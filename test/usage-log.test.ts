import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { documentedVariables } from "../scripts/check-registry.ts";
import { loadConfig } from "../src/config.ts";
import { JobRegistry } from "../src/jobs.ts";
import { SHUTDOWN_DEADLINE_MS, createShutdown } from "../src/shutdown.ts";
import type { AppliedSettings, DelegationResult } from "../src/types.ts";
import {
  appendUsageEntry,
  nodeUsageFileSystem,
  resolveUsageDirectory,
  summarizeUsage,
  usageOutcome,
  validateLabel,
  type UsageEntry,
  type UsageFileSystem,
  type UsageGroupBy,
} from "../src/usage.ts";

/**
 * Acceptance tests for the usage log's pure parts (#29, ADR 22, ADR 24). The tool-level behaviour
 * is in `test/usage-tools.test.ts`, and the multi-process rotation in `test/usage-rotation.test.ts`.
 */

const MiB = 1024 * 1024;
const NOW = new Date("2026-10-07T20:13:16.132Z");
const ARCHIVE_NAME = "usage-20261007T201316132Z-4242.jsonl";
const ARCHIVE = /^usage-.+\.jsonl$/;

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    schema: 1,
    ended_at: "2026-10-07T12:00:00.000Z",
    duration_ms: 1000,
    kind: "delegation",
    mode: "blocking",
    thread_id: "thread",
    label: null,
    requested: { model: "m1", effort: "low", sandbox: "read-only" },
    applied: { model: "m1", effort: "low", sandbox: "read-only" },
    flags: { use_worktree: false, target_files: false, acceptance_criteria: false, output_schema: false },
    commands: 1,
    tokens: { input: 100, cached: 40, output: 10, reasoning: 2, uncached: 60 },
    outcome: "success",
    sandbox_ceiling: "workspace-write",
    server_version: "0.5.0",
    cli_version: "0.160.1",
    ...overrides,
  };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "codex-subagent-usage-"));
}

/** Every line of every log file in `dir`, parsed, with the file each came from. */
function readAll(dir: string): { file: string; value: Record<string, unknown> }[] {
  const out: { file: string; value: Record<string, unknown> }[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (file !== "usage.jsonl" && !ARCHIVE.test(file)) continue;
    for (const text of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (text.trim() === "") continue;
      try {
        out.push({ file, value: JSON.parse(text) as Record<string, unknown> });
      } catch {
        // Filler written by a test is not an entry.
      }
    }
  }
  return out;
}

/** The real file system with some operations replaced, counting every call. */
function faultyFs(overrides: Partial<UsageFileSystem>): { fs: UsageFileSystem; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const wrap = <K extends keyof UsageFileSystem>(name: K): UsageFileSystem[K] =>
    ((...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const target = (overrides[name] ?? nodeUsageFileSystem[name]) as (...a: unknown[]) => unknown;
      return target(...args);
    }) as UsageFileSystem[K];
  const fs: UsageFileSystem = {
    mkdir: wrap("mkdir"),
    stat: wrap("stat"),
    readdir: wrap("readdir"),
    readFile: wrap("readFile"),
    rename: wrap("rename"),
    unlink: wrap("unlink"),
    appendFile: wrap("appendFile"),
  };
  return { fs, calls };
}

const injected = (message: string) => async () => {
  throw Object.assign(new Error(message), { code: "EIO" });
};

// AC-1, AC-2: reading the variable.

test("AC-2 reads CODEX_SUBAGENT_USAGE_LOG on and off, trimmed", () => {
  for (const [value, expected] of [["on", true], [" on ", true], ["off", false], [" off\t", false]] as const) {
    const { config, errors } = loadConfig({ CODEX_SUBAGENT_USAGE_LOG: value });
    assert.deepEqual(errors, [], value);
    assert.equal(config.usageLog, expected, JSON.stringify(value));
  }
});

test("AC-1 treats an unset, empty or whitespace CODEX_SUBAGENT_USAGE_LOG as off", () => {
  for (const env of [{}, { CODEX_SUBAGENT_USAGE_LOG: "" }, { CODEX_SUBAGENT_USAGE_LOG: "   " }]) {
    const { config, errors } = loadConfig(env);
    assert.deepEqual(errors, [], JSON.stringify(env));
    assert.equal(config.usageLog, false, JSON.stringify(env));
  }
});

test("AC-2 reports any other CODEX_SUBAGENT_USAGE_LOG value as a configuration error naming the variable", () => {
  for (const value of ["yes", "true", "1", "on,off", "enabled"]) {
    const { errors } = loadConfig({ CODEX_SUBAGENT_USAGE_LOG: value });
    assert.ok(
      errors.some((error) => error.includes("CODEX_SUBAGENT_USAGE_LOG")),
      `${value}: ${JSON.stringify(errors)}`,
    );
  }
});

// AC-4: the outcome and its precedence.

function applied(overrides: Partial<AppliedSettings> = {}): AppliedSettings {
  const confirmed = (value: string) => ({ requested: value, applied: value, state: "confirmed" as const });
  return {
    source: "rollout",
    reason: null,
    model: confirmed("m"),
    reasoningEffort: confirmed("low"),
    sandbox: confirmed("read-only"),
    workingDir: confirmed("/repo"),
    approvalPolicy: "never",
    ...overrides,
  };
}

function result(overrides: Partial<DelegationResult> = {}): DelegationResult {
  return {
    finalMessage: "Done.",
    threadId: "t",
    model: "m",
    reasoningEffort: "low",
    sandbox: "read-only",
    workingDir: "/repo",
    applied: applied(),
    commandCount: 0,
    commands: [],
    fileChanges: [],
    agentMessages: ["Done."],
    errors: [],
    warnings: [],
    turnFailure: null,
    turnUsage: null,
    threadUsage: null,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    structured: null,
    inherited: null,
    stderr: "",
    ...overrides,
  };
}

const breach = {
  applied: applied({ sandbox: { requested: "read-only", applied: "danger-full-access", state: "differs" } }),
};

test("AC-4 records a clean answered run as success", () => {
  assert.equal(usageOutcome(result()), "success");
});

test("AC-4 records failure when the exit code is 0 but the server reports a failure", () => {
  const cases: [string, Partial<DelegationResult>][] = [
    ["sandbox breach", breach],
    ["turn.failed", { turnFailure: "usage limit" }],
    ["invalid structured output", { structured: { ok: false, error: "not JSON" } }],
    ["no answer", { finalMessage: "", agentMessages: [] }],
  ];
  for (const [name, overrides] of cases) {
    assert.equal(usageOutcome(result({ exitCode: 0, ...overrides })), "failure", name);
  }
  assert.equal(usageOutcome(result({ exitCode: 1 })), "failure", "non-zero exit");
});

test("AC-4 records the first of cancelled, timeout, failure, success that applies", () => {
  assert.equal(usageOutcome(result({ cancelled: true, timedOut: true, exitCode: null })), "cancelled");
  assert.equal(usageOutcome(result({ cancelled: true, ...breach })), "cancelled");
  assert.equal(usageOutcome(result({ cancelled: true, exitCode: 1 })), "cancelled");
  assert.equal(usageOutcome(result({ cancelled: true })), "cancelled");
  assert.equal(usageOutcome(result({ timedOut: true, exitCode: null })), "timeout");
  assert.equal(usageOutcome(result({ timedOut: true, exitCode: 0 })), "timeout");
  assert.equal(usageOutcome(result({ timedOut: true, ...breach })), "timeout");
  assert.equal(usageOutcome(result({ timedOut: true, turnFailure: "x", exitCode: 1 })), "timeout");
});

// AC-8: where the log lives.

test("AC-8 uses an absolute XDG_STATE_HOME on every platform", () => {
  assert.deepEqual(
    resolveUsageDirectory({ env: { XDG_STATE_HOME: "/state" }, platform: "darwin", homedir: "/Users/u" }),
    { dir: "/state/codex-subagent-mcp" },
  );
  assert.deepEqual(
    resolveUsageDirectory({ env: { XDG_STATE_HOME: "/var/state" }, platform: "linux", homedir: "/home/u" }),
    { dir: "/var/state/codex-subagent-mcp" },
  );
  assert.deepEqual(
    resolveUsageDirectory({ env: { XDG_STATE_HOME: "D:\\state" }, platform: "win32", homedir: "C:\\Users\\u" }),
    { dir: "D:\\state\\codex-subagent-mcp" },
  );
});

test("AC-8 ignores an unset, empty or relative XDG_STATE_HOME and uses the platform default", () => {
  for (const xdg of [undefined, "", "relative/state"]) {
    const env = xdg === undefined ? {} : { XDG_STATE_HOME: xdg };
    assert.deepEqual(
      resolveUsageDirectory({ env, platform: "darwin", homedir: "/Users/u" }),
      { dir: "/Users/u/Library/Application Support/codex-subagent-mcp" },
      `darwin ${xdg}`,
    );
    assert.deepEqual(
      resolveUsageDirectory({ env, platform: "linux", homedir: "/home/u" }),
      { dir: "/home/u/.local/state/codex-subagent-mcp" },
      `linux ${xdg}`,
    );
    assert.deepEqual(
      resolveUsageDirectory({
        env: { ...env, LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        platform: "win32",
        homedir: "C:\\Users\\u",
      }),
      { dir: "C:\\Users\\u\\AppData\\Local\\codex-subagent-mcp" },
      `win32 ${xdg}`,
    );
  }
});

test("AC-8 reports that nothing can be written on Windows without an absolute XDG_STATE_HOME or LOCALAPPDATA", () => {
  for (const localAppData of [undefined, "", "AppData\\Local"]) {
    const env = localAppData === undefined ? {} : { LOCALAPPDATA: localAppData };
    const resolved = resolveUsageDirectory({ env, platform: "win32", homedir: "C:\\Users\\u" });
    assert.ok("error" in resolved, JSON.stringify(resolved));
    assert.match(resolved.error, /LOCALAPPDATA/);
  }
  assert.deepEqual(
    resolveUsageDirectory({ env: { XDG_STATE_HOME: "D:\\state" }, platform: "win32", homedir: "C:\\Users\\u" }),
    { dir: "D:\\state\\codex-subagent-mcp" },
  );
});

test("AC-8 creates directories 0700, intermediate ones included, and the file 0600 on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = scratch();
  try {
    const dir = join(root, "state", "nested", "codex-subagent-mcp");
    const written = await appendUsageEntry(dir, entry());
    assert.equal(written.written, true, written.error ?? "");
    for (const created of [join(root, "state"), join(root, "state", "nested"), dir]) {
      assert.equal(statSync(created).mode & 0o777, 0o700, created);
    }
    assert.equal(statSync(join(dir, "usage.jsonl")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-8 keeps the permissions of an existing directory and file on POSIX", { skip: process.platform === "win32" }, async () => {
  const dir = scratch();
  try {
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "usage.jsonl"), "");
    chmodSync(join(dir, "usage.jsonl"), 0o644);
    const written = await appendUsageEntry(dir, entry());
    assert.equal(written.written, true, written.error ?? "");
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, "usage.jsonl")).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AC-9: rotation.

/** The bytes one entry takes on disk, measured by writing it. */
async function lineBytes(value: UsageEntry): Promise<number> {
  const dir = scratch();
  try {
    const written = await appendUsageEntry(dir, value);
    assert.equal(written.written, true, written.error ?? "");
    return statSync(join(dir, "usage.jsonl")).size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AC-9 appends without rotating while the file stays within 10 MiB", async () => {
  const value = entry({ thread_id: "fits" });
  const bytes = await lineBytes(value);
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), "");
    truncateSync(join(dir, "usage.jsonl"), 10 * MiB - bytes);
    const written = await appendUsageEntry(dir, value, { now: () => NOW, pid: 4242 });
    assert.equal(written.written, true, written.error ?? "");
    assert.deepEqual(readdirSync(dir), ["usage.jsonl"]);
    assert.equal(statSync(join(dir, "usage.jsonl")).size, 10 * MiB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-9 rotates to usage-<compact UTC timestamp>-<pid>.jsonl when the entry would exceed 10 MiB", async () => {
  const value = entry({ thread_id: "rotates" });
  const bytes = await lineBytes(value);
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), "");
    truncateSync(join(dir, "usage.jsonl"), 10 * MiB - bytes + 1);
    const written = await appendUsageEntry(dir, value, { now: () => NOW, pid: 4242 });
    assert.equal(written.written, true, written.error ?? "");
    assert.deepEqual(readdirSync(dir).sort(), [ARCHIVE_NAME, "usage.jsonl"]);
    assert.ok(!ARCHIVE_NAME.includes(":"));
    assert.equal(statSync(join(dir, ARCHIVE_NAME)).size, 10 * MiB - bytes + 1);
    assert.deepEqual(
      readAll(dir).map(({ file, value: parsed }) => [file, parsed.thread_id]),
      [["usage.jsonl", "rotates"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-9 leaves a file already at the candidate archive name intact and archives under another name", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), line(entry({ thread_id: "old-current" })));
    writeFileSync(join(dir, ARCHIVE_NAME), "keep me\n");
    const written = await appendUsageEntry(dir, entry({ thread_id: "new" }), { now: () => NOW, pid: 4242, maxBytes: 10 });
    assert.equal(written.written, true, written.error ?? "");
    assert.equal(readFileSync(join(dir, ARCHIVE_NAME), "utf8"), "keep me\n");
    const archives = readdirSync(dir).filter((file) => ARCHIVE.test(file) && file !== ARCHIVE_NAME);
    assert.equal(archives.length, 1, JSON.stringify(readdirSync(dir)));
    assert.ok(!archives[0]!.includes(":"), archives[0]);
    assert.deepEqual(
      readAll(dir).map(({ file, value }) => [file === "usage.jsonl" ? "current" : "archive", value.thread_id]).sort(),
      [["archive", "old-current"], ["current", "new"]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-9 serialises writes within one process, so two rotations at once lose and overwrite nothing", async () => {
  const dir = scratch();
  try {
    const first = entry({ thread_id: "prefill" });
    const bytes = await lineBytes(first);
    writeFileSync(join(dir, "usage.jsonl"), line(first));
    const options = { now: () => NOW, pid: 4242, maxBytes: bytes + 10 };
    const results = await Promise.all([
      appendUsageEntry(dir, entry({ thread_id: "one" }), options),
      appendUsageEntry(dir, entry({ thread_id: "two" }), options),
    ]);
    for (const written of results) assert.equal(written.written, true, written.error ?? "");
    const archives = readdirSync(dir).filter((file) => ARCHIVE.test(file));
    assert.equal(archives.length, 2, JSON.stringify(readdirSync(dir)));
    assert.deepEqual(readAll(dir).map(({ value }) => value.thread_id).sort(), ["one", "prefill", "two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-9 deletes the oldest archives by the timestamp in their names until they hold at most 50 MiB", async () => {
  const dir = scratch();
  try {
    const names = [1, 2, 3, 4, 5, 6].map((day) => `usage-2026100${day}T000000000Z-1.jsonl`);
    // Written newest first, so that file times disagree with the names.
    for (const name of [...names].reverse()) {
      writeFileSync(join(dir, name), "");
      truncateSync(join(dir, name), 10 * MiB);
    }
    writeFileSync(join(dir, "usage.jsonl"), "");
    truncateSync(join(dir, "usage.jsonl"), 10 * MiB);
    const written = await appendUsageEntry(dir, entry({ thread_id: "after-prune" }), { now: () => NOW, pid: 4242 });
    assert.equal(written.written, true, written.error ?? "");
    assert.equal(written.pruneError, null);
    const archives = readdirSync(dir).filter((file) => ARCHIVE.test(file)).sort();
    assert.deepEqual(archives, [...names.slice(2), ARCHIVE_NAME].sort());
    const total = archives.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
    assert.ok(total <= 50 * MiB, String(total));
    assert.deepEqual(readAll(dir).map(({ value }) => value.thread_id), ["after-prune"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AC-10: a write that fails.

test("AC-10 reports a directory that cannot be created and does not append", async () => {
  const root = scratch();
  try {
    const { fs, calls } = faultyFs({ mkdir: injected("injected mkdir failure") });
    const written = await appendUsageEntry(join(root, "missing", "codex-subagent-mcp"), entry(), { fs });
    assert.equal(written.written, false);
    assert.match(written.error ?? "", /injected mkdir failure/);
    assert.equal(calls.appendFile ?? 0, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-10 skips the entry when the rotation fails, so the current file never passes its cap", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), line(entry({ thread_id: "current" })));
    const { fs, calls } = faultyFs({ rename: injected("injected rename failure") });
    const written = await appendUsageEntry(dir, entry({ thread_id: "skipped" }), { fs, now: () => NOW, pid: 4242, maxBytes: 10 });
    assert.equal(written.written, false);
    assert.match(written.error ?? "", /injected rename failure/);
    assert.equal(calls.appendFile ?? 0, 0);
    assert.deepEqual(readAll(dir).map(({ value }) => value.thread_id), ["current"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-10 reports a failed append once, without retrying", async () => {
  const dir = scratch();
  try {
    const { fs, calls } = faultyFs({ appendFile: injected("injected append failure") });
    const written = await appendUsageEntry(dir, entry(), { fs });
    assert.equal(written.written, false);
    assert.match(written.error ?? "", /injected append failure/);
    assert.equal(calls.appendFile, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-10 still writes the entry when only deleting old archives fails, and says so", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage-20261001T000000000Z-1.jsonl"), "x".repeat(100));
    writeFileSync(join(dir, "usage.jsonl"), line(entry({ thread_id: "current" })));
    const { fs } = faultyFs({ unlink: injected("injected unlink failure") });
    const written = await appendUsageEntry(dir, entry({ thread_id: "kept" }), {
      fs, now: () => NOW, pid: 4242, maxBytes: 10, maxArchiveBytes: 10,
    });
    assert.equal(written.written, true, written.error ?? "");
    assert.equal(written.error, null);
    assert.match(written.pruneError ?? "", /injected unlink failure/);
    assert.ok(readAll(dir).some(({ file, value }) => file === "usage.jsonl" && value.thread_id === "kept"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AC-11: the label's characters (ADR 24).

test("AC-11 accepts 1 to 64 code points of any other text, verbatim", () => {
  for (const label of [
    "a",
    "a".repeat(64),
    "😀".repeat(64),
    "👨\u200D👩\u200D👧",
    "   ",
    "e\u0301",
    "100% quota, $5 credit",
    "review\u00A0pass",
  ]) {
    assert.equal(validateLabel(label), null, JSON.stringify(label));
  }
});

test("AC-11 refuses a label outside 1 to 64 code points and names the length", () => {
  for (const label of ["", "a".repeat(65), "😀".repeat(65)]) {
    assert.match(validateLabel(label) ?? "", /64/, JSON.stringify(label));
  }
});

test("AC-11 refuses an unpaired surrogate as not well-formed", () => {
  for (const label of ["a\uD800b", "\uDC00", "ok\uD83D"]) {
    const message = validateLabel(label) ?? "";
    assert.match(message, /well-formed|surrogate/i, JSON.stringify(label));
    assert.doesNotMatch(message, /bidi/i);
  }
});

test("AC-11 refuses control characters of category Cc", () => {
  for (const label of ["a\nb", "a\tb", "\u0000", "a\u007Fb", "a\u0085b", "a\u001Bb"]) {
    const message = validateLabel(label) ?? "";
    assert.match(message, /control/i, JSON.stringify(label));
    assert.doesNotMatch(message, /bidi/i, JSON.stringify(label));
  }
});

test("AC-11 refuses every Bidi_Control character", () => {
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const label = `ab${String.fromCodePoint(code)}cd`;
    assert.match(validateLabel(label) ?? "", /bidi/i, code.toString(16));
  }
});

// AC-13, AC-15: reading the log back.

const WINDOW_NOW = new Date("2026-10-07T12:00:00.000Z");
const WINDOW_START = "2026-10-06T12:00:00.000Z";

async function summary(dir: string, groupBy: UsageGroupBy = "model", sinceHours = 24, fs?: UsageFileSystem) {
  return summarizeUsage(dir, { sinceHours, groupBy, now: WINDOW_NOW, ...(fs ? { fs } : {}) });
}

test("AC-13 keeps entries from the window's start on, including any dated in the future, from every file", async () => {
  const dir = scratch();
  try {
    writeFileSync(
      join(dir, "usage.jsonl"),
      line(entry({ ended_at: WINDOW_START, thread_id: "at-start" })) +
        line(entry({ ended_at: "2026-10-06T11:59:59.999Z", thread_id: "before" })) +
        line(entry({ ended_at: "2026-10-08T12:00:00.000Z", thread_id: "future" })),
    );
    writeFileSync(join(dir, "usage-20261001T000000000Z-1.jsonl"), line(entry({ ended_at: "2026-10-07T00:00:00.000Z" })));
    const result = await summary(dir);
    assert.equal(result.entries, 3);
    assert.equal(result.filesFound, 2);
    assert.equal(result.skipped, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-13 groups by applied model and effort by default, with unconfirmed as its own value", async () => {
  const dir = scratch();
  try {
    const at = (model: string, effort: string, duration: number, extra: Partial<UsageEntry> = {}) =>
      line(entry({ applied: { model, effort, sandbox: "read-only" }, duration_ms: duration, ...extra }));
    writeFileSync(
      join(dir, "usage.jsonl"),
      at("m1", "low", 10, { commands: 2 }) +
        at("m1", "low", 30, { commands: 3, outcome: "failure" }) +
        at("m1", "low", 20, { tokens: null, outcome: "cancelled" }) +
        at("m1", "high", 10, { tokens: null }) +
        at("m1", "high", 40, { tokens: null, outcome: "timeout" }) +
        at("unconfirmed", "low", 5) +
        at("m1", "unconfirmed", 7),
    );
    const result = await summarizeUsage(dir, { sinceHours: 24, groupBy: "model", now: WINDOW_NOW });
    const group = (model: string, effort: string) =>
      result.groups.find((g) => JSON.stringify(g.key) === JSON.stringify({ model, effort }));

    const low = group("m1", "low");
    assert.ok(low, JSON.stringify(result.groups));
    assert.equal(low.count, 3);
    assert.deepEqual(low.outcomes, { success: 1, failure: 1, timeout: 0, cancelled: 1 });
    assert.equal(low.commands, 2 + 3 + 1);
    assert.equal(low.totalDurationMs, 60);
    assert.equal(low.medianDurationMs, 20);
    assert.equal(low.knownTokens, 2);
    assert.equal(low.unknownTokens, 1);
    assert.deepEqual(low.tokens, { input: 200, cached: 80, output: 20, reasoning: 4, uncached: 120 });

    const high = group("m1", "high");
    assert.ok(high);
    assert.equal(high.medianDurationMs, 25);
    assert.equal(high.knownTokens, 0);
    assert.equal(high.unknownTokens, 2);
    assert.equal(high.tokens, null);

    assert.ok(group("unconfirmed", "low"));
    assert.ok(group("m1", "unconfirmed"));
    assert.equal(result.groups.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-13 groups by label with null as its own group, by outcome and by kind", async () => {
  const dir = scratch();
  try {
    writeFileSync(
      join(dir, "usage.jsonl"),
      line(entry({ label: "review" })) +
        line(entry({ label: "review", kind: "follow-up", outcome: "failure" })) +
        line(entry({ label: "e\u0301" })) +
        line(entry({ label: "\u00E9" })) +
        line(entry({ label: null })),
    );
    const byLabel = await summary(dir, "label");
    const keys = byLabel.groups.map((g) => JSON.stringify(g.key)).sort();
    assert.deepEqual(
      keys,
      [{ label: null }, { label: "e\u0301" }, { label: "review" }, { label: "\u00E9" }].map((k) => JSON.stringify(k)).sort(),
    );
    const byOutcome = await summary(dir, "outcome");
    assert.deepEqual(
      byOutcome.groups.map((g) => [JSON.stringify(g.key), g.count]).sort(),
      [[JSON.stringify({ outcome: "failure" }), 1], [JSON.stringify({ outcome: "success" }), 4]].sort(),
    );
    const byKind = await summary(dir, "kind");
    assert.deepEqual(
      byKind.groups.map((g) => [JSON.stringify(g.key), g.count]).sort(),
      [[JSON.stringify({ kind: "delegation" }), 4], [JSON.stringify({ kind: "follow-up" }), 1]].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-13 reports the oldest valid entry in any file, whatever the window", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), line(entry({ ended_at: "2026-10-07T00:00:00.000Z" })));
    writeFileSync(
      join(dir, "usage-20260901T000000000Z-1.jsonl"),
      "not json\n" + line(entry({ ended_at: "2026-09-01T08:00:00.000Z" })),
    );
    const result = await summary(dir);
    assert.equal(result.entries, 1);
    assert.equal(result.oldest, "2026-09-01T08:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-15 skips lines that do not parse, have an unknown schema or lack or mistype a needed field, the same for every grouping", async () => {
  const dir = scratch();
  try {
    const valid = entry() as unknown as Record<string, unknown>;
    const without = (field: string) => {
      const copy = { ...valid };
      delete copy[field];
      return copy;
    };
    const bad = [
      "not json",
      "[1,2,3]",
      JSON.stringify({ ...valid, schema: 2 }),
      JSON.stringify(without("schema")),
      JSON.stringify(without("ended_at")),
      JSON.stringify({ ...valid, ended_at: "yesterday" }),
      JSON.stringify(without("duration_ms")),
      JSON.stringify({ ...valid, duration_ms: "5" }),
      JSON.stringify({ ...valid, duration_ms: -1 }),
      JSON.stringify(without("kind")),
      JSON.stringify({ ...valid, kind: "other" }),
      JSON.stringify(without("outcome")),
      JSON.stringify({ ...valid, outcome: "maybe" }),
      JSON.stringify(without("commands")),
      JSON.stringify({ ...valid, commands: "3" }),
      JSON.stringify(without("applied")),
      JSON.stringify({ ...valid, applied: { model: "m1", sandbox: "read-only" } }),
      JSON.stringify({ ...valid, applied: { model: 5, effort: "low", sandbox: "read-only" } }),
      JSON.stringify(without("label")),
      JSON.stringify({ ...valid, label: 5 }),
      JSON.stringify(without("tokens")),
      JSON.stringify({ ...valid, tokens: { input: 1 } }),
      JSON.stringify({ ...valid, tokens: { input: "1", cached: 0, output: 0, reasoning: 0 } }),
      JSON.stringify({ ...valid, tokens: 0 }),
    ];
    writeFileSync(join(dir, "usage.jsonl"), `${bad.join("\n")}\n${line(valid)}`);
    for (const groupBy of ["model", "label", "outcome", "kind"] as const) {
      const result = await summary(dir, groupBy);
      assert.equal(result.skipped, bad.length, groupBy);
      assert.equal(result.entries, 1, groupBy);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-15 uses an entry missing only fields the reader does not need, and derives uncached input", async () => {
  const dir = scratch();
  try {
    const sparse: Record<string, unknown> = { ...(entry() as unknown as Record<string, unknown>) };
    for (const field of ["cli_version", "server_version", "flags", "requested", "thread_id", "mode", "sandbox_ceiling"]) {
      delete sparse[field];
    }
    sparse.tokens = { input: 100, cached: 30, output: 5, reasoning: 1 };
    writeFileSync(join(dir, "usage.jsonl"), line(sparse));
    const result = await summary(dir);
    assert.equal(result.skipped, 0);
    assert.equal(result.entries, 1);
    assert.deepEqual(result.groups[0]?.tokens, { input: 100, cached: 30, output: 5, reasoning: 1, uncached: 70 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-15 names a file that exists but cannot be read and still summarises the others", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "usage.jsonl"), line(entry()));
    writeFileSync(join(dir, "usage-20261001T000000000Z-1.jsonl"), line(entry()));
    const real = nodeUsageFileSystem.readFile;
    const { fs } = faultyFs({
      readFile: async (path: string) => {
        if (path.endsWith("usage-20261001T000000000Z-1.jsonl")) throw new Error("injected read failure");
        return real(path);
      },
    });
    const result = await summary(dir, "model", 24, fs);
    assert.deepEqual(result.unreadable, ["usage-20261001T000000000Z-1.jsonl"]);
    assert.equal(result.entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-15 finds nothing to summarise when no file exists", async () => {
  const dir = scratch();
  try {
    const empty = await summary(dir);
    assert.equal(empty.filesFound, 0);
    assert.equal(empty.entries, 0);
    assert.deepEqual(empty.groups, []);
    const missing = await summary(join(dir, "does-not-exist"));
    assert.equal(missing.filesFound, 0);
    assert.deepEqual(missing.unreadable, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AC-22: the variable is documented and registered by name.

test("AC-22 lists CODEX_SUBAGENT_USAGE_LOG in the README's configuration table and in server.json", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.ok(documentedVariables(readme).includes("CODEX_SUBAGENT_USAGE_LOG"), "README configuration table");
  const serverJson = JSON.parse(readFileSync("server.json", "utf8")) as {
    packages?: { registryType?: string; environmentVariables?: { name?: string }[] }[];
  };
  const npm = serverJson.packages?.find((entry) => entry.registryType === "npm");
  assert.ok(
    (npm?.environmentVariables ?? []).some((variable) => variable.name === "CODEX_SUBAGENT_USAGE_LOG"),
    "server.json npm environmentVariables",
  );
});

// Regressions found by reviewing the implementation (#29), added to the oracle with the maintainer's approval.

test("AC-10 a failure while recording a background job's usage does not change how the job ended", async () => {
  const registry = new JobRegistry();
  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller: new AbortController(),
    run: async () => result(),
    onSettled: () => {
      throw new Error("injected failure while recording usage");
    },
  });
  for (let i = 0; i < 50 && registry.snapshot(jobId).state === "running"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(registry.snapshot(jobId).state, "completed");
  assert.equal(registry.snapshot(jobId).error, undefined);
});

test("AC-3 a shutdown writes a usage entry already queued when the budget allows, and never exits past its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const run = (drainMs: number) => {
    const exits: number[] = [];
    let drained = false;
    const shutdown = createShutdown({
      runs: { stopAll: async () => [] },
      jobs: { cancelAll: () => {} },
      close: async () => {},
      exit: () => exits.push(Date.now()),
      log: () => {},
      drain: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            drained = true;
            resolve();
          }, drainMs),
        ),
    });
    shutdown(143);
    return { exits, drained: () => drained };
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const quick = run(50);
  await flush();
  assert.deepEqual(quick.exits, [], "exited before the queued write finished");
  t.mock.timers.tick(50);
  await flush();
  assert.equal(quick.drained(), true);
  assert.deepEqual(quick.exits, [50]);

  const slow = run(10_000);
  await flush();
  t.mock.timers.tick(SHUTDOWN_DEADLINE_MS);
  await flush();
  assert.equal(slow.drained(), false);
  assert.equal(slow.exits.length, 1);
  assert.ok(slow.exits[0]! <= 50 + SHUTDOWN_DEADLINE_MS, String(slow.exits[0]));
});
