"use client";

/**
 * Mobile sign-in handoff (A2). Google blocks OAuth inside a WebView, so the APK
 * opens THIS hosted page in the system browser; it runs GIS, exchanges the
 * Google credential for our JWT, then redirects to
 * `focusengine://auth#token=<jwt>&user=<base64url(JSON)>` where the app's
 * deep-link listener captures it. A visible "Return to the app" link is the
 * fallback if the automatic scheme redirect is blocked. Fully static-export
 * safe — no server data, all work happens client-side in the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  exchangeGoogleCredential,
  GoogleAuthUnavailableError,
  isGoogleConfigured,
  renderGoogleButton,
} from "@/lib/auth/google";
import { useTheme } from "@/components/theme/ThemeProvider";

const DEEP_LINK = "focusengine://auth";

/** UTF-8-safe base64url of the user JSON for the deep-link fragment (A2). */
function base64Url(value: string): string {
  const b64 = btoa(unescape(encodeURIComponent(value)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Phase = "ready" | "exchanging" | "done" | "error";

export default function MobileAuthPage() {
  const { theme } = useTheme();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  const handleCredential = useCallback(async (credential: string) => {
    setPhase("exchanging");
    setError(null);
    try {
      const auth = await exchangeGoogleCredential(credential);
      const url = `${DEEP_LINK}#token=${auth.token}&user=${base64Url(JSON.stringify(auth.user))}`;
      setRedirectUrl(url);
      setPhase("done");
      window.location.href = url; // hand the session to the native app
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    const container = buttonRef.current;
    if (!isGoogleConfigured || !container) return;
    let cancelled = false;
    void renderGoogleButton(container, (credential) => void handleCredential(credential), theme).catch((err) => {
      if (cancelled) return;
      setError(
        err instanceof GoogleAuthUnavailableError || err instanceof Error
          ? err.message
          : "Sign-in is unavailable right now.",
      );
      setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [handleCredential, theme]);

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center px-6"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-lg border border-hairline bg-surface p-8 text-center">
        <p className="eyebrow">FocusEngine</p>
        <h1 className="font-display text-title text-ink">Sign in on your phone</h1>

        {!isGoogleConfigured ? (
          <p className="text-secondary text-muted">
            Sign-in is not configured. Open the app to keep working locally.
          </p>
        ) : (
          <>
            <p className="text-secondary text-muted">Continue with Google to sync this device.</p>
            <div
              ref={buttonRef}
              aria-label="Sign in with Google"
              className={phase === "exchanging" ? "pointer-events-none opacity-50" : ""}
            />
          </>
        )}

        {phase === "exchanging" && (
          <p className="font-mono text-meta uppercase tracking-[0.14em] text-muted">Signing in</p>
        )}

        {phase === "done" && redirectUrl && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-secondary text-break">Signed in. Returning to the app.</p>
            <a href={redirectUrl} className="text-secondary text-work transition-colors hover:underline">
              Return to the app
            </a>
          </div>
        )}

        {phase === "error" && error && (
          <p role="status" className="text-secondary text-overdue">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
