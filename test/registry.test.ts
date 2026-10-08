import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MCP_PUBLISHER_ASSET,
  MCP_PUBLISHER_SHA256,
  MCP_PUBLISHER_VERSION,
  SCHEMA_URL,
  SERVER_NAMESPACE,
  checkPublishedPackage,
  checkRegistryMetadata,
  documentedVariables,
  verifySha256,
  type RegistryInputs,
} from "../scripts/check-registry.ts";

/** Publishing to the official MCP Registry (#97). */

const NAME = "io.github.parisbs/codex-subagent-mcp";

function inputs(overrides: {
  packageJson?: Record<string, unknown>;
  serverJson?: Record<string, unknown>;
  npmPackage?: Record<string, unknown>;
  serverVersion?: string;
  tag?: string;
} = {}): RegistryInputs {
  const npmPackage = {
    registryType: "npm",
    identifier: "codex-subagent-mcp",
    version: "1.2.3",
    transport: { type: "stdio" },
    ...overrides.npmPackage,
  };
  return {
    packageJson: { name: "codex-subagent-mcp", version: "1.2.3", mcpName: NAME, ...overrides.packageJson },
    serverJson: {
      $schema: SCHEMA_URL,
      name: NAME,
      description: "Delegates to the Codex CLI, installed separately.",
      version: "1.2.3",
      packages: [npmPackage],
      ...overrides.serverJson,
    },
    serverVersion: overrides.serverVersion ?? "1.2.3",
    ...(overrides.tag === undefined ? {} : { tag: overrides.tag }),
  };
}

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** The committed files, read the way the workflows read them. */
function committed(): RegistryInputs & { readme: string } {
  const serverJsonPath = repoFile("server.json");
  const source = readFileSync(repoFile("src/server.ts"), "utf8");
  return {
    packageJson: JSON.parse(readFileSync(repoFile("package.json"), "utf8")),
    // Missing until the implementation adds it; the assertions then fail by value.
    serverJson: existsSync(serverJsonPath) ? JSON.parse(readFileSync(serverJsonPath, "utf8")) : {},
    serverVersion: /export const SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(source)?.[1] ?? "",
    readme: readFileSync(repoFile("README.md"), "utf8"),
  };
}

// AC-1: mcpName and the server's name.

test("AC-1 accepts an mcpName equal to the server's name under io.github.parisbs/", () => {
  assert.ok(NAME.startsWith(SERVER_NAMESPACE));
  assert.deepEqual(checkRegistryMetadata(inputs()), []);
});

test("AC-1 rejects a missing mcpName, a different name, or another namespace", () => {
  const cases: RegistryInputs[] = [
    inputs({ packageJson: { mcpName: undefined } }),
    inputs({ packageJson: { mcpName: "io.github.parisbs/something-else" } }),
    inputs({
      packageJson: { mcpName: "io.github.someone/codex-subagent-mcp" },
      serverJson: { name: "io.github.someone/codex-subagent-mcp" },
    }),
  ];
  for (const [index, input] of cases.entries()) {
    const problems = checkRegistryMetadata(input);
    assert.ok(problems.length > 0, `case ${index} passed`);
    assert.match(problems.join("\n"), /mcpName|namespace|io\.github\.parisbs/, `case ${index}`);
  }
});

test("AC-1 rejects a package entry that is not this npm package over stdio", () => {
  const cases: RegistryInputs[] = [
    inputs({ npmPackage: { registryType: "pypi" } }),
    inputs({ npmPackage: { identifier: "another-package" } }),
    inputs({ npmPackage: { transport: { type: "streamable-http" } } }),
    inputs({ serverJson: { packages: [] } }),
  ];
  for (const [index, input] of cases.entries()) {
    assert.ok(checkRegistryMetadata(input).length > 0, `case ${index} passed`);
  }
});

test("AC-1 (#117) requires exactly one npm package in server.json", () => {
  const npmPackage = inputs().serverJson.packages as Record<string, unknown>[];
  const twice = inputs({ serverJson: { packages: [npmPackage[0], { ...npmPackage[0], version: "9.9.9" }] } });
  assert.match(checkRegistryMetadata(twice).join("\n"), /exactly one npm package/);
  // Even when both entries agree: which one a client installs is then ambiguous.
  const same = inputs({ serverJson: { packages: [npmPackage[0], npmPackage[0]] } });
  assert.match(checkRegistryMetadata(same).join("\n"), /exactly one npm package/);
});

test("AC-2 (#117) rejects a server name the registry's schema would refuse", () => {
  for (const name of ["io.github.parisbs/", "io.github.parisbs/has space", "io.github.parisbs/a/b"]) {
    const problems = checkRegistryMetadata(inputs({ packageJson: { mcpName: name }, serverJson: { name } }));
    assert.ok(problems.some((problem) => problem.includes(JSON.stringify(name))), `${name}: ${problems.join(" | ")}`);
  }
});

test("AC-1 the committed package.json and server.json agree on the server's name", () => {
  const { packageJson, serverJson } = committed();
  assert.equal(typeof packageJson.mcpName, "string");
  assert.ok((packageJson.mcpName as string).startsWith(SERVER_NAMESPACE));
  assert.equal(serverJson.name, packageJson.mcpName);
});

// AC-2: the declared schema. Full validation is a CI step running mcp-publisher.

test("AC-2 the committed server.json declares the schema these checks were written for", () => {
  assert.equal(committed().serverJson.$schema, SCHEMA_URL);
});

// AC-3: one version everywhere.

test("AC-3 accepts one version everywhere, with and without a release tag", () => {
  assert.deepEqual(checkRegistryMetadata(inputs()), []);
  assert.deepEqual(checkRegistryMetadata(inputs({ tag: "v1.2.3" })), []);
});

test("AC-3 names the value of each source that disagrees", () => {
  const cases: [string, RegistryInputs][] = [
    ["server.json version", inputs({ serverJson: { version: "9.9.9" } })],
    ["server.json package version", inputs({ npmPackage: { version: "9.9.9" } })],
    ["package.json version", inputs({ packageJson: { version: "9.9.9" } })],
    ["SERVER_VERSION", inputs({ serverVersion: "9.9.9" })],
    ["release tag", inputs({ tag: "v9.9.9" })],
  ];
  for (const [source, input] of cases) {
    const problems = checkRegistryMetadata(input);
    assert.ok(problems.length > 0, `${source} passed`);
    assert.match(problems.join("\n"), /9\.9\.9/, source);
  }
});

test("AC-3 rejects a release tag that is not v followed by a semantic version", () => {
  for (const tag of ["1.2.3", "release-1.2.3", "v1.2", "v1.2.3 "]) {
    assert.ok(checkRegistryMetadata(inputs({ tag })).length > 0, JSON.stringify(tag));
  }
});

test("AC-3 the committed files agree on one version", () => {
  const { readme: _readme, ...files } = committed();
  assert.deepEqual(checkRegistryMetadata(files), []);
});

// AC-5: the registry entry says the Codex CLI is a separate install.

test("AC-5 the committed description says the Codex CLI is installed separately, within 100 characters", () => {
  const description = committed().serverJson.description;
  assert.equal(typeof description, "string");
  assert.match(description as string, /Codex CLI/);
  assert.match(description as string, /separately/i);
  assert.ok((description as string).length <= 100, `${(description as string).length} characters`);
});

// AC-6: what npm actually serves.

const EXPECTED = { version: "1.2.3", mcpName: NAME };

test("AC-6 refuses a version that is not live on npm, and says so", () => {
  const reason = checkPublishedPackage(null, EXPECTED);
  assert.notEqual(reason, null);
  assert.match(reason!, /1\.2\.3/);
  assert.match(reason!, /npm/);
  assert.doesNotMatch(reason!, /mcpName/);
});

test("AC-6 refuses a published package without the expected mcpName, and says so", () => {
  for (const published of [{ version: "1.2.3" }, { version: "1.2.3", mcpName: "io.github.parisbs/other" }]) {
    const reason = checkPublishedPackage(published, EXPECTED);
    assert.notEqual(reason, null, JSON.stringify(published));
    assert.match(reason!, /mcpName/);
  }
});

test("AC-6 accepts the live version carrying the expected mcpName", () => {
  assert.equal(checkPublishedPackage({ version: "1.2.3", mcpName: NAME }, EXPECTED), null);
});

// AC-7: the downloaded publisher matches its pin.

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("AC-7 rejects a download whose SHA-256 differs from the pin, naming both digests", () => {
  const data = new TextEncoder().encode("not the publisher");
  const expected = "0".repeat(64);
  assert.throws(
    () => verifySha256(data, expected),
    (error: Error) => error.message.includes(expected) && error.message.includes(sha256(data)),
  );
});

test("AC-7 accepts a download matching the pin", () => {
  const data = new TextEncoder().encode("the publisher");
  assert.doesNotThrow(() => verifySha256(data, sha256(data)));
});

test("AC-7 pins a released version and a SHA-256 digest for the Linux x64 archive", () => {
  assert.match(MCP_PUBLISHER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(MCP_PUBLISHER_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(MCP_PUBLISHER_ASSET, "mcp-publisher_linux_amd64.tar.gz");
});

// AC-8: the variables a client is offered are the ones the README documents.

test("AC-8 reads the variables from the README's configuration table only", () => {
  const readme = [
    "## Install",
    "",
    "| Variable | Effect |",
    "| --- | --- |",
    "| `NOT_CONFIGURATION` | Elsewhere. |",
    "",
    "## Configuration",
    "",
    "Everything is optional.",
    "",
    "| Variable | Effect |",
    "| --- | --- |",
    "| `FIRST_VARIABLE` | One. |",
    "| `SECOND_VARIABLE` | Two, with `inline` code. |",
    "",
    "## Safety",
    "",
    "| `AFTER_CONFIGURATION` | Not in the table. |",
  ].join("\n");
  assert.deepEqual(documentedVariables(readme), ["FIRST_VARIABLE", "SECOND_VARIABLE"]);
});

test("AC-8 the committed server.json lists every documented variable, none required or secret", () => {
  const { serverJson, readme } = committed();
  const documented = documentedVariables(readme);
  assert.ok(documented.length > 0, "the README documents no variables");
  const packages = (serverJson.packages ?? []) as { environmentVariables?: Record<string, unknown>[] }[];
  const variables = packages[0]?.environmentVariables ?? [];
  assert.deepEqual(variables.map((variable) => variable.name).sort(), [...documented].sort());
  for (const variable of variables) {
    assert.notEqual(variable.isRequired, true, `${String(variable.name)} is marked required`);
    assert.notEqual(variable.isSecret, true, `${String(variable.name)} is marked secret`);
  }
});

for (const name of ["CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR", "CODEX_SUBAGENT_MAX_BACKGROUND_JOBS"]) {
  test(`AC-15 (#62) ${name} is in the README's configuration table, in server.json and in docs/CONTROL.md`, () => {
    const { serverJson, readme } = committed();
    assert.ok(documentedVariables(readme).includes(name), `the README's configuration table does not list ${name}`);
    const packages = (serverJson.packages ?? []) as { environmentVariables?: Record<string, unknown>[] }[];
    const listed = (packages[0]?.environmentVariables ?? []).map((variable) => variable.name);
    assert.ok(listed.includes(name), `server.json does not list ${name}`);
    assert.ok(readFileSync(repoFile("docs/CONTROL.md"), "utf8").includes(name), `docs/CONTROL.md does not name ${name}`);
  });
}
