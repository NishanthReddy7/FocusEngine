"""FocusController — the asynchronous focus-timer state machine (ARCHITECTURE §5).

Pure domain logic: no FastAPI, no SQLAlchemy. Persistence and task-time
crediting go only through the injected ports (``SessionStore`` /
``TaskTimeSink``); all duration/wall-clock math goes through the injected
``Clock``; timers come from the injected ``TimerFactory``. That makes the
machine fully deterministic and unit-testable without real time.

The class enforces invariants ARCHITECTURE §5.3.1–§5.3.7; each is cited in the
method that upholds it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

from app.domain.focus.errors import InvalidTransition
from app.domain.focus.events import (
    EVENT_BREAK_STARTED,
    EVENT_CYCLE_COMPLETED,
    EVENT_SESSION_COMPLETED,
    EVENT_SESSION_PAUSED,
    EVENT_SESSION_RESUMED,
    EVENT_SESSION_STARTED,
    EVENT_TIME_ADDED,
    EventBus,
    FocusEvent,
)
from app.domain.focus.ports import SessionStore, TaskTimeSink
from app.domain.focus.timer import (
    AsyncioTimerFactory,
    Clock,
    SystemClock,
    TimerFactory,
    TimerHandle,
)
from app.schemas.enums import AmbientTrack, FocusPreset, SessionOutcome, SessionState
from app.schemas.focus import FocusSession, SessionSegment

# ARCHITECTURE §5.1 — the transition table, reproduced verbatim and binding.
# Any (state, trigger) pair absent here raises InvalidTransition; COMPLETED is
# terminal (it is a target but never a source). Breaks are not pausable by
# design — use "skip_break".
TRANSITIONS: dict[tuple[SessionState, str], SessionState] = {
    (SessionState.IDLE, "start"): SessionState.ACTIVE_WORK,
    (SessionState.ACTIVE_WORK, "pause"): SessionState.PAUSED,
    (SessionState.PAUSED, "resume"): SessionState.ACTIVE_WORK,
    (SessionState.ACTIVE_WORK, "work_elapsed"): SessionState.BREAK,
    (SessionState.BREAK, "break_elapsed"): SessionState.ACTIVE_WORK,
    (SessionState.BREAK, "skip_break"): SessionState.ACTIVE_WORK,
    (SessionState.ACTIVE_WORK, "complete"): SessionState.COMPLETED,
    (SessionState.PAUSED, "complete"): SessionState.COMPLETED,
    (SessionState.BREAK, "complete"): SessionState.COMPLETED,
    (SessionState.ACTIVE_WORK, "abandon"): SessionState.COMPLETED,
    (SessionState.PAUSED, "abandon"): SessionState.COMPLETED,
    (SessionState.BREAK, "abandon"): SessionState.COMPLETED,
}


@dataclass
class _Effects:
    """Side effects gathered under the lock, executed after it is released.

    Invariant §5.3.1: events (and the sink/store awaits) are collected while
    holding the lock and dispatched only once it is released, so a subscriber
    reacting to an event can safely re-enter the controller.
    """

    events: list[FocusEvent] = field(default_factory=list)
    sink_seconds: list[int] = field(default_factory=list)
    save_snapshot: FocusSession | None = None
    finalized: bool = False


class FocusController:
    """State machine for one focus-timer run against a single task."""

    def __init__(
        self,
        *,
        task_id: UUID,
        preset: FocusPreset,
        planned_cycles: int | None = None,
        bus: EventBus,
        time_sink: TaskTimeSink,
        store: SessionStore,
        clock: Clock | None = None,
        timer_factory: TimerFactory | None = None,
        on_finalized: Callable[[FocusController], None] | None = None,
    ) -> None:
        self._task_id = task_id
        self._preset = preset
        self._planned_cycles = planned_cycles
        self._bus = bus
        self._time_sink = time_sink
        self._store = store
        self._clock: Clock = clock or SystemClock()
        self._timer_factory: TimerFactory = timer_factory or AsyncioTimerFactory()
        self._on_finalized = on_finalized

        # §5.3.1 — one lock guards every mutation (public methods + callbacks).
        self._lock = asyncio.Lock()
        # §5.3.4 — bumped on every state entry; late timer callbacks compare the
        # epoch they captured and no-op if it has moved on.
        self._epoch = 0
        # §5.3.3 — work seconds accrued in the current cycle; drives the
        # remaining-work countdown across pause/resume.
        self._cycle_work_accum = 0
        self._open_segment: SessionSegment | None = None
        self._segment_start_mono: float | None = None
        self._timer_handle: TimerHandle | None = None

        now = self._clock.now()
        # updated_hlc is stamped by the SessionStore on persist (§5.4); the
        # domain layer is HLC-agnostic, so it starts empty.
        self._session = FocusSession(
            id=uuid4(),
            task_id=task_id,
            preset=preset,
            planned_cycles=planned_cycles,
            state=SessionState.IDLE,
            outcome=None,
            started_at=None,
            ended_at=None,
            work_seconds=0,
            break_seconds=0,
            cycles_completed=0,
            segments=[],
            ambient_track=AmbientTrack.NONE,
            energy_after=None,
            created_at=now,
            updated_at=now,
            updated_hlc="",
            device_id=None,
        )

    # ---- read-only views (lock-free; a sync read never yields) -------------

    @property
    def state(self) -> SessionState:
        """Current state. Lock-free and safe to call from an event handler."""
        return self._session.state

    @property
    def session(self) -> FocusSession:
        """A deep copy of the live session snapshot (ARCHITECTURE §5.2)."""
        return self._session.model_copy(deep=True)

    @property
    def task_id(self) -> UUID:
        """The task this session credits its focus time to."""
        return self._task_id

    def remaining_seconds(self) -> int:
        """Seconds left on the current countdown — pure, no side effects (§5.3.7)."""
        state = self._session.state
        work_total = self._preset.work_minutes * 60
        if state is SessionState.ACTIVE_WORK:
            used = self._cycle_work_accum + self._open_segment_elapsed()
            return max(0, round(work_total - used))
        if state is SessionState.PAUSED:
            return max(0, round(work_total - self._cycle_work_accum))
        if state is SessionState.BREAK:
            break_total = self._preset.break_minutes * 60
            return max(0, round(break_total - self._open_segment_elapsed()))
        if state is SessionState.IDLE:
            return work_total
        return 0  # COMPLETED

    def _open_segment_elapsed(self) -> float:
        """Monotonic seconds since the open segment began (0.0 if none)."""
        if self._segment_start_mono is None:
            return 0.0
        return self._clock.monotonic() - self._segment_start_mono

    # ---- public transitions ------------------------------------------------

    async def start(self) -> None:
        """IDLE → ACTIVE_WORK; persist, open the first work segment, arm the timer."""
        await self._trigger("start")

    async def pause(self) -> None:
        """ACTIVE_WORK → PAUSED; credit the open work segment, stop the countdown."""
        await self._trigger("pause")

    async def resume(self) -> None:
        """PAUSED → ACTIVE_WORK; continue the same cycle's countdown (§5.3.3)."""
        await self._trigger("resume")

    async def skip_break(self) -> None:
        """BREAK → ACTIVE_WORK early; credit the partial break, start a new cycle."""
        await self._trigger("skip_break")

    async def complete(self) -> None:
        """Finalize as COMPLETED from any active state (§5.3.6)."""
        await self._trigger("complete")

    async def abandon(self) -> None:
        """Finalize as ABANDONED from any active state (§5.3.6)."""
        await self._trigger("abandon")

    # ---- trigger plumbing --------------------------------------------------

    async def _trigger(self, trigger: str) -> None:
        # §5.3.1 — mutate under the lock, dispatch effects after releasing it.
        async with self._lock:
            effects = self._apply(trigger)  # may raise InvalidTransition
        await self._dispatch(effects)

    async def _on_timer(self, epoch: int, trigger: str) -> None:
        # Timer callback: honour the epoch guard (§5.3.4) under the lock, then
        # dispatch outside it just like a public trigger.
        async with self._lock:
            if epoch != self._epoch:
                return  # stale timer — neutralised
            effects = self._apply(trigger)
        await self._dispatch(effects)

    def _apply(self, trigger: str) -> _Effects:
        """Validate against the table, run the handler, return collected effects.

        Runs entirely synchronously under the lock — no awaits — so it is
        atomic with respect to every other coroutine.
        """
        current = self._session.state
        if (current, trigger) not in TRANSITIONS:
            raise InvalidTransition(current, trigger)
        effects = _Effects()
        handler: Callable[[_Effects], None] = getattr(self, f"_on_{trigger}")
        handler(effects)
        return effects

    async def _dispatch(self, effects: _Effects) -> None:
        """Execute collected effects outside the lock (§5.3.1, ordering per §5.3.6).

        Order: credit the sink(s) → persist → publish events → notify manager.
        """
        for seconds in effects.sink_seconds:
            await self._time_sink.add_focus_seconds(self._task_id, seconds)
        if effects.save_snapshot is not None:
            await self._store.save(effects.save_snapshot)
        for event in effects.events:
            await self._bus.publish(event)
        if effects.finalized and self._on_finalized is not None:
            self._on_finalized(self)

    # ---- transition handlers (sync; run under the lock) --------------------

    def _on_start(self, effects: _Effects) -> None:
        self._session.started_at = self._clock.now()
        self._enter_active_work(new_cycle=True)
        effects.events.append(self._event(EVENT_SESSION_STARTED))
        effects.save_snapshot = self._save_snapshot()  # §5.3.6 — save at start()

    def _on_pause(self, effects: _Effects) -> None:
        self._close_segment(effects)  # §5.3.2 — credit the open work segment
        self._enter_state(SessionState.PAUSED)
        self._cancel_timer()  # §5.3.4 — entering PAUSED cancels the pending timer
        effects.events.append(self._event(EVENT_SESSION_PAUSED))

    def _on_resume(self, effects: _Effects) -> None:
        # §5.3.3 — continue the countdown; do NOT reset cycle_work_accum.
        self._enter_active_work(new_cycle=False)
        effects.events.append(
            self._event(EVENT_SESSION_RESUMED, {"cycle": self._current_cycle()})
        )

    def _on_work_elapsed(self, effects: _Effects) -> None:
        # §5.3.5 — a work block finished.
        self._close_segment(effects)
        self._session.cycles_completed += 1
        effects.events.append(self._event(EVENT_CYCLE_COMPLETED))
        if (
            self._planned_cycles is not None
            and self._session.cycles_completed >= self._planned_cycles
        ):
            self._finalize(effects, SessionOutcome.COMPLETED)
        else:
            self._enter_break()
            effects.events.append(self._event(EVENT_BREAK_STARTED))

    def _on_break_elapsed(self, effects: _Effects) -> None:
        self._resume_from_break(effects)

    def _on_skip_break(self, effects: _Effects) -> None:
        self._resume_from_break(effects)

    def _on_complete(self, effects: _Effects) -> None:
        self._finalize(effects, SessionOutcome.COMPLETED)

    def _on_abandon(self, effects: _Effects) -> None:
        self._finalize(effects, SessionOutcome.ABANDONED)

    # ---- shared machinery --------------------------------------------------

    def _resume_from_break(self, effects: _Effects) -> None:
        # break_elapsed / skip_break both close the break and open a new cycle.
        self._close_segment(effects)  # credits break_seconds (never the sink)
        self._enter_active_work(new_cycle=True)
        effects.events.append(
            self._event(EVENT_SESSION_RESUMED, {"cycle": self._current_cycle()})
        )

    def _current_cycle(self) -> int:
        """1-indexed number of the cycle now in progress."""
        return self._session.cycles_completed + 1

    def _enter_state(self, new_state: SessionState) -> None:
        # §5.3.4 — every state entry bumps the epoch, invalidating any timer
        # scheduled in the prior state.
        self._session.state = new_state
        self._epoch += 1

    def _enter_active_work(self, *, new_cycle: bool) -> None:
        if new_cycle:
            self._cycle_work_accum = 0
        self._enter_state(SessionState.ACTIVE_WORK)
        self._open_segment_now(SessionState.ACTIVE_WORK)
        # §5.3.3 — arm work_elapsed for the work *remaining* in this cycle.
        delay = self._preset.work_minutes * 60 - self._cycle_work_accum
        self._schedule("work_elapsed", delay)

    def _enter_break(self) -> None:
        self._enter_state(SessionState.BREAK)
        self._open_segment_now(SessionState.BREAK)
        self._schedule("break_elapsed", self._preset.break_minutes * 60)

    def _open_segment_now(self, seg_state: SessionState) -> None:
        """Open a fresh segment: record the monotonic anchor and the wall start."""
        segment = SessionSegment(
            state=seg_state, started_at=self._clock.now(), ended_at=None
        )
        self._session.segments.append(segment)
        self._open_segment = segment
        self._segment_start_mono = self._clock.monotonic()

    def _close_segment(self, effects: _Effects) -> None:
        """Close the open segment, crediting exactly its monotonic delta (§5.3.2).

        Called on every exit from ACTIVE_WORK/BREAK and defensively during
        finalization; a no-op when nothing is open (e.g. finalizing from PAUSED),
        which is what prevents any work time from being double-counted.
        """
        if self._open_segment is None:
            return
        delta = round(self._clock.monotonic() - self._segment_start_mono)
        self._open_segment.ended_at = self._clock.now()
        seg_state = self._open_segment.state
        self._open_segment = None
        self._segment_start_mono = None
        if seg_state is SessionState.ACTIVE_WORK:
            self._session.work_seconds += delta
            self._cycle_work_accum += delta
            # Exactly one sink credit + one EVENT_TIME_ADDED per closed
            # ACTIVE_WORK segment (§5.3.2), even if delta rounds to 0.
            effects.sink_seconds.append(delta)
            effects.events.append(
                self._event(
                    EVENT_TIME_ADDED,
                    {"seconds": delta, "total_work_seconds": self._session.work_seconds},
                )
            )
        else:  # BREAK — accrues break_seconds only; never touches the sink.
            self._session.break_seconds += delta

    def _finalize(self, effects: _Effects, outcome: SessionOutcome) -> None:
        # §5.3.6 — flush the open segment, stamp the outcome/ended_at, move to
        # terminal COMPLETED, cancel the timer, persist, announce, notify.
        self._close_segment(effects)
        self._session.outcome = outcome
        self._session.ended_at = self._clock.now()
        self._enter_state(SessionState.COMPLETED)
        self._cancel_timer()
        effects.save_snapshot = self._save_snapshot()
        effects.events.append(self._event(EVENT_SESSION_COMPLETED))
        effects.finalized = True

    def _save_snapshot(self) -> FocusSession:
        """Deep-copy the session for persistence, with a fresh ``updated_at``."""
        self._session.updated_at = self._clock.now()
        return self._session.model_copy(deep=True)

    # ---- timer scheduling --------------------------------------------------

    def _schedule(self, trigger: str, delay_seconds: float) -> None:
        # Replace any armed timer, then capture the current epoch so a late
        # callback can detect that it is stale (§5.3.4).
        self._cancel_timer()
        epoch = self._epoch
        self._timer_handle = self._timer_factory.schedule(
            delay_seconds, self._make_timer_callback(epoch, trigger)
        )

    def _make_timer_callback(
        self, epoch: int, trigger: str
    ) -> Callable[[], Awaitable[None]]:
        async def _callback() -> None:
            await self._on_timer(epoch, trigger)

        return _callback

    def _cancel_timer(self) -> None:
        if self._timer_handle is not None:
            self._timer_handle.cancel()
            self._timer_handle = None

    # ---- event construction ------------------------------------------------

    def _event(self, event_type: str, data: dict[str, Any] | None = None) -> FocusEvent:
        return FocusEvent(
            type=event_type,
            session_id=self._session.id,
            task_id=self._task_id,
            state=self._session.state,
            at=self._clock.now(),
            data=data or {},
        )
