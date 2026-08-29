import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import type { BridgeSession, SessionHistoryEntry, TimelineEntry } from "../core/types.js";
import type { BackgroundTaskRecord, StoredTaskResult } from "../core/background.js";
import { isPidAlive } from "../core/background.js";
import { loadProjectConfig } from "../core/config.js";

// ---------------------------------------------------------------------------
// Read-only data access layer for the UI visualization panel.
//
// Every function takes `homeDir` as an explicit parameter instead of calling
// resolveAgentMeshHome(), which lets tests inject a temporary directory and
// avoids any coupling to the real agentmesh home.  No writes, no locks, no
// SessionManager instantiation — only fs reads.
// ---------------------------------------------------------------------------

/** Cap for a single incremental output read (mirrors background.ts MAX_POLL_READ_BYTES). */
const MAX_POLL_READ_BYTES = 8 * 1024 * 1024;

export interface SessionSummary {
  id: string;
  agent: string;
  role: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastStatus: string | null;
  lastActivityAt: string | null;
  totalTokens: number;
  lastModelId?: string;
  /** True when at least one turn carries vendor usage (r18: 0 tokens on an old session means 未计量, not 没用). */
  hasUsage?: boolean;
  /** Distinct files with recorded changes across the session's turns (r18: the honest did-work signal). */
  changedFiles?: string[];
  /** First line of the orchestrator's dispatch prompt — the task this session worked on (r18). */
  taskTitle?: string;
}

export interface TaskSummary {
  taskId: string;
  status: string;
  startedAtMs: number;
  outputFile: string;
  orphanedAtMs: number | undefined;
  result: StoredTaskResult | undefined;
}

export interface TaskOutputRead {
  taskId: string;
  status: string;
  output: string;
  nextOffset: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readSessionsFile(homeDir: string): BridgeSession[] {
  const sessionsPath = nodePath.join(homeDir, "sessions.json");
  const parsed = readJsonFile(sessionsPath);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is BridgeSession =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string",
  );
}

function sumTokens(history: SessionHistoryEntry[]): number {
  let total = 0;
  for (const entry of history) {
    total += entry.usage?.totalTokens ?? 0;
  }
  return total;
}

function findLastRequestedModel(history: SessionHistoryEntry[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const model = history[i]!.requestedModel;
    if (model !== undefined) return model;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timeline derivation
// ---------------------------------------------------------------------------

const MAX_TASK_LENGTH = 500;

function isWorkerEntry(entry: SessionHistoryEntry): boolean {
  return !!(entry.finalAnswer || entry.summary || entry.evidence || entry.findings);
}

export function buildTimeline(session: BridgeSession): TimelineEntry[] {
  const history = session.history ?? [];
  return history.map((entry) => {
    const base: TimelineEntry = {
      timestamp: entry.timestamp,
      status: entry.status,
      role: entry.role,
      task: entry.task.length > MAX_TASK_LENGTH ? entry.task.slice(0, MAX_TASK_LENGTH) : entry.task,
      from: isWorkerEntry(entry) ? "worker" : "orchestrator",
    };
    // r18: 主模型给组员的完整提示词原文（前端折叠展示，不受 MAX_TASK_LENGTH 截断）。
    if (entry.task.length > MAX_TASK_LENGTH) base.taskFull = entry.task;
    if (entry.summary !== undefined) base.summary = entry.summary;
    if (entry.finalAnswer !== undefined) base.finalAnswer = entry.finalAnswer;
    if (entry.usage !== undefined) base.usage = entry.usage;
    if (entry.requestedModel !== undefined) base.modelId = entry.requestedModel;
    return base;
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Reads all sessions and returns summary records sorted by updatedAt descending. */
export function listSessions(homeDir: string): SessionSummary[] {
  const sessions = readSessionsFile(homeDir);
  return sessions
    .map((s) => {
      const history = s.history ?? [];
      const lastEntry = history.at(-1);
      const lastModelId = findLastRequestedModel(history);
      // r18: the honest did-work signal — distinct files with recorded changes.
      const changedFiles = [
        ...new Set(
          history.flatMap((entry) => {
            const paths = [
              ...(entry.evidence?.repositoryAfter?.changedPaths ?? []),
              ...(entry.evidence?.testFilesModified ?? []),
            ];
            return paths;
          }),
        ),
      ].slice(0, 50);
      const hasUsage = history.some((entry) => entry.usage !== undefined);
      const summary: SessionSummary = {
        id: s.id,
        agent: s.agent,
        role: s.role,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turnCount: history.length,
        lastStatus: lastEntry?.status ?? null,
        lastActivityAt: lastEntry?.timestamp ?? null,
        totalTokens: sumTokens(history),
        taskTitle: history[0]?.task.split(/\r?\n/)[0]?.slice(0, 60),
        changedFiles: changedFiles.length ? changedFiles : undefined,
        ...(hasUsage ? { hasUsage } : {}),
      };
      if (lastModelId !== undefined) summary.lastModelId = lastModelId;
      return summary;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * r18: groups sessions by project directory (cwd) — one archival group per
 * task/project, newest activity first. Collapsed rendering is the panel's job;
 * this only provides the stable grouping key and per-group aggregates.
 */
export interface ProjectGroup {
  project: string;
  label: string;
  sessions: SessionSummary[];
  totalTokens: number;
  meteredCount: number;
  lastActivityAt: string;
}

export function groupSessionsByProject(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.cwd || "(未知目录)";
    let group = groups.get(key);
    if (!group) {
      const normalized = key.replace(/\\/g, "/");
      const label = normalized.split("/").filter(Boolean).pop() || key;
      group = {
        project: key,
        label,
        sessions: [],
        totalTokens: 0,
        meteredCount: 0,
        lastActivityAt: session.updatedAt,
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.totalTokens += session.totalTokens ?? 0;
    if (session.hasUsage) group.meteredCount++;
    if (new Date(session.updatedAt).getTime() > new Date(group.lastActivityAt).getTime()) {
      group.lastActivityAt = session.updatedAt;
    }
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

/** Returns a single session by id, or undefined if not found. */
export function getSession(homeDir: string, id: string): BridgeSession | undefined {
  const sessions = readSessionsFile(homeDir);
  return sessions.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

function parseRegistryLines(homeDir: string): BackgroundTaskRecord[] {
  const registryPath = nodePath.join(homeDir, "tasks", "registry.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf-8");
  } catch {
    return [];
  }
  const records: BackgroundTaskRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const c = parsed as Record<string, unknown>;
      if (
        typeof c.taskId === "string" &&
        typeof c.pid === "number" &&
        typeof c.startedAtMs === "number" &&
        typeof c.outputFile === "string"
      ) {
        records.push({
          taskId: c.taskId,
          pid: c.pid,
          startedAtMs: c.startedAtMs,
          outputFile: c.outputFile,
          ...(typeof c.orphanedAtMs === "number" ? { orphanedAtMs: c.orphanedAtMs } : {}),
        });
      }
    } catch {
      // Corrupt lines are skipped — mirrors background.ts readPersistedRecords.
    }
  }
  return records;
}

async function readStoredResult(
  homeDir: string,
  taskId: string,
): Promise<StoredTaskResult | undefined> {
  const resultPath = nodePath.join(homeDir, "tasks", `${taskId}.result.json`);
  const raw = await fsp.readFile(resultPath, "utf-8").catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const c = parsed as Record<string, unknown>;
    if (
      typeof c.taskId === "string" &&
      (c.status === "completed" || c.status === "failed") &&
      typeof c.completedAtMs === "number"
    ) {
      return {
        taskId: c.taskId,
        status: c.status,
        summary: typeof c.summary === "string" ? c.summary : undefined,
        finalAnswer: typeof c.finalAnswer === "string" ? c.finalAnswer : undefined,
        error: typeof c.error === "string" ? c.error : undefined,
        exitCode: typeof c.exitCode === "number" ? c.exitCode : undefined,
        completedAtMs: c.completedAtMs,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives task status for display. Mirrors BackgroundTaskRegistry.pollOnce in
 * background.ts with one deliberate divergence: a stored terminal result wins
 * over the orphanedAtMs dead-letter marker. The scan that sets the marker
 * keys on owner-pid liveness alone, so a bridge restart after a task already
 * finished leaves completed records carrying the mark; showing those as
 * "interrupted" would mislabel finished work. P-R15-1's own contract defines
 * the dead letter as "owning bridge died without a terminal result", so the
 * result file is the stronger evidence.
 *   1. StoredTaskResult exists → completed/failed
 *   2. orphanedAtMs set (no result) → interrupted
 *   3. No result, pid alive → running
 *   4. No result, pid dead → failed (same as pollOnce)
 */
function deriveTaskStatus(
  record: BackgroundTaskRecord,
  result: StoredTaskResult | undefined,
): string {
  if (result) return result.status;
  if (record.orphanedAtMs !== undefined) return "interrupted";
  return isPidAlive(record.pid) ? "running" : "failed";
}

/** Lists all background tasks with derived status, sorted by startedAtMs descending. */
export async function listTasks(homeDir: string): Promise<TaskSummary[]> {
  const records = parseRegistryLines(homeDir);
  // The registry is append-only and the orphan scan re-appends marked lines,
  // so one taskId can appear multiple times. Keep the last line per taskId and
  // carry over the earliest dead-letter marker so the interruption evidence
  // survives the dedupe.
  const byTaskId = new Map<string, BackgroundTaskRecord>();
  for (const record of records) {
    const existing = byTaskId.get(record.taskId);
    if (existing?.orphanedAtMs !== undefined && record.orphanedAtMs === undefined) {
      byTaskId.set(record.taskId, { ...record, orphanedAtMs: existing.orphanedAtMs });
    } else {
      byTaskId.set(record.taskId, record);
    }
  }
  const summaries: TaskSummary[] = [];
  for (const record of byTaskId.values()) {
    const result = await readStoredResult(homeDir, record.taskId);
    summaries.push({
      taskId: record.taskId,
      status: deriveTaskStatus(record, result),
      startedAtMs: record.startedAtMs,
      outputFile: record.outputFile,
      orphanedAtMs: record.orphanedAtMs,
      result,
    });
  }
  return summaries.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Checks whether a taskId exists in the registry. */
export function taskExists(homeDir: string, taskId: string): boolean {
  const records = parseRegistryLines(homeDir);
  return records.some((r) => r.taskId === taskId);
}

/** Reads a task's output incrementally from a byte offset. */
export async function readTaskOutput(
  homeDir: string,
  taskId: string,
  offset: number,
): Promise<TaskOutputRead> {
  const records = parseRegistryLines(homeDir);
  const record = records.find((r) => r.taskId === taskId);
  if (!record) throw new TaskNotFoundError(taskId);

  const result = await readStoredResult(homeDir, taskId);
  const status = deriveTaskStatus(record, result);

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(record.outputFile, "r");
  } catch {
    // Missing output file degrades to empty output — same as background.ts readOutputRange.
    return { taskId, status, output: "", nextOffset: offset, hasMore: false };
  }
  try {
    const total = (await handle.stat()).size;
    if (offset >= total) {
      return { taskId, status, output: "", nextOffset: offset, hasMore: false };
    }
    const length = Math.min(MAX_POLL_READ_BYTES, total - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      taskId,
      status,
      output: buffer.toString("utf8"),
      nextOffset: offset + bytesRead,
      hasMore: offset + bytesRead < total,
    };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Budget / summary
// ---------------------------------------------------------------------------

export interface BudgetInfo {
  perSessionTokenCap: number;
  maxSessionUsed: number;
  maxSessionId: string;
}

export interface SummaryData {
  sessionCount: number;
  taskCounts: {
    running: number;
    interrupted: number;
    completed: number;
    failed: number;
    stalled: number;
    total: number;
  };
  totalTokens: number;
  lastEventAt: string | null;
  budget: BudgetInfo | null;
  dataHome: string;
}

/** Gathers summary statistics across sessions and tasks. */
export async function getSummary(
  homeDir: string,
  startDir: string | undefined,
): Promise<SummaryData> {
  const sessions = readSessionsFile(homeDir);
  let totalTokens = 0;
  let lastEventAt: string | null = null;

  for (const session of sessions) {
    const history = session.history ?? [];
    for (const entry of history) {
      totalTokens += entry.usage?.totalTokens ?? 0;
      if (entry.timestamp > (lastEventAt ?? "")) {
        lastEventAt = entry.timestamp;
      }
    }
  }

  const tasks = await listTasks(homeDir);
  const taskCounts = {
    running: 0,
    interrupted: 0,
    completed: 0,
    failed: 0,
    stalled: 0,
    total: tasks.length,
  };
  for (const t of tasks) {
    if (t.status === "running") taskCounts.running++;
    else if (t.status === "interrupted") taskCounts.interrupted++;
    else if (t.status === "completed") taskCounts.completed++;
    else if (t.status === "failed") taskCounts.failed++;
    else if (t.status === "stalled") taskCounts.stalled++;
  }

  let budget: BudgetInfo | null = null;
  if (startDir) {
    const loaded = loadProjectConfig(startDir);
    if (loaded?.config.budget?.perSessionTokenCap !== undefined) {
      const cap = loaded.config.budget.perSessionTokenCap;
      let maxUsed = 0;
      let maxSid = "";
      for (const s of sessions) {
        const tokens = sumTokens(s.history ?? []);
        if (tokens > maxUsed) {
          maxUsed = tokens;
          maxSid = s.id;
        }
      }
      budget = { perSessionTokenCap: cap, maxSessionUsed: maxUsed, maxSessionId: maxSid };
    }
  }

  return {
    sessionCount: sessions.length,
    taskCounts,
    totalTokens,
    lastEventAt,
    budget,
    dataHome: homeDir,
  };
}

// ---------------------------------------------------------------------------
// Agent statistics (agent x role aggregation)
// ---------------------------------------------------------------------------

export interface AgentStat {
  agent: string;
  role: string;
  turns: number;
  successCount: number;
  failedCount: number;
  /** successCount / turns, 0-1; 0 when the group has no turns. */
  successRate: number;
  /** Mean of evidence.durationMs across turns that report it; null when none do. */
  avgDurationMs: number | null;
  totalTokens: number;
}

/** Aggregates every session's history turns by (agent, role) pair. */
export function getStats(homeDir: string): AgentStat[] {
  const groups = new Map<
    string,
    {
      agent: string;
      role: string;
      turns: number;
      success: number;
      durations: number[];
      tokens: number;
    }
  >();
  for (const session of readSessionsFile(homeDir)) {
    const history = session.history ?? [];
    const key = `${session.agent}\u0000${session.role}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        agent: session.agent,
        role: session.role,
        turns: 0,
        success: 0,
        durations: [],
        tokens: 0,
      };
      groups.set(key, group);
    }
    for (const entry of history) {
      group.turns++;
      if (entry.status === "success") group.success++;
      if (typeof entry.evidence?.durationMs === "number")
        group.durations.push(entry.evidence.durationMs);
      group.tokens += entry.usage?.totalTokens ?? 0;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      agent: g.agent,
      role: g.role,
      turns: g.turns,
      successCount: g.success,
      failedCount: g.turns - g.success,
      successRate: g.turns === 0 ? 0 : g.success / g.turns,
      avgDurationMs:
        g.durations.length === 0
          ? null
          : Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length),
      totalTokens: g.tokens,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.role.localeCompare(b.role));
}

// ---------------------------------------------------------------------------
// File access (security-validated by the API layer)
// ---------------------------------------------------------------------------

export interface FileContent {
  path: string;
  content: string;
}

/**
 * Reads a single file. Caller MUST validate the resolved path before calling.
 * Known limitation: a symlink inside homeDir pointing outside it would bypass
 * the traversal guard (path resolution does not follow-and-check links); the
 * agentmesh home only contains bridge-written regular files today, but any
 * future exposure to user-planted content must add realpath containment.
 */
export async function readFile(resolvedPath: string): Promise<FileContent> {
  const stat = await fsp.stat(resolvedPath).catch(() => undefined);
  if (!stat) throw new FileNotFoundError(resolvedPath);
  if (stat.isDirectory()) throw new NotAFileError(resolvedPath);
  const content = await fsp.readFile(resolvedPath, "utf-8");
  return { path: resolvedPath, content };
}

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export class TaskNotFoundError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`Background task '${taskId}' was not found.`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class FileNotFoundError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = "FileNotFoundError";
    this.filePath = filePath;
  }
}

export class NotAFileError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`Path is a directory, not a file: ${filePath}`);
    this.name = "NotAFileError";
    this.filePath = filePath;
  }
}
