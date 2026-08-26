import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMEOUT_MS,
  collectConfigSemanticIssues,
  parseMode,
  parseRole,
  parseTimeout,
  renderConfigValidationReport,
  resolveReviewInput,
  resolveRunInput,
  validateConfigFile,
} from "../../src/cli/validation.js";
import type { AgentNameResolver } from "../../src/cli/validation.js";

describe("cli/validation", () => {
  it("accepts supported roles and modes", () => {
    expect(parseRole("reviewer")).toBe("reviewer");
    expect(parseMode("mcp")).toBe("mcp");
  });

  it("rejects invalid roles and modes instead of silently using worker or CLI behavior", () => {
    expect(() => parseRole("reviewre")).toThrow("Role must be");
    expect(() => parseMode("typo")).toThrow("Mode must be");
  });

  it("requires a positive bounded integer timeout", () => {
    expect(parseTimeout("1500")).toBe(1500);
    for (const invalid of ["abc", "0", "-1", "1.5", String(MAX_TIMEOUT_MS + 1)]) {
      expect(() => parseTimeout(invalid)).toThrow("Timeout must be");
    }
  });

  it("supports both legacy explicit-agent and configured-role run syntax", () => {
    expect(resolveRunInput("antigravity", ["implement feature"], undefined)).toEqual({
      agent: "antigravity",
      task: "implement feature",
    });
    expect(resolveRunInput("implement feature", [], undefined)).toEqual({
      task: "implement feature",
    });
    expect(resolveRunInput("implement", ["feature"], "claude")).toEqual({
      agent: "claude",
      task: "implement feature",
    });
  });

  it("resolves review input without confusing a known agent with a review task", () => {
    const known = (value: string) => value === "claude";
    expect(resolveReviewInput("claude", [], undefined, known)).toEqual({ agent: "claude" });
    expect(resolveReviewInput("focus on auth", [], undefined, known)).toEqual({
      task: "focus on auth",
    });
  });
});

describe("cli/config validate", () => {
  const resolver: AgentNameResolver = (value) => {
    const known = new Set(["codex", "claude", "opencode", "zcode", "codex-cli"]);
    return known.has(value.toLowerCase().trim()) ? value.toLowerCase().trim() : undefined;
  };

  it("reports no issues for a resolvable roles-only config", () => {
    expect(
      collectConfigSemanticIssues({ version: 1, roles: { worker: { agent: "codex" } } }, resolver),
    ).toEqual([]);
  });

  it("errors on an unresolvable role assignment with the exact field path and a fix", () => {
    const issues = collectConfigSemanticIssues(
      { version: 1, roles: { worker: { agent: "codexx" } } },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "error",
      field: "roles.worker.agent",
    });
    expect(issues[0]?.fix).toContain('"codex"');
  });

  it("keeps unresolvable agents keys as warned profile-variant ids, not errors", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { "codex-strong": { tier: "strong", sandboxLevel: "native-sandbox" } },
      },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.field).toBe("agents.codex-strong");
  });

  it("warns when tier=strong declares only prompt-only protection", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { codex: { tier: "strong", sandboxLevel: "prompt-only" } },
      },
      resolver,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "agents.codex.sandboxLevel",
    });
  });

  it("accepts candidates referencing aliases or sibling entries but errors on dangling ones", () => {
    const valid = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: {
          zcode: { tier: "weak", candidates: ["codex-medium"] },
          "codex-medium": { tier: "medium", candidates: ["codex-cli"] },
          codex: { tier: "strong" },
        },
      },
      resolver,
    );
    expect(valid.filter((issue) => issue.severity === "error")).toEqual([]);

    const dangling = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { zcode: { candidates: ["codex-max"] } },
      },
      resolver,
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({
      severity: "error",
      field: "agents.zcode.candidates.0",
    });
    expect(dangling[0]?.fix).toContain('Declare an "agents"."codex-max" block');
  });

  it("rejects duplicate and self-referencing candidates with indexed field paths", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: { zcode: { candidates: ["codex", "codex", "zcode"] } },
      },
      resolver,
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "agents.zcode.candidates.1",
      "agents.zcode.candidates.2",
    ]);
  });

  it("detects cycles across the declared candidate graph", () => {
    const issues = collectConfigSemanticIssues(
      {
        version: 1,
        roles: {},
        agents: {
          a: { candidates: ["b"] },
          b: { candidates: ["a"] },
        },
      },
      resolver,
    );
    const cycleIssue = issues.find((issue) => issue.message.includes("cycle"));
    expect(cycleIssue?.severity).toBe("error");
    expect(cycleIssue?.message).toContain("a -> b -> a");
  });

  describe("validateConfigFile", () => {
    const createdDirectories: string[] = [];

    function createProject(config: unknown): { root: string; configPath: string } {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-validate-"));
      createdDirectories.push(root);
      fs.mkdirSync(path.join(root, ".git"));
      fs.mkdirSync(path.join(root, ".agentmesh"));
      const configPath = path.join(root, ".agentmesh", "config.json");
      fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
      return { root, configPath };
    }

    afterEach(() => {
      for (const directory of createdDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it("returns an actionable error when no project config exists", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-validate-empty-"));
      createdDirectories.push(empty);
      const report = validateConfigFile(empty, resolver);
      expect(report.summary.errors).toBe(1);
      expect(report.path).toBeUndefined();
      expect(report.issues[0]?.field).toBe("config");
      expect(report.issues[0]?.message).toContain("No .agentmesh/config.json");
      expect(report.issues[0]?.fix).toContain('"version"');
    });

    it("passes a fully valid routing configuration", () => {
      const { root, configPath } = createProject({
        version: 1,
        roles: { worker: "zcode", reviewer: { agent: "opencode" } },
        agents: {
          zcode: {
            tier: "weak",
            costLevel: 1,
            speed: "fast",
            strengths: ["quick summaries"],
            notGoodAt: ["deep refactors"],
            sandboxLevel: "prompt-only",
            notes: "cheap bulk work",
            candidates: ["codex"],
          },
          codex: { tier: "strong", costLevel: 5, sandboxLevel: "native-sandbox" },
        },
      });
      const report = validateConfigFile(root, resolver);
      expect(report.path).toBe(configPath);
      expect(report.summary).toEqual({ errors: 0, warnings: 0 });
    });

    it("maps schema violations to per-field errors with fix examples", () => {
      const { root } = createProject({
        version: 1,
        roles: { worker: "codex" },
        agents: { codex: { costLevel: 9, tier: "powerful" } },
      });
      const report = validateConfigFile(root, resolver);
      expect(report.summary.errors).toBeGreaterThanOrEqual(2);
      const fields = report.issues.map((issue) => issue.field);
      expect(fields).toContain("agents.codex.costLevel");
      expect(fields).toContain("agents.codex.tier");
      for (const issue of report.issues) {
        expect(issue.fix.length).toBeGreaterThan(0);
      }
    });

    it("renders errors, field paths, fixes, and summary in human-readable output", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({
          path: "C:\\proj\\.agentmesh\\config.json",
          issues: [
            {
              severity: "error",
              field: "roles.worker.agent",
              message: "Unknown agent name or alias 'codexx'.",
              fix: 'Set "roles.worker" to a known agent.',
            },
            {
              severity: "warning",
              field: "agents.codex.sandboxLevel",
              message: "tier strong with prompt-only protection.",
              fix: "Use a channel with real isolation.",
            },
          ],
          summary: { errors: 1, warnings: 1 },
        });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("[ERROR] roles.worker.agent");
        expect(output).toContain("[WARN]  agents.codex.sandboxLevel");
        expect(output).toContain("Fix:");
        expect(output).toContain("Summary: 1 error(s) / 1 warning(s)");
        expect(output).toContain("Result: invalid");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("renders a clean result when there are no issues", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({ issues: [], summary: { errors: 0, warnings: 0 } });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("No issues found.");
        expect(output).toContain("Result: valid.");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("keeps exit-worthy result positive when only warnings are present", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        renderConfigValidationReport({
          issues: [
            {
              severity: "warning",
              field: "agents.codex-strong",
              message: "'codex-strong' is not a registered agent name or alias.",
              fix: "Provision the matching profile file.",
            },
          ],
          summary: { errors: 0, warnings: 1 },
        });
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain("[WARN]  agents.codex-strong");
        expect(output).not.toContain("[ERROR]");
        expect(output).toContain("Result: valid, with warnings.");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("treats alias-resolving candidates as valid chain terminators", () => {
      const issues = collectConfigSemanticIssues(
        {
          version: 1,
          roles: {},
          agents: { zcode: { tier: "weak", candidates: ["codex"] } },
        },
        resolver,
      );
      expect(issues).toEqual([]);
    });
  });
});
