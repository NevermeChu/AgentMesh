import { describe, it, expect } from "vitest";
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_DURATION_MS,
  MAX_DISPATCH_ATTEMPTS,
  RETRY_BACKOFF_DELAYS_MS,
  evaluateCircuitBreaker,
  executeWithResilientRetries,
  initialCircuitBreakerState,
  isRetriableFailure,
  recordExecutionOutcome,
} from "../../src/core/resilience.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

function retryableFailure(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: "failed",
    agent: "codex",
    summary: "spawn codex EBUSY",
    output: "spawn codex EBUSY",
    error: "spawn codex EBUSY",
    exitCode: 1,
    errorCode: "SPAWN_FAILED",
    durationMs: 3,
    ...overrides,
  };
}

describe("core/resilience retry policy (P1 T1.3)", () => {
  const base = {
    operation: async () => retryableFailure(),
    isRetriable: (result: AgentResult) => isRetriableFailure(result, false),
    sleep: async () => {},
  };

  it("retries pre-work failures with the 5s/15s/45s backoff table and caps attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    const { result, attempts } = await executeWithResilientRetries({
      ...base,
      operation: async () => {
        calls += 1;
        return retryableFailure();
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(calls).toBe(MAX_DISPATCH_ATTEMPTS);
    expect(attempts).toBe(3);
    expect(result.status).toBe("failed");
    expect(delays).toEqual(RETRY_BACKOFF_DELAYS_MS.slice(0, 2));
    expect(RETRY_BACKOFF_DELAYS_MS).toEqual([5_000, 15_000, 45_000]);
  });

  it("returns the third attempt's success after two transient failures", async () => {
    let calls = 0;
    const { result, attempts } = await executeWithResilientRetries({
      ...base,
      operation: async (): Promise<AgentResult> => {
        calls += 1;
        if (calls < 3) return retryableFailure();
        return {
          status: "success",
          agent: "codex",
          summary: "ok",
          output: "ok",
          finalAnswer: "done",
          durationMs: 4,
        };
      },
    });

    expect(calls).toBe(3);
    expect(attempts).toBe(3);
    expect(result.status).toBe("success");
    expect(result.finalAnswer).toBe("done");
  });

  it("never retries failures that already produced work or are non-retryable", async () => {
    let workCalls = 0;
    const withWork = await executeWithResilientRetries({
      ...base,
      operation: async () => {
        workCalls += 1;
        return retryableFailure({
          finalAnswer: "partial answer already produced",
          errorCode: "TRANSIENT_5XX",
        });
      },
    });
    expect(workCalls).toBe(1);
    expect(withWork.attempts).toBe(1);

    let rejectedCalls = 0;
    const rejected = await executeWithResilientRetries({
      ...base,
      operation: async () => {
        rejectedCalls += 1;
        return retryableFailure({ errorCode: "MODEL_REJECTED" });
      },
    });
    expect(rejected.attempts).toBe(1);
    expect(rejectedCalls).toBe(1);
  });

  it("does not retry permanently-failing spawn causes such as missing binaries", () => {
    expect(isRetriableFailure(retryableFailure({ output: "spawn codex ENOENT" }), false)).toBe(
      false,
    );
    expect(
      isRetriableFailure(
        retryableFailure({
          exitCode: 127,
          output: "'x' is not recognized as an internal or external command",
        }),
        false,
      ),
    ).toBe(false);
    expect(isRetriableFailure(retryableFailure(), true)).toBe(false);
    expect(
      isRetriableFailure(retryableFailure({ aborted: true, errorCode: undefined }), false),
    ).toBe(false);
  });

  it("stops immediately when the caller cancels during a backoff wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { result, attempts } = await executeWithResilientRetries({
      ...base,
      signal: controller.signal,
      operation: async () => {
        calls += 1;
        return retryableFailure();
      },
      sleep: async () => {
        controller.abort(new Error("client cancelled"));
      },
    });

    expect(calls).toBe(1);
    expect(attempts).toBe(1);
    expect(result.status).toBe("failed");
  });
});

describe("core/resilience circuit breaker reducer (P1 T1.3)", () => {
  it("opens only at the fifth consecutive failure and reports remaining cooldown", () => {
    let state = initialCircuitBreakerState();
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      state = recordExecutionOutcome(state, { ok: false, nowMs: i * 100 });
      expect(evaluateCircuitBreaker(state, 10_000).allowed).toBe(true);
    }

    state = recordExecutionOutcome(state, { ok: false, nowMs: 50_000 });
    const verdict = evaluateCircuitBreaker(state, 60_000);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.retryAfterMs).toBe(CIRCUIT_OPEN_DURATION_MS - 10_000);
    }
  });

  it("allows a probe once the open window has elapsed and re-arms on continued failures", () => {
    let state = initialCircuitBreakerState();
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      state = recordExecutionOutcome(state, { ok: false, nowMs: i * 100 });
    }
    // The breaker opened at nowMs=400; the window elapses from that instant.
    const openedAtMs = 400;
    const probeTime = openedAtMs + CIRCUIT_OPEN_DURATION_MS;
    expect(evaluateCircuitBreaker(state, probeTime).allowed).toBe(true);

    // A failed probe keeps the breaker engaged.
    state = recordExecutionOutcome(state, { ok: false, nowMs: probeTime + 1 });
    expect(evaluateCircuitBreaker(state, probeTime + 2).allowed).toBe(false);
  });

  it("resets on success", () => {
    let state = initialCircuitBreakerState();
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      state = recordExecutionOutcome(state, { ok: false, nowMs: i * 100 });
    }
    state = recordExecutionOutcome(state, { ok: true, nowMs: 999 });
    expect(state).toEqual(initialCircuitBreakerState());
  });
});

class FlakyAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Flaky Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "FLAKY_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public invocations = 0;
  public observedDelays: number[] = [];
  private script: Array<"ok" | "fail-transient" | "fail-permanent"> = [];

  /**
   * Appends scripted per-invocation outcomes; unscripted invocations fail with
   * a transient pre-work error. "fail-permanent" emits a missing-binary style
   * failure that the retry policy must never retry.
   */
  public enqueueOutcomes(...outcomes: Array<"ok" | "fail-transient" | "fail-permanent">): void {
    this.script.push(...outcomes);
  }

  protected override resilienceSleep(ms: number): Promise<void> {
    this.observedDelays.push(ms);
    return Promise.resolve();
  }

  protected override async runViaCli(): Promise<AgentResult> {
    this.invocations += 1;
    const outcome = this.script.shift() ?? "fail-transient";
    if (outcome === "ok") {
      return {
        status: "success",
        agent: this.name,
        summary: "ok",
        output: "ok",
        finalAnswer: "done",
        exitCode: 0,
        durationMs: 4,
      };
    }
    if (outcome === "fail-permanent") {
      return retryableFailure({
        summary: "spawn codex ENOENT",
        output: "spawn codex ENOENT",
        error: "spawn codex ENOENT",
      });
    }
    return retryableFailure();
  }
}

describe("agents/base resilience wrapping (P1 T1.3)", () => {
  it("succeeds on the third attempt and annotates attempts plus recovery warning", async () => {
    const adapter = new FlakyAdapter();
    adapter.enqueueOutcomes("fail-transient", "fail-transient", "ok");

    const result = await adapter.run({ task: "T" });

    expect(result.status).toBe("success");
    expect(result.attempts).toBe(3);
    expect(adapter.invocations).toBe(3);
    expect(adapter.observedDelays).toEqual([5_000, 15_000]);
    expect(result.warning).toContain("3 automatic attempts");
  });

  it("trips the breaker after five failing dispatches and fails fast without spawning", async () => {
    const adapter = new FlakyAdapter();

    for (let i = 0; i < 5; i++) {
      const result = await adapter.run({ task: `T${i}` });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("SPAWN_FAILED");
    }
    const invocationsAfterFive = adapter.invocations;
    expect(invocationsAfterFive).toBe(15);

    const sixth = await adapter.run({ task: "T5" });
    expect(adapter.invocations).toBe(invocationsAfterFive);
    expect(sixth.errorCode).toBe("CIRCUIT_OPEN");
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
    expect(sixth.retryAfterMs).toBeLessThanOrEqual(CIRCUIT_OPEN_DURATION_MS);
    expect(sixth.summary).toContain("circuit breaker");
  });

  it("does not trip when successes interrupt the failure streak", async () => {
    const adapter = new FlakyAdapter();
    // One invocation per dispatch (permanent failures are never retried):
    // 4 failures + success + 4 failures = never 5 consecutive logical failures.
    adapter.enqueueOutcomes(
      "fail-permanent",
      "fail-permanent",
      "fail-permanent",
      "fail-permanent",
      "ok",
      "fail-permanent",
      "fail-permanent",
      "fail-permanent",
      "fail-permanent",
    );

    for (let i = 0; i < 9; i++) {
      const result = await adapter.run({ task: `T${i}` });
      // Every dispatch executes for real (no fail-fast), whatever its outcome.
      expect(result.status === "success" || result.errorCode === "SPAWN_FAILED").toBe(true);
      expect(result.errorCode).not.toBe("CIRCUIT_OPEN");
    }
    // The tenth logical dispatch still executes instead of CIRCUIT_OPEN; its
    // unscripted failure is transient, so it consumes the full 3 attempts.
    const tenth = await adapter.run({ task: "T9" });
    expect(tenth.errorCode).toBe("SPAWN_FAILED");
    expect(adapter.invocations).toBe(12);
  });
});
