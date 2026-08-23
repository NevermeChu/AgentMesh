import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRepositoryState } from "../../src/core/repository.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd });
}

describe("core/repository evidence", () => {
  let repositoryRoot: string;

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-repo-test-"));
    git(repositoryRoot, "init", "--quiet");
    git(repositoryRoot, "config", "user.email", "test@example.com");
    git(repositoryRoot, "config", "user.name", "AgentMesh Test");
    fs.writeFileSync(path.join(repositoryRoot, "base.txt"), "base\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "--quiet", "-m", "init");
  });

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it("fingerprints individual changed paths and stays deterministic", async () => {
    fs.writeFileSync(path.join(repositoryRoot, "base.txt"), "changed\n");

    const first = await captureRepositoryState(repositoryRoot);
    const second = await captureRepositoryState(repositoryRoot);

    expect(first?.dirty).toBe(true);
    expect(Object.keys(first?.pathFingerprints ?? {})).toContain("base.txt");
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });

  it("degrades to coarse evidence beyond the changed-path cap", async () => {
    for (let index = 0; index < 101; index += 1) {
      fs.writeFileSync(path.join(repositoryRoot, `f${index}.txt`), `content ${index}\n`);
    }

    const state = await captureRepositoryState(repositoryRoot);

    expect(state?.changedPaths).toHaveLength(100);
    expect(state?.pathFingerprints).toBeUndefined();
  });

  it("keeps untracked fingerprints deterministic beyond the content-hash cap", async () => {
    for (let index = 0; index < 505; index += 1) {
      fs.writeFileSync(path.join(repositoryRoot, `u${index}.txt`), "x");
    }

    const first = await captureRepositoryState(repositoryRoot);
    const second = await captureRepositoryState(repositoryRoot);
    expect(second?.fingerprint).toBe(first?.fingerprint);

    fs.writeFileSync(path.join(repositoryRoot, "u0.txt"), "changed");
    const third = await captureRepositoryState(repositoryRoot);
    expect(third?.fingerprint).not.toBe(first?.fingerprint);
  });

  it("returns undefined outside a git repository", async () => {
    const plainDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-plain-"));
    try {
      expect(await captureRepositoryState(plainDirectory)).toBeUndefined();
    } finally {
      fs.rmSync(plainDirectory, { recursive: true, force: true });
    }
  });
});
