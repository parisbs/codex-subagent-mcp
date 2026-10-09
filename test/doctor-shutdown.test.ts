import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { runDoctorReport } from "../src/codex/doctor-report.ts";
import { ActiveRuns } from "../src/runs.ts";
import { createShutdown } from "../src/shutdown.ts";

/**
 * A shutdown that arrives while a cancelled extended diagnosis already has its
 * forced stage pending (#69, found by review after the oracle was frozen).
 *
 * Shutdown asks every run for SIGKILL at one instant and forbids a second
 * process-table read (#116). A pending forced stage due earlier keeps its own
 * instant, but it must adopt that prohibition: `ps` is synchronous, so a read
 * there blocks the event loop and pushes every run's SIGKILL past the host's
 * budget. The process layer is replaced here (spawn, the `ps` read and the
 * signals) and the clock is mocked, so the schedule is exact and no process is
 * started. POSIX only: Windows has neither process groups nor this read.
 */

const POSIX = process.platform !== "win32";

test(
  "AC-10 a shutdown after a cancellation keeps its no-reread rule for the pending forced stage",
  { skip: POSIX ? false : "process groups and the ps read are POSIX-only" },
  async (t) => {
    const start = 100_000;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });

    const realSpawn = cp.spawn;
    const realSpawnSync = cp.spawnSync;
    const realKill = process.kill;
    let nextPid = 70_001;
    const reads: number[] = [];
    const kills: { pid: number; at: number }[] = [];
    cp.spawn = (() =>
      Object.assign(new EventEmitter(), {
        pid: nextPid++,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      })) as unknown as typeof cp.spawn;
    cp.spawnSync = (() => {
      reads.push(Date.now());
      return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null };
    }) as unknown as typeof cp.spawnSync;
    syncBuiltinESMExports();
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") kills.push({ pid, at: Date.now() });
      return true;
    }) as typeof process.kill;

    try {
      const runs = new ActiveRuns({ readProcessTable: () => [] });
      const cancelled = runs.track(runDoctorReport({ executable: "doctor-stand-in", killGraceMs: 5_000 }));
      const running = runs.track(runDoctorReport({ executable: "doctor-stand-in", killGraceMs: 5_000 }));
      cancelled.cancel();
      // Its forced stage is now due at start + 5000, armed with the default reader.
      t.mock.timers.tick(4_800);
      reads.length = 0;

      const shutdownAt = Date.now();
      const shutdown = createShutdown({
        runs,
        jobs: { cancelAll() {} },
        close: async () => {},
        exit: () => {},
        log: () => {},
      });
      shutdown(143);
      const killed = (pid: number | undefined) => kills.some((kill) => kill.pid === -pid!);

      // The pending forced stage keeps its earlier instant, start + 5000 = shutdown + 200.
      t.mock.timers.tick(199);
      assert.equal(killed(cancelled.pid), false, "killed before its pending instant");
      t.mock.timers.tick(1);
      assert.equal(killed(cancelled.pid), true, "not killed at its pending instant");
      assert.deepEqual(reads, [], "the process table was read again after the shutdown began");

      // The other run gets the shared instant, shutdown + 250.
      t.mock.timers.tick(49);
      assert.equal(killed(running.pid), false, "killed before the shared instant");
      t.mock.timers.tick(1);
      assert.equal(killed(running.pid), true, "not killed at the shared instant");
      assert.equal(Date.now(), shutdownAt + 250);
      assert.deepEqual(reads, [], "the process table was read again after the shutdown began");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      cp.spawn = realSpawn;
      cp.spawnSync = realSpawnSync;
      syncBuiltinESMExports();
      process.kill = realKill;
    }
  },
);
