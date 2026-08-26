import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { AgentExecutableInfo, AgentName } from "../agents/types.js";
import {
  DEFAULT_MAX_HISTORY_TURNS_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  BridgeSessionSchema,
  resolveSessionStoragePath,
} from "./session.js";
import type { LoadedProjectConfig } from "./config.js";
import { loadProjectConfig } from "./config.js";
import { evaluateModelOptionSupport, readCapabilities } from "./capabilities.js";
import { captureRepositoryState } from "./repository.js";

/** Keep in sync with package.json "engines". */
const MINIMUM_NODE_VERSION = "22.13.0";

const STALE_LOCK_AGE_MS = 30_000;
const NEAR_CAPACITY_THRESHOLD = 0.8;

export type DoctorCheckStatus = "pass" | "warn" | "fail" | "info";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorReport {
  meta: {
    version: string;
    platform: string;
    cwd: string;
    timestamp: string;
  };
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
}

/** Structural subset of AgentRegistry.listAgentAvailability() results. */
export interface DoctorAvailabilityEntry {
  name: AgentName;
  displayName: string;
  available: boolean;
  info: AgentExecutableInfo;
}

export interface DoctorInput {
  cwd: string;
  availability: DoctorAvailabilityEntry[];
  /** Resolves a configured agent name or alias to its canonical name. */
  resolveAgentName: (nameOrAlias: string) => AgentName | undefined;
}

type ConfigLoadOutcome =
  | { kind: "loaded"; loaded: LoadedProjectConfig }
  | { kind: "invalid"; error: string }
  | { kind: "missing" };

function check(id: string, status: DoctorCheckStatus, detail: string): DoctorCheck {
  return { id, status, detail };
}

function compareNodeVersion(actual: string, minimum: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  for (let index = 0; index < minimumParts.length; index++) {
    const a = actualParts[index] ?? 0;
    const b = minimumParts[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function checkRuntime(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const satisfied = compareNodeVersion(process.version, MINIMUM_NODE_VERSION) >= 0;
  checks.push(
    check(
      "runtime.node",
      satisfied ? "pass" : "fail",
      `Node ${process.version} ${satisfied ? "satisfies" : "does not satisfy"} >=${MINIMUM_NODE_VERSION}`,
    ),
  );
  checks.push(check("runtime.package", "pass", `AgentMesh v${VERSION} on ${process.platform}`));
  if (process.env.AGENTMESH_SESSIONS_FILE) {
    checks.push(
      check(
        "runtime.sessions-override",
        "info",
        `AGENTMESH_SESSIONS_FILE overrides session storage: ${process.env.AGENTMESH_SESSIONS_FILE}`,
      ),
    );
  }
  return checks;
}

function loadConfigForDoctor(cwd: string): ConfigLoadOutcome {
  try {
    const loaded = loadProjectConfig(cwd);
    return loaded ? { kind: "loaded", loaded } : { kind: "missing" };
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function executableRoleAgents(
  outcome: ConfigLoadOutcome,
  resolveAgentName: DoctorInput["resolveAgentName"],
): Set<AgentName> {
  const required = new Set<AgentName>();
  if (outcome.kind !== "loaded") return required;
  for (const role of ["worker", "reviewer", "tester"] as const) {
    const assignment = outcome.loaded.config.roles[role];
    if (!assignment) continue;
    const canonical = resolveAgentName(assignment.agent);
    if (canonical) required.add(canonical);
  }
  // The orchestrator assignment is metadata only, never an executable role.
  return required;
}

function checkAdapters(
  availability: DoctorAvailabilityEntry[],
  requiredAgents: Set<AgentName>,
): DoctorCheck[] {
  return availability.map((entry) => {
    if (entry.available) {
      return check(
        `adapters.${entry.name}`,
        "pass",
        `${entry.displayName} available at '${entry.info.path}' (preferred: ${entry.info.preferredTransport})`,
      );
    }
    const required = requiredAgents.has(entry.name);
    return check(
      `adapters.${entry.name}`,
      required ? "fail" : "warn",
      entry.info.notes ||
        `${entry.displayName} binary was not found; ${required ? "a configured role references it and delegation will fail" : "not referenced by any configured role"}`,
    );
  });
}

function checkProjectConfig(cwd: string, outcome: ConfigLoadOutcome): DoctorCheck[] {
  if (outcome.kind === "missing") {
    return [
      check(
        "config.file",
        "info",
        `No .agentmesh/config.json found for '${cwd}'; built-in role defaults apply`,
      ),
    ];
  }
  if (outcome.kind === "invalid") {
    return [check("config.file", "fail", outcome.error)];
  }
  const roles = Object.entries(outcome.loaded.config.roles)
    .filter(([, assignment]) => assignment !== undefined)
    .map(([role]) => role);
  return [
    check(
      "config.file",
      "pass",
      `${outcome.loaded.path} valid (${roles.length > 0 ? roles.join(", ") : "no roles assigned"})`,
    ),
  ];
}

function reviewerSafetyChecks(
  outcome: ConfigLoadOutcome,
  availability: DoctorAvailabilityEntry[],
  resolveAgentName: DoctorInput["resolveAgentName"],
): DoctorCheck[] {
  if (outcome.kind !== "loaded") return [];
  const assignment = outcome.loaded.config.roles.reviewer;
  if (!assignment || typeof assignment === "string") return [];

  const canonical = resolveAgentName(assignment.agent);
  if (!canonical) {
    return [
      check(
        "config.reviewer-agent",
        "warn",
        `Reviewer references unknown agent or alias '${assignment.agent}'`,
      ),
    ];
  }
  const entry = availability.find((candidate) => candidate.name === canonical);
  const mechanism = entry?.info.sandboxMechanism;

  const checks: DoctorCheck[] = [];
  if (assignment.safety === "enforced" && mechanism === "prompt-only") {
    checks.push(
      check(
        "config.reviewer-safety",
        "fail",
        `Reviewer safety is 'enforced' but ${canonical} provides only prompt-level protection; delegation will be rejected at startup`,
      ),
    );
  } else if (mechanism === "prompt-only") {
    checks.push(
      check(
        "config.reviewer-safety",
        "warn",
        `Reviewer ${canonical} relies on prompt-level constraints (best-effort); this is not a runtime read-only sandbox`,
      ),
    );
  }
  return checks;
}

function capabilityOptionChecks(
  cwd: string,
  outcome: ConfigLoadOutcome,
  availability: DoctorAvailabilityEntry[],
  resolveAgentName: DoctorInput["resolveAgentName"],
): DoctorCheck[] {
  if (outcome.kind !== "loaded") return [];
  const checks: DoctorCheck[] = [];
  for (const role of ["worker", "reviewer", "tester"] as const) {
    const assignment = outcome.loaded.config.roles[role];
    if (!assignment || typeof assignment === "string") continue;
    if (!assignment.model && !assignment.reasoningEffort) continue;

    const canonical = resolveAgentName(assignment.agent);
    if (!canonical) continue;
    const entry = availability.find((candidate) => candidate.name === canonical);
    if (!entry) continue;

    const transportUsed =
      assignment.mode && assignment.mode !== "auto"
        ? assignment.mode
        : entry.info.preferredTransport === "auto"
          ? undefined
          : entry.info.preferredTransport;
    if (!transportUsed) continue;

    const diagnostics = evaluateModelOptionSupport({
      agent: canonical,
      transportUsed,
      model: assignment.model,
      reasoningEffort: assignment.reasoningEffort,
      startDirectory: cwd,
    });
    for (const diagnostic of diagnostics) {
      checks.push(check(`config.model-options.${role}`, "warn", diagnostic));
    }
  }
  return checks;
}

function capabilitiesDriftChecks(cwd: string): DoctorCheck[] {
  let capabilities: ReturnType<typeof readCapabilities>;
  try {
    capabilities = readCapabilities(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No .agentmesh/config.json found") || code === "ENOENT") {
      return [
        check(
          "capabilities.file",
          "info",
          "No capabilities.json; the built-in static matrix applies",
        ),
      ];
    }
    return [
      check(
        "capabilities.file",
        "warn",
        `capabilities.json is invalid and is being ignored (static matrix applies): ${message}`,
      ),
    ];
  }

  const generatedVersion = capabilities.generatedBy.packageVersion;
  if (generatedVersion !== VERSION) {
    return [
      check(
        "capabilities.version-drift",
        "warn",
        `capabilities.json was generated by v${generatedVersion}, running v${VERSION}; regenerate with 'agentmesh capabilities generate --force'`,
      ),
    ];
  }
  return [check("capabilities.version-drift", "pass", `generated by v${generatedVersion}`)];
}

interface SessionStoreInspection {
  checks: DoctorCheck[];
}

function inspectSessionStore(): SessionStoreInspection {
  const checks: DoctorCheck[] = [];
  const storagePath = resolveSessionStoragePath();
  const storageDir = path.dirname(storagePath);
  const storageName = path.basename(storagePath);

  if (!fs.existsSync(storagePath)) {
    checks.push(check("session-store.file", "pass", `No session storage yet at '${storagePath}'`));
    return { checks };
  }

  let sessions: Array<{ id: string; history: unknown[] }> | undefined;
  try {
    const parsed = z
      .array(BridgeSessionSchema)
      .safeParse(JSON.parse(fs.readFileSync(storagePath, "utf8")));
    if (parsed.success) sessions = parsed.data;
  } catch {
    // Fall through to the unreadable branch below.
  }

  if (!sessions) {
    checks.push(
      check(
        "session-store.file",
        "warn",
        `'${storagePath}' exists but cannot be parsed; it will be quarantined on next load. Inspect or remove it manually.`,
      ),
    );
  } else {
    const totalTurns = sessions.reduce((sum, session) => sum + session.history.length, 0);
    const busiestTurns = sessions.reduce(
      (max, session) => Math.max(max, session.history.length),
      0,
    );
    checks.push(
      check(
        "session-store.file",
        "pass",
        `${sessions.length} sessions, ${totalTurns} total turns ('${storagePath}')`,
      ),
    );
    if (
      sessions.length / DEFAULT_MAX_SESSIONS >= NEAR_CAPACITY_THRESHOLD &&
      DEFAULT_MAX_SESSIONS > 0
    ) {
      checks.push(
        check(
          "session-store.capacity",
          "info",
          `Session count ${sessions.length}/${DEFAULT_MAX_SESSIONS} is near the cap; oldest sessions will be evicted`,
        ),
      );
    }
    if (
      DEFAULT_MAX_HISTORY_TURNS_PER_SESSION > 0 &&
      busiestTurns / DEFAULT_MAX_HISTORY_TURNS_PER_SESSION >= NEAR_CAPACITY_THRESHOLD
    ) {
      checks.push(
        check(
          "session-store.capacity",
          "info",
          `One session holds ${busiestTurns}/${DEFAULT_MAX_HISTORY_TURNS_PER_SESSION} turns; oldest turns will be trimmed`,
        ),
      );
    }
  }

  const lockPath = `${storagePath}.lock`;
  if (fs.existsSync(lockPath)) {
    let stale: boolean;
    try {
      stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_AGE_MS;
    } catch {
      stale = false;
    }
    checks.push(
      check(
        "session-store.lock",
        stale ? "warn" : "info",
        stale
          ? `Stale session lock '${lockPath}' (older than ${STALE_LOCK_AGE_MS / 1000}s); it will be reclaimed automatically on the next mutation`
          : `A session lock exists ('${lockPath}'); another AgentMesh process may be active`,
      ),
    );
  }

  try {
    const quarantineFiles = fs
      .readdirSync(storageDir)
      .filter((name) => name.startsWith(`${storageName}.corrupt-`));
    if (quarantineFiles.length > 0) {
      checks.push(
        check(
          "session-store.quarantine",
          "warn",
          `${quarantineFiles.length} quarantined storage file(s) found in '${storageDir}' (${quarantineFiles.join(", ")}); session data was previously corrupt`,
        ),
      );
    }
  } catch {
    // Directory listing failures do not block other doctor checks.
  }

  return { checks };
}

async function repositoryChecks(cwd: string): Promise<DoctorCheck[]> {
  const state = await captureRepositoryState(cwd);
  if (!state) {
    return [
      check(
        "repository.state",
        "info",
        `'${cwd}' is not inside a Git repository (or git is unavailable); review fingerprint evidence will be unavailable`,
      ),
    ];
  }
  const shortHead = state.head ? state.head.slice(0, 12) : "unborn";
  return [
    check(
      "repository.state",
      "pass",
      `Git repository at '${state.repositoryRoot}', HEAD ${shortHead}, ${state.dirty ? `dirty (${state.changedPaths.length} changed paths)` : "clean"}${state.dirty ? "; review fingerprint baselines include these changes" : ""}`,
    ),
  ];
}

/**
 * Runs all read-only doctor checks. Never spawns vendor agents, never mutates
 * project files or session storage, and never throws for per-check findings:
 * individual check failures become report entries so one broken area cannot
 * hide the state of the others.
 */
export async function runDoctorChecks(input: DoctorInput): Promise<DoctorReport> {
  const { cwd, availability, resolveAgentName } = input;
  const configOutcome = loadConfigForDoctor(cwd);

  const checks: DoctorCheck[] = [
    ...checkRuntime(),
    ...checkProjectConfig(cwd, configOutcome),
    ...reviewerSafetyChecks(configOutcome, availability, resolveAgentName),
    ...capabilityOptionChecks(cwd, configOutcome, availability, resolveAgentName),
    ...checkAdapters(availability, executableRoleAgents(configOutcome, resolveAgentName)),
    ...capabilitiesDriftChecks(cwd),
    ...inspectSessionStore().checks,
    ...(await repositoryChecks(cwd)),
  ];

  const summary: Record<DoctorCheckStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    info: 0,
  };
  for (const result of checks) summary[result.status] += 1;

  return {
    meta: {
      version: VERSION,
      platform: process.platform,
      cwd,
      timestamp: new Date().toISOString(),
    },
    checks,
    summary,
  };
}
