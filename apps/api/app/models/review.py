"""DailyReview ORM model — ARCHITECTURE.md §4.6."""

from __future__ import annotations

# Aliased: the column below is named `date` (matching the wire contract),
# and a same-named field assignment would shadow the `date` type when
# annotations are evaluated lazily (see app/schemas/due.py for the same
# issue spelled out in full).
from datetime import date as date_

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SyncMixin, TimestampMixin, UserScopedMixin


class DailyReview(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """End-of-day reflection: energy, mood, and what got done."""

    __tablename__ = "daily_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    date: Mapped[date_] = mapped_column(index=True, nullable=False)
    energy_level: Mapped[int] = mapped_column(Integer, nullable=False)
    mood: Mapped[str | None] = mapped_column(String(120), nullable=True)
    focus_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tasks_completed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    highlights: Mapped[str] = mapped_column(default="", nullable=False)
    friction: Mapped[str] = mapped_column(default="", nullable=False)
    ai_feedback: Mapped[str | None] = mapped_column(nullable=True)
