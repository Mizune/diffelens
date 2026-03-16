# CLAUDE.md

## Project Overview
Multi-lens AI PR review orchestrator. Uses Claude Code CLI / Codex CLI as the execution engine for lenses, reviewing PRs in parallel from specialized perspectives (default: readability, architectural, bug_risk). Custom lenses can be added via `.diffelens.yaml`.

## Tech Stack
- TypeScript (ES2022, ESM)
- Node.js 20+
- Direct execution via tsx (no build step)
- @octokit/rest (GitHub API)
- yaml (config file parsing)

## Architecture
- `src/main.ts` — Orchestrator: config → diff → lenses → dedup → convergence → output
- `src/config.ts` — `.diffelens.yaml` loader with validation and normalization
- `src/options.ts` — CLI arg parsing and mode detection (github / local)
- `src/diff.ts` — Diff fetching (git diff) and hashing
- `src/lens-runner.ts` — Lens execution via CLI adapter
- `src/prompt-resolver.ts` — Prompt resolution: builtin / custom / extended (append)
- `src/project-context.ts` — Repo metadata collection (language detection, CLAUDE.md)
- `src/filters.ts` — Diff filtering with glob-based file exclusion
- `src/severity.ts` — Shared severity rank constants and validation set
- `src/deduplicator.ts` — Cross-lens finding deduplication
- `src/convergence.ts` — Convergence logic and per-round severity filtering
- `src/adapters/` — CLI abstraction layer (Claude Code / Codex adapter pattern)
- `src/state/` — Cross-round state management via review_state.json
- `src/output/` — GitHub API integration and Markdown summary rendering
- `prompts/` — System prompts for each lens (defines review focus, restrictions, and output format)

## Key Design Principles
1. **Vary context per lens**: readability runs in tempdir isolation with no tools; architectural/bug_risk can explore the repository
2. **Single summary comment**: Keeps the PR comment thread clean (identified by `<!-- diffelens-summary -->` marker)
3. **Convergent design**: N-round severity filtering via `round_severities` array + approve when zero blockers
4. **Custom prompts**: `prompt_file` for full replacement, `prompt_append_file` to extend builtin prompts

## Configuration
- Config path: `--config` arg → `CONFIG_PATH` env var → `.diffelens.yaml` (cwd)
- Local mode fallback: diffelens bundled `.diffelens.yaml` if repo has none
- **Local overlay**: `.diffelens.local.yaml` is auto-detected in local mode and deep-merged over the base config. Only specified fields are overridden. Skipped when `--config` is explicitly provided. Use this to run different CLI/model settings locally (e.g., Claude Opus) vs CI (e.g., Gemini Flash)
- **API proxy**: `global.base_url` or per-lens `base_url` sets CLI-specific env vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_API_BASE_URL`)
- Convergence: `round_severities` array (N rounds) or legacy `round_N_severities` (auto-normalized)

## Commands
- `npx tsx src/main.ts` — Run all lenses (github mode: requires PR_NUMBER, BASE_SHA, HEAD_SHA)
- `npx tsx src/main.ts --diff-target branch` — Local mode: review current branch diff
- `npx tsx src/test-lens.ts <lens_name>` — Test a single lens
- `npx tsx src/handle-command.ts` — Process /diffelens dismiss commands

## Notes
- Imports use `.js` extension (ESM)
- Builtin `prompts/*.md` filenames must match lens names
- Custom lenses require `prompt_file` in config
