"use client";

/**
 * Energy correlation (DESIGN_SPEC §8, chart 2) — a dot-strip: x is the hour a
 * session ran, y is the day's self-reported energy (1–5), dots carry the energy
 * hue, and a muted median line answers "when am I actually good." Each review is
 * joined to that day's focus session for its hour.
 */
import { EnergyLevel } from "@focusengine/schemas/enums";
import type { DailyReview, FocusSession } from "@focusengine/schemas/entities";
import { InstrumentCard } from "./InstrumentCard";

const W = 560;
const H = 176;
const LEFT = 24;
const RIGHT = 10;
const TOP = 12;
const BOTTOM = 26;
const HOUR_MIN = 6;
const HOUR_MAX = 22;

const ENERGY_COLOR: Record<EnergyLevel, string> = {
  [EnergyLevel.LOW]: "var(--energy-low)",
  [EnergyLevel.MEDIUM]: "var(--energy-medium)",
  [EnergyLevel.HIGH]: "var(--energy-high)",
};

function levelForScore(score: number): EnergyLevel {
  if (score <= 2) return EnergyLevel.LOW;
  if (score === 3) return EnergyLevel.MEDIUM;
  return EnergyLevel.HIGH;
}

interface Point {
  hour: number;
  energy: number;
  color: string;
}

export function EnergyCorrelationChart({
  sessions,
  reviews,
}: {
  sessions: FocusSession[];
  reviews: DailyReview[];
}) {
  const points: Point[] = [];
  for (const review of reviews) {
    const session = sessions.find((s) => (s.started_at ?? "").slice(0, 10) === review.date);
    if (!session?.started_at) continue;
    const hour = Number(session.started_at.slice(11, 13));
    if (Number.isNaN(hour)) continue;
    points.push({ hour, energy: review.energy_level, color: ENERGY_COLOR[levelForScore(review.energy_level)] });
  }

  const plotW = W - LEFT - RIGHT;
  const plotBottom = H - BOTTOM;
  const plotH = plotBottom - TOP;
  const xScale = (hour: number) => LEFT + ((Math.min(HOUR_MAX, Math.max(HOUR_MIN, hour)) - HOUR_MIN) / (HOUR_MAX - HOUR_MIN)) * plotW;
  const yScale = (energy: number) => TOP + (1 - (energy - 1) / 4) * plotH;

  const sortedEnergy = points.map((p) => p.energy).sort((a, b) => a - b);
  const median =
    sortedEnergy.length === 0
      ? 3
      : sortedEnergy.length % 2 === 1
        ? sortedEnergy[(sortedEnergy.length - 1) / 2] ?? 3
        : ((sortedEnergy[sortedEnergy.length / 2 - 1] ?? 3) + (sortedEnergy[sortedEnergy.length / 2] ?? 3)) / 2;

  // Peak = hour with the highest average energy (the headline read).
  const byHour = new Map<number, number[]>();
  for (const p of points) byHour.set(p.hour, [...(byHour.get(p.hour) ?? []), p.energy]);
  let peakHour: number | null = null;
  let peakAvg = -1;
  for (const [hour, vals] of byHour) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg > peakAvg) {
      peakAvg = avg;
      peakHour = hour;
    }
  }

  const hourTicks = [8, 12, 16, 20];

  return (
    <InstrumentCard
      title="Energy correlation"
      stat={peakHour === null ? "—" : `${String(peakHour).padStart(2, "0")}:00`}
      statNote="peak hour"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Self-reported energy by hour of day">
        {/* y guides at 1 and 5 */}
        {[1, 3, 5].map((v) => (
          <g key={v}>
            <line x1={LEFT} y1={yScale(v)} x2={W - RIGHT} y2={yScale(v)} stroke="var(--hairline)" strokeWidth="1" />
            <text x={LEFT - 6} y={yScale(v) + 3} textAnchor="end" className="font-mono" fontSize="10" fill="var(--text-muted)">
              {v}
            </text>
          </g>
        ))}

        {/* median line */}
        <line
          x1={LEFT}
          y1={yScale(median)}
          x2={W - RIGHT}
          y2={yScale(median)}
          stroke="var(--text-muted)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />

        {points.map((p, i) => (
          <circle key={i} cx={xScale(p.hour) + ((i % 3) - 1) * 2.5} cy={yScale(p.energy)} r={4} fill={p.color}>
            <title>{`${String(p.hour).padStart(2, "0")}:00 · energy ${p.energy}`}</title>
          </circle>
        ))}

        {hourTicks.map((h) => (
          <text key={h} x={xScale(h)} y={H - 8} textAnchor="middle" className="font-mono" fontSize="10" fill="var(--text-muted)">
            {String(h).padStart(2, "0")}
          </text>
        ))}
      </svg>
    </InstrumentCard>
  );
}
