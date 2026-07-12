import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Archivo, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { AuthProvider } from "@/lib/auth/provider";
import { AuthOverlays } from "@/components/auth/AuthOverlays";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";
import "./globals.css";

/**
 * Typography — DESIGN_SPEC §4. Loaded via `next/font/google` with
 * `display: "swap"` and system fallbacks so a first paint (or a cached offline
 * build) stays legible. Each face exposes a CSS variable that
 * tailwind.config.ts's fontFamily reads.
 *  - Archivo  → display / eyebrows / wordmark
 *  - Instrument Sans → body / UI / task titles
 *  - IBM Plex Mono (200/400) → timer digits, durations, counts, chart labels
 */
const displayFont = Archivo({
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
  variable: "--font-display",
  fallback: ["system-ui", "Segoe UI", "sans-serif"],
});

const bodyFont = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-body",
  fallback: ["system-ui", "Segoe UI", "sans-serif"],
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["200", "400"],
  display: "swap",
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

/** Build flavor stamped on <html> so CSS can target the Capacitor mobile build
 *  (A6). A build-time constant, so SSR and client agree. */
const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM === "mobile" ? "mobile" : "web";

export const metadata: Metadata = {
  title: "FocusEngine",
  description: "A precision instrument for attention — capture, focus, review over one local-first data model.",
};

/** `viewport-fit=cover` lets `env(safe-area-inset-*)` resolve on notched
 *  devices (A6). Zoom is never disabled (§10 / a11y). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#111013", // Studio --bg; the native status bar is tinted per-theme in V2-D
};

/**
 * Root layout — the app shell's outermost frame. Kept a Server Component so
 * `metadata` stays valid. `ThemeProvider` applies the persisted DESIGN_SPEC §3
 * theme on hydrate; `AuthProvider` restores the session and owns the token;
 * `OnboardingGate` runs the first-launch flow. `theme-dark` (Studio) is the SSR
 * default.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-platform={PLATFORM}
      className={`theme-dark ${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <body className="min-h-dvh bg-bg font-sans text-ink antialiased">
        <ThemeProvider>
          <AuthProvider>
            <OnboardingGate>{children}</OnboardingGate>
            <AuthOverlays />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
