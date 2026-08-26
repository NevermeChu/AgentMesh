import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveAgentMeshHome } from "./session.js";

/**
 * T1.4 background task registry.
 *
 * Persists one JSONL line per dispatched background task so a restarted bridge
 * can distinguish live work from orphans left behind by a dead process. The
 * registry is deliberately dumb storage plus pure decision helpers: completion
 * is inferred either from a `<taskId>.result.json` record written by the
 * completion callback or, absent that, from process liveness. Output bytes are
 * read incrementally at a byte offset (same semantics as [CC]
 * utils/task/diskOutput.ts) so poll_task never re-reads what the caller
 * already consumed.
 */

/** Output silence after which an active background task is reported as stalled. */
export const STALLED_OUTPUT_THRESHOLD_MS = 10 * 60_000;

/** How often the stalled watchdog inspects active tasks while any exist. */
export const WATCHDOG_INTERVAL_MS = 30_000;

/** Wait between two output-file polls inside one poll_task call. */
export const POLL_INTERVAL_MS = 100;

/** Upper bound a single poll_task call may spend waiting for progress. */
export const POLL_MAX_WAIT_MS = 500;

/** Cap for one incremental output read (mirrors [CC] DEFAULT_MAX_READ_BYTES). */
export const MAX_POLL_READ_BYTES = 8 * 1024 * 1024;

/** One persisted background-task registration line in registry.jsonl. */
export interface BackgroundTaskRecord {
  taskId: string;
  /**
   * Owning bridge-process pid. Orphan detection keys on this pid: when the
   * owning bridge dies, its incomplete registrations are reaped on next
   * startup. The vendor child pid is intentionally not used because it is not
   * observable at the MCP dispatch boundary before spawn.
   */
  pid: number;
  /** Registration instant (epoch ms). */
  startedAtMs: number;
  /** Absolute path of the tee'd stdout/stderr capture file. */
  outputFile: string;
}

/** Terminal outcome written by the completion callback to <taskId>.result.json. */
export interface StoredTaskResult {
  taskId: string;
  status: "completed" | "failed";
  summary?: string;
  finalAnswer?: string;
  error?: string;
  exitCode?: number;
  completedAtMs: number;
}

export type PollTaskStatus = "running" | "completed" | "failed" | "stalled";

export interface PollTaskOutcome {
  taskId: string;
  status: PollTaskStatus;
  /** New output bytes since sinceOffset. */
  outputSinceOffset: string;
  /** Byte offset the caller should pass as the next sinceOffset. */
  nextOffset: number;
  /** True when unread bytes remain beyond nextOffset. */
  hasMore: boolean;
  /** Present once the task reached a terminal state. */
  result?: StoredTaskResult;
}

export interface PollTaskOptions {
  taskId: string;
  sinceOffset?: number;
  maxWaitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Raised when poll_task references a taskId unknown to memory and registry. */
export class BackgroundTaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Background task '${taskId}' was not found in the registry.`);
    this.name = "BackgroundTaskNotFoundError";
    this.taskId = taskId;
  }
}

/** Raised by scanAndReapOrphans when the registry file cannot be parsed. */
export class BackgroundRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BackgroundRegistryError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Cross-platform pid liveness probe (signal 0: ESRCH = gone, EPERM = alive but foreign). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface OutputRangeRead {
  content: string;
  nextOffset: number;
  hasMore: boolean;
}

/** Reads at most maxBytes of filePath starting at byte offset ([CC] diskOutput semantics). */
async function readOutputRange(
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<OutputRangeRead> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", nextOffset: offset, hasMore: false };
    }
    throw err;
  }
  try {
    const total = (await handle.stat()).size;
    if (offset >= total) {
      return { content: "", nextOffset: offset, hasMore: false };
    }
    const length = Math.min(maxBytes, total - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      // A chunk boundary can split a multi-byte UTF-8 sequence; the replacement
      // char it produces is the documented cost of offset-based reads.
      content: buffer.toString("utf8"),
      nextOffset: offset + bytesRead,
      hasMore: offset + bytesRead < total,
    };
  } finally {
    await handle.close();
  }
}

function parseRegistryLine(line: string): BackgroundTaskRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.taskId !== "string" ||
      typeof candidate.pid !== "number" ||
      typeof candidate.startedAtMs !== "number" ||
      typeof candidate.outputFile !== "string"
    ) {
      return undefined;
    }
    return {
      taskId: candidate.taskId,
      pid: candidate.pid,
      startedAtMs: candidate.startedAtMs,
      outputFile: candidate.outputFile,
    };
  } catch {
    return undefined;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface StalledWatchdogOptions {
  /**
   * Resolves the activity handle executor.ts keeps per running background task.
   * Returning undefined falls back to the registration timestamp baseline.
   */
  getActivityHandle?: (taskId: string) => { getLastOutputAtMs(): number | undefined } | undefined;
  intervalMs?: number;
  thresholdMs?: number;
  /** Advisory callback invoked at most once per task (deduplicated). */
  onStalled?: (taskId: string) => void;
}

export interface BackgroundRegistryOptions {
  homeDir?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

export class BackgroundTaskRegistry {
  private readonly tasksDir: string;
  private readonly registryFile: string;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly active = new Map<string, BackgroundTaskRecord>();
  private readonly released = new Set<string>();
  private readonly stalledNotified = new Set<string>();
  private watchdogConfig: StalledWatchdogOptions | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;

  constructor(options: BackgroundRegistryOptions = {}) {
    const homeDir = options.homeDir ?? resolveAgentMeshHome();
    this.tasksDir = path.join(homeDir, "tasks");
    this.registryFile = path.join(this.tasksDir, "registry.jsonl");
    this.now = options.now ?? Date.now;
    this.pidAlive = options.isPidAlive ?? isPidAlive;
  }

  /** Directory holding registry.jsonl, output captures and result records. */
  public get tasksDirectory(): string {
    return this.tasksDir;
  }

  public get registryFilePath(): string {
    return this.registryFile;
  }

  public outputFilePath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.output`);
  }

  private resultFilePath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.result.json`);
  }

  /**
   * Registers and persists one background task. The JSONL append happens
   * synchronously before the caller starts async work so a crash immediately
   * after launch still leaves a recoverable trace.
   */
  public registerTask(record: BackgroundTaskRecord): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.appendFileSync(this.registryFile, `${JSON.stringify(record)}\n`, "utf-8");
    this.active.set(record.taskId, { ...record });
    this.ensureWatchdogTimer();
  }

  /** Memory-first lookup with a registry.jsonl fallback (restart recovery). */
  public getRegisteredTask(taskId: string): BackgroundTaskRecord | undefined {
    const live = this.active.get(taskId);
    if (live) return { ...live };
    for (const record of this.readPersistedRecords()) {
      if (record.taskId === taskId) return record;
    }
    return undefined;
  }

  private readPersistedRecords(): BackgroundTaskRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryFile, "utf-8");
    } catch {
      return [];
    }
    const records: BackgroundTaskRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      // Corrupt lines are skipped, never fatal: the registry must stay readable.
      const parsed = parseRegistryLine(line);
      if (parsed) records.push(parsed);
    }
    return records;
  }

  public async readStoredResult(taskId: string): Promise<StoredTaskResult | undefined> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.resultFilePath(taskId), "utf-8");
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.taskId !== "string" ||
        (candidate.status !== "completed" && candidate.status !== "failed") ||
        typeof candidate.completedAtMs !== "number"
      ) {
        return undefined;
      }
      return {
        taskId: candidate.taskId,
        status: candidate.status,
        summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
        finalAnswer: typeof candidate.finalAnswer === "string" ? candidate.finalAnswer : undefined,
        error: typeof candidate.error === "string" ? candidate.error : undefined,
        exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : undefined,
        completedAtMs: candidate.completedAtMs,
      };
    } catch {
      // A half-written result file is treated as absent; liveness decides instead.
      return undefined;
    }
  }

  /** Completion callback target: persists the terminal outcome atomically enough for readers. */
  public async writeStoredResult(result: StoredTaskResult): Promise<void> {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    await fsp.writeFile(this.resultFilePath(result.taskId), JSON.stringify(result), "utf-8");
  }

  /** Tasks still tracked in this process without a stored terminal result. */
  public listActiveTasks(): BackgroundTaskRecord[] {
    return [...this.active.values()]
      .filter((record) => !fs.existsSync(this.resultFilePath(record.taskId)))
      .map((record) => ({ ...record }));
  }

  /** True when the task already produced a stored terminal result. */
  public hasStoredResult(taskId: string): boolean {
    return fs.existsSync(this.resultFilePath(taskId));
  }

  /**
   * Startup orphan sweep. Every registration whose owning pid is dead is
   * removed from registry.jsonl (its output/result files remain on disk for
   * post-mortem inspection); the removed entries are returned.
   */
  public async scanAndReapOrphans(): Promise<BackgroundTaskRecord[]> {
    const records = this.readPersistedRecords();
    if (records.length === 0) return [];
    const kept: BackgroundTaskRecord[] = [];
    const reaped: BackgroundTaskRecord[] = [];
    for (const record of records) {
      const hasResult = fs.existsSync(this.resultFilePath(record.taskId));
      if (!this.pidAlive(record.pid)) {
        reaped.push(record);
        continue;
      }
      // A finished task owned by a live bridge needs no further tracking.
      if (hasResult && !this.active.has(record.taskId)) {
        reaped.push(record);
        continue;
      }
      kept.push(record);
    }
    if (reaped.length > 0) {
      await this.rewriteRegistry(kept);
    }
    return reaped;
  }

  private async rewriteRegistry(records: BackgroundTaskRecord[]): Promise<void> {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    const tempFile = `${this.registryFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(
      tempFile,
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
      "utf-8",
    );
    try {
      await fsp.rename(tempFile, this.registryFile);
    } catch {
      // Windows rename can fail under concurrent readers; fall back to copy.
      await fsp.copyFile(tempFile, this.registryFile);
      await fsp.unlink(tempFile);
    }
  }

  /**
   * Installs the stalled watchdog configuration and starts its timer. The
   * timer only keeps running while at least one active task exists.
   */
  public enableStalledWatchdog(options: StalledWatchdogOptions): void {
    this.watchdogConfig = options;
    this.ensureWatchdogTimer();
  }

  /** Observable for tests/diagnostics: whether the watchdog timer currently runs. */
  public get isWatchdogRunning(): boolean {
    return this.watchdogTimer !== undefined;
  }

  private ensureWatchdogTimer(): void {
    // The watchdog timer exists only while there is something to watch.
    if (!this.watchdogConfig || this.watchdogTimer || this.active.size === 0) return;
    const intervalMs = this.watchdogConfig.intervalMs ?? WATCHDOG_INTERVAL_MS;
    this.watchdogTimer = setInterval(() => this.runWatchdogTick(), intervalMs);
    this.watchdogTimer.unref();
  }

  private runWatchdogTick(): void {
    if (this.active.size === 0) {
      this.stopWatchdogTimer();
      return;
    }
    this.checkStalledTasks(this.now());
  }

  private stopWatchdogTimer(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  /**
   * Pure-ish stall sweep with an injectable clock: flags every active task
   * whose last observed output instant is at least the threshold old. Each
   * task is notified at most once (dedup set, [AB] scheduleTurnWatchdog style).
   */
  public checkStalledTasks(nowMs: number): string[] {
    const thresholdMs = this.watchdogConfig?.thresholdMs ?? STALLED_OUTPUT_THRESHOLD_MS;
    const newlyStalled: string[] = [];
    for (const [taskId, record] of this.active) {
      if (this.stalledNotified.has(taskId)) continue;
      if (fs.existsSync(this.resultFilePath(taskId))) continue;
      const handle = this.watchdogConfig?.getActivityHandle?.(taskId);
      const lastOutputAtMs = handle?.getLastOutputAtMs() ?? record.startedAtMs;
      if (nowMs - lastOutputAtMs >= thresholdMs) {
        this.stalledNotified.add(taskId);
        newlyStalled.push(taskId);
        this.watchdogConfig?.onStalled?.(taskId);
      }
    }
    if (this.active.size === 0) this.stopWatchdogTimer();
    return newlyStalled;
  }

  /** True once the watchdog has flagged this task as stalled in this process. */
  public isStallNotified(taskId: string): boolean {
    return this.stalledNotified.has(taskId);
  }

  /** Drops in-process tracking after the task promise settled. */
  public releaseTask(taskId: string): void {
    this.active.delete(taskId);
    this.released.add(taskId);
    if (this.active.size === 0) this.stopWatchdogTimer();
  }

  /** True when releaseTask already ran for this taskId in this process. */
  public isReleased(taskId: string): boolean {
    return this.released.has(taskId);
  }

  /** One poll step: status resolution plus incremental output read. */
  public async pollOnce(taskId: string, sinceOffset: number): Promise<PollTaskOutcome> {
    const record = this.getRegisteredTask(taskId);
    if (!record) throw new BackgroundTaskNotFoundError(taskId);
    const stored = await this.readStoredResult(taskId);
    const read = await readOutputRange(
      record.outputFile,
      Math.max(0, sinceOffset),
      MAX_POLL_READ_BYTES,
    );
    let status: PollTaskStatus;
    if (stored) {
      status = stored.status;
    } else if (this.isStallNotified(taskId)) {
      status = "stalled";
    } else if (this.active.has(taskId)) {
      status = "running";
    } else {
      // Registered but neither active nor terminal here: decide by owner liveness.
      status = this.pidAlive(record.pid) ? "running" : "failed";
    }
    return {
      taskId,
      status,
      outputSinceOffset: read.content,
      nextOffset: read.nextOffset,
      hasMore: read.hasMore,
      ...(stored ? { result: stored } : {}),
    };
  }

  /**
   * Polls until a terminal/stalled state or maxWaitMs elapse, sleeping
   * intervalMs between attempts (default 100ms/500ms).
   */
  public async pollTask(options: PollTaskOptions): Promise<PollTaskOutcome> {
    const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    const maxWaitMs = options.maxWaitMs ?? POLL_MAX_WAIT_MS;
    const sleep = options.sleep ?? defaultSleep;
    // The wait budget is wall-clock bounded on purpose: the injectable logical
    // clock drives status decisions and must never stretch a caller's poll.
    const deadline = Date.now() + maxWaitMs;
    let outcome = await this.pollOnce(options.taskId, options.sinceOffset ?? 0);
    while (outcome.status === "running" && Date.now() < deadline) {
      await sleep(intervalMs);
      outcome = await this.pollOnce(options.taskId, options.sinceOffset ?? 0);
    }
    return outcome;
  }
}
