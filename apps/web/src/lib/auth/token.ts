/**
 * In-memory JWT holder — V2-C (A2). One process-wide source of truth for the
 * current bearer token so every network caller (the sync engine, the focus
 * timer hook, the check-in POST) attaches the SAME `Authorization` header and
 * the SAME websocket `?token=` param without each re-reading Dexie.
 *
 * The auth provider (`lib/auth/provider.tsx`) owns the token's lifecycle and is
 * the only writer: it calls {@link setAuthToken} after restoring `_meta.auth`
 * on load, after a sign-in exchange, and (with `null`) on sign-out. The sync
 * engine subscribes via {@link onAuthTokenChange} to (re)connect its websocket
 * and kick an immediate sync when a token appears, or idle when it clears.
 *
 * Deliberately dependency-free (no React, no Dexie) so it sits below both the
 * engine and the provider in the import graph with no cycles.
 */

let currentToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

/** The current JWT, or null when signed out / local-only. Read at call time by
 *  every REST caller so a mid-flight token change is picked up on the next
 *  request. */
export function getAuthToken(): string | null {
  return currentToken;
}

/** Sets the token and notifies subscribers. A no-op when the value is
 *  unchanged, so the provider can call it idempotently on every auth state
 *  reconciliation without churning the engine's websocket. */
export function setAuthToken(token: string | null): void {
  if (token === currentToken) return;
  currentToken = token;
  for (const listener of Array.from(listeners)) listener(token);
}

/** Subscribe to token changes (sign-in / sign-out / 401 clear). Returns an
 *  unsubscribe. */
export function onAuthTokenChange(handler: (token: string | null) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** `Authorization` header for REST — empty object when signed out, so a
 *  local-only build sends no auth header at all. Spread into a request's
 *  `headers`. */
export function authHeader(): Record<string, string> {
  return currentToken ? { Authorization: `Bearer ${currentToken}` } : {};
}

/** Websocket `?token=` query suffix (A2: "WebSockets take `?token=`"), or an
 *  empty string when signed out. */
export function wsTokenParam(): string {
  return currentToken ? `?token=${encodeURIComponent(currentToken)}` : "";
}
