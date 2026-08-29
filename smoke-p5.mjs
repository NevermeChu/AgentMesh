import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = "D:/temp_pip/smoke-ws-p5";
const EVIDENCE = "D:/temp_pip/smoke-evidence-p5";
const MODEL = "opencode/nemotron-3.5-lightning-free";
mkdirSync(EVIDENCE, { recursive: true });

if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
mkdirSync(join(WS, "src"), { recursive: true });
writeFileSync(
  join(WS, "src", "utils.ts"),
  "export function add(a: number, b: number): number {" +
    String.fromCharCode(10) +
    "  return a + b;" +
    String.fromCharCode(10) +
    "}" +
    String.fromCharCode(10) +
    String.fromCharCode(10) +
    "export function multiply(a: number, b: number): number {" +
    String.fromCharCode(10) +
    "  return a * b;" +
    String.fromCharCode(10) +
    "}" +
    String.fromCharCode(10),
  "utf-8",
);
writeFileSync(join(WS, "README.md"), "# Smoke workspace", "utf-8");
execSync("git init", { cwd: WS, stdio: "pipe" });
execSync("git add -A", { cwd: WS, stdio: "pipe" });
execSync("git -c user.name=T -c user.email=t@example.invalid commit -qm init", {
  cwd: WS,
  stdio: "pipe",
});
mkdirSync(join(WS, ".agentmesh"), { recursive: true });
writeFileSync(
  join(WS, ".agentmesh", "config.json"),
  JSON.stringify(
    {
      version: 1,
      roles: {
        worker: { agent: "opencode", mode: "cli", timeoutMs: 420000, model: MODEL },
        reviewer: {
          agent: "opencode",
          mode: "cli",
          timeoutMs: 420000,
          model: MODEL,
          safety: "best-effort",
        },
      },
      agents: {
        opencode: {
          tier: "weak",
          costLevel: 1,
          strengths: ["free-tier smoke", "simple edits"],
          notes: "zen free model for L4 smoke",
        },
      },
    },
    null,
    2,
  ),
  "utf-8",
);
console.log("workspace ready:", WS, "| model:", MODEL);

async function startServer() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(__dirname, "dist", "cli", "index.js"), "serve"],
    env: {
      ...process.env,
      PATH: "F:/node/node_global;" + process.env.PATH,
      OPENCODE_BIN: "F:/node/node_global/opencode.cmd",
    },
  });
  const client = new Client({ name: "smoke-p5", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}, timeout = 480000) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return { ...res, elapsedMs: Date.now() - t0 };
}

function text(res) {
  return (res.content ?? []).map((c) => c.text ?? "").join(String.fromCharCode(10));
}

function save(tag, res) {
  const out = typeof res === "string" ? res : text(res);
  writeFileSync(
    join(EVIDENCE, tag + ".log"),
    out + String.fromCharCode(10) + "elapsedMs=" + (res.elapsedMs ?? "?"),
    "utf-8",
  );
  console.log(
    "  [evidence] " + tag + ".log (" + out.length + " bytes, " + (res.elapsedMs ?? "?") + "ms)",
  );
  return out;
}

const client = await startServer();
console.log("MCP connected.");

const la = await callTool(client, "list_agents", { cwd: WS }, 60000);
const laText = save("00-list-agents", la);
console.log(
  "list_agents isError:",
  la.isError ?? false,
  "| opencode row present:",
  laText.includes("== opencode"),
);

const s1 = await callTool(client, "delegate_task", {
  task: "阅读 src/utils.ts，用中文总结每个函数的作用，每个函数一句话。",
  cwd: WS,
  role: "worker",
});
save("S1-readonly", s1);
console.log("S1 isError:", s1.isError ?? false);

const w1 = await callTool(client, "delegate_task", {
  task: "在 src/calc.ts 中实现 export function divide(a: number, b: number): number，只实现 happy path（直接返回 a / b）。不要做任何参数校验或除零检查。不要修改其他文件。",
  cwd: WS,
  role: "worker",
});
save("S4-worker-turn1", w1);
console.log("worker turn1 isError:", w1.isError ?? false);

function extractSessionId(t) {
  const marker = "Session: ";
  const i = t.indexOf(marker);
  if (i < 0) return undefined;
  return t
    .slice(i + marker.length)
    .split("]")[0]
    .trim();
}
const workerSessionId = extractSessionId(text(w1));
console.log("worker session:", workerSessionId);
console.log("worker session:", workerSessionId);

const rv = await callTool(
  client,
  "review_changes",
  {
    task: "审查工作树中的变更，重点：divide 函数是否正确处理除零（b=0 时必须抛出带说明的错误）。若除零未处理，这是 P1 缺陷，必须 FAIL。",
    cwd: WS,
    maxReworkRounds: 2,
    workerSessionId,
  },
  600000,
);
const rvText = save("S4-rework-loop", rv);
const lines = rvText.split(String.fromCharCode(10));
console.log(
  "review isError:",
  rv.isError ?? false,
  "| outcome:",
  lines.find((l) => l.includes("Review Outcome:")) || "?",
  "| rework:",
  lines.find((l) => l.includes("Rework Evidence:"))?.slice(0, 300) || "(none)",
);

await client.close();
console.log("done.");
