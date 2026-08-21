import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MultiAgentRunner, defaultRunner } from "../core/runner.js";
import { registerMcpTools } from "./tools.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
  runner?: MultiAgentRunner;
}

/**
 * Creates and initializes the Multi-Agent Bridge MCP Server instance.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name || "agentmesh",
    version: options.version || "0.1.0",
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
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle process signals for graceful shutdown
  const handleExit = async () => {
    try {
      await server.close();
    } catch {
      // Ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);

  return server;
}
