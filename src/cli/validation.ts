import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidArgumentError } from "commander";
import type { AgentRole, TransportMode } from "../agents/types.js";
import type { AgentMeshProjectConfig, ConfigParseIssue } from "../core/config.js";
import { findProjectConfigPath, parseProjectConfigText } from "../core/config.js";

export const MAX_TIMEOUT_MS = 3_600_000;

export function parseRole(value: string): AgentRole {
  if (value === "worker" || value === "reviewer" || value === "tester") return value;
  throw new InvalidArgumentError("Role must be worker, reviewer, or tester.");
}

export function parseMode(value: string): TransportMode {
  if (value === "auto" || value === "mcp" || value === "cli") return value;
  throw new InvalidArgumentError("Mode must be auto, mcp, or cli.");
}

export function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new InvalidArgumentError(
      `Timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}ms.`,
    );
  }
  return timeout;
}

export function resolveRunInput(
  agentOrTask: string,
  taskParts: string[],
  explicitAgent?: string,
): { agent?: string; task: string } {
  if (explicitAgent) {
    return {
      agent: explicitAgent,
      task: [agentOrTask, ...taskParts].join(" ").trim(),
    };
  }
  if (taskParts.length > 0) {
    return { agent: agentOrTask, task: taskParts.join(" ").trim() };
  }
  return { task: agentOrTask.trim() };
}

export function resolveReviewInput(
  agentOrTask: string | undefined,
  taskParts: string[],
  explicitAgent: string | undefined,
  isKnownAgent: (value: string) => boolean,
): { agent?: string; task?: string } {
  if (explicitAgent) {
    const task = [agentOrTask, ...taskParts].filter(Boolean).join(" ").trim();
    return { agent: explicitAgent, task: task || undefined };
  }
  if (agentOrTask && taskParts.length > 0) {
    return {
      agent: agentOrTask,
      task: taskParts.join(" ").trim() || undefined,
    };
  }
  if (agentOrTask && isKnownAgent(agentOrTask)) return { agent: agentOrTask };
  return { task: agentOrTask?.trim() || undefined };
}

export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  /** Exact config field path, e.g. `agents.codex.candidates.1`. */
  field: string;
  message: string;
  fix: string;
}

export interface ConfigValidationReport {
  path?: string;
  issues: ConfigIssue[];
  summary: { errors: number; warnings: number };
}

export type AgentNameResolver = (nameOrAlias: string) => string | undefined;

const CONFIG_GUIDE_REFERENCE =
  'see "强弱模型路由表配置指南" (MODEL_ROUTING_GUIDE.md) for field semantics';

const SCHEMA_FIX_EXAMPLES: Array<[RegExp, string]> = [
  [/^version$/, `"version": 1`],
  [/^roles(\.[^.]+)*\.agent$/, `"worker": { "agent": "codex" }`],
  [/\.mode$/, `"mode": "cli"   // auto | mcp | cli`],
  [/\.timeoutMs$/, `"timeoutMs": 600000`],
  [/\.model$/, `"model": "gpt-5-codex"`],
  [/\.reasoningEffort$/, `"reasoningEffort": "high"`],
  [/\.safety$/, `"safety": "enforced"`],
  [/\.tier$/, `"tier": "medium"   // strong | medium | weak`],
  [/\.costLevel$/, `"costLevel": 3   // integer 1-5`],
  [/\.speed$/, `"speed": "fast (~30s per task)"`],
  [/\.strengths$/, `"strengths": ["code-review", "refactoring"]`],
  [/\.notGoodAt$/, `"notGoodAt": ["long multi-file refactors"]`],
  [
    /\.sandboxLevel$/,
    `"sandboxLevel": "native-sandbox"   // native-sandbox | tool-filtering | prompt-only`,
  ],
  [/\.notes$/, `"notes": "When to prefer this agent"`],
  [/\.candidates$/, `"candidates": ["codex-medium", "codex-strong"]`],
];

function schemaIssueToConfigIssue(issue: ConfigParseIssue): ConfigIssue {
  const example = SCHEMA_FIX_EXAMPLES.find(([pattern]) => pattern.test(issue.field))?.[1];
  return {
    severity: "error",
    field: issue.field,
    message: issue.message,
    fix: example
      ? `Set a valid value, e.g. ${example}.`
      : `Correct the value at this path (${CONFIG_GUIDE_REFERENCE}).`,
  };
}

/**
 * Semantic checks on top of the zod schema:
 * - every configured role agent must resolve to a known adapter name/alias;
 * - an unresolvable agents key is treated as a profile-variant id (warned,
 *   e.g. codex profile "codex-strong"), not an error;
 * - every candidates entry must reference a known alias or a sibling key in
 *   the same agents map, without duplicates, self-references, or cycles;
 * - tier=strong combined with sandboxLevel=prompt-only draws a warning so the
 *   routing table never oversells prompt-level protection as a sandbox.
 */
export function collectConfigSemanticIssues(
  config: AgentMeshProjectConfig,
  resolveAgentName: AgentNameResolver,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const role of ["orchestrator", "worker", "reviewer", "tester"] as const) {
    const assignment = config.roles[role];
    if (!assignment) continue;
    if (!resolveAgentName(assignment.agent)) {
      issues.push({
        severity: "error",
        field: `roles.${role}.agent`,
        message: `Unknown agent name or alias '${assignment.agent}'; delegation would fail at runtime.`,
        fix: `Set "roles.${role}" to a known agent, e.g. "codex", "claude", or "opencode".`,
      });
    }
  }

  const agents = config.agents ?? {};
  const declaredKeys = new Set(Object.keys(agents));

  for (const key of Object.keys(agents)) {
    if (!resolveAgentName(key)) {
      issues.push({
        severity: "warning",
        field: `agents.${key}`,
        message: `'${key}' is not a registered agent name or alias; it is kept as a profile-variant id (e.g. backed by a codex profile file).`,
        fix: `Rename '${key}' to a known alias (e.g. "codex") or provision the matching role/profile file so downstream tools can resolve it.`,
      });
    }

    const metadata = agents[key];
    const seen = new Set<string>();
    (metadata?.candidates ?? []).forEach((candidate, index) => {
      const field = `agents.${key}.candidates.${index}`;
      if (seen.has(candidate)) {
        issues.push({
          severity: "error",
          field,
          message: `Duplicate candidate '${candidate}' in the upgrade chain.`,
          fix: `Remove the repeated entry: "candidates": [...new Set(candidates)]`,
        });
      }
      seen.add(candidate);

      if (candidate === key) {
        issues.push({
          severity: "error",
          field,
          message: `Upgrade chain for '${key}' references itself.`,
          fix: `Replace the self-reference with the next stronger candidate, e.g. "codex".`,
        });
        return;
      }

      if (!declaredKeys.has(candidate) && !resolveAgentName(candidate)) {
        issues.push({
          severity: "error",
          field,
          message: `Candidate '${candidate}' does not reference a known agent alias or a declared entry in "agents".`,
          fix: `Declare an "agents"."${candidate}" block, or replace it with a known alias such as "codex".`,
        });
      }
    });

    if (metadata?.tier === "strong" && metadata?.sandboxLevel === "prompt-only") {
      issues.push({
        severity: "warning",
        field: `agents.${key}.sandboxLevel`,
        message: `tier 'strong' is declared but sandboxLevel 'prompt-only' provides no runtime protection; do not present prompt-only channels as sandboxed.`,
        fix: `Use a channel with real isolation ("native-sandbox"/"tool-filtering") for strong-tier work, or downgrade the tier claim.`,
      });
    }
  }

  for (const cycle of detectCandidateCycles(agents, declaredKeys)) {
    issues.push({
      severity: "error",
      field: `agents.${cycle[0]}.candidates`,
      message: `Upgrade chain forms a cycle: ${cycle.join(" -> ")}.`,
      fix: `Break the loop so each chain ends at a strictly higher tier (weak -> medium -> strong).`,
    });
  }

  return issues;
}

function detectCandidateCycles(
  agents: Record<string, { candidates?: string[] }>,
  declaredKeys: Set<string>,
): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const key of Object.keys(agents)) color.set(key, WHITE);

  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const candidate of agents[node]?.candidates ?? []) {
      if (candidate === node || !declaredKeys.has(candidate)) continue;
      const state = color.get(candidate);
      if (state === GRAY) {
        const startIndex = stack.indexOf(candidate);
        if (startIndex >= 0) cycles.push([...stack.slice(startIndex), candidate]);
      } else if (state === WHITE) {
        visit(candidate);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const key of Object.keys(agents)) {
    if (color.get(key) === WHITE) visit(key);
  }
  return cycles;
}

export function validateConfigFile(
  startDirectory: string,
  resolveAgentName: AgentNameResolver,
): ConfigValidationReport {
  const finalize = (
    configPath: string | undefined,
    issues: ConfigIssue[],
  ): ConfigValidationReport => ({
    ...(configPath ? { path: configPath } : {}),
    issues,
    summary: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
  });

  const configPath = findProjectConfigPath(startDirectory);
  if (!configPath) {
    return finalize(undefined, [
      {
        severity: "error",
        field: "config",
        message: `No .agentmesh/config.json found for '${path.resolve(startDirectory)}'.`,
        fix: `Create one at the repository root, e.g. {"version":1,"roles":{"worker":"codex"}}.`,
      },
    ]);
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finalize(configPath, [
      {
        severity: "error",
        field: "config",
        message: `Failed to read '${configPath}': ${message}`,
        fix: "Check file permissions and encoding (UTF-8 expected).",
      },
    ]);
  }

  const parsed = parseProjectConfigText(text);
  if (!parsed.success) {
    return finalize(configPath, parsed.issues.map(schemaIssueToConfigIssue));
  }

  return finalize(configPath, collectConfigSemanticIssues(parsed.config, resolveAgentName));
}

export function renderConfigValidationReport(report: ConfigValidationReport): void {
  console.log("AgentMesh Config Validation");
  if (report.path) console.log(`Path: ${report.path}`);
  console.log("");
  if (report.issues.length === 0) console.log("No issues found.");
  for (const issue of report.issues) {
    const label = issue.severity === "error" ? "[ERROR]" : "[WARN] ";
    console.log(`${label} ${issue.field}`);
    console.log(`        ${issue.message}`);
    console.log(`        Fix: ${issue.fix}`);
    console.log("");
  }
  const { errors, warnings } = report.summary;
  console.log(`Summary: ${errors} error(s) / ${warnings} warning(s)`);
  if (errors > 0) {
    console.log("Result: invalid -- fix the errors above and re-run 'agentmesh config validate'.");
  } else if (warnings > 0) {
    console.log("Result: valid, with warnings.");
  } else {
    console.log("Result: valid.");
  }
}
