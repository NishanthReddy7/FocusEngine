/**
 * Capture-view scope — the sidebar's Inbox/Today/Upcoming/Projects selection
 * (DESIGN_SPEC §5), applied as a pure predicate over the live task list so the
 * sidebar and the list can't disagree on what "Today" means.
 */
import type { Task } from "@focusengine/schemas/entities";
import { dateToISODate } from "@/lib/recurrence/next";

export type Scope =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "today" }
  | { kind: "upcoming" }
  | { kind: "project"; id: string; name: string };

export function todayISO(): string {
  return dateToISODate(new Date());
}

export function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case "all":
      return "All tasks";
    case "inbox":
      return "Inbox";
    case "today":
      return "Today";
    case "upcoming":
      return "Upcoming";
    case "project":
      return scope.name;
  }
}

export function matchesScope(task: Task, scope: Scope): boolean {
  const today = todayISO();
  switch (scope.kind) {
    case "all":
      return true;
    case "inbox":
      return task.project_id === null;
    case "today":
      // Due today or already overdue — the "act now" bucket.
      return task.due !== null && task.due.date <= today;
    case "upcoming":
      return task.due !== null && task.due.date > today;
    case "project":
      return task.project_id === scope.id;
  }
}
