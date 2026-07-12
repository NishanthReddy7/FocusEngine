"use client";

/**
 * ListView — DESIGN_SPEC §5/§6. The live task list, filtered by the sidebar
 * scope and grouped Today / Upcoming / No date, each group under a small-caps
 * eyebrow with a mono count. Empty states are one muted line + one action
 * (§6) — never an illustration.
 */
import { TaskStatus } from "@focusengine/schemas/enums";
import type { Task } from "@focusengine/schemas/entities";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { TaskRow } from "./TaskRow";
import { matchesScope, todayISO, type Scope } from "./scope";

type GroupKey = "today" | "upcoming" | "nodate";

const GROUP_LABEL: Record<GroupKey, string> = {
  today: "Today",
  upcoming: "Upcoming",
  nodate: "No date",
};
const GROUP_ORDER: readonly GroupKey[] = ["today", "upcoming", "nodate"];

function groupKeyFor(task: Task, today: string): GroupKey {
  if (!task.due) return "nodate";
  return task.due.date <= today ? "today" : "upcoming";
}

function sortTasks(a: Task, b: Task): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ad = a.due?.date ?? "9999-99-99";
  const bd = b.due?.date ?? "9999-99-99";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.child_order - b.child_order;
}

function focusQuickAdd(): void {
  document.getElementById("quickadd-input")?.focus();
}

function EmptyState({ line, actionLabel, onAction }: { line: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-10">
      <p className="text-secondary text-muted">{line}</p>
      <button
        type="button"
        onClick={onAction}
        className="rounded-md text-secondary text-work transition-colors duration-150 hover:underline"
      >
        {actionLabel}
      </button>
    </div>
  );
}

export function ListView({ scope, onScope }: { scope: Scope; onScope: (scope: Scope) => void }) {
  const tasks = useLiveQuery("tasks", (rows) => rows);
  if (!tasks) return null;

  const today = todayISO();
  const visible = tasks.filter(
    (t) => t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.ARCHIVED && matchesScope(t, scope),
  );

  if (visible.length === 0) {
    if (scope.kind === "today") {
      return (
        <EmptyState
          line="Nothing due today."
          actionLabel="Pull one from Upcoming"
          onAction={() => onScope({ kind: "upcoming" })}
        />
      );
    }
    if (scope.kind === "upcoming") {
      return (
        <EmptyState line="Nothing upcoming. You're clear." actionLabel="See today" onAction={() => onScope({ kind: "today" })} />
      );
    }
    return <EmptyState line="No tasks here yet." actionLabel="Capture one" onAction={focusQuickAdd} />;
  }

  const groups: Record<GroupKey, Task[]> = { today: [], upcoming: [], nodate: [] };
  for (const task of visible) groups[groupKeyFor(task, today)].push(task);
  for (const key of GROUP_ORDER) groups[key].sort(sortTasks);

  return (
    <div className="flex flex-col gap-7">
      {GROUP_ORDER.filter((key) => groups[key].length > 0).map((key) => (
        <section key={key}>
          <div className="mb-1 flex items-baseline gap-2 px-2">
            <h2 className="eyebrow text-muted">{GROUP_LABEL[key]}</h2>
            <span className="font-mono text-[11px] text-muted">{groups[key].length}</span>
          </div>
          <ul className="flex flex-col">
            {groups[key].map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
