import { Octokit } from "@octokit/rest";
import type { ReviewState } from "../state/review-state.js";
import type { ReviewDecision } from "../convergence.js";
import { renderSummary, MARKER } from "./summary-renderer.js";
import { embedState, extractState } from "./comment-state.js";

// ============================================================
// GitHub API: post and update summary comments
// ============================================================

let octokitInstance: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set");
    octokitInstance = new Octokit({ auth: token });
  }
  return octokitInstance;
}

export function parseRepo(): { owner: string; repo: string } {
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!repoSlug) throw new Error("GITHUB_REPOSITORY is not set");
  const [owner, repo] = repoSlug.split("/");
  return { owner, repo };
}

/**
 * Load review state from the existing summary comment.
 * Returns null if no comment or no embedded state found.
 */
export async function loadStateFromComment(
  prNumber: number
): Promise<ReviewState | null> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  const commentId = await findSummaryComment(octokit, owner, repo, prNumber);
  if (!commentId) return null;

  const { data: comment } = await octokit.issues.getComment({
    owner,
    repo,
    comment_id: commentId,
  });

  if (!comment.body) return null;
  return extractState(comment.body);
}

/**
 * Post or update a summary comment (search for existing by marker).
 * Embeds review state as a hidden marker for cross-round persistence.
 */
export async function upsertSummaryComment(
  prNumber: number,
  state: ReviewState,
  decision: ReviewDecision
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  const rendered = renderSummary(state, decision);
  const body = embedState(rendered, state);

  // Search for existing summary comment
  const existingCommentId = await findSummaryComment(
    octokit,
    owner,
    repo,
    prNumber
  );

  if (existingCommentId) {
    // Update existing comment
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });
    console.log(`  Summary comment updated (comment_id: ${existingCommentId})`);
  } else {
    // Post new comment
    const { data } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    console.log(`  Summary comment created (comment_id: ${data.id})`);
  }

  // Also set PR review status (optional)
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
      // Ignore if no APPROVE permission
      console.warn(`  Could not submit approval: ${e}`);
    }
  }
}

/**
 * Post an escalation comment.
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

  const rendered = [
    MARKER,
    `## 🚨 AI Review — Escalated`,
    "",
    `This PR has reached the maximum number of rounds (${state.max_rounds})`,
    `but still has ${openBlockers.length} unresolved blocker(s).`,
    `A human reviewer is required.`,
    "",
    "### Unresolved Blockers",
    "",
    ...openBlockers.map(
      (f) =>
        `- **[${f.id}]** \`${f.file}:${f.line_start}\` — ${f.summary}`
    ),
  ].join("\n");
  const body = embedState(rendered, state);

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

export async function findSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  // Search for the marker in the latest 100 comments
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
