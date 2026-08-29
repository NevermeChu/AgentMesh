import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveAgentMeshHome } from "./session.js";
import type { UsageInfo } from "../agents/types.js";

/**
 * T5.2 checkpoint artifact layer.
 *
 * Interrupted or terminated work (stalled watchdog kill, orphan reap, failed
 * background dispatch) must not lose what the child already produced. The last
 * salvaged answer is persisted verbatim under
 * `<agentmeshHome>/checkpoints/<bucket>/<checkpointId>.json` and can be
 * injected into a continuation turn via continue_task(fromCheckpoint).
 *
 * Consumption follows the peek → fail-closed commit discipline of [AB]
 * admission-quota: a checkpoint is consumable exactly once; the consumed
 * tombstone is written BEFORE the caller is told success, and a second
 * consumption attempt is rejected instead of silently re-running the recovery.
 */

/** Character cap for the salvaged partial answer stored inside a checkpoint. */
export const CHECKPOINT_PARTIAL_MAX_CHARS = 32_000;

export type CheckpointReason = "stalled-terminated" | "orphan-reaped" | "failed" | "cancelled";

export interface CheckpointRecord {
  checkpointId: string;
  /** Bridge session bucket the checkpoint belongs to (present when known). */
  bridgeSessionId?: string;
  /** Background task id when the checkpoint originates from a background dispatch. */
  taskId?: string;
  reason: CheckpointReason;
  /** Salvaged partial answer text (already tail-truncated to the cap). */
  partialAnswer: string;
  summary?: string;
  usage?: UsageInfo;
  exitCode?: number;
  createdAtMs: number;
  /** Set on first consumption; a second consume is rejected (one-shot baton). */
  consumedAtMs?: number;
}

export class CheckpointNotFoundError extends Error {
  readonly checkpointId: string;

  constructor(checkpointId: string) {
    super(`Checkpoint '${checkpointId}' was not found.`);
    this.name = "CheckpointNotFoundError";
    this.checkpointId = checkpointId;
  }
}

export class CheckpointAlreadyConsumedError extends Error {
  readonly checkpointId: string;
  readonly consumedAtMs: number;

  constructor(checkpointId: string, consumedAtMs: number) {
    super(
      `Checkpoint '${checkpointId}' was already consumed at ` +
        `${new Date(consumedAtMs).toISOString()}; a checkpoint is a one-shot recovery baton and cannot be replayed.`,
    );
    this.name = "CheckpointAlreadyConsumedError";
    this.checkpointId = checkpointId;
    this.consumedAtMs = consumedAtMs;
  }
}

export class CheckpointPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointPathError";
  }
}

/** Path-segment guard mirroring core/artifacts.ts. */
function assertSafePathSegment(value: string, label: string): void {
  if (value.trim() === "") {
    throw new CheckpointPathError(`${label} must not be blank.`);
  }
  if (/[/\\]/.test(value) || value.includes("..") || value.includes("\0")) {
    throw new CheckpointPathError(
      `${label} contains path separators or traversal segments and was rejected: '${value}'.`,
    );
  }
}

/** Clips salvaged text to the checkpoint cap on a character boundary. */
export function clipPartialAnswer(
  text: string,
  maxChars: number = CHECKPOINT_PARTIAL_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `...[earlier output omitted]\n${text.slice(text.length - maxChars)}`;
}

export interface CheckpointStoreOptions {
  homeDir?: string;
  now?: () => number;
}

export class CheckpointStore {
  private readonly root: string;
  private readonly now: () => number;

  constructor(options: CheckpointStoreOptions = {}) {
    this.root = path.join(options.homeDir ?? resolveAgentMeshHome(), "checkpoints");
    this.now = options.now ?? Date.now;
  }

  /** Absolute path of one checkpoint record file. */
  public checkpointPath(checkpointId: string, bucket: string): string {
    assertSafePathSegment(bucket, "checkpoint bucket");
    assertSafePathSegment(checkpointId, "checkpointId");
    return path.join(this.root, bucket, `${checkpointId}.json`);
  }

  private get indexPath(): string {
    return path.join(this.root, "index.jsonl");
  }

  /**
   * Persists one checkpoint. The id is content-independent and caller-chosen
   * when provided (taskId-derived ids make reruns fail closed via 'wx').
   * An index line records the bucket so consumers can resolve a checkpoint by
   * id alone (they rarely know whether it was filed under a session or task).
   */
  public async saveCheckpoint(params: {
    checkpointId?: string;
    bridgeSessionId?: string;
    taskId?: string;
    reason: CheckpointReason;
    partialAnswer: string;
    summary?: string;
    usage?: UsageInfo;
    exitCode?: number;
  }): Promise<CheckpointRecord> {
    const bucket = params.bridgeSessionId || params.taskId || "unattributed";
    const checkpointId =
      params.checkpointId ??
      `ckpt_${this.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const record: CheckpointRecord = {
      checkpointId,
      ...(params.bridgeSessionId ? { bridgeSessionId: params.bridgeSessionId } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      reason: params.reason,
      partialAnswer: clipPartialAnswer(params.partialAnswer),
      ...(params.summary ? { summary: params.summary } : {}),
      ...(params.usage ? { usage: params.usage } : {}),
      ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
      createdAtMs: this.now(),
    };
    const filePath = this.checkpointPath(checkpointId, bucket);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // 'wx' keeps a rerun from overwriting the first recovery evidence.
    await fsp.writeFile(filePath, JSON.stringify(record, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
    try {
      await fsp.appendFile(
        this.indexPath,
        `${JSON.stringify({ checkpointId, bucket })}\n`,
        "utf-8",
      );
    } catch {
      // Index loss degrades lookup to explicit-bucket reads; never fatal.
    }
    return record;
  }

  /** Resolves the bucket recorded for one checkpoint id (newest entry wins). */
  private async resolveBucket(checkpointId: string): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexPath, "utf-8");
    } catch {
      return undefined;
    }
    let bucket: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { checkpointId?: unknown; bucket?: unknown };
        if (parsed.checkpointId === checkpointId && typeof parsed.bucket === "string") {
          bucket = parsed.bucket;
        }
      } catch {
        // Corrupt lines are skipped, never fatal.
      }
    }
    return bucket;
  }

  /** Reads one checkpoint without consuming it. */
  public async readCheckpoint(checkpointId: string, bucket?: string): Promise<CheckpointRecord> {
    const resolved = bucket ?? (await this.resolveBucket(checkpointId));
    if (!resolved) throw new CheckpointNotFoundError(checkpointId);
    let raw: string;
    try {
      raw = await fsp.readFile(this.checkpointPath(checkpointId, resolved), "utf-8");
    } catch {
      throw new CheckpointNotFoundError(checkpointId);
    }
    return this.parseRecord(raw, checkpointId);
  }

  /**
   * One-shot consumption: returns the record and stamps the consumed tombstone
   * before resolving. A record that already carries a tombstone is rejected.
   */
  public async consumeCheckpoint(checkpointId: string, bucket?: string): Promise<CheckpointRecord> {
    const resolved = bucket ?? (await this.resolveBucket(checkpointId));
    if (!resolved) throw new CheckpointNotFoundError(checkpointId);
    const record = await this.readCheckpoint(checkpointId, resolved);
    if (record.consumedAtMs !== undefined) {
      throw new CheckpointAlreadyConsumedError(checkpointId, record.consumedAtMs);
    }
    const consumed: CheckpointRecord = { ...record, consumedAtMs: this.now() };
    // Fail-closed commit: only report success after the tombstone is durable.
    await fsp.writeFile(
      this.checkpointPath(checkpointId, resolved),
      JSON.stringify(consumed, null, 2),
      "utf-8",
    );
    return consumed;
  }

  private parseRecord(raw: string, checkpointId: string): CheckpointRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CheckpointNotFoundError(checkpointId);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new CheckpointNotFoundError(checkpointId);
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.checkpointId !== "string" ||
      typeof candidate.reason !== "string" ||
      typeof candidate.partialAnswer !== "string" ||
      typeof candidate.createdAtMs !== "number"
    ) {
      throw new CheckpointNotFoundError(checkpointId);
    }
    return {
      checkpointId: candidate.checkpointId,
      ...(typeof candidate.bridgeSessionId === "string"
        ? { bridgeSessionId: candidate.bridgeSessionId }
        : {}),
      ...(typeof candidate.taskId === "string" ? { taskId: candidate.taskId } : {}),
      reason: candidate.reason as CheckpointReason,
      partialAnswer: candidate.partialAnswer,
      ...(typeof candidate.summary === "string" ? { summary: candidate.summary } : {}),
      ...(typeof candidate.usage === "object" && candidate.usage !== null
        ? { usage: candidate.usage }
        : {}),
      ...(typeof candidate.exitCode === "number" ? { exitCode: candidate.exitCode } : {}),
      createdAtMs: candidate.createdAtMs,
      ...(typeof candidate.consumedAtMs === "number"
        ? { consumedAtMs: candidate.consumedAtMs }
        : {}),
    };
  }
}

export const defaultCheckpointStore = new CheckpointStore();
