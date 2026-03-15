import type { ReviewState, StateFinding } from "../state/review-state.js";
import type { ReviewDecision } from "../convergence.js";

// ============================================================
// Generate Markdown summary for posting to PR
// ============================================================

const MARKER = "<!-- ai-review-summary -->";

export function renderSummary(
  state: ReviewState,
  decision: ReviewDecision,
  mode: "github" | "local" = "github"
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
      `💬 Dismiss a finding: <code>/ai-review dismiss {id} {reason}</code>`,
      "<br>",
      `🔄 Re-review: automatically triggered on new commits`,
      "</sub>"
    );
  }

  return lines.join("\n");
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

// ============================================================
// State embedding in PR comments (GitHub mode)
// ============================================================

const STATE_MARKER_PREFIX = "<!-- ai-review-state: ";
const STATE_MARKER_SUFFIX = " -->";

/** Embed review state as a hidden marker at the end of the comment body */
export function embedState(body: string, state: ReviewState): string {
  const json = JSON.stringify(state);
  const encoded = Buffer.from(json, "utf-8").toString("base64");
  return `${body}\n${STATE_MARKER_PREFIX}${encoded}${STATE_MARKER_SUFFIX}`;
}

/** Extract review state from comment body. Returns null if no marker found. */
export function extractState(body: string): ReviewState | null {
  const startIdx = body.indexOf(STATE_MARKER_PREFIX);
  if (startIdx === -1) return null;

  const dataStart = startIdx + STATE_MARKER_PREFIX.length;
  const endIdx = body.indexOf(STATE_MARKER_SUFFIX, dataStart);
  if (endIdx === -1) return null;

  const encoded = body.slice(dataStart, endIdx);
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json) as ReviewState;
  } catch {
    return null;
  }
}

/** Marker to identify the summary comment */
export { MARKER };
