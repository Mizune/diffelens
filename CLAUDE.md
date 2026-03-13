# CLAUDE.md

## Project Overview
Multi-lens AI PR review orchestrator. Uses Claude Code CLI / Codex CLI as the execution engine for lenses, reviewing PRs in parallel from 3 specialized perspectives: readability, architectural, and bug_risk.

## Tech Stack
- TypeScript (ES2022, ESM)
- Node.js 20+
- Direct execution via tsx (no build step)
- @octokit/rest (GitHub API)
- yaml (config file parsing)

## Architecture
- `src/adapters/` — CLI abstraction layer. CLIAdapter interface absorbs differences between Claude Code / Codex
- `src/state/` — Cross-round state management via review_state.json
- `src/output/` — GitHub API integration and Markdown summary rendering
- `src/filters.ts` — Diff filtering with glob-based file exclusion
- `src/severity.ts` — Shared severity rank constants
- `prompts/` — System prompts for each lens (defines review focus, restrictions, and output format)

## Key Design Principles
1. **Vary context per lens**: readability runs in tempdir isolation with no tools; architectural/bug_risk can explore the repository
2. **Single summary comment**: Keeps the PR comment thread clean (identified by `<!-- ai-review-summary -->` marker)
3. **Convergent design**: Round limit + progressive severity filtering + approve when zero blockers

## Commands
- `npx tsx src/main.ts` — Run all lenses (requires PR_NUMBER, BASE_SHA, HEAD_SHA env vars)
- `npx tsx src/test-lens.ts <lens_name>` — Test a single lens
- `npx tsx src/handle-command.ts` — Process /ai-review dismiss commands

## Notes
- Imports use `.js` extension (ESM)
- `prompts/*.md` filenames must match lens names
