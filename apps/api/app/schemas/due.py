"""Due-date value object — ARCHITECTURE.md §4.2."""

from __future__ import annotations

# Aliased on import: fields below are named `date`/`time` to match the wire
# contract, and (with `from __future__ import annotations`) a field
# assignment such as `time: time | None = None` would rebind the class-body
# name `time` to `None`, shadowing the type when Pydantic later evaluates
# the stringified annotation — aliasing sidesteps the collision entirely.
from datetime import date as date_
from datetime import time as time_

from app.schemas.base import FEBase
from app.schemas.recurrence import RecurrenceRule


class DueInfo(FEBase):
    """A task's due date/time, timezone, and optional recurrence."""

    date: date_
    time: time_ | None = None
    timezone: str = "UTC"  # IANA name
    recurrence: RecurrenceRule | None = None
