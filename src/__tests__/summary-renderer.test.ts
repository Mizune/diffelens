import { describe, it, expect } from "vitest";
import { renderSummary, MARKER } from "../output/summary-renderer.js";
import type { ReviewState } from "../state/review-state.js";

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

describe("renderSummary", () => {
  it("includes the marker for comment identification", () => {
    const result = renderSummary(makeState(), "approve");
    expect(result).toContain(MARKER);
  });

  it("shows APPROVED for approve decision", () => {
    const result = renderSummary(makeState(), "approve");
    expect(result).toContain("APPROVED");
  });

  it("shows CHANGES REQUESTED for request_changes", () => {
    const result = renderSummary(makeState(), "request_changes");
    expect(result).toContain("CHANGES REQUESTED");
  });

  it("shows ESCALATED for escalate", () => {
    const result = renderSummary(makeState(), "escalate");
    expect(result).toContain("ESCALATED");
  });

  it("renders blocker findings", () => {
    const state = makeState({
      findings: [
        {
          id: "b-001",
          lens: "bug_risk",
          status: "open",
          severity: "blocker",
          file: "src/app.ts",
          line_start: 10,
          line_end: 10,
          category: "null_check",
          summary: "missing null check",
          suggestion: "add check",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    const result = renderSummary(state, "request_changes");
    expect(result).toContain("Blockers | 1");
    expect(result).toContain("[b-001]");
    expect(result).toContain("missing null check");
  });

  it("renders resolved findings in collapsible section", () => {
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "addressed",
          severity: "warning",
          file: "src/app.ts",
          line_start: 5,
          line_end: 5,
          category: "naming",
          summary: "bad name",
          suggestion: "rename",
          first_raised_round: 1,
          last_evaluated_round: 2,
          resolution_note: "Resolved in round 2",
        },
      ],
    });
    const result = renderSummary(state, "approve");
    expect(result).toContain("Resolved | 1");
    expect(result).toContain("~~**[r-001]**~~");
  });

  it("shows round info", () => {
    const state = makeState({ current_round: 2, max_rounds: 3 });
    const result = renderSummary(state, "approve");
    expect(result).toContain("Round 2/3");
  });

  it("renders suggestion with lightbulb", () => {
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
          summary: "test",
          suggestion: "use camelCase",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });
    const result = renderSummary(state, "request_changes");
    expect(result).toContain("use camelCase");
  });
});
