"""SQLAlchemy declarative base and shared mixins — ARCHITECTURE.md §4.6."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import TypeVar

from sqlalchemy import JSON, String
from sqlalchemy import Enum as SqlEnum
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.schemas.base import utcnow

_EnumT = TypeVar("_EnumT", bound=Enum)


def sa_enum(enum_cls: type[_EnumT]) -> SqlEnum:
    """A SQLAlchemy ``Enum`` column type storing member *values*, not names.

    Plain ``sqlalchemy.Enum(SomeEnum)`` persists the Python member *name*
    (e.g. ``"IN_PROGRESS"``) by default, which would silently diverge from
    the snake_case wire-format *value* (``"in_progress"``) every schema and
    the TS mirror use. ``values_callable`` keeps the stored string identical
    to ``SomeEnum.value`` across the whole stack.
    """
    return SqlEnum(enum_cls, values_callable=lambda cls: [member.value for member in cls])


class Base(DeclarativeBase):
    """Declarative base for every FocusEngine ORM model."""


class TimestampMixin:
    """``created_at``/``updated_at`` audit columns, stamped in UTC."""

    created_at: Mapped[datetime] = mapped_column(default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow, nullable=False)


class SyncMixin:
    """Per-row sync bookkeeping shared by every synced entity table.

    ``field_hlcs`` is the per-field HLC map consumed by the merge algorithm
    (SYNC_STRATEGY.md §5). It must always be reassigned as a fresh dict
    rather than mutated in place — SQLite JSON columns don't track
    in-place mutation (ARCHITECTURE §4.6).
    """

    updated_hlc: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)
    field_hlcs: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)


class UserScopedMixin:
    """Owner scope carried by every synced entity table (V2_ADDENDUM A3).

    ``user_id`` is NOT NULL and indexed on all seven entity tables; every
    query filters ``WHERE user_id = :uid`` so cross-user access is impossible
    by construction. The value is always server-authoritative (stamped from
    the authenticated ``current_user.id``, never trusted from a client patch —
    it is a merge-meta column, see ``services.sync.META_COLUMNS``). Each
    subclass gets its own ``ix_<table>_user_id`` index automatically.
    """

    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
