import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { evaluateTriggers, resolveSkills } from "../skill-resolver.js";
import type { ReviewConfig, SkillConfig, SkillTriggers } from "../config.js";

// ============================================================
// evaluateTriggers
// ============================================================

describe("evaluateTriggers", () => {
  it("matches file_patterns against diff files", () => {
    const triggers: SkillTriggers = {
      filePatterns: ["**/*.tsx", "**/*.jsx"],
    };
    expect(evaluateTriggers(triggers, ["src/App.tsx"])).toBe(true);
    expect(evaluateTriggers(triggers, ["src/utils.ts"])).toBe(false);
  });

  it("returns true when always is true", () => {
    const triggers: SkillTriggers = { always: true };
    expect(evaluateTriggers(triggers, [])).toBe(true);
    expect(evaluateTriggers(triggers, ["any.file"])).toBe(true);
  });

  it("returns false when no conditions match", () => {
    const triggers: SkillTriggers = {
      filePatterns: ["**/*.py"],
    };
    expect(evaluateTriggers(triggers, ["src/index.ts"])).toBe(false);
  });

  it("matches nested file patterns", () => {
    const triggers: SkillTriggers = {
      filePatterns: ["**/repository/**"],
    };
    expect(evaluateTriggers(triggers, ["src/repository/user.ts"])).toBe(true);
    expect(evaluateTriggers(triggers, ["src/service/auth.ts"])).toBe(false);
  });

  it("returns false for empty file_patterns", () => {
    const triggers: SkillTriggers = { filePatterns: [] };
    expect(evaluateTriggers(triggers, ["src/index.ts"])).toBe(false);
  });
});

// ============================================================
// resolveSkills
// ============================================================

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

function makeConfig(skills: SkillConfig[]): ReviewConfig {
  return {
    global: {
      max_rounds: 3,
      language: "en",
      default_cli: "claude",
      timeout_ms: 120000,
    },
    lenses: [
      {
        name: "bug_risk",
        cli: "claude",
        model: "claude-sonnet-4-6",
        promptFile: "prompts/bug_risk.md",
        promptSource: "builtin",
        toolPolicy: { type: "none" },
        timeoutMs: 120000,
        isolation: "repo",
        severityCap: "blocker",
      },
      {
        name: "readability",
        cli: "claude",
        model: "claude-sonnet-4-6",
        promptFile: "prompts/readability.md",
        promptSource: "builtin",
        toolPolicy: { type: "none" },
        timeoutMs: 120000,
        isolation: "tempdir",
        severityCap: "warning",
      },
    ],
    skills,
    convergence: {
      round_severities: [["blocker", "warning", "nitpick"]],
      approve_condition: "zero_blockers",
    },
    filters: { exclude_patterns: [] },
    output: {
      github: {
        autoApprove: false,
        onIssues: "comment",
        inlineComments: false,
        maxInlineComments: 25,
        inlineSeverities: ["blocker", "warning"],
      },
    },
  };
}

describe("resolveSkills", () => {
  it("resolves inject skill and groups by target lens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-skill-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "skills/react.md"), "Check React hooks rules.", "utf-8");

    const config = makeConfig([
      {
        name: "react_hooks",
        enabled: true,
        mode: "inject",
        promptFile: "skills/react.md",
        triggers: { filePatterns: ["**/*.tsx"] },
        attachTo: ["bug_risk"],
      },
    ]);

    const result = await resolveSkills(config, ["src/App.tsx"], dir);

    expect(result.activatedSkills).toEqual(["react_hooks"]);
    expect(result.injections.has("bug_risk")).toBe(true);
    expect(result.injections.get("bug_risk")).toBe("Check React hooks rules.");
    expect(result.standaloneSkills).toHaveLength(0);
  });

  it("does not activate skill when triggers do not match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-skill-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "skills/react.md"), "Check React hooks rules.", "utf-8");

    const config = makeConfig([
      {
        name: "react_hooks",
        enabled: true,
        mode: "inject",
        promptFile: "skills/react.md",
        triggers: { filePatterns: ["**/*.tsx"] },
        attachTo: ["bug_risk"],
      },
    ]);

    const result = await resolveSkills(config, ["src/utils.ts"], dir);

    expect(result.activatedSkills).toEqual([]);
    expect(result.injections.size).toBe(0);
  });

  it("resolves standalone skill as StandaloneSkillConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-skill-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "skills/sql.md"), "Check SQL injection.", "utf-8");

    const config = makeConfig([
      {
        name: "sql_check",
        enabled: true,
        mode: "standalone",
        promptFile: "skills/sql.md",
        triggers: { filePatterns: ["**/*.sql"] },
        cli: "claude",
        model: "claude-sonnet-4-6",
        isolation: "repo",
        toolPolicy: { type: "read_only" },
        timeoutMs: 300000,
        severityCap: "blocker",
      },
    ]);

    const result = await resolveSkills(config, ["migrations/001.sql"], dir);

    expect(result.activatedSkills).toEqual(["sql_check"]);
    expect(result.standaloneSkills).toHaveLength(1);

    const skill = result.standaloneSkills[0];
    expect(skill.name).toBe("sql_check");
    expect(skill.mode).toBe("standalone");
    expect(skill.cli).toBe("claude");
    expect(skill.model).toBe("claude-sonnet-4-6");
    expect(skill.promptFile).toBe("skills/sql.md");
    expect(skill.toolPolicy).toEqual({ type: "read_only" });
  });

  it("merges multiple inject skills into same lens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-skill-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "skills/hooks.md"), "Hook rules.", "utf-8");
    await writeFile(join(dir, "skills/standards.md"), "Coding standards.", "utf-8");

    const config = makeConfig([
      {
        name: "hooks",
        enabled: true,
        mode: "inject",
        promptFile: "skills/hooks.md",
        triggers: { always: true },
        attachTo: ["bug_risk"],
      },
      {
        name: "standards",
        enabled: true,
        mode: "inject",
        promptFile: "skills/standards.md",
        triggers: { always: true },
        attachTo: ["bug_risk"],
      },
    ]);

    const result = await resolveSkills(config, ["any.ts"], dir);

    expect(result.activatedSkills).toEqual(["hooks", "standards"]);
    const injection = result.injections.get("bug_risk")!;
    expect(injection).toContain("Hook rules.");
    expect(injection).toContain("---");
    expect(injection).toContain("Coding standards.");
  });

  it("skips disabled skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffelens-skill-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "skills/react.md"), "Content", "utf-8");

    const config = makeConfig([
      {
        name: "react_hooks",
        enabled: false,
        mode: "inject",
        promptFile: "skills/react.md",
        triggers: { always: true },
        attachTo: ["bug_risk"],
      },
    ]);

    const result = await resolveSkills(config, ["src/App.tsx"], dir);
    expect(result.activatedSkills).toEqual([]);
  });
});
