import type { ReactNode } from "react";

/**
 * Instrument card (DESIGN_SPEC §8) — every Review chart sits in one: an eyebrow
 * title, a single mono headline stat, then the hand-rolled SVG. Elevation is a
 * surface step + hairline, never a shadow (§5).
 */
export function InstrumentCard({
  title,
  stat,
  statNote,
  className,
  children,
}: {
  title: string;
  stat?: string;
  statNote?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-4 ${className ?? ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow">{title}</h2>
        {statNote && <span className="font-mono text-[11px] text-muted">{statNote}</span>}
      </div>
      {stat && <p className="font-mono text-heading font-thin leading-none text-ink">{stat}</p>}
      {children}
    </section>
  );
}
