"""Google sign-in exchange — V2_ADDENDUM A2.

``POST /auth/google`` is the one route (besides ``/health``) that does *not*
require a bearer token: it takes a Google ID token, verifies it, upserts the
user by ``google_sub``, and returns our own 30-day HS256 JWT plus the account.
"""

from __future__ import annotations

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthError, create_access_token, verify_google_id_token
from app.core.deps import get_app_state, get_db
from app.models.user import User
from app.schemas.user import AuthResponse, GoogleAuthRequest, UserPublic

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.post("/google", response_model=AuthResponse)
async def google_auth(payload: GoogleAuthRequest, request: Request, session: DbSession) -> AuthResponse:
    """Verify a Google ID token, upsert the user, and mint our JWT (A2)."""
    settings = get_app_state(request).settings
    if not settings.google_client_id:
        # Auth is unconfigured (no client id pasted yet) — the client runs in
        # local-only mode; fail loudly rather than accept an unverifiable token.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured",
        )
    try:
        claims = verify_google_id_token(payload.id_token, settings.google_client_id)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    google_sub = claims["sub"]
    user = await session.scalar(select(User).where(User.google_sub == google_sub))
    if user is None:
        user = User(
            id=str(uuid4()),
            google_sub=google_sub,
            email=claims.get("email", ""),
            name=claims.get("name", "") or "",
            picture=claims.get("picture"),
            settings={},
        )
        session.add(user)
    else:
        # Refresh mutable profile fields on every sign-in (name/photo can change).
        user.email = claims.get("email", user.email)
        user.name = claims.get("name", user.name) or user.name
        user.picture = claims.get("picture", user.picture)
    await session.commit()
    await session.refresh(user)

    token = create_access_token(user.id, settings.jwt_secret, expiry_days=settings.jwt_expiry_days)
    return AuthResponse(token=token, user=UserPublic.model_validate(user))
