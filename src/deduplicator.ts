import type { Finding } from "./adapters/types.js";

// ============================================================
// 複数レンズの結果をマージし、重複を排除する
// ============================================================

const SEVERITY_RANK: Record<string, number> = {
  blocker: 3,
  warning: 2,
  nitpick: 1,
};

/**
 * 重複判定: 同じファイル・重複する行範囲・同じカテゴリなら重複。
 * 異なるレンズからの異なる観点の指摘は重複としない。
 * 例: "naming" (readability) vs "layer_violation" (structural) → 別指摘
 */
function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (!linesOverlap(a.line_start, a.line_end, b.line_start, b.line_end))
    return false;
  if (a.category !== b.category) return false;
  return true;
}

function linesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const merged: Finding[] = [];

  for (const finding of findings) {
    const dupIndex = merged.findIndex((m) => isDuplicate(m, finding));

    if (dupIndex >= 0) {
      // 重複: severity が高い方を残す
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
