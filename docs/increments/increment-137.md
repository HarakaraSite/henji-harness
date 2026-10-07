# Increment 137 — Responsesの本文・tool call併存時の表示順と履歴本文欠落の修正（S23）

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態: 完了（2026-09-27、利用者が133〜138をすべて完了とする旨を明示した）。
隔離production TUIの表示・保存・再表示と、後述の実OpenRouter／MiMo flashでの基本E2Eを確認済み。
利用者の今回の明示承認により完了。公開は未実施。
経緯: 利用者がsession `4ba6f18d`で観測した不具合を調査し、通常利用メモS23へ記録した。
2026-09-27、利用者はS21をIncrement 136として計画済みと伝え、本不具合をIncrement 137として
計画するよう指示した。当初の対応予定は136の後。通常レビュー・批判的レビューを経て、同日、
利用者が本計画の実装を指示した。本書が要件・観測・原因・対象範囲・計画・結果の正本であり、
S23の記録を通常利用メモから移した。実装開始時点で136は計画のみで、136の実装変更は混在させていない。

## 必要なproduct動作と根拠

- Responsesで同じmodel stepに本文とtool callが返ったとき、人間がその本文とtoolの実行を
  production TUIで順に読める。次stepのthinkingは、前stepのtoolより後ろに追加される。
- 途中本文は一時表示だけでなく通常のassistant本文として保存され、Session履歴・TUI復元でも読める。
- thinking・tool call・最終回答の既存の順序と、Responsesの継続requestを維持する。
- 根拠は利用者の通常利用観測、保存済みsemantic履歴・canonical messageの照合、current source、
  および保存本文から途中表示eventを補ったTUI reducerでの再現である。Responses APIやOpenRouter側の
  制約とは扱わない。原因はHenjiのResponses adapterがtool call結果に併存本文を渡していないことである。

成功基準は、人間が新しいexecutionの実行中画面と保存後のSessionの双方で、
`thinking → 途中本文 → tool → 次stepのthinking → … → 最終回答`を読めることである。
offline再現だけでproduction画面の受入を完了扱いにしない。

## 観測と確認した保存内容

- session: `4ba6f18d-e85b-4dfd-96e2-4add04ea3649`。
- execution: `799b73ef-097c-4e1f-985b-429cb043f188`。18 model step・33 tool callで完了。
- provider／model／effort: `openrouter-responses`／`xiaomi/mimo-v2.6-pro`／`auto`。
- Henji `0.7.0`、source `52e84069ea3d440edd38b82e4c14e6cf3418b114`、
  build `426d89176e764872a6374407a2412b743778a1dbb21d22e664cc4e867eeee0ef`。
- 利用者観測（2026-09-27）: tool callが画面末尾へ追加される一方、次stepのthinkingが前stepの
  実行済みtool callより上に追加される。利用者にこの前後関係を確認し、同じ事象との回答を得た。
- step 4のResponses output item順は
  `reasoning → message(output_text 72文字) → function_call → function_call`。
  `ModelResult`には`text`がなく、canonical conversationのmessage ordinal 7も通常本文の`text`がない。
  本文72文字はprovider stateの`replayItems`に残っている。本文データ全体がDBから失われたわけではない。
- thinking・tool callのsemantic履歴の順序は正常。履歴表示はstep順に構成されるが、step 4の本文は
  通常本文として投影されていないため通常の履歴表示から抜ける。同じprovider・modelのResponses
  継続requestは`replayItems`を再投入するので、当該本文はその経路のmodel contextには残る。

## 現行の利用者操作から表示・保存・再表示までの経路

1. 人間がTUIからtaskを送信し、Workerの`runAgentTurn()`が選択modelを呼ぶ。
   `v0/agent/provider/openai_responses_model.ts`の`ResponsesApiModel.generate()`が
   Responses streamを処理する。OpenAI・OpenRouter・宣言型Responses providerはこの処理を共有する。
2. `response.output_text.delta`で`progress`へ本文を蓄積し、`reportAssistantProgress`を呼ぶ。
   `v0/agent/core/loop.ts`が本文snapshotを受け、provider evidenceへ記録する。
   production Workerではprovider observationをHostへの単一の事実経路として使う。
3. `v0/agent/worker/worker_host_coordinator.ts`が`assistant_progress` observationを
   provider非依存の`AgentEvent`へ投影し、presentation adapter経由でTUIへ渡す。
   `v0/tui/state.ts`はlive assistant entryを作り、`activeAssistantId`として保持する。
4. model request完了時、Responses adapterはoutputを`providerState.replayItems`として保持する。
   tool callがある分岐は`{kind:'tool_calls', calls, providerState}`を返し、本文`text`を返さない。
   tool callがないfinal分岐にだけ、完了本文または蓄積した`progress`の本文解決がある。
5. loopは`recordModelResult`を発行し、Hostは結果を`assistant_message`へ投影する。
   同じ`ModelResult.text`をloopの`assistantToolMessage()`がtranscriptの通常本文へ転記する。
   本文が渡されないため、Hostの完了messageとcanonical transcriptの双方で本文が抜ける。
6. TUIの`assistant_message`は本文未指定なら早期returnする。このためlive entryと
   `activeAssistantId`が残り、本文表示が確定しない。その後の`tool_call`は末尾へ追加される。
7. 次stepの`assistant_thinking`初回snapshotは、同じturnのlive assistant entryの直前へ挿入される。
   挿入先entryが前stepのものかは識別していない。古い本文entryが残ると、後続thinkingが前stepの
   toolより上に入る。thinking snapshotの更新自体はmodel stepごとの同じentryを更新する。
8. 保存側の`sqlite_history_v7_production_store.ts`は本文progressをrequest単位の最新状態として
   保持し、`model_result`到着時にその状態を除く。通常は完了結果が本文の正本になるが、今回はその
   結果に本文がない。途中表示の本文progressは完了後の独立したsemantic本文として残らない。
9. `history_view.ts`はassistant messageの通常本文とthinkingのmodel stepからSession timelineを
   構成する。TUI復元は`worker_tui_session.ts`のthinking位置付けと`state.ts`のrestore処理を使う。
   いずれも`replayItems`の本文を通常本文として拾い直す経路ではない。
10. Responsesの`requestInput()`は同じprovider・modelの`replayItems`があればそれを投入し、
    通常本文とtool callを別途追加せず次messageへ進む。通常本文を付加しても、この経路を維持すれば
    継続requestの本文を二重送信する必要はない。

## 原因の適用範囲と再現の限界

- 原因はResponses共通adapterの本文の渡し忘れであり、OpenRouterやMiMo固有の処理ではない。
  本文とtool callが併存すれば、OpenAI Responsesや宣言型Responses providerにも同じsource経路がある。
  他providerでの実発生は未確認。
- 表示順を崩す挿入処理の置き場所はTUI共通だが、Chat Completionsでも今回の事象が起きるという
  意味ではない。Chat Completionsの`openrouter_sse.ts`／`openrouter_response.ts`は
  tool callと併存本文を両方返すので、今回と同じ原因には当たらない。
- 保存eventだけをTUI reducerへ再入力すると、既に完了結果へ置き換えられた本文progressがないため
  表示順の崩れは再現しない。step 4の`replayItems`の本文から`assistant_progress`を補って再入力すると、
  step 5〜18のthinkingがstep 4以降のtool群より上へ集まる症状を再現した。
  元のSSE delta列を取得した再現ではない。調査中の実provider callとproduction画面の再現確認は未実施。

期待順: `thinking4 → 本文4 → tool4 → thinking5 → tool5 → … → thinking18 → final本文`。
再現した順: `thinking4 → thinking5 → … → thinking18 → tool4 → tool5 → … → final本文`。

## 提供するproduct動作

1. Responsesのtool call結果にも併存本文を渡す。本文なしのtool call結果は、本文なしのまま扱う。
   本文を読むために通常のprovider responseを拒否したり、本文併存を制限したりしない。
2. 既存の`assistant_message`処理で途中本文を`assistant note>`として確定させる。
   次stepのthinkingは直前stepのtoolより後ろに入り、最終回答は最後に表示される。
3. 同じ本文をcanonical assistant messageの`text`として保存する。新しいexecutionについて、
   通常のSession履歴表示とSession再表示でも途中本文を読める。
4. 既存のResponses output itemとtool callの順序・識別子・引数を維持する。
   同じprovider・modelへの継続requestでは本文が一度だけ入る。

## 対象範囲と実装方針

- 主変更は`v0/agent/provider/openai_responses_model.ts`の完了結果生成。
  既存のfinal本文解決をtool call分岐にも通し、得た本文がある場合に`ModelResult.text`へ渡す。
  既に観測した本文併存outputとstream本文を基準にし、推測したprovider variantを新仕様にしない。
- `ModelResult`、`AssistantMessage`には任意の本文が既にあるため、新しいcontractやstorageは不要。
  loop・Host投影・TUI本文確定・保存・履歴・TUI復元はまず既存経路で成立させる。
- 共通TUIの追加変更は現段階では計画しない。Responses adapter修正後にも今回の症状が残る
  実行証拠が得られた場合、原因と必要な変更を報告して本書の範囲を見直す。
- Increment 136のagent名previewとは原因・変更箇所が異なる。136が変更する共有tool previewを
  そのまま使い、137から136の計画や表示仕様を変更しない。

## 非対象

- Chat Completions adapterの変更、Responses APIの切替、provider／modelの制限。
- 古い保存済みSessionからの本文抽出・補完・migration、DB schema変更、過去eventの書換え。
  保存済みsession `4ba6f18d`は調査証拠であり、本計画で修復する対象にはしない。
- raw request／response、SSE断片、thinking全文の新たな常設収集。
- 子Agentの進捗取得、steering複数回受付、S21／S24の追加表示、一般的なTUI描画方式の改訂。
- 構想・architecture・roadmapの変更。既存の本文contractと責務の範囲で修正する。

## 実装計画

1. 136後のsource状態を確認し、Responsesの本文生成とtool call返却を局所修正する。
   本文の取り出し方は既存の完了本文・stream本文経路に揃え、本文がないcall結果も維持する。
2. 観測した本文併存Responsesから、次stepのthinking・tool・finalまでを通して表示順を確認する。
   Hostへのprovider observation投影とTUI adapterを通し、TUIに都合のよいmessageだけを直入力する
   確認で完了としない。
3. 同じ実行のcanonical message保存・readback、Session timeline、TUI復元で途中本文を確認する。
   既存の継続requestを確認し、本文とtoolのreplayを二重にしない。
4. 下記のfocused確認とproduction TUI確認を行い、実施した操作・結果・未確認事項を本書へ記録する。

## test計画（product動作との対応）

| 確認する動作 | 経路・候補となる既存test |
| --- | --- |
| 本文とtool callの両方を返し、本文なしのcall結果も維持する（動作1） | `increment_14_multi_provider_test.ts`の実Responses adapter＋注入fetcherによるSSE確認を拡張。観測したreasoning・message・function call併存outputと本文deltaを使う |
| 次stepのthinkingが前stepのtoolより後ろになり、本文・finalが確定する（動作2） | 実Responses adapter → loop／Worker・Host → presentation → TUIのfocused確認。`increment_120_thinking_history_test.ts`、`tui_conversation_presentation_test.ts`、`increment_132_streaming_display_test.ts`の既存seamを使う |
| 本文がcanonical messageに残り、timeline・復元でも読める（動作3） | `increment_120_thinking_history_test.ts`のproduction SQLite保存経路と`increment_129_assistant_note_history_test.ts`の本文履歴確認を参照し、同じ本文の保存・readback・再表示を確認 |
| 本文を追加しても継続requestのreplayは一回になる（動作4） | `increment_14_multi_provider_test.ts`のResponses replay確認で、次requestのinputにmessage本文とfunction callが一度ずつ入ることを確認 |

追加する確認は上記の観測済み不具合と変更動作に限る。既存のfinal・本文なしtool call・Chat Completionsの
本文併存確認は関係するfocused testで回帰確認し、provider全種の未観測variant matrixは追加しない。
test件数を目標・完了条件にはしない。

## 検証計画（production Surfaceの受入）

- 変更箇所のfocused test、必要なtype check、format、lint、`git diff --check`を行う。
  計画作成中にtest追加やgate実行は行わない。review前のfull gateは要求しない。
- 隔離XDGのtmuxでproduction TUIを起動し、本文とtool callが同じstepに現れるtaskを実行する。
  次stepのthinkingが前のtoolより後ろに現れること、途中本文と最終回答が確定することを観測する。
  実configの`default-selection.json`等へ書き込まない。
- 保存後にSession履歴とTUIでのSession再表示を確認し、本文とthinking・toolの前後関係を記録する。
- 実provider確認の候補は観測元の`openrouter-responses`／`xiaomi/mimo-v2.6-pro`／`auto`。
  実施前にtask、回数、保存先を提示して別途承認を得る。本文併存が出なかった実行は本症状の確認として
  成功扱いにせず、得た観測を記録する。追加requestも承認された回数の範囲で行う。
- 他Responses providerの実発生・修正後の実動作は未確認として区別する。
  共通adapterのsource・focused確認を、他providerで実確認したという報告に置き換えない。
- `v0:gate`は本計画では必須にしない。追加で要求された場合は、安定候補に対してownerが一回実行する。

## 未確認事項と承認境界

- 元sessionのSSE delta列は保持されていない。本文途中表示の細かな時刻は復元できないが、
  保存された本文併存output・current source・補ったprogressでの再現と利用者の表示観測は一致する。
- 計画作成依頼の時点では計画のみとし、実装しなかった。通常レビュー・批判的レビューの後、
  2026-09-27に利用者の実装指示を受け、local実装・test追加・隔離production TUI確認を実施した。
  その後、同日利用者指示によりcommit／push・常用binary配置を実施した。公開は未指示・未実施。
- 新しい実provider callは対象・回数・保存先を提示して別途承認を得る。
- 計画外のproduct変更が必要になった場合は原因・根拠・利用者影響・案を報告する。
  古いSessionの変更や、構想・architecture・roadmapの修正を推測で追加しない。

## 実装・確認結果

### 計画レビューと採用した確認事項

- 通常レビュー・批判的レビューとも必須findingなし。本文を既存の`ModelResult.text`へ渡すことで、
  Host投影・canonical保存・TUI本文確定・履歴／復元まで成立するsource経路を確認した。
- 批判的レビューの未確認事項: 本文解決は`completed.output_text`またはstreamの`progress`を読む。
  保存された`output[].message.content[].output_text`を別途抽出する処理ではなく、元sessionの上位
  `output_text`とdelta列も未保持。新規focused確認では上位`output_text`を付けず、実際の
  `response.output_text.delta`から本文を受ける経路を通すことで、helperの都合を実仕様にしない。

### 実装内容

- `v0/agent/provider/openai_responses_model.ts`: 既存の本文解決をtool call分岐の前へ移し、本文がある
  場合は`tool_calls`結果にも`text`を渡す。本文なしのcall結果と既存final処理は維持する。
- 共通TUI、loop、Host投影、storage schema、履歴rendererの実装は変更していない。
  既存の本文確定経路で`activeAssistantId`が解除され、次stepのthinkingの誤挿入は解消した。
- `tests/v0/increment_137_responses_note_test.ts`を追加し、`deno.v0.json`へfocused taskと
  通常の`v0:test`からの呼出しを登録した。`v0:check`／format／lintの既存globにも含まれる。

### focused確認

- 新規確認は、localhostのResponses SSEからproduction Worker・Host・presentation adapter・TUI
  reducerへ通す一連の確認。step 1はthinking・本文delta・read 2件、step 2はthinking・本文なしread、
  step 3はthinking・final本文とする。上位`output_text`を付けず、本文deltaを複数fragmentで渡した。
- `assistant note>`の確定と`activeAssistantId`解除、tool後の次thinking、最終回答の位置を確認した。
  production SQLiteへのcanonical本文保存・readback、通常Session timeline、閉じたSessionの復元でも
  同じ本文と順序を確認した。継続requestには保存outputとtool resultが入り、本文は一度だけだった。
- 新規focused test 1件、既存multi-provider確認24件、thinking／assistant note履歴／streaming display／
  conversation presentation／Chat Completions stream互換の関連確認56件が成功。
  本文なしtool callと既存finalの回帰もこれらの既存確認で通過した。
- 変更sourceと新規testのtype check、format、lint、`deno.v0.json`のformat、`git diff --check`が成功。
  本計画どおりfull gateは実行していない。
- 結果ログ: `/tmp/henji-i137-new-test.log`、`/tmp/henji-i137-focused.log`。

### production TUIのtmux確認（隔離XDG・実provider callなし）

- source production CLIをtmux上で起動し、新規宣言型Responses provider `i137-local-responses`を
  localhostの確認用サーバーへ接続した。実config・実credential・実DB・常用binaryは更新していない。
  保存先は`/tmp/henji-i137-tui-3pxb2wd6`、操作probeは`/tmp/henji-i137-tui-probe.py`。
- workspaceの`marker.txt`を実read toolで読み、1turn・3 model request・3 read callを完了した。
  本文とtool callが併存するstep、本文なしtool callの次step、final stepを実CLI／Workerの経路で通した。
- 最終stepのthinking中に画面をcaptureし、
  `thinking1 → 本文1 → read 2件 → thinking2 → read → thinking3`の順を確認した。
  final生成後にも途中本文が残り、最終回答は最後に表示された。
- TUIを終了してproduction `history --session`で通常履歴を読み、本文と順序を確認した。
  同じSessionを`--session`で再起動した画面でも本文と順序を確認した。再表示でmodel requestは増えなかった。
- canonical messageの本文をDBからreadbackし、本文ありstepと本文なしstepの両方を確認した。
  次requestの短いfactで本文が一回だけreplayされることを確認した。
- Session: `b5cd252b-8ba0-4344-8850-74bef39501d8`。
  `evidence/active.txt`、`completed.txt`、`history.txt`、`restored.txt`、`request-facts.json`、
  `result.json`に操作・画面・短い照合結果を保存した。raw request／response・SSE・Authorization・
  credential値のログは保存していない。確認用TUIとサーバーは終了済み。
- probe初回はbuilt-in providerのendpointをexternal overrideする宣言が既存loaderに受理されなかった。
  probeを新規宣言型providerへ直し、上記production経路を確認した。製品の宣言contractは変更していない。

### 残る確認・承認境界

- コード・テストのread-onlyレビューは必須findingなし。Responses adapterの局所変更、本文なし結果と
  final処理の維持、旧実装の表示順・本文欠落を検出できる新規test、隔離tmuxの実行証拠を確認した。
- ローカルSSEでのproduction表示・保存経路と、後述の実OpenRouter／MiMo flashの本文併存responseは確認済み。
  元sessionのdelta粒度・速度、他Responses providerの実動作は未確認。
  新たな実provider確認は対象・回数・保存先を提示して別途明示承認を得る。
- 旧session `4ba6f18d`の通常本文は補完していない。修正は新しいexecutionに適用される。
- 2026-09-27、利用者からcommit・push・常用binary配置の指示を受けた。以下に結果を記録する。
  当時は公開と利用者によるIncrement完了承認は未取得だった。完了承認は末尾のとおり取得済み。

### Commit・push・常用binary配置（2026-09-27）

- 実装・追加test・test task・本文書をcommit `3926cfff9ecc7ac61d4fe0105a1833fb8085deca`へまとめ、
  `origin/main`へpushした。fetch後のlocal／remote一致を確認した。
  別作業のIncrement 136計画と通常利用メモの未commit差分は本commitへ含めていない。
- push済みcommitのcleanなdetached worktreeからDeno 2.9.7でbuildした。product versionは0.7.0、
  source `3926cfff…`（dirtyなし）、buildは
  `531c5cf1b230332f2d15d695551a7d3a75f9b2b0e14d0df842b1d8abf5d0b330`。
  build・候補binaryの保存先は`/tmp/henji-i137-deploy-Jn0JeJfr`。
- compiled候補をtmux上のproduction TUIで起動し、隔離XDGとlocalhost Responsesサーバーで
  1turn・3 model requestを実行した。実read tool、途中本文の確定、後続thinkingの位置、finalの位置、
  canonical本文、通常履歴、Session再起動後の表示、次requestへの本文replay一回を確認した。
  Sessionは`fd1599cb-1687-458d-888e-6cbaa4c59c09`、画面・短い結果の保存先は
  `/tmp/henji-i137-compiled-tui-iliua5q7/evidence/`。
- 常用先`/home/agent/.local/bin/henji`へ原子的に配置した。候補と配置先のSHA-256はともに
  `998e2ecf55c1fcd6aebce4c6586490322fdd77430657a681b686ec66dc302119`で一致。
  配置binaryのversion／source／buildも一致し、配置binaryで隔離Sessionのread-only
  `history --session`を実行して本文と履歴を読めることを確認した。
- compiled確認用TUI・サーバーは終了済み。稼働中のHenjiは切り替えていないため、修正は新しい
  Henjiプロセスから適用される。実config・実DB・旧Sessionは変更していない。実provider callとJSR公開は
  行っていない。build用worktreeは確認後に除去し、binaryと結果ログは上記保存先に残す。

## 配置binary・実OpenRouter／MiMo flashの基本E2E（2026-09-27）

利用者の133〜138 E2E依頼と実provider許可に従い、配置binaryをtmuxで操作した。
`openrouter-responses / xiaomi/mimo-v2.6-flash / auto`の実応答で、step 1の本文
`E2E NOTE BEFORE BASH`とbash callの併存を確認した。
本文はassistant noteとしてtoolより前に確定し、次step thinking・tool・finalがその後に表示された。
canonical assistant messageのtext、配置binaryのSession履歴CLI、同じSessionのTUI再開にも
本文と順序が残った。再表示による追加provider requestは0回。
元観測と同じ速度・他provider・wire上のreplay回数は今回確認していない。

結果・Session ID・保存先は
[合同E2E記録](e2e-133-138-2026-09-27.md#137--実responsesの本文併存と復元)を参照する。
E2E実施時点では公開・利用者による完了承認は依頼に含まれなかった。
その後、末尾のとおり利用者が完了を明示した。

## 133〜138の利用者完了承認（2026-09-27）

利用者が「では133-138は全て完了とします」と明示した。
Responses本文併存の修正・配置と、実OpenRouter／MiMo flashの表示・保存・履歴復元の基本E2Eを踏まえ、137を完了とした。
元sessionのdelta粒度・速度や他providerを追加確認したという意味ではない。JSR公開と旧Sessionの補完は含めない。
