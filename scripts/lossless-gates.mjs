#!/usr/bin/env node
/**
 * Offline lossless-gate calculator for golden traces (plan A2, zero quota).
 *
 * Consumes the traces produced by scripts/export-golden-trace.mjs and computes
 * the first three gates of the lossless-handoff evaluation framework as
 * proxy metrics:
 *
 *   structural — handoff presence, per-field coverage of the handoff contract,
 *                and the share of turns rendered through the legacy fallback
 *                (the "no structured handoff" exposure surface).
 *   evidence   — handoff artifact files locatable against the recorded
 *                repositoryAfter.changedPaths and (when the trace cwd still
 *                exists on disk) the filesystem; plus command coverage.
 *   semantic   — EXACT typed-token diff (paths/versions/commands/counts/hashes)
 *                between the turn's finalAnswer and its handoff: precise values
 *                present in the answer but missing from the handoff. A proxy,
 *                not end-to-end task fidelity.
 *   behavioral — NOT computable offline. The report explicitly marks it as
 *                "requires R19 differential round"; no number is fabricated.
 *
 * Usage:
 *   node scripts/lossless-gates.mjs --traces <golden-traces dir> [--out <report.json>]
 *
 * The script imports the product extractor from dist/ so the gate logic and
 * the runtime share one implementation. Run `npm run build` first.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let extractTypedTokens;
let diffTypedTokens;
let findUngroundedHandoffFiles;
try {
  ({ extractTypedTokens, diffTypedTokens, findUngroundedHandoffFiles } = await import(
    pathToFileURL(path.join(repoRoot, "dist", "index.js"))
  ));
} catch (error) {
  console.error(
    `Cannot load the typed-token engine from dist/index.js (${error instanceof Error ? error.message : String(error)}). Run 'npm run build' first.`,
  );
  process.exit(1);
}

import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { traces: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--traces") args.traces = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/lossless-gates.mjs --traces <dir> [--out <report.json>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.traces) throw new Error("--traces <golden-traces dir> is required");
  return args;
}

function loadTraces(tracesDir) {
  const files = readdirSync(tracesDir).filter(
    (file) => file.endsWith(".json") && file !== "_summary.json" && !file.startsWith("_"),
  );
  const traces = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(path.join(tracesDir, file), "utf-8"));
    // Shape guard: the report itself (or any non-trace JSON) may live in the
    // directory; only objects with the golden-trace identity keys count.
    if (parsed && typeof parsed === "object" && parsed.sessionId && parsed.turnIndex) {
      traces.push({ file, trace: parsed });
    } else {
      console.warn(`[skipped] ${file}: not a golden trace`);
    }
  }
  return traces;
}

/** Flattens a handoff to the text surface downstream agents actually receive. */
function handoffText(handoff) {
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

function rate(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function computeStructural(traces) {
  const total = traces.length;
  const withHandoff = traces.filter((t) => Boolean(t.handoff)).length;
  const handoffTurns = traces.filter((t) => t.handoff);
  const rawCoverage = {
    goal: handoffTurns.filter((t) => t.handoff.goal?.trim()).length,
    decisions: handoffTurns.filter((t) => (t.handoff.keyDecisions ?? []).length > 0).length,
    files: handoffTurns.filter((t) => (t.handoff.artifacts.files ?? []).length > 0).length,
    commands: handoffTurns.filter((t) => (t.handoff.artifacts.commands ?? []).length > 0).length,
    tests: handoffTurns.filter((t) => Boolean(t.handoff.artifacts.tests?.trim())).length,
    openItems: handoffTurns.filter((t) => (t.handoff.openItems ?? []).length > 0).length,
  };
  const fieldCoverage = {};
  for (const key of Object.keys(rawCoverage)) {
    fieldCoverage[key] = {
      turns: rawCoverage[key],
      rate: rate(rawCoverage[key], handoffTurns.length),
    };
  }
  const legacy = traces.filter((t) => t.sharedContextAudit?.strategy === "legacy").length;
  const handoffStrategy = traces.filter((t) => t.sharedContextAudit?.strategy === "handoff").length;
  const noAudit = total - legacy - handoffStrategy;
  return {
    handoffPresence: { withHandoff, total, rate: rate(withHandoff, total) },
    fieldCoverage,
    legacyExposure: {
      legacyRenders: legacy,
      handoffRenders: handoffStrategy,
      noInjectionAudit: noAudit,
      total,
      legacyRate: rate(legacy, total),
      note: "legacy = the turn's injection used the pre-handoff replay fallback; noInjectionAudit = the turn recorded no shared-context audit (never injected or predates the audit).",
    },
  };
}

function computeEvidenceGate(traces) {
  let totalClaims = 0;
  let located = 0;
  let ungrounded = 0;
  let unverifiable = 0;
  let existenceUnknown = 0;
  const perTurn = [];

  for (const { file, trace } of traces) {
    const claims = trace.handoff?.artifacts?.files ?? [];
    if (claims.length === 0) {
      perTurn.push({ file, sessionId: trace.sessionId, turnIndex: trace.turnIndex, claims: 0 });
      continue;
    }
    const changedPaths = trace.evidence?.repositoryAfter?.changedPaths ?? [];
    // Offline honesty guard: existence checks only run when the recorded cwd
    // still exists on disk. A missing workspace must not fabricate "ungrounded".
    const cwdUsable = Boolean(trace.cwd) && existsSync(trace.cwd);
    const result = findUngroundedHandoffFiles(claims, {
      ...(cwdUsable ? { cwd: trace.cwd } : {}),
      changedPaths,
    });
    totalClaims += claims.length;
    if (cwdUsable) {
      located += claims.length - result.ungrounded.length - result.unverifiable;
      ungrounded += result.ungrounded.length;
      unverifiable += result.unverifiable;
    } else {
      // Without a filesystem, only changedPaths matching is evidence; the rest
      // is reported as existence-unknown rather than ungrounded.
      const matched = claims.length - result.ungrounded.length;
      located += matched;
      existenceUnknown += result.ungrounded.length;
    }
    perTurn.push({
      file,
      sessionId: trace.sessionId,
      turnIndex: trace.turnIndex,
      claims: claims.length,
      located: cwdUsable
        ? claims.length - result.ungrounded.length - result.unverifiable
        : claims.length - result.ungrounded.length,
      ungrounded: cwdUsable ? result.ungrounded : [],
      unverifiable: result.unverifiable,
      existenceUnknown: cwdUsable ? 0 : result.ungrounded.length,
      cwdUsable,
    });
  }

  return {
    fileGrounding: {
      totalClaims,
      located,
      ungrounded,
      ungroundedRate: rate(ungrounded, totalClaims),
      unverifiable,
      existenceUnknown,
      note: "located = matched against repositoryAfter.changedPaths or found on disk; unverifiable = filesystem error; existenceUnknown = claim not in recorded changes and the recorded working tree no longer exists, so existence could not be checked (counted neither as located nor ungrounded).",
    },
    perTurn,
  };
}

function computeSemanticGate(traces) {
  const perTurn = [];
  const missingHistogram = new Map();
  let turnsCompared = 0;
  let turnsWithMissing = 0;
  let missingTotal = 0;
  let extraTotal = 0;

  for (const { file, trace } of traces) {
    if (!trace.finalAnswer || !trace.handoff) {
      perTurn.push({
        file,
        sessionId: trace.sessionId,
        turnIndex: trace.turnIndex,
        compared: false,
        reason: !trace.finalAnswer ? "no finalAnswer recorded" : "no handoff recorded",
      });
      continue;
    }
    turnsCompared += 1;
    const source = extractTypedTokens(trace.finalAnswer);
    const comparison = extractTypedTokens(handoffText(trace.handoff));
    const diff = diffTypedTokens(source, comparison);
    const turnMissing = [];
    const turnExtra = [];
    for (const category of Object.keys(diff)) {
      for (const value of diff[category].missing) {
        turnMissing.push({ category, value });
        missingHistogram.set(
          `${category}:${value}`,
          (missingHistogram.get(`${category}:${value}`) ?? 0) + 1,
        );
      }
      turnExtra.push(...diff[category].extra.map((value) => ({ category, value })));
    }
    missingTotal += turnMissing.length;
    extraTotal += turnExtra.length;
    if (turnMissing.length > 0) turnsWithMissing += 1;
    perTurn.push({
      file,
      sessionId: trace.sessionId,
      turnIndex: trace.turnIndex,
      compared: true,
      missing: turnMissing,
      extra: turnExtra,
    });
  }

  const topMissing = [...missingHistogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([key, count]) => {
      const separator = key.indexOf(":");
      return {
        category: key.slice(0, separator),
        value: key.slice(separator + 1),
        turnsMissing: count,
      };
    });

  return {
    turnsCompared,
    turnsWithMissing,
    missingTotal,
    extraTotal,
    topMissing,
    perTurn,
    note: "missing = typed token present in the turn's finalAnswer but absent from its handoff (the information-loss direction). extra = claimed by the handoff without appearing in the answer. Exact string comparison, no embeddings.",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracesDir = path.resolve(args.traces);
  if (!existsSync(tracesDir)) throw new Error(`Traces directory not found: ${tracesDir}`);
  const traces = loadTraces(tracesDir);
  if (traces.length === 0) throw new Error(`No trace JSON files found in ${tracesDir}`);

  const structural = computeStructural(traces.map((t) => t.trace));
  const evidence = computeEvidenceGate(traces);
  const semantic = computeSemanticGate(traces);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tracesDir,
    traceCount: traces.length,
    gates: {
      structural,
      evidence: {
        fileGrounding: evidence.fileGrounding,
      },
      semanticProxy: {
        turnsCompared: semantic.turnsCompared,
        turnsWithMissing: semantic.turnsWithMissing,
        missingTotal: semantic.missingTotal,
        extraTotal: semantic.extraTotal,
        topMissing: semantic.topMissing,
        note: semantic.note,
      },
      behavioral: {
        status: "requires R19 differential round",
        note: "Behavioral losslessness (does the downstream agent perform as well with the handoff injection as with the full transcript?) is not computable offline. It needs the opt-in R19 differential round with real vendor models; no placeholder metric is recorded here.",
      },
    },
    perTurn: {
      evidence: evidence.perTurn,
      semantic: semantic.perTurn,
    },
    limitations: [
      "Structural, evidence, and semantic gates are proxy metrics over recorded traces; they are not end-to-end task-fidelity measurements.",
      "The semantic gate compares exact typed tokens only; semantic paraphrases and untyped facts are invisible to it.",
      "File-existence checks run against the CURRENT state of the recorded working directories, which may have changed since the turns executed; changedPaths matching uses only what the turn recorded.",
      "Turns without a recorded finalAnswer (failed/cancelled vendor runs) are excluded from the semantic comparison and reported as such.",
      "Behavioral losslessness is explicitly not computed here (see gates.behavioral).",
    ],
  };

  const outPath = path.resolve(args.out ?? path.join(tracesDir, "lossless-gates-report.json"));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`Lossless gates over ${traces.length} trace(s) — report: ${outPath}`);
  console.log(
    `  structural: handoff ${structural.handoffPresence.withHandoff}/${structural.handoffPresence.total}` +
      ` (${Math.round((structural.handoffPresence.rate ?? 0) * 100)}%), legacy exposure ${structural.legacyExposure.legacyRenders}/${structural.legacyExposure.total}`,
  );
  const fg = report.gates.evidence.fileGrounding;
  console.log(
    `  evidence:   files located ${fg.located}/${fg.totalClaims}, ungrounded ${fg.ungrounded}, unverifiable ${fg.unverifiable}, existence-unknown ${fg.existenceUnknown}`,
  );
  console.log(
    `  semantic:   ${semantic.turnsWithMissing}/${semantic.turnsCompared} compared turn(s) lost typed tokens (${semantic.missingTotal} missing, ${semantic.extraTotal} extra)`,
  );
  console.log("  behavioral: requires R19 differential round (not computed offline)");
  console.log("  limitations: proxy metrics — see the report's limitations section");
}

main();
