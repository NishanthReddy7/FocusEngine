/**
 * Repository — ARCHITECTURE.md §7.2 (load-bearing rule): every local write is
 * ONE Dexie transaction spanning the entity table and `_oplog`, bumping
 * `field_hlcs` per touched field. No component (and no other lib module)
 * writes Dexie tables directly — this file is the only place that does.
 * Remote-merge writes (driven by `lib/sync/engine.ts`) go through
 * `applyRemoteWrite` instead, which deliberately does NOT touch `_oplog`
 * (SYNC_STRATEGY.md §4: "repository bypasses oplog-append for remote ops —
 * remote ops are already in the server log").
 */
import type { Table } from "dexie";
import {
  db,
  type EntityRowMap,
  type EntityTableName,
  type MetaKey,
  type OplogRow,
} from "./schema";
import { HLC } from "../sync/hlc";
import { computeNext, dateToISODate } from "../recurrence/next";
import { bus } from "../events/bus";
import type { ParsedQuickAdd } from "../nlp/parser";
import {
  CaptureSource,
  EnergyLevel,
  EntityType,
  RecurrenceAnchor,
  SyncOpType,
  TaskStatus,
} from "@focusengine/schemas/enums";
import type {
  DueInfo,
  ISODateString,
  NLPMetadata,
  SyncAudit,
  Task,
} from "@focusengine/schemas/entities";
import type { StoredAuth, UserSettings } from "@focusengine/schemas/auth";

// ---------------------------------------------------------------------------
// Table <-> EntityType (ARCHITECTURE.md §4.1 enum values are singular/
// underscored, e.g. "focus_session"; Dexie table names are their plural
// collection names, e.g. "focus_sessions" — this is the single place that
// translates between them).
// ---------------------------------------------------------------------------

export const TABLE_TO_ENTITY_TYPE: Record<EntityTableName, EntityType> = {
  tasks: EntityType.TASK,
  projects: EntityType.PROJECT,
  sections: EntityType.SECTION,
  visions: EntityType.VISION,
  seasons: EntityType.SEASON,
  focus_sessions: EntityType.FOCUS_SESSION,
  daily_reviews: EntityType.DAILY_REVIEW,
};

export const ENTITY_TYPE_TO_TABLE: Record<EntityType, EntityTableName> = {
  [EntityType.TASK]: "tasks",
  [EntityType.PROJECT]: "projects",
  [EntityType.SECTION]: "sections",
  [EntityType.VISION]: "visions",
  [EntityType.SEASON]: "seasons",
  [EntityType.FOCUS_SESSION]: "focus_sessions",
  [EntityType.DAILY_REVIEW]: "daily_reviews",
};

/** Dexie's `.table(name)` accessor is dynamically typed (`Table<any, any>`);
 *  this centralizes the one assertion needed to correlate it back to our own
 *  `EntityRowMap`, so the functions below don't each repeat it. */
function tableFor<E extends EntityTableName>(name: E): Table<EntityRowMap[E], string> {
  return db.table(name) as unknown as Table<EntityRowMap[E], string>;
}

function utcNowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Device id + HLC — module-level singletons for the page's lifetime so
// concurrent callers share one in-memory clock instead of racing on reads of
// `_meta` (SYNC_STRATEGY.md §2: "HLC per device... persisted in _meta.hlc_last").
// ---------------------------------------------------------------------------

let deviceIdPromise: Promise<string> | null = null;

export async function getDeviceId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const existing = await db._meta.get("device_id");
      if (existing && typeof existing.value === "string") return existing.value;
      const id = crypto.randomUUID();
      await db._meta.put({ key: "device_id", value: id });
      return id;
    })();
  }
  return deviceIdPromise;
}

let hlcPromise: Promise<HLC> | null = null;

async function getHlc(): Promise<HLC> {
  if (!hlcPromise) {
    hlcPromise = (async () => {
      const deviceId = await getDeviceId();
      const row = await db._meta.get("hlc_last");
      const seed = row && typeof row.value === "string" ? row.value : null;
      return new HLC(deviceId, seed);
    })();
  }
  return hlcPromise;
}

/** tick() before stamping a local op (SYNC_STRATEGY.md §2). */
export async function tickLocalHlc(): Promise<string> {
  const clock = await getHlc();
  const stamped = clock.tick();
  await db._meta.put({ key: "hlc_last", value: stamped });
  return stamped;
}

/** receive(remote) on applying a pulled op (SYNC_STRATEGY.md §2) — advances
 *  the local clock so subsequent local ticks stay causally after everything
 *  this device has observed. Used by `lib/sync/engine.ts`. */
export async function receiveRemoteHlc(remoteHlc: string): Promise<void> {
  const clock = await getHlc();
  const stamped = clock.receive(remoteHlc);
  await db._meta.put({ key: "hlc_last", value: stamped });
}

// ---------------------------------------------------------------------------
// _meta / _oplog accessors used by lib/sync/engine.ts (kept here so engine.ts
// never touches Dexie tables directly either).
// ---------------------------------------------------------------------------

export async function getMeta<T>(key: MetaKey): Promise<T | undefined> {
  const row = await db._meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: MetaKey, value: unknown): Promise<void> {
  await db._meta.put({ key, value });
}

export async function getLastServerSeq(): Promise<number> {
  const value = await getMeta<number>("last_server_seq");
  return value ?? 0;
}

export async function setLastServerSeq(seq: number): Promise<void> {
  await setMeta("last_server_seq", seq);
}

/** Up to `limit` unpushed ops, ordered by `seq` (SYNC_STRATEGY.md §4 push). */
export async function getUnpushedOps(limit: number): Promise<OplogRow[]> {
  const rows = await db._oplog.where("pushed").equals(0).sortBy("seq");
  return rows.slice(0, limit);
}

/** Marks ops pushed — SYNC_STRATEGY.md §4: "Client marks both `applied` and
 *  `skipped` rows `pushed=1`" (skipped is idempotent success, never retried). */
export async function markOpsPushed(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  await db.transaction("rw", db._oplog, async () => {
    const rows = await db._oplog.where("op_id").anyOf(opIds).toArray();
    await Promise.all(
      rows
        .filter((row): row is OplogRow & { seq: number } => row.seq !== undefined)
        .map((row) => db._oplog.update(row.seq, { pushed: 1 })),
    );
  });
}

// ---------------------------------------------------------------------------
// Auth / settings / data-owner _meta accessors (V2_ADDENDUM §A2/A3). Typed
// wrappers over the untyped `_meta` store so the auth provider and settings
// screens never touch Dexie directly (same rule as every other module).
// ---------------------------------------------------------------------------

/** The signed-in `{token, user}` bundle, or null when signed out (A3). */
export async function getStoredAuth(): Promise<StoredAuth | null> {
  return (await getMeta<StoredAuth>("auth")) ?? null;
}

export async function setStoredAuth(auth: StoredAuth): Promise<void> {
  await setMeta("auth", auth);
}

/** Sign-out clears the token+user but KEEPS local data and `data_owner` (A3). */
export async function clearStoredAuth(): Promise<void> {
  await db._meta.delete("auth");
}

/** Cached per-user `UserSettings` (A2), hydrated from `GET /me` when signed in
 *  and written by onboarding / the settings screen. */
export async function getStoredSettings(): Promise<UserSettings | null> {
  return (await getMeta<UserSettings>("settings")) ?? null;
}

export async function setStoredSettings(settings: UserSettings): Promise<void> {
  await setMeta("settings", settings);
}

/** The user id the local dataset belongs to — set on first claim / bootstrap,
 *  and PERSISTED across sign-out so a later sign-in as a different user can be
 *  detected (A3 "Replace local data?"). Null = never claimed (pure local). */
export async function getDataOwner(): Promise<string | null> {
  return (await getMeta<string>("data_owner")) ?? null;
}

export async function setDataOwner(userId: string | null): Promise<void> {
  if (userId === null) {
    await db._meta.delete("data_owner");
    return;
  }
  await setMeta("data_owner", userId);
}

/** FocusShield distraction list (`_meta.shield_blocklist`) — edited on the
 *  settings screen, mirrored into `UserSettings.blocklist` for cross-device
 *  sync. Always an array. */
export async function getBlocklist(): Promise<string[]> {
  const value = await getMeta<string[]>("shield_blocklist");
  return Array.isArray(value) ? value : [];
}

export async function setBlocklist(list: string[]): Promise<void> {
  await setMeta("shield_blocklist", list);
}

// ---------------------------------------------------------------------------
// Claim-local-data + wipe (V2_ADDENDUM §A2/A3). Both live here because they
// touch entity tables + `_oplog` + the HLC, whose invariants this module owns.
// ---------------------------------------------------------------------------

/** Parent-before-child ordering so a staged CREATE for a child (a task's
 *  project_id, a section's project_id) is preceded by its parent's CREATE in
 *  the oplog. The server merge is FK-agnostic field-level LWW, so this is a
 *  tidiness guarantee rather than a correctness one, but it keeps the replayed
 *  log readable. */
const CLAIM_TABLE_ORDER: readonly EntityTableName[] = [
  "visions",
  "seasons",
  "projects",
  "sections",
  "tasks",
  "focus_sessions",
  "daily_reviews",
];

/**
 * First-sign-in claim (A2 "claim-local-data"): guarantee every local row is
 * queued to push to the newly-signed-in account. For each entity row that does
 * NOT already have a pending (`pushed=0`) oplog op, append a fresh CREATE op
 * carrying the row's full current doc — so the server receives it on the next
 * push. Rows that already have a pending op are left alone (they push anyway),
 * which is why in the common pure-local case (nothing ever pushed) this stages
 * nothing and simply lets the existing unpushed CREATEs flow. The server treats
 * a CREATE for an already-present row as a field-by-field UPDATE (idempotent),
 * so a redundant claim can never corrupt server state.
 *
 * Returns the number of rows freshly staged (0 in the common case).
 */
export async function claimLocalData(): Promise<number> {
  const pending = await db._oplog.where("pushed").equals(0).toArray();
  const pendingEntityIds = new Set(pending.map((op) => op.entity_id));

  const deviceId = await getDeviceId();
  let staged = 0;

  for (const table of CLAIM_TABLE_ORDER) {
    const entity = TABLE_TO_ENTITY_TYPE[table];
    const rows = await tableFor(table).toArray();
    for (const row of rows) {
      const record = row as unknown as Record<string, unknown> & { id: string };
      if (pendingEntityIds.has(record.id)) continue; // already queued for push

      const hlc = await tickLocalHlc();
      // The oplog patch never carries the local-only `field_hlcs` bookkeeping
      // (SYNC merges reconstruct it server-side from op HLCs).
      const doc: Record<string, unknown> = { ...record };
      delete doc.field_hlcs;
      await db._oplog.add({
        op_id: `${hlc}:${entity}:${record.id}`,
        entity,
        entity_id: record.id,
        op: SyncOpType.CREATE,
        patch: doc,
        hlc,
        device_id: deviceId,
        pushed: 0,
      });
      staged += 1;
    }
  }

  return staged;
}

/**
 * Bootstrap wipe (A3 "Replace local data?" → wipe+load): clear every entity
 * table and the oplog, and reset the pull cursor to 0 so the next sync
 * bootstraps the newly-signed-in user's snapshot. Deliberately KEEPS
 * `device_id`, `hlc_last` (the monotonic clock stays valid) and UI-only keys
 * (`theme`); the caller sets `auth` / `settings` / `data_owner` for the new
 * user immediately after.
 */
export async function wipeLocalData(): Promise<void> {
  await db.transaction(
    "rw",
    [db.tasks, db.projects, db.sections, db.visions, db.seasons, db.focus_sessions, db.daily_reviews, db._oplog, db._meta],
    async () => {
      await Promise.all(CLAIM_TABLE_ORDER.map((table) => tableFor(table).clear()));
      await db._oplog.clear();
      await db._meta.put({ key: "last_server_seq", value: 0 });
    },
  );
}

// ---------------------------------------------------------------------------
// Local mutation path — createEntity / updateEntity / softDelete. Every
// write here is one Dexie transaction spanning [table, _oplog].
// ---------------------------------------------------------------------------

/** What a caller supplies to `createEntity`: every business field, `id`
 *  optional (defaults to uuid4 — mirrors `TaskCreate`'s "id defaults to
 *  uuid4()", ARCHITECTURE.md §4.3), audit/sync fields excluded entirely
 *  (this function stamps them — mirrors "audit fields server-stamped",
 *  generalized to "repository-stamped" on the client). */
export type NewEntityInput<E extends EntityTableName> = Omit<
  EntityRowMap[E],
  keyof SyncAudit | "field_hlcs" | "id"
> & { id?: string };

export async function createEntity<E extends EntityTableName>(
  table: E,
  input: NewEntityInput<E>,
): Promise<EntityRowMap[E]> {
  const hlc = await tickLocalHlc();
  const deviceId = await getDeviceId();
  const now = utcNowISO();
  const resolvedId = input.id ?? crypto.randomUUID();

  // Spreading a generic-over-union `input` plus the stamped audit block
  // can't be verified field-for-field by the checker against the specific
  // `EntityRowMap[E]` for whichever concrete E was passed — this is the one
  // assertion needed to say "trust that NewEntityInput<E> + audit + id really
  // is EntityRowMap[E] minus field_hlcs", which callers' input types enforce.
  const fullDoc = {
    ...input,
    id: resolvedId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    updated_hlc: hlc,
    device_id: deviceId,
  } as unknown as Omit<EntityRowMap[E], "field_hlcs">;

  const fieldHlcs: Record<string, string> = {};
  for (const key of Object.keys(fullDoc)) {
    fieldHlcs[key] = hlc;
  }
  const row = { ...fullDoc, field_hlcs: fieldHlcs } as unknown as EntityRowMap[E];

  const entity = TABLE_TO_ENTITY_TYPE[table];
  const opRow: OplogRow = {
    op_id: `${hlc}:${entity}:${resolvedId}`,
    entity,
    entity_id: resolvedId,
    op: SyncOpType.CREATE,
    patch: fullDoc as unknown as Record<string, unknown>,
    hlc,
    device_id: deviceId,
    pushed: 0,
  };

  await db.transaction("rw", tableFor(table), db._oplog, async () => {
    await tableFor(table).add(row);
    await db._oplog.add(opRow);
  });

  // Bus integration point (ARCHITECTURE.md §7.3): lets lib/sync/engine.ts
  // debounce a sync burst after local writes without importing this module
  // (which would cycle back on itself), and lets any UI react without a
  // direct dependency on the repository.
  if (table === "tasks") {
    bus.emit("task.created", { task_id: resolvedId });
  }

  return row;
}

/** Sparse patch type for `updateEntity`: business fields only (no id, no
 *  audit/sync block, no field_hlcs) — those are managed by this function. */
export type EntityPatch<E extends EntityTableName> = Partial<
  Omit<EntityRowMap[E], keyof SyncAudit | "field_hlcs" | "id">
>;

export async function updateEntity<E extends EntityTableName>(
  table: E,
  id: string,
  patch: EntityPatch<E>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return; // nothing touched, nothing to do

  const hlc = await tickLocalHlc();
  const deviceId = await getDeviceId();
  const now = utcNowISO();
  const entity = TABLE_TO_ENTITY_TYPE[table];
  let didUpdate = false;

  await db.transaction("rw", tableFor(table), db._oplog, async () => {
    const existing = await tableFor(table).get(id);
    if (!existing) return; // nothing to update locally — no-op, no oplog entry

    const fieldHlcs = { ...existing.field_hlcs };
    for (const key of Object.keys(patch)) {
      fieldHlcs[key] = hlc;
    }

    const updatedRow = {
      ...existing,
      ...patch,
      updated_at: now,
      updated_hlc: hlc,
      device_id: deviceId,
      field_hlcs: fieldHlcs,
    } as unknown as EntityRowMap[E];

    await tableFor(table).put(updatedRow);
    await db._oplog.add({
      op_id: `${hlc}:${entity}:${id}`,
      entity,
      entity_id: id,
      op: SyncOpType.UPDATE,
      patch: patch as unknown as Record<string, unknown>,
      hlc,
      device_id: deviceId,
      pushed: 0,
    });
    didUpdate = true;
  });

  if (didUpdate && table === "tasks") {
    bus.emit("task.updated", { task_id: id, fields: Object.keys(patch) });
  }
}

export async function softDelete<E extends EntityTableName>(table: E, id: string): Promise<void> {
  const hlc = await tickLocalHlc();
  const deviceId = await getDeviceId();
  const now = utcNowISO();
  const entity = TABLE_TO_ENTITY_TYPE[table];
  let didDelete = false;

  await db.transaction("rw", tableFor(table), db._oplog, async () => {
    const existing = await tableFor(table).get(id);
    if (!existing) return;

    const updatedRow = {
      ...existing,
      deleted_at: now,
      updated_at: now,
      updated_hlc: hlc,
      device_id: deviceId,
      field_hlcs: { ...existing.field_hlcs, __deleted__: hlc },
    } as unknown as EntityRowMap[E];

    await tableFor(table).put(updatedRow);
    await db._oplog.add({
      op_id: `${hlc}:${entity}:${id}`,
      entity,
      entity_id: id,
      op: SyncOpType.DELETE,
      patch: null,
      hlc,
      device_id: deviceId,
      pushed: 0,
    });
    didDelete = true;
  });

  if (didDelete && table === "tasks") {
    bus.emit("task.deleted", { task_id: id });
  }
}

// ---------------------------------------------------------------------------
// Remote-merge write path — used ONLY by lib/sync/engine.ts's applyRemoteOp.
// Does not append to _oplog (remote ops are already server-logged, SYNC §4).
// ---------------------------------------------------------------------------

/**
 * Applies one remote op's merge atomically with its HLC receive. Opens ONE
 * `rw` transaction spanning [`table`, `_meta`]: inside it, `receiveRemoteHlc`
 * advances the local clock (`_meta.hlc_last`, SYNC_STRATEGY.md §2 receive())
 * and `decide` — implementing the §5 merge — reads the current row (possibly
 * undefined) and returns either the row to `put()` or `"skip"` (stale/duplicate
 * write, or a DELETE a causally-later edit beat).
 *
 * Wrapping receive + read + decide + put in the single transaction is what
 * makes the read-modify-write safe under concurrency: IndexedDB serializes
 * overlapping-scope `rw` transactions — across browser tabs too — so no other
 * applier (a second trigger this tab's overlap guard can't see, or another
 * tab's engine) can slip a stale `get()` between this read and `put()` and
 * clobber a field a prior op just merged (e.g. the server's recomputed
 * `task.actual_focus_seconds`). `receiveRemoteHlc` runs first and unconditionally,
 * so the local clock advances even when the merge is a no-op `"skip"`.
 * Still bypasses `_oplog` (remote ops are already server-logged, SYNC §4).
 */
export async function applyRemoteWrite<E extends EntityTableName>(
  table: E,
  id: string,
  remoteHlc: string,
  decide: (existing: EntityRowMap[E] | undefined) => EntityRowMap[E] | "skip",
): Promise<void> {
  await db.transaction("rw", tableFor(table), db._meta, async () => {
    await receiveRemoteHlc(remoteHlc);
    const existing = await tableFor(table).get(id);
    const outcome = decide(existing);
    if (outcome === "skip") return;
    await tableFor(table).put(outcome);
  });
}

/**
 * Wholesale table load for `GET /sync/bootstrap` (SYNC_STRATEGY.md §7 — first
 * sync / lost cursor). Snapshot rows come from the server already shaped like
 * `EntityRowMap[E]` (the server's `SyncMixin` carries `field_hlcs` too, per
 * ARCHITECTURE.md §4.6, for this exact reason), so this is a plain bulk
 * insert — no oplog append (this is establishing initial state, not a
 * tracked local mutation).
 */
export async function bulkPutSnapshot<E extends EntityTableName>(
  table: E,
  rows: EntityRowMap[E][],
): Promise<void> {
  if (rows.length === 0) return;
  await tableFor(table).bulkPut(rows);
}

// ---------------------------------------------------------------------------
// Task-specific helpers.
// ---------------------------------------------------------------------------

/** Builds and persists a Task from `lib/nlp/parser.ts`'s `parseQuickAdd`
 *  output. `rawInput` (the untouched original string) is stored on
 *  `nlp.raw_input`; falls back to the parsed title if omitted. */
export async function createTaskFromParse(parsed: ParsedQuickAdd, rawInput?: string): Promise<Task> {
  const due: DueInfo | null = parsed.due
    ? { date: parsed.due.date, time: parsed.due.time, timezone: "UTC", recurrence: parsed.recurrence }
    : null;

  const nlp: NLPMetadata = {
    raw_input: rawInput ?? parsed.title,
    source: CaptureSource.TEXT,
    extracted: parsed.meta.extracted,
    confidence: 1.0,
    parser_version: "1.0.0",
  };

  return createEntity("tasks", {
    user_id: null,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: parsed.title,
    description: "",
    status: TaskStatus.PENDING,
    priority: parsed.priority,
    labels: parsed.labels,
    due,
    energy_required: EnergyLevel.MEDIUM,
    estimated_minutes: null,
    actual_focus_seconds: 0,
    season_id: null,
    child_order: 0,
    completion_count: 0,
    last_completed_at: null,
    nlp,
  });
}

/**
 * Client-side mirror of `services/tasks.py::complete_task` (ARCHITECTURE.md
 * §4.5, v1.1 canonical resolutions): if the task's recurrence yields a next
 * date, roll it forward and keep it pending; otherwise mark it completed.
 * Returns the updated task, or `null` if the task doesn't exist locally
 * (already deleted, or never synced).
 *
 * Kept step-for-step symmetric with the server's `complete_task` (the two must
 * agree — that symmetry is the convergence guarantee). Corrected in T7 to match
 * the server after the v1.1 clarification:
 *  - `anchor=COMPLETED` steps once from the COMPLETION date (today), not from
 *    the current `due.date` (server passes `after=now.date()`).
 *  - `count` is enforced by THIS caller for BOTH anchors, checked AFTER
 *    incrementing, via `completion_count >= rule.count`. `compute_next` can't
 *    track the series total once `due.date` has been rolled forward and passed
 *    back as `base`, so `completion_count` is the durable per-series counter
 *    (ARCHITECTURE §4.3, and see the server's `complete_task` comment).
 *  - `completion_count` bumps on the final completion too (when the series
 *    ends), matching the server patch.
 */
export async function completeTask(id: string): Promise<Task | null> {
  const existing = await db.tasks.get(id);
  if (!existing || existing.deleted_at) return null;

  // Full datetime (not date-only) — matches `last_completed_at`'s
  // `ISODateTimeString` type. Named `now`, not `nowIso`, to avoid reading
  // like the date-only `nowIso` convention used in lib/nlp/parser.ts and
  // lib/recurrence/next.ts for a different purpose.
  const now = utcNowISO();
  const due = existing.due;
  const rule = due?.recurrence ?? null;

  if (!due || !rule) {
    // Non-recurring: a single completion. The server does NOT bump
    // completion_count here, so neither do we.
    await updateEntity("tasks", id, {
      status: TaskStatus.COMPLETED,
      last_completed_at: now,
    });
    // More specific than the `task.updated` that `updateEntity` already
    // emitted — subscribers that only care about completion (e.g. the
    // daily-review tally) don't need to inspect `fields` to find it.
    bus.emit("task.completed", { task_id: id });
    return (await db.tasks.get(id)) ?? null;
  }

  // Recurring — mirror the server (services/tasks.py::complete_task).
  const nextCompletionCount = existing.completion_count + 1;
  const base = due.date; // the pattern-conforming current due date
  let nextDate: ISODateString | null =
    rule.anchor === RecurrenceAnchor.COMPLETED
      ? // Step once forward from the completion date (today, UTC) — §4.5.
        computeNext(rule, dateToISODate(new Date()), base)
      : // anchor=SCHEDULED: step from the current due date; `until` is enforced
        // inside computeNext, `count` by the check just below.
        computeNext(rule, base, base);

  // v1.1: `count` enforced by the caller for BOTH anchors, checked AFTER
  // incrementing completion_count → `completion_count >= count` ends the series.
  if (rule.count !== null && nextCompletionCount >= rule.count) {
    nextDate = null;
  }

  if (nextDate) {
    // Rolls forward — the task isn't "done", it's rescheduled. `updateEntity`
    // already emits `task.updated`, so no extra emission is needed here.
    await updateEntity("tasks", id, {
      status: TaskStatus.PENDING,
      due: { ...due, date: nextDate },
      completion_count: nextCompletionCount,
      last_completed_at: now,
    });
  } else {
    // Series ends: complete it, but still advance the completions tally (the
    // server includes completion_count in this patch too).
    await updateEntity("tasks", id, {
      status: TaskStatus.COMPLETED,
      completion_count: nextCompletionCount,
      last_completed_at: now,
    });
    bus.emit("task.completed", { task_id: id });
  }

  return (await db.tasks.get(id)) ?? null;
}
