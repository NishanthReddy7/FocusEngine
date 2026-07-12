"use client";

/**
 * Focus vs. completion, 14 days (DESIGN_SPEC §8, chart 1) — a dual-encoding
 * column chart: bars are focus hours (work amber), an overlaid dot-line is
 * tasks completed (ink). Today's column is full opacity. Per the dataviz skill
 * there is only ONE drawn axis (the hairline baseline); the second measure is
 * shown as a distinct mark type with a legend and native hover, not a competing
 * second y-scale.
 */
import type { DailyReview, FocusSession } from "@focusengine/schemas/entities";
import { addDays, dateToISODate } from "@/lib/recurrence/next";
import { InstrumentCard } from "./InstrumentCard";

const DAYS = 14;
const W = 560;
const H = 176;
const PAD_X = 10;
const PAD_TOP = 14;
const BASELINE = 150;
const PLOT_H = BASELINE - PAD_TOP;

function lastDays(): string[] {
  const today = dateToISODate(new Date());
  return Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));
}

export function FocusCompletionChart({
  sessions,
  reviews,
}: {
  sessions: FocusSession[];
  reviews: DailyReview[];
}) {
  const days = lastDays();
  const today = days[DAYS - 1];

  const focusHours = days.map(
    (d) => sessions.filter((s) => (s.started_at ?? "").slice(0, 10) === d).reduce((sum, s) => sum + s.work_seconds, 0) / 3600,
  );
  const completed = days.map((d) => reviews.find((r) => r.date === d)?.tasks_completed ?? 0);

  const totalHours = focusHours.reduce((a, b) => a + b, 0);
  const focusMax = Math.max(0.5, ...focusHours);
  const compMax = Math.max(1, ...completed);

  const slot = (W - PAD_X * 2) / DAYS;
  const barW = slot * 0.46;
  const cx = (i: number) => PAD_X + i * slot + slot / 2;

  const linePoints = completed
    .map((c, i) => `${cx(i).toFixed(1)},${(BASELINE - (c / compMax) * PLOT_H).toFixed(1)}`)
    .join(" ");

  return (
    <InstrumentCard title="Focus vs. completion" stat={`${totalHours.toFixed(1)}h`} statNote="14 days">
      <div className="flex items-center gap-4 font-mono text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2 rounded-[1px]" style={{ backgroundColor: "var(--work)" }} />
          focus hrs
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--text)" }} />
          tasks done
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Focus hours and tasks completed over ${DAYS} days`}>
        {/* baseline (the one axis) */}
        <line x1={PAD_X} y1={BASELINE} x2={W - PAD_X} y2={BASELINE} stroke="var(--hairline)" strokeWidth="1" />

        {focusHours.map((h, i) => {
          const barH = (h / focusMax) * PLOT_H;
          const isToday = days[i] === today;
          return (
            <rect
              key={i}
              x={cx(i) - barW / 2}
              y={BASELINE - barH}
              width={barW}
              height={Math.max(0, barH)}
              rx={2}
              fill={isToday ? "var(--work)" : "color-mix(in srgb, var(--work) 70%, transparent)"}
            >
              <title>{`${days[i]} · ${h.toFixed(1)}h · ${completed[i]} done`}</title>
            </rect>
          );
        })}

        {/* completion dot-line (second measure, no second axis) */}
        <polyline points={linePoints} fill="none" stroke="var(--text)" strokeWidth="1.25" opacity="0.55" />
        {completed.map((c, i) => (
          <circle key={i} cx={cx(i)} cy={BASELINE - (c / compMax) * PLOT_H} r={2.5} fill="var(--text)" />
        ))}

        {/* sparse x labels — day of month */}
        {days.map((d, i) =>
          i % 2 === 0 ? (
            <text
              key={d}
              x={cx(i)}
              y={H - 6}
              textAnchor="middle"
              className="font-mono"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {Number(d.slice(8, 10))}
            </text>
          ) : null,
        )}
      </svg>
    </InstrumentCard>
  );
}
