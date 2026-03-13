import { describe, it, expect } from "vitest";

// Test parseOutput / extractContent for ClaudeCodeAdapter and CodexAdapter.
// Since these are private methods, we test equivalent logic directly
// rather than going through the adapter. Focus is on output parsing.

describe("ClaudeCodeAdapter parseOutput (indirect)", () => {
  // Directly test parseOutput logic (using equivalent logic since the method is private)
  function parseClaudeOutput(stdout: string) {
    try {
      const envelope = JSON.parse(stdout);
      const content = envelope.result ?? envelope;

      if (typeof content === "string") {
        const cleaned = content
          .replace(/^```json\s*/m, "")
          .replace(/\s*```$/m, "")
          .trim();
        return JSON.parse(cleaned);
      }

      if (content.findings) {
        return content;
      }

      return null;
    } catch {
      return extractJsonFromText(stdout);
    }
  }

  function extractJsonFromText(text: string) {
    const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }

  it("parses JSON envelope with result string", () => {
    const input = JSON.stringify({
      result: JSON.stringify({
        findings: [{ file: "a.ts", severity: "warning" }],
        overall_assessment: "minor_issues",
      }),
    });
    const result = parseClaudeOutput(input);
    expect(result.findings).toHaveLength(1);
  });

  it("parses JSON envelope with result string wrapped in code fence", () => {
    const inner = JSON.stringify({
      findings: [{ file: "a.ts", severity: "warning" }],
      overall_assessment: "minor_issues",
    });
    const input = JSON.stringify({
      result: "```json\n" + inner + "\n```",
    });
    const result = parseClaudeOutput(input);
    expect(result.findings).toHaveLength(1);
  });

  it("parses direct LensOutput object", () => {
    const input = JSON.stringify({
      findings: [{ file: "b.ts", severity: "blocker" }],
      overall_assessment: "significant_issues",
    });
    const result = parseClaudeOutput(input);
    expect(result.findings).toHaveLength(1);
    expect(result.overall_assessment).toBe("significant_issues");
  });

  it("extracts JSON from mixed text output", () => {
    const text = `Some preamble text\n${JSON.stringify({
      findings: [{ file: "c.ts", severity: "nitpick" }],
      overall_assessment: "clean",
    })}\nSome trailing text`;
    const result = parseClaudeOutput(text);
    expect(result.findings).toHaveLength(1);
  });

  it("returns null for completely invalid output", () => {
    expect(parseClaudeOutput("not json at all")).toBeNull();
  });
});

describe("CodexAdapter parseOutput / extractContent (indirect)", () => {
  function extractContent(event: any): string | null {
    if (event?.type === "message" && event?.role === "assistant") {
      return typeof event.content === "string"
        ? event.content
        : JSON.stringify(event.content);
    }
    if (event?.output) {
      return typeof event.output === "string"
        ? event.output
        : JSON.stringify(event.output);
    }
    if (typeof event === "string") return event;
    return null;
  }

  function parseCodexOutput(stdout: string) {
    try {
      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        try {
          const event = JSON.parse(line);
          const content = extractContent(event);
          if (content && content.includes('"findings"')) {
            const cleaned = content
              .replace(/^```json\s*/m, "")
              .replace(/\s*```$/m, "")
              .trim();
            return JSON.parse(cleaned);
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  it("parses JSONL with assistant message", () => {
    const event = {
      type: "message",
      role: "assistant",
      content: JSON.stringify({
        findings: [{ file: "x.ts", severity: "warning" }],
        overall_assessment: "minor_issues",
      }),
    };
    const stdout = JSON.stringify(event);
    const result = parseCodexOutput(stdout);
    expect(result.findings).toHaveLength(1);
  });

  it("parses JSONL with output field", () => {
    const event = {
      output: JSON.stringify({
        findings: [],
        overall_assessment: "clean",
      }),
    };
    const stdout = JSON.stringify(event);
    const result = parseCodexOutput(stdout);
    expect(result.findings).toHaveLength(0);
    expect(result.overall_assessment).toBe("clean");
  });

  it("scans multiple JSONL lines and picks the findings line", () => {
    const lines = [
      JSON.stringify({ type: "start", id: "123" }),
      JSON.stringify({ type: "tool_call", name: "read" }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: JSON.stringify({
          findings: [{ file: "a.ts", severity: "blocker" }],
          overall_assessment: "significant_issues",
        }),
      }),
    ];
    const stdout = lines.join("\n");
    const result = parseCodexOutput(stdout);
    expect(result.findings).toHaveLength(1);
  });

  it("returns null for empty output", () => {
    expect(parseCodexOutput("")).toBeNull();
  });

  describe("extractContent", () => {
    it("extracts string content from assistant message", () => {
      expect(
        extractContent({ type: "message", role: "assistant", content: "hello" })
      ).toBe("hello");
    });

    it("stringifies object content from assistant message", () => {
      const result = extractContent({
        type: "message",
        role: "assistant",
        content: { key: "value" },
      });
      expect(result).toBe('{"key":"value"}');
    });

    it("extracts output field", () => {
      expect(extractContent({ output: "result text" })).toBe("result text");
    });

    it("returns string events as-is", () => {
      expect(extractContent("plain string")).toBe("plain string");
    });

    it("returns null for unrecognized events", () => {
      expect(extractContent({ type: "tool_call" })).toBeNull();
    });
  });
});
