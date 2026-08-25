import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../../src/agents/antigravity.js";
import { ClaudeAdapter } from "../../src/agents/claude.js";
import { CodexAdapter } from "../../src/agents/codex.js";

describe("CLI adapter process integration", () => {
  let temporaryDirectory: string;
  let originalAgyBin: string | undefined;
  let originalClaudeBin: string | undefined;
  let originalCodexBin: string | undefined;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-adapter-integ-"));
    originalAgyBin = process.env.AGY_BIN;
    originalClaudeBin = process.env.CLAUDE_BIN;
    originalCodexBin = process.env.CODEX_BIN;
  });

  afterEach(async () => {
    restoreEnvironment("AGY_BIN", originalAgyBin);
    restoreEnvironment("CLAUDE_BIN", originalClaudeBin);
    restoreEnvironment("CODEX_BIN", originalCodexBin);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("parses a Codex worker process result", async () => {
    const executable = await createFakeExecutable(temporaryDirectory);
    const capturePath = path.join(temporaryDirectory, "codex-args.json");
    process.env.CODEX_BIN = executable;

    const task = 'Implement a cache\nPreserve "quotes", 100% values & literal | pipes!';
    const result = await new CodexAdapter().run({
      task,
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
      env: {
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_STDOUT: [
          JSON.stringify({ type: "thread.started", thread_id: "native-codex-integ" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Worker completed the cache." },
          }),
        ].join("\n"),
      },
    });

    const args = JSON.parse(await fs.readFile(capturePath, "utf8")) as unknown;
    expect(result).toMatchObject({
      status: "success",
      finalAnswer: "Worker completed the cache.",
      nativeSessionId: "native-codex-integ",
      transportUsed: "cli",
    });
    const sandboxConfig = 'sandbox_mode="workspace-write"';
    expect(args).toEqual(expect.arrayContaining(["exec", "-c", sandboxConfig, "--json"]));
    expect(Array.isArray(args) && args.some((argument) => String(argument).includes(task))).toBe(
      true,
    );
  });

  it("enforces Antigravity reviewer process arguments", async () => {
    const executable = await createFakeExecutable(temporaryDirectory);
    const capturePath = path.join(temporaryDirectory, "antigravity-args.json");
    process.env.AGY_BIN = executable;

    const result = await new AntigravityAdapter().run({
      task: "Review the cache implementation",
      cwd: temporaryDirectory,
      role: "reviewer",
      mode: "cli",
      env: {
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_STDOUT: JSON.stringify({
          status: "SUCCESS",
          response: "PASS\nNo findings.",
          conversation_id: "native-antigravity-integ",
        }),
      },
    });

    const args = JSON.parse(await fs.readFile(capturePath, "utf8")) as unknown;
    expect(result).toMatchObject({
      status: "success",
      reviewOutcome: "PASS",
      nativeSessionId: "native-antigravity-integ",
      transportUsed: "cli",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--dangerously-skip-permissions", "--mode", "plan"]),
    );
    if (process.platform === "win32") {
      expect(args).not.toEqual(expect.arrayContaining(["--sandbox"]));
    } else {
      expect(args).toEqual(expect.arrayContaining(["--sandbox"]));
    }
  });

  it("keeps a successful Claude run despite auxiliary stderr diagnostics", async () => {
    const executable = await createFakeExecutable(temporaryDirectory);
    const capturePath = path.join(temporaryDirectory, "claude-args.json");
    process.env.CLAUDE_BIN = executable;

    const result = await new ClaudeAdapter().run({
      task: "Review the diff",
      cwd: temporaryDirectory,
      role: "reviewer",
      mode: "cli",
      env: {
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_STDOUT: JSON.stringify({
          session_id: "claude-integ-12345678",
          is_error: false,
          result: "PASS\nReview completed cleanly.",
        }),
        FAKE_STDERR:
          '[claude-code:unrecognized_model] {"model":"proxy-model","query_source":"generate_session_title"}',
      },
    });

    expect(result).toMatchObject({
      status: "success",
      reviewOutcome: "PASS",
      nativeSessionId: "claude-integ-12345678",
      transportUsed: "cli",
    });
  });
  it("keeps a successful Codex run despite a trailing structured error event", async () => {
    const executable = await createFakeExecutable(temporaryDirectory);
    const capturePath = path.join(temporaryDirectory, "codex-args.json");
    process.env.CODEX_BIN = executable;

    const result = await new CodexAdapter().run({
      task: "Finish the feature",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
      env: {
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_STDOUT: [
          JSON.stringify({ type: "error", error: "context canceled" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "PASS\nFeature complete." },
          }),
        ].join("\n"),
      },
    });

    // Partial success must not be discarded (regression for P3/P8 residue):
    // a clean exit plus a substantive final message wins over teardown noise.
    expect(result.status).toBe("success");
    expect(result.finalAnswer).toContain("Feature complete.");
    expect(result.warning).toContain("context canceled");
  });

  it("still fails a Codex run whose structured error has no substantive output", async () => {
    const executable = await createFakeExecutable(temporaryDirectory);
    const capturePath = path.join(temporaryDirectory, "codex-args.json");
    process.env.CODEX_BIN = executable;

    const result = await new CodexAdapter().run({
      task: "Fail clearly",
      cwd: temporaryDirectory,
      role: "worker",
      mode: "cli",
      env: {
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_STDOUT: JSON.stringify({ type: "error", error: "quota exceeded" }),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("quota exceeded");
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createFakeExecutable(directory: string): Promise<string> {
  const scriptPath = path.join(directory, "fake-agent.mjs");
  await fs.writeFile(
    scriptPath,
    [
      'import fs from "node:fs";',
      "fs.writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));",
      'process.stdout.write(process.env.FAKE_STDOUT || "");',
      'process.stderr.write(process.env.FAKE_STDERR || "");',
      'process.exit(Number(process.env.FAKE_EXIT_CODE || "0"));',
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    const wrapperPath = path.join(directory, "fake-agent.cmd");
    await fs.writeFile(wrapperPath, '@ECHO off\nnode "%~dp0\\fake-agent.mjs" %*\n', "utf8");
    return wrapperPath;
  }

  const wrapperPath = path.join(directory, "fake-agent");
  await fs.writeFile(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-agent.mjs" "$@"\n`,
    "utf8",
  );
  await fs.chmod(wrapperPath, 0o755);
  return wrapperPath;
}
