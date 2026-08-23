import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defaultRunner } from "../core/runner.js";
import type { MultiAgentRunner } from "../core/runner.js";
import { registerMcpTools } from "./tools.js";
import { VERSION } from "../version.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
  runner?: MultiAgentRunner;
  handleSignals?: boolean;
  transport?: Transport;
}

/**
 * Creates and initializes the Multi-Agent Bridge MCP Server instance.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name || "agentmesh",
    version: options.version || VERSION,
  });

  const runner = options.runner || defaultRunner;
  registerMcpTools(server, runner);

  return server;
}

/**
 * Starts the MCP server on stdio transport.
 */
export async function startMcpServer(options: McpServerOptions = {}): Promise<McpServer> {
  const server = createMcpServer(options);
  const transport = options.transport || new StdioServerTransport();

  await server.connect(transport);

  if (options.handleSignals === false) return server;

  // Handle process signals for graceful shutdown. Unregister on normal close so
  // repeated programmatic starts do not accumulate process listeners.
  const originalClose = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  const removeSignalHandlers = () => {
    process.off("SIGINT", handleExit);
    process.off("SIGTERM", handleExit);
  };
  const closeServer = async () => {
    if (!closePromise) {
      removeSignalHandlers();
      closePromise = originalClose();
    }
    await closePromise;
  };

  const closeAndExit = async () => {
    try {
      await closeServer();
    } catch {
      // Ignore
    }
    process.exitCode = 0;
  };

  const handleExit = () => {
    void closeAndExit();
  };

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
  server.close = closeServer;

  return server;
}
