import { InvalidArgumentError } from "commander";
import type { AgentRole, TransportMode } from "../agents/types.js";

export const MAX_TIMEOUT_MS = 3_600_000;

export function parseRole(value: string): AgentRole {
  if (value === "worker" || value === "reviewer" || value === "tester") return value;
  throw new InvalidArgumentError("Role must be worker, reviewer, or tester.");
}

export function parseMode(value: string): TransportMode {
  if (value === "auto" || value === "mcp" || value === "cli") return value;
  throw new InvalidArgumentError("Mode must be auto, mcp, or cli.");
}

export function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new InvalidArgumentError(
      `Timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}ms.`
    );
  }
  return timeout;
}
