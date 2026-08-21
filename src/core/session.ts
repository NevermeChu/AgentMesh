import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
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
const SessionHistoryEntrySchema = z.object({
  role: AgentRoleSchema,
  task: z.string(),
  timestamp: z.string().datetime(),
  status: z.enum(["success", "failed"]),
  summary: z.string().optional(),
  finalAnswer: z.string().optional(),
  findings: z.array(ReviewFindingSchema).optional(),
  nativeSessionId: z.string().min(1).optional(),
});
const BridgeSessionSchema: z.ZodType<BridgeSession> = z.object({
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

function snapshotSession(session: BridgeSession): BridgeSession {
  return structuredClone(session);
}

export class SessionManager {
  private sessions = new Map<string, BridgeSession>();
  private readonly storagePath: string;
  private readonly persist: boolean;
  private readonly lockPath: string;

  constructor(options: SessionManagerOptions = {}) {
    this.persist = options.persist ?? true;
    this.storagePath =
      options.storagePath ||
      process.env.AGENTMESH_SESSIONS_FILE ||
      path.join(os.homedir(), ".agentmesh", "sessions.json");
    this.lockPath = `${this.storagePath}.lock`;

    if (this.persist) {
      this.loadFromFile();
    }
  }

  /**
   * Loads sessions from the persisted JSON storage file with retry resilience for concurrent writes.
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
        // Brief pause to yield if another process is in the middle of atomic rename
        if (attempt < 4) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        }
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Failed to load AgentMesh sessions from '${this.storagePath}': ${message}`);
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
      throw new Error(`Failed to save AgentMesh sessions to '${this.storagePath}': ${message}`);
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

    try {
      this.loadFromFile();
      return operation();
    } finally {
      fs.closeSync(lockFd);
      try {
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  /**
   * Generates a unique bridge session ID.
   */
  public generateId(): string {
    const randomHex = crypto.randomBytes(6).toString("hex");
    return `bridge-sess_${randomHex}`;
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
      this.saveToFile();
      return snapshotSession(session);
    });
  }

  /**
   * Retrieves an active session by its ID.
   */
  public getSession(id: string): BridgeSession | undefined {
    if (this.persist) {
      this.loadFromFile();
    }
    const session = this.sessions.get(id);
    return session ? snapshotSession(session) : undefined;
  }

  /**
   * Updates an existing session.
   */
  public updateSession(
    id: string,
    updates: Partial<Omit<BridgeSession, "id" | "createdAt">>
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
        session.updatedAt = new Date().toISOString();
        this.saveToFile();
      }
    });
  }

  /**
   * Lists all tracked sessions.
   */
  public listSessions(): BridgeSession[] {
    if (this.persist) {
      this.loadFromFile();
    }

    return Array.from(this.sessions.values(), snapshotSession).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Deletes a session.
   */
  public deleteSession(id: string): boolean {
    return this.withFileLock(() => {
      const deleted = this.sessions.delete(id);
      if (deleted) {
        this.saveToFile();
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
      this.saveToFile();
    });
  }
}

export const defaultSessionManager = new SessionManager();
