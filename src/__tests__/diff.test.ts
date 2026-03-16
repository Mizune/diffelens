import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateGitRef } from "../options.js";
import type { RunOptions } from "../options.js";

// Mock child_process to control detectDefaultBranch behavior
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    execSync: vi.fn().mockImplementation((command: string, options?: object) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/main\n";
      }
      return original.execSync(command, options);
    }),
  };
});

import { buildDiffCommand, buildRefDiffCommand, detectDefaultBranch, parseDiffStats } from "../diff.js";
import { execSync } from "child_process";

const mockedExecSync = vi.mocked(execSync);

// ============================================================
// parseDiffStats
// ============================================================

describe("parseDiffStats", () => {
  it("counts files, additions, and deletions", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -1,2 +1,1 @@",
      "-const x = 1;",
      "-const y = 2;",
      "+const x = 3;",
    ].join("\n");

    const stats = parseDiffStats(diff);
    expect(stats.files).toBe(2);
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(3);
  });

  it("returns zeros for empty diff", () => {
    const stats = parseDiffStats("");
    expect(stats).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("does not count --- and +++ as additions/deletions", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,1 +1,1 @@",
      "-old line",
      "+new line",
    ].join("\n");

    const stats = parseDiffStats(diff);
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });
});

// ============================================================
// validateGitRef
// ============================================================

describe("validateGitRef", () => {
  it("accepts valid refs", () => {
    expect(validateGitRef("abc123")).toBe(true);
    expect(validateGitRef("main")).toBe(true);
    expect(validateGitRef("feature/foo")).toBe(true);
    expect(validateGitRef("HEAD~3")).toBe(true);
    expect(validateGitRef("v1.0.0")).toBe(true);
    expect(validateGitRef("abc123def456abc123def456abc123def456abcd")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateGitRef("")).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(validateGitRef("foo; rm -rf /")).toBe(false);
    expect(validateGitRef("$(whoami)")).toBe(false);
    expect(validateGitRef("foo`id`")).toBe(false);
    expect(validateGitRef("foo | cat")).toBe(false);
    expect(validateGitRef("foo & bg")).toBe(false);
    expect(validateGitRef("foo > /tmp/x")).toBe(false);
    expect(validateGitRef("foo < /tmp/x")).toBe(false);
    expect(validateGitRef("foo\nbar")).toBe(false);
  });
});

// ============================================================
// detectDefaultBranch
// ============================================================

describe("detectDefaultBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts branch name from symbolic-ref output", () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/develop\n";
      }
      return "";
    });
    expect(detectDefaultBranch("/tmp/repo")).toBe("develop");
  });

  it("returns main as fallback when symbolic-ref fails", () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        throw new Error("not a git repository");
      }
      return "";
    });
    expect(detectDefaultBranch("/tmp/repo")).toBe("main");
  });

  it("handles master branch", () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/master\n";
      }
      return "";
    });
    expect(detectDefaultBranch("/tmp/repo")).toBe("master");
  });
});

// ============================================================
// buildRefDiffCommand
// ============================================================

describe("buildRefDiffCommand", () => {
  it("both base and head: exact range", () => {
    expect(buildRefDiffCommand("abc123", "def456")).toBe(
      "git diff abc123...def456"
    );
  });

  it("head only: from merge-base with default branch", () => {
    expect(buildRefDiffCommand(undefined, "def456")).toBe(
      "git diff $(git merge-base def456 main)...def456"
    );
  });

  it("head only: uses custom default branch", () => {
    expect(buildRefDiffCommand(undefined, "def456", "develop")).toBe(
      "git diff $(git merge-base def456 develop)...def456"
    );
  });

  it("base only: from base to HEAD", () => {
    expect(buildRefDiffCommand("abc123", undefined)).toBe(
      "git diff abc123...HEAD"
    );
  });
});

// ============================================================
// buildDiffCommand integration
// ============================================================

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    mode: "local",
    prNumber: 0,
    baseSha: "",
    headSha: "",
    repoRoot: "/tmp/repo",
    diffelensRoot: "/tmp/diffelens",
    configPath: ".diffelens.yaml",
    configExplicit: false,
    stateDir: ".diffelens-state",
    diffTarget: "all",
    cliBase: undefined,
    cliHead: undefined,
    ...overrides,
  };
}

describe("buildDiffCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: simulate origin/HEAD → main
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/main\n";
      }
      return "";
    });
  });

  it("local mode without cliBase/cliHead uses diffTarget", () => {
    expect(buildDiffCommand(makeOptions({ diffTarget: "staged" }))).toBe(
      "git diff --cached"
    );
    expect(buildDiffCommand(makeOptions({ diffTarget: "branch" }))).toBe(
      "git diff $(git merge-base HEAD main)...HEAD"
    );
  });

  it("branch mode uses detected default branch", () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/master\n";
      }
      return "";
    });
    expect(buildDiffCommand(makeOptions({ diffTarget: "branch" }))).toBe(
      "git diff $(git merge-base HEAD master)...HEAD"
    );
  });

  it("cliHead uses detected default branch for merge-base", () => {
    mockedExecSync.mockImplementation((command: string) => {
      if (typeof command === "string" && command.includes("symbolic-ref")) {
        return "refs/remotes/origin/develop\n";
      }
      return "";
    });
    expect(
      buildDiffCommand(makeOptions({ cliHead: "abc123" }))
    ).toBe("git diff $(git merge-base abc123 develop)...abc123");
  });

  it("cliBase/cliHead overrides diffTarget in local mode", () => {
    expect(
      buildDiffCommand(makeOptions({ diffTarget: "staged", cliHead: "abc123" }))
    ).toBe("git diff $(git merge-base abc123 main)...abc123");
  });

  it("cliBase and cliHead together produce exact range", () => {
    expect(
      buildDiffCommand(
        makeOptions({ cliBase: "def456", cliHead: "abc123" })
      )
    ).toBe("git diff def456...abc123");
  });

  it("github mode ignores cliBase/cliHead", () => {
    expect(
      buildDiffCommand(
        makeOptions({
          mode: "github",
          baseSha: "aaa",
          headSha: "bbb",
          cliBase: "xxx",
          cliHead: "yyy",
        })
      )
    ).toBe("git diff aaa...bbb");
  });
});
