# Increment 122 — 失敗行の赤字表示とSession種別ごとの`/recall`案内

状態: 完了（2026-09-24、利用者判断）。実装・検証・配置済み。通常利用メモS11を採用した。構想・architecture・roadmapの変更は不要と判断し、編集していない。

## 必要なproduct動作と根拠

- キャンセルを含む失敗turnでは、`failure>`行のラベル・失敗理由・案内までを含む行全体を赤文字で表示する。
- 保存Sessionでは、失敗理由に続けて英語で、`/recall`が停止した実行の指示と途中結果を次の指示から参照させられること、元の実行自体は再開しないことを案内する。
- `--no-session`では`/recall`が利用不可として拒否されるため、利用できない案内を出さず、失敗理由だけを行全体の赤字で表示する。
- 根拠: 通常利用メモS11の観測（2026-09-23、失敗表示に専用色がない）と利用者希望（キャンセルを含む失敗turnの案内と赤字表示）。利用者reviewで、全`failure>`行に案内を付ける実装は`--no-session`の実操作と矛盾すると指摘された。

## 現行経路と対象

- `failure_diagnostic`eventは`reduceUiEvent`で`kind: 'recoverable'`のlog entryになり、`logRows`が`projectConversationEntry`で行テキストとtoneを決める。`wrap`が行全体のtoneを折返し後の全行へ伝播し、`renderLayoutRow`が`RED_SGR`で行全体を描画する。
- `/recall`の可否は`TuiPresentationAdapter`の`recall_execution`が`coreNavigation.persistent === true`を要求して決める。これは`--no-session`（persistence `none`）でsession navigation hostが存在しないことと同じ条件であり、startup stateの`sessionMode.kind === 'none'`と一致する。
- 対象: `v0/tui/conversation_renderer.ts`、`v0/tui/layout.ts`、`v0/tui/terminal.ts`、`v0/tui/tui_renderer.ts`、`tests/v0/tui_conversation_presentation_test.ts`、`tests/v0/tui_retained_terminal_test.ts`。

## 変更内容

- `projectConversationEntry(entry, { recallAvailable })`へ変更した。失敗行はどちらのモードでも`rowTone: 'failure'`とし、`recallAvailable`がtrueのときだけ理由の後に` · <failureRecallGuidance>`を付ける。
- `logRows`は`state.startup?.state.sessionMode.kind !== 'none'`から`recallAvailable`を導出する。この式は`sessionMode.kind`が`'none'`以外のときに案内を付ける。production TUIは`v0/agent/cli/tui_cli.ts`で入力を受け付ける前に`renderCompactStartup`でstartup factsを設定するため、失敗行が存在する時点でstartup factsは常にあり、`--no-session`だけが`'none'`になる。
- `--no-session`の失敗行は`failure> cancelled`のように理由のみを表示する。`/recall`を前提にした案内文は同じpaneに現れない。
- 失敗行の英語案内は`/recall without an ID references the latest stopped execution's instructions and partial results from the next task; it does not resume the run`とした。`/recall`はIDを省略するとそのSessionの最新の停止実行を選ぶ（`prepareRecall`の`id === undefined`経路）ため、この行の実行だけを参照すると誤読されないよう、IDなしで参照される対象を明示する。Execution ID表示（通常利用メモS13）は実装していない。

## 受入確認

- focused testは、保存Session（`sessionMode.kind: 'new'`）と`--no-session`（`'none'`）の両方で、キャンセル（`turn_cancelled`）と解析失敗（`response_error`）の2理由を確認する。保存Sessionは案内付きの全行赤字、`--no-session`は理由のみの全行赤字で、案内文がframeに現れない。frameのheader（`new (autosave)`／`no session`）で対象モードも確認する。
- retained terminal testは、`--no-session`の`/recall`拒否（commandをeditorに保持）と同じ画面の失敗行が理由のみで全行赤字であること、保存Sessionの`/recall`成功（`next task only`）と同じ画面の失敗行が案内付きで全行赤字であることを確認する。
- current code、TUI conversation、retained terminal、controller overlay、tool preview、keymap readline、Increment 120の対象testが106件成功（0 failed）。`v0:check`、`deno fmt --check`、`deno lint`、`git diff --check`成功。full `v0:gate`は実行していない。
- 隔離XDGとtmuxのproduction TUI（`agent:tui`と`--no-session`）をlocalhost mock providerで起動し、headerが`new (autosave) · 679ea514`と`no session`であることを確認した。Escでキャンセルすると、保存Sessionは`failure> cancelled · /recall … it does not resume the run`、`--no-session`は`failure> cancelled`を全行赤字で表示した。mockの不正SSE（`delta.content: 42`）でも、保存Sessionは`failure> provider response invalid · /recall …`、`--no-session`は`failure> provider response invalid`となった。`/recall`は保存Sessionで`recall 2cd53f53 ready │ next task only`、`--no-session`で`recall unavailable with --no-session │ cmds: /recall`だった。案内文言の修正後に同じ構成で再確認し、保存Sessionは`failure> cancelled · /recall without an ID references the latest stopped execution's … it does not resume the run`と`failure> provider response invalid · /recall …`を全行赤字で表示し、`--no-session`は理由のみを全行赤字で表示して案内文をpaneに出さなかった。実provider callは行っていない。隔離root（dummy credential含む）は確認後に削除し、実configは変更していない。

## 採用しなかった候補

- 通常利用メモS13の失敗行Execution ID表示は今回実装せず、未採用候補として通常利用メモに残した。`/recall`が受け付けるExecution IDを表示する案であり、必要になった時点で採用を判断する。

## 配置

- commit `621b6892`（実装・test・文書）を`origin/main`へpushし、同じclean commitからDeno 2.9.7で`deno task henji:compile`を実行してbuild `178a8646…`（file SHA-256 `9554953c…`、embedded runtime `b8e1dda0…`）を作成し、`dist/henji`と`~/.local/bin/henji`へ原子的に配置した。配置先の`--version`がsource `621b6892…`・build `178a8646…`を示し、build成果物とfile SHA-256が一致することを確認した。
- 配置済みbinaryを隔離XDG・localhost mock providerのtmuxで起動し、保存Sessionのキャンセル／解析失敗行が新文言の案内付きで全行赤字、`--no-session`が理由のみで全行赤字（案内文はpaneに現れない）、`/recall`が保存Sessionで`recall <短縮ID> ready │ next task only`、`--no-session`で`recall unavailable with --no-session │ cmds: /recall`となることを確認した。releaseは行っていない。
