# Pi / OpenCode / Henji の画面表示実装比較

調査日: 2026-09-26

## 位置付け

Pi・OpenCode・Henjiの**画面表示の実装方式**（terminal出力、レイアウト、更新、履歴・スクロール、
検証）を比較する参照実装調査である。Henjiへの採用、architecture・roadmap変更、実装認可を
意味しない。Markdown本文の表現（折り返し・表・着色）は
[`terminal-markdown-rendering-comparison.md`](terminal-markdown-rendering-comparison.md)に譲る。
本調査は描画パイプラインと画面管理に限定する。

## 対象 snapshot

- Pi: `_refs/pi`、commit `08dc60bc52d89d6823a9738cc90b1916e5e446e5`（pinned upstream snapshot、
  `@earendil-works/pi-tui`／`pi-coding-agent` 0.85.1系）。実sourceを直接確認した。
- OpenCode: <https://github.com/anomalyco/opencode> `dev`、commit
  [`696f41bc8e7586657375d53390925fc54c25d34c`](https://github.com/anomalyco/opencode/commit/696f41bc8e7586657375d53390925fc54c25d34c)
  （2026-09-25時点。旧`sst/opencode`からの移管先が`anomalyco/opencode`であることをGitHub APIで確認）。
  TUIは`packages/tui`（`@opencode-ai/tui` 1.18.32）。描画engineは別repository
  <https://github.com/anomalyco/opentui> `main`、commit
  [`684d70ce1b442702a2f4cc05831539629387226c`](https://github.com/anomalyco/opentui/commit/684d70ce1b442702a2f4cc05831539629387226c)
  （`@opentui/core`）。raw取得した該当fileのみ確認した（後述の未確認事項を参照）。
- Henji: 本repository working tree `b42003a1b6b7bea1af7f216b43f77cd7a944665d`、`v0/tui/`。

## 比較表

| 観点 | Pi | OpenCode | Henji |
| --- | --- | --- | --- |
| 描画モデル | component tree → `render(width): string[]` の行列 | SolidJS → opentui renderable tree（cell buffer） | `UiState` reducer → 行projection → 全frame文字列 |
| 端末への出力 | 行単位差分（`previousLines`比較） | committed frameとのcell差分（Zig output層、double buffer） | **毎回`\x1b[2J\x1b[H`＋全面書き直し**（差分なし） |
| 画面mode | `TuiMainScreen`／`TuiAltScreen`を切替（state移行あり） | 既定`alternate-screen`、`main-screen`／`split-footer`も選択可 | 常時alternate screen |
| 履歴・スクロール | `ScrollView`（`follow:"end"`、`overscroll:"chain"`、scrollbar） | `ScrollBoxRenderable`（`stickyScroll`／`stickyStart="bottom"`、加速度、message jump） | 端末scrollback不使用。`pageHistoryWindow`による内部window（`followLatest`／`oldest`） |
| レイアウト | 自前flexbox（basis/grow/shrink/minSize） | flexbox（Yoga計測を前提にしたhookあり） | 縦方向のみの純粋な行projection（`layoutUi`） |
| 文字幅 | `Intl.Segmenter`のgrapheme単位`visibleWidth`（cache、ANSI strip） | `renderer.widthMethod`（unicode／wcwidth） | code point範囲表`cellWidth`（CJK・全角2、結合文字0） |
| style・色 | ANSI state追跡（改行をまたぐ）、テーマ | theme JSON多数（RGBA）、syntax highlight | 固定8色SGR定数＋span range |
| 更新の間隔 | `scheduleRender`／`MIN_RENDER_INTERVAL_MS = 16` | continuous fps既定30・immediate cap既定60 | presentation eventごとに`redraw()`（`CoalescingWriter`がqueue上のfull frameを最新に置換） |
| streaming中の表示 | 差分行のみ書き換え | reactive更新＋Markdownのstable prefix（前出調査） | 全frame再描画で行追従（Increment 132／S16） |
| resize | 幅変更はfull re-render、高さ変更はfull re-render（Termux例外） | renderable側で再計測 | `SIGWINCH`をcoalesceし`resize` actionで再layout |
| overlay | overlay stack（anchor／focus restore） | dialog／command palette／sidebar等 | overlay行をframe内に重ねる（startup help、picker、context panel） |
| IME・cursor | `CURSOR_MARKER`（`\x1b_pi:c\x07`）でhardware cursorを指定しIME候補位置を合わせる | kitty keyboard等 | frame末尾でcursor位置を指定 |
| mouse・画像 | mouse event（cell座標）／Kitty画像（差分行の拡張・delete） | mouse／画像／audio等 | なし |
| 検証 | xterm.js headlessの`VirtualTerminal`、regression test、render bench | bun test＋snapshot、Zig native test多数 | `renderFrame`／`layoutSnapshot`の決定的frame、fake `TerminalPort`、tmux実機確認 |

規模（目安）: Pi `packages/tui` TypeScript約36.7k行（src約18.1k）＋`modes/interactive`約10k行。
OpenCode `packages/tui/src` 185 file約1.06 MB（最大`routes/session/index.tsx`約90 KB）、engineは
opentuiのZig native（`renderer.zig`約162 KB、`buffer.zig`約139 KB、`renderer-output.zig`約36 KB）。
Henji `v0/tui` 23 file 7,978行。

## Pi（`_refs/pi`）

- 構造: `packages/tui/src/`にTUI本体。componentは`render(width): string[]`を実装する（`tui.ts:117`）。
  `layout.ts`／`layout-node.ts`と`components/`（`v-stack`／`h-stack`／`box`／`scroll-view`／`markdown`／
  `editor`等）がflexboxで組む。application側は`packages/coding-agent/src/modes/interactive/`で、
  `chat-viewport.ts:23-38`がtranscript用`ScrollView`（`follow:"end"`、`overscroll:"chain"`、
  `scrollbar:"auto"`）と入力dock用`VStack`（pending／status／editor／footer）を固定配置する。
- 差分描画: `tui-main-screen.ts:247-`の`doRender()`は、(1)全componentを`render(width)`で行化、
  (2)overlay合成、(3)`CURSOR_MARKER`からhardware cursor位置を抽出、(4)`previousLines`と行比較し
  変化範囲のみcursor移動で書き換える。初回・幅変更・高さ変更（Termux sessionは除外）・
  `clearOnShrink`時はfull render（synchronized output `\x1b[?2026h`、`\x1b[2J\x1b[H\x1b[3J`）。
  Kitty画像行は変化範囲を画像block単位へ拡張し、対象image idをdeleteする。
- 出力: `BoundedTerminalWriter`が1 MiB chunkで分割write。描画は`scheduleRender`と
  `requestImmediateRender`でまとめ、`MIN_RENDER_INTERVAL_MS = 16`（`tui.ts:477`）。
- terminal能力: OSC 11背景色query、terminal color scheme report、cell size query（`\x1b[16t`）、
  kitty keyboard、mouseをlayerで扱う。overlayはanchorとfocus restoreを持つstack。
- 幅: `utils.ts:240`の`visibleWidth`はgrapheme segmenterで幅を合計（cache、ANSI/OSC/APC strip）。
  `wrapTextWithAnsi`／`sliceByColumn`／`truncateToWidth`／`cjkBreakRegex`を持つ。
- 検証: `test/virtual-terminal.ts`はxterm.jsによる実emulator。CJK境界・regional indicator幅・
  shrink・overlay style leak等のregression test、`render-churn`／alt-screen transcriptのbenchがある。

## OpenCode（`anomalyco/opencode`＋`anomalyco/opentui`）

- 構造: `packages/tui`はSolidJSで画面を記述し、`@opentui/core`／`@opentui/solid`のrenderableへ
  reconcileする。起動は`app.tsx:194`の`createCliRenderer({ externalOutputMode:"passthrough",
  targetFps:60, useKittyKeyboard, useMouse, ... })`。
- session画面: `routes/session/index.tsx`（約90 KB）が`ScrollBoxRenderable`を`stickyScroll={true}`・
  `stickyStart="bottom"`で持ち、追従／手動scrollを切り替える。`util/scroll.ts`はmacOS scroll
  accelerationか固定速度を選択。message jumpはchild renderableの`y`座標から`scrollBy`する。
  `contentWidth`はsidebar（幅>120で42列）有無から派生する。promptは`component/prompt/index.tsx`
  （autocomplete／history／stash／move）。
- データ: server同期store（`context/sync`）から`createMemo`で派生viewを組み、renderableを更新する
  reactive方式。streaming更新もこの経路に乗る。
- 描画engine（opentui）: Zig nativeがcell buffer（`buffer.zig`）とframe loop（`renderer.zig`）を持ち、
  TSはFFIで駆動する。`renderer.ts`はscreen modeを`"alternate-screen"`（既定）／`"main-screen"`／
  `"split-footer"`から選び、continuous fps既定30・immediate cap既定60を宣言している。
  `renderer-output.zig`は`outputA`／`outputB`のdouble bufferと`lastCommittedBuffer`を持ち、
  committed frameとのcell diffで差分出力する（全面repaintはdiffを信用できない例外系）。
  backpressure時はdiff前のframe skipでwrite量を落とす。
- 描画物: `TextRenderable`／`BoxRenderable`／`ScrollBoxRenderable`／`CodeRenderable`（tree-sitter）／
  `DiffRenderable`／`FrameBufferRenderable`／image等。Markdown表現は前出調査の
  `MarkdownRenderable`（streaming中に未完blockを安定化）に譲る。

## Henji（`v0/tui`）

- 構造: 4層に分離している。`state.ts`（`UiState`と`reduceUiEvent`／`reduceUiAction`、1,024行）→
  `layout.ts`（`layoutUi`が`LayoutRow[]`へ投影、790行）→ `tui_renderer.ts`（frame組み立て、792行）→
  `terminal.ts`（`TerminalPort`／`DenoTerminal`／`CoalescingWriter`／`TerminalLifecycle`、501行）。
  layoutは純粋関数で、`layoutSnapshot`／`renderFrame`がI/Oなしでframeを返す。
- 描画: `redraw()`（`tui_renderer.ts:763-776`）は`renderFrame()`の全frameに`\x1b[2J\x1b[H`を付け、
  cursor位置のCSIで終える。行・cell差分は持たない。`renderFrame`はlayout行へSGR range（label・
  span・blink）を適用して連結し、`MAX_FRAME_BYTES`（128 KiB）を超えたらtruncate、logは後方から
  詰め、入力・footerの固定部分を優先する。
- 画面・履歴: acquire時に`ENTER_ALTERNATE_SCREEN`（`usesAlternateScreen: true`）。terminal
  scrollbackは使わず、履歴は`UiState.scroll`（`followLatest`／`oldest`）と`pageHistoryWindow`の
  内部window。PageUp／PageDownは`controller.ts:625-629`、履歴位置表示はfooter（Increment 130）。
- 出力: `CoalescingWriter`が非同期の逐次writeを保証し、queue上のfull frame同士は最新に置換する
  （slow consumerでも表示が最新frameに追いつく。B1の同期write問題への対応）。
- 幅・escape: `cellWidth`（code point範囲表）と、唯一のdynamic text escape境界
  `escapeTerminalText`（control・bidiを`\u{...}`、tab→`⇥`）。`truncateText`はbyte上限。
- style: 固定8色SGR定数。assistant本文は`markdownAssistantRenderer`がheading／list／table／quote／
  bold／emphasisのspan toneを出し、`renderLayoutRow`が着色する。
- 制約: `MIN_COLUMNS` 80／`MIN_ROWS` 24、`MAX_COLUMNS` 512／`MAX_ROWS` 200、`MAX_EDITOR_ROWS` 8、
  超過時は`degraded`。
- streaming: presentation event（`user_message`／`assistant_message`／`assistant_progress`／
  `assistant_thinking`等）ごとに`redraw()`。Increment 132（S16）で本文・thinkingの行追従を成立
  させたが、描画方式は全frame書き直しのままであり、thinking途中表示と描画方式の見直しは範囲外と
  した。busy spinnerはintervalで更新。
- 検証: 決定的frameとfake `TerminalPort`による`tests/v0/tui_*`。Surface変更はtmux上の実production
  TUI確認を完了条件にしている（AGENTS.md）。

## Henji視点の差分（観測。採用判断は未実施）

1. **更新方式**: Piは行差分、OpenCodeはcell差分、Henjiは全面書き直し。Henjiは構造が単純でframeの
   決定的検証が容易な一方、更新のたびに`\x1b[2J`で消して全量を書き直す。実terminalでのflicker・
   書き込み量は今回の調査では実測していない。
2. **履歴の所有者**: Henjiはalternate screen内の内部windowで履歴を持ち、端末scrollbackに依存しない。
   Piの`TuiMainScreen`は端末のscrollbackへ残す方向で、思想が逆。OpenCodeはalt screen内の
   `ScrollBoxRenderable`で、履歴所有者がUI toolkit側にある。
3. **文字幅**: Henjiのcode point範囲表はgrapheme cluster（ZWJ絵文字・regional indicator）と
   ambiguous widthを扱わない。実測でも`cellWidth`は`👨‍👩‍👧`を8 cell、`👋🏽`を4 cellと数え、実terminalの
   表示（概ね2 cell）とずれる。Piは`Intl.Segmenter`＋regression test、OpenCodeはwidthMethod切替で
   対応する。CJK自体はHenjiも幅2で扱う。
4. **更新の間隔**: Piは16 ms coalesce、OpenCodeはfps cap（30／60）。Henjiはeventごとの全frameで、
   間隔制御は`CoalescingWriter`の置換のみ。S16の行追従は達成済み。
5. **色**: Henjiは固定8色SGRで、テーマ・256 color・truecolorを持たない。PiはANSI stateを跨行で
   追跡、OpenCodeはtheme asset（RGBA）。
6. **検証**: Piはxterm.js実emulator、OpenCodeはtoolkitのnative test、Henjiは決定的frame＋tmux実機。
   いずれも「frame文字列の決定性」を軸にしており、実terminalの描画結果の扱いが異なる。

## 未確認事項

- opentui `renderer-output.zig`のcell diffは断片（double buffer・committed frame・backpressure時の
  frame skip）しか確認していない。damage範囲の決定条件は未読。
- OpenCode／Piの実機挙動（flicker、streaming中の再描画量、scroll体感）は今回の調査では観測していない。
- Piの`TuiMainScreen`／`TuiAltScreen`の選択条件（`interactive-mode.ts`内の切替）は未確認。
- Henjiの全面書き直しが実terminalでflickerするか、書き込み量が問題になるかは未実測。

## 描画・保持負荷の実測（2026-09-26、Henjiのみ）

「alt screen＋内部window方針の負荷」を確認するため、現行実装を直接実行して測定した
（`state.ts`／`layout.ts`／`assistant_layout.ts`をDenoで呼び、1 redraw相当の`layoutUi`を計測）。

- 保持: `UiState.log.entries`は会話全entryをimmutableで保持する。表示windowは`HISTORY_WINDOW_ENTRIES` 48／
  `HISTORY_WINDOW_BYTES` 1 MiB（`state.ts`）で、layout対象はこのwindowのみ。frameは可視画面分だけ組み立てられ、
  `MAX_FRAME_BYTES` 128 KiBは上限であって発生量ではない（実測frameは画面行数に比例）。
- 計算量: `layoutUi`はwindow全体（最大48 entry・1 MiB）を毎回wrap・markdown span生成し直し、
  可視行だけを後からslicingする（`allLog`→`log`）。1 redrawのコストはwindowの文字量に比例する。
- 実測（120列×40行、window 48 entry）:

| 内容 | window sourceBytes | 1 redraw（`layoutUi`） |
| --- | --- | --- |
| entry約600 B・ASCII・plainText renderer | 約30 KB | 0.7 ms |
| entry約600 B・ASCII・markdown renderer | 約30 KB | 2.0 ms |
| entry約600 B・CJK・markdown renderer | 約100 KB | 2.4 ms |
| entry約20 KB・markdown・計961 KB | 961 KB（上限近く） | 約77 ms |

- 描画回数: streaming中のlive更新は`LIVE_UPDATE_MIN_INTERVAL_MS = 100`／`LIVE_UPDATE_MAX_INTERVAL_MS = 500`
  （`v0/agent/core/loop.ts`）で間引き済みで、最大約10 redraw/s。よって典型（2〜2.4 ms/回）では負荷は小さいが、
  window上限いっぱいの長大entryが続く場合は1 redrawが数十msになり得る。
- 巨大表示領域（2026-09-26追加実測）: windowはentry数・文字量で決まり画面行数を保証しない。
  512×200ではwindow30 entry・63 KBで生成行120行に対し必要196行（空行paddingで上部が空白）。
  `MAX_ROWS` 200／`MAX_COLUMNS` 512のclamp外は使われず、512×200＋CJK本文（window 1 MiB）では
  frameが147 KBと`MAX_FRAME_BYTES` 128 KiB（SGR未計上）を超過し、`renderFrame`が古いlog行からtruncateする。
  詳細はinbox S20。
- 比較: Piも毎frameに全componentを`render(width)`で行化するため、window／document全体の再計算は
  本質的に同等。差があるのは行差分出力とrender合流（16 ms）で、ここはS17の対象。



## 採用を見送るもの（2026-09-26）

以下は本比較で「取り入れないほうがよい」と判断したもの。通常利用メモ
[`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)の「画面表示の参照実装調査で
見送ったもの」に同じ内容を記録済み。記録のみで採用・実装を意味しない。

1. Piのmain screen履歴（terminal scrollbackへ残す方式）: Henjiのalt screen＋内部window方針と
   Increment 128／130の履歴操作が衝突し、document全体の再計算はPiも行うため描画コストも本質不変。
2. message jump（Pi／OpenCode）: 利用者判断でP2として除外済み（PageUpの方が手軽）。
3. テーマ／256 color／truecolor: 色に関する観測された不満がなく、Surface変更が大きい。
4. Piの`CURSOR_MARKER`（IME候補位置合わせ）: Henjiはframe末尾のcursor位置指定で入力位置を示しており
   目的を満たす。
5. xterm.js仮想terminalのtest基盤: 単独では採らない。S17採用時にframe実挙動検証が必要になる場合のみ。

## 採用候補の記録先

本比較からHenjiへの採用候補として採用できるものは通常利用メモ
[`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)のS17（描画更新の合流と行差分描画）、
S18（文字幅のgrapheme cluster対応）、S19（synchronized output）、S20（巨大表示領域でのwindow行量確保と
frame上限）へ記録した。いずれも未採用であり、
採用時は個別incrementで計測根拠と変更範囲を決める。

## 参照

- [`terminal-markdown-rendering-comparison.md`](terminal-markdown-rendering-comparison.md)
  （Markdown表現の比較。OpenTUI `MarkdownRenderable`を含む）
- Pi: `_refs/pi/packages/tui/src/{tui.ts,tui-main-screen.ts,tui-alt-screen.ts,utils.ts,terminal.ts}`、
  `packages/coding-agent/src/modes/interactive/{chat-viewport.ts,interactive-mode.ts}`
- OpenCode: <https://github.com/anomalyco/opencode/tree/dev/packages/tui/src>
  （`app.tsx`、`routes/session/index.tsx`、`util/scroll.ts`、`util/layout.ts`、`util/transcript.ts`）
- OpenTUI: <https://github.com/anomalyco/opentui>
  （`packages/core/src/renderer.ts`、`packages/native/src/{renderer.zig,buffer.zig,renderer-output.zig}`）
- Henji: `v0/tui/{state.ts,layout.ts,tui_renderer.ts,terminal.ts,terminal_text.ts,assistant_layout.ts}`、
  `docs/increments/increment-132.md`（S16逐次表示の現行経路）
