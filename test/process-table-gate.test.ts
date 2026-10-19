import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { decideProcessTableGate, type ProbeOutcome } from "./support/process-table-gate.ts";

/**
 * The tests that need the real process table, where `ps` is denied (#159).
 *
 * The denial is simulated without a sandbox: a file named `ps` that cannot be
 * executed, alone on `PATH`, makes spawning it fail with EACCES, the same
 * refusal at exec that Codex's sandbox produces as EPERM.
 */

const POSIX = process.platform !== "win32";
const POSIX_ONLY = { skip: POSIX ? false : "a file without the execute bit is not refused on Windows" };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DENIED = ["EPERM", "EACCES"];
const UNIX: NodeJS.Platform[] = ["darwin", "linux"];

/** The three tests whose assertion depends on the table's content. */
const NEEDS_TABLE = [
  "AC-3 (#107) stops a command Codex started in its own process group, within the host's budget",
  "AC-1 (#107) stops a command Codex started in its own process group when the run is cancelled",
  "AC-2 (#107) (#169 AC-3) stops a command Codex started in its own process group when the run times out",
];

const outcome = (result: ProbeOutcome) => () => result;

test("AC-1 skips, naming ps and the error code, when launching ps is refused and CI is not set", () => {
  for (const platform of UNIX) {
    for (const errorCode of DENIED) {
      const decision = decideProcessTableGate({ platform, probe: outcome({ errorCode, status: null }), env: {} });
      assert.equal(decision.action, "skip", `${platform} ${errorCode}`);
      if (decision.action !== "skip") continue;
      assert.match(decision.reason, /\bps\b/, `${platform} ${errorCode}`);
      assert.match(decision.reason, new RegExp(errorCode), `${platform} ${errorCode}`);
    }
  }
});

test("AC-2 runs when ps exits 0, and when it fails in any way other than a refusal to execute", () => {
  const outcomes: ProbeOutcome[] = [
    { status: 0 },
    { errorCode: "ENOENT", status: null },
    { errorCode: "ETIMEDOUT", status: null },
    { status: 1 },
  ];
  for (const platform of UNIX) {
    for (const result of outcomes) {
      const decision = decideProcessTableGate({ platform, probe: outcome(result), env: {} });
      assert.deepEqual(decision, { action: "run" }, `${platform} ${JSON.stringify(result)}`);
    }
  }
});

test("AC-3 fails, naming ps, the error code and CI, when launching ps is refused and CI is set to any value but empty, false or 0", () => {
  for (const platform of UNIX) {
    for (const errorCode of DENIED) {
      for (const CI of ["true", "1", "buildkite"]) {
        const decision = decideProcessTableGate({ platform, probe: outcome({ errorCode, status: null }), env: { CI } });
        const label = `${platform} ${errorCode} CI=${CI}`;
        assert.equal(decision.action, "fail", label);
        if (decision.action !== "fail") continue;
        assert.match(decision.message, /\bps\b/, label);
        assert.match(decision.message, new RegExp(errorCode), label);
        assert.match(decision.message, /\bCI\b/, label);
      }
    }
  }
});

test("AC-3 treats CI empty, false or 0 as not set", () => {
  for (const CI of ["", "false", "0"]) {
    const decision = decideProcessTableGate({ platform: "linux", probe: outcome({ errorCode: "EPERM", status: null }), env: { CI } });
    assert.equal(decision.action, "skip", `CI=${JSON.stringify(CI)}`);
  }
});

test("AC-4 runs on Windows without launching ps", () => {
  let launched = 0;
  const decision = decideProcessTableGate({
    platform: "win32",
    probe: () => {
      launched += 1;
      return { errorCode: "EPERM", status: null };
    },
    env: { CI: "true" },
  });
  assert.deepEqual(decision, { action: "run" });
  assert.equal(launched, 0, "ps was launched on Windows");
});

/** A directory holding only a `ps` that cannot be executed. */
function deniedPsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "denied-ps-"));
  writeFileSync(join(dir, "ps"), "#!/bin/sh\n", { mode: 0o644 });
  return dir;
}

/**
 * An environment with only `dir` on PATH, `CI` as given, and no parent test
 * runner. Only absolute paths run there, as the test runner and the stand-ins do.
 */
function envWithPath(dir: string, ci: string | undefined, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PATH: dir };
  // Set by the parent runner; a child that inherits it reports to it instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return env;
}

/** Runs an ES module snippet with tsx in the repository, under `env`. */
const runSnippet = (code: string, env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

const DECIDE_TWICE =
  "const { processTableDecision } = await import('./test/support/process-table-gate.ts');" +
  " process.stdout.write(JSON.stringify([processTableDecision(), processTableDecision()]));";

test("AC-2 the real decision runs when ps exits 0 or 1, launching the server's listing once", POSIX_ONLY, () => {
  for (const exit of ["0", "1"]) {
    const dir = mkdtempSync(join(tmpdir(), "recording-ps-"));
    const log = join(dir, "argv.log");
    try {
      // Only shell builtins: nothing else is on PATH.
      writeFileSync(join(dir, "ps"), '#!/bin/sh\necho "$*" >> "$PS_LOG"\nexit "$PS_EXIT"\n', { mode: 0o755 });
      const result = runSnippet(DECIDE_TWICE, envWithPath(dir, undefined, { PS_LOG: log, PS_EXIT: exit }));
      assert.equal(result.status, 0, `exit ${exit}: the decision threw:\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), [{ action: "run" }, { action: "run" }], `exit ${exit}`);
      assert.equal(readFileSync(log, "utf8"), "-A -o pid=,ppid=,pgid=\n", `exit ${exit}: not the server's listing, once`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("AC-2 the real decision runs when ps is missing", POSIX_ONLY, () => {
  const dir = mkdtempSync(join(tmpdir(), "no-ps-"));
  try {
    const result = runSnippet(DECIDE_TWICE, envWithPath(dir, "true"));
    assert.equal(result.status, 0, `the decision threw:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), [{ action: "run" }, { action: "run" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the three tests that need the table, with `ps` denied, and returns the TAP output and how the run ended. */
function runNeedingTable(ci: string | undefined): { tap: string; status: number | null; signal: NodeJS.Signals | null } {
  const dir = deniedPsDir();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx", "--test", "--test-reporter=tap",
        "--test-name-pattern=own process group",
        "test/shutdown.test.ts", "test/termination.test.ts",
      ],
      { cwd: ROOT, env: envWithPath(dir, ci), encoding: "utf8", timeout: 60_000 },
    );
    return { tap: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status, signal: result.signal };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** TAP escapes `#` in a test name, since it would otherwise start a directive. */
const tapName = (name: string): string => name.replaceAll("#", "\\#");

const RESULT = /^\s*(not )?ok \d+ - /;

/** The TAP result line of `name`, or undefined when it was not reported. */
const resultLine = (tap: string, name: string): string | undefined =>
  tap.split("\n").find((line) => RESULT.test(line) && line.includes(tapName(name)));

/** The YAML diagnostics that follow the result line of `name`, up to the next subtest. */
function diagnostics(tap: string, name: string): string {
  const lines = tap.split("\n");
  const start = lines.findIndex((line) => RESULT.test(line) && line.includes(tapName(name)));
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && (/^\s*# Subtest:/.test(line) || RESULT.test(line)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

test("AC-5 reports the three tests as skipped, naming ps and the error code, when ps is denied and CI is not set", POSIX_ONLY, () => {
  const { tap } = runNeedingTable(undefined);
  for (const name of NEEDS_TABLE) {
    const line = resultLine(tap, name);
    assert.ok(line, `${name} was not reported:\n${tap}`);
    assert.match(line, /^\s*ok \d+ - .* # SKIP .*\bps\b/, `${name} was not skipped naming ps:\n${tap}`);
    assert.match(line, /# SKIP .*\bEACCES\b/, `${name} was skipped without the error code:\n${tap}`);
  }
  assert.match(tap, /^# fail 0$/m, `a test failed:\n${tap}`);
});

test("AC-6 fails the three tests, naming ps, the error code and CI, and the run, when ps is denied and CI is set", POSIX_ONLY, () => {
  const { tap, status, signal } = runNeedingTable("true");
  for (const name of NEEDS_TABLE) {
    const line = resultLine(tap, name);
    assert.ok(line, `${name} was not reported:\n${tap}`);
    assert.match(line, /^\s*not ok \d+ - /, `${name} did not fail:\n${tap}`);
    const failure = diagnostics(tap, name);
    assert.match(failure, /\bps\b/, `${name} failed without naming ps:\n${failure}`);
    assert.match(failure, /\bEACCES\b/, `${name} failed without the error code:\n${failure}`);
    assert.match(failure, /\bCI\b/, `${name} failed without naming CI:\n${failure}`);
  }
  assert.match(tap, /^# fail 3$/m, `not exactly the three tests failed:\n${tap}`);
  // A run cut short by the timeout also ends non-zero, with a signal and no status.
  assert.equal(signal, null, `the run was ended by ${signal}`);
  assert.equal(status, 1, "the run did not exit with a test failure");
});

test("AC-7 counts a live process as alive, without throwing, when ps is denied", POSIX_ONLY, () => {
  const dir = deniedPsDir();
  try {
    const result = runSnippet(
      "const { isAlive } = await import('./test/fixtures/process-alive.ts'); process.stdout.write(String(isAlive(process.pid)));",
      envWithPath(dir, undefined),
    );
    assert.equal(result.status, 0, `the check threw:\n${result.stderr}`);
    assert.equal(result.stdout, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-7 cleanup still kills a live process when ps is denied", POSIX_ONLY, async () => {
  const dir = deniedPsDir();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const ended = new Promise<NodeJS.Signals | null>((resolve) => sleeper.once("exit", (_code, signal) => resolve(signal)));
  try {
    assert.ok(sleeper.pid, "the sleeper did not start");
    const result = runSnippet(
      `const { killQuietly } = await import('./test/fixtures/process-alive.ts'); killQuietly(${sleeper.pid});`,
      envWithPath(dir, undefined),
    );
    assert.equal(result.status, 0, `cleanup threw:\n${result.stderr}`);
    const timeout = new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 5_000).unref());
    assert.equal(await Promise.race([ended, timeout]), "SIGKILL", "cleanup did not kill the live process");
  } finally {
    sleeper.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
