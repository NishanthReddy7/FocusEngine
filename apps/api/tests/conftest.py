"""Shared pytest fixtures for the FocusEngine API test suite.

Splits into two groups:

* **Unit fixtures** (``device_id``/``fixed_now``/``audit_fields``) used by the
  pure schema/recurrence tests — unchanged from v1.
* **Auth + HTTP fixtures** (V2_ADDENDUM A2/A3) — an isolated file DB seeded with
  two users (A and B), a test JWT secret, and ``TestClient``s authenticated as
  each. The Google verification boundary is never called here; ``test_auth.py``
  patches it directly. Every route (except ``/health`` and ``/auth/google``)
  now requires a bearer token, so ``client`` is authenticated as user A by
  default and the whole existing suite runs against it unchanged.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from app.core.auth import create_access_token
from app.core.config import Settings
from app.core.deps import PerUserFocusManager, get_focus_registry
from app.db.engine import create_all, create_engine, create_session_factory
from app.domain.focus.timer import ManualTimerFactory
from app.main import create_app
from app.models.user import User

# --------------------------------------------------------------------------
# Unit-test fixtures (schemas / recurrence) — carried over from v1 verbatim.
# --------------------------------------------------------------------------


@pytest.fixture
def device_id() -> str:
    """A stable, valid device uuid string used across sync/HLC tests."""
    return "9f3a1c2b-0000-4000-8000-000000000000"


@pytest.fixture
def fixed_now() -> datetime:
    """A fixed, tz-aware UTC instant for deterministic time-based assertions."""
    return datetime(2026, 7, 12, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def audit_fields() -> Callable[..., dict[str, Any]]:
    """Factory for the audit/sync block (ARCHITECTURE §4.3) shared by every entity."""

    def _make(**overrides: Any) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        base = {
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
            "updated_hlc": "1783958400123-0000-9f3a1c2b",
            "device_id": str(uuid4()),
        }
        base.update(overrides)
        return base

    return _make


# --------------------------------------------------------------------------
# Auth + HTTP fixtures (V2_ADDENDUM A2/A3).
# --------------------------------------------------------------------------

#: Test-only secrets. The JWT secret signs the tokens the fixtures mint; the
#: client id is what ``POST /auth/google`` expects as the audience (tests mock
#: the verify boundary so it is never sent to Google).
# >=32 bytes so pyjwt raises no InsecureKeyLengthWarning (RFC 7518 §3.2).
TEST_JWT_SECRET = "test-jwt-secret-v2b-0123456789-abcdefghijklmnop"
TEST_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com"


class FakeClock:
    """Deterministic ``Clock`` double (monotonic + wall advance together).

    Shared by the focus-lifecycle and multi-user tests so no real timers or
    sleeps are ever needed (the whole suite stays sub-second).
    """

    def __init__(self) -> None:
        self._mono = 1000.0
        self._now = datetime(2026, 7, 12, 12, 0, 0, tzinfo=timezone.utc)

    def monotonic(self) -> float:
        return self._mono

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._mono += seconds
        self._now = self._now + timedelta(seconds=seconds)


@pytest.fixture
def db_url(tmp_path: Any) -> str:
    """An isolated temp-file SQLite URL, shared by the seed step and the app."""
    return f"sqlite+aiosqlite:///{tmp_path / 'focusengine_test.db'}"


@pytest.fixture
def settings(db_url: str) -> Settings:
    """Test settings: isolated DB, deterministic JWT secret + Google audience."""
    return Settings(
        database_url=db_url,
        cors_origins=["http://localhost:3000"],
        jwt_secret=TEST_JWT_SECRET,
        google_client_id=TEST_GOOGLE_CLIENT_ID,
    )


@pytest.fixture
def users(db_url: str) -> SimpleNamespace:
    """Seed users A and B into the file DB *before* the app starts, with tokens.

    Seeding runs its own short-lived engine (the app's lifespan later runs an
    idempotent ``create_all`` over the same file), so both accounts exist the
    moment the first authenticated request arrives.
    """
    record_a = {"id": str(uuid4()), "google_sub": "google-sub-A", "email": "ana@example.com", "name": "Ana"}
    record_b = {"id": str(uuid4()), "google_sub": "google-sub-B", "email": "ben@example.com", "name": "Ben"}

    async def _seed() -> None:
        engine = create_engine(db_url)
        await create_all(engine)
        factory = create_session_factory(engine)
        async with factory() as session:
            session.add(User(settings={}, **record_a))
            session.add(User(settings={}, **record_b))
            await session.commit()
        await engine.dispose()

    asyncio.run(_seed())

    return SimpleNamespace(
        a=SimpleNamespace(**record_a, token=create_access_token(record_a["id"], TEST_JWT_SECRET)),
        b=SimpleNamespace(**record_b, token=create_access_token(record_b["id"], TEST_JWT_SECRET)),
    )


@pytest.fixture
def app(settings: Settings, users: SimpleNamespace) -> FastAPI:
    """A fresh app per test, pointed at the seeded isolated DB.

    Depends on ``users`` so the two accounts are seeded before the app boots.
    """
    return create_app(settings=settings)


@pytest.fixture
def auth_a(users: SimpleNamespace) -> dict[str, str]:
    """Bearer header for user A."""
    return {"Authorization": f"Bearer {users.a.token}"}


@pytest.fixture
def auth_b(users: SimpleNamespace) -> dict[str, str]:
    """Bearer header for user B."""
    return {"Authorization": f"Bearer {users.b.token}"}


@pytest.fixture
def client(app: FastAPI, auth_a: dict[str, str]) -> Iterator[TestClient]:
    """``TestClient`` (lifespan run), authenticated as user A by default.

    The existing v1 suite uses this and passes unchanged — every request now
    simply carries A's token. Per-request headers (e.g. ``headers=auth_b``)
    still override the default when a test needs to act as B.
    """
    with TestClient(app) as test_client:
        test_client.headers.update(auth_a)
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def client_unauth(app: FastAPI) -> Iterator[TestClient]:
    """``TestClient`` with no default auth header (for 401 probes / auth exchange)."""
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def focus_clock(app: FastAPI, client: TestClient) -> FakeClock:
    """Override the per-user focus registry with a FakeClock + ManualTimerFactory.

    Depends on ``client`` so the app lifespan is already running (``app.state.fe``
    exists). Returns the shared clock the test advances; the override makes
    every per-user ``FocusSessionManager`` deterministic (no real timers).
    """
    state = app.state.fe
    clock = FakeClock()
    registry = PerUserFocusManager(
        session_factory=state.session_factory,
        hlc=state.hlc,
        notifier=state.notifier,
        clock=clock,
        timer_factory=ManualTimerFactory(),
    )
    app.dependency_overrides[get_focus_registry] = lambda: registry
    return clock
