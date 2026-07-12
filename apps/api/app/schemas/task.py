"""Task schema — ARCHITECTURE.md §4.3 (the unified Todoist+Superfocus entity)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from pydantic import Field

from app.schemas.base import FEBase, SyncedEntityMixin
from app.schemas.due import DueInfo
from app.schemas.enums import EnergyLevel, Priority, TaskStatus
from app.schemas.nlp import NLPMetadata


class Task(SyncedEntityMixin):
    """The unified task schema — Todoist-style capture plus GPS/focus fields."""

    id: UUID
    user_id: UUID | None = None  # single-user MVP
    project_id: UUID | None = None  # None = Inbox
    section_id: UUID | None = None
    parent_id: UUID | None = None  # nested subtasks, arbitrary depth
    title: str = Field(min_length=1, max_length=500)
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: Priority = Priority.P4
    labels: list[str] = Field(default_factory=list)  # lowercase, no leading '#'
    due: DueInfo | None = None
    energy_required: EnergyLevel = EnergyLevel.MEDIUM
    estimated_minutes: int | None = Field(default=None, gt=0)
    actual_focus_seconds: int = 0  # DERIVED — see §4.5
    season_id: UUID | None = None  # Goal-to-Action GPS alignment
    child_order: float = 0.0  # fractional ordering among siblings
    completion_count: int = 0  # recurring-task completions
    last_completed_at: datetime | None = None
    nlp: NLPMetadata | None = None
    # + audit/sync block (via SyncedEntityMixin)


class TaskCreate(FEBase):
    """Task creation payload: only ``title`` is required; audit/sync fields
    are server-stamped and therefore not accepted here."""

    id: UUID = Field(default_factory=uuid4)
    user_id: UUID | None = None
    project_id: UUID | None = None
    section_id: UUID | None = None
    parent_id: UUID | None = None
    title: str = Field(min_length=1, max_length=500)
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: Priority = Priority.P4
    labels: list[str] = Field(default_factory=list)
    due: DueInfo | None = None
    energy_required: EnergyLevel = EnergyLevel.MEDIUM
    estimated_minutes: int | None = Field(default=None, gt=0)
    actual_focus_seconds: int = 0
    season_id: UUID | None = None
    child_order: float = 0.0
    completion_count: int = 0
    last_completed_at: datetime | None = None
    nlp: NLPMetadata | None = None


class TaskUpdate(FEBase):
    """Sparse Task patch: every field is optional; ``id`` comes from the URL."""

    user_id: UUID | None = None
    project_id: UUID | None = None
    section_id: UUID | None = None
    parent_id: UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    status: TaskStatus | None = None
    priority: Priority | None = None
    labels: list[str] | None = None
    due: DueInfo | None = None
    energy_required: EnergyLevel | None = None
    estimated_minutes: int | None = Field(default=None, gt=0)
    actual_focus_seconds: int | None = None
    season_id: UUID | None = None
    child_order: float | None = None
    completion_count: int | None = None
    last_completed_at: datetime | None = None
    nlp: NLPMetadata | None = None
