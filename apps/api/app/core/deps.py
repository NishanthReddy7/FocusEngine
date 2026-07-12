"""Dependency injection wiring — ARCHITECTURE.md §2, §5.4; V2_ADDENDUM A2-A5.

``build_app_state`` constructs every lifespan singleton exactly once (called
from ``app/main.py``'s lifespan context manager and stashed on
``app.state.fe``); the ``get_*`` functions below are the FastAPI ``Depends``
seams that route handlers use, and that tests override (e.g. swapping
``get_focus_registry`` for one built with a ``FakeClock``/``ManualTimerFactory``
pair) without touching route code.

Auth (A2): ``get_current_user`` guards every route except ``/health`` and
``/auth/google``. Multi-user (A3): the single ``FocusSessionManager`` becomes a
per-user registry so accounts can focus simultaneously. Realtime (A5): a
process-wide :class:`~app.services.sync.SyncNotifier` fans oplog advances out to
each user's ``/ws/sync`` sockets.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.auth import AuthError, decode_access_token
from app.core.config import Settings
from app.db.engine import create_all, create_engine, create_session_factory
from app.domain.focus import EventBus, FocusSessionManager
from app.domain.focus.timer import Clock, TimerFactory
from app.models.user import User
from app.schemas.hlc import HybridLogicalClock
from app.services.sync import SERVER_DEVICE_ID, SyncNotifier
from app.services.tasks import SqlSessionStore, SqlTaskTimeSink


class PerUserFocusManager:
    """Per-user registry of single-active-session managers (V2_ADDENDUM A3).

    The MVP's one global :class:`FocusSessionManager` becomes one manager *per
    account*, each still enforcing a single active session — so users A and B
    can run focus sessions at the same time. Every user also gets a private
    :class:`EventBus` (focus events never cross accounts) plus SQL adapters
    (:class:`SqlTaskTimeSink`/:class:`SqlSessionStore`) bound to their id, so
    every credit/persist/oplog append lands under the right owner. Managers,
    buses, and adapters are created lazily and cached. The domain ``focus``
    package itself is untouched — this registry only composes it.
    """

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        hlc: HybridLogicalClock,
        notifier: SyncNotifier | None = None,
        clock: Clock | None = None,
        timer_factory: TimerFactory | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._hlc = hlc
        self._notifier = notifier
        # None → each controller builds its own SystemClock/AsyncioTimerFactory;
        # tests inject a FakeClock + ManualTimerFactory here.
        self._clock = clock
        self._timer_factory = timer_factory
        self._managers: dict[str, FocusSessionManager] = {}
        self._buses: dict[str, EventBus] = {}

    def bus_for(self, user_id: str) -> EventBus:
        """The account's private focus :class:`EventBus` (the focus WS fans it out)."""
        bus = self._buses.get(user_id)
        if bus is None:
            bus = EventBus()
            self._buses[user_id] = bus
        return bus

    def for_user(self, user_id: str) -> FocusSessionManager:
        """The account's single-active-session :class:`FocusSessionManager`."""
        manager = self._managers.get(user_id)
        if manager is None:
            manager = FocusSessionManager(
                bus=self.bus_for(user_id),
                time_sink=SqlTaskTimeSink(
                    self._session_factory, self._hlc, user_id=user_id, notifier=self._notifier
                ),
                store=SqlSessionStore(
                    self._session_factory, self._hlc, user_id=user_id, notifier=self._notifier
                ),
                clock=self._clock,
                timer_factory=self._timer_factory,
            )
            self._managers[user_id] = manager
        return manager


@dataclass
class AppState:
    """Every singleton the lifespan builds once, shared by all requests."""

    settings: Settings
    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]
    hlc: HybridLogicalClock
    notifier: SyncNotifier
    focus_registry: PerUserFocusManager


async def build_app_state(settings: Settings) -> AppState:
    """Construct every lifespan singleton (ARCHITECTURE §5.4; V2_ADDENDUM A3-A5).

    Called once from ``main.py``'s lifespan. ``create_all`` runs here (MVP
    migration strategy, ARCHITECTURE §2 / V2_ADDENDUM A4) so the schema is
    ready before the first request, on SQLite or Postgres alike.
    """
    engine = create_engine(settings.database_url)
    await create_all(engine)
    session_factory = create_session_factory(engine)
    hlc = HybridLogicalClock(SERVER_DEVICE_ID)
    notifier = SyncNotifier()
    focus_registry = PerUserFocusManager(session_factory=session_factory, hlc=hlc, notifier=notifier)
    return AppState(
        settings=settings,
        engine=engine,
        session_factory=session_factory,
        hlc=hlc,
        notifier=notifier,
        focus_registry=focus_registry,
    )


def get_app_state(request: Request) -> AppState:
    """Fetch the lifespan-built :class:`AppState` off ``app.state``."""
    return request.app.state.fe


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """Per-request database session; route/service code controls the commit."""
    state = get_app_state(request)
    async with state.session_factory() as session:
        yield session


def get_notifier(request: Request) -> SyncNotifier:
    """The process-wide :class:`SyncNotifier` (``/ws/sync`` fan-out — A5)."""
    return get_app_state(request).notifier


def get_focus_registry(request: Request) -> PerUserFocusManager:
    """The per-user focus registry (overridden in tests with fake clock/timer)."""
    return get_app_state(request).focus_registry


def get_hlc_clock(request: Request) -> HybridLogicalClock:
    """The server's in-process HLC (SYNC_STRATEGY §2 — device id ``"server"``)."""
    return get_app_state(request).hlc


async def resolve_user(session: AsyncSession, token: str, settings: Settings) -> User:
    """Decode a JWT and load its :class:`User`, or raise :class:`AuthError`.

    Shared by the HTTP dependency and the WebSocket ``?token=`` path so both
    accept exactly the same tokens.
    """
    user_id = decode_access_token(token, settings.jwt_secret)
    user = await session.get(User, user_id)
    if user is None:
        raise AuthError("user not found")
    return user


async def get_current_user(
    request: Request, session: Annotated[AsyncSession, Depends(get_db)]
) -> User:
    """Authenticate the caller from ``Authorization: Bearer <jwt>`` (A2).

    401 on a missing/malformed header, an invalid/expired token, or an unknown
    user. Applied as a router-level dependency to every route except
    ``/health`` and ``/auth/google``.
    """
    settings = get_app_state(request).settings
    header = request.headers.get("Authorization", "")
    scheme, _, raw_token = header.partition(" ")
    token = raw_token.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return await resolve_user(session, token, settings)
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


#: FastAPI-friendly alias for handlers that need the authenticated account.
CurrentUser = Annotated[User, Depends(get_current_user)]


def get_manager(
    current_user: CurrentUser,
    registry: Annotated[PerUserFocusManager, Depends(get_focus_registry)],
) -> FocusSessionManager:
    """The authenticated user's single-active-session manager (A3)."""
    return registry.for_user(current_user.id)
