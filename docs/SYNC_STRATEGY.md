# FocusEngine — Local-First Sync Architecture (Deliverable 4)

**Status:** v1.0 · 2026-07-12 · Authored by the project architect. Binding blueprint for `app/services/sync.py`, `app/routers/sync.py`, `src/lib/sync/*`, and `src/lib/db/repository.ts`.

---

## 1. Principles & Topology

- **Client is the source of truth.** Dexie/IndexedDB serves every read and accepts every write instantly — zero network on the interaction path. The FastAPI/SQLite backend is a **sync relay and durability layer**, not a gatekeeper.
- **Operation-based sync.** We replicate *operations* (an oplog), not table snapshots. Ops are small, idempotent, and totally ordered per server (`server_seq`) while remaining causally comparable across devices (HLC).
- **Convergence guarantee.** Both sides apply the *same deterministic merge function* (§5) to the same ops, so all replicas converge regardless of arrival order.
- Works with 0..N devices; the degenerate offline-forever case is fully functional.

```
Device A (Dexie + _oplog) ──push──▶
                                    FastAPI ── SQLite (entity tables + ServerOplog, server_seq)
Device B (Dexie + _oplog) ◀──pull──
```

## 2. Identity & Clocks

- **Entity ids:** client-generated uuid4 strings → no id coordination, offline creates are safe.
- **Device id:** uuid4 minted on first launch, persisted in `_meta.device_id`. The server uses the reserved device id `"server"` for server-originated mutations (recurrence rolls, focus-time credits) — these enter the same oplog and flow down to clients like any other device's ops.
- **Hybrid Logical Clock (HLC)** per device, persisted in `_meta.hlc_last` (client) / in-process (server). String format (identical in `hlc.ts` and `hlc.py`):

```
"{unix_ms:013d}-{counter:04x}-{device8}"      e.g. "1783958400123-0003-9f3a1c2b"
```

Zero-padding makes **lexicographic order = causal order**; ties break by counter then device id. Rules:
- `tick()` (before stamping a local op): `ms = max(wall_ms, last_ms)`; if equal to `last_ms`, `counter += 1` else `counter = 0`.
- `receive(remote)` (on applying a pulled op): adopt `max(local, remote, wall)` per HLC algorithm, capping forward adoption of a remote physical time at `wall + 5min` (clock-skew guard — a device with a wildly wrong clock can't drag everyone's clocks forward).

## 3. Change Capture (client) — the change log & tombstones

Every local mutation goes through the repository (`lib/db/repository.ts`), which performs **one atomic Dexie transaction** across the entity table and `_oplog`:

1. Apply the change to the entity row; for each touched field set `field_hlcs[field] = hlc`.
2. Append `_oplog` row: `{seq: auto, op_id: "{hlc}:{entity}:{entity_id}", entity, entity_id, op, patch, hlc, device_id, pushed: 0}`.

Op shapes: `create` → `patch` = full document; `update` → `patch` = **changed fields only** (sparse); `delete` → `patch = null` and the entity row gets `deleted_at` (a **tombstone** — the row is kept so the deletion can replicate; UI queries always filter `deleted_at == null`). The delete's HLC is recorded in `field_hlcs["__deleted__"]`.

Because entity write + oplog append share a transaction, a crash can never produce a change that sync silently misses.

## 4. Transport Protocol (opportunistic, bi-directional)

`SyncEngine` (`lib/sync/engine.ts`) runs `syncOnce()` on: app start, every 15 s while online, on `window.online`, and after local bursts (debounced). Push then pull, both cheap no-ops when nothing changed. Exponential backoff (max 5 min) on failure; `navigator.onLine=false` short-circuits. Emits `sync.started/completed/failed` on the client bus.

**Push** — `POST /sync/push` with up to 500 unpushed `_oplog` rows ordered by `seq`:
`PushRequest {device_id, ops[], last_server_seq}` → server applies each op through the merge (§5), appends accepted ops to `ServerOplog` (allocating `server_seq`), and answers `PushResponse {applied: [op_id], skipped: [op_id], server_seq}`. Client marks both `applied` and `skipped` rows `pushed=1` (skipped = duplicate/stale — success by idempotency, never retried).

**Pull** — `GET /sync/pull?since={last_server_seq}&device_id={me}&limit=500` →
`PullResponse {ops: ServerOp[], next_seq, has_more}` where ops satisfy `server_seq > since AND device_id != me` (**echo suppression** — a device never re-applies its own ops). Client applies each through the same merge into Dexie (repository *bypasses* oplog-append for remote ops — remote ops are already in the server log), then persists `_meta.last_server_seq = next_seq`; loops while `has_more`.

**Ordering:** push-then-pull in one cycle guarantees a device observes its own writes' effects plus everything the server knew, within one round trip.

## 5. Merge & Conflict Resolution — deterministic field-level LWW

Implemented identically in `app/services/sync.py::apply_op` (SQLAlchemy) and `lib/sync/engine.ts::applyRemoteOp` (Dexie). For an incoming op:

```
1. Idempotency: if op_id already seen (ServerOplog unique index / client: hlc <= field_hlcs) → skip.
2. Strip DERIVED_FIELDS for the entity (task.actual_focus_seconds) from patch.        # §6
3. CREATE  : row absent → insert whole doc, field_hlcs = {f: hlc for f in patch}.
             row exists → downgrade to UPDATE (same doc, field-by-field).
4. UPDATE  : for each (field, value) in patch:
                 if hlc > field_hlcs.get(field, "")  → apply value, field_hlcs[field] = hlc
                 else                                → lose (stale write)
             if hlc > field_hlcs.get("__deleted__", "") and row was tombstoned → clear deleted_at   # resurrection
             updated_hlc = max(updated_hlc, hlc)
5. DELETE  : if hlc > every field_hlc on the row → set deleted_at, field_hlcs["__deleted__"] = hlc
             else → skip (a causally-later edit already beat the delete → the edit wins, row survives)
6. Server only: recompute derived fields if op.entity == focus_session touching work_seconds;
   append accepted op to ServerOplog → allocates server_seq.
```

Properties: **commutative + idempotent per field** (max-HLC wins), so replicas converge under any interleaving. Concurrent edits to *different* fields of the same task both survive (field granularity, not row). Concurrent edits to the *same* field: highest HLC wins everywhere — deterministic, no user prompt (right trade-off for task metadata; see §10 for the CRDT upgrade path for long text).

**Delete vs. edit:** delete wins only over ops it causally dominates. An offline edit made after (HLC-later than) a delete resurrects the task — matching user intuition that the most recent intent wins.

## 6. Derived Fields — why focus time can't be LWW

`task.actual_focus_seconds` is additive across devices; two devices LWW-ing totals would drop time. Therefore:
- Focus **sessions/segments are append-only facts** owned by the device that ran them → conflict-free by construction.
- Server strips `actual_focus_seconds` from any incoming task patch (`DERIVED_FIELDS`) and recomputes `SUM(focus_sessions.work_seconds) WHERE task_id` whenever a session op lands; the refreshed value is written with a `"server"`-device op so clients receive it on pull.
- Live crediting during a session: `FocusController → SqlTaskTimeSink` does an **atomic SQL increment** (`SET actual_focus_seconds = actual_focus_seconds + :delta … RETURNING`) — no read-modify-write race — then oplogs the new value.

## 7. Bootstrap, Recovery, Migrations

- **First sync / lost cursor:** `GET /sync/bootstrap` returns a full snapshot of all live + tombstoned rows and the current `server_seq`; the client loads tables wholesale and sets its cursor. Triggered when the client has no `last_server_seq` or the server responds that the requested `since` predates the compaction horizon (§8).
- **Schema migrations:** Dexie `version(n).upgrade()` on the client, SQLAlchemy `create_all` (MVP; Alembic when auth lands) on the server. Sync payloads are tolerant: unknown patch fields are ignored with a warning (forward compatibility), missing fields simply aren't merged.
- **Crash safety:** client — oplog transactionality (§3); server — each op application + oplog append is one DB transaction.

## 8. Compaction & Tombstone GC

Oplog and tombstones grow forever if unmanaged. Policy (documented now, `TODO` job later):
- **Tombstone GC:** hard-delete rows where `deleted_at < now − 30 days` **and** every known device cursor has passed the delete's `server_seq` (single-user MVP: server tracks per-device cursors from pull requests in memory/table).
- **Oplog compaction:** ops with `server_seq` older than the min device cursor − safety window collapse into the snapshot (bootstrap already serves state, so old ops are only needed for lagging devices → answer their pull with `snapshot_required` and let them re-bootstrap).
- Client `_oplog` rows with `pushed=1` are pruned after 7 days (kept briefly for debugging).

## 9. Failure-Mode Walkthroughs

| Scenario | Outcome |
|---|---|
| Offline for a week, 200 edits | All ops queue in `_oplog`; on reconnect one push batch + pulls; merge is order-insensitive → converges. |
| Laptop renames task title while phone (offline) changes its priority | Different fields → both survive on every replica. |
| Both devices edit the title | Higher HLC (later real intent, modulo skew ≤ counter tiebreak) wins identically everywhere. |
| Phone deletes task; laptop (offline) keeps editing it, syncs later | Laptop's edits carry later HLCs → resurrection (edit wins). Reverse order (edit first, delete last) → delete wins. |
| Push response lost mid-flight | Client retries same ops; `op_id` idempotency → server answers `skipped`, client marks pushed. No duplicates. |
| Device clock 3 days fast | Its ops win same-field conflicts (accepted trade-off), but HLC `receive` cap stops clock poisoning of other devices; monotonic counters keep ordering sane. |
| Two devices run focus sessions on the same task simultaneously | Sessions are separate append-only rows; server sums → total is exact, nothing lost. |

## 10. Evolution Path

1. **Auth & multi-user:** scope every table + oplog by `user_id`; cursors become (user, device); bootstrap filters by user. Contract already carries `user_id`.
2. **Text CRDT:** if collaborative long-form `description` editing arrives, upgrade that one field from LWW to a Peritext/Yjs-style CRDT — the op envelope (`SyncOp.patch`) already accommodates per-field payload types.
3. **Realtime push:** replace 15 s polling with the existing WS channel notifying "new server_seq" → clients pull immediately.
4. **E2E encryption:** ops are opaque blobs to the server except entity/id/hlc routing metadata — the merge would move fully client-side with server as ordered blob log.
