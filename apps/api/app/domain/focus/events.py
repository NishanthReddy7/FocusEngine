"""Focus event bus and event payloads (ARCHITECTURE §5.2).

The bus is the task-engine ↔ focus-engine integration seam: the controller
publishes :class:`FocusEvent`s and consumers (WebSocket fan-out, ambient-audio
engine, …) subscribe without knowing the machine's internals. Publishing never
blocks on a slow consumer — a full subscriber queue drops its oldest event and
counts the drop.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from app.schemas.enums import SessionState

# Event-name constants (dotted, stable wire strings). Consumers match on these.
EVENT_SESSION_STARTED = "focus.session.started"
EVENT_SESSION_PAUSED = "focus.session.paused"
EVENT_SESSION_RESUMED = "focus.session.resumed"
EVENT_BREAK_STARTED = "focus.break.started"
EVENT_CYCLE_COMPLETED = "focus.cycle.completed"
EVENT_SESSION_COMPLETED = "focus.session.completed"
# data: {"seconds": int, "total_work_seconds": int}
EVENT_TIME_ADDED = "focus.task.time_added"

DEFAULT_MAXSIZE = 256


@dataclass(frozen=True)
class FocusEvent:
    """An immutable focus-domain event (ARCHITECTURE §5.2)."""

    type: str
    session_id: UUID
    task_id: UUID
    state: SessionState
    at: datetime
    data: dict[str, Any]


class EventBus:
    """Fan-out pub/sub over bounded asyncio queues (ARCHITECTURE §5.2).

    Each subscriber gets its own bounded queue; on overflow the oldest event is
    dropped (and counted) so a slow consumer can never stall a publisher.
    """

    def __init__(self, maxsize: int = DEFAULT_MAXSIZE) -> None:
        self._maxsize = maxsize
        self._subscribers: list[asyncio.Queue[FocusEvent]] = []
        self._dropped = 0

    @property
    def dropped(self) -> int:
        """Total events dropped across all subscribers (observable backpressure)."""
        return self._dropped

    def subscribe(self) -> asyncio.Queue[FocusEvent]:
        """Register a new subscriber and return its bounded queue."""
        queue: asyncio.Queue[FocusEvent] = asyncio.Queue(maxsize=self._maxsize)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[FocusEvent]) -> None:
        """Remove a subscriber queue; a no-op if it is not registered."""
        try:
            self._subscribers.remove(queue)
        except ValueError:
            pass

    async def publish(self, event: FocusEvent) -> None:
        """Deliver ``event`` to every subscriber, dropping the oldest on overflow.

        This coroutine never awaits: single-threaded asyncio guarantees the
        ``full()`` / ``get_nowait()`` / ``put_nowait()`` sequence runs without
        interleaving, so once a slot has been freed the put cannot fail.
        """
        for queue in self._subscribers:
            if queue.full():
                queue.get_nowait()  # drop the oldest buffered event
                self._dropped += 1
            queue.put_nowait(event)
