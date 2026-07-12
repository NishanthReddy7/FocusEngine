"use client";

/**
 * Theme state — DESIGN_SPEC §3. "Studio" (`theme-dark`) is the default; the
 * rail toggle flips to `theme-neon`. The choice persists to `_meta.theme` via
 * the repository (never a component writing Dexie directly) and is re-applied
 * on load. One provider is the single source of truth so the rail toggle and
 * any other consumer stay in lockstep.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getMeta, setMeta } from "@/lib/db/repository";

export type Theme = "dark" | "neon";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyThemeClass(theme: Theme): void {
  const el = document.documentElement;
  el.classList.remove("theme-dark", "theme-neon");
  el.classList.add(`theme-${theme}`);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR renders Studio (matches the `theme-dark` class the layout stamps on
  // <html>); if the user picked Neon, the effect below swaps it on hydrate.
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    let active = true;
    void getMeta<Theme>("theme").then((persisted) => {
      if (!active) return;
      const next: Theme = persisted === "neon" ? "neon" : "dark";
      setThemeState(next);
      applyThemeClass(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyThemeClass(next);
    void setMeta("theme", next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === "dark" ? "neon" : "dark";
      applyThemeClass(next);
      void setMeta("theme", next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
