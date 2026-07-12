"use client";

/**
 * The DESIGN_SPEC-styled "Continue with Google" button (V2-G Fix D). We render
 * our OWN button — not Google's `renderButton` — so the mark is optically
 * correct and the control can enter the cold-start working states ("Connecting…"
 * / "Waking the sync server…") that Google's own button can't express.
 *
 * Purely presentational: 44px tall, hairline border, an 18px Google "G"
 * optically centered in a 20px box with a 12px gap to a 15px Instrument Sans
 * medium label. In the working state the mark becomes a restrained spinner and
 * the label switches to a 13px mono phase line. All colors come from tokens
 * (§3); voice is plain, no exclamation (§9). Smart components own the flow.
 */
import type { WakePhase } from "@/lib/auth/wake";

const PHASE_LABEL: Record<WakePhase, string> = {
  connecting: "Connecting…",
  waking: "Waking the sync server…",
};

/** The official Google "G" mark — inline so it inherits crisp rendering and
 *  needs no network/asset. 18px inside a 20px optical box (Fix D). */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Restrained loading spinner (§6/§7) — a hairline ring with a work-color arc,
 *  18px to match the mark it replaces. */
function Spinner() {
  return (
    <svg viewBox="0 0 18 18" width={18} height={18} className="fe-spin" aria-hidden focusable="false">
      <circle cx="9" cy="9" r="7" fill="none" stroke="var(--hairline)" strokeWidth="1.5" />
      <path d="M9 2 a7 7 0 0 1 7 7" fill="none" stroke="var(--work)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GoogleBrandButton({
  onClick,
  working = false,
  phase = "connecting",
  disabled = false,
}: {
  onClick: () => void;
  working?: boolean;
  phase?: WakePhase;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || working}
      aria-label="Continue with Google"
      aria-busy={working || undefined}
      className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-hairline bg-surface px-4 text-ink transition-colors duration-150 hover:bg-surface-2 disabled:cursor-default disabled:opacity-70"
    >
      {working ? (
        <>
          <span className="flex h-5 w-5 items-center justify-center">
            <Spinner />
          </span>
          <span className="font-mono text-secondary text-muted">{PHASE_LABEL[phase]}</span>
        </>
      ) : (
        <>
          <span className="flex h-5 w-5 items-center justify-center">
            <GoogleMark />
          </span>
          <span className="text-body font-medium">Continue with Google</span>
        </>
      )}
    </button>
  );
}
