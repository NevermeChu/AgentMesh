import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectConfigPath,
  loadProjectConfig,
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

  it("parses the role-level context budget override", () => {
    const project = createProject({
      version: 1,
      roles: {
        worker: { agent: "codex", contextBudgetTokens: 2500 },
        tester: "codex",
      },
    });

    const loaded = loadProjectConfig(project.root)!;
    expect(loaded.config.roles.worker).toEqual({
      agent: "codex",
      contextBudgetTokens: 2500,
    });
    expect(loaded.config.roles.tester).toEqual({ agent: "codex" });
  });

  it("rejects non-positive or non-integer context budgets", () => {
    const project = createProject({
      version: 1,
      roles: { worker: { agent: "codex", contextBudgetTokens: 0 } },
    });

    expect(() => loadProjectConfig(project.root)).toThrowError(/contextBudgetTokens/);
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
