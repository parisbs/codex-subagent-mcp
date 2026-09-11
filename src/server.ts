import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { findModel, getCatalog, resolveEffort } from "./codex/catalog.js";
import {
  ENV_PREFIX,
  capEffort,
  checkModel,
  checkSandbox,
  impliedModel,
  loadConfig,
  type ServerConfig,
} from "./config.js";
import {
  formatDiagnosis,
  isUsable,
  runDoctor,
  type Diagnosis,
} from "./codex/doctor.js";
import type { CodexEvent } from "./codex/events.js";
import { DEFAULT_TIMEOUT_SECONDS, runCodex } from "./codex/runner.js";
import type { CodexInvocation } from "./codex/args.js";
import { JobRegistry } from "./jobs.js";
import { assemblePrompt } from "./prompt.js";
import { recommend, type Priority } from "./recommend.js";
import {
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type DelegationResult,
  type ReasoningEffort,
  type SandboxMode,
} from "./types.js";

export const SERVER_NAME = "codex-subagent";
export const SERVER_VERSION = "0.1.0";

const effortSchema = z.enum(REASONING_EFFORTS);
const sandboxSchema = z.enum(SANDBOX_MODES);
const prioritySchema = z.enum(["quality", "balanced", "latency", "cost"]);

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(message, true);
}

/**
 * Raised when the local Codex CLI cannot serve a request. Carries the full
 * diagnosis so the tool can hand back installation steps instead of a bare
 * "spawn ENOENT", which tells the user nothing actionable.
 */
class CodexUnavailableError extends Error {
  constructor(readonly diagnosis: Diagnosis) {
    super(formatDiagnosis(diagnosis));
    this.name = "CodexUnavailableError";
  }
}

/**
 * Preflight run before anything that needs the CLI.
 *
 * Every tool goes through this, so a missing or signed-out Codex is reported
 * once, clearly, with the steps to fix it — rather than surfacing as a
 * different cryptic failure per tool.
 */
async function requireUsableCodex(): Promise<Diagnosis> {
  const diagnosis = await runDoctor();
  if (!isUsable(diagnosis)) {
    throw new CodexUnavailableError(diagnosis);
  }
  return diagnosis;
}

/** Rejects working directories that do not exist, before spending a model call. */
function validateWorkingDir(dir: string | undefined): void {
  if (!dir) return;
  if (!isAbsolute(dir)) {
    throw new Error(`working_dir must be an absolute path; received "${dir}".`);
  }
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new Error(`working_dir does not exist: ${dir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`working_dir is not a directory: ${dir}`);
  }
}

/**
 * A delegation failed if Codex exited non-zero or was killed for running past
 * its budget. A timeout leaves `exitCode` null (the process died on a signal),
 * so it has to be checked separately.
 */
function isFailure(result: DelegationResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Renders a finished delegation as the text the orchestrator reads. */
function renderResult(result: DelegationResult, notes: string[]): string {
  const lines: string[] = [];

  if (notes.length > 0) {
    lines.push(`Notes: ${notes.join(" ")}`, "");
  }

  if (result.errors.length > 0) {
    lines.push(
      `Codex reported ${result.errors.length} error(s):`,
      ...result.errors.map((message) => `- ${message}`),
      "",
    );
  }

  if (result.timedOut) {
    lines.push(
      "The delegation was terminated because it exceeded its timeout. Partial output follows.",
      "",
    );
  } else if (result.exitCode !== 0) {
    lines.push(
      `Codex exited with code ${result.exitCode}.` +
        (result.stderr ? ` stderr: ${result.stderr}` : ""),
      "",
    );
  }

  lines.push(
    result.finalMessage.trim().length > 0
      ? result.finalMessage.trim()
      : "(Codex produced no final message.)",
  );

  if (result.fileChanges.length > 0) {
    lines.push("", `Files changed (${result.fileChanges.length}):`);
    for (const change of result.fileChanges) {
      lines.push(`- [${change.kind}] ${change.path}`);
    }
  }

  if (result.commands.length > 0) {
    lines.push("", `Commands run (${result.commands.length}):`);
    for (const command of result.commands) {
      lines.push(`- [exit ${command.exitCode ?? "?"}] ${command.command}`);
    }
  }

  const meta: string[] = [
    `model=${result.model ?? "default"}`,
    `effort=${result.reasoningEffort ?? "default"}`,
    `sandbox=${result.sandbox}`,
    `duration=${formatDuration(result.durationMs)}`,
  ];
  if (result.usage) {
    meta.push(
      `tokens=in ${result.usage.inputTokens} (cached ${result.usage.cachedInputTokens}) / out ${result.usage.outputTokens} (reasoning ${result.usage.reasoningOutputTokens})`,
    );
  }
  if (result.threadId) {
    meta.push(`thread_id=${result.threadId}`);
  }
  lines.push("", meta.join(" | "));

  if (result.threadId) {
    lines.push(
      `Continue this session with codex_follow_up using thread_id "${result.threadId}".`,
    );
  }

  return lines.join("\n");
}

/**
 * Raised when no model was specified and none can be chosen without guessing.
 *
 * This is deliberately not a fallback. Which model a task deserves depends on
 * budget and on how much a wrong answer costs — things this server cannot know.
 * Rather than decide silently and bill the user for that decision, it refuses
 * and hands back the recommendation it would have made, so the caller can
 * choose in one more round trip.
 */
class ModelRequiredError extends Error {}

/**
 * Resolves the model and effort for a delegation.
 *
 * Order of precedence: what the caller asked for, then what the user configured,
 * then — only if an allow-list leaves exactly one possibility — that. Otherwise
 * this refuses.
 */
async function resolveModelAndEffort(
  requestedModel: string | undefined,
  requestedEffort: ReasoningEffort | undefined,
  taskDescription: string,
  config: ServerConfig,
): Promise<{ model: string; effort: ReasoningEffort; notes: string[] }> {
  const diagnosis = await requireUsableCodex();
  const catalog = await getCatalog();
  const notes: string[] = [];
  if (diagnosis.status === "unverified-version") notes.push(diagnosis.summary);
  if (catalog.warning) notes.push(catalog.warning);

  const chosen = requestedModel ?? impliedModel(config);

  if (!chosen) {
    const suggestion = recommend(catalog, taskDescription, "balanced", config.allowedModels);
    throw new ModelRequiredError(
      `No model was specified, and this server does not choose one for you — which model a task ` +
        `deserves depends on your budget and on how costly a wrong answer is.\n\n` +
        `For this task the suggestion would be: model "${suggestion.model}" at reasoning effort ` +
        `"${suggestion.reasoningEffort}" (${suggestion.tier} tier). ${suggestion.rationale}\n\n` +
        `Call again with an explicit model, or set ${ENV_PREFIX}DEFAULT_MODEL in the MCP server ` +
        `configuration to skip this. Use list_codex_models to see every option.`,
    );
  }

  const allowed = checkModel(chosen, config);
  if (!allowed.ok) throw new Error(allowed.reason);

  const model = findModel(catalog, chosen);
  if (!model) {
    throw new Error(
      `Unknown model "${chosen}". Available models: ` +
        `${catalog.models.map((entry) => entry.slug).join(", ")}. ` +
        "Call list_codex_models for the current catalog.",
    );
  }

  if (!requestedModel) {
    notes.push(`No model was specified; using the configured default (${model.slug}).`);
  }

  const resolved = resolveEffort(model, requestedEffort ?? config.defaultEffort ?? undefined);
  if (resolved.adjusted && resolved.reason) notes.push(resolved.reason);

  const capped = capEffort(resolved.effort, config);
  if (capped.note) notes.push(capped.note);

  return { model: model.slug, effort: capped.effort, notes };
}

const delegateShape = {
  prompt: z
    .string()
    .min(1)
    .describe("The task for Codex. Be specific and self-contained: Codex cannot see this conversation."),
  model: z
    .string()
    .optional()
    .describe("Catalog slug from list_codex_models. Omitted means the recommendation matrix picks one."),
  reasoning_effort: effortSchema
    .optional()
    .describe("Reasoning depth, independent of model choice. Clamped to what the chosen model supports."),
  system_instructions: z
    .string()
    .optional()
    .describe("Persona or extra rules inherited from the orchestrator, layered on the built-in quality contract."),
  context: z
    .string()
    .optional()
    .describe("Background Codex needs: prior findings, constraints, relevant excerpts."),
  target_files: z
    .array(z.string())
    .optional()
    .describe("Paths Codex should focus on, relative to working_dir."),
  acceptance_criteria: z
    .array(z.string())
    .optional()
    .describe("Concrete conditions that must hold for the task to be considered done."),
  working_dir: z
    .string()
    .optional()
    .describe("Absolute path Codex uses as its working root."),
  sandbox: sandboxSchema
    .optional()
    .describe("Sandbox policy. Defaults to read-only: Codex analyses and reports but cannot modify files."),
  auto_approve: z
    .boolean()
    .optional()
    .describe("Adds --approve-for-me so Codex auto-approves its own commands. Only applies when sandbox allows writes."),
  add_dirs: z
    .array(z.string())
    .optional()
    .describe("Additional absolute directories that should be writable alongside working_dir."),
  use_worktree: z
    .boolean()
    .optional()
    .describe("Run in a managed git worktree so changes never touch the current working tree."),
  web_search: z.boolean().optional().describe("Enable Codex's native web search tool."),
  skip_git_repo_check: z
    .boolean()
    .optional()
    .describe("Allow running outside a git repository."),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe(`Wall-clock budget. Defaults to ${DEFAULT_TIMEOUT_SECONDS}s.`),
  mode: z
    .enum(["blocking", "background"])
    .optional()
    .describe("blocking (default) waits and streams progress; background returns a job_id immediately."),
};

export function createServer(): { server: McpServer; jobs: JobRegistry } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );
  const jobs = new JobRegistry();
  const { config, errors: configErrors } = loadConfig();

  /** Refuses every call while the environment is misconfigured. */
  const requireValidConfig = (): void => {
    if (configErrors.length === 0) return;
    throw new Error(
      `This MCP server is misconfigured:\n${configErrors.map((e) => `- ${e}`).join("\n")}\n` +
        "Fix the environment variables in the MCP server configuration and restart it.",
    );
  };

  server.registerTool(
    "codex_doctor",
    {
      title: "Check the Codex CLI installation",
      description:
        "Check whether the local Codex CLI is installed, recent enough and signed in, and report the exact " +
        "steps to fix it if not. Run this when any other tool reports the CLI is unavailable, or before " +
        "relying on delegation for the first time. It only inspects the installation; it never installs or " +
        "changes anything.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Re-probe the CLI instead of reusing the cached diagnosis."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ refresh }) => {
      try {
        const diagnosis = await runDoctor({ refresh: refresh ?? false });
        const lines = [
          `status: ${diagnosis.status}`,
          `codex binary: ${diagnosis.codexPath}`,
          `version: ${diagnosis.version ?? "not detected"}`,
          `signed in: ${diagnosis.authenticated === null ? "unknown" : diagnosis.authenticated ? "yes" : "no"}`,
          "",
          formatDiagnosis(diagnosis),
        ];
        return textResult(lines.join("\n"), !isUsable(diagnosis));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_codex_models",
    {
      title: "List Codex models",
      description:
        "List the Codex models available on this machine, with the reasoning-effort levels each one supports. " +
        "Read from the installed Codex CLI, never hardcoded. Call this before codex_delegate when choosing a model explicitly.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the cache and re-read the catalog from the CLI."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ refresh }) => {
      try {
        requireValidConfig();
        const diagnosis = await requireUsableCodex();
        const catalog = await getCatalog({ refresh: refresh ?? false });

        // Every model is listed, including ones the allow-list blocks, and the
        // blocked ones are marked. This is an informational tool; the allow-list
        // is enforced where it matters, on delegation. Hiding a model would also
        // hide the fact that a better one exists but is unavailable, which is
        // exactly what someone needs to know to reconsider the restriction.
        const blocked = (slug: string): boolean =>
          config.allowedModels.length > 0 && !config.allowedModels.includes(slug);

        const lines: string[] = [];

        if (diagnosis.status === "unverified-version") {
          lines.push(`WARNING: ${diagnosis.summary}`, "");
        }
        if (catalog.warning) lines.push(`WARNING: ${catalog.warning}`, "");

        lines.push(
          `${catalog.models.length} models available (most capable first), read at ${catalog.fetchedAt}:`,
          "",
        );

        for (const model of catalog.models) {
          lines.push(
            `${model.slug} — ${model.displayName}` +
              (blocked(model.slug) ? "  [BLOCKED by this server's configuration]" : ""),
            `  ${model.description}`,
            `  reasoning efforts: ${model.supportedReasoningEfforts.join(", ")} (default: ${model.defaultReasoningEffort})`,
            `  context window: ${model.contextWindow?.toLocaleString("en-US") ?? "unknown"} tokens` +
              (model.maxContextWindow && model.maxContextWindow !== model.contextWindow
                ? ` (up to ${model.maxContextWindow.toLocaleString("en-US")})`
                : ""),
            `  images: ${model.supportsImages ? "yes" : "no"} | web search: ${model.supportsWebSearch ? "yes" : "no"}`,
            "",
          );
        }

        lines.push(
          "Model and reasoning effort are independent axes: the model sets raw capability, the effort sets how long it deliberates.",
          "Use codex_recommend to get a suggested pairing for a specific task.",
        );

        if (config.allowedModels.length > 0) {
          lines.push(
            "",
            `Models marked BLOCKED are excluded by ${ENV_PREFIX}ALLOWED_MODELS in this server's ` +
              "configuration and will be refused if requested. They are listed so you can see what " +
              "the restriction is costing you.",
          );
        }

        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_recommend",
    {
      title: "Recommend a Codex model and effort",
      description:
        "Given a task description, recommend which Codex model and reasoning effort to delegate it with. " +
        "Runs no model call; applies a documented matrix reconciled against the installed catalog.",
      inputSchema: {
        task_description: z
          .string()
          .min(1)
          .describe("What the delegated task involves, in one or two sentences."),
        priority: prioritySchema
          .optional()
          .describe("Bias the reasoning effort: quality raises it, latency and cost lower it. Default balanced."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_description, priority }) => {
      try {
        await requireUsableCodex();
        const catalog = await getCatalog();
        const suggestion = recommend(
          catalog,
          task_description,
          (priority ?? "balanced") as Priority,
          config.allowedModels,
        );
        const lines = [
          `model: ${suggestion.model}`,
          `reasoning_effort: ${suggestion.reasoningEffort}`,
          `tier: ${suggestion.tier}`,
          "",
          suggestion.rationale,
        ];
        if (suggestion.adjustment) lines.push("", suggestion.adjustment);
        if (catalog.warning) lines.push("", `WARNING: ${catalog.warning}`);
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_delegate",
    {
      title: "Delegate a task to Codex",
      description:
        "Delegate a coding or analysis task to the local Codex CLI, choosing model and reasoning effort. " +
        "Codex runs read-only by default: it investigates and reports. Set sandbox to workspace-write to let it edit files. " +
        "Codex cannot see this conversation, so pass everything it needs in prompt, context, and target_files.",
      inputSchema: delegateShape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        requireValidConfig();
        validateWorkingDir(args.working_dir);

        const sandbox: SandboxMode = (args.sandbox ?? "read-only") as SandboxMode;
        const sandboxCheck = checkSandbox(sandbox, config);
        if (!sandboxCheck.ok) throw new Error(sandboxCheck.reason);

        const { model, effort, notes } = await resolveModelAndEffort(
          args.model,
          args.reasoning_effort as ReasoningEffort | undefined,
          `${args.prompt}\n${args.context ?? ""}`,
          config,
        );

        if (args.auto_approve && sandbox === "read-only") {
          notes.push(
            "auto_approve was ignored: it only applies when the sandbox allows writes.",
          );
        }

        const prompt = assemblePrompt({
          task: args.prompt,
          systemInstructions: args.system_instructions,
          context: args.context,
          targetFiles: args.target_files,
          acceptanceCriteria: args.acceptance_criteria,
          readOnly: sandbox === "read-only",
        });

        const invocation: CodexInvocation = {
          kind: "exec",
          model,
          reasoningEffort: effort,
          sandbox,
          autoApprove: args.auto_approve ?? false,
          workingDir: args.working_dir,
          addDirs: args.add_dirs ?? [],
          useWorktree: args.use_worktree ?? false,
          webSearch: args.web_search ?? false,
          skipGitRepoCheck: args.skip_git_repo_check ?? false,
        };

        const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;

        if (args.mode === "background") {
          const controller = new AbortController();
          const jobId = jobs.start({
            model,
            reasoningEffort: effort,
            controller,
            run: (hooks) =>
              runCodex({
                invocation,
                prompt,
                timeoutSeconds,
                signal: controller.signal,
                onEvent: hooks.onEvent,
              }).result,
          });

          return textResult(
            [
              ...(notes.length > 0 ? [`Notes: ${notes.join(" ")}`, ""] : []),
              `Started background delegation ${jobId} (${model} at ${effort}, sandbox ${sandbox}).`,
              "Poll codex_job_status with this job_id, then read codex_job_result once it reports completed.",
            ].join("\n"),
          );
        }

        const progressToken = extra._meta?.progressToken;
        let progress = 0;
        const onEvent = (_event: CodexEvent, description: string | null): void => {
          if (!description || progressToken === undefined) return;
          progress += 1;
          // Progress notifications also reset the client's tool timeout, which
          // is what keeps long delegations from being cut off.
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, message: description },
            })
            .catch(() => {
              // A dropped notification must never fail the delegation.
            });
        };

        const handle = runCodex({
          invocation,
          prompt,
          timeoutSeconds,
          onEvent,
          signal: extra.signal,
        });
        const result = await handle.result;
        return textResult(renderResult(result, notes), isFailure(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_follow_up",
    {
      title: "Continue a Codex session",
      description:
        "Send a follow-up message to a previous delegation using its thread_id. Codex still has the earlier context, " +
        "so this is much cheaper than re-sending it with codex_delegate.",
      inputSchema: {
        thread_id: z
          .string()
          .min(1)
          .describe("The thread_id reported by a previous codex_delegate call."),
        prompt: z.string().min(1).describe("The follow-up instruction."),
        model: z.string().optional().describe("Override the model for this turn."),
        reasoning_effort: effortSchema
          .optional()
          .describe("Override the reasoning effort for this turn."),
        sandbox: sandboxSchema
          .optional()
          .describe("Sandbox policy for this turn. Defaults to read-only."),
        auto_approve: z.boolean().optional(),
        working_dir: z.string().optional(),
        timeout_seconds: z.number().int().positive().max(7200).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        requireValidConfig();
        validateWorkingDir(args.working_dir);

        const sandbox: SandboxMode = (args.sandbox ?? "read-only") as SandboxMode;
        const sandboxCheck = checkSandbox(sandbox, config);
        if (!sandboxCheck.ok) throw new Error(sandboxCheck.reason);

        const notes: string[] = [];
        let model: string | undefined;
        let effort: ReasoningEffort | undefined;

        if (!args.model && !args.reasoning_effort) {
          // resolveModelAndEffort runs the preflight; without an override it is
          // skipped, so the check has to happen explicitly here.
          await requireUsableCodex();
        }

        if (args.model || args.reasoning_effort) {
          const resolved = await resolveModelAndEffort(
            args.model,
            args.reasoning_effort as ReasoningEffort | undefined,
            args.prompt,
            config,
          );
          model = resolved.model;
          effort = resolved.effort;
          notes.push(...resolved.notes);
        }

        const invocation: CodexInvocation = {
          kind: "resume",
          threadId: args.thread_id,
          ...(model ? { model } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          sandbox,
          autoApprove: args.auto_approve ?? false,
          workingDir: args.working_dir,
        };

        const progressToken = extra._meta?.progressToken;
        let progress = 0;

        const handle = runCodex({
          invocation,
          // The contract is already in the session's history; a follow-up only
          // needs the new instruction.
          prompt: args.prompt,
          timeoutSeconds: args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
          signal: extra.signal,
          onEvent: (_event, description) => {
            if (!description || progressToken === undefined) return;
            progress += 1;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, message: description },
              })
              .catch(() => {});
          },
        });

        const result = await handle.result;
        return textResult(renderResult(result, notes), isFailure(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_job_status",
    {
      title: "Check a background delegation",
      description:
        "Report the state and recent activity of a background delegation started with mode=background. " +
        "Call it with no job_id to list every known job.",
      inputSchema: {
        job_id: z.string().optional().describe("Omit to list all jobs."),
        include_activity: z
          .boolean()
          .optional()
          .describe("Include the recent progress log for the job."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, include_activity }) => {
      try {
        if (!job_id) {
          const all = jobs.list();
          if (all.length === 0) return textResult("No background delegations.");
          return textResult(
            all
              .map(
                (job) =>
                  `${job.jobId} — ${job.state} (${job.model ?? "default"} at ${job.reasoningEffort ?? "default"}, ${formatDuration(job.durationMs)}): ${job.lastActivity}`,
              )
              .join("\n"),
          );
        }

        const snapshot = jobs.snapshot(job_id);
        const lines = [
          `job_id: ${snapshot.jobId}`,
          `state: ${snapshot.state}`,
          `model: ${snapshot.model ?? "default"} at ${snapshot.reasoningEffort ?? "default"}`,
          `started: ${snapshot.startedAt}`,
          `duration: ${formatDuration(snapshot.durationMs)}`,
          `commands run: ${snapshot.commandCount}`,
          `thread_id: ${snapshot.threadId ?? "not yet reported"}`,
          `last activity: ${snapshot.lastActivity}`,
        ];
        if (snapshot.error) lines.push(`error: ${snapshot.error}`);
        if (include_activity) {
          lines.push("", "Recent activity:", ...jobs.activity(job_id).map((a) => `- ${a}`));
        }
        if (snapshot.state !== "running") {
          lines.push("", "Read the full output with codex_job_result.");
        }
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_job_result",
    {
      title: "Read a background delegation's result",
      description:
        "Return the full output of a finished background delegation. Errors if the job is still running.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job_id returned by codex_delegate."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        return textResult(renderResult(jobs.result(job_id), []));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_job_cancel",
    {
      title: "Cancel a background delegation",
      description: "Terminate a running background delegation.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job_id returned by codex_delegate."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        const snapshot = jobs.cancel(job_id);
        return textResult(`Job ${snapshot.jobId} is now ${snapshot.state}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return { server, jobs };
}
