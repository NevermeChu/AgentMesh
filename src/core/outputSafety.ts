/**
 * Runner-level safety scans (P-R14-1). H5/H9 of round 14 proved that
 * prompt-only channels with free models execute malicious and destructive
 * instructions without any resistance: the bridge cannot prevent that at the
 * vendor layer, but it MUST surface the facts — leaked credential material in
 * worker output, and destructive command patterns in task text — as
 * structured warnings the orchestrator and reviewers cannot miss.
 *
 * These scans are best-effort heuristics (defense in depth, not a sandbox):
 * false negatives are expected; false positives are acceptable because the
 * output is warnings, never blocking.
 */

export interface SafetyScanMatch {
  /** Pattern identifier, stable for downstream tooling. */
  pattern: string;
  /** Redacted excerpt around the match (never the full credential). */
  excerpt: string;
}

const CREDENTIAL_PATTERNS: ReadonlyArray<{ pattern: string; re: RegExp }> = [
  { pattern: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { pattern: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { pattern: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { pattern: "bearer-token", re: /\bBearer [A-Za-z0-9._-]{16,}\b/g },
  {
    pattern: "credential-assignment",
    re: /\b(api[_-]?key|apikey|password|passwd|secret|token|access[_-]?token)\b\s*[=:]\s*["']?[^\s"']{8,}/gi,
  },
  {
    pattern: "env-file-contents",
    re: /^\s*[A-Z][A-Z0-9_]{2,}=[^\s=].{4,}$/gm,
  },
];

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: string; re: RegExp }> = [
  { pattern: "rm-recursive-force", re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/gi },
  { pattern: "git-reset-hard", re: /\bgit\s+reset\s+--hard\b/gi },
  { pattern: "git-force-push", re: /\bgit\s+push\s+.*(-f|--force)\b/gi },
  { pattern: "git-clean-force", re: /\bgit\s+clean\s+.*-[a-zA-Z]*f/gi },
  {
    pattern: "windows-del-tree",
    re: /\b(del\s+\/[sq]|rd\s+\/s|Remove-Item\s+.*-Recurse.*-Force)\b/gi,
  },
  { pattern: "disk-overwrite", re: /\bdd\s+if=/gi },
  { pattern: "mkfs", re: /\bmkfs\b/gi },
  { pattern: "sql-drop", re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/gi },
];

function collectMatches(
  text: string,
  patterns: ReadonlyArray<{ pattern: string; re: RegExp }>,
  maxPerPattern = 3,
): SafetyScanMatch[] {
  const matches: SafetyScanMatch[] = [];
  for (const { pattern, re } of patterns) {
    const regex = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null && count < maxPerPattern) {
      const start = Math.max(0, match.index - 12);
      // Redact the excerpt tail so the warning itself does not carry secrets.
      const excerpt = `${text.slice(start, match.index)}[${match[0].slice(0, 12)}…]<redacted>`;
      matches.push({ pattern, excerpt });
      count++;
      if (match[0].length === 0) regex.lastIndex++;
    }
  }
  return matches;
}

/**
 * Scans worker output for credential-shaped material. Returns one match entry
 * per (pattern, occurrence up to cap); empty array means nothing detected —
 * never a guarantee of cleanliness.
 */
export function scanForCredentialLeaks(text: string): SafetyScanMatch[] {
  if (!text) return [];
  return collectMatches(text, CREDENTIAL_PATTERNS);
}

/**
 * Scans task text for destructive command patterns. Round 14 H9: free-tier
 * workers execute such instructions verbatim; prompt-only channels have no
 * runtime enforcement, so the dispatch carries an explicit warning instead.
 */
export function detectDestructiveInstructions(text: string): SafetyScanMatch[] {
  if (!text) return [];
  return collectMatches(text, DESTRUCTIVE_PATTERNS);
}

export function formatSafetyWarning(
  kind: "credential-leak" | "destructive-task",
  matches: SafetyScanMatch[],
): string {
  const detail = matches.map((m) => `${m.pattern}(${m.excerpt})`).join("; ");
  if (kind === "credential-leak") {
    return `SECURITY: possible credential material in worker output [${detail}]. Treat as leaked; rotate if these are real secrets.`;
  }
  return `SAFETY: task text contains destructive command patterns [${detail}]. The channel is prompt-only (no runtime enforcement); the worker may execute them verbatim (round-14 H9). Confirm this is intended.`;
}
