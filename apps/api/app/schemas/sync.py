"""Sync envelope schemas — ARCHITECTURE.md §4.4; full protocol in SYNC_STRATEGY.md.

TS mirror: ``packages/schemas/ts/sync.ts``.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import Field

from app.schemas.base import FEBase
from app.schemas.enums import EntityType, SyncOpType


class SyncOp(FEBase):
    """One change-log entry, as produced by the client repository layer."""

    op_id: str  # f"{hlc}:{entity}:{entity_id}" — idempotency key
    entity: EntityType
    entity_id: UUID
    op: SyncOpType
    patch: dict[str, Any] | None  # CREATE: full doc · UPDATE: changed fields only · DELETE: None
    hlc: str
    device_id: str


class PushRequest(FEBase):
    """Body of ``POST /sync/push`` — a batch of unpushed local ops."""

    device_id: str
    ops: list[SyncOp] = Field(max_length=500)
    last_server_seq: int = 0


class PushResponse(FEBase):
    """Response of ``POST /sync/push``.

    ``skipped`` = stale/duplicate op_ids — idempotent success, never retried.
    """

    applied: list[str]
    skipped: list[str]
    server_seq: int


class ServerOp(SyncOp):
    """A :class:`SyncOp` as it appears in the server oplog, with its sequence number."""

    server_seq: int


class PullResponse(FEBase):
    """Response of ``GET /sync/pull``."""

    ops: list[ServerOp]
    next_seq: int
    has_more: bool
