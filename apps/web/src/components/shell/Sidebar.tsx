"use client";

/**
 * Collapsible 240px sidebar — DESIGN_SPEC §5: Inbox / Today / Upcoming, a
 * PROJECTS list, and the active SEASON with its `WK n/12` mono badge (the
 * Goal-to-Action GPS readout). Reads projects/seasons through the live query;
 * selecting a row filters the capture list via the shared `Scope`.
 */
import { Inbox, PanelLeftClose, Sun, CalendarClock, type LucideIcon } from "lucide-react";
import { SeasonStatus } from "@focusengine/schemas/enums";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { dateToISODate } from "@/lib/recurrence/next";
import type { Scope } from "@/components/tasks/scope";

interface SidebarProps {
  scope: Scope;
  onScope: (scope: Scope) => void;
  onCollapse: () => void;
}

const SMART_LISTS: ReadonlyArray<{ scope: Scope; label: string; icon: LucideIcon }> = [
  { scope: { kind: "inbox" }, label: "Inbox", icon: Inbox },
  { scope: { kind: "today" }, label: "Today", icon: Sun },
  { scope: { kind: "upcoming" }, label: "Upcoming", icon: CalendarClock },
];

/** 1-based season week, clamped to the 12-week season (DESIGN_SPEC §5). */
function seasonWeek(startsOn: string): number {
  const start = new Date(`${startsOn}T00:00:00Z`).getTime();
  const today = new Date(`${dateToISODate(new Date())}T00:00:00Z`).getTime();
  const week = Math.floor((today - start) / (7 * 86_400_000)) + 1;
  return Math.min(12, Math.max(1, week));
}

function isActiveList(scope: Scope, active: Scope): boolean {
  if (scope.kind !== active.kind) return false;
  if (scope.kind === "project" && active.kind === "project") return scope.id === active.id;
  return true;
}

export function Sidebar({ scope, onScope, onCollapse }: SidebarProps) {
  const projects = useLiveQuery("projects", (rows) =>
    [...rows].filter((p) => !p.is_archived).sort((a, b) => a.child_order - b.child_order),
  );
  const seasons = useLiveQuery("seasons", (rows) => rows);
  const activeSeason = (seasons ?? []).find((s) => s.status === SeasonStatus.ACTIVE) ?? (seasons ?? [])[0];

  const rowBase =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-secondary transition-colors duration-150";

  return (
    <div className="flex h-full w-60 flex-col gap-6 overflow-y-auto border-r border-hairline bg-bg px-3 py-4">
      <div className="flex items-center justify-between px-1.5">
        <span className="font-display text-secondary font-semibold tracking-[-0.01em] text-ink">FOCUSENGINE</span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:text-ink"
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="Lists">
        {SMART_LISTS.map(({ scope: s, label, icon: Icon }) => {
          const active = isActiveList(s, scope);
          return (
            <button
              key={label}
              type="button"
              onClick={() => onScope(s)}
              aria-current={active ? "true" : undefined}
              className={`${rowBase} ${active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface hover:text-ink"}`}
            >
              <Icon size={16} strokeWidth={1.75} className={active ? "text-work" : ""} />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1.5">
        <p className="eyebrow px-2.5">Projects</p>
        {projects && projects.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {projects.map((project) => {
              const active = scope.kind === "project" && scope.id === project.id;
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onScope({ kind: "project", id: project.id, name: project.name })}
                  aria-current={active ? "true" : undefined}
                  className={`${rowBase} ${active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface hover:text-ink"}`}
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color }}
                  />
                  <span className="truncate">{project.name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-2.5 text-meta text-muted">No projects yet.</p>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <p className="eyebrow px-2.5">Seasons</p>
        {activeSeason ? (
          <div className="rounded-lg border border-hairline bg-surface px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="eyebrow !tracking-[0.12em] text-muted">Season</span>
              <span className="font-mono text-meta text-work">WK {seasonWeek(activeSeason.starts_on)}/12</span>
            </div>
            <p className="mt-1 truncate text-secondary text-ink">{activeSeason.title}</p>
          </div>
        ) : (
          <p className="px-2.5 text-meta text-muted">No active season.</p>
        )}
      </div>
    </div>
  );
}
