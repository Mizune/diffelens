import type { ReviewState } from "./state/review-state.js";
import { loadState, saveState } from "./state/review-state.js";
import { renderSummary, MARKER } from "./output/summary-renderer.js";
import {
  getOctokit,
  parseRepo,
  findSummaryComment,
} from "./output/github-client.js";
import { checkConvergence } from "./convergence.js";
import { loadConfig } from "./config.js";

// ============================================================
// Handle /diffelens dismiss {id} {reason} command
// ============================================================

async function main() {
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0");
  const commandBody = process.env.COMMAND_BODY ?? "";
  const commandUser = process.env.COMMAND_USER ?? "unknown";
  const stateDir = process.env.STATE_DIR ?? ".diffelens-state";

  console.log(`Command: ${commandBody}`);
  console.log(`User: ${commandUser}`);

  // Parse command
  const match = commandBody.match(
    /^\/diffelens\s+dismiss\s+(\S+)\s*(.*)?$/
  );

  if (!match) {
    console.log("Not a dismiss command. Ignoring.");
    return;
  }

  const [, findingId, reason] = match;
  console.log(`Dismissing: ${findingId}, reason: ${reason || "none"}`);

  // Load state (via shared module)
  const state = await loadState(stateDir, prNumber);
  if (!state) {
    console.error("No review state found for this PR.");
    return;
  }

  // Update finding status (immutably)
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
      `Round ${state.current_round}: ${findingId} dismissed as wontfix by @${commandUser} (${reason || "no reason"})`,
    ],
  };

  // Save state (via shared module)
  await saveState(stateDir, updatedState);

  // Update summary comment (via shared module)
  if (process.env.GITHUB_TOKEN) {
    const configPath = process.env.CONFIG_PATH ?? ".diffelens.yaml";
    const config = await loadConfig(configPath);

    const decision = checkConvergence(updatedState, config.convergence);
    const body = renderSummary(updatedState, decision);

    const octokit = getOctokit();
    const { owner, repo } = parseRepo();

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
      console.log("Summary comment updated.");
    }

    // Confirm with a reaction
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
