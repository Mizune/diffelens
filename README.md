# diffelens

Multi-lens AI PR review orchestrator using Claude Code CLI / Codex CLI.

## Concept

- **Lens Separation**: readability / architectural / bug_risk run as separate LLM invocations
- **Context Control**: readability receives only the diff; architectural allows full repository exploration
- **State Management**: `review_state.json` tracks findings across rounds and prevents contradictions
- **Convergence Control**: Round limit + progressive severity filtering prevents endless review loops
- **CLI Abstraction**: Claude Code / Codex can be swapped via adapter pattern

## Quick Start

```bash
# Install dependencies
npm install

# Claude Code CLI is required
npm install -g @anthropic-ai/claude-code

# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-xxx

# Test a single lens (run on a PR branch)
PR_NUMBER=1 BASE_SHA=abc HEAD_SHA=def npx tsx src/test-lens.ts readability

# Using gh CLI (on a PR branch)
npx tsx src/test-lens.ts readability
```

## Run All Lenses Locally

```bash
PR_NUMBER=1 \
BASE_SHA=$(gh pr view 1 --json baseRefOid -q .baseRefOid) \
HEAD_SHA=$(gh pr view 1 --json headRefOid -q .headRefOid) \
npx tsx src/main.ts
```

When GITHUB_TOKEN is not set, the summary is printed to stdout.

## Configuration

Place `.ai-review.yaml` at the repository root. Each lens can be configured with its own CLI, model, and tool permissions.

### Custom Prompts

Two mutually exclusive options per lens:

**Option A** — Full replacement:
```yaml
lenses:
  readability:
    prompt_file: "my-prompts/readability.md"
```

**Option B** — Append to builtin prompt:
```yaml
lenses:
  readability:
    prompt_append_file: "extra-rules.md"
```

### Convergence (N-round severity filtering)

```yaml
convergence:
  round_severities:
    - ["blocker", "warning", "nitpick"]   # round 1
    - ["blocker", "warning"]              # round 2
    - ["blocker"]                         # round 3+
  approve_condition: "zero_blockers"
```

Legacy `round_1_severities` / `round_2_severities` / `round_3_severities` format is also supported.

## File Structure

```
src/
├── main.ts              # Orchestrator
├── config.ts            # .ai-review.yaml loader + validation
├── options.ts           # CLI arg parsing + mode detection
├── diff.ts              # Diff fetching + hashing
├── lens-runner.ts       # Lens execution (CLI invocation)
├── prompt-resolver.ts   # Prompt resolution (builtin/custom/extended)
├── project-context.ts   # Repo metadata collection
├── filters.ts           # Diff filtering (glob-based exclusion)
├── severity.ts          # Shared severity rank constants
├── deduplicator.ts      # Finding deduplication
├── convergence.ts       # Convergence logic + per-round severity filter
├── test-lens.ts         # Single lens test runner
├── handle-command.ts    # /ai-review dismiss command handler
├── adapters/
│   ├── types.ts         # Shared interfaces
│   ├── claude-code.ts   # Claude Code CLI adapter
│   ├── codex.ts         # Codex CLI adapter
│   └── index.ts         # Factory
├── state/
│   └── review-state.ts  # State management
└── output/
    ├── summary-renderer.ts  # Markdown summary generation
    └── github-client.ts     # GitHub API client
prompts/
├── readability.md
├── architectural.md
└── bug_risk.md
```
