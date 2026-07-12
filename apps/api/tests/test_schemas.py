"""Tests for the Pydantic v2 wire contract in ``app.schemas`` (ARCHITECTURE.md §4)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError


def test_models_and_schemas_import_cleanly() -> None:
    """Acceptance criterion: ``from app import models, schemas`` imports clean."""
    from app import models, schemas  # noqa: F401


# --------------------------------------------------------------------------
# Enums / FocusPreset durations
# --------------------------------------------------------------------------


def test_focus_preset_durations() -> None:
    from app.schemas.enums import FocusPreset

    assert FocusPreset.SPRINT.work_minutes == 15
    assert FocusPreset.SPRINT.break_minutes == 3
    assert FocusPreset.FOCUS.work_minutes == 30
    assert FocusPreset.FOCUS.break_minutes == 5
    assert FocusPreset.FLOW.work_minutes == 45
    assert FocusPreset.FLOW.break_minutes == 10
    assert FocusPreset.DEEP_WORK.work_minutes == 90
    assert FocusPreset.DEEP_WORK.break_minutes == 15


def test_priority_is_int_enum_with_p1_highest() -> None:
    from app.schemas.enums import Priority

    assert Priority.P1 == 1
    assert Priority.P4 == 4
    assert Priority.P1 < Priority.P4


# --------------------------------------------------------------------------
# Task: roundtrip, defaults, validation
# --------------------------------------------------------------------------


def _make_task(audit_fields, **overrides):
    from app.schemas.due import DueInfo
    from app.schemas.nlp import NLPMetadata
    from app.schemas.recurrence import RecurrenceRule
    from app.schemas.task import Task

    kwargs: dict = {
        "id": uuid4(),
        "title": "Review network vulnerability report",
        "due": DueInfo(
            date=date(2026, 7, 13),
            time=time(16, 0),
            recurrence=RecurrenceRule(
                frequency="weekly", weekdays=[0, 2], interval=1, raw="every mon and wed"
            ),
        ),
        "nlp": NLPMetadata(
            raw_input="Review network vulnerability report tomorrow at 4pm p1 #security"
        ),
        **audit_fields(),
    }
    kwargs.update(overrides)
    return Task(**kwargs)


def test_task_roundtrip_via_json_dump(audit_fields) -> None:
    from app.schemas.task import Task

    original = _make_task(audit_fields)
    dumped = original.model_dump(mode="json")
    restored = Task.model_validate(dumped)

    assert restored == original
    assert restored.due.recurrence.weekdays == [0, 2]
    assert restored.nlp.raw_input == original.nlp.raw_input


def test_task_defaults(audit_fields) -> None:
    from app.schemas.enums import EnergyLevel, Priority, TaskStatus
    from app.schemas.task import Task

    task = Task(id=uuid4(), title="Untitled task", **audit_fields())

    assert task.priority == Priority.P4
    assert task.energy_required == EnergyLevel.MEDIUM
    assert task.status == TaskStatus.PENDING
    assert task.description == ""
    assert task.labels == []
    assert task.actual_focus_seconds == 0
    assert task.child_order == 0.0
    assert task.completion_count == 0
    assert task.due is None
    assert task.nlp is None


def test_task_rejects_empty_title(audit_fields) -> None:
    from app.schemas.task import Task

    with pytest.raises(ValidationError):
        Task(id=uuid4(), title="", **audit_fields())


def test_task_rejects_zero_estimated_minutes(audit_fields) -> None:
    from app.schemas.task import Task

    with pytest.raises(ValidationError):
        Task(id=uuid4(), title="Something", estimated_minutes=0, **audit_fields())


def test_task_forbids_extra_fields(audit_fields) -> None:
    from app.schemas.task import Task

    with pytest.raises(ValidationError):
        Task(id=uuid4(), title="Something", not_a_real_field=True, **audit_fields())


def test_task_create_defaults_id_and_requires_title() -> None:
    from app.schemas.task import TaskCreate

    created = TaskCreate(title="Just a title")
    assert created.id is not None
    assert created.title == "Just a title"

    with pytest.raises(ValidationError):
        TaskCreate()  # title is the only required field


def test_task_update_is_a_sparse_patch() -> None:
    from app.schemas.task import TaskUpdate

    patch = TaskUpdate(title="New title")
    dumped = patch.model_dump(exclude_unset=True)
    assert dumped == {"title": "New title"}


# --------------------------------------------------------------------------
# Season: ends_on default
# --------------------------------------------------------------------------


def test_season_ends_on_defaults_to_83_days_after_starts_on(audit_fields) -> None:
    from app.schemas.goals import Season

    starts = date(2026, 7, 1)
    season = Season(id=uuid4(), title="Q3 Build", starts_on=starts, **audit_fields())

    assert season.ends_on == starts + timedelta(days=83)


def test_season_ends_on_explicit_value_is_preserved(audit_fields) -> None:
    from app.schemas.goals import Season

    starts = date(2026, 7, 1)
    explicit_end = date(2026, 8, 1)
    season = Season(
        id=uuid4(), title="Q3 Build", starts_on=starts, ends_on=explicit_end, **audit_fields()
    )

    assert season.ends_on == explicit_end


# --------------------------------------------------------------------------
# HLC
# --------------------------------------------------------------------------


def test_hlc_tick_is_monotonic_same_ms_bumps_counter(device_id) -> None:
    from app.schemas.hlc import HybridLogicalClock, parse_hlc

    frozen_ms = 1783958400123
    frozen_dt = datetime.fromtimestamp(frozen_ms / 1000, tz=timezone.utc)
    clock = HybridLogicalClock(device_id, now_fn=lambda: frozen_dt)

    first = clock.tick()
    second = clock.tick()

    ms1, counter1, _ = parse_hlc(first)
    ms2, counter2, _ = parse_hlc(second)

    assert ms1 == ms2 == frozen_ms
    assert counter2 == counter1 + 1
    assert second > first  # lexicographic compare == causal order


def test_hlc_string_compare_equals_causal_order(device_id) -> None:
    from app.schemas.hlc import format_hlc

    earlier = format_hlc(1783958400123, 0, device_id)
    later_ms = format_hlc(1783958400999, 0, device_id)
    later_counter = format_hlc(1783958400123, 1, device_id)

    assert earlier < later_ms
    assert earlier < later_counter
    assert sorted([later_ms, earlier, later_counter]) == [earlier, later_counter, later_ms]


def test_hlc_receive_caps_forward_skew_at_5_minutes(device_id) -> None:
    from app.schemas.hlc import HybridLogicalClock, format_hlc, parse_hlc

    wall_ms = 1783958400000
    frozen_dt = datetime.fromtimestamp(wall_ms / 1000, tz=timezone.utc)
    clock = HybridLogicalClock(device_id, now_fn=lambda: frozen_dt)

    far_future_remote = format_hlc(
        wall_ms + 60 * 60_000, 0, "aaaaaaaa-0000-4000-8000-000000000000"
    )
    merged = clock.receive(far_future_remote)

    merged_ms, _, _ = parse_hlc(merged)
    assert merged_ms == wall_ms + 5 * 60_000  # capped, not the full hour of skew


def test_hlc_receive_adopts_remote_when_causally_ahead_within_cap(device_id) -> None:
    from app.schemas.hlc import HybridLogicalClock, format_hlc, parse_hlc

    wall_ms = 1783958400000
    frozen_dt = datetime.fromtimestamp(wall_ms / 1000, tz=timezone.utc)
    clock = HybridLogicalClock(device_id, now_fn=lambda: frozen_dt)

    remote = format_hlc(wall_ms + 1000, 5, "aaaaaaaa-0000-4000-8000-000000000000")
    merged = clock.receive(remote)

    merged_ms, merged_counter, _ = parse_hlc(merged)
    assert merged_ms == wall_ms + 1000
    assert merged_counter == 6
