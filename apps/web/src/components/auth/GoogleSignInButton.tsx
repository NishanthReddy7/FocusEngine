"use client";

/**
 * Google sign-in button — V2-C (A2). Renders the official GIS button when a
 * client id is configured; otherwise shows the local-only notice (A2
 * acceptance: "button hidden, local-only notice"). The credential from a
 * successful popup is handed to the auth provider, which runs the claim /
 * different-user flow. Voice per DESIGN_SPEC §9 — plain, no exclamation.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/provider";
import { renderGoogleButton } from "@/lib/auth/google";
import { useTheme } from "@/components/theme/ThemeProvider";

export function GoogleSignInButton({ localOnlyNotice }: { localOnlyNotice?: ReactNode }) {
  const { configured, signInWithCredential } = useAuth();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!configured || !container) return;
    let cancelled = false;
    void renderGoogleButton(
      container,
      (credential) => {
        void signInWithCredential(credential);
      },
      theme,
    ).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Sign-in is unavailable right now.");
    });
    return () => {
      cancelled = true;
    };
  }, [configured, signInWithCredential, theme]);

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

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} aria-label="Sign in with Google" />
      {error && (
        <p role="status" className="text-meta text-overdue">
          {error}
        </p>
      )}
    </div>
  );
}
