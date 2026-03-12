import type { ReviewState, StateFinding } from "../state/review-state.js";
import type { ReviewDecision } from "../convergence.js";

// ============================================================
// PRに投稿するMarkdownサマリーを生成
// ============================================================

const MARKER = "<!-- ai-review-summary -->";

export function renderSummary(
  state: ReviewState,
  decision: ReviewDecision
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
        ? "🚨 ESCALATED (人間のレビューが必要)"
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
      `<details><summary>展開 (${warnings.length}件)</summary>`,
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
      `<details><summary>展開 (${nitpicks.length}件)</summary>`,
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
      `<details><summary>展開 (${resolved.length}件)</summary>`,
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
  lines.push(
    "---",
    "<sub>",
    `💬 指摘を却下: <code>/ai-review dismiss {id} {reason}</code>`,
    "<br>",
    `🔄 再レビュー: 新しいcommitをpushすると自動実行`,
    "</sub>"
  );

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
      ? `Round ${f.first_raised_round} から継続`
      : `New`;

  lines.push(`  > 🔍 Lens: \`${lensLabel}\` / ${roundLabel}`);
  lines.push("");

  return lines;
}

/** サマリーコメントを識別するマーカー */
export { MARKER };
