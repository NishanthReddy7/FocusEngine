"use client";

/**
 * Settings (A6) — account (sign in/out + avatar/name/email), the onboarding
 * preferences (theme, default preset, week start, display name), and the
 * FocusShield blocklist editor. Under the app shell; the mobile flavor reaches
 * it from the permanent bottom tab bar. Voice per DESIGN_SPEC §9.
 */
import { useEffect, useState, type ReactNode } from "react";
import { LogOut } from "lucide-react";
import { FocusPreset, PRESET_DURATIONS } from "@focusengine/schemas/enums";
import { AppShell } from "@/components/shell/AppShell";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { useAuth } from "@/lib/auth/provider";
import { useTheme, type Theme } from "@/components/theme/ThemeProvider";
import { loadSettings, saveSettings, type ResolvedSettings } from "@/lib/settings";
import { startSyncEngine } from "@/lib/sync/engine";

const PRESETS: readonly FocusPreset[] = [FocusPreset.SPRINT, FocusPreset.FOCUS, FocusPreset.FLOW, FocusPreset.DEEP_WORK];
const PRESET_NAME: Record<FocusPreset, string> = {
  [FocusPreset.SPRINT]: "Sprint",
  [FocusPreset.FOCUS]: "Focus",
  [FocusPreset.FLOW]: "Flow",
  [FocusPreset.DEEP_WORK]: "Deep work",
};
const THEMES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "dark", label: "Studio" },
  { value: "neon", label: "Neon" },
];

function presetLabel(preset: FocusPreset): string {
  const d = PRESET_DURATIONS[preset];
  return `${d.work_minutes}/${d.break_minutes}`;
}

function Avatar({ picture, name }: { picture: string | null; name: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  if (picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={picture}
        alt=""
        referrerPolicy="no-referrer"
        className="h-11 w-11 rounded-full border border-hairline object-cover"
      />
    );
  }
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-surface-2 font-display text-ink">
      {initial}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-hairline py-6 first:border-t-0 first:pt-0">
      <p className="eyebrow">{title}</p>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  useEffect(() => startSyncEngine(), []);

  const { status, user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<ResolvedSettings | null>(null);
  const [blockInput, setBlockInput] = useState("");

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  async function update(patch: Partial<ResolvedSettings>) {
    const merged = await saveSettings(patch);
    setSettings(merged);
  }

  function chooseTheme(next: Theme) {
    setTheme(next);
    void update({ theme: next });
  }

  async function addBlock() {
    const value = blockInput.trim().toLowerCase();
    if (!value || !settings) return;
    setBlockInput("");
    if (settings.blocklist.includes(value)) return;
    await update({ blocklist: [...settings.blocklist, value] });
  }

  async function removeBlock(value: string) {
    if (!settings) return;
    await update({ blocklist: settings.blocklist.filter((v) => v !== value) });
  }

  const segmented = "flex divide-x divide-hairline overflow-hidden rounded-lg border border-hairline";

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-8 md:py-10">
        <header className="mb-6 flex items-baseline gap-3">
          <h1 className="font-display text-title font-semibold tracking-[-0.01em] text-ink">Settings</h1>
        </header>

        <Section title="Account">
          {status === "authed" && user ? (
            <div className="flex items-center gap-3">
              <Avatar picture={user.picture} name={user.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-ink">{user.name}</p>
                <p className="truncate font-mono text-[11px] text-muted">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-secondary text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
              >
                <LogOut size={15} strokeWidth={1.75} /> Sign out
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-secondary text-muted">
                Sign in to sync your tasks and history across devices. Your data stays on this device until you do.
              </p>
              <GoogleSignInButton />
            </div>
          )}
        </Section>

        <Section title="Theme">
          <div role="radiogroup" aria-label="Theme" className={`${segmented} self-start`}>
            {THEMES.map(({ value, label }) => {
              const active = theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => chooseTheme(value)}
                  className={`px-4 py-2 text-secondary transition-colors duration-150 ${
                    active ? "bg-surface-2 text-work" : "text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Default session">
          <div role="radiogroup" aria-label="Default session preset" className={segmented}>
            {PRESETS.map((p) => {
              const active = settings?.default_preset === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void update({ default_preset: p })}
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
        </Section>

        <Section title="Week starts on">
          <div role="radiogroup" aria-label="Week starts on" className={`${segmented} self-start`}>
            {([[1, "Monday"], [0, "Sunday"]] as const).map(([value, label]) => {
              const active = settings?.week_start === value;
              return (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void update({ week_start: value })}
                  className={`px-4 py-2 text-secondary transition-colors duration-150 ${
                    active ? "bg-surface-2 text-work" : "text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Display name">
          <input
            type="text"
            value={settings?.display_name ?? ""}
            onChange={(e) => setSettings((prev) => (prev ? { ...prev, display_name: e.target.value } : prev))}
            onBlur={(e) => void update({ display_name: e.target.value.trim() })}
            placeholder="What should the app call you"
            maxLength={40}
            className="max-w-sm rounded-md bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-muted"
          />
        </Section>

        <Section title="Focus shield blocklist">
          <p className="text-secondary text-muted">
            Sites and apps to keep out during a work interval. One entry per line.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addBlock();
                }
              }}
              placeholder="news.ycombinator.com"
              className="flex-1 rounded-md bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-muted"
            />
            <button
              type="button"
              onClick={() => void addBlock()}
              className="rounded-md border border-hairline px-4 py-2 text-secondary text-ink transition-colors duration-150 hover:bg-surface"
            >
              Add
            </button>
          </div>
          {settings && settings.blocklist.length > 0 ? (
            <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
              {settings.blocklist.map((entry) => (
                <li key={entry} className="flex items-center justify-between px-3 py-2">
                  <span className="truncate font-mono text-secondary text-ink">{entry}</span>
                  <button
                    type="button"
                    onClick={() => void removeBlock(entry)}
                    aria-label={`Remove ${entry}`}
                    className="rounded-md px-2 py-1 text-meta text-muted transition-colors hover:text-overdue"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted">Nothing blocked yet.</p>
          )}
        </Section>
      </div>
    </AppShell>
  );
}
