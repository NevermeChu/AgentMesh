#!/usr/bin/env node
/**
 * External vendor-process resource sampler for real-test evidence
 * (reference/agentmesh-coverage-evidence-escalation-plan.md, Workstream B1).
 *
 * AgentMesh's built-in resourceEvidence only covers the AgentMesh process
 * itself (collection: "process"). This sampler fills the vendor gap: it
 * samples the process tree rooted at a seed PID (any ancestor of the vendor
 * child works — the AgentMesh server PID or the vendor child PID itself) and
 * records CPU-seconds, RSS, command lines and creation times as JSONL.
 *
 * Usage:
 *   node scripts/resource-sampler.mjs --pid <seedPid> --out <samples.jsonl> \
 *     [--interval-ms 3000] [--stop-file <path>] [--summary <path>] \
 *     [--max-duration-ms <ms>] [--vendor-regex "codex|opencode|..."]
 *
 * The sampler runs until the stop file appears (checked at ~200ms granularity),
 * SIGINT/SIGTERM is received, or --max-duration-ms elapses. When it stops it
 * runs an orphan check: vendor-binary processes (Name or CommandLine matching
 * the vendor regex) created inside the sampling window that are still alive.
 * Zero orphans is the expectation; anything else must be reported as-is.
 *
 * The real-test driver should annotate the turn's resourceEvidence with
 * note: "external sampler: <jsonl path>" (collection: "external") and compare
 * the per-process firstSeen/lastSeen lifecycle against the turn's durationMs.
 *
 * Declared limitations (report them with the evidence):
 * - Windows-only (PowerShell Get-CimInstance / Win32_Process). Linux/macOS
 *   (/proc, ps) are future work.
 * - Sampling is periodic: sub-second RSS/CPU spikes are invisible. CPU values
 *   are cumulative process-lifetime seconds, not per-interval usage.
 * - WMI counter granularity differs from Task Manager; numbers are for trend
 *   and anomaly discovery, not precise pricing or accounting.
 * - The orphan check matches vendor binaries by name/command line inside the
 *   creation window, so vendor processes started by unrelated work in the same
 *   window can surface as false positives — cross-check the command lines.
 * - Processes that exit between ticks still appear in samples with their final
 *   cumulative counters, but may be missed entirely if they live shorter than
 *   one interval.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_VENDOR_REGEX = "codex|opencode|antigravity|grok|gemini|claude|zcode";
const DEFAULT_INTERVAL_MS = 3_000;
const STOP_POLL_SLICE_MS = 200;
const WINDOW_SLACK_MS = 1_000;

function usage() {
  return [
    "Usage: node scripts/resource-sampler.mjs --pid <seedPid> --out <samples.jsonl>",
    "  [--interval-ms 3000] [--stop-file <path>] [--summary <path>]",
    "  [--max-duration-ms <ms>] [--vendor-regex <pattern>]",
  ].join("\n");
}

function fail(message) {
  console.error(`resource-sampler: ${message}`);
  console.error(usage());
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument '${token}'`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`option --${key} requires a value`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer, got '${value}'`);
  }
  return parsed;
}

/** One batched full-process-table query via Windows PowerShell. */
function queryProcesses() {
  const psScript = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$ErrorActionPreference='SilentlyContinue';",
    "ConvertTo-Json -Compress -Depth 3 -InputObject @(Get-CimInstance Win32_Process |",
    "ForEach-Object { [pscustomobject]@{",
    "pid=$_.ProcessId;",
    "ppid=$_.ParentProcessId;",
    "name=$_.Name;",
    "cpuSec=(($_.KernelModeTime+$_.UserModeTime)/1e7);",
    "rss=$_.WorkingSetSize;",
    "cmd=$_.CommandLine;",
    'created=("{0:yyyy-MM-ddTHH:mm:ss.fffzzz}" -f $_.CreationDate)',
    "} })",
  ].join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`powershell exited with code ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (error) {
        reject(new Error(`failed to parse process table JSON: ${error.message}`));
      }
    });
  });
}

/** Rows in the downward closure of the seed PID, plus the seed row itself. */
function treeClosure(rows, seedPid) {
  const childrenOf = new Map();
  for (const row of rows) {
    const parent = Number(row.ppid);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(row);
  }
  const closure = new Map();
  const stack = [Number(seedPid)];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const row of childrenOf.get(current) ?? []) {
      const pid = Number(row.pid);
      if (closure.has(pid)) continue;
      closure.set(pid, row);
      stack.push(pid);
    }
  }
  const seed = rows.find((row) => Number(row.pid) === Number(seedPid));
  if (seed) closure.set(Number(seedPid), seed);
  return [...closure.values()];
}

function sleepWhileWatchingStopFile(deadline, stopFile) {
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() >= deadline || (stopFile && fs.existsSync(stopFile))) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(STOP_POLL_SLICE_MS, Math.max(1, deadline - Date.now())));
    };
    tick();
  });
}

function roundCpu(cpuSec) {
  const value = Number(cpuSec);
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

function normalizeSample(row) {
  return {
    pid: Number(row.pid),
    ppid: Number(row.ppid),
    name: row.name ?? null,
    cpuSec: roundCpu(row.cpuSec),
    rssBytes: Number.isFinite(Number(row.rss)) ? Number(row.rss) : null,
    cmd: row.cmd ?? null,
    created: row.created || null,
  };
}

/**
 * PIDs that belong to the measurement harness itself: the sampler process,
 * its ancestors (driver shells whose argv embeds the --vendor-regex pattern
 * and would self-match it), and the sampler's own descendants (the per-tick
 * PowerShell queries). Ancestors' other children are NOT excluded — a vendor
 * child spawned as a sibling by the same driver is a legitimate target.
 */
function harnessPids(rows) {
  const byPid = new Map(rows.map((row) => [Number(row.pid), row]));
  const excluded = new Set([process.pid]);
  let current = process.ppid;
  while (current && byPid.has(Number(current)) && !excluded.has(Number(current))) {
    excluded.add(Number(current));
    current = Number(byPid.get(Number(current))?.ppid) || 0;
  }
  const stack = [process.pid];
  while (stack.length > 0) {
    const parent = stack.pop();
    for (const row of rows) {
      const pid = Number(row.pid);
      if (!excluded.has(pid) && Number(row.ppid) === parent) {
        excluded.add(pid);
        stack.push(pid);
      }
    }
  }
  return excluded;
}

async function main() {
  if (process.platform !== "win32") {
    console.error("resource-sampler: this sampler is Windows-only (PowerShell Win32_Process).");
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.pid) fail("--pid is required (seed PID; any ancestor of the vendor child works)");
  if (!args.out) fail("--out is required (JSONL output path)");
  const seedPid = parsePositiveInt(args.pid, "--pid");
  const intervalMs = args["interval-ms"]
    ? parsePositiveInt(args["interval-ms"], "--interval-ms")
    : DEFAULT_INTERVAL_MS;
  const maxDurationMs = args["max-duration-ms"]
    ? parsePositiveInt(args["max-duration-ms"], "--max-duration-ms")
    : undefined;
  const stopFile = args["stop-file"];
  const summaryFile = args.summary;
  let vendorRegex;
  try {
    vendorRegex = new RegExp(args["vendor-regex"] ?? DEFAULT_VENDOR_REGEX, "i");
  } catch (error) {
    fail(`--vendor-regex is not a valid regular expression: ${error.message}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  const outPath = path.resolve(args.out);
  fs.writeFileSync(outPath, "");

  const windowStart = new Date();
  const perProcess = new Map();
  let ticks = 0;
  let tickErrors = 0;
  let treePeakRssBytes = 0;
  let seedObserved = false;
  let stopReason = "stop-file";
  const startedAt = Date.now();

  const onSignal = () => {
    stopReason = "signal";
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const appendTick = (payload) => {
    fs.appendFileSync(outPath, `${JSON.stringify(payload)}\n`);
  };

  try {
    while (true) {
      if (stopReason === "signal") break;
      if (stopFile && fs.existsSync(stopFile)) break;
      if (maxDurationMs !== undefined && Date.now() - startedAt >= maxDurationMs) {
        stopReason = "max-duration";
        break;
      }

      const tickTs = new Date();
      try {
        const rows = await queryProcesses();
        const samples = treeClosure(rows, seedPid).map(normalizeSample);
        appendTick({ ts: tickTs.toISOString(), samples });
        ticks += 1;

        let treeRssThisTick = 0;
        for (const sample of samples) {
          if (sample.pid === seedPid) seedObserved = true;
          if (sample.rssBytes !== null) treeRssThisTick += sample.rssBytes;
          const stats = perProcess.get(sample.pid) ?? {
            ...sample,
            firstSeenTs: tickTs.toISOString(),
            lastSeenTs: tickTs.toISOString(),
            cpuSecFirst: sample.cpuSec,
            cpuSecLast: sample.cpuSec,
            rssPeakBytes: sample.rssBytes ?? 0,
          };
          stats.lastSeenTs = tickTs.toISOString();
          stats.cpuSecLast = sample.cpuSec;
          if (sample.cmd) stats.cmd = sample.cmd;
          if ((sample.rssBytes ?? 0) > stats.rssPeakBytes) stats.rssPeakBytes = sample.rssBytes;
          perProcess.set(sample.pid, stats);
        }
        treePeakRssBytes = Math.max(treePeakRssBytes, treeRssThisTick);
      } catch (error) {
        tickErrors += 1;
        appendTick({ ts: tickTs.toISOString(), error: error.message });
      }

      await sleepWhileWatchingStopFile(Date.now() + intervalMs, stopFile);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const windowEnd = new Date();
  let orphans = [];
  let orphanCheckError;
  try {
    const rows = await queryProcesses();
    const harness = harnessPids(rows);
    orphans = rows
      .filter((row) => !harness.has(Number(row.pid)))
      .filter((row) => {
        const created = row.created ? Date.parse(row.created) : NaN;
        if (!Number.isFinite(created)) return false;
        return (
          created >= windowStart.getTime() - WINDOW_SLACK_MS &&
          created <= windowEnd.getTime() + WINDOW_SLACK_MS
        );
      })
      .filter(
        (row) =>
          vendorRegex.test(String(row.name ?? "")) || vendorRegex.test(String(row.cmd ?? "")),
      )
      .map(normalizeSample);
  } catch (error) {
    orphanCheckError = error.message;
  }

  const summary = {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    stopReason,
    seedPid,
    seedObserved,
    intervalMs,
    ticks,
    tickErrors,
    treePeakRssBytes,
    perProcess: [...perProcess.values()]
      .map((stats) => ({
        pid: stats.pid,
        ppid: stats.ppid,
        name: stats.name,
        created: stats.created,
        firstSeenTs: stats.firstSeenTs,
        lastSeenTs: stats.lastSeenTs,
        cpuSecFirst: stats.cpuSecFirst,
        cpuSecLast: stats.cpuSecLast,
        cpuSecDelta:
          stats.cpuSecFirst !== null && stats.cpuSecLast !== null
            ? Math.round((stats.cpuSecLast - stats.cpuSecFirst) * 1_000) / 1_000
            : null,
        rssPeakBytes: stats.rssPeakBytes,
        cmd: stats.cmd,
      }))
      .sort((a, b) => (b.cpuSecDelta ?? 0) - (a.cpuSecDelta ?? 0)),
    orphans: {
      expected: 0,
      count: orphanCheckError ? null : orphans.length,
      processes: orphans,
      vendorRegex: vendorRegex.source,
      ...(orphanCheckError ? { error: orphanCheckError } : {}),
    },
    outputs: {
      jsonl: outPath,
      ...(summaryFile ? { summary: path.resolve(summaryFile) } : {}),
      ...(stopFile ? { stopFile: path.resolve(stopFile) } : {}),
    },
    limitations: [
      `periodic sampling at ${intervalMs}ms cannot observe sub-interval spikes`,
      "CPU values are cumulative process-lifetime seconds, not per-interval usage",
      "WMI counter granularity differs from Task Manager; use for trends and anomaly discovery only",
      "Windows-only (PowerShell Win32_Process)",
      "orphan check matches vendor binaries by name/command line within the creation window; unrelated same-window vendor processes can appear as false positives — cross-check command lines",
      "the sampler's own process tree (itself, ancestors, descendants) is excluded from orphan detection",
    ],
  };

  const rendered = JSON.stringify(summary, null, 2);
  if (summaryFile) {
    fs.mkdirSync(path.dirname(path.resolve(summaryFile)), { recursive: true });
    fs.writeFileSync(summaryFile, `${rendered}\n`);
  }
  console.log(rendered);

  if (!seedObserved) {
    console.error(
      `resource-sampler: warning — seed PID ${seedPid} was never observed; verify the seed is an ancestor of the vendor child.`,
    );
  }
}

main().catch((error) => {
  console.error(`resource-sampler: fatal: ${error.message}`);
  process.exit(1);
});
