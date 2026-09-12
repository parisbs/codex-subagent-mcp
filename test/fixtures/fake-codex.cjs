/**
 * A stand-in for the Codex CLI, used to exercise the full delegation cycle on
 * every platform.
 *
 * It is copied into a temporary directory under the name `exec`, and the runner
 * is pointed at `process.execPath` with that directory as the child's cwd. The
 * argv the server builds always starts with `exec`, so Node runs this file as
 * the entry point and the remaining Codex flags land in `process.argv`.
 *
 * That indirection exists because the obvious approach does not work on
 * Windows: a shebang script is not executable there, and a `.cmd` shim is
 * rejected by `src/codex/resolve.ts` by design. Node itself is a real
 * executable on all three platforms, which is what makes this portable.
 *
 * The file has no extension on purpose, so `package.json` in the temporary
 * directory pins it to CommonJS regardless of what any ancestor declares.
 */
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const scenario = JSON.parse(readFileSync(join(process.cwd(), "scenario.json"), "utf8"));

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});

process.stdin.on("end", () => {
  // Record what actually arrived, so a test can assert on the argv the server
  // built and on the prompt surviving stdin byte for byte.
  writeFileSync(
    join(process.cwd(), "received.json"),
    JSON.stringify({ argv: process.argv.slice(2), stdin }, null, 2),
    "utf8",
  );

  if (scenario.stderr) {
    process.stderr.write(scenario.stderr);
  }

  const chunks = scenario.chunks ?? [];
  let index = 0;

  const writeNext = () => {
    if (index >= chunks.length) {
      // Setting the code rather than calling process.exit() lets the pending
      // stdout writes drain; process.exit() would truncate them.
      process.exitCode = scenario.exitCode ?? 0;
      return;
    }
    const chunk = chunks[index++];
    process.stdout.write(chunk, () => {
      if (scenario.chunkDelayMs) {
        setTimeout(writeNext, scenario.chunkDelayMs);
      } else {
        writeNext();
      }
    });
  };

  writeNext();
});
