import { Command } from "commander";
import { defaultRunner } from "../core/runner.js";
import { defaultRegistry } from "../agents/registry.js";
import { startMcpServer } from "../mcp/server.js";
import { VERSION } from "../version.js";
import type { AgentRole, TransportMode } from "../agents/types.js";
import {
  parseMode,
  parseRole,
  parseTimeout,
  resolveReviewInput,
  resolveRunInput,
} from "./validation.js";

const program = new Command();

interface RunCommandOptions {
  agent?: string;
  base?: string;
  contextSession?: string;
  contextSessions?: string[];
  cwd: string;
  mode?: TransportMode;
  role?: AgentRole;
  session?: string;
  timeout?: number;
}

interface ReviewCommandOptions {
  agent?: string;
  base?: string;
  contextSession?: string;
  contextSessions?: string[];
  cwd: string;
  mode?: TransportMode;
  timeout?: number;
}

interface ContinueCommandOptions {
  contextSessions?: string[];
  mode: TransportMode;
  timeout?: number;
}

program
  .name("agentmesh")
  .description("AgentMesh management CLI and stdio MCP server")
  .version(VERSION);

const debugProgram = program
  .command("debug")
  .description(
    "Direct execution commands for diagnostics only; normal workflows should use the MCP tools",
  );

// Debug command: run
debugProgram
  .command("run <agentOrTask> [task...]")
  .description("Directly run a task outside an Orchestrator (diagnostics only)")
  .option("-c, --cwd <path>", "Working directory", process.cwd())
  .option("-r, --role <role>", "Role: worker | reviewer | tester", parseRole)
  .option("-a, --agent <agent>", "Explicit agent override for project role assignment")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode)
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .option("-s, --session <sessionId>", "Bridge session ID to attach")
  .option(
    "--context-session <sessionId>",
    "Bridge session whose normalized context should be shared",
  )
  .option(
    "--context-sessions <sessionIds...>",
    "Up to 4 Bridge sessions injected first-hand, in the given order",
  )
  .option("--base <commit>", "Git base branch/commit for diff comparison")
  .action(async (agentOrTask: string, taskParts: string[], options: RunCommandOptions) => {
    try {
      const input = resolveRunInput(agentOrTask, taskParts, options.agent);
      const role = options.role || "worker";
      console.log(
        `[AgentMesh] Dispatching ${input.agent ? `to '${input.agent}'` : `configured '${role}' role`} (role: ${role}, mode: ${options.mode || "configured/auto"})...\n`,
      );
      const result = await defaultRunner.delegateTask({
        agent: input.agent,
        task: input.task,
        cwd: options.cwd,
        role: options.role,
        mode: options.mode,
        timeoutMs: options.timeout,
        sessionId: options.session,
        contextSessionId: options.contextSession,
        contextSessionIds: options.contextSessions,
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

// Debug command: review
debugProgram
  .command("review [agentOrTask] [task...]")
  .description("Directly run a reviewer outside an Orchestrator (diagnostics only)")
  .option("-c, --cwd <path>", "Working directory", process.cwd())
  .option("-a, --agent <agent>", "Explicit reviewer agent override")
  .option("--base <commit>", "Git base branch/commit to diff against")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode)
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .option(
    "--context-session <sessionId>",
    "Worker/tester Bridge session whose evidence should be shared",
  )
  .option(
    "--context-sessions <sessionIds...>",
    "Up to 4 Bridge sessions injected first-hand, in the given order",
  )
  .action(
    async (agentOrTask: string | undefined, taskParts: string[], options: ReviewCommandOptions) => {
      try {
        const input = resolveReviewInput(
          agentOrTask,
          taskParts,
          options.agent,
          (value) => defaultRegistry.resolveName(value) !== undefined,
        );
        console.log(
          `[AgentMesh] Initiating independent Code Review using ${input.agent ? `'${input.agent}'` : "configured reviewer role"}...\n`,
        );
        const result = await defaultRunner.reviewChanges({
          agent: input.agent,
          task: input.task,
          cwd: options.cwd,
          baseCommit: options.base,
          mode: options.mode,
          timeoutMs: options.timeout,
          contextSessionId: options.contextSession,
          contextSessionIds: options.contextSessions,
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
    },
  );

program
  .command("config [cwd]")
  .description("Show and validate the nearest project .agentmesh/config.json")
  .action((cwd: string | undefined) => {
    try {
      const loaded = defaultRunner.getProjectConfiguration(cwd || process.cwd());
      if (!loaded) {
        console.error(`No .agentmesh/config.json found for '${cwd || process.cwd()}'.`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(loaded, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// Debug command: continue
debugProgram
  .command("continue <sessionId> <task>")
  .description("Directly continue a Bridge session for diagnostics")
  .option("-m, --mode <mode>", "Transport mode: auto | mcp | cli", parseMode, "auto")
  .option("-t, --timeout <ms>", "Execution timeout in milliseconds", parseTimeout)
  .option(
    "--context-sessions <sessionIds...>",
    "Up to 4 Bridge sessions injected alongside this session's own history",
  )
  .action(async (sessionId: string, task: string, options: ContinueCommandOptions) => {
    try {
      console.log(`[AgentMesh] Continuing session '${sessionId}'...\n`);
      const result = await defaultRunner.continueTask({
        sessionId,
        task,
        mode: options.mode,
        timeoutMs: options.timeout,
        contextSessionIds: options.contextSessions,
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
          "PATH / NOTE",
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
            pathStr,
        );
      }
      console.log(
        "\nTip: You can specify custom binary locations using environment variables (e.g. CODEX_BIN, CLAUDE_BIN, AGY_BIN, GROK_BIN).\n",
      );
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
        "CWD",
    );
    console.log("-".repeat(100));
    for (const s of sessions) {
      console.log(
        s.id.padEnd(28) +
          s.agent.padEnd(14) +
          s.role.padEnd(12) +
          String(s.history.length).padEnd(8) +
          s.updatedAt.padEnd(26) +
          s.cwd,
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
