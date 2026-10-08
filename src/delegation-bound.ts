const HOUR_MS = 60 * 60 * 1000;

export interface DelegationReservation {
  spawned: (atMs: number) => void;
  release: () => void;
}

export interface DelegationWindow {
  processes: number;
  pending: number;
  oldestExpiresAtMs: number | null;
}

/** Per-server invocation counts, independent of the usage log (ADR 23, ADR 25). */
export class DelegationBound {
  private spawnTimes: number[] = [];
  private pending = 0;

  constructor(private readonly limit: number | null) {}

  snapshot(now = Date.now()): DelegationWindow {
    // A backwards clock can put entries out of order or in the future.
    this.spawnTimes = this.spawnTimes.filter((at) => now - at < HOUR_MS);
    let oldest: number | null = null;
    for (const at of this.spawnTimes) {
      if (oldest === null || at < oldest) oldest = at;
    }
    return {
      processes: this.spawnTimes.length,
      pending: this.pending,
      oldestExpiresAtMs: oldest === null ? null : oldest + HOUR_MS,
    };
  }

  reserve(): { ok: true; reservation: DelegationReservation } | { ok: false; window: DelegationWindow } {
    const window = this.snapshot();
    if (this.limit !== null && window.processes + window.pending >= this.limit) {
      return { ok: false, window };
    }
    this.pending += 1;
    let held = true;
    return {
      ok: true,
      reservation: {
        spawned: (atMs) => {
          if (!held) return;
          held = false;
          this.pending -= 1;
          this.spawnTimes.push(atMs);
        },
        release: () => {
          if (!held) return;
          held = false;
          this.pending -= 1;
        },
      },
    };
  }
}
