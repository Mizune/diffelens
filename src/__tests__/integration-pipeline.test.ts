import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "../config.js";
import { runLens } from "../lens-runner.js";
import { updateState } from "../state/review-state.js";
import { deduplicateFindings } from "../deduplicator.js";
import { filterBySeverityForRound, checkConvergence } from "../convergence.js";
import { renderSummary } from "../output/summary-renderer.js";
import { filterDiffByExcludePatterns, globToRegex } from "../filters.js";
import type { ReviewState } from "../state/review-state.js";
import type { Finding, CLIAdapter, CLIResponse } from "../adapters/types.js";
import { join } from "path";

// ============================================================
// Mock CLI Adapter
// ============================================================

function mockCLIResponse(findings: Finding[]): CLIResponse {
  return {
    parsed: {
      findings,
      overall_assessment: findings.some((f) => f.severity === "blocker")
        ? "significant_issues"
        : findings.length > 0
          ? "minor_issues"
          : "clean",
    },
    rawStdout: JSON.stringify({ findings }),
    rawStderr: "",
    exitCode: 0,
    durationMs: 100,
  };
}

vi.mock("../adapters/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../adapters/index.js")>();
  return {
    ...original,
    getAdapter: vi.fn().mockResolvedValue({
      name: "mock-cli",
      isAvailable: () => Promise.resolve(true),
      execute: vi.fn(),
    } satisfies CLIAdapter),
  };
});

import { getAdapter } from "../adapters/index.js";
const mockedGetAdapter = vi.mocked(getAdapter);

// ============================================================
// Test Data
// ============================================================

// yarn.lock matches **/*.lock, dist/ matches **/dist/**
const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..abcdefg 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,6 +10,8 @@ export function processData(input: any) {
   const result = transform(input);
+  // FIXME: no null check on input
+  const name = input.user.name;
   return result;
 }
diff --git a/src/utils.ts b/src/utils.ts
index 2345678..bcdefgh 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,4 +1,4 @@
-export function formatDate(d: Date): string {
+export function fmt(d: Date): string {
   return d.toISOString();
 }
diff --git a/yarn.lock b/yarn.lock
index 0000000..1111111 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1,3 +1,3 @@
-foo@1.0.0:
+foo@1.0.1:
diff --git a/dist/bundle.js b/dist/bundle.js
index aaaaaaa..bbbbbbb 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-var a=1;
+var a=2;
`;

const READABILITY_FINDINGS: Finding[] = [
  {
    file: "src/utils.ts",
    line_start: 1,
    line_end: 1,
    severity: "warning",
    category: "naming",
    summary: "Function name 'fmt' is too abbreviated",
    suggestion: "Use 'formatDate' for clarity",
  },
];

const ARCHITECTURAL_FINDINGS: Finding[] = [
  {
    file: "src/app.ts",
    line_start: 12,
    line_end: 12,
    severity: "warning",
    category: "direct_access",
    summary: "Direct property access without type guard",
    suggestion: "Add a type narrowing check before accessing nested properties",
    lens: "architectural",
  },
];

const BUG_RISK_FINDINGS: Finding[] = [
  {
    file: "src/app.ts",
    line_start: 12,
    line_end: 12,
    severity: "blocker",
    category: "null_deref",
    summary: "Potential null dereference on input.user.name",
    suggestion: "Add null check: if (!input?.user?.name) throw new Error(...)",
  },
];

function makeInitialState(): ReviewState {
  return {
    schema_version: "1.0",
    pr_number: 42,
    repository: "test/diffelens",
    current_round: 1,
    max_rounds: 3,
    base_sha: "aaa1111",
    head_sha: "bbb2222",
    findings: [],
    round_history: [],
    decisions: [],
  };
}

const CONFIG_PATH = join(import.meta.dirname, "../../.ai-review.yaml");

// ============================================================
// globToRegex
// ============================================================

describe("globToRegex", () => {
  it("matches **/*.lock against .lock files (root and nested)", () => {
    const re = globToRegex("**/*.lock");
    expect(re.test("yarn.lock")).toBe(true);
    expect(re.test("pnpm-lock.lock")).toBe(true);
    expect(re.test("sub/dir/file.lock")).toBe(true);
    // package-lock.json ends in .json, not .lock
    expect(re.test("package-lock.json")).toBe(false);
  });

  it("matches **/dist/** against dist paths (root and nested)", () => {
    const re = globToRegex("**/dist/**");
    expect(re.test("dist/bundle.js")).toBe(true);
    expect(re.test("packages/app/dist/index.js")).toBe(true);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches **/*.generated.* against generated files", () => {
    const re = globToRegex("**/*.generated.*");
    expect(re.test("src/file.generated.ts")).toBe(true);
    expect(re.test("file.generated.js")).toBe(true);
    expect(re.test("src/file.ts")).toBe(false);
  });

  it("matches **/node_modules/**", () => {
    const re = globToRegex("**/node_modules/**");
    expect(re.test("node_modules/foo/index.js")).toBe(true);
    expect(re.test("packages/a/node_modules/b/c.js")).toBe(true);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches **/*.min.js", () => {
    const re = globToRegex("**/*.min.js");
    expect(re.test("dist/app.min.js")).toBe(true);
    expect(re.test("app.min.js")).toBe(true);
    expect(re.test("app.js")).toBe(false);
  });
});

// ============================================================
// filterDiffByExcludePatterns
// ============================================================

describe("filterDiffByExcludePatterns", () => {
  it("excludes .lock and dist/ chunks from diff", () => {
    const filtered = filterDiffByExcludePatterns(SAMPLE_DIFF, ["**/*.lock", "**/dist/**"]);
    expect(filtered).not.toContain("yarn.lock");
    expect(filtered).not.toContain("dist/bundle.js");
    expect(filtered).toContain("src/app.ts");
    expect(filtered).toContain("src/utils.ts");
  });

  it("returns original diff when no patterns", () => {
    expect(filterDiffByExcludePatterns(SAMPLE_DIFF, [])).toBe(SAMPLE_DIFF);
  });

  it("excludes multiple patterns", () => {
    const filtered = filterDiffByExcludePatterns(SAMPLE_DIFF, ["**/*.lock", "**/utils.*"]);
    expect(filtered).not.toContain("yarn.lock");
    expect(filtered).not.toContain("src/utils.ts");
    expect(filtered).toContain("src/app.ts");
  });
});

// ============================================================
// Pipeline Integration
// ============================================================

describe("Pipeline Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("full pipeline: config → diff filter → lens execution → dedup → convergence → summary", async () => {
    // 1. Config loading
    const config = await loadConfig(CONFIG_PATH);
    expect(config.lenses).toHaveLength(3);

    // 2. Diff filtering — yarn.lock and dist/ should be excluded
    const filtered = filterDiffByExcludePatterns(SAMPLE_DIFF, config.filters.exclude_patterns);
    expect(filtered).not.toContain("yarn.lock");
    expect(filtered).not.toContain("dist/bundle.js");
    expect(filtered).toContain("src/app.ts");

    // 3. Lens execution (mocked per lens name)
    const findingsMap: Record<string, Finding[]> = {
      readability: READABILITY_FINDINGS,
      architectural: ARCHITECTURAL_FINDINGS,
      bug_risk: BUG_RISK_FINDINGS,
    };

    // Each getAdapter call returns a unique adapter so prompt content determines findings
    mockedGetAdapter.mockImplementation(async (name) => ({
      name: "mock-cli",
      isAvailable: () => Promise.resolve(true),
      execute: vi.fn().mockImplementation(async (req) => {
        // Determine which lens by checking system prompt path
        const lensName = Object.keys(findingsMap).find((l) => req.systemPromptPath.includes(l));
        return mockCLIResponse(findingsMap[lensName ?? "readability"]);
      }),
    }));

    const state = makeInitialState();
    const repoRoot = join(import.meta.dirname, "../..");

    const results = await Promise.allSettled(
      config.lenses.map((lens) => runLens(lens, filtered, state, repoRoot))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(3);

    // 4. Collect findings
    const allFindings: Finding[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.output) {
        allFindings.push(...result.value.output.findings);
      }
    }
    expect(allFindings).toHaveLength(3);

    // 5. Severity filter (round 1 = all severities)
    const severityFiltered = filterBySeverityForRound(allFindings, 1, config.convergence);
    expect(severityFiltered).toHaveLength(3);

    // 6. Deduplication (different categories → no dedup)
    const deduplicated = deduplicateFindings(severityFiltered);
    expect(deduplicated).toHaveLength(3);

    // 7. State update (immutable)
    const newState = updateState(state, deduplicated, "bbb2222");
    expect(newState.findings).toHaveLength(3);
    expect(newState.findings.filter((f) => f.status === "open")).toHaveLength(3);
    expect(newState.round_history).toHaveLength(1);
    expect(state.findings).toHaveLength(0); // original not mutated

    // 8. Convergence — blocker exists → request_changes
    const decision = checkConvergence(newState, config.convergence);
    expect(decision).toBe("request_changes");

    // 9. Summary
    const summary = renderSummary(newState, decision);
    expect(summary).toContain("CHANGES REQUESTED");
    expect(summary).toContain("Blockers | 1");
    expect(summary).toContain("Warnings | 2");
    expect(summary).toContain("null dereference");
    expect(summary).toContain("Round 1/3");
  });

  it("severityCap downgrades blocker to warning for readability lens", async () => {
    const config = await loadConfig(CONFIG_PATH);
    const readabilityLens = config.lenses.find((l) => l.name === "readability")!;
    expect(readabilityLens.severityCap).toBe("warning");

    const blockerFinding: Finding[] = [{
      file: "src/app.ts",
      line_start: 1,
      line_end: 1,
      severity: "blocker",
      category: "naming",
      summary: "This should be downgraded",
      suggestion: "fix it",
    }];

    mockedGetAdapter.mockResolvedValue({
      name: "mock-cli",
      isAvailable: () => Promise.resolve(true),
      execute: vi.fn().mockResolvedValue(mockCLIResponse(blockerFinding)),
    });

    const state = makeInitialState();
    const repoRoot = join(import.meta.dirname, "../..");
    const result = await runLens(readabilityLens, SAMPLE_DIFF, state, repoRoot);

    expect(result.success).toBe(true);
    expect(result.output!.findings[0].severity).toBe("warning");
    expect(result.output!.findings[0].lens).toBe("readability");
  });

  it("round 2 filters out nitpicks", async () => {
    const config = await loadConfig(CONFIG_PATH);
    const findings: Finding[] = [
      { file: "a.ts", line_start: 1, line_end: 1, severity: "blocker", category: "bug", summary: "s", suggestion: "s" },
      { file: "b.ts", line_start: 1, line_end: 1, severity: "warning", category: "style", summary: "s", suggestion: "s" },
      { file: "c.ts", line_start: 1, line_end: 1, severity: "nitpick", category: "naming", summary: "s", suggestion: "s" },
    ];

    const result = filterBySeverityForRound(findings, 2, config.convergence);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.severity !== "nitpick")).toBe(true);
  });

  it("deduplication keeps higher severity when findings overlap", () => {
    const findings: Finding[] = [
      { file: "src/app.ts", line_start: 10, line_end: 15, severity: "warning", category: "null_deref", summary: "architectural", suggestion: "fix", lens: "architectural" },
      { file: "src/app.ts", line_start: 12, line_end: 14, severity: "blocker", category: "null_deref", summary: "bug_risk", suggestion: "fix", lens: "bug_risk" },
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("multi-round: round 1 blockers → round 2 resolved → approve", async () => {
    const config = await loadConfig(CONFIG_PATH);
    const state = makeInitialState();

    // Round 1
    const round1Findings: Finding[] = [{
      file: "src/app.ts", line_start: 12, line_end: 12,
      severity: "blocker", category: "null_deref",
      summary: "null dereference", suggestion: "add check", lens: "bug_risk",
    }];
    const stateAfterR1 = updateState(state, round1Findings, "commit-r1");
    expect(checkConvergence(stateAfterR1, config.convergence)).toBe("request_changes");

    // Round 2: resolved
    const stateR2 = { ...stateAfterR1, current_round: 2, head_sha: "commit-r2" };
    const stateAfterR2 = updateState(stateR2, [], "commit-r2");
    expect(stateAfterR2.findings[0].status).toBe("addressed");
    expect(checkConvergence(stateAfterR2, config.convergence)).toBe("approve");

    const summary = renderSummary(stateAfterR2, "approve");
    expect(summary).toContain("APPROVED");
    expect(summary).toContain("Resolved | 1");
  });

  it("max rounds with unresolved blockers → escalate", async () => {
    const config = await loadConfig(CONFIG_PATH);
    const blocker: Finding[] = [{
      file: "src/danger.ts", line_start: 1, line_end: 1,
      severity: "blocker", category: "security",
      summary: "SQL injection", suggestion: "use parameterized query", lens: "bug_risk",
    }];

    let state = makeInitialState();
    for (let round = 1; round <= 3; round++) {
      state = { ...state, current_round: round, head_sha: `commit-r${round}` };
      state = updateState(state, blocker, `commit-r${round}`);
    }

    expect(checkConvergence(state, config.convergence)).toBe("escalate");

    const summary = renderSummary(state, "escalate");
    expect(summary).toContain("ESCALATED");
    expect(summary).toContain("SQL injection");
  });
});
