"""Project and Section ORM models — ARCHITECTURE.md §4.6."""

from __future__ import annotations

from sqlalchemy import Boolean, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SyncMixin, TimestampMixin, UserScopedMixin, sa_enum
from app.schemas.enums import ViewMode


class Project(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """A Todoist-style project container for tasks."""

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#808080", nullable=False)
    view_mode: Mapped[ViewMode] = mapped_column(
        sa_enum(ViewMode), default=ViewMode.LIST, nullable=False
    )
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    child_order: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Section(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """A named grouping of tasks within a project."""

    __tablename__ = "sections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    child_order: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
