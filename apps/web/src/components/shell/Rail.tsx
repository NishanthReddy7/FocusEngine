"use client";

/**
 * Left icon rail (56px) — DESIGN_SPEC §5: wordmark glyph, Capture/Focus/Review
 * icons, theme toggle, sync status dot. On the Focus cockpit it collapses to an
 * 8px strip that expands on hover (§5), so the dial owns the screen.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CircleDot, Inbox, Settings, Timer, Zap, type LucideIcon } from "lucide-react";
import { useTheme } from "@/components/theme/ThemeProvider";
import { SyncDot } from "./SyncDot";
import { AccountChip } from "./AccountChip";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: readonly NavItem[] = [
  { href: "/", label: "Capture", icon: Inbox },
  { href: "/focus", label: "Focus", icon: Timer },
  { href: "/review", label: "Review", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** The wordmark glyph echoes the Session Dial: a hairline ring with a single
 *  lit tick at 12 o'clock. Brand and signature are the same object. */
function DialGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden fill="none">
      <circle cx="12" cy="12" r="9" stroke="var(--hairline)" strokeWidth="1.5" />
      <line x1="12" y1="2.5" x2="12" y2="6" stroke="var(--work)" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="var(--work)" />
    </svg>
  );
}

export function Rail({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className={`group fixed inset-y-0 left-0 z-40 ${collapsed ? "w-2" : "w-14"}`}>
      <div
        className={`flex h-full w-14 flex-col items-center border-r border-hairline bg-bg py-3 ${
          collapsed
            ? "-translate-x-12 transition-transform duration-200 ease-instrument group-hover:translate-x-0"
            : ""
        }`}
      >
        <Link
          href="/"
          aria-label="FocusEngine — capture"
          className="mb-4 flex h-9 w-9 items-center justify-center rounded-md"
        >
          <DialGlyph />
        </Link>

        <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Primary">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={label}
                className="relative flex h-10 w-10 items-center justify-center rounded-md transition-colors duration-150"
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-work"
                  />
                )}
                <Icon size={19} strokeWidth={1.75} className={active ? "text-ink" : "text-muted"} />
              </Link>
            );
          })}
        </nav>

        <div className="mt-2 flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to Neon theme" : "Switch to Studio theme"}
            title={theme === "dark" ? "Studio · switch to Neon" : "Neon · switch to Studio"}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:text-ink"
          >
            {theme === "dark" ? <CircleDot size={18} strokeWidth={1.75} /> : <Zap size={18} strokeWidth={1.75} />}
          </button>
          <SyncDot />
          <AccountChip />
        </div>
      </div>
    </div>
  );
}
