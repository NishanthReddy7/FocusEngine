"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SessionState, TaskStatus } from "@focusengine/schemas/enums";
import { Rail } from "@/components/shell/Rail";
import { TimerHUD } from "@/components/focus/TimerHUD";
import { FocusShield } from "@/components/shield/FocusShield";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useFocusTimer } from "@/hooks/useFocusTimer";
import { startSyncEngine } from "@/lib/sync/engine";
import { takePendingFocusTask } from "@/lib/focus/handoff";
import { isMobileFlavor } from "@/lib/platform";

/** Deep-work cockpit (DESIGN_SPEC §5): a collapsed rail, no sidebar, the dial
 *  owning the viewport. Picks up a task handed over from a TaskRow's Play. */
export default function FocusPage() {
  useEffect(() => startSyncEngine(), []);

  const [taskId, setTaskId] = useState<string | null>(null);

  // Capture → focus bridge: a task chosen via a TaskRow's Play lands here.
  useEffect(() => {
    const pending = takePendingFocusTask();
    if (pending) setTaskId(pending);
  }, []);

  // Owned here (not inside TimerHUD) so FocusShield reads the same session
  // state without a second WS connection / poll cycle.
  const timer = useFocusTimer();

  const tasks = useLiveQuery("tasks", (rows) => rows);
  const pendingTasks = useMemo(
    () =>
      (tasks ?? [])
        .filter((t) => t.status === TaskStatus.PENDING)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 8),
    [tasks],
  );

  const state = timer.session?.state ?? SessionState.IDLE;
  const isRunning =
    state === SessionState.ACTIVE_WORK || state === SessionState.PAUSED || state === SessionState.BREAK;

  const effectiveTaskId = taskId ?? timer.session?.task_id ?? null;
  const taskTitle = (tasks ?? []).find((t) => t.id === effectiveTaskId)?.title ?? null;
  const showPicker = !effectiveTaskId && !isRunning;

  return (
    <>
      {/* Mobile hero is full-bleed — the collapsed hover-strip rail is desktop-only (A6). */}
      {!isMobileFlavor && <Rail collapsed />}

      <Link
        href="/"
        aria-label="Back to capture"
        className="fixed left-4 top-4 z-40 inline-flex items-center gap-2 text-secondary text-muted transition-colors hover:text-ink md:left-6"
      >
        <ArrowLeft size={15} strokeWidth={1.75} /> <span className="md:hidden">Capture</span>
      </Link>

      <TimerHUD taskId={effectiveTaskId} taskTitle={taskTitle} timer={timer} />
      <FocusShield sessionState={state} />

      {showPicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a task to focus on"
          className="fixed inset-0 z-40 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 82%, transparent)" }}
        >
          <div className="w-full max-w-md rounded-lg border border-hairline bg-surface p-5">
            <p className="eyebrow mb-3">Choose a task</p>
            {pendingTasks.length === 0 ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-secondary text-muted">No pending tasks yet.</p>
                <Link href="/" className="text-secondary text-work transition-colors hover:underline">
                  Capture one first
                </Link>
              </div>
            ) : (
              <ul className="flex flex-col">
                {pendingTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setTaskId(task.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-2"
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `var(--p${task.priority})` }}
                      />
                      <span className="truncate text-body text-ink">{task.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
