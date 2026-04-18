import type { StateFinding, ReviewState } from "../state/review-state.js";
import type { GitHubOutputConfig } from "../config.js";
import { SEVERITY_RANK, type Severity } from "../severity.js";

// ============================================================
// Inline Review Comments: build GitHub-native review comments
// from StateFinding[] for posting via pulls.createReview
// ============================================================

/** Marker prefix for machine-readable metadata in inline comments */
const FINDING_MARKER_PREFIX = "<!-- diffelens-finding: ";
const FINDING_MARKER_SUFFIX = " -->";

/** Regex to extract the JSON metadata from an inline comment body */
const FINDING_MARKER_PATTERN = /<!-- diffelens-finding: ({.*?}) -->/;

/** Legacy regex for **[id]** pattern (fallback for pre-metadata comments) */
export const FINDING_ID_PATTERN = /\*\*\[([a-z]-\d{3})\]\*\*/;

export interface FindingMetadata {
  id: string;
  lens: string;
  round: number;
  severity: string;
  category: string;
}

/** Extract finding metadata from an inline comment body */
export function extractFindingMetadata(body: string): FindingMetadata | null {
  const match = body.match(FINDING_MARKER_PATTERN);
  if (match) {
    try {
      return JSON.parse(match[1]) as FindingMetadata;
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract a finding ID from a comment body (metadata marker → legacy **[id]** fallback) */
export function extractFindingIdFromBody(body: string): string | null {
  const meta = extractFindingMetadata(body);
  if (meta) return meta.id;
  const legacyMatch = body.match(FINDING_ID_PATTERN);
  return legacyMatch ? legacyMatch[1] : null;
}

/** Build the HTML comment marker for a finding */
function buildFindingMarker(f: StateFinding): string {
  const meta: FindingMetadata = {
    id: f.id,
    lens: f.lens,
    round: f.first_raised_round,
    severity: f.severity,
    category: f.category,
  };
  return `${FINDING_MARKER_PREFIX}${JSON.stringify(meta)}${FINDING_MARKER_SUFFIX}`;
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

/** Line range in the new (right) side of a diff hunk */
interface DiffLineRange {
  start: number;
  end: number;
}

/**
 * Parse a unified diff to extract valid line ranges per file (new/right side).
 * Returns a map of file path → array of valid line ranges.
 */
export function parseDiffLineRanges(diff: string): Map<string, DiffLineRange[]> {
  const result = new Map<string, DiffLineRange[]>();
  let currentFile: string | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      if (!result.has(currentFile)) {
        result.set(currentFile, []);
      }
      continue;
    }

    // @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1], 10);
      const count = parseInt(hunkMatch[2] ?? "1", 10);
      result.get(currentFile)!.push({ start, end: start + count - 1 });
    }
  }

  return result;
}

/** Check if a finding's line range falls within any diff hunk for that file */
function isLineInDiff(
  file: string,
  lineStart: number,
  lineEnd: number,
  diffRanges: Map<string, DiffLineRange[]>
): boolean {
  const ranges = diffRanges.get(file);
  if (!ranges) return false;
  return ranges.some((r) => lineEnd >= r.start && lineStart <= r.end);
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
  config: GitHubOutputConfig,
  diff?: string
): StateFinding[] {
  const allowedSeverities = new Set<string>(config.inlineSeverities);
  const diffRanges = diff ? parseDiffLineRanges(diff) : null;

  const candidates = state.findings.filter(
    (f) => f.status === "open" && allowedSeverities.has(f.severity)
  );

  const filtered = candidates.filter((f) => {
    // Skip findings whose lines are outside the diff (would cause "Line could not be resolved")
    if (diffRanges && !isLineInDiff(f.file, f.line_start, f.line_end, diffRanges)) {
      return false;
    }

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

  // Machine-readable metadata (invisible to humans)
  lines.push(buildFindingMarker(f));

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
    lines.push("");
  }

  // Action hints for AI/bot consumers (invisible to humans)
  lines.push(`<!-- diffelens-actions: dismiss=reply "/dismiss {reason}", resolve=click "Resolve conversation" -->`);

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
