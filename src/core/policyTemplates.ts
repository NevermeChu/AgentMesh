/**
 * Claude Worker deny fallback policy templates (P3 / T3.2).
 *
 * Principle of effectiveness: Claude Code evaluates rule-based permissions
 * BEFORE the bypassPermissions decision, so deny rules keep biting under
 * `--dangerously-skip-permissions` ([CC] permissions.ts
 * checkRuleBasedPermissions:1060-1156 and the deny-first step at
 * permissions.ts:1170-1181).
 *
 * Injection mechanism per the vendor contract:
 * - the generated settings.json is loaded through `--settings <file>` (the
 *   flagSettings source), which is force-enabled alongside policySettings by
 *   [CC] settings/constants.ts getEnabledSettingSources;
 * - `--setting-sources user,project,local` pins the standard sources while
 *   leaving the flag-based deny policy authoritative for what it denies.
 *
 * Template sources: OPTIMIZATION_PLAN T3.2 default deny list (.env*, ~/.ssh
 * recursive glob, .git recursive glob, .agentmesh recursive glob,
 * Bash curl/wget/sudo); supplementary dangerous-file rationale from
 * [CC] utils/permissions/filesystem.ts:57-79.
 */

import * as path from "node:path";

/**
 * Deny rules active for every AgentMesh-driven Claude worker run. Path rules
 * are emitted for both the Read and Edit tool families so secrets can be
 * neither exfiltrated nor overwritten; the .env glob is additionally covered
 * recursively (double-star prefix) for nested environment files.
 */
export const CLAUDE_WORKER_DENY_RULES: readonly string[] = [
  // Environment/secret files (plan: .env*) - root and nested variants
  "Read(.env*)",
  "Edit(.env*)",
  "Read(**/.env*)",
  "Edit(**/.env*)",
  // SSH credentials (plan: ~/.ssh/**)
  "Read(~/.ssh/**)",
  "Edit(~/.ssh/**)",
  // Git metadata and hooks (plan: .git/**; hooks are code-execution vectors)
  "Read(.git/**)",
  "Edit(.git/**)",
  // AgentMesh's own state (plan: recursive .agentmesh glob)
  "Read(**/.agentmesh/**)",
  "Edit(**/.agentmesh/**)",
  // Network fetch and privilege escalation commands (plan: Bash(curl,wget,sudo))
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(sudo:*)",
];

/**
 * Value passed to `--setting-sources`: standard user/project/local sources stay
 * loaded; flagSettings (our generated file) and policySettings are always
 * enabled by the vendor regardless of this flag.
 */
export const CLAUDE_SETTING_SOURCES_FLAG = "user,project,local";

const POLICY_ROOT_SEGMENTS = [".agentmesh", "policy"] as const;

/**
 * Builds the controlled settings.json content. Pure: returns the exact JSON
 * text an adapter persists next to the vendor CLI invocation.
 */
export function buildClaudePolicySettingsContent(
  denyRules: readonly string[] = CLAUDE_WORKER_DENY_RULES,
): string {
  return `${JSON.stringify({ permissions: { deny: [...denyRules] } }, null, 2)}\n`;
}

/**
 * Reduces a Bridge/native session identifier to a single safe path segment so
 * the policy directory can never escape the policy root:
 * - path separators (and Windows drive colons) become underscores, which kills
 *   absolute paths and traversal chains;
 * - runs of dots collapse to underscores, so "." / ".." / "..." segments are
 *   impossible (relative-path-traversal boundary variant);
 * - Windows reserved device names are prefixed;
 * - the segment is capped to 64 characters and falls back to "adhoc".
 *
 * Case is preserved verbatim (filesystems differ; nothing here depends on
 * comparing identifiers case-insensitively).
 */
export function sanitizePolicySessionSlug(sessionId?: string): string {
  const raw = typeof sessionId === "string" ? sessionId.trim() : "";
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 64)
    .replace(/[._]+$/, "");
  if (sanitized.length === 0 || isWindowsReservedName(sanitized)) return "adhoc";
  return sanitized;
}

function isWindowsReservedName(name: string): boolean {
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split(".")[0] ?? name);
}

/** Directory holding one generated policy workspace per session. */
export function getClaudePolicyDirectoryPath(homeDir: string, sessionId?: string): string {
  return path.join(homeDir, ...POLICY_ROOT_SEGMENTS, sanitizePolicySessionSlug(sessionId));
}

/** Full settings.json path handed to `--settings`. */
export function getClaudePolicySettingsPath(homeDir: string, sessionId?: string): string {
  return path.join(getClaudePolicyDirectoryPath(homeDir, sessionId), "settings.json");
}

/**
 * CLI arguments injecting the generated policy into a Claude worker run:
 * `--settings <file>` loads the deny policy (flagSettings), and
 * `--setting-sources` pins the standard sources.
 */
export function buildClaudeWorkerInjectionArgs(
  settingsPath: string,
  settingSourcesFlag: string = CLAUDE_SETTING_SOURCES_FLAG,
): string[] {
  return ["--settings", settingsPath, "--setting-sources", settingSourcesFlag];
}

/** Response-facing disclosure text listing the active deny rules. */
export function describeClaudeDenyPolicy(
  denyRules: readonly string[] = CLAUDE_WORKER_DENY_RULES,
): string {
  return `deny rules (${denyRules.length}): ${denyRules.join(", ")}`;
}
