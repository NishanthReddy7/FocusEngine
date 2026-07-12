"use client";

/**
 * Google sign-in button — V2-C (A2) + V2-G (Fixes A/D). Renders the
 * DESIGN_SPEC-styled {@link GoogleBrandButton} when a client id is configured;
 * otherwise shows the local-only notice (A2 acceptance). Clicking opens the
 * Google account chooser (GIS), and the returned credential runs the
 * cold-start-resilient wake + exchange flow (the button shows "Connecting…" then
 * "Waking the sync server…"). A failure surfaces INLINE under the button with a
 * Retry — never a floating raw "Failed to fetch" (Fixes A/C). Voice per §9.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/provider";
import { GoogleAuthUnavailableError, primeGoogle, promptGoogle } from "@/lib/auth/google";
import { WAKE_ERROR_MESSAGE, type WakePhase } from "@/lib/auth/wake";
import { GoogleBrandButton } from "./GoogleBrandButton";

type ButtonState =
  | { kind: "idle" }
  | { kind: "working"; phase: WakePhase }
  | { kind: "error"; message: string } // designed wake failure — offers Retry
  | { kind: "notice"; message: string }; // soft local-only explanation (503 / GIS unavailable)

export function GoogleSignInButton({ localOnlyNotice }: { localOnlyNotice?: ReactNode }) {
  const { configured, signInWithCredential } = useAuth();
  const [state, setState] = useState<ButtonState>({ kind: "idle" });
  // True from the moment a credential arrives until the flow settles — so a
  // dismissed chooser (no credential) resets the button, but an in-flight
  // exchange is never interrupted.
  const runningRef = useRef(false);

  const runFlow = useCallback(
    async (credential: string) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setState({ kind: "working", phase: "connecting" });
      try {
        await signInWithCredential(credential, {
          onPhase: (phase) => setState({ kind: "working", phase }),
        });
        // Success (session activated) or a pending "Replace local data?" prompt
        // has taken over — either way the button returns to rest.
        setState({ kind: "idle" });
      } catch (err) {
        if (err instanceof GoogleAuthUnavailableError) {
          setState({ kind: "notice", message: err.message });
        } else {
          // Provider already normalised this to designed copy, but guard anyway
          // so a raw fetch error can never reach the UI.
          setState({ kind: "error", message: WAKE_ERROR_MESSAGE });
        }
      } finally {
        runningRef.current = false;
      }
    },
    [signInWithCredential],
  );

  // Prime GIS once configured so a click can open the chooser immediately.
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    void primeGoogle((credential) => {
      if (!cancelled) void runFlow(credential);
    }).catch(() => {
      // GIS script failed to load — a soft notice, not a raw error.
      if (!cancelled) {
        setState({
          kind: "notice",
          message: "Google sign-in is unavailable right now. You can keep working locally.",
        });
      }
    });

    // Dev-only test seam (stripped from production builds): drive the resilient
    // flow with a synthetic credential so the wake ladder + working/error states
    // can be verified without a real Google account.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __feTestSignIn?: (c: string) => void }).__feTestSignIn = (c: string) => void runFlow(c);
    }

    return () => {
      cancelled = true;
    };
  }, [configured, runFlow]);

  const beginSignIn = useCallback(() => {
    setState({ kind: "working", phase: "connecting" });
    promptGoogle(() => {
      // Prompt couldn't open, or the user dismissed it without choosing — reset
      // (unless a credential already started the flow).
      if (!runningRef.current) setState({ kind: "idle" });
    });
  }, []);

  if (!configured) {
    return (
      <>
        {localOnlyNotice ?? (
          <p className="text-secondary text-muted">
            Local-only mode. Sign-in is not configured, so your data stays on this device.
          </p>
        )}
      </>
    );
  }

  const working = state.kind === "working";

  return (
    <div className="flex flex-col gap-2">
      <GoogleBrandButton onClick={beginSignIn} working={working} phase={working ? state.phase : "connecting"} />

      {state.kind === "error" && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-secondary text-muted">{state.message}</p>
          <button
            type="button"
            onClick={beginSignIn}
            className="rounded-md border border-hairline px-3 py-1.5 text-secondary text-work transition-colors duration-150 hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === "notice" && (
        <p role="status" className="text-secondary text-muted">
          {state.message}
        </p>
      )}
    </div>
  );
}
