import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { promisify } from "node:util";

/**
 * The preflight and the catalog are probes, and a probe's answer depends on
 * where it runs: Codex loads the configuration of the directory it is invoked
 * in, so a project the user has trusted in Codex can set its own model catalog,
 * and a config file Codex cannot parse is only visible from inside that project.
 *
 * These tests intercept `child_process` the way `server.test.ts` does, so no
 * Codex CLI, credentials or quota are involved.
 */

interface Probe {
  args: string[];
  cwd: string | undefined;
}

let probes: Probe[] = [];
/** Catalog JSON keyed by the directory `debug models` was run in. */
let catalogByCwd = new Map<string, string>();
/** Directories where `login status` fails, as a signed-out CLI would. */
let signedOutCwds = new Set<string>();

const catalogFor = (slug: string): string =>
  JSON.stringify({
    models: [
      {
        slug,
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      },
    ],
  });

const fakeExecFile = async (
  _file: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> => {
  probes.push({ args, cwd: options?.cwd });
  const cwd = options?.cwd ?? "";
  if (args[0] === "--version") return { stdout: "codex-cli 0.154.0", stderr: "" };
  if (args[0] === "debug") {
    return { stdout: catalogByCwd.get(cwd) ?? catalogFor("default-model"), stderr: "" };
  }
  if (args[0] === "login") {
    if (signedOutCwds.has(cwd)) {
      const error = Object.assign(new Error("exit 1"), { stderr: "Not logged in" });
      throw error;
    }
    return { stdout: "Logged in using ChatGPT", stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;
syncBuiltinESMExports();

const { getCatalog, resetCatalogCache } = await import("../src/codex/catalog.ts");
const { runDoctor, resetDoctorCache } = await import("../src/codex/doctor.ts");

function reset(): void {
  probes = [];
  catalogByCwd = new Map();
  signedOutCwds = new Set();
  resetCatalogCache();
  resetDoctorCache();
  process.env.CODEX_BIN = process.execPath;
}

test("reads the catalog in the directory it was asked about", async () => {
  reset();
  catalogByCwd.set("/project-a", catalogFor("model-a"));
  catalogByCwd.set("/project-b", catalogFor("model-b"));

  const a = await getCatalog({ cwd: "/project-a" });
  const b = await getCatalog({ cwd: "/project-b" });

  assert.deepEqual(
    a.models.map((model) => model.slug),
    ["model-a"],
  );
  assert.deepEqual(
    b.models.map((model) => model.slug),
    ["model-b"],
  );
  assert.deepEqual(
    probes.map((probe) => probe.cwd),
    ["/project-a", "/project-b"],
  );
});

test("does not serve one directory's catalog from another's cache entry", async () => {
  reset();
  catalogByCwd.set("/project-a", catalogFor("model-a"));
  catalogByCwd.set("/project-b", catalogFor("model-b"));

  await getCatalog({ cwd: "/project-a" });
  await getCatalog({ cwd: "/project-a" });
  const b = await getCatalog({ cwd: "/project-b" });

  // Two directories, two probes: the repeat hits the cache, the new directory
  // does not. A single global entry validated delegations against whichever
  // directory happened to be read first.
  assert.equal(probes.length, 2);
  assert.deepEqual(
    b.models.map((model) => model.slug),
    ["model-b"],
  );
});

test("keeps the server's own directory distinct from an explicit one", async () => {
  reset();
  catalogByCwd.set("", catalogFor("server-default"));
  catalogByCwd.set("/project-a", catalogFor("model-a"));

  const implicit = await getCatalog();
  const explicit = await getCatalog({ cwd: "/project-a" });

  assert.equal(implicit.models[0]?.slug, "server-default");
  assert.equal(explicit.models[0]?.slug, "model-a");
  assert.equal(probes[0]?.cwd, undefined, "no cwd is passed when none was asked for");
});

test("probes the installation in the directory it was asked about", async () => {
  reset();
  signedOutCwds.add("/project-b");

  const a = await runDoctor({ cwd: "/project-a" });
  const b = await runDoctor({ cwd: "/project-b" });

  assert.equal(a.status, "ok");
  // Codex reads the configuration of the directory it runs in, so the answer is
  // not a property of the machine alone.
  assert.equal(b.status, "unauthenticated");
  assert.deepEqual(new Set(probes.map((probe) => probe.cwd)), new Set(["/project-a", "/project-b"]));
});

test("caches a clean diagnosis per directory and never caches a broken one", async () => {
  reset();
  signedOutCwds.add("/project-b");

  await runDoctor({ cwd: "/project-a" });
  await runDoctor({ cwd: "/project-a" });
  assert.equal(probes.length, 2, "the second call to the same directory is cached");

  await runDoctor({ cwd: "/project-b" });
  await runDoctor({ cwd: "/project-b" });
  // Signing in must take effect without restarting the server, so a failed
  // diagnosis is re-probed every time.
  assert.equal(probes.length, 6);
});

test("re-probes a directory when asked to refresh", async () => {
  reset();
  await runDoctor({ cwd: "/project-a" });
  await runDoctor({ cwd: "/project-a", refresh: true });
  assert.equal(probes.length, 4);
});
