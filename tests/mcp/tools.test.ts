import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type { AgentName, AgentResult, RunAgentOptions, TransportMode } from "../../src/agents/types.js";

class TestAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Test Codex Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    if (options.role === "reviewer") {
      if (options.task.includes("UNKNOWN_TRIGGER")) {
        return this.formatSuccessResult("Review finished without a verdict.", Date.now(), {
          nativeSessionId: "native_rev_unknown",
          exitCode: 0,
          role: "reviewer",
        });
      }
      if (options.task.includes("FAIL_TRIGGER")) {
        const failOutput = `FAIL\n- severity: high\n  file: src/auth.ts\n  line: 42\n  issue: SQL Injection\n  suggestion: Use parameterized query`;
        return this.formatSuccessResult(failOutput, Date.now(), {
          nativeSessionId: "native_rev_fail",
          exitCode: 0,
          role: "reviewer",
        });
      }
      return this.formatSuccessResult("PASS\nAll checks passed cleanly.", Date.now(), {
        nativeSessionId: "native_rev_123",
        exitCode: 0,
        role: "reviewer",
      });
    }

    return this.formatSuccessResult(`Executed successfully: ${options.task}`, Date.now(), {
      nativeSessionId: options.nativeSessionId || "native_sess_999",
      exitCode: 0,
      summary: `Task completed: ${options.task}`,
      finalAnswer: `Executed successfully: ${options.task}`,
      role: options.role,
    });
  }
}

describe("mcp/tools protocol integration", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let runner: MultiAgentRunner;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    const adapter = new TestAdapter();
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, sessionManager);

    const server = createMcpServer({ runner });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    try {
      await clientTransport.close();
      await serverTransport.close();
    } catch {
      // ignore
    }
  });

  it("should discover all registered MCP tools", async () => {
    const response = await client.listTools();
    const toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain("delegate_task");
    expect(toolNames).toContain("review_changes");
    expect(toolNames).toContain("continue_task");
    expect(toolNames).toContain("list_agents");
    expect(toolNames).toContain("get_session");
    expect(toolNames).toContain("get_role_config");
  });

  it("should execute delegate_task via MCP callTool", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Implement user registration",
        role: "worker",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain("Summary: Task completed: Implement user registration");
    expect(content[0]?.text).not.toContain("Output:");
    expect(content[0]?.text).toContain("Final Answer:");
    expect(content[0]?.text).toContain("Executed successfully: Implement user registration");
  });

  it("should execute review_changes via MCP callTool on PASS", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "Review PR #42",
        baseCommit: "main",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("[Reviewer: codex | Review Outcome: PASS | Status: SUCCESS");
    expect(content[0]?.text).toContain("PASS");
  });

  it("should set isError: true when review_changes produces FAIL findings", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "Review PR #42 FAIL_TRIGGER",
        baseCommit: "main",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: FAIL");
    expect(content[0]?.text).toContain("Status: FAILED");
    expect(content[0]?.text).toContain("Findings: 1");
    expect(content[0]?.text).toContain("SQL Injection");
  });

  it("should report UNKNOWN reviewer output as an error instead of PASS", async () => {
    const res = await client.callTool({
      name: "review_changes",
      arguments: {
        agent: "codex",
        task: "UNKNOWN_TRIGGER",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: UNKNOWN");
    expect(content[0]?.text).not.toContain("Review Outcome: PASS");
    expect(content[0]?.text).not.toContain("--- REVIEW FINDINGS ---");
  });

  it("should execute continue_task via MCP callTool", async () => {
    const firstRun = await runner.delegateTask({
      agent: "codex",
      task: "Initial feature",
    });

    const res = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: firstRun.sessionId!,
        task: "Fix review findings",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain(firstRun.sessionId!);
  });

  it("should execute list_agents via MCP callTool", async () => {
    const res = await client.callTool({
      name: "list_agents",
      arguments: {},
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const agents = JSON.parse(content[0]?.text || "[]");
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.some((a: { name: string }) => a.name === "codex")).toBe(true);
  });

  it("should execute get_session via MCP callTool", async () => {
    const createdSession = sessionManager.createSession({
      agent: "codex",
      cwd: "/my/project",
      role: "worker",
    });

    const res = await client.callTool({
      name: "get_session",
      arguments: {
        sessionId: createdSession.id,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const session = JSON.parse(content[0]?.text || "{}");
    expect(session.id).toBe(createdSession.id);
    expect(session.agent).toBe("codex");
  });

  it("should return error structure on unknown session in get_session", async () => {
    const res = await client.callTool({
      name: "get_session",
      arguments: {
        sessionId: "invalid_session_id_123",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Session 'invalid_session_id_123' not found");
  });

  it("should reject blank tasks and invalid timeout bounds at the MCP schema", async () => {
    const blankTask = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "   " },
    });
    expect(blankTask.isError).toBe(true);

    const invalidTimeout = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Valid task", timeoutMs: -1 },
    });
    expect(invalidTimeout.isError).toBe(true);
  });

  it("should accept an omitted agent and report a missing project role assignment", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        task: "Use configured worker",
        role: "worker",
        cwd: process.cwd(),
      },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("is not configured");
  });
});
