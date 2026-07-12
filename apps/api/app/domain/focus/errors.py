"""Domain errors for the focus state machine (ARCHITECTURE §5.1).

These are pure-Python exceptions; the router layer (T4) maps them to HTTP
status codes (InvalidTransition/SessionAlreadyActive → 409, NoActiveSession →
404) so the domain stays framework-free.
"""

from __future__ import annotations

from app.schemas.enums import SessionState


class FocusError(Exception):
    """Base class for every focus-domain error."""


class InvalidTransition(FocusError):
    """Raised when a ``(state, trigger)`` pair is absent from the transition table."""

    def __init__(self, state: SessionState, trigger: str) -> None:
        self.state = state
        self.trigger = trigger
        super().__init__(
            f"invalid transition: {trigger!r} is not allowed from {state.value!r}"
        )


class NoActiveSession(FocusError):
    """Raised when a manager action is requested but no session is active."""


class SessionAlreadyActive(FocusError):
    """Raised when starting a session while one is already active (MVP: single)."""
