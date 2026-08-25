import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  executeCommand,
  findExecutableOnPath,
  escapeCmdArg,
  buildCmdCommandLine,
  resolveCommandInvocation,
  buildChildEnvironment,
} from "../../src/core/executor.js";

describe("core/executor", () => {
  it("finds an executable on PATH", async () => {
    const nodePath = await findExecutableOnPath("node");
    expect(nodePath).toBeDefined();
    expect(typeof nodePath).toBe("string");
  });

  it("resolves quoted and extensionless executable paths", async () => {
    const execPath = process.execPath; // e.g. D:\path\node.exe
    const withoutExt = execPath.replace(/\.(exe|cmd|bat)$/i, "");
    const found = await findExecutableOnPath(withoutExt);
    expect(found).toBeDefined();
    expect(typeof found).toBe("string");

    // Forward slash path
    const forwardSlash = withoutExt.replace(/\\/g, "/");
    const foundForward = await findExecutableOnPath(forwardSlash);
    expect(foundForward).toBeDefined();

    // Quoted path
    const quoted = `"${withoutExt}"`;
    const foundQuoted = await findExecutableOnPath(quoted);
    expect(foundQuoted).toBeDefined();
  });

  it("returns null for empty or missing paths", async () => {
    expect(await findExecutableOnPath("")).toBeNull();
    expect(await findExecutableOnPath("   ")).toBeNull();
    expect(await findExecutableOnPath("D:/non_existent_dir_123/fake_bin_999")).toBeNull();
    expect(await findExecutableOnPath("./non_existent_relative_bin_999")).toBeNull();
  });

  it("captures successful process output", async () => {
    const res = await executeCommand("node", ["-e", "console.log('hello from test')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello from test");
    expect(res.timedOut).toBe(false);
    expect(res.resourceEvidence?.collection).toBe("process");
    expect(res.resourceEvidence?.peakRssBytes).toBeGreaterThan(0);
    expect(res.resourceEvidence?.limitations).toContain("vendor child-process");
  });

  it("preserves UTF-8 characters split across process chunks", async () => {
    const res = await executeCommand("node", [
      "-e",
      "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad])), 20)",
    ]);
    expect(res.stdout).toBe("中");
  });

  it("captures non-zero exit code and stderr", async () => {
    const res = await executeCommand("node", [
      "-e",
      "console.error('error message'); process.exit(42)",
    ]);
    expect(res.exitCode).toBe(42);
    expect(res.stderr).toContain("error message");
  });

  it("bounds a timed-out process", async () => {
    const res = await executeCommand(
      "node",
      ["-e", "setTimeout(() => process.stdout.write('done'), 5000)"],
      { timeoutMs: 300 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.durationMs).toBeLessThan(4_000);
    expect(res.cleanupMethod).toBeDefined();
    expect(res.cleanupSucceeded).toBe(true);
    expect(res.resourceEvidence?.collection).toBe("process");
  });

  it("quotes cmd.exe arguments containing spaces and metacharacters", () => {
    expect(escapeCmdArg("hello")).toBe('"hello"');
    expect(escapeCmdArg("")).toBe('""');
    expect(escapeCmdArg('say "hello"')).toBe('"say \\"hello\\""');
    expect(escapeCmdArg("auth & token")).toBe('"auth & token"');

    const cmdLine = buildCmdCommandLine("C:/path with spaces/bin.cmd", ["arg 1", "auth & token"]);
    expect(cmdLine).toContain('"C:/path with spaces/bin.cmd"');
    expect(cmdLine).toContain('"auth & token"');
  });

  it.runIf(process.platform === "win32")(
    "unwraps npm-style command shims without cmd.exe parsing",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-cmd-shim-"));
      try {
        const entry = path.join(directory, "cli.mjs");
        const shim = path.join(directory, "cli.cmd");
        await fs.writeFile(entry, "", "utf8");
        await fs.writeFile(shim, '@ECHO off\nnode "%~dp0\\cli.mjs" %*\n', "utf8");
        const args = ['line one\nline two "quoted" & literal | pipe %value%!'];

        const invocation = await resolveCommandInvocation(shim, args);

        expect(invocation.command).toBe(process.execPath);
        expect(invocation.args).toEqual([entry, ...args]);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "unwraps npm shims that point to packaged native executables",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-native-shim-"));
      try {
        const entry = path.join(directory, "agent.exe");
        const shim = path.join(directory, "agent.cmd");
        await fs.writeFile(entry, "", "utf8");
        await fs.writeFile(shim, '@ECHO off\n"%~dp0\\agent.exe" %*\n', "utf8");
        const args = ["review", "line one\nline two & literal"];

        await expect(resolveCommandInvocation(shim, args)).resolves.toEqual({
          command: entry,
          args,
        });
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects arbitrary batch files instead of interpolating untrusted arguments",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-batch-reject-"));
      try {
        const batch = path.join(directory, "unsafe.cmd");
        await fs.writeFile(batch, "@echo %*\n", "utf8");
        await expect(resolveCommandInvocation(batch, ["safe & whoami"])).rejects.toThrow(
          "not a recognized Node.js CLI shim",
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("drops shell-injected PWD so child CLIs cannot resolve the wrong project", () => {
    const previousPwd = process.env.PWD;
    const previousOldPwd = process.env.OLDPWD;
    const spawnCwd = path.resolve(os.tmpdir(), "agentmesh-target-project");
    try {
      process.env.PWD = "D:\\launcher\\directory";
      process.env.OLDPWD = "D:\\launcher\\previous";
      const env = buildChildEnvironment(spawnCwd, { TASK_MARKER: "1" });

      expect(env.TASK_MARKER).toBe("1");
      if (process.platform === "win32") {
        expect(env.PWD).toBeUndefined();
        expect(env.OLDPWD).toBeUndefined();
      } else {
        expect(env.PWD).toBe(spawnCwd);
      }
    } finally {
      if (previousPwd === undefined) delete process.env.PWD;
      else process.env.PWD = previousPwd;
      if (previousOldPwd === undefined) delete process.env.OLDPWD;
      else process.env.OLDPWD = previousOldPwd;
    }
  });

  it("terminates the process tree and resolves when the abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await executeCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 30000)"],
      { timeoutMs: 30_000, signal: controller.signal },
    );

    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("survives a child that exits before draining stdin (EPIPE regression)", async () => {
    // Without an error listener on the child's stdin stream, the async EPIPE
    // event would crash the AgentMesh process with an unhandled error.
    const result = await executeCommand(process.execPath, ["-e", "process.exit(0)"], {
      input: "payload that will never be read\n".repeat(2_000),
    });

    expect(result.exitCode).toBe(0);
  });
});
