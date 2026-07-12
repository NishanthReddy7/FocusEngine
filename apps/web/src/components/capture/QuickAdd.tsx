"use client";

/**
 * QuickAdd hero — DESIGN_SPEC §5/§6. A 56px borderless `--surface` bar; as you
 * type, parsed tokens surface as live chips beneath it (date, priority, labels,
 * recurrence). Enter commits. `q` focuses it from anywhere; Esc blurs. Parsing
 * is the pure, synchronous `parseQuickAdd`, so chips update every keystroke with
 * no debounce.
 */
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Repeat } from "lucide-react";
import { Priority } from "@focusengine/schemas/enums";
import { parseQuickAdd } from "@/lib/nlp/parser";
import { createTaskFromParse } from "@/lib/db/repository";

const PLACEHOLDER = 'Try: "Review vulnerability report tomorrow at 4pm p1 #security"';

export function QuickAdd() {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => (value.trim() ? parseQuickAdd(value) : null), [value]);
  const hasChips = Boolean(
    parsed && (parsed.due || parsed.labels.length > 0 || parsed.recurrence || parsed.priority !== Priority.P4),
  );

  // `q` focuses the bar from anywhere (§6/§10); ignored while typing elsewhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "q") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await createTaskFromParse(parseQuickAdd(trimmed), trimmed);
      setValue("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <input
        ref={inputRef}
        id="quickadd-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") inputRef.current?.blur();
        }}
        placeholder={PLACEHOLDER}
        aria-label="Quick add a task"
        disabled={submitting}
        className="h-14 w-full rounded-lg bg-surface px-4 text-body text-ink outline-none transition-colors placeholder:text-muted"
      />

      {hasChips && parsed && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {parsed.due && (
            <span
              className="chip-in inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] text-ink"
              style={{ borderColor: "var(--work)" }}
            >
              <CalendarClock size={12} className="text-work" />
              {parsed.due.date}
              {parsed.due.time ? ` · ${parsed.due.time}` : ""}
            </span>
          )}

          {parsed.priority !== Priority.P4 && (
            <span
              className="chip-in inline-flex items-center rounded-md px-2 py-1 font-mono text-[11px] font-medium"
              style={{
                backgroundColor: `color-mix(in srgb, var(--p${parsed.priority}) 15%, transparent)`,
                color: `var(--p${parsed.priority})`,
              }}
            >
              P{parsed.priority}
            </span>
          )}

          {parsed.recurrence && (
            <span className="chip-in inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted">
              <Repeat size={11} className="text-work" />
              {parsed.recurrence.raw ?? parsed.recurrence.frequency}
            </span>
          )}

          {parsed.labels.map((label) => (
            <span
              key={label}
              className="chip-in inline-flex items-center rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted"
            >
              #{label}
            </span>
          ))}
        </div>
      )}
    </form>
  );
}
