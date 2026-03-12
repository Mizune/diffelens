# CLAUDE.md

## プロジェクト概要
Multi-lens AI PR review orchestrator。Claude Code CLI / Codex CLIをレンズの実行エンジンとして使い、PRをreadability / structural / bug_riskの3つの専門的な観点から並列レビューする。

## 技術スタック
- TypeScript (ES2022, ESM)
- Node.js 20+
- tsx で直接実行（ビルド不要）
- @octokit/rest (GitHub API)
- yaml (設定ファイル読み込み)

## アーキテクチャ
- `src/adapters/` — CLI抽象化レイヤー。CLIAdapter インターフェースで Claude Code / Codex の差分を吸収
- `src/state/` — review_state.json によるラウンド間の状態管理
- `src/output/` — GitHub APIとMarkdownサマリーレンダリング
- `prompts/` — 各レンズのシステムプロンプト（レビュー観点・禁止事項・出力形式を定義）

## 重要な設計原則
1. **レンズ間でコンテキスト量を変える**: readability は tempdir 隔離 + ツールなし、structural/bug_risk はリポジトリ探索可能
2. **1つのサマリーコメントを更新し続ける**: PRのコメント欄を汚さない（マーカー `<!-- ai-review-summary -->` で識別）
3. **収束する設計**: ラウンド上限 + severity フィルタの段階的厳格化 + blocker 0件でapprove

## コマンド
- `npx tsx src/main.ts` — 全レンズ実行（PR_NUMBER, BASE_SHA, HEAD_SHA 環境変数が必要）
- `npx tsx src/test-lens.ts <lens_name>` — 単一レンズのテスト
- `npx tsx src/handle-command.ts` — /ai-review dismiss コマンド処理

## 注意
- import は `.js` 拡張子付き（ESM）
- `prompts/*.md` のファイル名はレンズ名と一致させること
