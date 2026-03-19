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

```bash
npm install
npm install -g @anthropic-ai/claude-code  # or @google/gemini-cli
export ANTHROPIC_API_KEY=sk-ant-xxx

# Review current branch changes
npx tsx src/main.ts --diff-target branch

# Test a single lens
npx tsx src/test-lens.ts readability
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Local Mode](docs/local-mode.md) | CLI options, configuration, custom prompts, reading output |
| [GitHub Actions](docs/github-actions.md) | Workflow setup, secrets, state management, troubleshooting |

## File Structure

```
src/
├── main.ts              # Orchestrator
├── config.ts            # .diffelens.yaml loader + validation
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
├── handle-command.ts    # /diffelens dismiss command handler
├── adapters/
│   ├── types.ts         # Shared interfaces
│   ├── claude-code.ts   # Claude Code CLI adapter
│   ├── codex.ts         # Codex CLI adapter
│   ├── gemini.ts        # Gemini CLI adapter
│   └── index.ts         # Factory
├── state/
│   └── review-state.ts  # State management
└── output/
    ├── summary-renderer.ts  # Markdown summary generation
    ├── comment-state.ts     # State embedding in PR comments
    └── github-client.ts     # GitHub API client
prompts/
├── readability.md
├── architectural.md
└── bug_risk.md
```
