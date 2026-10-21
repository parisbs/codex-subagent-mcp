---
paths:
  - "CHANGELOG.md"
  - "server.json"
  - "docs/VERSIONING.md"
  - ".github/workflows/{publish,registry}.yml"
  - "scripts/check-registry.ts"
---

# Releases

- A `release/X.Y.Z` branch only prepares a release: the documentation pass, the changelog and the
  version bump in `package.json`, `package-lock.json`, `SERVER_VERSION` and both fields of
  `server.json`. It is squash-merged like any branch and deleted once the release is published; the
  annotated tag `vX.Y.Z` records the published state.
- Pushing the tag runs `.github/workflows/publish.yml`, which stages the release with npm
  provenance for a maintainer to approve. Staging is not publishing.
- The MCP Registry entry follows the npm approval, by hand: once the release is live, run
  `.github/workflows/registry.yml` with the tag. The registry checks `server.json` against the
  package npm serves, so it refuses a version that is only staged or lacks `mcpName`; the workflow
  checks both first. The `mcp-publisher` version and its SHA-256 are pinned together in
  `scripts/check-registry.ts`; "invalid audience" from the registry means that pin is due.
- A release records the Codex CLI version it was verified against, after `/smoke-test` passes.
