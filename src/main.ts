#!/usr/bin/env node
import { join } from "path";
import { loadConfig, loadConfigWithFallback } from "./config.js";
import { runLens, type LensRunResult } from "./lens-runner.js";
import {
  loadOrCreateState,
  createInitialState,
  advanceRoundIfNeeded,
  updateState,
  saveState,
} from "./state/review-state.js";
import { deduplicateFindings } from "./deduplicator.js";
import {
  checkConvergence,
  filterBySeverityForRound,
} from "./convergence.js";
import {
  upsertSummaryComment,
  postEscalationComment,
  loadStateFromComment,
} from "./output/github-client.js";
import { checkAvailability, type Finding } from "./adapters/index.js";
import { filterDiffByExcludePatterns } from "./filters.js";
import { resolveOptions, type RunOptions } from "./options.js";
import { fetchDiff, hashDiff, resolveGitRef } from "./diff.js";
import { collectProjectContext, formatProjectContext } from "./project-context.js";
import { resolvePrompt, validatePrompts } from "./prompt-resolver.js";

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
  const fallbackConfigPath = join(opts.diffelensRoot, ".ai-review.yaml");
  const config =
    opts.mode === "local"
      ? await loadConfigWithFallback(opts.configPath, fallbackConfigPath)
      : await loadConfig(opts.configPath);

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
    const commentState = await loadStateFromComment(opts.prNumber);
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

  // 7. Validate prompts + run all lenses in parallel
  await validatePrompts(activeLenses, opts.repoRoot, opts.diffelensRoot);

  for (const lens of activeLenses) {
    console.log(`  [${lens.name}] prompt: ${lens.promptSource}${lens.promptAppendFile ? ` (+${lens.promptAppendFile})` : ""}`);
  }

  console.log(
    `\nRunning ${activeLenses.length} lenses in parallel...\n`
  );

  const results = await Promise.allSettled(
    activeLenses.map(async (lens) => {
      const resolved = await resolvePrompt(lens, opts.repoRoot, opts.diffelensRoot);
      try {
        return await runLens(lens, diff, state, opts.repoRoot, resolved.absolutePath, projectContextStr);
      } finally {
        await resolved.cleanup();
      }
    })
  );

  // 7. Collect results
  const allFindings: Finding[] = [];
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
    } else {
      console.error(`  x Lens failed:`, result.reason);
    }
  }

  console.log("");

  // 8. Severity filter based on round (applies only to new findings)
  const filtered = filterBySeverityForRound(
    allFindings,
    state.current_round,
    config.convergence
  );
  console.log(
    `Findings: ${allFindings.length} raw -> ${filtered.length} after severity filter`
  );

  // 9. Deduplicate
  const deduplicated = deduplicateFindings(filtered);
  console.log(`  -> ${deduplicated.length} after deduplication`);

  // 10. Update state
  const newState = updateState(state, deduplicated, headSha);
  const openCount = newState.findings.filter(
    (f) => f.status === "open"
  ).length;
  const resolvedCount = newState.findings.filter(
    (f) => f.status === "addressed"
  ).length;
  console.log(`  Open: ${openCount}, Resolved: ${resolvedCount}\n`);

  // 11. Convergence decision
  const decision = checkConvergence(newState, config.convergence);
  console.log(`Decision: ${decision}`);

  // 12. Output: GitHub API for github mode with token, stdout otherwise
  if (opts.mode === "github" && process.env.GITHUB_TOKEN) {
    await upsertSummaryComment(opts.prNumber, newState, decision);
  } else {
    const { renderSummary } = await import(
      "./output/summary-renderer.js"
    );
    console.log("\n--- Summary ---");
    console.log(renderSummary(newState, decision, opts.mode));
  }

  // 13. Save state (local mode only; GitHub mode persists via comment)
  if (opts.mode === "local") {
    await saveState(opts.stateDir, newState);
  }

  console.log("\nAI Review — Done.");
}

// In ESM, use import.meta.url to determine if this is the entry point
const isEntryPoint =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isEntryPoint) {
  main().catch((err) => {
    console.error("AI Review failed:", err);
    process.exit(1);
  });
}
