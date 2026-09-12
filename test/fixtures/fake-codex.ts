import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_SOURCE = fileURLToPath(new URL("./fake-codex.cjs", import.meta.url));

export interface Scenario {
  /** Written to stdout in order, verbatim. Split a JSON line across entries to
   * exercise the incremental parser. */
  chunks?: string[];
  chunkDelayMs?: number;
  stderr?: string;
  exitCode?: number;
  /** A descendant keeps stdout and stderr open after the CLI exits. */
  descendantHoldMs?: number;
}

export interface FakeCodex {
  /** Pass as `codexPath`: Node is a real executable on every platform. */
  codexPath: string;
  /** Pass as `invocation.workingDir`: it becomes the child's cwd. */
  workingDir: string;
  /** What the child actually received. Only valid after the run finishes. */
  received: () => { argv: string[]; stdin: string };
  dispose: () => void;
}

/**
 * Prepares a throwaway Codex stand-in that runs on Linux, macOS and Windows.
 *
 * The argv the server builds always begins with `exec`, so pointing the runner
 * at Node with this directory as cwd makes Node treat the copied `exec` file as
 * its entry point. No shebang, no `.cmd` shim, no shell — which is what lets the
 * same test cover all three platforms.
 */
export function createFakeCodex(scenario: Scenario): FakeCodex {
  const workingDir = mkdtempSync(join(tmpdir(), "codex-subagent-fake-"));

  copyFileSync(FAKE_SOURCE, join(workingDir, "exec"));
  // An extensionless file is CommonJS unless an ancestor package.json says
  // otherwise. Pinning it here keeps the fixture independent of where the OS
  // puts its temporary directories.
  writeFileSync(join(workingDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  writeFileSync(join(workingDir, "scenario.json"), JSON.stringify(scenario), "utf8");

  return {
    codexPath: process.execPath,
    workingDir,
    received: () =>
      JSON.parse(readFileSync(join(workingDir, "received.json"), "utf8")) as {
        argv: string[];
        stdin: string;
      },
    dispose: () => rmSync(workingDir, { recursive: true, force: true }),
  };
}

/** Serialises events as the JSONL stream `codex exec --json` produces. */
export function jsonl(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
