import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectConfigPath,
  loadProjectConfig,
  parseProjectConfigText,
  resolveRoleAssignment,
} from "../../src/core/config.js";

const createdDirectories: string[] = [];

function createProject(config: unknown): { root: string; nested: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-config-"));
  createdDirectories.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const configDirectory = path.join(root, ".agentmesh");
  fs.mkdirSync(configDirectory);
  const configPath = path.join(configDirectory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
  const nested = path.join(root, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested, configPath };
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("core/project config", () => {
  it("loads shorthand and detailed role assignments from nested project paths", () => {
    const project = createProject({
      version: 1,
      roles: {
        orchestrator: "antigravity",
        worker: "antigravity",
        reviewer: {
          agent: "claude",
          mode: "cli",
          timeoutMs: 120000,
          safety: "enforced",
        },
        tester: "claude",
      },
    });

    expect(findProjectConfigPath(project.nested)).toBe(project.configPath);
    const loaded = loadProjectConfig(project.nested)!;
    expect(loaded.projectRoot).toBe(project.root);
    expect(loaded.config.roles.worker).toEqual({ agent: "antigravity" });
    expect(loaded.config.roles.reviewer).toEqual({
      agent: "claude",
      mode: "cli",
      timeoutMs: 120000,
      safety: "enforced",
    });
    expect(resolveRoleAssignment(project.nested, "tester").assignment?.agent).toBe("claude");
  });

  it("fails with a precise error for invalid project config", () => {
    const project = createProject({ version: 1, roles: { reviewer: { agent: "" } } });
    expect(() => loadProjectConfig(project.root)).toThrow("Invalid AgentMesh project config");
  });

  it("rejects reviewer-only safety settings on other roles", () => {
    const project = createProject({
      version: 1,
      roles: { worker: { agent: "codex", safety: "best-effort" } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow("Unrecognized key");
  });

  it("does not inherit configuration beyond the nearest repository boundary", () => {
    const parent = createProject({ version: 1, roles: { worker: "claude" } });
    const nestedRepository = path.join(parent.root, "nested-repo");
    fs.mkdirSync(path.join(nestedRepository, ".git"), { recursive: true });
    expect(findProjectConfigPath(nestedRepository)).toBeUndefined();
  });
});

describe("core/project config agents metadata", () => {
  it("parses a full valid agents metadata section with trimmed values", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: { worker: "codex" },
        agents: {
          codex: {
            tier: "strong",
            costLevel: 5,
            speed: "slow (~3min per task)",
            strengths: ["deep refactoring", "architecture review"],
            notGoodAt: ["quick one-liners"],
            sandboxLevel: "native-sandbox",
            notes: "Preferred for high-stakes changes",
            candidates: ["codex-medium", "zcode"],
          },
          zcode: { tier: "weak", costLevel: 1 },
        },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.agents).toEqual({
      codex: {
        tier: "strong",
        costLevel: 5,
        speed: "slow (~3min per task)",
        strengths: ["deep refactoring", "architecture review"],
        notGoodAt: ["quick one-liners"],
        sandboxLevel: "native-sandbox",
        notes: "Preferred for high-stakes changes",
        candidates: ["codex-medium", "zcode"],
      },
      zcode: { tier: "weak", costLevel: 1 },
    });
  });

  it("keeps configs without an agents section fully backward compatible", () => {
    const project = createProject({ version: 1, roles: { worker: "antigravity" } });
    const loaded = loadProjectConfig(project.nested)!;
    expect(loaded.config.agents).toBeUndefined();
    expect(loaded.config.roles.worker).toEqual({ agent: "antigravity" });
    expect(resolveRoleAssignment(project.root, "worker").assignment?.agent).toBe("antigravity");
  });

  it("rejects an invalid tier and reports the exact field path", () => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { tier: "powerful" } },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain("agents.codex.tier");
  });

  it.each([0, 6, 2.5, "3"])("rejects costLevel %p outside integer range 1-5", (costLevel) => {
    const result = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { costLevel } },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const target = result.issues.find((issue) => issue.field.startsWith("agents.codex.costLevel"));
    expect(target).toBeDefined();
  });

  it("rejects unknown metadata keys so typos fail fast", () => {
    const project = createProject({
      version: 1,
      roles: {},
      agents: { codex: { tuer: "typo of tier" } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow(/Unrecognized key/);
  });

  it("rejects blank agent keys in the agents map", () => {
    const result = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { "": { tier: "weak" } } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-array strengths and oversized candidate chains", () => {
    const badStrengths = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, agents: { codex: { strengths: "review" } } }),
    );
    expect(badStrengths.success).toBe(false);

    const tooManyCandidates = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        agents: { codex: { candidates: Array.from({ length: 17 }, (_, i) => `a${i}`) } },
      }),
    );
    expect(tooManyCandidates.success).toBe(false);
    if (tooManyCandidates.success) return;
    expect(tooManyCandidates.issues.map((issue) => issue.field)).toContain(
      "agents.codex.candidates",
    );
  });

  it("reports invalid JSON as a single config-level issue", () => {
    const result = parseProjectConfigText("{ not json");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toHaveLength(1);
    const [jsonIssue] = result.issues;
    expect(jsonIssue?.field).toBe("config");
    expect(jsonIssue?.message).toContain("Invalid JSON");
  });

  it("still fails loadProjectConfig with the aggregated legacy error format", () => {
    const project = createProject({
      version: 1,
      roles: {},
      agents: { codex: { costLevel: 9 } },
    });
    expect(() => loadProjectConfig(project.root)).toThrow(
      /Invalid AgentMesh project config .*agents\.codex\.costLevel/,
    );
  });
});
