import type { ReviewState } from "./state/review-state.js";
import type { Finding } from "./adapters/types.js";
import { findingsMatch } from "./state/review-state.js";

export interface RecurrenceDirective {
  /** Index of the suppressed finding in the original newFindings array */
  targetIndex: number;
  /** ID of the previously addressed finding that recurred */
  originalFindingId: string;
  file: string;
  category: string;
  reason: string;
  /** Summary of the suppressed finding for audit trail */
  suppressedSummary: string;
}

export interface RecurrenceResult {
  directives: readonly RecurrenceDirective[];
  /** Findings after suppression */
  findings: Finding[];
}

/**
 * Detect recurring findings and suppress them.
 *
 * A "recurrence" is when a finding was open, then addressed (developer fixed it),
 * and now reappears at the same location with the same category.
 * This indicates a pendulum effect — the LLM keeps flip-flopping.
 *
 * Pure function — no LLM, no side effects.
 */
export function detectAndSuppressRecurrences(
  state: ReviewState,
  newFindings: readonly Finding[]
): RecurrenceResult {
  const addressedFromPriorRounds = state.findings.filter(
    (f) => f.status === "addressed" && f.first_raised_round < state.current_round
  );

  if (addressedFromPriorRounds.length === 0) {
    return { directives: [], findings: [...newFindings] };
  }

  const directives: RecurrenceDirective[] = [];
  const suppressedIndices = new Set<number>();

  for (let i = 0; i < newFindings.length; i++) {
    const candidate = newFindings[i];
    const priorMatch = addressedFromPriorRounds.find((addressedFinding) =>
      findingsMatch(candidate, addressedFinding)
    );

    if (priorMatch) {
      directives.push({
        targetIndex: i,
        originalFindingId: priorMatch.id,
        file: candidate.file,
        category: candidate.category,
        reason:
          `Finding matches previously addressed ${priorMatch.id} ` +
          `(raised round ${priorMatch.first_raised_round}, addressed, now recurring)`,
        suppressedSummary: candidate.summary,
      });
      suppressedIndices.add(i);
    }
  }

  const findings = newFindings.filter((_, i) => !suppressedIndices.has(i));

  return { directives, findings };
}
