#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Create the MCP server
const server = new Server(
  {
    name: "Codex Subagent",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_codex",
        description: "Delegate a task to Codex with full context, working directory, and reasoning level selection.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The main task description or instruction to execute.",
            },
            reasoning_level: {
              type: "string",
              enum: ["low", "medium", "high", "extra"],
              description: "Selects the model based on task complexity. low=gpt-4o-mini, medium=gpt-4o, high=o1, extra=o3",
            },
            model: {
              type: "string",
              description: "Explicit model override. Use this to specify a custom model name instead of reasoning_level.",
            },
            system_instructions: {
              type: "string",
              description: "System instructions or persona to inherit from the orchestrator.",
            },
            context: {
              type: "string",
              description: "Additional background information or relevant data.",
            },
            working_dir: {
              type: "string",
              description: "Absolute path to the directory where Codex should execute.",
            },
            target_files: {
              type: "array",
              items: { type: "string" },
              description: "Specific files or directories Codex should focus on (relative to working_dir).",
            },
            autonomous: {
              type: "boolean",
              description: "If true (default), enables --approve-for-me so Codex executes commands autonomously.",
            }
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

// Map reasoning levels to models (assuming OpenAI Codex as default)
const REASONING_MODELS: Record<string, string> = {
  low: "gpt-4o-mini",
  medium: "gpt-4o",
  high: "o1",
  extra: "o3",
};

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ask_codex") {
    const args = request.params.arguments || {};
    const prompt = String(args.prompt || "");
    const reasoningLevel = args.reasoning_level ? String(args.reasoning_level) : undefined;
    const modelOverride = args.model ? String(args.model) : undefined;
    const systemInstructions = args.system_instructions ? String(args.system_instructions) : undefined;
    const context = args.context ? String(args.context) : undefined;
    const workingDir = args.working_dir ? String(args.working_dir) : undefined;
    const targetFiles = Array.isArray(args.target_files) ? args.target_files : undefined;
    const autonomous = args.autonomous !== undefined ? Boolean(args.autonomous) : true;
    
    if (!prompt) {
      throw new Error("Prompt is required");
    }

    try {
      // 1. Determine model
      const modelToUse = modelOverride || (reasoningLevel ? REASONING_MODELS[reasoningLevel] : undefined);

      // 2. Assemble the rich prompt
      let assembledPrompt = "";

      if (systemInstructions) {
        assembledPrompt += `<system_instructions>\n${systemInstructions}\n</system_instructions>\n\n`;
      }

      if (context) {
        assembledPrompt += `<context>\n${context}\n</context>\n\n`;
      }

      if (targetFiles && targetFiles.length > 0) {
        assembledPrompt += `<target_files>\nPlease focus specifically on these files:\n${targetFiles.map(f => `- ${f}`).join('\n')}\n</target_files>\n\n`;
      }

      assembledPrompt += `<task>\n${prompt}\n</task>`;

      // 3. Construct CLI arguments
      // Escape prompt carefully
      const safePrompt = assembledPrompt.replace(/"/g, '\\"');
      
      let command = `codex exec`;
      
      if (modelToUse) {
        command += ` --model "${modelToUse}"`;
      }
      
      if (workingDir) {
        command += ` --cd "${workingDir}"`;
      }

      if (autonomous) {
        command += ` --approve-for-me`;
      }
      
      command += ` "${safePrompt}"`;
      
      const { stdout, stderr } = await execAsync(command);
      
      return {
        content: [
          {
            type: "text",
            text: stdout || stderr,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing codex CLI: ${error.message}\nStderr: ${error.stderr || ""}`,
          },
        ],
      };
    }
  }

  throw new Error("Tool not found");
});

// Start the server
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codex-subagent MCP server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
