/**
 * Claim-local-data (A2) — the auth-facing entry point for the first sign-in on
 * a device that already holds locally-created data. It guarantees every local
 * row is queued to push to the newly-signed-in account; the actual replay to
 * the server happens on the sync engine's next cycle (kicked when the provider
 * sets the token).
 *
 * The Dexie/oplog/HLC work lives in `lib/db/repository.ts::claimLocalData`
 * (that module owns those invariants — "no other module writes Dexie
 * directly"); this file is the thin orchestration seam the auth provider calls,
 * so the provider depends on `lib/auth/*` rather than reaching into the
 * repository for a sync concern.
 */
import { claimLocalData as stageLocalRowsForPush } from "../db/repository";

/**
 * Stage all un-queued local rows for push to the new account (A2). Returns the
 * number of rows freshly staged — 0 in the common pure-local case, where every
 * row already carries an unpushed CREATE and simply flows on the next push.
 */
export async function claimLocalData(): Promise<number> {
  return stageLocalRowsForPush();
}
