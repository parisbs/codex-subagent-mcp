/**
 * One writer process for the multi-process rotation test (#29, AC-9).
 *
 * Usage: node --import tsx usage-writer.ts <dir> <tag> <count> <maxBytes>
 *
 * Prints "ready" and waits for a line on stdin before writing, so that the test can release every
 * writer at once. Exits 2, after printing the reason, when an entry is not written.
 */
import { appendUsageEntry, type UsageEntry } from "../../src/usage.ts";

const [dir, tag, count, maxBytes] = process.argv.slice(2);
if (!dir || !tag || !count || !maxBytes) {
  console.error("usage: usage-writer.ts <dir> <tag> <count> <maxBytes>");
  process.exit(1);
}

function entry(threadId: string): UsageEntry {
  return {
    schema: 1,
    ended_at: new Date().toISOString(),
    duration_ms: 1000,
    kind: "delegation",
    mode: "blocking",
    thread_id: threadId,
    label: null,
    requested: { model: "m1", effort: "low", sandbox: "read-only" },
    applied: { model: "m1", effort: "low", sandbox: "read-only" },
    flags: { use_worktree: false, target_files: false, acceptance_criteria: false, output_schema: false },
    commands: 1,
    tokens: { input: 100, cached: 40, output: 10, reasoning: 2, uncached: 60 },
    outcome: "success",
    sandbox_ceiling: "workspace-write",
    server_version: "0.5.0",
    cli_version: "0.160.1",
  };
}

process.stdout.write("ready\n");
process.stdin.once("data", async () => {
  for (let i = 0; i < Number(count); i++) {
    const result = await appendUsageEntry(dir, entry(`${tag}-${i}`), {
      maxBytes: Number(maxBytes),
      // Retention far above what the test writes: pruning is tested elsewhere, and here every line must survive.
      maxArchiveBytes: 1024 * 1024 * 1024,
    });
    if (!result.written) {
      console.error(`${tag}-${i}: ${result.error}`);
      process.exit(2);
    }
  }
  process.exit(0);
});
