"""Server-side oplog merge — SYNC_STRATEGY.md §4-§8.

Implements the single deterministic merge function (:func:`apply_op`) that
``app/routers/sync.py`` (client push/pull) *and* ``app/routers/tasks.py``
(direct REST mutations, treated as server-authored ops so they replicate to
other devices too) both funnel through. The client's ``lib/sync/engine.ts::
applyRemoteOp`` implements the identical decision table (SYNC §5) — that
symmetry is the whole convergence guarantee.

Numbered comments inside :func:`apply_op` match SYNC_STRATEGY.md §5's
numbered algorithm verbatim.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

from sqlalchemy import Column, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import Base
from app.models.focus import FocusSession as FocusSessionModel
from app.models.goals import Season as SeasonModel
from app.models.goals import Vision as VisionModel
from app.models.project import Project as ProjectModel
from app.models.project import Section as SectionModel
from app.models.review import DailyReview as DailyReviewModel
from app.models.sync import ServerOplog, SyncCursor
from app.models.task import Task as TaskModel
from app.schemas.base import utcnow
from app.schemas.enums import EntityType, SyncOpType
from app.schemas.hlc import HybridLogicalClock
from app.schemas.sync import PullResponse, PushRequest, PushResponse, ServerOp, SyncOp

logger = logging.getLogger(__name__)


@dataclass
class SyncNotifier:
    """Per-user fan-out of "your oplog advanced to N" signals (V2_ADDENDUM A5).

    Each ``/ws/sync`` socket subscribes with its authenticated ``user_id`` and
    receives an ``asyncio.Queue`` of ``server_seq`` values. After any oplog
    append for a user (client push, recurrence roll, focus-time credit,
    session persist), a writer calls :func:`notify_user` which pushes that
    user's fresh high-water mark onto only *that* user's queues — a different
    user's sockets stay silent (proven in ``tests/test_multiuser.py``). Lives
    in the services layer (not ``core/deps``) so both the routers and the
    focus stores can reach it without an import cycle.
    """

    _subscribers: dict[str, set[asyncio.Queue[int]]] = field(default_factory=dict)

    def subscribe(self, user_id: str) -> asyncio.Queue[int]:
        """Register a new socket for ``user_id``; returns its signal queue."""
        queue: asyncio.Queue[int] = asyncio.Queue()
        self._subscribers.setdefault(user_id, set()).add(queue)
        return queue

    def unsubscribe(self, user_id: str, queue: asyncio.Queue[int]) -> None:
        """Drop a socket's queue on disconnect (cleans up empty user buckets)."""
        subscribers = self._subscribers.get(user_id)
        if subscribers is not None:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(user_id, None)

    def notify(self, user_id: str, server_seq: int) -> None:
        """Push ``server_seq`` to every socket owned by ``user_id`` (only)."""
        for queue in list(self._subscribers.get(user_id, ())):
            queue.put_nowait(server_seq)


async def current_server_seq(session: AsyncSession, *, user_id: str) -> int:
    """The highest ``server_seq`` this user owns (0 if they have no ops yet).

    ``server_seq`` is a single global sequence, but each account only ever
    sees its own ops, so its cursor is the max over ``user_id``-scoped rows.
    """
    result = await session.scalar(
        select(func.max(ServerOplog.server_seq)).where(ServerOplog.user_id == user_id)
    )
    return result or 0


async def notify_user(notifier: SyncNotifier | None, session: AsyncSession, user_id: str) -> None:
    """Signal ``user_id``'s ``/ws/sync`` sockets with their fresh high-water mark.

    No-op when ``notifier`` is ``None`` (direct service-level tests that bypass
    the app wiring). Must be called *after* the oplog append is committed so
    the seq it reports is durable and a woken client's pull sees the row.
    """
    if notifier is None:
        return
    seq = await current_server_seq(session, user_id=user_id)
    notifier.notify(user_id, seq)

#: ARCHITECTURE §4.5 / SYNC_STRATEGY §6 — additive cross-device counters that
#: are recomputed server-side from append-only facts, never LWW-merged.
#: Keyed by ``EntityType.value`` (the wire string), matching how ``SyncOp``
#: carries ``entity``.
DERIVED_FIELDS: dict[str, set[str]] = {"task": {"actual_focus_seconds"}}

#: Reserved device id for every server-originated mutation (SYNC_STRATEGY §2):
#: recurrence rolls, focus-time credits, and the derived-field recompute
#: below all get a fresh HLC stamped with this device id so they flow to
#: clients on their next pull, indistinguishable from any other device's ops.
SERVER_DEVICE_ID = "server"

#: Bookkeeping columns the merge algorithm itself manages. Even if a
#: (tolerated, forward-compatible) patch includes one of these, it is never
#: treated as an ordinary per-field LWW target — ``updated_hlc``/``device_id``
#: are row-level watermarks, ``field_hlcs`` is the bookkeeping map itself, and
#: ``id``/``created_at``/``deleted_at`` are managed by identity/create/delete,
#: never by an UPDATE patch.
#: ``user_id`` is server-authoritative (stamped from the JWT, never from a
#: client patch — that is what makes cross-user writes impossible), so it is
#: treated as a merge-meta column too: never LWW-merged from an incoming
#: patch, only set on the fresh-insert path from the authenticated user id.
META_COLUMNS: frozenset[str] = frozenset(
    {"id", "user_id", "created_at", "updated_at", "deleted_at", "updated_hlc", "device_id", "field_hlcs"}
)

#: Every entity kind that flows through the oplog, mapped to its ORM model
#: (ARCHITECTURE §4.6). Push/pull/bootstrap all dispatch through this table so
#: adding a synced entity only ever means adding one row here.
_ENTITY_MODELS: dict[EntityType, type[Base]] = {
    EntityType.TASK: TaskModel,
    EntityType.PROJECT: ProjectModel,
    EntityType.SECTION: SectionModel,
    EntityType.VISION: VisionModel,
    EntityType.SEASON: SeasonModel,
    EntityType.FOCUS_SESSION: FocusSessionModel,
    EntityType.DAILY_REVIEW: DailyReviewModel,
}

#: Table names bootstrap exposes each entity kind under (ARCHITECTURE §6:
#: ``{tasks: [...], projects: [...], ...}``).
_BOOTSTRAP_TABLES: dict[str, EntityType] = {
    "tasks": EntityType.TASK,
    "projects": EntityType.PROJECT,
    "sections": EntityType.SECTION,
    "visions": EntityType.VISION,
    "seasons": EntityType.SEASON,
    "focus_sessions": EntityType.FOCUS_SESSION,
    "daily_reviews": EntityType.DAILY_REVIEW,
}


@dataclass
class ApplyResult:
    """Outcome of merging one op — drives ``PushResponse``'s applied/skipped split.

    ``applied=False`` covers both idempotent duplicates and fully-stale writes
    (every touched field lost, and no resurrection/tombstone/create happened):
    in both cases the row is untouched and nothing is appended to the
    ``ServerOplog`` (there is nothing new to replicate).
    """

    op_id: str
    applied: bool
    server_seq: int | None = None


def coerce_column_value(column: Column, value: Any) -> Any:
    """Coerce a raw JSON-decoded ``value`` to what ``column`` expects.

    JSON transports dates/datetimes as ISO-8601 strings, but SQLite's
    ``DateTime``/``Date`` column types (via aiosqlite) reject plain strings
    outright — they need real ``datetime``/``date`` objects. JSON (dict/list),
    string, int, float, and bool columns accept the decoded value unchanged;
    ``sa_enum`` columns already accept the raw string that matches one of the
    enum's *values* (ARCHITECTURE §4.6's ``values_callable``), so no coercion
    is needed there either.
    """
    if value is None:
        return None
    try:
        python_type = column.type.python_type
    except NotImplementedError:
        return value  # JSON columns: python_type is unimplemented; pass through.
    if python_type is datetime and isinstance(value, str):
        return datetime.fromisoformat(value)
    if python_type is date and isinstance(value, str):
        return date.fromisoformat(value)
    return value


def make_server_op(
    *,
    user_id: str,
    entity: EntityType,
    entity_id: str,
    op_type: SyncOpType,
    patch: dict[str, Any] | None,
    hlc: str,
) -> ServerOplog:
    """Build a server-originated :class:`ServerOplog` row (device ``"server"``)."""
    return ServerOplog(
        user_id=user_id,
        op_id=f"{hlc}:{entity.value}:{entity_id}",
        entity=entity,
        entity_id=entity_id,
        op=op_type,
        patch=patch,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )


def _strip_derived_fields(entity: EntityType, patch: dict[str, Any] | None) -> dict[str, Any] | None:
    """Remove ``DERIVED_FIELDS`` entries from an incoming patch (SYNC §5 step 2, §6)."""
    if patch is None:
        return None
    derived = DERIVED_FIELDS.get(entity.value)
    if not derived:
        return patch
    return {field: value for field, value in patch.items() if field not in derived}


def _insert_fresh(
    model_cls: type[Base], entity_id: str, patch: dict[str, Any], hlc: str, device_id: str, user_id: str
) -> Base:
    """CREATE, row absent: insert the whole doc, ``field_hlcs = {f: hlc for f in patch}``.

    ``user_id`` is stamped from the authenticated caller, never from the patch
    (it is a META column), so a client can never plant a row under another
    account (V2_ADDENDUM A3).
    """
    columns = model_cls.__table__.columns
    row = model_cls(id=entity_id)
    field_hlcs: dict[str, str] = {}
    for name, value in patch.items():
        if name in META_COLUMNS:
            continue
        if name not in columns:
            logger.warning("sync: ignoring unknown patch field %r for %s", name, model_cls.__tablename__)
            continue
        setattr(row, name, coerce_column_value(columns[name], value))
        field_hlcs[name] = hlc

    now = utcnow()
    row.user_id = user_id  # server-authoritative owner scope (A3).
    row.created_at = coerce_column_value(columns["created_at"], patch.get("created_at")) or now
    row.updated_at = coerce_column_value(columns["updated_at"], patch.get("updated_at")) or now
    row.deleted_at = None
    row.updated_hlc = hlc
    row.device_id = device_id
    row.field_hlcs = field_hlcs
    return row


def _merge_update_fields(row: Base, patch: dict[str, Any], hlc: str, device_id: str) -> bool:
    """UPDATE (incl. CREATE downgraded to UPDATE): field-level LWW + resurrection.

    Returns whether anything on ``row`` actually changed (drives the
    applied/skipped split — a fully-stale patch leaves no trace).
    """
    columns = row.__table__.columns
    field_hlcs: dict[str, str] = dict(row.field_hlcs or {})
    changed = False

    for name, value in patch.items():
        if name in META_COLUMNS:
            continue  # bookkeeping columns are never ordinary LWW fields.
        if name not in columns:
            logger.warning("sync: ignoring unknown patch field %r for %s", name, row.__tablename__)
            continue
        if hlc > field_hlcs.get(name, ""):
            setattr(row, name, coerce_column_value(columns[name], value))
            field_hlcs[name] = hlc
            changed = True
        # else: stale write for this field — lose, no mutation (SYNC §5 step 4).

    if row.deleted_at is not None and hlc > field_hlcs.get("__deleted__", ""):
        row.deleted_at = None  # resurrection: a causally-later edit beats the delete.
        changed = True

    if changed:
        row.field_hlcs = field_hlcs  # fresh dict — SQLite JSON columns don't track mutation (§4.6).
        row.updated_hlc = max(row.updated_hlc, hlc)
        row.device_id = device_id  # last-accepted-op's device (informational bookkeeping).
    return changed


def _merge_delete(row: Base, hlc: str, device_id: str) -> bool:
    """DELETE: tombstone iff ``hlc`` causally dominates every field on the row."""
    field_hlcs: dict[str, str] = dict(row.field_hlcs or {})
    if not all(hlc > existing for existing in field_hlcs.values()):
        return False  # a causally-later edit already beat this delete — row survives.
    row.deleted_at = utcnow()
    row.field_hlcs = {**field_hlcs, "__deleted__": hlc}  # fresh dict (§4.6).
    row.updated_hlc = max(row.updated_hlc, hlc)
    row.device_id = device_id
    return True


async def _recompute_actual_focus_seconds(
    session: AsyncSession, *, task_id: str, user_id: str, hlc_clock: HybridLogicalClock
) -> None:
    """SYNC §6: recompute ``task.actual_focus_seconds`` from append-only session facts.

    Sums ``focus_sessions.work_seconds`` for ``task_id`` (excluding tombstoned
    sessions, scoped to ``user_id``) and writes the fresh total with its own
    ``"server"``-device op, bypassing :func:`apply_op`'s derived-field strip
    (this is the one place allowed to set ``actual_focus_seconds``).
    """
    total = await session.scalar(
        select(func.coalesce(func.sum(FocusSessionModel.work_seconds), 0)).where(
            FocusSessionModel.task_id == task_id,
            FocusSessionModel.user_id == user_id,
            FocusSessionModel.deleted_at.is_(None),
        )
    )
    task_row = await session.get(TaskModel, task_id)
    if task_row is None or task_row.user_id != user_id:
        return  # task deleted/never existed or not this user's; nothing to recompute onto.

    new_total = int(total or 0)
    hlc = hlc_clock.tick()
    task_row.actual_focus_seconds = new_total
    field_hlcs = dict(task_row.field_hlcs or {})
    field_hlcs["actual_focus_seconds"] = hlc
    task_row.field_hlcs = field_hlcs  # fresh dict (§4.6).
    task_row.updated_hlc = max(task_row.updated_hlc, hlc)
    task_row.device_id = SERVER_DEVICE_ID

    session.add(
        make_server_op(
            user_id=user_id,
            entity=EntityType.TASK,
            entity_id=task_id,
            op_type=SyncOpType.UPDATE,
            patch={"actual_focus_seconds": new_total},
            hlc=hlc,
        )
    )


async def apply_op(
    session: AsyncSession, op: SyncOp, *, user_id: str, hlc_clock: HybridLogicalClock
) -> ApplyResult:
    """Merge one :class:`SyncOp` into the server DB — SYNC_STRATEGY.md §5, steps 1-6.

    ``user_id`` is the authenticated owner (V2_ADDENDUM A3): every fetched row
    must belong to it, every fresh insert is stamped with it, and every oplog
    append records it. A row that exists under a *different* account is treated
    as untouchable — the op is a no-op, never a cross-user read/write/create.

    Flushes (but does not commit) so an autoincremented ``server_seq`` is
    available on the returned :class:`ApplyResult`; the caller (a single REST
    mutation, or a whole push batch) controls the commit boundary.
    """
    # 1. Idempotency: an already-seen op_id is a no-op (duplicate replay).
    existing = await session.scalar(select(ServerOplog).where(ServerOplog.op_id == op.op_id))
    if existing is not None:
        return ApplyResult(op_id=op.op_id, applied=False)

    model_cls = _ENTITY_MODELS[op.entity]
    entity_id = str(op.entity_id)

    # 2. Strip DERIVED_FIELDS for the entity (task.actual_focus_seconds) from the patch.
    patch = _strip_derived_fields(op.entity, op.patch)

    row = await session.get(model_cls, entity_id)
    # Owner guard (A3): a row belonging to another account is invisible here —
    # can't be updated/deleted, and can't be created *over* (which would also
    # collide on the PK). This is the construction that makes cross-user access
    # impossible; proven in tests/test_multiuser.py.
    if row is not None and row.user_id != user_id:
        return ApplyResult(op_id=op.op_id, applied=False)

    changed: bool

    if op.op is SyncOpType.CREATE:
        if row is None:
            row = _insert_fresh(model_cls, entity_id, patch or {}, op.hlc, op.device_id, user_id)
            session.add(row)
            changed = True
        else:
            # 3. CREATE, row exists: downgrade to UPDATE (same doc, field-by-field).
            changed = _merge_update_fields(row, patch or {}, op.hlc, op.device_id)
    elif op.op is SyncOpType.UPDATE:
        if row is None:
            # No prior CREATE observed for this id — conservatively a no-op
            # rather than fabricating a partial row from a sparse patch (which
            # could violate NOT NULL columns the sparse patch never touches).
            changed = False
        else:
            # 4. UPDATE: field-level LWW + resurrection (see _merge_update_fields).
            changed = _merge_update_fields(row, patch or {}, op.hlc, op.device_id)
    elif op.op is SyncOpType.DELETE:
        # 5. DELETE: tombstone iff this op causally dominates every field on the row.
        changed = False if row is None else _merge_delete(row, op.hlc, op.device_id)
    else:  # pragma: no cover - SyncOpType is exhaustive; guards future additions.
        raise ValueError(f"unknown sync op type: {op.op!r}")

    if not changed:
        return ApplyResult(op_id=op.op_id, applied=False)

    # Mirror the *incoming* op's own identity (op_id/hlc/device_id) verbatim —
    # this is what makes the idempotency check in step 1 exact on retry, and
    # what makes echo suppression (SYNC §4: `device_id != me`) correct for a
    # genuine client device's op. Contrast with make_server_op(), used below
    # and by services/tasks.py, which mints a *new* op_id/hlc/device="server"
    # for mutations the server itself originates (no incoming op to mirror).
    server_op = ServerOplog(
        user_id=user_id,
        op_id=op.op_id,
        entity=op.entity,
        entity_id=entity_id,
        op=op.op,
        patch=patch,
        hlc=op.hlc,
        device_id=op.device_id,
    )
    session.add(server_op)

    # 6. Server only: recompute derived fields when a focus_session op touches
    #    work_seconds (append its own "server"-device op with the fresh total).
    if op.entity is EntityType.FOCUS_SESSION and patch and "work_seconds" in patch:
        await _recompute_actual_focus_seconds(
            session, task_id=row.task_id, user_id=user_id, hlc_clock=hlc_clock
        )

    await session.flush()  # allocate server_seq for the caller/response.
    return ApplyResult(op_id=op.op_id, applied=True, server_seq=server_op.server_seq)


async def push_ops(
    session: AsyncSession,
    request: PushRequest,
    *,
    user_id: str,
    hlc_clock: HybridLogicalClock,
    notifier: SyncNotifier | None = None,
) -> PushResponse:
    """``POST /sync/push`` (SYNC_STRATEGY §4): merge a batch, one commit for the whole batch.

    Every op is stamped/scoped to ``user_id``; after the commit, ``user_id``'s
    ``/ws/sync`` sockets are signalled with the fresh high-water mark (A5).
    """
    applied: list[str] = []
    skipped: list[str] = []
    for op in request.ops:
        result = await apply_op(session, op, user_id=user_id, hlc_clock=hlc_clock)
        (applied if result.applied else skipped).append(result.op_id)
    await session.commit()
    server_seq = await current_server_seq(session, user_id=user_id)
    if applied:
        await notify_user(notifier, session, user_id)
    return PushResponse(applied=applied, skipped=skipped, server_seq=server_seq)


async def pull_ops(
    session: AsyncSession, *, user_id: str, since: int, device_id: str, limit: int
) -> PullResponse:
    """``GET /sync/pull`` (SYNC_STRATEGY §4): echo-suppressed, cursor-paginated, user-scoped.

    Only this user's ops are ever returned (A3); the requesting device's own
    ops are echo-suppressed. The per-(user, device) cursor is upserted to the
    page's ``next_seq`` on every pull.
    """
    stmt = (
        select(ServerOplog)
        .where(
            ServerOplog.user_id == user_id,
            ServerOplog.server_seq > since,
            ServerOplog.device_id != device_id,
        )
        .order_by(ServerOplog.server_seq)
        .limit(limit + 1)  # fetch one extra row to detect has_more without a second query.
    )
    rows = (await session.scalars(stmt)).all()
    has_more = len(rows) > limit
    page = rows[:limit]
    ops = [ServerOp.model_validate(row, from_attributes=True) for row in page]
    next_seq = page[-1].server_seq if page else since
    await _upsert_sync_cursor(session, user_id=user_id, device_id=device_id, last_seq=next_seq)
    await session.commit()
    return PullResponse(ops=ops, next_seq=next_seq, has_more=has_more)


async def _upsert_sync_cursor(
    session: AsyncSession, *, user_id: str, device_id: str, last_seq: int
) -> None:
    """Record how far ``device_id`` has replayed ``user_id``'s oplog (A3)."""
    cursor = await session.get(SyncCursor, (user_id, device_id))
    if cursor is None:
        session.add(SyncCursor(user_id=user_id, device_id=device_id, last_seq=last_seq))
    else:
        cursor.last_seq = last_seq
        cursor.updated_at = utcnow()


def _serialize_scalar(value: Any) -> Any:
    """A single column value, JSON-safe (enum -> value, datetime/date -> ISO string).

    Naive datetimes read back from SQLite's plain ``DateTime`` columns are
    reinterpreted as UTC (ARCHITECTURE §3 — the bootstrap snapshot bypasses the
    :class:`~app.schemas.base.FEBase` wire schemas, so it must apply the same
    tz-aware guarantee itself). ``datetime`` is checked before ``date`` because
    it is a ``date`` subclass.
    """
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _row_to_wire_dict(row: Base) -> dict[str, Any]:
    """Serialize an ORM row to a JSON-safe dict, including ``field_hlcs``.

    Unlike the entity Pydantic schemas (which model the mutable business
    contract only), the bootstrap snapshot exposes every column verbatim —
    clients rehydrate their local Dexie tables (which also carry
    ``field_hlcs``, ARCHITECTURE §7.1) wholesale from this response.
    """
    return {column.name: _serialize_scalar(getattr(row, column.name)) for column in row.__table__.columns}


async def bootstrap_snapshot(session: AsyncSession, *, user_id: str) -> dict[str, Any]:
    """``GET /sync/bootstrap`` (SYNC_STRATEGY §7): this user's live + tombstoned rows.

    Every table is filtered to ``user_id`` (A3) so a fresh device only ever
    hydrates its own account's data; ``server_seq`` is the user's high-water mark.
    """
    snapshot: dict[str, Any] = {}
    for table_key, entity in _BOOTSTRAP_TABLES.items():
        model_cls = _ENTITY_MODELS[entity]
        rows = (await session.scalars(select(model_cls).where(model_cls.user_id == user_id))).all()
        snapshot[table_key] = [_row_to_wire_dict(row) for row in rows]
    snapshot["server_seq"] = await current_server_seq(session, user_id=user_id)
    return snapshot
