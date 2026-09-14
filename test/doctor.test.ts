import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VERIFIED_CODEX_VERSION,
  classifyLoginFailure,
  compareVersions,
  classifyLoginFailure,
  diagnose,
  formatDiagnosis,
  installationSteps,
  executableFor,
  isUsable,
  parseVersion,
} from "../src/codex/doctor.ts";

const OK_DIAGNOSIS = {
  status: "ok" as const,
  codexPath: "codex",
  version: "0.154.0",
  authenticated: true,
  summary: "",
  remediation: [],
};

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

test("reports a Windows batch shim as unusable, not as missing", () => {
  // `npm install -g @openai/codex` produces codex.cmd on Windows. spawn cannot
  // run it without a shell, and this server never uses one — so saying
  // "not installed" would be wrong and would send the user nowhere useful.
  const diagnosis = diagnose({
    codexPath: "codex",
    version: null,
    authenticated: null,
    platform: "win32",
    shimPath: "C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd",
  });
  assert.equal(diagnosis.status, "unsupported-shim");
  assert.equal(isUsable(diagnosis), false);
  assert.match(diagnosis.summary, /codex\.cmd/);
  assert.match(diagnosis.remediation.join("\n"), /install\.ps1/);
  assert.match(diagnosis.remediation.join("\n"), /CODEX_BIN/);
});

test("prefers the shim diagnosis over every other state", () => {
  // The shim cannot be run, so version and sign-in are moot.
  const diagnosis = diagnose({
    codexPath: "codex",
    version: "0.100.0",
    authenticated: false,
    platform: "win32",
    shimPath: "C:\\npm\\codex.cmd",
  });
  assert.equal(diagnosis.status, "unsupported-shim");
});

test("exposes the resolved path for spawning when one is known", () => {
  assert.equal(executableFor({ ...OK_DIAGNOSIS, resolvedPath: "/usr/local/bin/codex" }), "/usr/local/bin/codex");
  assert.equal(executableFor(OK_DIAGNOSIS), "codex");
});

// Verbatim stderr from `codex login status` on codex-cli 0.154.0 with a broken scratch config.
const CONFIG_STDERR =
  "Error loading configuration: /tmp/home/config.toml:1:9: string values must be quoted, expected literal string\n";

test("reads a config that cannot load as a config error, not as signed out", () => {
  // login status exits 1 both when signed out and when the config is broken.
  const probe = classifyLoginFailure(Object.assign(new Error("Command failed"), { stderr: CONFIG_STDERR, code: 1 }));
  assert.equal(probe.authenticated, null);
  assert.match("configError" in probe ? (probe.configError ?? "") : "", /string values must be quoted/);

  const legacyProfile = classifyLoginFailure({
    stderr: 'Error loading configuration: legacy `profile = "x"` config is no longer supported',
  });
  assert.ok("configError" in legacyProfile && legacyProfile.configError);
});

test("reads a plain failed login probe as signed out and a timed-out one as unknown", () => {
  assert.deepEqual(classifyLoginFailure({ stderr: "Not logged in\n", code: 1 }), { authenticated: false });
  assert.deepEqual(classifyLoginFailure({ stderr: "", killed: true, signal: "SIGTERM" }), { authenticated: null });
  assert.deepEqual(classifyLoginFailure("not an error object"), { authenticated: false });
});

test("reports a config error with Codex's message and no sign-in steps", () => {
  const diagnosis = diagnose({
    codexPath: "codex",
    version: VERIFIED_CODEX_VERSION,
    authenticated: null,
    configError: CONFIG_STDERR.trim(),
  });
  assert.equal(diagnosis.status, "config-error");
  assert.equal(isUsable(diagnosis), false);
  const text = formatDiagnosis(diagnosis);
  assert.match(text, /string values must be quoted/);
  assert.match(text, /not a sign-in problem/);
  assert.doesNotMatch(text, /Sign in by running/);
});

test("treats a sign-in probe that timed out as unknown but usable", () => {
  const diagnosis = diagnose({ codexPath: "codex", version: VERIFIED_CODEX_VERSION, authenticated: null });
  assert.equal(diagnosis.status, "unknown");
  assert.equal(isUsable(diagnosis), true);
  assert.match(diagnosis.remediation.join("\n"), /codex login status/);
});

test("still reports a missing CLI before a config error", () => {
  const diagnosis = diagnose({ codexPath: "codex", version: null, authenticated: null, configError: "Error loading configuration: x" });
  assert.equal(diagnosis.status, "missing");
});
