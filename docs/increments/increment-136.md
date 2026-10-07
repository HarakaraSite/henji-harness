# Increment 136 — subagent起動時のagent名表示（S21）

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 完了（2026-09-27、利用者が133〜138をすべて完了とする旨を明示した）。
local実装・focused確認・実providerを使うproduction TUI受入確認と、
利用者指示のcommit／push・常用binary配置を実施済み。 経緯:
2026-09-27、利用者が通常利用メモのS21を次のincrementとすることを指示し、計画の作成を依頼した。
同日、defaultの計画レビューを経て、利用者指示で検証手順と復元test参照先を補足し、実装指示を受けた。
本文書が要件・対象範囲・計画・結果の正本であり、実装・確認結果は末尾に記録する。
当時未確認だった子のHTTP status readbackは後継138の経路でB08において確認済み。 子の実request
fact・HTTP 200・model/step/ordinalのreadbackは[1〜132 E2E](e2e-001-132-2026-09-27.md)を参照する。
S21の要件・観測・計画は通常利用メモから本文書へ移した。採用時に決めるとされていた
runId・task断片表示とstatus／collect／cancel行のagent名対応は、本文書の採用判断で今回含めない
（再検討候補は通常利用メモのS24）。

## 必要なproduct動作と根拠

- 人間が複数の子Agentを並行運用するとき、TUIの会話履歴と保存済みSessionの履歴から、
  `spawn_subagent`がどのagentを起動したかを読める。
- 根拠は利用者要望（2026-09-26、「`toolActivityPreview`に`spawn_subagent`のcaseを追加し、
  起動行にagent名を表示する（例: `spawn_subagent reviewer`）」）と、通常利用メモS21のsource照合
  観測（2026-09-26）である。`spawn_subagent`の起動contract（
  [Increment 131](increment-131.md)）は`agent`名（Host解決済みcatalog名）と`task`を必須引数とし、
  その`agent`はtool call引数として履歴に保存される。表示だけが欠落している。
- 成功基準は、人間がproduction TUIで子Agentを起動した後、その場の履歴と再起動後の
  Session履歴の双方から、起動行にagent名が読めることである。name-onlyの
  `tool> spawn_subagent …`／`spawn_subagent ✓`が残らない。

## 現行経路（調査済み事実。2026-09-26〜27 source照合）

1. tool行の表示textは`v0/agent/tools/tool_activity.ts`の`toolActivityPreview(name, args)`が生成する。
   対応は`bash`／`read`／`write`／`edit`／`bash_output`／`web_search`／`web_fetch`／`skill`のみで、
   `spawn_subagent`はdefaultへ落ちてname-only（`tool> spawn_subagent …`、完了時`spawn_subagent ✓`）になる。
2. 同じpreviewを使う表示経路は三つある。
   - TUI live: `v0/tui/state.ts`の`tool_call`（`event.call.arguments`からpreviewを組み立て
     `pendingToolActivityText`でentry text化）、`tool_progress`／`tool_result`
     （`previewFromToolActivityText`で既存entry textからpreviewを復元し`settledToolActivityText`で更新）。
     `v0/tui/conversation_renderer.ts`が`tool>` labelで描画する。
   - TUI復元: `v0/tui/state.ts`のrestore（`call.arguments`から同様にentry textを生成）。
   - Session履歴: `v0/agent/history/history_view.ts`の`renderMessages`（transcriptの
     `ToolCallContent.arguments`から）。`v0/agent/cli/history_cli.ts`がtimeline・view表示に使う。
3. 保存: transcriptの`ToolCallContent`は`callId`／`name`／`arguments`を保持する
   （`v0/agent/core/contracts.ts`）。`spawn_subagent`の引数`agent`（catalog名）は履歴に保存されるため、
   表示に使うagent名について追加storageは不要。再起動後の表示も同じ経路で成立する。
4. 既に引数としてagent名が見える経路（変更不要の根拠）: `v0/agent/cli/run_events.ts`の`--stream`
   tool行は引数JSONのheadを表示し、`v0/agent/session/history_export.ts`のMarkdown exportは
   引数JSON全文を出力している。欠落はTUI・Session履歴の簡潔なtool行に限られる。
5. runIdは`v0/agent/worker/worker_host_children.ts`の`ChildRunRegistry.spawn`が
   `crypto.randomUUID().toLowerCase()`で発行し、`spawn_subagent`のcall引数には存在しない。
   tool result JSON（`{ok:true,runId}`）と`subagent_status`／`collect_subagent`／`cancel_subagent`の
   引数にのみ現れる。HostのrunId→agent対応はin-memory registryのみで永続化されない。
6. 既存testに`spawn_subagent`行の表示textを直接確認している箇所はない（source照合）。
   tool previewの確認は`tests/v0/tui_tool_preview_test.ts`、履歴textの確認は
   `tests/v0/increment_129_assistant_note_history_test.ts`／`tests/v0/increment_99_history_cli_test.ts`
   の流儀に既存がある。

## 提供するproduct動作

1. `spawn_subagent`の起動行・完了行に、起動対象agent名を表示する。表示形式は既存のtool行構造を
   そのまま使い、previewをagent名とする（例: `tool> spawn_subagent reviewer …`、
   完了時`spawn_subagent reviewer ✓`）。label（`tool>`）・marker（`…`／`✓`／`✗`）・1行1tool行の
   構造は変えない。
2. この表示はTUI live・TUI復元・Session履歴timelineの三経路で同一になる。
   保存済みSessionでも追加storageなしで表示される。
3. 引数に`agent`文字列が無いtool call（modelの入力不正時など）では、既存どおりname-only表示に
   戻る。表示のための入力拒否・fallback・sanitizationは作らない。

## 対象範囲

- `v0/agent/tools/tool_activity.ts`の`toolActivityPreview`への`spawn_subagent` case追加。
  引数`agent`の先頭行をpreviewに返す（`skill`の`name`と同じ扱い。既存の`boundedHead`上限に従う）。
- 上記三経路の表示確認と、product動作に対応する最小のfocused test追加。
- Surface変更のための隔離XDGでのproduction TUI（tmux）確認と、その観測の本文書への記録。

## 非対象

- runId・task断片の表示、`collect_subagent`／`subagent_status`／`cancel_subagent`行とagent名の
  対応付け。採用判断で今回含めない。実現にはrunId→agent対応（transcriptからの導出、TUI stateの
  保持、またはspawn result契約の拡張のいずれか）が要り、最小の必須動作を越える。
  再検討条件は通常利用メモの[S24](../experience/normal-use-inbox.md)。
- `--stream`（`run_events.ts`）とMarkdown export（`history_export.ts`）の表示変更。
  既に引数JSONとしてagent名を含む。
- 子Agentの作業状況表示（A20）、名前付き子Agentの専用model指定（A14）。
- `spawn_subagent`の起動contract・tool result契約・Host run管理の変更。
- 構想・architecture・roadmapの変更なし（表示textのみで、状態所有・component境界・不変条件に
  影響しない）。

## 未確認事項

- 未確認: agent名が`boundedHead`の上限（96 byte）を超える場合の表示（`…`省略に従う想定）。
  catalog名は短い識別子であるため実害は想定しない。観測が得られたら本文書へ記録する。
- 実provider requestを伴うproduction確認は、対象・回数・保存先を提示して利用者の明示承認を得るまで
  実施しない。

## 実装計画

1. `toolActivityPreview`に`spawn_subagent` caseを追加し、引数`agent`の先頭行をpreviewとして返す。
   既存の`firstLine`／`boundedHead`を使い、preview機構
   （`pendingToolActivityText`／`settledToolActivityText`／`previewFromToolActivityText`）は変えない。
2. TUI live・TUI復元・Session履歴timelineは既存のpreview経路をそのまま使う。経路ごとの
   分岐・専用処理を追加しない。
3. test計画のfocused testを追加し、type check・format・lint・`git diff --check`を行う。
4. Surface変更のため、検証計画のtmux確認を実施し、操作と観測を本文書へ記録する。

## test計画（対応するproduct動作）

- product動作1（起動行・完了行のagent名表示）: `tests/v0/tui_tool_preview_test.ts`へ、
  `tool_call`／`tool_result`のreducer経路で`tool> spawn_subagent reviewer …`が
  `spawn_subagent reviewer ✓`へ確定する確認を追加する。
- product動作2（TUI復元経路）: `tests/v0/increment_129_assistant_note_history_test.ts`の
  `restoredPresentationMessages`／`restored_log`によるrestore確認の流儀を参照し、
  `tests/v0/tui_tool_preview_test.ts`へ復元entry textにagent名が含まれる確認を追加する。
- product動作2（Session履歴timeline経路）: 履歴text確認の流儀
  （`tests/v0/increment_129_assistant_note_history_test.ts`相当）で、
  `tool> spawn_subagent reviewer ✓`がtimelineに現れる確認を追加する。
- product動作3（`agent`欠落時はname-only）: 同test fileに、引数に`agent`文字列が無いcallで
  name-only表示に戻る確認を追加する。
- 回帰確認: 既存のtool preview確認（`bash`／`read`等）と履歴text確認を変更せず実行する。
- test件数は成果の記録であり、目標・上限・完了条件にしない。上記に対応先のないtestは計画しない。

## 検証計画（Surface変更の受入）

- focused test、type check、format、lint、`git diff --check`。
- 隔離XDG（`XDG_CONFIG_HOME`／`XDG_DATA_HOME`／`XDG_STATE_HOME`を隔離し、実configへ
  `default-selection.json`等を書かない）のtmuxでproduction TUIを起動し、子Agentを起動した後の
  履歴にagent名が表示される経路を実操作で確認する。TUIを終了し、同じ隔離XDG・Sessionを使って
  `history --session <sessionId>`のtimeline表示と、`--session <sessionId>`で再起動したTUIの
  復元表示の双方でも、起動行にagent名が残ることを確認する。
  確認した操作と各表示の観測を本文書へ記録する。
- この確認は実provider requestを伴う。対象（provider・model・起動agent）、回数、保存先を提示して
  利用者の明示承認を得てから実施する。承認前はoffline focused testまでとする。
- `v0:gate`は承認済み計画が要求する場合にcoordinating ownerが安定候補に対して一度だけ実行する。
  本計画はreview前のfull gateを要求しない。

## 承認境界

- 2026-09-27の利用者指示でlocal実装・test追加・focused確認を実施した。
  非対象判断（runId・task断片・collect対応の見送り）は実装指示により確定した。
- tmuxでの実provider確認は対象・回数・保存先を提示し、利用者の明示承認を得て実施済み。
  commit／push・常用binary配置は2026-09-27に利用者が指示し、実施済み。JSR公開は未指示。
- 新たな実provider確認は、対象・回数・保存先を提示して別途明示承認を得る。

## 実装・確認結果

### local実装・focused確認（2026-09-27）

- `v0/agent/tools/tool_activity.ts`: `spawn_subagent` caseを追加し、既存の`firstLine(args.agent)`と
  `boundedHead`でagent名をpreviewにする。live・復元・Session履歴は共有関数をそのまま使う。
- `tests/v0/tui_tool_preview_test.ts`: 起動から完了までのagent名保持、
  `restoredPresentationMessages`／`restored_log`による復元、agent引数欠落時のname-only表示を確認した。
- `tests/v0/increment_129_assistant_note_history_test.ts`: Session timelineの起動行にagent名が残る確認を追加した。
- 上記2 fileのfocused testは既存の回帰確認を含め21件通過（新規4件）。
  実行: `deno test --no-prompt --cached-only --config deno.v0.json
  tests/v0/tui_tool_preview_test.ts tests/v0/increment_129_assistant_note_history_test.ts`。
  結果ログ: `/tmp/henji-i136-focused.log`。
- 変更source・testと三経路のsourceに対するtype check、変更source・testのformat・lint、
  `git diff --check`は通過。full gateは実施していない。
- defaultが差分を確認し、preview以外の表示処理・storage・Host契約を変更していないことを確認した。

### production TUIの実provider確認（2026-09-27）

- 対象・回数・保存先を提示した後、利用者の「はい承認します」を受けて実施した。
  親・子とも`openrouter-responses`／`xiaomi/mimo-v2.6-pro`／`auto`。
  親1turn・`generic`子1run、既存`--max-steps 3`を親・子へ適用した。
- source production CLIをtmux（140列×55行）で起動し、隔離HOME・XDG・workspace・DBを使った。
  実config・実DB・常用binaryは変更していない。確認probeは`/tmp/henji-i136-production-probe.py`、
  保存先は`/tmp/henji-i136-production/`。
- 初回の隔離起動はcredential参照をsymlinkにしたため、既存credential読込contractが受理せず、
  provider送信前に停止した（request 0回）。その観測は`preflight-credential/`、DBは`state/`へ保持した。
  hard linkもfilesystemをまたいで作れなかったため、確認用configへcredential fileをmode 0600でコピーした。
  製品のcredential読込contractは変更していない。
- 実provider確認では`state-live/`の新規Sessionを使った。親が`spawn_subagent`を1回、
  `collect_subagent`を1回実行し、子の`I136 CHILD OK`を回収して`I136 PARENT OK`で正常完了した。
  親・子ともcompleted。Session: `6b1a860c-c8ac-4702-970a-74cf800acb9a`。
- 起動中の`tool> spawn_subagent generic …`と、完了後の`tool> spawn_subagent generic ✓`を
  tmux画面で観測した。終了後のproduction `history --session`と同じSessionのTUI再起動でも
  `tool> spawn_subagent generic ✓`を確認した。履歴・復元では追加request 0回。
- request数は親3回（各HTTP 200）＋子1回＝計4回。子の回数は保存済み`collect_subagent`結果の
  `providerRequestCount: 1`、modelはchild admissionのreadbackで照合した。
  現行child Host経路には個別requestのHTTP factが保存されておらず、子のHTTP statusのreadbackは未確認。
  この計画外の観測は通常利用メモA22に記録した。
- 画面とreadbackの記録は`evidence/pending.txt`、`spawn-completed.txt`、`completed.txt`、`history.txt`、
  `restored.txt`、`request-facts.json`、`result.json`。raw request／response・SSE・Authorizationのログは
  収集していない。確認ログにcredential値が含まれないことも照合した。確認用TUIは終了済み。

### Commit・push・常用binary配置（2026-09-27）

- 利用者のcommit／push・配置指示に従い、実装・追加test・本文書・関連する通常利用メモとhandoffを
  commit `c7d9c73753874b5a80e29d3f7c4c5708d3a6471f`へまとめ、`origin/main`へpushした。
  fetch後のlocal／remote一致を確認した。別件A21の未commitメモ差分は含めていない。
- push済みcommitのcleanなdetached worktreeからDeno 2.9.7でbuildした。product versionは0.7.0、
  sourceは`c7d9c737…`（dirtyなし）、buildは
  `62605210bb0378cd4b0b1dcf1305e84b3f6f27eeebf165b938cc42e5a44ffd69`。
  保存先は`/tmp/henji-i136-deploy-a38mstkc`。
- compiled候補で実provider確認済みの隔離Sessionを読み、production `history --session`と
  tmux上のproduction TUIの復元で`tool> spawn_subagent generic ✓`を確認した。
  確認用TUIは終了済み。新しい依頼・実provider callは発生していない。
- 常用先`/home/agent/.local/bin/henji`へ原子的に配置した。候補と配置先のSHA-256はともに
  `d00dce968f64a3af6bc099a86a944a63ba7a8b98509ceeb85220a6482c5d29aa`で一致。
  配置後のversion／source／buildも一致し、配置binaryの履歴CLIでもagent名表示を確認した。
- 画面・version・照合結果は上記保存先の`evidence/`配下、旧binaryは`henji.previous`へ保持した。
  稼働中のHenjiは切り替えず、新しいプロセスからこのbinaryを使う。実config・実DB・旧Sessionと
  JSR公開内容は変更していない。構想・architecture・roadmapは今回変更していない。

## 最新配置binaryの基本E2E（2026-09-27）

利用者の133〜138 E2E依頼に従い、source `560c4f6f…`の配置binaryをtmuxで操作した。
実MiMo flashの親requestから`spawn_subagent generic …`と`spawn_subagent generic ✓`を観測した。
ただしtool結果はgeneric Definitionのrealpath失敗による`ok:false`で、子は起動できなかった。
今回はlive行のagent名表示のみ確認。子が完了したcanonical履歴と復元の確認には到達していない。
以前のsource実行による受入結果を、最新配置binaryの子起動成功として扱わない。

起動error、親子execution ID、TUI終了と証拠は
[合同E2E記録](e2e-133-138-2026-09-27.md#dで見つかった配置binaryの不具合)を参照する。


## 138起動失敗修正後の表示確認（2026-09-27）

bundled generic同梱漏れの修正後、実compiled候補の新規親子taskで、spawn行のgeneric名を
live pending／completed、canonical Session履歴、同じSessionのTUI再開で確認した。
localhostと実MiMo flashの両経路で子は正常完了し、履歴再表示による追加requestは0回。
修正・binary identity・配置後確認は
[Increment 138の追加対応結果](increment-138.md#起動失敗への追加対応確認結果2026-09-27)を参照する。

## 133〜138の利用者完了承認（2026-09-27）

利用者が「では133-138は全て完了とします」と明示した。
agent名表示の実装・配置と、138起動失敗修正後の配置binaryでのlive・履歴・TUI復元確認を踏まえ、136を完了とした。
採用時に対象外としたrunId・task断片やstatus／collect／cancel行の対応を追加する判断は含めない。
