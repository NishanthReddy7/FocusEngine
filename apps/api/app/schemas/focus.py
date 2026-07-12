"""Focus session schemas — ARCHITECTURE.md §4.2 (SessionSegment) and §4.3 (FocusSession).

The state machine that drives these fields at runtime lives in
``app.domain.focus`` (ARCHITECTURE §5, Task T2); this module only defines
the wire schema.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from pydantic import Field

from app.schemas.base import FEBase, SyncedEntityMixin
from app.schemas.enums import AmbientTrack, EnergyLevel, FocusPreset, SessionOutcome, SessionState


class SessionSegment(FEBase):
    """One contiguous ACTIVE_WORK or BREAK interval within a focus session."""

    state: SessionState  # ACTIVE_WORK or BREAK only
    started_at: datetime
    ended_at: datetime | None = None


class FocusSession(SyncedEntityMixin):
    """A single focus-timer run against one task."""

    id: UUID
    task_id: UUID
    preset: FocusPreset
    planned_cycles: int | None = None  # None = run until complete()/abandon()
    state: SessionState = SessionState.IDLE
    outcome: SessionOutcome | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    work_seconds: int = 0
    break_seconds: int = 0
    cycles_completed: int = 0
    segments: list[SessionSegment] = []
    ambient_track: AmbientTrack = AmbientTrack.NONE
    energy_after: EnergyLevel | None = None


class FocusSessionCreate(FEBase):
    """FocusSession creation payload: ``task_id`` and ``preset`` are required."""

    id: UUID = Field(default_factory=uuid4)
    task_id: UUID
    preset: FocusPreset
    planned_cycles: int | None = None
    state: SessionState = SessionState.IDLE
    outcome: SessionOutcome | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    work_seconds: int = 0
    break_seconds: int = 0
    cycles_completed: int = 0
    segments: list[SessionSegment] = []
    ambient_track: AmbientTrack = AmbientTrack.NONE
    energy_after: EnergyLevel | None = None


class FocusSessionUpdate(FEBase):
    """Sparse FocusSession patch: every field is optional."""

    task_id: UUID | None = None
    preset: FocusPreset | None = None
    planned_cycles: int | None = None
    state: SessionState | None = None
    outcome: SessionOutcome | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    work_seconds: int | None = None
    break_seconds: int | None = None
    cycles_completed: int | None = None
    segments: list[SessionSegment] | None = None
    ambient_track: AmbientTrack | None = None
    energy_after: EnergyLevel | None = None
