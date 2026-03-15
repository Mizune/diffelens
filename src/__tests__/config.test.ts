import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, deepMergeRawConfig, loadConfigWithLocalOverlay } from "../config.js";
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

  it("normalizes tool_policy 'all'", async () => {
    const path = await writeYamlConfig(BASE_YAML(`
  readability:
    enabled: true
    model: "sonnet"
    isolation: "repo"
    tool_policy: "all"
`));
    const config = await loadConfig(path);
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.toolPolicy).toEqual({ type: "all" });
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

// ============================================================
// deepMergeRawConfig
// ============================================================

function makeRawConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    global: {
      max_rounds: 3,
      language: "en",
      default_cli: "gemini" as const,
      timeout_ms: 120000,
    },
    lenses: {
      readability: {
        enabled: true,
        cli: "gemini" as const,
        model: "gemini-2.5-flash",
        isolation: "tempdir" as const,
        tool_policy: "none" as const,
        timeout_ms: 300000,
        severity_cap: "warning" as const,
      },
      architectural: {
        enabled: true,
        cli: "gemini" as const,
        model: "gemini-2.5-flash",
        isolation: "repo" as const,
        tool_policy: "none" as const,
      },
    },
    convergence: {
      round_severities: [["blocker", "warning", "nitpick"], ["blocker", "warning"], ["blocker"]],
      approve_condition: "zero_blockers" as const,
    },
    filters: { exclude_patterns: ["**/*.lock"] },
    ...overrides,
  };
}

describe("deepMergeRawConfig", () => {
  it("overrides only global.default_cli when specified", () => {
    const base = makeRawConfig();
    const overlay = { global: { default_cli: "claude" } };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.global.default_cli).toBe("claude");
    expect(merged.global.max_rounds).toBe(3);
    expect(merged.global.timeout_ms).toBe(120000);
  });

  it("overrides only model for a specific lens", () => {
    const base = makeRawConfig();
    const overlay = { lenses: { readability: { model: "claude-opus-4-6" } } };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.lenses.readability.model).toBe("claude-opus-4-6");
    expect(merged.lenses.readability.cli).toBe("gemini");
    expect(merged.lenses.readability.isolation).toBe("tempdir");
    expect(merged.lenses.architectural.model).toBe("gemini-2.5-flash");
  });

  it("adds a new lens from overlay", () => {
    const base = makeRawConfig();
    const overlay = {
      lenses: {
        security: {
          enabled: true,
          model: "claude-opus-4-6",
          isolation: "repo",
          tool_policy: "none",
          prompt_file: "prompts/security.md",
        },
      },
    };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.lenses).toHaveProperty("security");
    expect((merged.lenses as Record<string, unknown>)["security"]).toMatchObject({
      enabled: true,
      model: "claude-opus-4-6",
    });
    expect(merged.lenses.readability).toBeDefined();
  });

  it("overrides convergence.approve_condition only", () => {
    const base = makeRawConfig();
    const overlay = { convergence: { approve_condition: "zero_blockers_and_warnings" } };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.convergence.approve_condition).toBe("zero_blockers_and_warnings");
    expect((merged.convergence as { round_severities: string[][] }).round_severities).toHaveLength(3);
  });

  it("replaces filters.exclude_patterns entirely", () => {
    const base = makeRawConfig();
    const overlay = { filters: { exclude_patterns: ["**/*.min.js", "**/vendor/**"] } };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.filters.exclude_patterns).toEqual(["**/*.min.js", "**/vendor/**"]);
  });

  it("returns base unchanged when overlay is empty", () => {
    const base = makeRawConfig();
    const merged = deepMergeRawConfig(base, {});

    expect(merged.global).toEqual(base.global);
    expect(merged.lenses).toEqual(base.lenses);
    expect(merged.convergence).toEqual(base.convergence);
    expect(merged.filters).toEqual(base.filters);
  });

  it("can disable a lens via overlay", () => {
    const base = makeRawConfig();
    const overlay = { lenses: { readability: { enabled: false } } };
    const merged = deepMergeRawConfig(base, overlay);

    expect(merged.lenses.readability.enabled).toBe(false);
  });

  it("does not mutate the base config", () => {
    const base = makeRawConfig();
    const originalCli = base.global.default_cli;
    deepMergeRawConfig(base, { global: { default_cli: "claude" } });

    expect(base.global.default_cli).toBe(originalCli);
  });
});

// ============================================================
// loadConfigWithLocalOverlay
// ============================================================

async function writeYamlFile(dir: string, filename: string, yaml: string): Promise<string> {
  const path = join(dir, filename);
  await writeFile(path, yaml, "utf-8");
  return path;
}

describe("loadConfigWithLocalOverlay", () => {
  it("applies local overlay when file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-overlay-test-"));
    tempDirs.push(dir);

    await writeYamlFile(dir, ".ai-review.yaml", FULL_YAML);
    await writeYamlFile(dir, ".ai-review.local.yaml", `
global:
  default_cli: "claude"
lenses:
  readability:
    cli: "claude"
    model: "claude-opus-4-6"
`);

    const basePath = join(dir, ".ai-review.yaml");
    const localPath = join(dir, ".ai-review.local.yaml");
    const { config, localOverlayApplied } = await loadConfigWithLocalOverlay(basePath, localPath);

    expect(localOverlayApplied).toBe(true);
    expect(config.global.default_cli).toBe("claude");
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.cli).toBe("claude");
    expect(readability?.model).toBe("claude-opus-4-6");
    // Unchanged lens
    const architectural = config.lenses.find((l) => l.name === "architectural");
    expect(architectural?.cli).toBe("claude"); // default_cli changed to claude
    expect(architectural?.model).toBe("claude-opus-4-6");
  });

  it("returns base config when local file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-overlay-test-"));
    tempDirs.push(dir);

    await writeYamlFile(dir, ".ai-review.yaml", FULL_YAML);

    const basePath = join(dir, ".ai-review.yaml");
    const localPath = join(dir, ".ai-review.local.yaml");
    const { config, localOverlayApplied } = await loadConfigWithLocalOverlay(basePath, localPath);

    expect(localOverlayApplied).toBe(false);
    expect(config.global.default_cli).toBe("claude");
    expect(config.lenses).toHaveLength(3);
  });

  it("validates merged config (invalid after merge throws)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-overlay-test-"));
    tempDirs.push(dir);

    await writeYamlFile(dir, ".ai-review.yaml", FULL_YAML);
    await writeYamlFile(dir, ".ai-review.local.yaml", `
convergence:
  round_severities: []
  approve_condition: "zero_blockers"
`);

    const basePath = join(dir, ".ai-review.yaml");
    const localPath = join(dir, ".ai-review.local.yaml");
    await expect(loadConfigWithLocalOverlay(basePath, localPath)).rejects.toThrow(
      "round_severities must not be empty"
    );
  });

  it("overrides cli and model per lens for local use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-overlay-test-"));
    tempDirs.push(dir);

    await writeYamlFile(dir, ".ai-review.yaml", FULL_YAML);
    await writeYamlFile(dir, ".ai-review.local.yaml", `
lenses:
  bug_risk:
    cli: "gemini"
    model: "gemini-2.5-pro"
`);

    const basePath = join(dir, ".ai-review.yaml");
    const localPath = join(dir, ".ai-review.local.yaml");
    const { config } = await loadConfigWithLocalOverlay(basePath, localPath);

    const bugRisk = config.lenses.find((l) => l.name === "bug_risk");
    expect(bugRisk?.cli).toBe("gemini");
    expect(bugRisk?.model).toBe("gemini-2.5-pro");
    // Other lenses unchanged
    const readability = config.lenses.find((l) => l.name === "readability");
    expect(readability?.cli).toBe("claude");
  });
});
