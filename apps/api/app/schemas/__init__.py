"""Pydantic v2 wire contract — re-exports every schema (ARCHITECTURE.md §4)."""

from __future__ import annotations

from app.schemas.base import FEBase, SyncedEntityMixin, utcnow
from app.schemas.due import DueInfo
from app.schemas.enums import (
    PRESET_DURATIONS,
    AmbientTrack,
    CaptureSource,
    EnergyLevel,
    EntityType,
    FocusPreset,
    Priority,
    PresetDuration,
    RecurrenceAnchor,
    RecurrenceFrequency,
    SeasonStatus,
    SessionOutcome,
    SessionState,
    SyncOpType,
    TaskStatus,
    ViewMode,
)
from app.schemas.focus import (
    FocusSession,
    FocusSessionCreate,
    FocusSessionUpdate,
    SessionSegment,
)
from app.schemas.goals import (
    Season,
    SeasonCreate,
    SeasonUpdate,
    Vision,
    VisionCreate,
    VisionUpdate,
)
from app.schemas.hlc import SKEW_CAP_MS, HybridLogicalClock, device8, format_hlc, parse_hlc
from app.schemas.nlp import NLPMetadata
from app.schemas.project import (
    Project,
    ProjectCreate,
    ProjectUpdate,
    Section,
    SectionCreate,
    SectionUpdate,
)
from app.schemas.recurrence import RecurrenceRule
from app.schemas.review import DailyReview, DailyReviewCreate, DailyReviewUpdate
from app.schemas.sync import PullResponse, PushRequest, PushResponse, ServerOp, SyncOp
from app.schemas.task import Task, TaskCreate, TaskUpdate

__all__ = [
    "PRESET_DURATIONS",
    "SKEW_CAP_MS",
    "AmbientTrack",
    "CaptureSource",
    "DailyReview",
    "DailyReviewCreate",
    "DailyReviewUpdate",
    "DueInfo",
    "EnergyLevel",
    "EntityType",
    "FEBase",
    "FocusPreset",
    "FocusSession",
    "FocusSessionCreate",
    "FocusSessionUpdate",
    "HybridLogicalClock",
    "NLPMetadata",
    "Priority",
    "PresetDuration",
    "Project",
    "ProjectCreate",
    "ProjectUpdate",
    "PullResponse",
    "PushRequest",
    "PushResponse",
    "RecurrenceAnchor",
    "RecurrenceFrequency",
    "RecurrenceRule",
    "Season",
    "SeasonCreate",
    "SeasonStatus",
    "SeasonUpdate",
    "Section",
    "SectionCreate",
    "SectionUpdate",
    "ServerOp",
    "SessionOutcome",
    "SessionSegment",
    "SessionState",
    "SyncOp",
    "SyncOpType",
    "SyncedEntityMixin",
    "Task",
    "TaskCreate",
    "TaskStatus",
    "TaskUpdate",
    "ViewMode",
    "Vision",
    "VisionCreate",
    "VisionUpdate",
    "device8",
    "format_hlc",
    "parse_hlc",
    "utcnow",
]
