"""Sync bookkeeping ORM models — ARCHITECTURE.md §4.6; protocol in SYNC_STRATEGY.md §4-§5.

Both the server oplog and the per-device pull cursors are scoped by
``user_id`` (V2_ADDENDUM A3) so push/pull/bootstrap never cross accounts.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, sa_enum
from app.schemas.base import utcnow
from app.schemas.enums import EntityType, SyncOpType


class ServerOplog(Base):
    """The server-side append-only change log (allocates ``server_seq``).

    Every server-originated mutation (recurrence rolls, focus-time credits)
    and every accepted client push is appended here — this is what
    ``GET /sync/pull`` replays to *that user's* other devices. ``server_seq``
    stays a single global autoincrement PK; the per-user cursor is enforced by
    the ``user_id`` filter on every read, not by a per-user sequence.
    """

    __tablename__ = "server_oplog"

    server_seq: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    op_id: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    entity: Mapped[EntityType] = mapped_column(sa_enum(EntityType), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    op: Mapped[SyncOpType] = mapped_column(sa_enum(SyncOpType), nullable=False)
    patch: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    hlc: Mapped[str] = mapped_column(String(40), nullable=False)
    device_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    received_at: Mapped[datetime] = mapped_column(default=utcnow, nullable=False)


class SyncCursor(Base):
    """Per-(user, device) high-water mark, upserted on every pull (A3).

    Records how far each device has replayed the oplog. The composite primary
    key ``(user_id, device_id)`` means one row per device per account; ``GET
    /sync/pull`` upserts ``last_seq`` = the page's ``next_seq`` and stamps
    ``updated_at``.
    """

    __tablename__ = "sync_cursors"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    last_seq: Mapped[int] = mapped_column(default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow, nullable=False)
