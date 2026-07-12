# FocusEngine — System Architecture & Binding Contracts

**Status:** v1.0 · 2026-07-12 · Authored by the project architect.
**Audience:** implementers and future contributors.
**Rule:** every name, type, enum member, signature, and path in this document is **binding**. If an implementation needs to deviate, it must be reported as a deviation, not silently changed.

---

## 1. System Overview

FocusEngine merges two workflows over one shared state:

- **High-velocity capture** (Todoist core): NLP quick-add, projects/sections/nested subtasks, list/board/calendar views, advanced recurrence.
- **Deep-work execution** (Superfocus core): Vision → Season (12-week) → Daily Action pipeline, state-driven focus timers, ambient audio, distraction shield, intention-loop coaching.

### Principles

1. **Local-first.** IndexedDB (Dexie) is the client source of truth. Every mutation applies locally and instantly; the FastAPI/SQLite backend is a sync relay + durability layer. The web app must be fully functional with the backend offline.
2. **Contract-first.** One wire format (snake_case JSON, UTC ISO-8601 datetimes, uuid4 string ids) shared by Pydantic, SQLAlchemy, and TypeScript. No casing translation layers.
3. **Event-driven integration.** Task engine and focus engine never call each other directly; they communicate via event buses (client: `lib/events/bus.ts`; server: `domain/focus/events.py` → WebSocket fan-out).
4. **Derived, never merged.** Cross-device additive quantities (`task.actual_focus_seconds`) are recomputed from append-only facts (focus session segments), never last-writer-wins merged. See `docs/SYNC_STRATEGY.md`.
5. **Deterministic core.** The focus state machine and recurrence engine are pure/injected-clock components, fully unit-testable without real time.

---

## 2. Monorepo Layout (Deliverable 1)

Repo root = `/Users/nishanthreddy/Downloads/Focus`.

```
focusengine/
├── README.md                        # overview, quickstart, deliverable map
├── package.json                     # pnpm workspace root (private)
├── pnpm-workspace.yaml              # apps/web, packages/*
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md              # ← this file (binding contracts)
│   ├── SYNC_STRATEGY.md             # Deliverable 4: local-first sync blueprint
│   └── superpowers/plans/
│       └── 2026-07-12-focusengine-core.md   # implementation plan (T1–T5)
├── packages/
│   └── schemas/                     # shared contract types (TS mirror of §4)
│       ├── package.json
│       └── ts/
│           ├── enums.ts             # string enums + PRESET_DURATIONS
│           ├── entities.ts          # Task, Project, Season, FocusSession, …
│           └── sync.ts              # SyncOp, Push/Pull payloads, EntityType
├── apps/
│   ├── api/                         # FastAPI backend (Python ≥3.11)
│   │   ├── pyproject.toml           # deps + pytest config (pythonpath=["."], asyncio_mode="auto")
│   │   ├── app/
│   │   │   ├── __init__.py
│   │   │   ├── main.py              # create_app(), lifespan, router wiring, CORS
│   │   │   ├── core/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── config.py        # Settings (pydantic-settings, env prefix FE_)
│   │   │   │   └── deps.py          # DI: get_db, get_bus, get_manager
│   │   │   ├── db/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── base.py          # DeclarativeBase, TimestampMixin, SyncMixin
│   │   │   │   └── engine.py        # async engine + session factory (sqlite+aiosqlite)
│   │   │   ├── models/              # SQLAlchemy 2.0 typed ORM (§4.6)
│   │   │   │   ├── __init__.py      # re-exports all models
│   │   │   │   ├── task.py  project.py  goals.py  focus.py  review.py  sync.py
│   │   │   ├── schemas/             # Pydantic v2 wire contract (§4)
│   │   │   │   ├── __init__.py      # re-exports all schemas
│   │   │   │   ├── base.py          # FEBase (ConfigDict), utcnow()
│   │   │   │   ├── enums.py  hlc.py  recurrence.py  due.py  nlp.py
│   │   │   │   ├── task.py  project.py  goals.py  focus.py  review.py  sync.py
│   │   │   ├── domain/
│   │   │   │   └── focus/           # Deliverable 3: state machine (§5)
│   │   │   │       ├── __init__.py
│   │   │   │       ├── controller.py    # FocusController FSM
│   │   │   │       ├── events.py        # EventBus + FocusEvent + event names
│   │   │   │       ├── timer.py         # Clock/IntervalTimer abstractions
│   │   │   │       ├── manager.py       # FocusSessionManager (active-session registry)
│   │   │   │       ├── ports.py         # TaskTimeSink / SessionStore protocols
│   │   │   │       └── errors.py
│   │   │   ├── services/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── recurrence.py    # compute_next() engine (§4.5)
│   │   │   │   ├── tasks.py         # complete_task() incl. recurrence roll
│   │   │   │   └── sync.py          # oplog merge: HLC field-level LWW (SYNC_STRATEGY §5)
│   │   │   └── routers/
│   │   │       ├── __init__.py
│   │   │       ├── tasks.py  focus.py  sync.py
│   │   │       └── insights.py      # intention-loop stub (canned coaching, TODO(LLM))
│   │   └── tests/
│   │       ├── conftest.py
│   │       ├── test_schemas.py  test_recurrence.py
│   │       ├── test_focus_controller.py
│   │       └── test_sync_merge.py  test_api.py
│   └── web/                         # Next.js 14 App Router (TS, Tailwind, lucide)
│       ├── package.json  next.config.mjs  tsconfig.json
│       ├── tailwind.config.ts  postcss.config.mjs
│       └── src/
│           ├── app/
│           │   ├── layout.tsx  page.tsx  globals.css   # shell + capture view
│           │   ├── focus/page.tsx                      # deep-work view
│           │   └── review/page.tsx                     # intention loop (stub)
│           ├── lib/
│           │   ├── db/
│           │   │   ├── schema.ts        # Dexie tables incl. _oplog/_meta (§7.1)
│           │   │   └── repository.ts    # tracked writes: entity+oplog atomically
│           │   ├── sync/
│           │   │   ├── hlc.ts           # hybrid logical clock (same format as hlc.py)
│           │   │   └── engine.ts        # push/pull loop, cursors, backoff (§7 + SYNC doc)
│           │   ├── events/bus.ts        # typed client event bus (§7.3)
│           │   ├── nlp/parser.ts        # quick-add grammar (§7.4)
│           │   ├── recurrence/next.ts   # mirror of services/recurrence.py
│           │   └── audio/engine.ts      # ambient loop keyed to timer state (§7.5)
│           ├── hooks/
│           │   ├── useLiveQuery.ts      # dexie-react-hooks wrapper (excludes tombstones)
│           │   └── useFocusTimer.ts     # WS events + REST actions + local countdown
│           └── components/
│               ├── capture/QuickAdd.tsx     # NLP input with live parse chips
│               ├── capture/VoiceCapture.tsx # Ramble stub (MediaRecorder → TODO STT)
│               ├── tasks/ListView.tsx  tasks/BoardView.tsx  tasks/CalendarView.tsx  # thin view stubs
│               ├── focus/TimerHUD.tsx       # timer, presets, controls, ambient picker
│               └── shield/FocusShield.tsx   # distraction interceptor skeleton (§7.6)
```

Not included by design (MVP): auth/multi-user, Alembic migrations (SQLite `create_all` on startup; see SYNC doc §7), real LLM calls (stubbed behind service functions), audio asset files.

---

## 3. Conventions (all languages)

- **Wire format:** snake_case field names **everywhere, including TypeScript interfaces**. No camelCase mapping.
- **IDs:** uuid4, serialized as 36-char lowercase strings, generated client-side (or server-side for server-originated writes).
- **Datetimes:** timezone-aware UTC, ISO-8601 with `Z`/offset. Dates as `YYYY-MM-DD`. Never naive datetimes. Python helper `utcnow()` in `schemas/base.py`.
- **Durations:** integer **seconds** in stored state (`work_seconds`, `actual_focus_seconds`); **minutes** only in user-facing estimates (`estimated_minutes`) and preset definitions.
- **HLC (hybrid logical clock) string:** `f"{unix_ms:013d}-{counter:04x}-{device8}"` where `device8` = first 8 hex chars of the device uuid. Zero-padded so **lexicographic order == causal order**. Identical format in `app/schemas/hlc.py` and `lib/sync/hlc.ts`.
- **Weekdays:** integers 0=Monday … 6=Sunday (ISO).
- **Python:** PEP 8, full type hints, Pydantic v2 idioms (`ConfigDict`, `field_validator`, `model_validator`), SQLAlchemy 2.0 typed style (`Mapped[]`, `mapped_column`), async handlers end-to-end.
- **Soft delete:** rows are never hard-deleted during normal operation; `deleted_at` tombstone set instead (GC per SYNC doc §8).

---

## 4. Data Contract (Deliverable 2 specification)

### 4.1 Enums — `app/schemas/enums.py` (TS mirror: `packages/schemas/ts/enums.ts`)

```python
class Priority(IntEnum):            # Todoist convention: P1 = highest
    P1 = 1; P2 = 2; P3 = 3; P4 = 4

class EnergyLevel(str, Enum):       LOW = "low"; MEDIUM = "medium"; HIGH = "high"
class TaskStatus(str, Enum):        PENDING = "pending"; IN_PROGRESS = "in_progress"; COMPLETED = "completed"; ARCHIVED = "archived"
class SessionState(str, Enum):      IDLE = "idle"; ACTIVE_WORK = "active_work"; PAUSED = "paused"; BREAK = "break"; COMPLETED = "completed"
class SessionOutcome(str, Enum):    COMPLETED = "completed"; ABANDONED = "abandoned"
class FocusPreset(str, Enum):       SPRINT = "sprint"; FOCUS = "focus"; FLOW = "flow"; DEEP_WORK = "deep_work"
class RecurrenceFrequency(str, Enum): DAILY = "daily"; WEEKLY = "weekly"; MONTHLY = "monthly"; YEARLY = "yearly"
class RecurrenceAnchor(str, Enum):  SCHEDULED = "scheduled"; COMPLETED = "completed"
class SyncOpType(str, Enum):        CREATE = "create"; UPDATE = "update"; DELETE = "delete"
class EntityType(str, Enum):        TASK = "task"; PROJECT = "project"; SECTION = "section"; VISION = "vision"; SEASON = "season"; FOCUS_SESSION = "focus_session"; DAILY_REVIEW = "daily_review"
class ViewMode(str, Enum):          LIST = "list"; BOARD = "board"; CALENDAR = "calendar"
class CaptureSource(str, Enum):     TEXT = "text"; VOICE = "voice"; API = "api"
class AmbientTrack(str, Enum):      NONE = "none"; WHITE_NOISE = "white_noise"; BINAURAL = "binaural"; LOFI = "lofi"; RAIN = "rain"
class SeasonStatus(str, Enum):      PLANNED = "planned"; ACTIVE = "active"; COMPLETED = "completed"
```

Preset durations (cognitive-load ladder) — expose on `FocusPreset` as `work_minutes` / `break_minutes` properties backed by a module-level table, mirrored in TS as `PRESET_DURATIONS`:

| preset | work_minutes | break_minutes |
|---|---|---|
| sprint | 15 | 3 |
| focus | 30 | 5 |
| flow | 45 | 10 |
| deep_work | 90 | 15 |

### 4.2 Embedded value objects

All Pydantic models extend `FEBase` (`schemas/base.py`) with `model_config = ConfigDict(from_attributes=True, extra="forbid")`.

```python
class RecurrenceRule(FEBase):                       # schemas/recurrence.py
    frequency: RecurrenceFrequency
    interval: int = Field(default=1, ge=1)          # every N units
    weekdays: list[int] | None = None               # WEEKLY: 0=Mon..6=Sun
    ordinal: int | None = Field(default=None)       # MONTHLY: 1..4, or -1 = last
    ordinal_weekday: int | None = None              # MONTHLY ordinal: which weekday
    workdays_only: bool = False                     # DAILY: steps count Mon–Fri only
    anchor: RecurrenceAnchor = RecurrenceAnchor.SCHEDULED
    until: date | None = None                       # inclusive end
    count: int | None = Field(default=None, ge=1)   # max occurrences
    raw: str | None = None                          # original NLP phrase

class DueInfo(FEBase):                              # schemas/due.py
    date: date
    time: time | None = None
    timezone: str = "UTC"                           # IANA name
    recurrence: RecurrenceRule | None = None

class NLPMetadata(FEBase):                          # schemas/nlp.py
    raw_input: str
    source: CaptureSource = CaptureSource.TEXT
    extracted: dict[str, Any] = Field(default_factory=dict)  # e.g. {"date_text": "tomorrow at 4pm", "priority_text": "p1"}
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    parser_version: str = "1.0.0"

class SessionSegment(FEBase):                       # schemas/focus.py
    state: SessionState                             # ACTIVE_WORK or BREAK only
    started_at: datetime
    ended_at: datetime | None = None
```

### 4.3 Entities

Every synced entity carries the **audit/sync block** (define once, reuse):
`created_at: datetime`, `updated_at: datetime`, `deleted_at: datetime | None = None`, `updated_hlc: str`, `device_id: str | None = None`.

```python
class Task(FEBase):                                 # schemas/task.py — the unified schema
    id: UUID
    user_id: UUID | None = None                     # single-user MVP
    project_id: UUID | None = None                  # None = Inbox
    section_id: UUID | None = None
    parent_id: UUID | None = None                   # nested subtasks, arbitrary depth
    title: str = Field(min_length=1, max_length=500)
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: Priority = Priority.P4
    labels: list[str] = Field(default_factory=list) # lowercase, no leading '#'
    due: DueInfo | None = None
    energy_required: EnergyLevel = EnergyLevel.MEDIUM
    estimated_minutes: int | None = Field(default=None, gt=0)
    actual_focus_seconds: int = 0                   # DERIVED — see §4.5
    season_id: UUID | None = None                   # Goal-to-Action GPS alignment
    child_order: float = 0.0                        # fractional ordering among siblings
    completion_count: int = 0                       # recurring-task completions
    last_completed_at: datetime | None = None
    nlp: NLPMetadata | None = None
    # + audit/sync block
```

Companion models: `TaskCreate` (all fields optional except `title`; `id` defaults to `uuid4()`; audit fields server-stamped) and `TaskUpdate` (every field optional — a sparse patch). Same Create/Update pattern for the other entities.

```python
class Project(FEBase):    id; name: str(1..120); color: str = "#808080"; view_mode: ViewMode = LIST; parent_id: UUID|None; child_order: float = 0.0; is_archived: bool = False; +audit/sync
class Section(FEBase):    id; project_id: UUID; name: str(1..120); child_order: float = 0.0; +audit/sync
class Vision(FEBase):     id; title: str(1..200); narrative: str = ""; horizon_years: int = 3; is_archived: bool = False; +audit/sync
class Season(FEBase):     id; vision_id: UUID|None; title: str(1..200); objective: str = ""; key_results: list[str] = []; starts_on: date; ends_on: date; status: SeasonStatus = PLANNED; +audit/sync
    # model_validator: if ends_on omitted → starts_on + 83 days (12 weeks, inclusive)
class FocusSession(FEBase): id; task_id: UUID; preset: FocusPreset; planned_cycles: int|None = None;  # None = run until complete()/abandon()
    state: SessionState = IDLE; outcome: SessionOutcome|None = None
    started_at: datetime|None = None; ended_at: datetime|None = None
    work_seconds: int = 0; break_seconds: int = 0; cycles_completed: int = 0
    segments: list[SessionSegment] = []; ambient_track: AmbientTrack = NONE
    energy_after: EnergyLevel|None = None; +audit/sync
class DailyReview(FEBase): id; date: date; energy_level: int = Field(ge=1, le=5); mood: str|None = None
    focus_seconds: int = 0; tasks_completed: int = 0
    highlights: str = ""; friction: str = ""; ai_feedback: str|None = None; +audit/sync
```

### 4.4 Sync envelope — `app/schemas/sync.py` (TS mirror: `sync.ts`)

```python
class SyncOp(FEBase):
    op_id: str                       # f"{hlc}:{entity}:{entity_id}" — idempotency key
    entity: EntityType
    entity_id: UUID
    op: SyncOpType
    patch: dict[str, Any] | None    # CREATE: full doc · UPDATE: changed fields only · DELETE: None
    hlc: str
    device_id: str

class PushRequest(FEBase):  device_id: str; ops: list[SyncOp] = Field(max_length=500); last_server_seq: int = 0
class PushResponse(FEBase): applied: list[str]; skipped: list[str]; server_seq: int   # skipped = stale/duplicate (idempotent success)
class ServerOp(SyncOp):     server_seq: int
class PullResponse(FEBase): ops: list[ServerOp]; next_seq: int; has_more: bool
```

### 4.5 Semantics that implementations MUST honor

**Derived fields.** `DERIVED_FIELDS = {"task": {"actual_focus_seconds"}}` (constant in `services/sync.py`). These are stripped from any incoming sync patch; the server recomputes `actual_focus_seconds = SUM(focus_sessions.work_seconds WHERE task_id = …)` whenever a `focus_session` op touching `work_seconds` is applied. Rationale: additive cross-device counters cannot be LWW-merged safely; sessions are append-only facts owned by one device, so the sum is conflict-free.

**Recurrence engine** — `services/recurrence.py`:
```python
def compute_next(rule: RecurrenceRule, after: date, base: date) -> date | None
```
- `anchor=SCHEDULED` (strict schedule): step from `base` (the original due date) by the rule repeatedly; return the first occurrence strictly `> after`.
- `anchor=COMPLETED`: step exactly once forward from `after` (the completion date).
- `workdays_only=True` (with DAILY): each of the `interval` steps advances to the next Mon–Fri day (weekends don't count). "every 2 workdays" → `DAILY, interval=2, workdays_only=True`; Thu → next Mon.
- MONTHLY with `ordinal`/`ordinal_weekday`: e.g. "every last Friday of the month" → `MONTHLY, ordinal=-1, ordinal_weekday=4`. Compute that weekday of the target month; months advance by `interval`.
- WEEKLY with `weekdays`: next listed weekday after the cursor; weeks advance by `interval` after the last listed weekday.
- Returns `None` when `until`/`count` is exhausted.

Canonical resolutions for cases the rules above leave open (v1.1 clarification — client `lib/recurrence/next.ts` and server `services/recurrence.py` MUST agree; T5 verifies with concrete cases):
- MONTHLY without `ordinal`: same day-of-month, **clamped to the target month's last day** (Jan 31 → Feb 28/29). YEARLY: same date next year, Feb 29 clamped to Feb 28.
- WEEKLY without `weekdays`: defaults to the base date's weekday.
- `count` semantics: under `anchor=SCHEDULED`, enforced inside `compute_next` (occurrence index from `base`). Under `anchor=COMPLETED`, `compute_next` cannot know the occurrence index, so the **caller** (`complete_task` / `completeTask`) enforces it: if `rule.count is not None and task.completion_count >= rule.count` (checked after incrementing), the series ends → task completes.

**Recurring completion** — `services/tasks.py::complete_task(task) `: if `task.due.recurrence` yields a next date → keep `status=PENDING`, set `due.date = next`, `completion_count += 1`, `last_completed_at = utcnow()`; else → `status=COMPLETED`, `last_completed_at = utcnow()`. All server-originated mutations (this, and focus-time increments) are **stamped with a new HLC (device `"server"`) and appended to the server oplog** so they propagate to clients on pull.

### 4.6 SQLAlchemy mapping rules — `app/models/*`

- SQLAlchemy 2.0 typed ORM: `class Base(DeclarativeBase)`, `Mapped[...]`/`mapped_column`.
- Mixins in `db/base.py`: `TimestampMixin` (created_at, updated_at), `SyncMixin` (updated_hlc `String(40)` indexed, device_id, deleted_at, **`field_hlcs: JSON` default `{}`** — per-field HLC map used by the merge, see SYNC doc §5).
- IDs: `String(36)` primary keys. Datetimes stored UTC.
- Nested structures (`due`, `segments`, `nlp`, `labels`, `key_results`, `patch`) → `JSON` columns. **Never mutate a JSON value in place; always assign a fresh dict/list** (SQLite JSON columns don't track mutations).
- `models/sync.py::ServerOplog`: `server_seq` Integer PK autoincrement, `op_id` unique-indexed, entity, entity_id (indexed), op, patch JSON, hlc, device_id (indexed), received_at.
- Useful indexes: task(project_id), task(section_id), task(parent_id), task(season_id), task(status), focus_session(task_id).

---

## 5. FocusController State Machine (Deliverable 3 specification)

Location: `app/domain/focus/`. Pure domain logic — no FastAPI, no SQLAlchemy imports; persistence and task-time crediting go through **ports**.

### 5.1 States & transition table

`SessionState`: `IDLE → ACTIVE_WORK ⇄ PAUSED`, `ACTIVE_WORK ⇄ BREAK`, all active states → `COMPLETED` (terminal).

```python
TRANSITIONS: dict[tuple[SessionState, str], SessionState] = {
    (IDLE,        "start"):         ACTIVE_WORK,
    (ACTIVE_WORK, "pause"):         PAUSED,
    (PAUSED,      "resume"):        ACTIVE_WORK,
    (ACTIVE_WORK, "work_elapsed"):  BREAK,       # handler may finalize to COMPLETED instead — see 5.4
    (BREAK,       "break_elapsed"): ACTIVE_WORK,
    (BREAK,       "skip_break"):    ACTIVE_WORK,
    (ACTIVE_WORK, "complete"):      COMPLETED, (PAUSED, "complete"): COMPLETED, (BREAK, "complete"): COMPLETED,
    (ACTIVE_WORK, "abandon"):       COMPLETED, (PAUSED, "abandon"): COMPLETED, (BREAK, "abandon"): COMPLETED,
}
```
Any (state, trigger) pair not in the table raises `InvalidTransition(state, trigger)` (in `errors.py`, alongside `FocusError`, `NoActiveSession`, `SessionAlreadyActive`). `COMPLETED` accepts nothing. Breaks are not pausable by design (use `skip_break`).

### 5.2 Files & interfaces

```python
# ports.py
class TaskTimeSink(Protocol):
    async def add_focus_seconds(self, task_id: UUID, seconds: int) -> None: ...
class SessionStore(Protocol):
    async def save(self, session: FocusSession) -> None: ...

# timer.py
class Clock(Protocol):
    def monotonic(self) -> float: ...
    def now(self) -> datetime: ...          # tz-aware UTC
class SystemClock: ...                       # time.monotonic / utcnow
class TimerHandle(Protocol):
    def cancel(self) -> None: ...
class TimerFactory(Protocol):                # schedule async callback after delay
    def schedule(self, delay_seconds: float, callback: Callable[[], Awaitable[None]]) -> TimerHandle: ...
class AsyncioTimerFactory: ...               # loop.call_later → asyncio.create_task
class ManualTimerFactory: ...                # tests: captures (delay, callback); .fire_next() awaits it

# events.py
@dataclass(frozen=True)
class FocusEvent:
    type: str; session_id: UUID; task_id: UUID; state: SessionState; at: datetime; data: dict[str, Any]
EVENT_SESSION_STARTED = "focus.session.started"    EVENT_SESSION_PAUSED   = "focus.session.paused"
EVENT_SESSION_RESUMED = "focus.session.resumed"    EVENT_BREAK_STARTED    = "focus.break.started"
EVENT_CYCLE_COMPLETED = "focus.cycle.completed"    EVENT_SESSION_COMPLETED = "focus.session.completed"
EVENT_TIME_ADDED      = "focus.task.time_added"    # data: {"seconds": int, "total_work_seconds": int}
class EventBus:
    def subscribe(self) -> asyncio.Queue[FocusEvent]        # bounded maxsize=256; on full: drop oldest, count drops
    def unsubscribe(self, q) -> None
    async def publish(self, event: FocusEvent) -> None      # never blocks on slow consumers

# controller.py
class FocusController:
    def __init__(self, *, task_id: UUID, preset: FocusPreset, planned_cycles: int | None = None,
                 bus: EventBus, time_sink: TaskTimeSink, store: SessionStore,
                 clock: Clock | None = None, timer_factory: TimerFactory | None = None,
                 on_finalized: Callable[["FocusController"], None] | None = None) -> None
    async def start(self) / pause(self) / resume(self) / skip_break(self) -> None
    async def complete(self) / abandon(self) -> None
    @property def state(self) -> SessionState
    @property def session(self) -> FocusSession               # deep copy / model_copy
    def remaining_seconds(self) -> int                        # pure computation, no side effects

# manager.py
class FocusSessionManager:                                     # single active session (MVP)
    async def start_session(self, task_id, preset, planned_cycles=None) -> FocusSession   # raises SessionAlreadyActive
    def get_active(self) -> FocusController | None
    async def pause/resume/skip_break/complete/abandon(self) -> FocusSession               # raise NoActiveSession
```

### 5.3 Invariants (the hard requirements)

1. **Concurrency.** Every public method and every timer callback mutates state under a single `asyncio.Lock`. Events are collected under the lock and **published after it is released**.
2. **Monotonic accounting.** Elapsed work time uses `clock.monotonic()` deltas only (wall clock only for display timestamps). Entering `ACTIVE_WORK` opens a segment; leaving it (pause/break/complete/abandon) closes the segment: `delta = round(monotonic_now - segment_start)`; `session.work_seconds += delta`; append/close the `SessionSegment`; `await time_sink.add_focus_seconds(task_id, delta)` **exactly once per segment** — this is the "securely updates the linked task's elapsed time" path (server-side atomic SQL increment; clients never send totals). Emit `EVENT_TIME_ADDED`. BREAK segments accrue `break_seconds` the same way (no sink call). PAUSED accrues nothing.
3. **Countdown continuity.** Pause must not reset the work countdown. Track `cycle_work_accum_seconds` (work done in the current cycle, reset on each cycle boundary); on (re)entering `ACTIVE_WORK`, schedule `work_elapsed` after `preset.work_minutes*60 - cycle_work_accum_seconds`.
4. **Stale-timer guard.** An epoch counter increments on every state entry; timer callbacks capture the epoch at scheduling time and no-op (under the lock) if the controller's epoch has moved on. Entering PAUSED/COMPLETED cancels any pending timer.
5. **Cycle handling** (`work_elapsed` fires): `cycles_completed += 1`, emit `EVENT_CYCLE_COMPLETED`; if `planned_cycles is not None and cycles_completed >= planned_cycles` → finalize as COMPLETED (outcome=COMPLETED); else → BREAK, schedule `break_elapsed` after `break_minutes*60`, emit `EVENT_BREAK_STARTED`. `break_elapsed` → ACTIVE_WORK (new cycle), emit `EVENT_SESSION_RESUMED` with `data={"cycle": n}`.
6. **Finalization** (complete/abandon/last-cycle): flush open segment, set `outcome`, `ended_at`, state=COMPLETED, cancel timer, `await store.save(session)`, emit `EVENT_SESSION_COMPLETED`, then call `on_finalized(self)` (manager uses it to clear its active slot). `store.save` is also called once at `start()` so a crash mid-session leaves a row.
7. **Purity.** `remaining_seconds()` computes from preset, accumulated cycle work, and (if ACTIVE_WORK) the open segment's monotonic elapsed — no mutation.

### 5.4 Server wiring (implemented in T4, consumed by routers)

`core/deps.py` builds one `EventBus` + one `FocusSessionManager` at lifespan startup, with `SqlTaskTimeSink` (atomic `UPDATE task SET actual_focus_seconds = actual_focus_seconds + :delta ... RETURNING actual_focus_seconds`, HLC-stamp, oplog append) and `SqlSessionStore` (upsert focus_session row + oplog append). WebSocket `/ws/focus/events` fans out bus events as JSON.

---

## 6. HTTP / WS API Surface (`apps/api/app/routers/`)

| Method & path | Body → Response | Notes |
|---|---|---|
| GET `/health` | → `{"status":"ok"}` | main.py |
| GET `/tasks` | filters: `project_id, season_id, status, label, parent_id` → `list[Task]` | excludes tombstones |
| POST `/tasks` | `TaskCreate` → `Task` (201) | server stamps hlc/audit, oplog append |
| GET `/tasks/{id}` | → `Task` | 404 if missing/deleted |
| PATCH `/tasks/{id}` | `TaskUpdate` → `Task` | sparse patch, oplog append |
| DELETE `/tasks/{id}` | → 204 | tombstone, oplog append |
| POST `/tasks/{id}/complete` | → `Task` | `complete_task` service (recurrence roll) |
| POST `/focus/sessions` | `{task_id, preset, planned_cycles?}` → `FocusSession` (201) | 409 `SessionAlreadyActive` |
| GET `/focus/sessions/active` | → `{session: FocusSession, remaining_seconds: int}` | 404 `NoActiveSession` |
| POST `/focus/sessions/active/{action}` | action ∈ pause,resume,skip-break,complete,abandon → `FocusSession` | 409 `InvalidTransition`, 404 `NoActiveSession` |
| WS `/ws/focus/events` | server→client stream of `FocusEvent` JSON | subscribe on connect |
| POST `/sync/push` | `PushRequest` → `PushResponse` | SYNC doc §4 |
| GET `/sync/pull?since={seq}&device_id={id}&limit={n=500}` | → `PullResponse` | echo-suppressed |
| GET `/sync/bootstrap` | → full snapshot `{tasks: [...], projects: [...], ..., server_seq}` | first sync / recovery |
| POST `/insights/daily-review` | `DailyReviewCreate` → `DailyReview` | `ai_feedback` = canned stub, `TODO(LLM)` marked |

Error mapping: domain errors → HTTP via exception handlers in `main.py` (`InvalidTransition`/`SessionAlreadyActive` → 409, `NoActiveSession` → 404).

---

## 7. Client Architecture (`apps/web`)

### 7.1 Dexie schema — `lib/db/schema.ts` (version 1)

```ts
tasks:          "id, project_id, section_id, parent_id, season_id, status, *labels, updated_hlc"
projects:       "id, parent_id"            sections: "id, project_id"
visions:        "id"                       seasons:  "id, vision_id, status"
focus_sessions: "id, task_id, state"       daily_reviews: "id, date"
_oplog:         "++seq, pushed, op_id, entity, entity_id"   // local change log
_meta:          "key"                                        // device_id, last_server_seq, hlc_last, shield_blocklist
```
Every entity row also carries `field_hlcs: Record<string, string>` (not indexed).

### 7.2 Repository rule — `lib/db/repository.ts`

All writes go through `createEntity/updateEntity/softDelete(table, …)`: one `db.transaction('rw', [table, '_oplog'], …)` that (a) applies the change + bumps `field_hlcs` per touched field, (b) appends the `_oplog` row (hlc ticked via `hlc.ts`, `pushed: 0`). **No component writes Dexie tables directly.** Task helpers: `createTaskFromParse(parsed)`, `completeTask(id)` (client-side mirror of the recurrence roll). Deletes set `deleted_at` (tombstone); UI queries filter `deleted_at == null`.

### 7.3 Client event bus — `lib/events/bus.ts`

Tiny typed pub/sub (`on(type, handler) → unsubscribe`, `emit(type, payload)`). Event name union: `task.created | task.updated | task.completed | task.deleted | focus.session.started | focus.session.paused | focus.session.resumed | focus.break.started | focus.cycle.completed | focus.session.completed | sync.started | sync.completed | sync.failed | shield.triggered` (v1.1: `shield.triggered` added — the FocusShield emits through this bus, payload `{reason: "visibility" | "navigation", at: ISO datetime}`; do not use DOM CustomEvents for it). Server focus events arriving on the WS are re-emitted verbatim on this bus — that is the task-engine ↔ focus-engine integration point (e.g. audio engine reacts without knowing about timers' internals).

### 7.4 NLP quick-add grammar — `lib/nlp/parser.ts`

`parseQuickAdd(input: string, now?: Date): ParsedQuickAdd` — pure function.
Token rules (case-insensitive; consumed tokens are stripped from the title; spans recorded in `meta.extracted`):
- **Priority:** `/\bp([1-4])\b/i` → priority 1–4 (default 4).
- **Labels:** `#word` (letters/digits/_/-) → labels[] (lowercased), may appear anywhere.
- **Dates:** `today`, `tod`, `tomorrow`, `tmr`, weekday names (`monday`… → next such day strictly after today), `next week` (next Monday), explicit `jul 15` / `15 jul` / `2026-07-15`.
- **Times:** `at 4pm`, `at 16:00`, `4:30pm` → `due.time` (24h `HH:MM`).
- **Recurrence:** `every day|week|month`, `every N days|workdays|weeks`, `every <weekday>`, `every last <weekday> of the month` → `RecurrenceRule` (also sets a due date of the first occurrence).
- Remaining text (whitespace-collapsed, trimmed) → `title`.

**Canonical acceptance example** (from product spec): `"Review network vulnerability report tomorrow at 4pm p1 #security"` parsed with now = 2026-07-12 →
`{ title: "Review network vulnerability report", due: { date: "2026-07-13", time: "16:00" }, priority: 1, labels: ["security"], recurrence: null }`.

### 7.4b API base URL

Client REST/WS calls read `NEXT_PUBLIC_API_BASE_URL`, defaulting to `http://localhost:8000` (uvicorn default; frontend dev server is 3000 per §5.4 CORS).

### 7.5 Ambient audio — `lib/audio/engine.ts`

`AmbientAudioEngine` (HTMLAudioElement, loop=true, src `/audio/<track>.mp3` — assets not shipped; document). Subscribes to the bus: `focus.session.started|resumed` → play at volume 1.0; `focus.break.started` → fade to 0.5; `focus.session.paused` → fade to 0; `focus.session.completed` → fade out & stop. `setTrack(track: AmbientTrack)`, `fadeTo(volume, ms)` (requestAnimationFrame ramp).

### 7.6 Focus Shield skeleton — `components/shield/FocusShield.tsx`

Client component mounted on the focus page. While timer state is `active_work`: listens to `document.visibilitychange` (tab-away → full-screen "Return to your task" overlay + bus event), warns on `beforeunload`, and exposes `isDistraction(url)` checked against `_meta.shield_blocklist`. Network-level blocking is explicitly a mock/documented extension point (comment pointing at a future Next.js middleware / browser-extension layer).

### 7.7 Views

`page.tsx` (capture): `QuickAdd` + live task list via `useLiveQuery`. `focus/page.tsx`: `TimerHUD` + `FocusShield`. `ListView/BoardView/CalendarView` are thin stubs over the same `tasks` live query (grouping by status-column / due-date respectively) — full interactions deferred. Dark minimal theme is default; `globals.css` defines CSS-variable token sets for `.theme-dark` and `.theme-neon` (high-contrast).

---

## 8. Synchronization

The complete blueprint — change capture, HLC, push/pull protocol, field-level LWW merge, tombstones, GC, failure modes — lives in **`docs/SYNC_STRATEGY.md`** (Deliverable 4). Server merge implementation: `app/services/sync.py`; client engine: `src/lib/sync/engine.ts`.
