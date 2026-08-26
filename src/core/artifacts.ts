import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveAgentMeshHome } from "./session.js";

/**
 * T2.2 artifact spill layer ([CC] utils/toolResultStorage.ts blueprint).
 *
 * Oversized normalized outputs are persisted verbatim to
 * `<agentmeshHome>/artifacts/<sessionId>/turn-<n>.txt` and surfaced to the
 * orchestrator as a bounded preview plus an absolute pointer, replacing lossy
 * hard truncation. This layer sits downstream of every transport channel; the
 * codex rollout salvage (core/codexRollout.ts) keeps its own recovery path.
 */

/** Char count above which a normalized output section spills to disk. */
export const ARTIFACT_SPILL_THRESHOLD_CHARS = 50_000;

/** Preview size for the reference message ([CC] PREVIEW_SIZE_BYTES). */
export const ARTIFACT_PREVIEW_BYTES = 2_000;

/** Raised when a requested artifact path segment could escape its directory. */
export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

/** Raised by the 'wx' create-only write when the target already exists. */
export class ArtifactExistsError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Artifact already exists and was not overwritten: ${path}`);
    this.name = "ArtifactExistsError";
    this.path = path;
  }
}

/**
 * Path-segment guard: session IDs and turn IDs become directory/file names, so
 * anything carrying separators, parent segments or NUL is rejected outright.
 */
function assertSafePathSegment(value: string, label: string): void {
  if (value.trim() === "") {
    throw new ArtifactPathError(`${label} must not be blank.`);
  }
  if (/[/\\]/.test(value) || value.includes("..") || value.includes("\0")) {
    throw new ArtifactPathError(
      `${label} contains path separators or traversal segments and was rejected: '${value}'.`,
    );
  }
}

export interface PersistedArtifact {
  /** Absolute path of the persisted artifact. */
  path: string;
  sha256: string;
  chars: number;
}

/**
 * Persists one artifact verbatim. The write uses flag 'wx' (create-only):
 * a concurrent duplicate write fails with ArtifactExistsError instead of
 * overwriting the first author's bytes.
 */
export async function persistArtifact(
  sessionId: string,
  turnId: string | number,
  content: string,
  options: { homeDir?: string } = {},
): Promise<PersistedArtifact> {
  assertSafePathSegment(sessionId, "sessionId");
  assertSafePathSegment(String(turnId), "turnId");
  const artifactsDir = path.join(options.homeDir ?? resolveAgentMeshHome(), "artifacts", sessionId);
  await fsp.mkdir(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `turn-${String(turnId)}.txt`);
  try {
    await fsp.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ArtifactExistsError(filePath);
    }
    throw err;
  }
  return {
    path: filePath,
    sha256: crypto.createHash("sha256").update(content, "utf-8").digest("hex"),
    chars: content.length,
  };
}

export interface ArtifactPreview {
  preview: string;
  truncated: boolean;
}

/**
 * Builds a bounded preview, preferring a cut at a newline boundary when one
 * falls in the back half of the budget so lines survive whole ([CC]
 * generatePreview).
 */
export function buildPreview(
  content: string,
  maxBytes: number = ARTIFACT_PREVIEW_BYTES,
): ArtifactPreview {
  if (content.length <= maxBytes) {
    return { preview: content, truncated: false };
  }
  const slice = content.slice(0, maxBytes);
  const lastNewline = slice.lastIndexOf("\n");
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), truncated: true };
}

export type ArtifactSpillSource = "finalAnswer" | "rawOutput";

export interface ArtifactSpillDecision {
  source: ArtifactSpillSource;
  content: string;
}

/**
 * Picks the normalized section that must spill. Strictly above the threshold
 * spills; exactly-at-threshold does not. The trimmed raw output is considered
 * only when it differs from the final answer already handled.
 */
export function selectArtifactSpill(
  finalAnswer: string | undefined,
  rawOutput: string | undefined,
): ArtifactSpillDecision | undefined {
  const answer = finalAnswer?.trim();
  if (answer && answer.length > ARTIFACT_SPILL_THRESHOLD_CHARS) {
    return { source: "finalAnswer", content: answer };
  }
  const output = rawOutput?.trim();
  if (output && output.length > ARTIFACT_SPILL_THRESHOLD_CHARS && output !== answer) {
    return { source: "rawOutput", content: output };
  }
  return undefined;
}
