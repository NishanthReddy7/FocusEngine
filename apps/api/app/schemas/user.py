"""User & auth wire schemas — V2_ADDENDUM A2.

These sit outside the synced-entity contract (no HLC/oplog block): a user is
identity, not a replicated row. ``UserPublic`` is what ``POST /auth/google``
and ``GET /me`` return; ``google_sub`` is deliberately withheld from the wire
(it is an internal identity key, never needed by the client).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.schemas.base import FEBase


class UserPublic(FEBase):
    """The account view the client caches in ``_meta.auth.user``."""

    id: str
    email: str
    name: str = ""
    picture: str | None = None
    settings: dict[str, Any] = {}
    created_at: datetime


class GoogleAuthRequest(FEBase):
    """Body of ``POST /auth/google`` — a Google Identity Services ID token."""

    id_token: str


class AuthResponse(FEBase):
    """Response of ``POST /auth/google`` — our HS256 JWT plus the user."""

    token: str
    user: UserPublic


class SettingsUpdate(FEBase):
    """Body of ``PATCH /me/settings`` — a partial settings blob to merge."""

    settings: dict[str, Any]
