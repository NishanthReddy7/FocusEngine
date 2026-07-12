"""User ORM model — V2_ADDENDUM A2 (identity & auth).

A ``users`` row is created on first Google sign-in (upsert by ``google_sub``)
and is the anchor every other table's ``user_id`` foreign-scopes to. It is not
a synced entity — it carries no HLC/oplog bookkeeping, only identity plus a
free-form ``settings`` JSON blob the client mirrors into ``_meta.settings``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.schemas.base import utcnow


class User(Base):
    """An authenticated account, keyed to a Google subject identifier."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    google_sub: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    picture: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # Free-form per-user preferences (theme, default preset, week start, …).
    # JSON column: always reassign a fresh dict rather than mutating in place
    # so SQLite/aiosqlite picks up the change (ARCHITECTURE §4.6).
    settings: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, nullable=False)
