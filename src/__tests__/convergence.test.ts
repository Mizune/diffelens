import { describe, it, expect } from "vitest";
import { checkConvergence, filterBySeverityForRound } from "../convergence.js";
import type { ReviewState } from "../state/review-state.js";
import type { ConvergenceConfig } from "../config.js";
import type { Finding } from "../adapters/types.js";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    schema_version: "1.0",
    pr_number: 1,
    repository: "test/repo",
    current_round: 1,
    max_rounds: 3,
    base_sha: "aaa",
    head_sha: "bbb",
    findings: [],
    round_history: [],
    decisions: [],
    ...overrides,
  };
}

const convergence: ConvergenceConfig = {
  round_severities: [
    ["blocker", "warning", "nitpick"],
    ["blocker", "warning"],
    ["blocker"],
  ],
  approve_condition: "zero_blockers",
};

describe("checkConvergence", () => {
  it("returns approve when no open blockers", () => {
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "open",
          severity: "warning",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          category: "naming",
          summary: "bad name",
          suggestion: "rename",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    expect(checkConvergence(state, convergence)).toBe("approve");
  });

  it("returns request_changes when blockers exist", () => {
    const state = makeState({
      findings: [
        {
          id: "b-001",
          lens: "bug_risk",
          status: "open",
          severity: "blocker",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          category: "null_check",
          summary: "missing null check",
          suggestion: "add check",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    expect(checkConvergence(state, convergence)).toBe("request_changes");
  });

  it("returns escalate at max rounds with blockers", () => {
    const state = makeState({
      current_round: 3,
      max_rounds: 3,
      findings: [
        {
          id: "b-001",
          lens: "bug_risk",
          status: "open",
          severity: "blocker",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          category: "null_check",
          summary: "missing null check",
          suggestion: "add check",
          first_raised_round: 1,
          last_evaluated_round: 3,
          resolution_note: null,
        },
      ],
    });
    expect(checkConvergence(state, convergence)).toBe("escalate");
  });

  it("returns approve with zero_blockers_and_warnings condition when no blockers/warnings", () => {
    const strictConvergence: ConvergenceConfig = {
      ...convergence,
      approve_condition: "zero_blockers_and_warnings",
    };
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "open",
          severity: "nitpick",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          category: "naming",
          summary: "nitpick",
          suggestion: "fix",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    expect(checkConvergence(state, strictConvergence)).toBe("approve");
  });

  it("returns request_changes with zero_blockers_and_warnings when warnings exist", () => {
    const strictConvergence: ConvergenceConfig = {
      ...convergence,
      approve_condition: "zero_blockers_and_warnings",
    };
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "open",
          severity: "warning",
          file: "a.ts",
          line_start: 1,
          line_end: 1,
          category: "naming",
          summary: "warning",
          suggestion: "fix",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    expect(checkConvergence(state, strictConvergence)).toBe("request_changes");
  });
});

describe("filterBySeverityForRound", () => {
  const findings: Finding[] = [
    { file: "a.ts", line_start: 1, line_end: 1, severity: "blocker", category: "bug", summary: "s", suggestion: "s" },
    { file: "b.ts", line_start: 1, line_end: 1, severity: "warning", category: "style", summary: "s", suggestion: "s" },
    { file: "c.ts", line_start: 1, line_end: 1, severity: "nitpick", category: "naming", summary: "s", suggestion: "s" },
  ];

  it("round 1 keeps all severities", () => {
    const result = filterBySeverityForRound(findings, 1, convergence);
    expect(result).toHaveLength(3);
  });

  it("round 2 drops nitpicks", () => {
    const result = filterBySeverityForRound(findings, 2, convergence);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.severity !== "nitpick")).toBe(true);
  });

  it("round 3 keeps only blockers", () => {
    const result = filterBySeverityForRound(findings, 3, convergence);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("round 4+ reuses last entry", () => {
    const result = filterBySeverityForRound(findings, 5, convergence);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("5-round config uses index 4 for round 5", () => {
    const fiveRoundConvergence: ConvergenceConfig = {
      round_severities: [
        ["blocker", "warning", "nitpick"],
        ["blocker", "warning", "nitpick"],
        ["blocker", "warning"],
        ["blocker", "warning"],
        ["blocker"],
      ],
      approve_condition: "zero_blockers",
    };
    const result = filterBySeverityForRound(findings, 5, fiveRoundConvergence);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("round 10 reuses last entry when config has 3 entries", () => {
    const result = filterBySeverityForRound(findings, 10, convergence);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("single-entry config applies to all rounds", () => {
    const singleConvergence: ConvergenceConfig = {
      round_severities: [["blocker"]],
      approve_condition: "zero_blockers",
    };
    expect(filterBySeverityForRound(findings, 1, singleConvergence)).toHaveLength(1);
    expect(filterBySeverityForRound(findings, 3, singleConvergence)).toHaveLength(1);
    expect(filterBySeverityForRound(findings, 99, singleConvergence)).toHaveLength(1);
  });
});
