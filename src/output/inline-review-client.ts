import type { ReviewState } from "../state/review-state.js";
import type { OutputConfig } from "../config.js";
import { getOctokit, parseRepo } from "./github-client.js";
import {
  FINDING_ID_PATTERN,
  selectFindingsForInline,
  buildReviewComments,
  countOverflow,
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
  outputConfig: OutputConfig
): Promise<InlineReviewResult> {
  const githubConfig = outputConfig.github;
  const selected = selectFindingsForInline(state, modifiedFiles, githubConfig);

  if (selected.length === 0) {
    return { postedComments: {}, overflow: 0 };
  }

  const comments = buildReviewComments(selected);
  const overflow = countOverflow(state, selected, githubConfig);

  const octokit = getOctokit();
  const { owner, repo } = parseRepo();

  let reviewBody = `🤖 AI Review — ${selected.length} inline comment(s)`;
  if (overflow > 0) {
    reviewBody += ` (${overflow} more in summary)`;
  }

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: "COMMENT",
      body: reviewBody,
      comments,
    });

    // Map finding IDs back to posted comment IDs.
    // GitHub's createReview doesn't return individual comment IDs, so we
    // fetch recent review comments and reverse-match via the **[id]** pattern
    // embedded in each comment body. Sorted DESC so the newest (just-posted)
    // comment wins if duplicates exist for the same finding ID.
    const postedComments: Record<string, number> = {};

    const { data: reviewComments } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100, // GitHub API max per page
      sort: "created",
      direction: "desc",
    });

    for (const comment of reviewComments) {
      const match = comment.body?.match(FINDING_ID_PATTERN);
      if (match) {
        const findingId = match[1];
        // Keep first match (newest) — skip if already mapped
        if (selected.some((f) => f.id === findingId) && !(findingId in postedComments)) {
          postedComments[findingId] = comment.id;
        }
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
