import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { StructuredResult } from "../types.js";

/** The largest serialised schema accepted, in UTF-8 bytes (#28, AC-8). */
export const OUTPUT_SCHEMA_LIMIT_BYTES = 65_536;

/** Every schema file lives in a directory whose name starts with this (#28, AC-7). */
export const SCHEMA_DIR_PREFIX = "codex-subagent-schema-";

/** A schema written for one run. */
export interface SchemaFile {
  /** Absolute path of the schema file, passed to `--output-schema`. */
  path: string;
  /** The private directory holding it. */
  directory: string;
  /** Removes the file and its directory. Idempotent; never throws. */
  remove: () => void;
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Validates a caller's `output_schema` and returns its serialised form.
 *
 * Deliberately minimal (#28, decision 3): an object, and a size cap measured in
 * UTF-8 bytes. Whether it is a schema OpenAI accepts is the API's to say — it
 * rejects a non-strict schema before generating anything — and re-implementing
 * its rules here would drift from them.
 */
export function serialiseOutputSchema(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`output_schema must be a JSON object; received ${describeKind(value)}.`);
  }
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > OUTPUT_SCHEMA_LIMIT_BYTES) {
    throw new Error(
      `output_schema is ${bytes.toLocaleString("en-US")} bytes once serialised; the limit is ` +
        `${OUTPUT_SCHEMA_LIMIT_BYTES.toLocaleString("en-US")} bytes (64 KiB).`,
    );
  }
  return json;
}

/**
 * Writes a serialised schema into a new private directory under `parentDir`.
 *
 * `mkdtemp` creates the directory with mode 0700 and the file is created
 * exclusively with mode 0600, so on POSIX only the current user can read it. On
 * Windows those modes are not enforced: the file inherits the permissions of the
 * user's temporary directory, and nothing here claims more (#28, AC-1).
 */
export function writeSchemaFile(json: string, parentDir: string = tmpdir()): SchemaFile {
  const directory = resolve(mkdtempSync(join(parentDir, SCHEMA_DIR_PREFIX)));
  const path = join(directory, "schema.json");
  try {
    writeFileSync(path, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    removeDirectory(directory);
    throw error;
  }

  let removed = false;
  return {
    path,
    directory,
    remove: () => {
      if (removed) return;
      removed = true;
      removeDirectory(directory);
    },
  };
}

/** Removes a schema directory, logging a failure instead of throwing it. */
function removeDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    // A failed removal must not replace the run's own outcome (#28, AC-7).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`codex-subagent: could not remove the output schema at ${directory}: ${message}`);
  }
}

/**
 * Reads a schema turn's final message as its structured result.
 *
 * Any JSON value counts: validating it against the schema is the API's job,
 * not this server's. The text is kept as Codex returned it, trimmed of the
 * whitespace JSON allows around it, so re-serialising cannot change a large number. A
 * run whose output was truncated is refused even when its last message parses:
 * the message Codex actually ended with may be the one that was dropped.
 */
export function parseStructuredResult(finalMessage: string, truncated: boolean): StructuredResult {
  if (truncated) {
    return {
      ok: false,
      error:
        "the structured result could not be confirmed intact: Codex's output was truncated, so the last " +
        "message kept may not be the one it ended with.",
    };
  }
  // Only JSON's own whitespace: `trim()` also strips a byte order mark and
  // other Unicode spaces, which would pass text `JSON.parse` rejects.
  const json = finalMessage.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  if (json.length === 0) {
    return { ok: false, error: "Codex returned no final message, so there is no structured result." };
  }
  try {
    JSON.parse(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Codex's final message is not valid JSON (${reason}).` };
  }
  return { ok: true, json };
}
