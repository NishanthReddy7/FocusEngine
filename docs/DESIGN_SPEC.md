# FocusEngine — Design Specification (binding)

**Status:** v1.0 · 2026-07-12 · Authored by the design lead. Binding for T7 (UI build-out) and audited by T6 (visual QA).
**Relationship to other docs:** visual/interaction layer over `ARCHITECTURE.md` §7. Where this doc is silent, the implementer decides within the direction below and reports the choice.

---

## 1. Design thesis

FocusEngine is a **precision instrument for attention** — closer to a chronograph, a metronome, a studio console than to a SaaS dashboard. The interface is a quiet, warm-graphite panel on which **color exists only to express the state of your attention**: amber while you work, sage while you recover. Capture surfaces are dense and typographic, like a well-set timetable; the focus surface is a cockpit — chrome recedes, one dial remains.

**Anti-defaults (hard):** no cream-paper + serif + terracotta look; no gradient-purple SaaS cards; no glassmorphism; no shadow-2xl float; no 24px-radius-everything; no emoji in headings; no motivational-poster copy. The dark theme must read *warm graphite studio*, explicitly NOT the generic near-black + acid-green default — that energy is reserved for the Neon theme, where the product brief itself demands it and where it is executed minimally.

## 2. Signature element (the one bold thing)

**The Session Dial** (`components/focus/TimerHUD.tsx`): a full-viewport-centered SVG chronograph —
- a thin ring (1.5px stroke) of **60 tick marks**; elapsed ticks lit in the state color, remaining ticks hairline; breaks render as a distinct sage arc segment so a whole session reads like a flight recorder of your cycles;
- giant thin tabular digits in the center (`IBM Plex Mono` 200, `clamp(88px, 16vw, 176px)`, `font-variant-numeric: tabular-nums`) — `mm:ss`;
- above the digits, a small-caps letterspaced eyebrow with the active task title; below, the cycle readout `CYCLE 2 · DEEP WORK 90/15` in 11px mono small-caps;
- state changes crossfade the ring color over 400ms; during BREAK the dial (only the dial) breathes: scale 1.00→1.015, 4s ease-in-out loop.

Everything else on every screen stays quiet so this dial is the thing people remember.

## 3. Tokens

Implement as CSS custom properties on `:root`/`.theme-dark` (default) and `.theme-neon` in `globals.css`; Tailwind consumes them via `tailwind.config.ts` color aliases. Never hard-code hexes in components.

### Theme "Studio" (`.theme-dark`, default)
```
--bg:            #111013;   /* warm graphite, not blue-black */
--surface:       #18171B;
--surface-2:     #201F24;
--hairline:      rgba(235, 230, 220, 0.08);
--text:          #E9E4DA;   /* warm ivory */
--text-muted:    #96918A;
--work:          #E2A33D;   /* "filament" amber — ACTIVE_WORK, primary actions, focus rings */
--break:         #8FB996;   /* "sage" — BREAK state, success, streaks */
--overdue:       #D96C5A;
--p1: #E5484D;  --p2: #E2A33D;  --p3: #6E9BD1;  --p4: #96918A;   /* priority ring hues */
--energy-low: #6E9BD1; --energy-medium: #E2A33D; --energy-high: #E5484D;
```

### Theme "Neon" (`.theme-neon`, high-contrast minimal)
```
--bg: #000000;  --surface: #0A0A0A;  --surface-2: #121212;
--hairline: rgba(83, 255, 200, 0.22);
--text: #EFFFFA;  --text-muted: #7BA599;
--work: #53FFC8;  --break: #FF4FD8;  --overdue: #FF6B4A;
--p1: #FF4FD8;  --p2: #53FFC8;  --p3: #4AC8FF;  --p4: #7BA599;
```
Glow (`box-shadow: 0 0 24px color-mix(in srgb, var(--work) 35%, transparent)`) is allowed **only** on the Session Dial and only in Neon.

Theme toggle lives in the nav rail (Sun/MoonStar lucide icons are wrong metaphors — use `CircleDot` for Studio / `Zap` for Neon); persists to `_meta.theme` via the repository.

## 4. Typography

Load via `next/font/google` with `display: "swap"` and system fallbacks (build must not break offline — wrap in the documented fallback pattern).

| Role | Face | Usage |
|---|---|---|
| Display | **Archivo** 600, `letter-spacing:-0.01em`; small-caps eyebrows: Archivo 500 11px, `letter-spacing:0.14em`, uppercase | headings, view titles, eyebrows ("TODAY", "SEASON · WK 4/12"), wordmark "FOCUSENGINE" |
| Body/UI | **Instrument Sans** 400/500 | task titles, inputs, controls, prose |
| Data | **IBM Plex Mono** 200/400, tabular-nums | timer digits, durations, dates, counts, chart labels |

Scale: 11 (eyebrow/meta) · 13 (secondary) · 15 (body/task title) · 18 · 24 · 32 (view heading) · dial clamp. Line-height 1.5 body, 1.1 headings. All numerals everywhere are tabular.

## 5. Layout system

- 4px base grid; radii: 6px (chips, inputs), 10px (cards) — nothing rounder; borders are hairline 1px `var(--hairline)`; elevation via surface steps, not shadows (Studio theme has NO drop shadows).
- **App shell:** left icon rail 56px (wordmark glyph, Capture/Focus/Review icons, theme toggle, sync status dot) → collapsible sidebar 240px (Inbox, Today, Upcoming; PROJECTS eyebrow + list; SEASONS eyebrow + active season with `WK n/12` mono badge) → content.
- **Capture (`/`):** content column `max-w-2xl` centered for List view; Board/Calendar go full-width with 24px gutters. QuickAdd is the hero at top: 56px tall borderless `--surface` bar, 15px Instrument Sans, placeholder `Try: "Review vulnerability report tomorrow at 4pm p1 #security"`.
- **Focus (`/focus`):** cockpit — rail collapses to a 8px hover strip, no sidebar; dial centered in `min-h-screen`; a single quiet control row under the dial (Start/Pause/Resume, Skip break, End — text buttons, hairline separators); bottom-left tiny mono readout for ambient track (`AUDIO · LOFI`), bottom-right shield status (`SHIELD · ARMED`). Preset picker = 4-segment control labeled `15/3 · 30/5 · 45/10 · 90/15` with names beneath.
- **Review (`/review`):** 12-col grid of instrument cards (see §8) + the evening check-in card.

## 6. Components (states required: default / hover / focus-visible / active / disabled / empty / loading)

- **QuickAdd:** as the user types, parsed tokens become inline **chips rendered live under the input**: date chip (mono, work-color outline), priority chip (`P1`–`P4` filled with priority hue at 15% alpha + hue text), label chips (`#security`, surface-2 pill), recurrence chip (`↻ every 2 workdays`). Enter commits; chips animate in 150ms ease-out. `q` focuses it from anywhere; Esc blurs.
- **TaskRow (40px):** priority ring checkbox (2px ring in `--p{n}`, fills state color on hover, check animates 200ms); title 15px; meta row 11px mono: due (overdue in `--overdue`), labels, energy glyph (`▁ ▃ ▅` low/med/high in energy hue), accumulated focus time (`1h 20m`). Hover: `--surface` wash + a small `Play` icon button appears (start focus session on this task) — the capture→focus bridge.
- **BoardView:** status columns (Pending / In progress / Completed) as hairline-bordered lanes, WIP counts in mono; cards = compact TaskRows. Move via card overflow menu (no drag-drop dependency; note as extension point).
- **CalendarView:** 7-day week grid, 1px hairlines, hour rows 07–22; tasks with due times render as blocks tinted by priority at 12% alpha; all-day row on top; today column gets a `--work` hairline highlight.
- **FocusShield overlay:** full-screen `--bg` at 96% with centered eyebrow `SHIELD` + line "You left during a work interval." + one action "Return to task". No shame copy.
- **Empty states:** one 13px muted line + one action, e.g. Today: "Nothing due today. Pull one task from Upcoming." Never illustrations.
- **Sync dot (rail):** 6px dot — muted (idle), work-color pulse (syncing), overdue-color (failed, tooltip with retry action).

## 7. Motion

One orchestrated moment: **starting a session** — shell chrome fades/slides out (200ms), dial ticks draw in clockwise (600ms ease-out), digits settle last (150ms fade). Everything else: 150–200ms ease-out micro-transitions only. BREAK breathing per §2. `prefers-reduced-motion`: replace all of the above with simple opacity swaps; the breathing stops.

## 8. Review dashboard (charts — hand-rolled SVG, no chart libraries)

Monochrome ink (`--text-muted`) + state accents only; hairline axes; 11px mono labels; every chart in an instrument card with an eyebrow title and one mono headline stat.

1. **Focus vs. completion (14 days):** dual-encoding column chart — bars = focus hours (`--work` at 70%), overlaid dot-line = tasks completed (`--text`); today's column full-opacity.
2. **Energy correlation:** dot-strip — x = hour of completion, y = self-reported energy 1–5, dots in energy hue; a muted median line. Reads "when am I actually good."
3. **Streak:** the signature tick motif reused — a row of 60 day-ticks like the dial's ring unrolled; kept-streak ticks lit `--break`, gaps hairline; current streak as the mono headline (`12 DAYS`).

Data from Dexie live queries (focus_sessions, daily_reviews, tasks). With no data: render the empty state + a dev-only "Seed demo data" text button (calls `lib/dev/seed.ts`).

## 9. Voice & copy

Plain verbs, sentence case, instrument register. "Start session", "Skip break", "End early", "Saved" — the button's verb matches its toast. Errors say what happened and the next step ("Sync failed. Retrying in 30s."); never apologize, never vague. No exclamation marks anywhere in the UI.

## 10. Accessibility & quality floor (non-negotiable)

WCAG AA contrast in BOTH themes (verify the muted-on-surface pairs); visible `:focus-visible` rings (2px `--work`, 2px offset) on every interactive element; icon-only buttons get `aria-label`; the timer announces via `aria-live="polite"` on minute boundaries only; full keyboard path: `q` quick-add, `Esc` blur/close, `Space` start-pause on focus view, arrows navigate task list; hit targets ≥ 32px; responsive to 375px (rail becomes bottom tab bar, dial scales via clamp, board scrolls horizontally with snap).
