/**
 * Prompt assembly for delegated tasks.
 *
 * The orchestrator (Claude Code) works under an explicit set of quality rules.
 * A delegated subagent that does not share them produces work the orchestrator
 * then has to redo, so the contract below is prepended to every delegation.
 * It is injected into the prompt rather than written to an `AGENTS.md` file so
 * the server never mutates the target repository.
 */
export const QUALITY_CONTRACT = `<delegation_contract>
You are running as a delegated subagent inside another agent's workflow. The
orchestrator will act on your answer, so these rules are not optional.

Scope
- Deliver exactly the scope described in <task>. Do not silently narrow, widen,
  or transform it. If part of it is blocked, complete everything else and state
  plainly what you left out and why.
- Do not make unrelated "improvements" to files you touch.

Truthfulness
- Verify before you assert. Read the actual file, run the actual command.
- Never invent files, functions, flags, APIs, or command output. If you did not
  check something, say so.
- Report failures faithfully. If a test fails or a build breaks, say so and
  include the real output. Do not claim success you did not observe.

Code
- Match the surrounding code's style, naming, and comment density.
- Write code, comments, identifiers, and documentation in English.
- Reuse existing helpers instead of adding near-duplicates.

Safety
- Do not run destructive commands (no recursive deletes outside build output,
  no force pushes, no history rewrites).
- Do not create commits, branches, tags, or any other git write operation unless
  the task explicitly asks for it.
- Do not install global tooling or change machine-level configuration.

Reporting
- End with a short, concrete summary: what you changed (file by file), what you
  verified and how, and anything the orchestrator must decide or double-check.
- Be concise. No preamble, no restating the task back.
</delegation_contract>`;

/**
 * A second layer against recursive delegation for configurations the server
 * could not enumerate. This is an instruction to the model, not a technical
 * control; the MCP configuration override in `src/codex/mcp.ts` is the control.
 */
export const NO_FURTHER_DELEGATION_INSTRUCTION = `<delegation_instruction>
Instruction: you are a delegated subagent. Do not delegate work to other agents
and do not call tools that delegate work further.
</delegation_instruction>`;

export interface PromptParts {
  task: string;
  systemInstructions?: string;
  context?: string;
  targetFiles?: string[];
  acceptanceCriteria?: string[];
  /** Set when the orchestrator wants Codex to only analyse and report. */
  readOnly?: boolean;
}

function section(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

/**
 * Assembles the full prompt handed to Codex over stdin.
 *
 * Order matters: the contract first (it constrains everything that follows),
 * then the no-further-delegation instruction and execution mode, then
 * orchestrator instructions and context, and the task last so it stays closest
 * to the model's generation point.
 */
export function assemblePrompt(parts: PromptParts): string {
  const blocks: string[] = [QUALITY_CONTRACT, NO_FURTHER_DELEGATION_INSTRUCTION];

  if (parts.readOnly) {
    blocks.push(
      section(
        "execution_mode",
        "You are running in a read-only sandbox. You cannot modify files. " +
          "Investigate and report; when a change is needed, describe it precisely " +
          "(file, location, and the exact code) instead of attempting to apply it. " +
          "Commands that need to write temporary, cache, or build files may fail because the " +
          "sandbox denies those writes. When a command fails specifically for that reason, report " +
          "that the verification could not be completed; do not report the sandbox-caused failure " +
          "as a defect in the code. Do not dismiss permission failures that are themselves the " +
          "behaviour under investigation. Shell commands have no network access in this mode. " +
          "When the task needs current external information, use the web-search tool if it is " +
          "enabled for this run.",
      ),
    );
  }

  if (parts.systemInstructions?.trim()) {
    blocks.push(section("orchestrator_instructions", parts.systemInstructions));
  }

  if (parts.context?.trim()) {
    blocks.push(section("context", parts.context));
  }

  if (parts.targetFiles && parts.targetFiles.length > 0) {
    blocks.push(
      section(
        "target_files",
        `Focus on these paths:\n${parts.targetFiles.map((file) => `- ${file}`).join("\n")}`,
      ),
    );
  }

  if (parts.acceptanceCriteria && parts.acceptanceCriteria.length > 0) {
    blocks.push(
      section(
        "acceptance_criteria",
        `The task is done only when all of these hold:\n${parts.acceptanceCriteria
          .map((criterion, index) => `${index + 1}. ${criterion}`)
          .join("\n")}`,
      ),
    );
  }

  blocks.push(section("task", parts.task));

  return blocks.join("\n\n");
}
