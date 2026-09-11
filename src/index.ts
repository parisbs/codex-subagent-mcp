#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

async function main(): Promise<void> {
  const { server, jobs } = createServer();

  const shutdown = (signal: NodeJS.Signals): void => {
    // Background delegations are child processes; leaving them behind would
    // keep burning quota with nobody reading the result.
    jobs.cancelAll();
    void server.close().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the JSON-RPC stream, so all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error("Fatal error starting the codex-subagent MCP server:", error);
  process.exit(1);
});
