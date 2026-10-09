import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** Keep running after the last chunk until terminated, instead of exiting. */
  stayRunning?: boolean;
  /** Ignore SIGTERM and SIGINT, so only SIGKILL ends the stand-in. POSIX only. */
  ignoreSigterm?: boolean;
  /** On SIGINT or SIGTERM, write these chunks and exit with this code. POSIX only. */
  onStop?: { chunks?: string[]; exitCode?: number };
  /** A descendant started before any output; its pid is readable through `descendantPid`. */
  descendant?: {
    holdMs: number;
    /** Inherit the CLI's stdout and stderr, so they stay open while it lives. */
    holdPipes?: boolean;
    /** Ignore SIGTERM and SIGINT. Meaningful on POSIX only. */
    ignoreSigterm?: boolean;
    /** Start it as the leader of its own process group, as the real CLI does with commands. */
    ownGroup?: boolean;
  };
  /** Append each SIGINT or SIGTERM received to `signals.log`, then exit. */
  recordSignals?: boolean;
}

export interface FakeCodex {
  /** Pass as `codexPath`: Node is a real executable on every platform. */
  codexPath: string;
  /** Pass as `invocation.workingDir`: it becomes the child's cwd. */
  workingDir: string;
  /** What the child actually received. Only valid after the run finishes. */
  received: () => { argv: string[]; stdin: string; schema: string | null };
  /** The pid of `scenario.descendant`, once the stand-in has started it. */
  descendantPid: () => number | null;
  /** Signals the stand-in recorded with `recordSignals`, in order. */
  signals: () => string[];
  /** Replaces the scenario for the next run in the same directory. */
  setScenario: (next: Scenario) => void;
  dispose: () => void;
}

export interface FakeCodexOptions {
  /**
   * The subcommand the argv starts with, and so the name the stand-in is copied
   * under: `exec` for delegations, `doctor` for `codex doctor --json` (#69).
   */
  command?: "exec" | "doctor";
}

/**
 * Prepares a throwaway Codex stand-in that runs on Linux, macOS and Windows.
 *
 * The argv the server builds always begins with `exec` (or `doctor`, for the
 * extended diagnosis), so pointing the runner at Node with this directory as cwd
 * makes Node treat the copied file of that name as its entry point. No shebang,
 * no `.cmd` shim, no shell — which is what lets the same test cover all three
 * platforms.
 */
export function createFakeCodex(scenario: Scenario, options: FakeCodexOptions = {}): FakeCodex {
  const workingDir = mkdtempSync(join(tmpdir(), "codex-subagent-fake-"));

  copyFileSync(FAKE_SOURCE, join(workingDir, options.command ?? "exec"));
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
        schema: string | null;
      },
    descendantPid: () => {
      const file = join(workingDir, "descendant.pid");
      return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
    },
    signals: () => {
      const file = join(workingDir, "signals.log");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    },
    setScenario: (next) => writeFileSync(join(workingDir, "scenario.json"), JSON.stringify(next), "utf8"),
    dispose: () => rmSync(workingDir, { recursive: true, force: true }),
  };
}

/** Serialises events as the JSONL stream `codex exec --json` produces. */
export function jsonl(...events: unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
