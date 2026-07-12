/**
 * Cold-start-resilient auth exchange — V2-G (Fixes A + B). The deployed backend
 * runs on Render's free tier: it SLEEPS after ~15 min idle and takes 30–60s to
 * wake, and while waking its edge rejects requests WITHOUT CORS headers, so a
 * browser `fetch` fails with the generic, useless "Failed to fetch". A naive
 * `POST /auth/google` against a cold server therefore looks like a silent
 * sign-in failure (the original bug #1).
 *
 * This module makes sign-in survive the cold start:
 *   1. {@link wakeAndExchange} first WAKES the server — `GET /health` on a
 *      capped retry/backoff ladder (2·4·8·15·15… ≈ 90s) until it answers 200 —
 *      reporting a {@link WakePhase} so the button can say "Connecting…" then
 *      "Waking the sync server…". Only THEN does it exchange the held Google
 *      credential for our JWT, retrying the POST on transient network errors.
 *   2. {@link prewarmApi} is a fire-and-forget `GET /health` on app load so the
 *      server is already awake by the time the user reaches sign-in or sync.
 *
 * Every failure path resolves to a designed, human message
 * ({@link WAKE_ERROR_MESSAGE}) — a raw "Failed to fetch" must never reach the UI
 * (DESIGN_SPEC §9).
 */
import type { AuthResponse } from "@focusengine/schemas/auth";
import { exchangeGoogleCredential, GoogleAuthUnavailableError } from "./google";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const HEALTH_URL = `${API_BASE}/health`;

/** Which line the working button shows. `connecting` for the first few seconds,
 *  then `waking` once we're clearly waiting on a cold server (Fix A). */
export type WakePhase = "connecting" | "waking";

/** The single designed inline message for an ultimately-failed sign-in — shown
 *  under the button with a Retry, never as a floating raw error (Fix A/C, §9). */
export const WAKE_ERROR_MESSAGE =
  "The sync server is waking up — this can take a minute on the free tier. Try again.";

/** Raised when the wake/exchange flow ultimately fails (server never woke, or
 *  the credential exchange kept failing). Always carries {@link WAKE_ERROR_MESSAGE}
 *  so callers can render it verbatim without ever exposing a raw fetch error. */
export class SignInWakeError extends Error {
  constructor(message: string = WAKE_ERROR_MESSAGE) {
    super(message);
    this.name = "SignInWakeError";
  }
}

// Backoff between `/health` probes (ms): quick at first, then a steady 15s.
// Sum ≈ 2+4+8+15+15+15+15+15 = 89s, so the ladder spans ~90s of wake budget.
const HEALTH_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000] as const;
/** Total time to spend trying to wake the server before giving up. Overridable
 *  via `NEXT_PUBLIC_WAKE_MAX_MS` for local verification only (defaults to 90s). */
const WAKE_MAX_MS = Number(process.env.NEXT_PUBLIC_WAKE_MAX_MS) || 90_000;
/** Switch the button copy "Connecting…" → "Waking the sync server…" after this. */
const WAKING_COPY_AFTER_MS = 4_000;
/** Retry the credential exchange this many times on a transient network error. */
const EXCHANGE_NETWORK_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `GET /health`. Returns true only on a real 200. A cold Render server
 *  fails the fetch entirely (no CORS on the edge error) — caught here as "not
 *  awake yet", never surfaced as a raw error. */
async function probeHealth(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { method: "GET", cache: "no-store" });
    return res.ok;
  } catch {
    return false; // cold start / offline — keep waiting
  }
}

/** Poll `/health` on the backoff ladder until it answers 200 or the wake budget
 *  is spent. Reports `connecting`, then `waking` after ~4s so the button copy
 *  tracks reality. Throws {@link SignInWakeError} if the server never wakes. */
async function waitForHealth(onPhase?: (phase: WakePhase) => void): Promise<void> {
  const start = Date.now();
  onPhase?.("connecting");
  const wakingTimer = setTimeout(() => onPhase?.("waking"), WAKING_COPY_AFTER_MS);
  try {
    for (let i = 0; ; i += 1) {
      if (await probeHealth()) return;
      if (Date.now() - start >= WAKE_MAX_MS) throw new SignInWakeError();
      await sleep(HEALTH_BACKOFF_MS[Math.min(i, HEALTH_BACKOFF_MS.length - 1)]!);
      if (Date.now() - start >= WAKE_MAX_MS) throw new SignInWakeError();
    }
  } finally {
    clearTimeout(wakingTimer);
  }
}

/**
 * Exchange the held Google credential for our JWT, retrying only on transient
 * network errors (a cold server that dropped the POST despite the health probe
 * passing). A 503 means the server has no Google client configured — a
 * local-only signal ({@link GoogleAuthUnavailableError}), propagated as-is. Any
 * other failure becomes a {@link SignInWakeError} so the UI shows designed copy.
 */
async function exchangeWithRetry(googleIdToken: string): Promise<AuthResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await exchangeGoogleCredential(googleIdToken);
    } catch (err) {
      if (err instanceof GoogleAuthUnavailableError) throw err; // 503 → stay local-only
      // `fetch` rejects with a TypeError on a network/CORS failure; that is the
      // only case worth retrying. A real HTTP error (bad token, 500) is final.
      const transient = err instanceof TypeError;
      if (transient && attempt < EXCHANGE_NETWORK_RETRIES) {
        await sleep(1_000);
        continue;
      }
      throw new SignInWakeError();
    }
  }
}

/**
 * The full cold-start-resilient sign-in exchange (Fix A): wake the server, then
 * exchange the credential. `onPhase` drives the button's working copy. Resolves
 * with our session on success; throws {@link GoogleAuthUnavailableError} (server
 * unconfigured → local-only) or {@link SignInWakeError} (designed failure copy)
 * — never a raw fetch error.
 */
export async function wakeAndExchange(
  googleIdToken: string,
  opts: { onPhase?: (phase: WakePhase) => void } = {},
): Promise<AuthResponse> {
  await waitForHealth(opts.onPhase);
  return exchangeWithRetry(googleIdToken);
}

// ---------------------------------------------------------------------------
// Fix B — app-load pre-warm.
// ---------------------------------------------------------------------------

let prewarmed = false;

/**
 * Fire-and-forget `GET /health` once on app mount to wake Render while the user
 * works locally, so sign-in and sync are warm by the time they're used (Fix B).
 * Only runs when `NEXT_PUBLIC_API_BASE_URL` is explicitly configured (there's no
 * point pinging the dev default), fires at most once per page load, and is
 * entirely silent — no UI, no error surface on failure.
 */
export function prewarmApi(): void {
  if (prewarmed) return;
  if (typeof window === "undefined") return;
  if (!process.env.NEXT_PUBLIC_API_BASE_URL) return;
  prewarmed = true;
  void fetch(HEALTH_URL, { method: "GET", cache: "no-store" }).catch(() => {
    // Silent by contract — waking is best-effort; sign-in/sync retry on their own.
  });
}
