/**
 * Environment-variable injection policy for vendor child processes (P3 / T3.3).
 *
 * All functions in this module are pure: they never touch `process.env`
 * themselves; callers pass the parent snapshot in. `core/executor.ts` applies
 * the result at the spawn boundary, which covers every vendor channel.
 *
 * Whitelist rationale follows [CC] bashPermissions.ts:369-446 SAFE_ENV_VARS:
 * the accepted keys "CANNOT execute code or load libraries". The security
 * commentary there must never be weakened:
 * - PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*  -> execution/library loading
 * - PYTHONPATH, NODE_PATH, CLASSPATH, RUBYLIB  -> module loading
 * - GOFLAGS, RUSTFLAGS, NODE_OPTIONS           -> can carry code-exec flags
 * - DOCKER_HOST, KUBECONFIG, AWS_*             -> redirect daemon/cluster/cloud
 *   endpoints and credentials ([CC] bashPermissions.ts:432-446 argues why even
 *   stripping these is dangerous; injecting them for a vendor child is worse).
 */

/**
 * Baseline keys every spawned vendor process must be able to rely on,
 * across Windows/macOS/Linux. Compared case-insensitively because Windows
 * environment variables are case-preserving but case-insensitive.
 */
export const ENV_INHERIT_BASELINE_KEYS: readonly string[] = [
  // Execution lookup (inherited from the AgentMesh parent; callers may NOT override)
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  // User/session roots
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  // Temp directories
  "TEMP",
  "TMP",
  "TMPDIR",
  // Locale/time
  "LANG",
  "LC_ALL",
  "TZ",
  // Working directory contract maintained by core/executor.ts
  "PWD",
  "OLDPWD",
] as const;

/**
 * Permanently blacklisted keys: never inherited from the AgentMesh host into a
 * vendor child and never accepted as caller overrides. Exact-match names are
 * compared case-insensitively; prefix entries match by uppercase prefix.
 */
export const ENV_PERMANENT_BLACKLIST_KEYS: readonly string[] = [
  // Dynamic code/library loading ([CC] bashPermissions.ts:372-377)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYLIB",
  "CLASSPATH",
  "PERL5OPT",
  "GOFLAGS",
  "RUSTFLAGS",
  // Shell startup scripts executed implicitly by sh/bash/zsh
  "BASH_ENV",
  "ZDOTDIR",
  "SHELLOPTS",
  "BASHOPTS",
  // Daemon/cluster endpoint redirection ([CC] bashPermissions.ts:432-446)
  "DOCKER_HOST",
  "KUBECONFIG",
];

export const ENV_PERMANENT_BLACKLIST_PREFIXES: readonly string[] = [
  // macOS dynamic-loader injection family
  "DYLD_",
  // Cloud credential/config selection (AWS_* per OPTIMIZATION_PLAN T3.3)
  "AWS_",
  // npm registry/lifecycle hijacking via environment config
  "NPM_CONFIG_",
];

/**
 * Keys a caller may set or override per task. Everything else is dropped and
 * reported via `rejectedKeys`. Deliberately EXCLUDED despite being legitimate
 * platform inputs: PATH/PATHEXT/COMSPEC/SYSTEMROOT (baseline inheritance only —
 * letting callers swap them would allow binary planting ahead of the vendor
 * CLI), proxy variables (would MITM vendor API traffic), and HOME/USERPROFILE
 * (redirecting them re-points vendor auth and hook configuration).
 */
export const ENV_OVERRIDE_ALLOWED_KEYS: readonly string[] = [
  // Locale and character encoding
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "TZ",
  // Terminal/display formatting
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // Behavior flags only — never module loaders ([CC] bashPermissions.ts:378-430)
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "PYTEST_DEBUG",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "GOEXPERIMENT",
  "GOOS",
  "GOARCH",
  "GO111MODULE",
  "CGO_ENABLED",
  // Task-scoped vendor credentials (plain API keys; base-URL overrides stay banned)
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  // Agent-governance directory consumed and re-injected by the codex adapter
  // (dedicated CODEX_HOME per role, see core/codexSecurity.ts withCodexHome)
  "CODEX_HOME",
];

/**
 * Override prefixes reserved for AgentMesh-owned plumbing (e.g. the
 * AGENTMESH_HEARTBEAT_FILE execution-evidence path used by the executor
 * process-group integ fixture). Remote MCP callers cannot inject environment
 * variables today (no tool schema exposes one), so these keys only ever carry
 * values produced by trusted internal code or local test harnesses.
 */
export const ENV_OVERRIDE_ALLOWED_PREFIXES: readonly string[] = ["AGENTMESH_"];

const BLACKLIST_SET = new Set(ENV_PERMANENT_BLACKLIST_KEYS.map((key) => key.toUpperCase()));
const OVERRIDE_SET = new Set(ENV_OVERRIDE_ALLOWED_KEYS.map((key) => key.toUpperCase()));
const OVERRIDE_PREFIXES = ENV_OVERRIDE_ALLOWED_PREFIXES.map((prefix) => prefix.toUpperCase());

/** True when the key must never reach a vendor child process. */
export function isPermanentBlacklistedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLACKLIST_SET.has(upper)) return true;
  return ENV_PERMANENT_BLACKLIST_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

/** True when a caller override for this key may be applied to the child env. */
export function isEnvOverrideAllowed(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLACKLIST_SET.has(upper)) return false;
  if (ENV_PERMANENT_BLACKLIST_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))) {
    return false;
  }
  if (OVERRIDE_SET.has(upper)) return true;
  return OVERRIDE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface EnvOverrideFilterResult {
  /** Override entries that passed the whitelist, keyed by their original spelling. */
  accepted: Record<string, string>;
  /** Original spellings of dropped override keys, first-seen order preserved. */
  rejectedKeys: string[];
}

/**
 * Splits caller-supplied task-scoped overrides into accepted and rejected
 * parts. Rejection depends only on the key names, so this stays independent of
 * any particular parent environment snapshot.
 */
export function filterEnvOverrides(overrides?: Record<string, string>): EnvOverrideFilterResult {
  const accepted: Record<string, string> = {};
  const rejectedKeys: string[] = [];
  if (!overrides) return { accepted, rejectedKeys };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || !isEnvOverrideAllowed(key)) {
      if (!rejectedKeys.includes(key)) rejectedKeys.push(key);
      continue;
    }
    accepted[key] = value;
  }
  return { accepted, rejectedKeys };
}

/**
 * Copies the parent snapshot minus permanently blacklisted keys (and non-string
 * holes). Baseline keys present in the parent survive here; callers cannot
 * override them later because none of them are in the override whitelist.
 */
export function filterInheritedEnvironment(
  parentEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (typeof value !== "string") continue;
    if (isPermanentBlacklistedEnvKey(key)) continue;
    inherited[key] = value;
  }
  return inherited;
}

export interface ChildEnvironmentResult extends EnvOverrideFilterResult {
  /** The sanitized environment to hand to spawn(). */
  env: Record<string, string>;
}

/**
 * Builds the full vendor child environment: inherited parent baseline plus
 * whitelisted overrides, with the spawn-cwd alignment previously owned by
 * buildChildEnvironment. Pure: pass `parentEnv` explicitly to test without
 * touching process state.
 */
export function buildPolicyChildEnvironment(
  cwd: string | undefined,
  overrides?: Record<string, string>,
  parentEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ChildEnvironmentResult {
  const env = filterInheritedEnvironment(parentEnv);
  const { accepted, rejectedKeys } = filterEnvOverrides(overrides);
  Object.assign(env, accepted);
  if (process.platform === "win32") {
    delete env.PWD;
    delete env.OLDPWD;
  } else if (cwd) {
    env.PWD = cwd;
  }
  return { env, accepted, rejectedKeys };
}

/**
 * Formats the response-facing warning for dropped override keys
 * (OPTIMIZATION_PLAN T3.3: 越键丢弃并计 warning envOverrideRejected:[...]).
 * Reports key names only — never values.
 */
export function formatEnvOverrideWarning(rejectedKeys: readonly string[]): string | undefined {
  if (rejectedKeys.length === 0) return undefined;
  return (
    `envOverrideRejected:[${rejectedKeys.join(",")}]; ` +
    "the listed task environment keys were dropped by the AgentMesh environment allowlist policy."
  );
}
