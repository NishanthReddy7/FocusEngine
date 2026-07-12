"""Daily review (intention-loop) schema — ARCHITECTURE.md §4.3."""

from __future__ import annotations

from datetime import date as date_
from uuid import UUID, uuid4

from pydantic import Field

from app.schemas.base import FEBase, SyncedEntityMixin


class DailyReview(SyncedEntityMixin):
    """End-of-day reflection: energy, mood, and what got done."""

    id: UUID
    date: date_
    energy_level: int = Field(ge=1, le=5)
    mood: str | None = None
    focus_seconds: int = 0
    tasks_completed: int = 0
    highlights: str = ""
    friction: str = ""
    ai_feedback: str | None = None  # canned stub for MVP — TODO(LLM)


class DailyReviewCreate(FEBase):
    """DailyReview creation payload: ``date`` and ``energy_level`` are required."""

    id: UUID = Field(default_factory=uuid4)
    date: date_
    energy_level: int = Field(ge=1, le=5)
    mood: str | None = None
    focus_seconds: int = 0
    tasks_completed: int = 0
    highlights: str = ""
    friction: str = ""
    ai_feedback: str | None = None


class DailyReviewUpdate(FEBase):
    """Sparse DailyReview patch: every field is optional."""

    date: date_ | None = None
    energy_level: int | None = Field(default=None, ge=1, le=5)
    mood: str | None = None
    focus_seconds: int | None = None
    tasks_completed: int | None = None
    highlights: str | None = None
    friction: str | None = None
    ai_feedback: str | None = None
