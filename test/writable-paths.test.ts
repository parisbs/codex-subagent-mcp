import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWritablePaths } from "../src/server.ts";

for (const path of ['/workspace/"quoted"', '/workspace/"quoted"/../safe', '/workspace/trailing"']) {
  test(`AC-1 AC-2 (#207) refuses the literal double quote in ${JSON.stringify(path)} on macOS`, () => {
    assert.throws(
      () => validateWritablePaths("workspace-write", ["/safe", path], "darwin"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path), error.message);
        assert.match(error.message, /macOS/i);
        assert.match(error.message, /workspace-write/i);
        assert.match(error.message, /double quote/i);
        assert.match(error.message, /seatbelt|sandbox-exec|sandbox profile/i);
        return true;
      },
    );
  });
}

test("AC-3 (#207) accepts double quotes in every read-only path on macOS", () => {
  assert.doesNotThrow(() => validateWritablePaths("read-only", ['/cwd/"quoted"', '/root/"quoted"'], "darwin"));
});

for (const platform of ["linux", "win32", "freebsd"] as const) {
  test(`AC-4 (#207) accepts double quotes in workspace-write paths on ${platform}`, () => {
    assert.doesNotThrow(() => validateWritablePaths("workspace-write", ['/cwd/"quoted"', '/root/"quoted"'], platform));
  });
}

for (const character of ["\\", " ", "'", "é", "\t", "\n"]) {
  test(`AC-1 AC-2 (#207) accepts ${JSON.stringify(character)} without a double quote on macOS`, () => {
    assert.doesNotThrow(() => validateWritablePaths("workspace-write", [`/cwd/a${character}b`, `/root/a${character}b`], "darwin"));
  });
}

test("AC-1 AC-2 (#207) accepts an empty writable-path list on macOS", () => {
  assert.doesNotThrow(() => validateWritablePaths("workspace-write", [], "darwin"));
});

test("AC-1 AC-2 (#207) leaves danger-full-access outside the workspace-write refusal", () => {
  assert.doesNotThrow(() => validateWritablePaths("danger-full-access", ['/cwd/"quoted"'], "darwin"));
});
