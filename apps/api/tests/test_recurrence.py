"""Tests for ``app.services.recurrence.compute_next`` (ARCHITECTURE.md §4.5).

Weekday/month arithmetic used in the expected values below was cross-checked
against ``datetime.date.weekday()`` directly (0=Monday..6=Sunday, ISO) before
being hard-coded here — see the plan's T1 self-review note.
"""

from __future__ import annotations

from datetime import date


def _rule(**kwargs):
    from app.schemas.recurrence import RecurrenceRule

    return RecurrenceRule(**kwargs)


# --------------------------------------------------------------------------
# DAILY + workdays_only ("every 2 workdays")
# --------------------------------------------------------------------------


def test_every_2_workdays_from_thursday_lands_on_monday() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=2, workdays_only=True)
    thursday = date(2026, 7, 9)

    result = compute_next(rule, after=thursday, base=thursday)

    assert result == date(2026, 7, 13)  # Monday


def test_every_2_workdays_from_friday_lands_on_tuesday() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=2, workdays_only=True)
    friday = date(2026, 7, 10)

    result = compute_next(rule, after=friday, base=friday)

    assert result == date(2026, 7, 14)  # Tuesday


# --------------------------------------------------------------------------
# MONTHLY + ordinal ("every last Friday of the month")
# --------------------------------------------------------------------------


def test_last_friday_of_month_july_resolves_to_july_31() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="monthly", ordinal=-1, ordinal_weekday=4)
    base = date(2026, 7, 1)

    result = compute_next(rule, after=date(2026, 7, 1), base=base)

    assert result == date(2026, 7, 31)


def test_last_friday_of_month_steps_from_july_to_august() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="monthly", ordinal=-1, ordinal_weekday=4)
    base = date(2026, 7, 1)

    result = compute_next(rule, after=date(2026, 7, 31), base=base)

    assert result == date(2026, 8, 28)


def test_last_friday_of_month_december_wraps_into_january() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="monthly", ordinal=-1, ordinal_weekday=4)
    base = date(2026, 12, 1)

    result = compute_next(rule, after=date(2026, 12, 25), base=base)

    assert result == date(2027, 1, 29)


# --------------------------------------------------------------------------
# WEEKLY + specific weekdays + interval
# --------------------------------------------------------------------------


def test_weekly_specific_weekdays_next_occurrence_same_week() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="weekly", weekdays=[0, 2], interval=2)
    monday = date(2026, 7, 6)

    result = compute_next(rule, after=monday, base=monday)

    assert result == date(2026, 7, 8)  # Wednesday, same active week


def test_weekly_specific_weekdays_interval_skips_to_next_block() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="weekly", weekdays=[0, 2], interval=2)
    monday = date(2026, 7, 6)

    result = compute_next(rule, after=date(2026, 7, 8), base=monday)

    assert result == date(2026, 7, 20)  # 2 weeks later, first listed weekday


# --------------------------------------------------------------------------
# anchor=COMPLETED steps exactly once from the completion date
# --------------------------------------------------------------------------


def test_anchor_completed_steps_once_from_completion_date() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="weekly", weekdays=[0, 2], interval=2, anchor="completed")
    base = date(2026, 7, 6)  # the original schedule anchor — irrelevant to the result
    completed_on = date(2026, 7, 9)  # a Thursday: past both listed weekdays for its week

    result = compute_next(rule, after=completed_on, base=base)

    assert result == date(2026, 7, 20)


def test_anchor_completed_ignores_base_schedule_chain() -> None:
    """anchor=COMPLETED steps from ``after`` directly, not from the base chain."""
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=3, anchor="completed")
    base = date(2020, 1, 1)  # far in the past / irrelevant
    completed_on = date(2026, 7, 9)

    result = compute_next(rule, after=completed_on, base=base)

    assert result == date(2026, 7, 12)


# --------------------------------------------------------------------------
# until / count exhaustion
# --------------------------------------------------------------------------


def test_until_exhaustion_returns_none_past_the_boundary() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=1, until=date(2026, 7, 2))
    base = date(2026, 7, 1)

    assert compute_next(rule, after=date(2026, 7, 1), base=base) == date(2026, 7, 2)
    assert compute_next(rule, after=date(2026, 7, 2), base=base) is None


def test_count_exhaustion_returns_none_past_max_occurrences() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=1, count=2)
    base = date(2026, 7, 1)

    # Occurrence #1 = base (2026-07-01), occurrence #2 = 2026-07-02: still allowed.
    assert compute_next(rule, after=date(2026, 7, 1), base=base) == date(2026, 7, 2)
    # Occurrence #3 would be 2026-07-03: exceeds count=2.
    assert compute_next(rule, after=date(2026, 7, 2), base=base) is None


# --------------------------------------------------------------------------
# Plain DAILY/WEEKLY/MONTHLY/YEARLY sanity (no ordinal/workdays_only/weekdays)
# --------------------------------------------------------------------------


def test_plain_daily_interval() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="daily", interval=3)
    base = date(2026, 7, 1)

    assert compute_next(rule, after=date(2026, 7, 1), base=base) == date(2026, 7, 4)


def test_plain_weekly_interval_no_weekdays_list() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="weekly", interval=2)
    base = date(2026, 7, 6)  # Monday

    assert compute_next(rule, after=date(2026, 7, 6), base=base) == date(2026, 7, 20)


def test_plain_monthly_interval_preserves_day_of_month() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="monthly", interval=1)
    base = date(2026, 1, 31)

    # February has no 31st: day-of-month clamps to the last day of the target month.
    assert compute_next(rule, after=date(2026, 1, 31), base=base) == date(2026, 2, 28)


def test_plain_yearly_interval() -> None:
    from app.services.recurrence import compute_next

    rule = _rule(frequency="yearly", interval=1)
    base = date(2026, 7, 12)

    assert compute_next(rule, after=date(2026, 7, 12), base=base) == date(2027, 7, 12)
