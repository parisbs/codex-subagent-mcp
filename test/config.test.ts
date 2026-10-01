import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkModel,
  checkSandbox,
  impliedModel,
  loadConfig,
} from "../src/config.ts";

const P = "CODEX_SUBAGENT_";
const empty = loadConfig({}).config;

test("uses safe sandbox defaults without inventing model or effort policy", () => {
  const { config, errors } = loadConfig({});
  assert.deepEqual(errors, []);
  assert.equal(config.defaultModel, null);
  assert.equal(config.defaultEffort, null);
  assert.deepEqual(config.allowedModels, []);
  assert.equal(config.maxEffort, null);
  assert.equal(config.defaultSandbox, "read-only");
  assert.equal(config.maxSandbox, "workspace-write");
});

test("reads every setting", () => {
  const { config, errors } = loadConfig({
    [`${P}DEFAULT_MODEL`]: "gpt-5.6-luna",
    [`${P}DEFAULT_EFFORT`]: "low",
    [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna, gpt-5.6-terra",
    [`${P}DEFAULT_SANDBOX`]: "workspace-write",
    [`${P}MAX_SANDBOX`]: "danger-full-access",
    [`${P}MAX_EFFORT`]: "high",
  });
  assert.deepEqual(errors, []);
  assert.equal(config.defaultModel, "gpt-5.6-luna");
  assert.deepEqual(config.allowedModels, ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.equal(config.defaultSandbox, "workspace-write");
  assert.equal(config.maxSandbox, "danger-full-access");
  assert.equal(config.maxEffort, "high");
});

test("collects invalid values instead of throwing", () => {
  // A server that refuses to start cannot explain why; the user would just see
  // a tool that is not there.
  const { errors } = loadConfig({
    [`${P}MAX_SANDBOX`]: "yolo",
    [`${P}DEFAULT_SANDBOX`]: "unconfined",
    [`${P}MAX_EFFORT`]: "turbo",
  });
  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /MAX_SANDBOX is "yolo"/);
  assert.match(errors.join("\n"), /DEFAULT_SANDBOX is "unconfined"/);
  assert.match(errors.join("\n"), /MAX_EFFORT is "turbo"/);
});

test("rejects a default model excluded by its own allow-list", () => {
  const { errors } = loadConfig({
    [`${P}DEFAULT_MODEL`]: "gpt-6-astra",
    [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna",
  });
  assert.match(errors.join("\n"), /not in CODEX_SUBAGENT_ALLOWED_MODELS/);
});

test("rejects a default effort above its own ceiling", () => {
  const { errors } = loadConfig({
    [`${P}DEFAULT_EFFORT`]: "ultra",
    [`${P}MAX_EFFORT`]: "medium",
  });
  assert.match(errors.join("\n"), /higher than CODEX_SUBAGENT_MAX_EFFORT/);
});

test("rejects a default sandbox above its own ceiling", () => {
  const { errors } = loadConfig({
    [`${P}DEFAULT_SANDBOX`]: "danger-full-access",
    [`${P}MAX_SANDBOX`]: "workspace-write",
  });
  assert.match(errors.join("\n"), /DEFAULT_SANDBOX \("danger-full-access"\) is higher than CODEX_SUBAGENT_MAX_SANDBOX \("workspace-write"\)/);
});

test("rejects a danger-full-access default without an explicit ceiling opt-in", () => {
  const { errors } = loadConfig({
    [`${P}DEFAULT_SANDBOX`]: "danger-full-access",
  });
  assert.match(errors.join("\n"), /MAX_SANDBOX \("workspace-write"\)/);
});

test("requires an explicit ceiling to make danger-full-access reachable", () => {
  assert.equal(checkSandbox("danger-full-access", loadConfig({}).config).ok, false);
  assert.equal(
    checkSandbox(
      "danger-full-access",
      loadConfig({ [`${P}MAX_SANDBOX`]: "danger-full-access" }).config,
    ).ok,
    true,
  );
});

test("refuses a sandbox above the ceiling rather than lowering it", () => {
  // Silently running read-only would produce a delegation that cannot do the
  // job it was given and does not say so.
  const { config } = loadConfig({ [`${P}MAX_SANDBOX`]: "read-only" });
  const result = checkSandbox("workspace-write", config);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /MAX_SANDBOX="read-only"/);
});

test("allows a sandbox at or below the ceiling", () => {
  const { config } = loadConfig({ [`${P}MAX_SANDBOX`]: "workspace-write" });
  assert.equal(checkSandbox("read-only", config).ok, true);
  assert.equal(checkSandbox("workspace-write", config).ok, true);
  assert.equal(checkSandbox("danger-full-access", config).ok, false);
});

test("enforces the model allow-list", () => {
  const { config } = loadConfig({ [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna" });
  assert.equal(checkModel("gpt-5.6-luna", config).ok, true);
  const denied = checkModel("gpt-6-astra", config);
  assert.equal(denied.ok, false);
  assert.match(denied.ok === false ? denied.reason : "", /not in CODEX_SUBAGENT_ALLOWED_MODELS/);
});

test("allows every model when no list is configured", () => {
  assert.equal(checkModel("anything", empty).ok, true);
});

test("has no implied model without configuration", () => {
  // This is what makes the server refuse rather than guess.
  assert.equal(impliedModel(empty), null);
});

test("treats a single-entry allow-list as the default", () => {
  // Nothing is left to decide, so refusing would be friction with no decision
  // behind it.
  const { config } = loadConfig({ [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna" });
  assert.equal(impliedModel(config), "gpt-5.6-luna");
});

test("prefers an explicit default over the allow-list", () => {
  const { config } = loadConfig({
    [`${P}DEFAULT_MODEL`]: "gpt-5.6-terra",
    [`${P}ALLOWED_MODELS`]: "gpt-5.6-terra, gpt-5.6-luna",
  });
  assert.equal(impliedModel(config), "gpt-5.6-terra");
});

test("does not imply a model from a multi-entry allow-list", () => {
  const { config } = loadConfig({ [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna, gpt-5.6-terra" });
  assert.equal(impliedModel(config), null);
});

// #64: inheritance is configured outside the tool arguments.
test("AC-1 (#64) defaults all inherited tools to none", () => {
  const { config, errors } = loadConfig({});
  assert.deepEqual(errors, []);
  assert.deepEqual(config.mcpServers, { kind: "none" });
  assert.deepEqual(config.plugins, { kind: "none" });
  assert.equal(config.apps, false);
});

for (const [variable, field, ac] of [
  ["MCP_SERVERS", "mcpServers", "AC-2 AC-3"],
  ["PLUGINS", "plugins", "AC-5"],
] as const) {
  test(`${ac} (#64) parses ${variable} keywords and case-sensitive lists`, () => {
    for (const [raw, expected] of [
      [" none ", { kind: "none" }],
      [" all\n", { kind: "all" }],
      [" alpha@market , Beta,alpha@market,Beta,beta ", { kind: "list", names: ["alpha@market", "Beta", "beta"] }],
      ["ALL,None", { kind: "list", names: ["ALL", "None"] }],
    ] as const) {
      const loaded = loadConfig({ [`${P}${variable}`]: raw });
      assert.deepEqual(loaded.errors, [], raw);
      assert.deepEqual(loaded.config[field], expected, raw);
    }
  });

  test(`AC-1 (#64) treats blank ${variable} as unset`, () => {
    for (const raw of ["", " \t\n"]) {
      const loaded = loadConfig({ [`${P}${variable}`]: raw });
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.config[field], { kind: "none" });
    }
  });

  // Amended on 2026-10-01: an empty entry is a mistake to report, not a
  // separator to skip. A value of only commas usually means a template whose
  // variables expanded to nothing.
  test(`AC-7 (#64) rejects ${variable} lists with an empty entry`, () => {
    for (const raw of [",", " , , ", "docs,,api", "docs,", ",docs", "docs, ,api"]) {
      const { errors } = loadConfig({ [`${P}${variable}`]: raw });
      assert.equal(errors.length, 1, raw);
      assert.ok(errors[0]!.includes(`${P}${variable}`), raw);
      assert.ok(errors[0]!.includes(raw), raw);
    }
  });

  test(`AC-7 (#64) rejects ${variable} keywords mixed with names`, () => {
    for (const raw of ["all,docs", "docs,none", "none,all", "all,all", "none,none", "all,", ",none"]) {
      const { errors } = loadConfig({ [`${P}${variable}`]: raw });
      assert.equal(errors.length, 1, raw);
      assert.ok(errors[0]!.includes(`${P}${variable}`));
      assert.ok(errors[0]!.includes(raw));
    }
  });
}

test("AC-6 (#64) parses trimmed apps on and off and blank as unset", () => {
  for (const [raw, expected] of [[" on\n", true], [" off ", false], ["", false], [" \t", false]] as const) {
    const loaded = loadConfig({ [`${P}APPS`]: raw });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.config.apps, expected, JSON.stringify(raw));
  }
});

test("AC-7 (#64) rejects every apps value outside on and off", () => {
  for (const raw of ["all", "none", "ON", "OFF", "true", "docs", "on,off", "on,"]) {
    const { errors } = loadConfig({ [`${P}APPS`]: raw });
    assert.equal(errors.length, 1, raw);
    assert.match(errors[0]!, /CODEX_SUBAGENT_APPS/);
    assert.ok(errors[0]!.includes(raw));
  }
});
