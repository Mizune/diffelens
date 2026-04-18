import type { ReviewState } from "./state/review-state.js";
import { loadState, saveState } from "./state/review-state.js";
import { extractFindingIdFromBody } from "./output/inline-comments.js";
import {
  getOctokit,
  parseRepo,
  upsertSummaryComment,
  loadStateFromComment,
} from "./output/github-client.js";
import { checkConvergence } from "./convergence.js";
import { loadConfig } from "./config.js";

// ============================================================
// Handle /diffelens dismiss {id} {reason} command
//
// Supports three invocation modes:
// 1. GitHub issue comment: /diffelens dismiss {id} {reason}
// 2. GitHub review comment reply: /dismiss {reason} (ID extracted from parent)
// 3. Local CLI: npx tsx src/handle-command.ts dismiss {id} {reason}
// ============================================================

/** Core dismiss logic shared by all invocation modes */
function applyDismiss(
  state: ReviewState,
  findingId: string,
  reason: string,
  actor: string
): ReviewState | null {
  const targetIndex = state.findings.findIndex((f) => f.id === findingId);
  if (targetIndex === -1) {
    console.error(`Finding "${findingId}" not found.`);
    return null;
  }

  const target = state.findings[targetIndex];
  if (target.status !== "open") {
    console.log(`Finding "${findingId}" is already ${target.status}. Skipping.`);
    return null;
  }

  const updatedFindings = state.findings.map((f, i) =>
    i === targetIndex
      ? {
          ...f,
          status: "wontfix" as const,
          resolution_note: `Dismissed by @${actor}: ${reason || "no reason given"}`,
        }
      : f
  );

  return {
    ...state,
    findings: updatedFindings,
    decisions: [
      ...state.decisions,
      `Round ${state.current_round}: ${findingId} dismissed as wontfix by @${actor} (${reason || "no reason"})`,
    ],
  };
}

/** Update the GitHub summary comment with new state via upsertSummaryComment */
async function updateGitHubSummary(
  updatedState: ReviewState,
  prNumber: number
): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? ".diffelens.yaml";
  const config = await loadConfig(configPath);
  const decision = checkConvergence(updatedState, config.convergence);
  await upsertSummaryComment(prNumber, updatedState, decision, undefined, config.output);
}

/** React to a comment with +1 */
async function reactToComment(commentId: number): Promise<void> {
  if (!commentId) return;
  const octokit = getOctokit();
  const { owner, repo } = parseRepo();
  await octokit.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content: "+1",
  }).catch(() => {});
}

/** Load state, apply dismiss, save, and optionally update GitHub */
async function executeDismiss(
  stateDir: string,
  prNumber: number,
  findingId: string,
  reason: string,
  actor: string
): Promise<void> {
  // Try file state first, then fall back to PR comment state (GitHub mode)
  let state = await loadState(stateDir, prNumber);
  if (!state && process.env.GITHUB_TOKEN && prNumber > 0) {
    state = await loadStateFromComment(prNumber);
  }
  if (!state) {
    console.error("No review state found.");
    return;
  }

  const updatedState = applyDismiss(state, findingId, reason, actor);
  if (!updatedState) return;

  await saveState(stateDir, updatedState);

  if (process.env.GITHUB_TOKEN) {
    await updateGitHubSummary(updatedState, prNumber);
    const commentId = parseInt(process.env.COMMENT_ID ?? "0") || 0;
    await reactToComment(commentId);
  }

  console.log(`Done. Finding ${findingId} marked as wontfix.`);
}

// ============================================================
// Mode 3: Local CLI — npx tsx src/handle-command.ts dismiss {id} {reason}
// ============================================================
async function handleLocalDismiss(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] !== "dismiss" || !args[1]) {
    console.log("Usage: npx tsx src/handle-command.ts dismiss <finding-id> [reason]");
    return;
  }

  const findingId = args[1];
  const reason = args.slice(2).join(" ") || "no reason given";
  const stateDir = process.env.STATE_DIR ?? ".diffelens-state";
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0");

  await executeDismiss(stateDir, prNumber, findingId, reason, "local-user");
}

// ============================================================
// Mode 1 & 2: GitHub — env var driven
// ============================================================
async function handleGitHubDismiss(): Promise<void> {
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0");
  const commandBody = process.env.COMMAND_BODY ?? "";
  const commandUser = process.env.COMMAND_USER ?? "unknown";
  const stateDir = process.env.STATE_DIR ?? ".diffelens-state";

  // Mode 2: Review comment reply — /dismiss {reason}
  // PARENT_COMMENT_BODY contains the inline comment body with **[id]**
  const parentBody = process.env.PARENT_COMMENT_BODY;
  if (parentBody) {
    const findingId = extractFindingIdFromBody(parentBody);
    if (!findingId) {
      console.log("Could not extract finding ID from parent comment.");
      return;
    }
    const reason = commandBody.replace(/^\/dismiss\s*/, "").trim() || "no reason given";
    console.log(`Thread dismiss: ${findingId}, reason: ${reason}`);
    await executeDismiss(stateDir, prNumber, findingId, reason, commandUser);
    return;
  }

  // Mode 1: Issue comment — /diffelens dismiss {id} {reason}
  console.log(`Command: ${commandBody}`);
  console.log(`User: ${commandUser}`);

  const match = commandBody.match(
    /^\/diffelens\s+dismiss\s+(\S+)\s*(.*)?$/
  );

  if (!match) {
    console.log("Not a dismiss command. Ignoring.");
    return;
  }

  const [, findingId, reason] = match;
  console.log(`Dismissing: ${findingId}, reason: ${reason || "none"}`);
  await executeDismiss(stateDir, prNumber, findingId, reason || "", commandUser);
}

// ============================================================
// Entry point: detect mode from args vs env vars
// ============================================================
async function main() {
  const args = process.argv.slice(2);

  // Local CLI mode: first arg is "dismiss"
  if (args[0] === "dismiss") {
    await handleLocalDismiss();
    return;
  }

  // GitHub mode: driven by env vars
  await handleGitHubDismiss();
}

main().catch(console.error);
