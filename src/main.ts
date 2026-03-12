import { execSync } from "child_process";
import { loadConfig } from "./config.js";
import { runLens, type LensRunResult } from "./lens-runner.js";
import {
  loadOrCreateState,
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
} from "./output/github-client.js";
import { checkAvailability, type Finding } from "./adapters/index.js";

// ============================================================
// AI PR Review Orchestrator
// ============================================================

async function main() {
  console.log("🤖 AI PR Review — Starting...\n");

  // --- 環境変数 ---
  const prNumber = parseInt(process.env.PR_NUMBER ?? "0");
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  const repoRoot = process.cwd();
  const configPath = process.env.CONFIG_PATH ?? ".ai-review.yaml";

  if (!prNumber || !baseSha || !headSha) {
    console.error(
      "Required env vars: PR_NUMBER, BASE_SHA, HEAD_SHA"
    );
    process.exit(1);
  }

  // 1. CLI利用可否チェック
  const availability = await checkAvailability();
  console.log("CLI availability:", availability);

  // 2. 設定読み込み
  const config = await loadConfig(configPath);
  console.log(
    `Config: ${config.lenses.length} lenses, max_rounds=${config.global.max_rounds}\n`
  );

  // 利用可能なレンズだけに絞る
  const activeLenses = config.lenses.filter((l) => {
    if (!availability[l.cli]) {
      console.warn(
        `⚠ Lens "${l.name}" requires "${l.cli}" but not available. Skipping.`
      );
      return false;
    }
    return true;
  });

  if (activeLenses.length === 0) {
    console.error("No lenses available. Install at least one CLI tool.");
    process.exit(1);
  }

  // 3. diff取得 + exclude_patterns フィルタ
  console.log("Fetching diff...");
  const rawDiff = execSync(`git diff ${baseSha}...${headSha}`, {
    encoding: "utf-8",
    maxBuffer: 5 * 1024 * 1024,
  });
  const diff = filterDiffByExcludePatterns(rawDiff, config.filters.exclude_patterns);
  console.log(`  Diff size: ${rawDiff.length} → ${diff.length} chars (after exclude filter)\n`);

  if (diff.trim().length === 0) {
    console.log("No diff found (or all files excluded). Nothing to review.");
    return;
  }

  // 4. 前ラウンドの状態
  const state = await loadOrCreateState(
    prNumber,
    baseSha,
    headSha,
    config.global.max_rounds
  );
  console.log(`Round: ${state.current_round}/${state.max_rounds}`);
  console.log(
    `  Previous findings: ${state.findings.length} (open: ${state.findings.filter((f) => f.status === "open").length})\n`
  );

  // 5. 収束チェック（max_rounds超過）
  if (state.current_round > state.max_rounds) {
    console.log("Max rounds exceeded. Escalating to human reviewer.");
    await postEscalationComment(prNumber, state);
    await saveState(state);
    return;
  }

  // 6. 全レンズ並列実行
  console.log(
    `Running ${activeLenses.length} lenses in parallel...\n`
  );

  const results = await Promise.allSettled(
    activeLenses.map((lens) => runLens(lens, diff, state, repoRoot))
  );

  // 7. 結果収集
  const allFindings: Finding[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      const r = result.value;
      const count = r.output?.findings.length ?? 0;
      const icon = r.success ? "✓" : "✗";
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
      console.error(`  ✗ Lens failed:`, result.reason);
    }
  }

  console.log("");

  // 8. ラウンドに応じたseverityフィルタ（新規findingsのみ制限）
  const filtered = filterBySeverityForRound(
    allFindings,
    state.current_round,
    config.convergence
  );
  console.log(
    `Findings: ${allFindings.length} raw → ${filtered.length} after severity filter`
  );

  // 9. 重複排除
  const deduplicated = deduplicateFindings(filtered);
  console.log(`  → ${deduplicated.length} after deduplication`);

  // 10. 状態更新
  const newState = updateState(state, deduplicated, headSha);
  const openCount = newState.findings.filter(
    (f) => f.status === "open"
  ).length;
  const resolvedCount = newState.findings.filter(
    (f) => f.status === "addressed"
  ).length;
  console.log(`  Open: ${openCount}, Resolved: ${resolvedCount}\n`);

  // 11. 収束判定
  const decision = checkConvergence(newState, config.convergence);
  console.log(`Decision: ${decision}`);

  // 12. サマリーコメント投稿/更新
  if (process.env.GITHUB_TOKEN) {
    await upsertSummaryComment(prNumber, newState, decision);
  } else {
    console.log(
      "\n  GITHUB_TOKEN not set — skipping comment posting."
    );
    // ローカルテスト用にサマリーを stdout に出力
    const { renderSummary } = await import(
      "./output/summary-renderer.js"
    );
    console.log("\n--- Summary Preview ---");
    console.log(renderSummary(newState, decision));
  }

  // 13. 状態保存
  await saveState(newState);

  console.log("\n🤖 AI PR Review — Done.");
}

/**
 * グロブパターンを正規表現に変換する。
 * `**\/` は「任意のディレクトリプレフィックス（空を含む）」として扱う。
 */
export function globToRegex(pattern: string): RegExp {
  // 1. **/ と ** をトークンに置換（\x00, \x01 は入力に出現しない制御文字）
  let result = pattern
    .replace(/\*\*\//g, "\x00")
    .replace(/\*\*/g, "\x01");

  // 2. 正規表現メタ文字をエスケープ（* と ? はグロブ用に残す）
  result = result.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // 3. グロブ → 正規表現
  result = result
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, "(.+/)?")
    .replace(/\x01/g, ".*");

  return new RegExp(`^${result}$`);
}

/**
 * unified diff を解析し、exclude_patterns にマッチするファイルのハンクを除外する。
 */
export function filterDiffByExcludePatterns(diff: string, patterns: string[]): string {
  if (patterns.length === 0) return diff;

  const regexes = patterns.map(globToRegex);

  const shouldExclude = (filePath: string): boolean =>
    regexes.some((re) => re.test(filePath));

  // unified diff を "diff --git" 境界で分割
  const chunks = diff.split(/^(?=diff --git )/m);
  const kept = chunks.filter((chunk) => {
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!headerMatch) return true; // diff ヘッダーでなければ残す
    const filePath = headerMatch[2];
    return !shouldExclude(filePath);
  });

  return kept.join("");
}

// ESM では import.meta.url がエントリポイントかどうかで自動実行を制御
const isEntryPoint =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isEntryPoint) {
  main().catch((err) => {
    console.error("AI Review failed:", err);
    process.exit(1);
  });
}
