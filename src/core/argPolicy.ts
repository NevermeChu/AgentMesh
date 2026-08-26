/**
 * Per-adapter extraArgs allowlists plus a global dangerous-argument blacklist
 * (P3 / T3.3). All functions are pure; adapters call `validateExtraArgs`
 * before constructing vendor argv and fail closed with a structured rejection.
 *
 * Dangerous-flag rationale:
 * - `--yolo` / `--dangerously-bypass-approvals-and-sandbox` simultaneously drop
 *   approval and sandbox ([CX] exec/src/lib.rs:296-300, OPTIMIZATION_PLAN T3.1.4).
 * - `--dangerously-skip-permissions` is adapter-managed (e.g. Claude workers)
 *   and must never be injectable by callers.
 * - `--settings` / `--setting-sources` could override the deny policy injected
 *   by core/policyTemplates.ts; `--mcp-config` / `--config` can register
 *   arbitrary tool/MCP servers (remote code execution).
 * - Interpreter/system-prompt flags (`-c` outside declared prefixes,
 *   `--append-system-prompt`) hijack vendor behavior invisibly.
 */
import type { AgentName } from "../agents/types.js";

export const DANGEROUS_ARG_MARKERS: readonly string[] = [
  "--yolo",
  "dangerously-bypass-approvals-and-sandbox",
  "dangerously-skip-permissions",
  "danger-full-access",
  // Plan T3.1.4 hard-rejects this for codex; banned globally until a window opens it deliberately.
  "--ephemeral",
  // Policy/config injection surface
  "--settings",
  "--setting-sources",
  "--mcp-config",
  "--strict-mcp-config",
  "--config",
  "--append-system-prompt",
  "--system-prompt",
];

/**
 * Structured rejection contract.
 *
 * TODO(window-1 contract): the ARG_REJECTED code value is owned by the
 * window-1 protocol contract; this string constant is a placeholder so that
 * convergence during merge only requires replacing this single definition.
 */
export const ARG_REJECTED = "ARG_REJECTED";

export type ArgRejectionReason =
  | "dangerous-flag"
  | "not-in-allowlist"
  | "missing-value"
  | "value-not-allowed"
  | "empty-token";

export interface AllowedExtraArg {
  /** Exact argv token that opens the entry, e.g. `--model` or `-c`. */
  flag: string;
  /** How many value tokens follow the flag. Defaults to 0. */
  valueTokens?: number;
  /** When set, every value token must start with one of these prefixes. */
  valuePrefixes?: readonly string[];
}

const MODEL_ONLY: readonly AllowedExtraArg[] = [{ flag: "--model", valueTokens: 1 }];

/**
 * Allowlist tables per adapter. Agents without an entry reject ALL extraArgs
 * (same posture as reviewers). The codex row is a window-2 placeholder built
 * from OPTIMIZATION_PLAN T3.3 (model / -c model* / --add-dir only); window-2
 * owns the authoritative version and physical exclusion in agents/codex.ts.
 */
export const ALLOWED_EXTRA_ARGS: Partial<Record<AgentName, readonly AllowedExtraArg[]>> = {
  codex: [
    { flag: "--model", valueTokens: 1 },
    { flag: "--add-dir", valueTokens: 1 },
    { flag: "-c", valueTokens: 1, valuePrefixes: ["model", "model_reasoning_effort"] },
  ],
  claude: MODEL_ONLY,
  grok: MODEL_ONLY,
  zcode: MODEL_ONLY,
  opencode: MODEL_ONLY,
  antigravity: MODEL_ONLY,
};

export interface ArgRejection {
  code: string;
  agent: AgentName;
  /** Offending token (flag plus consumed values where applicable). */
  arg: string;
  reason: ArgRejectionReason;
  /** Dangerous marker that matched, when reason is "dangerous-flag". */
  matchedMarker?: string;
}

export interface ExtraArgsVerdict {
  accepted: string[];
  rejections: ArgRejection[];
}

function rejection(
  agent: AgentName,
  arg: string,
  reason: ArgRejectionReason,
  matchedMarker?: string,
): ArgRejection {
  return matchedMarker === undefined
    ? { code: ARG_REJECTED, agent, arg, reason }
    : { code: ARG_REJECTED, agent, arg, reason, matchedMarker };
}

/** True when the raw token contains a blacklisted dangerous marker. */
export function isDangerousArg(token: string): string | undefined {
  const lower = token.toLowerCase();
  return DANGEROUS_ARG_MARKERS.find((marker) => lower.includes(marker));
}

/**
 * Validates caller-supplied extraArgs against the adapter allowlist and the
 * global dangerous-argument blacklist. Default-deny: anything unmatched is
 * rejected with a structured reason instead of being forwarded to the vendor
 * CLI. Reviewers never reach this path (base.ts rejects their extraArgs).
 */
export function validateExtraArgs(agent: AgentName, args?: readonly string[]): ExtraArgsVerdict {
  const accepted: string[] = [];
  const rejections: ArgRejection[] = [];
  if (!args || args.length === 0) return { accepted, rejections };

  const rules = ALLOWED_EXTRA_ARGS[agent];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    index += 1;
    if (arg === undefined) continue;

    if (arg.trim().length === 0) {
      rejections.push(rejection(agent, arg, "empty-token"));
      continue;
    }
    const marker = isDangerousArg(arg);
    if (marker !== undefined) {
      rejections.push(rejection(agent, arg, "dangerous-flag", marker));
      continue;
    }
    const rule = rules?.find((candidate) => candidate.flag === arg);
    if (!rule) {
      rejections.push(rejection(agent, arg, "not-in-allowlist"));
      continue;
    }

    const take = rule.valueTokens ?? 0;
    if (take === 0) {
      accepted.push(arg);
      continue;
    }
    const values = args.slice(index, index + take).filter((v): v is string => v !== undefined);
    index += take;
    if (values.length < take) {
      rejections.push(rejection(agent, arg, "missing-value"));
      break;
    }
    const dangerousValue = values
      .map((value) => isDangerousArg(value))
      .find((marker) => marker !== undefined);
    if (dangerousValue !== undefined) {
      rejections.push(
        rejection(agent, [arg, ...values].join(" "), "dangerous-flag", dangerousValue),
      );
      continue;
    }
    const invalid = values.find(
      (value) =>
        value.trim().length === 0 ||
        value.startsWith("-") ||
        (rule.valuePrefixes !== undefined &&
          !rule.valuePrefixes.some((prefix) => value.startsWith(prefix))),
    );
    if (invalid !== undefined) {
      rejections.push(rejection(agent, [arg, ...values].join(" "), "value-not-allowed"));
      continue;
    }
    accepted.push(arg, ...values);
  }
  return { accepted, rejections };
}

/** Human-readable, response-ready description of structured rejections. */
export function describeArgRejections(rejections: readonly ArgRejection[]): string {
  return rejections
    .map((item) =>
      item.matchedMarker === undefined
        ? `${item.arg} (${item.reason})`
        : `${item.arg} (${item.reason}: ${item.matchedMarker})`,
    )
    .join("; ");
}
