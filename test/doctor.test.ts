import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VERIFIED_CODEX_VERSION,
  compareVersions,
  diagnose,
  formatDiagnosis,
  installationSteps,
  isUsable,
  parseVersion,
} from "../src/codex/doctor.ts";

test("parses the version out of the CLI banner", () => {
  // Verbatim output of `codex --version` on codex-cli 0.154.0.
  assert.equal(parseVersion("codex-cli 0.154.0"), "0.154.0");
  assert.equal(parseVersion("codex-cli 0.154.0\n"), "0.154.0");
  assert.equal(parseVersion("no version here"), null);
});

test("compares dotted versions numerically, not lexically", () => {
  assert.equal(compareVersions("0.154.0", "0.154.0"), 0);
  assert.equal(compareVersions("0.155.0", "0.154.0"), 1);
  assert.equal(compareVersions("0.99.0", "0.154.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.154.0"), 1);
  assert.equal(compareVersions("0.154", "0.154.0"), 0);
});

test("reports a missing CLI with installation steps", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: null,
    authenticated: null,
    platform: "darwin",
  });
  assert.equal(diagnosis.status, "missing");
  assert.equal(isUsable(diagnosis), false);
  assert.match(diagnosis.remediation.join("\n"), /install\.sh/);
  assert.match(diagnosis.remediation.join("\n"), /CODEX_BIN/);
});

test("gives platform-specific installation steps", () => {
  assert.match(installationSteps("win32").join("\n"), /install\.ps1/);
  assert.match(installationSteps("darwin").join("\n"), /brew install --cask codex/);
  assert.ok(!installationSteps("linux").join("\n").includes("brew"));
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.match(installationSteps(platform).join("\n"), /@openai\/codex/);
  }
});

test("recommends Homebrew first on macOS", () => {
  // Homebrew installs a self-contained binary; the npm package is a Node
  // wrapper around it, which adds startup cost and ties the install to the
  // active Node version.
  assert.match(installationSteps("darwin")[0] ?? "", /brew install --cask codex/);
});

test("lists npm last on every platform, with its caveat", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const steps = installationSteps(platform);
    assert.match(steps.at(-1) ?? "", /npm install -g @openai\/codex/);
    assert.match(steps.at(-1) ?? "", /tied to the active Node version/);
  }
});

test("never proposes running the installer itself", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: null,
    authenticated: null,
    platform: "linux",
  });
  // Remediation is instructions for the user, never something this server runs.
  assert.match(formatDiagnosis(diagnosis), /Install the Codex CLI/);
});

test("reports an installed but signed-out CLI as unusable", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: VERIFIED_CODEX_VERSION,
    authenticated: false,
  });
  assert.equal(diagnosis.status, "unauthenticated");
  assert.equal(isUsable(diagnosis), false);
  assert.match(diagnosis.remediation.join("\n"), /codex login status/);
});

test("treats an older version as usable but warns", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: "0.100.0",
    authenticated: true,
  });
  assert.equal(diagnosis.status, "unverified-version");
  // Older is unverified, not known-broken: the run may work, and the CLI's own
  // error is more informative than refusing up front.
  assert.equal(isUsable(diagnosis), true);
  assert.match(diagnosis.summary, /0\.100\.0/);
  assert.match(diagnosis.remediation.join("\n"), /codex update/);
});

test("reports a healthy installation", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: "0.200.0",
    authenticated: true,
  });
  assert.equal(diagnosis.status, "ok");
  assert.equal(isUsable(diagnosis), true);
  assert.deepEqual(diagnosis.remediation, []);
});

test("checks the missing CLI before the sign-in state", () => {
  // A CLI that is not installed cannot report a login status; saying "not
  // signed in" would send the user down the wrong path.
  const diagnosis = diagnose({
    codexPath: "codex",
    version: null,
    authenticated: false,
  });
  assert.equal(diagnosis.status, "missing");
});

test("names the configured binary in the failure message", () => {
  const diagnosis = diagnose({
    codexPath: "/opt/custom/codex",
    version: null,
    authenticated: null,
  });
  assert.match(diagnosis.summary, /\/opt\/custom\/codex/);
});
