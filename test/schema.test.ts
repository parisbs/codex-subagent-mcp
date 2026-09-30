import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";

import {
  OUTPUT_SCHEMA_LIMIT_BYTES,
  SCHEMA_DIR_PREFIX,
  parseStructuredResult,
  serialiseOutputSchema,
  writeSchemaFile,
} from "../src/codex/schema.ts";

/** Output schemas (#28): validation, the private file, and reading the final message. */

const POSIX = process.platform !== "win32";

/** An object whose serialised JSON is exactly `bytes` long, padded with `filler`. */
function schemaOfBytes(bytes: number, filler = "a"): Record<string, unknown> {
  const empty = JSON.stringify({ type: "object", description: "" });
  const fillerBytes = Buffer.byteLength(filler, "utf8");
  const room = bytes - Buffer.byteLength(empty, "utf8");
  const description = filler.repeat(Math.floor(room / fillerBytes)) + "a".repeat(room % fillerBytes);
  const schema = { type: "object", description };
  assert.equal(Buffer.byteLength(JSON.stringify(schema), "utf8"), bytes);
  return schema;
}

test("AC-8 serialises a JSON object schema", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };
  assert.deepEqual(JSON.parse(serialiseOutputSchema(schema)), schema);
});

test("AC-8 refuses a schema that is not a JSON object", () => {
  for (const value of [[], ["type"], "object", 42, true, null, undefined]) {
    assert.throws(() => serialiseOutputSchema(value), /output_schema/, String(value));
  }
});

test("AC-8 accepts exactly 65,536 bytes and refuses one more", () => {
  assert.equal(OUTPUT_SCHEMA_LIMIT_BYTES, 65_536);
  assert.doesNotThrow(() => serialiseOutputSchema(schemaOfBytes(65_536)));
  assert.throws(() => serialiseOutputSchema(schemaOfBytes(65_537)), /65,?536|64 KiB/);
});

test("AC-8 counts multibyte characters by their UTF-8 size", () => {
  // 40,000 characters of "é" are 80,000 bytes: over the limit though under it in characters.
  const schema = { type: "object", description: "é".repeat(40_000) };
  assert.ok(JSON.stringify(schema).length < OUTPUT_SCHEMA_LIMIT_BYTES);
  assert.throws(() => serialiseOutputSchema(schema), /65,?536|64 KiB/);
});

function withParent(body: (parent: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), "schema-parent-"));
  try {
    body(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test("AC-1 writes exactly the serialised schema to an absolute path in a prefixed private directory", () => {
  withParent((parent) => {
    const json = '{"type":"object","additionalProperties":false}';
    const file = writeSchemaFile(json, parent);
    assert.ok(isAbsolute(file.path));
    assert.equal(readFileSync(file.path, "utf8"), json);
    assert.equal(dirname(file.path), file.directory);
    assert.equal(dirname(file.directory), parent);
    assert.ok(basename(file.directory).startsWith(SCHEMA_DIR_PREFIX));
    file.remove();
  });
});

test("AC-1 makes the file readable only by the current user on POSIX", { skip: POSIX ? false : "mode bits do not apply on Windows" }, () => {
  withParent((parent) => {
    const file = writeSchemaFile("{}", parent);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    assert.equal(statSync(file.directory).mode & 0o777, 0o700);
    file.remove();
  });
});

test("AC-7 removes the file and its directory, idempotently and without throwing", () => {
  withParent((parent) => {
    const file = writeSchemaFile("{}", parent);
    file.remove();
    assert.equal(existsSync(file.path), false);
    assert.equal(existsSync(file.directory), false);
    assert.doesNotThrow(() => file.remove());
  });
});

test("AC-7 fails to write into a parent directory that does not exist", () => {
  assert.throws(
    () => writeSchemaFile("{}", join(tmpdir(), "no-such-parent-for-schema-tests", "deeper")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("AC-2 accepts JSON of any type and keeps the text verbatim", () => {
  for (const text of ['{"a":1}', "[1,2]", '"text"', "42", "true", "null", '{"big":12345678901234567890}']) {
    assert.deepEqual(parseStructuredResult(text, false), { ok: true, json: text }, text);
  }
});

test("AC-2 ignores surrounding whitespace but keeps the document as returned", () => {
  assert.deepEqual(parseStructuredResult('\n  {"a":1}\n', false), { ok: true, json: '{"a":1}' });
});

test("AC-3 reports an empty, blank or non-JSON final message as invalid", () => {
  for (const text of ["", "   \n", "Here you go: {\"a\":1}", "{\"a\":", "```json\n{}\n```"]) {
    const result = parseStructuredResult(text, false);
    assert.equal(result.ok, false, text);
  }
});

test("AC-5 refuses a final message that may not be intact, even when it parses", () => {
  const result = parseStructuredResult('{"a":1}', true);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /intact/);
});
