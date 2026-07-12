/**
 * Sync envelope — exact TS mirror of `app/schemas/sync.py` (ARCHITECTURE.md §4.4)
 * and the merge contract in SYNC_STRATEGY.md §4-§6.
 */
import { EntityType, SyncOpType } from "./enums";

export interface SyncOp {
  /** `{hlc}:{entity}:{entity_id}` — idempotency key */
  op_id: string;
  entity: EntityType;
  entity_id: string;
  op: SyncOpType;
  /** CREATE: full doc · UPDATE: changed fields only · DELETE: null */
  patch: Record<string, unknown> | null;
  hlc: string;
  device_id: string;
}

export interface PushRequest {
  device_id: string;
  /** max 500 */
  ops: SyncOp[];
  last_server_seq: number;
}

export interface PushResponse {
  applied: string[];
  /** stale/duplicate (idempotent success) */
  skipped: string[];
  server_seq: number;
}

export interface ServerOp extends SyncOp {
  server_seq: number;
}

export interface PullResponse {
  ops: ServerOp[];
  next_seq: number;
  has_more: boolean;
}

/**
 * Derived fields — SYNC_STRATEGY.md §5 step 2 / §6. These are additive,
 * cross-device counters recomputed server-side from append-only facts, never
 * LWW-merged. Both `app/services/sync.py::apply_op` (server) and
 * `lib/sync/engine.ts::applyRemoteOp` (client) strip these keys from an
 * incoming op's `patch` before applying it — kept here as the single TS-side
 * source of truth so both merge call sites agree.
 */
export const DERIVED_FIELDS: Readonly<Record<EntityType, readonly string[]>> = {
  [EntityType.TASK]: ["actual_focus_seconds"],
  [EntityType.PROJECT]: [],
  [EntityType.SECTION]: [],
  [EntityType.VISION]: [],
  [EntityType.SEASON]: [],
  [EntityType.FOCUS_SESSION]: [],
  [EntityType.DAILY_REVIEW]: [],
};

/** Reserved device id for server-originated mutations (SYNC_STRATEGY.md §2). */
export const SERVER_DEVICE_ID = "server";
