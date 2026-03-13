import { describe, it, expect, afterEach } from "vitest";
import { resolvePrompt, validatePrompts } from "../prompt-resolver.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LensConfig } from "../config.js";

// ============================================================
// Helpers
// ============================================================

const diffelensRoot = join(import.meta.dirname, "../..");
let tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffelens-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeLens(overrides: Partial<LensConfig>): LensConfig {
  return {
    name: "readability",
    cli: "claude",
    model: "sonnet",
    promptFile: "prompts/readability.md",
    promptSource: "builtin",
    toolPolicy: { type: "none" },
    maxTurns: 1,
    timeoutMs: 60000,
    isolation: "tempdir",
    severityCap: "blocker",
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

// ============================================================
// resolvePrompt
// ============================================================

describe("resolvePrompt", () => {
  it("builtin: returns path under diffelensRoot", async () => {
    const lens = makeLens({ promptSource: "builtin" });
    const resolved = await resolvePrompt(lens, "/fake-repo", diffelensRoot);

    expect(resolved.absolutePath).toBe(join(diffelensRoot, "prompts/readability.md"));
    await resolved.cleanup(); // noop, should not throw
  });

  it("custom: returns path under repoRoot", async () => {
    const repoRoot = await makeTempRepo();
    const promptPath = "review/my-prompt.md";
    await writeFile(join(repoRoot, "review", "dummy"), "", "utf-8").catch(() => {});

    const lens = makeLens({
      promptSource: "custom",
      promptFile: promptPath,
    });
    const resolved = await resolvePrompt(lens, repoRoot, diffelensRoot);

    expect(resolved.absolutePath).toBe(join(repoRoot, promptPath));
    await resolved.cleanup(); // noop
  });

  it("extended: creates temp file with combined content", async () => {
    const repoRoot = await makeTempRepo();
    const appendPath = "extra-rules.md";
    await writeFile(join(repoRoot, appendPath), "## Extra Rules\n- Be strict", "utf-8");

    const lens = makeLens({
      promptSource: "extended",
      promptAppendFile: appendPath,
    });

    const resolved = await resolvePrompt(lens, repoRoot, diffelensRoot);

    expect(resolved.absolutePath).toContain("diffelens-prompt-readability-");
    expect(existsSync(resolved.absolutePath)).toBe(true);

    const { readFile: rf } = await import("fs/promises");
    const content = await rf(resolved.absolutePath, "utf-8");
    expect(content).toContain("Extra Rules");
    expect(content).toContain("Be strict");

    await resolved.cleanup();
  });

  it("extended: cleanup removes temp file", async () => {
    const repoRoot = await makeTempRepo();
    const appendPath = "append.md";
    await writeFile(join(repoRoot, appendPath), "appended content", "utf-8");

    const lens = makeLens({
      promptSource: "extended",
      promptAppendFile: appendPath,
    });

    const resolved = await resolvePrompt(lens, repoRoot, diffelensRoot);
    const tempPath = resolved.absolutePath;
    expect(existsSync(tempPath)).toBe(true);

    await resolved.cleanup();
    expect(existsSync(tempPath)).toBe(false);
  });
});

// ============================================================
// validatePrompts
// ============================================================

describe("validatePrompts", () => {
  it("throws when builtin prompt is missing", async () => {
    const lens = makeLens({
      promptFile: "prompts/nonexistent.md",
      promptSource: "builtin",
    });

    await expect(
      validatePrompts([lens], "/fake-repo", diffelensRoot)
    ).rejects.toThrow("built-in prompt not found");
  });

  it("throws when custom prompt is missing", async () => {
    const repoRoot = await makeTempRepo();
    const lens = makeLens({
      promptFile: "review/missing.md",
      promptSource: "custom",
    });

    await expect(
      validatePrompts([lens], repoRoot, diffelensRoot)
    ).rejects.toThrow("custom prompt not found");
  });

  it("throws when append prompt is missing", async () => {
    const repoRoot = await makeTempRepo();
    const lens = makeLens({
      promptSource: "extended",
      promptAppendFile: "missing-append.md",
    });

    await expect(
      validatePrompts([lens], repoRoot, diffelensRoot)
    ).rejects.toThrow("append prompt not found");
  });

  it("passes when all prompts exist", async () => {
    const repoRoot = await makeTempRepo();
    const builtinLens = makeLens({ promptSource: "builtin" });

    await expect(
      validatePrompts([builtinLens], repoRoot, diffelensRoot)
    ).resolves.toBeUndefined();
  });
});
