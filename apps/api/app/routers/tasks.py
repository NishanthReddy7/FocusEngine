"""Task CRUD + completion routes — ARCHITECTURE.md §6; user-scoped per V2_ADDENDUM A3."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db, get_hlc_clock, get_notifier
from app.models.task import Task as TaskModel
from app.schemas.enums import TaskStatus
from app.schemas.hlc import HybridLogicalClock
from app.schemas.task import Task, TaskCreate, TaskUpdate
from app.services.sync import SyncNotifier
from app.services.tasks import complete_task, create_task_rest, delete_task_rest, update_task_rest

# Router-level dependency: every task route requires a valid bearer token (A2).
router = APIRouter(prefix="/tasks", tags=["tasks"], dependencies=[Depends(get_current_user)])

DbSession = Annotated[AsyncSession, Depends(get_db)]
HlcClock = Annotated[HybridLogicalClock, Depends(get_hlc_clock)]
Notifier = Annotated[SyncNotifier, Depends(get_notifier)]


async def _get_live_task_or_404(session: AsyncSession, task_id: UUID, user_id: str) -> TaskModel:
    """Fetch a live, *owned* (non-tombstoned) task or raise 404 (ARCHITECTURE §6, A3).

    Another user's task is indistinguishable from a missing one — same 404, so
    existence itself never leaks across accounts.
    """
    row = await session.get(TaskModel, str(task_id))
    if row is None or row.deleted_at is not None or row.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")
    return row


@router.get("", response_model=list[Task])
async def list_tasks(
    session: DbSession,
    current_user: CurrentUser,
    project_id: UUID | None = None,
    season_id: UUID | None = None,
    status_filter: Annotated[TaskStatus | None, Query(alias="status")] = None,
    label: str | None = None,
    parent_id: UUID | None = None,
) -> list[TaskModel]:
    """``GET /tasks``: this user's live (non-tombstoned) tasks, filterable (§6, A3)."""
    stmt = select(TaskModel).where(
        TaskModel.user_id == current_user.id, TaskModel.deleted_at.is_(None)
    )
    if project_id is not None:
        stmt = stmt.where(TaskModel.project_id == str(project_id))
    if season_id is not None:
        stmt = stmt.where(TaskModel.season_id == str(season_id))
    if status_filter is not None:
        stmt = stmt.where(TaskModel.status == status_filter)
    if parent_id is not None:
        stmt = stmt.where(TaskModel.parent_id == str(parent_id))
    rows = list((await session.scalars(stmt)).all())
    if label is not None:
        # `labels` is a JSON column (no portable indexed containment query in
        # SQLite); filtering in Python is fine at this MVP's scale.
        rows = [row for row in rows if label in (row.labels or [])]
    return rows


@router.post("", response_model=Task, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> TaskModel:
    """``POST /tasks``: server stamps owner/hlc/audit, oplog append, WS notify (§6, A3/A5)."""
    return await create_task_rest(
        session, payload, user_id=current_user.id, hlc_clock=hlc_clock, notifier=notifier
    )


@router.get("/{task_id}", response_model=Task)
async def get_task(task_id: UUID, session: DbSession, current_user: CurrentUser) -> TaskModel:
    """``GET /tasks/{id}``: 404 if missing/deleted/not-owned (ARCHITECTURE §6, A3)."""
    return await _get_live_task_or_404(session, task_id, current_user.id)


@router.patch("/{task_id}", response_model=Task)
async def patch_task(
    task_id: UUID, payload: TaskUpdate, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> TaskModel:
    """``PATCH /tasks/{id}``: sparse patch on an owned task, oplog append (§6, A3)."""
    await _get_live_task_or_404(session, task_id, current_user.id)
    updated = await update_task_rest(
        session, task_id, payload, user_id=current_user.id, hlc_clock=hlc_clock, notifier=notifier
    )
    assert updated is not None  # the row was confirmed to exist just above.
    return updated


@router.delete("/{task_id}", response_model=None, status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: UUID, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> None:
    """``DELETE /tasks/{id}``: tombstone an owned task, oplog append (§6, A3)."""
    await _get_live_task_or_404(session, task_id, current_user.id)
    await delete_task_rest(
        session, task_id, user_id=current_user.id, hlc_clock=hlc_clock, notifier=notifier
    )


@router.post("/{task_id}/complete", response_model=Task)
async def complete_task_route(
    task_id: UUID, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> TaskModel:
    """``POST /tasks/{id}/complete``: recurrence roll on an owned task (§6, A3)."""
    row = await _get_live_task_or_404(session, task_id, current_user.id)
    return await complete_task(
        session, row, user_id=current_user.id, hlc_clock=hlc_clock, notifier=notifier
    )
