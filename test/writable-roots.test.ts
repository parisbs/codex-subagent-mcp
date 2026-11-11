import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

import { readTurnContext, recoverThreadSettings } from "../src/codex/rollout.ts";
import { createCodexHome, SESSION_META_LINE, turnContextLine, type CodexHome } from "./fixtures/codex-home.ts";

let spawnedArgs: string[][] = [];
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

async function followUp(home: CodexHome, threadId: string) {
  const keys = Object.keys(process.env).filter((key) => key.startsWith("CODEX_SUBAGENT_") || key === "CODEX_HOME" || key === "CODEX_BIN");
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CODEX_HOME = home.path;
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_SUBAGENT_USAGE_LOG = "off";
  resetCatalogCache();
  resetDoctorCache();
  spawnedArgs = [];
  const { server, jobs } = createServer();
  const tools = server as unknown as {
    _registeredTools: Record<string, unknown>;
    validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
    executeToolHandler: (tool: unknown, args: unknown, extra: unknown) => Promise<{
      isError?: boolean; content: { text?: string }[];
    }>;
  };
  try {
    const tool = tools._registeredTools.codex_follow_up;
    const args = await tools.validateToolInput(tool, {
      thread_id: threadId, prompt: "continue", sandbox: "workspace-write",
      model: "cheap-model", reasoning_effort: "low", working_dir: home.path,
    }, "codex_follow_up");
    const result = await tools.executeToolHandler(tool, args, {
      signal: new AbortController().signal, sendNotification: async () => {},
    });
    const text = result.content.map((item) => item.text ?? "").join("\n");
    assert.notEqual(result.isError, true, text);
    assert.equal(spawnedArgs.length, 1, "the follow-up ran");
    const key = "sandbox_workspace_write.writable_roots=";
    const override = spawnedArgs[0]!.find((arg) => arg.startsWith(key));
    return { roots: override === undefined ? null : JSON.parse(override.slice(key.length)), text };
  } finally {
    jobs.cancelAll();
    await server.close();
    for (const key of ["CODEX_HOME", "CODEX_BIN", "CODEX_SUBAGENT_USAGE_LOG", ...keys]) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function writeTurn(home: CodexHome, roots: unknown[]): string {
  return turnContextLine({
    cwd: home.path, model: "cheap-model", effort: "low",
    sandbox_policy: { type: "workspace-write", writable_roots: roots },
  });
}

const NOT_RESTORED = /extra writable directories could not be restored/i;

test("AC-2 (#197) truncation: incomplete session reads cannot restore obsolete roots", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "truncated-roots", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, [join(home.path, "old")]),
      // Keep each intervening line small so reading the prefix stays fast and bounded.
      `${"x".repeat(65535)}\n`.repeat(257),
      writeTurn(home, [join(home.path, "new")]),
    ] });
    const lookup = await readTurnContext({ threadId: "truncated-roots", codexHome: home.path });
    assert.equal(lookup.writableRoots, undefined);
    assert.equal("writableRoots" in lookup, false);
    assert.match(lookup.reason ?? "", /limit|truncat/i);
    assert.deepEqual(recoverThreadSettings(lookup), {
      model: "cheap-model", reasoningEffort: "low", workingDir: home.path,
    });
    const result = await followUp(home, "truncated-roots");
    assert.equal(result.roots, null);
    assert.match(result.text, NOT_RESTORED);
  } finally {
    home.dispose();
  }
});

test("AC-2 (#197) relative roots: malformed latest roots never reach resume argv", async () => {
  const home = createCodexHome();
  try {
    const malformed = ["../outside", "relative/directory", "..\\outside", ".", "C:drive-relative", "", null, 42];
    for (const root of malformed) {
      if (typeof root === "string") assert.equal(isAbsolute(root), false);
      home.write({ threadId: "relative-roots", day: "2026-11-10", lines: [
        SESSION_META_LINE, writeTurn(home, [join(home.path, "older")]),
        writeTurn(home, [join(home.path, "valid"), root]),
      ] });
      const lookup = await readTurnContext({ threadId: "relative-roots", codexHome: home.path });
      assert.equal(lookup.writableRoots, undefined, JSON.stringify(root));
      assert.match(lookup.reason ?? "", /absolute|invalid/i);
      const result = await followUp(home, "relative-roots");
      assert.equal(result.roots, null, JSON.stringify(root));
      assert.match(result.text, NOT_RESTORED);
    }
  } finally {
    home.dispose();
  }
});

test("AC-2 (#197) truncation: EOF exactly at the read limit still confirms roots", async () => {
  const home = createCodexHome();
  try {
    const roots = [join(home.path, "missing")];
    const lines = [SESSION_META_LINE, writeTurn(home, roots)];
    const paddingBytes = 16 * 1024 * 1024 - Buffer.byteLength(lines.join("\n")) - 2;
    const paddingLine = `${"x".repeat(65535)}\n`;
    lines.push(paddingLine.repeat(Math.floor(paddingBytes / paddingLine.length)) + "x".repeat(paddingBytes % paddingLine.length));
    home.write({ threadId: "complete-limit", day: "2026-11-10", lines });
    const lookup = await readTurnContext({ threadId: "complete-limit", codexHome: home.path });
    assert.deepEqual(lookup.writableRoots, roots);
    assert.equal(lookup.reason, null);
  } finally {
    home.dispose();
  }
});

test("AC-2 (#197) absolute roots: restores nonexistent paths verbatim after a malformed turn", async () => {
  const home = createCodexHome();
  try {
    const roots = [join(home.path, "missing", "child"), `${join(home.path, "missing")}/../verbatim/`];
    home.write({ threadId: "absolute-roots", day: "2026-11-10", lines: [
      SESSION_META_LINE, writeTurn(home, ["../outside"]), writeTurn(home, roots),
      turnContextLine({ sandbox_policy: { type: "read-only" } }),
    ] });
    const lookup = await readTurnContext({ threadId: "absolute-roots", codexHome: home.path });
    assert.deepEqual(lookup.writableRoots, roots);
    assert.equal(lookup.reason, null);
    const result = await followUp(home, "absolute-roots");
    assert.deepEqual(result.roots, roots);
    assert.doesNotMatch(result.text, NOT_RESTORED);
  } finally {
    home.dispose();
  }
});
