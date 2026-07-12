/**
 * Hybrid Logical Clock — client mirror of `app/schemas/hlc.py`.
 * SYNC_STRATEGY.md §2 (binding — string format and tick/receive rules MUST
 * stay identical on both sides):
 *
 *   "{unix_ms:013d}-{counter:04x}-{device8}"   e.g. "1783958400123-0003-9f3a1c2b"
 *
 * Zero-padding makes lexicographic string order == causal order; ties break
 * by counter then device id. This module is pure (no Dexie/IO) — persistence
 * of the running clock state (`_meta.hlc_last`) is `lib/db/repository.ts`'s
 * job, not this module's.
 */

/** Clock-skew guard for `receive()` — a device with a wildly wrong clock
 *  can't drag everyone else's clocks forward (SYNC_STRATEGY.md §2). */
const SKEW_CAP_MS = 5 * 60 * 1000;

const MS_WIDTH = 13;
const COUNTER_WIDTH = 4;

export interface HlcParts {
  ms: number;
  counter: number;
  device8: string;
}

/** "device8 = first 8 hex chars of the device uuid" (SYNC_STRATEGY.md §2) —
 *  a standard uuid4's first hyphen-delimited group is exactly 8 hex chars. */
export function deviceId8(deviceId: string): string {
  return deviceId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function formatHlc(parts: HlcParts): string {
  const ms = String(Math.trunc(parts.ms)).padStart(MS_WIDTH, "0");
  const counter = (parts.counter >>> 0).toString(16).padStart(COUNTER_WIDTH, "0");
  return `${ms}-${counter}-${parts.device8}`;
}

export function parseHlc(hlc: string): HlcParts {
  const [msPart, counterPart, device8] = hlc.split("-");
  if (msPart === undefined || counterPart === undefined || device8 === undefined) {
    throw new Error(`malformed HLC string: ${hlc}`);
  }
  return { ms: Number(msPart), counter: parseInt(counterPart, 16), device8 };
}

/** Lexicographic compare doubles as causal-order compare (SYNC_STRATEGY.md §2). */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One instance per device. Holds the running (ms, counter) pair and the
 * fixed device8 suffix; `tick()`/`receive()` mutate it per SYNC_STRATEGY.md §2.
 */
export class HLC {
  private ms: number;
  private counter: number;
  private readonly device8: string;

  constructor(deviceId: string, seed?: HlcParts | string | null) {
    this.device8 = deviceId8(deviceId);
    const parsed = typeof seed === "string" ? parseHlc(seed) : seed ?? null;
    this.ms = parsed?.ms ?? 0;
    this.counter = parsed?.counter ?? 0;
  }

  /** Current state formatted as an HLC string, without advancing it. */
  peek(): string {
    return formatHlc({ ms: this.ms, counter: this.counter, device8: this.device8 });
  }

  toJSON(): HlcParts {
    return { ms: this.ms, counter: this.counter, device8: this.device8 };
  }

  /**
   * tick() — before stamping a local op (SYNC_STRATEGY.md §2):
   *   ms = max(wall_ms, last_ms); if equal to last_ms, counter += 1 else counter = 0.
   */
  tick(wallMs: number = Date.now()): string {
    const nextMs = Math.max(wallMs, this.ms);
    this.counter = nextMs === this.ms ? this.counter + 1 : 0;
    this.ms = nextMs;
    return this.peek();
  }

  /**
   * receive(remote) — on applying a pulled op (SYNC_STRATEGY.md §2): adopt
   * max(local, remote, wall) per the HLC algorithm, capping forward adoption
   * of the remote physical time at wall + 5min (clock-skew guard). Standard
   * HLC counter-merge rule: when two of {local, capped-remote, wall} tie for
   * the max, the counter is the max of the tied sources' counters + 1;
   * otherwise it resets to the winning source's counter + 1 (or 0 if wall
   * alone wins, since wall carries no counter).
   */
  receive(remoteHlc: string, wallMs: number = Date.now()): string {
    const remote = parseHlc(remoteHlc);
    const cappedRemoteMs = Math.min(remote.ms, wallMs + SKEW_CAP_MS);
    const nextMs = Math.max(wallMs, this.ms, cappedRemoteMs);

    const localWins = nextMs === this.ms;
    const remoteWins = nextMs === cappedRemoteMs;

    if (localWins && remoteWins) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (localWins) {
      this.counter = this.counter + 1;
    } else if (remoteWins) {
      this.counter = remote.counter + 1;
    } else {
      // wall clock alone is strictly ahead of both local and remote
      this.counter = 0;
    }
    this.ms = nextMs;
    return this.peek();
  }
}
