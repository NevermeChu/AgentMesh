import * as nodePath from "node:path";
import { z } from "zod";
import {
  getSummary,
  getStats,
  getSession,
  listSessions,
  listTasks,
  taskExists,
  readTaskOutput,
  readFile,
  buildTimeline,
  FileNotFoundError,
  NotAFileError,
  TaskNotFoundError,
} from "./data.js";

// ---------------------------------------------------------------------------
// Public response contract consumed by the frontend B-worker.
// ---------------------------------------------------------------------------

export interface UiApiResponse {
  status: number;
  contentType: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Zod schemas for query parameters.
// ---------------------------------------------------------------------------

const NonNegativeInt = z.coerce.number().int().min(0).default(0);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function json(status: number, data: unknown): UiApiResponse {
  return { status, contentType: "application/json", body: JSON.stringify(data) };
}

function methodNotAllowed(): UiApiResponse {
  return json(405, { error: "Method Not Allowed" });
}

// ---------------------------------------------------------------------------
// Route handler
//
// Returns `null` when the pathname is not an API route so the server layer
// can fall through to its own handling.
// ---------------------------------------------------------------------------

export async function handleUiApiRequest(opts: {
  method: string;
  pathname: string;
  query: URLSearchParams;
  homeDir: string;
  startDir?: string;
}): Promise<UiApiResponse | null> {
  const { method, pathname, query, homeDir, startDir } = opts;

  // Only GET is permitted for all read-only endpoints.
  if (method !== "GET") {
    // Return 405 for known API routes even on wrong method.
    if (pathname.startsWith("/api/")) return methodNotAllowed();
    return null;
  }

  // -----------------------------------------------------------------------
  // /api/summary
  // -----------------------------------------------------------------------
  if (pathname === "/api/summary") {
    const data = await getSummary(homeDir, startDir);
    return json(200, data);
  }

  // -----------------------------------------------------------------------
  // /api/sessions — list
  // -----------------------------------------------------------------------
  if (pathname === "/api/sessions") {
    const sessions = listSessions(homeDir);
    return json(200, { sessions });
  }

  // -----------------------------------------------------------------------
  // /api/sessions/{id} — detail
  // -----------------------------------------------------------------------
  const sessionMatch = pathname.match(/^\/api\/sessions\/(.+)$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]!);
    const session = getSession(homeDir, id);
    if (!session) return json(404, { error: "Session not found" });
    return json(200, { ...session, timeline: buildTimeline(session) });
  }

  // -----------------------------------------------------------------------
  // /api/tasks — list
  // -----------------------------------------------------------------------
  if (pathname === "/api/tasks") {
    const tasks = await listTasks(homeDir);
    return json(200, { tasks });
  }

  // -----------------------------------------------------------------------
  // /api/tasks/{taskId}/output — incremental read
  // -----------------------------------------------------------------------
  const outputMatch = pathname.match(/^\/api\/tasks\/(.+)\/output$/);
  if (outputMatch) {
    const taskId = decodeURIComponent(outputMatch[1]!);
    const parsed = NonNegativeInt.safeParse(query.get("offset"));
    if (!parsed.success) {
      return json(400, { error: "Invalid offset parameter" });
    }
    const offset = parsed.data;
    try {
      const data = await readTaskOutput(homeDir, taskId, offset);
      return json(200, data);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return json(404, { error: `Task '${taskId}' not found` });
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // /api/tasks/{taskId} — detail (convenience: returns task + result)
  // -----------------------------------------------------------------------
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]!);
    if (!taskExists(homeDir, taskId)) {
      return json(404, { error: `Task '${taskId}' not found` });
    }
    const tasks = await listTasks(homeDir);
    const task = tasks.find((t) => t.taskId === taskId);
    return json(200, task ?? { taskId, status: "unknown" });
  }

  // -----------------------------------------------------------------------
  // /api/file — artifact / sidecar full-text view with path-traversal guard
  // -----------------------------------------------------------------------
  if (pathname === "/api/file") {
    const rawPath = query.get("path");
    // Zod non-empty string validation.
    const parsed = z.string().min(1).safeParse(rawPath);
    if (!parsed.success) {
      return json(400, { error: "Missing or empty path parameter" });
    }
    const relPath = parsed.data;

    // Reject absolute paths to prevent traversal.
    if (nodePath.isAbsolute(relPath)) {
      return json(403, { error: "FORBIDDEN" });
    }

    const resolved = nodePath.resolve(homeDir, relPath);
    // Ensure the resolved path stays inside homeDir — the core defense
    // against directory-traversal attacks (../../secret.txt etc.).
    const relative = nodePath.relative(homeDir, resolved);
    if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
      return json(403, { error: "FORBIDDEN" });
    }

    try {
      const file = await readFile(resolved);
      return json(200, { path: relPath, content: file.content });
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        return json(404, { error: "File not found" });
      }
      if (err instanceof NotAFileError) {
        return json(400, { error: "Path is a directory, not a file" });
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // /api/stats — agent x role aggregation
  // -----------------------------------------------------------------------
  if (pathname === "/api/stats") {
    return json(200, { stats: getStats(homeDir) });
  }

  // Not an API route — let the server layer handle it.
  return null;
}
