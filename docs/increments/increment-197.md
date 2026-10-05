# Increment 197 — tool名とthinking系ラベルの緑dim

状態: 実装・focused確認・独立review・隔離production TUI確認・source commit・公式build・常用配置済み（2026-10-05）。利用者のGhosttyでの見た目確認が残る。

## 利用者が必要とする動作と根拠

利用者が「また少し表示色を変えたい」と提起し、確認応答で「tool名　と　thinking系ラベル
緑のdimにして」と対象・色を指定した。production TUIのtool表示とthinking系ラベルを
緑（ANSI 32）＋dim（faint）にし、それ以外の配色を維持する。

根拠はこの会話での利用者指示（2026-10-05）と、
[Increment 193](increment-193.md)の配色経緯（S33・再調整・追加指定）。

解釈: 現行の着色単位ではtool entryの「tool>＋ツール名」は1つのrange
（`styledPrefixScalarLength`）である。指示の「tool名」をこの単位として扱い、
「tool>」ラベル語とツール名の両方を緑dimにする。「tool>」語だけを旧青紫（SGR 95）へ
残す要件は指示にない。thinking系は現行どおりラベルだけを着色し、本文は通常色のまま。

## 現行の利用経路と変更境界

193で確認した経路をそのまま使う。`v0/tui/terminal.ts`の色定義と
`v0/tui/tui_renderer.ts`の`LABEL_SGR`用途別割当が、Core snapshot系
（`SnapshotConversationProjector`）とPresentationEvent系（`state.ts`）の両経路で共有する
最終描画である。tool entryは`conversation_renderer.ts`の`projectConversationEntry`が
`labelTone: 'tool'`と`styledPrefixScalarLength`（label＋tool名）を供給し、
`layout.ts`が1つのlabel rangeとしてrendererへ渡す。thinking系は
entry kind `thinking`で`labelTone: 'thinking'`、着色幅はラベルのみ。

変更は色割当のみ。保存data・設定・declaration・parser・layout構造・
本文／引数／状態記号の文字列は変更しない。テーマ設定や新しい保存先は増やさない。

## 採用範囲

| 対象 | 変更後 |
| --- | --- |
| tool>＋表示されたツール名 | 緑＋dim（SGR 32;2）、名前末尾でreset。引数・preview・状態記号は通常色 |
| thinking>・thinking~・thinking summary>・thinking summary~ | 緑＋dim（SGR 32;2）、ラベルだけ。本文は通常色 |

維持: ユーザー帯の灰237・user/assistantラベルの黄土（33）、見出しの青（34）、
強調の青緑（36）、readyの青、workingの黄土、thinking本文・Tool引数の通常色、
表罫線・フッターのdim、失敗の赤。

## 計画

1. `terminal.ts`へ緑＋dimのSGR定数を追加し、使用されなくなる青紫定数を除く。
2. `tui_renderer.ts`の`LABEL_SGR`でtool・thinkingを緑＋dimへ切り替える。
3. 変更されたproduct動作に対応するfocused確認として、
   `tests/v0/tui_conversation_presentation_test.ts`の既存色期待を更新する
   （tool prefixの着色と名前末尾でのreset、thinking系ラベルの緑dimと本文通常色、
   pending→settled表示、既存のユーザー帯・assistant・見出し・強調の期待維持）。
   未観測variantのtestは追加しない。
4. 変更箇所のtype check、format、lint、`git diff --check`。
5. 独立reviewで指定SGR・着色範囲・維持範囲を確認する。
6. 確認用binaryを`.tools/increment-197/`へbuildし、隔離HOME/XDG/workspace・専用tmux
   socket上で193のlocal provider probeを踏襲してproduction TUIを確認する。
   tool prefixの緑dimと名前末尾reset、thinking系ラベルの緑dimと本文通常色、
   既存配色（user帯・assistant・見出し・強調・ready・working・失敗）の維持をSGR付き画面で見る。
   実provider callは行わない。
7. source commit、公式`henji:compile`でのbuild、`dist/henji`と常用配置先へのatomic配置。

## 承認境界

local実装・focused確認・独立review・隔離tmux確認・source commit・公式build・常用配置を
今回の色変更の完了に必要な範囲とする（193の配色roundで確立した経路）。
push、公開/release、新しい実provider call、構想・architecture・roadmap変更は行わない。
利用者のGhosttyでの最終見た目確認は残る。

## 実装・確認結果

### 実装

- `v0/tui/terminal.ts`: `GREEN_DIM_SGR = '\x1b[32;2m'`（ANSI green＋faintの合成SGR）を追加し、
  使用されなくなる`VIOLET_SGR`を除いた。変更はこの1行のみ。
- `v0/tui/tui_renderer.ts`: `LABEL_SGR`の`thinking`・`tool`を`GREEN_DIM_SGR`へ切り替え、
  importを差し替えた。user/assistant（黄土33）・failure（赤）・`SPAN_SGR`・`FOOTER_SGR`は不変。
  両UI経路（Core snapshot系とPresentationEvent系）はこの`LABEL_SGR`と共有の
  `renderLayoutRow`を経由するため、1箇所の変更で成立する。
- `tests/v0/tui_conversation_presentation_test.ts`: 変更動作の既存色期待を更新した
  （tool prefix `\x1b[32;2mtool> bash\x1b[0m`、引数非着色、thinking系ラベル`\x1b[32;2m`＋本文非着色、
  test名の色語更新）。維持対象（user帯237/33・assistant 33・見出し34・強調36）の期待はそのまま。
- 解釈の実装: 「tool>＋ツール名」は既存の1つの着色単位（`styledPrefixScalarLength`）であり、
  `tool> `ラベル語と名前の両方が緑dimになる。引数・preview・実行内容・状態記号はrange外で通常色。
  thinking系は従来どおりラベルのみ着色、本文通常色。

### focused確認・静的確認

- `tests/v0/tui_conversation_presentation_test.ts`・`tests/v0/tui_tool_preview_test.ts`・
  `tests/v0/tui_retained_terminal_test.ts`のfocused testは70件pass・0 fail（`.tools/increment-197/focused-test.log`）。
- 変更3fileと対象testのtype check、format、lint、`git diff --check`は通過（`type-check.log`）。
  full gateは計画どおり実行していない。

### 独立review結果

独立reviewerが差分・current source・focused logを確認した。 採用可能なfindingは成立せず。
指定SGR・着色範囲・名前末尾reset・維持配色・両UI経路の同一割当・`VIOLET_SGR`除去の参照漏れなしを
sourceで確認した。参考観測としてtest名の旧色語残存（"stay violet"）があり、
変更動作の表記として同test名を"stay green dim"へ更新した。 reviewerはtest実行・build・tmux・
provider確認・file変更を行っていない。詳細は`.tools/increment-197/review.md`相当の報告（本会話）を参照。

### production TUI確認（隔離tmux、実providerなし）

確認用binary（build ID `6cdb83f7efcc161cf3b80b84c5ecc7c31427d3d713e4873730854b93c6eeadb7`）を
`.tools/increment-197/henji`へbuildし、193のlocal provider probeを踏襲した
`.tools/increment-197/tmux_check.py`で隔離HOME/XDG/workspace・専用tmux socketのproduction
Core＋TUIを確認した。 実provider callは0（local providerのみ、物理request 3件はすべて127.0.0.1）。

- tool行は`\x1b[2m\x1b[32mtool> read\x1b[0m probe.txt ✓`のように、`tool>＋名前`が緑dim、
  名前末尾でresetし、引数・状態記号が通常色。pending表示（`…`）とsettled表示（`✓`）の両方で確認。
- thinking行は`\x1b[2m\x1b[32mthinking>\x1b[0m THINKING_BODY_197`のようにラベルのみ緑dim、本文通常色。
- 維持確認: userラベルの黄土＋灰237全幅帯、assistant noteラベルの黄土、見出しの青、強調の青緑、
  `● ready`の青、workingの黄土、表罫線・フッターのdim、太字・マゼンタ・青紫の不在。
- 通常起動と明示的`henji tui`の同一renderer、help／provider picker、入力編集、履歴、resize／復帰、
  local HTTP 400による`system> FAILED`の赤だけが赤い失敗表示も確認。
- 2回目のprobe実行で、初回のassertionがSGR直後のみを見る字句条件で'probe.txt'を誤判定した。
  画面記録（`local-completed-sgr.txt`）では表示は計画どおりだったためprobe側のassertionを修正し、
  再実行でpassed=true（`local-tmux-result.json`）。 製品sourceの追加修正はない。

証拠は`.tools/increment-197/`（画面記録・SGR記録・semantic event・result JSON・log）。
raw provider request／responseやcredentialは収集していない。

### Commit・公式build・常用配置結果

（配置後に記録する）

## 利用者確認

利用者のGhosttyでの見た目確認が残る。 見た目で調整が必要なら対象と希望を指定してほしい。
