"use client";

/**
 * TaskEditor — the full edit affordance for a task (V2-H Fix 3). `TaskEditorFields`
 * is the presentation-agnostic form (used inline in a desktop TaskRow); `TaskEditSheet`
 * wraps it in an overlay — a centered panel on desktop, a safe-area-padded bottom
 * sheet with 44px targets on the mobile flavor (V2_ADDENDUM A6) — for the Board /
 * Calendar entry points where an inline expansion doesn't fit.
 *
 * Editable per the spec: title, due date + time (both clearable), priority P1–P4
 * (the four ring hues), energy, estimated minutes, labels (chip add/remove), and
 * description. An existing recurrence shows as a read-only chip with the existing
 * "End recurrence" action. Save writes ONLY the changed fields through
 * `repository.updateEntity` (a sparse patch); Cancel / Esc discards. Copy is §9
 * register — "Save changes", sentence case, no exclamations.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Repeat, X } from "lucide-react";
import { EnergyLevel, Priority } from "@focusengine/schemas/enums";
import type { DueInfo, Task } from "@focusengine/schemas/entities";
import { updateEntity, type EntityPatch } from "@/lib/db/repository";
import { isMobileFlavor } from "@/lib/platform";

const PRIORITIES: readonly Priority[] = [Priority.P1, Priority.P2, Priority.P3, Priority.P4];
const ENERGIES: readonly EnergyLevel[] = [EnergyLevel.LOW, EnergyLevel.MEDIUM, EnergyLevel.HIGH];
const ENERGY_LABEL: Record<EnergyLevel, string> = {
  [EnergyLevel.LOW]: "Low",
  [EnergyLevel.MEDIUM]: "Medium",
  [EnergyLevel.HIGH]: "High",
};

function normalizeLabel(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase();
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((label, i) => label === sortedB[i]);
}

function buildDue(task: Task, date: string, time: string): DueInfo | null {
  if (!date) return null;
  return {
    date,
    time: time ? time : null,
    timezone: task.due?.timezone ?? "UTC",
    recurrence: task.due?.recurrence ?? null,
  };
}

function sameDue(orig: DueInfo | null, next: DueInfo | null): boolean {
  if (!orig && !next) return true;
  if (!orig || !next) return false;
  return (
    orig.date === next.date &&
    (orig.time ?? null) === (next.time ?? null) &&
    JSON.stringify(orig.recurrence ?? null) === JSON.stringify(next.recurrence ?? null)
  );
}

export function TaskEditorFields({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [date, setDate] = useState(task.due?.date ?? "");
  const [time, setTime] = useState(task.due?.time ?? "");
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [energy, setEnergy] = useState<EnergyLevel>(task.energy_required);
  const [estimate, setEstimate] = useState(task.estimated_minutes != null ? String(task.estimated_minutes) : "");
  const [labels, setLabels] = useState<string[]>(task.labels);
  const [labelDraft, setLabelDraft] = useState("");

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const recurrence = task.due?.recurrence ?? null;

  const patch = useMemo<EntityPatch<"tasks">>(() => {
    const next: EntityPatch<"tasks"> = {};
    const trimmedTitle = title.trim();
    if (trimmedTitle && trimmedTitle !== task.title) next.title = trimmedTitle;
    if (description !== task.description) next.description = description;
    if (priority !== task.priority) next.priority = priority;
    if (energy !== task.energy_required) next.energy_required = energy;

    const parsedEst = parseInt(estimate, 10);
    const est = Number.isFinite(parsedEst) && parsedEst > 0 ? parsedEst : null;
    if (est !== (task.estimated_minutes ?? null)) next.estimated_minutes = est;

    if (!sameLabels(labels, task.labels)) next.labels = labels;

    const newDue = buildDue(task, date, time);
    if (!sameDue(task.due, newDue)) next.due = newDue;

    return next;
  }, [title, description, priority, energy, estimate, labels, date, time, task]);

  const dirty = Object.keys(patch).length > 0;
  const canSave = title.trim().length > 0 && dirty;

  async function save() {
    if (!title.trim()) return;
    await updateEntity("tasks", task.id, patch);
    onClose();
  }

  function addLabelFromDraft() {
    const clean = normalizeLabel(labelDraft);
    if (!clean) return;
    if (!labels.includes(clean)) setLabels((prev) => [...prev, clean]);
    setLabelDraft("");
  }

  function removeLabel(label: string) {
    setLabels((prev) => prev.filter((l) => l !== label));
  }

  function endRecurrence() {
    if (!task.due) return;
    void updateEntity("tasks", task.id, { due: { ...task.due, recurrence: null } });
    onClose();
  }

  const fieldClass = `w-full rounded-md border border-hairline bg-surface-2 px-2.5 text-body text-ink outline-none placeholder:text-muted ${
    isMobileFlavor ? "min-h-11 py-2.5" : "py-2"
  }`;
  const segBtn = `flex-1 rounded-md border border-hairline text-secondary transition-colors ${
    isMobileFlavor ? "min-h-11 py-2" : "py-1.5"
  }`;

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex flex-col gap-4"
    >
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Title</span>
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Task title"
          className={fieldClass}
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
          <span className="eyebrow">Due date</span>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Due date"
              className={fieldClass}
            />
            {date && (
              <button
                type="button"
                onClick={() => {
                  setDate("");
                  setTime("");
                }}
                aria-label="Clear due date"
                className={`shrink-0 rounded-md px-2 text-muted transition-colors hover:text-ink ${
                  isMobileFlavor ? "min-h-11 min-w-11" : "py-2"
                }`}
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </label>

        <label className="flex min-w-[7rem] flex-1 flex-col gap-1">
          <span className="eyebrow">Due time</span>
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={!date}
              aria-label="Due time"
              className={`${fieldClass} disabled:cursor-not-allowed disabled:opacity-50`}
            />
            {time && (
              <button
                type="button"
                onClick={() => setTime("")}
                aria-label="Clear due time"
                className={`shrink-0 rounded-md px-2 text-muted transition-colors hover:text-ink ${
                  isMobileFlavor ? "min-h-11 min-w-11" : "py-2"
                }`}
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <span className="eyebrow">Priority</span>
        <div role="radiogroup" aria-label="Priority" className="flex gap-1.5">
          {PRIORITIES.map((p) => {
            const selected = p === priority;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPriority(p)}
                className={`${segBtn} font-mono`}
                style={
                  selected
                    ? {
                        backgroundColor: `color-mix(in srgb, var(--p${p}) 15%, transparent)`,
                        color: `var(--p${p})`,
                        borderColor: `var(--p${p})`,
                      }
                    : { color: "var(--text-muted)" }
                }
              >
                P{p}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="eyebrow">Energy</span>
        <div role="radiogroup" aria-label="Energy" className="flex gap-1.5">
          {ENERGIES.map((level) => {
            const selected = level === energy;
            const hue = `var(--energy-${level})`;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setEnergy(level)}
                className={segBtn}
                style={
                  selected
                    ? { backgroundColor: `color-mix(in srgb, ${hue} 15%, transparent)`, color: hue, borderColor: hue }
                    : { color: "var(--text-muted)" }
                }
              >
                {ENERGY_LABEL[level]}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="eyebrow">Estimated minutes</span>
        <input
          type="number"
          min={1}
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          placeholder="—"
          aria-label="Estimated minutes"
          className={fieldClass}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">Labels</span>
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted"
              >
                #{label}
                <button
                  type="button"
                  onClick={() => removeLabel(label)}
                  aria-label={`Remove label ${label}`}
                  className="text-muted transition-colors hover:text-overdue"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addLabelFromDraft();
            }
          }}
          placeholder="Add a label, press Enter"
          aria-label="Add label"
          className={fieldClass}
        />
      </div>

      <label className="flex flex-col gap-1">
        <span className="eyebrow">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          aria-label="Description"
          className={`${fieldClass} resize-y`}
        />
      </label>

      {recurrence && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-surface px-2.5 py-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Repeat size={11} className="text-work" />
            {recurrence.raw ?? recurrence.frequency}
          </span>
          <button
            type="button"
            onClick={endRecurrence}
            className={`rounded-md px-2 text-secondary text-muted transition-colors hover:text-ink ${
              isMobileFlavor ? "min-h-11" : "py-1"
            }`}
          >
            End recurrence
          </button>
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className={`rounded-md px-3 text-secondary text-muted transition-colors hover:text-ink ${
            isMobileFlavor ? "min-h-11" : "py-1.5"
          }`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className={`rounded-md bg-surface-2 px-3 text-secondary text-work transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:text-muted ${
            isMobileFlavor ? "min-h-11" : "py-1.5"
          }`}
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

/** Overlay wrapper for the Board / Calendar entry points and the mobile TaskRow:
 *  a centered panel on desktop, a bottom sheet on the mobile flavor (A6). */
export function TaskEditSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${task.title}`}
      className={`fixed inset-0 z-50 flex ${isMobileFlavor ? "items-end" : "items-center justify-center p-4"}`}
      style={{ backgroundColor: "color-mix(in srgb, var(--bg) 78%, transparent)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={
          isMobileFlavor
            ? "max-h-[88dvh] w-full overflow-y-auto rounded-t-[10px] border-t border-hairline bg-surface px-4 pt-4"
            : "max-h-[86vh] w-full max-w-lg overflow-y-auto rounded-lg border border-hairline bg-surface p-5"
        }
        style={
          isMobileFlavor
            ? { paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }
            : undefined
        }
      >
        {isMobileFlavor && <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-surface-2" />}
        <p className="eyebrow mb-3">Edit task</p>
        <TaskEditorFields task={task} onClose={onClose} />
      </div>
    </div>
  );
}
