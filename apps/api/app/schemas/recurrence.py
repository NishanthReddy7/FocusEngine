"""Recurrence rule value object — ARCHITECTURE.md §4.2.

The stepping/next-occurrence algorithm that interprets this rule lives in
``app.services.recurrence`` (§4.5); this module only defines the schema.
"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from app.schemas.base import FEBase
from app.schemas.enums import RecurrenceAnchor, RecurrenceFrequency


class RecurrenceRule(FEBase):
    """A recurrence pattern attached to a task's due date."""

    frequency: RecurrenceFrequency
    interval: int = Field(default=1, ge=1)  # every N units
    weekdays: list[int] | None = None  # WEEKLY: 0=Mon..6=Sun
    ordinal: int | None = Field(default=None)  # MONTHLY: 1..4, or -1 = last
    ordinal_weekday: int | None = None  # MONTHLY ordinal: which weekday
    workdays_only: bool = False  # DAILY: steps count Mon-Fri only
    anchor: RecurrenceAnchor = RecurrenceAnchor.SCHEDULED
    until: date | None = None  # inclusive end
    count: int | None = Field(default=None, ge=1)  # max occurrences
    raw: str | None = None  # original NLP phrase
