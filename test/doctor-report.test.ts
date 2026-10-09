import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";

import { diagnose, type Diagnosis } from "../src/codex/doctor.ts";
import {
  DOCTOR_REPORT_ARGS,
  DOCTOR_REPORT_TIMEOUT_MS,
  DOCTOR_STDERR_LIMIT_BYTES,
  DOCTOR_STDOUT_LIMIT_BYTES,
  SECTION_LIMIT,
  SUMMARY_STRING_LIMIT,
  SUMMARY_WARNING_LIMIT,
  canRunDoctorReport,
  classifyDoctorRun,
  formatExtendedDiagnosis,
  runDoctorReport,
  summariseConfigLoad,
  type DoctorReportHandle,
  type DoctorReportOptions,
  type DoctorRunOutcome,
  type ExtendedDiagnosis,
} from "../src/codex/doctor-report.ts";
import type { CancelOptions } from "../src/codex/runner.ts";
import { ActiveRuns } from "../src/runs.ts";
import { createShutdown } from "../src/shutdown.ts";

import { createFakeCodex, type Scenario } from "./fixtures/fake-codex.ts";
import { isAlive } from "./fixtures/process-alive.ts";

/**
 * The extended diagnosis of `codex_doctor` (#69): classification, summary and
 * presentation of `codex doctor --json` as pure functions, and the process
 * lifecycle against the Node stand-in, which runs on every platform.
 *
 * The fixtures under `test/fixtures/doctor-report-0.162.0-*.json` were captured
 * from codex-cli 0.162.0 on macOS on 2026-10-09. Only `config.load` and two other
 * checks were kept, and home directories were replaced with `/Users/example`;
 * everything else is the CLI's output as printed.
 */

type Report = { schemaVersion: unknown; checks: Record<string, Record<string, unknown>> } & Record<string, unknown>;

const CONTEXT = { directory: "/Users/example/sentinel-directory" };

function fixture(name: "healthy" | "warning" | "syntax" | "semantic"): Report {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/doctor-report-0.162.0-${name}.json`, import.meta.url), "utf8"),
  ) as Report;
}

function configLoad(report: Report): Record<string, unknown> {
  return report.checks["config.load"]!;
}

/** A finished run with nothing unusual about it. */
function outcome(overrides: Partial<DoctorRunOutcome>): DoctorRunOutcome {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, stopped: null, ...overrides };
}

function summaryOf(diagnosis: ExtendedDiagnosis) {
  assert.equal(diagnosis.kind, "summary", `expected a summary, got ${JSON.stringify(diagnosis)}`);
  return (diagnosis as Extract<ExtendedDiagnosis, { kind: "summary" }>).summary;
}

function withConfigLoad(check: unknown): string {
  const report = fixture("healthy");
  report.checks["config.load"] = check as Record<string, unknown>;
  return JSON.stringify(report);
}

/** The section for a finished run, as `codex_doctor` would show it. */
function shown(run: Partial<DoctorRunOutcome>): string {
  return formatExtendedDiagnosis(classifyDoctorRun(outcome(run)), CONTEXT);
}

function diagnosisWith(status: Diagnosis["status"]): Diagnosis {
  const base = diagnose({ codexPath: "codex", version: "0.160.0", authenticated: true });
  return { ...base, status };
}

/** A report whose configured model is a sentinel, to prove a diagnosis summarised nothing. */
const MODEL_SENTINEL = "sentinel-model-never-shown";
function reportWithSentinelModel(): Report {
  const report = fixture("healthy");
  (configLoad(report).details as Record<string, unknown>).model = MODEL_SENTINEL;
  return report;
}

// ---------------------------------------------------------------------------
// The published bounds and argv

test("AC-5 AC-6 AC-8 AC-13 pins the published deadline, bounds and argv", () => {
  assert.equal(DOCTOR_REPORT_TIMEOUT_MS, 60_000);
  assert.equal(DOCTOR_STDOUT_LIMIT_BYTES, 1_048_576);
  assert.equal(DOCTOR_STDERR_LIMIT_BYTES, 65_536);
  assert.equal(SUMMARY_STRING_LIMIT, 2_000);
  assert.equal(SUMMARY_WARNING_LIMIT, 10);
  assert.equal(SECTION_LIMIT, 16_384);
  assert.deepEqual([...DOCTOR_REPORT_ARGS], ["doctor", "--json"]);
});

// ---------------------------------------------------------------------------
// AC-2, AC-4: the gate

test("AC-2 runs the extended diagnosis for every status that found a runnable CLI", () => {
  for (const status of ["ok", "unauthenticated", "config-error", "unverified-version", "unknown"] as const) {
    assert.equal(canRunDoctorReport(diagnosisWith(status)), true, status);
  }
});

test("AC-4 skips the extended diagnosis for missing or a shim, and for a null version, independently", () => {
  for (const status of ["missing", "unsupported-shim"] as const) {
    assert.equal(canRunDoctorReport(diagnosisWith(status)), false, `${status} with a version`);
  }
  for (const status of ["ok", "unauthenticated", "config-error", "unverified-version", "unknown"] as const) {
    assert.equal(canRunDoctorReport({ ...diagnosisWith(status), version: null }), false, `${status} without a version`);
  }
  assert.equal(canRunDoctorReport(diagnose({ codexPath: "codex", version: null, authenticated: null })), false);
  assert.equal(
    canRunDoctorReport(
      diagnose({ codexPath: "codex", version: null, authenticated: null, shimPath: "C:\\npm\\codex.cmd" }),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// AC-2: the summary of a real report

test("AC-2 summarises config.load from a report captured from codex-cli 0.162.0", () => {
  const summary = summaryOf(classifyDoctorRun(outcome({ stdout: JSON.stringify(fixture("warning")), exitCode: 1 })));
  assert.deepEqual(summary.status, { kind: "known", value: "warning" });
  assert.equal(summary.summary, "config loaded");
  assert.equal(summary.model, "sentinel-configured-model");
  assert.equal(summary.modelProvider, "openai");
  assert.equal(summary.configurationScope, "invocation config, including cloud-managed policy");
  assert.equal(summary.featureFlagsEnabled, "57");
  assert.equal(summary.featureFlagOverrides, "none");
  assert.match(summary.enabledFeatureFlags ?? "", /^daemon_auto_start, /);
  assert.equal(summary.configTomlParse, "ok");
  assert.equal(summary.startupWarningCount, "1");
  assert.equal(summary.startupWarnings?.length, 1);
  assert.match(summary.startupWarnings![0]!, /^Ignored unsupported project-local config keys/);
  assert.equal(summary.remediation, undefined, "a null remediation is not a string");
});

test("AC-2 heads the section with the directory and says it is Codex's own config.load check only", () => {
  const text = shown({ stdout: JSON.stringify(fixture("healthy")) });
  const header = text.split("\n")[0]!;
  assert.ok(header.includes(CONTEXT.directory), "the header names the directory");
  assert.match(header, /Codex/);
  assert.match(header, /config\.load/);
  assert.match(text, /other doctor checks are not summari[sz]ed/i);
  assert.ok(text.includes('configured model: "<default>"'));
  assert.ok(text.includes('model provider: "openai"'));
  assert.ok(text.includes('status: "ok"'));
});

test("AC-2 AC-3 shows every whitelisted field as a labelled, quoted value", () => {
  const check = configLoad(fixture("warning"));
  check.summary = "sentinel-summary";
  check.remediation = "sentinel-remediation";
  Object.assign(check.details as Record<string, unknown>, {
    "configuration scope": "sentinel-scope",
    model: "sentinel-model",
    "model provider": "sentinel-provider",
    "feature flags enabled": "7",
    "enabled feature flags": "sentinel-flag-a, sentinel-flag-b",
    "feature flag overrides": "sentinel-override=true",
    "startup warnings": "1",
    "startup warning": "sentinel-warning",
    error: "sentinel-error",
    line: "12",
    column: "34",
    "config.toml parse": "ok",
  });
  const text = shown({ stdout: withConfigLoad(check) });
  for (const line of [
    'status: "warning"',
    'summary: "sentinel-summary"',
    'remediation: "sentinel-remediation"',
    'configuration scope: "sentinel-scope"',
    'configured model: "sentinel-model"',
    'model provider: "sentinel-provider"',
    'feature flags enabled: "7"',
    'enabled feature flags: "sentinel-flag-a, sentinel-flag-b"',
    'feature flag overrides: "sentinel-override=true"',
    'startup warnings: "1"',
    'startup warning: "sentinel-warning"',
    'error: "sentinel-error"',
    'line: "12"',
    'column: "34"',
    "config.toml parse: ok",
  ]) {
    assert.ok(text.includes(line), `missing ${line}`);
  }
});

// ---------------------------------------------------------------------------
// AC-3: nothing outside the whitelist

test("AC-3 shows no value from a non-whitelisted detail, issues, notes or another check", () => {
  const report = fixture("warning");
  const check = configLoad(report);
  const details = check.details as Record<string, unknown>;
  const sentinels = {
    CODEX_HOME: "/sentinel/codex-home",
    "config.toml": "/sentinel/config-toml",
    cwd: "/sentinel/cwd",
    "log dir": "/sentinel/log-dir",
    "sqlite home": "/sentinel/sqlite-home",
    file: "/sentinel/file",
    "configuration load ms": "sentinel-load-ms",
    "configured TUI mode": "sentinel-tui-mode",
    "mcp servers": "sentinel-mcp-servers",
    "active thread overrides": "sentinel-thread-overrides",
    "startup warning MCP": "sentinel-category-count",
    "an unknown future key": "sentinel-unknown-key",
  };
  Object.assign(details, sentinels);
  check.issues = [{ severity: "fail", cause: "sentinel-issue-cause", measured: null, expected: null, remedy: null, fields: [] }];
  check.notes = ["sentinel-note"];
  report.checks["terminal.env"]!.summary = "sentinel-other-check";
  const text = formatExtendedDiagnosis(classifyDoctorRun(outcome({ stdout: JSON.stringify(report) })), CONTEXT);
  for (const value of [...Object.values(sentinels), "sentinel-issue-cause", "sentinel-note", "sentinel-other-check"]) {
    assert.ok(!text.includes(value), `${value} leaked into the extended section`);
  }
  const labels = new Set(text.split("\n").map((line) => line.split(": ")[0]));
  for (const key of Object.keys(sentinels)) {
    assert.ok(!labels.has(key), `the label ${key} appears`);
  }
  assert.ok(text.includes('configured model: "sentinel-configured-model"'), "the whitelisted fields are still shown");
});

test("AC-3 omits a whitelisted field of the wrong type and still shows the others", () => {
  const check = configLoad(fixture("healthy"));
  const details = check.details as Record<string, unknown>;
  details.model = 42;
  details["model provider"] = null;
  details["configuration scope"] = { nested: "sentinel-nested" };
  details["startup warning"] = ["a text", 3];
  details["startup warnings"] = 1;
  details["config.toml parse"] = false;
  details.line = 2;
  details.column = "ten";
  check.summary = ["sentinel-array-summary"];
  check.remediation = 5;
  const summary = summariseConfigLoad(check);
  assert.ok(summary);
  assert.equal(summary.model, undefined);
  assert.equal(summary.modelProvider, undefined);
  assert.equal(summary.configurationScope, undefined);
  assert.equal(summary.startupWarnings, undefined, "a mixed array is omitted, not coerced");
  assert.equal(summary.startupWarningCount, undefined, "a JSON number is not the CLI's decimal string");
  assert.equal(summary.configTomlParse, undefined);
  assert.equal(summary.line, undefined, "a JSON number is not a decimal string");
  assert.equal(summary.column, undefined, "a non-decimal string is omitted");
  assert.equal(summary.summary, undefined);
  assert.equal(summary.remediation, undefined);
  const text = shown({ stdout: withConfigLoad(check) });
  assert.ok(!text.includes("sentinel-nested"));
  assert.ok(!text.includes("sentinel-array-summary"));
  assert.ok(text.includes(`feature flags enabled: ${JSON.stringify(details["feature flags enabled"])}`), "the others are shown");
  assert.ok(text.includes('status: "ok"'));
});

test("AC-3 keeps status and summary when details is not an object", () => {
  for (const details of ["sentinel-details-string", null, ["sentinel-details-array"]]) {
    const check = { ...configLoad(fixture("healthy")), details };
    const summary = summariseConfigLoad(check);
    assert.ok(summary, JSON.stringify(details));
    assert.deepEqual(summary.status, { kind: "known", value: "ok" });
    assert.equal(summary.model, undefined);
    const text = shown({ stdout: withConfigLoad(check) });
    assert.ok(!text.includes("sentinel-details"), JSON.stringify(details));
    assert.ok(text.includes('summary: "config loaded"'));
  }
});

test("AC-3 reduces config.toml parse to error and shows it without its message", () => {
  const check = configLoad(fixture("healthy"));
  (check.details as Record<string, unknown>)["config.toml parse"] =
    "TOML parse error at line 1, column 9\n  |\n1 | token = sentinel-secret-line\n  |         ^\ninvalid string";
  assert.equal(summariseConfigLoad(check)?.configTomlParse, "error");
  const text = shown({ stdout: withConfigLoad(check) });
  assert.ok(text.includes("config.toml parse: error"));
  assert.ok(!text.includes("sentinel-secret-line"));
  assert.ok(!text.includes("TOML parse error"));
});

test("AC-3 leaves config.toml parse out when the report has none", () => {
  const check = configLoad(fixture("healthy"));
  delete (check.details as Record<string, unknown>)["config.toml parse"];
  assert.equal(summariseConfigLoad(check)?.configTomlParse, undefined);
  assert.ok(!shown({ stdout: withConfigLoad(check) }).includes("config.toml parse:"));
});

test("AC-3 shows an unknown or missing status as such, never as healthy", () => {
  const unknown = { ...configLoad(fixture("healthy")), status: "sentinel-degraded" };
  assert.deepEqual(summariseConfigLoad(unknown)?.status, { kind: "unrecognised", value: "sentinel-degraded" });
  assert.ok(shown({ stdout: withConfigLoad(unknown) }).includes('status: unrecognised "sentinel-degraded"'));
  const missing = { ...configLoad(fixture("healthy")) };
  delete missing.status;
  assert.deepEqual(summariseConfigLoad(missing)?.status, { kind: "unavailable" });
  assert.ok(shown({ stdout: withConfigLoad(missing) }).includes("status: unavailable"));
  const wrongType = { ...configLoad(fixture("healthy")), status: 7 };
  assert.deepEqual(summariseConfigLoad(wrongType)?.status, { kind: "unavailable" });
  assert.ok(!shown({ stdout: withConfigLoad(wrongType) }).includes('status: "ok"'));
});

// ---------------------------------------------------------------------------
// AC-6: classification

test("AC-6 reports a run that was stopped before it finished, whatever it printed", () => {
  const report = JSON.stringify(reportWithSentinelModel());
  for (const stopped of ["cancelled", "timed-out", "stdout-too-large"] as const) {
    const result = classifyDoctorRun(outcome({ stdout: report, exitCode: null, signal: "SIGINT", stopped }));
    assert.equal(result.kind, "stopped", stopped);
    assert.equal((result as Extract<ExtendedDiagnosis, { kind: "stopped" }>).reason, stopped);
    assert.ok(!formatExtendedDiagnosis(result, CONTEXT).includes(MODEL_SENTINEL), stopped);
  }
  const spawn = classifyDoctorRun(
    outcome({ exitCode: null, stopped: "spawn-failed", spawnError: "spawn /nowhere/codex ENOENT" }),
  );
  assert.deepEqual(spawn, { kind: "stopped", reason: "spawn-failed", detail: "spawn /nowhere/codex ENOENT" });
});

test("AC-6 a signal it was not sent wins over a usable report", () => {
  const result = classifyDoctorRun(
    outcome({ stdout: JSON.stringify(reportWithSentinelModel()), exitCode: null, signal: "SIGKILL" }),
  );
  assert.deepEqual(result, { kind: "stopped", reason: "signal", detail: "SIGKILL" });
  assert.ok(!formatExtendedDiagnosis(result, CONTEXT).includes(MODEL_SENTINEL));
});

test("AC-6 summarises a usable report whatever the exit code and stderr", () => {
  for (const exitCode of [0, 1, 2]) {
    const result = classifyDoctorRun(
      outcome({ stdout: JSON.stringify(fixture("healthy")), exitCode, stderr: "error: unexpected argument '--json' found" }),
    );
    assert.equal(result.kind, "summary", `exit ${exitCode}`);
    assert.equal((result as Extract<ExtendedDiagnosis, { kind: "summary" }>).exitCode, exitCode);
  }
  const incidental = classifyDoctorRun(
    outcome({ stdout: JSON.stringify(fixture("healthy")), stderr: "WARNING: could not create PATH aliases" }),
  );
  assert.equal(incidental.kind, "summary");
});

test("AC-6 names an unsupported integer schemaVersion, even next to usage errors", () => {
  const report = { ...reportWithSentinelModel(), schemaVersion: 2 };
  assert.deepEqual(classifyDoctorRun(outcome({ stdout: JSON.stringify(report) })), {
    kind: "unsupported-schema",
    schemaVersion: 2,
  });
  const future = classifyDoctorRun(
    outcome({
      stdout: JSON.stringify({ schemaVersion: 2, checks: null }),
      exitCode: 2,
      stderr: "error: unexpected argument '--json' found",
    }),
  );
  assert.deepEqual(future, { kind: "unsupported-schema", schemaVersion: 2 });
  assert.ok(!formatExtendedDiagnosis(classifyDoctorRun(outcome({ stdout: JSON.stringify(report) })), CONTEXT).includes(MODEL_SENTINEL));
});

test("AC-6 does not treat a report of the wrong shape as usable", () => {
  const healthy = reportWithSentinelModel();
  const { checks: _checks, ...withoutChecks } = healthy;
  const shapes = [
    "null",
    "[]",
    "42",
    '"a string"',
    JSON.stringify({ ...healthy, schemaVersion: "1" }),
    JSON.stringify({ ...healthy, schemaVersion: 1.5 }),
    JSON.stringify({ ...healthy, schemaVersion: null }),
    JSON.stringify({ ...healthy, schemaVersion: true }),
    JSON.stringify({ ...healthy, schemaVersion: undefined }),
    JSON.stringify({ ...healthy, checks: null }),
    JSON.stringify({ ...healthy, checks: "config.load" }),
    JSON.stringify({ ...healthy, checks: [configLoad(healthy)] }),
    JSON.stringify(withoutChecks),
    "",
    "not json at all",
    JSON.stringify(healthy).slice(0, 200),
  ];
  for (const stdout of shapes) {
    const failed = classifyDoctorRun(outcome({ stdout, exitCode: 1 }));
    assert.deepEqual(failed, { kind: "no-report", exitCode: 1 }, stdout.slice(0, 60));
    assert.ok(!formatExtendedDiagnosis(failed, CONTEXT).includes(MODEL_SENTINEL));
    assert.deepEqual(classifyDoctorRun(outcome({ stdout, exitCode: 0 })), { kind: "unparseable" }, stdout.slice(0, 60));
    assert.deepEqual(classifyDoctorRun(outcome({ stdout, exitCode: 2, stderr: "" })), { kind: "usage-error" }, stdout.slice(0, 60));
  }
});

test("AC-6 tells a CLI without doctor --json from any other usage error", () => {
  assert.deepEqual(
    classifyDoctorRun(
      outcome({
        exitCode: 2,
        stderr: "error: unexpected argument '--json' found\n\n  tip: to pass '--json' as a value, use '-- --json'\n",
      }),
    ),
    { kind: "json-unsupported" },
  );
  for (const stderr of [
    "error: unexpected argument '--bogus' found\n",
    "error: unexpected argument '--bogus' found\n\nUsage: codex doctor --json\n",
    "error: invalid value 'x' for '--json'\n",
    "",
  ]) {
    assert.deepEqual(classifyDoctorRun(outcome({ exitCode: 2, stderr })), { kind: "usage-error" }, stderr);
  }
});

test("AC-6 names a usable report without a config.load check, or with an invalid one", () => {
  const healthy = reportWithSentinelModel();
  const without = { ...healthy, checks: { "terminal.env": healthy.checks["terminal.env"] } };
  assert.deepEqual(classifyDoctorRun(outcome({ stdout: JSON.stringify(without) })), { kind: "no-config-load" });
  const { id: _id, ...noId } = configLoad(healthy);
  for (const check of [
    "config loaded",
    null,
    [],
    noId,
    { ...configLoad(healthy), id: null },
    { ...configLoad(healthy), id: 7 },
    { ...configLoad(healthy), id: "network.env" },
  ]) {
    const report = { ...healthy, checks: { ...healthy.checks, "config.load": check } };
    const result = classifyDoctorRun(outcome({ stdout: JSON.stringify(report) }));
    assert.deepEqual(result, { kind: "invalid-config-load" }, JSON.stringify(check).slice(0, 60));
    assert.ok(!formatExtendedDiagnosis(result, CONTEXT).includes(MODEL_SENTINEL));
  }
});

test("AC-6 names each case in the text and never echoes the raw output", () => {
  const cases: [ExtendedDiagnosis, RegExp[]][] = [
    [{ kind: "stopped", reason: "timed-out", detail: null }, [/timed out/i]],
    [{ kind: "stopped", reason: "cancelled", detail: null }, [/cancel/i]],
    [{ kind: "stopped", reason: "stdout-too-large", detail: null }, [/too large/i]],
    [{ kind: "stopped", reason: "signal", detail: "SIGKILL" }, [/signal/i, /SIGKILL/]],
    [{ kind: "stopped", reason: "spawn-failed", detail: "spawn /nowhere ENOENT" }, [/could not (be )?start/i, /ENOENT/]],
    [{ kind: "unsupported-schema", schemaVersion: 7 }, [/schemaVersion/, /\b7\b/]],
    [{ kind: "json-unsupported" }, [/does not support/i, /doctor --json/]],
    [{ kind: "usage-error" }, [/usage error/i]],
    [{ kind: "no-report", exitCode: 3 }, [/exit code 3/i, /no usable report/i]],
    [{ kind: "unparseable" }, [/could not be read/i]],
    [{ kind: "no-config-load" }, [/no config\.load check/i]],
    [{ kind: "invalid-config-load" }, [/invalid config\.load check/i]],
  ];
  for (const [diagnosis, patterns] of cases) {
    const text = formatExtendedDiagnosis(diagnosis, CONTEXT);
    assert.ok(text.split("\n")[0]!.includes(CONTEXT.directory), `header of ${diagnosis.kind}`);
    for (const pattern of patterns) assert.match(text, pattern, JSON.stringify(diagnosis));
  }
  assert.ok(!shown({ stdout: "sentinel-raw-stdout ".repeat(50), exitCode: 0 }).includes("sentinel-raw-stdout"));
  assert.ok(!shown({ exitCode: 1, stderr: "sentinel-raw-stderr" }).includes("sentinel-raw-stderr"));
  assert.ok(!shown({ exitCode: 2, stderr: "error: unexpected argument 'sentinel-raw-arg' found" }).includes("sentinel-raw-arg"));
});

test("AC-4 names a skipped run and why", () => {
  const unavailable = formatExtendedDiagnosis({ kind: "skipped", reason: "cli-unavailable" }, CONTEXT);
  assert.match(unavailable, /skipped/i);
  assert.match(unavailable, /unavailable/i);
  assert.match(formatExtendedDiagnosis({ kind: "skipped", reason: "cancelled" }, CONTEXT), /cancel/i);
  assert.match(formatExtendedDiagnosis({ kind: "skipped", reason: "shutting-down" }, CONTEXT), /shutting down/i);
});

test("AC-5 says a timed-out run can be caused by slow network or MCP probes", () => {
  const text = formatExtendedDiagnosis({ kind: "stopped", reason: "timed-out", detail: null }, CONTEXT);
  assert.match(text, /network/i);
  assert.match(text, /MCP/);
});

// ---------------------------------------------------------------------------
// AC-8: startup warnings and the display bounds

function warningReport(warnings: unknown, count?: unknown): string {
  const check = configLoad(fixture("warning"));
  const details = check.details as Record<string, unknown>;
  details["startup warning"] = warnings;
  if (count === undefined) delete details["startup warnings"];
  else details["startup warnings"] = count;
  return withConfigLoad(check);
}

test("AC-8 shows the reported count and the warning texts, from a string or an array", () => {
  const one = classifyDoctorRun(outcome({ stdout: warningReport("only one warning", "1") }));
  assert.deepEqual(summaryOf(one).startupWarnings, ["only one warning"]);
  const oneText = formatExtendedDiagnosis(one, CONTEXT);
  assert.ok(oneText.includes('startup warnings: "1"'));
  assert.ok(oneText.includes('startup warning: "only one warning"'));
  const two = classifyDoctorRun(outcome({ stdout: warningReport(["first warning", "second warning"], "2") }));
  assert.deepEqual(summaryOf(two).startupWarnings, ["first warning", "second warning"]);
  const text = formatExtendedDiagnosis(two, CONTEXT);
  assert.ok(text.includes('startup warnings: "2"'));
  assert.ok(text.includes('startup warning: "first warning"') && text.includes('startup warning: "second warning"'));
});

test("AC-8 shows a count that disagrees with the texts, or none, without correcting it", () => {
  const mismatch = classifyDoctorRun(outcome({ stdout: warningReport(["the only text"], "3") }));
  assert.equal(summaryOf(mismatch).startupWarningCount, "3");
  assert.equal(summaryOf(mismatch).startupWarnings?.length, 1);
  const text = formatExtendedDiagnosis(mismatch, CONTEXT);
  assert.ok(text.includes('startup warnings: "3"'), "the reported count is shown as reported");
  assert.ok(text.includes('startup warning: "the only text"'));
  const noCount = classifyDoctorRun(outcome({ stdout: warningReport(["a warning"]) }));
  assert.equal(summaryOf(noCount).startupWarningCount, undefined);
  assert.deepEqual(summaryOf(noCount).startupWarnings, ["a warning"]);
  assert.ok(formatExtendedDiagnosis(noCount, CONTEXT).includes("startup warnings: not reported"));
});

test("AC-8 shows at most ten warning texts and says how many were left out", () => {
  const warnings = Array.from({ length: SUMMARY_WARNING_LIMIT + 2 }, (_, i) => `warning-text-${String(i).padStart(2, "0")}`);
  const text = shown({ stdout: warningReport(warnings, String(warnings.length)) });
  for (const kept of warnings.slice(0, SUMMARY_WARNING_LIMIT)) assert.ok(text.includes(JSON.stringify(kept)), kept);
  for (const dropped of warnings.slice(SUMMARY_WARNING_LIMIT)) assert.ok(!text.includes(dropped), dropped);
  assert.ok(text.includes("(2 more startup warnings omitted)"));
});

test("AC-8 cuts each string at the code-point limit, keeps whole characters and states the omitted length", () => {
  const prefix = "a".repeat(SUMMARY_STRING_LIMIT - 1) + "😀";
  const long = `${prefix}sentinel-after-limit`;
  const fields: [string, (check: Record<string, unknown>) => void, string][] = [
    ["startup warning", (c) => ((c.details as Record<string, unknown>)["startup warning"] = [long]), "startup warning"],
    ["summary", (c) => (c.summary = long), "summary"],
    ["remediation", (c) => (c.remediation = long), "remediation"],
    ["model", (c) => ((c.details as Record<string, unknown>).model = long), "configured model"],
    ["model provider", (c) => ((c.details as Record<string, unknown>)["model provider"] = long), "model provider"],
    ["enabled feature flags", (c) => ((c.details as Record<string, unknown>)["enabled feature flags"] = long), "enabled feature flags"],
    ["error", (c) => ((c.details as Record<string, unknown>).error = long), "error"],
  ];
  for (const [name, set, label] of fields) {
    const check = configLoad(fixture("warning"));
    set(check);
    const text = shown({ stdout: withConfigLoad(check) });
    assert.ok(text.includes(`${label}: ${JSON.stringify(prefix)} (20 code points omitted)`), name);
    assert.ok(!text.includes("sentinel-after-limit"), name);
  }
  const unknown = { ...configLoad(fixture("healthy")), status: long };
  assert.ok(shown({ stdout: withConfigLoad(unknown) }).includes(`status: unrecognised ${JSON.stringify(prefix)} (20 code points omitted)`));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown({ stdout: warningReport([long], "1") })), "no lone surrogate");
});

test("AC-8 escapes control, line-separator and bidirectional characters in Codex text", () => {
  const dangerous = [
    ...Array.from({ length: 0x20 }, (_, i) => String.fromCodePoint(i)),
    ...Array.from({ length: 0x21 }, (_, i) => String.fromCodePoint(0x7f + i)),
    "\u2028",
    "\u2029",
    "\u200e",
    "\u200f",
    ...Array.from({ length: 5 }, (_, i) => String.fromCodePoint(0x202a + i)),
    ...Array.from({ length: 4 }, (_, i) => String.fromCodePoint(0x2066 + i)),
  ];
  const text = shown({ stdout: warningReport([`alert ${dangerous.join("|")} end`], "1") });
  const body = text.split("\n").filter((line) => line.startsWith("startup warning:")).join("\n");
  assert.ok(body.includes("alert") && body.includes("end"));
  for (const character of dangerous) {
    assert.ok(!body.includes(character), `U+${character.codePointAt(0)!.toString(16).padStart(4, "0")} is raw`);
  }
  assert.ok(text.includes('startup warning: "alert \\u0000|'), "escaped as in a JSON string literal");
});

test("AC-8 keeps the whole section within its limit and says it was cut", () => {
  const check = configLoad(fixture("warning"));
  const details = check.details as Record<string, unknown>;
  for (const key of ["enabled feature flags", "feature flag overrides", "configuration scope", "model", "model provider"]) {
    details[key] = "x".repeat(SUMMARY_STRING_LIMIT + 100);
  }
  details["startup warning"] = Array.from({ length: SUMMARY_WARNING_LIMIT }, () => "w".repeat(SUMMARY_STRING_LIMIT + 100));
  check.summary = "s".repeat(SUMMARY_STRING_LIMIT + 100);
  check.remediation = "r".repeat(SUMMARY_STRING_LIMIT + 100);
  const text = shown({ stdout: withConfigLoad(check) });
  assert.ok([...text].length <= SECTION_LIMIT, `${[...text].length} code points`);
  assert.ok(text.trimEnd().endsWith("(section cut at 16384 code points)"));
  const small = shown({ stdout: JSON.stringify(fixture("healthy")) });
  assert.ok(!small.includes("section cut"), "an ordinary section is not cut");
});

// ---------------------------------------------------------------------------
// AC-9: failed configuration

test("AC-9 shows the status, error, line and column of a parse failure but not the file", () => {
  const diagnosis = classifyDoctorRun(outcome({ stdout: JSON.stringify(fixture("syntax")), exitCode: 1 }));
  const summary = summaryOf(diagnosis);
  assert.deepEqual(summary.status, { kind: "known", value: "fail" });
  assert.equal(summary.error, "invalid configuration");
  assert.equal(summary.line, "2");
  assert.equal(summary.column, "10");
  const text = formatExtendedDiagnosis(diagnosis, CONTEXT);
  for (const line of ['status: "fail"', 'error: "invalid configuration"', 'line: "2"', 'column: "10"']) {
    assert.ok(text.includes(line), line);
  }
  assert.ok(!text.includes("home-broken/config.toml"), "the file path is not shown");
  assert.ok(!/^file:/m.test(text));
});

test("AC-9 shows only status, summary, remediation and error for a failure without a location", () => {
  const diagnosis = classifyDoctorRun(outcome({ stdout: JSON.stringify(fixture("semantic")), exitCode: 1 }));
  const summary = summaryOf(diagnosis);
  assert.equal(summary.error, "entity not found");
  assert.equal(summary.line, undefined);
  const text = formatExtendedDiagnosis(diagnosis, CONTEXT);
  for (const line of [
    'status: "fail"',
    'summary: "config could not be loaded"',
    'remediation: "Fix the reported config error, then rerun codex doctor."',
    'error: "entity not found"',
  ]) {
    assert.ok(text.includes(line), line);
  }
  assert.ok(!/^(line|column|file|configured model):/m.test(text));
});

test("AC-9 shows nothing of the raw error in the 0.154.0 shape", () => {
  // Reconstructed from the 0.154.0 source, not captured: that release appends
  // err.to_string() as the only detail, which the JSON renderer splits on its
  // first ": " (rust-v0.154.0 codex-rs/cli/src/doctor.rs:510-518, 749-771).
  const check = {
    id: "config.load",
    category: "config",
    status: "fail",
    summary: "config could not be loaded",
    details: { "/Users/example/.codex/config.toml:2:10": "sentinel-raw-error unclosed table, expected `]`" },
    notes: ["sentinel-raw-note"],
    remediation: "Fix the reported config error, then rerun codex doctor.",
    durationMs: 0,
  };
  const diagnosis = classifyDoctorRun(outcome({ stdout: withConfigLoad(check), exitCode: 1 }));
  const text = formatExtendedDiagnosis(diagnosis, CONTEXT);
  assert.deepEqual(summaryOf(diagnosis).status, { kind: "known", value: "fail" });
  assert.ok(text.includes('status: "fail"'));
  assert.ok(text.includes('summary: "config could not be loaded"'));
  for (const raw of ["sentinel-raw-error", "sentinel-raw-note", "/Users/example/.codex/config.toml:2:10"]) {
    assert.ok(!text.includes(raw), raw);
  }
});

// ---------------------------------------------------------------------------
// AC-10: the shared shutdown schedule, on a mocked clock

test("AC-10 (fake clock) a doctor handle gets the delegations' SIGKILL instant and shutdown still exits at 300 ms", async (t) => {
  const start = 1_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const runs = new ActiveRuns({ readProcessTable: () => [] });
  const cancels: CancelOptions[] = [];
  const doctor: DoctorReportHandle = {
    pid: 101,
    result: new Promise(() => {}),
    exited: new Promise(() => {}),
    cancel: (options) => {
      cancels.push(options ?? {});
    },
  };
  runs.track(doctor);
  runs.track({
    pid: 102,
    exited: new Promise<void>(() => {}),
    cancel: (options?: CancelOptions) => {
      cancels.push(options ?? {});
    },
  });
  const exits: number[] = [];
  const shutdown = createShutdown({
    runs,
    jobs: { cancelAll() {} },
    close: async () => {},
    exit: () => {
      exits.push(Date.now());
    },
    log() {},
  });
  shutdown(143);
  assert.deepEqual(cancels.map((options) => options.killAt), [start + 250, start + 250]);
  assert.equal(cancels[0]!.processTables, cancels[1]!.processTables, "one process-table read for both");
  assert.equal(cancels[0]!.processTables?.forced, null);
  t.mock.timers.tick(299);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, []);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [start + 300]);
});

// ---------------------------------------------------------------------------
// The process lifecycle, against the Node stand-in

const POSIX = process.platform !== "win32";
const GRACE_MS = 300;
const SETTLE_SLACK_MS = 2500;
// Captured before any test mocks the timers, so waiting on real processes still works under a fake clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    realClearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

type Start = (options: Omit<DoctorReportOptions, "executable" | "cwd"> & Partial<DoctorReportOptions>) => DoctorReportHandle;

/**
 * Runs the stand-in as `doctor`. Every handle started through `start` is
 * cancelled and awaited afterwards, independently of the code under test, and
 * the descendant is killed, so a failing assertion never leaves a process.
 */
async function withDoctor(
  scenario: Scenario,
  body: (fake: ReturnType<typeof createFakeCodex>, start: Start) => Promise<void>,
): Promise<void> {
  const fake = createFakeCodex(scenario, { command: "doctor" });
  const handles: DoctorReportHandle[] = [];
  const start: Start = (options) => {
    const handle = runDoctorReport({ executable: fake.codexPath, cwd: fake.workingDir, ...options });
    handles.push(handle);
    return handle;
  };
  try {
    await body(fake, start);
  } finally {
    mock.timers.reset();
    for (const handle of handles) {
      try {
        handle.cancel({ graceMs: 0 });
      } catch {
        // A broken handle must not stop the cleanup.
      }
      if (handle.pid !== undefined && isAlive(handle.pid)) {
        try {
          process.kill(POSIX ? -handle.pid : handle.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await Promise.all(handles.map((handle) => within(handle.exited, 5_000, "cleanup").catch(() => undefined)));
    const pid = fake.descendantPid();
    if (pid !== null && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await sleep(100);
    fake.dispose();
  }
}

const HEALTHY = JSON.stringify(fixture("healthy"));

test("AC-2 spawns the executable with doctor --json in the given directory and returns its report", async () => {
  await withDoctor({ chunks: [HEALTHY], exitCode: 1 }, async (fake, start) => {
    const handle = start({ killGraceMs: GRACE_MS });
    const result = await within(handle.result, 10_000, "the run");
    assert.equal(result.stopped, null);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, HEALTHY);
    // Node ran the file named `doctor` in that directory, so argv[0] was `doctor`.
    assert.deepEqual(fake.received().argv, ["--json"]);
    assert.equal(fake.received().stdin, "", "nothing is written to stdin");
    await within(handle.exited, 5_000, "exited");
  });
});

test("AC-4 reports a spawn failure as an outcome, not a rejection", async () => {
  const handle = runDoctorReport({ executable: join("/nonexistent-dir-for-69", "codex"), killGraceMs: GRACE_MS });
  const result = await within(handle.result, 5_000, "the run");
  assert.equal(result.stopped, "spawn-failed");
  assert.ok(result.spawnError && result.spawnError.length > 0);
  await within(handle.exited, 5_000, "exited");
});

test("AC-4 reports a file that cannot be executed as a spawn failure", { skip: POSIX ? false : "no execute bit on Windows" }, async () => {
  await withDoctor({ chunks: [] }, async (fake) => {
    const notExecutable = join(fake.workingDir, "not-executable");
    writeFileSync(notExecutable, "plain text\n", "utf8");
    chmodSync(notExecutable, 0o644);
    const handle = runDoctorReport({ executable: notExecutable, cwd: fake.workingDir, killGraceMs: GRACE_MS });
    const result = await within(handle.result, 5_000, "the run");
    assert.equal(result.stopped, "spawn-failed");
    assert.match(result.spawnError ?? "", /EACCES/);
  });
});

test("AC-5 (fake clock) stops the process tree 60 s after spawn and parses no partial output", async () => {
  await withDoctor(
    { chunks: [HEALTHY.slice(0, 500)], stayRunning: true, descendant: { holdMs: 30_000 } },
    async (fake, start) => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const handle = start({ killGraceMs: GRACE_MS });
      let settled = false;
      void handle.result.then(() => {
        settled = true;
      });
      await waitFor(() => fake.descendantPid() !== null, 10_000, "the stand-in and its descendant to start");
      mock.timers.tick(DOCTOR_REPORT_TIMEOUT_MS - 1);
      await sleep(50);
      assert.equal(settled, false, "stopped before the deadline");
      assert.equal(isAlive(handle.pid!), true);
      mock.timers.tick(1);
      for (let i = 0; i < 200 && !settled; i++) {
        await sleep(10);
        mock.timers.tick(100);
      }
      const result = await within(handle.result, SETTLE_SLACK_MS, "the timed-out run");
      assert.equal(result.stopped, "timed-out");
      assert.equal(classifyDoctorRun(result).kind, "stopped");
      for (let i = 0; i < 100; i++) mock.timers.tick(100);
      const descendant = fake.descendantPid()!;
      await waitFor(() => !isAlive(descendant), SETTLE_SLACK_MS, `descendant ${descendant} to stop`);
      await waitFor(() => !isAlive(handle.pid!), SETTLE_SLACK_MS, "the doctor process to stop");
    },
  );
});

test("AC-10 starts nothing when the request was cancelled before spawn", async () => {
  await withDoctor({ chunks: [HEALTHY] }, async (fake, start) => {
    const controller = new AbortController();
    controller.abort();
    const handle = start({ signal: controller.signal, killGraceMs: GRACE_MS });
    const result = await within(handle.result, 5_000, "the run");
    assert.equal(result.stopped, "cancelled");
    assert.equal(handle.pid, undefined);
    await within(handle.exited, 1_000, "exited");
    await sleep(300);
    assert.equal(existsSync(join(fake.workingDir, "received.json")), false, "the stand-in ran");
  });
});

test("AC-10 stops the process tree when the request is cancelled after spawn", async () => {
  await withDoctor({ chunks: [], stayRunning: true, descendant: { holdMs: 30_000 } }, async (fake, start) => {
    const controller = new AbortController();
    const handle = start({ signal: controller.signal, killGraceMs: GRACE_MS });
    await waitFor(() => fake.descendantPid() !== null, 10_000, "the descendant to start");
    controller.abort();
    const result = await within(handle.result, GRACE_MS + SETTLE_SLACK_MS, "the run");
    assert.equal(result.stopped, "cancelled");
    await within(handle.exited, GRACE_MS + SETTLE_SLACK_MS, "exited");
    const descendant = fake.descendantPid()!;
    await waitFor(() => !isAlive(descendant), SETTLE_SLACK_MS, `descendant ${descendant} to stop`);
  });
});

test("AC-10 honours the killAt of a stop request over its own grace", { skip: POSIX ? false : "needs a CLI that ignores the polite signal" }, async () => {
  await withDoctor(
    { chunks: [], stayRunning: true, ignoreSigterm: true, descendant: { holdMs: 30_000, ignoreSigterm: true } },
    async (fake, start) => {
      const handle = start({ killGraceMs: 20_000 });
      await waitFor(() => fake.descendantPid() !== null, 10_000, "the descendant to start");
      await sleep(300);
      const stoppedAt = Date.now();
      handle.cancel({ graceMs: 20_000, killAt: stoppedAt + 250 });
      await within(handle.exited, 5_000, "exited, well before the 20 s grace");
      const descendant = fake.descendantPid()!;
      await waitFor(() => !isAlive(descendant), SETTLE_SLACK_MS, `descendant ${descendant} to stop`);
      assert.equal((await handle.result).stopped, "cancelled");
    },
  );
});

test("AC-10 is stopped by ActiveRuns.stopAll together with its descendant", async () => {
  // Ignoring the polite signal on POSIX leaves only the forced stage, so the
  // run's own twenty-second grace would miss the deadline.
  await withDoctor(
    { chunks: [], stayRunning: true, ignoreSigterm: POSIX, descendant: { holdMs: 30_000, ignoreSigterm: POSIX } },
    async (fake, start) => {
      const runs = new ActiveRuns();
      const handle = runs.track(start({ killGraceMs: 20_000 }));
      await waitFor(() => fake.descendantPid() !== null, 10_000, "the descendant to start");
      await sleep(300);
      assert.equal(runs.size, 1);
      const unconfirmed = await runs.stopAll({ graceMs: 250, deadlineMs: 3_000 });
      assert.deepEqual(unconfirmed, [], "the shutdown grace, not the run's own, applied");
      const result = await within(handle.result, SETTLE_SLACK_MS, "the run");
      assert.equal(result.stopped, "cancelled");
      const descendant = fake.descendantPid()!;
      await waitFor(() => !isAlive(descendant), SETTLE_SLACK_MS, `descendant ${descendant} to stop`);
      assert.equal(runs.size, 0);
    },
  );
});

/** A usable report padded with spaces to exactly `bytes` bytes of UTF-8. */
function reportOfSize(bytes: number): string {
  const base = JSON.stringify(fixture("healthy"));
  const padded = `${base.slice(0, -1)},"pad":""}`;
  const missing = bytes - Buffer.byteLength(padded);
  assert.ok(missing >= 0);
  return `${base.slice(0, -1)},"pad":"${" ".repeat(missing)}"}`;
}

test("AC-6 parses a report of exactly the stdout limit", async () => {
  const exact = reportOfSize(DOCTOR_STDOUT_LIMIT_BYTES);
  assert.equal(Buffer.byteLength(exact), DOCTOR_STDOUT_LIMIT_BYTES);
  await withDoctor({ chunks: [exact], exitCode: 0 }, async (_fake, start) => {
    const result = await within(start({ killGraceMs: GRACE_MS }).result, 10_000, "the run");
    assert.equal(result.stopped, null);
    assert.equal(Buffer.byteLength(result.stdout), DOCTOR_STDOUT_LIMIT_BYTES);
    assert.equal(classifyDoctorRun(result).kind, "summary");
  });
});

test("AC-6 stops a run whose stdout exceeds the limit by one byte and does not parse it", async () => {
  const over = reportOfSize(DOCTOR_STDOUT_LIMIT_BYTES + 1);
  await withDoctor({ chunks: [over], stayRunning: true }, async (_fake, start) => {
    const handle = start({ killGraceMs: GRACE_MS });
    const result = await within(handle.result, 10_000, "the run");
    assert.equal(result.stopped, "stdout-too-large");
    assert.ok(Buffer.byteLength(result.stdout) <= DOCTOR_STDOUT_LIMIT_BYTES);
    assert.equal(classifyDoctorRun(result).kind, "stopped");
    await within(handle.exited, GRACE_MS + SETTLE_SLACK_MS, "exited");
  });
});

test("AC-6 keeps at most the stderr limit, drains the rest and still reports the exit code", async () => {
  await withDoctor(
    { chunks: [], stderr: "é".repeat(DOCTOR_STDERR_LIMIT_BYTES), exitCode: 2 },
    async (_fake, start) => {
      const result = await within(start({ killGraceMs: GRACE_MS }).result, 10_000, "the run");
      assert.equal(result.stopped, null);
      assert.equal(result.exitCode, 2);
      assert.ok(Buffer.byteLength(result.stderr) <= DOCTOR_STDERR_LIMIT_BYTES);
      assert.ok(result.stderr.length > 0);
      assert.ok(!result.stderr.includes("\uFFFD"), "no character split at the cut");
    },
  );
});
