import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * AC-9 of #29 with real processes: several writers appending and rotating the same log at once lose
 * and duplicate nothing. POSIX only: ADR 22 relies on POSIX appends of a short line not being
 * interleaved, and Windows documents no such guarantee, so the same assertion there would be flaky
 * rather than informative.
 */

const WRITERS = 6;
const PER_WRITER = 200;
const FIXTURE = join("test", "fixtures", "usage-writer.ts");

test("AC-9 several processes appending and rotating at once lose and duplicate no line", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-subagent-rotation-"));
  try {
    const children = Array.from({ length: WRITERS }, (_, index) =>
      spawn(process.execPath, ["--import", "tsx", FIXTURE, dir, `w${index}`, String(PER_WRITER), String(16 * 1024)], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const stderr = children.map(() => "");
    children.forEach((child, index) => child.stderr.on("data", (chunk: Buffer) => (stderr[index] += chunk.toString())));

    // Release every writer only once all of them are ready, so that their writes overlap.
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => reject(new Error(`a writer exited (${code}) before it was ready`)));
            child.stdout.once("data", () => resolve());
          }),
      ),
    );
    const exits = Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.once("close", resolve))));
    for (const child of children) child.stdin.write("go\n");
    const codes = await exits;
    codes.forEach((code, index) => assert.equal(code, 0, `writer ${index}: ${stderr[index]}`));

    const files = readdirSync(dir);
    assert.ok(files.filter((file) => /^usage-.+\.jsonl$/.test(file)).length > 1, "the writers rotated");
    const seen = new Map<string, number>();
    for (const file of files) {
      for (const text of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (text === "") continue;
        const threadId = (JSON.parse(text) as { thread_id: string }).thread_id;
        seen.set(threadId, (seen.get(threadId) ?? 0) + 1);
      }
    }
    for (let w = 0; w < WRITERS; w++) {
      for (let i = 0; i < PER_WRITER; i++) {
        assert.equal(seen.get(`w${w}-${i}`), 1, `w${w}-${i}`);
      }
    }
    assert.equal(seen.size, WRITERS * PER_WRITER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
