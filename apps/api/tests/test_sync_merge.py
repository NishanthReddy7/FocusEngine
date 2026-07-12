"""Tests for the server-side sync merge — SYNC_STRATEGY.md §5 (algorithm), §9 (scenarios).

Exercises ``app.services.sync.apply_op``/``push_ops``/``pull_ops`` directly
against a fresh temp-file SQLite database per test (no HTTP layer — that is
``test_api.py``'s job). Each test name states the SYNC §9 failure-mode
scenario (or §5 algorithm step) it demonstrates.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import create_all, create_engine, create_session_factory
from app.models.sync import ServerOplog
from app.models.task import Task as TaskModel
from app.schemas.enums import EntityType, SyncOpType
from app.schemas.hlc import HybridLogicalClock, format_hlc
from app.schemas.sync import PushRequest, SyncOp
from app.services.sync import SERVER_DEVICE_ID, apply_op, pull_ops, push_ops

DEVICE_A = "aaaaaaaa-0000-4000-8000-000000000000"
DEVICE_B = "bbbbbbbb-0000-4000-8000-000000000000"

# These merge-primitive tests exercise one account at a time; user_id is the
# server-authoritative owner scope every op is stamped with (V2_ADDENDUM A3).
# Cross-user isolation is proven separately in tests/test_multiuser.py.
USER_A = "11111111-2222-4333-8444-555555555555"


def _hlc(ms: int, counter: int = 0, device: str = DEVICE_A) -> str:
    """A well-formed HLC string with a controllable, comparable ordering."""
    return format_hlc(ms, counter, device)


@pytest.fixture
async def db_session(tmp_path: Path) -> AsyncIterator[AsyncSession]:
    """A fresh temp-file SQLite AsyncSession per test (isolated, real tables)."""
    db_path = tmp_path / "test_sync_merge.db"
    engine = create_engine(f"sqlite+aiosqlite:///{db_path}")
    await create_all(engine)
    factory = create_session_factory(engine)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture
def server_hlc() -> HybridLogicalClock:
    """A fresh in-process server HLC clock, matching ``core/deps.py``'s wiring."""
    return HybridLogicalClock(SERVER_DEVICE_ID)


def _create_task_op(task_id: UUID, patch: dict, hlc: str, device_id: str = DEVICE_A) -> SyncOp:
    return SyncOp(
        op_id=f"{hlc}:task:{task_id}",
        entity=EntityType.TASK,
        entity_id=task_id,
        op=SyncOpType.CREATE,
        patch=patch,
        hlc=hlc,
        device_id=device_id,
    )


def _update_task_op(task_id: UUID, patch: dict, hlc: str, device_id: str = DEVICE_A) -> SyncOp:
    return SyncOp(
        op_id=f"{hlc}:task:{task_id}",
        entity=EntityType.TASK,
        entity_id=task_id,
        op=SyncOpType.UPDATE,
        patch=patch,
        hlc=hlc,
        device_id=device_id,
    )


def _delete_task_op(task_id: UUID, hlc: str, device_id: str = DEVICE_A) -> SyncOp:
    return SyncOp(
        op_id=f"{hlc}:task:{task_id}",
        entity=EntityType.TASK,
        entity_id=task_id,
        op=SyncOpType.DELETE,
        patch=None,
        hlc=hlc,
        device_id=device_id,
    )


# --------------------------------------------------------------------------
# 1. Create-then-stale-update: an older-HLC field update loses (SYNC §5 step 4)
# --------------------------------------------------------------------------


async def test_create_then_stale_update_older_hlc_field_loses(db_session, server_hlc) -> None:
    task_id = uuid4()
    create_result = await apply_op(
        db_session, _create_task_op(task_id, {"title": "Original title"}, _hlc(2_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )
    assert create_result.applied is True

    stale_result = await apply_op(
        db_session,
        _update_task_op(task_id, {"title": "Stale title"}, _hlc(1_000_000)),  # earlier than the create
        user_id=USER_A, hlc_clock=server_hlc,
    )
    assert stale_result.applied is False
    await db_session.commit()

    row = await db_session.get(TaskModel, str(task_id))
    assert row.title == "Original title"


# --------------------------------------------------------------------------
# 2. Concurrent different-field updates both survive (field granularity)
# --------------------------------------------------------------------------


async def test_concurrent_different_field_updates_both_survive(db_session, server_hlc) -> None:
    task_id = uuid4()
    await apply_op(
        db_session, _create_task_op(task_id, {"title": "Task", "priority": 4}, _hlc(1_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )

    result_title = await apply_op(
        db_session,
        _update_task_op(task_id, {"title": "Renamed by A"}, _hlc(2_000_000, device=DEVICE_A), device_id=DEVICE_A),
        user_id=USER_A, hlc_clock=server_hlc,
    )
    result_priority = await apply_op(
        db_session,
        _update_task_op(task_id, {"priority": 1}, _hlc(2_000_000, counter=1, device=DEVICE_B), device_id=DEVICE_B),
        user_id=USER_A, hlc_clock=server_hlc,
    )
    await db_session.commit()

    assert result_title.applied is True
    assert result_priority.applied is True
    row = await db_session.get(TaskModel, str(task_id))
    assert row.title == "Renamed by A"
    assert row.priority == 1


# --------------------------------------------------------------------------
# 3. Delete-vs-later-edit -> resurrection (SYNC §9: "laptop's edits carry
#    later HLCs -> resurrection")
# --------------------------------------------------------------------------


async def test_delete_then_later_edit_resurrects_the_task(db_session, server_hlc) -> None:
    task_id = uuid4()
    await apply_op(db_session, _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000)), user_id=USER_A, hlc_clock=server_hlc)

    delete_result = await apply_op(db_session, _delete_task_op(task_id, _hlc(2_000_000)), user_id=USER_A, hlc_clock=server_hlc)
    assert delete_result.applied is True
    row = await db_session.get(TaskModel, str(task_id))
    assert row.deleted_at is not None

    edit_result = await apply_op(
        db_session, _update_task_op(task_id, {"title": "Resurrected"}, _hlc(3_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )
    await db_session.commit()

    assert edit_result.applied is True
    row = await db_session.get(TaskModel, str(task_id))
    assert row.deleted_at is None  # resurrected
    assert row.title == "Resurrected"


# --------------------------------------------------------------------------
# 4. Edit-then-later-delete -> delete wins (dominant delete tombstones)
# --------------------------------------------------------------------------


async def test_edit_then_later_delete_wins(db_session, server_hlc) -> None:
    task_id = uuid4()
    await apply_op(db_session, _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000)), user_id=USER_A, hlc_clock=server_hlc)
    await apply_op(
        db_session, _update_task_op(task_id, {"title": "Edited"}, _hlc(2_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )

    delete_result = await apply_op(db_session, _delete_task_op(task_id, _hlc(3_000_000)), user_id=USER_A, hlc_clock=server_hlc)
    await db_session.commit()

    assert delete_result.applied is True
    row = await db_session.get(TaskModel, str(task_id))
    assert row.deleted_at is not None
    assert row.title == "Edited"  # the field value is untouched; only the tombstone is set.


async def test_delete_loses_to_a_causally_later_edit_already_applied(db_session, server_hlc) -> None:
    """Bonus: a late-arriving delete that is causally *older* than an existing
    field HLC must be skipped (row survives) — the mirror image of resurrection."""
    task_id = uuid4()
    await apply_op(db_session, _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000)), user_id=USER_A, hlc_clock=server_hlc)
    await apply_op(
        db_session, _update_task_op(task_id, {"title": "Edited later"}, _hlc(3_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )

    # A delete stamped *between* the create and the edit arrives late.
    delete_result = await apply_op(db_session, _delete_task_op(task_id, _hlc(2_000_000)), user_id=USER_A, hlc_clock=server_hlc)
    await db_session.commit()

    assert delete_result.applied is False
    row = await db_session.get(TaskModel, str(task_id))
    assert row.deleted_at is None
    assert row.title == "Edited later"


# --------------------------------------------------------------------------
# 5. Duplicate op_id -> skipped, idempotent (SYNC §9: "push response lost
#    mid-flight" -> client retries -> server answers skipped, no duplicates)
# --------------------------------------------------------------------------


async def test_duplicate_op_id_is_skipped_idempotently(db_session, server_hlc) -> None:
    task_id = uuid4()
    op = _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000))

    first = await apply_op(db_session, op, user_id=USER_A, hlc_clock=server_hlc)
    await db_session.commit()
    second = await apply_op(db_session, op, user_id=USER_A, hlc_clock=server_hlc)  # exact same op_id, resubmitted
    await db_session.commit()

    assert first.applied is True
    assert second.applied is False

    from sqlalchemy import func, select

    count = await db_session.scalar(select(func.count()).select_from(ServerOplog).where(ServerOplog.op_id == op.op_id))
    assert count == 1  # never duplicated in the oplog


# --------------------------------------------------------------------------
# 6. actual_focus_seconds in a task patch is stripped (DERIVED_FIELDS, §6)
# --------------------------------------------------------------------------


async def test_actual_focus_seconds_is_stripped_from_task_patches(db_session, server_hlc) -> None:
    task_id = uuid4()
    create_result = await apply_op(
        db_session,
        _create_task_op(task_id, {"title": "Task", "actual_focus_seconds": 500}, _hlc(1_000_000)),
        user_id=USER_A, hlc_clock=server_hlc,
    )
    await db_session.commit()
    assert create_result.applied is True
    row = await db_session.get(TaskModel, str(task_id))
    assert row.actual_focus_seconds == 0  # stripped -> falls back to the column default, not 500

    # An UPDATE patch containing *only* the derived field strips to empty and
    # applies nothing (there's nothing left to merge).
    update_result = await apply_op(
        db_session, _update_task_op(task_id, {"actual_focus_seconds": 999}, _hlc(2_000_000)), user_id=USER_A, hlc_clock=server_hlc
    )
    await db_session.commit()
    assert update_result.applied is False
    row = await db_session.get(TaskModel, str(task_id))
    assert row.actual_focus_seconds == 0


# --------------------------------------------------------------------------
# 7. A focus_session op touching work_seconds triggers a task recompute (§6)
# --------------------------------------------------------------------------


async def test_focus_session_op_triggers_task_recompute(db_session, server_hlc) -> None:
    task_id = uuid4()
    await apply_op(db_session, _create_task_op(task_id, {"title": "Deep work"}, _hlc(1_000_000)), user_id=USER_A, hlc_clock=server_hlc)

    session_id_1 = uuid4()
    op1 = SyncOp(
        op_id=f"{_hlc(2_000_000)}:focus_session:{session_id_1}",
        entity=EntityType.FOCUS_SESSION,
        entity_id=session_id_1,
        op=SyncOpType.CREATE,
        patch={"task_id": str(task_id), "preset": "sprint", "work_seconds": 300},
        hlc=_hlc(2_000_000),
        device_id=DEVICE_A,
    )
    result1 = await apply_op(db_session, op1, user_id=USER_A, hlc_clock=server_hlc)
    await db_session.commit()
    assert result1.applied is True

    row = await db_session.get(TaskModel, str(task_id))
    assert row.actual_focus_seconds == 300

    # A second session for the same task: recompute SUMs across sessions.
    session_id_2 = uuid4()
    op2 = SyncOp(
        op_id=f"{_hlc(3_000_000)}:focus_session:{session_id_2}",
        entity=EntityType.FOCUS_SESSION,
        entity_id=session_id_2,
        op=SyncOpType.CREATE,
        patch={"task_id": str(task_id), "preset": "focus", "work_seconds": 200},
        hlc=_hlc(3_000_000),
        device_id=DEVICE_A,
    )
    await apply_op(db_session, op2, user_id=USER_A, hlc_clock=server_hlc)
    await db_session.commit()

    row = await db_session.get(TaskModel, str(task_id))
    assert row.actual_focus_seconds == 500  # 300 + 200, summed from append-only facts

    # The recompute's own server-authored oplog entry is present.
    from sqlalchemy import select

    server_ops = (
        await db_session.scalars(
            select(ServerOplog).where(ServerOplog.entity == EntityType.TASK, ServerOplog.device_id == SERVER_DEVICE_ID)
        )
    ).all()
    assert any(op.patch == {"actual_focus_seconds": 500} for op in server_ops)


# --------------------------------------------------------------------------
# 8. Pull excludes own device + honors since/limit/has_more (SYNC §4)
# --------------------------------------------------------------------------


async def test_pull_excludes_own_device(db_session, server_hlc) -> None:
    task_id = uuid4()
    await apply_op(
        db_session, _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000), device_id=DEVICE_A), user_id=USER_A, hlc_clock=server_hlc
    )
    await db_session.commit()

    own_device_pull = await pull_ops(db_session, user_id=USER_A, since=0, device_id=DEVICE_A, limit=500)
    assert own_device_pull.ops == []  # echo suppression: never re-applies its own ops

    other_device_pull = await pull_ops(db_session, user_id=USER_A, since=0, device_id=DEVICE_B, limit=500)
    assert len(other_device_pull.ops) == 1
    assert other_device_pull.ops[0].device_id == DEVICE_A


async def test_pull_honors_since_limit_and_has_more(db_session, server_hlc) -> None:
    for i in range(5):
        task_id = uuid4()
        await apply_op(
            db_session,
            _create_task_op(task_id, {"title": f"Task {i}"}, _hlc(1_000_000 + i), device_id=DEVICE_A),
            user_id=USER_A, hlc_clock=server_hlc,
        )
    await db_session.commit()

    page1 = await pull_ops(db_session, user_id=USER_A, since=0, device_id=DEVICE_B, limit=2)
    assert len(page1.ops) == 2
    assert page1.has_more is True
    assert page1.next_seq == page1.ops[-1].server_seq

    page2 = await pull_ops(db_session, user_id=USER_A, since=page1.next_seq, device_id=DEVICE_B, limit=2)
    assert len(page2.ops) == 2
    assert page2.has_more is True

    page3 = await pull_ops(db_session, user_id=USER_A, since=page2.next_seq, device_id=DEVICE_B, limit=2)
    assert len(page3.ops) == 1
    assert page3.has_more is False

    # No overlap and no gaps across the three pages.
    seen_seqs = [op.server_seq for page in (page1, page2, page3) for op in page.ops]
    assert seen_seqs == sorted(seen_seqs)
    assert len(set(seen_seqs)) == 5


# --------------------------------------------------------------------------
# Bonus: push_ops end-to-end (applied/skipped split + server_seq) — the
# router-facing function the tests above deliberately bypass to test the
# merge primitive in isolation.
# --------------------------------------------------------------------------


async def test_push_ops_reports_applied_and_skipped(db_session, server_hlc) -> None:
    task_id = uuid4()
    create_op = _create_task_op(task_id, {"title": "Task"}, _hlc(1_000_000))
    duplicate_op = create_op  # resubmitting the identical op_id
    stale_op = _update_task_op(task_id, {"title": "Stale"}, _hlc(500_000))

    request = PushRequest(device_id=DEVICE_A, ops=[create_op], last_server_seq=0)
    response = await push_ops(db_session, request, user_id=USER_A, hlc_clock=server_hlc)
    assert response.applied == [create_op.op_id]
    assert response.skipped == []
    assert response.server_seq >= 1

    request2 = PushRequest(device_id=DEVICE_A, ops=[duplicate_op, stale_op], last_server_seq=response.server_seq)
    response2 = await push_ops(db_session, request2, user_id=USER_A, hlc_clock=server_hlc)
    assert response2.applied == []
    assert sorted(response2.skipped) == sorted([duplicate_op.op_id, stale_op.op_id])
