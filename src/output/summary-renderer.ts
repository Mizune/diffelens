import type { ReviewState, StateFinding } from "../state/review-state.js";
import type { ReviewDecision } from "../convergence.js";
import type { DiffStats } from "../diff.js";

// ============================================================
// Generate Markdown summary for posting to PR
// ============================================================

const MARKER = "<!-- diffelens-summary -->";

export interface LensStat {
  name: string;
  cli: string;
  durationMs: number;
  success: boolean;
  assessment: string | null;
  exploredFiles: number | null;
  findingCount: number | null;
}

export interface ReviewScope {
  diffStats: DiffStats;
  diffFiles: string[];
  changeSummary: string | null;
  lensStats: LensStat[];
}

export function renderSummary(
  state: ReviewState,
  decision: ReviewDecision,
  mode: "github" | "local" = "github",
  scope?: ReviewScope
): string {
  const open = state.findings.filter((f) => f.status === "open");
  const blockers = open.filter((f) => f.severity === "blocker");
  const warnings = open.filter((f) => f.severity === "warning");
  const nitpicks = open.filter((f) => f.severity === "nitpick");
  const resolved = state.findings.filter((f) => f.status === "addressed");

  const decisionEmoji =
    decision === "approve"
      ? "✅ APPROVED"
      : decision === "escalate"
        ? "🚨 ESCALATED (human review required)"
        : "🔄 CHANGES REQUESTED";

  const suppressionCount = state.recurrence_suppressions?.length ?? 0;

  const lines: string[] = [
    MARKER,
    `## 🤖 AI Review — Round ${state.current_round}/${state.max_rounds}`,
    "",
    `**${decisionEmoji}**`,
    "",
    "| | Count |",
    "|---|---|",
    `| 🔴 Blockers | ${blockers.length} |`,
    `| 🟡 Warnings | ${warnings.length} |`,
    `| 💬 Nitpicks | ${nitpicks.length} |`,
    `| ✅ Resolved | ${resolved.length} |`,
    "",
  ];

  if (suppressionCount > 0) {
    lines.push(
      `> **Note:** ${suppressionCount} finding(s) suppressed — recurrence detected (same location was fixed then re-raised)`,
      "",
    );
  }

  // Review Scope (collapsible)
  if (scope) {
    lines.push(...renderScope(scope));
  }

  // Blockers
  if (blockers.length > 0) {
    lines.push("---", "", "### 🔴 Blockers", "");
    for (const f of blockers) {
      lines.push(...renderFinding(f, state.current_round));
    }
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push(
      "---",
      "",
      `### 🟡 Warnings`,
      `<details><summary>Expand (${warnings.length})</summary>`,
      ""
    );
    for (const f of warnings) {
      lines.push(...renderFinding(f, state.current_round));
    }
    lines.push("</details>", "");
  }

  // Nitpicks
  if (nitpicks.length > 0) {
    lines.push(
      "---",
      "",
      `### 💬 Nitpicks`,
      `<details><summary>Expand (${nitpicks.length})</summary>`,
      ""
    );
    for (const f of nitpicks) {
      lines.push(...renderFinding(f, state.current_round));
    }
    lines.push("</details>", "");
  }

  // Resolved
  if (resolved.length > 0) {
    lines.push(
      "---",
      "",
      `### ✅ Resolved`,
      `<details><summary>Expand (${resolved.length})</summary>`,
      ""
    );
    for (const f of resolved) {
      lines.push(
        `- ~~**[${f.id}]**~~ \`${f.file}:${f.line_start}\` — ${f.summary}`,
        `  > ${f.resolution_note ?? "resolved"}`,
        ""
      );
    }
    lines.push("</details>", "");
  }

  // Footer
  if (mode === "local") {
    lines.push(
      "---",
      "<sub>",
      `🔄 Re-run to check convergence after fixing issues`,
      "</sub>"
    );
  } else {
    lines.push(
      "---",
      "<sub>",
      `💬 Dismiss a finding: <code>/diffelens dismiss {id} {reason}</code>`,
      "<br>",
      `🔄 Re-review: automatically triggered on new commits`,
      "</sub>"
    );
  }

  return lines.join("\n");
}

function renderScope(scope: ReviewScope): string[] {
  const { diffStats, diffFiles, changeSummary, lensStats } = scope;
  const successCount = lensStats.filter((l) => l.success).length;
  const total = lensStats.length;

  const lensLabel = successCount === total
    ? `${total} lenses`
    : `${successCount}/${total} lenses`;

  const summaryText = `${lensLabel} reviewed ${diffStats.files} files (+${diffStats.additions} -${diffStats.deletions})`;

  const lines: string[] = [
    `<details><summary>📋 ${summaryText}</summary>`,
    "",
  ];

  // Change summary (from LLM, best effort)
  if (changeSummary) {
    const sanitized = changeSummary
      .replace(/<\/?details>/gi, "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    lines.push(sanitized, "");
  }

  lines.push(
    "| Lens | CLI | Duration | Explored | Result |",
    "|------|-----|----------|----------|--------|",
  );

  const diffFileCount = diffFiles.length;

  for (const lens of lensStats) {
    const duration = formatDuration(lens.durationMs);
    const explored = formatExplored(lens, diffFileCount);
    const result = lens.success
      ? formatResult(lens.assessment, lens.findingCount)
      : "⚠️ error";
    lines.push(`| ${lens.name} | ${lens.cli} | ${duration} | ${explored} | ${result} |`);
  }

  // Changed files list
  if (diffFiles.length > 0) {
    const MAX_FILES = 20;
    const displayFiles = diffFiles.slice(0, MAX_FILES);
    lines.push("", "**Changed files:**");
    for (const f of displayFiles) {
      lines.push(`- \`${f}\``);
    }
    if (diffFiles.length > MAX_FILES) {
      lines.push(`- ...and ${diffFiles.length - MAX_FILES} more`);
    }
  }

  lines.push("", "</details>", "");

  return lines;
}

function formatExplored(lens: LensStat, diffFileCount: number): string {
  if (lens.exploredFiles != null) {
    return `${lens.exploredFiles} files`;
  }
  if (lens.success && diffFileCount > 0) {
    return `${diffFileCount} files (diff)`;
  }
  return "—";
}

function formatResult(assessment: string | null, findingCount: number | null): string {
  if (assessment && findingCount != null) {
    const label = assessment.replace(/_/g, " ");
    return findingCount > 0 ? `${label} (${findingCount})` : label;
  }
  if (findingCount != null) {
    return `${findingCount} issues`;
  }
  if (assessment) {
    return assessment.replace(/_/g, " ");
  }
  return "—";
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderFinding(f: StateFinding, currentRound: number): string[] {
  const lines: string[] = [];
  const lineRef =
    f.line_start === f.line_end
      ? `${f.line_start}`
      : `${f.line_start}-${f.line_end}`;

  lines.push(
    `- **[${f.id}]** \`${f.file}:${lineRef}\` — ${f.summary}`
  );

  if (f.suggestion) {
    lines.push(`  > 💡 ${f.suggestion}`);
  }

  const lensLabel = f.lens ?? "unknown";
  const roundLabel =
    f.first_raised_round < currentRound
      ? `Carried from Round ${f.first_raised_round}`
      : `New`;

  lines.push(`  > 🔍 Lens: \`${lensLabel}\` / ${roundLabel}`);
  lines.push("");

  return lines;
}

/** Marker to identify the summary comment */
export { MARKER };
