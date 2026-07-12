/**
 * Platform flavor + native app-state injection point — V2-C (A6 M-spec, A5
 * cadence). The web and mobile (Capacitor) builds share one static export; the
 * only compile-time difference is `NEXT_PUBLIC_PLATFORM=mobile`, read here once
 * so every consumer (shell, sync cadence, TaskRow affordances) branches on the
 * same flag rather than re-reading `process.env` ad hoc.
 *
 * The Capacitor `@capacitor/app` App-state listener (foreground/background)
 * lands in V2-D; it is NOT available in the web build. Until then this module
 * is the documented seam: `onForegroundChange` defaults to a `visibilitychange`
 * proxy (A5: "listen to visibilitychange as proxy"), and the native layer can
 * later call `setForegroundSource` to feed true App-state events in without any
 * consumer changing. Keeping the seam typed here means the sync engine depends
 * on an abstraction, not on `document.visibilityState` directly.
 */

export type Platform = "web" | "mobile";

/** Build flavor. `NEXT_PUBLIC_PLATFORM=mobile` selects the Capacitor-wrapped
 *  experience (A6); anything else is the hosted web app. */
export const PLATFORM: Platform = process.env.NEXT_PUBLIC_PLATFORM === "mobile" ? "mobile" : "web";

/** True for the Capacitor mobile flavor — permanent bottom tabs, always-visible
 *  row affordances, 3s foreground sync cadence (A5/A6). */
export const isMobileFlavor = PLATFORM === "mobile";

/** True while the app is foreground/visible. A backgrounded mobile app or a
 *  hidden tab returns false — used to pick the polling cadence (A5). */
export type ForegroundSource = () => boolean;

function visibilityForeground(): boolean {
  if (typeof document === "undefined") return true; // SSR: assume visible
  return document.visibilityState !== "hidden";
}

let foregroundSource: ForegroundSource = visibilityForeground;

/**
 * Replace the foreground predicate. Called by the native layer (V2-D) with a
 * Capacitor App-state-backed source; defaults to the `visibilitychange` proxy
 * for the pure web build. Idempotent and side-effect free — consumers read the
 * current value through {@link isForeground}.
 */
export function setForegroundSource(source: ForegroundSource): void {
  foregroundSource = source;
}

/** Current foreground/visible state, via whatever source is installed. */
export function isForeground(): boolean {
  return foregroundSource();
}

/**
 * Subscribe to foreground/background transitions. The default implementation
 * bridges the browser `visibilitychange` event; the native layer (V2-D) can
 * override {@link setForegroundSource} and additionally drive this callback
 * from Capacitor App-state events. Returns an unsubscribe function; a no-op
 * during SSR.
 */
export function onForegroundChange(handler: (foreground: boolean) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => handler(isForeground());
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
