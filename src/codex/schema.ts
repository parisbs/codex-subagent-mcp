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

/** Validates a caller's `output_schema` and returns its serialised form. */
export function serialiseOutputSchema(_value: unknown): string {
  throw new Error("not implemented");
}

/** Writes a serialised schema into a new private directory under `parentDir`. */
export function writeSchemaFile(_json: string, _parentDir?: string): SchemaFile {
  throw new Error("not implemented");
}

/** Reads a schema turn's final message as its structured result. */
export function parseStructuredResult(_finalMessage: string, _truncated: boolean): StructuredResult {
  throw new Error("not implemented");
}
