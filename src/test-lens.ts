import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { runLens } from "./lens-runner.js";
import { loadOrCreateState } from "./state/review-state.js";
import { renderSummary } from "./output/summary-renderer.js";
import { collectProjectContext, formatProjectContext } from "./project-context.js";
import { resolvePrompt } from "./prompt-resolver.js";

// ============================================================
// Single lens test runner
// Usage: npx tsx src/test-lens.ts readability
//   (Pass PR_NUMBER, BASE_SHA, HEAD_SHA as env vars,
//    or they will be auto-fetched via gh cli)
// ============================================================

async function main() {
  const lensName = process.argv[2];
  if (!lensName) {
    console.error("Usage: tsx src/test-lens.ts <lens_name>");
    console.error("  e.g.: tsx src/test-lens.ts readability");
    process.exit(1);
  }

  const configPath = process.env.CONFIG_PATH ?? ".diffelens.yaml";
  const config = await loadConfig(configPath);

  const lens = config.lenses.find((l) => l.name === lensName);
  if (!lens) {
    console.error(
      `Lens "${lensName}" not found. Available: ${config.lenses.map((l) => l.name).join(", ")}`
    );
    process.exit(1);
  }

  // PR info (from env vars or gh cli)
  const prNumber = parseInt(
    process.env.PR_NUMBER ??
      execSync("gh pr view --json number -q .number", {
        encoding: "utf-8",
      }).trim()
  );

  const baseSha =
    process.env.BASE_SHA ??
    execSync("gh pr view --json baseRefOid -q .baseRefOid", {
      encoding: "utf-8",
    }).trim();

  const headSha =
    process.env.HEAD_SHA ??
    execSync("gh pr view --json headRefOid -q .headRefOid", {
      encoding: "utf-8",
    }).trim();

  console.log(`PR: #${prNumber}`);
  console.log(`Base: ${baseSha.slice(0, 7)}`);
  console.log(`Head: ${headSha.slice(0, 7)}`);
  console.log(`Lens: ${lensName} (${lens.cli} / ${lens.model})\n`);

  // Fetch diff
  const diff = execSync(`git diff ${baseSha}...${headSha}`, {
    encoding: "utf-8",
    maxBuffer: 5 * 1024 * 1024,
  });
  console.log(`Diff: ${diff.length} chars\n`);

  // State
  const stateDir = process.env.STATE_DIR ?? ".diffelens-state";
  const state = await loadOrCreateState(
    stateDir,
    prNumber,
    baseSha,
    headSha,
    config.global.max_rounds
  );

  // Project context
  const projectCtx = await collectProjectContext(process.cwd(), null);
  const projectContextStr = formatProjectContext(projectCtx);

  // Resolve prompt
  const diffelensRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const resolved = await resolvePrompt(lens, process.cwd(), diffelensRoot);

  // Execute
  let result;
  try {
    result = await runLens(lens, diff, state, process.cwd(), resolved.absolutePath, projectContextStr);
  } finally {
    await resolved.cleanup();
  }

  console.log("\n--- Result ---");
  console.log(`Success: ${result.success}`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Findings: ${result.output?.findings.length ?? 0}`);
  console.log(
    `Assessment: ${result.output?.overall_assessment ?? "N/A"}`
  );

  if (result.output?.findings.length) {
    console.log("\n--- Findings ---");
    for (const f of result.output.findings) {
      console.log(
        `  [${f.severity}] ${f.file}:${f.line_start} — ${f.summary}`
      );
      if (f.suggestion) console.log(`    💡 ${f.suggestion}`);
    }
  }

  if (result.error) {
    console.log("\n--- Error ---");
    console.log(result.error);
  }

  if (result.output?.explored_files?.length) {
    console.log("\n--- Explored Files ---");
    for (const f of result.output.explored_files) {
      console.log(`  ${f}`);
    }
  }
}

main().catch(console.error);
