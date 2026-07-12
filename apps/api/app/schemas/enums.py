"""Wire-contract enums — ARCHITECTURE.md §4.1.

TS mirror: ``packages/schemas/ts/enums.ts``. Every string enum's *value*
(not its member name) is what crosses the wire, so values here must match
the TS side verbatim.
"""

from __future__ import annotations

from enum import Enum, IntEnum
from typing import NamedTuple


class Priority(IntEnum):
    """Todoist convention: P1 is the highest priority."""

    P1 = 1
    P2 = 2
    P3 = 3
    P4 = 4


class EnergyLevel(str, Enum):
    """Self-reported energy/effort level, used both on tasks and check-ins."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class TaskStatus(str, Enum):
    """Lifecycle state of a Task."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class SessionState(str, Enum):
    """Runtime state of the FocusController state machine (ARCHITECTURE §5)."""

    IDLE = "idle"
    ACTIVE_WORK = "active_work"
    PAUSED = "paused"
    BREAK = "break"
    COMPLETED = "completed"


class SessionOutcome(str, Enum):
    """How a finalized FocusSession ended."""

    COMPLETED = "completed"
    ABANDONED = "abandoned"


class FocusPreset(str, Enum):
    """Cognitive-load ladder of focus-timer presets.

    ``work_minutes``/``break_minutes`` are exposed as properties backed by
    the module-level :data:`PRESET_DURATIONS` table (mirrored in TS as
    ``PRESET_DURATIONS`` in ``packages/schemas/ts/enums.ts``).
    """

    SPRINT = "sprint"
    FOCUS = "focus"
    FLOW = "flow"
    DEEP_WORK = "deep_work"

    @property
    def work_minutes(self) -> int:
        """Planned work-block length, in minutes, for this preset."""
        return PRESET_DURATIONS[self].work_minutes

    @property
    def break_minutes(self) -> int:
        """Planned break length, in minutes, for this preset."""
        return PRESET_DURATIONS[self].break_minutes


class RecurrenceFrequency(str, Enum):
    """The unit a :class:`~app.schemas.recurrence.RecurrenceRule` steps by."""

    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


class RecurrenceAnchor(str, Enum):
    """What a recurrence's next occurrence is computed relative to (§4.5)."""

    SCHEDULED = "scheduled"
    COMPLETED = "completed"


class SyncOpType(str, Enum):
    """The kind of change a :class:`~app.schemas.sync.SyncOp` represents."""

    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


class EntityType(str, Enum):
    """Every entity kind that flows through the sync oplog."""

    TASK = "task"
    PROJECT = "project"
    SECTION = "section"
    VISION = "vision"
    SEASON = "season"
    FOCUS_SESSION = "focus_session"
    DAILY_REVIEW = "daily_review"


class ViewMode(str, Enum):
    """How a project's tasks are laid out in the client UI."""

    LIST = "list"
    BOARD = "board"
    CALENDAR = "calendar"


class CaptureSource(str, Enum):
    """How a task's NLP metadata was captured."""

    TEXT = "text"
    VOICE = "voice"
    API = "api"


class AmbientTrack(str, Enum):
    """Background audio track played during a focus session (§7.5)."""

    NONE = "none"
    WHITE_NOISE = "white_noise"
    BINAURAL = "binaural"
    LOFI = "lofi"
    RAIN = "rain"


class SeasonStatus(str, Enum):
    """Lifecycle state of a 12-week Season."""

    PLANNED = "planned"
    ACTIVE = "active"
    COMPLETED = "completed"


class PresetDuration(NamedTuple):
    """One row of the preset-durations table (ARCHITECTURE §4.1)."""

    work_minutes: int
    break_minutes: int


PRESET_DURATIONS: dict[FocusPreset, PresetDuration] = {
    FocusPreset.SPRINT: PresetDuration(work_minutes=15, break_minutes=3),
    FocusPreset.FOCUS: PresetDuration(work_minutes=30, break_minutes=5),
    FocusPreset.FLOW: PresetDuration(work_minutes=45, break_minutes=10),
    FocusPreset.DEEP_WORK: PresetDuration(work_minutes=90, break_minutes=15),
}
