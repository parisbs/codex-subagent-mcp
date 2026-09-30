import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  NEGATIVE_CONTROL,
  argvShapes,
  checkCompatibility,
  findCodexBinary,
  shimProblem,
  type CliRun,
} from "../scripts/check-codex-compat.ts";

/**
 * The CI check that runs every new Codex CLI release against this server (#99).
 * The CLI itself is replaced by a function here; the workflow runs the real one.
 */

const ARGS_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/codex/args.ts", import.meta.url)),
  "utf8",
);

const CATALOG = JSON.stringify({
  models: [{ slug: "some-model", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }],
});

const ok = (stdout = ""): CliRun => ({ status: 0, stdout, stderr: "" });

/** A CLI that accepts everything but the negative control, like a healthy release. */
function healthyCli(overrides: (args: string[]) => CliRun | undefined = () => undefined) {
  const calls: string[][] = [];
  const run = (args: string[]): CliRun => {
    calls.push(args);
    const overridden = overrides(args);
    if (overridden) return overridden;
    if (args[0] === "debug") return ok(CATALOG);
    if (args[0] === "mcp") return ok("[]");
    if (args[0] === "features") return ok("worktrees  stable  true\n");
    if (args.includes("--full-auto")) {
      return { status: 2, stdout: "", stderr: "error: unexpected argument '--full-auto' found\n" };
    }
    return ok("Usage: codex exec [OPTIONS]");
  };
  return { run, calls };
}

const check = (run: (args: string[]) => CliRun, version = "0.154.0") =>
  checkCompatibility({ version, newestVerified: "0.154.0", dir: tmpdir(), run });

test("AC-1 covers every option the argv builder can emit", () => {
  const emitted = new Set(argvShapes("m", tmpdir()).flatMap((shape) => shape.argv.filter((a) => a.startsWith("-"))));
  const declared = [...ARGS_SOURCE.matchAll(/"(--?[a-z][a-z-]*)"/g)].map((match) => match[1]!);
  const missing = declared.filter((option) => !emitted.has(option));
  assert.deepEqual(missing, [], `argv shapes never exercise: ${missing.join(", ")}`);
});

test("AC-1 checks exec and resume shapes, each followed by --help", () => {
  const { run, calls } = healthyCli();
  const report = check(run);
  assert.deepEqual(report.failures, []);
  const helped = calls.filter((args) => args.at(-1) === "--help");
  assert.ok(helped.some((args) => args[0] === "exec" && args[1] !== "resume"));
  assert.ok(helped.some((args) => args[0] === "exec" && args[1] === "resume"));
  assert.ok(helped.length >= argvShapes("m", tmpdir()).length);
});

test("AC-2 fails a rejected shape and names the version, the argv and the CLI's error", () => {
  const { run } = healthyCli((args) =>
    args.includes("--add-dir")
      ? { status: 2, stdout: "", stderr: "error: unexpected argument '--add-dir' found\n\n  tip: ...\n" }
      : undefined,
  );
  const report = check(run, "0.160.0");
  assert.equal(report.failures.length > 0, true);
  const failure = report.failures.join("\n");
  assert.match(failure, /0\.160\.0/);
  assert.match(failure, /--add-dir/);
  assert.match(failure, /error: unexpected argument '--add-dir' found/);
});

test("AC-2 distrusts a CLI that no longer rejects the negative control", () => {
  const { run } = healthyCli((args) => (args.includes("--full-auto") ? ok() : undefined));
  const report = check(run);
  assert.ok(report.failures.some((failure) => failure.includes(NEGATIVE_CONTROL.join(" "))));
});

test("AC-3 fails an empty or unreadable catalog", () => {
  for (const output of [JSON.stringify({ models: [] }), "not json"]) {
    const { run } = healthyCli((args) => (args[0] === "debug" ? ok(output) : undefined));
    assert.ok(check(run).failures.some((failure) => /catalog/i.test(failure)), output);
  }
});

test("AC-4 fails an MCP listing that is not a JSON array", () => {
  const { run } = healthyCli((args) => (args[0] === "mcp" ? ok('{"servers":[]}') : undefined));
  assert.ok(check(run).failures.some((failure) => /mcp list/i.test(failure)));
});

test("AC-5 notes a CLI newer than the newest verified version without failing", () => {
  const { run } = healthyCli();
  const report = check(run, "0.159.2");
  assert.deepEqual(report.failures, []);
  assert.ok(report.notes.some((note) => note.includes("0.159.2") && /smoke-test/.test(note)));
  assert.ok(!check(run, "0.154.0").notes.some((note) => /smoke-test/.test(note)));
});

test("AC-6 refuses a batch shim or a script wrapper as the CLI", () => {
  for (const path of ["C:\\npm\\codex.cmd", "C:\\npm\\codex.bat", "/usr/lib/node_modules/@openai/codex/bin/codex.js"]) {
    assert.notEqual(shimProblem(path), null, path);
  }
  assert.equal(shimProblem("C:\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"), null);
  assert.equal(shimProblem("/tmp/codex/vendor/aarch64-apple-darwin/bin/codex"), null);
});

test("AC-6 finds the native binary of the platform package, not the npm wrapper", () => {
  const prefix = mkdtempSync(join(tmpdir(), "codex-compat-"));
  try {
    const wrapper = join(prefix, "node_modules", "@openai", "codex", "bin");
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, "codex.js"), "", "utf8");
    const native = join(prefix, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "codex.exe"), "", "utf8");

    assert.equal(findCodexBinary(prefix, "win32"), join(native, "codex.exe"));
    assert.equal(findCodexBinary(prefix, "linux"), null);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
