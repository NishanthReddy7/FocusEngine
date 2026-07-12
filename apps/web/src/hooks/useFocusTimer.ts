"use client";

/**
 * Focus timer hook — ARCHITECTURE.md §7 hooks list ("WS events + REST
 * actions + local countdown") over the §6 HTTP/WS surface. The WebSocket is
 * the authoritative source for session state (and is re-emitted verbatim on
 * the client bus, §7.3 — the task/focus-engine integration point); REST
 * calls are fire-and-forget actions whose effect we learn about from the
 * response *and* the WS event that follows. `remaining_seconds` itself is
 * always re-fetched from the server rather than recomputed here, since
 * `FocusController.remaining_seconds()` depends on server-side state
 * (preset, cycle accumulator, monotonic clock, §5.2/§5.3.7) this hook has no
 * access to — the 1s local interval only ticks the last known value down
 * smoothly between refreshes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FocusPreset, PRESET_DURATIONS, SessionState } from "@focusengine/schemas/enums";
import type { FocusSession } from "@focusengine/schemas/entities";
import { bus, type FocusEventPayload } from "../lib/events/bus";
import { authHeader, onAuthTokenChange, wsTokenParam } from "../lib/auth/token";

// Duplicated (not centralized) from lib/sync/engine.ts's identical constant:
// a shared config module isn't in this task's file list, and one line isn't
// worth an extra file.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

const FOCUS_BUS_EVENT_TYPES = [
  "focus.session.started",
  "focus.session.paused",
  "focus.session.resumed",
  "focus.break.started",
  "focus.cycle.completed",
  "focus.session.completed",
] as const;
type FocusBusEventType = (typeof FOCUS_BUS_EVENT_TYPES)[number];

function isFocusBusEventType(type: string): type is FocusBusEventType {
  return (FOCUS_BUS_EVENT_TYPES as readonly string[]).includes(type);
}

type FocusAction = "pause" | "resume" | "skip-break" | "complete" | "abandon";

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

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return `HTTP ${res.status}`;
}

export function useFocusTimer(): UseFocusTimerResult {
  const [session, setSession] = useState<FocusSession | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The focus WS (and its REST actions) now require the JWT (A2). Bump a tick
  // on any token change so the WS effect below reconnects with the new token;
  // REST calls read `authHeader()` fresh at call time.
  const [authTick, setAuthTick] = useState(0);
  useEffect(() => onAuthTokenChange(() => setAuthTick((n) => n + 1)), []);

  // Interval callbacks close over stale state in React; refs give the
  // countdown tick and the WS handler access to the latest values.
  const sessionRef = useRef<FocusSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const refreshActiveSession = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/focus/sessions/active`, { headers: { ...authHeader() } });
      if (res.status === 404) {
        setSession(null);
        setRemainingSeconds(0);
        return;
      }
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const body = (await res.json()) as { session: FocusSession; remaining_seconds: number };
      setSession(body.session);
      setRemainingSeconds(body.remaining_seconds);
      setError(null);
    } catch (err) {
      // Offline/unreachable API — local countdown keeps ticking with the
      // last known value; this hook never throws out to its caller.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Hydrate on mount.
  useEffect(() => {
    void refreshActiveSession();
  }, [refreshActiveSession]);

  // Local 1s countdown — only decrements while a session is actually
  // running (ACTIVE_WORK or BREAK); PAUSED/IDLE/COMPLETED freeze it.
  useEffect(() => {
    const id = setInterval(() => {
      const state = sessionRef.current?.state;
      if (state !== SessionState.ACTIVE_WORK && state !== SessionState.BREAK) return;
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // WebSocket: authoritative event stream, re-emitted verbatim on the bus
  // (ARCHITECTURE.md §7.3), and the trigger to refresh remaining_seconds.
  //
  // Auto-reconnect with exponential backoff (added in T7): the WS is the
  // authoritative session-state channel, so if it drops (server restart,
  // laptop sleep/wake, flaky network) we keep retrying — capped at ~30s —
  // instead of leaving the cockpit silently stale. All timers/handlers are
  // torn down on unmount so nothing reconnects after the component is gone.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const wsUrl = `${API_BASE.replace(/^http/, "ws")}/ws/focus/events${wsTokenParam()}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    // 0.5x–1.0x of min(30s, 2^attempt s): capped, with jitter so many tabs
    // reconnecting after a server blip don't stampede it.
    const backoffDelay = (): number => {
      const ceil = Math.min(30_000, 1_000 * 2 ** attempt);
      return ceil / 2 + Math.random() * (ceil / 2);
    };

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attempt += 1;
        connect();
      }, backoffDelay());
    };

    function connect(): void {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        setIsConnected(false);
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.onopen = () => {
        if (disposed) return;
        attempt = 0; // healthy connection → reset backoff
        setIsConnected(true);
        // A reconnect may have missed events while the socket was down —
        // re-pull the authoritative state immediately.
        void refreshActiveSession();
      };
      socket.onclose = () => {
        setIsConnected(false);
        scheduleReconnect();
      };
      socket.onerror = () => {
        setIsConnected(false);
        // onerror is normally followed by onclose (which schedules the retry);
        // closing here avoids leaking a half-open socket if it isn't.
        try {
          socket.close();
        } catch {
          // already closing/closed — nothing to do
        }
      };
      socket.onmessage = (event: MessageEvent) => {
        let focusEvent: FocusEventPayload;
        try {
          focusEvent = JSON.parse(event.data as string) as FocusEventPayload;
        } catch {
          return; // malformed frame — ignore, don't crash the handler
        }
        if (isFocusBusEventType(focusEvent.type)) {
          bus.emit(focusEvent.type, focusEvent);
        }
        void refreshActiveSession();
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        // Detach handlers so a close fired during teardown can't reschedule.
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
    // `authTick` re-runs this effect on a token change so the WS reconnects
    // carrying the new `?token=` (or drops it on sign-out).
  }, [refreshActiveSession, authTick]);

  const start = useCallback(
    async (taskId: string, preset: FocusPreset, plannedCycles: number | null = null) => {
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/focus/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader() },
          body: JSON.stringify({ task_id: taskId, preset, planned_cycles: plannedCycles }),
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const body = (await res.json()) as FocusSession;
        setSession(body);
        // Optimistic estimate until the WS event / refresh lands.
        setRemainingSeconds(PRESET_DURATIONS[preset].work_minutes * 60);
        void refreshActiveSession();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshActiveSession],
  );

  const runAction = useCallback(
    async (action: FocusAction) => {
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/focus/sessions/active/${action}`, {
          method: "POST",
          headers: { ...authHeader() },
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const body = (await res.json()) as FocusSession;
        setSession(body);
        void refreshActiveSession();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshActiveSession],
  );

  const pause = useCallback(() => runAction("pause"), [runAction]);
  const resume = useCallback(() => runAction("resume"), [runAction]);
  const skipBreak = useCallback(() => runAction("skip-break"), [runAction]);
  const complete = useCallback(() => runAction("complete"), [runAction]);
  const abandon = useCallback(() => runAction("abandon"), [runAction]);

  return { session, remainingSeconds, isConnected, error, start, pause, resume, skipBreak, complete, abandon };
}
