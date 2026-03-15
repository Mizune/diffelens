import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../config.js";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";


let tempDirs: string[] = [];

async function writeYamlConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffelens-cfg-test-"));
  tempDirs.push(dir);
  const path = join(dir, ".ai-review.yaml");
  await writeFile(path, yaml, "utf-8");
  return path;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

const BASE_YAML = (lensBlock: string, convergenceBlock?: string) => `
version: "1.0"
global:
  max_rounds: 3
  language: "en"
  default_cli: "claude"
  timeout_ms: 120000
lenses:
${lensBlock}
convergence:
${convergenceBlock ?? `  round_1_severities: ["blocker", "warning", "nitpick"]
  round_2_severities: ["blocker", "warning"]
  round_3_severities: ["blocker"]
  approve_condition: "zero_blockers"`}
filters:
  exclude_patterns: []
`;

const FULL_YAML = `
version: "1.0"
global:
  max_rounds: 4
  language: "en"
  default_cli: "claude"
  timeout_ms: 120000
lenses:
  readability:
    enabled: true
    cli: "claude"
    model: "claude-sonnet-4-6"
    isolation: "tempdir"
    tool_policy: "none"
    timeout_ms: 300000
    severity_cap: "warning"
  architectural:
    enabled: true
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
    timeout_ms: 600000
    severity_cap: "blocker"
  bug_risk:
    enabled: true
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
    timeout_ms: 600000
    severity_cap: "blocker"
filters:
  exclude_patterns:
    - "**/*.lock"
    - "**/node_modules/**"
convergence:
  round_severities:
    - ["blocker", "warning", "nitpick"]
    - ["blocker", "warning", "nitpick"]
    - ["blocker", "warning"]
    - ["blocker"]
  approve_condition: "zero_blockers"
`;

describe("loadConfig", () => {
  it("loads and parses the config file", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);

    expect(config.global.max_rounds).toBe(4);
    expect(config.global.language).toBe("en");
    expect(config.global.default_cli).toBe("claude");
  });

  it("loads all enabled lenses", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);

    expect(config.lenses).toHaveLength(3);
    const names = config.lenses.map((l) => l.name);
    expect(names).toContain("readability");
    expect(names).toContain("architectural");
    expect(names).toContain("bug_risk");
  });

  it("applies severity_cap from config", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.severityCap).toBe("warning");
  });

  it("normalizes tool_policy", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.toolPolicy).toEqual({ type: "none" });

    const architectural = config.lenses.find((l) => l.name === "architectural");
    expect(architectural?.toolPolicy).toEqual({
      type: "explicit",
      tools: ["Read", "Grep", "Glob"],
    });
  });

  it("loads convergence settings (new round_severities format)", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);
    expect(config.convergence.approve_condition).toBe("zero_blockers");
    expect(config.convergence.round_severities).toEqual([
      ["blocker", "warning", "nitpick"],
      ["blocker", "warning", "nitpick"],
      ["blocker", "warning"],
      ["blocker"],
    ]);
  });

  it("loads exclude_patterns", async () => {
    const path = await writeYamlConfig(FULL_YAML);
    const config = await loadConfig(path);
    expect(config.filters.exclude_patterns).toContain("**/*.lock");
  });
});

describe("loadConfig custom prompt fields", () => {
  it("prompt_file on built-in lens sets promptSource to custom", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  readability:
    enabled: true
    model: "sonnet"
    isolation: "tempdir"
    tool_policy: "none"
    prompt_file: "my-prompts/readability.md"
`));

    const config = await loadConfig(path);
    const lens = config.lenses.find((l) => l.name === "readability")!;
    expect(lens.promptSource).toBe("custom");
    expect(lens.promptFile).toBe("my-prompts/readability.md");
  });

  it("prompt_append_file sets promptSource to extended", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  readability:
    enabled: true
    model: "sonnet"
    isolation: "tempdir"
    tool_policy: "none"
    prompt_append_file: "extra-rules.md"
`));

    const config = await loadConfig(path);
    const lens = config.lenses.find((l) => l.name === "readability")!;
    expect(lens.promptSource).toBe("extended");
    expect(lens.promptAppendFile).toBe("extra-rules.md");
    expect(lens.promptFile).toBe("prompts/readability.md");
  });

  it("no prompt fields on built-in lens sets promptSource to builtin", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  readability:
    enabled: true
    model: "sonnet"
    isolation: "tempdir"
    tool_policy: "none"
`));

    const config = await loadConfig(path);
    const lens = config.lenses.find((l) => l.name === "readability")!;
    expect(lens.promptSource).toBe("builtin");
    expect(lens.promptFile).toBe("prompts/readability.md");
  });

  it("custom lens without prompt_file throws", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  security:
    enabled: true
    model: "sonnet"
    isolation: "repo"
    tool_policy: "none"
`));

    await expect(loadConfig(path)).rejects.toThrow(
      'Custom lens "security" requires a prompt_file'
    );
  });

  it("both prompt_file and prompt_append_file throws", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  readability:
    enabled: true
    model: "sonnet"
    isolation: "tempdir"
    tool_policy: "none"
    prompt_file: "my-prompt.md"
    prompt_append_file: "extra.md"
`));

    await expect(loadConfig(path)).rejects.toThrow(
      "prompt_file and prompt_append_file are mutually exclusive"
    );
  });
});

const MINIMAL_LENS = `
  readability:
    enabled: true
    model: "sonnet"
    isolation: "tempdir"
    tool_policy: "none"
`;

describe("loadConfig convergence normalization", () => {
  it("legacy format is normalized to round_severities", async () => {
    const path = await writeYamlConfig(BASE_YAML(MINIMAL_LENS));
    const config = await loadConfig(path);

    expect(config.convergence.round_severities).toEqual([
      ["blocker", "warning", "nitpick"],
      ["blocker", "warning"],
      ["blocker"],
    ]);
  });

  it("new round_severities format is loaded as-is", async () => {
    const path = await writeYamlConfig(BASE_YAML(MINIMAL_LENS, `  round_severities:
    - ["blocker", "warning", "nitpick"]
    - ["blocker", "warning"]
    - ["blocker"]
    - ["blocker"]
    - ["blocker"]
  approve_condition: "zero_blockers"`));
    const config = await loadConfig(path);

    expect(config.convergence.round_severities).toHaveLength(5);
    expect(config.convergence.round_severities[3]).toEqual(["blocker"]);
  });

  it("empty round_severities throws", async () => {
    const path = await writeYamlConfig(BASE_YAML(MINIMAL_LENS, `  round_severities: []
  approve_condition: "zero_blockers"`));

    await expect(loadConfig(path)).rejects.toThrow("round_severities must not be empty");
  });

  it("empty entry in round_severities throws", async () => {
    const path = await writeYamlConfig(BASE_YAML(MINIMAL_LENS, `  round_severities:
    - ["blocker"]
    - []
  approve_condition: "zero_blockers"`));

    await expect(loadConfig(path)).rejects.toThrow("round_severities[1] must not be empty");
  });

  it("invalid severity value throws", async () => {
    const path = await writeYamlConfig(BASE_YAML(MINIMAL_LENS, `  round_severities:
    - ["blocker", "critical"]
  approve_condition: "zero_blockers"`));

    await expect(loadConfig(path)).rejects.toThrow('Invalid severity "critical"');
  });
});
