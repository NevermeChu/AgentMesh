import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffTypedTokens, extractTypedTokens, parseHandoffReport } from "../../src/core/handoff.js";
import type { TypedTokens } from "../../src/core/handoff.js";
import type { HandoffSummary } from "../../src/core/types.js";
import { buildSharedContextDetailed, MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

/**
 * Adversarial perturbation matrix for the handoff pipeline (lossless-handoff
 * plan B3). Six perturbation classes plus a paraphrase control verify what the
 * pipeline can honestly guarantee: the injection relay is FAITHFUL (edits are
 * never lost or silently corrected), typed exact tokens track perturbations
 * precisely, and file perturbations are caught by the recordTurn grounding
 * check. Semantic-equivalent rewrites must NOT trigger anything (no false
 * positives). This suite validates pipeline fidelity, not the ability to see
 * through a vendor's semantic-level lies.
 */

const TASK = "Add rate limiting to the login endpoint";

function goldenFinalAnswer(): string {
  return [
    "I finished the auth rate-limiting work and verified it.",
    "",
    "## Goal",
    "- Add in-memory rate limiting to the login endpoint",
    "",
    "## Decisions",
    "- Chose in-memory rate limiting because persistence was out of scope",
    "- Kept the legacy session cookie for one release",
    "",
    "## Files",
    "- src/auth/login.ts",
    "- src/auth/login.test.ts",
    "",
    "## Commands",
    "- npm test -- auth",
    "",
    "## Tests",
    "42 passed, 0 failed, version 1.2.3 published",
    "",
    "## Open Items",
    "- Rate limiting still uses the in-memory store",
    "- Deployment needs the release 2.0 flag",
  ].join("\n");
}

function parseHandoff(finalAnswer: string): HandoffSummary {
  const handoff = parseHandoffReport(finalAnswer, TASK, "success");
  if (!handoff) throw new Error("Golden fixture must always produce a handoff");
  return handoff;
}

/** Flattens a handoff back to text so token extraction sees what injection would relay. */
function handoffText(handoff: HandoffSummary): string {
  return [
    handoff.goal,
    ...handoff.keyDecisions,
    ...(handoff.artifacts.files ?? []),
    ...(handoff.artifacts.commands ?? []),
    handoff.artifacts.tests ?? "",
    ...handoff.openItems,
  ]
    .filter(Boolean)
    .join("\n");
}

function goldenTokens(): TypedTokens {
  return extractTypedTokens(handoffText(parseHandoff(goldenFinalAnswer())));
}

function sessionWithAnswer(finalAnswer: string) {
  const handoff = parseHandoff(finalAnswer);
  return {
    id: "bridge-sess_golden",
    agent: "codex" as AgentName,
    cwd: "/nonexistent/repo",
    role: "worker" as const,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    history: [
      {
        role: "worker" as const,
        task: TASK,
        timestamp: "2026-08-30T00:00:00.000Z",
        status: "success" as const,
        summary: "Added in-memory rate limiting",
        finalAnswer,
        handoff,
      },
    ],
  };
}

function renderInjection(finalAnswer: string): string {
  return buildSharedContextDetailed([sessionWithAnswer(finalAnswer)])?.text ?? "";
}

describe("core/handoff perturbation matrix", () => {
  describe("entity substitution (file path swapped)", () => {
    const perturbed = goldenFinalAnswer().replace("src/auth/login.ts", "src/auth/session.ts");

    it("relays the substituted entity verbatim and drops the original", () => {
      const text = renderInjection(perturbed);

      expect(text).toContain("src/auth/session.ts");
      expect(text).not.toContain("src/auth/login.ts");
    });

    it("is captured exactly by the typed-token diff (no fuzzy residue)", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      expect(diff.paths).toEqual({
        missing: ["src/auth/login.ts"],
        extra: ["src/auth/session.ts"],
      });
      for (const category of ["versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("numeric tampering (test count altered)", () => {
    const perturbed = goldenFinalAnswer().replace("42 passed", "41 passed");

    it("relays the tampered value verbatim and drops the original", () => {
      const text = renderInjection(perturbed);

      expect(text).toContain("41 passed");
      expect(text).not.toContain("42 passed");
    });

    it("is captured exactly by the typed-token diff", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      expect(diff.counts).toEqual({ missing: ["42"], extra: ["41"] });
      for (const category of ["paths", "versions", "commands", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("negation insertion", () => {
    const perturbed = goldenFinalAnswer().replace(
      "Rate limiting still uses the in-memory store",
      "Rate limiting no longer uses the in-memory store",
    );

    it("relays the negation verbatim instead of silently correcting it", () => {
      const text = renderInjection(perturbed);

      expect(text).toContain("no longer uses the in-memory store");
      expect(text).not.toContain("still uses the in-memory store");
    });

    it("changes no typed tokens (negation is semantic, not exact-match)", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      for (const category of ["paths", "versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("constraint deletion (open item removed)", () => {
    const perturbed = goldenFinalAnswer().replace("\n- Deployment needs the release 2.0 flag", "");

    it("no longer relays the deleted constraint", () => {
      const text = renderInjection(perturbed);

      expect(text).not.toContain("Deployment needs the release 2.0 flag");
      expect(parseHandoff(perturbed).openItems).toHaveLength(1);
    });

    it("changes no typed tokens (the deleted item carried none)", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      for (const category of ["paths", "versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("causal inversion", () => {
    const perturbed = goldenFinalAnswer().replace(
      "Chose in-memory rate limiting because persistence was out of scope",
      "Persistence was out of scope because in-memory rate limiting was chosen",
    );

    it("relays the inverted causality verbatim instead of silently fixing it", () => {
      const text = renderInjection(perturbed);

      expect(text).toContain(
        "Persistence was out of scope because in-memory rate limiting was chosen",
      );
      expect(text).not.toContain(
        "Chose in-memory rate limiting because persistence was out of scope",
      );
    });

    it("changes no typed tokens", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      for (const category of ["paths", "versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("temporal reordering (decisions swapped)", () => {
    const perturbed = [
      "I finished the auth rate-limiting work and verified it.",
      "",
      "## Goal",
      "- Add in-memory rate limiting to the login endpoint",
      "",
      "## Decisions",
      "- Kept the legacy session cookie for one release",
      "- Chose in-memory rate limiting because persistence was out of scope",
      "",
      "## Files",
      "- src/auth/login.ts",
      "- src/auth/login.test.ts",
      "",
      "## Commands",
      "- npm test -- auth",
      "",
      "## Tests",
      "42 passed, 0 failed, version 1.2.3 published",
      "",
      "## Open Items",
      "- Rate limiting still uses the in-memory store",
      "- Deployment needs the release 2.0 flag",
    ].join("\n");

    it("preserves the reordered sequence instead of restoring the original", () => {
      const text = renderInjection(perturbed);
      const cookie = text.indexOf("Kept the legacy session cookie");
      const inMemory = text.indexOf("Chose in-memory rate limiting");

      expect(cookie).toBeGreaterThan(-1);
      expect(inMemory).toBeGreaterThan(-1);
      expect(cookie).toBeLessThan(inMemory);
    });

    it("changes no typed tokens (reordering is not information loss)", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(perturbed))),
      );

      for (const category of ["paths", "versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });
  });

  describe("paraphrase control (semantically equivalent rewrite)", () => {
    // Same facts, different surface form: heading style, synonyms, backtick
    // wrapping, and appended prose around unchanged precise values.
    const paraphrased = [
      "I finished the auth rate-limiting work and verified it.",
      "",
      "**Decisions**:",
      "- Selected in-memory rate limiting since persistence was out of scope",
      "- Kept the legacy session cookie for one release",
      "",
      "**Files**:",
      "- `src/auth/login.ts`",
      "- `src/auth/login.test.ts`",
      "",
      "**Commands**:",
      "- `npm test -- auth`",
      "",
      "**Tests**:",
      "42 passed, 0 failed — version 1.2.3 was published",
      "",
      "**Open Items**:",
      "- Rate limiting still uses the in-memory store",
      "- Deployment needs the release 2.0 flag",
    ].join("\n");

    it("still produces a handoff with identical typed tokens (no false positive)", () => {
      const diff = diffTypedTokens(
        goldenTokens(),
        extractTypedTokens(handoffText(parseHandoff(paraphrased))),
      );

      for (const category of ["paths", "versions", "commands", "counts", "hashes"] as const) {
        expect(diff[category]).toEqual({ missing: [], extra: [] });
      }
    });

    it("relays the paraphrase itself faithfully (normalization must not rewrite it back)", () => {
      const text = renderInjection(paraphrased);

      expect(text).toContain("Selected in-memory rate limiting since persistence was out of scope");
      expect(text).toContain("version 1.2.3 was published");
      // Backtick wrappers are stripped by the documented parse-boundary
      // normalization (cleanItemLine); the relay-fidelity check therefore
      // targets the paraphrased prose and precise values, not the wrappers.
      expect(text).toContain("src/auth/login.ts");
    });
  });
});

class FixtureAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Fixture Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "FIXTURE_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public answer = goldenFinalAnswer();

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    void options;
    return {
      status: "success",
      agent: this.name,
      summary: "Fixture answer emitted",
      output: "Executed fixture task",
      finalAnswer: this.answer,
      exitCode: 0,
      durationMs: 5,
    };
  }
}

describe("core/handoff perturbation × recordTurn grounding check", () => {
  let runner: MultiAgentRunner;
  let registry: AgentRegistry;
  let adapter: FixtureAdapter;
  let workspace: string;

  beforeEach(() => {
    registry = new AgentRegistry();
    adapter = new FixtureAdapter();
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, new SessionManager({ persist: false }));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-perturb-"));
    fs.mkdirSync(path.join(workspace, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "auth", "login.ts"), "export {};\n");
    fs.writeFileSync(path.join(workspace, "src", "auth", "login.test.ts"), "export {};\n");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("raises no grounding warning when the handoff files are faithful", async () => {
    const result = await runner.delegateTask({ agent: "codex", task: TASK, cwd: workspace });

    expect(result.status).toBe("success");
    expect(result.warning ?? "").not.toContain("Handoff grounding");
  });

  it("flags entity-substituted (nonexistent) files as ungrounded", async () => {
    adapter.answer = goldenFinalAnswer().replace("src/auth/login.ts", "src/auth/ghost-file.ts");

    const result = await runner.delegateTask({ agent: "codex", task: TASK, cwd: workspace });

    expect(result.status).toBe("success");
    expect(result.warning).toContain("Handoff grounding");
    expect(result.warning).toContain("src/auth/ghost-file.ts");
    expect(result.warning).not.toContain("src/auth/login.test.ts");
  });
});
