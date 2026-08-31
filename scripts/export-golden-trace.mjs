#!/usr/bin/env node
/**
 * Golden-trace exporter for the lossless-handoff evaluation baseline (plan A1).
 *
 * Reads an AgentMesh sessions.json store plus its sidecar context artifacts and
 * emits one trace JSON per recorded turn:
 *   { sessionId, turnIndex, agent, role, status, timestamp, cwd, task, summary?,
 *     handoff?, finalAnswer?, findings?, evidence?, sharedContextAudit?,
 *     contextSources?, reviewOutcome?, sidecarVerified, sidecarNote? }
 *
 * Data provenance is sessions.json + sidecars only — nothing is re-derived or
 * re-executed. A sidecar whose sha256 no longer matches the digest recorded in
 * the audit is exported with `sidecarVerified: false` and kept: bad data is
 * evidence. Every trace is validated against the zod schema below; traces that
 * fail validation are written to `<out>/_invalid/` and reported instead of
 * being silently dropped.
 *
 * Usage:
 *   node scripts/export-golden-trace.mjs --sessions <sessions.json> \
 *        [--session <bridgeSessionId>] [--out <dir>]
 *
 * Output: one `<sessionId>-turn-NNN.json` per turn (default output directory:
 * `<sessions dir>/golden-traces`) plus a `_summary.json` manifest.
 * Zero vendor/quota usage: offline by construction.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const RepositoryStateEvidenceSchema = z
  .object({
    capturedAt: z.string(),
    repositoryRoot: z.string(),
    head: z.string().optional(),
    dirty: z.boolean(),
    fingerprint: z.string(),
    changedPaths: z.array(z.string()),
    pathFingerprints: z.record(z.string()).optional(),
  })
  .passthrough();

const HandoffSummarySchema = z
  .object({
    goal: z.string(),
    outcome: z.enum(["success", "failed"]),
    keyDecisions: z.array(z.string()),
    artifacts: z.object({
      files: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
      tests: z.string().optional(),
    }),
    openItems: z.array(z.string()),
  })
  .passthrough();

const SharedContextAuditSchema = z
  .object({
    file: z.string().optional(),
    bytes: z.number(),
    sha256: z.string(),
    totalChars: z.number(),
    sources: z.array(
      z.object({ sessionId: z.string(), chars: z.number(), truncated: z.boolean() }),
    ),
    strategy: z.enum(["handoff", "legacy"]).optional(),
    estimatedTokens: z.number().optional(),
    budgetTokens: z.number().optional(),
    droppedSections: z.array(z.string()).optional(),
    injectedOwnHistory: z.boolean().optional(),
  })
  .passthrough();

const GoldenTraceSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string(),
    turnIndex: z.number().int().positive(),
    agent: z.string(),
    role: z.string(),
    status: z.enum(["success", "failed"]),
    timestamp: z.string(),
    cwd: z.string(),
    task: z.string(),
    summary: z.string().optional(),
    handoff: HandoffSummarySchema.optional(),
    finalAnswer: z.string().optional(),
    findings: z.array(z.unknown()).optional(),
    evidence: z
      .object({
        repositoryBefore: RepositoryStateEvidenceSchema.optional(),
        repositoryAfter: RepositoryStateEvidenceSchema.optional(),
        exitCode: z.number().optional(),
        durationMs: z.number().optional(),
        timedOut: z.boolean().optional(),
        aborted: z.boolean().optional(),
        cancelReason: z.string().optional(),
        transportUsed: z.string().optional(),
      })
      .passthrough()
      .optional(),
    sharedContextAudit: SharedContextAuditSchema.optional(),
    contextSources: z.array(z.string()).optional(),
    reviewOutcome: z.enum(["PASS", "FAIL", "UNKNOWN"]).optional(),
    sidecarVerified: z.boolean(),
    sidecarNote: z.string().optional(),
  })
  .passthrough();

function parseArgs(argv) {
  const args = { sessions: undefined, session: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sessions") args.sessions = argv[++i];
    else if (arg === "--session") args.session = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/export-golden-trace.mjs --sessions <sessions.json> [--session <id>] [--out <dir>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.sessions) throw new Error("--sessions <sessions.json> is required");
  return args;
}

/**
 * Best-effort review-verdict derivation. Session history does not persist the
 * reviewOutcome field, so reviewer verdicts are recovered from the normalized
 * summary the review pipeline writes ("Review PASSED/FAILED: ..."); anything
 * ambiguous stays unset rather than guessed.
 */
function deriveReviewOutcome(entry) {
  if (entry.role !== "reviewer") return undefined;
  const summary = entry.summary ?? "";
  if (/^Review PASSED\b/.test(summary)) return "PASS";
  if (/^Review FAILED\b/.test(summary)) return "FAIL";
  return undefined;
}

function verifySidecar(sessionsDir, audit) {
  if (!audit?.file) {
    return {
      sidecarVerified: false,
      sidecarNote: "no shared-context audit recorded for this turn",
    };
  }
  const sidecarPath = path.join(sessionsDir, audit.file);
  if (!existsSync(sidecarPath)) {
    return { sidecarVerified: false, sidecarNote: `sidecar file missing: ${audit.file}` };
  }
  try {
    const content = readFileSync(sidecarPath, "utf-8");
    const digest = createHash("sha256").update(content, "utf-8").digest("hex");
    if (digest !== audit.sha256) {
      return {
        sidecarVerified: false,
        // Kept on purpose: a mismatched sidecar is evidence of drift, not noise.
        sidecarNote: `sidecar sha256 mismatch (audit=${audit.sha256}, actual=${digest})`,
      };
    }
    return { sidecarVerified: true };
  } catch (error) {
    return {
      sidecarVerified: false,
      sidecarNote: `sidecar read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildTrace(session, entry, turnIndex, sessionsDir) {
  const evidence = entry.evidence
    ? {
        ...(entry.evidence.repositoryBefore
          ? { repositoryBefore: entry.evidence.repositoryBefore }
          : {}),
        ...(entry.evidence.repositoryAfter
          ? { repositoryAfter: entry.evidence.repositoryAfter }
          : {}),
        ...(entry.evidence.exitCode !== undefined ? { exitCode: entry.evidence.exitCode } : {}),
        ...(entry.evidence.durationMs !== undefined
          ? { durationMs: entry.evidence.durationMs }
          : {}),
        ...(entry.evidence.timedOut !== undefined ? { timedOut: entry.evidence.timedOut } : {}),
        ...(entry.evidence.aborted !== undefined ? { aborted: entry.evidence.aborted } : {}),
        ...(entry.evidence.cancelReason ? { cancelReason: entry.evidence.cancelReason } : {}),
        ...(entry.evidence.transportUsed ? { transportUsed: entry.evidence.transportUsed } : {}),
      }
    : undefined;
  const audit = entry.sharedContextAudit
    ? {
        file: entry.sharedContextAudit.file,
        bytes: entry.sharedContextAudit.bytes,
        sha256: entry.sharedContextAudit.sha256,
        totalChars: entry.sharedContextAudit.totalChars,
        sources: entry.sharedContextAudit.sources,
        ...(entry.sharedContextAudit.strategy
          ? { strategy: entry.sharedContextAudit.strategy }
          : {}),
        ...(entry.sharedContextAudit.estimatedTokens !== undefined
          ? { estimatedTokens: entry.sharedContextAudit.estimatedTokens }
          : {}),
        ...(entry.sharedContextAudit.budgetTokens !== undefined
          ? { budgetTokens: entry.sharedContextAudit.budgetTokens }
          : {}),
        ...(entry.sharedContextAudit.droppedSections
          ? { droppedSections: entry.sharedContextAudit.droppedSections }
          : {}),
        ...(entry.sharedContextAudit.injectedOwnHistory !== undefined
          ? { injectedOwnHistory: entry.sharedContextAudit.injectedOwnHistory }
          : {}),
      }
    : undefined;
  const sidecar = verifySidecar(sessionsDir, entry.sharedContextAudit);
  const reviewOutcome = deriveReviewOutcome(entry);

  return {
    schemaVersion: 1,
    sessionId: session.id,
    turnIndex,
    agent: session.agent,
    role: entry.role,
    status: entry.status,
    timestamp: entry.timestamp,
    cwd: session.cwd,
    task: entry.task,
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.handoff ? { handoff: entry.handoff } : {}),
    ...(entry.finalAnswer ? { finalAnswer: entry.finalAnswer } : {}),
    ...(entry.findings?.length ? { findings: entry.findings } : {}),
    ...(evidence ? { evidence } : {}),
    ...(audit ? { sharedContextAudit: audit } : {}),
    ...(entry.contextSources?.length ? { contextSources: entry.contextSources } : {}),
    ...(reviewOutcome ? { reviewOutcome } : {}),
    sidecarVerified: sidecar.sidecarVerified,
    ...(sidecar.sidecarNote ? { sidecarNote: sidecar.sidecarNote } : {}),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionsPath = path.resolve(args.sessions);
  if (!existsSync(sessionsPath)) {
    throw new Error(`Sessions file not found: ${sessionsPath}`);
  }
  const sessionsDir = path.dirname(sessionsPath);
  const sessions = JSON.parse(readFileSync(sessionsPath, "utf-8"));
  if (!Array.isArray(sessions)) throw new Error(`Expected a JSON array in ${sessionsPath}`);

  const selected = args.session
    ? sessions.filter((session) => session.id === args.session)
    : sessions;
  if (args.session && selected.length === 0) {
    throw new Error(`Session '${args.session}' not found in ${sessionsPath}`);
  }

  const outDir = path.resolve(args.out ?? path.join(sessionsDir, "golden-traces"));
  const invalidDir = path.join(outDir, "_invalid");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(invalidDir, { recursive: true });

  const manifest = { sessionsFile: sessionsPath, exported: 0, invalid: 0, traces: [] };
  for (const session of selected) {
    session.history.forEach((entry, offset) => {
      const turnIndex = offset + 1;
      const trace = buildTrace(session, entry, turnIndex, sessionsDir);
      const baseName = `${session.id}-turn-${String(turnIndex).padStart(3, "0")}.json`;
      const parsed = GoldenTraceSchema.safeParse(trace);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
        writeFileSync(
          path.join(invalidDir, baseName),
          JSON.stringify({ trace, schemaErrors: issues }, null, 2),
          "utf-8",
        );
        manifest.invalid += 1;
        manifest.traces.push({ file: `_invalid/${baseName}`, schemaValid: false, errors: issues });
        console.error(`[invalid] ${session.id} turn ${turnIndex}: ${issues.join("; ")}`);
        return;
      }
      writeFileSync(path.join(outDir, baseName), JSON.stringify(parsed.data, null, 2), "utf-8");
      manifest.exported += 1;
      manifest.traces.push({
        file: baseName,
        schemaValid: true,
        sessionId: session.id,
        turnIndex,
        role: entry.role,
        status: entry.status,
        hasHandoff: Boolean(entry.handoff),
        sidecarVerified: trace.sidecarVerified,
      });
    });
  }

  writeFileSync(path.join(outDir, "_summary.json"), JSON.stringify(manifest, null, 2), "utf-8");
  const sidecarOk = manifest.traces.filter((t) => t.schemaValid && t.sidecarVerified).length;
  const sidecarBad = manifest.traces.filter((t) => t.schemaValid && !t.sidecarVerified).length;
  console.log(
    `Exported ${manifest.exported} golden trace(s) to ${outDir} ` +
      `(${manifest.invalid} invalid, ${sidecarOk} sidecar-verified, ${sidecarBad} sidecar-unverified).`,
  );
}

main();
