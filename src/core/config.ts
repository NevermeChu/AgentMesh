import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyPolicy,
  TransportMode,
} from "../agents/types.js";

export type ConfigurableRole = AgentRole | "orchestrator";

export type AgentTier = "strong" | "medium" | "weak";

/**
 * Self-declared protection level for an agent channel. Mirrors the runtime
 * SandboxMechanism vocabulary so metadata stays comparable with diagnostics.
 */
export type AgentSandboxLevel = "native-sandbox" | "tool-filtering" | "prompt-only";

export interface AgentMetadata {
  tier?: AgentTier;
  costLevel?: number;
  speed?: string;
  strengths?: string[];
  notGoodAt?: string[];
  sandboxLevel?: AgentSandboxLevel;
  notes?: string;
  /**
   * Declared upgrade chain. Entries must reference a known agent alias or a
   * sibling key declared in the same agents map (e.g. codex profile variants).
   */
  candidates?: string[];
}

export interface RoleAssignment {
  agent: string;
  mode?: TransportMode;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  safety?: ReviewerSafetyPolicy;
}

export interface AgentMeshProjectConfig {
  version: 1;
  roles: Partial<Record<ConfigurableRole, RoleAssignment>>;
  agents?: Record<string, AgentMetadata>;
}

export interface LoadedProjectConfig {
  path: string;
  projectRoot: string;
  config: AgentMeshProjectConfig;
}

export interface ConfigParseIssue {
  field: string;
  message: string;
}

export type ProjectConfigParseResult =
  | { success: true; config: AgentMeshProjectConfig }
  | { success: false; issues: ConfigParseIssue[] };

const NonBlankString = z.string().trim().min(1);
const AssignmentObjectSchema = z
  .object({
    agent: NonBlankString,
    mode: z.enum(["auto", "mcp", "cli"]).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    model: NonBlankString.max(200).optional(),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  })
  .strict();
const RoleAssignmentSchema = z.union([NonBlankString, AssignmentObjectSchema]);
const ReviewerRoleAssignmentSchema = z.union([
  NonBlankString,
  AssignmentObjectSchema.extend({
    safety: z.enum(["best-effort", "enforced"]).optional(),
  }).strict(),
]);

const MAX_AGENT_METADATA_ENTRIES = 32;
const MAX_LISTED_TRAITS = 32;
const MAX_CANDIDATES = 16;

export const AgentMetadataSchema = z
  .object({
    tier: z.enum(["strong", "medium", "weak"]).optional(),
    costLevel: z.number().int().min(1).max(5).optional(),
    speed: NonBlankString.max(100).optional(),
    strengths: z.array(NonBlankString.max(200)).max(MAX_LISTED_TRAITS).optional(),
    notGoodAt: z.array(NonBlankString.max(200)).max(MAX_LISTED_TRAITS).optional(),
    sandboxLevel: z.enum(["native-sandbox", "tool-filtering", "prompt-only"]).optional(),
    notes: NonBlankString.max(2000).optional(),
    candidates: z.array(NonBlankString.max(200)).max(MAX_CANDIDATES).optional(),
  })
  .strict();

const AgentsMetadataSchema = z
  .record(z.string().trim().min(1), AgentMetadataSchema)
  .refine(
    (entries) => Object.keys(entries).length <= MAX_AGENT_METADATA_ENTRIES,
    `agents section must declare at most ${MAX_AGENT_METADATA_ENTRIES} entries`,
  );

const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    roles: z
      .object({
        orchestrator: RoleAssignmentSchema.optional(),
        worker: RoleAssignmentSchema.optional(),
        reviewer: ReviewerRoleAssignmentSchema.optional(),
        tester: RoleAssignmentSchema.optional(),
      })
      .strict(),
    agents: AgentsMetadataSchema.optional(),
  })
  .strict();

function normalizeAssignment(
  value:
    | z.infer<typeof RoleAssignmentSchema>
    | z.infer<typeof ReviewerRoleAssignmentSchema>
    | undefined,
): RoleAssignment | undefined {
  return typeof value === "string" ? { agent: value } : value;
}

/**
 * Parses raw config text into a validated project config. Field-level issues
 * are returned individually so callers (e.g. `agentmesh config validate`) can
 * point at the exact offending path instead of a joined blob.
 */
export function parseProjectConfigText(text: string): ProjectConfigParseResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, issues: [{ field: "config", message: `Invalid JSON: ${message}` }] };
  }

  const parsed = ProjectConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "config",
        message: issue.message,
      })),
    };
  }

  const config: AgentMeshProjectConfig = {
    version: 1,
    roles: {
      orchestrator: normalizeAssignment(parsed.data.roles.orchestrator),
      worker: normalizeAssignment(parsed.data.roles.worker),
      reviewer: normalizeAssignment(parsed.data.roles.reviewer),
      tester: normalizeAssignment(parsed.data.roles.tester),
    },
  };
  if (parsed.data.agents) config.agents = parsed.data.agents;
  return { success: true, config };
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

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read AgentMesh project config '${configPath}': ${message}`, {
      cause: error,
    });
  }

  const parsed = parseProjectConfigText(text);
  if (!parsed.success) {
    const details = parsed.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    throw new Error(`Invalid AgentMesh project config '${configPath}': ${details}`);
  }

  return {
    path: configPath,
    projectRoot: path.dirname(path.dirname(configPath)),
    config: parsed.config,
  };
}

export function resolveRoleAssignment(
  startDirectory: string,
  role: ConfigurableRole,
): { assignment?: RoleAssignment; loaded?: LoadedProjectConfig } {
  const loaded = loadProjectConfig(startDirectory);
  return { assignment: loaded?.config.roles[role], loaded };
}
