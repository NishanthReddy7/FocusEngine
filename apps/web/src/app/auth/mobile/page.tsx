"use client";

/**
 * Mobile sign-in handoff (A2) + V2-G (Fixes A/C/D). Google blocks OAuth inside a
 * WebView, so the APK opens THIS hosted page in the system browser; it runs GIS,
 * exchanges the Google credential for our JWT, then redirects to
 * `focusengine://auth#token=<jwt>&user=<base64url(JSON)>` where the app's
 * deep-link listener captures it. A visible "Return to the app" link is the
 * fallback if the automatic scheme redirect is blocked. Fully static-export safe.
 *
 * The exchange uses the same cold-start-resilient wake ladder as the web button
 * (wake the sleeping Render backend, then exchange with retries), with the
 * DESIGN_SPEC-styled button and working states — never a raw "Failed to fetch".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleAuthUnavailableError, isGoogleConfigured, primeGoogle, promptGoogle } from "@/lib/auth/google";
import { WAKE_ERROR_MESSAGE, wakeAndExchange, type WakePhase } from "@/lib/auth/wake";
import { GoogleBrandButton } from "@/components/auth/GoogleBrandButton";

const DEEP_LINK = "focusengine://auth";

/** UTF-8-safe base64url of the user JSON for the deep-link fragment (A2). */
function base64Url(value: string): string {
  const b64 = btoa(unescape(encodeURIComponent(value)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type State =
  | { kind: "idle" }
  | { kind: "working"; phase: WakePhase }
  | { kind: "done"; redirectUrl: string }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export default function MobileAuthPage() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const runningRef = useRef(false);

  const runFlow = useCallback(async (credential: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState({ kind: "working", phase: "connecting" });
    try {
      const auth = await wakeAndExchange(credential, {
        onPhase: (phase) => setState({ kind: "working", phase }),
      });
      const url = `${DEEP_LINK}#token=${auth.token}&user=${base64Url(JSON.stringify(auth.user))}`;
      setState({ kind: "done", redirectUrl: url });
      window.location.href = url; // hand the session to the native app
    } catch (err) {
      if (err instanceof GoogleAuthUnavailableError) {
        setState({ kind: "notice", message: err.message });
      } else {
        setState({ kind: "error", message: WAKE_ERROR_MESSAGE });
      }
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isGoogleConfigured) return;
    let cancelled = false;
    void primeGoogle((credential) => {
      if (!cancelled) void runFlow(credential);
    }).catch(() => {
      if (!cancelled) {
        setState({ kind: "notice", message: "Google sign-in is unavailable right now. Open the app to keep working locally." });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runFlow]);

  const beginSignIn = useCallback(() => {
    setState({ kind: "working", phase: "connecting" });
    promptGoogle(() => {
      if (!runningRef.current) setState({ kind: "idle" });
    });
  }, []);

  const working = state.kind === "working";

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center px-6"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-hairline bg-surface p-8 text-center">
        <p className="eyebrow">FocusEngine</p>
        <h1 className="font-display text-title text-ink">Sign in on your phone</h1>

        {!isGoogleConfigured ? (
          <p className="text-secondary text-muted">Sign-in is not configured. Open the app to keep working locally.</p>
        ) : state.kind === "done" ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-secondary text-break">Signed in. Returning to the app.</p>
            <a href={state.redirectUrl} className="text-secondary text-work transition-colors hover:underline">
              Return to the app
            </a>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <p className="text-secondary text-muted">Continue with Google to sync this device.</p>
            <GoogleBrandButton onClick={beginSignIn} working={working} phase={working ? state.phase : "connecting"} />

            {state.kind === "error" && (
              <div role="alert" className="flex flex-col items-center gap-2">
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
        )}
      </div>
    </main>
  );
}
