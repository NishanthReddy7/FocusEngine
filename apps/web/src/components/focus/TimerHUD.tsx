"use client";

/**
 * Focus cockpit — DESIGN_SPEC §5 (focus). The Session Dial owns the centre;
 * one quiet row of text controls sits beneath it; a 4-segment preset picker
 * appears only when idle; the ambient-track readout sits bottom-left and the
 * shield status bottom-right. Chrome recedes so the dial is the thing you
 * remember.
 */
import { useEffect, useState } from "react";
import { AmbientTrack, FocusPreset, PRESET_DURATIONS, SessionState } from "@focusengine/schemas/enums";
import type { UseFocusTimerResult } from "@/hooks/useFocusTimer";
import { ambientAudioEngine } from "@/lib/audio/engine";
import { isMobileFlavor } from "@/lib/platform";
import { SessionDial } from "./SessionDial";

const PRESETS: readonly FocusPreset[] = [FocusPreset.SPRINT, FocusPreset.FOCUS, FocusPreset.FLOW, FocusPreset.DEEP_WORK];

const PRESET_NAME: Record<FocusPreset, string> = {
  [FocusPreset.SPRINT]: "Sprint",
  [FocusPreset.FOCUS]: "Focus",
  [FocusPreset.FLOW]: "Flow",
  [FocusPreset.DEEP_WORK]: "Deep work",
};

const AMBIENT_ORDER: readonly AmbientTrack[] = [
  AmbientTrack.NONE,
  AmbientTrack.LOFI,
  AmbientTrack.RAIN,
  AmbientTrack.WHITE_NOISE,
  AmbientTrack.BINAURAL,
];

function presetDurationLabel(preset: FocusPreset): string {
  const d = PRESET_DURATIONS[preset];
  return `${d.work_minutes}/${d.break_minutes}`;
}

function ambientLabel(track: AmbientTrack): string {
  return track === AmbientTrack.NONE ? "OFF" : track.toUpperCase().replace(/_/g, " ");
}

export interface TimerHUDProps {
  taskId: string | null;
  taskTitle: string | null;
  timer: UseFocusTimerResult;
}

export function TimerHUD({ taskId, taskTitle, timer }: TimerHUDProps) {
  const { session, remainingSeconds, isConnected, error, start, pause, resume, skipBreak, complete } = timer;
  const [preset, setPreset] = useState<FocusPreset>(FocusPreset.FOCUS);
  const [track, setTrack] = useState<AmbientTrack>(AmbientTrack.NONE);

  const state = session?.state ?? SessionState.IDLE;
  const isActive = state === SessionState.ACTIVE_WORK;
  const isPaused = state === SessionState.PAUSED;
  const isBreak = state === SessionState.BREAK;
  const isRunning = isActive || isPaused || isBreak;

  const activePreset = session?.preset ?? preset;
  const durations = PRESET_DURATIONS[activePreset];
  const intervalTotalSeconds = (isBreak ? durations.break_minutes : durations.work_minutes) * 60;

  const cycleNumber = (session?.cycles_completed ?? 0) + 1;
  const presetTag = `${PRESET_NAME[activePreset].toUpperCase()} ${presetDurationLabel(activePreset)}`;
  const cycleReadout = isRunning
    ? `CYCLE ${cycleNumber} · ${presetTag}${isPaused ? " · PAUSED" : ""}`
    : `READY · ${presetTag}`;

  // §10: Space toggles start/pause on the focus view (ignored while a control
  // or field has focus, so it doesn't double-fire with the button it lands on).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== "Space") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      event.preventDefault();
      if (isActive) void pause();
      else if (isPaused) void resume();
      else if (!isRunning && taskId) void start(taskId, preset);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, isPaused, isRunning, taskId, preset, pause, resume, start]);

  function cycleAmbient() {
    const idx = AMBIENT_ORDER.indexOf(track);
    const next = AMBIENT_ORDER[(idx + 1) % AMBIENT_ORDER.length] ?? AmbientTrack.NONE;
    setTrack(next);
    ambientAudioEngine.setTrack(next);
  }

  const controlBtn =
    "rounded-md px-4 py-2 text-secondary text-muted transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed";

  // 4-segment preset picker — idle only (§5).
  const presetPicker = !isRunning ? (
    <div
      role="radiogroup"
      aria-label="Session preset"
      className="flex divide-x divide-hairline overflow-hidden rounded-lg border border-hairline"
    >
      {PRESETS.map((p) => {
        const selected = p === preset;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPreset(p)}
            className={`flex w-24 flex-col items-center gap-1 px-3 py-2.5 transition-colors duration-150 ${
              selected ? "bg-surface-2" : "hover:bg-surface"
            }`}
          >
            <span className={`font-mono text-secondary ${selected ? "text-work" : "text-ink"}`}>
              {presetDurationLabel(p)}
            </span>
            <span className={`text-[11px] ${selected ? "text-ink" : "text-muted"}`}>{PRESET_NAME[p]}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  // Quiet control row (§5) — text buttons, hairline separators. On the mobile
  // hero this cluster lives at the bottom, in thumb reach (A6).
  const controlRow = (
    <div className="flex items-center gap-1">
      {!isRunning && (
        <button
          type="button"
          disabled={!taskId}
          onClick={() => taskId && void start(taskId, preset)}
          className="rounded-md px-4 py-2 text-secondary text-work transition-colors duration-150 hover:bg-surface disabled:cursor-not-allowed disabled:text-muted"
        >
          Start session
        </button>
      )}
      {isActive && (
        <button type="button" onClick={() => void pause()} className={controlBtn}>
          Pause
        </button>
      )}
      {isPaused && (
        <button type="button" onClick={() => void resume()} className={`${controlBtn} text-work hover:text-work`}>
          Resume
        </button>
      )}
      {isBreak && (
        <button type="button" onClick={() => void skipBreak()} className={controlBtn}>
          Skip break
        </button>
      )}
      {isRunning && (
        <>
          <span className="hairline-x mx-1 h-5" aria-hidden />
          <button type="button" onClick={() => void complete()} className={controlBtn}>
            End early
          </button>
        </>
      )}
    </div>
  );

  const errorNote = error ? (
    <p role="status" className="font-mono text-[11px] uppercase tracking-[0.14em] text-overdue">
      {error}
    </p>
  ) : null;

  // Ambient (bottom-left) + shield status (bottom-right) readouts (§5) — desktop
  // only; the mobile hero keeps the cockpit clean.
  const readouts = (
    <>
      <button
        type="button"
        onClick={cycleAmbient}
        aria-label={`Ambient audio: ${ambientLabel(track)}. Activate to change.`}
        className="fixed bottom-5 left-5 hidden font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink md:block"
      >
        Audio · {ambientLabel(track)}
      </button>
      <p
        className="fixed bottom-5 right-5 hidden font-mono text-[11px] uppercase tracking-[0.14em] md:block"
        style={{ color: isActive ? "var(--work)" : "var(--text-muted)" }}
      >
        Shield · {isActive ? "Armed" : "Standby"}
      </p>
    </>
  );

  const dial = (
    <SessionDial
      state={state}
      // Idle previews the selected preset's work time (e.g. 30:00) instead of
      // a flat 00:00; a live session shows the authoritative remaining count.
      remainingSeconds={isRunning ? remainingSeconds : intervalTotalSeconds}
      intervalTotalSeconds={intervalTotalSeconds}
      taskTitle={taskTitle}
      cycleReadout={cycleReadout}
      running={isRunning}
      drawKey={isRunning ? session?.id ?? "run" : "idle"}
      offline={!isConnected}
      sizeClassName={isMobileFlavor ? "max-w-[86vw]" : undefined}
    />
  );

  // Mobile hero (A6): full-bleed, dial ~86vw centered, controls in a bottom
  // thumb cluster, safe-area padded.
  if (isMobileFlavor) {
    return (
      <div
        className="flex min-h-dvh w-full flex-col items-center px-4 pt-14"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex w-full flex-1 items-center justify-center">{dial}</div>
        <div className="flex w-full flex-col items-center gap-5">
          {presetPicker}
          {controlRow}
          {errorNote}
        </div>
        {readouts}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-10 px-4 py-16">
      {dial}
      {presetPicker}
      {controlRow}
      {errorNote}
      {readouts}
    </div>
  );
}
