import type { StateFinding, ReviewState } from "../state/review-state.js";
import type { GitHubOutputConfig } from "../config.js";
import { SEVERITY_RANK, type Severity } from "../severity.js";

// ============================================================
// Inline Review Comments: build GitHub-native review comments
// from StateFinding[] for posting via pulls.createReview
// ============================================================

/** Regex matching the **[id]** pattern in inline comment bodies (e.g., **[b-001]**) */
export const FINDING_ID_PATTERN = /\*\*\[([a-z]-\d{3})\]\*\*/;

/** Extract a finding ID from a comment body containing the **[id]** pattern */
export function extractFindingIdFromBody(body: string): string | null {
  const match = body.match(FINDING_ID_PATTERN);
  return match ? match[1] : null;
}

/** Shape expected by octokit.pulls.createReview({ comments }) */
export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  body: string;
}

/** Result of inline review posting, maps findingId → GitHub comment ID */
export interface InlineReviewResult {
  postedComments: Record<string, number>;
  overflow: number;
}

const SEVERITY_EMOJI: Record<string, string> = {
  blocker: "🔴",
  warning: "🟡",
  nitpick: "💬",
};

/**
 * Determine which findings should be posted as inline comments.
 *
 * Noise-minimized multi-round logic:
 * - File modified since last inline review → re-post (old comment is outdated)
 * - File NOT modified + finding already has inline comment → skip (still valid)
 * - New finding → post
 */
export function selectFindingsForInline(
  state: ReviewState,
  modifiedFiles: Set<string>,
  config: GitHubOutputConfig
): StateFinding[] {
  const allowedSeverities = new Set<string>(config.inlineSeverities);

  const candidates = state.findings.filter(
    (f) => f.status === "open" && allowedSeverities.has(f.severity)
  );

  const filtered = candidates.filter((f) => {
    // New finding (no inline comment yet) → always post
    if (!f.inline_comment_id) return true;

    // Existing inline comment, but file was modified → re-post on new code
    if (modifiedFiles.has(f.file)) return true;

    // Existing inline comment, file unchanged → skip (comment still valid)
    return false;
  });

  // Sort by severity (blockers first) then by file/line
  const sorted = [...filtered].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;
    return a.line_start - b.line_start;
  });

  // Apply max limit
  return sorted.slice(0, config.maxInlineComments);
}

/** Build the ReviewComment array for octokit.pulls.createReview */
export function buildReviewComments(
  findings: StateFinding[]
): ReviewComment[] {
  return findings.map((f) => ({
    path: f.file,
    line: f.line_end,
    ...(f.line_start < f.line_end ? { start_line: f.line_start } : {}),
    side: "RIGHT" as const,
    body: formatInlineBody(f),
  }));
}

/** Format the Markdown body for a single inline comment */
export function formatInlineBody(f: StateFinding): string {
  const emoji = SEVERITY_EMOJI[f.severity] ?? "";
  const lines: string[] = [];

  // Header: [id] severity | category
  lines.push(`**[${f.id}]** ${emoji} ${f.severity} | \`${f.category}\``);
  lines.push("");

  // Summary
  lines.push(f.summary);
  lines.push("");

  // Suggestion text
  if (f.suggestion) {
    lines.push(`> 💡 ${f.suggestion}`);
    lines.push("");
  }

  // GitHub suggestion block (exact code replacement)
  if (f.suggestion_diff) {
    lines.push("```suggestion");
    lines.push(f.suggestion_diff);
    lines.push("```");
    lines.push("");
  }

  // Evidence (collapsible)
  if (f.evidence) {
    lines.push("<details><summary>Evidence</summary>");
    lines.push("");
    lines.push(f.evidence);
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Count how many findings were filtered out by the max limit.
 */
export function countOverflow(
  state: ReviewState,
  posted: StateFinding[],
  config: GitHubOutputConfig
): number {
  const allowedSeverities = new Set<string>(config.inlineSeverities);
  const total = state.findings.filter(
    (f) => f.status === "open" && allowedSeverities.has(f.severity)
  ).length;
  return Math.max(0, total - posted.length);
}
