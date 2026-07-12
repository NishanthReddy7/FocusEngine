"""Hybrid Logical Clock — SYNC_STRATEGY.md §2.

String format (identical in ``lib/sync/hlc.ts``)::

    f"{unix_ms:013d}-{counter:04x}-{device8}"   e.g. "1783958400123-0003-9f3a1c2b"

Zero-padding makes lexicographic string order equal causal order: the
13-digit millisecond field sorts correctly up to year 2286, the 4-hex-digit
counter breaks ties within the same millisecond, and the 8-hex-char device
id breaks any remaining tie deterministically.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from app.schemas.base import utcnow

#: Clock-skew guard (SYNC_STRATEGY §2): a remote physical time is never
#: adopted more than this far ahead of the local wall clock, so a device
#: with a wildly wrong clock can't drag every other device's HLC forward.
SKEW_CAP_MS = 5 * 60 * 1000


def device8(device_id: str) -> str:
    """First 8 hex characters of a device uuid, as embedded in HLC strings."""
    return device_id.replace("-", "")[:8]


def format_hlc(unix_ms: int, counter: int, device_id: str) -> str:
    """Render ``(unix_ms, counter, device_id)`` as the canonical HLC string."""
    return f"{unix_ms:013d}-{counter:04x}-{device8(device_id)}"


def parse_hlc(hlc: str) -> tuple[int, int, str]:
    """Parse an HLC string back into ``(unix_ms, counter, device8)``."""
    ms_part, counter_part, device_part = hlc.split("-")
    return int(ms_part), int(counter_part, 16), device_part


def _wall_ms(now_fn: Callable[[], datetime]) -> int:
    """Current wall-clock time in integer milliseconds since the epoch."""
    return round(now_fn().timestamp() * 1000)


class HybridLogicalClock:
    """Per-device HLC state machine (SYNC_STRATEGY.md §2).

    One instance per device (client) or per server process, persisted
    externally (client: ``_meta.hlc_last``; server: in-process) between
    calls. ``now_fn`` defaults to :func:`app.schemas.base.utcnow` and is
    injectable for deterministic tests.
    """

    def __init__(self, device_id: str, *, now_fn: Callable[[], datetime] | None = None) -> None:
        self.device_id = device_id
        self._now_fn = now_fn or utcnow
        self.last_ms: int = 0
        self.counter: int = 0

    def tick(self) -> str:
        """Stamp a new local event, advancing the clock monotonically.

        ``ms = max(wall_ms, last_ms)``; if unchanged from ``last_ms`` the
        counter bumps (same-millisecond collision), otherwise it resets.
        """
        wall_ms = _wall_ms(self._now_fn)
        new_ms = max(wall_ms, self.last_ms)
        if new_ms == self.last_ms:
            self.counter += 1
        else:
            self.counter = 0
        self.last_ms = new_ms
        return self._format()

    def receive(self, remote: str) -> str:
        """Merge a remote HLC string into this clock (on applying a pulled op).

        Adopts ``max(local, remote, wall)`` per the standard HLC receive
        algorithm, capping the remote physical time at ``wall + SKEW_CAP_MS``
        before the merge so a fast remote clock can't poison this device's
        clock indefinitely.
        """
        remote_ms, remote_counter, _remote_device = parse_hlc(remote)
        wall_ms = _wall_ms(self._now_fn)
        capped_remote_ms = min(remote_ms, wall_ms + SKEW_CAP_MS)

        prev_ms, prev_counter = self.last_ms, self.counter
        new_ms = max(prev_ms, capped_remote_ms, wall_ms)

        if new_ms == prev_ms and new_ms == capped_remote_ms:
            new_counter = max(prev_counter, remote_counter) + 1
        elif new_ms == prev_ms:
            new_counter = prev_counter + 1
        elif new_ms == capped_remote_ms:
            new_counter = remote_counter + 1
        else:
            new_counter = 0

        self.last_ms = new_ms
        self.counter = new_counter
        return self._format()

    def _format(self) -> str:
        return format_hlc(self.last_ms, self.counter, self.device_id)
