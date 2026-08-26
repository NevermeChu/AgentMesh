import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexRolloutError,
  locateRolloutFiles,
  parseRolloutFile,
  recoverCodexRollout,
  resolveCodexHome,
} from "../../src/core/codexRollout.js";

const THREAD_ID = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";

function sessionMetaLine(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-08-26T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      timestamp: "2026-08-26T10:00:00.000Z",
      cwd: "D:/repo",
      originator: "codex_cli_rs",
      cli_version: "0.99.0",
      history_mode: "legacy",
      ...overrides,
    },
  });
}

function taskCompleteLine(message: string): string {
  return JSON.stringify({
    timestamp: "2026-08-26T10:05:00.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: message,
    },
  });
}

function tokenCountLine(total: Record<string, number>): string {
  return JSON.stringify({
    timestamp: "2026-08-26T10:05:01.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: total,
        model_context_window: 272000,
      },
      rate_limits: null,
    },
  });
}

function agentMessageLine(message: string): string {
  return JSON.stringify({
    timestamp: "2026-08-26T10:04:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message },
  });
}

describe("core/codexRollout", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const dir = temporaryDirectories.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function createHome(): Promise<string> {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agentmesh-rollout-"));
    temporaryDirectories.push(home);
    return home;
  }

  function writeRolloutSync(home: string, fileName: string, lines: string[], day = "2026/08/26") {
    const dayDir = path.join(home, "sessions", ...day.split("/"));
    fs.mkdirSync(dayDir, { recursive: true });
    const filePath = path.join(dayDir, fileName);
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    return filePath;
  }

  it("recovers the completed answer and cumulative usage from a rollout tail", async () => {
    const home = await createHome();
    writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      sessionMetaLine(),
      agentMessageLine("working on it"),
      taskCompleteLine("Final recovered answer."),
      tokenCountLine({
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 5,
        output_tokens: 60,
        reasoning_output_tokens: 12,
        total_tokens: 177,
      }),
    ]);

    const recovery = await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home });
    expect(recovery).toMatchObject({
      sessionId: THREAD_ID,
      historyMode: "legacy",
      cwd: "D:/repo",
      lastAgentMessage: "Final recovered answer.",
      partialAgentMessage: "working on it",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 5,
        outputTokens: 60,
        reasoningOutputTokens: 12,
        totalTokens: 177,
      },
    });
  });

  it("keeps the latest task_complete and token_count when several are persisted", async () => {
    const home = await createHome();
    writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      sessionMetaLine(),
      taskCompleteLine("older answer"),
      tokenCountLine({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
      taskCompleteLine("newer answer"),
      tokenCountLine({ input_tokens: 10, output_tokens: 20, total_tokens: 30 }),
    ]);

    const recovery = await parseRolloutFile(
      path.join(
        home,
        "sessions",
        "2026",
        "08",
        "26",
        `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`,
      ),
    );
    expect(recovery.lastAgentMessage).toBe("newer answer");
    expect(recovery.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("rejects a rollout whose first meaningful line is not session_meta", async () => {
    const home = await createHome();
    const filePath = writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      JSON.stringify({
        timestamp: "2026-08-26T10:00:00.000Z",
        type: "response_item",
        payload: { type: "message" },
      }),
      sessionMetaLine(),
    ]);

    await expect(parseRolloutFile(filePath)).rejects.toThrow(
      /does not start with session metadata/,
    );
    expect(await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home })).toBeUndefined();
  });

  it("rejects an unknown history_mode instead of silently trusting the file", async () => {
    const home = await createHome();
    const filePath = writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      sessionMetaLine({ history_mode: "mystery-mode" }),
    ]);

    await expect(parseRolloutFile(filePath)).rejects.toBeInstanceOf(CodexRolloutError);
    await expect(parseRolloutFile(filePath)).rejects.toThrow(
      /invalid session metadata history_mode/,
    );
  });

  it("rejects a rollout whose header id does not match the requested thread", async () => {
    const home = await createHome();
    const otherId = "00000000-1111-2222-3333-444444444444";
    const filePath = writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${otherId}.jsonl`, [
      sessionMetaLine({ id: otherId }),
    ]);

    await expect(parseRolloutFile(filePath, THREAD_ID)).rejects.toThrow(/belongs to thread/);
    // Recovery by another id still finds nothing because the header id wins.
    expect(await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home })).toBeUndefined();
  });

  it("matches ids case-insensitively and follows revert-suffixed rollout files", async () => {
    const home = await createHome();
    writeRolloutSync(
      home,
      `rollout-2026-08-26T10-00-00-${THREAD_ID.toUpperCase()}_ab12cd34.jsonl`,
      [sessionMetaLine(), taskCompleteLine("revert rollout answer")],
    );

    const candidates = await locateRolloutFiles(THREAD_ID, home);
    expect(candidates).toHaveLength(1);

    const recovery = await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home });
    expect(recovery?.lastAgentMessage).toBe("revert rollout answer");
  });

  it("prefers the newest candidate across days and skips untrustworthy ones", async () => {
    const home = await createHome();
    writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      "{corrupt json line without closing",
    ]);
    writeRolloutSync(
      home,
      `rollout-2026-08-25T09-00-00-${THREAD_ID}.jsonl`,
      [sessionMetaLine(), taskCompleteLine("older valid answer")],
      "2026/08/25",
    );

    const candidates = await locateRolloutFiles(THREAD_ID, home);
    expect(candidates).toHaveLength(2);
    // Newest day first even though it cannot be trusted.
    expect(candidates[0]).toContain("2026-08-26T10");

    const recovery = await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home });
    expect(recovery?.rolloutPath).toContain("2026-08-25T09");
    expect(recovery?.lastAgentMessage).toBe("older valid answer");
  });

  it("falls back to the last persisted agent_message for mid-turn crashes", async () => {
    const home = await createHome();
    writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl`, [
      sessionMetaLine(),
      agentMessageLine("partial progress before SIGKILL"),
    ]);

    const recovery = await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home });
    expect(recovery?.lastAgentMessage).toBeUndefined();
    expect(recovery?.partialAgentMessage).toBe("partial progress before SIGKILL");
  });

  it("reports zstd rollouts honestly when the runtime cannot decode them", async () => {
    const nativeZstd =
      typeof (zlib as unknown as Record<string, unknown>).zstdDecompressSync === "function";
    const home = await createHome();
    const filePath = writeRolloutSync(home, `rollout-2026-08-26T10-00-00-${THREAD_ID}.jsonl.zst`, [
      sessionMetaLine(),
    ]);
    // Overwrite with bytes that are not even a valid zstd frame header.
    await fsp.writeFile(filePath, Buffer.from([0x28, 0x00, 0x00, 0xff]));

    if (!nativeZstd) {
      await expect(parseRolloutFile(filePath)).rejects.toThrow(
        /zstd decompression is not available/,
      );
    }
    // A corrupt compressed payload must never be presented as a recovery.
    expect(await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home })).toBeUndefined();
  });

  it("returns undefined without throwing when no sessions exist", async () => {
    const home = await createHome();
    expect(await recoverCodexRollout({ sessionId: THREAD_ID, codexHome: home })).toBeUndefined();
    expect(await recoverCodexRollout({ sessionId: "", codexHome: home })).toBeUndefined();
  });

  it("resolves CODEX_HOME from explicit argument, env, then the default home", async () => {
    const originalEnv = process.env.CODEX_HOME;
    try {
      delete process.env.CODEX_HOME;
      expect(resolveCodexHome()).toBe(path.join(os.homedir(), ".codex"));
      process.env.CODEX_HOME = "D:/custom-codex-home";
      expect(resolveCodexHome()).toBe(path.resolve("D:/custom-codex-home"));
      expect(resolveCodexHome("E:/explicit-home")).toBe(path.resolve("E:/explicit-home"));
    } finally {
      restoreCodexHomeEnv(originalEnv);
    }
  });
});

function restoreCodexHomeEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
}
