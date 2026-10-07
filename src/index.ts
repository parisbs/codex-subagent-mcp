#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { createShutdown, installShutdownTriggers } from "./shutdown.js";
import { whenUsageIdle } from "./usage.js";

async function main(): Promise<void> {
  const { server, jobs, runs } = createServer();

  // Delegations are child processes; leaving them behind would keep burning
  // quota with nobody reading the result. See `src/shutdown.ts` for the budget.
  const shutdown = createShutdown({
    runs,
    jobs,
    drain: whenUsageIdle,
    close: () => server.close(),
    exit: (code) => process.exit(code),
    log: (message) => console.error(message),
  });
  installShutdownTriggers(shutdown, { process, stdin: process.stdin });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the JSON-RPC stream, so all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error("Fatal error starting the codex-subagent MCP server:", error);
  process.exit(1);
});
