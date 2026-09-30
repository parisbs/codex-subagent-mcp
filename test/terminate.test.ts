import assert from "node:assert/strict";
import { test } from "node:test";

import { processGroupAlive, signalProcessTree, type TreeKillDeps } from "../src/codex/terminate.ts";

/** Records every kill and taskkill instead of performing it. */
function recorder(platform: NodeJS.Platform, options: { groupKillFails?: string } = {}) {
  const kills: [number, NodeJS.Signals | 0][] = [];
  const execs: { file: string; args: string[]; shell: unknown }[] = [];
  const deps: TreeKillDeps = {
    platform,
    systemRoot: "C:\\Windows",
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (pid < 0 && options.groupKillFails) {
        throw Object.assign(new Error(options.groupKillFails), { code: options.groupKillFails });
      }
    },
    execFile: (file, args, opts, callback) => {
      execs.push({ file, args, shell: opts.shell });
      callback(null);
    },
  };
  return { deps, kills, execs };
}

test("signals the whole process group of a live child on POSIX", () => {
  const { deps, kills, execs } = recorder("darwin");
  signalProcessTree({ pid: 4242, alive: true }, "SIGTERM", deps);
  assert.deepEqual(kills, [[-4242, "SIGTERM"]]);
  assert.deepEqual(execs, []);
});

test("falls back to the child itself when its group cannot be signalled", () => {
  const { deps, kills } = recorder("linux", { groupKillFails: "EPERM" });
  signalProcessTree({ pid: 4242, alive: true }, "SIGKILL", deps);
  assert.deepEqual(kills, [[-4242, "SIGKILL"], [4242, "SIGKILL"]]);
});

test("AC-4 signals only the group, never the bare pid, of a child already reaped", () => {
  const { deps, kills } = recorder("linux", { groupKillFails: "ESRCH" });
  signalProcessTree({ pid: 4242, alive: false }, "SIGKILL", deps);
  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
});

test("AC-3 terminates the tree on Windows with taskkill and no shell", () => {
  const { deps, kills, execs } = recorder("win32");
  signalProcessTree({ pid: 4242, alive: true }, "SIGTERM", deps);
  assert.deepEqual(kills, []);
  assert.equal(execs.length, 1);
  assert.match(execs[0]!.file, /[\\/]System32[\\/]taskkill\.exe$/i);
  assert.deepEqual(execs[0]!.args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(execs[0]!.shell, false);
});

test("AC-4 runs no taskkill for a Windows child already reaped", () => {
  const { deps, kills, execs } = recorder("win32");
  signalProcessTree({ pid: 4242, alive: false }, "SIGKILL", deps);
  assert.deepEqual(kills, []);
  assert.deepEqual(execs, []);
});

test("does nothing for a spawn that produced no process", () => {
  const { deps, kills, execs } = recorder("linux");
  signalProcessTree({ pid: undefined, alive: false }, "SIGKILL", deps);
  assert.deepEqual(kills, []);
  assert.deepEqual(execs, []);
});

test("reports whether a process group still has members", () => {
  const empty = recorder("linux", { groupKillFails: "ESRCH" });
  assert.equal(processGroupAlive(4242, empty.deps), false);
  assert.deepEqual(empty.kills, [[-4242, 0]]);

  const populated = recorder("linux");
  assert.equal(processGroupAlive(4242, populated.deps), true);

  assert.equal(processGroupAlive(4242, recorder("win32").deps), false);
  assert.equal(processGroupAlive(undefined, recorder("linux").deps), false);
});
