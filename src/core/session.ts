import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ZodError, z } from "zod";
import type { AgentName, AgentRole } from "../agents/types.js";
import type {
  BridgeSession,
  IdempotencyTombstone,
  IdempotencyTombstoneStore,
  SessionHistoryEntry,
  SessionManagerOptions,
} from "./types.js";

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
  "VENDOR_QUOTA",
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
  testFilesModified: z.array(z.string()).optional(),
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
const UsageInfoSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  reasoningOutputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
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
  // P-R14-2b: without this field, zod silently stripped usage on every disk
  // reload and the T5.4 budget gate went blind across process/restart edges.
  usage: UsageInfoSchema.optional(),
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
 * T2.3 summary sidecar stored inside a session's metadata bag (the persisted
 * BridgeSession shape stays untouched). `summarizedTurns` pins the summary to
 * a history length: any turn appended afterwards makes the snapshot incomplete
 * and sends shared-context rendering back to the full transcript.
 */
export interface SessionSummary {
  /** Deliverable summary text; the <analysis> draft is stripped by the caller. */
  text: string;
  /** Number of source-session history turns covered at compaction time. */
  summarizedTurns: number;
  /** ISO timestamp of when the summary was produced. */
  createdAt: string;
}

const METADATA_SUMMARY_KEY = "compactSummary";

/**
 * Narrows the untyped metadata bag entry into a SessionSummary. Returns
 * undefined for absent or malformed entries instead of throwing, so older
 * sessions and partial writes degrade to "no summary".
 */
export function readSessionSummary(session: BridgeSession): SessionSummary | undefined {
  const raw = session.metadata?.[METADATA_SUMMARY_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.text !== "string" || !candidate.text.trim()) return undefined;
  if (
    typeof candidate.summarizedTurns !== "number" ||
    !Number.isInteger(candidate.summarizedTurns) ||
    candidate.summarizedTurns < 0
  ) {
    return undefined;
  }
  if (typeof candidate.createdAt !== "string") return undefined;
  return {
    text: candidate.text,
    summarizedTurns: candidate.summarizedTurns,
    createdAt: candidate.createdAt,
  };
}

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

/**
 * Resolves the AgentMesh home directory (parent of sessions.json) exactly like
 * the storage-path resolution above. Background task artifacts and spill
 * artifacts share this root so AGENTMESH_SESSIONS_FILE relocates all of it.
 */
export function resolveAgentMeshHome(): string {
  return path.dirname(resolveSessionStoragePath());
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
  /**
   * Terminal-outcome tombstones for idempotency keys (P1 T1.1). Process-local
   * by design: losing them across a bridge restart degrades to honest
   * re-execution of the same key (documented boundary, not silent corruption).
   */
  private idempotencyTombstones: IdempotencyTombstoneStore = new Map();

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
    // P-R14-2: preserved unsaved sessions re-enter after the load-time cap, so
    // enforce once more; LRU ordering evicts oldest first and leaves the
    // preserved (newest) sessions for last.
    this.enforceSessionCap();
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
        // P-R14-2: the disk file may exceed the cap (deferred-create means
        // evictions are not always persisted); enforce on every load or the
        // in-memory map — and therefore the next flush — grows without bound.
        this.enforceSessionCap();
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
   * Records one artifact-spill pointer in the session's sidecar audit area
   * (the same contexts/<sessionId> directory persistContextArtifact uses).
   * The artifact body itself lives under <agentmeshHome>/artifacts; this
   * sidecar keeps the SHA-256 pointer discoverable next to the turn it
   * belongs to.
   */
  public persistArtifactSidecar(
    sessionId: string,
    turnNumber: number,
    record: {
      source: string;
      chars: number;
      sha256: string;
      artifactPath: string;
    },
  ): { file: string } | undefined {
    if (!this.persist) return undefined;
    try {
      const storageDir = path.dirname(this.storagePath);
      const dir = path.join(storageDir, "contexts", sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${String(turnNumber).padStart(3, "0")}.artifact.json`;
      fs.writeFileSync(
        path.join(dir, fileName),
        JSON.stringify({ timestamp: new Date().toISOString(), ...record }, null, 2),
        "utf-8",
      );
      return { file: path.join("contexts", sessionId, fileName) };
    } catch {
      // Audit artifacts are best-effort: losing one must not fail the turn.
      return undefined;
    }
  }

  /**
   * Looks up the live tombstone for an idempotency scope key. Expired
   * tombstones are treated as absent and dropped eagerly (lazy expiry is the
   * authoritative TTL check; `nowMs` is injectable for tests).
   */
  public getIdempotencyTombstone(
    scopeKey: string,
    nowMs: number = Date.now(),
  ): IdempotencyTombstone | undefined {
    const tombstone = this.idempotencyTombstones.get(scopeKey);
    if (!tombstone) return undefined;
    if (nowMs >= tombstone.expiresAtMs) {
      this.idempotencyTombstones.delete(scopeKey);
      return undefined;
    }
    return structuredClone(tombstone);
  }

  /** Records (or overwrites) the terminal tombstone for an idempotency scope key. */
  public setIdempotencyTombstone(scopeKey: string, tombstone: IdempotencyTombstone): void {
    this.idempotencyTombstones.set(scopeKey, structuredClone(tombstone));
  }

  /**
   * T2.3 summary sidecar write. Stores the compact summary in the session's
   * metadata bag without touching history, so turn-count-based freshness
   * checks stay meaningful. Returns false when the session no longer exists.
   */
  public setSummary(id: string, summary: SessionSummary): boolean {
    return this.withFileLock(() => {
      const existing = this.sessions.get(id);
      if (!existing) return false;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        [METADATA_SUMMARY_KEY]: structuredClone(summary),
      };
      existing.updatedAt = new Date().toISOString();
      this.saveToFile();
      this.markFlushed(id);
      return true;
    });
  }

  /** T2.3 summary sidecar read; undefined when absent or malformed. */
  public getSummary(id: string): SessionSummary | undefined {
    const session = this.getSession(id);
    return session ? readSessionSummary(session) : undefined;
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
