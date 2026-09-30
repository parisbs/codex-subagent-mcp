import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Checks for publishing this server to the official MCP Registry (#97).
 *
 * The registry hosts metadata only: `server.json` describes the npm package,
 * and the registry accepts it only if the package published on npm carries an
 * `mcpName` equal to the server's name. Everything here is a pure function so
 * the unit suite covers it; the workflows run it on the real files.
 */

/** The GitHub namespace this server publishes under; `login github-oidc` proves it. */
export const SERVER_NAMESPACE = "io.github.parisbs/";

/** The `server.json` schema these checks were written against. */
export const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/**
 * The `mcp-publisher` release the workflows download, and the SHA-256 of its
 * Linux x64 archive from that release's `registry_<version>_checksums.txt`.
 *
 * Bump both together, deliberately. The registry's guide warns that an
 * outdated publisher fails with "invalid audience" once the registry is
 * redeployed; that error means this pin is due, not that the release is wrong.
 */
export const MCP_PUBLISHER_VERSION = "1.8.1";
export const MCP_PUBLISHER_ASSET = "mcp-publisher_linux_amd64.tar.gz";
export const MCP_PUBLISHER_SHA256 = "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc";

export interface RegistryInputs {
  packageJson: Record<string, unknown>;
  serverJson: Record<string, unknown>;
  /** `SERVER_VERSION` from `src/server.ts`. */
  serverVersion: string;
  /** The release tag, `v<semver>`, when checking a release. */
  tag?: string;
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DESCRIPTION_LIMIT = 100;
/** The schema's pattern for `name`: one slash, and something on each side of it. */
const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const quote = (value: unknown): string => (value === undefined ? "nothing" : JSON.stringify(value));

/** Every disagreement between the registry metadata and the package; empty when there is none. */
export function checkRegistryMetadata(inputs: RegistryInputs): string[] {
  const { packageJson, serverJson, serverVersion, tag } = inputs;
  const problems: string[] = [];

  if (serverJson.$schema !== SCHEMA_URL) {
    problems.push(`server.json declares the schema ${quote(serverJson.$schema)}; these checks expect ${SCHEMA_URL}.`);
  }

  // AC-1: the registry matches the published package by its mcpName.
  const name = serverJson.name;
  if (typeof name !== "string" || !name.startsWith(SERVER_NAMESPACE)) {
    problems.push(`server.json name ${quote(name)} is not under the ${SERVER_NAMESPACE} namespace.`);
  } else if (!NAME_PATTERN.test(name)) {
    problems.push(`server.json name ${quote(name)} does not match the registry's pattern ${NAME_PATTERN.source}.`);
  }
  if (typeof packageJson.mcpName !== "string") {
    problems.push(`package.json has no mcpName; the registry needs it equal to server.json's name, ${quote(name)}.`);
  } else if (packageJson.mcpName !== name) {
    problems.push(`package.json mcpName ${quote(packageJson.mcpName)} differs from server.json name ${quote(name)}.`);
  }

  const description = serverJson.description;
  if (typeof description !== "string" || description.length === 0 || description.length > DESCRIPTION_LIMIT) {
    problems.push(`server.json description must be 1 to ${DESCRIPTION_LIMIT} characters; it is ${quote(description)}.`);
  }

  const packages = Array.isArray(serverJson.packages) ? serverJson.packages.filter(isRecord) : [];
  const npmPackages = packages.filter((entry) => entry.registryType === "npm");
  // One entry, or which package a client installs is ambiguous and only the
  // first would be checked below (#117).
  if (npmPackages.length !== 1) {
    problems.push(`server.json must list exactly one npm package; it lists ${npmPackages.length}.`);
  }
  const npmPackage = npmPackages[0];
  if (npmPackage) {
    if (npmPackage.identifier !== packageJson.name) {
      problems.push(
        `server.json's npm package is ${quote(npmPackage.identifier)}, not this package, ${quote(packageJson.name)}.`,
      );
    }
    const transport = isRecord(npmPackage.transport) ? npmPackage.transport.type : undefined;
    if (transport !== "stdio") {
      problems.push(`server.json's npm package uses the ${quote(transport)} transport; this server speaks stdio.`);
    }
  }

  // AC-3: one version everywhere, measured against package.json.
  const expected = packageJson.version;
  const versions: [string, unknown][] = [
    ["server.json version", serverJson.version],
    ["server.json npm package version", npmPackage?.version],
    ["SERVER_VERSION in src/server.ts", serverVersion],
  ];
  if (tag !== undefined) {
    if (RELEASE_TAG.test(tag)) versions.push(["release tag", tag.slice(1)]);
    else problems.push(`Release tag ${quote(tag)} is not v<major>.<minor>.<patch>.`);
  }
  for (const [source, version] of versions) {
    if (version !== expected) {
      problems.push(`${source} is ${quote(version)}; package.json version is ${quote(expected)}.`);
    }
  }

  return problems;
}

/** What `npm view <name>@<version> version mcpName --json` reported; null when the version is not on npm. */
export interface PublishedPackage {
  version?: string;
  mcpName?: string;
}

/**
 * Why the registry would refuse this release, or null when it would not: the
 * version must be live on npm, and its published `package.json` must carry the
 * expected `mcpName`.
 */
export function checkPublishedPackage(
  published: PublishedPackage | null,
  expected: { version: string; mcpName: string },
): string | null {
  if (published === null || published.version !== expected.version) {
    return (
      `Version ${expected.version} is not live on npm. Approve the staged release first ` +
      "(npm stage approve, or on npmjs.com), then run this workflow again."
    );
  }
  if (published.mcpName === undefined) {
    return (
      `Version ${expected.version} is live on npm, but its package.json has no mcpName; ` +
      `the registry needs ${JSON.stringify(expected.mcpName)}. Only a release that carries it can be listed.`
    );
  }
  if (published.mcpName !== expected.mcpName) {
    return (
      `Version ${expected.version} is live on npm with mcpName ${JSON.stringify(published.mcpName)}, ` +
      `not ${JSON.stringify(expected.mcpName)}.`
    );
  }
  return null;
}

/** The variable names in the README's configuration table. */
export function documentedVariables(readme: string): string[] {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Configuration\s*$/.test(line));
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (row) names.push(row[1]!);
  }
  return names;
}

/** Throws, naming both digests, unless `data` hashes to `expected` with SHA-256. */
export function verifySha256(data: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}. Refusing to run the download.`);
  }
}

// ---------------------------------------------------------------------------
// Command line, as the workflows run it:
//
//   check-registry.ts metadata [--root <dir>] [--tag <tag>]
//   check-registry.ts published --tag <tag> [--root <dir>]
//   check-registry.ts install-publisher <dir>

interface Files extends RegistryInputs {
  readme: string;
}

function readFiles(root: string, tag?: string): Files {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const serverJsonPath = join(root, "server.json");
  const source = read("src/server.ts");
  return {
    packageJson: JSON.parse(read("package.json")),
    serverJson: existsSync(serverJsonPath) ? JSON.parse(readFileSync(serverJsonPath, "utf8")) : {},
    serverVersion: /export const SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(source)?.[1] ?? "",
    readme: read("README.md"),
    ...(tag === undefined ? {} : { tag }),
  };
}

/** AC-8: the variables `server.json` offers are the ones the README documents. */
function variableProblems(files: Files): string[] {
  const documented = documentedVariables(files.readme);
  const packages = Array.isArray(files.serverJson.packages) ? files.serverJson.packages.filter(isRecord) : [];
  const listed = packages.find((entry) => entry.registryType === "npm")?.environmentVariables;
  const variables = Array.isArray(listed) ? listed.filter(isRecord) : [];
  const names = variables.map((variable) => variable.name);
  const problems: string[] = [];
  for (const name of documented) {
    if (!names.includes(name)) problems.push(`server.json does not list ${name}, which the README documents.`);
  }
  for (const variable of variables) {
    if (!documented.includes(variable.name as string)) {
      problems.push(`server.json lists ${quote(variable.name)}, which the README's configuration table does not.`);
    }
    if (variable.isRequired === true || variable.isSecret === true) {
      problems.push(`server.json marks ${quote(variable.name)} required or secret; every variable is optional.`);
    }
  }
  return problems;
}

/** What npm serves for this version; null on a 404. Any other npm failure throws. */
function viewPublished(name: string, version: string): PublishedPackage | null {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "mcpName", "--json"], {
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    if (/E404/.test(`${result.stdout}${result.stderr}`)) return null;
    throw new Error(`npm view failed (exit ${result.status}): ${result.error?.message ?? result.stderr}`);
  }
  const text = result.stdout.trim();
  if (text === "") return null;
  // With one field present npm prints it bare; with both, an object.
  const value: unknown = JSON.parse(text);
  if (typeof value === "string") return { version: value };
  if (!isRecord(value)) return null;
  return {
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.mcpName === "string" ? { mcpName: value.mcpName } : {}),
  };
}

async function installPublisher(directory: string): Promise<string> {
  const url =
    `https://github.com/modelcontextprotocol/registry/releases/download/` +
    `v${MCP_PUBLISHER_VERSION}/${MCP_PUBLISHER_ASSET}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}.`);
  const archive = new Uint8Array(await response.arrayBuffer());
  // AC-7: nothing downloaded is written to disk, let alone run, before this.
  verifySha256(archive, MCP_PUBLISHER_SHA256);
  mkdirSync(directory, { recursive: true });
  const archivePath = join(directory, MCP_PUBLISHER_ASSET);
  writeFileSync(archivePath, archive);
  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", directory, "mcp-publisher"], {
    shell: false,
    encoding: "utf8",
  });
  if (extracted.status !== 0) throw new Error(`Extracting ${archivePath} failed: ${extracted.stderr}`);
  return join(directory, "mcp-publisher");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(problems: string[]): void {
  for (const problem of problems) console.error(`check-registry: ${problem}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = resolve(option(args, "--root") ?? ".");
  const tag = option(args, "--tag");

  if (command === "metadata") {
    const files = readFiles(root, tag);
    const problems = [...checkRegistryMetadata(files), ...variableProblems(files)];
    if (problems.length > 0) return fail(problems);
    console.log(`Registry metadata for ${String(files.serverJson.name)} ${String(files.packageJson.version)} agrees.`);
    return;
  }

  if (command === "published") {
    if (tag === undefined || !RELEASE_TAG.test(tag)) return fail([`published needs --tag v<version>; got ${quote(tag)}.`]);
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const serverJsonPath = join(root, "server.json");
    const serverJson = existsSync(serverJsonPath)
      ? (JSON.parse(readFileSync(serverJsonPath, "utf8")) as Record<string, unknown>)
      : {};
    // The name the registry will ask npm for is server.json's, when the tag has one.
    const mcpName = typeof serverJson.name === "string" ? serverJson.name : `${SERVER_NAMESPACE}${String(packageJson.name)}`;
    const version = tag.slice(1);
    const reason = checkPublishedPackage(viewPublished(String(packageJson.name), version), { version, mcpName });
    if (reason) return fail([reason]);
    console.log(`${String(packageJson.name)}@${version} is live on npm with mcpName ${mcpName}.`);
    return;
  }

  if (command === "install-publisher") {
    const directory = args[0];
    if (!directory) return fail(["install-publisher needs a directory."]);
    console.log(await installPublisher(resolve(directory)));
    return;
  }

  fail([`unknown command ${quote(command)}; expected metadata, published or install-publisher.`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => fail([error instanceof Error ? error.message : String(error)]));
}
