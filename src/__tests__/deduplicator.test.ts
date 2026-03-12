import { describe, it, expect } from "vitest";
import { deduplicateFindings } from "../deduplicator.js";
import type { Finding } from "../adapters/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
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

describe("deduplicateFindings", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateFindings([])).toEqual([]);
  });

  it("keeps unique findings", () => {
    const findings = [
      makeFinding({ file: "a.ts", category: "naming" }),
      makeFinding({ file: "b.ts", category: "naming" }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it("deduplicates findings with same file, overlapping lines, same category", () => {
    const findings = [
      makeFinding({ file: "a.ts", line_start: 10, line_end: 15, severity: "warning" }),
      makeFinding({ file: "a.ts", line_start: 12, line_end: 18, severity: "warning" }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(1);
  });

  it("keeps higher severity when deduplicating", () => {
    const findings = [
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "blocker" }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("does not deduplicate different categories on same lines", () => {
    const findings = [
      makeFinding({ category: "naming" }),
      makeFinding({ category: "error_handling" }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it("does not deduplicate non-overlapping lines in same file", () => {
    const findings = [
      makeFinding({ line_start: 1, line_end: 5 }),
      makeFinding({ line_start: 10, line_end: 15 }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it("does not deduplicate different files", () => {
    const findings = [
      makeFinding({ file: "a.ts" }),
      makeFinding({ file: "b.ts" }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });
});
