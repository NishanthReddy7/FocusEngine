/**
 * Client sync engine — SYNC_STRATEGY.md §4 (transport) and §5 (merge). Push
 * then pull on a timer/backoff loop; `applyRemoteOp` is the client half of
 * the deterministic merge — `app/services/sync.py::apply_op` is meant to be
 * its exact server-side twin. Neither side special-cases entity types beyond
 * stripping derived fields, which is what lets one merge function serve
 * all 7 entity kinds identically.
 *
 * Fully offline-safe: every network call is wrapped so a fetch failure (or
 * `navigator.onLine === false`) is a silent no-op from the caller's
 * perspective — it only surfaces as a `sync.failed` bus event, never a thrown
 * exception that could disrupt the rest of the app.
 */
import { EntityType, SyncOpType } from "@focusengine/schemas/enums";
import { DERIVED_FIELDS } from "@focusengine/schemas/sync";
import type { PullResponse, PushRequest, PushResponse, ServerOp } from "@focusengine/schemas/sync";
import { bus } from "../events/bus";
import { parseHlc } from "./hlc";
import { authHeader, getAuthToken, onAuthTokenChange, setAuthToken, wsTokenParam } from "../auth/token";
import { isForeground, isMobileFlavor, onForegroundChange } from "../platform";
import type { EntityRowMap, EntityTableName } from "../db/schema";
import {
  ENTITY_TYPE_TO_TABLE,
  applyRemoteWrite,
  bulkPutSnapshot,
  getDeviceId,
  getLastServerSeq,
  getUnpushedOps,
  markOpsPushed,
  setLastServerSeq,
} from "../db/repository";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws"); // http→ws, https→wss (A2 WS transport)

// Polling cadence (A5): the WS push is the fast path; the timer is the
// fallback + baseline. 5s while the web tab is visible, 60s when hidden; the
// mobile flavor foregrounds at 3s (user requirement). `isForeground()` is the
// platform seam (visibilitychange proxy today, Capacitor App-state in V2-D).
const VISIBLE_INTERVAL_MS = 5_000;
const HIDDEN_INTERVAL_MS = 60_000;
const MOBILE_FOREGROUND_INTERVAL_MS = 3_000;

const BACKOFF_START_MS = 5_000; // first-failure backoff seed
const MAX_BACKOFF_MS = 5 * 60 * 1000; // "exponential backoff (max 5 min) on failure"
const DEBOUNCE_MS = 2_000; // "after local bursts (debounced)"
const PUSH_BATCH_LIMIT = 500;
const PULL_PAGE_LIMIT = 500;

/** Thrown when the API returns 401 — the JWT expired or was revoked. Handled
 *  distinctly from a transient network error: it stops the engine and asks the
 *  user to re-authenticate rather than retrying with backoff (A2/A5). */
class SyncAuthError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "SyncAuthError";
  }
}

/** A 401 is auth-fatal; any other non-2xx is a normal transport failure. */
function assertAuthorized(response: Response, context: string): void {
  if (response.status === 401) throw new SyncAuthError();
  if (!response.ok) throw new Error(`sync ${context} failed: HTTP ${response.status}`);
}

/** `user_id` never lives in Dexie (A3 — "a device's DB belongs to whoever is
 *  signed in; the JWT derives it"). Strip it from any patch/row that crosses
 *  in from the server, and from outgoing op patches (the server scopes by JWT,
 *  not by a client-sent id). */
function withoutUserId(patch: Record<string, unknown>): Record<string, unknown> {
  if (!("user_id" in patch)) return patch;
  const rest = { ...patch };
  delete rest.user_id;
  return rest;
}

/** Bootstrap/snapshot rows for `tasks` include a server `user_id`; normalize it
 *  to null so the local row matches everything `createTaskFromParse` writes
 *  (A3). Non-task tables have no such field and pass through untouched. */
function normalizeSnapshotRow<E extends EntityTableName>(row: EntityRowMap[E]): EntityRowMap[E] {
  if (row && typeof row === "object" && "user_id" in row) {
    return { ...(row as unknown as Record<string, unknown>), user_id: null } as unknown as EntityRowMap[E];
  }
  return row;
}

const BURST_EVENTS = ["task.created", "task.updated", "task.completed", "task.deleted"] as const;

const BOOTSTRAP_TABLES: readonly EntityTableName[] = [
  "tasks",
  "projects",
  "sections",
  "visions",
  "seasons",
  "focus_sessions",
  "daily_reviews",
];

type BootstrapSnapshot = Record<EntityTableName, unknown[]> & { server_seq: number };

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// ---------------------------------------------------------------------------
// SYNC_STRATEGY.md §5 — deterministic field-level LWW merge. Implemented
// identically to (and meant to converge with) the server's
// `app/services/sync.py::apply_op`; step numbers in comments match §5 exactly.
// ---------------------------------------------------------------------------

function stripDerivedFields(entity: EntityType, patch: Record<string, unknown> | null): Record<string, unknown> {
  // 2. Strip DERIVED_FIELDS for the entity (task.actual_focus_seconds) from
  //    patch (SYNC_STRATEGY.md §5 step 2 / §6 — additive facts recomputed
  //    server-side, never client-LWW-merged).
  if (!patch) return {};
  const derived = DERIVED_FIELDS[entity] ?? [];
  if (derived.length === 0) return patch;
  const stripped = { ...patch };
  for (const field of derived) delete stripped[field];
  return stripped;
}

/** Wall-clock estimate for a tombstone's `deleted_at`: the HLC's physical-time
 *  component (its leading unix-ms segment) approximates "when this op
 *  happened" on the originating device — SYNC §5 step 5 says to "set
 *  deleted_at" without specifying its value, since DELETE ops carry no patch
 *  to source one from. */
function hlcToISODateTime(hlc: string): string {
  return new Date(parseHlc(hlc).ms).toISOString();
}

/**
 * CREATE and UPDATE share one code path: a CREATE for a row that already
 * exists locally "downgrades to UPDATE (same doc, field-by-field)" per step 3,
 * which is exactly the step-4 per-field comparison below.
 */
function mergeCreateOrUpdate(
  op: ServerOp,
  patch: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> | "skip" {
  if (!existing) {
    // 3. CREATE, row absent: insert whole doc, field_hlcs = {f: hlc for f in patch}.
    if (op.op !== SyncOpType.CREATE) {
      // An UPDATE/DELETE naming a row this device has never seen. Not an
      // explicitly spec'd case (bootstrap/pull ordering should prevent it);
      // skip rather than fabricate a row from a sparse patch.
      return "skip";
    }
    const fieldHlcs: Record<string, string> = {};
    for (const key of Object.keys(patch)) fieldHlcs[key] = op.hlc;
    // entity_id is authoritative for the primary key (mirrors the server's
    // `_insert_fresh`, which always uses entity_id over any patch `id`) — a
    // row constructed without a guaranteed `id` throws IDB DataError on
    // put() and aborts the whole pull loop.
    return { ...patch, id: op.entity_id, field_hlcs: fieldHlcs };
  }

  // 3. CREATE, row exists: downgrade to UPDATE (same doc, field-by-field) —
  //    falls straight into the step-4 loop below, no special-casing needed.
  // 4. UPDATE: for each (field, value) in patch:
  //      if hlc > field_hlcs.get(field, "") -> apply value, field_hlcs[field] = hlc
  //      else                               -> lose (stale write)
  const fieldHlcs: Record<string, string> = { ...(existing.field_hlcs as Record<string, string>) };
  const merged: Record<string, unknown> = { ...existing };
  let changed = false;

  for (const [field, value] of Object.entries(patch)) {
    const currentFieldHlc = fieldHlcs[field] ?? "";
    if (op.hlc > currentFieldHlc) {
      merged[field] = value;
      fieldHlcs[field] = op.hlc;
      changed = true;
    }
    // else: lose (stale write) — field left untouched.
  }

  // 4. "if hlc > field_hlcs.get('__deleted__', '') and row was tombstoned ->
  //     clear deleted_at" (resurrection). Checked against `existing` (the
  //     row's state before this op), not `merged` — the patch loop above
  //     never touches `deleted_at` itself (deletes are separate DELETE ops).
  const wasTombstoned = existing.deleted_at !== null && existing.deleted_at !== undefined;
  const deletedHlc = fieldHlcs["__deleted__"] ?? "";
  if (wasTombstoned && op.hlc > deletedHlc) {
    merged.deleted_at = null;
    changed = true;
  }

  if (!changed) return "skip"; // every field lost — nothing to write

  // 4. "updated_hlc = max(updated_hlc, hlc)"
  const existingUpdatedHlc = (existing.updated_hlc as string | undefined) ?? "";
  merged.updated_hlc = op.hlc > existingUpdatedHlc ? op.hlc : existingUpdatedHlc;
  merged.field_hlcs = fieldHlcs;
  return merged;
}

function mergeDelete(
  op: ServerOp,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> | "skip" {
  if (!existing) return "skip"; // nothing locally to delete

  // 5. DELETE: if hlc > every field_hlc on the row -> set deleted_at,
  //    field_hlcs["__deleted__"] = hlc; else -> skip (a causally-later edit
  //    already beat the delete -> the edit wins, row survives).
  const fieldHlcs = existing.field_hlcs as Record<string, string>;
  const beatsEverything = Object.values(fieldHlcs).every((h) => op.hlc > h);
  if (!beatsEverything) return "skip";

  return {
    ...existing,
    deleted_at: hlcToISODateTime(op.hlc),
    field_hlcs: { ...fieldHlcs, __deleted__: op.hlc },
  };
}

/**
 * Client half of SYNC_STRATEGY.md §5. The server's `apply_op` is its twin —
 * both must make the same accept/reject decision for the same op so replicas
 * converge regardless of arrival order (the whole point of this function).
 */
export async function applyRemoteOp(op: ServerOp): Promise<void> {
  const table = ENTITY_TYPE_TO_TABLE[op.entity];
  // 2. Strip DERIVED_FIELDS — except from server-authored ops (device_id ===
  //    "server"): the server's recompute of e.g. task.actual_focus_seconds is
  //    written as a device "server" op precisely so clients receive it on
  //    pull (SYNC_STRATEGY.md §6) — stripping it here would defeat that.
  // Strip derived fields (except from server-authored ops) and — defensively —
  // any `user_id` (pull ops carry none per the A3 contract, but never let one
  // into Dexie regardless).
  const patch = withoutUserId(
    op.device_id === "server" ? (op.patch ?? {}) : stripDerivedFields(op.entity, op.patch),
  );

  // 1. Idempotency + 2-5 merge, run atomically with §2 receive(). applyRemoteWrite
  //    opens one transaction spanning [entity table, _meta] that runs
  //    receiveRemoteHlc(op.hlc) — advance the local clock regardless of merge
  //    outcome — and the read → decide → put() together, so the whole
  //    read-modify-write is serialized by IndexedDB. Idempotency stays
  //    structural (the server keeps a seen-op_id index; the client has no
  //    separate store — replaying an already-applied op can never win the strict
  //    `hlc > field_hlcs[field]` comparisons in steps 3-5 a second time). The
  //    transaction adds the concurrency half: a *simultaneous* replay (or another
  //    tab) can't slip a stale read between our get() and put(), so it can never
  //    clobber a field this op just merged.
  await applyRemoteWrite(table, op.entity_id, op.hlc, (existing) => {
    const existingRecord = existing as unknown as Record<string, unknown> | undefined;
    const outcome =
      op.op === SyncOpType.DELETE
        ? mergeDelete(op, existingRecord) // step 5
        : mergeCreateOrUpdate(op, patch, existingRecord); // steps 3-4
    return outcome === "skip" ? "skip" : (outcome as unknown as EntityRowMap[typeof table]);
  });

  // 6. Server only (recompute derived fields, append to ServerOplog) — not
  //    applicable client-side; this function's server-side twin does that half.
}

// ---------------------------------------------------------------------------
// Transport — SYNC_STRATEGY.md §4.
// ---------------------------------------------------------------------------

async function pushOnce(): Promise<{ applied: number }> {
  const unpushed = await getUnpushedOps(PUSH_BATCH_LIMIT);
  if (unpushed.length === 0) return { applied: 0 };

  const deviceId = await getDeviceId();
  const lastServerSeq = await getLastServerSeq();
  const request: PushRequest = {
    device_id: deviceId,
    ops: unpushed.map((row) => ({
      op_id: row.op_id,
      entity: row.entity,
      entity_id: row.entity_id,
      op: row.op,
      // Outgoing patches drop `user_id`; the server scopes writes by the JWT.
      patch: row.patch ? withoutUserId(row.patch) : row.patch,
      hlc: row.hlc,
      device_id: row.device_id,
    })),
    last_server_seq: lastServerSeq,
  };

  const response = await fetch(`${API_BASE}/sync/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(request),
  });
  assertAuthorized(response, "push");

  const body = (await response.json()) as PushResponse;
  // Both `applied` and `skipped` mark pushed=1 — skipped is idempotent
  // success (stale/duplicate), never retried (SYNC_STRATEGY.md §4).
  await markOpsPushed([...body.applied, ...body.skipped]);
  return { applied: body.applied.length };
}

async function bootstrap(): Promise<number> {
  const response = await fetch(`${API_BASE}/sync/bootstrap`, { headers: { ...authHeader() } });
  assertAuthorized(response, "bootstrap");
  const snapshot = (await response.json()) as BootstrapSnapshot;

  let total = 0;
  for (const table of BOOTSTRAP_TABLES) {
    // Snapshot task rows carry a server `user_id`; normalize it out before it
    // lands in Dexie (A3).
    const rows = (snapshot[table] as EntityRowMap[typeof table][]).map(normalizeSnapshotRow);
    await bulkPutSnapshot(table, rows);
    total += rows.length;
  }
  await setLastServerSeq(snapshot.server_seq);
  return total;
}

async function pullLoop(): Promise<{ pulled: number }> {
  const deviceId = await getDeviceId();
  let cursor = await getLastServerSeq();

  if (cursor === 0) {
    // First sync / lost cursor -> full snapshot (SYNC_STRATEGY.md §7).
    return { pulled: await bootstrap() };
  }

  let totalPulled = 0;
  // "loops while has_more" (SYNC_STRATEGY.md §4).
  for (;;) {
    const url = `${API_BASE}/sync/pull?since=${cursor}&device_id=${encodeURIComponent(deviceId)}&limit=${PULL_PAGE_LIMIT}`;
    const response = await fetch(url, { headers: { ...authHeader() } });
    assertAuthorized(response, "pull");

    const body = (await response.json()) as PullResponse;
    for (const op of body.ops) {
      await applyRemoteOp(op);
    }
    totalPulled += body.ops.length;
    cursor = body.next_seq;
    await setLastServerSeq(cursor);
    if (!body.has_more) break;
  }
  return { pulled: totalPulled };
}

let backoffMs = 0; // 0 = healthy (use the visibility-aware cadence); >0 = backing off after a failure

/** On a 401: tell the app to re-authenticate and clear the token so the engine
 *  idles. `setAuthToken(null)` cascades through `onAuthTokenChange` (the WS
 *  disconnects); the auth provider's `auth.expired` subscriber clears
 *  `_meta.auth` and surfaces the message. */
function handleAuthExpired(): void {
  bus.emit("auth.expired", { message: "Session expired — sign in" });
  setAuthToken(null);
}

// Overlap guard (SYNC_STRATEGY.md §4). There are four independent triggers for
// a sync — the 15s timer, `window.online`, the debounced local-write burst, and
// a manual/immediate start — all of which land on this one entry point. Without
// a guard they overlap into concurrent push+pull cycles: duplicate `GET
// /sync/pull` swarms, and two pull loops racing the same read-modify-write
// merges. `syncInFlight` admits exactly one cycle at a time; a trigger that
// arrives mid-cycle sets `rerunRequested` and returns, coalescing into a single
// follow-up run (so a local write during a sync is never dropped — it still
// gets pushed on the immediately-following cycle) instead of a parallel loop.
let syncInFlight = false;
let rerunRequested = false;

/**
 * One push-then-pull cycle ("push then pull... guarantees a device observes
 * its own writes' effects plus everything the server knew, within one round
 * trip", SYNC_STRATEGY.md §4). Never throws — a failure is caught, backed
 * off, and reported only via the `sync.failed` bus event. Reentrant-safe: an
 * overlapping call is coalesced (see `syncInFlight`), never run concurrently.
 */
export async function syncOnce(): Promise<void> {
  if (!isOnline()) return; // "navigator.onLine=false short-circuits"
  if (!getAuthToken()) return; // signed out / local-only → engine idles (A2, no requests)

  if (syncInFlight) {
    // A cycle is already running — coalesce rather than start a second one.
    rerunRequested = true;
    return;
  }

  syncInFlight = true;
  try {
    do {
      rerunRequested = false;
      bus.emit("sync.started", {});
      try {
        const pushResult = await pushOnce();
        const pullResult = await pullLoop();
        backoffMs = 0; // healthy → back to the visibility-aware cadence
        bus.emit("sync.completed", { applied: pushResult.applied, pulled: pullResult.pulled });
      } catch (err) {
        if (err instanceof SyncAuthError) {
          // Auth-fatal (401): stop, don't retry — clear the token and ask for
          // re-auth. `finally` still resets `syncInFlight`.
          handleAuthExpired();
          return;
        }
        backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        bus.emit("sync.failed", { reason: err instanceof Error ? err.message : String(err) });
      }
      // A trigger that fired during the cycle above is serviced by exactly one
      // more pass (rerunRequested was reset at the top), never a parallel loop.
    } while (rerunRequested && isOnline() && getAuthToken() !== null);
  } finally {
    syncInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket sync-notify — A5. The server pushes {"server_seq": N} after any
// oplog append for this user; when N passes our cursor we sync immediately, so
// the polling timer below is only the fallback/baseline. Auto-reconnect with
// capped, jittered backoff mirrors useFocusTimer's pattern. The socket is
// (re)opened when a token appears and torn down on sign-out / engine stop.
// ---------------------------------------------------------------------------

let syncSocket: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsAttempt = 0;
let wsWanted = false; // true when we want a live socket (engine active + token present)

// 0.5x–1.0x of min(30s, 2^attempt s): capped, jittered so many tabs reconnecting
// after a server blip don't stampede it (same shape as useFocusTimer).
function wsBackoffDelay(): number {
  const ceil = Math.min(30_000, 1_000 * 2 ** wsAttempt);
  return ceil / 2 + Math.random() * (ceil / 2);
}

function scheduleWsReconnect(): void {
  if (!wsWanted || wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsAttempt += 1;
    openSyncSocket();
  }, wsBackoffDelay());
}

function openSyncSocket(): void {
  if (!wsWanted || typeof window === "undefined" || !getAuthToken()) return;
  if (syncSocket) return; // already connected/connecting
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${WS_BASE}/ws/sync${wsTokenParam()}`);
  } catch {
    scheduleWsReconnect();
    return;
  }
  syncSocket = socket;

  socket.onopen = () => {
    wsAttempt = 0; // healthy connection → reset backoff
  };
  socket.onclose = () => {
    if (syncSocket === socket) syncSocket = null;
    scheduleWsReconnect();
  };
  socket.onerror = () => {
    // onerror is normally followed by onclose (which reconnects); closing here
    // avoids leaking a half-open socket if it isn't.
    try {
      socket.close();
    } catch {
      // already closing/closed — nothing to do
    }
  };
  socket.onmessage = (event: MessageEvent) => {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data as string);
    } catch {
      return; // malformed frame — ignore, don't crash the handler
    }
    const seq = (payload as { server_seq?: unknown }).server_seq;
    if (typeof seq !== "number") return;
    // Only sync when the server actually advanced past our cursor (A5).
    void (async () => {
      if (seq > (await getLastServerSeq())) void syncOnce();
    })();
  };
}

function startSyncSocket(): void {
  wsWanted = true;
  wsAttempt = 0;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  openSyncSocket();
}

function stopSyncSocket(): void {
  wsWanted = false;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (syncSocket) {
    const socket = syncSocket;
    syncSocket = null;
    // Detach handlers so a close fired during teardown can't reschedule.
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler — app start, visibility-aware poll (A5) w/ backoff, window.online,
// debounced bursts, WS-notify, and auth-token changes. Signed out, syncOnce()
// is a no-op, so the timer idles harmlessly until a token arrives.
// ---------------------------------------------------------------------------

let timerHandle: ReturnType<typeof setTimeout> | null = null;
let debounceHandle: ReturnType<typeof setTimeout> | null = null;

// Idempotent start (SYNC_STRATEGY.md §4). All three route components mount the
// engine (app/, focus/, review/), and each mount/unmount cycle calls
// startSyncEngine again. `engineActive` gates the scheduler to a single running
// engine; `engineRefCount` keeps that one engine alive across overlapping
// callers so one route unmounting can't stop the loop another route still
// needs, and only the last outstanding cleanup actually tears it down. Without
// this, repeated starts each spawned their own timer + burst subscriptions —
// N parallel push+pull loops, the duplicate-pull swarm this fix removes.
let engineActive = false;
let engineRefCount = 0;
let stopEngine: (() => void) | null = null;

/** Delay before the next poll: the backoff interval while failing, else the
 *  visibility-aware cadence — 5s web-visible / 60s hidden / 3s mobile-foreground
 *  (A5). `isForeground()` is the platform seam. */
function nextDelay(): number {
  if (backoffMs > 0) return backoffMs;
  if (!isForeground()) return HIDDEN_INTERVAL_MS;
  return isMobileFlavor ? MOBILE_FOREGROUND_INTERVAL_MS : VISIBLE_INTERVAL_MS;
}

function scheduleNext(delayMs: number): void {
  if (!engineActive) return;
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = setTimeout(() => {
    void runAndReschedule();
  }, delayMs);
}

async function runAndReschedule(): Promise<void> {
  await syncOnce();
  scheduleNext(nextDelay());
}

function scheduleDebouncedSync(): void {
  if (debounceHandle) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    debounceHandle = null;
    void syncOnce();
  }, DEBOUNCE_MS);
}

/**
 * Starts the sync loop: an immediate run (app start), a visibility-aware
 * poll (A5) with failure backoff, a `window.online` trigger, a debounced
 * trigger after local write bursts, the `/ws/sync` notify socket, and an
 * auth-token subscription that connects/idles the engine on sign-in/out.
 * Idempotent: every caller attaches to the ONE shared engine (ref-counted)
 * rather than spawning a parallel loop, so it is safe no matter how many
 * routes mount it. Returns a per-caller cleanup (call it on unmount); only the
 * last outstanding cleanup stops the engine. No-op (and returns a no-op
 * cleanup) during SSR, where there is no `window`/IndexedDB.
 */
export function startSyncEngine(): () => void {
  if (typeof window === "undefined") return () => {};

  engineRefCount += 1;
  if (engineRefCount === 1) {
    // First caller boots the single shared engine.
    engineActive = true;
    backoffMs = 0;

    const onOnline = () => void syncOnce();
    window.addEventListener("online", onOnline);

    const unsubscribers = BURST_EVENTS.map((type) => bus.on(type, () => scheduleDebouncedSync()));

    // Sign-in / sign-out: (re)connect the notify socket + kick a sync when a
    // token appears; disconnect + idle when it clears (A2/A5).
    const offAuth = onAuthTokenChange((token) => {
      if (!engineActive) return;
      if (token) {
        startSyncSocket();
        void syncOnce();
      } else {
        stopSyncSocket();
      }
    });

    // Re-pace to the current cadence on a visibility change, and sync at once
    // when returning to the foreground so hidden→visible feels fresh (A5).
    const offForeground = onForegroundChange((foreground) => {
      if (foreground) void syncOnce();
      scheduleNext(nextDelay());
    });

    // If already signed in when the engine boots, open the socket now.
    if (getAuthToken()) startSyncSocket();

    void runAndReschedule(); // app start

    stopEngine = () => {
      engineActive = false;
      if (timerHandle) clearTimeout(timerHandle);
      if (debounceHandle) clearTimeout(debounceHandle);
      timerHandle = null;
      debounceHandle = null;
      window.removeEventListener("online", onOnline);
      for (const unsubscribe of unsubscribers) unsubscribe();
      offAuth();
      offForeground();
      stopSyncSocket();
    };
  }

  // Per-caller cleanup: idempotent (guards its own double-invoke, e.g. React
  // StrictMode) and decrements the shared refcount; the engine is torn down
  // only when the last caller releases it.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    engineRefCount -= 1;
    if (engineRefCount === 0 && stopEngine) {
      stopEngine();
      stopEngine = null;
    }
  };
}
