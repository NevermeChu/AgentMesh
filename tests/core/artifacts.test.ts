import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactExistsError,
  ARTIFACT_PREVIEW_BYTES,
  ARTIFACT_SPILL_THRESHOLD_CHARS,
  buildPreview,
  persistArtifact,
  selectArtifactSpill,
} from "../../src/core/artifacts.js";

describe("core/artifacts", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_art_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists an artifact verbatim and returns its absolute path plus sha256", async () => {
    const content = "line one\nline two\n";
    const ref = await persistArtifact("bridge-sess_abc", 3, content, { homeDir });

    const expectedPath = path.join(homeDir, "artifacts", "bridge-sess_abc", "turn-3.txt");
    expect(ref.path).toBe(expectedPath);
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe(content);
    expect(ref.sha256).toBe(crypto.createHash("sha256").update(content, "utf-8").digest("hex"));
    expect(ref.chars).toBe(content.length);
  });

  it("fails a conflicting 'wx' write without overwriting the original bytes", async () => {
    await persistArtifact("bridge-sess_abc", 1, "original body", { homeDir });

    await expect(
      persistArtifact("bridge-sess_abc", 1, "second author body", { homeDir }),
    ).rejects.toBeInstanceOf(ArtifactExistsError);

    // The first author's content is untouched.
    const filePath = path.join(homeDir, "artifacts", "bridge-sess_abc", "turn-1.txt");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original body");
  });

  it("rejects sessionIds that carry traversal or separator segments", async () => {
    for (const evil of ["../escape", "..\\escape", "a/b", "a\\b", "..", "", "  ", "nul\0id"]) {
      await expect(persistArtifact(evil, 1, "x", { homeDir })).rejects.toBeInstanceOf(Error);
    }
    // Nothing was written anywhere under artifacts/.
    expect(fs.existsSync(path.join(homeDir, "artifacts"))).toBe(false);
  });

  it("builds previews within budget and keeps short content verbatim", () => {
    const short = "small output";
    expect(buildPreview(short)).toEqual({ preview: short, truncated: false });
    expect(buildPreview(short, ARTIFACT_PREVIEW_BYTES).truncated).toBe(false);
  });

  it("cuts long previews at a newline boundary when one sits past the halfway mark", () => {
    const firstLine = "a".repeat(1500);
    const content = `${firstLine}\n${"b".repeat(3000)}`;
    const { preview, truncated } = buildPreview(content, 2000);

    expect(truncated).toBe(true);
    // The cut lands exactly on the newline after the first full line.
    expect(preview).toBe(firstLine);
    expect(preview.length).toBe(1500);
  });

  it("falls back to the exact byte cut without any newline in range", () => {
    const content = "x".repeat(5000);
    const { preview, truncated } = buildPreview(content, 2000);

    expect(truncated).toBe(true);
    expect(preview).toHaveLength(2000);
  });

  it("spills strictly above the 50k threshold (exactly-at does not spill)", () => {
    expect(ARTIFACT_SPILL_THRESHOLD_CHARS).toBe(50_000);

    const atThreshold = "y".repeat(ARTIFACT_SPILL_THRESHOLD_CHARS);
    expect(selectArtifactSpill(atThreshold, undefined)).toBeUndefined();

    const overThreshold = `${atThreshold}!`;
    expect(selectArtifactSpill(overThreshold, undefined)).toEqual({
      source: "finalAnswer",
      content: overThreshold,
    });
  });

  it("spills an oversized raw output only when it differs from the final answer", () => {
    const bigOutput = "z".repeat(ARTIFACT_SPILL_THRESHOLD_CHARS + 1);
    const smallAnswer = "concise answer";

    expect(selectArtifactSpill(smallAnswer, bigOutput)).toEqual({
      source: "rawOutput",
      content: bigOutput,
    });
    // Same text in both sections spills once, not twice.
    expect(selectArtifactSpill(bigOutput, bigOutput)?.source).toBe("finalAnswer");
    expect(selectArtifactSpill(undefined, undefined)).toBeUndefined();
  });
});
