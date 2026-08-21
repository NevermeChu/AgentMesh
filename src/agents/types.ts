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

export interface RunAgentOptions {
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
}

export interface ContinueAgentOptions {
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
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number | string;
  issue: string;
  suggestion?: string;
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
  durationMs?: number;
  transportUsed?: "mcp" | "cli";
  reviewOutcome?: "PASS" | "FAIL" | "UNKNOWN";
  findings?: ReviewFinding[];
}

export type SandboxMechanism = "native-sandbox" | "tool-filtering" | "prompt-only";

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
