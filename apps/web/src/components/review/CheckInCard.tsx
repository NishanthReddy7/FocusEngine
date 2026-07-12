"use client";

/**
 * Evening check-in (DESIGN_SPEC §8) — the daily review, local-first: it upserts
 * today's `daily_review` into Dexie immediately (so the charts move and it works
 * offline), then best-effort calls `/insights/daily-review` for the canned
 * coaching line. Voice per §9: plain verbs, sentence case, no exclamation.
 */
import { type FormEvent, useState } from "react";
import type { DailyReview } from "@focusengine/schemas/entities";
import { createEntity, updateEntity } from "@/lib/db/repository";
import { authHeader } from "@/lib/auth/token";
import { dateToISODate } from "@/lib/recurrence/next";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const ENERGY_SCALE = [1, 2, 3, 4, 5] as const;

export function CheckInCard({ todayReview }: { todayReview?: DailyReview }) {
  const [energy, setEnergy] = useState<number>(todayReview?.energy_level ?? 3);
  const [mood, setMood] = useState(todayReview?.mood ?? "");
  const [highlights, setHighlights] = useState(todayReview?.highlights ?? "");
  const [friction, setFriction] = useState(todayReview?.friction ?? "");
  const [feedback, setFeedback] = useState<string | null>(todayReview?.ai_feedback ?? null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setFeedback(null);

    const today = dateToISODate(new Date());
    const patch = {
      energy_level: energy,
      mood: mood.trim() || null,
      highlights: highlights.trim(),
      friction: friction.trim(),
    };

    // Local-first: persist before touching the network.
    if (todayReview) {
      await updateEntity("daily_reviews", todayReview.id, patch);
    } else {
      await createEntity("daily_reviews", {
        date: today,
        focus_seconds: 0,
        tasks_completed: 0,
        ai_feedback: null,
        ...patch,
      });
    }
    setStatus("saved");

    // Best-effort coaching line — never blocks the save, silent when offline.
    try {
      const res = await fetch(`${API_BASE}/insights/daily-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ date: today, ...patch }),
      });
      if (res.ok) {
        const body = (await res.json()) as { ai_feedback: string | null };
        if (body.ai_feedback) setFeedback(body.ai_feedback);
      }
    } catch {
      // Offline — the review is already saved locally; coaching syncs later.
    }
  }

  const field = "rounded-md bg-surface-2 px-3 py-2 text-body text-ink outline-none placeholder:text-muted";

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="eyebrow">Evening check-in</h2>
        {status === "saved" && <span className="font-mono text-[11px] text-break">Saved</span>}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-secondary text-muted">Energy</span>
          <div role="radiogroup" aria-label="Energy 1 to 5" className="flex gap-1.5">
            {ENERGY_SCALE.map((value) => {
              const selected = energy === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setEnergy(value)}
                  className={`h-9 flex-1 rounded-md border font-mono text-secondary transition-colors duration-150 ${
                    selected ? "border-transparent bg-surface-2 text-work" : "border-hairline text-muted hover:text-ink"
                  }`}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-secondary text-muted">Highlights</span>
          <textarea
            value={highlights}
            onChange={(e) => setHighlights(e.target.value)}
            placeholder="What moved forward today"
            className={`min-h-16 ${field}`}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-secondary text-muted">Friction</span>
          <textarea
            value={friction}
            onChange={(e) => setFriction(e.target.value)}
            placeholder="What got in the way"
            className={`min-h-16 ${field}`}
          />
        </label>

        <button
          type="submit"
          disabled={status === "saving"}
          className="self-start rounded-md px-4 py-2 text-secondary text-work transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed"
        >
          {status === "saving" ? "Saving" : "Save check-in"}
        </button>
      </form>

      {feedback && (
        <p className="rounded-md bg-surface-2 p-3 text-secondary text-ink">{feedback}</p>
      )}
    </section>
  );
}
