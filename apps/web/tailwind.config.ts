import type { Config } from "tailwindcss";

/**
 * DESIGN_SPEC §3/§5 token wiring. Every colour is a CSS custom property defined
 * in globals.css under `.theme-dark` (Studio, default) and `.theme-neon`, so
 * swapping the class on <html> re-themes the whole app with zero per-component
 * change. Components reference ONLY these aliases — never a raw hex (§3).
 *
 * Alpha tints the spec calls for (priority chips at 15%, calendar blocks at
 * 12%, chart fills at 70%, the shield scrim at 96%, the Neon dial glow) are not
 * expressible as Tailwind opacity utilities over hex-valued vars, so those use
 * inline `color-mix(in srgb, var(--token) N%, transparent)` at the call site —
 * still token-derived, never a hard-coded colour.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        hairline: "var(--hairline)",
        ink: "var(--text)",
        muted: "var(--text-muted)",
        work: "var(--work)",
        break: "var(--break)",
        overdue: "var(--overdue)",
        p1: "var(--p1)",
        p2: "var(--p2)",
        p3: "var(--p3)",
        p4: "var(--p4)",
        "energy-low": "var(--energy-low)",
        "energy-medium": "var(--energy-medium)",
        "energy-high": "var(--energy-high)",
      },
      borderColor: {
        DEFAULT: "var(--hairline)",
        hairline: "var(--hairline)",
      },
      borderRadius: {
        // Nothing rounder than 10px (§5). Chips/inputs = 6px, cards = 10px.
        none: "0",
        sm: "6px",
        DEFAULT: "6px",
        md: "6px",
        lg: "10px",
        xl: "10px",
        full: "9999px",
      },
      fontFamily: {
        // next/font/google injects these variables (app/layout.tsx); the
        // system stacks keep an offline/first-paint build legible (§4).
        display: ["var(--font-display)", "Archivo", "system-ui", "sans-serif"],
        sans: ["var(--font-body)", "Instrument Sans", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        // Explicit scale (§4): 11 · 13 · 15 · 18 · 24 · 32.
        eyebrow: ["11px", { lineHeight: "1.2", letterSpacing: "0.14em" }],
        meta: ["11px", { lineHeight: "1.3" }],
        secondary: ["13px", { lineHeight: "1.5" }],
        body: ["15px", { lineHeight: "1.5" }],
        lg: ["18px", { lineHeight: "1.4" }],
        title: ["24px", { lineHeight: "1.2" }],
        heading: ["32px", { lineHeight: "1.1", letterSpacing: "-0.01em" }],
      },
      letterSpacing: {
        eyebrow: "0.14em",
        display: "-0.01em",
      },
      transitionTimingFunction: {
        // §7 motion: ease-out for entrances is the house default.
        instrument: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
