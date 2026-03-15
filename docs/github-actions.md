# GitHub Actions Guide

Automatically review PRs with diffelens on every push and PR open.

## Prerequisites

- A GitHub repository with diffelens installed (`npm install` or `package.json` dependency)
- An API key for at least one CLI tool (see [Secrets Configuration](#secrets-configuration))

## Secrets Configuration

Add the required API key(s) to your repository secrets (**Settings > Secrets and variables > Actions**):

| CLI | Secret Name | Required |
|-----|-------------|----------|
| Claude Code | `ANTHROPIC_API_KEY` | If using `claude` CLI |
| Codex CLI | `OPENAI_API_KEY` | If using `codex` CLI |
| Gemini CLI | `GEMINI_API_KEY` | If using `gemini` CLI |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Workflow Setup

### Basic Workflow (Claude Code)

Create `.github/workflows/ai-review.yml`:

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  pull-requests: write
  contents: read

jobs:
  ai-review:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Claude Code CLI
        run: npm install -g @anthropic-ai/claude-code

      - name: Install orchestrator dependencies
        run: npm ci

      - name: Run AI Review
        run: npx tsx src/main.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          CONFIG_PATH: ${{ github.workspace }}/.ai-review.yaml
```

### Gemini Workflow

To use Gemini instead, install the Gemini CLI and set `default_cli: "gemini"` in `.ai-review.yaml`:

```yaml
      - name: Install Gemini CLI
        run: npm install -g @google/gemini-cli

      - name: Run AI Review
        run: npx tsx src/main.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

### Multi-CLI Workflow

You can install multiple CLIs and let lenses use different backends:

```yaml
      - name: Install CLIs
        run: |
          npm install -g @anthropic-ai/claude-code
          npm install -g @google/gemini-cli

      - name: Run AI Review
        run: npx tsx src/main.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

Then configure per-lens CLIs in `.ai-review.yaml`:

```yaml
lenses:
  readability:
    cli: "gemini"
    model: "gemini-2.5-flash"
    # ...
  architectural:
    cli: "claude"
    model: "claude-opus-4-6"
    # ...
```

## Configuration

Place `.ai-review.yaml` at the repository root. The workflow reads it via `CONFIG_PATH` env var (defaults to `.ai-review.yaml`).

You can override with `--config` or `CONFIG_PATH`:

```yaml
env:
  CONFIG_PATH: ${{ github.workspace }}/my-custom-config.yaml
```

See [Local Mode Guide — Configuration](./local-mode.md#configuration) for full config reference.

## State Management

diffelens uses **comment-embedded state** for cross-round persistence in GitHub mode. Review state is encoded as a hidden HTML marker (`<!-- ai-review-state: {base64} -->`) at the end of the summary comment. No artifacts or external storage are needed.

1. On each workflow run, diffelens searches for the existing summary comment
2. If found, it extracts the embedded state and advances the round if `HEAD_SHA` changed
3. After review, the updated state is re-embedded into the comment

This approach is more reliable than GitHub Actions artifacts, which can silently fail on upload.

### How Rounds Work

- Each `synchronize` event (new push to the PR) triggers a new round
- Findings from previous rounds are carried forward; resolved findings are marked as "addressed"
- Severity filtering progressively narrows focus (configurable via `convergence.round_severities`)
- When `max_rounds` is exceeded, the review escalates to human review

## Dismiss Command

To dismiss a finding directly from the PR comment thread:

```
/ai-review dismiss {finding-id} {reason}
```

This requires the **command handler workflow** (`.github/workflows/ai-review-commands.yml`):

```yaml
name: AI Review Commands

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  contents: read

jobs:
  handle-command:
    if: |
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/ai-review')
    runs-on: ubuntu-latest
    timeout-minutes: 2

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Handle command
        run: npx tsx src/handle-command.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.issue.number }}
          COMMAND_BODY: ${{ github.event.comment.body }}
          COMMAND_USER: ${{ github.event.comment.user.login }}
          COMMENT_ID: ${{ github.event.comment.id }}
```

## Troubleshooting

### Missing API Key

```
Error: CLI "claude" is not installed or not in PATH.
```

Ensure the CLI is installed in a prior step and the corresponding API key secret is set.

### Timeout

If lenses timeout, increase `timeout_ms` in `.ai-review.yaml` or `timeout-minutes` in the workflow.

```yaml
# .ai-review.yaml
lenses:
  architectural:
    timeout_ms: 900000  # 15 minutes
```

### No Diff Found

```
No diff found (or all files excluded). Nothing to review.
```

Check that `fetch-depth: 0` is set in the checkout step. Without full history, `git diff` may not find changes.

### State Not Persisting

Review state is embedded in the PR summary comment. If state is lost between rounds:
- Ensure `GITHUB_TOKEN` has `pull-requests: write` permission
- Check that the summary comment (with `<!-- ai-review-summary -->` marker) exists and hasn't been deleted

### Lenses Skipped

```
Warning: Lens "readability" requires "claude" but not available. Skipping.
```

The CLI is not installed or not in PATH. Add the install step for the required CLI.
