# Increment 84 — assistant本文の読みやすいレイアウトとMarkdownタグ着色

ステータス: **実装・検証完了（正本更新は別承認待ち）**

基準commit: `ee60f070`

計画日: 2026-09-19

## 利用者が必要とする動作

- assistant本文が端末幅に合わせて読みやすく折り返される。モデルが出力した改行は保持し、幅を超える行だけを
  word-awareで折る（空白/CJK境界優先、無空白の長いトークンのみ強制分割）。
- リスト（`-`/`*`/`+`/番号）の継続行がmarker幅でhanging indentされる。
- Markdown表が列を揃えて表示される。幅に収まるときは自然幅、収まらないときはセル内を折り返して`|`位置を
  維持する。極端に狭く読めない場合は**records（`Header: value`の縦積み）へフォールバック**する。
- コードフェンス内は行を保持し、長い行のみ強制分割する。フェンス内は表・リストとして解釈しない。
- Markdownの各tagは残したまま、主要tagに色を付ける。`**bold**`はSGR1で太字にする。
- streaming中も同じrendererで、最初のframeから整形して表示する。resizeで再レイアウトする。
- 会話logのみが対象で、canonical transcript、`/history`、`/history export`、Presentation contractはplainの
  まま変更しない。

## 根拠

- 利用者観測（2026-09-19）: 現行はセル幅での機械的な折り返しのため、表が崩れ、段落が単語途中で切れ、
  リストの継続行のインデントが崩れる。tagsは残してよいが、レイアウトを見やすくしたい。
- 現行`projectConversationEntry`は`AssistantContentRenderer.render(text, phase)`が返す文字列を`wrap`で
  折るだけ。rendererは幅を受け取らず、spanも運べない。
- 参照実装調査（`docs/research/terminal-markdown-rendering-comparison.md`）: `_refs/zot`が`|`pipeを維持し、
  セル折り返しで全行のpipe位置を揃える。Codex/Retainerは狭幅時にrecordsフォールバックを使う。pi/opencodeは
  width指定・cell wrap・streaming安定化の参照。glow等の外部binary起動はstandalone・ANSI境界・毎frame速度の
  理由でproduction経路に採らない。

## 実装計画

1. renderer seamを拡張する。`AssistantContentRenderer.render(text, phase, width)`が
   `readonly { text: string; spans: readonly { start; length; tone }[] }[]`（整形済み行）を返す。
   `AssistantSpanTone`は`heading`/`list`/`code`/`table`/`bold`。既存`plainTextAssistantRenderer`は幅無視で
   各`\n`行をspanなしで返す。
2. `v0/tui/assistant_layout.ts`に自前のline-based rendererを追加する。block検出（fence/table/list/heading/
   quote/rule/paragraph）と、word wrap、cell折り返し表、recordsフォールバックを実装する。`cellWidth`を再利用。
3. `v0/tui/layout.ts`の`LayoutRow`に`spans`を追加し、`logRows`でassistant entryはrendererの行を直接
   LayoutRowへ写す（本文幅は`columns - label幅 - 1`）。非assistant entryは現行`wrap`を維持する。
   `projectConversationEntry`はrenderer引数を外し、label/text projectionだけにする。
4. `v0/tui/tui_renderer.ts`の`renderLayoutRow`を複数span対応にする。label色・tag色・bold・blinkを
   範囲ごとに注入する。`terminal.ts`に`BOLD_SGR`/`DIM_SGR`を追加する。既定`assistantRenderer`を新rendererへ
   差し替える。
5. tone対応: heading=blue、list=green、code=green、table=dim、bold=SGR1。markerは残す。
6. focused test: word wrap（Latin/CJK/長トークン）、list indent、表align、幅超過のセル折り返し、records
   フォールバック、fence保護、streaming途中、spanのframe注入、layoutがplainであること。
7. `v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate`を実行する。

## 表の字形と閾値（決定）

- 字形: `|`のpipeグリッドを維持し、separatorは`-`＋`:`のalignment markerを出す（zot方式、tagsを残す方針）。
- 列最小幅: 3セル。最広列を優先的に縮め、合計が収まるまで縮める。3セルを下回る列が生じる場合は
  recordsフォールバックへ切り替える。
- records形式: 1データ行を`<header>: <value>`の複数行で表示し、行間に空行を入れる。header labelはtable tone。

## 対象外

- ANSI theme設定、marker conceal切替（opencodeの`columns`preset等）。
- 表以外の高度syntax（HTML、画像、脚注、数式、mermaid）。
- parserの外部ライブラリ化（`marked`等同梱の検討は`terminal-markdown-rendering-comparison.md`の未決メモ。
  通常利用で自前parserの限界が問題になるまで保留）。
- user/tool/system行のレイアウト、`/history`・export、Worker protocol、Session schema。
- glow等の外部binary起動。
- roadmap F01/F10/TUI節、architecture Surface記述、`v0/agent/README.md`の正本更新（**別承認**）。

## Human Gate

- 利用者は2026-09-19に、Phase Bを「さっきの案」＝上記の本文レイアウト＋tag着色で進めることを指示した。
- 表の字形・recordsフォールバック・tone対応は本書の決定に従う。
- roadmap・architecture・component READMEの正本更新は、実装結果を確認したうえで別途承認を得る。

## Verification

- focused testと`v0:gate`。
- live provider、実TTY、compiled binaryは実装後の安定候補で別途確認する。

## 結果

- renderer seamを`render(text, phase, width)`へ拡張し、`AssistantLine`（本文＋inline span）を返すようにした。
  `AssistantSpanTone`はheading/list/code/table/quote/bold。`plainTextAssistantRenderer`は各行spanなしで互換。
- `v0/tui/assistant_layout.ts`に自前line-based rendererを追加した。word wrap（空白境界、無空白トークンのみ
  強制分割、CJKはセル単位）、list/heading/quoteのhanging indent、`|`pipe表（alignment marker・セル折り返し・
  列最小3）、収まらない表のrecordsフォールバック、fence保護、inline `**bold**`／backtick code spanを実装。
- `LayoutRow`へ`spans`を追加し、`logRows`はassistant entryをrendererの行から直接組み立てる（本文幅は
  `columns - label幅 - 1`）。`renderLayoutRow`はlabel色・tag色・bold・blinkを範囲ごとに最終frameへ注入する。
- 既定`assistantRenderer`を`markdownAssistantRenderer`へ差し替えた。toneはheading=blue、list/code=green、
  table=dim、quote=magenta、bold=SGR1。recordsの`Header:`labelは可読性のためlist（green）にした。
- `plainTextAssistantRenderer`はテスト注入用に残し、既存のplain境界testも維持。

## Verification結果

- focused test: `tests/v0/increment_84_assistant_layout_test.ts` 8件pass（Latin/CJK wrap、list indent、表align、
  セル折り返し、records fallback、fence保護、span検出）。
- 既存TUI suite（`tui_conversation_presentation`のmarkdown span frame test追加、`tui_retained_terminal`、
  `tui_controller_overlay`）pass。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`／authoritative `v0:gate` exit 0。
- 実TTY・compiled binaryでの目視確認は未実施（安定候補で別途）。

## 規模見積り

renderer seam変更、自前markdown layout、span描画、test更新で**2〜3開発日相当**。
