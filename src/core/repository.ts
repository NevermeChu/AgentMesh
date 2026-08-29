import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeCommand } from "./executor.js";
import type { RepositoryStateEvidence } from "./types.js";

async function hashFile(filePath: string, hash: crypto.Hash): Promise<void> {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${await fs.promises.readlink(filePath)}`);
    return;
  }
  if (!stat.isFile()) {
    hash.update(`non-file:${stat.mode}`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

interface ChangedPathEntry {
  path: string;
  status: string;
}

/**
 * Per-path content fingerprints are kept only while the change set stays small
 * enough to fingerprint cheaply. Beyond the cap the evidence degrades to the
 * coarse changed-path list, keeping every capture bounded.
 */
const MAX_FINGERPRINTED_PATHS = 100;
/** Untracked files beyond this count contribute path+size only, not full content. */
const MAX_UNTRACKED_CONTENT_HASHES = 500;

function parsePorcelainEntries(output: string): ChangedPathEntry[] {
  const entries = output.split("\0").filter(Boolean);
  const changedPaths: ChangedPathEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    changedPaths.push({ path: entry.slice(3), status });
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      changedPaths.push({ path: entries[index + 1]!, status: `${status}:source` });
      index++;
    }
  }
  return changedPaths;
}

async function fingerprintChangedPath(
  root: string,
  entry: ChangedPathEntry,
): Promise<string | undefined> {
  const absolutePath = path.resolve(root, entry.path);
  const relation = path.relative(root, absolutePath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) return undefined;

  const hash = crypto.createHash("sha256");
  hash.update(`status\0${entry.status}\0path\0${entry.path}\0`);
  try {
    await hashFile(absolutePath, hash);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || "unknown";
    hash.update(`unreadable:${code}`);
  }
  return hash.digest("hex");
}

/** Captures a content-sensitive Git working-tree fingerprint for context handoffs. */
export async function captureRepositoryState(
  cwd: string,
): Promise<RepositoryStateEvidence | undefined> {
  try {
    const rootResult = await executeCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (rootResult.exitCode !== 0) return undefined;
    const root = rootResult.stdout.trim();
    if (!root) return undefined;

    const [headResult, statusResult, trackedDiffResult, stagedDiffResult, untrackedResult] =
      await Promise.all([
        executeCommand("git", ["rev-parse", "HEAD"], { cwd: root }),
        executeCommand("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], {
          cwd: root,
        }),
        executeCommand("git", ["diff", "--binary", "--no-ext-diff", "--"], { cwd: root }),
        executeCommand("git", ["diff", "--cached", "--binary", "--no-ext-diff", "--"], {
          cwd: root,
        }),
        executeCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
          cwd: root,
        }),
      ]);
    if (
      statusResult.exitCode !== 0 ||
      trackedDiffResult.exitCode !== 0 ||
      stagedDiffResult.exitCode !== 0 ||
      untrackedResult.exitCode !== 0
    ) {
      return undefined;
    }

    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : undefined;
    const changedEntries = parsePorcelainEntries(statusResult.stdout);
    const changedPaths = [...new Set(changedEntries.map((entry) => entry.path))].slice(0, 100);
    const fingerprintEntries =
      changedEntries.length <= MAX_FINGERPRINTED_PATHS ? changedEntries : undefined;
    const pathFingerprints: Record<string, string> = {};
    for (const entry of fingerprintEntries ?? []) {
      const fingerprint = await fingerprintChangedPath(root, entry);
      if (fingerprint) pathFingerprints[entry.path] = fingerprint;
    }
    const untrackedPaths = untrackedResult.stdout.split("\0").filter(Boolean).sort();
    const hash = crypto.createHash("sha256");
    hash.update(`head\0${head || "unborn"}\0status\0${statusResult.stdout}`);
    hash.update(`\0tracked\0${trackedDiffResult.stdout}\0staged\0${stagedDiffResult.stdout}`);

    for (const [index, relativePath] of untrackedPaths.entries()) {
      const absolutePath = path.resolve(root, relativePath);
      const relation = path.relative(root, absolutePath);
      if (relation.startsWith("..") || path.isAbsolute(relation)) continue;
      hash.update(`\0untracked\0${relativePath}\0`);
      if (index >= MAX_UNTRACKED_CONTENT_HASHES) {
        // Oversized untracked sets fall back to path+size so captures stay bounded.
        try {
          const stat = await fs.promises.lstat(absolutePath);
          hash.update(`stat\0${stat.size}\0`);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code || "unknown";
          hash.update(`unreadable:${code}`);
        }
        continue;
      }
      try {
        await hashFile(absolutePath, hash);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || "unknown";
        hash.update(`unreadable:${code}`);
      }
    }

    return {
      capturedAt: new Date().toISOString(),
      repositoryRoot: root,
      head,
      dirty: statusResult.stdout.length > 0,
      fingerprint: hash.digest("hex"),
      changedPaths,
      pathFingerprints: fingerprintEntries ? pathFingerprints : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Pre-worker working-tree snapshot used by rollback_task (T4b). */
export interface RollbackAnchor {
  repositoryRoot: string;
  /** HEAD at capture time; absent on an unborn branch. */
  headSha?: string;
  /**
   * Dangling stash commit capturing tracked modifications at capture time
   * (`git stash create` — does not touch the working tree or the index).
   * Absent when the tracked working tree was clean. Untracked files are NOT
   * covered and cannot be restored.
   */
  stashSha?: string;
  fingerprint?: string;
  capturedAt: string;
}

export interface RollbackRestoreOutcome {
  restoredVia: "stash" | "head";
  preRollbackStashSha?: string;
  fingerprintAfter?: string;
  /** Working-tree changes still present after the restore (e.g. files created after the anchor). */
  remainingChangedPaths: string[];
}

/**
 * Captures the pre-worker rollback anchor. Requires an existing git repository
 * (repositoryBefore evidence); callers treat undefined as "rollback unavailable".
 */
export async function captureRollbackAnchor(
  _cwd: string,
  repositoryBefore: RepositoryStateEvidence | undefined,
): Promise<RollbackAnchor | undefined> {
  if (!repositoryBefore?.repositoryRoot) return undefined;
  const root = repositoryBefore.repositoryRoot;
  const anchor: RollbackAnchor = {
    repositoryRoot: root,
    fingerprint: repositoryBefore.fingerprint,
    capturedAt: new Date().toISOString(),
  };
  const head = await executeCommand("git", ["rev-parse", "HEAD"], { cwd: root }).catch(
    () => undefined,
  );
  if (head && head.exitCode === 0 && head.stdout.trim()) {
    anchor.headSha = head.stdout.trim();
  }
  const stash = await executeCommand("git", ["stash", "create"], { cwd: root }).catch(
    () => undefined,
  );
  if (stash && stash.exitCode === 0 && stash.stdout.trim()) {
    anchor.stashSha = stash.stdout.trim();
  }
  return anchor;
}

function changedPathsNow(evidence: RepositoryStateEvidence | undefined): string[] {
  return evidence?.changedPaths?.length ? evidence.changedPaths : [];
}

/**
 * Restores the tracked working tree to a previously captured anchor. The
 * current state is stashed first (pre-rollback snapshot) so a mistaken
 * rollback is itself recoverable. Semantics differ by path and are disclosed
 * to the caller: the stash path (checkout <stash> -- .) restores anchor-known
 * paths and leaves later-created files alone; the head path (reset --hard)
 * discards ALL tracked changes since the anchor, including staged new files.
 * Untracked files present at anchor time were never captured and cannot be
 * restored. remainingChangedPaths reports whatever is still dirty afterwards.
 */
export async function restoreRollbackAnchor(
  anchor: RollbackAnchor,
  cwd?: string,
): Promise<{ ok: true; outcome: RollbackRestoreOutcome } | { ok: false; error: string }> {
  const root = anchor.repositoryRoot;
  const run = (args: string[]) => executeCommand("git", args, { cwd: cwd ?? root });

  const preStash = await run(["stash", "create"]).catch(() => undefined);
  const preRollbackStashSha =
    preStash && preStash.exitCode === 0 && preStash.stdout.trim()
      ? preStash.stdout.trim()
      : undefined;

  // If HEAD moved since the anchor, another actor is reshaping history; refuse
  // rather than fight over it.
  const head = await run(["rev-parse", "HEAD"]).catch(() => undefined);
  if (anchor.headSha && head && head.exitCode === 0 && head.stdout.trim() !== anchor.headSha) {
    return {
      ok: false,
      error: `HEAD moved since the anchor was captured (${anchor.headSha.slice(0, 12)} -> ${head.stdout.trim().slice(0, 12)}); refusing to roll back over another actor's commits.`,
    };
  }

  let restoredVia: RollbackRestoreOutcome["restoredVia"];
  if (anchor.stashSha) {
    const checkout = await run(["checkout", anchor.stashSha, "--", "."]).catch(() => undefined);
    if (!checkout || checkout.exitCode !== 0) {
      return {
        ok: false,
        error: `Failed to restore tracked files from anchor stash ${anchor.stashSha.slice(0, 12)}: ${checkout?.stderr?.trim() || "git checkout failed"}`,
      };
    }
    restoredVia = "stash";
  } else if (anchor.headSha) {
    // The anchor tracked tree was clean: discard every tracked change since.
    const reset = await run(["reset", "--hard", anchor.headSha]).catch(() => undefined);
    if (!reset || reset.exitCode !== 0) {
      return {
        ok: false,
        error: `Failed to reset tracked files to anchor HEAD ${anchor.headSha.slice(0, 12)}: ${reset?.stderr?.trim() || "git reset failed"}`,
      };
    }
    restoredVia = "head";
  } else {
    return { ok: false, error: "Anchor has neither stash nor HEAD reference; cannot restore." };
  }

  const after = await captureRepositoryState(root);
  return {
    ok: true,
    outcome: {
      restoredVia,
      preRollbackStashSha,
      fingerprintAfter: after?.fingerprint,
      remainingChangedPaths: changedPathsNow(after),
    },
  };
}
