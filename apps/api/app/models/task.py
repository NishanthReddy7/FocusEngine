"""Task ORM model — ARCHITECTURE.md §4.6."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Float, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SyncMixin, TimestampMixin, UserScopedMixin, sa_enum
from app.schemas.enums import EnergyLevel, Priority, TaskStatus


class Task(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """The unified task row — Todoist-style capture plus GPS/focus fields.

    ``labels``, ``due``, and ``nlp`` are JSON columns (ARCHITECTURE §4.6):
    never mutate them in place, always assign a fresh dict/list so SQLite
    picks up the change.
    """

    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_tasks_project_id", "project_id"),
        Index("ix_tasks_section_id", "section_id"),
        Index("ix_tasks_parent_id", "parent_id"),
        Index("ix_tasks_season_id", "season_id"),
        Index("ix_tasks_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # user_id (NOT NULL, indexed) is provided by UserScopedMixin.
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    section_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(default="", nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        sa_enum(TaskStatus), default=TaskStatus.PENDING, nullable=False
    )
    # Priority is an IntEnum stored as a plain integer; Pydantic (Task.priority:
    # Priority) coerces the raw int back on read via from_attributes.
    priority: Mapped[int] = mapped_column(Integer, default=Priority.P4.value, nullable=False)
    labels: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    due: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    energy_required: Mapped[EnergyLevel] = mapped_column(
        sa_enum(EnergyLevel), default=EnergyLevel.MEDIUM, nullable=False
    )
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # DERIVED — see §4.5: recomputed from focus_sessions, never client-writable.
    actual_focus_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    season_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    child_order: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    completion_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    nlp: Mapped[dict | None] = mapped_column(JSON, nullable=True)
