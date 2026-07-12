"use client";

/**
 * First-launch gate — shows {@link Onboarding} until `_meta.settings.onboarded`
 * is set (A6). Renders children immediately and only overlays onboarding once a
 * Dexie read confirms it's a first launch, so returning users never see a
 * flash. The standalone `/auth/*` handoff routes are never gated.
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { loadSettings } from "@/lib/settings";
import { Onboarding } from "./Onboarding";

export function OnboardingGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isStandalone = (pathname ?? "").startsWith("/auth");
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    if (isStandalone) {
      setNeedsOnboarding(false);
      return;
    }
    let active = true;
    void loadSettings().then((s) => {
      if (active) setNeedsOnboarding(!s.onboarded);
    });
    return () => {
      active = false;
    };
  }, [isStandalone]);

  return (
    <>
      {children}
      {needsOnboarding && !isStandalone && <Onboarding onDone={() => setNeedsOnboarding(false)} />}
    </>
  );
}
