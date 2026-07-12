/**
 * Client-side mirror of `app/services/recurrence.py::compute_next()`
 * (ARCHITECTURE.md §4.5). Pure date arithmetic — no IO, no Date.now() calls
 * inside the algorithm itself (callers pass `after`/`base` explicitly), so
 * it is trivially unit-testable and safe to call from `lib/nlp/parser.ts`
 * (recurrence phrases "also set a due date of the first occurrence", §7.4)
 * and from `lib/db/repository.ts`'s `completeTask()` (the client-side mirror
 * of the recurrence roll, §4.5 "Recurring completion").
 *
 * All dates are `YYYY-MM-DD` strings and all arithmetic runs through
 * `Date.UTC(...)` so results never depend on the host's local timezone or DST.
 */
import { RecurrenceAnchor, RecurrenceFrequency } from "@focusengine/schemas/enums";
import type { ISODateString, RecurrenceRule } from "@focusengine/schemas/entities";

// ---------------------------------------------------------------------------
// Generic calendar-date helpers (shared with lib/nlp/parser.ts so both
// modules agree on weekday indexing and date arithmetic — one implementation,
// not two that could silently drift apart).
// ---------------------------------------------------------------------------

function parseISODate(iso: ISODateString): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) {
    throw new Error(`malformed ISO date: ${iso}`);
  }
  return { y, m: m - 1, d }; // m is 0-indexed for Date.UTC
}

function toISODate(y: number, m: number, d: number): ISODateString {
  const dt = new Date(Date.UTC(y, m, d));
  const yyyy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Converts a JS `Date` to `YYYY-MM-DD` using UTC getters, so a `Date`
 *  constructed from `new Date("2026-07-12")` (parsed as UTC midnight) yields
 *  "2026-07-12" regardless of the host machine's local timezone. */
export function dateToISODate(d: Date): ISODateString {
  return toISODate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function addDays(iso: ISODateString, days: number): ISODateString {
  const { y, m, d } = parseISODate(iso);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dateToISODate(dt);
}

export function addMonths(iso: ISODateString, months: number): ISODateString {
  const { y, m, d } = parseISODate(iso);
  const targetIndex = m + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return toISODate(targetYear, targetMonth, Math.min(d, daysInTargetMonth));
}

export function addYears(iso: ISODateString, years: number): ISODateString {
  return addMonths(iso, years * 12);
}

/** ISO weekday: 0=Monday..6=Sunday (ARCHITECTURE.md §3), converted from JS
 *  `Date.getUTCDay()` (0=Sunday..6=Saturday). */
export function isoWeekdayOf(iso: ISODateString): number {
  const { y, m, d } = parseISODate(iso);
  const jsDay = new Date(Date.UTC(y, m, d)).getUTCDay();
  return (jsDay + 6) % 7;
}

export function compareISODate(a: ISODateString, b: ISODateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWeekendISO(iso: ISODateString): boolean {
  const wd = isoWeekdayOf(iso);
  return wd === 5 || wd === 6; // Saturday, Sunday
}

// ---------------------------------------------------------------------------
// Per-frequency single-step primitives. `computeNext` below calls one of
// these either once (anchor=COMPLETED) or repeatedly from `base`
// (anchor=SCHEDULED) — ARCHITECTURE.md §4.5.
// ---------------------------------------------------------------------------

function nextWorkday(iso: ISODateString): ISODateString {
  let candidate = addDays(iso, 1);
  while (isWeekendISO(candidate)) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/** "every N workdays": advances N times, each advance landing on the next
 *  Mon-Fri day (weekends don't count as steps). E.g. "every 2 workdays" from
 *  Thu -> Fri (step 1) -> Mon (step 2, skipping Sat/Sun). */
function stepWorkdays(iso: ISODateString, steps: number): ISODateString {
  let cursor = iso;
  for (let i = 0; i < steps; i += 1) {
    cursor = nextWorkday(cursor);
  }
  return cursor;
}

/** WEEKLY: "next listed weekday after the cursor; weeks advance by interval
 *  after the last listed weekday" (ARCHITECTURE.md §4.5). */
function stepWeekly(iso: ISODateString, weekdays: readonly number[], interval: number): ISODateString {
  if (weekdays.length === 0) {
    throw new Error("WEEKLY recurrence requires at least one weekday");
  }
  const sorted = [...weekdays].sort((a, b) => a - b);
  const cursorIso = isoWeekdayOf(iso);
  const laterThisWeek = sorted.find((w) => w > cursorIso);
  if (laterThisWeek !== undefined) {
    return addDays(iso, laterThisWeek - cursorIso);
  }
  // Passed every listed weekday this week: jump `interval` weeks forward
  // (from the coming Monday) and take the earliest listed weekday there.
  const daysToNextMonday = 7 - cursorIso;
  const mondayOfTargetWeek = addDays(iso, daysToNextMonday + (interval - 1) * 7);
  // `sorted[0]` is always present (the length===0 guard above already threw),
  // but a plain array's index access is still `number | undefined` under
  // `noUncheckedIndexedAccess` — assert it explicitly rather than silently
  // falling back to a wrong default.
  const earliestWeekday = sorted[0];
  if (earliestWeekday === undefined) {
    throw new Error("unreachable: sorted is non-empty (length===0 case already threw above)");
  }
  return addDays(mondayOfTargetWeek, earliestWeekday);
}

/** The `ordinal`-th (or last, if -1) occurrence of `isoWd` in `year`/`month`
 *  (0-indexed month), per ARCHITECTURE.md §4.5's "every last Friday of the
 *  month" example generalized to any ordinal 1..4 or -1. */
function nthWeekdayOfMonth(year: number, month: number, ordinal: number, isoWd: number): ISODateString {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (ordinal === -1) {
    for (let d = daysInMonth; d >= 1; d -= 1) {
      if (isoWeekdayOf(toISODate(year, month, d)) === isoWd) return toISODate(year, month, d);
    }
  } else {
    let count = 0;
    for (let d = 1; d <= daysInMonth; d += 1) {
      if (isoWeekdayOf(toISODate(year, month, d)) === isoWd) {
        count += 1;
        if (count === ordinal) return toISODate(year, month, d);
      }
    }
  }
  throw new Error(`ordinal weekday (ordinal=${ordinal}, weekday=${isoWd}) not found in ${year}-${month + 1}`);
}

function stepMonthlyOrdinal(
  iso: ISODateString,
  ordinal: number,
  ordinalWeekday: number,
  interval: number,
): ISODateString {
  const { y, m } = parseISODate(iso);
  const targetIndex = m + interval;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  return nthWeekdayOfMonth(targetYear, targetMonth, ordinal, ordinalWeekday);
}

/**
 * Advances `cursor` by exactly one occurrence of `rule`. Shared by both
 * anchor modes in `computeNext`: SCHEDULED calls it repeatedly from `base`;
 * COMPLETED calls it exactly once from `after` (ARCHITECTURE.md §4.5).
 */
function stepOnce(rule: RecurrenceRule, cursor: ISODateString): ISODateString {
  switch (rule.frequency) {
    case RecurrenceFrequency.DAILY:
      return rule.workdays_only ? stepWorkdays(cursor, rule.interval) : addDays(cursor, rule.interval);
    case RecurrenceFrequency.WEEKLY: {
      // Not part of the spec's explicit bullet list: a WEEKLY rule with no
      // `weekdays` recorded (shouldn't happen via the parser, which always
      // fills it in) falls back to the cursor's own weekday.
      const weekdays = rule.weekdays && rule.weekdays.length > 0 ? rule.weekdays : [isoWeekdayOf(cursor)];
      return stepWeekly(cursor, weekdays, rule.interval);
    }
    case RecurrenceFrequency.MONTHLY:
      // ARCHITECTURE.md §4.5 only spells out the ordinal/ordinal_weekday
      // ("last Friday of the month") case explicitly. A plain "every month"
      // (both null) is filled in here as the natural default: advance by
      // `interval` months, keeping the day-of-month (clamped at month end).
      return rule.ordinal !== null && rule.ordinal_weekday !== null
        ? stepMonthlyOrdinal(cursor, rule.ordinal, rule.ordinal_weekday, rule.interval)
        : addMonths(cursor, rule.interval);
    case RecurrenceFrequency.YEARLY:
      // YEARLY has no dedicated bullet in §4.5; same-month/day advance by
      // `interval` years is the uncontroversial default (Feb 29 clamps via
      // addMonths' day-in-month clamp).
      return addYears(cursor, rule.interval);
    default: {
      const exhaustive: never = rule.frequency;
      throw new Error(`unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}

function withinLimits(rule: RecurrenceRule, candidate: ISODateString, occurrenceIndex: number | null): boolean {
  if (rule.until !== null && compareISODate(candidate, rule.until) > 0) return false;
  if (rule.count !== null && occurrenceIndex !== null && occurrenceIndex > rule.count) return false;
  return true;
}

const MAX_STEPS = 10_000; // guards against a malformed/zero-effective-step rule looping forever

/**
 * `compute_next(rule, after, base) -> date | None` (ARCHITECTURE.md §4.5):
 * - anchor=SCHEDULED (default): step from `base` (the original due date) by
 *   the rule repeatedly; return the first occurrence strictly > `after`.
 * - anchor=COMPLETED: step exactly once forward from `after` (the completion
 *   date).
 * - Returns `null` when `until`/`count` is exhausted.
 *
 * `count` bookkeeping note: for anchor=SCHEDULED, `base` counts as
 * occurrence #1 and each step increments the index — fully derivable from
 * the three inputs given, so it's checked here. For anchor=COMPLETED there
 * is no `base`-relative index available from this signature alone; `count`
 * exhaustion in that mode is expected to be enforced by the caller using
 * `task.completion_count` (which exists for exactly this purpose, §4.3) —
 * this function still enforces `until` for anchor=COMPLETED, since that
 * check needs no external state.
 */
export function computeNext(
  rule: RecurrenceRule,
  after: ISODateString,
  base: ISODateString,
): ISODateString | null {
  if (rule.anchor === RecurrenceAnchor.COMPLETED) {
    const candidate = stepOnce(rule, after);
    return withinLimits(rule, candidate, null) ? candidate : null;
  }

  // anchor=SCHEDULED
  let cursor = base;
  let occurrenceIndex = 1; // base itself is occurrence #1
  for (let i = 0; i < MAX_STEPS; i += 1) {
    cursor = stepOnce(rule, cursor);
    occurrenceIndex += 1;
    if (compareISODate(cursor, after) > 0) {
      return withinLimits(rule, cursor, occurrenceIndex) ? cursor : null;
    }
  }
  throw new Error("computeNext: exceeded iteration cap — rule step is not advancing past `after`");
}
