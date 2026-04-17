import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getAdapter } from "./adapters/index.js";
import type { CLIRequest, LensOutput, Finding } from "./adapters/index.js";
import type { RunContext } from "./config.js";
import type { ReviewState } from "./state/review-state.js";
import { SEVERITY_RANK } from "./severity.js";

// ============================================================
// Lens/Skill Execution: RunContext -> CLIAdapter -> LensRunResult
// ============================================================

export interface LensRunResult {
  lens: string;
  type: "lens" | "skill";
  cli: string;
  output: LensOutput | null;
  durationMs: number;
  success: boolean;
  error?: string;
}

export async function runLens(
  config: RunContext,
  diff: string,
  state: ReviewState,
  repoRoot: string,
  resolvedPromptPath: string,
  projectContext?: string,
  type: "lens" | "skill" = "lens"
): Promise<LensRunResult> {
  const adapter = await getAdapter(config.cli);

  // Determine working directory
  let cwd: string;
  let tempDir: string | null = null;

  if (config.isolation === "tempdir") {
    // Readability: run in a temp directory with only the diff
    tempDir = await mkdtemp(join(tmpdir(), "ai-review-"));
    await writeFile(join(tempDir, "diff.patch"), diff);
    cwd = tempDir;
  } else {
    cwd = repoRoot;
  }

  try {
    const userPrompt = buildUserPrompt(config.name, diff, state, projectContext ?? "");

    const request: CLIRequest = {
      systemPromptPath: resolvedPromptPath,
      userPrompt,
      cwd,
      toolPolicy: config.toolPolicy,
      model: config.model,
      timeoutMs: config.timeoutMs,
      baseUrl: config.baseUrl,
    };

    console.log(`    [${config.name}] Executing ${adapter.name} (${config.model})...`);
    const response = await adapter.execute(request);

    if (response.exitCode !== 0 && !response.parsed) {
      console.error(
        `    [${config.name}] CLI failed (exit=${response.exitCode})`
      );
      if (response.rawStderr) {
        console.error(`    [${config.name}] stderr: ${response.rawStderr}`);
      }
      if (response.rawStdout) {
        console.error(`    [${config.name}] stdout: ${response.rawStdout}`);
      }
      return {
        lens: config.name,
        type,
        cli: adapter.name,
        output: null,
        durationMs: response.durationMs,
        success: false,
        error: response.rawStderr || "Failed to parse output",
      };
    }

    // Warn when CLI succeeded but output couldn't be parsed
    if (!response.parsed) {
      const preview = response.rawStdout.slice(0, 500);
      console.warn(
        `    [${config.name}] Parse failed — rawStdout preview:\n${preview}`
      );
    }

    // Attach lens name to findings + apply severityCap
    const output = applySeverityCap(response.parsed, config);

    return {
      lens: config.name,
      type,
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

/**
 * Downgrade findings that exceed the lens severityCap and attach the lens name.
 */
function applySeverityCap(
  parsed: LensOutput | null,
  config: RunContext
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
  state: ReviewState,
  projectContext: string
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

  const parts = [
    `Review the following diff from the ${lensName} perspective.`,
    `Output ONLY the JSON format specified in the system prompt.`,
    `Do not wrap in markdown code fences — return the raw JSON body only.`,
    ``,
  ];

  if (projectContext) {
    parts.push(projectContext, ``);
  }

  parts.push(
    `## Previous Round State`,
    stateJson,
    ``,
    `## Diff`,
    diff
  );

  return parts.join("\n");
}
