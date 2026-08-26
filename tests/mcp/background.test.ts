import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startMcpServer } from "../../src/mcp/server.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
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

/** Deferred the test controls; opening it lets the gated adapter finish. */
class ReleaseGate {
  readonly promise: Promise<void>;
  private resolveFn!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  public open(): void {
    this.resolveFn();
  }
}

class GatedAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Gated Test Adapter";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "TEST_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public gate: ReleaseGate = new ReleaseGate();

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const outputFile = options.taskActivity?.outputFile;
    if (outputFile) fs.appendFileSync(outputFile, "started\n", "utf-8");
    await Promise.race([
      this.gate.promise,
      new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    if (options.signal?.aborted) {
      return {
        status: "failed",
        agent: this.name,
        output: "cancelled",
        summary: "Cancelled by shutdown",
        error: "cancelled",
        errorCode: "CANCELLED",
        exitCode: 1,
        durationMs: 0,
      };
    }
    if (outputFile) fs.appendFileSync(outputFile, "finished\n", "utf-8");
    return this.formatSuccessResult("vendor log noise", Date.now(), {
      summary: "Background finished",
      finalAnswer: "The background answer",
      role: options.role,
    });
  }
}

describe("mcp background delegate and poll_task", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let server: McpServer;
  let adapter: GatedAdapter;
  let runner: MultiAgentRunner;
  let registry: BackgroundTaskRegistry;
  let background: BackgroundDispatchService;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_mcp_bg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    const appRegistry = new AgentRegistry();
    const sessionManager = new SessionManager({ persist: false });
    adapter = new GatedAdapter();
    appRegistry.register(adapter);
    runner = new MultiAgentRunner(appRegistry, sessionManager);
    registry = new BackgroundTaskRegistry({ homeDir });
    background = new BackgroundDispatchService(registry);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // startMcpServer installs the transport.onclose → gracefulShutdown path
    // the shutdown test exercises (createMcpServer alone would not).
    server = await startMcpServer({
      runner,
      backgroundService: background,
      transport: serverTransport,
    });
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await clientTransport.close();
      await serverTransport.close();
      await server.close();
    } catch {
      // ignore
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const outputFilePathOf = (taskId: string): string =>
    registry.getRegisteredTask(taskId)?.outputFile ??
    path.join(homeDir, "tasks", `${taskId}.output`);

  const startBackgroundTask = async (): Promise<string> => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: { agent: "codex", task: "Long running job", role: "worker", background: true },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("Status: RUNNING");
    expect(text).toContain("Output File:");
    expect(text).toContain("use poll_task to observe");
    const match = text.match(/Task ID: (\S+)/);
    expect(match).not.toBeNull();
    return match![1]!;
  };

  it("returns immediately from a background dispatch and exposes poll_task", async () => {
    const toolList = await client.listTools();
    expect(toolList.tools.map((t) => t.name)).toContain("poll_task");

    const startedAt = Date.now();
    const taskId = await startBackgroundTask();
    // The gate never resolves here, so a foreground call would hang forever.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(background.activeCount).toBe(1);
    // The adapter's first output chunk lands asynchronously after dispatch;
    // its appearance proves the run actually started in the background.
    await waitFor(() => fs.existsSync(outputFilePathOf(taskId)));
    expect(fs.readFileSync(outputFilePathOf(taskId), "utf-8")).toContain("started");
    const persisted = fs.readFileSync(registry.registryFilePath, "utf-8");
    expect(persisted).toContain(taskId);
  });

  it("polls running → completed with incremental output and a terminal result", async () => {
    const gate = new ReleaseGate();
    adapter.gate = gate;
    const taskId = await startBackgroundTask();
    await waitFor(
      () =>
        fs.existsSync(outputFilePathOf(taskId)) &&
        fs.readFileSync(outputFilePathOf(taskId), "utf-8").includes("started\n"),
    );

    const first = await client.callTool({
      name: "poll_task",
      arguments: { taskId },
    });
    const firstOutcome = JSON.parse(
      (first.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { status: string; outputSinceOffset: string };
    expect(firstOutcome.status).toBe("running");
    expect(firstOutcome.outputSinceOffset).toContain("started\n");

    // Second poll still running while the gate stays closed.
    const second = await client.callTool({ name: "poll_task", arguments: { taskId } });
    expect(
      JSON.parse((second.content as Array<{ type: string; text: string }>)[0]!.text),
    ).toMatchObject({ status: "running" });

    gate.open();

    let terminal: { status: string; result?: { summary?: string }; outputSinceOffset: string };
    for (let attempt = 0; attempt < 50; attempt++) {
      const poll = await client.callTool({ name: "poll_task", arguments: { taskId } });
      terminal = JSON.parse(
        (poll.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as typeof terminal;
      if (terminal.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(terminal!.status).toBe("completed");
    expect(terminal!.result?.summary).toBe("Background finished");
    expect(terminal!.outputSinceOffset).toContain("finished\n");
  });

  it("reports a structured NOT_FOUND for an unknown taskId", async () => {
    const res = await client.callTool({
      name: "poll_task",
      arguments: { taskId: "bgtask_does_not_exist" },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as {
      error: string;
      taskId: string;
    };
    expect(payload.error).toBe("NOT_FOUND");
    expect(payload.taskId).toBe("bgtask_does_not_exist");
  });

  it("aborts pending background tasks on graceful shutdown and records the outcome", async () => {
    adapter.gate = new ReleaseGate();
    const taskId = await startBackgroundTask();

    await clientTransport.close();
    await serverTransport.close();

    for (let attempt = 0; attempt < 50; attempt++) {
      if (background.activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(background.activeCount).toBe(0);
    const stored = await registry.readStoredResult(taskId);
    expect(stored?.status).toBe("failed");
  });
});
