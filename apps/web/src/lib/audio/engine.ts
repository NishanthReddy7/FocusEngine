/**
 * Ambient audio engine — ARCHITECTURE.md §7.5. Reacts ONLY to client bus
 * events (never imports timer/focus-controller internals — that's the whole
 * point of the event-bus integration, ARCHITECTURE.md §1 principle 3).
 *
 * Audio assets are NOT shipped with this scaffold (ARCHITECTURE.md §2,
 * "Not included by design"); wire real files at `public/audio/<track>.mp3`
 * for this to be audible.
 */
import { AmbientTrack } from "@focusengine/schemas/enums";
import { bus } from "../events/bus";

const TRACK_SRC: Partial<Record<AmbientTrack, string>> = {
  [AmbientTrack.WHITE_NOISE]: "/audio/white_noise.mp3",
  [AmbientTrack.BINAURAL]: "/audio/binaural.mp3",
  [AmbientTrack.LOFI]: "/audio/lofi.mp3",
  [AmbientTrack.RAIN]: "/audio/rain.mp3",
};

/** Clamps to the range `HTMLMediaElement.volume` accepts — it throws
 *  `IndexSizeError` synchronously if written outside [0, 1], so every write
 *  anywhere in this file must be pre-clamped, never assumed in-range. */
function clampVolume(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export class AmbientAudioEngine {
  private audio: HTMLAudioElement | null = null;
  private track: AmbientTrack = AmbientTrack.NONE;
  private fadeHandle: number | null = null;
  // Bumped by every call that changes playback state (fadeTo/playAtFull/
  // setTrack). Closures captured by an in-flight rAF loop or setTimeout
  // compare their captured generation against the current one before acting,
  // so a superseded fade/timeout becomes a no-op instead of fighting the
  // newer state change — the "coalescing under rapid state flips" guarantee.
  private generation = 0;
  private unsubscribers: Array<() => void> = [];

  constructor() {
    // SSR guard — this engine is client-only (no HTMLAudioElement on the
    // server); every method below no-ops when `audio` stays null.
    if (typeof window === "undefined") return;
    this.audio = new Audio();
    this.audio.loop = true;
    this.wireBus();
  }

  /** Cancels any in-flight fade RAF and invalidates its (and any pending
   *  fade-related timeout's) generation. Call this at the start of every
   *  method that changes playback state directly, so a stale loop never
   *  clobbers a fresher one. */
  private cancelFade(): number {
    if (this.fadeHandle !== null) {
      cancelAnimationFrame(this.fadeHandle);
      this.fadeHandle = null;
    }
    return ++this.generation;
  }

  private wireBus(): void {
    this.unsubscribers.push(
      bus.on("focus.session.started", () => this.playAtFull()),
      bus.on("focus.session.resumed", () => this.playAtFull()),
      bus.on("focus.break.started", () => this.fadeTo(0.5, 400)),
      bus.on("focus.session.paused", () => this.fadeTo(0, 250)),
      bus.on("focus.session.completed", () => this.fadeOutAndStop()),
    );
  }

  /** Selects (or clears, via `AmbientTrack.NONE`) which track plays on the
   *  next `focus.session.started|resumed` event. */
  setTrack(track: AmbientTrack): void {
    this.track = track;
    if (!this.audio) return;
    // A fade left over from the previous track (e.g. a pause fade-out still
    // ramping down) must not resurrect and write to the newly-selected one.
    this.cancelFade();
    if (track === AmbientTrack.NONE) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      return;
    }
    this.audio.src = TRACK_SRC[track] ?? "";
  }

  /** "focus.session.started|resumed -> play at volume 1.0" (§7.5) — a direct
   *  set, not a fade, per the spec's own wording distinguishing it from the
   *  three "fade to ..." rules below. Cancels any in-flight fade first: rapid
   *  pause/resume toggling was leaving a fade-to-0 loop running after resume
   *  set volume back to 1, and the orphaned loop would then silently fade
   *  the just-resumed track back toward 0 a frame later. */
  private playAtFull(): void {
    if (!this.audio || this.track === AmbientTrack.NONE) return;
    this.cancelFade();
    this.audio.volume = clampVolume(1.0);
    void this.audio.play().catch(() => {
      // Autoplay can be blocked until a user gesture occurs; the next bus
      // event (e.g. resuming after a break) retries.
    });
  }

  /** requestAnimationFrame ramp from the current volume to `volume` over `ms`. */
  fadeTo(volume: number, ms: number): void {
    if (!this.audio) return;
    const audio = this.audio;
    const generation = this.cancelFade();

    const startVolume = clampVolume(audio.volume);
    const target = clampVolume(volume);
    const startTime = performance.now();

    const step = (now: number) => {
      // Superseded by a newer fadeTo/playAtFull/setTrack call — stop
      // instead of continuing to write a stale ramp over the current one.
      if (generation !== this.generation) return;
      const elapsed = now - startTime;
      // Clamp BOTH ends: `elapsed` can be negative on a fade's first frame
      // (the rAF timestamp can precede the `performance.now()` read above by
      // a hair), and an unclamped negative `t` flips the sign of
      // `(target - startVolume) * t`, pushing the result past whichever of
      // startVolume/target is the upper bound — that's the `1.0116`
      // IndexSizeError from repeated pause/resume toggling.
      const t = ms <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / ms));
      audio.volume = clampVolume(startVolume + (target - startVolume) * t);
      this.fadeHandle = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.fadeHandle = requestAnimationFrame(step);
  }

  /** "focus.session.completed -> fade out & stop" (§7.5). */
  private fadeOutAndStop(): void {
    if (!this.audio) return;
    const audio = this.audio;
    const fadeMs = 400;
    this.fadeTo(0, fadeMs);
    // Snapshot the generation *after* fadeTo (which just bumped it) so this
    // timeout can detect being superseded too — e.g. a session restarting
    // within the 420ms window must not have its fresh playback paused out
    // from under it by this stale callback.
    const generation = this.generation;
    window.setTimeout(() => {
      if (generation !== this.generation) return;
      audio.pause();
      audio.currentTime = 0;
    }, fadeMs + 20);
  }

  /** Releases bus subscriptions and stops playback — call on teardown. */
  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.cancelFade();
    this.audio?.pause();
  }
}

/** Process-wide singleton; safe to import anywhere (no-ops under SSR). */
export const ambientAudioEngine = new AmbientAudioEngine();
