"""Auth exchange + route-guard tests — V2_ADDENDUM A2.

The Google verification boundary (``app.routers.auth.verify_google_id_token``)
is monkeypatched in every exchange test — Google is never contacted. JWTs are
minted with the test secret via ``create_access_token``. Covers: the happy-path
exchange, upsert idempotency, a rejected Google token, an expired JWT, an
unknown-user token, and a 401 sweep across a sample of every guarded router.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from starlette.testclient import TestClient

from app.core.auth import create_access_token
from tests.conftest import TEST_JWT_SECRET


def _fake_claims(**overrides: Any) -> dict[str, Any]:
    """Canned Google ID-token claims (what a real verify would return)."""
    claims = {
        "sub": "google-sub-new-user",
        "email": "casey@example.com",
        "name": "Casey",
        "picture": "https://example.com/casey.png",
    }
    claims.update(overrides)
    return claims


# --------------------------------------------------------------------------
# Open routes: /health and /auth/google require no bearer token (A2).
# --------------------------------------------------------------------------


def test_health_is_open(client_unauth: TestClient) -> None:
    resp = client_unauth.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# --------------------------------------------------------------------------
# POST /auth/google: happy path (mocked verify) → {token, user}; token works.
# --------------------------------------------------------------------------


def test_google_exchange_happy_path(client_unauth: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routers.auth.verify_google_id_token", lambda token, client_id: _fake_claims())

    resp = client_unauth.post("/auth/google", json={"id_token": "any-opaque-google-token"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["user"]["email"] == "casey@example.com"
    assert body["user"]["name"] == "Casey"
    assert "google_sub" not in body["user"]  # internal identity key never crosses the wire
    token = body["token"]
    assert token

    # The minted token authenticates the whole app: GET /me returns this user.
    me_resp = client_unauth.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert me_resp.status_code == 200
    assert me_resp.json()["id"] == body["user"]["id"]
    assert me_resp.json()["email"] == "casey@example.com"


def test_google_exchange_upsert_is_idempotent(
    client_unauth: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same ``google_sub`` twice → the same account, not a duplicate (A2)."""
    monkeypatch.setattr("app.routers.auth.verify_google_id_token", lambda token, client_id: _fake_claims())

    first = client_unauth.post("/auth/google", json={"id_token": "t1"}).json()
    second = client_unauth.post("/auth/google", json={"id_token": "t2"}).json()
    assert first["user"]["id"] == second["user"]["id"]


def test_google_exchange_refreshes_profile_fields(
    client_unauth: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A later sign-in updates mutable profile fields (name/picture) (A2)."""
    monkeypatch.setattr(
        "app.routers.auth.verify_google_id_token", lambda token, client_id: _fake_claims(name="Casey Sr.")
    )
    updated = client_unauth.post("/auth/google", json={"id_token": "t3"}).json()
    assert updated["user"]["name"] == "Casey Sr."


# --------------------------------------------------------------------------
# Rejected Google token → 401 (verify boundary raises AuthError).
# --------------------------------------------------------------------------


def test_google_exchange_bad_token_401(client_unauth: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.auth import AuthError

    def _reject(token: str, client_id: str) -> dict[str, Any]:
        raise AuthError("invalid Google ID token: audience mismatch")

    monkeypatch.setattr("app.routers.auth.verify_google_id_token", _reject)
    resp = client_unauth.post("/auth/google", json={"id_token": "forged"})
    assert resp.status_code == 401


# --------------------------------------------------------------------------
# JWT guard: expired / unknown-user / malformed → 401 on a protected route.
# --------------------------------------------------------------------------


def test_expired_jwt_is_rejected(client_unauth: TestClient, users: Any) -> None:
    expired = create_access_token(users.a.id, TEST_JWT_SECRET, expiry_days=-1)
    resp = client_unauth.get("/me", headers={"Authorization": f"Bearer {expired}"})
    assert resp.status_code == 401


def test_token_for_unknown_user_is_rejected(client_unauth: TestClient) -> None:
    ghost = create_access_token(str(uuid4()), TEST_JWT_SECRET)
    resp = client_unauth.get("/me", headers={"Authorization": f"Bearer {ghost}"})
    assert resp.status_code == 401


def test_token_signed_with_wrong_secret_is_rejected(client_unauth: TestClient, users: Any) -> None:
    forged = create_access_token(users.a.id, "not-the-server-secret-not-the-server-secret")
    resp = client_unauth.get("/me", headers={"Authorization": f"Bearer {forged}"})
    assert resp.status_code == 401


def test_malformed_authorization_header_is_rejected(client_unauth: TestClient, users: Any) -> None:
    # Missing scheme, wrong scheme, and empty token all fail closed.
    assert client_unauth.get("/me").status_code == 401
    assert client_unauth.get("/me", headers={"Authorization": users.a.token}).status_code == 401
    assert client_unauth.get("/me", headers={"Authorization": "Basic abc"}).status_code == 401
    assert client_unauth.get("/me", headers={"Authorization": "Bearer "}).status_code == 401


# --------------------------------------------------------------------------
# Unauthenticated 401 sweep — a sample route on every guarded router (A2).
# --------------------------------------------------------------------------


def test_every_router_rejects_unauthenticated_requests(client_unauth: TestClient) -> None:
    probes = [
        ("get", "/me", None),
        ("get", "/tasks", None),
        ("post", "/tasks", {"title": "no auth"}),
        ("get", "/focus/sessions/active", None),
        ("get", "/sync/bootstrap", None),
        ("get", "/sync/pull?device_id=d", None),
        # Valid body so the only possible failure is the auth guard, not 422.
        ("post", "/insights/daily-review", {"date": "2026-07-12", "energy_level": 3}),
    ]
    for method, path, json_body in probes:
        resp = getattr(client_unauth, method)(path, json=json_body) if json_body else getattr(client_unauth, method)(path)
        assert resp.status_code == 401, f"{method.upper()} {path} should be 401, got {resp.status_code}"
