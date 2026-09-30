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

/** Every disagreement between the registry metadata and the package; empty when there is none. */
export function checkRegistryMetadata(inputs: RegistryInputs): string[] {
  void inputs;
  throw new Error("not implemented");
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
  void published;
  void expected;
  throw new Error("not implemented");
}

/** The variable names in the README's configuration table. */
export function documentedVariables(readme: string): string[] {
  void readme;
  throw new Error("not implemented");
}

/** Throws, naming both digests, unless `data` hashes to `expected` with SHA-256. */
export function verifySha256(data: Uint8Array, expected: string): void {
  void data;
  void expected;
  throw new Error("not implemented");
}
