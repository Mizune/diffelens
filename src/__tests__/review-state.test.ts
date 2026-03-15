import { describe, it, expect } from "vitest";
import { updateState, linesOverlap, generateFindingId, advanceRoundIfNeeded } from "../state/review-state.js";
import type { ReviewState } from "../state/review-state.js";
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

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line_start: 10,
    line_end: 15,
    severity: "warning",
    category: "naming",
    summary: "bad name",
    suggestion: "rename",
    lens: "readability",
    ...overrides,
  };
}

describe("linesOverlap", () => {
  it("returns true for overlapping ranges", () => {
    expect(linesOverlap(1, 10, 5, 15)).toBe(true);
  });

  it("returns true for touching ranges", () => {
    expect(linesOverlap(1, 5, 5, 10)).toBe(true);
  });

  it("returns false for non-overlapping ranges", () => {
    expect(linesOverlap(1, 5, 6, 10)).toBe(false);
  });

  it("returns true for identical ranges", () => {
    expect(linesOverlap(5, 10, 5, 10)).toBe(true);
  });

  it("returns true when one range contains the other", () => {
    expect(linesOverlap(1, 20, 5, 10)).toBe(true);
  });
});

describe("generateFindingId", () => {
  it("generates id with lens prefix", () => {
    expect(generateFindingId("readability", 0)).toBe("r-001");
    expect(generateFindingId("architectural", 4)).toBe("a-005");
    expect(generateFindingId("bug_risk", 99)).toBe("b-100");
  });
});

describe("advanceRoundIfNeeded", () => {
  it("increments round when head_sha changes", () => {
    const state = makeState({ current_round: 1, head_sha: "aaa" });
    const result = advanceRoundIfNeeded(state, "bbb");
    expect(result.current_round).toBe(2);
    expect(result.head_sha).toBe("bbb");
  });

  it("returns same state when head_sha is unchanged", () => {
    const state = makeState({ current_round: 1, head_sha: "aaa" });
    const result = advanceRoundIfNeeded(state, "aaa");
    expect(result.current_round).toBe(1);
    expect(result).toBe(state); // same reference
  });

  it("does not mutate original state", () => {
    const state = makeState({ current_round: 1, head_sha: "aaa" });
    advanceRoundIfNeeded(state, "bbb");
    expect(state.current_round).toBe(1);
    expect(state.head_sha).toBe("aaa");
  });
});

describe("updateState", () => {
  it("does not mutate the original state", () => {
    const state = makeState();
    const originalFindings = [...state.findings];
    const originalHistory = [...state.round_history];

    updateState(state, [makeFinding()], "ccc");

    expect(state.findings).toEqual(originalFindings);
    expect(state.round_history).toEqual(originalHistory);
  });

  it("adds new findings to state", () => {
    const state = makeState();
    const newState = updateState(state, [makeFinding()], "ccc");

    expect(newState.findings).toHaveLength(1);
    expect(newState.findings[0].status).toBe("open");
    expect(newState.findings[0].id).toBe("r-001");
  });

  it("marks missing findings as addressed", () => {
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "open",
          severity: "warning",
          file: "src/app.ts",
          line_start: 10,
          line_end: 15,
          category: "naming",
          summary: "bad name",
          suggestion: "rename",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });

    // no new findings → existing should be addressed
    const newState = updateState(state, [], "ccc");

    expect(newState.findings[0].status).toBe("addressed");
    expect(newState.findings[0].resolution_note).toContain("Resolved");
  });

  it("keeps existing findings open when still present in new findings", () => {
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "open",
          severity: "warning",
          file: "src/app.ts",
          line_start: 10,
          line_end: 15,
          category: "naming",
          summary: "bad name",
          suggestion: "rename",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: null,
        },
      ],
    });

    const newFinding = makeFinding({
      file: "src/app.ts",
      line_start: 12,
      line_end: 14,
      category: "naming",
    });

    const newState = updateState(state, [newFinding], "ccc");

    // original finding still open, no new finding added (overlap match)
    expect(newState.findings).toHaveLength(1);
    expect(newState.findings[0].status).toBe("open");
    expect(newState.findings[0].id).toBe("r-001");
  });

  it("records round history", () => {
    const state = makeState();
    const newState = updateState(state, [makeFinding()], "ccc");

    expect(newState.round_history).toHaveLength(1);
    expect(newState.round_history[0].round).toBe(1);
    expect(newState.round_history[0].findings_opened).toEqual(["r-001"]);
    expect(newState.round_history[0].findings_resolved).toEqual([]);
  });

  it("skips wontfix findings when checking for resolved", () => {
    const state = makeState({
      findings: [
        {
          id: "r-001",
          lens: "readability",
          status: "wontfix",
          severity: "warning",
          file: "src/app.ts",
          line_start: 10,
          line_end: 15,
          category: "naming",
          summary: "bad name",
          suggestion: "rename",
          first_raised_round: 1,
          last_evaluated_round: 1,
          resolution_note: "wontfix by user",
        },
      ],
    });

    const newState = updateState(state, [], "ccc");

    // wontfix should remain wontfix, not change to addressed
    expect(newState.findings[0].status).toBe("wontfix");
  });
});
