/**
 * Typed client event bus — ARCHITECTURE.md §7.3. This is THE integration
 * point between the task engine and the focus engine: neither calls the
 * other directly (ARCHITECTURE.md §1 principle 3). Server focus events
 * arriving on the WebSocket (`useFocusTimer`) are re-emitted verbatim here so
 * e.g. the ambient audio engine can react without knowing about timer
 * internals.
 */
import type { SessionState } from "@focusengine/schemas/enums";

/** Verbatim shape of the server's `FocusEvent` dataclass (ARCHITECTURE.md §5.2),
 *  re-emitted as-is when it arrives over `/ws/focus/events`. */
export interface FocusEventPayload {
  type: string;
  session_id: string;
  task_id: string;
  state: SessionState;
  /** ISO-8601 UTC datetime */
  at: string;
  data: Record<string, unknown>;
}

export interface BusEventPayloads {
  "task.created": { task_id: string };
  "task.updated": { task_id: string; fields: string[] };
  "task.completed": { task_id: string };
  "task.deleted": { task_id: string };
  "focus.session.started": FocusEventPayload;
  "focus.session.paused": FocusEventPayload;
  "focus.session.resumed": FocusEventPayload;
  "focus.break.started": FocusEventPayload;
  "focus.cycle.completed": FocusEventPayload;
  "focus.session.completed": FocusEventPayload;
  "sync.started": Record<string, never>;
  "sync.completed": { applied: number; pulled: number };
  "sync.failed": { reason: string };
  /** V2-C (A2/A5): the sync engine got a 401 from the API — the JWT expired or
   *  was revoked. The auth provider clears the stored session and surfaces
   *  `message` ("Session expired — sign in"); the engine has already stopped
   *  issuing requests. Distinct from `sync.failed` (a transient network error,
   *  which retries) — this one requires re-authentication. */
  "auth.expired": { message: string };
  /** ARCHITECTURE.md §7.3 v1.1: the FocusShield fires this when the user
   *  leaves during a work interval (tab hidden = "visibility"; unload attempt =
   *  "navigation"). Replaces the pre-v1.1 DOM CustomEvent so subscribers (audio,
   *  coaching, analytics) react through the one typed bus like every other
   *  integration. */
  "shield.triggered": { reason: "visibility" | "navigation"; at: string };
}

export type BusEventType = keyof BusEventPayloads;

type Handler<K extends BusEventType> = (payload: BusEventPayloads[K]) => void;
/** Returned by `on()` — call it to unsubscribe. */
type Unsubscribe = () => void;

/** Any handler, for internal storage only. `(payload: never) => void` is the
 *  supertype every concrete `Handler<K>` is assignable to (parameter
 *  contravariance), so one Set type holds handlers for every event without the
 *  generic-index-write error a per-key `Set<Handler<K>>` map triggers. The
 *  public `on`/`emit` signatures stay fully typed; the two casts here are the
 *  only bridge between the typed API and the erased store. */
type StoredHandler = (payload: never) => void;

/** Tiny typed pub/sub. No queuing, no async — handlers run synchronously,
 *  in subscription order, on `emit()`. */
export class EventBus {
  private listeners: Partial<Record<BusEventType, Set<StoredHandler>>> = {};

  on<K extends BusEventType>(type: K, handler: Handler<K>): Unsubscribe {
    let set = this.listeners[type];
    if (!set) {
      set = new Set();
      this.listeners[type] = set;
    }
    const stored = handler as StoredHandler;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  emit<K extends BusEventType>(type: K, payload: BusEventPayloads[K]): void {
    const set = this.listeners[type];
    if (!set || set.size === 0) return;
    // snapshot before iterating: a handler unsubscribing mid-emit must not
    // perturb this emit's delivery
    for (const handler of Array.from(set)) {
      (handler as Handler<K>)(payload);
    }
  }

  /** Removes every handler for every event type. Mainly for tests. */
  clear(): void {
    this.listeners = {};
  }
}

/** Process-wide singleton — every module that needs the bus imports this. */
export const bus = new EventBus();
