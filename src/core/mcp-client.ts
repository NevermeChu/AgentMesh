import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
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
 * Collects live descendant PIDs of `rootPid` by reading procfs `children`
 * files. Linux only; other platforms return an empty list because they lack
 * procfs. The snapshot must happen while the root process is still alive,
 * otherwise deeper generations reparent to init and become untrackable.
 */
function collectDescendantPids(rootPid: number): number[] {
  if (process.platform !== "linux") return [];
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let tasks: string[];
    try {
      tasks = fs.readdirSync(path.join("/proc", String(current), "task"));
    } catch {
      continue;
    }
    for (const task of tasks) {
      let childLine: string;
      try {
        childLine = fs.readFileSync(
          path.join("/proc", String(current), "task", task, "children"),
          "utf8",
        );
      } catch {
        continue;
      }
      for (const field of childLine.trim().split(/\s+/)) {
        const childPid = Number(field);
        if (!Number.isInteger(childPid) || childPid <= 0 || seen.has(childPid)) continue;
        seen.add(childPid);
        descendants.push(childPid);
        queue.push(childPid);
      }
    }
  }
  return descendants;
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
    // Reap the vendor process tree while the parent is still alive. The SDK's
    // StdioClientTransport spawns without a dedicated process group, and its
    // close() only terminates the direct child; vendor MCP servers (e.g.
    // `codex mcp-server`, antigravity) routinely fork subprocesses (`codex
    // exec`, `agy`) that would survive as orphans. Windows gets taskkill /T /F;
    // Linux snapshots the live descendant list from procfs so any survivor can
    // be signalled once the direct child has been reaped below.
    const vendorPid = transport.pid;
    const posixDescendants =
      vendorPid && process.platform === "linux" ? collectDescendantPids(vendorPid) : [];
    if (process.platform === "win32" && vendorPid) {
      try {
        spawn("taskkill", ["/pid", vendorPid.toString(), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Best-effort cleanup; the server may already be gone.
      }
    }
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    for (const pid of posixDescendants) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited between the snapshot and the signal.
      }
    }
  }
}
