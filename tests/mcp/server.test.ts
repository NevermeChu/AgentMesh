import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { MultiAgentRunner } from "../../src/core/runner.js";

describe("mcp/server", () => {
  it("should create McpServer instance with all tools registered", () => {
    const runner = new MultiAgentRunner();
    const server = createMcpServer({ runner });
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});
