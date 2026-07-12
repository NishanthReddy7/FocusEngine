"use client";

import { useEffect, useState } from "react";
import { CalendarDays, LayoutGrid, List as ListIcon, type LucideIcon } from "lucide-react";
import { ViewMode } from "@focusengine/schemas/enums";
import { AppShell } from "@/components/shell/AppShell";
import { Sidebar } from "@/components/shell/Sidebar";
import { QuickAdd } from "@/components/capture/QuickAdd";
import { VoiceCapture } from "@/components/capture/VoiceCapture";
import { ListView } from "@/components/tasks/ListView";
import { BoardView } from "@/components/tasks/BoardView";
import { CalendarView } from "@/components/tasks/CalendarView";
import { scopeLabel, type Scope } from "@/components/tasks/scope";
import { startSyncEngine } from "@/lib/sync/engine";

const VIEW_TABS: ReadonlyArray<{ mode: ViewMode; label: string; icon: LucideIcon }> = [
  { mode: ViewMode.LIST, label: "List", icon: ListIcon },
  { mode: ViewMode.BOARD, label: "Board", icon: LayoutGrid },
  { mode: ViewMode.CALENDAR, label: "Calendar", icon: CalendarDays },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dateEyebrow(): string {
  const now = new Date();
  return `${WEEKDAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

/** Capture view (DESIGN_SPEC §5): QuickAdd hero + the live task list, board,
 *  or calendar under the app shell. */
export default function CapturePage() {
  useEffect(() => startSyncEngine(), []);

  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [view, setView] = useState<ViewMode>(ViewMode.LIST);
  const isList = view === ViewMode.LIST;

  return (
    <AppShell renderSidebar={(collapse) => <Sidebar scope={scope} onScope={setScope} onCollapse={collapse} />}>
      <div className={`${isList ? "mx-auto max-w-2xl px-4" : "px-6"} py-8 md:py-10`}>
        <QuickAdd />

        <div className="mt-4 flex items-center justify-between">
          <VoiceCapture />
          <div
            role="tablist"
            aria-label="View"
            className="flex divide-x divide-hairline overflow-hidden rounded-md border border-hairline"
          >
            {VIEW_TABS.map(({ mode, label, icon: Icon }) => {
              const active = view === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(mode)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors duration-150 ${
                    active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  <Icon size={13} strokeWidth={1.75} className={active ? "text-work" : ""} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <header className="mb-4 mt-8 flex items-baseline gap-3">
          <h1 className="font-display text-title font-semibold tracking-[-0.01em] text-ink">{scopeLabel(scope)}</h1>
          <span className="eyebrow">{dateEyebrow()}</span>
        </header>

        {view === ViewMode.LIST && <ListView scope={scope} onScope={setScope} />}
        {view === ViewMode.BOARD && <BoardView scope={scope} />}
        {view === ViewMode.CALENDAR && <CalendarView scope={scope} />}
      </div>
    </AppShell>
  );
}
