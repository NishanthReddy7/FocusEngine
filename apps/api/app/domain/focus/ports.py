"""Persistence/crediting ports for the focus domain (ARCHITECTURE §5.2).

These Protocols are the *only* channel through which the state machine reaches
the outside world, which is what keeps FastAPI and SQLAlchemy out of the domain
layer. T4 supplies the SQL-backed implementations (``SqlTaskTimeSink`` performs
the atomic ``actual_focus_seconds += delta`` increment; ``SqlSessionStore``
upserts the session row and appends to the oplog).
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from app.schemas.focus import FocusSession


class TaskTimeSink(Protocol):
    """Credits elapsed focus time to the task linked to a session."""

    async def add_focus_seconds(self, task_id: UUID, seconds: int) -> None:
        """Add ``seconds`` of focus time to the task identified by ``task_id``.

        Called exactly once per closed ACTIVE_WORK segment (ARCHITECTURE
        §5.3.2). Implementations must apply an atomic increment; the domain
        never sends running totals.
        """
        ...


class SessionStore(Protocol):
    """Durably persists a :class:`~app.schemas.focus.FocusSession` snapshot."""

    async def save(self, session: FocusSession) -> None:
        """Persist ``session`` (called at start() and at finalization, §5.3.6)."""
        ...
