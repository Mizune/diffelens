import type { ReviewState, StateFinding } from "./state/review-state.js";
import type { Finding } from "./adapters/types.js";
import { linesOverlap } from "./state/review-state.js";

// ============================================================
// Recurrence Detection: suppress oscillating findings
// ============================================================

export interface RecurrenceDirective {
  /** Index of the suppressed finding in the original newFindings array */
  targetIndex: number;
  /** ID of the previously addressed finding that recurred */
  originalFindingId: string;
  file: string;
  category: string;
  reason: string;
}

export interface RecurrenceResult {
  directives: readonly RecurrenceDirective[];
  /** Findings after suppression */
  findings: readonly Finding[];
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
    (f): f is StateFinding =>
      f.status === "addressed" && f.first_raised_round < state.current_round
  );

  if (addressedFromPriorRounds.length === 0) {
    return { directives: [], findings: newFindings };
  }

  const directives: RecurrenceDirective[] = [];
  const suppressedIndices = new Set<number>();

  for (let i = 0; i < newFindings.length; i++) {
    const nf = newFindings[i];
    const match = addressedFromPriorRounds.find((af) =>
      isMatchingFinding(nf, af)
    );

    if (match) {
      directives.push({
        targetIndex: i,
        originalFindingId: match.id,
        file: nf.file,
        category: nf.category,
        reason:
          `Finding matches previously addressed ${match.id} ` +
          `(raised round ${match.first_raised_round}, addressed, now recurring)`,
      });
      suppressedIndices.add(i);
    }
  }

  const findings = newFindings.filter((_, i) => !suppressedIndices.has(i));

  return { directives, findings };
}

function isMatchingFinding(a: Finding, b: StateFinding): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    linesOverlap(a.line_start, a.line_end, b.line_start, b.line_end)
  );
}
