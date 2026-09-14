#!/usr/bin/env node
/**
 * Runs the test suite.
 *
 * This exists because `npm test` cannot portably rely on a glob. On Linux and
 * macOS the shell expands `test/*.test.ts` before Node sees it; on Windows npm
 * runs scripts through cmd.exe, which does not expand globs at all. Node's own
 * `--test` expands patterns since Node 22, now the floor, but did not on Node
 * 20, where the run failed with "Could not find 'test\\*.test.ts'".
 *
 * Resolving the files here works everywhere and depends on neither the shell
 * nor a particular Node version's glob support.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const TEST_DIR = "test";

const files = readdirSync(TEST_DIR)
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => join(TEST_DIR, entry));

// A suite that silently runs nothing is worse than one that fails: it reports
// success without having checked anything.
if (files.length === 0) {
  console.error(`run-tests: no *.test.ts files found in ${TEST_DIR}/`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`run-tests: could not start the test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
