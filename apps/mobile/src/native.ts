/**
 * apps/mobile/src/native.ts
 *
 * Capacitor plugin wiring for FocusEngine's mobile shell.
 *
 * INTEGRATION BOUNDARY (read before wiring this into apps/web)
 * -----------------------------------------------------------------------
 * This file lives in the @focusengine/mobile package, not apps/web, because
 * this task (V2-D) is scoped to apps/mobile/** + .github/workflows/** only —
 * it must not modify apps/web/src while the web workstream builds concurrently.
 * The web app's mobile flavor (NEXT_PUBLIC_PLATFORM=mobile) is the intended
 * CONSUMER of these helpers, but that wiring is deliberately NOT done here.
 * This module has zero imports from apps/web, so the dependency direction
 * stays one-way and nothing here is coupled to web internals that might
 * still be in flux.
 *
 * For whoever wires this up next (a later web/integration pass):
 *   1. Add "@focusengine/mobile": "*" to apps/web/package.json dependencies
 *      (npm workspace-resolved — apps/mobile is already a sibling workspace
 *      per the root package.json "workspaces" array).
 *   2. Import from '@focusengine/mobile/src/native' in:
 *        - the root layout / app shell: call initNative(bgHex, isDarkBg) once
 *          on mount to tint the Android status bar to the active theme's
 *          --bg (docs/V2_ADDENDUM.md A6) and re-call it on theme toggle.
 *        - the focus session controller: call hapticImpact(moment) on
 *          session start, session complete, and cycle change ONLY (A6:
 *          "nothing elsewhere — instrument restraint"). Do not add haptics
 *          to any other interaction.
 *        - wherever "Sign in" is invoked in the mobile flavor: call
 *          openAuthInSystemBrowser(baseUrl) instead of running Google
 *          Identity Services in-WebView (GIS is blocked inside WebViews —
 *          A2's "Mobile sign-in" contract).
 *        - the app entry point (mounted once, e.g. root layout effect):
 *          call onAuthDeepLink(handler) to catch the
 *          focusengine://auth#token=<jwt>&user=<b64 json> redirect and hand
 *          the parsed { token, user } to the existing auth provider (the
 *          same shape POST /auth/google already returns).
 *
 * Every export below no-ops safely when not running under Capacitor (the
 * underlying @capacitor/* packages ship web implementations), so importing
 * this module from a plain browser build is not harmful — but it is only
 * MEANINGFUL in the mobile-flavored build running inside the Android WebView.
 */

import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';

/** True only inside the compiled Android (or future iOS) app shell. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * One-time-per-theme-change native setup: call from the app shell whenever
 * the active theme's --bg is known/changes. Tints the Android status bar to
 * match and sets its foreground (icons/text) style accordingly. Safe no-op
 * on web.
 *
 * @param bgHex    the resolved --bg custom property value, e.g. "#111013"
 *                 (Studio) or "#000000" (Neon) — see DESIGN_SPEC.md §3.
 * @param isDarkBg whether that background is dark (both current themes are;
 *                 parameterized rather than hard-coded for future themes).
 */
export async function initNative(bgHex: string, isDarkBg: boolean): Promise<void> {
  if (!isNativePlatform()) return;
  await StatusBar.setBackgroundColor({ color: bgHex });
  await StatusBar.setStyle({ style: isDarkBg ? Style.Dark : Style.Light });
}

export interface AuthDeepLinkResult {
  token: string;
  user: unknown;
}

/**
 * Deep-link auth capture (docs/V2_ADDENDUM.md A2 "Mobile sign-in"): the
 * system browser redirects to focusengine://auth#token=<jwt>&user=<b64 json>
 * after Google Identity Services completes on the hosted /auth/mobile page.
 * Capacitor's App plugin surfaces that as an `appUrlOpen` event carrying the
 * full URL string; this helper parses it and only invokes the callback for
 * the `focusengine://auth` scheme+host, ignoring anything else the OS might
 * route in. Returns an unsubscribe function.
 */
export function onAuthDeepLink(callback: (result: AuthDeepLinkResult) => void): () => void {
  const listenerPromise = App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
    let parsed: URL;
    try {
      parsed = new URL(event.url);
    } catch {
      return; // not a well-formed URL — ignore rather than throw
    }
    // focusengine://auth#token=...&user=... -> protocol "focusengine:", hostname "auth"
    if (parsed.protocol !== 'focusengine:' || parsed.hostname !== 'auth') return;

    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const token = fragment.get('token');
    const userB64 = fragment.get('user');
    if (!token || !userB64) return;

    let user: unknown;
    try {
      user = JSON.parse(atob(userB64));
    } catch {
      return; // malformed payload — drop rather than crash the listener
    }
    callback({ token, user });
  });

  return () => {
    void listenerPromise.then((handle) => handle.remove());
  };
}

/**
 * Opens the hosted web app's /auth/mobile page in the SYSTEM browser (never
 * the in-app WebView — Google blocks OAuth inside WebViews). `baseUrl` is the
 * deployed Pages origin, e.g. "https://nishanthreddy7.github.io/FocusEngine".
 */
export async function openAuthInSystemBrowser(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/auth/mobile`;
  if (!isNativePlatform()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await Browser.open({ url });
}

export type HapticMoment = 'session-start' | 'session-complete' | 'cycle-change';

/**
 * Light impact haptic for exactly the three moments A6 calls out — nowhere
 * else ("instrument restraint"). Callers gate on those moments; this
 * function does not — it fires whenever called.
 */
export async function hapticImpact(_moment: HapticMoment): Promise<void> {
  if (!isNativePlatform()) return;
  await Haptics.impact({ style: ImpactStyle.Light });
}
