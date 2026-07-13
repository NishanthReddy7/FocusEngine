"use client";

/**
 * Local focus engine — a client-side mirror of the server `FocusController`
 * FSM (ARCHITECTURE.md §5) so the deep-work timer runs fully signed-out /
 * offline with zero network. The hosted static build has no backend, so the
 * previous WS+REST driven `useFocusTimer` did nothing on the live site; this
 * engine is the authoritative source instead.
 *
 * It honours the §5 semantics: states idle/active_work/paused/break/completed;
 * presets from PRESET_DURATIONS; `planned_cycles = null` runs until complete();
 * pause preserves the countdown (per-cycle work accumulator, §5.3.3); cycle
 * handling work→break→next cycle (§5.5); segments with started_at/ended_at;
 * outcome completed/abandoned. All *durations* are measured from
 * `performance.now()` monotonic deltas — never wall-clock — with an epoch guard
 * on the transition timers (§5.3.4); wall-clock is used only for display
 * timestamps.
 *
 * Persistence is what makes this sync (SYNC_STRATEGY.md §6): a `focus_session`
 * row is CREATEd on start and UPDATEd on every transition / finalize, and each
 * closed work segment increments the linked task's `actual_focus_seconds`
 * locally via `repository.updateEntity`. The server strips that derived field
 * from the incoming task patch and recomputes it from the append-only session
 * rows, so the optimistic local increment and the synced sessions stay
 * consistent.
 *
 * It emits the §7.3 bus events verbatim (same names the WS used to re-emit), so
 * the ambient audio engine, FocusShield and any UI react unchanged.
 *
 * The engine is a module singleton, so an in-flight session survives
 * client-side navigation within the SPA. A hard reload loses the in-memory
 * monotonic state, so any `focus_session` row left mid-flight is finalized as
 * ABANDONED on next load (recovery below).
 */
import {
  AmbientTrack,
  FocusPreset,
  PRESET_DURATIONS,
  SessionOutcome,
  SessionState,
} from "@focusengine/schemas/enums";
import type { FocusSession, SessionSegment } from "@focusengine/schemas/entities";
import type { StoredFocusSession } from "../db/schema";
import { db } from "../db/schema";
import { createEntity, updateEntity, type EntityPatch } from "../db/repository";
import { bus, type FocusEventPayload } from "../events/bus";

export interface FocusTimerSnapshot {
  session: FocusSession | null;
  /** Seconds left in the current interval (float; UI floors it for display). */
  remainingSeconds: number;
  /** Always true — the local engine needs no connection. Kept for the hook's
   *  public shape (a signed-out/offline session is fully "connected" locally). */
  isConnected: boolean;
  error: string | null;
}

const IDLE_SNAPSHOT: FocusTimerSnapshot = {
  session: null,
  remainingSeconds: 0,
  isConnected: true,
  error: null,
};

type FocusEmitType =
  | "focus.session.started"
  | "focus.session.paused"
  | "focus.session.resumed"
  | "focus.break.started"
  | "focus.cycle.completed"
  | "focus.session.completed";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function nowISO(): string {
  return new Date().toISOString();
}

class LocalFocusEngine {
  private state: SessionState = SessionState.IDLE;
  private sessionId: string | null = null;
  private taskId: string | null = null;
  private preset: FocusPreset = FocusPreset.FOCUS;
  private plannedCycles: number | null = null;

  private workSeconds = 0;
  private breakSeconds = 0;
  private cyclesCompleted = 0;
  /** Closed work-segment seconds within the CURRENT cycle — reset on every
   *  cycle boundary; the basis for pause/resume countdown continuity (§5.3.3). */
  private cycleWorkAccum = 0;

  private segments: SessionSegment[] = [];
  private openSeg: SessionSegment | null = null;
  private segmentStartPerf: number | null = null;

  private row: StoredFocusSession | null = null;

  /** Bumped on every state entry; a scheduled transition captures it and no-ops
   *  when the engine has moved on (§5.3.4). */
  private epoch = 0;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private error: string | null = null;

  private listeners = new Set<() => void>();
  private snapshot: FocusTimerSnapshot = IDLE_SNAPSHOT;
  private lastPublishedRemInt = -1;
  private lastPublishedState: SessionState = SessionState.IDLE;

  /** Serializes the read-modify-write task credits and the session-row writes so
   *  rapid transitions can't interleave into a lost update. */
  private writeChain: Promise<void> = Promise.resolve();

  private recovered = false;
  private recoverPromise: Promise<void> | null = null;

  constructor() {
    if (typeof window !== "undefined") void this.ensureRecovered();
  }

  // -- React binding (useSyncExternalStore) --------------------------------

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };

  getSnapshot = (): FocusTimerSnapshot => this.snapshot;

  getServerSnapshot = (): FocusTimerSnapshot => IDLE_SNAPSHOT;

  // -- Durations -----------------------------------------------------------

  private workTotalSeconds(): number {
    return PRESET_DURATIONS[this.preset].work_minutes * 60;
  }

  private breakTotalSeconds(): number {
    return PRESET_DURATIONS[this.preset].break_minutes * 60;
  }

  private openSegmentElapsed(): number {
    if (this.segmentStartPerf === null) return 0;
    return Math.max(0, (monotonicNow() - this.segmentStartPerf) / 1000);
  }

  /** Pure remaining-seconds computation (no side effects, §5.3.7). */
  private remaining(): number {
    switch (this.state) {
      case SessionState.ACTIVE_WORK:
        return Math.max(0, this.workTotalSeconds() - this.cycleWorkAccum - this.openSegmentElapsed());
      case SessionState.PAUSED:
        return Math.max(0, this.workTotalSeconds() - this.cycleWorkAccum);
      case SessionState.BREAK:
        return Math.max(0, this.breakTotalSeconds() - this.openSegmentElapsed());
      default:
        return 0;
    }
  }

  // -- Snapshot / publish --------------------------------------------------

  private liveSession(): FocusSession | null {
    if (!this.row || !this.sessionId) return null;
    return {
      ...this.row,
      state: this.state,
      work_seconds: this.workSeconds,
      break_seconds: this.breakSeconds,
      cycles_completed: this.cyclesCompleted,
      segments: this.segments,
    };
  }

  private forcePublish(): void {
    const remaining = this.remaining();
    this.lastPublishedRemInt = Math.floor(remaining);
    this.lastPublishedState = this.state;
    this.snapshot = {
      session: this.liveSession(),
      remainingSeconds: remaining,
      isConnected: true,
      error: this.error,
    };
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Tick path — only re-publishes when the displayed second or the state
   *  actually changed, so a PAUSED session doesn't churn React every second. */
  private maybePublish(): void {
    const remInt = Math.floor(this.remaining());
    if (remInt === this.lastPublishedRemInt && this.state === this.lastPublishedState) return;
    this.forcePublish();
  }

  // -- Timers --------------------------------------------------------------

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => this.maybePublish(), 1000);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private cancelTransition(): void {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  private scheduleTransition(delaySeconds: number, kind: "work_elapsed" | "break_elapsed"): void {
    this.cancelTransition();
    const epoch = this.epoch;
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      if (kind === "work_elapsed") this.onWorkElapsed(epoch);
      else this.onBreakElapsed(epoch);
    }, Math.max(0, delaySeconds * 1000));
  }

  // -- Segments & accounting ----------------------------------------------

  private openSegment(state: SessionState): void {
    this.segmentStartPerf = monotonicNow();
    const seg: SessionSegment = { state, started_at: nowISO(), ended_at: null };
    this.openSeg = seg;
    this.segments = [...this.segments, seg];
  }

  /** Closes the open segment, accrues its monotonic delta to the right total,
   *  and (for work) credits the task exactly once (§5.3.2). */
  private closeAndAccount(): void {
    const seg = this.openSeg;
    if (!seg || this.segmentStartPerf === null) return;
    const delta = Math.max(0, Math.round((monotonicNow() - this.segmentStartPerf) / 1000));
    seg.ended_at = nowISO();
    this.segments = [...this.segments];
    this.segmentStartPerf = null;
    this.openSeg = null;

    if (seg.state === SessionState.ACTIVE_WORK) {
      this.workSeconds += delta;
      this.cycleWorkAccum += delta;
      const taskId = this.taskId;
      if (delta > 0 && taskId) this.queueTaskCredit(taskId, delta);
    } else if (seg.state === SessionState.BREAK) {
      this.breakSeconds += delta;
    }
  }

  private queueTaskCredit(taskId: string, delta: number): void {
    this.writeChain = this.writeChain
      .then(async () => {
        const task = await db.tasks.get(taskId);
        if (!task || task.deleted_at) return;
        const current = task.actual_focus_seconds ?? 0;
        await updateEntity("tasks", taskId, { actual_focus_seconds: current + delta });
      })
      .catch(() => {
        /* offline/local write failure — never surfaces to the timer UI */
      });
  }

  private persistSession(patch: EntityPatch<"focus_sessions">): void {
    const id = this.sessionId;
    if (!id) return;
    if (this.row) this.row = { ...this.row, ...patch } as StoredFocusSession;
    this.writeChain = this.writeChain
      .then(() => updateEntity("focus_sessions", id, patch))
      .catch(() => {
        /* local write failure — kept off the timer UI */
      });
  }

  // -- Bus -----------------------------------------------------------------

  private emit(type: FocusEmitType, data: Record<string, unknown> = {}): void {
    if (!this.sessionId || !this.taskId) return;
    const payload: FocusEventPayload = {
      type,
      session_id: this.sessionId,
      task_id: this.taskId,
      state: this.state,
      at: nowISO(),
      data,
    };
    bus.emit(type, payload);
  }

  // -- Transitions ---------------------------------------------------------

  private enterActiveWork(newCycle: boolean): void {
    this.state = SessionState.ACTIVE_WORK;
    if (newCycle) this.cycleWorkAccum = 0;
    this.epoch += 1;
    this.openSegment(SessionState.ACTIVE_WORK);
    this.scheduleTransition(this.workTotalSeconds() - this.cycleWorkAccum, "work_elapsed");
  }

  async start(
    taskId: string,
    preset: FocusPreset,
    plannedCycles: number | null = null,
  ): Promise<void> {
    await this.ensureRecovered();
    if (this.state !== SessionState.IDLE) return; // single active session (MVP)

    this.taskId = taskId;
    this.preset = preset;
    this.plannedCycles = plannedCycles;
    this.workSeconds = 0;
    this.breakSeconds = 0;
    this.cyclesCompleted = 0;
    this.cycleWorkAccum = 0;
    this.segments = [];
    this.openSeg = null;
    this.segmentStartPerf = null;
    this.error = null;

    const id = crypto.randomUUID();
    this.sessionId = id;
    const startedAt = nowISO();

    try {
      this.row = await createEntity("focus_sessions", {
        id,
        task_id: taskId,
        preset,
        planned_cycles: plannedCycles,
        state: SessionState.ACTIVE_WORK,
        outcome: null,
        started_at: startedAt,
        ended_at: null,
        work_seconds: 0,
        break_seconds: 0,
        cycles_completed: 0,
        segments: [],
        ambient_track: AmbientTrack.NONE,
        energy_after: null,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.sessionId = null;
      this.forcePublish();
      return;
    }

    this.enterActiveWork(true);
    this.startTick();
    this.emit("focus.session.started");
    this.forcePublish();
  }

  async pause(): Promise<void> {
    await this.ensureRecovered();
    if (this.state !== SessionState.ACTIVE_WORK) return;
    this.cancelTransition();
    this.closeAndAccount();
    this.state = SessionState.PAUSED;
    this.epoch += 1;
    this.stopTick();
    this.persistSession({
      state: SessionState.PAUSED,
      work_seconds: this.workSeconds,
      segments: [...this.segments],
    });
    this.emit("focus.session.paused");
    this.forcePublish();
  }

  async resume(): Promise<void> {
    await this.ensureRecovered();
    if (this.state !== SessionState.PAUSED) return;
    this.enterActiveWork(false);
    this.startTick();
    this.persistSession({ state: SessionState.ACTIVE_WORK, segments: [...this.segments] });
    this.emit("focus.session.resumed");
    this.forcePublish();
  }

  async skipBreak(): Promise<void> {
    await this.ensureRecovered();
    if (this.state !== SessionState.BREAK) return;
    this.cancelTransition();
    this.closeAndAccount();
    this.enterActiveWork(true);
    this.persistSession({
      state: SessionState.ACTIVE_WORK,
      break_seconds: this.breakSeconds,
      segments: [...this.segments],
    });
    this.emit("focus.session.resumed", { cycle: this.cyclesCompleted + 1 });
    this.forcePublish();
  }

  async complete(): Promise<void> {
    await this.ensureRecovered();
    await this.finalizeAction(SessionOutcome.COMPLETED);
  }

  async abandon(): Promise<void> {
    await this.ensureRecovered();
    await this.finalizeAction(SessionOutcome.ABANDONED);
  }

  private async finalizeAction(outcome: SessionOutcome): Promise<void> {
    if (this.state === SessionState.IDLE || this.state === SessionState.COMPLETED) return;
    this.cancelTransition();
    this.closeAndAccount();
    this.finalize(outcome);
  }

  private onWorkElapsed(epoch: number): void {
    if (epoch !== this.epoch || this.state !== SessionState.ACTIVE_WORK) return;
    this.closeAndAccount();
    this.cyclesCompleted += 1;
    this.emit("focus.cycle.completed", { cycle: this.cyclesCompleted });

    if (this.plannedCycles !== null && this.cyclesCompleted >= this.plannedCycles) {
      this.finalize(SessionOutcome.COMPLETED);
      return;
    }

    this.state = SessionState.BREAK;
    this.epoch += 1;
    this.openSegment(SessionState.BREAK);
    this.persistSession({
      state: SessionState.BREAK,
      work_seconds: this.workSeconds,
      cycles_completed: this.cyclesCompleted,
      segments: [...this.segments],
    });
    this.scheduleTransition(this.breakTotalSeconds(), "break_elapsed");
    this.emit("focus.break.started");
    this.forcePublish();
  }

  private onBreakElapsed(epoch: number): void {
    if (epoch !== this.epoch || this.state !== SessionState.BREAK) return;
    this.closeAndAccount();
    this.enterActiveWork(true);
    this.persistSession({
      state: SessionState.ACTIVE_WORK,
      break_seconds: this.breakSeconds,
      segments: [...this.segments],
    });
    this.emit("focus.session.resumed", { cycle: this.cyclesCompleted + 1 });
    this.forcePublish();
  }

  private finalize(outcome: SessionOutcome): void {
    this.cancelTransition();
    this.stopTick();
    this.state = SessionState.COMPLETED;
    this.epoch += 1;
    const endedAt = nowISO();
    this.persistSession({
      state: SessionState.COMPLETED,
      outcome,
      ended_at: endedAt,
      work_seconds: this.workSeconds,
      break_seconds: this.breakSeconds,
      cycles_completed: this.cyclesCompleted,
      segments: [...this.segments],
    });
    this.emit("focus.session.completed", { outcome });
    this.resetToIdle();
  }

  /** Returns the engine to IDLE so a fresh session can start (COMPLETED is a
   *  terminal FSM state; the persisted row keeps the completed facts). */
  private resetToIdle(): void {
    this.state = SessionState.IDLE;
    this.sessionId = null;
    this.taskId = null;
    this.row = null;
    this.openSeg = null;
    this.segmentStartPerf = null;
    this.workSeconds = 0;
    this.breakSeconds = 0;
    this.cyclesCompleted = 0;
    this.cycleWorkAccum = 0;
    this.segments = [];
    this.epoch += 1;
    this.stopTick();
    this.forcePublish();
  }

  // -- Stale-session recovery ---------------------------------------------

  private async ensureRecovered(): Promise<void> {
    if (this.recovered) return;
    if (!this.recoverPromise) this.recoverPromise = this.recoverStaleSessions();
    await this.recoverPromise;
  }

  private async recoverStaleSessions(): Promise<void> {
    try {
      if (typeof window === "undefined") return;
      const rows = await db.focus_sessions.toArray();
      for (const row of rows) {
        if (row.deleted_at) continue;
        const inFlight =
          row.state === SessionState.ACTIVE_WORK ||
          row.state === SessionState.PAUSED ||
          row.state === SessionState.BREAK;
        if (!inFlight) continue;
        // No live engine owns this row (it survived a reload) — finalize it as
        // abandoned with the last known segment end so it stops counting.
        const lastSeg =
          row.segments && row.segments.length > 0 ? row.segments[row.segments.length - 1] : null;
        const endedAt =
          (lastSeg && (lastSeg.ended_at ?? lastSeg.started_at)) ??
          row.started_at ??
          row.updated_at ??
          nowISO();
        await updateEntity("focus_sessions", row.id, {
          state: SessionState.COMPLETED,
          outcome: SessionOutcome.ABANDONED,
          ended_at: endedAt,
        });
      }
    } catch {
      /* recovery is best-effort — never blocks starting a new session */
    } finally {
      this.recovered = true;
    }
  }
}

/** Process-wide singleton — an in-flight session survives SPA navigation. */
export const focusEngine = new LocalFocusEngine();
