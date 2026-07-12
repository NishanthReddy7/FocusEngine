/**
 * Quick-add NLP grammar — ARCHITECTURE.md §7.4. `parseQuickAdd` is a pure
 * function (no IO, no hidden mutable state across calls — see the `LABEL_RE`
 * note below) that must reproduce the canonical acceptance example exactly:
 *
 *   parseQuickAdd("Review network vulnerability report tomorrow at 4pm p1 #security", now=2026-07-12)
 *   -> { title: "Review network vulnerability report",
 *        due: { date: "2026-07-13", time: "16:00" },
 *        priority: 1, labels: ["security"], recurrence: null }
 *
 * Token rules are case-insensitive; consumed tokens are stripped from the
 * title; spans are recorded in `meta.extracted`. Extraction order matters:
 * recurrence phrases are tried before bare date tokens (so "every monday"
 * doesn't leave a dangling "monday" for the weekday-date rule to also grab),
 * and recurrence — when present — supplies the due date itself (the first
 * occurrence), so the plain date-token pass is skipped entirely in that case.
 */
import { Priority, RecurrenceAnchor, RecurrenceFrequency } from "@focusengine/schemas/enums";
import type { ISODateString, ISOTimeString, RecurrenceRule } from "@focusengine/schemas/entities";
import { addDays, addYears, compareISODate, computeNext, dateToISODate, isoWeekdayOf } from "../recurrence/next";

export interface ParsedQuickAddDue {
  date: ISODateString;
  time: ISOTimeString | null;
}

/**
 * Result shape mirrors the canonical example's visible fields exactly
 * (title/due/priority/labels/recurrence); `meta.extracted` carries the
 * token-span provenance the grammar section also promises, without
 * cluttering the acceptance example's illustrated shape.
 */
export interface ParsedQuickAdd {
  title: string;
  due: ParsedQuickAddDue | null;
  priority: Priority;
  labels: string[];
  recurrence: RecurrenceRule | null;
  meta: { extracted: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Span helpers — track [start, end) of a regex match in the *current*
// (already-shrinking) working string, and remove it by replacing with a
// single space (never empty-string splice, which would fuse neighboring
// words together) — final whitespace collapse happens once, at the end.
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  text: string;
}

/**
 * `RegExpExecArray` extends `Array<string>`, so under this project's
 * `noUncheckedIndexedAccess` every `m[i]` is typed `string | undefined` even
 * for capture groups that aren't behind an optional `(...)?` in the source
 * pattern (where they're always present at runtime once the overall match
 * succeeds). This centralizes the one assertion needed for those groups —
 * used for every access in this file *except* the genuinely-optional minute
 * group in `TIME_AMPM_RE`, which already has its own explicit check.
 */
function group(m: RegExpExecArray, index: number): string {
  const value = m[index];
  if (value === undefined) {
    throw new Error(`expected regex capture group ${index} to be present in match "${m[0] ?? ""}"`);
  }
  return value;
}

function toSpan(m: RegExpExecArray): Span {
  const full = group(m, 0);
  return { start: m.index, end: m.index + full.length, text: full };
}

function removeSpan(text: string, span: Span): string {
  return text.slice(0, span.start) + " " + text.slice(span.end);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Index === ISO weekday (0=Monday..6=Sunday, ARCHITECTURE.md §3). */
const WEEKDAY_NAMES: readonly string[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const WEEKDAY_ALT = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

function weekdayIndex(name: string): number {
  return WEEKDAY_NAMES.indexOf(name.toLowerCase());
}

const MONTH_NAMES: readonly string[] = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH_ALT = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

function monthIndex(name: string): number {
  return MONTH_NAMES.indexOf(name.toLowerCase().slice(0, 3));
}

// ---------------------------------------------------------------------------
// Recurrence — "every day|week|month", "every workday|weekday" (bare, no
// digit), "every N days|workdays|weekdays|weeks", "every <weekday>",
// "every last <weekday> of the month". Tried most-specific-first since e.g.
// "every last friday of the month" also contains a bare weekday name.
//
// "workday" and "weekday" are synonyms here: both mean Mon-Fri (DAILY,
// workdays_only), so "every weekday" and "every 3 weekdays" step over weekends
// exactly like "every workday" / "every 3 workdays".
// ---------------------------------------------------------------------------

const REC_LAST_WEEKDAY_RE = new RegExp(`\\bevery\\s+last\\s+(${WEEKDAY_ALT})\\s+of\\s+the\\s+month\\b`, "i");
const REC_N_UNIT_RE = /\bevery\s+(\d+)\s+(workdays|weekdays|days|weeks)\b/i;
// Bare "every workday" / "every weekday" (optionally plural), no digit → DAILY,
// workdays_only. Deliberately does NOT collide with REC_SIMPLE_RE's "day"/"week"
// (word boundaries stop "workday"/"weekday" matching there) nor REC_WEEKDAY_RE
// (no weekday NAME is a prefix of "workday"/"weekday").
const REC_WORKDAY_RE = /\bevery\s+(?:workday|weekday)s?\b/i;
const REC_WEEKDAY_RE = new RegExp(`\\bevery\\s+(${WEEKDAY_ALT})\\b`, "i");
const REC_SIMPLE_RE = /\bevery\s+(day|week|month)\b/i;

function baseRule(over: Pick<RecurrenceRule, "frequency"> & Partial<RecurrenceRule>, raw: string): RecurrenceRule {
  return {
    frequency: over.frequency,
    interval: over.interval ?? 1,
    weekdays: over.weekdays ?? null,
    ordinal: over.ordinal ?? null,
    ordinal_weekday: over.ordinal_weekday ?? null,
    workdays_only: over.workdays_only ?? false,
    anchor: RecurrenceAnchor.SCHEDULED,
    until: null,
    count: null,
    raw,
  };
}

interface RecurrenceExtraction {
  span: Span;
  rule: RecurrenceRule;
  dueDate: ISODateString;
}

function extractRecurrence(text: string, nowIso: ISODateString): RecurrenceExtraction | null {
  const todayWeekday = isoWeekdayOf(nowIso);

  const buildResult = (m: RegExpExecArray, rule: RecurrenceRule): RecurrenceExtraction => ({
    span: toSpan(m),
    rule,
    // Recurrence "also sets a due date of the first occurrence" (§7.4): step
    // from `now` itself (both `after` and `base`) via the shared recurrence
    // engine so the parser and the recurrence engine can never disagree.
    dueDate: computeNext(rule, nowIso, nowIso) ?? nowIso,
  });

  let m = REC_LAST_WEEKDAY_RE.exec(text);
  if (m) {
    const rule = baseRule(
      { frequency: RecurrenceFrequency.MONTHLY, ordinal: -1, ordinal_weekday: weekdayIndex(group(m, 1)) },
      group(m, 0).trim(),
    );
    return buildResult(m, rule);
  }

  m = REC_N_UNIT_RE.exec(text);
  if (m) {
    const n = Number(group(m, 1));
    const unit = group(m, 2).toLowerCase();
    const rule =
      unit === "weeks"
        ? baseRule({ frequency: RecurrenceFrequency.WEEKLY, interval: n, weekdays: [todayWeekday] }, group(m, 0).trim())
        : baseRule(
            // "workdays" and "weekdays" both mean Mon-Fri; only bare "days" counts weekends.
            {
              frequency: RecurrenceFrequency.DAILY,
              interval: n,
              workdays_only: unit === "workdays" || unit === "weekdays",
            },
            group(m, 0).trim(),
          );
    return buildResult(m, rule);
  }

  m = REC_WORKDAY_RE.exec(text);
  if (m) {
    // Bare "every workday" / "every weekday" → DAILY, interval 1, Mon-Fri only.
    const rule = baseRule(
      { frequency: RecurrenceFrequency.DAILY, interval: 1, workdays_only: true },
      group(m, 0).trim(),
    );
    return buildResult(m, rule);
  }

  m = REC_WEEKDAY_RE.exec(text);
  if (m) {
    const rule = baseRule(
      { frequency: RecurrenceFrequency.WEEKLY, interval: 1, weekdays: [weekdayIndex(group(m, 1))] },
      group(m, 0).trim(),
    );
    return buildResult(m, rule);
  }

  m = REC_SIMPLE_RE.exec(text);
  if (m) {
    const unit = group(m, 1).toLowerCase();
    const rule =
      unit === "day"
        ? baseRule({ frequency: RecurrenceFrequency.DAILY, interval: 1 }, group(m, 0).trim())
        : unit === "week"
          ? baseRule({ frequency: RecurrenceFrequency.WEEKLY, interval: 1, weekdays: [todayWeekday] }, group(m, 0).trim())
          : baseRule({ frequency: RecurrenceFrequency.MONTHLY, interval: 1 }, group(m, 0).trim());
    return buildResult(m, rule);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dates — today/tod, tomorrow/tmr, weekday names (next such day strictly
// after today), "next week" (next Monday), explicit "jul 15" / "15 jul" /
// "2026-07-15".
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})[a-z]*\\.?\\b`, "i");
const NEXT_WEEK_RE = /\bnext\s+week\b/i;
const TODAY_RE = /\b(?:today|tod)\b/i;
const TOMORROW_RE = /\b(?:tomorrow|tmr)\b/i;
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_ALT})\\b`, "i");

/** Next occurrence of `targetIsoWeekday` that is strictly after `nowIso`
 *  (so "today" itself never counts — matches §7.4's "next such day strictly
 *  after today", and doubles as "next week" -> next Monday with target=0). */
function nextIsoWeekdayStrictlyAfter(nowIso: ISODateString, targetIsoWeekday: number): ISODateString {
  const todayWd = isoWeekdayOf(nowIso);
  const delta = ((targetIsoWeekday - todayWd + 7) % 7) || 7;
  return addDays(nowIso, delta);
}

/** No year in the input: assume the current year, but roll to next year if
 *  that date has already passed (not explicitly specified by §7.4; a
 *  documented, uncontroversial default for a quick-add grammar). */
function explicitDateFromParts(year: number, month0: number, day: number, nowIso: ISODateString): ISODateString {
  const candidate = dateToISODate(new Date(Date.UTC(year, month0, day)));
  return compareISODate(candidate, nowIso) >= 0 ? candidate : addYears(candidate, 1);
}

interface DateExtraction {
  span: Span;
  date: ISODateString;
}

function extractDate(now: Date, nowIso: ISODateString, text: string): DateExtraction | null {
  const currentYear = now.getUTCFullYear();

  let m = ISO_DATE_RE.exec(text);
  if (m) return { span: toSpan(m), date: `${group(m, 1)}-${group(m, 2)}-${group(m, 3)}` };

  m = MONTH_DAY_RE.exec(text);
  if (m) {
    return {
      span: toSpan(m),
      date: explicitDateFromParts(currentYear, monthIndex(group(m, 1)), Number(group(m, 2)), nowIso),
    };
  }

  m = DAY_MONTH_RE.exec(text);
  if (m) {
    return {
      span: toSpan(m),
      date: explicitDateFromParts(currentYear, monthIndex(group(m, 2)), Number(group(m, 1)), nowIso),
    };
  }

  m = NEXT_WEEK_RE.exec(text);
  if (m) return { span: toSpan(m), date: nextIsoWeekdayStrictlyAfter(nowIso, 0) };

  m = TODAY_RE.exec(text);
  if (m) return { span: toSpan(m), date: nowIso };

  m = TOMORROW_RE.exec(text);
  if (m) return { span: toSpan(m), date: addDays(nowIso, 1) };

  m = WEEKDAY_RE.exec(text);
  if (m) return { span: toSpan(m), date: nextIsoWeekdayStrictlyAfter(nowIso, weekdayIndex(group(m, 1))) };

  return null;
}

// ---------------------------------------------------------------------------
// Times — "at 4pm", "at 16:00", "4:30pm" -> 24h HH:MM.
// ---------------------------------------------------------------------------

const TIME_AMPM_RE = /\b(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
const TIME_24H_RE = /\bat\s+([01]?\d|2[0-3]):([0-5]\d)\b/i;

function formatTime(hour: number, minute: number): ISOTimeString {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

interface TimeExtraction {
  span: Span;
  time: ISOTimeString;
}

function extractTime(text: string): TimeExtraction | null {
  let m = TIME_AMPM_RE.exec(text);
  if (m) {
    const rawHour = Number(group(m, 1));
    // Minute IS genuinely optional in this pattern (`(?::([0-5]\d))?`), so
    // `m[2]` really can be undefined at runtime — handled directly here
    // rather than via `group()`, which is only for groups that are always
    // present once the overall match succeeds.
    const minuteGroup = m[2];
    const minute = minuteGroup ? Number(minuteGroup) : 0;
    const meridiem = group(m, 3).toLowerCase();
    let hour = rawHour % 12;
    if (meridiem === "pm") hour += 12;
    return { span: toSpan(m), time: formatTime(hour, minute) };
  }

  m = TIME_24H_RE.exec(text);
  if (m) return { span: toSpan(m), time: formatTime(Number(group(m, 1)), Number(group(m, 2))) };

  return null;
}

// ---------------------------------------------------------------------------
// Priority — /\bp([1-4])\b/i, default P4.
// ---------------------------------------------------------------------------

const PRIORITY_RE = /\bp([1-4])\b/i;

// ---------------------------------------------------------------------------
// Labels — #word (letters/digits/_/-), lowercased, may appear anywhere, all
// occurrences. `LABEL_RE` is the one stateful (global) regex in this module;
// `lastIndex` is reset before every scan so `parseQuickAdd` stays pure
// (no behavior depends on previous calls).
// ---------------------------------------------------------------------------

const LABEL_RE = /#([A-Za-z0-9_-]+)/g;

// ---------------------------------------------------------------------------
// parseQuickAdd
// ---------------------------------------------------------------------------

export function parseQuickAdd(input: string, now: Date = new Date()): ParsedQuickAdd {
  const nowIso = dateToISODate(now);
  const extracted: Record<string, string> = {};
  let text = input;

  // 1. Recurrence (also supplies the due date, if matched).
  let recurrence: RecurrenceRule | null = null;
  let dateIso: ISODateString | null = null;
  const recurrenceHit = extractRecurrence(text, nowIso);
  if (recurrenceHit) {
    recurrence = recurrenceHit.rule;
    dateIso = recurrenceHit.dueDate;
    text = removeSpan(text, recurrenceHit.span);
    extracted.recurrence_text = recurrenceHit.span.text.trim();
  }

  // 2. Explicit date token — only if recurrence didn't already set one.
  if (dateIso === null) {
    const dateHit = extractDate(now, nowIso, text);
    if (dateHit) {
      dateIso = dateHit.date;
      text = removeSpan(text, dateHit.span);
      extracted.date_text = dateHit.span.text.trim();
    }
  }

  // 3. Time token. A bare time with no date at all defaults to "today"
  // (common quick-add convention; not explicitly specified by §7.4 but the
  // natural reading of "at 4pm" typed with no day given).
  let time: ISOTimeString | null = null;
  const timeHit = extractTime(text);
  if (timeHit) {
    time = timeHit.time;
    text = removeSpan(text, timeHit.span);
    extracted.time_text = timeHit.span.text.trim();
    if (dateIso === null) dateIso = nowIso;
  }

  // 4. Priority (default P4).
  let priority: Priority = Priority.P4;
  const priorityMatch = PRIORITY_RE.exec(text);
  if (priorityMatch) {
    priority = Number(group(priorityMatch, 1)) as Priority;
    text = removeSpan(text, toSpan(priorityMatch));
    extracted.priority_text = group(priorityMatch, 0).trim();
  }

  // 5. Labels (all occurrences); collected first, removed back-to-front (via
  // a reversed copy, not index access) so earlier spans' indices stay valid.
  const labels: string[] = [];
  const labelSpans: Span[] = [];
  LABEL_RE.lastIndex = 0;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = LABEL_RE.exec(text)) !== null) {
    labels.push(group(labelMatch, 1).toLowerCase());
    labelSpans.push(toSpan(labelMatch));
  }
  for (const span of [...labelSpans].reverse()) {
    text = removeSpan(text, span);
  }
  if (labelSpans.length > 0) {
    extracted.labels_text = labelSpans.map((s) => s.text).join(" ");
  }

  // 6. Remaining text -> title.
  const title = text.replace(/\s+/g, " ").trim();

  return {
    title,
    due: dateIso === null ? null : { date: dateIso, time },
    priority,
    labels,
    recurrence,
    meta: { extracted },
  };
}
