import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getAdapter } from "./adapters/index.js";
import type { CLIRequest, LensOutput, Finding } from "./adapters/index.js";
import type { LensConfig } from "./config.js";
import type { ReviewState } from "./state/review-state.js";

// ============================================================
// レンズ実行: LensConfig → CLIAdapter → LensRunResult
// ============================================================

export interface LensRunResult {
  lens: string;
  cli: string;
  output: LensOutput | null;
  durationMs: number;
  success: boolean;
  error?: string;
}

export async function runLens(
  config: LensConfig,
  diff: string,
  state: ReviewState,
  repoRoot: string
): Promise<LensRunResult> {
  const adapter = await getAdapter(config.cli);

  // 実行ディレクトリの決定
  let cwd: string;
  let tempDir: string | null = null;

  if (config.isolation === "tempdir") {
    // Readability: diffだけの一時ディレクトリで実行
    tempDir = await mkdtemp(join(tmpdir(), "ai-review-"));
    await writeFile(join(tempDir, "diff.patch"), diff);
    cwd = tempDir;
  } else {
    cwd = repoRoot;
  }

  try {
    const userPrompt = buildUserPrompt(config.name, diff, state);

    const request: CLIRequest = {
      systemPromptPath: join(repoRoot, config.promptFile),
      userPrompt,
      cwd,
      toolPolicy: config.toolPolicy,
      maxTurns: config.maxTurns,
      model: config.model,
      timeoutMs: config.timeoutMs,
    };

    console.log(`    [${config.name}] Executing ${adapter.name} (${config.model})...`);
    const response = await adapter.execute(request);

    if (response.exitCode !== 0 && !response.parsed) {
      console.error(
        `    [${config.name}] CLI failed (exit=${response.exitCode})`
      );
      if (response.rawStderr) {
        console.error(
          `    [${config.name}] stderr: ${response.rawStderr.slice(0, 300)}`
        );
      }
      return {
        lens: config.name,
        cli: adapter.name,
        output: null,
        durationMs: response.durationMs,
        success: false,
        error:
          response.rawStderr.slice(0, 500) || "Failed to parse output",
      };
    }

    // findings にレンズ名を付与 + severityCap を適用
    const output = applySeverityCap(response.parsed, config);

    return {
      lens: config.name,
      cli: adapter.name,
      output,
      durationMs: response.durationMs,
      success: true,
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const SEVERITY_RANK: Record<string, number> = {
  nitpick: 1,
  warning: 2,
  blocker: 3,
};

/**
 * レンズの severityCap を超える severity のfindingsをダウングレードし、レンズ名を付与する。
 */
function applySeverityCap(
  parsed: LensOutput | null,
  config: LensConfig
): LensOutput | null {
  if (!parsed) return null;

  const capRank = SEVERITY_RANK[config.severityCap] ?? 3;
  const cappedFindings = parsed.findings.map((f) => {
    const findingRank = SEVERITY_RANK[f.severity] ?? 1;
    return {
      ...f,
      lens: config.name,
      severity: findingRank > capRank ? config.severityCap : f.severity,
    };
  });

  return {
    ...parsed,
    findings: cappedFindings,
  };
}

function buildUserPrompt(
  lensName: string,
  diff: string,
  state: ReviewState
): string {
  const stateJson = JSON.stringify(
    {
      current_round: state.current_round,
      findings: state.findings.filter((f) => f.status === "open"),
      decisions: state.decisions,
    },
    null,
    2
  );

  return [
    `以下のdiffを${lensName}の観点でレビューしてください。`,
    `出力はシステムプロンプトで指定されたJSON形式のみで返してください。`,
    `マークダウンのコードフェンスで囲まず、JSON本体だけを出力してください。`,
    ``,
    `## 前ラウンドの状態`,
    stateJson,
    ``,
    `## Diff`,
    diff,
  ].join("\n");
}
