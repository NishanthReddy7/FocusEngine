/**
 * Capture → Focus bridge (DESIGN_SPEC §6, TaskRow hover Play). When a task's
 * Play is pressed on the capture view we stash its id and route to /focus,
 * which picks it up on mount. Kept out of the URL (no query param) so the focus
 * route stays statically rendered; an in-memory handoff survives client-side
 * navigation, with a sessionStorage fallback for a hard reload.
 */
const KEY = "focusengine.pending_task";
let pending: string | null = null;

export function setPendingFocusTask(id: string): void {
  pending = id;
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // sessionStorage unavailable (private mode / SSR) — the in-memory value
    // still carries a client-side navigation.
  }
}

export function takePendingFocusTask(): string | null {
  if (pending) {
    const id = pending;
    pending = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return id;
  }
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) sessionStorage.removeItem(KEY);
    return stored;
  } catch {
    return null;
  }
}
