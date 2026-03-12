# AI PR Review

Multi-lens AI PR review orchestrator using Claude Code CLI / Codex CLI.

## コンセプト

- **レンズ分離**: readability / structural / bug_risk を別々のLLM呼び出しで実行
- **コンテキスト制御**: readabilityではdiffのみ渡し、structuralではリポジトリ探索を許可
- **状態管理**: `review_state.json` でラウンド間のfinding追跡・矛盾防止
- **収束制御**: ラウンド上限 + severity段階的フィルタで「終わらないレビュー」を防止
- **CLI抽象化**: Claude Code / Codex をアダプターで切り替え可能

## Quick Start

```bash
# 依存関係インストール
npm install

# Claude Code CLIが必要
npm install -g @anthropic-ai/claude-code

# 環境変数を設定
export ANTHROPIC_API_KEY=sk-ant-xxx

# 単一レンズのテスト（PRのあるブランチで実行）
PR_NUMBER=1 BASE_SHA=abc HEAD_SHA=def npx tsx src/test-lens.ts readability

# gh cli を使う場合（PRのブランチ上で）
npx tsx src/test-lens.ts readability
```

## ローカルで全レンズ実行

```bash
PR_NUMBER=1 \
BASE_SHA=$(gh pr view 1 --json baseRefOid -q .baseRefOid) \
HEAD_SHA=$(gh pr view 1 --json headRefOid -q .headRefOid) \
npx tsx src/main.ts
```

GITHUB_TOKEN が未設定の場合、サマリーはstdoutに出力されます。

## 設定

`.ai-review.yaml` をリポジトリルートに配置。レンズごとにCLI・モデル・ツール権限を設定できます。

## ファイル構成

```
src/
├── main.ts              # オーケストレーター
├── config.ts            # .ai-review.yaml 読み込み
├── lens-runner.ts       # レンズ実行（CLI呼び出し）
├── deduplicator.ts      # 重複排除
├── convergence.ts       # 収束判定
├── test-lens.ts         # 単一レンズテスト
├── handle-command.ts    # /ai-review dismiss コマンド
├── adapters/
│   ├── types.ts         # 共通インターフェース
│   ├── claude-code.ts   # Claude Code CLI アダプター
│   ├── codex.ts         # Codex CLI アダプター
│   └── index.ts         # ファクトリ
├── state/
│   └── review-state.ts  # 状態管理
└── output/
    ├── summary-renderer.ts  # Markdownサマリー生成
    └── github-client.ts     # GitHub API
prompts/
├── readability.md
├── structural.md
└── bug_risk.md
```
