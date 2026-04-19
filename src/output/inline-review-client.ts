import type { ReviewState } from "../state/review-state.js";
import type { OutputConfig } from "../config.js";
import { getOctokit, parseRepo } from "./github-client.js";
import {
  extractFindingIdFromBody,
  selectFindingsForInline,
  buildReviewComments,
  type InlineReviewResult,
} from "./inline-comments.js";

// ============================================================
// Inline Review Client: GitHub API calls for inline comments
// and resolved thread detection
// ============================================================

/**
 * Submit inline review comments for findings.
 * Posts all comments as a single COMMENT-event review (one notification).
 * Returns a map of findingId → GitHub review comment ID.
 */
export async function submitInlineReview(
  prNumber: number,
  state: ReviewState,
  commitSha: string,
  modifiedFiles: Set<string>,
  outputConfig: OutputConfig,
  diff?: string
): Promise<InlineReviewResult> {
  const githubConfig = outputConfig.github;
  const { findings: selected, overflow } = selectFindingsForInline(state, modifiedFiles, githubConfig, diff);

  if (selected.length === 0) {
    return { postedComments: {}, overflow: 0 };
  }

  const comments = buildReviewComments(selected);

  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  const reviewBody = `🤖 AI Review — ${selected.length} inline comment(s)${overflow > 0 ? ` (${overflow} more in summary)` : ""}`;

  try {
    const { data: review } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: "COMMENT",
      body: reviewBody,
      comments,
    });

    // Fetch only the comments belonging to the review we just posted,
    // avoiding pagination issues with per_page: 100 on the full PR.
    const postedComments: Record<string, number> = {};

    const { data: reviewComments } = await octokit.pulls.listCommentsForReview({
      owner,
      repo,
      pull_number: prNumber,
      review_id: review.id,
      per_page: 100,
    });

    for (const comment of reviewComments) {
      const findingId = extractFindingIdFromBody(comment.body ?? "");
      if (findingId) {
        postedComments[findingId] = comment.id;
      }
    }

    console.log(
      `  Inline review posted: ${selected.length} comments` +
      (overflow > 0 ? ` (${overflow} overflow)` : "")
    );

    return { postedComments, overflow };
  } catch (e) {
    console.warn(`  Could not submit inline review: ${e}`);
    return { postedComments: {}, overflow: 0 };
  }
}

interface ResolvedThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number }> };
        }>;
      };
    };
  };
}

/**
 * Fetch IDs of resolved review threads via GraphQL.
 * Returns a Set of review comment database IDs that belong to resolved threads.
 */
export async function fetchResolvedThreads(
  prNumber: number
): Promise<Set<number>> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  try {
    const result: ResolvedThreadsResponse = await octokit.graphql(
      `query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes { databaseId }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, pr: prNumber }
    );

    const threads = result.repository.pullRequest.reviewThreads.nodes;
    if (threads.length >= 100) {
      console.warn("  Warning: 100+ review threads — some resolved threads may not be detected");
    }

    const resolvedIds = new Set<number>();
    for (const thread of threads) {
      if (thread.isResolved) {
        for (const comment of thread.comments.nodes) {
          resolvedIds.add(comment.databaseId);
        }
      }
    }

    return resolvedIds;
  } catch (e) {
    console.warn(`  Could not fetch resolved threads: ${e}`);
    return new Set();
  }
}
