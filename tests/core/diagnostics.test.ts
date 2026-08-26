import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctorChecks } from "../../src/core/diagnostics.js";
import type {
  DoctorAvailabilityEntry,
  DoctorCheck,
  DoctorInput,
} from "../../src/core/diagnostics.js";
import type { AgentExecutableInfo, AgentName, SandboxMechanism } from "../../src/agents/types.js";

const KNOWN_AGENTS: AgentName[] = ["codex", "claude", "antigravity", "grok", "opencode", "zcode"];

function makeAvailability(
  name: AgentName,
  overrides: Partial<{
    available: boolean;
    mechanism: SandboxMechanism;
    preferred: "mcp" | "cli";
  }> = {},
): DoctorAvailabilityEntry {
  const available = overrides.available ?? true;
  const preferred = overrides.preferred ?? "cli";
  const info: AgentExecutableInfo = {
    available,
    path: available ? `/fake/path/${name}` : undefined,
    preferredTransport: preferred,
    supportedTransports: [preferred],
    sandboxMechanism: overrides.mechanism ?? "native-sandbox",
    notes: available ? undefined : `Binary '${name}' was not found in system PATH.`,
  };
  return { name, displayName: name, available, info };
}

function makeInput(cwd: string, availability: DoctorAvailabilityEntry[]): DoctorInput {
  return {
    cwd,
    availability,
    resolveAgentName: (nameOrAlias) =>
      KNOWN_AGENTS.includes(nameOrAlias as AgentName) ? (nameOrAlias as AgentName) : undefined,
  };
}

function writeProjectConfig(root: string, content: unknown): void {
  fs.mkdirSync(path.join(root, ".agentmesh"), { recursive: true });
  const serialized = typeof content === "string" ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(root, ".agentmesh", "config.json"), serialized);
}

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((entry) => entry.id === id);
}

describe("core/diagnostics", () => {
  let root: string;
  let previousSessionsFile: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-doctor-"));
    previousSessionsFile = process.env.AGENTMESH_SESSIONS_FILE;
    process.env.AGENTMESH_SESSIONS_FILE = path.join(root, "sessions.json");
  });

  afterEach(() => {
    if (previousSessionsFile === undefined) {
      delete process.env.AGENTMESH_SESSIONS_FILE;
    } else {
      process.env.AGENTMESH_SESSIONS_FILE = previousSessionsFile;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports runtime and adapter health for a bare directory", async () => {
    const report = await runDoctorChecks(makeInput(root, [makeAvailability("codex")]));

    expect(report.meta.cwd).toBe(root);
    expect(findCheck(report.checks, "runtime.node")?.status).toBe("pass");
    expect(findCheck(report.checks, "adapters.codex")?.status).toBe("pass");
    expect(findCheck(report.checks, "config.file")?.status).toBe("info");
    // A tmp directory outside any git repository degrades to an info check.
    expect(findCheck(report.checks, "repository.state")?.status).toBe("info");
    expect(report.summary.fail).toBe(0);
  });

  it("escalates missing binaries referenced by executable roles and warns otherwise", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: { worker: "codex", tester: "grok" },
    });
    const report = await runDoctorChecks(
      makeInput(root, [
        makeAvailability("codex", { available: false }),
        makeAvailability("claude", { available: false }),
        makeAvailability("grok"),
      ]),
    );

    expect(findCheck(report.checks, "adapters.codex")?.status).toBe("fail");
    expect(findCheck(report.checks, "adapters.claude")?.status).toBe("warn");
    expect(findCheck(report.checks, "adapters.grok")?.status).toBe("pass");
  });

  it("never treats the orchestrator assignment as an executable role", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: { orchestrator: "gemini", worker: "codex" },
    });
    const report = await runDoctorChecks(
      makeInput(root, [
        makeAvailability("codex"),
        makeAvailability("antigravity", { available: false }),
      ]),
    );

    expect(findCheck(report.checks, "adapters.antigravity")?.status).toBe("warn");
  });

  it("fails on an unparseable project config", async () => {
    writeProjectConfig(root, "{not json");
    const report = await runDoctorChecks(makeInput(root, [makeAvailability("codex")]));

    const configCheck = findCheck(report.checks, "config.file");
    expect(configCheck?.status).toBe("fail");
    expect(configCheck?.detail).toContain("Failed to read AgentMesh project config");
  });

  it("fails on a schema-violating project config", async () => {
    writeProjectConfig(root, { version: 99, roles: {} });
    const report = await runDoctorChecks(makeInput(root, [makeAvailability("codex")]));

    const configCheck = findCheck(report.checks, "config.file");
    expect(configCheck?.status).toBe("fail");
    expect(configCheck?.detail).toContain("Invalid AgentMesh project config");
  });

  it("fails closed when enforced reviewer safety meets a prompt-only agent", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: {
        reviewer: { agent: "antigravity", safety: "enforced" },
      },
    });
    const report = await runDoctorChecks(
      makeInput(root, [makeAvailability("antigravity", { mechanism: "prompt-only" })]),
    );
    expect(findCheck(report.checks, "config.reviewer-safety")?.status).toBe("fail");
  });

  it("warns without failing when best-effort reviewer safety meets a prompt-only agent", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: {
        reviewer: { agent: "antigravity", safety: "best-effort" },
      },
    });
    const report = await runDoctorChecks(
      makeInput(root, [makeAvailability("antigravity", { mechanism: "prompt-only" })]),
    );
    expect(findCheck(report.checks, "config.reviewer-safety")?.status).toBe("warn");
    expect(report.summary.fail).toBe(0);
  });

  it("warns when an unknown reviewer agent name is configured", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: { reviewer: { agent: "not-an-agent" } },
    });
    const report = await runDoctorChecks(makeInput(root, []));
    expect(findCheck(report.checks, "config.reviewer-agent")?.status).toBe("warn");
  });

  it("pre-flags model requests that the effective transport cannot honor", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: {
        worker: { agent: "codex", mode: "mcp", model: "gpt-5-codex" },
      },
    });
    const report = await runDoctorChecks(
      makeInput(root, [makeAvailability("codex", { preferred: "mcp" })]),
    );

    const optionCheck = report.checks.find((entry) =>
      entry.id.startsWith("config.model-options.worker"),
    );
    expect(optionCheck?.status).toBe("warn");
    expect(optionCheck?.detail).toContain("gpt-5-codex");
  });

  it("stays silent for model requests the configured transport supports", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: {
        worker: { agent: "codex", mode: "cli", model: "o3" },
      },
    });
    const report = await runDoctorChecks(makeInput(root, [makeAvailability("codex")]));

    expect(report.checks.some((entry) => entry.id.startsWith("config.model-options"))).toBe(false);
  });

  it("warns on capabilities drift and invalid capability files", async () => {
    writeProjectConfig(root, { version: 1, roles: {} });
    const capabilitiesPath = path.join(root, ".agentmesh", "capabilities.json");
    fs.writeFileSync(
      capabilitiesPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedBy: { packageVersion: "0.0.1-old", at: "2026-01-01T00:00:00.000Z" },
        configVersion: 1,
        capabilities: {},
        provenance: { source: "manual", commands: [] },
      }),
    );
    const drifted = await runDoctorChecks(makeInput(root, []));
    expect(findCheck(drifted.checks, "capabilities.version-drift")?.status).toBe("warn");

    fs.writeFileSync(capabilitiesPath, "{broken");
    const broken = await runDoctorChecks(makeInput(root, []));
    expect(findCheck(broken.checks, "capabilities.file")?.status).toBe("warn");
    expect(broken.summary.fail).toBe(0);
  });

  it("summarizes a healthy session store without mutating it", async () => {
    const storagePath = path.join(root, "sessions.json");
    fs.writeFileSync(
      storagePath,
      JSON.stringify([
        {
          id: "bridge-sess_aaaa",
          agent: "codex",
          cwd: root,
          role: "worker",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          history: [],
        },
        {
          id: "bridge-sess_bbbb",
          agent: "claude",
          cwd: root,
          role: "reviewer",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          history: [],
        },
      ]),
    );
    const before = fs.readFileSync(storagePath, "utf8");

    const report = await runDoctorChecks(makeInput(root, [makeAvailability("codex")]));

    const storeCheck = findCheck(report.checks, "session-store.file");
    expect(storeCheck?.status).toBe("pass");
    expect(storeCheck?.detail).toContain("2 sessions");
    expect(fs.readFileSync(storagePath, "utf8")).toBe(before);
    expect(fs.existsSync(`${storagePath}.lock`)).toBe(false);
  });

  it("warns on corrupt session storage without quarantining it", async () => {
    const storagePath = path.join(root, "sessions.json");
    fs.writeFileSync(storagePath, "{corrupt");

    const report = await runDoctorChecks(makeInput(root, []));

    const storeCheck = findCheck(report.checks, "session-store.file");
    expect(storeCheck?.status).toBe("warn");
    expect(fs.readFileSync(storagePath, "utf8")).toBe("{corrupt");
    expect(fs.readdirSync(root).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("detects stale locks and leftover quarantine files", async () => {
    const storagePath = path.join(root, "sessions.json");
    fs.writeFileSync(storagePath, "[]");
    const lockPath = `${storagePath}.lock`;
    fs.writeFileSync(lockPath, "");
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, oneMinuteAgo, oneMinuteAgo);
    fs.writeFileSync(`${storagePath}.corrupt-123`, "{}");

    const report = await runDoctorChecks(makeInput(root, []));

    expect(findCheck(report.checks, "session-store.lock")?.status).toBe("warn");
    expect(findCheck(report.checks, "session-store.quarantine")?.status).toBe("warn");
  });

  it("treats a fresh lock as informational, not stale", async () => {
    const storagePath = path.join(root, "sessions.json");
    fs.writeFileSync(storagePath, "[]");
    fs.writeFileSync(`${storagePath}.lock`, "");

    const report = await runDoctorChecks(makeInput(root, []));

    expect(findCheck(report.checks, "session-store.lock")?.status).toBe("info");
  });

  it("counts summary buckets consistently across all checks", async () => {
    writeProjectConfig(root, {
      version: 1,
      roles: { reviewer: { agent: "antigravity", safety: "enforced" } },
    });
    const report = await runDoctorChecks(
      makeInput(root, [makeAvailability("antigravity", { mechanism: "prompt-only" })]),
    );

    const counted = report.checks.reduce<Record<string, number>>((buckets, entry) => {
      buckets[entry.status] = (buckets[entry.status] ?? 0) + 1;
      return buckets;
    }, {});
    expect(report.summary.pass).toBe(counted.pass ?? 0);
    expect(report.summary.warn).toBe(counted.warn ?? 0);
    expect(report.summary.fail).toBe(counted.fail ?? 0);
    expect(report.summary.info).toBe(counted.info ?? 0);
    expect(report.summary.fail).toBeGreaterThan(0);
  });
});
