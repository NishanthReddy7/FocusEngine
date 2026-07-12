# FocusEngine

FocusEngine merges two workflows over one shared, local-first data model:

- **High-velocity capture** (Todoist core): NLP quick-add, projects/sections/nested
  subtasks, list/board/calendar views, advanced recurrence.
- **Deep-work execution** (Superfocus core): Vision → Season (12-week) → Daily
  Action pipeline, state-driven focus timers, ambient audio, distraction shield,
  intention-loop coaching.

The client (Dexie/IndexedDB) is the source of truth; the FastAPI/SQLite backend
is a sync relay and durability layer, not a gatekeeper. The web app is fully
functional offline. See `docs/ARCHITECTURE.md` and `docs/SYNC_STRATEGY.md` for
the binding contracts this repo implements.

## Repo layout

```
focusengine/
├── README.md                        # this file
├── package.json                     # pnpm workspace root (private)
├── pnpm-workspace.yaml              # apps/web, packages/*
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md              # binding contracts: data model, state machine, API, client architecture
│   └── SYNC_STRATEGY.md             # local-first sync blueprint (HLC, oplog, field-level LWW merge)
├── packages/
│   └── schemas/                     # shared contract types (TS mirror of ARCHITECTURE.md §4)
│       ├── package.json
│       └── ts/
│           ├── enums.ts             # string/int enums + PRESET_DURATIONS
│           ├── entities.ts          # Task, Project, Season, FocusSession, …
│           └── sync.ts              # SyncOp, Push/Pull payloads, DERIVED_FIELDS
├── apps/
│   ├── api/                         # FastAPI backend (Python >=3.11) — see apps/api once T1/T2/T4 land
│   │   ├── pyproject.toml
│   │   ├── app/                     # schemas, models, domain/focus state machine, services, routers
│   │   └── tests/
│   └── web/                         # Next.js 14 App Router (TypeScript, Tailwind, lucide-react)
│       ├── package.json  next.config.mjs  tsconfig.json
│       ├── tailwind.config.ts  postcss.config.mjs
│       └── src/
│           ├── app/                 # layout, capture page, focus page, review page (stub)
│           ├── lib/
│           │   ├── db/              # Dexie schema + repository (all local writes go through here)
│           │   ├── sync/            # HLC + push/pull sync engine
│           │   ├── events/          # typed client event bus
│           │   ├── nlp/             # quick-add grammar parser
│           │   ├── recurrence/      # client-side mirror of the recurrence engine
│           │   └── audio/           # ambient audio engine (bus-driven)
│           ├── hooks/               # useLiveQuery, useFocusTimer
│           └── components/          # capture, tasks, focus, shield
```

## Quickstart

Backend (from `apps/api`, once its virtualenv is created per T1's steps):

```bash
cd apps/api
uvicorn app.main:create_app --factory --reload
```

Frontend (from the repo root):

```bash
pnpm dev
```

> Dependencies are pinned in the various `package.json`/`pyproject.toml` files
> but **not installed** as part of this scaffold — run `pnpm install` /
> create the Python venv yourself before running the above.

## Deliverable map

| # | Deliverable | Lives in |
|---|---|---|
| 1 | Monorepo scaffold | repo root, `packages/schemas`, `apps/web` config files (this task) |
| 2 | Unified data schemas | `docs/ARCHITECTURE.md` §4 (spec) → `apps/api/app/schemas` + `apps/api/app/models` (Python) and `packages/schemas/ts` (TS mirror) |
| 3 | FocusController state machine | `docs/ARCHITECTURE.md` §5 (spec) → `apps/api/app/domain/focus` |
| 4 | Local-first sync layer | `docs/SYNC_STRATEGY.md` (spec) → `apps/api/app/services/sync.py` (server merge) + `apps/web/src/lib/sync` (client engine) |

## What's stubbed (honest MVP boundary)

- **Voice capture** (`components/capture/VoiceCapture.tsx`) — records via
  `MediaRecorder`; speech-to-text is a marked `TODO`, not implemented.
- **Intention-loop / daily review** (`app/review/page.tsx`,
  `POST /insights/daily-review`) — `ai_feedback` is a canned stub
  (`TODO(LLM)`), not a real model call.
- **Board/Calendar views** (`components/tasks/BoardView.tsx`,
  `CalendarView.tsx`) — thin stubs over the same live task query; full
  drag/drop and calendar interactions are deferred.
- **Focus Shield network blocking** (`components/shield/FocusShield.tsx`) —
  visibility/beforeunload interception is real; URL-level network blocking is
  a documented extension point (future middleware/browser-extension layer),
  not implemented here.
- **Auth/multi-user, Alembic migrations, audio asset files** — explicitly out
  of scope for this MVP (see `docs/ARCHITECTURE.md` §2).

Not stubbed: NLP quick-add grammar, recurrence engine (both server and
client-side mirror), the FocusController state machine, and the full
local-first sync protocol (HLC, oplog, field-level LWW merge, tombstones) —
these are complete per their respective contract sections.
