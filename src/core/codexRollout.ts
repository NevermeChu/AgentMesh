import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

/**
 * Token usage recovered from a rollout `token_count` event
 * (`info.total_token_usage`, cumulative for the thread).
 */
export interface CodexRolloutUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

/** Result of salvaging one rollout file after a crash. */
export interface CodexRolloutRecovery {
  /** Thread id from the validated `session_meta` header. */
  sessionId: string;
  historyMode?: "legacy" | "paginated";
  cwd?: string;
  /** Rollout file the payload was recovered from. */
  rolloutPath: string;
  /** `task_complete.last_agent_message` — the official completed-turn answer. */
  lastAgentMessage?: string;
  /**
   * Last persisted `agent_message` event; only meaningful when the turn never
   * reached `task_complete` (mid-turn crash salvage).
   */
  partialAgentMessage?: string;
  /** Cumulative token usage from the latest persisted `token_count` event. */
  usage?: CodexRolloutUsage;
}

/** Structured failure describing why a rollout file could not be trusted or read. */
export class CodexRolloutError extends Error {
  readonly path?: string;

  constructor(message: string, options?: { path?: string; cause?: unknown }) {
    super(message);
    this.name = "CodexRolloutError";
    this.path = options?.path;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const KNOWN_HISTORY_MODES = new Set(["legacy", "paginated"]);

const ROLLOUT_PREFIX = "rollout-";
const PLAIN_SUFFIX = ".jsonl";
const COMPRESSED_SUFFIX = ".jsonl.zst";

/**
 * Resolves the Codex home directory used by the vendor CLI:
 * explicit argument, then `CODEX_HOME`, then `~/.codex`.
 */
export function resolveCodexHome(explicitHome?: string): string {
  if (explicitHome && explicitHome.trim()) return path.resolve(explicitHome.trim());
  const envHome = process.env.CODEX_HOME;
  if (envHome && envHome.trim()) return path.resolve(envHome.trim());
  return path.join(os.homedir(), ".codex");
}

function isNativeZstdAvailable(): boolean {
  const zlibWithZstd = zlib as unknown as Record<string, unknown>;
  return typeof zlibWithZstd.zstdDecompressSync === "function";
}

function stripSuffixes(fileName: string): { base: string; compressed: boolean } {
  if (fileName.toLowerCase().endsWith(COMPRESSED_SUFFIX)) {
    return { base: fileName.slice(0, -COMPRESSED_SUFFIX.length), compressed: true };
  }
  if (fileName.toLowerCase().endsWith(PLAIN_SUFFIX)) {
    return { base: fileName.slice(0, -PLAIN_SUFFIX.length), compressed: false };
  }
  return { base: fileName, compressed: false };
}

/**
 * Whether a rollout file name encodes the given thread id. File names follow
 * `rollout-<timestamp>-<threadId>.jsonl[.zst]`; reverted threads append
 * `_<rolloutId>` after the stable thread id.
 */
function fileNameEncodesThreadId(fileName: string, sessionId: string): boolean {
  const { base } = stripSuffixes(fileName);
  if (!base.toLowerCase().startsWith(ROLLOUT_PREFIX)) return false;
  // Drop a trailing `_<rolloutId>` suffix produced by thread/revert.
  const withoutRolloutSuffix = base.replace(/_[^_]*$/, "");
  const normalizedId = sessionId.toLowerCase();
  return [base, withoutRolloutSuffix].some((candidate) =>
    candidate.toLowerCase().endsWith(normalizedId),
  );
}

interface DayDirectory {
  year: string;
  month: string;
  day: string;
}

async function listDayDirectories(sessionsDir: string): Promise<DayDirectory[]> {
  const years = await fsp.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const days: DayDirectory[] = [];
  for (const year of years) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    const months = await fsp
      .readdir(path.join(sessionsDir, year.name), { withFileTypes: true })
      .catch(() => []);
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      const dayEntries = await fsp
        .readdir(path.join(sessionsDir, year.name, month.name), { withFileTypes: true })
        .catch(() => []);
      for (const day of dayEntries) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        days.push({ year: year.name, month: month.name, day: day.name });
      }
    }
  }
  // Newest date first; zero-padded segments sort lexicographically.
  days.sort((a, b) => `${b.year}${b.month}${b.day}`.localeCompare(`${a.year}${a.month}${a.day}`));
  return days;
}

/**
 * Lists rollout files whose name encodes the thread id, newest first.
 * Both plain `.jsonl` and zstd-compressed `.jsonl.zst` siblings are returned.
 */
export async function locateRolloutFiles(sessionId: string, codexHome?: string): Promise<string[]> {
  const trimmed = sessionId.trim();
  if (!trimmed) return [];
  const sessionsDir = path.join(resolveCodexHome(codexHome), "sessions");
  const candidates: string[] = [];
  for (const dir of await listDayDirectories(sessionsDir)) {
    const dayPath = path.join(sessionsDir, dir.year, dir.month, dir.day);
    const files = await fsp.readdir(dayPath, { withFileTypes: true }).catch(() => []);
    const matches = files
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.toLowerCase().endsWith(PLAIN_SUFFIX) ||
            entry.name.toLowerCase().endsWith(COMPRESSED_SUFFIX)) &&
          fileNameEncodesThreadId(entry.name, trimmed),
      )
      .map((entry) => entry.name)
      // Newest timestamp prefix first within the same day.
      .sort((a, b) => b.localeCompare(a));
    for (const name of matches) candidates.push(path.join(dayPath, name));
  }
  return candidates;
}

type RolloutLineValue = Record<string, unknown>;

function parseRolloutLine(line: string): RolloutLineValue | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as RolloutLineValue;
    }
  } catch {
    // Corrupt or half-written lines are skipped, matching the official reader.
  }
  return undefined;
}

function readString(source: RolloutLineValue | undefined, key: string): string | undefined {
  const raw = source?.[key];
  return typeof raw === "string" ? raw : undefined;
}

function pickFiniteNumber(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = (source as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function mapTotalTokenUsage(total: unknown): CodexRolloutUsage | undefined {
  if (!total || typeof total !== "object") return undefined;
  const usage: CodexRolloutUsage = {
    inputTokens: pickFiniteNumber(total, "input_tokens"),
    cachedInputTokens: pickFiniteNumber(total, "cached_input_tokens"),
    cacheWriteInputTokens: pickFiniteNumber(total, "cache_write_input_tokens"),
    outputTokens: pickFiniteNumber(total, "output_tokens"),
    reasoningOutputTokens: pickFiniteNumber(total, "reasoning_output_tokens"),
    totalTokens: pickFiniteNumber(total, "total_tokens"),
  };
  const hasAny = Object.values(usage).some((value) => value !== undefined);
  return hasAny ? usage : undefined;
}

interface SessionMetaHeader {
  sessionId: string;
  historyMode?: "legacy" | "paginated";
  cwd?: string;
}

/**
 * Validates the head of a rollout file and returns its session metadata,
 * mirroring `[CX] rollout/src/list.rs::read_session_meta_line`: the first
 * meaningful line must be `session_meta`, and an unknown `history_mode`
 * invalidates the file instead of being silently ignored.
 */
function readSessionMeta(lines: string[], rolloutPath: string): SessionMetaHeader {
  for (const line of lines) {
    const value = parseRolloutLine(line);
    if (!value) continue;
    const type = readString(value, "type");
    if (type !== "session_meta") {
      // Response items before the header mean the file does not start with
      // session metadata and cannot be trusted for recovery.
      if (type === "response_item" || type === "inter_agent_communication") {
        throw new CodexRolloutError(
          `rollout at ${rolloutPath} does not start with session metadata`,
          {
            path: rolloutPath,
          },
        );
      }
      continue;
    }
    const payload =
      value.payload && typeof value.payload === "object"
        ? (value.payload as RolloutLineValue)
        : value;
    const rawMode = readString(payload, "history_mode");
    let historyMode: SessionMetaHeader["historyMode"];
    if (rawMode !== undefined) {
      if (!KNOWN_HISTORY_MODES.has(rawMode)) {
        throw new CodexRolloutError(
          `invalid session metadata history_mode '${rawMode}' in ${rolloutPath}`,
          { path: rolloutPath },
        );
      }
      historyMode = rawMode as "legacy" | "paginated";
    }
    const sessionId = readString(payload, "id");
    if (!sessionId) {
      throw new CodexRolloutError(`session metadata in ${rolloutPath} has no thread id`, {
        path: rolloutPath,
      });
    }
    return { sessionId, historyMode, cwd: readString(payload, "cwd") };
  }
  throw new CodexRolloutError(`rollout at ${rolloutPath} is empty`, { path: rolloutPath });
}

async function readRolloutLines(filePath: string): Promise<string[]> {
  const raw = await fsp.readFile(filePath).catch((cause: unknown) => {
    throw new CodexRolloutError(`failed to read rollout file '${filePath}'`, {
      path: filePath,
      cause,
    });
  });
  if (!filePath.toLowerCase().endsWith(COMPRESSED_SUFFIX)) {
    return raw.toString("utf8").split(/\r?\n/);
  }
  if (!isNativeZstdAvailable()) {
    throw new CodexRolloutError(
      `zstd decompression is not available in this Node runtime; cannot read rollout '${filePath}'`,
      { path: filePath },
    );
  }
  const decompressSync = (zlib as unknown as { zstdDecompressSync?: (buffer: Buffer) => Buffer })
    .zstdDecompressSync;
  try {
    return decompressSync!(raw).toString("utf8").split(/\r?\n/);
  } catch (cause: unknown) {
    throw new CodexRolloutError(`failed to decode zstd rollout '${filePath}'`, {
      path: filePath,
      cause,
    });
  }
}

/**
 * Parses one rollout file: validates the `session_meta` header (optionally
 * against the expected thread id), then scans the body for the last persisted
 * `task_complete.last_agent_message`, `token_count` usage totals, and any
 * trailing partial `agent_message`. Mirrors `[CX] rollout/src/policy.rs`
 * persistence guarantees: TokenCount/TurnComplete events survive SIGKILL.
 */
export async function parseRolloutFile(
  filePath: string,
  expectedSessionId?: string,
): Promise<CodexRolloutRecovery> {
  const lines = await readRolloutLines(filePath);
  const meta = readSessionMeta(lines, filePath);
  if (
    expectedSessionId &&
    meta.sessionId.toLowerCase() !== expectedSessionId.trim().toLowerCase()
  ) {
    throw new CodexRolloutError(
      `rollout '${filePath}' belongs to thread ${meta.sessionId}, expected ${expectedSessionId}`,
      { path: filePath },
    );
  }

  let lastAgentMessage: string | undefined;
  let partialAgentMessage: string | undefined;
  let usage: CodexRolloutUsage | undefined;

  for (const line of lines) {
    const value = parseRolloutLine(line);
    if (!value || readString(value, "type") !== "event_msg") continue;
    const payload =
      value.payload && typeof value.payload === "object"
        ? (value.payload as RolloutLineValue)
        : undefined;
    if (!payload) continue;
    switch (readString(payload, "type")) {
      case "task_complete":
      case "turn_complete": {
        const message = readString(payload, "last_agent_message");
        if (message !== undefined) lastAgentMessage = message;
        break;
      }
      case "token_count": {
        const info =
          payload.info && typeof payload.info === "object"
            ? (payload.info as RolloutLineValue)
            : undefined;
        const mapped = mapTotalTokenUsage(info?.total_token_usage ?? info);
        if (mapped) usage = mapped;
        break;
      }
      case "agent_message": {
        const message = readString(payload, "message");
        if (message !== undefined) partialAgentMessage = message;
        break;
      }
      default:
        break;
    }
  }

  return {
    sessionId: meta.sessionId,
    historyMode: meta.historyMode,
    cwd: meta.cwd,
    rolloutPath: filePath,
    lastAgentMessage,
    partialAgentMessage,
    usage,
  };
}

export interface RecoverCodexRolloutOptions {
  /** Bridge-known codex native thread/session id (UUID). */
  sessionId: string;
  /** Explicit CODEX_HOME; falls back to `CODEX_HOME` env, then `~/.codex`. */
  codexHome?: string;
}

/**
 * Locates and parses the newest trustworthy rollout file for a session.
 * Returns `undefined` when no candidate exists or none can be trusted;
 * never throws — crash recovery must stay best-effort.
 */
export async function recoverCodexRollout(
  options: RecoverCodexRolloutOptions,
): Promise<CodexRolloutRecovery | undefined> {
  if (!options.sessionId.trim()) return undefined;
  const candidates = await locateRolloutFiles(options.sessionId, options.codexHome);
  for (const candidate of candidates) {
    try {
      return await parseRolloutFile(candidate, options.sessionId);
    } catch {
      // Untrustworthy candidate (corrupt header, id mismatch, unreadable
      // compression): keep looking at older files instead of failing hard.
    }
  }
  return undefined;
}

/** Existence helper kept next to the recovery types for adapter wiring. */
export function fileExists(filePath: string | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
