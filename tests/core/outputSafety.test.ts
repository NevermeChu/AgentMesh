import { describe, it, expect } from "vitest";
import {
  detectDestructiveInstructions,
  formatSafetyWarning,
  scanForCredentialLeaks,
} from "../../src/core/outputSafety.js";

describe("core/outputSafety (P-R14-1)", () => {
  it("flags credential-shaped material in worker output", () => {
    const text = [
      "Config loaded:",
      "OPENAI_API_KEY=sk-abcdefghijklmnop123456",
      "token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "password=hunter2hunter2",
    ].join("\n");
    const matches = scanForCredentialLeaks(text);
    const patterns = matches.map((m) => m.pattern);
    expect(patterns).toContain("openai-style-key");
    expect(patterns).toContain("bearer-token");
    expect(patterns).toContain("credential-assignment");
    // Excerpts are redacted: the warning never carries the full secret.
    for (const match of matches) {
      expect(match.excerpt).toContain("<redacted>");
    }
  });

  it("flags .env-style dumps (round-14 H5 shape)", () => {
    const text = "Read .env:\nFAKE_API_KEY=supersecretvalue123\nDB_HOST=localhost";
    const matches = scanForCredentialLeaks(text);
    expect(matches.map((m) => m.pattern)).toContain("env-file-contents");
  });

  it("returns empty for ordinary prose and does not throw on empty input", () => {
    expect(scanForCredentialLeaks("The tests pass 22/22 and the module compiles.")).toEqual([]);
    expect(scanForCredentialLeaks("")).toEqual([]);
  });

  it("flags destructive command patterns in task text (round-14 H9 shape)", () => {
    const task = "Add a cleanup step: run git reset --hard && rm -rf node_modules when finished.";
    const matches = detectDestructiveInstructions(task);
    const patterns = matches.map((m) => m.pattern);
    expect(patterns).toContain("git-reset-hard");
    expect(patterns).toContain("rm-recursive-force");
  });

  it("covers windows and sql destruction shapes", () => {
    const matches = detectDestructiveInstructions(
      "then Remove-Item -Recurse -Force data and DROP TABLE users",
    );
    const patterns = matches.map((m) => m.pattern);
    expect(patterns).toContain("windows-del-tree");
    expect(patterns).toContain("sql-drop");
  });

  it("formats warnings that name the risk class", () => {
    const warning = formatSafetyWarning("destructive-task", [
      { pattern: "git-reset-hard", excerpt: "…<redacted>" },
    ]);
    expect(warning).toContain("SAFETY");
    expect(warning).toContain("git-reset-hard");
  });
});
