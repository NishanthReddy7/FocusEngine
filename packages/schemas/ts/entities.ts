/**
 * Entity + value-object interfaces — exact TS mirror of `app/schemas/*.py`
 * (ARCHITECTURE.md §4.2–§4.3). Field names are snake_case, field-for-field,
 * to match the Python/Pydantic contract with zero casing translation
 * (ARCHITECTURE.md §3). No behavior lives here — pure shape definitions.
 *
 * Date/time representation: the Python side uses `date`/`time`/`datetime`
 * objects that serialize to ISO-8601 strings on the wire (§3). TypeScript has
 * no equivalent native types, so wire values are plain strings here; the
 * aliases below document the expected format at each field.
 */
import {
  AmbientTrack,
  CaptureSource,
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
} from "./enums";

/** `YYYY-MM-DD` (Python `date`). */
export type ISODateString = string;
/** 24h `HH:MM` (Python `time`, wall-clock, no seconds). */
export type ISOTimeString = string;
/** Timezone-aware UTC ISO-8601 with `Z`/offset (Python `datetime`), never naive. */
export type ISODateTimeString = string;
/** 36-char lowercase uuid4 string. */
export type UUIDString = string;

// ---------------------------------------------------------------------------
// 4.2 Embedded value objects
// ---------------------------------------------------------------------------

/** schemas/recurrence.py */
export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** every N units; default 1, >=1 */
  interval: number;
  /** WEEKLY: 0=Mon..6=Sun */
  weekdays: number[] | null;
  /** MONTHLY: 1..4, or -1 = last */
  ordinal: number | null;
  /** MONTHLY ordinal: which weekday */
  ordinal_weekday: number | null;
  /** DAILY: steps count Mon-Fri only */
  workdays_only: boolean;
  anchor: RecurrenceAnchor;
  /** inclusive end */
  until: ISODateString | null;
  /** max occurrences */
  count: number | null;
  /** original NLP phrase */
  raw: string | null;
}

/** schemas/due.py */
export interface DueInfo {
  date: ISODateString;
  time: ISOTimeString | null;
  /** IANA name */
  timezone: string;
  recurrence: RecurrenceRule | null;
}

/** schemas/nlp.py */
export interface NLPMetadata {
  raw_input: string;
  source: CaptureSource;
  /** e.g. {"date_text": "tomorrow at 4pm", "priority_text": "p1"} */
  extracted: Record<string, unknown>;
  confidence: number;
  parser_version: string;
}

/** schemas/focus.py — ACTIVE_WORK or BREAK only */
export interface SessionSegment {
  state: SessionState;
  started_at: ISODateTimeString;
  ended_at: ISODateTimeString | null;
}

// ---------------------------------------------------------------------------
// 4.3 Entities — every synced entity carries this audit/sync block
// ---------------------------------------------------------------------------

export interface SyncAudit {
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;
  deleted_at: ISODateTimeString | null;
  updated_hlc: string;
  device_id: string | null;
}

/** schemas/task.py — the unified schema */
export interface Task extends SyncAudit {
  id: UUIDString;
  /** single-user MVP */
  user_id: UUIDString | null;
  /** None = Inbox */
  project_id: UUIDString | null;
  section_id: UUIDString | null;
  /** nested subtasks, arbitrary depth */
  parent_id: UUIDString | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  /** lowercase, no leading '#' */
  labels: string[];
  due: DueInfo | null;
  energy_required: EnergyLevel;
  estimated_minutes: number | null;
  /** DERIVED — see ARCHITECTURE.md §4.5 / SYNC_STRATEGY.md §6. Never set this
   *  directly from a sync patch; the server recomputes it. */
  actual_focus_seconds: number;
  /** Goal-to-Action GPS alignment */
  season_id: UUIDString | null;
  /** fractional ordering among siblings */
  child_order: number;
  /** recurring-task completions */
  completion_count: number;
  last_completed_at: ISODateTimeString | null;
  nlp: NLPMetadata | null;
}

export interface Project extends SyncAudit {
  id: UUIDString;
  name: string;
  color: string;
  view_mode: ViewMode;
  parent_id: UUIDString | null;
  child_order: number;
  is_archived: boolean;
}

export interface Section extends SyncAudit {
  id: UUIDString;
  project_id: UUIDString;
  name: string;
  child_order: number;
}

export interface Vision extends SyncAudit {
  id: UUIDString;
  title: string;
  narrative: string;
  horizon_years: number;
  is_archived: boolean;
}

export interface Season extends SyncAudit {
  id: UUIDString;
  vision_id: UUIDString | null;
  title: string;
  objective: string;
  key_results: string[];
  starts_on: ISODateString;
  /** model_validator default: starts_on + 83 days (12 weeks, inclusive) when omitted */
  ends_on: ISODateString;
  status: SeasonStatus;
}

export interface FocusSession extends SyncAudit {
  id: UUIDString;
  task_id: UUIDString;
  preset: FocusPreset;
  /** None = run until complete()/abandon() */
  planned_cycles: number | null;
  state: SessionState;
  outcome: SessionOutcome | null;
  started_at: ISODateTimeString | null;
  ended_at: ISODateTimeString | null;
  work_seconds: number;
  break_seconds: number;
  cycles_completed: number;
  segments: SessionSegment[];
  ambient_track: AmbientTrack;
  energy_after: EnergyLevel | null;
}

export interface DailyReview extends SyncAudit {
  id: UUIDString;
  date: ISODateString;
  /** 1..5 */
  energy_level: number;
  mood: string | null;
  focus_seconds: number;
  tasks_completed: number;
  highlights: string;
  friction: string;
  ai_feedback: string | null;
}

// ---------------------------------------------------------------------------
// Create/Update companions — "same Create/Update pattern for the other
// entities" (ARCHITECTURE.md §4.3). Create: every field optional except the
// given required key(s) (id defaults to uuid4(), audit fields are stamped by
// whoever persists the doc — server route handler, or lib/db/repository.ts on
// the client). Update: every field optional (sparse patch). These types are
// intentionally permissive (mirroring the Python companion models field-for-
// field); callers should in practice not hand-set audit/sync fields — see the
// narrower internal write types in lib/db/repository.ts.
// ---------------------------------------------------------------------------

export type CreateInput<T, RequiredKey extends keyof T> = Partial<T> & Pick<T, RequiredKey>;
export type UpdateInput<T> = Partial<T>;

export type TaskCreate = CreateInput<Task, "title">;
export type TaskUpdate = UpdateInput<Task>;

export type ProjectCreate = CreateInput<Project, "name">;
export type ProjectUpdate = UpdateInput<Project>;

export type SectionCreate = CreateInput<Section, "project_id" | "name">;
export type SectionUpdate = UpdateInput<Section>;

export type VisionCreate = CreateInput<Vision, "title">;
export type VisionUpdate = UpdateInput<Vision>;

export type SeasonCreate = CreateInput<Season, "title" | "starts_on">;
export type SeasonUpdate = UpdateInput<Season>;

export type FocusSessionCreate = CreateInput<FocusSession, "task_id" | "preset">;
export type FocusSessionUpdate = UpdateInput<FocusSession>;

export type DailyReviewCreate = CreateInput<DailyReview, "date" | "energy_level">;
export type DailyReviewUpdate = UpdateInput<DailyReview>;
