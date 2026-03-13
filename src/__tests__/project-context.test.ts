import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readAndTruncate,
  detectLanguage,
  collectProjectContext,
  formatProjectContext,
  type ProjectContext,
} from "../project-context.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-context-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// readAndTruncate
// ============================================================

describe("readAndTruncate", () => {
  it("returns null for non-existent file", async () => {
    const result = await readAndTruncate(join(tempDir, "nope.md"), 1000);
    expect(result).toBeNull();
  });

  it("returns full content for small file", async () => {
    const content = "# Hello\nThis is a test file.\n";
    await writeFile(join(tempDir, "small.md"), content);

    const result = await readAndTruncate(join(tempDir, "small.md"), 1000);
    expect(result).toBe(content);
  });

  it("truncates at line boundary with notice for large file", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: some content here`);
    const content = lines.join("\n");
    await writeFile(join(tempDir, "large.md"), content);

    const maxChars = 200;
    const result = await readAndTruncate(join(tempDir, "large.md"), maxChars);

    expect(result).not.toBeNull();
    expect(result!).toContain("... (truncated)");
    // Content before truncation notice should be <= maxChars
    const beforeNotice = result!.split("\n\n... (truncated)")[0];
    expect(beforeNotice.length).toBeLessThanOrEqual(maxChars);
  });
});

// ============================================================
// detectLanguage
// ============================================================

describe("detectLanguage", () => {
  it("detects TypeScript from package.json with typescript dep", async () => {
    const pkg = { devDependencies: { typescript: "^5.0.0" } };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg));

    const result = await detectLanguage(tempDir);
    expect(result).toBe("TypeScript");
  });

  it("detects JavaScript from package.json without typescript dep", async () => {
    const pkg = { dependencies: { express: "^4.0.0" } };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg));

    const result = await detectLanguage(tempDir);
    expect(result).toBe("JavaScript");
  });

  it("detects TypeScript from tsconfig.json (higher priority than package.json)", async () => {
    await writeFile(join(tempDir, "tsconfig.json"), "{}");
    const pkg = { dependencies: { express: "^4.0.0" } };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg));

    const result = await detectLanguage(tempDir);
    expect(result).toBe("TypeScript");
  });

  it("detects Go from go.mod", async () => {
    await writeFile(join(tempDir, "go.mod"), "module example.com/foo\n");

    const result = await detectLanguage(tempDir);
    expect(result).toBe("Go");
  });

  it("detects Rust from Cargo.toml", async () => {
    await writeFile(join(tempDir, "Cargo.toml"), "[package]\nname = \"foo\"\n");

    const result = await detectLanguage(tempDir);
    expect(result).toBe("Rust");
  });

  it("detects Python from pyproject.toml", async () => {
    await writeFile(join(tempDir, "pyproject.toml"), "[tool.poetry]\nname = \"foo\"\n");

    const result = await detectLanguage(tempDir);
    expect(result).toBe("Python");
  });

  it("detects Dart/Flutter from pubspec.yaml", async () => {
    await writeFile(join(tempDir, "pubspec.yaml"), "name: foo\n");

    const result = await detectLanguage(tempDir);
    expect(result).toBe("Dart/Flutter");
  });

  it("returns null when no manifest found", async () => {
    const result = await detectLanguage(tempDir);
    expect(result).toBeNull();
  });
});

// ============================================================
// formatProjectContext
// ============================================================

describe("formatProjectContext", () => {
  it("returns empty string when all fields are null", () => {
    const ctx: ProjectContext = { language: null, claudeMd: null, agentsMd: null };
    expect(formatProjectContext(ctx)).toBe("");
  });

  it("includes all sections when all fields are present", () => {
    const ctx: ProjectContext = {
      language: "TypeScript",
      claudeMd: "# Project\nSome guidelines",
      agentsMd: "# Agents\nSome agent config",
    };

    const result = formatProjectContext(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("**Language/Framework**: TypeScript");
    expect(result).toContain("### Project Guidelines (CLAUDE.md)");
    expect(result).toContain("Some guidelines");
    expect(result).toContain("### Agent Guidelines (AGENTS.md)");
    expect(result).toContain("Some agent config");
  });

  it("omits sections for null fields", () => {
    const ctx: ProjectContext = {
      language: "Go",
      claudeMd: null,
      agentsMd: null,
    };

    const result = formatProjectContext(ctx);
    expect(result).toContain("## Project Context");
    expect(result).toContain("**Language/Framework**: Go");
    expect(result).not.toContain("### Project Guidelines");
    expect(result).not.toContain("### Agent Guidelines");
  });

  it("includes only CLAUDE.md when agentsMd is null", () => {
    const ctx: ProjectContext = {
      language: null,
      claudeMd: "# Guidelines",
      agentsMd: null,
    };

    const result = formatProjectContext(ctx);
    expect(result).toContain("### Project Guidelines (CLAUDE.md)");
    expect(result).not.toContain("### Agent Guidelines");
  });
});

// ============================================================
// collectProjectContext
// ============================================================

describe("collectProjectContext", () => {
  it("uses languageOverride and skips auto-detection", async () => {
    // Place a Go manifest — but override should take precedence
    await writeFile(join(tempDir, "go.mod"), "module example.com/foo\n");

    const ctx = await collectProjectContext(tempDir, "Kotlin");
    expect(ctx.language).toBe("Kotlin");
  });

  it("auto-detects language when override is null", async () => {
    await writeFile(join(tempDir, "go.mod"), "module example.com/foo\n");

    const ctx = await collectProjectContext(tempDir, null);
    expect(ctx.language).toBe("Go");
  });

  it("reads CLAUDE.md and AGENTS.md when present", async () => {
    await writeFile(join(tempDir, "CLAUDE.md"), "# Claude\nGuidelines here");
    await writeFile(join(tempDir, "AGENTS.md"), "# Agents\nAgent config");

    const ctx = await collectProjectContext(tempDir, null);
    expect(ctx.claudeMd).toContain("Guidelines here");
    expect(ctx.agentsMd).toContain("Agent config");
  });

  it("returns null for missing CLAUDE.md and AGENTS.md", async () => {
    const ctx = await collectProjectContext(tempDir, null);
    expect(ctx.claudeMd).toBeNull();
    expect(ctx.agentsMd).toBeNull();
  });
});
