/**
 * Identity & auth wire shapes — exact TS mirror of the v2 contract in
 * `docs/V2_ADDENDUM.md` §A2 and the backend `app/schemas/user.py` (V2-B, the
 * authoritative implementation). Field names are snake_case, field-for-field,
 * to match the Pydantic contract with zero casing translation (ARCHITECTURE.md
 * §3). No behaviour lives here — pure shape definitions.
 */
import { FocusPreset } from "./enums";

/**
 * Per-user preferences (A2 `users.settings` JSON, default `{}`). Written by
 * onboarding + the settings screen to Dexie `_meta.settings`, and — when signed
 * in — round-tripped through `PATCH /me/settings` (A2) and hydrated from
 * `GET /me`. Every field is optional so a partial patch is always a valid
 * `UserSettings`; readers apply their own defaults (`lib/settings.ts`).
 */
export interface UserSettings {
  /** mirrors DESIGN_SPEC §3 theme toggle — also cached in `_meta.theme` for
   *  first-paint, synced here so a second device inherits the choice. */
  theme?: "dark" | "neon";
  /** onboarding default preset for the focus cockpit */
  default_preset?: FocusPreset;
  /** 0 = Sunday, 1 = Monday — first column of the calendar week */
  week_start?: 0 | 1;
  /** greeting name, distinct from the Google account name */
  display_name?: string;
  /** FocusShield distraction list (`_meta.shield_blocklist`), synced per-user */
  blocklist?: string[];
  /** set once the 3-screen onboarding completes; gates the first-launch flow */
  onboarded?: boolean;
}

/**
 * The signed-in user as it crosses the wire (A2 `users` row / V2-B
 * `UserRead`). Carries its `settings` JSON inline, so `POST /auth/google` and
 * `GET /me` both deliver preferences without a second request. `google_sub`
 * is server-internal and never returned.
 */
export interface User {
  /** String(36) PK (A2). */
  id: string;
  email: string;
  name: string;
  picture: string | null;
  settings: UserSettings;
  /** ISO-8601 UTC */
  created_at: string;
}

/** `POST /auth/google` request body (A2). `id_token` is Google's OIDC ID token
 *  from the GIS credential callback — NOT our JWT. */
export interface GoogleAuthRequest {
  id_token: string;
}

/** `POST /auth/google` response (A2): our JWT (pyjwt HS256, 30-day exp) + the
 *  upserted user. Stored verbatim in Dexie `_meta.auth`. When the backend has
 *  no Google client configured it returns 503 instead — treated as local-only
 *  mode by the caller. */
export interface AuthResponse {
  token: string;
  user: User;
}

/** `GET /me` response (A2) — the user with merged settings inline. */
export type MeResponse = User;

/** `PATCH /me/settings` request body (A2) — merged server-side into the JSON. */
export interface SettingsUpdate {
  settings: UserSettings;
}

/** Dexie `_meta.auth` shape (A3): "a device's DB belongs to whoever is signed
 *  in", so the token+user pair is cached locally and cleared on sign-out. */
export interface StoredAuth {
  token: string;
  user: User;
}

/** Payload carried across the mobile deep-link handoff (A2):
 *  `focusengine://auth#token=<jwt>&user=<base64url(JSON)>`. The decoded `user`
 *  fragment is a {@link User}; this documents the whole decoded bundle. */
export interface MobileAuthHandoff {
  token: string;
  user: User;
}
