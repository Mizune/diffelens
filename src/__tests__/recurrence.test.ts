import { describe, it, expect } from "vitest";
import { detectAndSuppressRecurrences } from "../recurrence.js";
import type { ReviewState, StateFinding } from "../state/review-state.js";
import type { Finding } from "../adapters/types.js";

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    schema_version: "1.0",
    pr_number: 1,
    repository: "test/repo",
    current_round: 2,
    max_rounds: 3,
    base_sha: "aaa",
    head_sha: "bbb",
    findings: [],
    round_history: [],
    decisions: [],
    ...overrides,
  };
}

function makeStateFinding(
  overrides: Partial<StateFinding> = {}
): StateFinding {
  return {
    id: "r-001",
    lens: "readability",
    status: "open",
    first_raised_round: 1,
    last_evaluated_round: 1,
    resolution_note: null,
    file: "src/app.ts",
    line_start: 10,
    line_end: 15,
    severity: "warning",
    category: "naming",
    summary: "bad name",
    suggestion: "rename",
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

describe("detectAndSuppressRecurrences", () => {
  it("suppresses a finding that was open then addressed and now reappears", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          last_evaluated_round: 2,
          resolution_note: "Resolved in round 2",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 10,
        line_end: 15,
        category: "naming",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].originalFindingId).toBe("r-001");
    expect(result.findings).toHaveLength(0);
  });

  it("does not suppress a first-time finding (no prior history)", () => {
    const state = makeState({
      current_round: 1,
      findings: [],
    });

    const newFindings: Finding[] = [
      makeFinding({ file: "src/app.ts", category: "naming" }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it("does not suppress when category differs", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          category: "naming",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 10,
        line_end: 15,
        category: "error_handling",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it("does not suppress when file differs", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          file: "src/app.ts",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({ file: "src/other.ts", category: "naming" }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it("does not suppress findings that are still open (not addressed)", () => {
    const state = makeState({
      current_round: 2,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "open",
          first_raised_round: 1,
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 10,
        line_end: 15,
        category: "naming",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it("handles round 1 with no history gracefully", () => {
    const state = makeState({
      current_round: 1,
      findings: [],
    });

    const result = detectAndSuppressRecurrences(state, []);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });

  it("suppresses multiple recurrences simultaneously", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          file: "src/app.ts",
          line_start: 10,
          line_end: 15,
          category: "naming",
        }),
        makeStateFinding({
          id: "b-002",
          status: "addressed",
          first_raised_round: 1,
          file: "src/db.ts",
          line_start: 20,
          line_end: 25,
          category: "sql_injection",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 10,
        line_end: 15,
        category: "naming",
      }),
      makeFinding({
        file: "src/db.ts",
        line_start: 20,
        line_end: 25,
        category: "sql_injection",
      }),
      makeFinding({
        file: "src/new.ts",
        line_start: 1,
        line_end: 5,
        category: "complexity",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/new.ts");
  });

  it("detects recurrence when lines overlap but are shifted", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          file: "src/app.ts",
          line_start: 10,
          line_end: 20,
          category: "naming",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 15,
        line_end: 25,
        category: "naming",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(1);
    expect(result.findings).toHaveLength(0);
  });

  it("does not suppress when lines do not overlap", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
          file: "src/app.ts",
          line_start: 10,
          line_end: 15,
          category: "naming",
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({
        file: "src/app.ts",
        line_start: 50,
        line_end: 60,
        category: "naming",
      }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });

  it("does not mutate input arrays", () => {
    const state = makeState({
      current_round: 3,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 1,
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({ file: "src/app.ts", category: "naming" }),
    ];
    const originalLength = newFindings.length;

    detectAndSuppressRecurrences(state, newFindings);

    expect(newFindings).toHaveLength(originalLength);
  });

  it("does not suppress findings addressed in the current round", () => {
    const state = makeState({
      current_round: 2,
      findings: [
        makeStateFinding({
          id: "r-001",
          status: "addressed",
          first_raised_round: 2,
          last_evaluated_round: 2,
        }),
      ],
    });

    const newFindings: Finding[] = [
      makeFinding({ file: "src/app.ts", category: "naming" }),
    ];

    const result = detectAndSuppressRecurrences(state, newFindings);

    expect(result.directives).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
  });
});
