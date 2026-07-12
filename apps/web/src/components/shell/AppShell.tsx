"use client";

/**
 * App shell — DESIGN_SPEC §5: 56px rail + collapsible 240px sidebar + content.
 *
 * Web flavor: at <768px the rail folds into a bottom tab bar and the sidebar is
 * hidden (§10 responsive). Mobile flavor (`NEXT_PUBLIC_PLATFORM=mobile`, A6):
 * the bottom tab bar is PERMANENT (Capture/Focus/Review/Settings) at every
 * width, the rail/sidebar are dropped entirely, and safe-area insets keep the
 * bar clear of the gesture area. The Focus cockpit does NOT use this shell — it
 * renders its own collapsed-rail layout so the dial owns the viewport.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Inbox, PanelLeft, Settings, Timer, type LucideIcon } from "lucide-react";
import { isMobileFlavor } from "@/lib/platform";
import { Rail } from "./Rail";

interface AppShellProps {
  /** Render-prop so the sidebar receives the collapse handler the shell owns. */
  renderSidebar?: (collapse: () => void) => ReactNode;
  children: ReactNode;
}

const MOBILE_NAV: ReadonlyArray<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/", label: "Capture", icon: Inbox },
  { href: "/focus", label: "Focus", icon: Timer },
  { href: "/review", label: "Review", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** `permanent` (mobile flavor) keeps the bar at every width and pads for the
 *  safe-area gesture bar; otherwise it is the <768px responsive fallback. Tabs
 *  are ≥44px touch targets (§10 / A6). */
function BottomTabBar({ permanent }: { permanent: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <nav
      aria-label="Primary"
      className={`fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-hairline bg-bg ${
        permanent ? "" : "h-16 md:hidden"
      }`}
      style={permanent ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
    >
      {MOBILE_NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center justify-center gap-1 ${permanent ? "min-h-[56px] py-2" : ""}`}
          >
            <Icon size={20} strokeWidth={1.75} className={active ? "text-work" : "text-muted"} />
            <span className={`text-[10px] ${active ? "text-ink" : "text-muted"}`}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ renderSidebar, children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Mobile flavor: no rail/sidebar, permanent bottom tabs, safe-area bottom pad.
  if (isMobileFlavor) {
    return (
      <>
        <div className="pb-tabbar min-h-dvh">{children}</div>
        <BottomTabBar permanent />
      </>
    );
  }

  const hasSidebar = Boolean(renderSidebar);
  const showSidebar = hasSidebar && !collapsed;

  return (
    <>
      <div className="hidden md:block">
        <Rail />
      </div>

      {showSidebar && (
        <div className="fixed inset-y-0 left-14 z-30 hidden md:block">
          {renderSidebar?.(() => setCollapsed(true))}
        </div>
      )}

      {hasSidebar && collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="fixed left-[68px] top-4 z-40 hidden h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface text-muted transition-colors hover:text-ink md:flex"
        >
          <PanelLeft size={15} strokeWidth={1.75} />
        </button>
      )}

      <div className={`min-h-dvh pb-16 md:pb-0 ${showSidebar ? "md:pl-[296px]" : "md:pl-14"}`}>{children}</div>

      <BottomTabBar permanent={false} />
    </>
  );
}
