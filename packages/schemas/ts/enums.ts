/**
 * String/int enums — exact TS mirror of `app/schemas/enums.py` (ARCHITECTURE.md §4.1).
 * Wire format is snake_case everywhere, including these TS enum member *values*
 * (member identifiers are UPPER_CASE by TS convention; the runtime string/number
 * values are what actually cross the wire and MUST match the Python side verbatim).
 */

/** Todoist convention: P1 = highest priority. Mirrors Python `IntEnum`. */
export enum Priority {
  P1 = 1,
  P2 = 2,
  P3 = 3,
  P4 = 4,
}

export enum EnergyLevel {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  ARCHIVED = "archived",
}

export enum SessionState {
  IDLE = "idle",
  ACTIVE_WORK = "active_work",
  PAUSED = "paused",
  BREAK = "break",
  COMPLETED = "completed",
}

export enum SessionOutcome {
  COMPLETED = "completed",
  ABANDONED = "abandoned",
}

export enum FocusPreset {
  SPRINT = "sprint",
  FOCUS = "focus",
  FLOW = "flow",
  DEEP_WORK = "deep_work",
}

export enum RecurrenceFrequency {
  DAILY = "daily",
  WEEKLY = "weekly",
  MONTHLY = "monthly",
  YEARLY = "yearly",
}

export enum RecurrenceAnchor {
  SCHEDULED = "scheduled",
  COMPLETED = "completed",
}

export enum SyncOpType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
}

export enum EntityType {
  TASK = "task",
  PROJECT = "project",
  SECTION = "section",
  VISION = "vision",
  SEASON = "season",
  FOCUS_SESSION = "focus_session",
  DAILY_REVIEW = "daily_review",
}

export enum ViewMode {
  LIST = "list",
  BOARD = "board",
  CALENDAR = "calendar",
}

export enum CaptureSource {
  TEXT = "text",
  VOICE = "voice",
  API = "api",
}

export enum AmbientTrack {
  NONE = "none",
  WHITE_NOISE = "white_noise",
  BINAURAL = "binaural",
  LOFI = "lofi",
  RAIN = "rain",
}

export enum SeasonStatus {
  PLANNED = "planned",
  ACTIVE = "active",
  COMPLETED = "completed",
}

/**
 * Preset durations (cognitive-load ladder) — ARCHITECTURE.md §4.1 table.
 * Python exposes these as `FocusPreset.work_minutes`/`.break_minutes` properties
 * backed by an equivalent module-level table; this is that table's TS mirror.
 */
export interface PresetDuration {
  work_minutes: number;
  break_minutes: number;
}

export const PRESET_DURATIONS: Record<FocusPreset, PresetDuration> = {
  [FocusPreset.SPRINT]: { work_minutes: 15, break_minutes: 3 },
  [FocusPreset.FOCUS]: { work_minutes: 30, break_minutes: 5 },
  [FocusPreset.FLOW]: { work_minutes: 45, break_minutes: 10 },
  [FocusPreset.DEEP_WORK]: { work_minutes: 90, break_minutes: 15 },
};
