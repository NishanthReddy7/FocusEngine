"""Recurrence stepping engine — ARCHITECTURE.md §4.5.

``compute_next`` is the single entry point; everything else in this module
is a private helper building the per-frequency "step forward one unit"
function it drives.
"""

from __future__ import annotations

import calendar
from collections.abc import Callable
from datetime import date, timedelta

from app.schemas.enums import RecurrenceAnchor, RecurrenceFrequency
from app.schemas.recurrence import RecurrenceRule

#: Safety bound on the SCHEDULED-anchor search loop so a misconfigured rule
#: (e.g. an ``until``/``count`` that can never be reached) fails safe by
#: returning ``None`` instead of looping forever.
_MAX_ITERATIONS = 100_000

_WEEKDAYS_PER_WEEK = 7
_WORKDAY_CUTOFF = 5  # date.weekday() < 5 means Mon-Fri (ISO: 0=Mon..6=Sun)


def compute_next(rule: RecurrenceRule, after: date, base: date) -> date | None:
    """Compute the next occurrence of ``rule`` strictly after ``after``.

    ``base`` is the recurrence's original scheduled anchor date — normally
    already pattern-conforming, since the NLP parser sets a task's initial
    due date to the first real occurrence (ARCHITECTURE §7.4). ``after`` is
    the date to search strictly beyond: typically the task's current due
    date for ``anchor=SCHEDULED``, or the completion date for
    ``anchor=COMPLETED``.

    - ``anchor=SCHEDULED``: step from ``base`` by the rule repeatedly;
      return the first occurrence strictly greater than ``after``.
    - ``anchor=COMPLETED``: step exactly once forward from ``after``.

    Returns ``None`` once ``rule.until``/``rule.count`` is exhausted.
    """
    stepper = _make_stepper(rule)

    if rule.anchor == RecurrenceAnchor.COMPLETED:
        candidate = stepper(after)
        if rule.until is not None and candidate > rule.until:
            return None
        # `count` is defined relative to the base-anchored SCHEDULED series;
        # a completion-anchored step has no such series to index into, so
        # only `until` is honored here (documented limitation — not
        # exercised by any contract scenario).
        return candidate

    occurrence = _seed_occurrence(rule, base)
    ordinal = 1
    for _ in range(_MAX_ITERATIONS):
        if rule.until is not None and occurrence > rule.until:
            return None
        if rule.count is not None and ordinal > rule.count:
            return None
        if occurrence > after:
            return occurrence
        occurrence = stepper(occurrence)
        ordinal += 1
    return None


def _seed_occurrence(rule: RecurrenceRule, base: date) -> date:
    """The first element of the SCHEDULED occurrence series.

    Identity for every frequency except MONTHLY-with-ordinal: a caller may
    reasonably supply ``base`` as any date within the target month (e.g.
    the 1st), so that one case projects ``base`` onto the actual
    ordinal-weekday date *within its own month* before stepping begins.
    """
    is_monthly_ordinal = (
        rule.frequency == RecurrenceFrequency.MONTHLY
        and rule.ordinal is not None
        and rule.ordinal_weekday is not None
    )
    if is_monthly_ordinal:
        return _nth_weekday_of_month(base.year, base.month, rule.ordinal, rule.ordinal_weekday)
    return base


def _make_stepper(rule: RecurrenceRule) -> Callable[[date], date]:
    """Build the "advance one occurrence forward" function for ``rule``."""
    if rule.frequency == RecurrenceFrequency.DAILY:
        if rule.workdays_only:
            return lambda d: _add_workdays(d, rule.interval)
        return lambda d: d + timedelta(days=rule.interval)

    if rule.frequency == RecurrenceFrequency.WEEKLY:
        if rule.weekdays:
            sorted_weekdays = sorted(set(rule.weekdays))
            return lambda d: _step_weekly_weekdays(d, sorted_weekdays, rule.interval)
        return lambda d: d + timedelta(weeks=rule.interval)

    if rule.frequency == RecurrenceFrequency.MONTHLY:
        if rule.ordinal is not None and rule.ordinal_weekday is not None:
            ordinal, ordinal_weekday, interval = rule.ordinal, rule.ordinal_weekday, rule.interval

            def _step_monthly(d: date) -> date:
                year, month = _add_months_ym(d.year, d.month, interval)
                return _nth_weekday_of_month(year, month, ordinal, ordinal_weekday)

            return _step_monthly
        return lambda d: _add_months(d, rule.interval)

    if rule.frequency == RecurrenceFrequency.YEARLY:
        return lambda d: _add_years(d, rule.interval)

    raise ValueError(f"Unsupported recurrence frequency: {rule.frequency!r}")


def _add_workdays(d: date, n: int) -> date:
    """Advance ``d`` by ``n`` workdays (Mon-Fri); weekends don't count as steps."""
    remaining = n
    current = d
    while remaining > 0:
        current += timedelta(days=1)
        if current.weekday() < _WORKDAY_CUTOFF:
            remaining -= 1
    return current


def _step_weekly_weekdays(d: date, sorted_weekdays: list[int], interval: int) -> date:
    """Next listed weekday after ``d``; weeks advance by ``interval`` after the last one."""
    dow = d.weekday()
    for weekday in sorted_weekdays:
        if weekday > dow:
            return d + timedelta(days=weekday - dow)
    monday = d - timedelta(days=dow)
    next_block_monday = monday + timedelta(weeks=interval)
    return next_block_monday + timedelta(days=sorted_weekdays[0])


def _add_months_ym(year: int, month: int, n: int) -> tuple[int, int]:
    """Add ``n`` months to a (year, month) pair, wrapping the year as needed."""
    total = (month - 1) + n
    return year + total // 12, total % 12 + 1


def _last_day_of_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _nth_weekday_of_month(year: int, month: int, ordinal: int, weekday: int) -> date:
    """The ``ordinal``-th occurrence of ``weekday`` in ``(year, month)``.

    ``ordinal=-1`` means "last"; ``ordinal`` in 1..4 counts from the start
    of the month.
    """
    if ordinal == -1:
        last = date(year, month, _last_day_of_month(year, month))
        offset = (last.weekday() - weekday) % _WEEKDAYS_PER_WEEK
        return last - timedelta(days=offset)

    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % _WEEKDAYS_PER_WEEK
    first_occurrence = first + timedelta(days=offset)
    return first_occurrence + timedelta(days=_WEEKDAYS_PER_WEEK * (ordinal - 1))


def _add_months(d: date, n: int) -> date:
    """Add ``n`` months to ``d``, clamping the day-of-month to the target month's length."""
    year, month = _add_months_ym(d.year, d.month, n)
    day = min(d.day, _last_day_of_month(year, month))
    return date(year, month, day)


def _add_years(d: date, n: int) -> date:
    """Add ``n`` years to ``d``, clamping Feb 29 to Feb 28 in non-leap target years."""
    try:
        return d.replace(year=d.year + n)
    except ValueError:
        return d.replace(year=d.year + n, day=28)
