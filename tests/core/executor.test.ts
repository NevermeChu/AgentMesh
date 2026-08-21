import { describe, it, expect } from "vitest";
import {
  executeCommand,
  findExecutableOnPath,
  isCommandAvailable,
  escapeCmdArg,
  buildCmdCommandLine,
} from "../../src/core/executor.js";

describe("core/executor", () => {
  it("should find node on system PATH", async () => {
    const nodePath = await findExecutableOnPath("node");
    expect(nodePath).toBeDefined();
    expect(typeof nodePath).toBe("string");
  });

  it("should find executable when path contains separators without extension on Windows", async () => {
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

  it("should return null for empty or non-existent paths", async () => {
    expect(await findExecutableOnPath("")).toBeNull();
    expect(await findExecutableOnPath("   ")).toBeNull();
    expect(await findExecutableOnPath("D:/non_existent_dir_123/fake_bin_999")).toBeNull();
    expect(await findExecutableOnPath("./non_existent_relative_bin_999")).toBeNull();
  });

  it("should check command availability correctly", async () => {
    const isNodeAvail = await isCommandAvailable("node");
    expect(isNodeAvail).toBe(true);

    const isFakeAvail = await isCommandAvailable("non_existent_binary_xyz_123");
    expect(isFakeAvail).toBe(false);
  });

  it("should execute node command and capture stdout", async () => {
    const res = await executeCommand("node", ["-e", "console.log('hello from test')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello from test");
    expect(res.timedOut).toBe(false);
  });

  it("should capture non-zero exit code and stderr", async () => {
    const res = await executeCommand("node", [
      "-e",
      "console.error('error message'); process.exit(42)",
    ]);
    expect(res.exitCode).toBe(42);
    expect(res.stderr).toContain("error message");
  });

  it("should handle command timeout gracefully", async () => {
    const res = await executeCommand(
      "node",
      ["-e", "setTimeout(() => process.stdout.write('done'), 5000)"],
      { timeoutMs: 300 }
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.durationMs).toBeLessThan(4_000);
  });

  it("should escape special characters in cmd.exe arguments", () => {
    expect(escapeCmdArg("hello")).toBe('"hello"');
    expect(escapeCmdArg("")).toBe('""');
    expect(escapeCmdArg('say "hello"')).toBe('"say \\"hello\\""');
    expect(escapeCmdArg("auth & token")).toBe('"auth & token"');

    const cmdLine = buildCmdCommandLine("C:/path with spaces/bin.cmd", ["arg 1", "auth & token"]);
    expect(cmdLine).toContain('"C:/path with spaces/bin.cmd"');
    expect(cmdLine).toContain('"auth & token"');
  });

  it("should execute command with & and special characters without splitting arguments", async () => {
    const res = await executeCommand("node", [
      "-e",
      "console.log(process.argv[1])",
      "Review auth & token logic <nested>",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("Review auth & token logic <nested>");
  });
});
