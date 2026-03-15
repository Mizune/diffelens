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

import { buildDiffCommand, buildRefDiffCommand, detectDefaultBranch } from "../diff.js";
import { execSync } from "child_process";

const mockedExecSync = vi.mocked(execSync);

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
    configPath: ".ai-review.yaml",
    stateDir: ".ai-review-state",
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
