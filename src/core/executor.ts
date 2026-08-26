import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { buildPolicyChildEnvironment } from "./envPolicy.js";

export interface ExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  shell?: boolean;
  /** Aborts the run: the process tree is terminated and the result resolves with `aborted: true`. */
  signal?: AbortSignal;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  /** `undefined` when the exit code could not be observed (e.g. hard settle). */
  exitCode?: number;
  durationMs: number;
  timedOut: boolean;
  aborted?: boolean;
  cleanupMethod?: "taskkill-tree" | "signal" | "unknown";
  cleanupSucceeded?: boolean;
  resourceEvidence?: {
    collection: "process";
    cpuUserMs: number;
    cpuSystemMs: number;
    peakRssBytes: number;
    limitations: string;
  };
}

export interface CommandInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export class ProcessExecutionError extends Error {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted?: boolean;
  readonly cleanupMethod?: "taskkill-tree" | "signal" | "unknown";
  readonly cleanupSucceeded?: boolean;
  readonly resourceEvidence?: ExecutionResult["resourceEvidence"];

  constructor(
    message: string,
    options: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
      aborted?: boolean;
      cleanupMethod?: ExecutionResult["cleanupMethod"];
      cleanupSucceeded?: boolean;
      resourceEvidence?: ExecutionResult["resourceEvidence"];
    },
  ) {
    super(message);
    this.name = "ProcessExecutionError";
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.timedOut = options.timedOut ?? false;
    this.aborted = options.aborted;
    this.cleanupMethod = options.cleanupMethod;
    this.cleanupSucceeded = options.cleanupSucceeded;
    this.resourceEvidence = options.resourceEvidence;
  }
}

/**
 * Searches system PATH or explicit path for an executable, accounting for Windows extensions (.exe, .cmd, .bat, etc.)
 * and handling relative/absolute paths without extensions.
 */
export async function findExecutableOnPath(cmdName: string): Promise<string | null> {
  if (!cmdName || !cmdName.trim()) {
    return null;
  }

  const isWindows = process.platform === "win32";
  // Strip surrounding double/single quotes if present in env vars
  const cleanCmd = cmdName.trim().replace(/^["']|["']$/g, "");
  if (!cleanCmd) return null;

  const extensions = isWindows
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM;.PS1")
        .toLowerCase()
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""];

  // Helper to check if a specific target path is an existing file
  const checkFile = (filePath: string): string | null => {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          return path.resolve(filePath);
        }
      }
    } catch {
      // ignore permissions or access errors
    }
    return null;
  };

  // If command contains path separators, treat as direct/relative path
  if (cleanCmd.includes("/") || cleanCmd.includes("\\")) {
    // 1. Check exact path first
    const directHit = checkFile(cleanCmd);
    if (directHit) return directHit;

    // 2. On Windows, check with PATHEXT extensions
    if (isWindows) {
      const lower = cleanCmd.toLowerCase();
      for (const ext of extensions) {
        if (!lower.endsWith(ext)) {
          const hitWithExt = checkFile(`${cleanCmd}${ext}`);
          if (hitWithExt) return hitWithExt;
        }
      }
    }

    return null;
  }

  // Otherwise, search directories in system PATH
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);

  const candidates: string[] = [];
  if (!isWindows) {
    candidates.push(cleanCmd);
  } else {
    for (const ext of extensions) {
      if (!cleanCmd.toLowerCase().endsWith(ext)) {
        candidates.push(`${cleanCmd}${ext}`);
      }
    }
    candidates.push(cleanCmd);
  }

  for (const dir of pathDirs) {
    if (!dir || !dir.trim()) continue;
    const cleanDir = dir.trim().replace(/^["']|["']$/g, "");
    for (const cand of candidates) {
      const fullPath = path.join(cleanDir, cand);
      const hit = checkFile(fullPath);
      if (hit) return hit;
    }
  }

  return null;
}

export async function isCommandAvailable(cmdName: string): Promise<boolean> {
  const found = await findExecutableOnPath(cmdName);
  return found !== null;
}

/**
 * Escapes an argument for Windows cmd.exe command line invocation.
 */
export function escapeCmdArg(arg: string): string {
  if (!arg) return '""';
  const escaped = arg.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Builds a single wrapped command line string for `cmd.exe /d /s /c`.
 */
export function buildCmdCommandLine(command: string, args: string[]): string {
  const escapedCmd = `"${command.replace(/"/g, '\\"')}"`;
  const escapedArgs = args.map(escapeCmdArg).join(" ");
  return escapedArgs.length > 0 ? `"${escapedCmd} ${escapedArgs}"` : `"${escapedCmd}"`;
}

/**
 * Resolves a command into a shell-free process invocation.
 *
 * npm-generated Windows shims are unwrapped to their JavaScript entry point so
 * prompts never pass through cmd.exe parsing. Arbitrary batch files are rejected
 * because cmd.exe cannot preserve untrusted multiline arguments safely.
 */
export async function resolveCommandInvocation(
  command: string,
  args: string[],
): Promise<CommandInvocation> {
  const resolvedCommand = (await findExecutableOnPath(command)) || command;
  if (process.platform !== "win32") {
    return { command: resolvedCommand, args };
  }

  const lowerCommand = resolvedCommand.toLowerCase();
  if (lowerCommand.endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...args],
    };
  }

  if (!lowerCommand.endsWith(".cmd") && !lowerCommand.endsWith(".bat")) {
    return { command: resolvedCommand, args };
  }

  let shimContents: string;
  try {
    shimContents = fs.readFileSync(resolvedCommand, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Windows command shim '${resolvedCommand}'.`, { cause: error });
  }

  const entryPattern = /(?:%~dp0|%dp0%)[\\/]([^"\r\n]+?\.(?:exe|com|(?:c|m)?js))["']?/gi;
  const candidates = Array.from(shimContents.matchAll(entryPattern));
  for (const match of candidates.reverse()) {
    const relativeEntry = match[1];
    if (!relativeEntry) continue;
    const entryPath = path.resolve(path.dirname(resolvedCommand), relativeEntry);
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) continue;
    if (/\.(?:exe|com)$/i.test(entryPath)) {
      return { command: entryPath, args };
    }
    const adjacentNode = path.join(path.dirname(resolvedCommand), "node.exe");
    const nodeCommand = fs.existsSync(adjacentNode) ? adjacentNode : process.execPath;
    return { command: nodeCommand, args: [entryPath, ...args] };
  }

  throw new Error(
    `Windows batch command '${resolvedCommand}' is not a recognized Node.js CLI shim. ` +
      "Use a native executable, PowerShell script, or npm-generated .cmd shim to preserve arguments safely.",
  );
}

/** Exit-code contributions of the signals we may deliver, following the 128+signum convention. */
const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Builds the child environment from the parent process plus task-scoped overrides.
 *
 * Since P3/T3.3 the construction is policy-driven (see core/envPolicy.ts):
 * permanently blacklisted variables are stripped from the parent snapshot and
 * caller overrides are accepted only when whitelisted — rejected keys are
 * reported by `buildPolicyChildEnvironment` so callers can surface an
 * `envOverrideRejected:[...]` warning. Execution-critical baseline keys such as
 * PATH are inherited exclusively from the AgentMesh process and can never be
 * swapped through overrides.
 *
 * Shell-injected `PWD`/`OLDPWD` describe the launcher's directory, not the
 * spawned working directory; vendor CLIs may trust `PWD` over `process.cwd()`
 * and would then operate on the wrong repository. They are removed on Windows
 * (where they are not native) and aligned with the spawn cwd elsewhere.
 */
export function buildChildEnvironment(
  cwd: string | undefined,
  overrides?: Record<string, string>,
): Record<string, string> {
  return buildPolicyChildEnvironment(cwd, overrides, process.env).env;
}

/**
 * Executes a command with cross-platform support and timeout safety.
 */
export async function executeCommand(
  command: string,
  args: string[],
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const isWindows = process.platform === "win32";

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const timeoutMs = options.timeoutMs ?? 0;

  let actualCmd = command;
  let actualArgs = args;
  const useShell = options.shell ?? false;
  let windowsVerbatim = false;

  if (useShell) {
    actualCmd = (await findExecutableOnPath(command)) || command;
  } else {
    // Both an omitted and an explicit `shell: false` must resolve Windows shims
    // identically; spawning a .cmd raw would fail with EINVAL on Node >= 22.
    const invocation = await resolveCommandInvocation(command, args);
    actualCmd = invocation.command;
    actualArgs = invocation.args;
    windowsVerbatim = invocation.windowsVerbatimArguments ?? false;
  }

  const spawnOptions: SpawnOptions = {
    cwd,
    env: buildChildEnvironment(cwd, options.env),
    shell: useShell,
    windowsVerbatimArguments: windowsVerbatim,
    stdio: ["pipe", "pipe", "pipe"],
    // On POSIX a detached child gets its own process group so the whole vendor
    // tree can be signalled via `-pid`; Windows uses taskkill /T instead.
    detached: !isWindows && !useShell,
  };

  return new Promise<ExecutionResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const readStdout = () => Buffer.concat(stdoutChunks).toString("utf8");
    const readStderr = () => Buffer.concat(stderrChunks).toString("utf8");
    let isSettled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let hardSettleTimer: NodeJS.Timeout | null = null;
    let cleanupMethod: ExecutionResult["cleanupMethod"];
    let cleanupSucceeded: boolean | undefined;
    const initialCpu = process.cpuUsage();
    const initialRss = process.memoryUsage().rss;
    let peakRssBytes = initialRss;

    const resourceEvidence = (): ExecutionResult["resourceEvidence"] => {
      const cpu = process.cpuUsage(initialCpu);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      return {
        collection: "process",
        cpuUserMs: Math.round(cpu.user / 1_000),
        cpuSystemMs: Math.round(cpu.system / 1_000),
        peakRssBytes,
        limitations:
          "Measures the AgentMesh process only; vendor child-process and process-tree resources require external monitoring.",
      };
    };

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
    };
    let pendingTermination: Promise<void> | null = null;
    const terminateProcessTree = (): Promise<void> => {
      if (!pendingTermination) {
        pendingTermination = (async () => {
          if (cleanupSucceeded !== undefined) return;
          cleanupMethod = isWindows && childProcess.pid ? "taskkill-tree" : "signal";
          if (isWindows && childProcess.pid) {
            cleanupSucceeded = await new Promise<boolean>((resolveKill) => {
              let settled = false;
              const kill = spawn("taskkill", ["/pid", childProcess.pid!.toString(), "/T", "/F"], {
                shell: false,
                stdio: "ignore",
              });
              const finish = (success: boolean) => {
                if (settled) return;
                settled = true;
                resolveKill(success);
              };
              kill.once("error", () => finish(false));
              kill.once("close", (code) => finish(code === 0));
            });
          } else {
            // The detached child leads its own process group; signalling `-pid`
            // reaches vendor-forked children that a plain root kill would orphan.
            const groupId = childProcess.pid ? -childProcess.pid : undefined;
            try {
              cleanupSucceeded =
                groupId !== undefined && process.kill(groupId, "SIGTERM")
                  ? true
                  : childProcess.kill("SIGTERM");
            } catch {
              try {
                cleanupSucceeded = childProcess.kill("SIGTERM");
              } catch {
                cleanupSucceeded = false;
              }
            }
          }
          forceKillTimer = setTimeout(() => {
            if (isSettled) return;
            try {
              if (!isWindows && childProcess.pid) {
                try {
                  process.kill(-childProcess.pid, "SIGKILL");
                } catch {
                  childProcess.kill("SIGKILL");
                }
              } else {
                childProcess.kill("SIGKILL");
              }
            } catch {
              // The hard-settle timer below still bounds the caller's wait.
            }
          }, 1_000);
          hardSettleTimer = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            clearTimers();
            // The process never reported a close event, so no honest exit code
            // exists; report undefined rather than fabricating one.
            resolve({
              stdout: readStdout(),
              stderr: readStderr(),
              exitCode: timedOut ? 124 : undefined,
              durationMs: Date.now() - startTime,
              timedOut,
              aborted,
              cleanupMethod,
              cleanupSucceeded,
              resourceEvidence: resourceEvidence(),
            });
          }, 3_000);
        })();
      }
      return pendingTermination;
    };

    let childProcess: ChildProcess;
    try {
      childProcess = spawn(actualCmd, actualArgs, spawnOptions);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return reject(
        new ProcessExecutionError(`Failed to spawn process '${command}': ${errorMsg}`, {
          exitCode: 127,
          stdout: "",
          stderr: errorMsg,
        }),
      );
    }

    if (childProcess.stdin) {
      // A child that exits before draining stdin raises an async EPIPE error;
      // without a listener it would crash the AgentMesh process.
      childProcess.stdin.on("error", () => {
        // Stdin failures cannot change the outcome; stdout/stderr already
        // capture whatever the process managed to produce.
      });
      try {
        if (options.input) {
          childProcess.stdin.write(options.input);
        }
        childProcess.stdin.end();
      } catch {
        // Ignore synchronous stdin write error if process died quickly
      }
    }

    if (options.signal?.aborted) {
      aborted = true;
      void terminateProcessTree();
    } else {
      options.signal?.addEventListener(
        "abort",
        () => {
          if (isSettled) return;
          aborted = true;
          void terminateProcessTree();
        },
        { once: true },
      );
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree();
      }, timeoutMs);
    }

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    childProcess.on("error", (err: Error) => {
      if (isSettled) return;
      void (async () => {
        await terminateProcessTree();
        if (isSettled) return;
        isSettled = true;
        clearTimers();
        reject(
          new ProcessExecutionError(`Process '${command}' encountered error: ${err.message}`, {
            exitCode: 1,
            stdout: readStdout(),
            stderr: readStderr() || err.message,
            timedOut,
            aborted,
            cleanupMethod,
            cleanupSucceeded,
            resourceEvidence: resourceEvidence(),
          }),
        );
      })();
    });

    childProcess.on("close", (code: number | null, signal: string | null) => {
      if (isSettled) return;
      void (async () => {
        // A termination initiated by timeout/cancel may still be recording its
        // cleanup outcome; settle only after it has finished so the reported
        // evidence is complete.
        await pendingTermination?.catch(() => undefined);
        if (isSettled) return;
        isSettled = true;
        clearTimers();
        const durationMs = Date.now() - startTime;
        const exitCode = timedOut
          ? 124
          : code !== null
            ? code
            : signal
              ? 128 + (SIGNAL_EXIT_CODES[signal] ?? 0)
              : 0;

        resolve({
          stdout: readStdout(),
          stderr: readStderr(),
          exitCode,
          durationMs,
          timedOut,
          aborted,
          cleanupMethod,
          cleanupSucceeded,
          resourceEvidence: resourceEvidence(),
        });
      })();
    });
  });
}
