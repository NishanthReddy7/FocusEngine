"use client";

/**
 * TaskRow — DESIGN_SPEC §6. Priority-ring checkbox (2px ring in the priority
 * hue, fills on hover, check animates in), a 15px title, and an 11px mono meta
 * row (due — overdue in the overdue hue —, labels, an energy glyph, accumulated
 * focus time). Hovering washes the row in `--surface` and reveals a Play button
 * that starts a focus session on this task: the capture → focus bridge.
 */
import { useState } from "react";
import { Check, MoreHorizontal, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { EnergyLevel, Priority, TaskStatus } from "@focusengine/schemas/enums";
import type { Task } from "@focusengine/schemas/entities";
import { completeTask, updateEntity } from "@/lib/db/repository";
import { setPendingFocusTask } from "@/lib/focus/handoff";
import { isMobileFlavor } from "@/lib/platform";
import { todayISO } from "./scope";

// Mobile flavor (A6): row affordances are never hover-gated — the Play + ⋯
// buttons are always visible and ≥44px. Web flavor keeps the quiet hover reveal.
const ACTION_BTN = isMobileFlavor
  ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-100 transition-colors duration-150"
  : "flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-0 transition-all duration-150 focus-visible:opacity-100 group-hover:opacity-100";

/** Clears the recurrence rule so the next `completeTask` finishes the series
 *  for good instead of rolling it forward — the affordance for the
 *  legitimately-infinite case (no `count`/`until`, ARCHITECTURE.md §4.5). */
function endRecurrence(task: Task): void {
  if (!task.due) return;
  void updateEntity("tasks", task.id, { due: { ...task.due, recurrence: null } });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const ENERGY_GLYPH: Record<EnergyLevel, string> = {
  [EnergyLevel.LOW]: "▁",
  [EnergyLevel.MEDIUM]: "▃",
  [EnergyLevel.HIGH]: "▅",
};
const ENERGY_COLOR: Record<EnergyLevel, string> = {
  [EnergyLevel.LOW]: "var(--energy-low)",
  [EnergyLevel.MEDIUM]: "var(--energy-medium)",
  [EnergyLevel.HIGH]: "var(--energy-high)",
};

function formatDueDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

/** "1h 20m" / "20m" / "45s"; null when nothing has been logged. */
function formatFocus(seconds: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function TaskRow({ task }: { task: Task }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const completed = task.status === TaskStatus.COMPLETED;
  const priorityColor = `var(--p${task.priority})`;
  const showPriorityRing = task.priority !== Priority.P4; // P4 is the quiet default
  const isRecurring = !completed && task.due?.recurrence != null;

  const focusLabel = formatFocus(task.actual_focus_seconds ?? 0);
  const isOverdue = !completed && task.due !== null && task.due.date < todayISO();

  function toFocus() {
    setPendingFocusTask(task.id);
    router.push("/focus");
  }

  return (
    <li className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-surface">
      <button
        type="button"
        onClick={() => !completed && void completeTask(task.id)}
        aria-label={completed ? "Completed" : "Complete task"}
        aria-pressed={completed}
        className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-200"
        style={{
          borderColor: showPriorityRing ? priorityColor : "var(--text-muted)",
          backgroundColor: completed ? priorityColor : "transparent",
        }}
      >
        {completed ? (
          <Check size={11} strokeWidth={3} style={{ color: "var(--bg)" }} />
        ) : (
          <span
            aria-hidden
            className="h-2 w-2 scale-0 rounded-full transition-transform duration-200 group-hover:scale-100"
            style={{ backgroundColor: "var(--work)" }}
          />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className={`truncate text-body ${completed ? "text-muted line-through" : "text-ink"}`}>{task.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-muted">
          {task.due && (
            <span style={isOverdue ? { color: "var(--overdue)" } : undefined}>
              {formatDueDate(task.due.date)}
              {task.due.time ? ` ${task.due.time}` : ""}
            </span>
          )}
          <span aria-label={`Energy ${task.energy_required}`} style={{ color: ENERGY_COLOR[task.energy_required] }}>
            {ENERGY_GLYPH[task.energy_required]}
          </span>
          {task.labels.map((label) => (
            <span key={label}>#{label}</span>
          ))}
          {focusLabel && <span className="text-muted">{focusLabel}</span>}
        </div>
      </div>

      {!completed && (
        <button
          type="button"
          onClick={toFocus}
          aria-label={`Focus on ${task.title}`}
          title="Start a focus session"
          className={`${ACTION_BTN} text-muted hover:text-work`}
        >
          <Play size={15} strokeWidth={1.75} />
        </button>
      )}

      {isRecurring && (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Task options"
            aria-expanded={menuOpen}
            title="Task options"
            className={`${ACTION_BTN} text-muted hover:text-ink`}
          >
            <MoreHorizontal size={15} strokeWidth={1.75} />
          </button>

          {menuOpen && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div className="absolute right-0 top-full z-20 mt-1 min-w-40 overflow-hidden rounded-md border border-hairline bg-surface-2 py-1">
                <button
                  type="button"
                  onClick={() => {
                    endRecurrence(task);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-secondary text-muted transition-colors hover:bg-surface hover:text-ink"
                >
                  End recurrence
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
