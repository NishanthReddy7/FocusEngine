"use client";

/**
 * The Session Dial — DESIGN_SPEC §2, the one bold thing. A full-viewport SVG
 * chronograph: a thin ring of 60 tick marks where the elapsed fraction of the
 * current interval is lit in the state colour (amber while you work, sage on a
 * break) and the remainder stays a hairline; giant thin tabular mono digits at
 * the centre; a small-caps eyebrow (the active task) above and the cycle
 * readout below. Ring colour crossfades over 400ms on a state change; on a
 * BREAK the dial (and only the dial) breathes.
 *
 * The 60 ticks map the CURRENT interval (work or break) onto a clock face — the
 * cleanest faithful reading of "elapsed ticks lit… breaks render as a distinct
 * sage arc" for sessions that can also run open-ended. Where §2 is silent on
 * open-ended multi-cycle mapping, this is the implementer's resolution.
 */
import { SessionState } from "@focusengine/schemas/enums";

const TICKS = 60;
const CX = 200;
const CY = 200;

export interface SessionDialProps {
  state: SessionState;
  /** Seconds left in the current interval (already server-authoritative). */
  remainingSeconds: number;
  /** Full length of the current interval, seconds (work or break minutes × 60). */
  intervalTotalSeconds: number;
  /** Small-caps eyebrow above the digits — the active task title. */
  taskTitle: string | null;
  /** Mono readout below the digits, e.g. "CYCLE 2 · DEEP WORK 90/15". */
  cycleReadout: string;
  /** True once a session is live — drives the clockwise tick-draw on start. */
  running: boolean;
  /** Changes when a new session begins, re-triggering the draw-in animation. */
  drawKey: string;
  /** Offline / disconnected — shown as a quiet note, dial still renders. */
  offline?: boolean;
  /** Container max-width utility. Defaults to the desktop cockpit size; the
   *  mobile hero passes a wider ~86vw (A6). */
  sizeClassName?: string;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Round to 3 decimals so SSR (Node) and client (browser) serialize the SAME
 *  string for each coordinate — full-precision floats differ in their last
 *  digit across JS engines, which would otherwise trip a React hydration
 *  mismatch on these SVG attributes. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function tickAt(index: number, rInner: number, rOuter: number): Tick {
  // 0 at 12 o'clock, sweeping clockwise.
  const rad = ((index * (360 / TICKS) - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x1: r3(CX + rInner * cos), y1: r3(CY + rInner * sin), x2: r3(CX + rOuter * cos), y2: r3(CY + rOuter * sin) };
}

export function SessionDial({
  state,
  remainingSeconds,
  intervalTotalSeconds,
  taskTitle,
  cycleReadout,
  running,
  drawKey,
  offline = false,
  sizeClassName = "max-w-[min(78vh,560px)]",
}: SessionDialProps) {
  const isBreak = state === SessionState.BREAK;
  const litColor = isBreak ? "var(--break)" : "var(--work)";

  const total = intervalTotalSeconds > 0 ? intervalTotalSeconds : 1;
  const elapsed = Math.min(total, Math.max(0, total - remainingSeconds));
  const litCount = running ? Math.min(TICKS, Math.max(0, Math.round((elapsed / total) * TICKS))) : 0;

  // Announce only on minute boundaries (§10) — string derives from minutes
  // alone, so it doesn't change (and SR doesn't re-announce) every second.
  const minutesRemaining = Math.ceil(Math.max(0, remainingSeconds) / 60);

  return (
    <div className={`relative mx-auto aspect-square w-full ${sizeClassName}`}>
      <div className={`h-full w-full ${isBreak ? "dial-breathe" : ""}`}>
        {/* §3: glow allowed ONLY on the dial and ONLY in Neon — `--dial-glow`
            is transparent in Studio (so drop-shadow renders nothing there) and
            a work-tinted colour in Neon. */}
        <svg
          viewBox="0 0 400 400"
          className="h-full w-full"
          role="presentation"
          style={{ filter: "drop-shadow(0 0 9px var(--dial-glow))" }}
        >
          <g key={drawKey}>
            {Array.from({ length: TICKS }, (_, i) => {
              const lit = i < litCount;
              const t = lit ? tickAt(i, 171, 189) : tickAt(i, 178, 187);
              return (
                <line
                  key={i}
                  x1={t.x1}
                  y1={t.y1}
                  x2={t.x2}
                  y2={t.y2}
                  strokeWidth={lit ? 2 : 1.5}
                  strokeLinecap="round"
                  className="tick-draw"
                  style={{
                    stroke: lit ? litColor : "color-mix(in srgb, var(--text-muted) 32%, transparent)",
                    // Clockwise draw-in on start (§7); the crossfade on state
                    // change rides the same stroke transition.
                    animationDelay: `${i * 9}ms`,
                    transition: "stroke 400ms ease",
                  }}
                />
              );
            })}
          </g>
        </svg>
      </div>

      {/* Centre stack: eyebrow · digits · cycle readout, absolutely centred. */}
      <div className="settle-in pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-[18%] text-center">
        <p className="eyebrow line-clamp-1 max-w-full text-muted">{taskTitle ?? "No task selected"}</p>
        <p
          className="font-mono font-thin leading-none text-ink"
          style={{ fontSize: "clamp(88px, 16vw, 176px)", fontVariantNumeric: "tabular-nums" }}
        >
          {formatClock(remainingSeconds)}
        </p>
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          {cycleReadout}
        </p>
        {offline && (
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-overdue">Backend offline</p>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {running ? `${minutesRemaining} minutes remaining` : "Session idle"}
      </div>
    </div>
  );
}
