import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeCommand } from "../../src/core/executor.js";

describe.skipIf(process.platform === "win32")("core/executor posix group cleanup", () => {
  it("terminates vendor-forked background children via the process group", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-pgroup-"));
    const heartbeat = path.join(directory, "heartbeat.txt");
    // The shell forks a long-running Node child; only a process-group signal
    // reaches the forked child once the root shell has been terminated.
    const script = path.join(directory, "forky-agent.sh");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        `"${process.execPath}" -e "setInterval(() => require('node:fs').writeFileSync(process.env.AGENTMESH_HEARTBEAT_FILE, String(Date.now())), 100)" &`,
        "wait",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(script, 0o755);

    try {
      const result = await executeCommand(script, [], {
        timeoutMs: 500,
        env: { AGENTMESH_HEARTBEAT_FILE: heartbeat },
      });
      expect(result.timedOut).toBe(true);
      expect(result.cleanupMethod).toBe("signal");

      const before = await fs.readFile(heartbeat, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await fs.readFile(heartbeat, "utf8");
      expect(after).toBe(before);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
