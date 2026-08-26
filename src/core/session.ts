import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ZodError, z } from "zod";
import type { AgentName, AgentRole } from "../agents/types.js";
import type { BridgeSession, SessionHistoryEntry, SessionManagerOptions } from "./types.js";

const AgentNameSchema = z.enum([
  "codex",
  "gemini",
  "antigravity",
  "grok",
  "claude",
  "opencode",
  "zcode",
]);
const AgentRoleSchema = z.enum(["worker", "reviewer", "tester"]);
const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string(),
  line: z.union([z.number(), z.string()]).optional(),
  issue: z.string(),
  suggestion: z.string().optional(),
});
const RepositoryStateEvidenceSchema = z.object({
  capturedAt: z.string().datetime(),
  repositoryRoot: z.string().min(1),
  head: z.string().min(1).optional(),
  dirty: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  changedPaths: z.array(z.string()),
  pathFingerprints: z.record(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
const ResourceEvidenceSchema = z.object({
  collection: z.enum(["none", "process", "process-tree", "external"]),
  cpuUserMs: z.number().nonnegative().optional(),
  cpuSystemMs: z.number().nonnegative().optional(),
  peakRssBytes: z.number().nonnegative().optional(),
  processTreePeakRssBytes: z.number().nonnegative().optional(),
  orphanProcessesDetected: z.boolean().optional(),
  note: z.string().optional(),
  limitations: z.string().optional(),
});
const TransportFallbackEvidenceSchema = z.object({
  from: z.enum(["mcp", "cli"]),
  to: z.enum(["mcp", "cli"]),
  reason: z.string(),
});
const ErrorCodeSchema = z.enum([
  "TRANSIENT_5XX",
  "SPAWN_FAILED",
  "TIMEOUT",
  "MODEL_REJECTED",
  "SANDBOX_UNAVAILABLE",
  "PARSE_FAILURE",
  "ARG_REJECTED",
  "CANCELLED",
  "CIRCUIT_OPEN",
  "BUDGET_EXHAUSTED",
]);
const SessionExecutionEvidenceSchema = z.object({
  repositoryBefore: RepositoryStateEvidenceSchema.optional(),
  repositoryAfter: RepositoryStateEvidenceSchema.optional(),
  transportUsed: z.enum(["mcp", "cli"]).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  timedOut: z.boolean().optional(),
  aborted: z.boolean().optional(),
  cancelReason: z.enum(["timeout", "client_cancel", "client_disconnect", "unknown"]).optional(),
  errorCode: ErrorCodeSchema.optional(),
  cleanupMethod: z.enum(["taskkill-tree", "signal", "unknown"]).optional(),
  cleanupSucceeded: z.boolean().optional(),
  resourceEvidence: ResourceEvidenceSchema.optional(),
  transportFallback: TransportFallbackEvidenceSchema.optional(),
});
const ReviewerSafetyReportSchema = z.object({
  requested: z.enum(["best-effort", "enforced"]),
  mechanism: z.enum(["native-sandbox", "tool-filtering", "prompt-only"]),
  enforced: z.boolean(),
  workspaceChanged: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
  warning: z.string().optional(),
});
const SharedContextAuditSchema = z.object({
  file: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  totalChars: z.number().int().nonnegative(),
  sources: z.array(
    z.object({
      sessionId: z.string(),
      chars: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  ),
});
const SessionHistoryEntrySchema = z.object({
  role: AgentRoleSchema,
  task: z.string(),
  timestamp: z.string().datetime(),
  status: z.enum(["success", "failed"]),
  summary: z.string().optional(),
  finalAnswer: z.string().optional(),
  findings: z.array(ReviewFindingSchema).optional(),
  nativeSessionId: z.string().min(1).optional(),
  evidence: SessionExecutionEvidenceSchema.optional(),
  reviewerSafety: ReviewerSafetyReportSchema.optional(),
  contextSources: z.array(z.string()).optional(),
  requestedModel: z.string().optional(),
  requestedReasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  capabilityDiagnostics: z.array(z.string()).optional(),
  sharedContextAudit: SharedContextAuditSchema.optional(),
});
/** Exported for read-only inspection (doctor); mutation stays inside SessionManager. */
export const BridgeSessionSchema: z.ZodType<BridgeSession> = z.object({
  id: z.string().min(1),
  agent: AgentNameSchema,
  nativeSessionId: z.string().min(1).optional(),
  cwd: z.string().min(1),
  role: AgentRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  history: z.array(SessionHistoryEntrySchema),
  metadata: z.record(z.unknown()).optional(),
});

export const DEFAULT_MAX_HISTORY_TURNS_PER_SESSION = 50;
export const DEFAULT_MAX_SESSIONS = 200;

/**
 * Resolves the effective sessions storage path exactly like the SessionManager
 * constructor, without constructing one. Read-only diagnostics (doctor) use
 * this to inspect storage without triggering load-time quarantine side effects.
 */
export function resolveSessionStoragePath(): string {
  return (
    process.env.AGENTMESH_SESSIONS_FILE || path.join(os.homedir(), ".agentmesh", "sessions.json")
  );
}

function snapshotSession(session: BridgeSession): BridgeSession {
  return structuredClone(session);
}

export class SessionManager {
  private sessions = new Map<string, BridgeSession>();
  private readonly storagePath: string;
  private readonly persist: boolean;
  private readonly lockPath: string;
  private readonly maxHistoryTurnsPerSession: number;
  private readonly maxSessions: number;
  /**
   * Sessions created in this process whose first turn has not been flushed to
   * storage yet. Deferring the first write means a client disconnect that kills
   * the server mid-execution can no longer leave a permanent zero-turn session
   * husk behind: a session becomes durable together with its first turn.
   */
  private unsavedSessions = new Set<string>();

  constructor(options: SessionManagerOptions = {}) {
    this.persist = options.persist ?? true;
    // Storage stays bounded: every mutation rewrites the whole JSON file, so
    // unbounded history would turn each append into an O(N) rewrite that grows
    // without limit. Caps are configurable and `0` disables them.
    this.maxHistoryTurnsPerSession =
      options.maxHistoryTurnsPerSession ?? DEFAULT_MAX_HISTORY_TURNS_PER_SESSION;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.storagePath = options.storagePath || resolveSessionStoragePath();
    this.lockPath = `${this.storagePath}.lock`;

    if (this.persist) {
      this.loadFromFile();
    }
  }

  /**
   * Refreshes from disk while keeping sessions created in this process whose
   * first turn has not been flushed yet, so a deferred-create session stays
   * visible and is not clobbered by the storage reload.
   */
  private reloadFromDiskPreservingUnsaved(): void {
    const preserved = new Map<string, BridgeSession>();
    for (const id of this.unsavedSessions) {
      const session = this.sessions.get(id);
      if (session) preserved.set(id, session);
    }
    this.loadFromFile();
    for (const [id, session] of preserved) {
      const persisted = this.sessions.get(id);
      if (
        !persisted ||
        new Date(persisted.updatedAt).getTime() <= new Date(session.updatedAt).getTime()
      ) {
        this.sessions.set(id, session);
      } else {
        // Another process already flushed a newer state for this id.
        this.unsavedSessions.delete(id);
      }
    }
  }

  /** Marks a session as durably stored after a successful flush. */
  private markFlushed(...ids: string[]): void {
    for (const id of ids) this.unsavedSessions.delete(id);
  }

  /**
   * Loads sessions from the persisted JSON storage file with retry resilience for concurrent writes.
   *
   * A file that is definitively corrupt (invalid JSON or failed schema validation)
   * is quarantined next to the storage file and replaced with an empty state so a
   * single damaged write cannot brick every AgentMesh command.
   */
  private loadFromFile(): void {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (!fs.existsSync(this.storagePath)) {
          return;
        }
        const raw = fs.readFileSync(this.storagePath, "utf-8");
        if (!raw.trim()) {
          return;
        }
        const parsed = z.array(BridgeSessionSchema).parse(JSON.parse(raw));
        this.sessions.clear();
        for (const session of parsed) {
          this.sessions.set(session.id, session);
        }
        return;
      } catch (err) {
        lastErr = err;
        if (err instanceof SyntaxError || err instanceof ZodError) {
          this.quarantineCorruptStorage(err);
          return;
        }
        // Brief pause to yield if another process is in the middle of atomic rename
        if (attempt < 4) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        }
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Failed to load AgentMesh sessions from '${this.storagePath}': ${message}`);
  }

  private quarantineCorruptStorage(error: Error): void {
    const quarantinePath = `${this.storagePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.storagePath, quarantinePath);
    } catch {
      // Even without quarantine rights we still start empty rather than fail to load.
    }
    this.sessions.clear();
    process.stderr.write(
      `AgentMesh session storage '${this.storagePath}' is corrupt (${error.message}). ` +
        `It was quarantined as '${quarantinePath}' and an empty session list was loaded.\n`,
    );
  }

  /**
   * Saves current sessions to the persisted storage file atomically.
   */
  private saveToFile(): void {
    if (!this.persist) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      const tempFile = `${this.storagePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
      try {
        fs.renameSync(tempFile, this.storagePath);
      } catch {
        // Fallback for Windows file locks
        fs.copyFileSync(tempFile, this.storagePath);
        fs.unlinkSync(tempFile);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to save AgentMesh sessions to '${this.storagePath}': ${message}`, {
        cause: err,
      });
    }
  }

  /** Serializes read-modify-write mutations across cooperating CLI/MCP processes. */
  private withFileLock<T>(operation: () => T): T {
    if (!this.persist) return operation();

    const dir = path.dirname(this.storagePath);
    fs.mkdirSync(dir, { recursive: true });

    let lockFd: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lockFd = fs.openSync(this.lockPath, "wx");
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;

        try {
          const ageMs = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (ageMs > 30_000) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
          continue;
        }

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }

    if (lockFd === undefined) {
      throw new Error(`Timed out acquiring AgentMesh session lock '${this.lockPath}'.`);
    }

    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      this.reloadFromDiskPreservingUnsaved();
      outcome = { ok: true, value: operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let cleanupError: unknown;
    try {
      fs.closeSync(lockFd);
    } catch (error) {
      cleanupError = error;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && cleanupError === undefined) {
        cleanupError = error;
      }
    }

    if (!outcome.ok) {
      if (outcome.error instanceof Error) throw outcome.error;
      throw new Error("AgentMesh session operation failed with a non-Error value.", {
        cause: outcome.error,
      });
    }
    if (cleanupError !== undefined) {
      if (cleanupError instanceof Error) throw cleanupError;
      throw new Error("AgentMesh session lock cleanup failed with a non-Error value.", {
        cause: cleanupError,
      });
    }
    return outcome.value;
  }

  /**
   * Generates a unique bridge session ID.
   */
  public generateId(): string {
    const randomHex = crypto.randomBytes(6).toString("hex");
    return `bridge-sess_${randomHex}`;
  }

  /** Evicts least-recently-updated sessions when the storage cap is exceeded. */
  private enforceSessionCap(): void {
    while (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) {
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, session] of this.sessions) {
        const updated = new Date(session.updatedAt).getTime();
        if (updated < oldestTime) {
          oldestTime = updated;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.sessions.delete(oldestId);
      this.unsavedSessions.delete(oldestId);
    }
  }

  /**
   * Creates and stores a new BridgeSession.
   */
  public createSession(params: {
    agent: AgentName;
    cwd: string;
    role?: AgentRole;
    nativeSessionId?: string;
    metadata?: Record<string, unknown>;
  }): BridgeSession {
    return this.withFileLock(() => {
      this.enforceSessionCap();
      const id = this.generateId();
      const now = new Date().toISOString();
      const session: BridgeSession = {
        id,
        agent: params.agent,
        nativeSessionId: params.nativeSessionId,
        cwd: params.cwd,
        role: params.role ?? "worker",
        createdAt: now,
        updatedAt: now,
        history: [],
        metadata: params.metadata,
      };

      this.sessions.set(id, session);
      // Deferred first flush: the session becomes durable together with its
      // first turn (see unsavedSessions). A hard death before that point must
      // not leave a zero-turn husk in shared storage.
      this.unsavedSessions.add(id);
      return snapshotSession(session);
    });
  }

  /**
   * Retrieves an active session by its ID.
   */
  public getSession(id: string): BridgeSession | undefined {
    if (this.persist) {
      this.reloadFromDiskPreservingUnsaved();
    }
    const session = this.sessions.get(id);
    return session ? snapshotSession(session) : undefined;
  }

  /**
   * Updates an existing session.
   */
  public updateSession(
    id: string,
    updates: Partial<Omit<BridgeSession, "id" | "createdAt">>,
  ): BridgeSession | undefined {
    return this.withFileLock(() => {
      const existing = this.sessions.get(id);
      if (!existing) return undefined;

      const updated: BridgeSession = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(id, updated);
      this.saveToFile();
      this.markFlushed(id);
      return snapshotSession(updated);
    });
  }

  /**
   * Records a task execution entry in the session's history.
   */
  public addHistory(id: string, entry: SessionHistoryEntry): void {
    this.withFileLock(() => {
      const session = this.sessions.get(id);
      if (session) {
        session.history.push(entry);
        if (this.maxHistoryTurnsPerSession > 0) {
          const excess = session.history.length - this.maxHistoryTurnsPerSession;
          if (excess > 0) session.history.splice(0, excess);
        }
        session.updatedAt = new Date().toISOString();
        this.saveToFile();
        this.markFlushed(id);
      }
    });
  }

  /**
   * Lists all tracked sessions.
   */
  public listSessions(): BridgeSession[] {
    if (this.persist) {
      this.reloadFromDiskPreservingUnsaved();
    }

    return Array.from(this.sessions.values(), snapshotSession).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * Persists the exact shared-context block injected into one turn's prompt as
   * a sidecar artifact next to the sessions storage file. This enables verbatim
   * handoff audits (what did the downstream agent actually see, including
   * truncation) without inflating the main JSON store.
   *
   * Returns the storage-relative artifact path plus byte/char sizes and digest,
   * or undefined when persistence is disabled or content is empty.
   */
  public persistContextArtifact(
    sessionId: string,
    turnNumber: number,
    content: string,
  ): { file: string; bytes: number; sha256: string } | undefined {
    if (!this.persist || !content) return undefined;
    try {
      const storageDir = path.dirname(this.storagePath);
      const dir = path.join(storageDir, "contexts", sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${String(turnNumber).padStart(3, "0")}.txt`;
      fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
      return {
        file: path.join("contexts", sessionId, fileName),
        bytes: Buffer.byteLength(content, "utf-8"),
        sha256: crypto.createHash("sha256").update(content, "utf-8").digest("hex"),
      };
    } catch {
      // Audit artifacts are best-effort: losing one must not fail the turn.
      return undefined;
    }
  }

  /**
   * Deletes a session.
   */
  public deleteSession(id: string): boolean {
    return this.withFileLock(() => {
      const deleted = this.sessions.delete(id);
      if (deleted) {
        this.saveToFile();
        this.markFlushed(id);
      }
      return deleted;
    });
  }

  /**
   * Clears all sessions in memory and persistent storage.
   */
  public clear(): void {
    this.withFileLock(() => {
      this.sessions.clear();
      this.unsavedSessions.clear();
      this.saveToFile();
    });
  }
}

export const defaultSessionManager = new SessionManager();
