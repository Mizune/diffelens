// ============================================================
// Severity rank definitions (shared constants)
// Referenced by lens-runner, deduplicator, etc.
// ============================================================

export type Severity = "blocker" | "warning" | "nitpick";

export const SEVERITY_RANK: Record<string, number> = {
  nitpick: 1,
  warning: 2,
  blocker: 3,
};
