/**
 * Dexie schema — ARCHITECTURE.md §7.1 (version 1). This file only defines
 * shape + indexes; all reads/writes go through `lib/db/repository.ts`
 * (§7.2 — "no component writes Dexie tables directly").
 */
import Dexie, { type Table } from "dexie";
import type {
  DailyReview,
  FocusSession,
  Project,
  Section,
  Season,
  Task,
  Vision,
} from "@focusengine/schemas/entities";
import type { EntityType, SyncOpType } from "@focusengine/schemas/enums";

/**
 * Every Dexie-stored row carries a per-field HLC map alongside its business
 * fields ("Every entity row also carries `field_hlcs`", §7.1). This is local
 * merge bookkeeping (SYNC_STRATEGY.md §3/§5), not part of the wire contract
 * in `packages/schemas`, so it's layered on here via intersection rather than
 * folded into the shared entity interfaces.
 */
export type Stored<T> = T & { field_hlcs: Record<string, string> };

export type StoredTask = Stored<Task>;
export type StoredProject = Stored<Project>;
export type StoredSection = Stored<Section>;
export type StoredVision = Stored<Vision>;
export type StoredSeason = Stored<Season>;
export type StoredFocusSession = Stored<FocusSession>;
export type StoredDailyReview = Stored<DailyReview>;

/** Local change log row (SYNC_STRATEGY.md §3). `seq` is Dexie's auto-increment
 *  primary key (the `++seq` below) — undefined until Dexie assigns it on insert. */
export interface OplogRow {
  seq?: number;
  op_id: string;
  entity: EntityType;
  entity_id: string;
  op: SyncOpType;
  /** CREATE: full doc · UPDATE: changed fields only · DELETE: null */
  patch: Record<string, unknown> | null;
  hlc: string;
  device_id: string;
  /** 0 = not yet pushed, 1 = pushed (applied-or-skipped, both idempotent success) */
  pushed: 0 | 1;
}

/** Known `_meta` keys (ARCHITECTURE.md §7.1 comment). Values are untyped at
 *  the Dexie level; typed accessors live in `lib/db/repository.ts`. `theme`
 *  persists the DESIGN_SPEC §3 theme toggle ("dark" = Studio | "neon");
 *  `demo_seeded` guards the dev-only Review seed (DESIGN_SPEC §8).
 *
 *  v2 (V2_ADDENDUM §A2/A3): `auth` caches the signed-in `{token, user}` bundle
 *  ("a device's DB belongs to whoever is signed in"), cleared on sign-out;
 *  `settings` caches the per-user `UserSettings` JSON round-tripped through
 *  `PATCH /me/settings`; `data_owner` records which user id the local dataset
 *  was claimed by / bootstrapped for, and PERSISTS across sign-out so a later
 *  sign-in as a different user can be detected (→ "Replace local data?"). */
export type MetaKey =
  | "device_id"
  | "last_server_seq"
  | "hlc_last"
  | "shield_blocklist"
  | "theme"
  | "demo_seeded"
  | "auth"
  | "settings"
  | "data_owner";

export interface MetaRow {
  key: MetaKey;
  value: unknown;
}

export class FocusEngineDB extends Dexie {
  tasks!: Table<StoredTask, string>;
  projects!: Table<StoredProject, string>;
  sections!: Table<StoredSection, string>;
  visions!: Table<StoredVision, string>;
  seasons!: Table<StoredSeason, string>;
  focus_sessions!: Table<StoredFocusSession, string>;
  daily_reviews!: Table<StoredDailyReview, string>;
  _oplog!: Table<OplogRow, number>;
  _meta!: Table<MetaRow, string>;

  constructor() {
    super("focusengine");
    // ARCHITECTURE.md §7.1, version 1. Index strings list only queried
    // fields — `field_hlcs` and most business fields stay unindexed.
    this.version(1).stores({
      tasks: "id, project_id, section_id, parent_id, season_id, status, *labels, updated_hlc",
      projects: "id, parent_id",
      sections: "id, project_id",
      visions: "id",
      seasons: "id, vision_id, status",
      focus_sessions: "id, task_id, state",
      daily_reviews: "id, date",
      _oplog: "++seq, pushed, op_id, entity, entity_id",
      _meta: "key",
    });
  }
}

/** Process-wide singleton — Dexie opens the underlying IndexedDB lazily on
 *  first use. */
export const db = new FocusEngineDB();

/** Entity table names — excludes `_oplog`/`_meta`, which have their own
 *  dedicated accessors in `repository.ts` rather than the generic
 *  create/update/delete helpers. */
export type EntityTableName =
  | "tasks"
  | "projects"
  | "sections"
  | "visions"
  | "seasons"
  | "focus_sessions"
  | "daily_reviews";

/** Maps a Dexie table name to its stored-row TS type so the generic
 *  repository helpers stay type-safe per table. */
export interface EntityRowMap {
  tasks: StoredTask;
  projects: StoredProject;
  sections: StoredSection;
  visions: StoredVision;
  seasons: StoredSeason;
  focus_sessions: StoredFocusSession;
  daily_reviews: StoredDailyReview;
}
