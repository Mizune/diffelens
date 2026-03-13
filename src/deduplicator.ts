import type { Finding } from "./adapters/types.js";
import { SEVERITY_RANK } from "./severity.js";
import { linesOverlap } from "./state/review-state.js";

// ============================================================
// Merge results from multiple lenses and deduplicate findings
// ============================================================

/**
 * Duplicate detection: same file, overlapping line range, and same category.
 * Findings from different lenses with different categories are not duplicates.
 * e.g. "naming" (readability) vs "layer_violation" (architectural) -> separate findings
 */
function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (!linesOverlap(a.line_start, a.line_end, b.line_start, b.line_end))
    return false;
  if (a.category !== b.category) return false;
  return true;
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const merged: Finding[] = [];

  for (const finding of findings) {
    const dupIndex = merged.findIndex((m) => isDuplicate(m, finding));

    if (dupIndex >= 0) {
      // Duplicate: keep the higher severity
      const existing = merged[dupIndex];
      if (
        (SEVERITY_RANK[finding.severity] ?? 0) >
        (SEVERITY_RANK[existing.severity] ?? 0)
      ) {
        merged[dupIndex] = finding;
      }
    } else {
      merged.push(finding);
    }
  }

  return merged;
}
