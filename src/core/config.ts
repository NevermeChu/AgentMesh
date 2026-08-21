import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AgentRole, TransportMode } from "../agents/types.js";

export type ConfigurableRole = AgentRole | "orchestrator";

export interface RoleAssignment {
  agent: string;
  mode?: TransportMode;
  timeoutMs?: number;
}

export interface AgentMeshProjectConfig {
  version: 1;
  roles: Partial<Record<ConfigurableRole, RoleAssignment>>;
}

export interface LoadedProjectConfig {
  path: string;
  projectRoot: string;
  config: AgentMeshProjectConfig;
}

const NonBlankString = z.string().trim().min(1);
const RoleAssignmentSchema = z.union([
  NonBlankString,
  z.object({
    agent: NonBlankString,
    mode: z.enum(["auto", "mcp", "cli"]).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  }).strict(),
]);

const ProjectConfigSchema = z.object({
  version: z.literal(1),
  roles: z.object({
    orchestrator: RoleAssignmentSchema.optional(),
    worker: RoleAssignmentSchema.optional(),
    reviewer: RoleAssignmentSchema.optional(),
    tester: RoleAssignmentSchema.optional(),
  }).strict(),
}).strict();

function normalizeAssignment(
  value: z.infer<typeof RoleAssignmentSchema> | undefined
): RoleAssignment | undefined {
  return typeof value === "string" ? { agent: value } : value;
}

export function findProjectConfigPath(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, ".agentmesh", "config.json");
    if (fs.existsSync(candidate)) return candidate;

    // A repository boundary prevents an unrelated parent configuration from
    // silently changing this project's agent assignments.
    if (fs.existsSync(path.join(current, ".git"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function loadProjectConfig(startDirectory: string): LoadedProjectConfig | undefined {
  const configPath = findProjectConfigPath(startDirectory);
  if (!configPath) return undefined;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read AgentMesh project config '${configPath}': ${message}`);
  }

  const parsed = ProjectConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AgentMesh project config '${configPath}': ${details}`);
  }

  return {
    path: configPath,
    projectRoot: path.dirname(path.dirname(configPath)),
    config: {
      version: 1,
      roles: {
        orchestrator: normalizeAssignment(parsed.data.roles.orchestrator),
        worker: normalizeAssignment(parsed.data.roles.worker),
        reviewer: normalizeAssignment(parsed.data.roles.reviewer),
        tester: normalizeAssignment(parsed.data.roles.tester),
      },
    },
  };
}

export function resolveRoleAssignment(
  startDirectory: string,
  role: ConfigurableRole
): { assignment?: RoleAssignment; loaded?: LoadedProjectConfig } {
  const loaded = loadProjectConfig(startDirectory);
  return { assignment: loaded?.config.roles[role], loaded };
}
