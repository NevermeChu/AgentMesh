export type AgentName =
  | "codex"
  | "gemini"
  | "antigravity"
  | "grok"
  | "claude"
  | "opencode"
  | "zcode";

export type AgentRole = "worker" | "reviewer" | "tester";

export type TransportMode = "auto" | "mcp" | "cli";
export type ReviewerSafetyPolicy = "best-effort" | "enforced";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface AgentModelOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface RunAgentOptions extends AgentModelOptions {
  task: string;
  cwd?: string;
  role?: AgentRole;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
  nativeSessionId?: string;
  baseCommit?: string;
  historyContext?: string;
  /**
   * Declares the strict review contract: an unparseable review verdict fails
   * closed. Set only by callers whose product IS the review verdict (the
   * review_changes pipeline); general reviewer-role conversations stay lenient.
   */
  reviewVerdictRequired?: boolean;
  /** Aborts the underlying agent process; the run resolves as a cancelled failure. */
  signal?: AbortSignal;
}

export interface ContinueAgentOptions extends AgentModelOptions {
  sessionId: string;
  nativeSessionId?: string;
  task: string;
  cwd?: string;
  role?: AgentRole;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
  historyContext?: string;
  /** Aborts the underlying agent process; the run resolves as a cancelled failure. */
  signal?: AbortSignal;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number | string;
  issue: string;
  suggestion?: string;
}

/** Evidence that an auto-mode execution silently switched transports. */
export interface TransportFallbackEvidence {
  from: "mcp" | "cli";
  to: "mcp" | "cli";
  /** Original transport error that triggered the fallback. */
  reason: string;
}

export interface AgentResult {
  status: "success" | "failed";
  agent: AgentName;
  summary: string;
  output: string;
  /** Normalized final agent response, excluding CLI logs and transport metadata. */
  finalAnswer?: string;
  sessionId?: string;
  nativeSessionId?: string;
  exitCode?: number;
  error?: string;
  /** Non-fatal vendor diagnostics preserved alongside substantive output. */
  warning?: string;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  cleanupMethod?: "taskkill-tree" | "signal" | "unknown";
  cleanupSucceeded?: boolean;
  resourceEvidence?: {
    collection: "none" | "process" | "process-tree" | "external";
    cpuUserMs?: number;
    cpuSystemMs?: number;
    peakRssBytes?: number;
    processTreePeakRssBytes?: number;
    orphanProcessesDetected?: boolean;
    note?: string;
    limitations?: string;
  };
  transportUsed?: "mcp" | "cli";
  /** Present when auto mode fell back from the preferred transport to another one. */
  transportFallback?: TransportFallbackEvidence;
  reviewOutcome?: "PASS" | "FAIL" | "UNKNOWN";
  findings?: ReviewFinding[];
  reviewerSafety?: ReviewerSafetyReport;
}

export type SandboxMechanism = "native-sandbox" | "tool-filtering" | "prompt-only";

export interface ReviewerSafetyReport {
  requested: ReviewerSafetyPolicy;
  mechanism: SandboxMechanism;
  enforced: boolean;
  workspaceChanged?: boolean;
  changedPaths?: string[];
  warning?: string;
}

export interface AgentExecutableInfo {
  available: boolean;
  path?: string;
  version?: string;
  preferredTransport: TransportMode;
  supportedTransports: TransportMode[];
  sandboxMechanism: SandboxMechanism;
  notes?: string;
}

export interface AgentAdapter {
  readonly name: AgentName;
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly supportedModes: readonly TransportMode[];
  readonly sandboxMechanism: SandboxMechanism;

  isAvailable(): Promise<boolean>;
  getExecutableInfo(): Promise<AgentExecutableInfo>;
  run(options: RunAgentOptions): Promise<AgentResult>;
  continue?(options: ContinueAgentOptions): Promise<AgentResult>;
}
