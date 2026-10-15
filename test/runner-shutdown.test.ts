import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { runCodex, type CancelOptions, type RunHandle } from "../src/codex/runner.ts";
import type { ProcessEntry } from "../src/codex/terminate.ts";
import { ActiveRuns } from "../src/runs.ts";
import { SHUTDOWN_KILL_MS, createShutdown } from "../src/shutdown.ts";

/**
 * The reader of a delegation's pending forced stage when a later stop request
 * arrives (#168), the same rule the extended diagnosis follows (#69).
 *
 * Shutdown asks every run for SIGKILL at one instant and forbids a second
 * process-table read (#116). A forced stage a cancellation armed earlier keeps
 * its own instant, but it must adopt that prohibition: `ps` is synchronous, so a
 * read there blocks the event loop and pushes every run's SIGKILL past the
 * host's budget. The process layer is replaced here (spawn, the `ps` read and
 * the signals) and the clock is mocked, so the schedule is exact and no process
 * is started. POSIX only: Windows has neither process groups nor this read.
 */

const POSIX = process.platform !== "win32";
const POSIX_ONLY = { skip: POSIX ? false : "process groups and the ps read are POSIX-only" };

const START = 100_000;
const GRACE_MS = 5_000;
/** A command Codex starts in a process group of its own, as the real CLI does (#107). */
const COMMAND_GROUP = 90_001;

interface FakeProcessLayer {
  /** When the default reader (`ps`, through `spawnSync`) was run. */
  reads: number[];
  kills: { target: number; at: number }[];
  /** What the default reader returns; replaceable while a run is stopping. */
  table: string;
  killed: (target: number) => number | undefined;
  restore: () => void;
}

/** Replaces spawn, the `ps` read and the signals; nothing real is started or signalled. */
function fakeProcessLayer(): FakeProcessLayer {
  const realSpawn = cp.spawn;
  const realSpawnSync = cp.spawnSync;
  const realKill = process.kill;
  let nextPid = 70_001;
  const layer: FakeProcessLayer = {
    reads: [],
    kills: [],
    table: "",
    killed: (target) => layer.kills.find((kill) => kill.target === target)?.at,
    restore: () => {
      cp.spawn = realSpawn;
      cp.spawnSync = realSpawnSync;
      syncBuiltinESMExports();
      process.kill = realKill;
    },
  };
  cp.spawn = (() =>
    Object.assign(new EventEmitter(), {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })) as unknown as typeof cp.spawn;
  cp.spawnSync = (() => {
    layer.reads.push(Date.now());
    return { status: 0, stdout: layer.table, stderr: "", pid: 0, output: [], signal: null };
  }) as unknown as typeof cp.spawnSync;
  syncBuiltinESMExports();
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") layer.kills.push({ target, at: Date.now() });
    return true;
  }) as typeof process.kill;
  return layer;
}

const startRun = (): RunHandle =>
  runCodex({
    invocation: { kind: "exec", sandbox: "read-only" },
    prompt: "irrelevant",
    codexPath: "codex-stand-in",
    killGraceMs: GRACE_MS,
  });

/** A reader a stop request names for the forced stage, recording when it was run. */
function namedReader(codexPid: number): { read: () => ProcessEntry[]; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    read: () => {
      calls.push(Date.now());
      return [{ pid: COMMAND_GROUP, ppid: codexPid, pgid: COMMAND_GROUP }];
    },
  };
}

const tables = (forced: (() => ProcessEntry[]) | null): CancelOptions["processTables"] => ({ polite: () => [], forced });

test(
  "AC-1 (#168) a shutdown after a delegation's cancellation keeps its no-reread rule for the pending forced stage",
  POSIX_ONLY,
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const layer = fakeProcessLayer();
    try {
      const shutdownReads: number[] = [];
      const runs = new ActiveRuns({ readProcessTable: () => { shutdownReads.push(Date.now()); return []; } });
      const cancelled = runs.track(startRun());
      const running = runs.track(startRun());
      cancelled.cancel();
      // Its forced stage is now due at START + 5000, armed with the default reader.
      t.mock.timers.tick(4_800);
      layer.reads.length = 0;

      const shutdownAt = Date.now();
      createShutdown({
        runs,
        jobs: { cancelAll() {} },
        close: async () => {},
        exit: () => {},
        log: () => {},
      })(143);
      assert.deepEqual(shutdownReads, [shutdownAt], "the shutdown reads the table once, before the polite signal");

      // The pending forced stage keeps its earlier instant, START + 5000 = shutdown + 200.
      t.mock.timers.tick(199);
      assert.equal(layer.killed(-cancelled.pid!), undefined, "killed before its pending instant");
      t.mock.timers.tick(1);
      assert.equal(layer.killed(-cancelled.pid!), START + GRACE_MS, "not killed at its pending instant");
      assert.deepEqual(layer.reads, [], "the process table was read again after the shutdown began");

      // The other run gets the shared instant, shutdown + 250.
      t.mock.timers.tick(SHUTDOWN_KILL_MS - 200 - 1);
      assert.equal(layer.killed(-running.pid!), undefined, "killed before the shared instant");
      t.mock.timers.tick(1);
      assert.equal(layer.killed(-running.pid!), shutdownAt + SHUTDOWN_KILL_MS, "not killed at the shared instant");
      assert.deepEqual(layer.reads, [], "the process table was read again after the shutdown began");
      assert.deepEqual(shutdownReads, [shutdownAt], "the shutdown read the table a second time");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      layer.restore();
    }
  },
);

test(
  "AC-2 (#168) the forced stage uses the reader a later stop request names when no skip was requested",
  POSIX_ONLY,
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const layer = fakeProcessLayer();
    try {
      const run = startRun();
      run.cancel();
      t.mock.timers.tick(4_800);
      layer.reads.length = 0;

      // Due later than the pending stage, so it keeps START + 5000, but with this reader.
      const named = namedReader(run.pid!);
      run.cancel({ killAt: Date.now() + 250, processTables: tables(named.read) });
      t.mock.timers.tick(200);
      assert.deepEqual(named.calls, [START + GRACE_MS], "the named reader was not used for the forced stage");
      assert.deepEqual(layer.reads, [], "the forced stage read the table with the arming request's reader");
      assert.equal(layer.killed(-COMMAND_GROUP), START + GRACE_MS, "the group the named reader found was not killed");
      assert.equal(layer.killed(-run.pid!), START + GRACE_MS);
    } finally {
      layer.restore();
    }
  },
);

test(
  "AC-2 (#168) once a stop request asked to skip the second read, no later request turns it back on",
  POSIX_ONLY,
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const layer = fakeProcessLayer();
    try {
      // The skip arrives after a cancellation armed the default reader, and is due
      // later; a third request names a reader again.
      const late = startRun();
      late.cancel();
      // The skip is due earlier and re-arms the stage; a later request, due earlier
      // still, names a reader again.
      const early = startRun();
      early.cancel({ killAt: START + 300, processTables: tables(null) });
      layer.reads.length = 0;

      const named = namedReader(early.pid!);
      early.cancel({ killAt: START + 200, processTables: tables(named.read) });
      t.mock.timers.tick(200);
      assert.equal(layer.killed(-early.pid!), START + 200, "not killed at the earlier instant");
      assert.deepEqual(named.calls, [], "a later request turned the read back on after a skip");
      assert.deepEqual(layer.reads, [], "the process table was read after a skip");

      t.mock.timers.tick(4_600);
      late.cancel({ killAt: Date.now() + 250, processTables: tables(null) });
      late.cancel({ killAt: Date.now() + 300, processTables: tables(namedReader(late.pid!).read) });
      t.mock.timers.tick(200);
      assert.equal(layer.killed(-late.pid!), START + GRACE_MS, "not killed at its pending instant");
      assert.deepEqual(layer.reads, [], "the pending forced stage read the table after a skip");
      assert.equal(layer.killed(-COMMAND_GROUP), undefined, "a group was found by a read that was skipped");
    } finally {
      layer.restore();
    }
  },
);

test(
  "AC-3 (#168) with only cancellations, the forced stage reads the table while Codex lives and kills the groups it finds",
  POSIX_ONLY,
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
    const layer = fakeProcessLayer();
    try {
      const run = startRun();
      run.cancel();
      assert.deepEqual(layer.reads, [START], "the polite stage did not read the table");
      // Codex starts a command in a group of its own during the grace.
      layer.table = `${run.pid} 1 ${run.pid}\n${COMMAND_GROUP} ${run.pid} ${COMMAND_GROUP}\n`;
      t.mock.timers.tick(1_000);
      // A second cancellation, due later, leaves the pending stage as it was.
      run.cancel();
      t.mock.timers.tick(GRACE_MS - 1_000 - 1);
      assert.equal(layer.killed(-COMMAND_GROUP), undefined, "killed before the grace ran out");
      t.mock.timers.tick(1);
      assert.deepEqual(layer.reads, [START, START + GRACE_MS], "the forced stage did not read the table once");
      assert.equal(layer.killed(-COMMAND_GROUP), START + GRACE_MS, "the group found in the forced stage was not killed");
      assert.equal(layer.killed(-run.pid!), START + GRACE_MS, "Codex's own group was not killed");
    } finally {
      layer.restore();
    }
  },
);
