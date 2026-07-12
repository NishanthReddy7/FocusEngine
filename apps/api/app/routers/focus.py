"""Focus-session routes — ARCHITECTURE.md §6, backed by ``FocusSessionManager`` (§5)."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from app.core.deps import get_current_user, get_manager
from app.domain.focus.errors import NoActiveSession
from app.domain.focus.manager import FocusSessionManager
from app.schemas.enums import FocusPreset
from app.schemas.focus import FocusSession

# Router-level dependency: every focus route requires a valid bearer token (A2).
# ``get_manager`` itself resolves the per-user manager from the same token (A3).
router = APIRouter(prefix="/focus", tags=["focus"], dependencies=[Depends(get_current_user)])

Manager = Annotated[FocusSessionManager, Depends(get_manager)]

#: URL action segment -> FocusSessionManager method name. The wire uses a
#: hyphen ("skip-break") while the domain method is snake_case.
_ACTION_METHOD: dict[str, str] = {
    "pause": "pause",
    "resume": "resume",
    "skip-break": "skip_break",
    "complete": "complete",
    "abandon": "abandon",
}


class StartSessionRequest(BaseModel):
    """Body of ``POST /focus/sessions`` (ARCHITECTURE §6)."""

    task_id: UUID
    preset: FocusPreset
    planned_cycles: int | None = Field(default=None, ge=1)


class ActiveSessionResponse(BaseModel):
    """Body of ``GET /focus/sessions/active`` (ARCHITECTURE §6)."""

    session: FocusSession
    remaining_seconds: int


@router.post("/sessions", response_model=FocusSession, status_code=status.HTTP_201_CREATED)
async def start_session(payload: StartSessionRequest, manager: Manager) -> FocusSession:
    """``POST /focus/sessions``: 409 ``SessionAlreadyActive`` (mapped in ``main.py``)."""
    return await manager.start_session(payload.task_id, payload.preset, payload.planned_cycles)


@router.get("/sessions/active", response_model=ActiveSessionResponse)
async def get_active_session(manager: Manager) -> ActiveSessionResponse:
    """``GET /focus/sessions/active``: 404 ``NoActiveSession`` (mapped in ``main.py``)."""
    controller = manager.get_active()
    if controller is None:
        raise NoActiveSession("no active focus session")
    return ActiveSessionResponse(session=controller.session, remaining_seconds=controller.remaining_seconds())


@router.post("/sessions/active/{action}", response_model=FocusSession)
async def act_on_active_session(
    action: Literal["pause", "resume", "skip-break", "complete", "abandon"], manager: Manager
) -> FocusSession:
    """``POST /focus/sessions/active/{action}``: 409 invalid transition, 404 no session."""
    method = getattr(manager, _ACTION_METHOD[action])
    return await method()
