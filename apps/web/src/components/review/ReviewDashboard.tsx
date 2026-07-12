"use client";

/**
 * Review dashboard (DESIGN_SPEC §5/§8) — a grid of instrument cards (three
 * hand-rolled SVG charts + the evening check-in), all off live Dexie queries.
 * With no data it shows the §8 empty state plus a dev-only "Seed demo data"
 * trigger. Elevation is surface + hairline, never a shadow.
 */
import { useState } from "react";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { dateToISODate } from "@/lib/recurrence/next";
import { seedDemoData } from "@/lib/dev/seed";
import { FocusCompletionChart } from "./FocusCompletionChart";
import { EnergyCorrelationChart } from "./EnergyCorrelationChart";
import { StreakChart } from "./StreakChart";
import { CheckInCard } from "./CheckInCard";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dateEyebrow(): string {
  const now = new Date();
  return `${WEEKDAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

export function ReviewDashboard() {
  const sessions = useLiveQuery("focus_sessions", (rows) => rows);
  const reviews = useLiveQuery("daily_reviews", (rows) => rows);
  const [seeding, setSeeding] = useState(false);

  const isDev = process.env.NODE_ENV !== "production";

  // Dexie live queries are undefined until the first read resolves.
  if (sessions === undefined || reviews === undefined) return null;

  const today = dateToISODate(new Date());
  const todayReview = reviews.find((r) => r.date === today);
  const hasData = sessions.length > 0 || reviews.length > 0;

  async function seed() {
    setSeeding(true);
    try {
      await seedDemoData();
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-baseline gap-3">
        <h1 className="font-display text-title font-semibold tracking-[-0.01em] text-ink">Review</h1>
        <span className="eyebrow">{dateEyebrow()}</span>
      </header>

      {!hasData ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-hairline bg-surface p-6">
          <p className="text-secondary text-muted">No focus logged yet. Run a session, or fill in a check-in below.</p>
          {isDev && (
            <button
              type="button"
              onClick={() => void seed()}
              disabled={seeding}
              className="rounded-md text-secondary text-work transition-colors duration-150 hover:underline disabled:cursor-not-allowed"
            >
              {seeding ? "Seeding" : "Seed demo data"}
            </button>
          )}
          <div className="w-full max-w-md">
            <CheckInCard todayReview={todayReview} />
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <FocusCompletionChart sessions={sessions} reviews={reviews} />
            </div>
            <EnergyCorrelationChart sessions={sessions} reviews={reviews} />
            <CheckInCard todayReview={todayReview} />
            <div className="lg:col-span-2">
              <StreakChart sessions={sessions} reviews={reviews} />
            </div>
          </div>

          {isDev && (
            <button
              type="button"
              onClick={() => void seed()}
              disabled={seeding}
              className="self-start font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed"
            >
              {seeding ? "Seeding demo data" : "Seed demo data"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
