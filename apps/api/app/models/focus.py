"""FocusSession ORM model — ARCHITECTURE.md §4.6."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SyncMixin, TimestampMixin, UserScopedMixin, sa_enum
from app.schemas.enums import AmbientTrack, EnergyLevel, FocusPreset, SessionOutcome, SessionState


class FocusSession(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """A single focus-timer run against one task (ARCHITECTURE §5).

    ``segments`` is a JSON column: always reassign a fresh list rather than
    mutating it in place (ARCHITECTURE §4.6).
    """

    __tablename__ = "focus_sessions"
    __table_args__ = (Index("ix_focus_sessions_task_id", "task_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(36), nullable=False)
    preset: Mapped[FocusPreset] = mapped_column(sa_enum(FocusPreset), nullable=False)
    planned_cycles: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[SessionState] = mapped_column(
        sa_enum(SessionState), default=SessionState.IDLE, nullable=False
    )
    outcome: Mapped[SessionOutcome | None] = mapped_column(sa_enum(SessionOutcome), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)
    work_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    break_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cycles_completed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    segments: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    ambient_track: Mapped[AmbientTrack] = mapped_column(
        sa_enum(AmbientTrack), default=AmbientTrack.NONE, nullable=False
    )
    energy_after: Mapped[EnergyLevel | None] = mapped_column(sa_enum(EnergyLevel), nullable=True)
