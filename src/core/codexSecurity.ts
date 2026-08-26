/**
 * Codex security baseline (OPTIMIZATION_PLAN T3.1).
 *
 * Assembles the controlled parameter set that every codex spawn must carry
 * and physically blocks bypass flags before they can reach the vendor argv:
 *
 * - `-c approval_policy="never"`: headless default made explicit; operations
 *   requiring approval are always Forbidden, never auto-approved.
 * - `-c sandbox_workspace_write.network_access=false`: defensive
 *   explicitation of the default-off network egress in workspace-write mode.
 * - `--strict-config`: unknown/typo'd `-c` keys become startup errors instead
 *   of silently ignored overrides (P-REAL-007 class of failures).
 * - argv physical exclusion of `--yolo`,
 *   `--dangerously-bypass-approvals-and-sandbox`, and
 *   `sandbox_mode=danger-full-access` (each skips approvals AND sandbox).
 * - Dedicated `CODEX_HOME` support for per-role governance directories.
 */

/** Global flag that turns unknown config keys into hard startup errors. */
export const CODEX_STRICT_CONFIG_FLAG = "--strict-config";

/**
 * Baseline `-c` overrides appended AFTER caller-supplied extra args so the
 * locks win when the vendor merges duplicate override keys last-wins.
 */
export function buildCodexSecurityBaselineArgs(): string[] {
  return [
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    CODEX_STRICT_CONFIG_FLAG,
  ];
}

/** Error thrown when forbidden bypass arguments are detected in an argv. */
export class CodexSecurityViolationError extends Error {
  readonly forbiddenArgs: string[];

  constructor(forbiddenArgs: string[]) {
    super(
      "Rejected forbidden Codex argument(s) that would bypass approvals or the sandbox: " +
        `${forbiddenArgs.join(", ")}`,
    );
    this.name = "CodexSecurityViolationError";
    this.forbiddenArgs = [...forbiddenArgs];
  }
}

const FORBIDDEN_FLAG_PATTERN = /^--(?:yolo|dangerously-bypass-approvals-and-sandbox)$/i;

/**
 * Matches a single argv entry that carries a dangerous config VALUE, whether
 * passed as one token (`-csandbox_mode=...` style) or as the value half of a
 * `-c <key>=<value>` pair. Quoted and unquoted variants are both covered;
 * matching is value-exact (codex distinguishes case, we accept any case of
 * the same literal to be conservative).
 */
const FORBIDDEN_CONFIG_VALUE_PATTERN =
  /^(?:[a-z_]+\.)?sandbox_mode\s*=\s*["']?danger-full-access["']?$/i;

/** Returns the entries of `args` that are physically excluded from codex argv. */
export function findForbiddenCodexArgs(args: readonly string[]): string[] {
  return args.filter(
    (arg) => FORBIDDEN_FLAG_PATTERN.test(arg) || FORBIDDEN_CONFIG_VALUE_PATTERN.test(arg),
  );
}

/**
 * Throws {@link CodexSecurityViolationError} when any argument would bypass
 * codex approvals/sandbox. Called at argv construction time so a rejected
 * spawn never happens and the violation is observable as a structured error.
 */
export function assertNoForbiddenCodexArgs(args: readonly string[] | undefined): void {
  if (!args || args.length === 0) return;
  const forbidden = findForbiddenCodexArgs(args);
  if (forbidden.length > 0) {
    throw new CodexSecurityViolationError(forbidden);
  }
}

/**
 * Returns a copy of `env` with `CODEX_HOME` pointed at a dedicated directory
 * (per-role governance home with execpolicy rules / requirements.toml). The
 * input record is never mutated.
 */
export function withCodexHome(
  env: Record<string, string> | undefined,
  codexHome: string,
): Record<string, string> {
  if (!codexHome || !codexHome.trim()) {
    throw new Error("withCodexHome requires a non-empty CODEX_HOME directory.");
  }
  return { ...(env ?? {}), CODEX_HOME: codexHome };
}
