# terminal markdownレンダリングの参照実装比較

調査日: 2026-09-19

## 位置付け

Increment 84（assistant本文の読みやすいレイアウトとMarkdownタグ着色）の計画に使う参照実装調査である。
Henjiへの採用、architecture・roadmap変更、実装認可を意味しない。対象は、terminal上のMarkdownを
(1) 単語境界で折り返す、(2) 表を幅に収める、(3) タグをANSI styleで着色する、(4) streaming中に再描画する、
の4点である。現行Henjiのassistant本文は`plainTextAssistantRenderer`が無変換で返し、layoutがセル幅で
機械的に折り返す。このリポジトリの`_refs/`にあるzotとpiは、他incrementでも参照してきたローカルcheckoutで、
本調査では実sourceを直接確認した。

## 比較

| 参照実装 | 折り返し | 表 | ANSI style | streaming・resize | Henjiとの対応 |
| --- | --- | --- | --- | --- | --- |
| [glow](https://github.com/charmbracelet/glow) / [Glamour](https://github.com/charmbracelet/glamour)（手元で実挙動を観測） | 単語境界。幅指定`--width` | `│`/`─`のグリッド。列幅を自然幅から詰め、幅超過時は**セル内で折り返して列位置を維持**する。全列を極小まで縮める | 見出しやmarkerをbold、コードを着色 | 文書単位のrenderer。widthごとに再生成する。resize再描画は呼出側 | 表のセル折り返しとmarker着色の直接参照 |
| zot（手元`_refs/zot`、`packages/tui/markdown.go`・`markdown_test.go`） | 単語境界はview層の`wrapANSILine`。本文は幅で再折り返し | `|`の**pipeグリッドを維持**。separatorは`-`＋`:---`のalignment marker。列最小3、最広列を1つずつ縮め、最小未満なら**溢れを許容**（読めなさより最小可読幅を優先）。セル折り返しで全行のpipe位置一致をtestで保証 | heading prefix・`•`・番号・`┃`・inline code/bold/italicをaccent/mutedで着色 | **行ベース**で未閉じフェンスをEOFでflush（streaming耐性）。widthは表とruleに使用 | Henjiの現行に最も近い**直接参照**。marker維持・marker着色・表のセル折り返しが一致 |
| pi（手元`_refs/pi`、`packages/tui/src/components/markdown.ts`、`packages/tui/src/utils.ts`） | ANSI-aware `wrapTextWithAnsi`。改行をまたいでstyle stateを追跡 | `┌─┬─┐`の**罫線グリッド**。自然幅＋最長単語の最小幅（上限30）を求め、重み配分で縮小。極小なら**生Markdownへfallback**。headerはbold、セルはwrapしてpadding | headingはh1 bold+underline・h2+ boldで`#`prefix維持（h3+）、strong/italic/code/strikethrough/link | AST（marked）ベース。linkは`text (url)`でURLを併記 | heading・表の列幅アルゴリズム・link表記・fallbackの**直接参照** |
| opencode / [OpenTUI](https://opentui.com/docs/components/markdown)（手元`opencode 1.18.31`、GitHub確認。`_refs`には未収録） | セル幅ベース。`wrapMode: word/char/none`、Yogaのflexbox計測、`renderer.widthMethod` unicode/wcwidth | `MarkdownRenderable.tableOptions`。preset `grid`（罫線・full幅）と`columns`（罫線なし・content幅）。`widthMode` content/full、`columnFitter` proportional/balancedで**セルwrapしながら列を縮小**。`borderStyle` single/double/rounded/bold | markerのconceal切替（`session.toggle.conceal`）、syntax highlight、`TextTable`のセル選択 | top-level blockを子renderableとして保持し`_stableBlockCount`でstable prefixを出す。**streaming中は未完tableの最終行を描画せずflicker防止**、codeはhighlight完了までunstyledを出さない | 表option設計とstreaming安定化の参照。ただしDOM/YogaモデルでHenjiの行ベースlayoutとは実装が異なる |
| Codex CLI（手元`codex-cli 0.155.1`、[#15449](https://github.com/openai/codex/issues/15449)・[#22410](https://github.com/openai/codex/issues/22410)、[解説](https://www.vincentschmalbach.com/codex-cli-responsive-terminal-tables)） | 単語境界 | 自然幅→配分。崩れるセル/行を検出し、影響行が閾値超、または全列3セル未満なら**records（key/value縦積み）へ自動切替**。1行表は早期切替 | header boldとテーマ色 | 元Markdownを保持しresizeで再描画。OSC8リンクを折り返し断片へ付与 | 幅不足時の**recordsフォールバック**の直接参照 |
| [Retainer `mdrender`](https://pkg.go.dev/github.com/seamus-brady/retainer/internal/tui/mdrender) | 単語境界（width必須） | 列揃え＋**recordsフォールバック**。Glamourの表がchat幅で読めないため自作したと明記 | bold/dim/italicを保守的に使用 | widthごとにrendererを生成。パース失敗時は**生テキスト返却** | Glamour採用却下理由と、生テキストfallbackの参照 |
| Claude Code（[#43113](https://github.com/anthropics/claude-code/issues/43113)・[#57075](https://github.com/anthropics/claude-code/issues/57075)、[renderer解析](https://github.com/DigitizingInc/claude-code-cli-analysis/blob/main/architecture/06-terminal-renderer.md)） | Ink word wrapが`\n`を挿入 | 専用`MarkdownTable`でレイアウト。pipeが揃わない報告がある | ANSI（自前SGR/OSC実装） | streamingはstablePrefix/unstableSuffixで再parseを抑制。**hard `\n`がscrollbackへ残りresizeで復元できない問題** | streaming分割の知見。ただし問題はalternate screen再描画のHenjiには該当しない |
| [mdcat](https://github.com/swsnr/mdcat) | 単語境界 | **セル内折り返し非対応**と制限に明記 | 豊富（画像・数式・構文強調） | 文書単位 | セル折り返しを省く実装の限界例 |
| [Gemini CLI #6499](https://github.com/google-gemini/gemini-cli/issues/6499) | — | 「terminalの表は完璧にならない」とし、truncation/ASCII artの限界を認める | — | — | 生/描画トグルのescape hatch要望 |
| [tui-md](https://github.com/VectorJet/tui-md) / [ratatui-markdown](https://docs.rs/crate/ratatui-markdown/latest) | CJK幅対応（`unicode-width`等） | Unicode罫線グリッド。幅超過時は自然幅のまま**横スクロール**（縦積みではない） | テーマ | streaming対応・resize再描画 | 横スクロールという別解。Henjiは横スクロールを持たないため参照は限定的 |
| [tui-markdown (joshka)](https://github.com/joshka/tui-markdown) | — | **表は未対応**（warning） | ratatui style | — | 表対応が難しいことの傍証 |

## 将来採用時に決める最小論点

1. 幅超過時の表フォールバックの閾値: 影響セル/行が何割でrecordsへ切り替えるか。全列の最小幅を何セルに
   するか（Codexは3セルで即records）。
2. 表の描画字形: `|`を維持するか、`│`/`─`の罫線へ替えるか。利用者は「tagは残して良い」としており、
   どちらも選択肢になる。
3. recordsモードの表示形式: `Header: value`の行、またはheaderを見出しにしたkey/valueブロック。
4. streaming中の再レイアウト: 毎frame全再描画の現行経路で、安定blockと成長中blockを分けて再parseを
   抑えるか。未閉じフェンス・未完成表の扱い。
5. パース失敗・未対応syntaxの扱い: 生テキストを保つ範囲と、部分成功時の優先順位。
6. ANSI styleの範囲: bold/italic/dim/色のどれを使い、最終frame注入の既存境界へinline spanをどう載せるか。
7. parserの選択（未決メモ、Increment 84では自前を採用）: 完全自前の限定parserか、`marked`等のJSライブラリを
   `deno compile`で同梱するか。同梱ライブラリはparse品質・対応syntaxが上がる一方、依存追加とbundleサイズ増、
   version追随が生じる。外部binary（`glow`等）の起動はstandalone・ANSI境界・毎frame速度の理由でproduction
   経路に採らない。通常利用で自前parserの限界が問題になった時点で再検討する。

## 比較から得た現在の判断材料

- 単語境界折り返しとCJK幅計算は複数実装で一致しており、`cellWidth`の再利用で足りる。
- 表の幅超過は、セル折り返しを維持するGlamour/zot方式と、狭ければ**recordsへ切替える**Codex/Retainer方式、
  極小で**生Markdownへ戻す**pi方式に分かれる。Glamour方式は極端に狭いと列が細片化するため、records
  フォールバックを併せ持つ実装がchat用途では実用的と判断できる。
- **手元の`_refs/zot`が最も近い**。`|`pipeを維持し、markerを色付けし、セル折り返しで全行のpipe位置を
  揃える（testで保証）。列最小3で、それ未満になると溢れを許容する。streaming中は未閉じフェンスをEOFで
  flushする行ベース実装で、Henjiの毎frame再描画・幅渡しにそのまま応用できる。
- **手元の`_refs/pi`**はASTベースで、自然幅＋最長単語の最小幅から重み配分で列幅を決め、極小なら生Markdownへ
  戻す。headingの`#`prefix維持、linkの`text (url)`併記、inline styleのrestore処理が参照になる。
- **opencode（OpenTUI）**はterminalをDOM/Yogaモデルで扱い、表を`tableOptions`で宣言的に制御する
  （`grid`/`columns`、`widthMode` content/full、`columnFitter`、`wrapMode` word/char/none、罫線種）。セルwrapで
  列を縮める点は私たちの当初案と一致し、`columns` presetは「append-only出力でfull幅の箱が重い」場合の別解。
  またstreamingではtop-level blockを保持してstable prefixを出し、**未完tableの最終行を描かずflickerを防ぐ**。
  これはHenjiの毎frame再描画にも応用できる。markerは既定でconcealしtoggle可能で、「tagを残す／隠す」は
  ユーザー設定にする余地がある。
- opencodeのweb側（session-ui）は`marked`＋`remend`（不完全Markdownの修復）＋workerでstreaming projectionを
  行い、`full`/`live`/`code`のblockへ分けてappend-only時に再利用する。行ベースのzotとは別のstreaming設計。
- ANSI style（bold/dim/色）は標準的で、Henjiではlabel色を最終frameで注入する既存境界へinline spanを
  一般化する形が整合する。
- Claude Codeのresize問題は、Henjiがalternate screenで毎frame幅を渡して再レイアウトし、canonical・
  exportは生Markdownを保つため、そのままは該当しない。resize対応は既存経路の延長で扱える。
- パース失敗時は生テキストを返す実装（Retainer・piのfallback）が安全で、Henjiの「機能を狭めない」方針とも
  整合する。

## 参照

- 手元checkout: `_refs/zot/packages/tui/markdown.go`・`markdown_test.go`、
  `_refs/pi/packages/tui/src/components/markdown.ts`・`src/utils.ts`（`wrapTextWithAnsi`）
- opencode / OpenTUI: https://opentui.com/docs/components/markdown 、
  https://opentui.com/docs/components/text-table 、https://opentui.com/docs/core-concepts/text-and-cells 、
  https://github.com/anomalyco/opencode （`packages/tui`、`packages/session-ui/src/components/markdown.tsx`・
  `markdown-stream.ts`・`markdown-projection.ts`・`markdown-worker.ts`）。手元`opencode 1.18.31`
  （`~/.local/lib/node_modules/opencode-ai`）。
- glow / Glamour: https://github.com/charmbracelet/glow 、https://github.com/charmbracelet/glamour
  （table wrapの経緯: https://github.com/charmbracelet/glamour/issues/344）
- Codex CLI: https://github.com/openai/codex/issues/15449 、https://github.com/openai/codex/issues/22410 、
  https://www.vincentschmalbach.com/codex-cli-responsive-terminal-tables
- Retainer `mdrender`: https://pkg.go.dev/github.com/seamus-brady/retainer/internal/tui/mdrender
- Claude Code: https://github.com/anthropics/claude-code/issues/43113 、
  https://github.com/anthropics/claude-code/issues/57075 、
  https://github.com/DigitizingInc/claude-code-cli-analysis/blob/main/architecture/06-terminal-renderer.md
- mdcat: https://github.com/swsnr/mdcat
- Gemini CLI: https://github.com/google-gemini/gemini-cli/issues/6499
- tui-md: https://github.com/VectorJet/tui-md
- ratatui-markdown: https://docs.rs/crate/ratatui-markdown/latest
- tui-markdown: https://github.com/joshka/tui-markdown
