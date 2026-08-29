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
const VENDOR_QUOTA_PATTERN =
  /预扣费|额度不足|余额不足|insufficient[_\s]*(?:user[_\s]*)?(?:credit|balance|quota)|(?:credit|balance|quota)[_\s]*(?:exhaust|deplet)/i;
const MODEL_REJECTION_PATTERN =
  /\b(?:invalid|unsupported)[_-]?model\b|model.{0,40}not\s+(?:supported|available|found|valid)|does\s+not\s+have\s+access|no\s+access\s+to\s+model|model[_-]not[_-]found|模型不存在|unknown\s+model|no\s+such\s+model/i;
const TRANSIENT_PATTERN =
  /\b(?:5\d\d|408|429)\b|\b(?:internal\s+server\s+error|bad\s+gateway|service\s+unavailable|server\s+error|overloaded|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|request\s+timeout|stream_error|fetch\s+failed|socket\s+hang\s+up)\b|connection\s+(?:refused|reset|closed|timed?\s?out)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT/i;
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
  if (VENDOR_QUOTA_PATTERN.test(message)) return "VENDOR_QUOTA";
  if (MODEL_REJECTION_PATTERN.test(message)) return "MODEL_REJECTED";
  if (TRANSIENT_PATTERN.test(message)) return "TRANSIENT_5XX";
  if (SANDBOX_PATTERN.test(message)) return "SANDBOX_UNAVAILABLE";
  if (PARSE_FAILURE_PATTERN.test(message)) return "PARSE_FAILURE";
  if (ARG_REJECTION_PATTERN.test(message)) return "ARG_REJECTED";
  return undefined;
}

// ── P1 T1.3 — controlled retry ──────────────────────────────────────────────

/** Backoff table between automatic attempts (attempt N waits delays[N-1]). */
export const RETRY_BACKOFF_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];
/** Hard cap of attempts for one logical dispatch (first try plus retries). */
export const MAX_DISPATCH_ATTEMPTS = 3;
/**
 * Failures eligible for automatic retry: only classes where the vendor process
 * provably produced no work. Any run that already emitted an extractable
 * answer has side effects and is always surfaced to the orchestrator instead.
 */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = ["SPAWN_FAILED", "TRANSIENT_5XX"];

/**
 * Spawn-failure causes that cannot heal within one dispatch horizon (binary
 * absent, interpreter missing, cwd gone). They stay SPAWN_FAILED for callers,
 * but automatic retries would only add latency, so they are excluded here.
 * Everything else under SPAWN_FAILED (EACCES/EPERM/EBUSY-style launcher and
 * antivirus races) is treated as transient and retried.
 */
const PERMANENT_SPAWN_CAUSE_PATTERN =
  /\b(?:enoent|command\s+not\s+found|is\s+not\s+recognized\s+as\s+an?\s+internal\s+or\s+external\s+command|not\s+found\s+in\s+(?:the\s+)?(?:system\s+)?path)\b/i;

export interface RetryCandidateResult {
  status: "success" | "failed";
  errorCode?: ErrorCode;
  finalAnswer?: string;
  /** Diagnostic output carried by the failure; scanned for permanent spawn causes. */
  output?: string;
  aborted?: boolean;
}

/** Iron-rule guard: retry only no-work failures, and never past a cancellation. */
export function isRetriableFailure(result: RetryCandidateResult, callerAborted: boolean): boolean {
  if (result.status !== "failed") return false;
  if (callerAborted || result.aborted) return false;
  if (!result.errorCode) return false;
  if (result.finalAnswer && result.finalAnswer.trim().length > 0) return false;

  if (result.errorCode === "TRANSIENT_5XX") return true;
  if (result.errorCode === "SPAWN_FAILED") {
    const evidence = result.output ?? "";
    return !PERMANENT_SPAWN_CAUSE_PATTERN.test(evidence);
  }
  return false;
}

export type ResilienceSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Real sleep used in production; resolves early on abort and never keeps the process alive. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let onAbort: (() => void) | undefined;
    const finish = () => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        finish();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(finish, ms);
    timer.unref?.();
  });
}

export interface ResilientExecutionOptions<T extends RetryCandidateResult> {
  /** One underlying execution attempt (already unwrapped from retry concerns). */
  operation: () => Promise<T>;
  /** Decides whether one failed attempt may be retried. */
  isRetriable: (result: T) => boolean;
  signal?: AbortSignal;
  maxAttempts?: number;
  backoffDelaysMs?: readonly number[];
  sleep?: ResilienceSleep;
}

/**
 * Drives bounded retries with the constant backoff table. Cancellation during
 * a wait returns the last observed result immediately instead of launching a
 * new attempt. Pure control flow: time enters only through `sleep`.
 */
export async function executeWithResilientRetries<T extends RetryCandidateResult>(
  options: ResilientExecutionOptions<T>,
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  const backoffDelaysMs = options.backoffDelaysMs ?? RETRY_BACKOFF_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await options.operation();
    if (attempts >= maxAttempts || !options.isRetriable(result)) {
      return { result, attempts };
    }
    if (options.signal?.aborted) return { result, attempts };

    const delayIndex = Math.min(attempts - 1, backoffDelaysMs.length - 1);
    await sleep(backoffDelaysMs[delayIndex]!, options.signal);
    if (options.signal?.aborted) return { result, attempts };
  }
}

// ── P1 T1.3 — per-adapter circuit breaker ───────────────────────────────────

/** Consecutive failed logical dispatches that trip the breaker. */
export const CIRCUIT_FAILURE_THRESHOLD = 5;
/** How long a tripped breaker rejects new dispatches before allowing a probe. */
export const CIRCUIT_OPEN_DURATION_MS = 10 * 60 * 1000;

export interface CircuitBreakerState {
  consecutiveFailures: number;
  /** Epoch ms when the breaker opened, or null while closed. */
  openedAtMs: number | null;
}

export function initialCircuitBreakerState(): CircuitBreakerState {
  return { consecutiveFailures: 0, openedAtMs: null };
}

export type CircuitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Gate evaluated BEFORE any dispatch. An expired opening allows the next
 * dispatch through (probe); a still-open breaker fails fast with the remaining
 * cooldown so callers can schedule a retry.
 */
export function evaluateCircuitBreaker(state: CircuitBreakerState, nowMs: number): CircuitVerdict {
  if (state.openedAtMs === null) return { allowed: true };
  const elapsed = nowMs - state.openedAtMs;
  if (elapsed >= CIRCUIT_OPEN_DURATION_MS) return { allowed: true };
  return { allowed: false, retryAfterMs: CIRCUIT_OPEN_DURATION_MS - elapsed };
}

/**
 * Pure reducer recording ONE logical dispatch outcome (retries included):
 * success closes/reset the breaker; the Nth consecutive failure at threshold
 * opens it from `nowMs`. Caller-abort outcomes should not be fed here.
 */
export function recordExecutionOutcome(
  state: CircuitBreakerState,
  params: { ok: boolean; nowMs: number },
): CircuitBreakerState {
  if (params.ok) return initialCircuitBreakerState();
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    openedAtMs:
      consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD ? params.nowMs : (state.openedAtMs ?? null),
  };
}
