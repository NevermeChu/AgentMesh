import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatNormalizedResultDetailed } from "../../src/mcp/tools.js";
import type { AgentResult } from "../../src/agents/types.js";

describe("mcp artifact spill rendering (T2.2)", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_spill_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const baseResult = (overrides: Partial<AgentResult>): AgentResult => ({
    status: "success",
    agent: "codex",
    summary: "Task completed",
    output: "",
    sessionId: "bridge-sess_spill",
    ...overrides,
  });

  it("replaces an oversized final answer with a bounded preview plus artifact pointer", async () => {
    const bigAnswer = `${"A".repeat(50_000)}!`;
    const auditRecords: Array<{
      source: string;
      chars: number;
      sha256: string;
      artifactPath: string;
    }> = [];
    const lines = await formatNormalizedResultDetailed(baseResult({ finalAnswer: bigAnswer }), {
      sessionId: "bridge-sess_spill",
      turnNumber: 7,
      artifactHomeDir: homeDir,
      registerAudit: (record) => {
        auditRecords.push(record);
        return { file: "contexts/bridge-sess_spill/007.artifact.json" };
      },
    });

    const block = lines.find((line) => line.includes("Final Answer Spilled To Artifact"));
    expect(block).toBeDefined();
    expect(block).toContain(
      `Artifact Path: ${path.join(homeDir, "artifacts", "bridge-sess_spill", "turn-7.txt")}`,
    );
    expect(block).toContain("[hasMore: true]");

    // Full text is on disk verbatim — zero truncation loss.
    const stored = fs.readFileSync(
      path.join(homeDir, "artifacts", "bridge-sess_spill", "turn-7.txt"),
      "utf-8",
    );
    expect(stored).toBe(bigAnswer);
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      source: "finalAnswer",
      chars: bigAnswer.length,
      artifactPath: path.join(homeDir, "artifacts", "bridge-sess_spill", "turn-7.txt"),
    });
    expect(auditRecords[0]!.sha256).toHaveLength(64);

    // The preview inside the response stays within the 2KB budget.
    const preview = block!.slice(block!.indexOf("Preview:") + "Preview:\n".length);
    expect(preview.length).toBeLessThanOrEqual(2_100);
  });

  it("keeps sub-threshold answers on the legacy rendering path", async () => {
    const lines = await formatNormalizedResultDetailed(
      baseResult({ finalAnswer: "compact answer", output: "" }),
      {
        sessionId: "bridge-sess_spill",
        turnNumber: 1,
        artifactHomeDir: homeDir,
      },
    );

    expect(lines).toContain("Final Answer:\ncompact answer");
    expect(fs.existsSync(homeDir)).toBe(false);
  });
});
