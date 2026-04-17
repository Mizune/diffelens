#!/usr/bin/env node
import { join } from "path";
import { existsSync, realpathSync } from "fs";
import { writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { loadConfig, loadConfigWithFallback, loadConfigWithLocalOverlay, LOCAL_CONFIG_FILENAME } from "./config.js";
import { runLens, type LensRunResult } from "./lens-runner.js";
import {
  loadOrCreateState,
  createInitialState,
  advanceRoundIfNeeded,
  updateState,
  saveState,
  applyRecurrenceSuppressions,
  buildInlineCommentMap,
} from "./state/review-state.js";
import { deduplicateFindings } from "./deduplicator.js";
import { detectAndSuppressRecurrences } from "./recurrence.js";
import {
  checkConvergence,
  filterBySeverityForRound,
} from "./convergence.js";
import {
  upsertSummaryComment,
  postEscalationComment,
  loadStateFromComment,
} from "./output/github-client.js";
import {
  submitInlineReview,
  fetchResolvedThreads,
} from "./output/inline-review-client.js";
import { checkAvailability, type Finding } from "./adapters/index.js";
import { filterDiffByExcludePatterns } from "./filters.js";
import { resolveOptions, type RunOptions } from "./options.js";
import { fetchDiff, hashDiff, resolveGitRef, parseDiffStats, parseDiffFiles } from "./diff.js";
import { collectProjectContext, formatProjectContext } from "./project-context.js";
import { resolvePrompt, resolveSkillPromptPath, validatePrompts, validateSkillPrompts } from "./prompt-resolver.js";
import { resolveSkills, skillRunName } from "./skill-resolver.js";
import { injectSkillContent } from "./skill-prompt-injector.js";
import type { ReviewScope, LensStat } from "./output/summary-renderer.js";
import type { ReviewState } from "./state/review-state.js";
import type { OutputConfig } from "./config.js";

// ============================================================
// AI PR Review Orchestrator
// ============================================================

export async function main(options?: RunOptions) {
  const opts = options ?? resolveOptions();

  console.log(`AI Review — Starting (mode: ${opts.mode})...\n`);

  // Validate github mode requirements
  if (opts.mode === "github" && (!opts.prNumber || !opts.baseSha || !opts.headSha)) {
    console.error(
      "Required env vars for github mode: PR_NUMBER, BASE_SHA, HEAD_SHA"
    );
    process.exit(1);
  }

  // 1. Check CLI availability
  const availability = await checkAvailability();
  console.log("CLI availability:", availability);

  // 2. Load config (with fallback to diffelens default for local mode)
  let config;
  if (opts.mode === "local" && !opts.configExplicit) {
    // Local mode without explicit --config: resolve base config (with fallback) + local overlay
    const fallbackConfigPath = join(opts.diffelensRoot, ".diffelens.yaml");
    const basePath = existsSync(opts.configPath) ? opts.configPath : fallbackConfigPath;
    const localPath = join(opts.repoRoot, LOCAL_CONFIG_FILENAME);
    const result = await loadConfigWithLocalOverlay(basePath, localPath);
    config = result.config;
    if (result.localOverlayApplied) {
      console.log(`Config: loaded ${LOCAL_CONFIG_FILENAME} overlay`);
    }
  } else if (opts.mode === "local") {
    // Local mode with explicit --config: use that file only, no overlay
    const fallbackConfigPath = join(opts.diffelensRoot, ".diffelens.yaml");
    config = await loadConfigWithFallback(opts.configPath, fallbackConfigPath);
  } else {
    // GitHub mode: use config as-is
    config = await loadConfig(opts.configPath);
  }

  console.log(
    `Config: ${config.lenses.length} lenses, max_rounds=${config.global.max_rounds}\n`
  );

  // Filter to only available lenses
  const activeLenses = config.lenses.filter((l) => {
    if (!availability[l.cli]) {
      console.warn(
        `Warning: Lens "${l.name}" requires "${l.cli}" but not available. Skipping.`
      );
      return false;
    }
    return true;
  });

  if (activeLenses.length === 0) {
    console.error("No lenses available. Install at least one CLI tool.");
    process.exit(1);
  }

  // 3. Fetch diff + apply exclude_patterns filter
  console.log("Fetching diff...");
  const rawDiff = fetchDiff(opts);
  const totalDiffFiles = parseDiffFiles(rawDiff).length;
  const diff = filterDiffByExcludePatterns(rawDiff, config.filters.exclude_patterns);
  console.log(`  Diff size: ${rawDiff.length} -> ${diff.length} chars (after exclude filter)\n`);

  if (diff.trim().length === 0) {
    console.log("No diff found (or all files excluded). Nothing to review.");
    return;
  }

  // Resolve SHAs for state tracking
  let headSha: string;
  if (opts.mode === "github") {
    headSha = opts.headSha;
  } else if (opts.cliHead) {
    headSha = resolveGitRef(opts.cliHead, opts.repoRoot);
  } else {
    headSha = hashDiff(diff);
  }

  let baseSha: string;
  if (opts.mode === "github") {
    baseSha = opts.baseSha;
  } else if (opts.cliBase) {
    baseSha = resolveGitRef(opts.cliBase, opts.repoRoot);
  } else {
    baseSha = opts.baseSha;
  }

  // 4. Previous round state
  let state: Awaited<ReturnType<typeof loadOrCreateState>>;
  if (opts.mode === "github" && process.env.GITHUB_TOKEN) {
    // GitHub mode: load state from PR comment
    let commentState: Awaited<ReturnType<typeof loadStateFromComment>> = null;
    try {
      commentState = await loadStateFromComment(opts.prNumber);
    } catch (e) {
      console.warn(`  Failed to load state from comment, starting fresh: ${e}`);
    }
    state = commentState
      ? advanceRoundIfNeeded(commentState, headSha)
      : createInitialState(opts.prNumber, baseSha, headSha, config.global.max_rounds);
  } else {
    // Local mode: load state from file
    state = await loadOrCreateState(
      opts.stateDir,
      opts.prNumber,
      baseSha,
      headSha,
      config.global.max_rounds
    );
  }
  // 4a. Detect resolved inline comment threads (GitHub mode only)
  const inlineCommentMap = buildInlineCommentMap(state.findings);
  if (
    opts.mode === "github" &&
    process.env.GITHUB_TOKEN &&
    config.output.github.inlineComments &&
    Object.keys(inlineCommentMap).length > 0
  ) {
    state = await reconcileResolvedThreads(state, opts.prNumber, inlineCommentMap);
  }

  console.log(`Round: ${state.current_round}/${state.max_rounds}`);
  console.log(
    `  Previous findings: ${state.findings.length} (open: ${state.findings.filter((f) => f.status === "open").length})\n`
  );

  // 5. Convergence check (max_rounds exceeded)
  if (state.current_round > state.max_rounds) {
    console.log("Max rounds exceeded. Escalating to human reviewer.");
    if (opts.mode === "github" && process.env.GITHUB_TOKEN) {
      await postEscalationComment(opts.prNumber, state);
    }
    if (opts.mode === "local") {
      await saveState(opts.stateDir, state);
    }
    return;
  }

  // 6. Collect project context
  const languageOverride = config.global.language && config.global.language !== "en"
    ? config.global.language
    : null;
  const projectCtx = await collectProjectContext(opts.repoRoot, languageOverride);
  const projectContextStr = formatProjectContext(projectCtx);

  if (projectContextStr.length > 0) {
    console.log(
      `Project context: language=${projectCtx.language ?? "unknown"}, ` +
      `CLAUDE.md=${projectCtx.claudeMd ? "yes" : "no"}, ` +
      `AGENTS.md=${projectCtx.agentsMd ? "yes" : "no"}`
    );
  }

  // 7. Validate all prompts (lenses + skills) before any I/O
  await validatePrompts(activeLenses, opts.repoRoot, opts.diffelensRoot);
  if (config.skills.length > 0) {
    await validateSkillPrompts(config.skills, opts.repoRoot);
  }

  // 8. Resolve skills (evaluate triggers against diff files)
  const diffFiles = parseDiffFiles(diff);
  const resolvedSkills = await resolveSkills(config, diffFiles, opts.repoRoot);

  if (resolvedSkills.activatedSkills.length > 0) {
    console.log(`Skills activated: ${resolvedSkills.activatedSkills.join(", ")}`);
  }

  for (const lens of activeLenses) {
    console.log(`  [${lens.name}] prompt: ${lens.promptSource}${lens.promptAppendFile ? ` (+${lens.promptAppendFile})` : ""}`);
  }

  // Filter standalone skills by CLI availability
  const activeStandaloneSkills = resolvedSkills.standaloneSkills.filter((s) => {
    if (!availability[s.cli]) {
      console.warn(
        `Warning: Skill "${s.name}" requires "${s.cli}" but not available. Skipping.`
      );
      return false;
    }
    return true;
  });

  const standaloneCount = activeStandaloneSkills.length;
  const skillSuffix = standaloneCount > 0 ? ` + ${standaloneCount} standalone skills` : "";
  console.log(
    `\nRunning ${activeLenses.length} lenses${skillSuffix} in parallel...\n`
  );

  // 9. Run all lenses (with inject skills applied) + standalone skills in parallel
  const lensPromises = activeLenses.map(async (lens) => {
    let resolved: Awaited<ReturnType<typeof resolvePrompt>> | undefined;
    let injected: Awaited<ReturnType<typeof injectSkillContent>> | undefined;
    try {
      resolved = await resolvePrompt(lens, opts.repoRoot, opts.diffelensRoot);
      injected = await injectSkillContent(
        resolved,
        resolvedSkills.injections.get(lens.name),
        lens.name,
      );
      return await runLens(lens, diff, state, opts.repoRoot, injected.absolutePath, projectContextStr, "lens");
    } finally {
      // Clean up whichever temp file was created last (injection wraps the resolved prompt)
      await (injected ?? resolved)?.cleanup();
    }
  });

  const skillPromises = activeStandaloneSkills.map(async (skill) => {
    const promptPath = resolveSkillPromptPath(skill.promptFile, opts.repoRoot);
    const skillRunContext = { ...skill, name: skillRunName(skill.name) };
    return await runLens(skillRunContext, diff, state, opts.repoRoot, promptPath, projectContextStr, "skill");
  });

  const results = await Promise.allSettled([...lensPromises, ...skillPromises]);

  // 10. Collect results + build lens stats for review scope
  const allFindings: Finding[] = [];
  const lensStats: LensStat[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      const r = result.value;
      const count = r.output?.findings.length ?? 0;
      const icon = r.success ? "+" : "x";
      console.log(
        `  ${icon} [${r.lens}] ${r.cli} — ${count} findings (${r.durationMs}ms)`
      );
      if (r.output) {
        allFindings.push(...r.output.findings);
      }
      if (r.error) {
        console.error(`    Error: ${r.error}`);
      }
      lensStats.push({
        name: r.lens,
        type: r.type,
        cli: r.cli,
        durationMs: r.durationMs,
        success: r.success,
        assessment: r.output?.overall_assessment ?? null,
        exploredFiles: r.output?.explored_files?.length ?? null,
        findingCount: r.output?.findings.length ?? null,
      });
    } else {
      console.error(`  x Lens failed:`, result.reason);
    }
  }

  console.log("");

  // 11. Severity filter based on round (applies only to new findings)
  const filtered = filterBySeverityForRound(
    allFindings,
    state.current_round,
    config.convergence
  );
  console.log(
    `Findings: ${allFindings.length} raw -> ${filtered.length} after severity filter`
  );

  // 12. Deduplicate
  const deduplicated = deduplicateFindings(filtered);
  console.log(`  -> ${deduplicated.length} after deduplication`);

  // 12a. Recurrence detection
  const recurrence = detectAndSuppressRecurrences(state, deduplicated);
  if (recurrence.directives.length > 0) {
    console.log(
      `  -> ${recurrence.findings.length} after recurrence suppression ` +
      `(${recurrence.directives.length} suppressed)`
    );
  }

  // 13. Update state
  const newState = updateState(state, recurrence.findings, headSha);
  const finalState = applyRecurrenceSuppressions(newState, recurrence.directives);
  const openCount = finalState.findings.filter(
    (f) => f.status === "open"
  ).length;
  const resolvedCount = finalState.findings.filter(
    (f) => f.status === "addressed"
  ).length;
  console.log(`  Open: ${openCount}, Resolved: ${resolvedCount}\n`);

  // 14. Convergence decision
  const decision = checkConvergence(finalState, config.convergence);
  console.log(`Decision: ${decision}`);

  // 15. Build review scope for summary
  const changeSummary = results
    .filter((r): r is PromiseFulfilledResult<LensRunResult> => r.status === "fulfilled")
    .map((r) => r.value.output?.change_summary)
    .find((s) => s != null) ?? null;

  const scope: ReviewScope = {
    diffStats: parseDiffStats(diff),
    diffFiles,
    totalDiffFiles,
    changeSummary,
    lensStats,
  };

  // 16. Output: GitHub API for github mode with token, stdout otherwise
  const outputState = (
    opts.mode === "github" &&
    process.env.GITHUB_TOKEN &&
    config.output.github.inlineComments
  )
    ? await postInlineAndMergeState(opts.prNumber, finalState, headSha, diffFiles, config.output)
    : finalState;

  if (opts.mode === "github" && process.env.GITHUB_TOKEN) {
    await upsertSummaryComment(opts.prNumber, outputState, decision, scope, config.output);
  } else {
    const { renderSummary } = await import(
      "./output/summary-renderer.js"
    );
    const summary = renderSummary(outputState, decision, opts.mode, scope);
    console.log("\n--- Summary ---");
    console.log(summary);

    if (opts.outputFile) {
      try {
        await writeFile(opts.outputFile, summary, "utf-8");
        console.log(`\n  Summary written to ${opts.outputFile}`);
      } catch (e) {
        console.warn(`  Could not write summary to ${opts.outputFile}: ${e}`);
      }
    }
  }

  // 17. Save state (local mode only; GitHub mode persists via comment)
  if (opts.mode === "local") {
    await saveState(opts.stateDir, outputState);
  }

  console.log("\nAI Review — Done.");
}

// ============================================================
// Helpers extracted from orchestrator for readability
// ============================================================

/** Reconcile resolved GitHub review threads with finding state */
async function reconcileResolvedThreads(
  state: ReviewState,
  prNumber: number,
  commentMap: Record<string, number>
): Promise<ReviewState> {
  const resolvedIds = await fetchResolvedThreads(prNumber);
  if (resolvedIds.size === 0) return state;

  let resolvedCount = 0;
  const updatedFindings = state.findings.map((f) => {
    if (f.status !== "open") return f;
    const commentId = commentMap[f.id];
    if (commentId && resolvedIds.has(commentId)) {
      resolvedCount++;
      return {
        ...f,
        status: "addressed" as const,
        resolution_note: "Resolved by reviewer",
      };
    }
    return f;
  });

  if (resolvedCount === 0) return state;

  console.log(`  Resolved threads detected: ${resolvedCount} finding(s) marked as addressed`);
  return {
    ...state,
    findings: updatedFindings,
    decisions: [...state.decisions, `${resolvedCount} finding(s) resolved by reviewer`],
  };
}

/** Post inline review comments and merge comment IDs back into state */
async function postInlineAndMergeState(
  prNumber: number,
  state: ReviewState,
  headSha: string,
  diffFiles: string[],
  outputConfig: OutputConfig
): Promise<ReviewState> {
  const modifiedFiles = new Set(diffFiles);
  const inlineResult = await submitInlineReview(
    prNumber, state, headSha, modifiedFiles, outputConfig
  );

  if (Object.keys(inlineResult.postedComments).length === 0) return state;

  return {
    ...state,
    last_inline_review_sha: headSha,
    findings: state.findings.map((f) => {
      const commentId = inlineResult.postedComments[f.id];
      return commentId ? { ...f, inline_comment_id: commentId } : f;
    }),
  };
}

// In ESM, use import.meta.url to determine if this is the entry point.
// realpathSync resolves npm global symlinks (e.g. /usr/local/bin/diffelens → .../dist/main.js)
const __filename = fileURLToPath(import.meta.url);
const isEntryPoint =
  process.argv[1] && realpathSync(process.argv[1]) === __filename;

if (isEntryPoint) {
  main().catch((err) => {
    console.error("AI Review failed:", err);
    process.exit(1);
  });
}
