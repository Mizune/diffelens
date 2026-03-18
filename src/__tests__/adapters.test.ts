import { describe, it, expect } from "vitest";
import {
  stripCodeFences,
  extractJsonFromText,
} from "../adapters/parse-utils.js";

// Test parseOutput / extractContent for each adapter.
// Since parseOutput is private, we test equivalent logic directly.
// Shared utilities (stripCodeFences, extractJsonFromText) are imported
// from parse-utils; adapter-specific envelope handling is replicated here.

describe("parse-utils", () => {
  describe("stripCodeFences", () => {
    it("removes ```json and closing ``` fences", () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(stripCodeFences(input)).toBe('{"key": "value"}');
    });

    it("returns plain text unchanged", () => {
      expect(stripCodeFences('{"key": "value"}')).toBe('{"key": "value"}');
    });
  });

  describe("extractJsonFromText", () => {
    it("extracts JSON with findings from mixed text", () => {
      const json = JSON.stringify({
        findings: [{ file: "a.ts", severity: "warning" }],
        overall_assessment: "minor_issues",
      });
      const text = `Some preamble\n${json}`;
      const result = extractJsonFromText(text);
      expect(result?.findings).toHaveLength(1);
    });

    it("returns null when no findings JSON present", () => {
      expect(extractJsonFromText("no json here")).toBeNull();
    });

    it("returns null for malformed JSON with findings keyword", () => {
      expect(extractJsonFromText('{"findings": broken}')).toBeNull();
    });
  });
});

describe("ClaudeCodeAdapter parseOutput (indirect)", () => {
  function parseClaudeOutput(stdout: string) {
    try {
      const envelope = JSON.parse(stdout);
      const content = envelope.result ?? envelope;

      if (typeof content === "string") {
        return JSON.parse(stripCodeFences(content));
      }

      if (content.findings) {
        return content;
      }

      return null;
    } catch {
      return extractJsonFromText(stdout);
    }
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
    // Codex v0.115.0+: item.completed with agent_message
    if (
      event?.type === "item.completed" &&
      event?.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      return event.item.text;
    }
    // Legacy: message with assistant role
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
            return JSON.parse(stripCodeFences(content));
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

  it("parses Codex v0.115.0 item.completed agent_message format", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "abc" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          text: JSON.stringify({
            findings: [{ file: "a.ts", severity: "warning" }],
            overall_assessment: "minor_issues",
          }),
        },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];
    const stdout = lines.join("\n");
    const result = parseCodexOutput(stdout);
    expect(result).not.toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.overall_assessment).toBe("minor_issues");
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

    it("extracts text from item.completed agent_message (v0.115.0+)", () => {
      expect(
        extractContent({
          type: "item.completed",
          item: { type: "agent_message", text: "review output" },
        })
      ).toBe("review output");
    });

    it("returns null for item.completed with non-agent_message type", () => {
      expect(
        extractContent({
          type: "item.completed",
          item: { type: "reasoning", text: "thinking..." },
        })
      ).toBeNull();
    });

    it("returns null for unrecognized events", () => {
      expect(extractContent({ type: "tool_call" })).toBeNull();
    });
  });
});

// Mirrors GeminiAdapter's private envelope handling for isolated unit testing.
// Shared parse utilities are imported from parse-utils.
describe("GeminiAdapter parseOutput (indirect)", () => {
  const TEST_SESSION_ID = "test-uuid";

  function parseGeminiOutput(stdout: string) {
    try {
      const envelope = JSON.parse(stdout);

      if (envelope.error) {
        return null;
      }

      const content = envelope.response;
      if (typeof content !== "string") {
        return null;
      }

      try {
        return JSON.parse(stripCodeFences(content));
      } catch {
        return extractJsonFromText(content);
      }
    } catch {
      return extractJsonFromText(stdout);
    }
  }

  it("parses standard envelope with response string", () => {
    const findings = {
      findings: [{ file: "a.ts", severity: "warning" }],
      overall_assessment: "minor_issues",
    };
    const input = JSON.stringify({
      session_id: TEST_SESSION_ID,
      response: JSON.stringify(findings),
      stats: { total_tokens: 100 },
    });
    const result = parseGeminiOutput(input);
    expect(result.findings).toHaveLength(1);
    expect(result.overall_assessment).toBe("minor_issues");
  });

  it("parses response wrapped in code fence", () => {
    const inner = JSON.stringify({
      findings: [{ file: "b.ts", severity: "blocker" }],
      overall_assessment: "significant_issues",
    });
    const input = JSON.stringify({
      session_id: TEST_SESSION_ID,
      response: "```json\n" + inner + "\n```",
    });
    const result = parseGeminiOutput(input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("blocker");
  });

  it("returns null for error envelope", () => {
    const input = JSON.stringify({
      error: { type: "Error", message: "model not found" },
    });
    expect(parseGeminiOutput(input)).toBeNull();
  });

  it("extracts response ignoring stats field", () => {
    const findings = {
      findings: [],
      overall_assessment: "clean",
    };
    const input = JSON.stringify({
      session_id: TEST_SESSION_ID,
      response: JSON.stringify(findings),
      stats: {
        total_tokens: 500,
        input_tokens: 400,
        output_tokens: 100,
      },
    });
    const result = parseGeminiOutput(input);
    expect(result.findings).toHaveLength(0);
    expect(result.overall_assessment).toBe("clean");
  });

  it("returns null for empty output", () => {
    expect(parseGeminiOutput("")).toBeNull();
  });

  it("returns null for invalid JSON output", () => {
    expect(parseGeminiOutput("not json at all")).toBeNull();
  });

  it("falls back to extractJsonFromText for mixed text output", () => {
    const findings = JSON.stringify({
      findings: [{ file: "c.ts", severity: "nitpick" }],
      overall_assessment: "minor_issues",
    });
    const text = `Here is the review:\n${findings}`;
    const result = parseGeminiOutput(text);
    expect(result.findings).toHaveLength(1);
  });
});
