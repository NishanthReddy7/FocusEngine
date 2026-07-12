"""Vision and Season ORM models (Goal-to-Action GPS) — ARCHITECTURE.md §4.6."""

from __future__ import annotations

from datetime import date

from sqlalchemy import JSON, Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SyncMixin, TimestampMixin, UserScopedMixin, sa_enum
from app.schemas.enums import SeasonStatus


class Vision(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """A long-horizon aspiration at the top of the Goal-to-Action pipeline."""

    __tablename__ = "visions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    narrative: Mapped[str] = mapped_column(default="", nullable=False)
    horizon_years: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Season(Base, TimestampMixin, SyncMixin, UserScopedMixin):
    """A 12-week execution window under a Vision.

    ``key_results`` is a JSON column (ARCHITECTURE §4.6): always reassign a
    fresh list rather than mutating it in place.
    """

    __tablename__ = "seasons"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    vision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    objective: Mapped[str] = mapped_column(default="", nullable=False)
    key_results: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    starts_on: Mapped[date] = mapped_column(nullable=False)
    ends_on: Mapped[date] = mapped_column(nullable=False)
    status: Mapped[SeasonStatus] = mapped_column(
        sa_enum(SeasonStatus), default=SeasonStatus.PLANNED, nullable=False
    )
