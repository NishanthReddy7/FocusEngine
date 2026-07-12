"""FastAPI application factory — ARCHITECTURE.md §2, §6; V2_ADDENDUM A2-A5.

``create_app`` is invoked by uvicorn's factory loader
(``uvicorn app.main:create_app --factory``). The lifespan builds every
singleton once (:func:`app.core.deps.build_app_state`) and disposes the
database engine on shutdown. Auth (A2) guards every route except ``/health``
and ``/auth/google``; the WebSockets authenticate via ``?token=`` (A5).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.auth import AuthError
from app.core.config import Settings, get_settings
from app.core.deps import AppState, build_app_state, resolve_user
from app.domain.focus.errors import InvalidTransition, NoActiveSession, SessionAlreadyActive
from app.domain.focus.events import FocusEvent
from app.models.user import User
from app.routers import auth, focus, insights, me, sync, tasks


def _focus_event_to_wire(event: FocusEvent) -> dict[str, Any]:
    """``FocusEvent`` dataclass -> JSON-safe dict for the WS wire (ARCHITECTURE §6)."""
    return {
        "type": event.type,
        "session_id": str(event.session_id),
        "task_id": str(event.task_id),
        "state": event.state.value,
        "at": event.at.isoformat(),
        "data": event.data,
    }


async def _authenticate_ws(state: AppState, token: str) -> User | None:
    """Resolve the account behind a WebSocket ``?token=`` (A2/A5), or ``None``.

    Opens a throwaway session (WS handlers own no request-scoped session) to
    load the user; any missing/invalid/expired token yields ``None`` so the
    caller can reject the handshake.
    """
    if not token:
        return None
    async with state.session_factory() as session:
        try:
            return await resolve_user(session, token, state.settings)
        except AuthError:
            return None


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FocusEngine FastAPI application."""
    resolved_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.fe = await build_app_state(resolved_settings)
        try:
            yield
        finally:
            await app.state.fe.engine.dispose()

    app = FastAPI(title="FocusEngine API", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # /auth/google and /health are the only unauthenticated routes (A2); every
    # other router carries its own router-level get_current_user dependency.
    app.include_router(auth.router)
    app.include_router(me.router)
    app.include_router(tasks.router)
    app.include_router(focus.router)
    app.include_router(sync.router)
    app.include_router(insights.router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # ---- domain-error -> HTTP mapping (ARCHITECTURE §5.1 note; §6 error table) ----

    @app.exception_handler(InvalidTransition)
    async def _invalid_transition_handler(_request: Request, exc: InvalidTransition) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(SessionAlreadyActive)
    async def _session_already_active_handler(_request: Request, exc: SessionAlreadyActive) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(NoActiveSession)
    async def _no_active_session_handler(_request: Request, exc: NoActiveSession) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    # ---- realtime sync WS (V2_ADDENDUM A5) ----

    @app.websocket("/ws/sync")
    async def sync_ws(websocket: WebSocket) -> None:
        """Push ``{"server_seq": N}`` to this user's sockets after any oplog append.

        Auth via ``?token=`` (A5). The client, on a message where ``N`` exceeds
        its local cursor, runs an immediate ``syncOnce()``. A different account's
        writes never reach these sockets (per-user :class:`SyncNotifier` fan-out).
        """
        state: AppState = websocket.app.state.fe
        user = await _authenticate_ws(state, websocket.query_params.get("token", ""))
        if user is None:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        await websocket.accept()
        queue = state.notifier.subscribe(user.id)
        try:
            while True:
                server_seq = await queue.get()
                await websocket.send_json({"server_seq": server_seq})
        except WebSocketDisconnect:
            pass
        finally:
            state.notifier.unsubscribe(user.id, queue)

    # ---- focus-events WS fan-out (ARCHITECTURE §6; per-user per A3) ----

    @app.websocket("/ws/focus/events")
    async def focus_events_ws(websocket: WebSocket) -> None:
        """Subscribe to *this user's* focus :class:`EventBus` and forward events."""
        state = websocket.app.state.fe
        user = await _authenticate_ws(state, websocket.query_params.get("token", ""))
        if user is None:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        await websocket.accept()
        bus = state.focus_registry.bus_for(user.id)
        queue = bus.subscribe()
        try:
            while True:
                event = await queue.get()
                await websocket.send_json(_focus_event_to_wire(event))
        except WebSocketDisconnect:
            pass
        finally:
            bus.unsubscribe(queue)

    return app
