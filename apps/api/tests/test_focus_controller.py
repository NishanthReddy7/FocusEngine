"""Behavioural tests for the FocusController state machine (ARCHITECTURE §5, Task T2).

Every scenario runs on a :class:`FakeClock` + :class:`ManualTimerFactory`, so no
real time passes and the suite stays fast (<5 s). The ten test groups below are
the mandatory minimum from the implementation plan's T2 section:

1.  start() → ACTIVE_WORK, one store.save, SESSION_STARTED, work timer armed.
2.  Full sprint cycle: work_elapsed → BREAK, break_elapsed → ACTIVE_WORK.
3.  planned_cycles=2 → second work_elapsed finalizes as COMPLETED.
4.  Monotonic accounting on pause (sink called once; PAUSED accrues nothing).
5.  Countdown continuity across pause/resume.
6.  Invalid transitions raise InvalidTransition.
7.  abandon() from BREAK flushes the break segment, outcome=abandoned.
8.  Stale timer callback is neutralised by the epoch guard.
9.  Events published after lock release; EventBus drop-oldest at maxsize.
10. Manager: double-start, complete-clears-slot, action-without-session.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from app.domain.focus.controller import FocusController
from app.domain.focus.errors import (
    InvalidTransition,
    NoActiveSession,
    SessionAlreadyActive,
)
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
from app.domain.focus.manager import FocusSessionManager
from app.domain.focus.timer import ManualTimerFactory
from app.schemas.enums import FocusPreset, SessionOutcome, SessionState

SPRINT_WORK = 15 * 60  # 900 s
SPRINT_BREAK = 3 * 60  # 180 s


# --------------------------------------------------------------------------- #
# Test doubles                                                                #
# --------------------------------------------------------------------------- #
class FakeClock:
    """Deterministic Clock: ``advance()`` moves both monotonic and wall time."""

    def __init__(self, start_monotonic: float = 1000.0, start_now: datetime | None = None) -> None:
        self._mono = start_monotonic
        self._now = start_now or datetime(2026, 7, 12, 12, 0, 0, tzinfo=timezone.utc)

    def monotonic(self) -> float:
        return self._mono

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._mono += seconds
        self._now = self._now + timedelta(seconds=seconds)


class FakeTimeSink:
    """Records every add_focus_seconds call as an ``(task_id, seconds)`` tuple."""

    def __init__(self) -> None:
        self.calls: list[tuple[UUID, int]] = []

    async def add_focus_seconds(self, task_id: UUID, seconds: int) -> None:
        self.calls.append((task_id, seconds))


class FakeStore:
    """Records every saved FocusSession snapshot (deep copies from the controller)."""

    def __init__(self) -> None:
        self.saves: list[object] = []

    async def save(self, session: object) -> None:
        self.saves.append(session)


def make_ctx(
    preset: FocusPreset = FocusPreset.SPRINT,
    planned_cycles: int | None = None,
    on_finalized=None,
) -> SimpleNamespace:
    """Assemble a FocusController wired to fully deterministic collaborators."""
    clock = FakeClock()
    timers = ManualTimerFactory()
    bus = EventBus()
    sink = FakeTimeSink()
    store = FakeStore()
    task_id = uuid4()
    controller = FocusController(
        task_id=task_id,
        preset=preset,
        planned_cycles=planned_cycles,
        bus=bus,
        time_sink=sink,
        store=store,
        clock=clock,
        timer_factory=timers,
        on_finalized=on_finalized,
    )
    return SimpleNamespace(
        controller=controller,
        clock=clock,
        timers=timers,
        bus=bus,
        sink=sink,
        store=store,
        task_id=task_id,
    )


def drain(queue: asyncio.Queue) -> list[FocusEvent]:
    """Non-blocking drain of every event currently buffered on a subscriber queue."""
    out: list[FocusEvent] = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


# --------------------------------------------------------------------------- #
# 1. start()                                                                  #
# --------------------------------------------------------------------------- #
async def test_start_enters_active_work_saves_and_arms_timer() -> None:
    ctx = make_ctx()
    q = ctx.bus.subscribe()

    await ctx.controller.start()

    assert ctx.controller.state is SessionState.ACTIVE_WORK
    assert len(ctx.store.saves) == 1  # store.save called once at start()
    types = [e.type for e in drain(q)]
    assert types == [EVENT_SESSION_STARTED]
    assert ctx.timers.armed is not None
    assert ctx.timers.armed.delay == SPRINT_WORK
    assert ctx.controller.remaining_seconds() == SPRINT_WORK


# --------------------------------------------------------------------------- #
# 2. Full sprint cycle                                                        #
# --------------------------------------------------------------------------- #
async def test_full_sprint_cycle_work_then_break_then_resume() -> None:
    ctx = make_ctx()  # planned_cycles=None → runs indefinitely
    q = ctx.bus.subscribe()
    await ctx.controller.start()
    drain(q)

    # Work block elapses.
    ctx.clock.advance(SPRINT_WORK)
    await ctx.timers.fire_next()  # work_elapsed
    assert ctx.controller.state is SessionState.BREAK
    types = [e.type for e in drain(q)]
    assert EVENT_CYCLE_COMPLETED in types
    assert EVENT_BREAK_STARTED in types
    assert ctx.timers.armed.delay == SPRINT_BREAK

    # Break elapses → next work cycle.
    ctx.clock.advance(SPRINT_BREAK)
    await ctx.timers.fire_next()  # break_elapsed
    assert ctx.controller.state is SessionState.ACTIVE_WORK
    evs = drain(q)
    resumed = [e for e in evs if e.type == EVENT_SESSION_RESUMED]
    assert resumed and resumed[0].data.get("cycle") == 2
    assert ctx.controller.session.cycles_completed == 1
    assert ctx.timers.armed.delay == SPRINT_WORK  # fresh full work countdown


# --------------------------------------------------------------------------- #
# 3. planned_cycles=2 finalizes on the second work_elapsed                    #
# --------------------------------------------------------------------------- #
async def test_planned_cycles_finalizes_as_completed() -> None:
    finalized: list[FocusController] = []
    ctx = make_ctx(planned_cycles=2, on_finalized=finalized.append)
    q = ctx.bus.subscribe()
    await ctx.controller.start()

    ctx.clock.advance(SPRINT_WORK)
    await ctx.timers.fire_next()  # cycle 1 work_elapsed → BREAK
    ctx.clock.advance(SPRINT_BREAK)
    await ctx.timers.fire_next()  # break_elapsed → cycle 2 ACTIVE_WORK
    ctx.clock.advance(SPRINT_WORK)
    await ctx.timers.fire_next()  # cycle 2 work_elapsed → finalize

    assert ctx.controller.state is SessionState.COMPLETED
    assert ctx.controller.session.outcome is SessionOutcome.COMPLETED
    assert ctx.controller.session.cycles_completed == 2
    types = [e.type for e in drain(q)]
    assert EVENT_SESSION_COMPLETED in types
    assert len(finalized) == 1
    # store.save fires at start() and again at finalization.
    assert len(ctx.store.saves) == 2
    assert ctx.store.saves[-1].state is SessionState.COMPLETED
    assert ctx.store.saves[-1].outcome is SessionOutcome.COMPLETED
    assert ctx.controller.session.work_seconds == 2 * SPRINT_WORK


# --------------------------------------------------------------------------- #
# 4. Monotonic accounting on pause                                            #
# --------------------------------------------------------------------------- #
async def test_pause_credits_exact_monotonic_delta_once() -> None:
    ctx = make_ctx()
    q = ctx.bus.subscribe()
    await ctx.controller.start()
    drain(q)

    ctx.clock.advance(600)
    await ctx.controller.pause()

    assert ctx.controller.session.work_seconds == 600
    assert ctx.sink.calls == [(ctx.task_id, 600)]  # exactly once, exact delta
    types = [e.type for e in drain(q)]
    assert EVENT_TIME_ADDED in types
    assert EVENT_SESSION_PAUSED in types

    seg = ctx.controller.session.segments[0]
    assert seg.state is SessionState.ACTIVE_WORK
    assert seg.ended_at is not None  # segment closed

    # PAUSED accrues nothing even as wall/monotonic time marches on.
    ctx.clock.advance(1000)
    assert ctx.controller.session.work_seconds == 600
    assert len(ctx.sink.calls) == 1
    assert ctx.controller.remaining_seconds() == SPRINT_WORK - 600


# --------------------------------------------------------------------------- #
# 5. Countdown continuity across pause/resume                                 #
# --------------------------------------------------------------------------- #
async def test_countdown_continuity_across_pause_resume() -> None:
    ctx = make_ctx()
    await ctx.controller.start()

    ctx.clock.advance(600)
    await ctx.controller.pause()
    await ctx.controller.resume()

    assert ctx.controller.state is SessionState.ACTIVE_WORK
    # New work timer resumes the countdown, not restarts it.
    assert ctx.timers.armed.delay == SPRINT_WORK - 600
    assert ctx.controller.remaining_seconds() == SPRINT_WORK - 600


# --------------------------------------------------------------------------- #
# 6. Invalid transitions                                                      #
# --------------------------------------------------------------------------- #
async def test_pause_from_idle_is_invalid() -> None:
    ctx = make_ctx()
    with pytest.raises(InvalidTransition):
        await ctx.controller.pause()


async def test_resume_from_active_work_is_invalid() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    with pytest.raises(InvalidTransition):
        await ctx.controller.resume()


async def test_start_twice_is_invalid() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    with pytest.raises(InvalidTransition):
        await ctx.controller.start()


async def test_completed_state_accepts_nothing() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    await ctx.controller.complete()
    assert ctx.controller.state is SessionState.COMPLETED
    for action in (
        ctx.controller.start,
        ctx.controller.pause,
        ctx.controller.resume,
        ctx.controller.skip_break,
        ctx.controller.complete,
        ctx.controller.abandon,
    ):
        with pytest.raises(InvalidTransition):
            await action()


# --------------------------------------------------------------------------- #
# 7. abandon() from BREAK                                                      #
# --------------------------------------------------------------------------- #
async def test_abandon_from_break_flushes_break_segment() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    ctx.clock.advance(SPRINT_WORK)
    await ctx.timers.fire_next()  # → BREAK
    assert ctx.controller.state is SessionState.BREAK

    ctx.clock.advance(60)
    await ctx.controller.abandon()

    assert ctx.controller.state is SessionState.COMPLETED
    assert ctx.controller.session.outcome is SessionOutcome.ABANDONED
    assert ctx.controller.session.break_seconds == 60
    # Break time never credits the task sink; only the one work block did.
    assert ctx.sink.calls == [(ctx.task_id, SPRINT_WORK)]
    break_segs = [s for s in ctx.controller.session.segments if s.state is SessionState.BREAK]
    assert break_segs and break_segs[-1].ended_at is not None


# --------------------------------------------------------------------------- #
# 8. Stale timer callback neutralised by the epoch guard                      #
# --------------------------------------------------------------------------- #
async def test_stale_timer_callback_is_noop() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    stale_timer = ctx.timers.timers[0]  # the work_elapsed timer armed by start()

    ctx.clock.advance(600)
    await ctx.controller.pause()  # cancels the timer and advances the epoch

    state_before = ctx.controller.state
    work_before = ctx.controller.session.work_seconds
    sink_before = len(ctx.sink.calls)

    # Fire the captured (now stale) callback directly: it must no-op.
    await stale_timer.callback()

    assert ctx.controller.state is state_before is SessionState.PAUSED
    assert ctx.controller.session.work_seconds == work_before
    assert len(ctx.sink.calls) == sink_before


# --------------------------------------------------------------------------- #
# 9. Events after lock release + EventBus drop-oldest                          #
# --------------------------------------------------------------------------- #
async def test_events_published_after_lock_release() -> None:
    ctx = make_ctx()
    q = ctx.bus.subscribe()
    await ctx.controller.start()

    # Receiving the event implies the lock was already released before publish;
    # a follow-up action that takes the same lock must not deadlock.
    ev = await asyncio.wait_for(q.get(), timeout=1.0)
    assert ev.type == EVENT_SESSION_STARTED
    await asyncio.wait_for(ctx.controller.pause(), timeout=1.0)
    assert ctx.controller.state is SessionState.PAUSED


async def test_eventbus_drops_oldest_at_maxsize() -> None:
    bus = EventBus(maxsize=2)
    q = bus.subscribe()

    def mk(tag: str) -> FocusEvent:
        return FocusEvent(
            type=tag,
            session_id=uuid4(),
            task_id=uuid4(),
            state=SessionState.IDLE,
            at=datetime.now(timezone.utc),
            data={},
        )

    await bus.publish(mk("e1"))
    await bus.publish(mk("e2"))
    await bus.publish(mk("e3"))  # queue full → drop oldest (e1)

    assert [e.type for e in drain(q)] == ["e2", "e3"]
    assert bus.dropped == 1


# --------------------------------------------------------------------------- #
# 10. Manager registry                                                        #
# --------------------------------------------------------------------------- #
async def test_manager_single_active_lifecycle() -> None:
    bus = EventBus()
    sink = FakeTimeSink()
    store = FakeStore()
    clock = FakeClock()
    timers = ManualTimerFactory()
    mgr = FocusSessionManager(
        bus=bus, time_sink=sink, store=store, clock=clock, timer_factory=timers
    )
    task_id = uuid4()

    session = await mgr.start_session(task_id, FocusPreset.SPRINT)
    assert session.state is SessionState.ACTIVE_WORK
    assert mgr.get_active() is not None

    with pytest.raises(SessionAlreadyActive):
        await mgr.start_session(uuid4(), FocusPreset.SPRINT)

    await mgr.complete()
    assert mgr.get_active() is None  # finalization cleared the active slot

    with pytest.raises(NoActiveSession):
        await mgr.pause()


# --------------------------------------------------------------------------- #
# Bonus: skip_break exercises the (BREAK, "skip_break") transition            #
# --------------------------------------------------------------------------- #
async def test_skip_break_returns_to_work_and_credits_break() -> None:
    ctx = make_ctx()
    await ctx.controller.start()
    ctx.clock.advance(SPRINT_WORK)
    await ctx.timers.fire_next()  # → BREAK
    ctx.clock.advance(30)  # 30 s into the break

    await ctx.controller.skip_break()

    assert ctx.controller.state is SessionState.ACTIVE_WORK
    assert ctx.controller.session.break_seconds == 30
    assert ctx.timers.armed.delay == SPRINT_WORK  # new cycle, full work countdown
    assert ctx.controller.remaining_seconds() == SPRINT_WORK
