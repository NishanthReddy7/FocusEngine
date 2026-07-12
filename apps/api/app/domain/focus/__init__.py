"""Focus state-machine domain package (ARCHITECTURE §5).

Re-exports the public surface so callers can ``from app.domain.focus import
FocusSessionManager, EventBus`` without reaching into submodules.
"""

from __future__ import annotations

from app.domain.focus.controller import TRANSITIONS, FocusController
from app.domain.focus.errors import (
    FocusError,
    InvalidTransition,
    NoActiveSession,
    SessionAlreadyActive,
)
from app.domain.focus.events import (
    EVENT_BREAK_STARTED,
    EVENT_CYCLE_COMPLETED,
    EVENT_SESSION_COMPLETED,
    EVENT_SESSION_PAUSED,
    EVENT_SESSION_RESUMED,
    EVENT_SESSION_STARTED,
    EVENT_TIME_ADDED,
    EventBus,
    FocusEvent,
)
from app.domain.focus.manager import FocusSessionManager
from app.domain.focus.ports import SessionStore, TaskTimeSink
from app.domain.focus.timer import (
    AsyncioTimerFactory,
    Clock,
    ManualTimerFactory,
    SystemClock,
    TimerFactory,
    TimerHandle,
)

__all__ = [
    "TRANSITIONS",
    "FocusController",
    "FocusSessionManager",
    "EventBus",
    "FocusEvent",
    "EVENT_SESSION_STARTED",
    "EVENT_SESSION_PAUSED",
    "EVENT_SESSION_RESUMED",
    "EVENT_BREAK_STARTED",
    "EVENT_CYCLE_COMPLETED",
    "EVENT_SESSION_COMPLETED",
    "EVENT_TIME_ADDED",
    "TaskTimeSink",
    "SessionStore",
    "Clock",
    "SystemClock",
    "TimerHandle",
    "TimerFactory",
    "AsyncioTimerFactory",
    "ManualTimerFactory",
    "FocusError",
    "InvalidTransition",
    "NoActiveSession",
    "SessionAlreadyActive",
]
