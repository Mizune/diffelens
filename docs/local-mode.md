# Local Mode Guide

Run diffelens locally to review your changes before pushing.

## Prerequisites

- **Node.js 20+**
- At least one CLI tool installed:

| CLI | Install | API Key |
|-----|---------|---------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| Codex CLI | `npm install -g @openai/codex` | `OPENAI_API_KEY` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `GEMINI_API_KEY` |

## Setup

```bash
# Install diffelens globally
npm install -g diffelens

# Install at least one LLM CLI
npm install -g @anthropic-ai/claude-code  # or @google/gemini-cli or @openai/codex

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-xxx
```

## Usage

### Basic Usage

```bash
# Review all staged + unstaged changes (default)
diffelens

# Review current branch diff against main
diffelens --diff-target branch

# Review only staged changes
diffelens --diff-target staged
```

### Commit Range

```bash
# Review a specific commit range
diffelens --base def5678 --head abc1234

# Review from a specific base to current HEAD
diffelens --base def5678

# Review up to a specific commit
diffelens --head abc1234
```

> When `--base` or `--head` is provided, `--diff-target` is ignored.

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--diff-target` | `staged` / `unstaged` / `all` / `branch` / `commits` | `all` |
| `--base <ref>` | Base git ref for diff range | merge-base with main |
| `--head <ref>` | Head git ref for diff range | current HEAD |
| `--config <path>` | Config file path | `.diffelens.yaml` |
| `--state-dir <path>` | State directory | `.diffelens-state` |
| `--mode` | `github` / `local` (usually auto-detected) | auto-detect |

## Configuration

Place `.diffelens.yaml` at the repository root. If no config exists in the target repo, diffelens uses its own bundled default config.

### Local Config Overlay

You can override settings for local development by creating `.diffelens.local.yaml` alongside `.diffelens.yaml`. In local mode, diffelens auto-detects this file and deep-merges it over the base config. Only specify fields you want to override — everything else is inherited.

```yaml
# .diffelens.local.yaml — use Claude locally instead of Gemini
global:
  default_cli: "claude"

lenses:
  readability:
    cli: "claude"
    model: "claude-opus-4-6"
  architectural:
    cli: "claude"
    model: "claude-opus-4-6"
  bug_risk:
    cli: "claude"
    model: "claude-opus-4-6"
```

**Merge rules:**

| Field | Strategy |
|-------|----------|
| `global.*` | Field-level overwrite |
| `lenses.<name>.*` | Per-lens field-level overwrite |
| `convergence.*` | Field-level overwrite |
| `filters.exclude_patterns` | Array replacement (not appended) |

**Notes:**
- `.diffelens.local.yaml` is gitignored by default
- Skipped when `--config` is explicitly provided
- Only applied in local mode (GitHub Actions always uses `.diffelens.yaml`)

### Default Config (Claude Code)

```yaml
version: "1.0"

global:
  max_rounds: 4
  language: "en"
  default_cli: "claude"
  timeout_ms: 120000
  # base_url: "https://proxy.example.com"

lenses:
  readability:
    enabled: true
    cli: "claude"
    model: "claude-sonnet-4-6"
    isolation: "tempdir"
    tool_policy: "none"
    timeout_ms: 300000
    severity_cap: "warning"

  architectural:
    enabled: true
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
    timeout_ms: 600000
    severity_cap: "blocker"

  bug_risk:
    enabled: true
    cli: "claude"
    model: "claude-opus-4-6"
    isolation: "repo"
    tool_policy:
      type: "explicit"
      tools: ["Read", "Grep", "Glob"]
    timeout_ms: 600000
    severity_cap: "blocker"
```

### Gemini Config

```yaml
version: "1.0"

global:
  max_rounds: 2
  default_cli: "gemini"
  timeout_ms: 120000
  # base_url: "https://proxy.example.com"

lenses:
  readability:
    enabled: true
    cli: "gemini"
    model: "gemini-2.5-flash"
    isolation: "tempdir"
    tool_policy: "none"
    timeout_ms: 300000
    severity_cap: "warning"

  bug_risk:
    enabled: true
    cli: "gemini"
    model: "gemini-2.5-flash"
    isolation: "tempdir"
    tool_policy: "none"
    timeout_ms: 300000
    severity_cap: "blocker"
```

### Key Config Fields

| Field | Description |
|-------|-------------|
| `global.default_cli` | Default CLI for all lenses (`claude`, `codex`, `gemini`) |
| `lenses.<name>.cli` | Per-lens CLI override |
| `lenses.<name>.model` | Model name passed to the CLI |
| `lenses.<name>.isolation` | `tempdir` (diff only) or `repo` (full repository access) |
| `lenses.<name>.tool_policy` | `none`, `read_only`, or `{ type: "explicit", tools: [...] }` |
| `lenses.<name>.severity_cap` | Maximum severity a lens can produce (`blocker`, `warning`, `nitpick`) |
| `global.base_url` | API proxy base URL for all lenses |
| `lenses.<name>.base_url` | Per-lens API proxy base URL (overrides global) |
| `filters.exclude_patterns` | Glob patterns for files to exclude from the diff |

## Custom Prompts

Two mutually exclusive options per lens:

**Option A — Full replacement:** provide your own prompt file.

```yaml
lenses:
  readability:
    prompt_file: "my-prompts/readability.md"
```

**Option B — Append to builtin prompt:** extend the default prompt with additional rules.

```yaml
lenses:
  readability:
    prompt_append_file: "extra-rules.md"
```

Custom lenses (names other than `readability`, `architectural`, `bug_risk`) always require `prompt_file`.

## Custom API Endpoints / Proxy

Use `base_url` to route LLM API calls through a proxy (e.g., corporate API gateway).

### Global proxy

```yaml
global:
  default_cli: "claude"
  base_url: "https://ai-proxy.corp.example.com"
```

### Per-lens override

```yaml
lenses:
  readability:
    cli: "claude"
    base_url: "https://claude-proxy.example.com"
  bug_risk:
    cli: "codex"
    base_url: "https://openai-proxy.example.com"
```

### Local overlay for proxy

```yaml
# .diffelens.local.yaml
global:
  base_url: "http://localhost:8080"
```

### Precedence

```
per-lens base_url > global base_url > ambient env var > CLI default
```

### CLI-to-env-var mapping

| CLI | Env var set by diffelens |
|-----|--------------------------|
| Claude Code | `ANTHROPIC_BASE_URL` |
| Codex | `OPENAI_BASE_URL` |
| Gemini | `GEMINI_API_BASE_URL` |

## Convergence

Controls how many rounds of review run and which severities are included per round.

```yaml
convergence:
  round_severities:
    - ["blocker", "warning", "nitpick"]   # round 1: all severities
    - ["blocker", "warning"]              # round 2: drop nitpick
    - ["blocker"]                         # round 3+: blockers only
  approve_condition: "zero_blockers"
```

The legacy format (`round_1_severities`, `round_2_severities`, `round_3_severities`) is also supported.

## Reading Output

In local mode, the summary is printed to stdout. It includes:

- **Decision**: `APPROVED`, `CHANGES REQUESTED`, or `ESCALATED`
- **Severity counts**: blockers, warnings, nitpicks, resolved
- **Findings**: grouped by severity with file location, summary, and suggestion
- **Convergence hint**: re-run after fixing issues to check convergence

Each finding shows:
- `[id]` — unique identifier for the finding
- `file:line` — source location
- Summary and suggestion
- Lens name and round info
