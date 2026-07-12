"""FocusSessionManager — single-active-session registry (ARCHITECTURE §5.2).

MVP owns at most one live :class:`FocusController`. It is the object the router
layer (T4) holds as a lifespan singleton; it hands out the active controller and
clears its slot automatically when a session finalizes (via the controller's
``on_finalized`` callback).
"""

from __future__ import annotations

import asyncio
from uuid import UUID

from app.domain.focus.controller import FocusController
from app.domain.focus.errors import NoActiveSession, SessionAlreadyActive
from app.domain.focus.events import EventBus
from app.domain.focus.ports import SessionStore, TaskTimeSink
from app.domain.focus.timer import Clock, TimerFactory
from app.schemas.enums import FocusPreset, SessionState
from app.schemas.focus import FocusSession


class FocusSessionManager:
    """Owns at most one live focus session and routes actions to its controller."""

    def __init__(
        self,
        *,
        bus: EventBus,
        time_sink: TaskTimeSink,
        store: SessionStore,
        clock: Clock | None = None,
        timer_factory: TimerFactory | None = None,
    ) -> None:
        self._bus = bus
        self._time_sink = time_sink
        self._store = store
        # None → each controller builds its own SystemClock/AsyncioTimerFactory;
        # tests inject a FakeClock + ManualTimerFactory here.
        self._clock = clock
        self._timer_factory = timer_factory
        self._active: FocusController | None = None
        self._lock = asyncio.Lock()  # guards the check-and-set in start_session

    async def start_session(
        self,
        task_id: UUID,
        preset: FocusPreset,
        planned_cycles: int | None = None,
    ) -> FocusSession:
        """Create and start a session. Raises SessionAlreadyActive if one runs."""
        async with self._lock:
            if self.get_active() is not None:
                raise SessionAlreadyActive("a focus session is already active")
            controller = FocusController(
                task_id=task_id,
                preset=preset,
                planned_cycles=planned_cycles,
                bus=self._bus,
                time_sink=self._time_sink,
                store=self._store,
                clock=self._clock,
                timer_factory=self._timer_factory,
                on_finalized=self._clear_active,
            )
            self._active = controller
            await controller.start()
            return controller.session

    def get_active(self) -> FocusController | None:
        """The live controller, or None. A finalized controller counts as gone."""
        controller = self._active
        if controller is not None and controller.state is SessionState.COMPLETED:
            return None
        return controller

    def _clear_active(self, controller: FocusController) -> None:
        # on_finalized callback: release the slot iff it still points at this one
        # (guards against a stale finalization clearing a newer session).
        if self._active is controller:
            self._active = None

    async def pause(self) -> FocusSession:
        """Pause the active session (raises NoActiveSession if none)."""
        return await self._act("pause")

    async def resume(self) -> FocusSession:
        """Resume the active session (raises NoActiveSession if none)."""
        return await self._act("resume")

    async def skip_break(self) -> FocusSession:
        """Skip the active session's break (raises NoActiveSession if none)."""
        return await self._act("skip_break")

    async def complete(self) -> FocusSession:
        """Complete the active session (raises NoActiveSession if none)."""
        return await self._act("complete")

    async def abandon(self) -> FocusSession:
        """Abandon the active session (raises NoActiveSession if none)."""
        return await self._act("abandon")

    async def _act(self, action: str) -> FocusSession:
        controller = self.get_active()
        if controller is None:
            raise NoActiveSession("no active focus session")
        # complete/abandon trigger on_finalized during the await, clearing the
        # slot; the local reference stays valid for the returned snapshot.
        await getattr(controller, action)()
        return controller.session
