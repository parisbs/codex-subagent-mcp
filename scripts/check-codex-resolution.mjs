#!/usr/bin/env node
/**
 * Checks that the preflight can find a Codex CLI that is on PATH.
 *
 * This exists for Windows. `child_process.spawn` without a shell resolves only
 *真 executables there, so a `codex.cmd` shim — which is exactly what
 * `npm install -g @openai/codex` produces on Windows — may not be found even
 * though `codex` works fine in a terminal. A user hitting that would be told
 * Codex is not installed while looking straight at a working install.
 *
 * Creates a fake Codex on PATH that answers `--version` and `login status`,
 * then asserts the preflight reports it as healthy.
 */
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "codex-shim-"));
const isWindows = process.platform === "win32";

if (isWindows) {
  // A .cmd shim, the shape npm creates for a global bin on Windows.
  writeFileSync(
    join(dir, "codex.cmd"),
    ["@echo off", 'if "%1"=="--version" echo codex-cli 0.154.0', 'if "%1"=="login" echo Logged in using ChatGPT', "exit /b 0"].join("\r\n"),
  );
} else {
  const shim = join(dir, "codex");
  writeFileSync(
    shim,
    ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; fi', 'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; fi', "exit 0"].join("\n"),
  );
  chmodSync(shim, 0o755);
}

process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
delete process.env.CODEX_BIN;

const { runDoctor } = await import("../build/codex/doctor.js");
const diagnosis = await runDoctor({ refresh: true });

console.log(`check-codex-resolution: platform=${process.platform} status=${diagnosis.status} version=${diagnosis.version}`);

if (diagnosis.status !== "ok") {
  console.error(
    `check-codex-resolution: a Codex CLI on PATH was reported as "${diagnosis.status}".\n` +
      (isWindows
        ? "On Windows, spawn without a shell does not resolve .cmd shims. The preflight and the runner " +
          "need to resolve the executable explicitly before spawning."
        : "Expected the shim to be detected."),
  );
  process.exit(1);
}

console.log("check-codex-resolution: the preflight found the CLI on PATH.");
