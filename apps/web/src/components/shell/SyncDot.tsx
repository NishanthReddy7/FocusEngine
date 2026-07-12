"use client";

/**
 * Sync status dot — DESIGN_SPEC §6: 6px dot, muted (idle), work-colour pulse
 * (syncing), overdue-colour (failed) with a retry affordance. Driven purely by
 * the client bus's `sync.*` events (never reaching into the engine's state).
 */
import { useEffect, useState } from "react";
import { bus } from "@/lib/events/bus";
import { syncOnce } from "@/lib/sync/engine";

type SyncStatus = "idle" | "syncing" | "failed";

export function SyncDot() {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [detail, setDetail] = useState("Up to date");

  useEffect(() => {
    const offs = [
      bus.on("sync.started", () => {
        setStatus("syncing");
        setDetail("Syncing");
      }),
      bus.on("sync.completed", () => {
        setStatus("idle");
        setDetail("Up to date");
      }),
      bus.on("sync.failed", (payload) => {
        setStatus("failed");
        setDetail(payload.reason ? `Sync failed — ${payload.reason}` : "Sync failed. Retry.");
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  const color = status === "failed" ? "var(--overdue)" : status === "syncing" ? "var(--work)" : "var(--text-muted)";
  const label = status === "syncing" ? "Syncing" : status === "failed" ? detail : "Sync up to date";

  return (
    <button
      type="button"
      onClick={() => void syncOnce()}
      title={`${label}${status !== "syncing" ? " · retry now" : ""}`}
      aria-label={`Sync status: ${label}. Activate to sync now.`}
      className="flex h-8 w-8 items-center justify-center rounded-md"
    >
      <span
        aria-hidden
        className={`block h-1.5 w-1.5 rounded-full transition-colors duration-200 ${status === "syncing" ? "sync-pulse" : ""}`}
        style={{ backgroundColor: color }}
      />
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}
