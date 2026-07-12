/**
 * Dev-only demo data (DESIGN_SPEC §8) — populates Dexie so the Review charts,
 * the sidebar projects/seasons, and the task views have something real to draw.
 * Backed by the same repository write path as the app (every row is tracked +
 * oplogged), so it also exercises the sync layer. Guarded by a `_meta` flag so
 * clicking the button twice doesn't duplicate everything.
 *
 * NOT shipped behavior — the review page only renders the trigger in dev.
 */
import {
  AmbientTrack,
  EnergyLevel,
  FocusPreset,
  Priority,
  RecurrenceAnchor,
  RecurrenceFrequency,
  SeasonStatus,
  SessionOutcome,
  SessionState,
  TaskStatus,
  ViewMode,
} from "@focusengine/schemas/enums";
import type { RecurrenceRule } from "@focusengine/schemas/entities";
import { createEntity, getMeta, setMeta, type NewEntityInput } from "@/lib/db/repository";
import { addDays, dateToISODate } from "@/lib/recurrence/next";

function newEntityTask(over: Partial<NewEntityInput<"tasks">> = {}): NewEntityInput<"tasks"> {
  return {
    user_id: null,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "",
    description: "",
    status: TaskStatus.PENDING,
    priority: Priority.P4,
    labels: [] as string[],
    due: null,
    energy_required: EnergyLevel.MEDIUM,
    estimated_minutes: null,
    actual_focus_seconds: 0,
    season_id: null,
    child_order: 0,
    completion_count: 0,
    last_completed_at: null,
    nlp: null,
    ...over,
  };
}

function energyToLevel(score: number): EnergyLevel {
  if (score <= 2) return EnergyLevel.LOW;
  if (score === 3) return EnergyLevel.MEDIUM;
  return EnergyLevel.HIGH;
}

// [focus minutes, tasks completed, self-reported energy 1–5]; 0 = a gap day.
// Index 0 = 13 days ago … index 13 = today. The unbroken tail gives a streak.
const PATTERN: ReadonlyArray<readonly [number, number, number]> = [
  [90, 3, 3],
  [0, 0, 0],
  [120, 4, 4],
  [75, 2, 3],
  [150, 5, 4],
  [45, 1, 2],
  [0, 0, 0],
  [180, 6, 5],
  [90, 3, 4],
  [60, 2, 3],
  [130, 4, 4],
  [40, 1, 2],
  [150, 5, 5],
  [100, 3, 4],
];

const RECURRENCE_WORKDAYS: RecurrenceRule = {
  frequency: RecurrenceFrequency.DAILY,
  interval: 2,
  weekdays: null,
  ordinal: null,
  ordinal_weekday: null,
  workdays_only: true,
  anchor: RecurrenceAnchor.SCHEDULED,
  until: null,
  count: null,
  raw: "every 2 workdays",
};

export async function seedDemoData(): Promise<boolean> {
  // Idempotency guard — clicking the button twice must not duplicate rows.
  if (await getMeta<boolean>("demo_seeded")) return false;

  const today = dateToISODate(new Date());

  // Projects (colours are data, stored on the row).
  const security = await createEntity("projects", {
    name: "Security",
    color: "#E5484D",
    view_mode: ViewMode.LIST,
    parent_id: null,
    child_order: 0,
    is_archived: false,
  });
  const growth = await createEntity("projects", {
    name: "Growth",
    color: "#6E9BD1",
    view_mode: ViewMode.BOARD,
    parent_id: null,
    child_order: 1,
    is_archived: false,
  });
  await createEntity("projects", {
    name: "Personal",
    color: "#8FB996",
    view_mode: ViewMode.LIST,
    parent_id: null,
    child_order: 2,
    is_archived: false,
  });

  // Active season (12-week), started ~4 weeks ago.
  const startsOn = addDays(today, -28);
  const season = await createEntity("seasons", {
    vision_id: null,
    title: "Ship FocusEngine v1",
    objective: "Take the local-first core from scaffold to a product people trust.",
    key_results: ["Design system shipped", "Sync converges under conflict", "First 10 users onboarded"],
    starts_on: startsOn,
    ends_on: addDays(startsOn, 83),
    status: SeasonStatus.ACTIVE,
  });

  // Tasks — a mix of today / upcoming / overdue / no-date, with times for the
  // calendar and accumulated focus time for the row meta.
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Review network vulnerability report",
      project_id: security.id,
      season_id: season.id,
      priority: Priority.P1,
      labels: ["security"],
      energy_required: EnergyLevel.HIGH,
      actual_focus_seconds: 4800,
      due: { date: today, time: "16:00", timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Rotate signing keys",
      project_id: security.id,
      priority: Priority.P2,
      labels: ["security", "ops"],
      energy_required: EnergyLevel.MEDIUM,
      due: { date: addDays(today, -1), time: null, timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Draft the Q3 growth memo",
      project_id: growth.id,
      season_id: season.id,
      priority: Priority.P2,
      labels: ["writing"],
      energy_required: EnergyLevel.HIGH,
      actual_focus_seconds: 7200,
      due: { date: today, time: "10:00", timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Standup notes",
      priority: Priority.P3,
      labels: ["team"],
      energy_required: EnergyLevel.LOW,
      due: { date: today, time: "09:30", timezone: "UTC", recurrence: RECURRENCE_WORKDAYS },
      completion_count: 6,
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Prepare investor update",
      project_id: growth.id,
      priority: Priority.P1,
      labels: ["writing"],
      energy_required: EnergyLevel.HIGH,
      due: { date: addDays(today, 2), time: "14:00", timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Read 'Deep Work' chapter 4",
      priority: Priority.P4,
      labels: ["reading"],
      energy_required: EnergyLevel.LOW,
      due: { date: addDays(today, 3), time: null, timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Refactor the sync backoff",
      priority: Priority.P3,
      labels: ["eng"],
      energy_required: EnergyLevel.MEDIUM,
      actual_focus_seconds: 3000,
      due: null,
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Plan next season objectives",
      season_id: season.id,
      priority: Priority.P2,
      energy_required: EnergyLevel.MEDIUM,
      due: { date: addDays(today, 5), time: null, timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Inbox zero",
      priority: Priority.P4,
      labels: ["admin"],
      energy_required: EnergyLevel.LOW,
      status: TaskStatus.IN_PROGRESS,
      due: { date: today, time: null, timezone: "UTC", recurrence: null },
    }),
  );
  await createEntity(
    "tasks",
    newEntityTask({
      title: "Fix dial breathing on reduced motion",
      project_id: growth.id,
      priority: Priority.P3,
      labels: ["eng", "design"],
      status: TaskStatus.COMPLETED,
      last_completed_at: `${today}T11:00:00Z`,
      actual_focus_seconds: 2700,
    }),
  );

  // Focus sessions + daily reviews across the last 14 days.
  const anchorTaskId = security.id; // any id; sessions just need a task_id
  for (let i = 0; i < PATTERN.length; i += 1) {
    const day = addDays(today, i - (PATTERN.length - 1));
    const entry = PATTERN[i];
    if (!entry) continue;
    const [minutes, tasksDone, energy] = entry;
    if (minutes === 0) continue; // gap day

    const hour = 9 + (i % 8); // spread sessions across the working day
    const startIso = `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
    const endIso = `${day}T${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`;
    const preset = minutes >= 120 ? FocusPreset.DEEP_WORK : minutes >= 60 ? FocusPreset.FLOW : FocusPreset.FOCUS;

    await createEntity("focus_sessions", {
      task_id: anchorTaskId,
      preset,
      planned_cycles: null,
      state: SessionState.COMPLETED,
      outcome: SessionOutcome.COMPLETED,
      started_at: startIso,
      ended_at: endIso,
      work_seconds: minutes * 60,
      break_seconds: Math.round(minutes * 60 * 0.12),
      cycles_completed: Math.max(1, Math.round(minutes / 45)),
      segments: [{ state: SessionState.ACTIVE_WORK, started_at: startIso, ended_at: endIso }],
      ambient_track: AmbientTrack.LOFI,
      energy_after: energyToLevel(energy),
    });

    await createEntity("daily_reviews", {
      date: day,
      energy_level: energy,
      mood: null,
      focus_seconds: minutes * 60,
      tasks_completed: tasksDone,
      highlights: "",
      friction: "",
      ai_feedback: null,
    });
  }

  await setMeta("demo_seeded", true);
  return true;
}
