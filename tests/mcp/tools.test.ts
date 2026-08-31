import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  TransportMode,
} from "../../src/agents/types.js";

class TestAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Test Codex Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public lastRunOptions?: RunAgentOptions;

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.lastRunOptions = options;
    const verdictRequired = options.reviewVerdictRequired;
    if (options.task.includes("CANCEL_WAIT")) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 15_000);
      });
      return this.formatSuccessResult("Finished after cancellation", Date.now(), {
        nativeSessionId: "native_cancel",
        exitCode: 0,
        summary: "Completed",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("RAW_OUTPUT_TRIGGER")) {
      return this.formatSuccessResult("vendor log line A\nvendor log line B", Date.now(), {
        nativeSessionId: "native_raw",
        exitCode: 0,
        summary: "Task completed: RAW_OUTPUT_TRIGGER",
        finalAnswer: "Clean final answer",
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("HANDOFF_OPEN_ITEMS_TRIGGER")) {
      return this.formatSuccessResult("done", Date.now(), {
        nativeSessionId: "native_handoff_open",
        exitCode: 0,
        summary: "Task completed: HANDOFF_OPEN_ITEMS_TRIGGER",
        finalAnswer: [
          "Implemented the billing export.",
          "## Goal",
          "Ship the billing export",
          "## Decisions",
          "- Reuse the shared CSV writer",
          "## Open Items",
          "- SPEC section 3 contradicts section 5 on timeout defaults",
          "- Docs pending",
        ].join("\n"),
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("HANDOFF_CLEAN_TRIGGER")) {
      return this.formatSuccessResult("done", Date.now(), {
        nativeSessionId: "native_handoff_clean",
        exitCode: 0,
        summary: "Task completed: HANDOFF_CLEAN_TRIGGER",
        finalAnswer: [
          "Implemented the billing export.",
          "## Goal",
          "Ship the billing export",
          "## Decisions",
          "- Reuse the shared CSV writer",
        ].join("\n"),
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.task.includes("GHOST_FILE_TRIGGER")) {
      return this.formatSuccessResult("done", Date.now(), {
        nativeSessionId: "native_ghost_file",
        exitCode: 0,
        summary: "Task completed: GHOST_FILE_TRIGGER",
        finalAnswer: [
          "Implemented the export.",
          "## Files",
          "- src/billing/ghost-export.ts",
          "## Tests",
          "3 passed, 0 failed",
        ].join("\n"),
        role: options.role,
        reviewVerdictRequired: verdictRequired,
      });
    }
    if (options.role === "reviewer") {
      if (options.task.includes("UNKNOWN_TRIGGER")) {
        return this.formatSuccessResult("Review finished without a verdict.", Date.now(), {
          nativeSessionId: "native_rev_unknown",
          exitCode: 0,
          finalAnswer: "Review finished without a verdict.",
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      if (options.task.includes("FAIL_TRIGGER")) {
        const failOutput = `FAIL\n- severity: high\n  file: src/auth.ts\n  line: 42\n  issue: SQL Injection\n  suggestion: Use parameterized query`;
        return this.formatSuccessResult(failOutput, Date.now(), {
          nativeSessionId: "native_rev_fail",
          exitCode: 0,
          role: "reviewer",
          reviewVerdictRequired: verdictRequired,
        });
      }
      return this.formatSuccessResult("PASS\nAll checks passed cleanly.", Date.now(), {
        nativeSessionId: "native_rev_123",
        exitCode: 0,
        role: "reviewer",
        reviewVerdictRequired: verdictRequired,
      });
    }

    return this.formatSuccessResult(`Executed successfully: ${options.task}`, Date.now(), {
      nativeSessionId: options.nativeSessionId || "native_sess_999",
      exitCode: 0,
      summary: `Task completed: ${options.task}`,
      finalAnswer: `Executed successfully: ${options.task}`,
      role: options.role,
      reviewVerdictRequired: verdictRequired,
    });
  }
}

describe("mcp/tools protocol integration", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let runner: MultiAgentRunner;
  let adapter: TestAdapter;

  beforeEach(async () => {
    const registry = new AgentRegistry();
    const sessionManager = new SessionManager({ persist: false });
    adapter = new TestAdapter();
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, sessionManager);

    const server = createMcpServer({ runner });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    try {
      await clientTransport.close();
      await serverTransport.close();
    } catch {
      // ignore
    }
  });

  it("discovers the complete MCP tool contract", async () => {
    const response = await client.listTools();
    const toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain("delegate_task");
    expect(toolNames).toContain("review_changes");
    expect(toolNames).toContain("continue_task");
    expect(toolNames).toContain("list_agents");
    expect(toolNames).toContain("get_session");
    expect(toolNames).toContain("get_role_config");
  });

  it("delegates a worker task through MCP", async () => {
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
    // Output equals the final answer here, so no separate Raw Output section is added.
    expect(content[0]?.text).not.toContain("Raw Output:");
    expect(content[0]?.text).toContain("Final Answer:");
    expect(content[0]?.text).toContain("Executed successfully: Implement user registration");
  });

  it("emits MCP progress notifications for agent tasks", async () => {
    const messages: string[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      if (notification.params.message) messages.push(notification.params.message);
    });

    const result = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Report progress", role: "worker" },
      _meta: { progressToken: "agentmesh-progress-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(messages).toEqual(["Agent task started", "Agent task success"]);
  });

  it("returns a successful reviewer verdict through MCP", async () => {
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
    expect(content[0]?.text).toContain("Reviewer Safety:");
    expect(content[0]?.text).toContain('"mechanism": "prompt-only"');
  });

  it("propagates reviewer findings as an MCP error", async () => {
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
    // The derived reviewer handoff carries the findings as open items so the
    // orchestrator sees them in the response without calling get_session.
    expect(content[0]?.text).toContain("openItems=1");
    expect(content[0]?.text).toContain(
      "⚠ 1 open item(s) reported — review before chaining further work (see get_session_context)",
    );
  });

  it("surfaces a handoff digest with an open-items warning in worker responses", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Implement billing export HANDOFF_OPEN_ITEMS_TRIGGER",
        role: "worker",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Handoff: goal=Ship the billing export");
    expect(content[0]?.text).toContain("decisions=1");
    expect(content[0]?.text).toContain("openItems=2");
    expect(content[0]?.text).toContain(
      "⚠ 2 open item(s) reported — review before chaining further work (see get_session_context)",
    );
  });

  it("omits the open-items warning when the handoff has none", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Implement billing export HANDOFF_CLEAN_TRIGGER",
        role: "worker",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Handoff: goal=Ship the billing export");
    expect(content[0]?.text).toContain("openItems=0");
    expect(content[0]?.text).not.toContain("⚠");
  });

  it("fails closed for an unknown reviewer verdict", async () => {
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

  it("keeps a verdict-less reviewer reply non-fatal outside the review contract (N-R11-A)", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        role: "reviewer",
        task: "UNKNOWN_TRIGGER",
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: UNKNOWN");
    expect(content[0]?.text).toContain("Status: SUCCESS");
    expect(content[0]?.text).toContain("No explicit PASS/FAIL verdict");
  });

  it("continues a Bridge session through MCP", async () => {
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

  it("marks an inherited reviewer FAIL verdict as an MCP error on continuation", async () => {
    const reviewRun = await runner.reviewChanges({ agent: "codex", task: "Review PR #42" });

    const res = await client.callTool({
      name: "continue_task",
      arguments: {
        sessionId: reviewRun.sessionId!,
        task: "Re-review after fixes FAIL_TRIGGER",
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Review Outcome: FAIL");
  });

  it("passes multi-source context ids through the MCP boundary", async () => {
    const sourceRun = await runner.delegateTask({ agent: "codex", task: "Source turn" });

    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        agent: "codex",
        task: "Consume sources over MCP",
        contextSessionIds: [sourceRun.sessionId!],
      },
    });

    expect(res.isError).toBeFalsy();
    expect(adapter.lastRunOptions?.historyContext).toContain(sourceRun.sessionId!);
    expect(adapter.lastRunOptions?.historyContext).toContain("[Turn 1 | Agent: CODEX");
  });

  it("serves recorded turns through get_session_context", async () => {
    const sourceRun = await runner.delegateTask({ agent: "codex", task: "Source turn" });

    const res = await client.callTool({
      name: "get_session_context",
      arguments: {
        sessionId: sourceRun.sessionId!,
        fields: ["handoff", "finalAnswer"],
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      sessionId: string;
      turnIndex: number;
      totalTurns: number;
      freshness: string;
      finalAnswer?: string;
      handoff?: unknown;
    };
    expect(parsed.sessionId).toBe(sourceRun.sessionId);
    expect(parsed.turnIndex).toBe(1);
    expect(parsed.totalTurns).toBe(1);
    expect(parsed.freshness).toBe("MATCHED");
    expect(parsed.finalAnswer).toContain("Source turn");
  });

  it("rejects out-of-range turn indexes and unknown sessions in get_session_context", async () => {
    const sourceRun = await runner.delegateTask({ agent: "codex", task: "Only turn" });

    const outOfRange = await client.callTool({
      name: "get_session_context",
      arguments: { sessionId: sourceRun.sessionId!, turnIndex: 5 },
    });
    expect(outOfRange.isError).toBe(true);
    const outContent = outOfRange.content as Array<{ type: string; text: string }>;
    expect(outContent[0]?.text).toContain("turnIndex must be between 1 and 1");

    const missing = await client.callTool({
      name: "get_session_context",
      arguments: { sessionId: "bridge-sess_missing" },
    });
    expect(missing.isError).toBe(true);
    const missingContent = missing.content as Array<{ type: string; text: string }>;
    expect(missingContent[0]?.text).toContain("not found");
  });

  it("reports CONTEXT_INSUFFICIENT with missing inputs on retrieval misses", async () => {
    const missingSession = await client.callTool({
      name: "get_session_context",
      arguments: { sessionId: "bridge-sess_missing" },
    });
    expect(missingSession.isError).toBe(true);
    const missingContent = missingSession.content as Array<{ type: string; text: string }>;
    expect(missingContent[0]?.text).toContain(
      "Context Status: CONTEXT_INSUFFICIENT — missing: session",
    );

    const sourceRun = await runner.delegateTask({ agent: "codex", task: "Only turn" });
    const outOfRange = await client.callTool({
      name: "get_session_context",
      arguments: { sessionId: sourceRun.sessionId!, turnIndex: 9 },
    });
    expect(outOfRange.isError).toBe(true);
    const rangeContent = outOfRange.content as Array<{ type: string; text: string }>;
    expect(rangeContent[0]?.text).toContain("Context Status: CONTEXT_INSUFFICIENT — missing: turn");
  });

  it("appends a sufficiency hint when retrieved context is not MATCHED", async () => {
    // A scratch directory outside any git repo yields UNKNOWN freshness.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-mcp-sufficiency-"));
    try {
      const sourceRun = await runner.delegateTask({ agent: "codex", task: "Source turn", cwd });
      const res = await client.callTool({
        name: "get_session_context",
        arguments: { sessionId: sourceRun.sessionId!, fields: ["handoff"] },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("Context Status: INSUFFICIENT");
      expect(content[0]?.text).toContain("verify before relying on prior results");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("surfaces ungrounded handoff artifacts as a Warning on delegate_task", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-mcp-grounding-"));
    try {
      const res = await client.callTool({
        name: "delegate_task",
        arguments: { agent: "codex", task: "Export GHOST_FILE_TRIGGER", cwd },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("Warning:");
      expect(content[0]?.text).toContain("Handoff grounding");
      expect(content[0]?.text).toContain("src/billing/ghost-export.ts");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects invalid task and timeout inputs at the MCP boundary", async () => {
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

  it("includes bounded vendor raw output for remote diagnostics", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "RAW_OUTPUT_TRIGGER", role: "worker" },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Final Answer:\nClean final answer");
    expect(content[0]?.text).toContain("Raw Output:\nvendor log line A");
  });

  it("records a cancelled turn as failed history instead of losing it", async () => {
    const callPromise = client
      .callTool({
        name: "delegate_task",
        arguments: { agent: "codex", task: "CANCEL_WAIT slow task" },
        _meta: { progressToken: "cancel-test" },
      })
      .catch(() => "connection closed");

    await new Promise((resolve) => setTimeout(resolve, 500));
    await clientTransport.close();
    await callPromise;

    for (let attempt = 0; attempt < 50; attempt++) {
      const target = runner
        .listSessions()
        .find((session) => session.history.some((turn) => turn.task.includes("CANCEL_WAIT")));
      if (target) {
        const turn = target.history.find((entry) => entry.task.includes("CANCEL_WAIT"));
        expect(turn?.status).toBe("failed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("cancelled turn was never recorded in session history");
  });

  it("reports a missing project role assignment when agent is omitted", async () => {
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
