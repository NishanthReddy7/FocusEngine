/**
 * Google Identity Services (GIS) integration — V2-C (A2). Loads the GIS client
 * script on demand, renders the official sign-in button, and exchanges the
 * returned Google ID token for our JWT via `POST /auth/google`. Framework-free
 * (imperative DOM + fetch) so it serves both the React button component and the
 * standalone `/auth/mobile` deep-link page.
 *
 * The script is fetched at runtime from Google in the browser, so it works in a
 * static export (GitHub Pages) all the same. When `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
 * is unset the whole surface is disabled and callers fall back to local-only
 * mode (A2 acceptance: "auth gracefully absent … button hidden").
 */
import type { AuthResponse, GoogleAuthRequest } from "@focusengine/schemas/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const GIS_SRC = "https://accounts.google.com/gsi/client";

/** The web OAuth client id (A8 — user pastes it into a repo variable). Empty
 *  when unset → local-only mode. */
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
export const isGoogleConfigured = GOOGLE_CLIENT_ID.length > 0;

/** Raised when sign-in isn't available: client id unset locally, or the server
 *  has no Google client configured (`POST /auth/google` → 503). Callers treat
 *  it as "stay in local-only mode" rather than a hard error. */
export class GoogleAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthUnavailableError";
  }
}

// --- Minimal GIS typings (only what we use) --------------------------------

interface CredentialResponse {
  credential: string; // Google-issued OIDC ID token (JWT)
}

interface GsiButtonOptions {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
}

/** Subset of the GIS moment notification we defensively read to decide whether
 *  the One Tap prompt actually opened (methods are best-effort — some are
 *  deprecated under FedCM, so every call site guards for their absence). */
interface PromptMomentNotification {
  isDisplayed?(): boolean;
  isNotDisplayed?(): boolean;
  isSkippedMoment?(): boolean;
  isDismissedMoment?(): boolean;
  getDismissedReason?(): string;
}

interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    ux_mode?: "popup" | "redirect";
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: GsiButtonOptions): void;
  prompt(momentListener?: (notification: PromptMomentNotification) => void): void;
  cancel(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

let scriptPromise: Promise<void> | null = null;

/** Load the GIS client script exactly once (idempotent across callers). */
export function loadGis(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Identity Services is unavailable during SSR"));
  }
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity Services")));
      if (window.google?.accounts?.id) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Initialise GIS + render the official button into `container`. `onCredential`
 * fires with the Google ID token when the user completes the popup; the caller
 * then hands it to {@link exchangeGoogleCredential}. Throws
 * {@link GoogleAuthUnavailableError} when no client id is configured.
 */
export async function renderGoogleButton(
  container: HTMLElement,
  onCredential: (googleIdToken: string) => void,
  theme: "dark" | "neon" = "dark",
): Promise<void> {
  if (!isGoogleConfigured) {
    throw new GoogleAuthUnavailableError("Google sign-in isn't configured (NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset).");
  }
  await loadGis();
  const accountsId = window.google?.accounts.id;
  if (!accountsId) throw new Error("Google Identity Services failed to initialise");

  accountsId.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => onCredential(response.credential),
    ux_mode: "popup",
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  container.replaceChildren(); // idempotent re-render
  accountsId.renderButton(container, {
    type: "standard",
    // filled_black reads correctly on both the Studio graphite and Neon black
    // surfaces; the brand button itself must stay Google-official (unrestyled).
    theme: theme === "neon" ? "filled_black" : "filled_black",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "center",
    width: 260,
  });
}

/**
 * Prime GIS for a CUSTOM sign-in button (V2-G Fix D). We render our own
 * DESIGN_SPEC-styled button rather than Google's `renderButton` (whose logo we
 * can't restyle and which can't show our "Waking…" working states), so we drive
 * the credential flow imperatively: `initialize` wires the callback, and a
 * later {@link promptGoogle} opens the account chooser. `onCredential` fires
 * with the Google ID token once the user picks an account. Throws
 * {@link GoogleAuthUnavailableError} when no client id is configured.
 */
export async function primeGoogle(onCredential: (googleIdToken: string) => void): Promise<void> {
  if (!isGoogleConfigured) {
    throw new GoogleAuthUnavailableError("Google sign-in isn't configured (NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset).");
  }
  await loadGis();
  const accountsId = window.google?.accounts.id;
  if (!accountsId) throw new Error("Google Identity Services failed to initialise");
  accountsId.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => onCredential(response.credential),
    auto_select: false,
    cancel_on_tap_outside: true,
    // FedCM is the modern, less cooldown-prone path for a programmatic prompt.
    use_fedcm_for_prompt: true,
  });
}

/**
 * Open the Google account chooser for a custom button (V2-G Fix D). Must be
 * called after {@link primeGoogle}. `onUnavailable` fires when the prompt could
 * not be shown or the user dismissed it WITHOUT choosing an account, so the
 * caller can reset its button out of the working state; the credential itself
 * still arrives via the `primeGoogle` callback on success.
 */
export function promptGoogle(onUnavailable?: () => void): void {
  const accountsId = window.google?.accounts?.id;
  if (!accountsId) {
    onUnavailable?.();
    return;
  }
  try {
    accountsId.prompt((notification) => {
      try {
        // A dismissal that returned a credential is the success path — the
        // `primeGoogle` callback handles it; do nothing here.
        if (notification.isDismissedMoment?.() && notification.getDismissedReason?.() === "credential_returned") {
          return;
        }
        const notShown =
          notification.isNotDisplayed?.() === true ||
          notification.isSkippedMoment?.() === true ||
          notification.isDismissedMoment?.() === true;
        if (notShown) onUnavailable?.();
      } catch {
        // FedCM hides these methods — rely on the credential callback instead.
      }
    });
  } catch {
    onUnavailable?.();
  }
}

/**
 * Exchange a Google ID token for our JWT (`POST /auth/google`, A2). A 503 means
 * the server has no Google client configured → local-only mode
 * ({@link GoogleAuthUnavailableError}); any other non-2xx is a real failure.
 * For sign-in from the app, prefer {@link wakeAndExchange} (lib/auth/wake) which
 * wraps this with the cold-start wake ladder + retries.
 */
export async function exchangeGoogleCredential(googleIdToken: string): Promise<AuthResponse> {
  const body: GoogleAuthRequest = { id_token: googleIdToken };
  const response = await fetch(`${API_BASE}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 503) {
    throw new GoogleAuthUnavailableError("Sign-in isn't configured on the server yet — continuing in local-only mode.");
  }
  if (!response.ok) {
    throw new Error(`Sign-in failed: HTTP ${response.status}`);
  }
  return (await response.json()) as AuthResponse;
}
