import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { Octokit } from "@octokit/rest";
import type { ReviewState } from "./state/review-state.js";
import { renderSummary, MARKER } from "./output/summary-renderer.js";
import { checkConvergence } from "./convergence.js";
import { loadConfig } from "./config.js";

// ============================================================
// /ai-review dismiss {id} {reason} コマンドの処理
// ============================================================

async function main() {
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0");
  const commandBody = process.env.COMMAND_BODY ?? "";
  const commandUser = process.env.COMMAND_USER ?? "unknown";

  console.log(`Command: ${commandBody}`);
  console.log(`User: ${commandUser}`);

  // コマンドのパース
  const match = commandBody.match(
    /^\/ai-review\s+dismiss\s+(\S+)\s*(.*)?$/
  );

  if (!match) {
    console.log("Not a dismiss command. Ignoring.");
    return;
  }

  const [, findingId, reason] = match;
  console.log(`Dismissing: ${findingId}, reason: ${reason || "none"}`);

  // state読み込み
  const stateDir = ".ai-review-state";
  const statePath = `${stateDir}/review-state-pr-${prNumber}.json`;

  if (!existsSync(statePath)) {
    console.error("No review state found for this PR.");
    return;
  }

  const state: ReviewState = JSON.parse(
    await readFile(statePath, "utf-8")
  );

  // findingのstatusを更新（イミュータブルに）
  const targetIndex = state.findings.findIndex((f) => f.id === findingId);
  if (targetIndex === -1) {
    console.error(`Finding "${findingId}" not found.`);
    return;
  }

  const target = state.findings[targetIndex];
  if (target.status !== "open") {
    console.log(
      `Finding "${findingId}" is already ${target.status}. Skipping.`
    );
    return;
  }

  const updatedFindings = state.findings.map((f, i) =>
    i === targetIndex
      ? {
          ...f,
          status: "wontfix" as const,
          resolution_note: `Dismissed by @${commandUser}: ${reason || "no reason given"}`,
        }
      : f
  );

  const updatedState: ReviewState = {
    ...state,
    findings: updatedFindings,
    decisions: [
      ...state.decisions,
      `Round ${state.current_round}: ${findingId} を @${commandUser} が wontfix とした (${reason || "no reason"})`,
    ],
  };

  // state保存
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(updatedState, null, 2), "utf-8");

  // サマリーコメント更新
  if (process.env.GITHUB_TOKEN) {
    const configPath = process.env.CONFIG_PATH ?? ".ai-review.yaml";
    const config = await loadConfig(configPath);

    const decision = checkConvergence(updatedState, config.convergence);
    const body = renderSummary(updatedState, decision);

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split(
      "/"
    );

    // 既存コメントを検索して更新
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existing = comments.find((c) => c.body?.includes(MARKER));

    if (existing) {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      console.log("Summary comment updated.");
    }

    // リアクションで確認
    await octokit.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: parseInt(process.env.COMMENT_ID ?? "0") || 0,
      content: "+1",
    }).catch(() => {});
  }

  console.log(`Done. Finding ${findingId} marked as wontfix.`);
}

main().catch(console.error);
