import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCodex, type RunHandle, type RunOptions } from "../src/codex/runner.ts";
import { ActiveRuns } from "../src/runs.ts";

import { createFakeCodex, jsonl, type FakeCodex, type Scenario } from "./fixtures/fake-codex.ts";

/**
 * The schema file of a run (#28), through the runner with the Node stand-in, on
 * every platform. Each test gives the runner a private parent directory and
 * asserts it is empty once the run has exited.
 */

const POSIX = process.platform !== "win32";
const SCHEMA = '{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false}';
const THREAD = jsonl({ type: "thread.started", thread_id: "schema-thread" });
const message = (text: string) => jsonl({ type: "item.completed", item: { type: "agent_message", text } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Harness {
  fake: FakeCodex;
  parent: string;
  schemaPath: () => string | null;
  leftovers: () => string[];
  start: (options?: Partial<RunOptions>) => RunHandle;
}

async function withRun(scenario: Scenario, body: (h: Harness) => Promise<void>): Promise<void> {
  const fake = createFakeCodex(scenario);
  const parent = mkdtempSync(join(tmpdir(), "schema-runs-"));
  const handles: RunHandle[] = [];
  const h: Harness = {
    fake,
    parent,
    schemaPath: () => {
      try {
        const { argv } = fake.received();
        const at = argv.indexOf("--output-schema");
        return at === -1 ? null : argv[at + 1]!;
      } catch {
        return null;
      }
    },
    leftovers: () => readdirSync(parent),
    start: (options = {}) => {
      const handle = runCodex({
        invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
        prompt: "irrelevant",
        codexPath: fake.codexPath,
        codexHome: fake.workingDir,
        timeoutSeconds: 60,
        outputSchema: SCHEMA,
        tempDir: parent,
        ...options,
      });
      handle.result.catch(() => {});
      handles.push(handle);
      return handle;
    },
  };
  try {
    await body(h);
  } finally {
    for (const handle of handles) handle.cancel({ graceMs: 0 });
    await Promise.all(handles.map((handle) => within(handle.exited, 10_000, "exit").catch(() => {})));
    await sleep(50);
    fake.dispose();
    rmSync(parent, { recursive: true, force: true });
  }
}

test("AC-1 AC-7 the CLI reads exactly the schema, and it is removed once the run has exited", async () => {
  await withRun({ chunks: [THREAD, message('{"n":1}')], exitCode: 0 }, async (h) => {
    let presentWhileRunning = false;
    const handle = h.start({
      onEvent: (event) => {
        if (event.type === "thread.started") presentWhileRunning = existsSync(h.schemaPath() ?? "");
      },
    });
    const outcome = await handle.result;
    await within(handle.exited, 5000, "exit");
    assert.equal(h.fake.received().schema, SCHEMA);
    assert.equal(presentWhileRunning, true);
    assert.deepEqual(outcome.structured, { ok: true, json: '{"n":1}' });
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-9 a run without a schema gets no flag, no file and no parsing", async () => {
  await withRun({ chunks: [THREAD, message('{"n":1}')], exitCode: 0 }, async (h) => {
    const handle = h.start({ outputSchema: undefined });
    const outcome = await handle.result;
    await within(handle.exited, 5000, "exit");
    assert.ok(!h.fake.received().argv.includes("--output-schema"));
    assert.equal(outcome.structured, null);
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 removes the file after a run that exits 1", async () => {
  await withRun({ chunks: [THREAD], exitCode: 1 }, async (h) => {
    const handle = h.start();
    await handle.result;
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

const STUBBORN: Scenario = { chunks: [THREAD], stayRunning: true, ignoreSigterm: POSIX };

test("AC-7 keeps the file through a timed-out run's forced stage, then removes it", async () => {
  await withRun(STUBBORN, async (h) => {
    const handle = h.start({ timeoutSeconds: 1, killGraceMs: 600 });
    const outcome = await within(handle.result, 5000, "the timeout");
    assert.equal(outcome.timedOut, true);
    if (POSIX) {
      // The stand-in ignores SIGINT: it is still running, and may still read the file.
      assert.equal(existsSync(h.schemaPath()!), true, "removed before the process exited");
    }
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 keeps the file through a cancelled run's forced stage, then removes it", async () => {
  await withRun(STUBBORN, async (h) => {
    let handle!: RunHandle;
    handle = h.start({
      killGraceMs: 600,
      onEvent: (event) => {
        if (event.type === "thread.started") handle.cancel();
      },
    });
    await sleep(200);
    if (POSIX) assert.equal(existsSync(h.schemaPath()!), true, "removed before the process exited");
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 has removed the file by the time a shutdown confirms the run stopped", async () => {
  await withRun(STUBBORN, async (h) => {
    const runs = new ActiveRuns();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    runs.track(h.start({ onEvent: (event) => { if (event.type === "thread.started") ready(); } }));
    await within(started, 5000, "the start");
    const unconfirmed = await runs.stopAll({ graceMs: 100, deadlineMs: 3000 });
    assert.deepEqual(unconfirmed, []);
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 leaves the file in place when a shutdown deadline passes before the run stopped", { skip: POSIX ? false : "Windows ends the tree at once" }, async () => {
  await withRun(STUBBORN, async (h) => {
    const runs = new ActiveRuns();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const handle = runs.track(h.start({ onEvent: (event) => { if (event.type === "thread.started") ready(); } }));
    await within(started, 5000, "the start");
    const unconfirmed = await runs.stopAll({ graceMs: 1500, deadlineMs: 50 });
    assert.equal(unconfirmed.length, 1);
    assert.equal(existsSync(h.schemaPath()!), true, "removed while the run could still be reading it");
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 leaves nothing behind when the CLI cannot be started", async () => {
  await withRun({ chunks: [] }, async (h) => {
    const handle = h.start({ codexPath: join(h.parent, "no-such-codex") });
    await assert.rejects(handle.result);
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 creates no file for a run cancelled before it started", async () => {
  await withRun({ chunks: [] }, async (h) => {
    const controller = new AbortController();
    controller.abort();
    const handle = h.start({ signal: controller.signal });
    await assert.rejects(handle.result);
    await within(handle.exited, 5000, "exit");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-7 refuses to run when the schema file cannot be written, and starts nothing", async () => {
  await withRun({ chunks: [THREAD], exitCode: 0 }, async (h) => {
    const handle = h.start({ tempDir: join(h.parent, "missing", "deeper") });
    await assert.rejects(handle.result, /schema/i);
    await within(handle.exited, 5000, "exit");
    assert.equal(existsSync(join(h.fake.workingDir, "received.json")), false, "the CLI was started anyway");
    assert.deepEqual(h.leftovers(), []);
  });
});

test("AC-5 refuses an earlier message as the structured result when the final one was discarded", async () => {
  // A JSONL line over 1 MiB is discarded by the parser; without a guard, the
  // JSON commentary before it would become the "final" message.
  const oversized = message("x".repeat(1024 * 1024 + 16));
  await withRun({ chunks: [THREAD, message('{"n":1}'), oversized], exitCode: 0 }, async (h) => {
    const handle = h.start();
    const outcome = await handle.result;
    assert.equal(outcome.structured?.ok, false);
    assert.match(outcome.structured && !outcome.structured.ok ? outcome.structured.error : "", /intact/);
  });
});
