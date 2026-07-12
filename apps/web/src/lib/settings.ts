/**
 * User settings store — V2-C (A2/A6). One place to read/write the per-user
 * `UserSettings` that onboarding, the settings screen, and the auth provider
 * all share. Local truth lives in Dexie `_meta.settings` (+ the FocusShield's
 * `_meta.shield_blocklist`, which the blocklist mirror keeps in lockstep so the
 * existing shield keeps working); when signed in, changes best-effort round-trip
 * through `PATCH /me/settings` and hydrate from `GET /me` (A2).
 *
 * The theme is intentionally NOT applied here — `components/theme/ThemeProvider`
 * owns `_meta.theme` and the live DOM class. This module only records the
 * theme *preference* into the synced settings blob; callers that change the
 * theme call both `setTheme()` (provider) and `saveSettings({ theme })`.
 */
import { FocusPreset } from "@focusengine/schemas/enums";
import type { UserSettings } from "@focusengine/schemas/auth";
import { getBlocklist, getStoredSettings, setBlocklist, setStoredSettings } from "./db/repository";
import { authHeader, getAuthToken } from "./auth/token";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/** Every field resolved — readers get a total object regardless of what was
 *  persisted. `week_start` defaults to Monday (1); `default_preset` matches the
 *  cockpit's own initial preset (FOCUS · 30/5). */
export type ResolvedSettings = Required<UserSettings>;

export const DEFAULT_SETTINGS: ResolvedSettings = {
  theme: "dark",
  default_preset: FocusPreset.FOCUS,
  week_start: 1,
  display_name: "",
  blocklist: [],
  onboarded: false,
};

/** Merge stored settings over the defaults, sourcing `blocklist` from the
 *  authoritative `_meta.shield_blocklist` (what the FocusShield reads). Built
 *  field-by-field so the result is a total {@link ResolvedSettings}. */
export async function loadSettings(): Promise<ResolvedSettings> {
  const [stored, blocklist] = await Promise.all([getStoredSettings(), getBlocklist()]);
  const s = stored ?? {};
  return {
    theme: s.theme ?? DEFAULT_SETTINGS.theme,
    default_preset: s.default_preset ?? DEFAULT_SETTINGS.default_preset,
    week_start: s.week_start ?? DEFAULT_SETTINGS.week_start,
    display_name: s.display_name ?? DEFAULT_SETTINGS.display_name,
    blocklist,
    onboarded: s.onboarded ?? DEFAULT_SETTINGS.onboarded,
  };
}

/**
 * Merge a partial patch into the stored settings, persist locally (mirroring
 * `blocklist` → `_meta.shield_blocklist`), and best-effort push to the server
 * when signed in. Returns the resolved settings so callers can update local
 * state without a re-read.
 */
export async function saveSettings(patch: Partial<UserSettings>): Promise<ResolvedSettings> {
  const current = (await getStoredSettings()) ?? {};
  const merged: UserSettings = { ...current, ...patch };
  await setStoredSettings(merged);
  if (patch.blocklist !== undefined) await setBlocklist(patch.blocklist);
  void pushSettings(merged);
  return loadSettings();
}

/** `PATCH /me/settings` — no-op when signed out or offline (settings sync on the
 *  next successful call / sign-in). */
export async function pushSettings(settings: UserSettings): Promise<void> {
  if (!getAuthToken()) return;
  try {
    await fetch(`${API_BASE}/me/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ settings }),
    });
  } catch {
    // Offline — local `_meta.settings` is the source of truth; syncs later.
  }
}

/** Apply server-provided settings to local storage on sign-in / `GET /me`
 *  hydration, keeping `_meta.shield_blocklist` in step. Does not push back. */
export async function applyServerSettings(settings: UserSettings): Promise<void> {
  const current = (await getStoredSettings()) ?? {};
  const merged: UserSettings = { ...current, ...settings };
  await setStoredSettings(merged);
  if (Array.isArray(settings.blocklist)) await setBlocklist(settings.blocklist);
}
