import { Command } from "commander";
import { defaultRunner } from "../core/runner.js";
import { startMcpServer } from "../mcp/server.js";
import { parseMode, parseRole, parseTimeout } from "./validation.js";

const program = new Command();

program
  .name("agentmesh")
  .description("AgentMesh CLI: Multi-agent bridge to delegate tasks and code reviews to vendor Coding Agents")
  .version("0.1.0");

// Command: run
program
  .command("run <agent> <task>")
  .description("Delegate a task to a designated agent (Codex, Antigravity, Grok, Claude Code, etc.)")
  .option("-c, --cwd <path>", "Working directory", process.cwd())
  .option("-r, --role <role>", "Role: worker | reviewer | tester", parseRole, "worker")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode, "auto")
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .option("-s, --session <sessionId>", "Bridge session ID to attach")
  .option("--base <commit>", "Git base branch/commit for diff comparison")
  .action(async (agent: string, task: string, options) => {
    try {
      console.log(`[AgentMesh] Dispatching to '${agent}' (role: ${options.role}, mode: ${options.mode})...\n`);
      const result = await defaultRunner.delegateTask({
        agent,
        task,
        cwd: options.cwd,
        role: options.role,
        mode: options.mode,
        timeoutMs: options.timeout,
        sessionId: options.session,
        baseCommit: options.base,
      });

      console.log(`----------------------------------------`);
      console.log(`Agent:     ${result.agent}`);
      console.log(`Status:    ${result.status.toUpperCase()}`);
      console.log(`Session:   ${result.sessionId}`);
      console.log(`Duration:  ${result.durationMs ?? 0}ms`);
      console.log(`Summary:   ${result.summary}`);
      console.log(`----------------------------------------\n`);
      console.log(result.output);

      if (result.status === "failed") {
        process.exit(1);
      }
    } catch (err) {
      console.error("Execution error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Command: review
program
  .command("review <agent> [task]")
  .description("Invoke an independent Reviewer agent to inspect code changes and git diff")
  .option("-c, --cwd <path>", "Working directory", process.cwd())
  .option("--base <commit>", "Git base branch/commit to diff against")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode, "auto")
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .action(async (agent: string, task: string | undefined, options) => {
    try {
      console.log(`[AgentMesh] Initiating independent Code Review using '${agent}'...\n`);
      const result = await defaultRunner.reviewChanges({
        agent,
        task,
        cwd: options.cwd,
        baseCommit: options.base,
        mode: options.mode,
        timeoutMs: options.timeout,
      });

      console.log(`----------------------------------------`);
      console.log(`Reviewer:  ${result.agent}`);
      console.log(`Status:    ${result.status.toUpperCase()}`);
      console.log(`Session:   ${result.sessionId}`);
      console.log(`Summary:   ${result.summary}`);
      console.log(`----------------------------------------\n`);
      console.log(result.output);

      if (result.status === "failed") {
        process.exit(1);
      }
    } catch (err) {
      console.error("Review error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Command: continue
program
  .command("continue <sessionId> <task>")
  .description("Continue an existing session with follow-up tasks or fix requests")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode, "auto")
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .action(async (sessionId: string, task: string, options) => {
    try {
      console.log(`[AgentMesh] Continuing session '${sessionId}'...\n`);
      const result = await defaultRunner.continueTask({
        sessionId,
        task,
        mode: options.mode,
        timeoutMs: options.timeout,
      });

      console.log(`----------------------------------------`);
      console.log(`Agent:     ${result.agent}`);
      console.log(`Status:    ${result.status.toUpperCase()}`);
      console.log(`Session:   ${result.sessionId}`);
      console.log(`Summary:   ${result.summary}`);
      console.log(`----------------------------------------\n`);
      console.log(result.output);

      if (result.status === "failed") {
        process.exit(1);
      }
    } catch (err) {
      console.error("Continue error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Command: list
program
  .command("list")
  .description("List all supported agents and their availability status on this system")
  .action(async () => {
    try {
      const agents = await defaultRunner.listAgents();
      console.log("\nSupported Agent Adapters & System Status:\n");
      console.log(
        "NAME".padEnd(16) +
        "DISPLAY NAME".padEnd(35) +
        "STATUS".padEnd(14) +
        "PREFERRED".padEnd(12) +
        "PATH / NOTE"
      );
      console.log("-".repeat(95));

      for (const ag of agents) {
        const statusStr = ag.available ? "[AVAILABLE]" : "[MISSING]";
        const pathStr = ag.info.path || ag.info.notes || "Not in PATH";
        console.log(
          ag.name.padEnd(16) +
          ag.displayName.padEnd(35) +
          statusStr.padEnd(14) +
          ag.info.preferredTransport.toUpperCase().padEnd(12) +
          pathStr
        );
      }
      console.log("\nTip: You can specify custom binary locations using environment variables (e.g. CODEX_BIN, CLAUDE_BIN, AGY_BIN, GROK_BIN).\n");
    } catch (err) {
      console.error("Failed to list agents:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Command: session
program
  .command("session <sessionId>")
  .description("View history and metadata of a bridge session")
  .action((sessionId: string) => {
    const session = defaultRunner.getSession(sessionId);
    if (!session) {
      console.error(`Session '${sessionId}' not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(session, null, 2));
  });

// Command: sessions (list all sessions)
program
  .command("sessions")
  .description("List all stored bridge sessions")
  .action(() => {
    const sessions = defaultRunner.listSessions();
    if (sessions.length === 0) {
      console.log("\nNo stored bridge sessions found.\n");
      return;
    }
    console.log(`\nStored Bridge Sessions (${sessions.length}):\n`);
    console.log(
      "SESSION ID".padEnd(28) +
      "AGENT".padEnd(14) +
      "ROLE".padEnd(12) +
      "TURNS".padEnd(8) +
      "UPDATED AT".padEnd(26) +
      "CWD"
    );
    console.log("-".repeat(100));
    for (const s of sessions) {
      console.log(
        s.id.padEnd(28) +
        s.agent.padEnd(14) +
        s.role.padEnd(12) +
        String(s.history.length).padEnd(8) +
        s.updatedAt.padEnd(26) +
        s.cwd
      );
    }
    console.log();
  });


// Command: serve (starts MCP server)
program
  .command("serve")
  .description("Start the stdio Model Context Protocol (MCP) server")
  .action(async () => {
    await startMcpServer();
  });

// If executed without arguments in non-interactive environment (or piped stdin), start MCP server
if (process.argv.length <= 2) {
  if (!process.stdin.isTTY) {
    startMcpServer().catch((err) => {
      console.error("Failed to start MCP server:", err);
      process.exit(1);
    });
  } else {
    program.help();
  }
} else {
  program.parse(process.argv);
}
