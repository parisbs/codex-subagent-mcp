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

const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const scenario = JSON.parse(readFileSync(join(process.cwd(), "scenario.json"), "utf8"));

let stdin = "";

/** Everything the stand-in does once the prompt has arrived on stdin. */
function run() {
  // Record what actually arrived, so a test can assert on the argv the server
  // built and on the prompt surviving stdin byte for byte.
  // What `--output-schema` pointed at, read the way the real CLI would (#28).
  const argv = process.argv.slice(2);
  const schemaAt = argv.indexOf("--output-schema");
  let schema = null;
  if (schemaAt !== -1) {
    try {
      schema = readFileSync(argv[schemaAt + 1], "utf8");
    } catch (error) {
      schema = `unreadable: ${error.message}`;
    }
  }
  writeFileSync(
    join(process.cwd(), "received.json"),
    JSON.stringify({ argv, stdin, schema }, null, 2),
    "utf8",
  );

  // A descendant started before any output, standing in for a command Codex
  // runs. Its pid is recorded so a test can check whether it outlived the run.
  if (scenario.descendant) {
    const { holdMs, holdPipes, ignoreSigterm, keepWriting, ownGroup } = scenario.descendant;
    const ignore = ignoreSigterm ? 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});' : "";
    // `descendant.ready` says its signal handlers are in place: until then a
    // signal it is meant to ignore still ends it (#169).
    const ready = 'try { require("node:fs").writeFileSync(process.argv[1], ""); } catch {}';
    // Events as fast as the pipe takes them, until the reader goes away (#172).
    const write = keepWriting
      ? 'process.stdout.on("error", () => {});' +
        ' const lines = (JSON.stringify({ type: "descendant.output" }) + "\\n").repeat(32);' +
        " const next = () => process.stdout.write(lines, (error) => { if (!error) setImmediate(next); });" +
        " next();"
      : "";
    const body = `${ignore} ${ready} ${write} setTimeout(() => {}, ${Number(holdMs)});`;
    const descendant = spawn(process.execPath, ["-e", body, join(process.cwd(), "descendant.ready")], {
      shell: false,
      stdio: holdPipes ? ["ignore", process.stdout, process.stderr] : "ignore",
      cwd: tmpdir(),
      // The real CLI starts each command as the leader of a process group of
      // its own, out of reach of a signal to the CLI's group (#107).
      detached: Boolean(ownGroup),
    });
    writeFileSync(join(process.cwd(), "descendant.pid"), String(descendant.pid), "utf8");
    descendant.unref();
  }

  // Records which termination signals arrive, then exits the way Node would.
  if (scenario.recordSignals) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        appendFileSync(join(process.cwd(), "signals.log"), `${signal}\n`, "utf8");
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

  // A CLI that does not stop when asked: only the forced stage can end it.
  if (scenario.ignoreSigterm) {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
  }

  // How the stand-in answers a polite termination request, where the platform
  // has one: it reports once more and exits, as the real CLI may.
  if (scenario.onStop) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        process.stdout.write((scenario.onStop.chunks ?? []).join(""), () => {
          process.exit(scenario.onStop.exitCode ?? 0);
        });
      });
    }
  }

  const chunks = scenario.chunks ?? [];
  let index = 0;
  let stderrWritten = !scenario.stderr;
  let stdoutWritten = false;

  // `output.written` says all of the output has been handed to the pipes,
  // where the server can read it (#172).
  const markWritten = () => {
    if (scenario.holdOutput && stderrWritten && stdoutWritten) {
      writeFileSync(join(process.cwd(), "output.written"), "", "utf8");
    }
  };

  const writeNext = () => {
    if (index >= chunks.length) {
      stdoutWritten = true;
      markWritten();
      if (scenario.stayRunning) {
        // Keep working until terminated, like a turn that has not finished.
        setInterval(() => {}, 1000);
        return;
      }
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

  const output = () => {
    if (scenario.stderr) {
      process.stderr.write(scenario.stderr, () => {
        stderrWritten = true;
        markWritten();
      });
    }
    writeNext();
  };

  // Output the server must not have read when its run settles (#172): nothing
  // is written until the test creates `output.go`, which it does only once it
  // has stopped letting the server's event loop run.
  if (scenario.holdOutput) {
    const release = () => (existsSync(join(process.cwd(), "output.go")) ? output() : setTimeout(release, 5));
    release();
  } else {
    output();
  }
}

function start() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdin += chunk;
  });
  process.stdin.on("end", run);
}

// A slow process start, as on a loaded machine (#169): until the delay has
// passed the stand-in reads nothing, installs no signal handler, writes no
// file, starts no descendant and writes no output.
if (scenario.startDelayMs) {
  setTimeout(start, scenario.startDelayMs);
} else {
  start();
}
