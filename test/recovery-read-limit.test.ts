import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

import { readTurnContext, recoverThreadSettings, SESSION_READ_LIMIT_REASON } from "../src/codex/rollout.ts";
import { createCodexHome, SESSION_META_LINE, turnContextLine, type CodexHome } from "./fixtures/codex-home.ts";

// Issue #206: a follow-up on a thread this server does not hold in memory must not resume with the
// model or directory of an earlier turn because the session file read stopped at its limit.

const READ_LIMIT_BYTES = 16 * 1024 * 1024;

let spawned: { args: string[]; cwd: string | undefined }[] = [];
cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (_file: string, args: string[]) => {
  if (args[0] === "--version") return { stdout: "codex-cli 0.154.0", stderr: "" };
  if (args[0] === "mcp") return { stdout: "[]", stderr: "" };
  if (args[0] === "plugin") return { stdout: '{"installed":[],"available":[]}', stderr: "" };
  if (args[0] === "debug") {
    return { stdout: JSON.stringify({ models: ["new-model", "old-model"].map((slug) => ({
      slug, visibility: "list", default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }],
    })) }), stderr: "" };
  }
  return { stdout: "Logged in using ChatGPT", stderr: "" };
};

cp.spawn = ((_file: string, args: string[], options?: { cwd?: string }) => {
  spawned.push({ args, cwd: options?.cwd });
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

/** Calls codex_follow_up on a fresh server, so the thread is never in its registry. */
async function followUp(home: CodexHome, args: Record<string, unknown>, env: Record<string, string> = {}) {
  const keys = Object.keys(process.env).filter((key) => key.startsWith("CODEX_SUBAGENT_") || key === "CODEX_HOME" || key === "CODEX_BIN");
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CODEX_HOME = home.path;
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_SUBAGENT_USAGE_LOG = "off";
  Object.assign(process.env, env);
  resetCatalogCache();
  resetDoctorCache();
  spawned = [];
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
    const validated = await tools.validateToolInput(tool, { prompt: "continue", ...args }, "codex_follow_up");
    const result = await tools.executeToolHandler(tool, validated, {
      signal: new AbortController().signal, sendNotification: async () => {},
    });
    return { isError: result.isError === true, text: result.content.map((item) => item.text ?? "").join("\n") };
  } finally {
    jobs.cancelAll();
    await server.close();
    for (const key of ["CODEX_HOME", "CODEX_BIN", "CODEX_SUBAGENT_USAGE_LOG", ...keys, ...Object.keys(env)]) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

function modelOf(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index === -1 ? undefined : args[index + 1];
}

/** Two existing directories, A for the first turn and B for the last one. */
function directories(home: CodexHome): { dirA: string; dirB: string } {
  const dirA = join(home.path, "dir-a");
  const dirB = join(home.path, "dir-b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  return { dirA, dirB };
}

/**
 * A session whose first turn ran old-model in A and whose last turn ran new-model in B, with more
 * than the read limit between them: the read stops before it reaches the last turn.
 */
function writePastLimit(home: CodexHome, threadId: string): { dirA: string; dirB: string } {
  const { dirA, dirB } = directories(home);
  home.write({ threadId, day: "2026-11-24", lines: [
    SESSION_META_LINE,
    turnContextLine({ cwd: dirA, model: "old-model", effort: "low" }),
    // Keep each intervening line small so reading the prefix stays fast and bounded.
    `${"x".repeat(65535)}\n`.repeat(257),
    turnContextLine({ cwd: dirB, model: "new-model", effort: "low" }),
  ] });
  return { dirA, dirB };
}

/** The same session, padded so the file ends exactly at the read limit. */
function writeExactlyAtLimit(home: CodexHome, threadId: string): { dirA: string; dirB: string } {
  const { dirA, dirB } = directories(home);
  const first = turnContextLine({ cwd: dirA, model: "old-model", effort: "low" });
  const last = turnContextLine({ cwd: dirB, model: "new-model", effort: "low" });
  // The fixture joins lines with "\n" and ends the file with one: four newlines around the padding.
  const paddingBytes = READ_LIMIT_BYTES - Buffer.byteLength([SESSION_META_LINE, first, last].join("\n")) - 2;
  const paddingLine = `${"x".repeat(65535)}\n`;
  const padding = paddingLine.repeat(Math.floor(paddingBytes / paddingLine.length)) +
    "x".repeat(paddingBytes % paddingLine.length);
  home.write({ threadId, day: "2026-11-24", lines: [SESSION_META_LINE, first, padding, last] });
  return { dirA, dirB };
}


test("AC-1 recovers no settings from a session file read past its limit", async () => {
  const home = createCodexHome();
  try {
    writePastLimit(home, "past-limit-unit");
    const lookup = await readTurnContext({ threadId: "past-limit-unit", codexHome: home.path });
    assert.equal(recoverThreadSettings(lookup), null);
  } finally {
    home.dispose();
  }
});

test("AC-1 a follow-up without model past the read limit uses the configured default", async () => {
  const home = createCodexHome();
  try {
    const { dirA } = writePastLimit(home, "past-limit-default");
    const result = await followUp(home, { thread_id: "past-limit-default" }, {
      CODEX_SUBAGENT_DEFAULT_MODEL: "new-model",
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(spawned.length, 1, "the follow-up ran");
    assert.equal(modelOf(spawned[0]!.args), "new-model");
    assert.notEqual(spawned[0]!.cwd, dirA);
  } finally {
    home.dispose();
  }
});

test("AC-1 AC-3 a follow-up without model past the read limit is refused and names the read limit", async () => {
  const home = createCodexHome();
  try {
    writePastLimit(home, "past-limit-refused");
    const result = await followUp(home, { thread_id: "past-limit-refused" });
    assert.equal(result.isError, true, result.text);
    assert.equal(spawned.length, 0, "nothing should have been spawned");
    assert.ok(result.text.includes(SESSION_READ_LIMIT_REASON), result.text);
  } finally {
    home.dispose();
  }
});

test("AC-2 a follow-up with model but no working_dir past the read limit does not resume in a directory from that read", async () => {
  const home = createCodexHome();
  try {
    const { dirA, dirB } = writePastLimit(home, "past-limit-model");
    const result = await followUp(home, { thread_id: "past-limit-model", model: "new-model" });
    assert.equal(result.isError, false, result.text);
    assert.equal(spawned.length, 1, "the follow-up ran");
    assert.notEqual(spawned[0]!.cwd, dirA);
    assert.notEqual(spawned[0]!.cwd, dirB);
  } finally {
    home.dispose();
  }
});

test("AC-3 a follow-up that ran past the read limit says the recorded settings were not used", async () => {
  const home = createCodexHome();
  try {
    writePastLimit(home, "past-limit-note");
    // The default read-only sandbox: no writable-roots note, which carries the same reason, is due.
    const result = await followUp(home, { thread_id: "past-limit-note" }, {
      CODEX_SUBAGENT_DEFAULT_MODEL: "new-model",
    });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.includes(SESSION_READ_LIMIT_REASON), result.text);
  } finally {
    home.dispose();
  }
});

test("AC-4 recovers settings from a session file that ends exactly at the read limit", async () => {
  const home = createCodexHome();
  try {
    const { dirB } = writeExactlyAtLimit(home, "exact-limit");
    const lookup = await readTurnContext({ threadId: "exact-limit", codexHome: home.path });
    assert.deepEqual(recoverThreadSettings(lookup), {
      model: "new-model", reasoningEffort: "low", workingDir: dirB,
    });
    const result = await followUp(home, { thread_id: "exact-limit" });
    assert.equal(result.isError, false, result.text);
    assert.equal(spawned.length, 1, "the follow-up ran");
    assert.equal(modelOf(spawned[0]!.args), "new-model");
    assert.equal(spawned[0]!.cwd, dirB);
  } finally {
    home.dispose();
  }
});
