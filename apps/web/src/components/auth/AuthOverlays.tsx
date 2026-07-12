"use client";

/**
 * Global auth overlays — V2-C (A2/A3). Mounted once at the app root so they
 * float above any route: the "Replace local data?" confirm for a different-user
 * sign-in (A3), and a dismissible notice line for session-expired / sign-in
 * unavailable messages. Voice per DESIGN_SPEC §9 — states what happened and the
 * next step, no apology, no exclamation.
 */
import { X } from "lucide-react";
import { useAuth } from "@/lib/auth/provider";

export function AuthOverlays() {
  const { pendingReplace, resolveReplace, message, clearMessage, status } = useAuth();

  return (
    <>
      {message && status !== "loading" && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-20 z-[60] mx-auto flex w-max max-w-[calc(100vw-2rem)] items-center gap-3 rounded-md border border-hairline bg-surface-2 px-4 py-2.5 md:bottom-6"
          style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
        >
          <span className="text-secondary text-ink">{message}</span>
          <button
            type="button"
            onClick={clearMessage}
            aria-label="Dismiss"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:text-ink"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {pendingReplace && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="replace-data-title"
          className="fixed inset-0 z-[70] flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 82%, transparent)" }}
        >
          <div className="w-full max-w-md rounded-lg border border-hairline bg-surface p-5">
            <p className="eyebrow mb-2 text-work">Different account</p>
            <h2 id="replace-data-title" className="font-display text-lg text-ink">
              Replace local data?
            </h2>
            <p className="mt-2 text-secondary text-muted">
              This device holds data for another account. Signing in as{" "}
              <span className="text-ink">{pendingReplace.user.email}</span> replaces the tasks and history here with
              that account&#39;s data. This cannot be undone.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void resolveReplace(false)}
                className="rounded-md px-4 py-2 text-secondary text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void resolveReplace(true)}
                className="rounded-md border border-hairline px-4 py-2 text-secondary transition-colors duration-150 hover:bg-surface-2"
                style={{ color: "var(--overdue)" }}
              >
                Replace local data
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
