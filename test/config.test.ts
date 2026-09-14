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

test("defaults to no policy of its own", () => {
  const { config, errors } = loadConfig({});
  assert.deepEqual(errors, []);
  assert.equal(config.defaultModel, null);
  assert.equal(config.defaultEffort, null);
  assert.deepEqual(config.allowedModels, []);
  assert.equal(config.maxEffort, null);
  // No ceiling configured means no ceiling applied; read-only is still the
  // per-call default, which is a separate thing.
  assert.equal(config.maxSandbox, "danger-full-access");
});

test("reads every setting", () => {
  const { config, errors } = loadConfig({
    [`${P}DEFAULT_MODEL`]: "gpt-5.6-luna",
    [`${P}DEFAULT_EFFORT`]: "low",
    [`${P}ALLOWED_MODELS`]: "gpt-5.6-luna, gpt-5.6-terra",
    [`${P}MAX_SANDBOX`]: "read-only",
    [`${P}MAX_EFFORT`]: "high",
  });
  assert.deepEqual(errors, []);
  assert.equal(config.defaultModel, "gpt-5.6-luna");
  assert.deepEqual(config.allowedModels, ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.equal(config.maxSandbox, "read-only");
  assert.equal(config.maxEffort, "high");
});

test("collects invalid values instead of throwing", () => {
  // A server that refuses to start cannot explain why; the user would just see
  // a tool that is not there.
  const { errors } = loadConfig({
    [`${P}MAX_SANDBOX`]: "yolo",
    [`${P}MAX_EFFORT`]: "turbo",
  });
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /MAX_SANDBOX is "yolo"/);
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
