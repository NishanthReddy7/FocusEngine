"""Vision and Season schemas (Goal-to-Action GPS) — ARCHITECTURE.md §4.3."""

from __future__ import annotations

from datetime import date, timedelta
from uuid import UUID, uuid4

from pydantic import Field, model_validator

from app.schemas.base import FEBase, SyncedEntityMixin
from app.schemas.enums import SeasonStatus

#: A Season defaults to a 12-week (84-day, i.e. +83 days inclusive of the
#: start day) span when ``ends_on`` is not supplied — ARCHITECTURE §4.3.
SEASON_DEFAULT_LENGTH_DAYS = 83


class Vision(SyncedEntityMixin):
    """A long-horizon aspiration at the top of the Goal-to-Action pipeline."""

    id: UUID
    title: str = Field(min_length=1, max_length=200)
    narrative: str = ""
    horizon_years: int = 3
    is_archived: bool = False


class VisionCreate(FEBase):
    """Vision creation payload: only ``title`` is required."""

    id: UUID = Field(default_factory=uuid4)
    title: str = Field(min_length=1, max_length=200)
    narrative: str = ""
    horizon_years: int = 3
    is_archived: bool = False


class VisionUpdate(FEBase):
    """Sparse Vision patch: every field is optional."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    narrative: str | None = None
    horizon_years: int | None = None
    is_archived: bool | None = None


class Season(SyncedEntityMixin):
    """A 12-week execution window under a Vision."""

    id: UUID
    vision_id: UUID | None = None
    title: str = Field(min_length=1, max_length=200)
    objective: str = ""
    key_results: list[str] = []
    starts_on: date
    ends_on: date | None = None  # defaulted below when omitted
    status: SeasonStatus = SeasonStatus.PLANNED

    @model_validator(mode="after")
    def _default_ends_on(self) -> "Season":
        """Default ``ends_on`` to ``starts_on + 83 days`` (12 weeks) if omitted."""
        if self.ends_on is None:
            self.ends_on = self.starts_on + timedelta(days=SEASON_DEFAULT_LENGTH_DAYS)
        return self


class SeasonCreate(FEBase):
    """Season creation payload: ``title`` and ``starts_on`` are required."""

    id: UUID = Field(default_factory=uuid4)
    vision_id: UUID | None = None
    title: str = Field(min_length=1, max_length=200)
    objective: str = ""
    key_results: list[str] = []
    starts_on: date
    ends_on: date | None = None
    status: SeasonStatus = SeasonStatus.PLANNED

    @model_validator(mode="after")
    def _default_ends_on(self) -> "SeasonCreate":
        if self.ends_on is None:
            self.ends_on = self.starts_on + timedelta(days=SEASON_DEFAULT_LENGTH_DAYS)
        return self


class SeasonUpdate(FEBase):
    """Sparse Season patch: every field is optional (no ends_on auto-default)."""

    vision_id: UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    objective: str | None = None
    key_results: list[str] | None = None
    starts_on: date | None = None
    ends_on: date | None = None
    status: SeasonStatus | None = None
