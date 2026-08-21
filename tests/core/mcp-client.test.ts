import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { executeViaMcpClient } from "../../src/core/mcp-client.js";

describe("core/mcp-client", () => {
  it("should forward cwd to StdioClientTransport correctly", async () => {
    const targetCwd = path.resolve(process.cwd(), "src");
    // Use node to run a small MCP server that returns process.cwd()
    const serverScript = `
      import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
      import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

      const server = new McpServer({ name: "cwd-test", version: "1.0.0" });
      server.tool("get_cwd", {}, async () => ({
        content: [{ type: "text", text: process.cwd() }]
      }));

      const transport = new StdioServerTransport();
      await server.connect(transport);
    `;

    const res = await executeViaMcpClient({
      command: process.execPath,
      args: ["--input-type=module", "-e", serverScript],
      cwd: targetCwd,
      toolName: "get_cwd",
      timeoutMs: 10_000,
    });

    expect(res.output).toBeDefined();
    // Compare normalized paths
    const normalizedActual = path.resolve(res.output.trim()).toLowerCase();
    const normalizedExpected = path.resolve(targetCwd).toLowerCase();
    expect(normalizedActual).toBe(normalizedExpected);
  });

  it("should throw error when MCP tool returns isError: true", async () => {
    const serverScript = `
      import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
      import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

      const server = new McpServer({ name: "error-test", version: "1.0.0" });
      server.tool("failing_tool", {}, async () => ({
        content: [{ type: "text", text: "Simulated internal failure" }],
        isError: true,
      }));

      const transport = new StdioServerTransport();
      await server.connect(transport);
    `;

    await expect(
      executeViaMcpClient({
        command: process.execPath,
        args: ["--input-type=module", "-e", serverScript],
        toolName: "failing_tool",
        timeoutMs: 10_000,
      })
    ).rejects.toThrow("Simulated internal failure");
  });
});
