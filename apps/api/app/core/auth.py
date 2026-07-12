"""Auth primitives — V2_ADDENDUM A2 (Google ID-token exchange + our JWT).

Deliberately dependency-free (no FastAPI, no SQLAlchemy) so ``core/deps.py``
can import these helpers into the ``get_current_user`` dependency without an
import cycle. The one external boundary is :func:`verify_google_id_token`,
which the test suite patches so it never reaches out to Google.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

#: HS256 is the agreed algorithm for our own tokens (A2). Google ID tokens are
#: RS256 and verified separately by ``google-auth`` against Google's JWKS.
JWT_ALGORITHM = "HS256"


class AuthError(Exception):
    """Raised when a token is missing, malformed, expired, or unverifiable.

    The FastAPI layer maps this to ``401 Unauthorized``; keeping it a plain
    exception keeps this module free of any web-framework dependency.
    """


def verify_google_id_token(id_token: str, client_id: str) -> dict[str, Any]:
    """Verify a Google Identity Services ID token → its claims (A2).

    This is the *only* network boundary in the auth path and the single seam
    the tests monkeypatch (they never call Google). ``client_id`` is the
    expected audience (``FE_GOOGLE_CLIENT_ID``). Any verification failure —
    bad signature, wrong audience, expiry — surfaces as :class:`AuthError`.
    Returns the decoded claims (``sub``, ``email``, ``name``, ``picture``).
    """
    try:
        claims: dict[str, Any] = google_id_token.verify_oauth2_token(
            id_token, google_requests.Request(), client_id
        )
    except Exception as exc:  # google-auth raises ValueError/GoogleAuthError subclasses
        raise AuthError(f"invalid Google ID token: {exc}") from exc
    if not claims.get("sub"):
        raise AuthError("Google ID token missing subject")
    return claims


def create_access_token(user_id: str, secret: str, *, expiry_days: int = 30) -> str:
    """Mint our HS256 JWT with ``sub`` = ``user_id`` and a 30-day expiry (A2)."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=expiry_days)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str, secret: str) -> str:
    """Decode/verify our JWT and return the ``sub`` (user id) (A2).

    Raises :class:`AuthError` on any invalid or expired token — expiry is
    enforced by ``pyjwt`` (``ExpiredSignatureError`` → ``InvalidTokenError``).
    """
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise AuthError(f"invalid access token: {exc}") from exc
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise AuthError("access token missing subject")
    return sub
