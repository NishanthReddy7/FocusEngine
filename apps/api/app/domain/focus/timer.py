"""Clock and timer abstractions for the focus domain (ARCHITECTURE §5.2).

Durations are measured with ``Clock.monotonic()`` (immune to wall-clock jumps);
display timestamps use ``Clock.now()`` (tz-aware UTC). Timers are created via a
``TimerFactory`` so production drives real asyncio timers while tests use
``ManualTimerFactory`` — capturing ``(delay, callback)`` pairs and firing them
explicitly, so the suite runs with zero real sleeps.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Protocol


class Clock(Protocol):
    """A source of monotonic durations and tz-aware UTC wall-clock time."""

    def monotonic(self) -> float:
        """Monotonic seconds; only *differences* are meaningful."""
        ...

    def now(self) -> datetime:
        """The current instant as a tz-aware UTC ``datetime``."""
        ...


class SystemClock:
    """Production :class:`Clock` backed by ``time.monotonic``/UTC ``datetime``."""

    def monotonic(self) -> float:
        return time.monotonic()

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class TimerHandle(Protocol):
    """Handle to a scheduled timer that can be cancelled."""

    def cancel(self) -> None:
        """Cancel the timer; safe to call more than once."""
        ...


class TimerFactory(Protocol):
    """Schedules an async callback to run once, after a delay."""

    def schedule(
        self, delay_seconds: float, callback: Callable[[], Awaitable[None]]
    ) -> TimerHandle:
        """Arrange for ``callback`` to be awaited ``delay_seconds`` from now."""
        ...


class _AsyncioTimerHandle:
    """A :class:`TimerHandle` wrapping a ``call_later`` handle and its task."""

    def __init__(self) -> None:
        self._handle: asyncio.TimerHandle | None = None
        self._task: asyncio.Task[None] | None = None

    def cancel(self) -> None:
        if self._handle is not None:
            self._handle.cancel()
        if self._task is not None and not self._task.done():
            self._task.cancel()


class AsyncioTimerFactory:
    """Production :class:`TimerFactory`: ``call_later`` → ``create_task``."""

    def schedule(
        self, delay_seconds: float, callback: Callable[[], Awaitable[None]]
    ) -> TimerHandle:
        loop = asyncio.get_running_loop()
        handle = _AsyncioTimerHandle()

        def _fire() -> None:
            handle._task = loop.create_task(callback())

        # Negative delays (e.g. an over-run resume) fire on the next tick.
        handle._handle = loop.call_later(max(0.0, delay_seconds), _fire)
        return handle


class ManualTimer:
    """A captured ``(delay, callback)`` pair fired explicitly by tests.

    Satisfies the :class:`TimerHandle` protocol structurally via ``cancel``.
    """

    def __init__(self, delay: float, callback: Callable[[], Awaitable[None]]) -> None:
        self.delay = delay
        self.callback = callback
        self.cancelled = False
        self.fired = False

    def cancel(self) -> None:
        self.cancelled = True


class ManualTimerFactory:
    """Test :class:`TimerFactory`: records timers; ``fire_next`` fires the armed one."""

    def __init__(self) -> None:
        self.timers: list[ManualTimer] = []

    def schedule(
        self, delay_seconds: float, callback: Callable[[], Awaitable[None]]
    ) -> TimerHandle:
        timer = ManualTimer(delay_seconds, callback)
        self.timers.append(timer)
        return timer

    @property
    def armed(self) -> ManualTimer | None:
        """The currently-armed timer: last scheduled, not cancelled, not fired.

        At most one timer is ever armed because the controller cancels the
        previous one before scheduling the next (ARCHITECTURE §5.3.4).
        """
        for timer in reversed(self.timers):
            if not timer.cancelled and not timer.fired:
                return timer
        return None

    async def fire_next(self) -> None:
        """Fire the currently-armed timer's callback (raises if none is armed)."""
        timer = self.armed
        if timer is None:
            raise RuntimeError("no armed timer to fire")
        timer.fired = True
        await timer.callback()
