import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

import { compareApplied, readTurnContext, reportWorktree } from "../src/codex/rollout.ts";
import type { TurnContext } from "../src/codex/rollout.ts";
import { createCodexHome, SESSION_META_LINE, turnContextLine, type CodexHome } from "./fixtures/codex-home.ts";

// Regressions for the second review of #197 (findings A, C, D, E, F, G). Offline: the CLI is
// stubbed at child_process, as in test/writable-roots.test.ts.

let spawnedArgs: string[][] = [];
let nextThreadId: string | null = null;
cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (_file: string, args: string[]) => {
  if (args[0] === "--version") return { stdout: "codex-cli 0.154.0", stderr: "" };
  if (args[0] === "mcp") return { stdout: "[]", stderr: "" };
  if (args[0] === "plugin") return { stdout: '{"installed":[],"available":[]}', stderr: "" };
  if (args[0] === "debug") {
    return { stdout: JSON.stringify({ models: [{
      slug: "cheap-model", visibility: "list", default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }],
    }] }), stderr: "" };
  }
  return { stdout: "Logged in using ChatGPT", stderr: "" };
};

cp.spawn = ((_file: string, args: string[]) => {
  spawnedArgs.push(args);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null, kill: () => true,
  });
  setImmediate(() => {
    if (nextThreadId) child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: nextThreadId })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } })}\n`);
    child.exitCode = 0;
    setImmediate(() => child.emit("close", 0));
  });
  return child;
}) as unknown as typeof cp.spawn;
syncBuiltinESMExports();

const { createServer } = await import("../src/server.ts");
const { resetCatalogCache } = await import("../src/codex/catalog.ts");
const { resetDoctorCache } = await import("../src/codex/doctor.ts");

interface Call { text: string; roots: string[] | null }

/** One server for the whole callback, so the thread registry survives between calls. */
async function withServer(
  home: CodexHome,
  run: (call: (tool: string, args: Record<string, unknown>, threadId?: string) => Promise<Call>) => Promise<void>,
): Promise<void> {
  const keys = Object.keys(process.env).filter((key) => key.startsWith("CODEX_SUBAGENT_") || key === "CODEX_HOME" || key === "CODEX_BIN");
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CODEX_HOME = home.path;
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_SUBAGENT_USAGE_LOG = "off";
  resetCatalogCache();
  resetDoctorCache();
  const { server, jobs } = createServer();
  const tools = server as unknown as {
    _registeredTools: Record<string, unknown>;
    validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
    executeToolHandler: (tool: unknown, args: unknown, extra: unknown) => Promise<{
      isError?: boolean; content: { text?: string }[];
    }>;
  };
  try {
    await run(async (name, input, threadId) => {
      spawnedArgs = [];
      nextThreadId = threadId ?? null;
      const tool = tools._registeredTools[name];
      const args = await tools.validateToolInput(tool, {
        prompt: "go", model: "cheap-model", reasoning_effort: "low", working_dir: home.path, ...input,
      }, name);
      const result = await tools.executeToolHandler(tool, args, {
        signal: new AbortController().signal, sendNotification: async () => {},
      });
      const text = result.content.map((item) => item.text ?? "").join("\n");
      assert.notEqual(result.isError, true, text);
      assert.equal(spawnedArgs.length, 1, "the tool ran the CLI once");
      const key = "sandbox_workspace_write.writable_roots=";
      const override = spawnedArgs[0]!.find((arg) => arg.startsWith(key));
      return { roots: override === undefined ? null : JSON.parse(override.slice(key.length)), text };
    });
  } finally {
    nextThreadId = null;
    jobs.cancelAll();
    await server.close();
    for (const key of ["CODEX_HOME", "CODEX_BIN", "CODEX_SUBAGENT_USAGE_LOG", ...keys]) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function writeTurn(home: CodexHome, roots: unknown[], sandbox = "workspace-write"): string {
  return turnContextLine({
    cwd: home.path, model: "cheap-model", effort: "low",
    sandbox_policy: { type: sandbox, writable_roots: roots },
  });
}

/** Past the 16 MiB read limit, in small lines so the prefix reads fast. */
const PADDING = `${"x".repeat(65535)}\n`.repeat(257);
const NOT_RESTORED = /extra writable directories could not be restored/i;

const CONTEXT: TurnContext = {
  cwd: "/work", model: "m", effort: "low", sandbox: "workspace-write", approvalPolicy: "never",
  writableRoots: ["/work/extra"],
};

function directory(home: CodexHome, name: string): string {
  const dir = join(home.path, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("Finding A (#197): a truncated read leaves the writable roots unconfirmed, not confirmed by an earlier turn", async () => {
  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-a", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra]), PADDING,
    ] });
    const lookup = await readTurnContext({ threadId: "thread-a", codexHome: home.path });
    const applied = await compareApplied({
      model: "cheap-model", reasoningEffort: "low", sandbox: "workspace-write",
      workingDir: home.path, writableRoots: [extra],
    }, lookup);
    assert.equal(applied.writableRoots?.state, "unconfirmed");
    assert.match(applied.writableRoots?.reason ?? "", /limit/);
    // The other fields keep what was read before the limit (ADR 13).
    assert.equal(applied.model.state, "confirmed");
    assert.equal(applied.sandbox.state, "confirmed");
  } finally {
    home.dispose();
  }
});

test("Finding A (#197): the follow-up report never says confirmed for roots read from a cut-off file", async () => {
  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-a2", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra]), PADDING,
    ] });
    await withServer(home, async (call) => {
      await call("codex_delegate", { sandbox: "workspace-write", add_dirs: [extra] }, "thread-a2");
      const second = await call("codex_follow_up", { thread_id: "thread-a2", sandbox: "workspace-write" }, "thread-a2");
      assert.deepEqual(second.roots, [extra]);
      assert.match(second.text, /writable roots could not be confirmed/i);
      assert.match(second.text, /limit/);
      assert.doesNotMatch(second.text, /writable roots[^\n]*: confirmed/i);
    });
  } finally {
    home.dispose();
  }
});

test("Finding C (#197): a later workspace-write follow-up on a thread whose roots could not be restored says so again", async () => {
  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-c", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra]), PADDING,
    ] });
    await withServer(home, async (call) => {
      const readOnly = await call("codex_follow_up", { thread_id: "thread-c", sandbox: "read-only" });
      assert.doesNotMatch(readOnly.text, NOT_RESTORED);
      const second = await call("codex_follow_up", { thread_id: "thread-c", sandbox: "workspace-write" });
      assert.equal(second.roots, null);
      assert.match(second.text, NOT_RESTORED);
      const third = await call("codex_follow_up", { thread_id: "thread-c", sandbox: "workspace-write" });
      assert.equal(third.roots, null);
      assert.match(third.text, NOT_RESTORED);
    });
  } finally {
    home.dispose();
  }
});

test("Finding C (#197): a later follow-up re-attempts recovery and restores the roots once the file is readable", async () => {
  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-c2", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra]), PADDING,
    ] });
    await withServer(home, async (call) => {
      await call("codex_follow_up", { thread_id: "thread-c2", sandbox: "read-only" });
      home.write({ threadId: "thread-c2", day: "2026-11-10", lines: [SESSION_META_LINE, writeTurn(home, [extra])] });
      const second = await call("codex_follow_up", { thread_id: "thread-c2", sandbox: "workspace-write" });
      assert.deepEqual(second.roots, [extra]);
      assert.doesNotMatch(second.text, NOT_RESTORED);
    });
  } finally {
    home.dispose();
  }
});

test("Finding C (#197): a thread whose roots were read fine and are simply none stays silent on every follow-up", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "thread-c3", day: "2026-11-10", lines: [
      SESSION_META_LINE,
      turnContextLine({ cwd: home.path, model: "cheap-model", effort: "low", sandbox_policy: { type: "workspace-write" } }),
    ] });
    await withServer(home, async (call) => {
      for (let turn = 0; turn < 2; turn += 1) {
        const result = await call("codex_follow_up", { thread_id: "thread-c3", sandbox: "workspace-write" });
        assert.equal(result.roots, null);
        assert.doesNotMatch(result.text, NOT_RESTORED);
      }
    });
  } finally {
    home.dispose();
  }
});

test("Finding D (#197): add_dirs and a recorded root that differ only by a trailing slash give one entry", async () => {
  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-d", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra]),
    ] });
    await withServer(home, async (call) => {
      await call("codex_delegate", { sandbox: "workspace-write", add_dirs: [`${extra}/`] }, "thread-d");
      const second = await call("codex_follow_up", { thread_id: "thread-d", sandbox: "workspace-write" });
      // The delegation's spelling wins; the recorded duplicate is dropped.
      assert.deepEqual(second.roots, [`${extra}/`]);
    });
  } finally {
    home.dispose();
  }
});

test("Finding E (#197): a missing working directory is not blamed on the writable roots", () => {
  const report = reportWorktree({
    context: { ...CONTEXT, cwd: null },
    reason: "the session file recorded writable roots that are not all valid absolute paths",
    baseCommit: "a".repeat(40),
  });
  assert.equal(report.path, null);
  assert.match(report.reason ?? "", /recorded no working directory/);
  assert.doesNotMatch(report.reason ?? "", /writable roots/);
  // Without a context the lookup's own reason still explains the missing path.
  assert.match(reportWorktree({ context: null, reason: "no session file was found" }).reason ?? "", /no session file/);
});

test("Finding E (#197): writable roots unconfirmed because of the sandbox say so, with correct wording", async () => {
  const applied = await compareApplied({
    model: "m", reasoningEffort: "low", sandbox: "workspace-write", workingDir: "/work", writableRoots: ["/work/extra"],
  }, { context: { ...CONTEXT, sandbox: "future-sandbox" }, reason: null });
  assert.equal(applied.writableRoots?.state, "unconfirmed");
  assert.match(applied.writableRoots?.reason ?? "", /future-sandbox.*not recognise/);

  const home = createCodexHome();
  try {
    const extra = directory(home, "extra");
    home.write({ threadId: "thread-e", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [extra], "future-sandbox"),
    ] });
    await withServer(home, async (call) => {
      await call("codex_delegate", { sandbox: "workspace-write", add_dirs: [extra] }, "thread-e");
      const second = await call("codex_follow_up", { thread_id: "thread-e", sandbox: "workspace-write" }, "thread-e");
      assert.doesNotMatch(second.text, /recorded a writable roots/);
      assert.match(second.text, /writable roots could not be confirmed \(Codex recorded the sandbox "future-sandbox"/);
    });
  } finally {
    home.dispose();
  }
});

test("Finding F (#197): a recovered root that TOML cannot hold degrades like a non-absolute one", async () => {
  const home = createCodexHome();
  try {
    const malformed = ["/ok/\ud800", "/ok/\udc00x", "/bad/\u0000path", "/bad/line\nbreak"];
    for (const [index, root] of malformed.entries()) {
      const threadId = `thread-f-${index}`;
      home.write({ threadId, day: "2026-11-10", lines: [SESSION_META_LINE, writeTurn(home, [join(home.path, "fine"), root])] });
      const lookup = await readTurnContext({ threadId, codexHome: home.path });
      assert.equal(lookup.writableRoots, undefined, JSON.stringify(root));
      await withServer(home, async (call) => {
        const result = await call("codex_follow_up", { thread_id: threadId, sandbox: "workspace-write" });
        assert.equal(result.roots, null, JSON.stringify(root));
        assert.match(result.text, NOT_RESTORED);
      });
    }
  } finally {
    home.dispose();
  }
});

test("Finding G (#197): on win32 the writable roots comparison ignores case, on posix it does not", async () => {
  const requested = {
    model: "m", reasoningEffort: "low", sandbox: "workspace-write" as const, workingDir: "/work", writableRoots: ["/Work/Extra"],
  };
  const lookup = { context: { ...CONTEXT, writableRoots: ["/work/extra"] }, reason: null };
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    assert.equal((await compareApplied(requested, lookup)).writableRoots?.state, "confirmed");
    Object.defineProperty(process, "platform", { ...original, value: "linux" });
    assert.equal((await compareApplied(requested, lookup)).writableRoots?.state, "differs");
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});
