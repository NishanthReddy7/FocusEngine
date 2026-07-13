/**
 * Ambient audio engine — ARCHITECTURE.md §7.5. Reacts ONLY to client bus
 * events (never imports timer/focus-controller internals — that's the whole
 * point of the event-bus integration, ARCHITECTURE.md §1 principle 3).
 *
 * No audio asset files were ever shipped (ARCHITECTURE.md §2, "Not included by
 * design"), so this synthesizes every track with the Web Audio API instead of
 * streaming `.mp3`s — the live site was silent otherwise. The public surface is
 * unchanged (`setTrack`, `fadeTo`, `destroy`, the singleton) and the §7.5
 * volume rules are honoured, but now through a master `GainNode`:
 *   - `focus.session.started|resumed` → gain 1.0
 *   - `focus.break.started`           → fade to 0.5
 *   - `focus.session.paused`          → fade to 0
 *   - `focus.session.completed`       → fade out & stop
 *
 * Synthesis per `AmbientTrack`:
 *   - white_noise → looping white-noise buffer through a lowpass
 *   - rain        → pink-ish filtered noise + sparse randomized droplet taps
 *   - binaural    → an L/R sine pair (200 / 204 Hz) via a ChannelMerger
 *                   (needs headphones — the picker shows that hint)
 *   - lofi        → brown noise + a gentle lowpass wobble (LFO on cutoff) +
 *                   sparse vinyl-crackle impulses
 *
 * An `AudioContext` may only be created/resumed from a user gesture, so
 * `setTrack` (a click) and `resume()` (called from the session-start click)
 * unlock it; everything is feature-detected and silently no-ops where the Web
 * Audio API is unavailable (SSR, old browsers).
 */
import { AmbientTrack } from "@focusengine/schemas/enums";
import { bus } from "../events/bus";

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function clampVolume(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Debug view surfaced for offline verification (headless can't hear audio, so
 *  the evidence is a running context + a non-empty node graph + gain changes). */
export interface AmbientAudioDebugInfo {
  available: boolean;
  contextState: string | null;
  track: AmbientTrack;
  nodeCount: number;
  masterGain: number | null;
}

export class AmbientAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private track: AmbientTrack = AmbientTrack.NONE;

  /** Every node/timer that makes up the CURRENT track's graph, so `setTrack`
   *  and `destroy` can tear it down completely. */
  private trackNodes: AudioNode[] = [];
  private trackTimers: number[] = [];

  /** Bumped by every call that changes playback state (fadeTo/setTrack/stop):
   *  a superseded rAF fade or a pending stop-timeout compares its captured
   *  generation and no-ops — the "coalescing under rapid state flips" guard. */
  private generation = 0;
  private fadeHandle: number | null = null;

  /** Last volume a bus event asked for (so re-selecting a track mid-session
   *  brings it in at the right level). */
  private targetVolume = 0;

  private unsubscribers: Array<() => void> = [];

  constructor() {
    if (typeof window === "undefined") return; // SSR: client-only engine
    this.wireBus();
  }

  private wireBus(): void {
    this.unsubscribers.push(
      bus.on("focus.session.started", () => this.playAt(1.0)),
      bus.on("focus.session.resumed", () => this.playAt(1.0)),
      bus.on("focus.break.started", () => this.fadeTo(0.5, 400)),
      bus.on("focus.session.paused", () => this.fadeTo(0, 250)),
      bus.on("focus.session.completed", () => this.fadeOutAndStop()),
    );
  }

  /** Create/resume the AudioContext from within a user gesture. Feature-detected;
   *  returns false (a silent no-op) where Web Audio is unavailable. */
  resume(): boolean {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      return true;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor();
    } catch {
      return false;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return true;
  }

  /** Selects (or clears, via `AmbientTrack.NONE`) the track. Rebuilds the graph
   *  immediately; a track chosen mid-session comes in at the current level. */
  setTrack(track: AmbientTrack): void {
    this.track = track;
    if (typeof window === "undefined") return;
    this.resume();
    this.cancelFade();
    this.teardownGraph();
    if (track === AmbientTrack.NONE || !this.ctx || !this.master) return;
    this.buildGraph(track);
    // Come in at whatever level the last bus event asked for, so a track picked
    // mid-session is immediately audible (and 0/silent when idle).
    this.master.gain.value = clampVolume(this.targetVolume);
  }

  private playAt(volume: number): void {
    this.targetVolume = clampVolume(volume);
    if (this.track === AmbientTrack.NONE) return;
    this.resume();
    if (!this.ctx || !this.master) return;
    if (this.trackNodes.length === 0) this.buildGraph(this.track);
    // A direct set (not a fade) per §7.5's own wording for the "play at 1.0"
    // rule; also cancels any in-flight fade so a stale ramp can't fight it.
    this.cancelFade();
    this.master.gain.value = clampVolume(volume);
  }

  /** requestAnimationFrame ramp of the MASTER gain from its current value to
   *  `volume` over `ms` (replaces the old element.volume ramp). */
  fadeTo(volume: number, ms: number): void {
    this.targetVolume = clampVolume(volume);
    if (!this.master) return;
    const master = this.master;
    const generation = this.cancelFade();

    const startVolume = clampVolume(master.gain.value);
    const target = clampVolume(volume);
    const startTime = performance.now();

    const step = (now: number) => {
      if (generation !== this.generation) return; // superseded
      const elapsed = now - startTime;
      // Clamp both ends: the first rAF timestamp can precede `startTime` by a
      // hair (negative t flips the ramp's sign and overshoots the [0,1] range).
      const t = ms <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / ms));
      master.gain.value = clampVolume(startVolume + (target - startVolume) * t);
      this.fadeHandle = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.fadeHandle = requestAnimationFrame(step);
  }

  private fadeOutAndStop(): void {
    if (!this.master) return;
    const fadeMs = 400;
    this.fadeTo(0, fadeMs);
    const generation = this.generation; // snapshot AFTER fadeTo bumped it
    window.setTimeout(() => {
      if (generation !== this.generation) return; // a new session restarted
      this.teardownGraph();
    }, fadeMs + 20);
  }

  private cancelFade(): number {
    if (this.fadeHandle !== null) {
      cancelAnimationFrame(this.fadeHandle);
      this.fadeHandle = null;
    }
    return ++this.generation;
  }

  // -- Synthesis -----------------------------------------------------------

  private buildGraph(track: AmbientTrack): void {
    if (!this.ctx || !this.master) return;
    switch (track) {
      case AmbientTrack.WHITE_NOISE:
        this.buildWhiteNoise();
        break;
      case AmbientTrack.RAIN:
        this.buildRain();
        break;
      case AmbientTrack.BINAURAL:
        this.buildBinaural();
        break;
      case AmbientTrack.LOFI:
        this.buildLofi();
        break;
      case AmbientTrack.NONE:
        break;
    }
  }

  /** A looping buffer of `seconds` filled by `fill(channelData)`. */
  private noiseSource(seconds: number, fill: (data: Float32Array) => void): AudioBufferSourceNode {
    const ctx = this.ctx as AudioContext;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    fill(buffer.getChannelData(0));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  private buildWhiteNoise(): void {
    const ctx = this.ctx as AudioContext;
    const src = this.noiseSource(2, (data) => {
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    });
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    src.connect(filter).connect(gain).connect(this.master as GainNode);
    src.start();
    this.trackNodes.push(src, filter, gain);
  }

  private buildRain(): void {
    const ctx = this.ctx as AudioContext;
    // Pink-ish bed: white noise heavily lowpassed.
    const bed = this.noiseSource(2, (data) => {
      let last = 0;
      for (let i = 0; i < data.length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      }
    });
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = "lowpass";
    bedFilter.frequency.value = 1000;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.5;
    bed.connect(bedFilter).connect(bedGain).connect(this.master as GainNode);
    bed.start();
    this.trackNodes.push(bed, bedFilter, bedGain);

    // Sparse randomized droplet taps: short filtered-noise bursts.
    const droplets = ctx.createGain();
    droplets.gain.value = 0.6;
    droplets.connect(this.master as GainNode);
    this.trackNodes.push(droplets);
    const timer = window.setInterval(() => {
      if (!this.ctx) return;
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i += 1) this.dropletTap(droplets, Math.random() * 0.12);
    }, 180);
    this.trackTimers.push(timer);
  }

  private dropletTap(dest: GainNode, delaySeconds: number): void {
    const ctx = this.ctx as AudioContext;
    const t0 = ctx.currentTime + delaySeconds;
    const burst = this.noiseSource(0.05, (data) => {
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    });
    burst.loop = false;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500 + Math.random() * 3500;
    bp.Q.value = 6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.5 + Math.random() * 0.4, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    burst.connect(bp).connect(env).connect(dest);
    burst.start(t0);
    burst.stop(t0 + 0.12);
  }

  private buildBinaural(): void {
    const ctx = this.ctx as AudioContext;
    const merger = ctx.createChannelMerger(2);
    const gain = ctx.createGain();
    gain.gain.value = 0.28;
    merger.connect(gain).connect(this.master as GainNode);
    this.trackNodes.push(merger, gain);

    const freqs = [200, 204];
    freqs.forEach((freq, channel) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const oscGain = ctx.createGain();
      oscGain.gain.value = 1;
      osc.connect(oscGain);
      oscGain.connect(merger, 0, channel);
      osc.start();
      this.trackNodes.push(osc, oscGain);
    });
  }

  private buildLofi(): void {
    const ctx = this.ctx as AudioContext;
    // Brown noise (integrated white noise).
    const src = this.noiseSource(3, (data) => {
      let last = 0;
      for (let i = 0; i < data.length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.0;
      }
    });
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    src.connect(filter).connect(gain).connect(this.master as GainNode);
    src.start();
    this.trackNodes.push(src, filter, gain);

    // Gentle lowpass wobble: an LFO modulating the cutoff.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.trackNodes.push(lfo, lfoGain);

    // Sparse vinyl-crackle impulses.
    const crackle = ctx.createGain();
    crackle.gain.value = 0.25;
    crackle.connect(this.master as GainNode);
    this.trackNodes.push(crackle);
    const timer = window.setInterval(() => {
      if (!this.ctx) return;
      if (Math.random() < 0.7) this.crackleImpulse(crackle, Math.random() * 0.1);
    }, 120);
    this.trackTimers.push(timer);
  }

  private crackleImpulse(dest: GainNode, delaySeconds: number): void {
    const ctx = this.ctx as AudioContext;
    const t0 = ctx.currentTime + delaySeconds;
    const burst = this.noiseSource(0.02, (data) => {
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    });
    burst.loop = false;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.6 + Math.random() * 0.4, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02);
    burst.connect(env).connect(dest);
    burst.start(t0);
    burst.stop(t0 + 0.04);
  }

  private teardownGraph(): void {
    for (const timer of this.trackTimers) window.clearInterval(timer);
    this.trackTimers = [];
    for (const node of this.trackNodes) {
      try {
        if (node instanceof AudioScheduledSourceNode) node.stop();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.trackNodes = [];
  }

  getDebugInfo(): AmbientAudioDebugInfo {
    return {
      available: this.ctx !== null,
      contextState: this.ctx?.state ?? null,
      track: this.track,
      nodeCount: this.trackNodes.length,
      masterGain: this.master ? this.master.gain.value : null,
    };
  }

  /** Releases bus subscriptions, tears down the graph, and closes the context. */
  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.cancelFade();
    this.teardownGraph();
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }
}

/** Process-wide singleton; safe to import anywhere (no-ops under SSR). */
export const ambientAudioEngine = new AmbientAudioEngine();

// A tiny debug seam for offline verification only (headless browsers can't
// render audio, so the evidence is the live graph + gain). Harmless in prod.
if (typeof window !== "undefined") {
  (window as unknown as { __focusAudio?: AmbientAudioEngine }).__focusAudio = ambientAudioEngine;
}
