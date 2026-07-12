"use client";

import { useEffect, useState } from "react";
import { SessionState } from "@focusengine/schemas/enums";
import { bus } from "@/lib/events/bus";
import { getMeta } from "@/lib/db/repository";

export interface FocusShieldProps {
  sessionState: SessionState;
}

/**
 * Distraction interceptor (ARCHITECTURE.md §7.6), active only while
 * `sessionState === "active_work"`. Tab-away raises a full-screen overlay and
 * `beforeunload` warns.
 *
 * v1.1 (ARCHITECTURE.md §7.3): the "you left" signal now fires through the
 * typed client bus as `shield.triggered` (payload `{reason, at}`) — replacing
 * the pre-v1.1 DOM `CustomEvent` — so audio/coaching/analytics can react
 * through the one integration bus like every other cross-engine event.
 *
 * Still a documented extension point: real network-level blocking of
 * `isDistraction()` URLs needs a Next.js middleware or companion extension this
 * scaffold doesn't ship; `isDistraction()` only classifies a URL string.
 */
export function FocusShield({ sessionState }: FocusShieldProps) {
  const [showOverlay, setShowOverlay] = useState(false);
  const active = sessionState === SessionState.ACTIVE_WORK;

  useEffect(() => {
    if (!active) {
      setShowOverlay(false);
      return;
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        setShowOverlay(true);
        bus.emit("shield.triggered", { reason: "visibility", at: new Date().toISOString() });
      }
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      bus.emit("shield.triggered", { reason: "navigation", at: new Date().toISOString() });
      event.preventDefault();
      event.returnValue = "";
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [active]);

  if (!active || !showOverlay) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="shield-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 text-center"
      style={{ backgroundColor: "color-mix(in srgb, var(--bg) 96%, transparent)" }}
    >
      <p className="eyebrow text-work">Shield</p>
      <p id="shield-title" className="font-display text-title text-ink">
        You left during a work interval.
      </p>
      <button
        type="button"
        autoFocus
        onClick={() => setShowOverlay(false)}
        className="rounded-md border border-hairline px-5 py-2.5 text-secondary text-ink transition-colors duration-150 hover:bg-surface"
      >
        Return to task
      </button>
    </div>
  );
}

/** Checked against `_meta.shield_blocklist` (ARCHITECTURE.md §7.6). Only
 *  classifies a URL — network-level blocking is the documented extension
 *  point (see the module doc above). */
export async function isDistraction(url: string): Promise<boolean> {
  const blocklist = await getMeta<string[]>("shield_blocklist");
  if (!blocklist || blocklist.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return blocklist.some((entry) => hostname === entry.toLowerCase() || hostname.endsWith(`.${entry.toLowerCase()}`));
  } catch {
    return false;
  }
}
