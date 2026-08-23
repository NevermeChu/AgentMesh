import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveCommandInvocation, buildChildEnvironment } from "./executor.js";
import { VERSION } from "../version.js";

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
  /** Aborts the call: the transport closes, terminating the vendor MCP server process tree. */
  signal?: AbortSignal;
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
  options: McpClientExecutionOptions,
): Promise<McpClientExecutionResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const resolvedCwd = options.cwd ? path.resolve(options.cwd) : undefined;
  const invocation = await resolveCommandInvocation(options.command, options.args);

  // buildChildEnvironment drops shell-injected PWD/OLDPWD so vendor CLIs cannot
  // resolve a different project directory than the spawned working directory.
  const cleanEnv = buildChildEnvironment(resolvedCwd, options.env);

  const transport = new StdioClientTransport({
    command: invocation.command,
    args: invocation.args,
    env: cleanEnv,
    cwd: resolvedCwd,
    stderr: "pipe",
  });

  const client = new Client(
    {
      name: "agentmesh-client",
      version: VERSION,
    },
    {
      capabilities: {},
    },
  );

  let timer: NodeJS.Timeout | null = null;

  // Closing the stdio transport terminates the vendor server process tree, so an
  // aborted caller request cannot leave a detached agent process running.
  const onAbort = () => {
    void transport.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

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
      }

      if (!targetTool) {
        // Never guess: calling an arbitrary tool with task-shaped arguments can
        // trigger strict schema validation failures or unintended side effects.
        throw new Error(
          `No recognizable task tool on MCP server '${options.command}'. ` +
            `Pass toolName explicitly. Available tools: [${toolNames.join(", ")}]`,
        );
      }

      const toolResult = await client.callTool(
        {
          name: targetTool,
          arguments: options.toolArguments || {},
        },
        undefined,
        {
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: timeoutMs,
        },
      );

      const content: unknown = toolResult.content;
      const textOutput = Array.isArray(content)
        ? content
            .map((item: unknown) => {
              if (typeof item === "object" && item !== null && "text" in item) {
                const text = item.text;
                if (typeof text === "string") return text;
              }
              return JSON.stringify(item);
            })
            .join("\n")
        : JSON.stringify(toolResult);

      if (toolResult.isError) {
        throw new Error(
          `MCP Tool '${targetTool}' reported error: ${textOutput || "Unknown tool error"}`,
        );
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
    options.signal?.removeEventListener("abort", onAbort);
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
