"""Account profile & settings — V2_ADDENDUM A2.

``GET /me`` returns the authenticated user (with settings); ``PATCH
/me/settings`` shallow-merges a partial settings blob and returns the updated
account (the client mirrors it into Dexie ``_meta.settings``).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db
from app.schemas.user import SettingsUpdate, UserPublic

# Router-level dependency: every /me route requires a valid bearer token (A2).
router = APIRouter(prefix="/me", tags=["me"], dependencies=[Depends(get_current_user)])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.get("", response_model=UserPublic)
async def get_me(current_user: CurrentUser) -> UserPublic:
    """``GET /me``: the authenticated account plus its settings (A2)."""
    return UserPublic.model_validate(current_user)


@router.patch("/settings", response_model=UserPublic)
async def patch_settings(
    payload: SettingsUpdate, current_user: CurrentUser, session: DbSession
) -> UserPublic:
    """``PATCH /me/settings``: shallow-merge the settings blob (A2).

    ``settings`` is a JSON column, so the merged result is assigned as a fresh
    dict (never mutated in place) for SQLite/aiosqlite change tracking.
    """
    merged = {**(current_user.settings or {}), **payload.settings}
    current_user.settings = merged
    await session.commit()
    await session.refresh(current_user)
    return UserPublic.model_validate(current_user)
