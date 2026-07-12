"use client";

/**
 * First-launch onboarding — A6 + V2-G (Fix E): four screens (welcome/thesis ·
 * theme pick with a live Studio/Neon preview · defaults: preset + week start +
 * display name · sync: sign in to sync across devices, or skip). Writes
 * `_meta.settings` (and `PATCH /me/settings` when signed in) on finish, and
 * applies the chosen theme through the ThemeProvider. Tokens/typography/voice
 * are DESIGN_SPEC-verbatim; no exclamation marks (§9).
 */
import { useEffect, useRef, useState } from "react";
import { FocusPreset, PRESET_DURATIONS } from "@focusengine/schemas/enums";
import { useTheme, type Theme } from "@/components/theme/ThemeProvider";
import { useAuth } from "@/lib/auth/provider";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "@/lib/settings";

const PRESETS: readonly FocusPreset[] = [FocusPreset.SPRINT, FocusPreset.FOCUS, FocusPreset.FLOW, FocusPreset.DEEP_WORK];
const PRESET_NAME: Record<FocusPreset, string> = {
  [FocusPreset.SPRINT]: "Sprint",
  [FocusPreset.FOCUS]: "Focus",
  [FocusPreset.FLOW]: "Flow",
  [FocusPreset.DEEP_WORK]: "Deep work",
};

function presetLabel(preset: FocusPreset): string {
  const d = PRESET_DURATIONS[preset];
  return `${d.work_minutes}/${d.break_minutes}`;
}

const TOTAL_STEPS = 4;

/** A small echo of the Session Dial (§2) — a 30-tick ring with a lit arc — used
 *  purely as a themed preview swatch. Reads the surrounding theme tokens, so the
 *  same markup renders Studio or Neon depending on the wrapping theme class. */
function MiniDial() {
  const ticks = 30;
  const lit = 11;
  return (
    <svg viewBox="0 0 100 100" className="h-20 w-20" aria-hidden>
      {Array.from({ length: ticks }, (_, i) => {
        const on = i < lit;
        const rad = ((i * (360 / ticks) - 90) * Math.PI) / 180;
        const rInner = on ? 40 : 43;
        const rOuter = 46;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return (
          <line
            key={i}
            x1={(50 + rInner * cos).toFixed(2)}
            y1={(50 + rInner * sin).toFixed(2)}
            x2={(50 + rOuter * cos).toFixed(2)}
            y2={(50 + rOuter * sin).toFixed(2)}
            strokeWidth={on ? 2 : 1.25}
            strokeLinecap="round"
            style={{ stroke: on ? "var(--work)" : "color-mix(in srgb, var(--text-muted) 32%, transparent)" }}
          />
        );
      })}
    </svg>
  );
}

function ThemePreview({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect: () => void }) {
  const title = theme === "dark" ? "Studio" : "Neon";
  const note = theme === "dark" ? "Warm graphite" : "High-contrast";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      // The nested theme class re-scopes the DESIGN_SPEC §3 tokens for this card
      // only, so both options preview live regardless of the active theme.
      className={`theme-${theme} flex flex-1 flex-col items-center gap-3 rounded-lg border p-5 transition-colors duration-150`}
      style={{
        backgroundColor: "var(--bg)",
        borderColor: selected ? "var(--work)" : "var(--hairline)",
        outline: selected ? "1px solid var(--work)" : "none",
      }}
    >
      <MiniDial />
      <span className="eyebrow" style={{ color: "var(--text)" }}>
        {title}
      </span>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text-muted)" }}>
        {note}
      </span>
    </button>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { setTheme } = useTheme();
  const { status } = useAuth();
  const [step, setStep] = useState(0);
  const [themeChoice, setThemeChoice] = useState<Theme>(DEFAULT_SETTINGS.theme);
  const [preset, setPreset] = useState<FocusPreset>(DEFAULT_SETTINGS.default_preset);
  const [weekStart, setWeekStart] = useState<0 | 1>(DEFAULT_SETTINGS.week_start);
  const [displayName, setDisplayName] = useState(DEFAULT_SETTINGS.display_name);
  const [saving, setSaving] = useState(false);
  const finishedRef = useRef(false);

  // Seed from any settings already stored (re-running onboarding keeps picks).
  useEffect(() => {
    void loadSettings().then((s) => {
      setThemeChoice(s.theme);
      setPreset(s.default_preset);
      setWeekStart(s.week_start);
      setDisplayName(s.display_name);
    });
  }, []);

  function chooseTheme(next: Theme) {
    setThemeChoice(next);
    setTheme(next); // live: recolors the whole app behind the overlay
  }

  // Persist the onboarding picks and close. Guarded so signing in AND clicking
  // "Skip for now" can't both fire it (Fix E). Runs after any sign-in has
  // already activated the session, so these picks win locally and push up.
  async function finish() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setSaving(true);
    await saveSettings({
      theme: themeChoice,
      default_preset: preset,
      week_start: weekStart,
      display_name: displayName.trim(),
      onboarded: true,
    });
    setTheme(themeChoice);
    onDone();
  }

  // Fix E: completing sign-in on the sync step finishes onboarding into the app.
  useEffect(() => {
    if (step === TOTAL_STEPS - 1 && status === "authed") void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, status]);

  const segmented = "flex divide-x divide-hairline overflow-hidden rounded-lg border border-hairline";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to FocusEngine"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-bg px-6"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="flex w-full max-w-lg flex-col gap-8">
        {/* Step indicator — three ticks in the dial's language. */}
        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <span
              key={i}
              className="h-0.5 flex-1 rounded-full transition-colors duration-200"
              style={{ backgroundColor: i <= step ? "var(--work)" : "var(--hairline)" }}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="flex flex-col gap-4">
            <p className="eyebrow">FocusEngine</p>
            <h1 className="font-display text-heading tracking-[-0.01em] text-ink">
              A precision instrument for attention
            </h1>
            <p className="text-body text-muted">
              Capture what is on your mind, then focus on one thing at a time. Everything lives on this device first and
              syncs across your devices once you sign in.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Theme</p>
              <h1 className="font-display text-title text-ink">Choose your surface</h1>
              <p className="text-secondary text-muted">Color only appears to show the state of your attention.</p>
            </div>
            <div className="flex gap-3">
              <ThemePreview theme="dark" selected={themeChoice === "dark"} onSelect={() => chooseTheme("dark")} />
              <ThemePreview theme="neon" selected={themeChoice === "neon"} onSelect={() => chooseTheme("neon")} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Defaults</p>
              <h1 className="font-display text-title text-ink">Set your defaults</h1>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-secondary text-muted">Default session</span>
              <div role="radiogroup" aria-label="Default session preset" className={segmented}>
                {PRESETS.map((p) => {
                  const active = p === preset;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPreset(p)}
                      className={`flex flex-1 flex-col items-center gap-1 px-3 py-2.5 transition-colors duration-150 ${
                        active ? "bg-surface-2" : "hover:bg-surface"
                      }`}
                    >
                      <span className={`font-mono text-secondary ${active ? "text-work" : "text-ink"}`}>
                        {presetLabel(p)}
                      </span>
                      <span className={`text-[11px] ${active ? "text-ink" : "text-muted"}`}>{PRESET_NAME[p]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-secondary text-muted">Week starts on</span>
              <div role="radiogroup" aria-label="Week starts on" className={`${segmented} self-start`}>
                {([[1, "Monday"], [0, "Sunday"]] as const).map(([value, label]) => {
                  const active = weekStart === value;
                  return (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setWeekStart(value)}
                      className={`px-4 py-2 text-secondary transition-colors duration-150 ${
                        active ? "bg-surface-2 text-work" : "text-muted hover:bg-surface hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-secondary text-muted">Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="What should the app call you"
                maxLength={40}
                className="rounded-md bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-muted"
              />
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Sync</p>
              <h1 className="font-display text-title text-ink">Sign in to sync</h1>
              <p className="text-secondary text-muted">
                Sign in to sync your tasks and history across devices. Your data stays on this device until you do.
              </p>
            </div>
            <GoogleSignInButton />
            <button
              type="button"
              onClick={() => void finish()}
              disabled={saving}
              className="self-start rounded-md px-1 py-1 text-secondary text-muted transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed"
            >
              {saving ? "Saving" : "Skip for now"}
            </button>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-md px-3 py-2 text-secondary text-muted transition-colors duration-150 hover:text-ink disabled:invisible"
          >
            Back
          </button>
          {/* The sync step (last) proceeds via sign-in or "Skip for now", so no
              Continue/Start here — only Back. */}
          {step < TOTAL_STEPS - 1 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1))}
              className="rounded-md border border-hairline px-5 py-2 text-secondary text-work transition-colors duration-150 hover:bg-surface"
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
