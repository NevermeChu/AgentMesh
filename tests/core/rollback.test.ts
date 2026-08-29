import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureRepositoryState,
  captureRollbackAnchor,
  restoreRollbackAnchor,
} from "../../src/core/repository.js";

const tempRoots: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmesh-rollback-"));
  tempRoots.push(dir);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  const git = (args: string) =>
    execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
  git("init");
  git("config core.autocrlf false");
  git("-c user.name=t -c user.email=t@example.invalid add -A");
  git("-c user.name=t -c user.email=t@example.invalid commit -qm seed");
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("rollback anchor (T4b)", () => {
  it("captures an anchor with HEAD on a clean tree and restores via head reset", async () => {
    const dir = makeRepo();
    const seedFile = join(dir, "seed.txt");
    writeFileSync(seedFile, "original\n");
    // Commit so the anchor tree is clean: restore must fall back to HEAD reset.
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync("git -c user.name=t -c user.email=t@example.invalid commit -qm original", {
      cwd: dir,
      stdio: "ignore",
    });

    const before = await captureRepositoryState(dir);
    const anchor = await captureRollbackAnchor(dir, before);
    expect(anchor).toBeDefined();
    expect(anchor?.headSha).toBeTruthy();
    expect(anchor?.stashSha).toBeUndefined();

    // Worker destruction: overwrite the seed, stage one new file, leave another untracked.
    writeFileSync(seedFile, "destroyed\n");
    const stagedNew = join(dir, "staged-new.txt");
    writeFileSync(stagedNew, "staged after anchor\n");
    execSync("git add staged-new.txt", { cwd: dir, stdio: "ignore" });
    const untrackedNew = join(dir, "untracked-new.txt");
    writeFileSync(untrackedNew, "untracked after anchor\n");

    const outcome = await restoreRollbackAnchor(anchor!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome.restoredVia).toBe("head");
    expect(readFileSync(seedFile, "utf-8")).toBe("original\n");
    // Head-reset semantics: staged new files are discarded from disk...
    expect(existsSync(stagedNew)).toBe(false);
    // ...while untracked files survive and are reported as still-dirty.
    expect(readFileSync(untrackedNew, "utf-8")).toBe("untracked after anchor\n");
    expect(outcome.outcome.remainingChangedPaths).toContain("untracked-new.txt");
    expect(outcome.outcome.remainingChangedPaths).not.toContain("staged-new.txt");
  });

  it("captures a stash snapshot on a dirty tree and restores the dirty content via stash", async () => {
    const dir = makeRepo();
    const seedFile = join(dir, "seed.txt");
    writeFileSync(seedFile, "base\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });
    execSync("git -c user.name=t -c user.email=t@example.invalid commit -qm base", {
      cwd: dir,
      stdio: "ignore",
    });

    // Pre-existing dirty state at anchor time (the state we must be able to get back to).
    writeFileSync(seedFile, "pre-existing work\n");

    const before = await captureRepositoryState(dir);
    const anchor = await captureRollbackAnchor(dir, before);
    expect(anchor?.stashSha).toBeTruthy();

    // Worker destroys the pre-existing work.
    writeFileSync(seedFile, "destroyed\n");

    const outcome = await restoreRollbackAnchor(anchor!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome.restoredVia).toBe("stash");
    expect(readFileSync(seedFile, "utf-8")).toBe("pre-existing work\n");
    expect(outcome.outcome.preRollbackStashSha).toBeTruthy();
  });

  it("refuses to roll back when HEAD moved past the anchor", async () => {
    const dir = makeRepo();
    const before = await captureRepositoryState(dir);
    const anchor = await captureRollbackAnchor(dir, before);
    expect(anchor?.headSha).toBeTruthy();

    execSync(
      "git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m moved",
      { cwd: dir, stdio: "ignore" },
    );

    const outcome = await restoreRollbackAnchor(anchor!);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("HEAD moved");
  });

  it("returns undefined for a non-git directory and a defined anchor requires evidence", async () => {
    const plain = mkdtempSync(join(tmpdir(), "agentmesh-nogit-"));
    tempRoots.push(plain);
    mkdirSync(join(plain, "src"), { recursive: true });
    const before = await captureRepositoryState(plain);
    expect(before).toBeUndefined();
    expect(await captureRollbackAnchor(plain, before)).toBeUndefined();
    expect(await captureRollbackAnchor(plain, undefined)).toBeUndefined();
  });
});
