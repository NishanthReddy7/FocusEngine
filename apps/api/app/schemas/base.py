"""Base Pydantic model and shared helpers for the FocusEngine wire contract.

ARCHITECTURE.md §3, §4.2: one wire format (snake_case JSON, UTC ISO-8601
datetimes) shared by Pydantic, SQLAlchemy, and TypeScript — every model in
``app.schemas`` extends :class:`FEBase`.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, model_validator


class FEBase(BaseModel):
    """Common Pydantic v2 configuration for every FocusEngine wire model.

    ``from_attributes=True`` lets these models validate directly from
    SQLAlchemy ORM instances; ``extra="forbid"`` rejects unknown fields so
    typos and stale clients fail loudly instead of silently dropping data.
    """

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def _ensure_utc_datetimes(self) -> "FEBase":
        """Guarantee every datetime on the wire is tz-aware UTC (ARCHITECTURE §3).

        SQLite's plain ``DateTime`` columns (via aiosqlite) drop tzinfo on
        round-trip, so audit fields like ``created_at``/``updated_at`` read back
        *naive* even though every write stamps UTC (``utcnow``). A naive UTC
        timestamp is a contract violation — a JS client's ``new Date()`` parses
        it as *local* time, shifting it by the viewer's offset. The stored value
        is always UTC wall-clock, so a naive datetime is reinterpreted as UTC
        here (tz-aware values pass through untouched; pure ``date``/``time`` are
        not ``datetime`` instances and are left alone).
        """
        for name, value in self.__dict__.items():
            if isinstance(value, datetime) and value.tzinfo is None:
                object.__setattr__(self, name, value.replace(tzinfo=timezone.utc))
        return self


def utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC ``datetime``.

    ARCHITECTURE.md §3: naive datetimes are never used anywhere in the
    system; every timestamp is tz-aware UTC.
    """
    return datetime.now(timezone.utc)


class SyncedEntityMixin(FEBase):
    """The audit/sync block carried by every synced entity (ARCHITECTURE §4.3).

    Defined once here and reused by every top-level entity schema (Task,
    Project, Section, Vision, Season, FocusSession, DailyReview) so the five
    fields and their defaults stay perfectly consistent across the contract.
    """

    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    updated_hlc: str
    device_id: str | None = None
