"""Project and Section schemas — ARCHITECTURE.md §4.3."""

from __future__ import annotations

from uuid import UUID, uuid4

from pydantic import Field

from app.schemas.base import FEBase, SyncedEntityMixin
from app.schemas.enums import ViewMode


class Project(SyncedEntityMixin):
    """A Todoist-style project container for tasks."""

    id: UUID
    name: str = Field(min_length=1, max_length=120)
    color: str = "#808080"
    view_mode: ViewMode = ViewMode.LIST
    parent_id: UUID | None = None
    child_order: float = 0.0
    is_archived: bool = False


class ProjectCreate(FEBase):
    """Project creation payload: only ``name`` is required."""

    id: UUID = Field(default_factory=uuid4)
    name: str = Field(min_length=1, max_length=120)
    color: str = "#808080"
    view_mode: ViewMode = ViewMode.LIST
    parent_id: UUID | None = None
    child_order: float = 0.0
    is_archived: bool = False


class ProjectUpdate(FEBase):
    """Sparse Project patch: every field is optional."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    view_mode: ViewMode | None = None
    parent_id: UUID | None = None
    child_order: float | None = None
    is_archived: bool | None = None


class Section(SyncedEntityMixin):
    """A named grouping of tasks within a project."""

    id: UUID
    project_id: UUID
    name: str = Field(min_length=1, max_length=120)
    child_order: float = 0.0


class SectionCreate(FEBase):
    """Section creation payload: ``project_id`` and ``name`` are required."""

    id: UUID = Field(default_factory=uuid4)
    project_id: UUID
    name: str = Field(min_length=1, max_length=120)
    child_order: float = 0.0


class SectionUpdate(FEBase):
    """Sparse Section patch: every field is optional."""

    project_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    child_order: float | None = None
