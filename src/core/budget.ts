import type { BridgeSession, SessionHistoryEntry } from "./types.js";
import type { BudgetConfig } from "./config.js";

/**
 * T5.4 budget water-level gate.
 *
 * Two-state simplification of [AB] budget-decision: warn | rejectNew. Usage
 * totals accumulate from the vendor-reported usage recorded on each session
 * turn (T2.1 metering); turns without usage data contribute zero, so an
 * unmetered channel degrades to "no gate" rather than a fabricated estimate
 * (evidence-honesty principle). In-flight work is never interrupted — the gate
 * only fails NEW dispatches.
 */

/** Usage fraction at/above which responses carry a warning (default 80%). */
export const BUDGET_WARN_RATIO = 0.8;

export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  meteredTurns: number;
}

export type BudgetDecision =
  | { action: "allow"; warning?: string; totals: SessionUsageTotals }
  | { action: "warn"; warning: string; totals: SessionUsageTotals }
  | { action: "reject"; warning: string; totals: SessionUsageTotals };

/** Sums vendor-reported usage across one session's recorded turns. */
export function sumSessionUsage(history: SessionHistoryEntry[]): SessionUsageTotals {
  const totals: SessionUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    meteredTurns: 0,
  };
  for (const turn of history) {
    const usage = turn.usage;
    if (!usage) continue;
    totals.meteredTurns += 1;
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    totals.totalTokens += usage.totalTokens ?? 0;
  }
  return totals;
}

/**
 * Evaluates one new dispatch against the session's accumulated usage. Without
 * a configured cap the decision is always allow (with totals attached so
 * callers can still observe metering). Rejection only fires under
 * onExceed:"rejectNew" once the cap is fully reached.
 */
export function evaluateBudgetGate(params: {
  config?: BudgetConfig;
  session: Pick<BridgeSession, "history">;
}): BudgetDecision {
  const totals = sumSessionUsage(params.session.history);
  const cap = params.config?.perSessionTokenCap;
  if (!cap || cap <= 0) {
    return { action: "allow", totals };
  }
  const spent = totals.totalTokens;
  if (spent >= cap) {
    if (params.config?.onExceed === "rejectNew") {
      return {
        action: "reject",
        warning:
          `BUDGET_EXHAUSTED: session token usage ${spent} has reached the configured ` +
          `per-session cap ${cap} (budget.onExceed=rejectNew). In-flight work continues; new ` +
          "dispatches on this session are rejected. Raise budget.perSessionTokenCap or start a new session.",
        totals,
      };
    }
    return {
      action: "warn",
      warning:
        `Budget warning: session token usage ${spent} has reached the configured per-session ` +
        `cap ${cap}. Configure budget.onExceed:"rejectNew" to hard-stop new dispatches.`,
      totals,
    };
  }
  if (spent >= Math.floor(cap * BUDGET_WARN_RATIO)) {
    return {
      action: "warn",
      warning:
        `Budget warning: session token usage ${spent} is at or above ` +
        `${Math.floor(BUDGET_WARN_RATIO * 100)}% of the per-session cap ${cap}.`,
      totals,
    };
  }
  return { action: "allow", totals };
}
