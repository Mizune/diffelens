import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import { join } from "path";

const configPath = join(import.meta.dirname, "../../.ai-review.yaml");

describe("loadConfig", () => {
  it("loads and parses the config file", async () => {
    const config = await loadConfig(configPath);

    expect(config.global.max_rounds).toBe(3);
    expect(config.global.language).toBe("ja");
    expect(config.global.default_cli).toBe("claude");
  });

  it("loads all enabled lenses", async () => {
    const config = await loadConfig(configPath);

    expect(config.lenses).toHaveLength(3);
    const names = config.lenses.map((l) => l.name);
    expect(names).toContain("readability");
    expect(names).toContain("structural");
    expect(names).toContain("bug_risk");
  });

  it("applies severity_cap from config", async () => {
    const config = await loadConfig(configPath);
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.severityCap).toBe("warning");
  });

  it("normalizes tool_policy", async () => {
    const config = await loadConfig(configPath);
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.toolPolicy).toEqual({ type: "none" });

    const structural = config.lenses.find((l) => l.name === "structural");
    expect(structural?.toolPolicy).toEqual({
      type: "explicit",
      tools: ["Read", "Grep", "Glob"],
    });
  });

  it("loads convergence settings", async () => {
    const config = await loadConfig(configPath);
    expect(config.convergence.approve_condition).toBe("zero_blockers");
    expect(config.convergence.round_1_severities).toContain("nitpick");
  });

  it("loads exclude_patterns", async () => {
    const config = await loadConfig(configPath);
    expect(config.filters.exclude_patterns).toContain("**/*.lock");
  });
});
