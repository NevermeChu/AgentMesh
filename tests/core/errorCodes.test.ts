import { describe, it, expect } from "vitest";
import { classifyErrorCode } from "../../src/core/resilience.js";
import { formatNormalizedResult } from "../../src/mcp/tools.js";
import type { AgentResult } from "../../src/agents/types.js";

describe("core/resilience error classification (P1 T1.2)", () => {
  it("classifies every reason code from at least one trigger path", () => {
    const cases: Array<{
      code: string;
      signal: { message?: string; exitCode?: number; timedOut?: boolean; aborted?: boolean };
    }> = [
      { code: "SPAWN_FAILED", signal: { message: "spawn codex ENOENT" } },
      {
        code: "SPAWN_FAILED",
        signal: { message: "'foo' is not recognized as an internal or external command" },
      },
      { code: "SPAWN_FAILED", signal: { message: "unknown crash", exitCode: 127 } },
      { code: "TIMEOUT", signal: { message: "process killed after limit", timedOut: true } },
      { code: "CANCELLED", signal: { message: "anything", aborted: true } },
      {
        code: "MODEL_REJECTED",
        signal: { message: "API error: model 'gpt-next' is not supported for this account" },
      },
      {
        code: "MODEL_REJECTED",
        signal: { message: "Access denied: does not have access to model o4-mini" },
      },
      {
        code: "TRANSIENT_5XX",
        signal: { message: "stream_error: upstream disconnected", exitCode: 1 },
      },
      {
        code: "TRANSIENT_5XX",
        signal: { message: "request failed with status 503 service unavailable" },
      },
      { code: "TRANSIENT_5XX", signal: { message: "connect ECONNREFUSED 127.0.0.1:443" } },
      {
        code: "TRANSIENT_5XX",
        signal: { message: "rate limited: too many requests, retry later" },
      },
      {
        code: "SANDBOX_UNAVAILABLE",
        signal: { message: "the OS sandbox is not enabled; write tasks were downgraded" },
      },
      { code: "PARSE_FAILURE", signal: { message: "Unexpected token '<' in JSON at position 0" } },
      {
        code: "PARSE_FAILURE",
        signal: { message: "malformed JSONL output: failed to parse event stream" },
      },
      {
        code: "ARG_REJECTED",
        signal: {
          message:
            "Additional CLI arguments are not allowed for Codex Reviewer tasks because they could override safety controls.",
        },
      },
      {
        code: "ARG_REJECTED",
        signal: { message: "CLI mode is not supported by Grok. Supported modes: mcp." },
      },
    ];

    for (const { code, signal } of cases) {
      expect(classifyErrorCode(signal), JSON.stringify(signal)).toBe(code);
    }
  });

  it("keeps unclassified failures honest (no fabricated default)", () => {
    expect(classifyErrorCode({ message: "Simulated agent error" })).toBeUndefined();
    expect(classifyErrorCode({})).toBeUndefined();
    expect(classifyErrorCode({ message: "", exitCode: 1 })).toBeUndefined();
  });

  it("applies cancellation and timeout priority over message content", () => {
    expect(classifyErrorCode({ message: "connection refused while spawning", aborted: true })).toBe(
      "CANCELLED",
    );
    expect(classifyErrorCode({ message: "spawn ENOENT during teardown", timedOut: true })).toBe(
      "TIMEOUT",
    );
  });
});

describe("mcp/tools error_code surfacing (P1 T1.2)", () => {
  const baseResult: AgentResult = {
    status: "failed",
    agent: "codex",
    summary: "Failed",
    output: "boom",
    error: "boom",
  };

  it("renders an error_code line inside the Error section when classified", () => {
    const lines = formatNormalizedResult({
      ...baseResult,
      errorCode: "TRANSIENT_5XX",
    });
    const errorIndex = lines.findIndex((line) => line.startsWith("Error:"));
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(lines[errorIndex + 1]).toBe("error_code: TRANSIENT_5XX");
  });

  it("omits the error_code line when the failure stays unclassified", () => {
    const lines = formatNormalizedResult(baseResult);
    expect(lines.some((line) => line.startsWith("error_code:"))).toBe(false);
    expect(lines).toContain("Error: boom");
  });
});
