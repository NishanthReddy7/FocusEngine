"use client";

/**
 * BoardView — DESIGN_SPEC §6. Status lanes (Pending / In progress / Completed)
 * as hairline-bordered columns with mono WIP counts; cards are compact tasks.
 * Moves happen through a card overflow menu, not drag-and-drop (no dnd
 * dependency — noted as the extension point). On mobile the lanes scroll
 * horizontally with snap (§10).
 */
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { TaskStatus } from "@focusengine/schemas/enums";
import type { Task } from "@focusengine/schemas/entities";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { completeTask, updateEntity } from "@/lib/db/repository";
import { matchesScope, type Scope } from "./scope";
import { TaskEditSheet } from "./TaskEditor";

const COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: TaskStatus.PENDING, label: "Pending" },
  { status: TaskStatus.IN_PROGRESS, label: "In progress" },
  { status: TaskStatus.COMPLETED, label: "Completed" },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  [TaskStatus.PENDING]: "Pending",
  [TaskStatus.IN_PROGRESS]: "In progress",
  [TaskStatus.COMPLETED]: "Completed",
  [TaskStatus.ARCHIVED]: "Archived",
};

function moveTask(task: Task, target: TaskStatus): void {
  // Completing routes through completeTask so a recurring task rolls forward
  // instead of just flipping its status (§4.5).
  if (target === TaskStatus.COMPLETED) void completeTask(task.id);
  else void updateEntity("tasks", task.id, { status: target });
}

function BoardCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const targets = COLUMNS.map((c) => c.status).filter((s) => s !== task.status);

  return (
    <li className="relative rounded-lg border border-hairline bg-surface px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          title="Edit task"
          className={`flex-1 text-left text-secondary ${
            task.status === TaskStatus.COMPLETED ? "text-muted line-through" : "text-ink"
          }`}
        >
          {task.title}
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="Move task"
          aria-expanded={open}
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:text-ink"
        >
          <MoreHorizontal size={15} strokeWidth={1.75} />
        </button>
      </div>

      {(task.due || task.labels.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted">
          {task.due && <span>{task.due.date}</span>}
          {task.labels.map((l) => (
            <span key={l}>#{l}</span>
          ))}
        </div>
      )}

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute right-2 top-9 z-20 min-w-40 overflow-hidden rounded-md border border-hairline bg-surface-2 py-1">
            <button
              type="button"
              onClick={() => {
                setEditOpen(true);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-secondary text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              Edit task
            </button>
            {targets.map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => {
                  moveTask(task, target);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-secondary text-muted transition-colors hover:bg-surface hover:text-ink"
              >
                Move to {STATUS_LABEL[target]}
              </button>
            ))}
          </div>
        </>
      )}

      {editOpen && <TaskEditSheet task={task} onClose={() => setEditOpen(false)} />}
    </li>
  );
}

export function BoardView({ scope }: { scope: Scope }) {
  const tasks = useLiveQuery("tasks", (rows) => rows.filter((t) => matchesScope(t, scope)));
  if (!tasks) return null;

  const byStatus = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  return (
    <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 sm:snap-none">
      {COLUMNS.map(({ status, label }) => {
        const items = byStatus(status);
        return (
          <section
            key={status}
            className="flex min-w-[82%] snap-start flex-col gap-2 rounded-lg border border-hairline bg-bg p-3 sm:min-w-0 sm:flex-1"
          >
            <div className="flex items-baseline justify-between px-1">
              <h2 className="eyebrow text-muted">{label}</h2>
              <span className="font-mono text-[11px] text-muted">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="px-1 py-3 text-[11px] text-muted">Empty</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((task) => (
                  <BoardCard key={task.id} task={task} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
