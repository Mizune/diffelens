import type { ReviewState } from "./state/review-state.js";
import type { ConvergenceConfig } from "./config.js";
import type { Finding } from "./adapters/types.js";

// ============================================================
// Convergence: 0 blockers -> approve, max_rounds exceeded -> escalate
// ============================================================

export type ReviewDecision = "approve" | "request_changes" | "escalate";

export function checkConvergence(
  state: ReviewState,
  convergence: ConvergenceConfig
): ReviewDecision {
  const openFindings = state.findings.filter((f) => f.status === "open");
  const blockers = openFindings.filter((f) => f.severity === "blocker");
  const warnings = openFindings.filter((f) => f.severity === "warning");

  // Round limit
  if (state.current_round >= state.max_rounds && blockers.length > 0) {
    return "escalate";
  }

  // Approval condition
  if (convergence.approve_condition === "zero_blockers") {
    if (blockers.length === 0) return "approve";
  } else if (convergence.approve_condition === "zero_blockers_and_warnings") {
    if (blockers.length === 0 && warnings.length === 0) return "approve";
  }

  return "request_changes";
}

/**
 * Severity filter based on round.
 * Round 1: all severities, Round 2: blocker+warning, Round 3: blocker only
 */
export function filterBySeverityForRound(
  findings: Finding[],
  round: number,
  convergence: ConvergenceConfig
): Finding[] {
  let allowed: string[];

  switch (round) {
    case 1:
      allowed = convergence.round_1_severities;
      break;
    case 2:
      allowed = convergence.round_2_severities;
      break;
    default:
      allowed = convergence.round_3_severities;
      break;
  }

  return findings.filter((f) => allowed.includes(f.severity));
}
