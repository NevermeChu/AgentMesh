import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { handleUiApiRequest } from "./api.js";
import { resolveAgentMeshHome } from "../core/session.js";

/**
 * HTTP glue for the `agentmesh ui` command: a local, read-only visualization
 * server. The data layer is exercised through handleUiApiRequest so the API
 * surface stays identical between tests and the live server; this file only
 * owns transport concerns (binding, routing, static panel serving).
 *
 * Security posture: bind 127.0.0.1 only, GET-only endpoints, and the data
 * layer performs no writes anywhere — the panel is a pure observation surface.
 */

/** How many consecutive ports to try (+1 each) before giving up. */
const MAX_PORT_PROBES = 10;

/** Resolves panel.html next to the compiled module (dist/ui) with a src fallback for dev runs. */
function resolvePanelHtmlPath(): string {
  // CJS output leaves import.meta empty (tsup warning): degrade to a
  // repo-root-relative guess instead of crashing on undefined.
  const moduleDir = import.meta.dirname ?? "";
  const candidates = moduleDir
    ? [
        path.join(moduleDir, "panel.html"),
        // Running from src (tsx/vitest) lands this file two levels below the repo root.
        path.join(moduleDir, "..", "..", "src", "ui", "panel.html"),
      ]
    : [path.join("dist", "ui", "panel.html"), path.join("src", "ui", "panel.html")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface UiServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface UiServerOptions {
  /** Preferred port; occupied ports are probed upward (+1) up to MAX_PORT_PROBES. */
  port?: number;
  /** AgentMesh home to read data from; defaults to resolveAgentMeshHome(). */
  homeDir?: string;
  /** Directory used to locate the project .agentmesh/config.json (budget display). */
  startDir?: string;
}

/**
 * Starts the read-only UI server. Resolves once the server is listening, with
 * the actual bound port (which may differ from the requested one when the
 * default was occupied).
 */
export function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const homeDir = options.homeDir ?? resolveAgentMeshHome();
  const startDir = options.startDir ?? process.cwd();
  const panelPath = resolvePanelHtmlPath();
  const panelCache = new Map<string, { contentType: string; body: Buffer; mtimeMs: number }>();

  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    const send = (status: number, contentType: string, body: string | Buffer): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", contentType);
      res.end(body);
    };

    const isApiRoute = url.pathname.startsWith("/api/");
    if (!isApiRoute && method !== "GET") {
      send(405, "application/json", JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    handleUiApiRequest({
      method,
      pathname: url.pathname,
      query: url.searchParams,
      homeDir,
      startDir,
    })
      .then((apiResult) => {
        if (apiResult) {
          send(apiResult.status, apiResult.contentType, apiResult.body);
          return;
        }
        if (method !== "GET") {
          send(404, "application/json", JSON.stringify({ error: "Not Found" }));
          return;
        }
        // Only the panel itself is served as a static asset; it is a single
        // self-contained file, so no directory serving is ever exposed.
        if (url.pathname === "/" || url.pathname === "/index.html") {
          // mtime-aware cache (r17 问题 2): dev edits to panel.html show up on
          // the next refresh without restarting the ui process.
          const mtime = fs.statSync(panelPath).mtimeMs;
          let cached = panelCache.get(panelPath);
          if (!cached || cached.mtimeMs !== mtime) {
            cached = {
              contentType: MIME_TYPES[".html"]!,
              body: fs.readFileSync(panelPath),
              mtimeMs: mtime,
            };
            panelCache.set(panelPath, cached);
          }
          send(200, cached.contentType, cached.body);
          return;
        }
        send(404, "application/json", JSON.stringify({ error: "Not Found" }));
      })
      .catch((err: unknown) => {
        send(
          500,
          "application/json",
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        );
      });
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(requestListener);
    const requestedPort = options.port ?? 7788;
    let attempt = 0;

    const tryListen = (port: number): void => {
      // The single error handler lives here: EADDRINUSE advances the probe,
      // everything else rejects. (r17 问题 3: a persistent on("error", reject)
      // registered alongside this handler rejected the promise on the first
      // EADDRINUSE before the retry could fire.)
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_PROBES) {
          attempt++;
          tryListen(port + 1);
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        // Remove the probe error handler so a later runtime error surfaces
        // through the default path instead of triggering another probe.
        server.removeAllListeners("error");
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
        });
      });
    };
    tryListen(requestedPort);
  });
}
