"use client";

/**
 * dexie-react-hooks wrapper — ARCHITECTURE.md §7 hooks list. Excludes
 * soft-deleted rows by default: "UI queries filter deleted_at == null" (§7.2).
 */
import { useLiveQuery as useDexieLiveQuery } from "dexie-react-hooks";
import { db, type EntityRowMap, type EntityTableName } from "../lib/db/schema";

/**
 * Live query over one Dexie entity table, excluding tombstones by default.
 * Re-runs automatically whenever the underlying table changes (Dexie tracks
 * which tables a live-query's promise touched).
 *
 * `select` narrows/sorts/maps the already-fetched, already-filtered rows; it
 * runs on every tick, so keep it cheap and pure. Its identity should be
 * stable (e.g. `useCallback`) to avoid re-subscribing on every render.
 */
export function useLiveQuery<E extends EntityTableName, R = EntityRowMap[E][]>(
  table: E,
  select?: (rows: EntityRowMap[E][]) => R,
  options?: { includeDeleted?: boolean },
): R | undefined {
  return useDexieLiveQuery(async () => {
    const rows = (await db.table(table).toArray()) as EntityRowMap[E][];
    const visible = options?.includeDeleted ? rows : rows.filter((row) => !row.deleted_at);
    return (select ? select(visible) : visible) as R;
  }, [table, options?.includeDeleted, select]);
}

/** Live single-row lookup by id, excluding tombstones by default. `id`
 *  undefined means "nothing selected yet" — returns undefined without querying. */
export function useLiveEntity<E extends EntityTableName>(
  table: E,
  id: string | undefined,
  options?: { includeDeleted?: boolean },
): EntityRowMap[E] | undefined {
  return useDexieLiveQuery(async () => {
    if (!id) return undefined;
    const row = (await db.table(table).get(id)) as EntityRowMap[E] | undefined;
    if (!row) return undefined;
    if (!options?.includeDeleted && row.deleted_at) return undefined;
    return row;
  }, [table, id, options?.includeDeleted]);
}
