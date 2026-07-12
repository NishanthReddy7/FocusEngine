"""Domain services. Task T1 provides the recurrence engine (§4.5);
``tasks.py``/``sync.py`` (Task T4) add task completion, the sync merge
algorithm, and the SQL-backed focus-domain port adapters."""

from __future__ import annotations

from app.services.recurrence import compute_next
from app.services.sync import (
    DERIVED_FIELDS,
    SERVER_DEVICE_ID,
    ApplyResult,
    apply_op,
    bootstrap_snapshot,
    pull_ops,
    push_ops,
)
from app.services.tasks import SqlSessionStore, SqlTaskTimeSink, complete_task

__all__ = [
    "DERIVED_FIELDS",
    "SERVER_DEVICE_ID",
    "ApplyResult",
    "SqlSessionStore",
    "SqlTaskTimeSink",
    "apply_op",
    "bootstrap_snapshot",
    "complete_task",
    "compute_next",
    "pull_ops",
    "push_ops",
]
