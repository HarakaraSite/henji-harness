# Increment 96 — assistant Markdownの見出し全行着色と`***強調***`の緑化

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: Increment 84（assistant本文レイアウトとMarkdownタグ着色）、Increment 95（会話ログのPageDown停止修正）、
通常利用メモのS5（assistant本文のrendering）。

## 利用者が必要とする動作

- Markdown見出し（`#`／`##`／`###`等）は、`#`記号だけでなく内容を含めた行全体が青で表示される。
- `***強調***`（triple-star）はボールドではなく緑で表示される。
- `**bold**`は従来どおりボールドのまま。上記は会話ログのassistant本文で確認できる。

## 変更

### 見出しの全行着色（`v0/tui/assistant_layout.ts`）

見出し行のspanは`#`prefixのみ（`length: heading[1].length`）を青くしていた。内容を含む行全体
（折り返しの継続行を含む）を覆う1 spanへ変更し、見出し内のinline span（bold/code）は全行青に統一するため
付けない。

### `***強調***`の緑化（`v0/tui/assistant_layout.ts`、`v0/tui/conversation_renderer.ts`、`v0/tui/tui_renderer.ts`）

`inlineSpans`は`**bold**`と`` `code` ``のみを扱い、`***text***`は`**text**`として部分的にboldと判定されて
いた。`***([^*]+)***`を先に`emphasis` toneとして検出し、bold正規表現を`(?<!\*)\*\*(?!\*)([^*]+)\*\*`へ
変更してtriple-starと重複しないようにした。`AssistantSpanTone`へ`emphasis`を追加し、SGRマップで緑
（`GREEN_SGR`）へ割り当てる。

## 検証

- `tests/v0/increment_84_assistant_layout_test.ts`:
  - 見出しspanが行全体を覆うこと（既存testの期待を新契約へ更新）。
  - 折り返した見出しの各表示行が全行着色されること。
  - `***em***`が`emphasis`、`**bold**`が`bold`のspanになり、対象文字列が正しいこと。
- `tests/v0/tui_conversation_presentation_test.ts`:
  - 最終frameで`## Title`全体が`\x1b[34m`、`bold`が`\x1b[1m`、`em`が`\x1b[32m`になること。
- `agent:increment-84-assistant-layout:test`（10件）、`tui_conversation_presentation_test.ts`（15件）、
  `tui_retained_terminal_test.ts`、`deno check`、`deno fmt --check`、`deno lint`、`git diff --check`は成功。

## 対象外

- `*italic*`（single-star）の着色。今回の利用者要件はtriple-starのみ。
- Markdown記号自体の除去。従来どおり`#`や`*`は本文に表示する。
- 履歴ビュー（`/history`）の見た目。対象は会話ログのassistant本文。
