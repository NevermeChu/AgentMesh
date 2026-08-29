import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/agents/codex.js";

const SALVAGE_THREAD_ID = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";

describe("agents/codex-channel wiring", () => {
  let temporaryDirectory: string;
  let originalCodexBin: string | undefined;
  const fakeEnvOriginals = new Map<string, string | undefined>();

  /** Fixture variables must ride the parent environment snapshot: the env
   * override whitelist drops unknown keys by design (T3.3), so test harnesses
   * inject fixture state the same way a real host would carry it. */
  function setFakeEnv(name: string, value: string): void {
    if (!fakeEnvOriginals.has(name)) fakeEnvOriginals.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-codex-channel-"));
    originalCodexBin = process.env.CODEX_BIN;
  });

  afterEach(async () => {
    restoreEnvironment("CODEX_BIN", originalCodexBin);
    for (const [name, value] of fakeEnvOriginals) restoreEnvironment(name, value);
    fakeEnvOriginals.clear();
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("prefers the official --output-last-message channel over JSONL scraping", async () => {
    const { capturePath } = installFakeCodex();
    setFakeEnv("AGENTMESH_FAKE_CAPTURE_PATH", capturePath);
    setFakeEnv("FAKE_LAST_MESSAGE_CONTENT", "OFFICIAL final answer.");
    setFakeEnv(
      "AGENTMESH_FAKE_STDOUT",
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-official-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "JSONL fallback answer." },
        }),
      ].join("\n"),
    );
    const result = await new CodexAdapter().run({
      task: "Implement feature",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
    });

    expect(result.status).toBe("success");
    expect(result.finalAnswer).toBe("OFFICIAL final answer.");
    expect(result.warning ?? "").not.toContain("fallback");
    const captured = readCapture(capturePath);
    expect(captured.argv).toContain("--output-last-message");
  });

  it("falls back to JSONL parsing with a warning when the official file is empty", async () => {
    const { capturePath } = installFakeCodex();
    setFakeEnv("AGENTMESH_FAKE_CAPTURE_PATH", capturePath);
    setFakeEnv(
      "AGENTMESH_FAKE_STDOUT",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered from JSONL." },
      }),
    );
    const result = await new CodexAdapter().run({
      task: "Implement feature",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
    });

    expect(result.status).toBe("success");
    expect(result.finalAnswer).toBe("Recovered from JSONL.");
    expect(result.warning).toContain("--output-last-message");
    expect(result.warning).toContain("fallback");
  });

  it("records thread-cumulative usage from turn.completed events", async () => {
    installFakeCodex();
    setFakeEnv("FAKE_LAST_MESSAGE_CONTENT", "Done.");
    setFakeEnv(
      "AGENTMESH_FAKE_STDOUT",
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-usage-9" }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 200,
            cached_input_tokens: 50,
            cache_write_input_tokens: 10,
            output_tokens: 80,
            reasoning_output_tokens: 25,
          },
        }),
      ].join("\n"),
    );
    const result = await new CodexAdapter().run({
      task: "Implement feature",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
    });

    expect(result.status).toBe("success");
    expect(result.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 10,
      outputTokens: 80,
      reasoningOutputTokens: 25,
      totalTokens: undefined,
    });
    expect(result.nativeSessionId).toBe("thread-usage-9");
  });

  it("salvages the completed answer and usage from rollout after abnormal death", async () => {
    installFakeCodex();
    const codexHome = path.join(temporaryDirectory, "codex-home");
    setFakeEnv("FAKE_ROLLOUT_SESSION_ID", SALVAGE_THREAD_ID);
    setFakeEnv("FAKE_ROLLOUT_ANSWER", "Salvaged final answer.");
    setFakeEnv(
      "AGENTMESH_FAKE_STDOUT",
      JSON.stringify({
        type: "thread.started",
        thread_id: SALVAGE_THREAD_ID,
      }),
    );
    setFakeEnv("AGENTMESH_FAKE_EXIT_CODE", "137");
    const result = await new CodexAdapter().run({
      task: "Long running task",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(137);
    expect(result.finalAnswer).toBe("Salvaged final answer.");
    // Recovered usage comes from the rollout token_count totals.
    expect(result.usage).toMatchObject({ inputTokens: 11, totalTokens: 23 });
    expect(result.warning).toContain("Crash salvage");
    expect(result.warning).toContain("rollout");
  });

  it("rejects bypass flags with a structured error before spawning", async () => {
    const { capturePath } = installFakeCodex();
    const result = await new CodexAdapter().run({
      task: "Try to escape",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
      extraArgs: ["--yolo"],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("--yolo");
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it("enforces the reviewer output-schema contract and machine-readable verdicts", async () => {
    const { capturePath } = installFakeCodex();
    setFakeEnv("AGENTMESH_FAKE_CAPTURE_PATH", capturePath);
    setFakeEnv(
      "FAKE_LAST_MESSAGE_CONTENT",
      JSON.stringify({
        verdict: "PASS",
        findings: [],
      }),
    );
    setFakeEnv("AGENTMESH_FAKE_STDOUT", "review finished");
    const result = await new CodexAdapter().run({
      task: "Review changes",
      cwd: temporaryDirectory,
      role: "reviewer",
      baseCommit: "main",
      mode: "cli",
      reviewVerdictRequired: true,
    });

    const captured = readCapture(capturePath);
    // The schema contract file existed when codex spawned and declares verdict.
    expect(captured.schemaFileExisted).toBe(true);
    expect(captured.argv).toContain("--output-schema");

    expect(result.status).toBe("success");
    expect(result.reviewOutcome).toBe("PASS");
    expect(result.summary).toContain("Review PASSED");
    expect(result.warning).toContain("--output-schema structured response");
  });

  it("fails a reviewer run whose schema verdict is FAIL", async () => {
    installFakeCodex();
    const failResult = await runReviewerWithVerdict({
      verdict: "FAIL",
      findings: [{ severity: "critical", file: "src/x.ts", issue: "RCE via deserialization" }],
    });

    expect(failResult.status).toBe("failed");
    expect(failResult.reviewOutcome).toBe("FAIL");
    expect(failResult.findings).toHaveLength(1);
    expect(failResult.summary).toContain("Review FAILED");
  });

  function installFakeCodex(): { scriptPath: string; capturePath: string } {
    const scriptPath = path.join(temporaryDirectory, "fake-codex.mjs");
    fs.writeFileSync(
      scriptPath,
      [
        'import fs from "node:fs";',
        "const args = process.argv.slice(2);",
        "if (process.env.AGENTMESH_FAKE_CAPTURE_PATH) {",
        '  const schemaIndex = args.indexOf("--output-schema");',
        "  const schemaPath = schemaIndex !== -1 ? args[schemaIndex + 1] : undefined;",
        "  let schemaFileExisted = null;",
        "  let schemaReadError = null;",
        "  if (schemaPath) {",
        "    try {",
        '      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));',
        "      schemaFileExisted = Boolean(schema && schema.properties && schema.properties.verdict);",
        "    }",
        "    catch (e) { schemaFileExisted = false; schemaReadError = String(e && e.message); }",
        "  }",
        "  fs.writeFileSync(process.env.AGENTMESH_FAKE_CAPTURE_PATH, JSON.stringify({ argv: args, schemaFileExisted, schemaReadError }));",
        "}",
        "if (process.env.FAKE_LAST_MESSAGE_CONTENT) {",
        '  const index = args.indexOf("--output-last-message");',
        "  if (index !== -1 && args[index + 1]) fs.writeFileSync(args[index + 1], process.env.FAKE_LAST_MESSAGE_CONTENT);",
        "}",
        "if (process.env.FAKE_ROLLOUT_SESSION_ID && process.env.CODEX_HOME) {",
        "  const now = new Date();",
        '  const pad = (n) => String(n).padStart(2, "0");',
        "  const dayDir = `${process.env.CODEX_HOME}/sessions/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;",
        "  fs.mkdirSync(dayDir, { recursive: true });",
        "  const id = process.env.FAKE_ROLLOUT_SESSION_ID;",
        "  const lines = [",
        '    JSON.stringify({ timestamp: "2026-08-26T10:00:00Z", type: "session_meta", payload: { id, cwd: process.cwd(), history_mode: "legacy" } }),',
        '    JSON.stringify({ timestamp: "2026-08-26T10:05:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: process.env.FAKE_ROLLOUT_ANSWER } }),',
        '    JSON.stringify({ timestamp: "2026-08-26T10:05:01Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 23 } } } }),',
        "  ];",
        '  fs.writeFileSync(`${dayDir}/rollout-2026-08-26T10-00-00-${id}.jsonl`, lines.join("\\n"));',
        "}",
        'process.stdout.write(process.env.AGENTMESH_FAKE_STDOUT || "");',
        'process.stderr.write(process.env.AGENTMESH_FAKE_STDERR || "");',
        'process.exit(Number(process.env.AGENTMESH_FAKE_EXIT_CODE || "0"));',
      ].join("\n"),
      "utf8",
    );

    if (process.platform === "win32") {
      const wrapperPath = path.join(temporaryDirectory, "fake-codex.cmd");
      fs.writeFileSync(wrapperPath, '@ECHO off\nnode "%~dp0\\fake-codex.mjs" %*\n', "utf8");
      process.env.CODEX_BIN = wrapperPath;
    } else {
      const wrapperPath = path.join(temporaryDirectory, "fake-codex");
      fs.writeFileSync(
        wrapperPath,
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.mjs" "$@"\n`,
        "utf8",
      );
      fs.chmodSync(wrapperPath, 0o755);
      process.env.CODEX_BIN = wrapperPath;
    }
    return {
      scriptPath,
      capturePath: path.join(temporaryDirectory, "codex-args.json"),
    };
  }

  async function runReviewerWithVerdict(verdictPayload: unknown) {
    setFakeEnv("FAKE_LAST_MESSAGE_CONTENT", JSON.stringify(verdictPayload));
    return new CodexAdapter().run({
      task: "Review again",
      cwd: temporaryDirectory,
      role: "reviewer",
      mode: "cli",
    });
  }
});

interface FakeCapture {
  argv: string[];
  schemaFileExisted: boolean | null;
  schemaReadError: string | null;
}

function readCapture(capturePath: string): FakeCapture {
  return JSON.parse(fs.readFileSync(capturePath, "utf8")) as FakeCapture;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
