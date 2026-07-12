"""Sync protocol routes — SYNC_STRATEGY.md §4 (push/pull), §7 (bootstrap); user-scoped (A3)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db, get_hlc_clock, get_notifier
from app.schemas.hlc import HybridLogicalClock
from app.schemas.sync import PullResponse, PushRequest, PushResponse
from app.services.sync import SyncNotifier, bootstrap_snapshot, pull_ops, push_ops

# Router-level dependency: every sync route requires a valid bearer token (A2).
router = APIRouter(prefix="/sync", tags=["sync"], dependencies=[Depends(get_current_user)])

DbSession = Annotated[AsyncSession, Depends(get_db)]
HlcClock = Annotated[HybridLogicalClock, Depends(get_hlc_clock)]
Notifier = Annotated[SyncNotifier, Depends(get_notifier)]


@router.post("/push", response_model=PushResponse)
async def push(
    payload: PushRequest, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> PushResponse:
    """``POST /sync/push`` (SYNC §4): merge a batch of this user's client ops, then notify (A5)."""
    return await push_ops(
        session, payload, user_id=current_user.id, hlc_clock=hlc_clock, notifier=notifier
    )


@router.get("/pull", response_model=PullResponse)
async def pull(
    session: DbSession,
    current_user: CurrentUser,
    device_id: str,
    since: int = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 500,
) -> PullResponse:
    """``GET /sync/pull`` (SYNC §4): this user's ops only, echo-suppressed, cursor-upserted (A3)."""
    return await pull_ops(
        session, user_id=current_user.id, since=since, device_id=device_id, limit=limit
    )


@router.get("/bootstrap")
async def bootstrap(session: DbSession, current_user: CurrentUser) -> dict[str, Any]:
    """``GET /sync/bootstrap`` (SYNC §7): this user's full snapshot + high-water ``server_seq`` (A3)."""
    return await bootstrap_snapshot(session, user_id=current_user.id)
