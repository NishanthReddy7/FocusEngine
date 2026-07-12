"""Task business logic — ARCHITECTURE.md §4.5 (recurring completion), §5.4 (focus ports).

Every mutation here is server-originated: each gets a fresh HLC stamped with
device ``"server"`` and an oplog entry, by routing through
``app.services.sync.apply_op`` — the exact same merge function a client push
uses. That reuse is deliberate: a REST-created/updated/deleted task must
replicate to other devices on their next pull exactly like a synced one would.

This module also hosts the two SQL-backed adapters the focus domain
(``app.domain.focus.ports``) is wired against at the DI boundary (T2's
``FocusController``/``FocusSessionManager`` never import SQLAlchemy directly):

- :class:`SqlTaskTimeSink` — the *live* per-segment credit path (atomic
  ``UPDATE ... SET actual_focus_seconds = actual_focus_seconds + :delta``).
- :class:`SqlSessionStore` — persists the FocusSession snapshot the domain
  layer builds with an empty ``updated_hlc``/``device_id`` (T2's integration
  note); this is where the real HLC/device get stamped.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.focus import FocusSession as FocusSessionModel
from app.models.task import Task as TaskModel
from app.schemas.base import utcnow
from app.schemas.enums import EntityType, RecurrenceAnchor, SyncOpType, TaskStatus
from app.schemas.focus import FocusSession
from app.schemas.hlc import HybridLogicalClock
from app.schemas.recurrence import RecurrenceRule
from app.schemas.sync import SyncOp
from app.schemas.task import TaskCreate, TaskUpdate
from app.services.recurrence import compute_next
from app.services.sync import (
    META_COLUMNS,
    SERVER_DEVICE_ID,
    SyncNotifier,
    apply_op,
    coerce_column_value,
    make_server_op,
    notify_user,
)


async def complete_task(
    session: AsyncSession,
    row: TaskModel,
    *,
    user_id: str,
    hlc_clock: HybridLogicalClock,
    notifier: SyncNotifier | None = None,
) -> TaskModel:
    """``POST /tasks/{id}/complete`` — ARCHITECTURE §4.5, v1.1 clarification.

    If ``due.recurrence`` yields a next occurrence: stay ``PENDING``, roll
    ``due.date`` forward, bump ``completion_count``. Otherwise: ``COMPLETED``.
    Always stamps ``last_completed_at``. Routed through :func:`apply_op`
    (scoped to ``user_id``) so the mutation is field-HLC-tracked and oplogged
    identically to a synced write (a fresh server HLC always wins, so this is
    always "applied").
    """
    now = utcnow()
    due = row.due
    rule = RecurrenceRule.model_validate(due["recurrence"]) if due and due.get("recurrence") else None

    if rule is None:
        patch: dict[str, Any] = {
            "status": TaskStatus.COMPLETED.value,
            "last_completed_at": now.isoformat(),
        }
    else:
        base = date.fromisoformat(due["date"])
        # A completion always advances the recurring-completions tally,
        # whether or not the series continues (v1.1 clarification).
        next_completion_count = row.completion_count + 1

        if rule.anchor is RecurrenceAnchor.COMPLETED:
            # anchor=COMPLETED: step once from the completion date (today).
            next_due = compute_next(rule, after=now.date(), base=base)
        else:
            # anchor=SCHEDULED: step from the (pattern-conforming) current due
            # date. `until` is enforced inside compute_next (absolute-date
            # comparison, base-independent); `count` is enforced below.
            next_due = compute_next(rule, after=base, base=base)

        # v1.1: `count` is enforced by the CALLER for BOTH anchors, checked
        # AFTER incrementing completion_count. complete_task rolls due.date
        # forward on every completion and passes it back in as compute_next's
        # `base`, so compute_next's own base-relative occurrence index restarts
        # at 1 each call and cannot track the series total across completions
        # (it only terminates count=1 SCHEDULED early). completion_count is the
        # durable per-series counter (ARCHITECTURE §4.3), so "series ends when
        # completion_count >= count" is enforced here uniformly.
        if rule.count is not None and next_completion_count >= rule.count:
            next_due = None

        if next_due is not None:
            patch = {
                "due": {**due, "date": next_due.isoformat()},
                "status": TaskStatus.PENDING.value,
                "completion_count": next_completion_count,
                "last_completed_at": now.isoformat(),
            }
        else:
            patch = {
                "status": TaskStatus.COMPLETED.value,
                "completion_count": next_completion_count,
                "last_completed_at": now.isoformat(),
            }

    hlc = hlc_clock.tick()
    op = SyncOp(
        op_id=f"{hlc}:task:{row.id}",
        entity=EntityType.TASK,
        entity_id=UUID(row.id),
        op=SyncOpType.UPDATE,
        patch=patch,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )
    await apply_op(session, op, user_id=user_id, hlc_clock=hlc_clock)
    await session.commit()
    await notify_user(notifier, session, user_id)
    return row


async def create_task_rest(
    session: AsyncSession,
    payload: TaskCreate,
    *,
    user_id: str,
    hlc_clock: HybridLogicalClock,
    notifier: SyncNotifier | None = None,
) -> TaskModel:
    """``POST /tasks`` (ARCHITECTURE §6): server-stamped create via the sync merge path.

    ``user_id`` is forced by the server (``apply_op`` stamps it); any
    client-supplied ``user_id`` in the body is dropped so a task can only ever
    be created under the authenticated account (A3).
    """
    hlc = hlc_clock.tick()
    data = payload.model_dump(mode="json")
    data.pop("user_id", None)  # server-authoritative — never trust the client value.
    op = SyncOp(
        op_id=f"{hlc}:task:{data['id']}",
        entity=EntityType.TASK,
        entity_id=payload.id,
        op=SyncOpType.CREATE,
        patch=data,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )
    await apply_op(session, op, user_id=user_id, hlc_clock=hlc_clock)
    await session.commit()
    await notify_user(notifier, session, user_id)
    row = await session.get(TaskModel, str(payload.id))
    assert row is not None  # apply_op's fresh-insert path always populates this id.
    return row


async def update_task_rest(
    session: AsyncSession,
    task_id: UUID,
    payload: TaskUpdate,
    *,
    user_id: str,
    hlc_clock: HybridLogicalClock,
    notifier: SyncNotifier | None = None,
) -> TaskModel | None:
    """``PATCH /tasks/{id}`` (ARCHITECTURE §6): sparse, server-stamped, user-scoped update."""
    hlc = hlc_clock.tick()
    data = payload.model_dump(mode="json", exclude_unset=True)
    data.pop("user_id", None)  # owner scope is immutable — never reassign a task.
    op = SyncOp(
        op_id=f"{hlc}:task:{task_id}",
        entity=EntityType.TASK,
        entity_id=task_id,
        op=SyncOpType.UPDATE,
        patch=data,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )
    await apply_op(session, op, user_id=user_id, hlc_clock=hlc_clock)
    await session.commit()
    await notify_user(notifier, session, user_id)
    return await session.get(TaskModel, str(task_id))


async def delete_task_rest(
    session: AsyncSession,
    task_id: UUID,
    *,
    user_id: str,
    hlc_clock: HybridLogicalClock,
    notifier: SyncNotifier | None = None,
) -> None:
    """``DELETE /tasks/{id}`` (ARCHITECTURE §6): tombstone via the user-scoped merge path."""
    hlc = hlc_clock.tick()
    op = SyncOp(
        op_id=f"{hlc}:task:{task_id}",
        entity=EntityType.TASK,
        entity_id=task_id,
        op=SyncOpType.DELETE,
        patch=None,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )
    await apply_op(session, op, user_id=user_id, hlc_clock=hlc_clock)
    await session.commit()
    await notify_user(notifier, session, user_id)


class SqlTaskTimeSink:
    """``TaskTimeSink`` port (ARCHITECTURE §5.2) — atomic credit of live focus time.

    Structurally satisfies ``app.domain.focus.ports.TaskTimeSink`` (a
    ``Protocol`` — no inheritance needed). Opens its own short-lived session
    per call so the focus domain (which calls this outside any HTTP request's
    session) never shares a session across concurrent requests. Bound to a
    single ``user_id`` (the per-user focus registry builds one adapter per
    account) so every credit + oplog append stays inside that account (A3).
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        hlc_clock: HybridLogicalClock,
        *,
        user_id: str,
        notifier: SyncNotifier | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._hlc_clock = hlc_clock
        self._user_id = user_id
        self._notifier = notifier

    async def add_focus_seconds(self, task_id: UUID, seconds: int) -> None:
        """Atomically add ``seconds`` to ``task.actual_focus_seconds`` (SYNC §6).

        The increment itself is one ``UPDATE ... RETURNING`` statement (no
        read-modify-write race on the counter), scoped to this user's task.
        The follow-up bookkeeping write (``field_hlcs``/``updated_hlc``/
        ``device_id``) is a second statement in the same transaction; under
        the single-active-session-per-user invariant (each user's
        ``FocusSessionManager`` allows only one running session) no concurrent
        credit to the same task can interleave, so this remains race-free in
        practice — flagged in the implementer report as the one spot that
        would need a single atomic JSON-update statement if that invariant is
        ever relaxed.
        """
        if seconds == 0:
            return  # nothing to credit; avoid a no-op write + oplog entry.
        async with self._session_factory() as session:
            hlc = self._hlc_clock.tick()
            result = await session.execute(
                update(TaskModel)
                .where(TaskModel.id == str(task_id), TaskModel.user_id == self._user_id)
                .values(actual_focus_seconds=TaskModel.actual_focus_seconds + seconds)
                .returning(TaskModel.actual_focus_seconds, TaskModel.field_hlcs)
            )
            row = result.first()
            if row is None:
                return  # task vanished / not this user's — nothing to credit.
            new_total, field_hlcs = row
            field_hlcs = dict(field_hlcs or {})
            field_hlcs["actual_focus_seconds"] = hlc
            await session.execute(
                update(TaskModel)
                .where(TaskModel.id == str(task_id), TaskModel.user_id == self._user_id)
                .values(field_hlcs=field_hlcs, updated_hlc=hlc, device_id=SERVER_DEVICE_ID)
            )
            session.add(
                make_server_op(
                    user_id=self._user_id,
                    entity=EntityType.TASK,
                    entity_id=str(task_id),
                    op_type=SyncOpType.UPDATE,
                    patch={"actual_focus_seconds": new_total},
                    hlc=hlc,
                )
            )
            await session.commit()
            await notify_user(self._notifier, session, self._user_id)


class SqlSessionStore:
    """``SessionStore`` port (ARCHITECTURE §5.2) — persists a FocusSession snapshot.

    T2's domain constructs ``FocusSession.updated_hlc == ""`` (HLC-agnostic by
    design) and carries no ``user_id``; this adapter stamps the real HLC +
    device ``"server"`` + owner ``user_id`` on every persist (called once at
    ``start()`` and once at finalization, §5.3.6). Bound to a single account
    (the per-user focus registry builds one store per user), so the session
    row and its oplog entry always land under the right owner (A3). The
    session row is single-writer (this adapter, sequentially, per controller),
    so each save simply overwrites ``field_hlcs`` for every business field with
    the freshly-ticked HLC rather than doing a field-level LWW comparison
    against itself.
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        hlc_clock: HybridLogicalClock,
        *,
        user_id: str,
        notifier: SyncNotifier | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._hlc_clock = hlc_clock
        self._user_id = user_id
        self._notifier = notifier

    async def save(self, session: FocusSession) -> None:
        """Upsert the ``focus_sessions`` row and append a matching oplog entry."""
        async with self._session_factory() as db_session:
            row = await db_session.get(FocusSessionModel, str(session.id))
            is_create = row is None
            if is_create:
                row = FocusSessionModel(id=str(session.id))
                db_session.add(row)

            data = session.model_dump(mode="json", exclude={"updated_hlc", "device_id"})
            columns = FocusSessionModel.__table__.columns
            for name, value in data.items():
                setattr(row, name, coerce_column_value(columns[name], value))

            hlc = self._hlc_clock.tick()
            row.user_id = self._user_id  # server-authoritative owner scope (A3).
            row.updated_hlc = hlc
            row.device_id = SERVER_DEVICE_ID
            row.field_hlcs = {name: hlc for name in data if name not in META_COLUMNS}

            db_session.add(
                make_server_op(
                    user_id=self._user_id,
                    entity=EntityType.FOCUS_SESSION,
                    entity_id=str(session.id),
                    op_type=SyncOpType.CREATE if is_create else SyncOpType.UPDATE,
                    patch=data,
                    hlc=hlc,
                )
            )
            await db_session.commit()
            await notify_user(self._notifier, db_session, self._user_id)
