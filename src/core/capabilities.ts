import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { AgentName, AgentRole, ReviewerSafetyPolicy, TransportMode } from "../agents/types.js";
import { findProjectConfigPath } from "./config.js";

const CapabilityValueSchema = z
  .object({
    supported: z.union([
      z.boolean(),
      z.literal("vendor-dependent"),
      z.literal("provider-dependent"),
    ]),
    flag: z.string().trim().min(1).optional(),
    kind: z.string().trim().min(1).optional(),
    key: z.string().trim().min(1).optional(),
    values: z.array(z.string().trim().min(1)).optional(),
    reason: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1).optional(),
  })
  .strict();

const TransportCapabilitySchema = z
  .object({
    model: CapabilityValueSchema.optional(),
    reasoningEffort: CapabilityValueSchema.optional(),
  })
  .strict();

const AgentCapabilitySchema = z
  .object({
    transports: z.record(z.enum(["auto", "mcp", "cli"]), TransportCapabilitySchema),
  })
  .strict();

const CapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedBy: z
      .object({ packageVersion: z.string().min(1), at: z.string().datetime() })
      .strict(),
    configVersion: z.literal(1),
    capabilities: z.record(AgentCapabilitySchema),
    provenance: z
      .object({
        source: z.enum(["adapter-static-plus-cli-help", "manual"]),
        commands: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type CapabilitiesFile = z.infer<typeof CapabilitiesSchema>;

const capabilityFileName = "capabilities.json";

export function findCapabilitiesPath(startDirectory: string): string | undefined {
  const configPath = findProjectConfigPath(startDirectory);
  if (!configPath) return undefined;
  return path.join(path.dirname(configPath), capabilityFileName);
}

function staticCapabilities(): CapabilitiesFile["capabilities"] {
  const cliModel = { supported: true as const, flag: "--model" };
  const unsupportedMcp = {
    supported: false as const,
    reason: "not supported by the strict vendor MCP tool schema",
  };
  const effort = {
    supported: "vendor-dependent" as const,
    notes: "Verify against the installed vendor CLI before configuring.",
  };
  return {
    codex: {
      transports: {
        mcp: { model: unsupportedMcp, reasoningEffort: unsupportedMcp },
        cli: {
          model: cliModel,
          reasoningEffort: {
            ...effort,
            kind: "config",
            key: "model_reasoning_effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        },
      },
    },
    antigravity: { transports: { cli: { model: cliModel, reasoningEffort: effort } } },
    opencode: {
      transports: {
        cli: {
          model: cliModel,
          reasoningEffort: {
            supported: "provider-dependent" as const,
            notes: "Depends on the configured OpenCode provider.",
          },
        },
      },
    },
    claude: { transports: { cli: { model: cliModel, reasoningEffort: effort } } },
    grok: { transports: { cli: { model: cliModel, reasoningEffort: effort } } },
    zcode: { transports: { cli: { model: cliModel, reasoningEffort: effort } } },
  };
}

export function generateCapabilities(
  startDirectory: string,
  force = false,
): { path: string; created: boolean; capabilities: CapabilitiesFile } {
  const capabilityPath = findCapabilitiesPath(startDirectory);
  if (!capabilityPath)
    throw new Error("No .agentmesh/config.json found within the current Git repository.");
  if (fs.existsSync(capabilityPath) && !force) {
    const existing = readCapabilities(startDirectory);
    return { path: capabilityPath, created: false, capabilities: existing };
  }
  const value: CapabilitiesFile = {
    schemaVersion: 1,
    generatedBy: { packageVersion: VERSION, at: new Date().toISOString() },
    configVersion: 1,
    capabilities: staticCapabilities(),
    provenance: {
      source: "adapter-static-plus-cli-help",
      commands: ["codex --help", "agy --help", "opencode --help", "claude --help"],
    },
  };
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
  const temporaryPath = `${capabilityPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, capabilityPath);
  return { path: capabilityPath, created: true, capabilities: value };
}

export function readCapabilities(startDirectory: string): CapabilitiesFile {
  const capabilityPath = findCapabilitiesPath(startDirectory);
  if (!capabilityPath)
    throw new Error("No .agentmesh/config.json found within the current Git repository.");
  const parsed = CapabilitiesSchema.safeParse(JSON.parse(fs.readFileSync(capabilityPath, "utf8")));
  if (!parsed.success)
    throw new Error(`Invalid AgentMesh capabilities '${capabilityPath}': ${parsed.error.message}`);
  return parsed.data;
}

export function getCapability(
  capabilities: CapabilitiesFile | undefined,
  agent: AgentName,
  mode: TransportMode,
  field: "model" | "reasoningEffort",
): z.infer<typeof CapabilityValueSchema> | undefined {
  return capabilities?.capabilities[agent]?.transports[mode]?.[field];
}

export function capabilityConfigSummary(
  role: AgentRole,
  agent: AgentName,
  mode: TransportMode,
  safety?: ReviewerSafetyPolicy,
) {
  return { role, agent, mode, safety };
}
