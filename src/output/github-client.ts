import { Octokit } from "@octokit/rest";
import type { ReviewState } from "../state/review-state.js";
import type { ReviewDecision } from "../convergence.js";
import { renderSummary, MARKER } from "./summary-renderer.js";

// ============================================================
// GitHub API: サマリーコメントの投稿・更新
// ============================================================

let octokitInstance: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set");
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

function parseRepo(): { owner: string; repo: string } {
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!repoSlug) throw new Error("GITHUB_REPOSITORY is not set");
  const [owner, repo] = repoSlug.split("/");
  return { owner, repo };
}

/**
 * サマリーコメントを投稿 or 更新（マーカーで既存コメントを検索）
 */
export async function upsertSummaryComment(
  prNumber: number,
  state: ReviewState,
  decision: ReviewDecision
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  const body = renderSummary(state, decision);

  // 既存のサマリーコメントを検索
  const existingCommentId = await findSummaryComment(
    octokit,
    owner,
    repo,
    prNumber
  );

  if (existingCommentId) {
    // 既存コメントを更新
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });
    console.log(`  Summary comment updated (comment_id: ${existingCommentId})`);
  } else {
    // 新規コメント投稿
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    console.log(`  Summary comment created (comment_id: ${data.id})`);
  }

  // PRのレビューステータスも設定（optional）
  if (decision === "approve") {
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        event: "APPROVE",
        body: "🤖 AI Review: All blockers resolved.",
      });
    } catch (e) {
      // APPROVE権限がない場合は無視
      console.warn(`  Could not submit approval: ${e}`);
    }
  }
}

/**
 * エスカレーションコメントの投稿
 */
export async function postEscalationComment(
  prNumber: number,
  state: ReviewState
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  const openBlockers = state.findings.filter(
    (f) => f.status === "open" && f.severity === "blocker"
  );

  const body = [
    MARKER,
    `## 🚨 AI Review — Escalated`,
    "",
    `このPRは最大ラウンド数 (${state.max_rounds}) に到達しましたが、`,
    `まだ ${openBlockers.length} 件のblockerが未解決です。`,
    `人間のレビュアーによるレビューをお願いします。`,
    "",
    "### 未解決 Blockers",
    "",
    ...openBlockers.map(
      (f) =>
        `- **[${f.id}]** \`${f.file}:${f.line_start}\` — ${f.summary}`
    ),
  ].join("\n");

  const existingCommentId = await findSummaryComment(
    octokit,
    owner,
    repo,
    prNumber
  );

  if (existingCommentId) {
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });
  } else {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}

async function findSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  // 最新100件のコメントからマーカーを検索
  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
    sort: "created",
    direction: "desc",
  });

  const found = comments.find(
    (c) => c.body?.includes(MARKER) ?? false
  );

  return found?.id ?? null;
}
