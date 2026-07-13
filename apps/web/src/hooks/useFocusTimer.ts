"use client";

/**
 * Focus timer hook — drives the UI from the module-singleton local focus engine
 * (`lib/focus/localEngine.ts`), a client-side mirror of the ARCHITECTURE.md §5
 * FSM. The hosted app is a static export with no backend, so the timer must run
 * fully signed-out / offline with zero network: this hook no longer talks to the
 * server focus REST/WS surface at all (the backend API is left untouched — it is
 * simply no longer on the timer's critical path).
 *
 * State is read through `useSyncExternalStore`, so every mounted view (the HUD,
 * the shield) sees the same authoritative snapshot without a second poll/socket,
 * and an in-flight session survives client-side navigation because the engine is
 * a singleton. The engine emits the §7.3 bus events itself, so ambient audio and
 * the shield react exactly as they did when the WS re-emitted them.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { FocusPreset } from "@focusengine/schemas/enums";
import type { FocusSession } from "@focusengine/schemas/entities";
import { focusEngine } from "@/lib/focus/localEngine";

export interface UseFocusTimerResult {
  session: FocusSession | null;
  remainingSeconds: number;
  isConnected: boolean;
  error: string | null;
  start: (taskId: string, preset: FocusPreset, plannedCycles?: number | null) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  skipBreak: () => Promise<void>;
  complete: () => Promise<void>;
  abandon: () => Promise<void>;
}

export function useFocusTimer(): UseFocusTimerResult {
  const snapshot = useSyncExternalStore(
    focusEngine.subscribe,
    focusEngine.getSnapshot,
    focusEngine.getServerSnapshot,
  );

  const start = useCallback(
    (taskId: string, preset: FocusPreset, plannedCycles: number | null = null) =>
      focusEngine.start(taskId, preset, plannedCycles),
    [],
  );
  const pause = useCallback(() => focusEngine.pause(), []);
  const resume = useCallback(() => focusEngine.resume(), []);
  const skipBreak = useCallback(() => focusEngine.skipBreak(), []);
  const complete = useCallback(() => focusEngine.complete(), []);
  const abandon = useCallback(() => focusEngine.abandon(), []);

  return {
    session: snapshot.session,
    remainingSeconds: snapshot.remainingSeconds,
    isConnected: snapshot.isConnected,
    error: snapshot.error,
    start,
    pause,
    resume,
    skipBreak,
    complete,
    abandon,
  };
}
