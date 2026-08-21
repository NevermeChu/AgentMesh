import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findExecutableOnPath, buildCmdCommandLine } from "./executor.js";

export interface McpClientExecutionOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  promptName?: string;
  promptArguments?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpClientExecutionResult {
  output: string;
  structuredResult?: unknown;
  durationMs: number;
  toolsDiscovered: string[];
}

/**
 * Spawns an agent in MCP server mode, performs the requested tool or prompt call, and cleanly disconnects.
 */
export async function executeViaMcpClient(
  options: McpClientExecutionOptions
): Promise<McpClientExecutionResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const resolvedCwd = options.cwd ? path.resolve(options.cwd) : undefined;
  const isWindows = process.platform === "win32";

  // Resolve executable command path on PATH
  const resolvedCmd = (await findExecutableOnPath(options.command)) || options.command;
  let transportCommand = resolvedCmd;
  let transportArgs = options.args;

  // On Windows, route .cmd/.bat through cmd.exe for StdioClientTransport
  if (isWindows) {
    const lowerCmd = resolvedCmd.toLowerCase();
    if (lowerCmd.endsWith(".cmd") || lowerCmd.endsWith(".bat")) {
      const comSpec = process.env.ComSpec || "cmd.exe";
      transportCommand = comSpec;
      transportArgs = ["/d", "/s", "/c", buildCmdCommandLine(resolvedCmd, options.args)];
    }
  }

  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
    if (typeof value === "string") {
      cleanEnv[key] = value;
    }
  }

  const transport = new StdioClientTransport({
    command: transportCommand,
    args: transportArgs,
    env: cleanEnv,
    cwd: resolvedCwd,
    stderr: "pipe",
  });

  const client = new Client(
    {
      name: "agentmesh-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    }
  );

  let timer: NodeJS.Timeout | null = null;

  try {
    const connectPromise = async () => {
      await client.connect(transport);
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      let targetTool = options.toolName;
      // If no specific tool is requested, find the most appropriate execution tool
      if (!targetTool) {
        if (toolNames.includes("codex")) targetTool = "codex";
        else if (toolNames.includes("delegate_task")) targetTool = "delegate_task";
        else if (toolNames.includes("run_task")) targetTool = "run_task";
        else if (toolNames.includes("prompt")) targetTool = "prompt";
        else if (toolNames.length > 0) targetTool = toolNames[0];
      }

      if (!targetTool) {
        throw new Error(
          `No tools found on MCP server '${options.command}'. Available tools: [${toolNames.join(", ")}]`
        );
      }

      const toolResult = await client.callTool({
        name: targetTool,
        arguments: options.toolArguments || {},
      });

      let textOutput = "";
      if (Array.isArray(toolResult.content)) {
        textOutput = toolResult.content
          .map((item) => {
            if ("text" in item && typeof item.text === "string") return item.text;
            return JSON.stringify(item);
          })
          .join("\n");
      } else {
        textOutput = JSON.stringify(toolResult);
      }

      if (toolResult.isError) {
        throw new Error(`MCP Tool '${targetTool}' reported error: ${textOutput || "Unknown tool error"}`);
      }

      return {
        output: textOutput,
        structuredResult: toolResult,
        durationMs: Date.now() - startTime,
        toolsDiscovered: toolNames,
      };
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`MCP client execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return await Promise.race([connectPromise(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await transport.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}
