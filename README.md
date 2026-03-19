<p align="center">
  <img src="assets/logo.svg" alt="diffelens" width="400">
</p>

<p align="center">

[![CI](https://github.com/Mizune/diffelens/actions/workflows/ci.yml/badge.svg)](https://github.com/Mizune/diffelens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/diffelens)](https://www.npmjs.com/package/diffelens)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</p>

Multi-lens AI PR review orchestrator using LLM CLI tools such as Claude Code / Codex CLI / Gemini.

<p align="center">
  <img src="assets/screenshot.png" alt="diffelens PR review example" width="700">
</p>

## Concept

- **Lens Separation**: readability / architectural / bug_risk run as separate LLM invocations
- **Context Control**: readability receives only the diff; architectural allows full repository exploration
- **State Management**: Findings tracked across rounds — comment-embedded (GitHub) or file-based (local)
- **Convergence Control**: Round limit + progressive severity filtering prevents endless review loops
- **CLI Abstraction**: Claude Code / Codex / Gemini can be swapped via adapter pattern
- **Custom API Endpoints**: Proxy / base URL support per-lens or global for enterprise API gateways

## Quick Start

### Local Review

```bash
# Install diffelens and at least one LLM CLI
npm install -g diffelens
npm install -g @anthropic-ai/claude-code  # or @google/gemini-cli or @openai/codex

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-xxx

# Review current branch changes
diffelens --diff-target branch
```

### GitHub Actions

Add the workflow to your repo — diffelens posts a review comment on every PR:

```yaml
# .github/workflows/ai-review.yml
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
      - run: npm install -g diffelens @anthropic-ai/claude-code
      - run: diffelens
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

### Configuration

Place `.diffelens.yaml` at the repository root to customize lenses, models, and convergence settings.
If no config exists, diffelens uses its bundled default (Claude Code).

```yaml
# .diffelens.yaml
version: "1.0"
global:
  max_rounds: 4
  default_cli: "claude"
lenses:
  readability:
    cli: "claude"
    model: "claude-sonnet-4-6"
    isolation: "tempdir"
    tool_policy: "none"
    severity_cap: "warning"
  architectural:
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
  bug_risk:
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Local Mode](docs/local-mode.md) | CLI options, diff targets, custom prompts, convergence settings |
| [GitHub Actions](docs/github-actions.md) | Workflow setup, secrets, state management, troubleshooting |

## Contributing

```bash
git clone https://github.com/Mizune/diffelens.git
cd diffelens
npm install
npm test

# Run from source
npx tsx src/main.ts --diff-target branch
```
