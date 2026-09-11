# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/parisbs/codex-subagent-mcp/security/advisories/new).
Do not open a public issue for a vulnerability.

Please include what an attacker can do, how to reproduce it, and the versions involved — this server
and the Codex CLI. Expect an initial response within a week. This is a personal project, not a
funded one, so there is no bounty and no formal SLA beyond that.

## What this server actually does

Understanding the threat model matters more here than in most packages, because this server exists
to run another program on your machine.

It spawns the local Codex CLI as a child process. Depending on the `sandbox` argument that Codex
receives, that child can read your files, run shell commands, and modify your working tree. The
server holds no credentials of its own: authentication is whatever your existing `codex login`
already granted.

### What the sandbox does and does not cover

Measured against codex-cli 0.154.0 on macOS, where Codex confines the child process with seatbelt,
the operating system's own sandbox. The model cannot talk its way out of it.

| | `read-only` | `workspace-write` | `danger-full-access` |
| --- | --- | --- | --- |
| Write inside the working directory | no | yes | yes |
| Write outside it (your home) | no | **no** | yes |
| Network access | no | **no** | yes |
| **Read outside the working directory** | **yes** | **yes** | yes |

The last row is the one that surprises people, so it is stated plainly: **the sandbox restricts
writes and network access, not reads.** Under `workspace-write`, reading `~/.codex/auth.json`
succeeds. Codex can read files anywhere your user account can.

Network access being blocked means Codex cannot send what it reads anywhere. But its final report
comes back to the orchestrator, and that is a channel. A delegation whose prompt was assembled from
untrusted content could, even read-only, be directed to read something sensitive and include it in
its answer.

Defaults are chosen accordingly:

- **`read-only` is the default sandbox.** Writing requires an explicit `sandbox: "workspace-write"`.
- **`auto_approve` is off by default**, and is ignored under a read-only sandbox.
- **`danger-full-access` is never combined with auto-approval.** An unsandboxed run that also
  approves its own commands has no check left.
- **`use_worktree`** confines writes to a managed git worktree rather than your working tree.

## Injection

The prompt is written to the child's stdin and never placed on the command line, and the CLI is
spawned with an argv array and `shell: false`. There is no shell in the path, so shell
metacharacters in a prompt, a working directory or any other argument are inert. This is covered by
tests, and was confirmed end to end with a prompt containing `$(...)`, backticks and quotes.

This is also why a Windows `.cmd` shim is refused rather than executed through a command shell. See
[ADR 11](docs/adr/0011-resolve-the-executable-without-a-shell.md).

## What is not defended against

Stated plainly, because a security policy that implies more coverage than it has is worse than none:

- **A prompt is untrusted input, and Codex acts on it.** If you delegate with
  `sandbox: "workspace-write"`, a prompt built from untrusted content — a web page, an issue body, a
  file from elsewhere — can direct Codex to modify your repository. The sandbox bounds where it can
  write; it does not judge what it should write. Treat write-enabled delegation the way you would
  treat running a script someone sent you.

  This one is mitigable. Setting `CODEX_SUBAGENT_MAX_SANDBOX=read-only` on the MCP server makes
  write-enabled delegation impossible rather than merely unlikely, and no argument passed by the
  caller can override it. It is the one control that cannot be expressed per call, because a caller
  can always pass different arguments.
- **Reads are not confined to the working directory.** See the table above. `CODEX_SUBAGENT_MAX_SANDBOX`
  does not help here; it caps writes.

  There is a real mitigation, but it is not ours to apply. The Codex CLI's schema includes a
  `filesystem.deny_read` list within its managed requirements, read from `/etc/codex/requirements.toml`
  — machine-wide configuration that needs administrator access. It cannot be set per invocation, so
  this server cannot apply it on your behalf, and it would be wrong for it to try. If reads are a
  concern for you, that file is where to look. Note that we located this in the CLI's configuration
  schema but did not verify it working, because doing so would have meant altering a machine's
  global configuration.

  The mitigations that do not depend on that: do not build delegation prompts from untrusted content
  when the answer will be acted on, and if the threat matters seriously, run Codex under an account
  or container that has no access to the secrets in the first place.

- **Delegation output is not sanitised.** What Codex returns is passed back to the orchestrator as
  text. Treat it as data.
- **The server trusts the Codex CLI.** If your Codex installation is compromised, so is this.
- **`danger-full-access` removes the sandbox.** It is available because it is sometimes necessary;
  it is not defended.

## Supported versions

The latest release is the supported one. Fixes go to `main` and ship in the next version.
