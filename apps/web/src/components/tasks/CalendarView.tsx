"use client";

/**
 * CalendarView — DESIGN_SPEC §6. A 7-day week grid on 1px hairlines, hour rows
 * 07–22, an all-day row on top, timed tasks as blocks tinted by priority at 12%
 * alpha, and a `--work` hairline highlight on today's column.
 */
import type { Task } from "@focusengine/schemas/entities";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { addDays, isoWeekdayOf } from "@/lib/recurrence/next";
import { todayISO, type Scope } from "./scope";

const WEEKDAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HOURS = Array.from({ length: 16 }, (_, i) => i + 7); // 07:00 – 22:00
const GRID_TEMPLATE = "44px repeat(7, minmax(0, 1fr))";

function mondayOfWeek(today: string): string {
  return addDays(today, -isoWeekdayOf(today));
}

function hourOf(time: string): number {
  return Number(time.split(":")[0]);
}

function TaskBlock({ task }: { task: Task }) {
  const color = `var(--p${task.priority})`;
  return (
    <div
      className="truncate rounded-[4px] px-1.5 py-1 text-[11px] leading-tight text-ink"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        borderLeft: `2px solid ${color}`,
      }}
      title={task.title}
    >
      {task.due?.time && <span className="font-mono text-muted">{task.due.time} </span>}
      {task.title}
    </div>
  );
}

export function CalendarView({ scope }: { scope: Scope }) {
  const tasks = useLiveQuery("tasks", (rows) => rows);
  if (!tasks) return null;

  const today = todayISO();
  const monday = mondayOfWeek(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  // Calendar is a time lens; only a project filter narrows it (smart lists
  // like "Today" would gut the week view).
  const scoped = scope.kind === "project" ? tasks.filter((t) => t.project_id === scope.id) : tasks;

  const timedFor = (day: string, hour: number) =>
    scoped.filter((t) => t.due?.date === day && t.due.time != null && hourOf(t.due.time) === hour);
  const allDayFor = (day: string) => scoped.filter((t) => t.due?.date === day && t.due.time == null);

  const todayTint = { backgroundColor: "color-mix(in srgb, var(--work) 5%, transparent)" };

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        {/* Header */}
        <div className="grid items-stretch" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
          <div />
          {days.map((day, i) => {
            const isToday = day === today;
            const dayNum = Number(day.split("-")[2]);
            return (
              <div
                key={day}
                className={`border-l border-hairline px-2 pb-1.5 pt-1 ${isToday ? "border-t-2" : ""}`}
                style={isToday ? { borderTopColor: "var(--work)" } : undefined}
              >
                <div className="eyebrow" style={isToday ? { color: "var(--work)" } : undefined}>
                  {WEEKDAY_ABBR[i]}
                </div>
                <div className={`font-mono text-secondary ${isToday ? "text-work" : "text-muted"}`}>{dayNum}</div>
              </div>
            );
          })}
        </div>

        {/* All-day row */}
        <div className="grid border-t border-hairline" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
          <div className="flex items-start justify-end px-1 py-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">all</span>
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="min-h-[34px] space-y-1 border-l border-hairline px-1 py-1"
              style={day === today ? todayTint : undefined}
            >
              {allDayFor(day).map((task) => (
                <TaskBlock key={task.id} task={task} />
              ))}
            </div>
          ))}
        </div>

        {/* Hour rows */}
        {HOURS.map((hour) => (
          <div key={hour} className="grid border-t border-hairline" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
            <div className="flex items-start justify-end px-1 py-1">
              <span className="font-mono text-[10px] text-muted">{String(hour).padStart(2, "0")}</span>
            </div>
            {days.map((day) => (
              <div
                key={day}
                className="min-h-[40px] space-y-1 border-l border-hairline px-1 py-1"
                style={day === today ? todayTint : undefined}
              >
                {timedFor(day, hour).map((task) => (
                  <TaskBlock key={task.id} task={task} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
