"""Cross-user isolation + realtime sync tests — V2_ADDENDUM A3/A5.

Every test drives the same app with two authenticated accounts (A and B) and
proves the account boundary holds by construction: B can never read/patch/
delete A's task, B's pull/bootstrap never contain A's rows, the per-(user,
device) sync cursor upserts, ``/ws/sync`` wakes only the pushing user, and the
per-user focus registry lets A and B run sessions at the same time.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from typing import Any
from uuid import uuid4

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.db.engine import create_engine, create_session_factory
from app.models.sync import SyncCursor
from app.schemas.hlc import format_hlc
from app.services.sync import SyncNotifier
from tests.conftest import FakeClock


def _read_sync_cursor(db_url: str, user_id: str, device_id: str) -> dict[str, Any] | None:
    """Read one ``sync_cursors`` row via a throwaway engine (out-of-band check)."""

    async def _run() -> dict[str, Any] | None:
        engine = create_engine(db_url)
        factory = create_session_factory(engine)
        async with factory() as session:
            row = await session.get(SyncCursor, (user_id, device_id))
            data = None if row is None else {"last_seq": row.last_seq, "device_id": row.device_id}
        await engine.dispose()
        return data

    return asyncio.run(_run())


# --------------------------------------------------------------------------
# CROSS-USER ISOLATION: B cannot touch A's task; A's data is untouched.
# --------------------------------------------------------------------------


def test_user_b_cannot_read_patch_or_delete_user_a_task(
    client: TestClient, auth_a: dict[str, str], auth_b: dict[str, str]
) -> None:
    task_id = client.post("/tasks", json={"title": "A private"}, headers=auth_a).json()["id"]

    # Existence never leaks: another account's task is a plain 404 on every verb.
    assert client.get(f"/tasks/{task_id}", headers=auth_b).status_code == 404
    assert client.patch(f"/tasks/{task_id}", json={"title": "hijacked"}, headers=auth_b).status_code == 404
    assert client.delete(f"/tasks/{task_id}", headers=auth_b).status_code == 404
    assert client.post(f"/tasks/{task_id}/complete", headers=auth_b).status_code == 404

    # A still owns it, fully intact; B's own list is empty.
    a_view = client.get(f"/tasks/{task_id}", headers=auth_a)
    assert a_view.status_code == 200
    assert a_view.json()["title"] == "A private"
    assert client.get("/tasks", headers=auth_b).json() == []


def test_pull_never_contains_another_users_ops(
    client: TestClient, auth_a: dict[str, str], auth_b: dict[str, str]
) -> None:
    a_task = client.post("/tasks", json={"title": "A task"}, headers=auth_a).json()["id"]
    b_task = client.post("/tasks", json={"title": "B task"}, headers=auth_b).json()["id"]

    a_ids = {op["entity_id"] for op in client.get("/sync/pull?device_id=a-dev", headers=auth_a).json()["ops"]}
    assert a_task in a_ids and b_task not in a_ids

    b_ids = {op["entity_id"] for op in client.get("/sync/pull?device_id=b-dev", headers=auth_b).json()["ops"]}
    assert b_task in b_ids and a_task not in b_ids


def test_bootstrap_is_user_filtered(
    client: TestClient, auth_a: dict[str, str], auth_b: dict[str, str]
) -> None:
    a_task = client.post("/tasks", json={"title": "A only"}, headers=auth_a).json()["id"]

    a_boot = client.get("/sync/bootstrap", headers=auth_a).json()
    b_boot = client.get("/sync/bootstrap", headers=auth_b).json()
    assert a_task in {t["id"] for t in a_boot["tasks"]}
    assert b_boot["tasks"] == []  # B sees none of A's rows
    # Each user's high-water seq is their own; B has appended nothing.
    assert a_boot["server_seq"] >= 1
    assert b_boot["server_seq"] == 0


def test_push_cannot_write_into_another_users_row(
    client: TestClient, auth_a: dict[str, str], auth_b: dict[str, str]
) -> None:
    """A client push naming A's entity id is a no-op for B (owner guard, A3)."""
    a_task = client.post("/tasks", json={"title": "A guarded"}, headers=auth_a).json()["id"]

    hlc = format_hlc(9_000_000_000_000, 0, "bbbbbbbb")
    forged = {
        "device_id": "bbbbbbbb-1111-4111-8111-111111111111",
        "last_server_seq": 0,
        "ops": [
            {
                "op_id": f"{hlc}:task:{a_task}",
                "entity": "task",
                "entity_id": a_task,
                "op": "update",
                "patch": {"title": "owned by B now"},
                "hlc": hlc,
                "device_id": "bbbbbbbb-1111-4111-8111-111111111111",
            }
        ],
    }
    resp = client.post("/sync/push", json=forged, headers=auth_b)
    assert resp.status_code == 200
    assert resp.json()["applied"] == []  # rejected: A's row is invisible to B

    # A's task is unchanged and still owned by A.
    assert client.get(f"/tasks/{a_task}", headers=auth_a).json()["title"] == "A guarded"


# --------------------------------------------------------------------------
# sync_cursors upsert on pull (A3).
# --------------------------------------------------------------------------


def test_pull_upserts_sync_cursor(
    client: TestClient, auth_a: dict[str, str], users: Any, db_url: str
) -> None:
    client.post("/tasks", json={"title": "seed"}, headers=auth_a)
    pull = client.get("/sync/pull?device_id=dev-1", headers=auth_a).json()

    cursor = _read_sync_cursor(db_url, users.a.id, "dev-1")
    assert cursor is not None
    assert cursor["last_seq"] == pull["next_seq"]

    # A second pull updates the same (user, device) row rather than duplicating.
    client.post("/tasks", json={"title": "seed 2"}, headers=auth_a)
    pull2 = client.get(f"/sync/pull?device_id=dev-1&since={pull['next_seq']}", headers=auth_a).json()
    cursor2 = _read_sync_cursor(db_url, users.a.id, "dev-1")
    assert cursor2 is not None
    assert cursor2["last_seq"] == pull2["next_seq"]
    assert cursor2["last_seq"] >= cursor["last_seq"]


# --------------------------------------------------------------------------
# SyncNotifier routing (deterministic core of the WS isolation guarantee, A5).
# --------------------------------------------------------------------------


async def test_sync_notifier_routes_only_to_the_target_user() -> None:
    notifier = SyncNotifier()
    queue_a = notifier.subscribe("user-a")
    queue_b = notifier.subscribe("user-b")

    notifier.notify("user-a", 7)
    assert queue_a.get_nowait() == 7
    assert queue_b.empty()  # a different user's socket stays silent

    # Every socket of the same user receives the signal.
    queue_a2 = notifier.subscribe("user-a")
    notifier.notify("user-a", 9)
    assert queue_a.get_nowait() == 9
    assert queue_a2.get_nowait() == 9

    # Unsubscribe removes just that socket.
    notifier.unsubscribe("user-a", queue_a)
    notifier.notify("user-a", 11)
    assert queue_a.empty()
    assert queue_a2.get_nowait() == 11


# --------------------------------------------------------------------------
# /ws/sync: A's push wakes A's socket; B's socket stays silent (A5).
# --------------------------------------------------------------------------


def test_ws_sync_wakes_only_the_pushing_user(
    client: TestClient, auth_a: dict[str, str], users: Any
) -> None:
    with (
        client.websocket_connect(f"/ws/sync?token={users.a.token}") as ws_a,
        client.websocket_connect(f"/ws/sync?token={users.b.token}") as ws_b,
    ):
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            # Block on B's socket in a worker thread so we can assert it never fires.
            future_b = executor.submit(ws_b.receive_json)

            task_id = uuid4()
            hlc = format_hlc(3_000_000_000_000, 0, "aaaaaaaa")
            push = {
                "device_id": "aaaaaaaa-1111-4111-8111-111111111111",
                "last_server_seq": 0,
                "ops": [
                    {
                        "op_id": f"{hlc}:task:{task_id}",
                        "entity": "task",
                        "entity_id": str(task_id),
                        "op": "create",
                        "patch": {"title": "pushed by A"},
                        "hlc": hlc,
                        "device_id": "aaaaaaaa-1111-4111-8111-111111111111",
                    }
                ],
            }
            resp = client.post("/sync/push", json=push, headers=auth_a)
            assert resp.status_code == 200
            assert resp.json()["applied"] == [f"{hlc}:task:{task_id}"]

            # A's socket gets the fresh high-water mark.
            assert ws_a.receive_json()["server_seq"] >= 1

            # B's socket stays silent (its receive never completes).
            with pytest.raises(concurrent.futures.TimeoutError):
                future_b.result(timeout=0.5)
        finally:
            executor.shutdown(wait=False)


def test_ws_sync_rejects_missing_or_invalid_token(client: TestClient) -> None:
    for bad in ("", "not-a-jwt"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/sync?token={bad}"):
                pass


# --------------------------------------------------------------------------
# Per-user focus registry: A and B run sessions simultaneously (A3).
# --------------------------------------------------------------------------


def test_users_a_and_b_focus_simultaneously(
    client: TestClient, auth_a: dict[str, str], auth_b: dict[str, str], focus_clock: FakeClock
) -> None:
    task_a = client.post("/tasks", json={"title": "A focus"}, headers=auth_a).json()["id"]
    task_b = client.post("/tasks", json={"title": "B focus"}, headers=auth_b).json()["id"]

    assert client.post("/focus/sessions", json={"task_id": task_a, "preset": "sprint"}, headers=auth_a).status_code == 201
    # A single global manager would 409 here; the per-user registry does not.
    assert client.post("/focus/sessions", json={"task_id": task_b, "preset": "sprint"}, headers=auth_b).status_code == 201

    # Both accounts have their own live session at the same time.
    active_a = client.get("/focus/sessions/active", headers=auth_a).json()
    active_b = client.get("/focus/sessions/active", headers=auth_b).json()
    assert active_a["session"]["task_id"] == task_a
    assert active_b["session"]["task_id"] == task_b

    focus_clock.advance(120)

    assert client.post("/focus/sessions/active/pause", headers=auth_a).json()["work_seconds"] == 120
    assert client.post("/focus/sessions/active/pause", headers=auth_b).json()["work_seconds"] == 120

    for headers in (auth_a, auth_b):
        client.post("/focus/sessions/active/resume", headers=headers)
        assert client.post("/focus/sessions/active/complete", headers=headers).json()["outcome"] == "completed"

    # Each session credited only its own owner's task.
    assert client.get(f"/tasks/{task_a}", headers=auth_a).json()["actual_focus_seconds"] == 120
    assert client.get(f"/tasks/{task_b}", headers=auth_b).json()["actual_focus_seconds"] == 120
