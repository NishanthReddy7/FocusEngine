"use client";

/**
 * Streak (DESIGN_SPEC §8, chart 3) — the dial's tick ring unrolled into 60 day
 * marks. Kept days (any focus session or daily review) are lit sage; gaps stay
 * hairline. The current streak is the mono headline.
 */
import type { DailyReview, FocusSession } from "@focusengine/schemas/entities";
import { addDays, dateToISODate } from "@/lib/recurrence/next";
import { InstrumentCard } from "./InstrumentCard";

const DAYS = 60;
const W = 600;
const H = 40;

export function StreakChart({ sessions, reviews }: { sessions: FocusSession[]; reviews: DailyReview[] }) {
  const today = dateToISODate(new Date());
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));

  const kept = new Set<string>();
  for (const s of sessions) if (s.started_at) kept.add(s.started_at.slice(0, 10));
  for (const r of reviews) kept.add(r.date);

  const flags = days.map((d) => kept.has(d));

  // Current streak: trailing run ending today, with a one-day grace so a not-
  // yet-worked today doesn't erase yesterday's streak.
  let streak = 0;
  let idx = DAYS - 1;
  if (!flags[idx] && flags[idx - 1]) idx -= 1;
  for (let i = idx; i >= 0 && flags[i]; i -= 1) streak += 1;

  const slot = W / DAYS;

  return (
    <InstrumentCard title="Streak" stat={`${streak} ${streak === 1 ? "day" : "days"}`} statNote="last 60 days">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Kept-day streak: ${streak} days`}>
        {flags.map((lit, i) => {
          const x = i * slot + slot / 2;
          return (
            <line
              key={i}
              x1={x}
              y1={8}
              x2={x}
              y2={32}
              strokeWidth={lit ? 2 : 1.5}
              strokeLinecap="round"
              stroke={lit ? "var(--break)" : "color-mix(in srgb, var(--text-muted) 30%, transparent)"}
            >
              <title>{`${days[i]}${lit ? " · kept" : ""}`}</title>
            </line>
          );
        })}
      </svg>
    </InstrumentCard>
  );
}
