"""HTTP-surface tests — ARCHITECTURE.md §6 (route table), via an ASGI TestClient.

``starlette.testclient.TestClient`` wraps ``httpx.Client`` over an in-process
ASGI transport (no real socket) and drives the app's async lifespan correctly
when used as a context manager. Every test gets its own temp-file SQLite
database seeded with users A and B (``conftest.py``), and ``client`` is
authenticated as user A — so these v1 route tests run semantically unchanged
under the V2 auth requirement (A2), just with a bearer token attached.

Focus-lifecycle tests use the shared ``focus_clock`` fixture, which overrides
the per-user focus registry (``get_focus_registry``) with a ``FakeClock`` +
``ManualTimerFactory`` — no real timers/sleeps anywhere in this file.
"""

from __future__ import annotations

from starlette.testclient import TestClient

from tests.conftest import FakeClock

# --------------------------------------------------------------------------
# Task CRUD roundtrip + tombstoned DELETE
# --------------------------------------------------------------------------


def test_task_crud_roundtrip_and_tombstoned_delete(client: TestClient) -> None:
    payload = {
        "title": "Review network vulnerability report",
        "due": {"date": "2026-07-13", "time": "16:00:00", "recurrence": None},
        "labels": ["security"],
        "energy_required": "high",
        "estimated_minutes": 45,
    }
    create_resp = client.post("/tasks", json=payload)
    assert create_resp.status_code == 201
    body = create_resp.json()
    task_id = body["id"]
    assert body["title"] == payload["title"]
    assert body["labels"] == ["security"]
    assert body["status"] == "pending"
    assert body["priority"] == 4  # default P4
    assert body["actual_focus_seconds"] == 0
    assert body["due"]["date"] == "2026-07-13"

    get_resp = client.get(f"/tasks/{task_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == task_id

    patch_resp = client.patch(f"/tasks/{task_id}", json={"priority": 1, "title": "Updated title"})
    assert patch_resp.status_code == 200
    updated = patch_resp.json()
    assert updated["priority"] == 1
    assert updated["title"] == "Updated title"
    assert updated["labels"] == ["security"]  # untouched field survives the sparse patch

    list_resp = client.get("/tasks")
    assert list_resp.status_code == 200
    assert any(t["id"] == task_id for t in list_resp.json())

    delete_resp = client.delete(f"/tasks/{task_id}")
    assert delete_resp.status_code == 204

    missing_resp = client.get(f"/tasks/{task_id}")
    assert missing_resp.status_code == 404

    list_after_delete = client.get("/tasks")
    assert all(t["id"] != task_id for t in list_after_delete.json())

    # Tombstones are invisible to GET/list but still present in the bootstrap
    # snapshot (SYNC_STRATEGY §7: "full snapshot of all live + tombstoned rows").
    bootstrap_resp = client.get("/sync/bootstrap")
    tombstoned = [t for t in bootstrap_resp.json()["tasks"] if t["id"] == task_id]
    assert len(tombstoned) == 1
    assert tombstoned[0]["deleted_at"] is not None


def test_get_and_patch_and_delete_missing_task_404s(client: TestClient) -> None:
    missing_id = "11111111-1111-4111-8111-111111111111"
    assert client.get(f"/tasks/{missing_id}").status_code == 404
    assert client.patch(f"/tasks/{missing_id}", json={"title": "x"}).status_code == 404
    assert client.delete(f"/tasks/{missing_id}").status_code == 404


# --------------------------------------------------------------------------
# POST /tasks/{id}/complete: recurrence roll (ARCHITECTURE §4.5)
# --------------------------------------------------------------------------


def test_complete_task_rolls_every_2_workdays_due_date_and_keeps_pending(client: TestClient) -> None:
    payload = {
        "title": "Weekly ops sync prep",
        "due": {
            "date": "2026-07-09",  # Thursday
            "recurrence": {"frequency": "daily", "interval": 2, "workdays_only": True},
        },
    }
    create_resp = client.post("/tasks", json=payload)
    task_id = create_resp.json()["id"]

    complete_resp = client.post(f"/tasks/{task_id}/complete")
    assert complete_resp.status_code == 200
    body = complete_resp.json()
    assert body["status"] == "pending"
    assert body["due"]["date"] == "2026-07-13"  # Monday
    assert body["completion_count"] == 1
    assert body["last_completed_at"] is not None


def test_complete_task_without_recurrence_becomes_completed(client: TestClient) -> None:
    create_resp = client.post("/tasks", json={"title": "One-off task"})
    task_id = create_resp.json()["id"]

    complete_resp = client.post(f"/tasks/{task_id}/complete")
    assert complete_resp.status_code == 200
    body = complete_resp.json()
    assert body["status"] == "completed"
    assert body["completion_count"] == 0


def test_complete_task_scheduled_recurrence_with_count_terminates_series(client: TestClient) -> None:
    """ARCHITECTURE §4.5 v1.1: a SCHEDULED recurrence with ``count`` ends the
    series once ``completion_count`` reaches ``count``."""
    payload = {
        "title": "Standup notes",
        "due": {
            "date": "2026-07-13",  # Monday
            "recurrence": {"frequency": "daily", "interval": 1, "count": 2},  # anchor defaults to SCHEDULED
        },
    }
    task_id = client.post("/tasks", json=payload).json()["id"]

    # Completion 1 of 2: series continues, due rolls forward, count ticks to 1.
    first = client.post(f"/tasks/{task_id}/complete").json()
    assert first["status"] == "pending"
    assert first["due"]["date"] == "2026-07-14"
    assert first["completion_count"] == 1

    # Completion 2 of 2: count reached -> series ends, task completes.
    second = client.post(f"/tasks/{task_id}/complete").json()
    assert second["status"] == "completed"
    assert second["completion_count"] == 2


# --------------------------------------------------------------------------
# Focus lifecycle with the per-user fake focus registry (FakeClock/ManualTimer)
# --------------------------------------------------------------------------


def test_focus_lifecycle_start_double_start_pause_resume_complete(
    client: TestClient, focus_clock: FakeClock
) -> None:
    task_resp = client.post("/tasks", json={"title": "Deep work block"})
    task_id = task_resp.json()["id"]

    start_resp = client.post("/focus/sessions", json={"task_id": task_id, "preset": "sprint"})
    assert start_resp.status_code == 201
    assert start_resp.json()["state"] == "active_work"

    double_start_resp = client.post("/focus/sessions", json={"task_id": task_id, "preset": "sprint"})
    assert double_start_resp.status_code == 409

    active_resp = client.get("/focus/sessions/active")
    assert active_resp.status_code == 200
    assert active_resp.json()["remaining_seconds"] == 15 * 60

    focus_clock.advance(300)

    pause_resp = client.post("/focus/sessions/active/pause")
    assert pause_resp.status_code == 200
    assert pause_resp.json()["work_seconds"] == 300
    assert pause_resp.json()["state"] == "paused"

    resume_resp = client.post("/focus/sessions/active/resume")
    assert resume_resp.status_code == 200
    assert resume_resp.json()["state"] == "active_work"

    complete_resp = client.post("/focus/sessions/active/complete")
    assert complete_resp.status_code == 200
    assert complete_resp.json()["outcome"] == "completed"
    assert complete_resp.json()["work_seconds"] == 300

    # Persisted AND the linked task's derived counter reflects the credited time.
    task_after = client.get(f"/tasks/{task_id}")
    assert task_after.json()["actual_focus_seconds"] == 300

    # No active session remains.
    no_active_resp = client.get("/focus/sessions/active")
    assert no_active_resp.status_code == 404
    no_session_action_resp = client.post("/focus/sessions/active/pause")
    assert no_session_action_resp.status_code == 404


def test_focus_invalid_transition_maps_to_409(client: TestClient, focus_clock: FakeClock) -> None:
    task_resp = client.post("/tasks", json={"title": "Another task"})
    task_id = task_resp.json()["id"]

    client.post("/focus/sessions", json={"task_id": task_id, "preset": "sprint"})
    # resume is not a valid transition from ACTIVE_WORK (ARCHITECTURE §5.1).
    resp = client.post("/focus/sessions/active/resume")
    assert resp.status_code == 409


# --------------------------------------------------------------------------
# /sync/bootstrap: snapshot + server_seq
# --------------------------------------------------------------------------


def test_bootstrap_returns_snapshot_and_server_seq(client: TestClient) -> None:
    client.post("/tasks", json={"title": "One"})
    client.post("/tasks", json={"title": "Two"})

    resp = client.get("/sync/bootstrap")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["tasks"]) >= 2
    assert body["server_seq"] >= 2
    assert "field_hlcs" in body["tasks"][0]
    for table in ("projects", "sections", "visions", "seasons", "focus_sessions", "daily_reviews"):
        assert table in body
