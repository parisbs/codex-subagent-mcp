# 4. Invoke the CLI with argv and deliver the prompt on stdin

Status: Accepted

## Context

The prototype built a command string by concatenation and ran it through `exec()`, which runs it in
a shell:

```js
const safePrompt = assembledPrompt.replace(/"/g, '\\"');
command += ` "${safePrompt}"`;
await execAsync(command);
```

Escaping only double quotes is not sufficient. A prompt containing `` ` ``, `$(...)`, or a newline
breaks out of the quoted string and executes in the user's shell. Prompts are not trusted input:
they carry file contents, error messages, issue text and anything else the orchestrator gathered.
This was a command-injection hole reachable through ordinary use.

Two further problems came from the same call. `exec()` buffers output with a 1 MB default
`maxBuffer`, so a long delegation fails with a buffer error after doing all the work. And with no
timeout, a hung Codex process blocks the MCP server indefinitely.

The CLI documents that when no positional prompt is given, instructions are read from stdin. That
was verified against codex-cli 0.154.0.

## Decision

Invoke the CLI with `spawn(codexPath, argv, { shell: false })` and write the assembled prompt to the
child's stdin, closing the stream. The prompt never appears on the argv.

Parse stdout incrementally as JSON Lines rather than buffering it, and enforce a wall-clock timeout
with SIGTERM escalating to SIGKILL after a grace period.

## Consequences

Shell metacharacters in the prompt, in `working_dir` or in any path are inert: there is no shell to
interpret them. This is covered by tests asserting the prompt never reaches the argv and that a
hostile working directory survives as a single argv entry, and was confirmed end to end with a
prompt containing `$(touch ...)`.

Prompt size is bounded by the pipe, not by a 1 MB buffer, and output is consumed as it arrives.

Streaming the JSONL is also what makes progress reporting possible: each parsed event becomes an MCP
progress notification, which is what keeps the client from timing out a long delegation.

The cost is more code than a single `exec()` call: a line-buffering parser that tolerates chunk
boundaries falling mid-line, plus explicit child-process lifecycle handling. Both are covered by
tests, including a stream fed seven characters at a time.
