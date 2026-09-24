# Increment 125 — 失敗行のExecution ID表示

状態: 完了（2026-09-24、利用者判断）。実装・検証・配置済み。通常利用メモS13を採用した。構想・architecture・
roadmapの変更は不要と判断し、編集していない。

## 必要なproduct動作と根拠

- 保存Sessionの`failure>`行に、短縮Execution ID（先頭8文字、例: `execution 2300b666`）を表示する。
- 同じ行の案内に`/recall 2300b666`を含め、表示したIDで`/recall`できることを示す。表示するのは診断IDではなく、
  `/recall`が受け付けるExecution ID（またはその前方一致prefix）である。
- `--no-session`では`/recall`が拒否されるため、Increment 122の方針どおりIDも案内も出さず失敗理由のみを表示する。
- `/recall`で選択できる停止実行がsettleされなかった経路では、artifactのIDが得られても従来どおりIDなしの案内
  （`/recall without an ID references the latest stopped execution's …`）を表示する。参照不能なIDを案内しない。
- 根拠: 通常利用メモS13の観測（2026-09-24、session `a2098f7c`）。`/recall`はID省略で直近の停止実行、ID指定で
  同じSessionの過去の停止実行を選べるが、TUIの`failure>`行にそのIDが表示されず、`henji history --view session`
  等で調べる必要があった。再検討契機（直近以外の停止実行をTUIから指定して参照したい）が2026-09-24の利用者
  依頼で発火し、採用を承認した。Increment 122（S11）の実装には加えず、別incrementとして実装する。

## 現行経路と対象

- turn停止時、Host `ExecutionCoordinator.settleExecution`／`persistExecutionArtifact`が実行をnon-canonicalに
  settleし、`turnEndFromOutcome`が`turn_end` AgentEventを発行する。`executionArtifactId`はartifactの識別子で、
  正常にsettleできた場合は`/recall`の`prepareRecall`が照合するIDと一致する。
- `TuiPresentationAdapter`の`turn_end`処理が`failure_diagnostic` Presentation eventを発行する際にこのIDを
  落としており、`reduceUiEvent`（`v0/tui/state.ts`）の`failure>`行、`logRows`→`projectConversationEntry`
  （`v0/tui/conversation_renderer.ts`）の案内文にも届いていなかった。
- fallback経路（`TuiController.finishTurn`／`finishModernTurn`の`renderFailureDiagnostic`）は
  `PresentationOutcome`経由で同じ行を出すが、`LoopOutcome.executionArtifactId`はprojectionで落ちていた。
- `/recall`側は`recallExecutionIdOf`（8〜36文字のUUID形式/prefix）と`prepareRecall`の
  `row.executionId.startsWith(id)`が既にprefixを受理するため、表示は`slice(0, 8)`（controllerの
  `pendingRecallShortId`と同じ規約）で既存受付条件と一致する。

## 実装

- `v0/presentation/contract_types.ts`: `failure_diagnostic` Presentation eventと`PresentationOutcome`へ
  optional `executionId`を追加。
- `v0/presentation/adapter_projection.ts`: `outcome()`がHostの`recallableExecutionId`を`executionId`へ
  投影する。
- `v0/presentation/tui_presentation_adapter.ts`: `turn_end`→`failure_diagnostic`発行で
  `event.recallableExecutionId`を`executionId`として渡す。
- `v0/tui/tui_renderer.ts`: `renderFailureDiagnostic`へ`executionId`引数を追加。
- `v0/tui/controller.ts`: `finishTurn`／`finishModernTurn`が`outcome.executionId`を渡す（event bridgeと
  fallbackの二重発行はentry id（diagnostic ID）でdedupされる）。
- `v0/tui/state.ts`: `UiLogEntry`へ`executionId`を追加し、`failure_diagnostic`の生成時と重複更新時に保持する
  （IDなしの後続eventで既存IDを失わない）。
- `v0/tui/conversation_renderer.ts`: IDあり案内`failureRecallGuidanceFor(shortId)`を追加し、
  `projectConversationEntry`がIDありの失敗行へ`execution <8> · /recall <8> references this stopped execution's
  instructions and partial results from the next task; it does not resume the run`を付ける。IDなしは従来の
  `failureRecallGuidance`のまま。
- 表示例（利用者承認済みの形式）:
  `failure> cancelled · execution 2300b666 · /recall 2300b666 references this stopped execution's instructions and partial results from the next task; it does not resume the run`

### P2修正 — artifact IDと`/recall`可能IDの区別

- 2026-09-24の確認で、SQLiteのnon-canonical settleに失敗した後にartifactだけ保存できた場合も、
  `executionArtifactId`がTUIへ渡り、`/recall`で選べないIDを失敗行が案内することが分かった。artifact保存自体の
  失敗時にもHostは同IDを返していた。`/recall`はsettled non-canonical行、またはhistoryを使わない実行の
  保存済みartifactを選択するため、artifact ID・artifact durabilityだけでは選択可能性を判断できない。
- Hostの`LoopOutcome`と`turn_end`に`recallableExecutionId`を追加した。SQLiteのnon-canonical settle成功時、
  またはhistoryを使わない実行のartifact保存成功時だけ設定する。元の`executionArtifactId`と
  `executionArtifactDurability`はartifactの事実として維持する。Presentationのevent／outcomeは
  `recallableExecutionId`だけを表示IDへ投影する。

## 受入確認

- focused test（`tui_conversation_presentation_test.ts`／`tui_retained_terminal_test.ts`）70件成功:
  - 「persisted-session failure rows show the stopped execution ID and its /recall hint」— キャンセル
    （`turn_cancelled`）と解析失敗（`response_error`）の2理由でID付き案内を確認し、表示IDが
    `recallExecutionIdOf`の受付と一致することを検査。
  - 「--no-session failure rows keep the reason without the execution ID or /recall hint」— 理由のみ・
    行全体赤字で、`execution`／`/recall`がframeに現れない。
  - 「a repeated failure diagnostic keeps the execution ID from the first event」— IDなしの重複eventでも
    IDを保持。
  - 「core events and outcomes carry the execution ID into failure presentation」— adapterの
    `turn_end`→`failure_diagnostic`と`submit` outcomeの両経路でIDが届く。
  - 「failure row shows the execution ID that /recall accepts for a stopped run」— 表示ID
    （`2300b666`）で`/recall`が成功し`recall 2300b666 ready │ next task only`となる。
  - 既存のIncrement 122 test（IDなしなら従来案内・`--no-session`理由のみ・行全体赤字）は不変で成功。
- 関連focused test（`current_code`／`tui_controller_overlay`／`tui_tool_preview`／`keymap_readline`）41件成功。
  `v0:check`、`deno fmt --check`（新規変更3fileを`deno fmt`で整形）、`deno lint`、`git diff --check`成功。
  full `v0:gate`は実行していない。
- 隔離XDG・tmuxのproduction TUI（source `agent:tui`）をlocalhost模擬Chat providerで確認（実provider callなし）。
  模擬providerは1回目をhangさせEscでキャンセル、2回目以降は不正SSE（`delta.content: 42`）を返した。
  - 保存Session（`new (autosave) · d40bdd15`）で
    `failure> cancelled · execution b1da14c3 · /recall b1da14c3 references this stopped execution's … it does not resume the run`
    と`failure> provider response invalid · execution 05ca7055 · /recall 05ca7055 …`を表示（いずれも行全体赤字）。
  - `/recall b1da14c3`で直近でない過去の停止実行を選べて`recall b1da14c3 ready │ next task only`となった。
  - `/recall`（ID省略）は`recall 05ca7055 ready`となり、直近の停止実行（2件目の失敗行）の表示IDと一致した。
    表示IDが実際のExecution IDであることを照合できる。
  - `--no-session`はheaderが`no session`で、`failure> provider response invalid`のみ（ID・案内なし、行全体赤字）。
  - 証拠は`/tmp/henji-increment125-tui/`（capture-pane 4件とmock server log）。隔離root（dummy credential
    含む）は確認後に削除し、実configは変更していない。

### P2修正の検証

- `agent_worker_foundation_test.ts`でSQLiteのnon-canonical settle直前にロールバックを注入した。
  artifact記録は成功（`executionArtifactDurability: yes`）しても、行は`active`のままで`/recall`は
  `unavailable`となり、Host outcomeの`recallableExecutionId`は付かないことを確認した。
- `tui_conversation_presentation_test.ts`で、artifact IDと`executionArtifactDurability: yes`があっても
  `recallableExecutionId`がなければ、event bridgeとoutcome fallbackの双方が表示IDを付けず、保存Sessionの
  失敗行は従来のIDなし案内になることを確認した。正常settleのID伝播、`--no-session`の理由のみの表示も確認した。
- focused testはconversation／retained 71件とHost rollback 1件成功。`v0:check`、変更ファイルの
  `deno fmt --check`・`deno lint`、`git diff --check`成功。full `v0:gate`は実施していない。
- 隔離XDG・tmuxのsource production TUIでlocalhost模擬Chat providerを1回使用し、解析失敗行に
  `execution 6728562c · /recall 6728562c`が表示され、このIDで`recall 6728562c ready │ next task only`を
  確認した。実provider callなし。証拠は`/tmp/henji-i125-p2-HBBCQF/session-source.txt`と
  `session-source-sgr.txt`、`requests.txt`。

## 対象外

- 保存Session復元時の失敗行の再表示（現行`restored_log`は失敗行を復元しないため、ID表示の対象はTUI起動後の
  失敗行）。`henji history`、診断IDの表示、`henji run`の構造化出力は変更していない。

## 配置

- 変更をcommit（`44448eba`）し、同じclean commitからDeno 2.9.7で`deno task --config deno.v0.json henji:compile`
  を実行してbuild `51dfe46d…`（file SHA-256 `69ef7618…`、embedded runtime `ac0f63bd…`）を作成し、`dist/henji`と
  `~/.local/bin/henji`へ原子的に配置した。配置先の`--version`がsource `44448eba…`・build `51dfe46d…`を示す。
  pushとreleaseは未実施。
