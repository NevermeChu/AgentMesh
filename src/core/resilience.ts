import type { ErrorCode } from "./types.js";

/**
 * P1 T1.2 — normalizes one execution failure into a machine-readable
 * ErrorCode. Classification is conservative on purpose (evidence-over-guessing
 * red line): when no known signal matches, the code stays undefined instead of
 * being fabricated.
 *
 * Signal semantics follow the codex exec channel (exit 0 = success, exit 1 =
 * failed turn including turn.failed / stream_error / server request refusal)
 * plus transport-level spawn and timeout evidence. Exit code 127 is the local
 * executor's "command not found" convention and maps to SPAWN_FAILED.
 */
const SPAWN_FAILURE_PATTERN =
  /\bspawn\s+(?:\S+\s+)?(?:ENOENT|EACCES|EPERM)\b|command\s+not\s+found|is\s+not\s+recognized\s+as\s+an\s+internal\s+or\s+external\s+command/i;
const MODEL_REJECTION_PATTERN =
  /\b(?:invalid|unsupported)[_-]?model\b|model.{0,40}not\s+(?:supported|available|found|valid)|does\s+not\s+have\s+access|no\s+access\s+to\s+model|model[_-]not[_-]found/i;
const TRANSIENT_PATTERN =
  /\b(?:5\d\d|408|429)\b|\b(?:internal\s+server\s+error|bad\s+gateway|service\s+unavailable|server\s+error|overloaded|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|request\s+timeout|stream_error|fetch\s+failed|socket\s+hang\s+up)\b|connection\s+(?:refused|reset|timed?\s?out)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT/i;
const SANDBOX_PATTERN =
  /\bsandbox\b.{0,80}\b(?:unavailable|blocked|denied|not\s+(?:enabled|activated))\b|\bspawn\s+EPERM\b.{0,80}\bsandbox\b/i;
const PARSE_FAILURE_PATTERN =
  /\b(?:unexpected\s+(?:end\s+of\s+(?:json|input)|token)|invalid\s+json|malformed|failed\s+to\s+parse|syntaxerror|json\.parse)\b/i;
const ARG_REJECTION_PATTERN =
  /\b(?:additional\s+cli\s+arguments\s+are\s+not\s+allowed|mode\s+is\s+not\s+supported\s+by|unsupported\s+(?:mode|argument|flag)|invalid\s+argument|disallowed\s+(?:flag|argument|extraargs?)|extra\s+args?\s+are\s+not\s+allowed)\b/i;

export interface FailureSignal {
  message?: string;
  exitCode?: number;
  timedOut?: boolean;
  aborted?: boolean;
}

/**
 * Maps one failure's signals to an ErrorCode, highest-priority first:
 * cancellation > timeout > spawn failure > model rejection > transient vendor
 * failure > sandbox unavailability > parse failure > argument rejection.
 * Returns undefined when nothing matches (never guess).
 */
export function classifyErrorCode(signal: FailureSignal): ErrorCode | undefined {
  if (signal.aborted) return "CANCELLED";
  if (signal.timedOut) return "TIMEOUT";

  const message = signal.message ?? "";
  if (!message) {
    return signal.exitCode === 127 ? "SPAWN_FAILED" : undefined;
  }

  if (SPAWN_FAILURE_PATTERN.test(message)) return "SPAWN_FAILED";
  if (signal.exitCode === 127) return "SPAWN_FAILED";
  if (MODEL_REJECTION_PATTERN.test(message)) return "MODEL_REJECTED";
  if (TRANSIENT_PATTERN.test(message)) return "TRANSIENT_5XX";
  if (SANDBOX_PATTERN.test(message)) return "SANDBOX_UNAVAILABLE";
  if (PARSE_FAILURE_PATTERN.test(message)) return "PARSE_FAILURE";
  if (ARG_REJECTION_PATTERN.test(message)) return "ARG_REJECTED";
  return undefined;
}
