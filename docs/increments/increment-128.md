# Increment 128 — ターン実行中のPageUp／PageDown履歴参照

状態:
実装・focused検証・tmux実経路確認・commit済み（2026-09-25）。構想・architecture・roadmapは
変更していない。`~/.local/bin/henji`への配置とpushは利用者の明示承認待ち。

## 必要なproduct動作と根拠

- ターン実行中（busy）でもPageUp／PageDownで会話履歴を参照・移動できる。PageUpで過去へ、PageDownで
  先へ進み、末尾で最新追尾（followLatest）へ戻る。
- 実行中のstreaming出力（thinking・tool・assistant）はスクロール位置を壊さず、履歴を見ている間の新着は
  `new below`で示す。
- busyの既存操作契約は変更しない:
  Escape＝cancel、Ctrl-C二回＝discardしてexit、Enter＝steering、
  Alt-Enter＝follow-up queue。
- footerの履歴hintはbusyでは`PgDn latest`とし`Esc cancel`と併記する。busyのEscapeはcancelなので
  `Esc latest`とは表示しない。idleは`Esc latest`のまま。
- 根拠:
  利用者依頼（2026-09-25）「henjiはターン実行中は、ページアップで過去履歴を参照できない。
  実行中でもページアップ／ページダウンを可能にすることはできるか」。実行中に参照できなかったのは
  TUI
  controllerのgateのみで、表示側の履歴窓機構は実行中のstreamingと共存できる。

## 現行経路と対象

- `v0/tui/input_decoder.ts`が`\x1b[5~`／`\x1b[6~`を`page_up`／`page_down`
  InputEventへdecodeする。
- `v0/tui/controller.ts`
  `processModernEvents`が`!busy`のときだけ`renderer.scrollPage`を呼んでいた
  （detached three-band
  TUI実装`d2cba6b2`からの条件）。これが実行中の履歴参照を遮っていた。 production
  entry（`henji_cli.ts`→`tui_cli.ts`）は`pending`を渡すmodern経路で、busy入力は
  `processBusy`→`processModernEvents`を通る。
- `v0/tui/tui_renderer.ts` `scrollPage`→`v0/tui/state.ts`
  `pageHistoryWindow`／anchored scroll→
  `v0/tui/layout.ts`の描画窓計算はbusyに依存しない。entry追加時も`scroll !== 'followLatest'`の間は
  `historyWindow`を固定し、`reduceUiEvent`が`newBelowCount`を加算する。実行中のstreamingと共存できる。
- footer
  hintは`footerStatusText`（`v0/tui/layout.ts`）が`Esc latest`を固定文言で出していた。

## 実装

- `v0/tui/controller.ts`: `page_up`／`page_down`の`!busy`
  gateを外し、busy中も`renderer.scrollPage`を 呼ぶ。cooperative
  cancellation後の入力freezeはeditor・queueのmutationを止め、view-onlyの
  PageUp／PageDownは通す。busyのEscape＝cancel等の他操作は変更しない。
- `v0/tui/layout.ts`: busy
  lifecycleの履歴hintを`PgDn latest`にし`Esc cancel`と併記。idleは不変。
- `tests/v0/tui_retained_terminal_test.ts`: 3 test追加。
  - `busy PageUp pages the retained history while the turn keeps streaming` —
    busy中PageUpで過去履歴が 出ること、streaming
    event追加中もanchor行が動かないこと（`new below`加算）、PageDownでlatestへ
    戻ること。
  - `busy Escape still cancels the turn while the history is anchored` —
    anchoredのままEscapeでcancel
    でき`cancelled; recoverable input available; press Up to resend`になること。
  - `busy history footer hints PgDn to latest while Esc stays cancel` —
    busy＋履歴表示で`PgDn latest`と
    `Esc cancel`があり`Esc latest`がないこと、idleは`Esc latest`のままであること。

## 意味上の判断

- busyのEscapeはcancelのまま変更していない（既存契約「Escape
  cancels」を維持）。履歴から最新へ戻すのは
  PageDown（末尾でfollowLatest）またはターン完了後のEscape。footer
  hintをこの挙動に合わせた。
- cooperative
  cancellation後のfreeze中もPageUp／PageDownを通す。freezeの対象はeditor・queueの
  mutationであり、view-only操作は含めない。

## 受入確認

- focused test: `tui_retained_terminal_test.ts`
  50件成功（追加3件含む）。関連focused test
  （`tui_conversation_presentation_test`／`tui_controller_overlay`／`tui_tool_preview`／
  `keymap_readline`）48件、`current_code_test`
  17件成功。`v0:check`、変更fileの`deno fmt --check`・
  `deno lint`、`git diff --check`成功。full `v0:gate`は実行していない。
- 隔離XDG `/tmp/henji-increment128-tui/xdg`・tmuxのsource production
  TUI（`agent:tui`、100×24）を localhost模擬Chat
  provider（`http://127.0.0.1:8931/v1`、provider declaration
  `mockchat`）で確認。 実provider
  callなし。模擬providerへのrequestは疎通確認1件＋henjiから8件（`mock.log`）。
  - busy中PageUpで`[history rows 1-18/37 │ PgDn latest │ ⠧ working 00:04 │ … │ Esc cancel]`となり、
    startup headerとturn 1の会話が見える（`capture-1-busy-pageup.txt`、
    `capture-2-busy-anchored-a.txt`／`-b.txt`）。
  - streamingが続く間anchorは`history rows 1-18`のまま、totalは33→37→41→45と増えた
    （`capture-2-busy-anchored-b.txt`ほか）。追加9
    eventは`new below 9`として表示され、settle後は
    hintが`Esc latest`へ戻る（`capture-2-busy-anchored-stable.txt`）。
  - busy中PageDownで最新追尾へ戻り、streaming中の`assistant~ tok0 …`が`[⠋ working 00:02 │ … │ Esc cancel]`
    とともに表示された（`capture-3-pagedown-a-anchored.txt`／`capture-3-pagedown-b-latest.txt`）。
  - anchoredのままEscapeでcancelし`cancelled; recoverable input available; press Up to resend`となり、
    履歴表示（`history rows 1-18/39`）は保たれた（`capture-4-escape-a-anchored.txt`／
    `capture-4-escape-b-cancelling.txt`／`capture-4-escape-c-settled.txt`）。
  - 証拠は`/tmp/henji-increment128-tui/`。実configは変更していない。
- TUI Surface変更のためtmux実経路確認済み。実provider callは行っていない。
- 外部reviewer（`local/reviewer@sha256:b510daaa…`）が差分をreviewし、採用findingなし。legacy経路・
  狭い幅のfallback
  hint・freeze除外の直接testなし、は根拠不足で不採用と判断された。

## 正本更新

- 利用者の明示承認（2026-09-25「配置・push・roadmap 更新」）により、roadmap
  F01のTUI
  Surface説明へ「実行中もPageUp／PageDownで会話履歴を参照でき、履歴表示中のfooterは
  `PgDn latest`／`Esc cancel`を示す（Increment
  128）」を追記した。構想・architectureは変更していない。

## 次

- 承認済みのclean
  commitからのbuildと`~/.local/bin/henji`への原子的配置、pushを実施し、結果をこの文書へ追記する。
