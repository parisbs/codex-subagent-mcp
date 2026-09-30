import assert from "node:assert/strict";
import { test } from "node:test";

import {
  descendantGroups,
  parseProcessTable,
  readProcessTable,
  processGroupAlive,
  signalGroups,
  signalProcessTree,
  type TreeKillDeps,
} from "../src/codex/terminate.ts";

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

// #107: the real CLI starts each command as the leader of a process group of
// its own, so the groups have to be found in the process table.

test("parses the process table ps prints", () => {
  assert.deepEqual(parseProcessTable("  100     1   100\n  200   100   200\n\n bad line\n"), [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 200 },
  ]);
});

test("AC-5 (#107) records every descendant's group, but not Codex's own, the server's, or init's", () => {
  const table = [
    { pid: 100, ppid: 50, pgid: 100 }, // Codex, leading its own group
    { pid: 200, ppid: 100, pgid: 200 }, // a command in a group of its own
    { pid: 201, ppid: 100, pgid: 100 }, // a helper that stayed in Codex's group
    { pid: 300, ppid: 200, pgid: 300 }, // a grandchild in yet another group
    { pid: 301, ppid: 200, pgid: 200 }, // a grandchild in its parent's group
    { pid: 500, ppid: 100, pgid: 7 }, // somehow in the server's group
    { pid: 600, ppid: 100, pgid: 1 }, // somehow in init's group
    { pid: 400, ppid: 1, pgid: 400 }, // unrelated
  ];
  const groups = descendantGroups(100, { platform: "darwin", listProcesses: () => table, ownPgid: 7 });
  assert.deepEqual([...groups].sort((a, b) => a - b), [200, 300]);
});

test("AC-6 (#107) records nothing when the process table cannot be read", () => {
  const groups = descendantGroups(100, {
    platform: "linux",
    listProcesses: () => {
      throw new Error("ps: not found");
    },
  });
  assert.deepEqual(groups, []);
});

test("records nothing on Windows, where taskkill walks the tree instead", () => {
  let listed = false;
  const groups = descendantGroups(100, { platform: "win32", listProcesses: () => ((listed = true), []) });
  assert.deepEqual(groups, []);
  assert.equal(listed, false);
});

test("AC-5 (#107) signals each recorded group, never a bare pid, and carries on past a gone one", () => {
  const { deps, kills } = recorder("linux", { groupKillFails: "ESRCH" });
  signalGroups([200, 300], "SIGKILL", deps);
  assert.deepEqual(kills, [[-200, "SIGKILL"], [-300, "SIGKILL"]]);
});

test("AC-3 (#116) abandons a process listing that does not answer within its timeout", () => {
  // A stand-in for a `ps` that hangs: it would answer after five seconds.
  const started = Date.now();
  assert.throws(() =>
    readProcessTable({ timeoutMs: 100, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `waited ${elapsed} ms for a listing bounded at 100 ms`);
});
