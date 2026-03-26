import type { Finding } from "./adapters/types.js";
import { SEVERITY_RANK } from "./severity.js";
import { findingsMatch } from "./state/review-state.js";

// ============================================================
// Merge results from multiple lenses and deduplicate findings
// ============================================================

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const merged: Finding[] = [];

  for (const finding of findings) {
    const dupIndex = merged.findIndex((m) => findingsMatch(m, finding));

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
