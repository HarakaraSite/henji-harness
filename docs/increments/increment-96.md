# Increment 96 — assistant Markdownの見出し全行着色と強調（`*`/`**`/`***`）の緑化

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: Increment 84（assistant本文レイアウトとMarkdownタグ着色）、Increment 95（会話ログのPageDown停止修正）、
通常利用メモのS5（assistant本文のrendering）。

## 利用者が必要とする動作

- Markdown見出し（`#`／`##`／`###`等）は、`#`記号だけでなく内容を含めた行全体が青で表示される。
- Markdownの強調 `*text*`（italic）／`**text**`（bold）／`***text***`（bold+italic）は、`*`記号を含む全体が
  緑で表示される（proseの強調にボールドは使わない）。
- 強調やinline code（`` `deno --version` ``）が行の折り返しをまたいでも、各行で正しく緑になる。
- 上記は会話ログのassistant本文で確認できる。

## 変更

### 見出しの全行着色（`v0/tui/assistant_layout.ts`）

見出し行のspanは`#`prefixのみ（`length: heading[1].length`）を青くしていた。内容を含む行全体
（折り返しの継続行を含む）を覆う1 spanへ変更し、見出し内のinline spanは全行青に統一するため付けない。

### 強調（`*`/`**`/`***`）の緑化（`v0/tui/assistant_layout.ts`、`v0/tui/conversation_renderer.ts`、`v0/tui/tui_renderer.ts`）

`inlineSpans`は`**bold**`と`` `code` ``のみを扱い、`*italic*`は未処理、`**bold**`はボールド、`***text***`は
`**text**`として部分的にボールドと判定されていた。triple/double/singleの順に検出し、いずれも`emphasis` tone
（緑）へ割り当てる。spanは`*`記号を含むマッチ全体（`match[0]`）を覆う。重複を避けるため各正規表現を
`(?<!\*)`／`(?!\*)`で隣接starから分離した。`AssistantSpanTone`へ`emphasis`を追加し、SGRマップで`GREEN_SGR`へ
割り当てる。table header cellの`bold` toneはそのまま。

初版は利用者の`***強調***`（3個）という指定に従いtriple-starのみを緑化したが、実際のassistant出力の強調は
`**text**`（2個）であり、利用者の訂正を受けて`*`／`**`／`***`すべてを緑とする最終契約へ更新した。

### wrap境界をまたぐinline spanの修正（`v0/tui/assistant_layout.ts`）

`inlineSpans`はwrap後の各行に適用していたため、`**...**`／`*...*`／`` `code` ``が折り返し境界をまたぐと
開き／閉じが別行に分かれ、どちらの行でもpairが成立せずspanが付かなかった（長いCJKトークンや
`` `deno --version` ``で発生）。`wrapCellsWithSource`を追加して各出力行のsource scalar indexを追跡し、元行で
検出したspanを`clipSpans`で各行へクリップするよう変更した。`wrapCells`は
`wrapCellsWithSource(...).map((wrapped) => wrapped.text)`のwrapperとし、table等の既存呼び出しは変更していない。

## 検証

- `tests/v0/increment_84_assistant_layout_test.ts`:
  - 見出しspanが行全体を覆うこと、折り返した見出しの各表示行が全行着色されること。
  - `*italic*`／`**bold**`／`***triple***`がいずれも`emphasis` spanになり、対象文字列が正しいこと。
  - `` `code` ``が`code` spanのままであること。
  - 折り返しをまたぐ`**...**`と`` `deno --version` ``が、複数行に分かれても各spanの合計が元の範囲と
    一致すること。
- `tests/v0/tui_conversation_presentation_test.ts`:
  - 最終frameで`## Title`全体が`\x1b[34m`、`**bold**`と`***em***`が`\x1b[32m`になること。
- `agent:increment-84-assistant-layout:test`（10件）、`tui_conversation_presentation_test.ts`（15件）、
  `tui_retained_terminal_test.ts`、`deno check`、`deno fmt --check`、`deno lint`、`git diff --check`は成功。

## 対象外

- Markdown記号自体の除去。従来どおり`#`や`*`は本文に表示する。
- 履歴ビュー（`/history`）の見た目。対象は会話ログのassistant本文。
- 数式中の`*`等、Markdown強調以外の用途のasterisk判定の厳密化。

## 関連候補の完了（2026-09-21）

利用者は通常利用メモS5（assistant本文のrendering）を完了と判断した。Increment 84のMarkdown readability
（word wrap、list／heading／quote／table、code span）と本incrementの見出し全行着色・強調（`*`／`**`／`***`）緑化・
折り返し跨ぎ対応で、通常利用の可読性は満たすと判断された。Mermaid等のblock renderer拡張、agentが意味的content
kind／presentation intentを返してHost Surfaceが解決する境界は、必要が生じた時点で新たに起票する。S5はinboxから
除いた。
