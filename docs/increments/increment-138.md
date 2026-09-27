# Increment 138 — 子Agentの作業状況取得とrequest factの保存・readback（A20・A22）

状態: 完了（2026-09-27、利用者の承認によりIncrement 138を完了とした）。
利用者がA20・A22をまとめて次のincrementへ採用し、計画レビュー後に実装を指示した。
実装・検証・第三者レビュー・commit／push・常用binary配置済み。
実provider受入と公開は未実施のまま、利用者が完了とする判断を示した。
その後の配置binary E2Eでbundled genericの起動失敗を観測した。追加対応で同梱と起動Promise処理を修正し、
修正版compiled候補のlocalhost・実MiMo flashの親子taskと履歴復元は成功。clean build・常用配置の確認は進行中。
原因・計画・確認結果は末尾を参照する。
本書が要件・観測・対象範囲・計画・結果の正本であり、A20・A22の記録を通常利用メモから移した。

## 必要なproduct動作と根拠

- 親Agentが子の実行中に`subagent_status`を呼び、lifecycle
  stateだけでなく、誰が、どのmodel stepで、
  model応答を待っているか、どのtoolを実行しているか、いつ最後に更新されたかを把握できる。
  親は取得した観測を利用者への中間報告に使える。
- 人間が通常の履歴参照操作で、子のrequestごとのprovider・model・API・論理step・物理request順・
  HTTP／error・解析失敗の項目と値の形をreadbackし、次の診断を決められる。
- 同じ子Workerの既存観測をHostで受け、semantic履歴への保存と現在の進捗への投影に使う。
  子の最終結果は従来どおり`collect_subagent`で取得し、途中の観測と区別する。
- 利用者指定: 待機中の定期報告、待機操作の変更は今回は求めない。
  `spawn_subagent → 親の独立した作業 → 必要に応じてstatus → 結果が必要になった時点でcollect`
  という既存の並行作業経路を使う。collectを呼んだ後は子の終了まで親の次requestへ進まない。
- 根拠は以下の利用者希望・実provider観測・current source、および
  [AGENTS.md](../../AGENTS.md)の通常実行で短いrequest単位factを保存・readbackする規定。
  外部providerの新しいresponse variantやAPI変更を前提にしない。

成功基準は、production経路で親が実行中の子の作業状況を取得して報告でき、実行後には人間が
子のrequest経緯を履歴から読めることである。A22とA20を別々に確認し、offline
testの成功だけで production受入を完了扱いにしない。

## 採用した観測・利用者判断

### A20 — 子Agentの作業状況取得

- 利用者希望（2026-09-27）:
  子Agentの状況を親が読み取り、利用者へ中間報告できるようにしたい。 session
  `51b47299`で名前付き`reviewer`の結果を待つ利用から出た候補。
- 利用者選択（同日）:
  子Workerの既存イベントをHostで受け、短い進捗として保持し、親が取得できる
  初期案に範囲を絞った。子の明示的な中間finding報告、TUIへの直接表示はこの初期案に含めない。
- 本会話でcollectの待機を確認したうえで、定期報告・待機操作の変更を求めないことを明示し、
  A22とまとめて次のincrementとする判断を得た。
- 関連:
  [Increment 136](increment-136.md)（子Agent名表示）、通常利用メモA19・S24。

### A22 — 子Agentのrequest単位factの保存・readback

- 観測（2026-09-27、Increment 136の承認済み実provider確認）:
  親3requestのprovider／model／step・ HTTP
  200はsemantic履歴からreadbackできた。`generic`子はcompletedで、保存済みcollect結果に
  `providerRequestCount: 1`と最終回答があるが、子のsemantic履歴には個別requestのHTTP
  factがない。
- Session `6b1a860c-c8ac-4702-970a-74cf800acb9a`、子run
  `e9bdccdf-3aa9-41de-97be-897f5437d2be`。
  証拠は`/tmp/henji-i136-production/evidence/request-facts.json`と隔離DBのreadback。
- 原因: `worker_host_children.ts`の`routeChildMessage()`はreadyやterminal
  message等を扱うが、
  子の`provider_observation`をhistoryへ転送しない。`settle()`は最終outcomeを保存するため、
  回数・最終結果は残る一方、request単位の経緯が残らない。
- 利用者影響は子のprovider応答・失敗を後から診断する材料の欠落。子Agent名の表示自体は136で実確認済み。

## 現行の利用者操作から保存・参照までの経路

1. 親modelが`spawn_subagent`を呼ぶ。`async_agents.ts`のtoolがWorker→HostのRPCを送り、
   `worker_host_coordinator.ts`のHost所有`ChildRunRegistry`がrunIdを発行する。
2. 子executionはrunIdをexecution
   IDとし、`parentExecutionId`と`spawnCallId`を付けて 同じproduction
   historyへadmissionする。子のsession correlationは
   `parent:<parentExecutionId>:child:<runId>`であり、親Session IDとは異なる。
3. 別Worker
   generationで子を実行する。`worker_runtime.ts`／`worker_bootstrap.ts`は既に
   provider observation、runtime event、context observation等をHostへ送る。
   productionでは本文・toolのsemantic eventはprovider
   observationが単一の事実経路である。
4. 子の`routeChildMessage()`は途中の観測を保存・進捗化しない。
   `subagent_status`のHost応答とtool結果はrunId・stateだけを返す。
5. 子のterminal messageでexact outcome・diagnostic・context manifestを受け、
   `settleNonCanonicalExecution()`へ保存する。子は親のcanonical
   conversationへ直接採用されない。
6. 親のtool
   loopはcall順に結果をawaitする。collectは`run.settled.promise`を待つため、
   その後のtoolと次model
   requestは子の終了まで進まない。親turn終了時は未完了の子がcleanup対象となる。
7. root側は`worker_host_journal.ts`が観測を既存event kindへ投影してbatch
   appendする。 production SQLiteはrequest
   factとtoolのsemantic記録を保存し、本文progressはIncrement 134の
   request単位の最新状態へ集約する。A22でもこの保存contractを使える。
8. 人間向け`history --session <id> --view detail`は
   `streamHumanHistoryExport()`を呼ぶが、現在は親Session
   IDと一致するexecutionだけを選ぶ。 子の独立したsession
   correlationは選択されない。`/recall`も現在は同じSessionの停止executionを
   次taskへ参照する操作であり、子をそのまま診断閲覧する入口ではない。

## 提供する動作

### A — 子の観測保存と人間のreadback（A22）

- `request_start`、`response_start`、`request_failure`、解析failure
  observationを、子executionの 既存semantic履歴へ受信順に保存する。request
  metadata・modelStep・request ordinalとHTTP／errorを 結び付け、rootのrequest
  ordinalと混ぜない。
- provider observation内のmodel result・tool
  call／progress／resultも既存保存経路へ渡す。
  途中で停止した場合も、Hostが保存できたtoolの順序・引数・結果とrequest
  factを参照できる。 assistant
  progressを取り込む場合は既存の最新本文stateを使い、更新ごとの累積全文を追記しない。
- requestの既存context参照に必要なcontext observationは既存の保存経路へ渡す。
  context manifest・diagnostic・exact terminal
  outcomeは現行settlementを維持する。 新しいcontext収集や独立したraw
  storeを設けない。
- terminal settlementより先に子の受信済み保存batchをflushする。
  正常終了後だけに保存を頼らず、実行中にも既存のbatch／timer方式で保存する。
  保存結果とWorkerの終了結果を区別し、保存失敗を保存成功として返さない。
- `history --session <親Session ID> --view detail`のexecution選択へ、親Session内のexecutionに
  `parentExecutionId`で結び付く子を含める。既存のexecution・semantic
  occurrence等のJSONL形式を使い、 runId＝子execution ID、親execution ID、spawn
  callの対応から子のrequest factを追えるようにする。
  親Sessionのheader／tailは親のexecutionを基準に維持する。
- 子の履歴を読めることと、親Sessionの通常会話へ採用することを同一視しない。
  session／canonicalの通常表示と`/recall`の選択仕様は変更しない。

### B — 親が取得する現在の作業状況（A20）

新しいtoolを増やさず、`subagent_status`の結果を拡張する。既存runId・stateにagent名とprogressを加える。
以下は実装に向けたsnapshot案であり、既存eventに対応する意味を維持して型を確定する。

| 項目                      | 内容と生成元                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                   | spawn時のcatalog名。`ChildRun.agent`を使用                                                                                                         |
| `progress.phase`          | `starting`／`model`／`tool`／`between_steps`／`settled`。Hostの開始・終了と、request start／本文生成／tool call／tool result／model resultから更新 |
| `progress.updatedAt`      | snapshot対象の観測をHostが最後に受けた日時。statusを読むだけでは更新しない                                                                         |
| `progress.modelStep`      | 観測された現在または直近の論理step。まだ観測していなければ未指定                                                                                   |
| `progress.requestOrdinal` | 現在または直近の子execution内の物理request ordinal。まだ観測していなければ未指定                                                                   |
| `progress.lastTool`       | 直近toolのname・callIdと実行中／終了の区別。終了時は既存tool resultのoutcomeを保持                                                                 |

- model resultとtool callの間、tool
  resultと次requestの間は`between_steps`として扱う。
  「model実行中」と「tool実行中」を終了済みeventの後まで引きずらない。
- tool内のweb search等の補助provider
  requestもA22のfact保存対象とするが、実行中toolのphaseを
  主modelの`model`へ置き換えない。既存request
  metadataのoriginと実行中toolから区別する。
- 起動時は`starting`とHostの開始日時を持ち、step・request・toolは最初の該当観測で設定する。
- 既存thinking
  eventも、必要ならstepと更新日時の材料にするが、thinking本文をsnapshotへ入れない。
  request開始後に本文更新がまだない場合でも`model`と既知のrequest情報を返せる。
- lifecycleの`running`とprogressの`model`／`tool`等は別の情報として扱う。
  `settled`でも最後に観測したstep・toolは残し、最終回答はcollectで取得する。
- snapshotは既存eventから作るHost内の現在値であり、別の永続履歴や定期snapshot列を作らない。
  親が取得したstatus結果は、通常の親tool resultとして既存経路で保存される。
- 完了率、途中のfinding、子の意図を推測して報告しない。最後の更新日時はheartbeatや生存保証ではない。
  status取得が親の明示的なtool callであることと、collectの待機仕様をtool
  descriptionに説明する。

## 対象範囲と実装方針

- `v0/agent/worker/worker_host_children.ts`:
  子の観測受信、child単位の保存batch、snapshot更新、
  status応答、terminal前のflush。既存ChildRunの所有とlifetimeに乗せる。
- `v0/agent/tools/async_agents.ts`:
  status応答の型・tool結果・descriptionを拡張する。
  RPCは既存の`AsyncAgentResponse`を使い、新しい通信channelやcollect方式を作らない。
- `v0/agent/worker/worker_host_journal.ts`: 必要なら既存のmessage→history
  event変換を小さな共通関数へ 切り出してrootとchildで共有する。root
  coordinator全体を子用に流用する大きなrefactorは行わない。
- `v0/agent/history/sqlite_history_v7_production_store.ts`: detail
  exportへ親に結び付く子executionを含める。
  既存record形式・保存schemaを使い、parent／childのattributionを保つ。
- 関連focused testと`deno.v0.json`のtask登録、本文書への結果記録。
  CLIの新しいoptionやTUIの表示部品は必要としない計画とする。

## 非対象

- 定期報告、push通知、collectのtimeout／yield、toolの並列実行、待機中の親model起動。
- 子への直接steering、子の中間finding報告、親turnをまたぐ子の存続、常駐Host化。
- S24のtool行へのrunId・task断片・agent対応表示、子の進捗のTUIへの直接表示、A14のmodel指定。
- raw
  request／response、SSE断片、parser内部遷移全文、thinking全文の新たな常設収集。
  API credential値とAuthorizationを記録・親contextへ露出しない。
- 新しいDB／schema、既存DBの削除、過去executionの欠けたfactの補完、migration／compatibility経路。
- 一般的なhardening、provider responseの新しい制限や拒否、retry／fallback。
- 構想・architecture・roadmapの修正。現行のHost所有・semantic履歴・派生projectionの責務で実現する。
  これらの正本に必要な意味変更が判明した場合は、対象・理由・変更内容を別途提示する。

## 実装計画

1. **A22の保存経路を成立させる。** 子の既存観測を既存history
   eventへ投影し、execution ID・ request
   ordinal・受信順を維持して保存する。通常のbatch保存とterminal前flushをつなぐ。
   model result・tool event・途中本文の既存保存contractに沿う。
2. **人間のreadbackを成立させる。** 親Sessionのdetail exportへ子を含める。
   完了した子と途中で停止した子の保存済みrequest
   factを、終了後の別processで読み出す。
3. **A20の取得経路を成立させる。** 同じ観測からsnapshotを更新し、既存status
   RPCとtool結果へ返す。 子が動いている間のstatus、tool終了後の更新、terminal
   stateとの対応を確認する。
4. **親の実際の利用を確認する。**
   spawn後に親が独立した作業を行い、statusから子の状況を報告してから
   collectする。collectの待機と最終結果を維持し、親のtool結果と子の履歴を照合する。
5. focused確認、必要なtype
   check・format・lint・`git diff --check`を実施し、結果・production観測・
   残る未確認事項を本書へ記録する。

## test計画（product動作との対応）

| 確認する動作                                                                  | 確認経路と根拠                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子のrequest順・step・HTTP／error・parse failure factが残る（A）               | 実Worker／Hostとproduction SQLiteを通すfocused確認。既存adapterが送るrequest／response／failure observationを使い、保存後にstoreを開き直して照合する。根拠は136で観測した子のHTTP fact欠落と既存observation型 |
| toolの実行中・終了と最終outcomeを追え、途中停止でも保存済みfactが残る（A・B） | 子toolを制御して実行中にstatus取得し、終了・停止後の状態と履歴を照合する。既存109／110／111の子Worker・cancel／settlement経路を使う。未観測provider variantのmatrixは作らない                                 |
| 親Sessionのdetailから子を読める（A）                                          | 親子executionを保存し、production history CLIのdetail出力で子のexecution ID・parentExecutionId・request factを確認する。別の親Sessionの子を混ぜず、親header／tailと通常会話の表示を維持する                   |
| snapshotが観測に沿って更新され、読み取りで時刻を変えない（B）                 | 制御した子request・toolの前後でstatus toolのJSONを取得。agent・phase・step・request ordinal・lastTool・更新日時を発生eventと照合する                                                                          |
| 親の独立作業→status→collectが成立する（利用者指定）                           | 親も実Workerで動かすfocused確認。子の起動後に親toolを実行し、status結果を次model requestで参照してからcollectする。collect後の親処理は子終了後になることを確認する                                            |

既存の`increment_109_async_subagent_test.ts`、`increment_110_async_child_contract_test.ts`、
`increment_111_async_child_evidence_test.ts`、`increment_131_generic_subagent_test.ts`、
`increment_134_production_text_test.ts`、`increment_99_history_cli_test.ts`の関係する経路を参照する。
新規focused
testは`increment_138_child_observation_test.ts`（仮称）へまとめ、必要な既存確認だけを選ぶ。
rootのevent変換を変更した場合は、その変更に対応するrootのrequest／tool保存も確認する。
fixture独自のresponse形式をproduct契約にせず、test件数を目標・完了条件にしない。

## production確認と承認境界

- 計画作成ではコード変更、test追加、gate、実provider callを行わない。
- local実装の指示後、隔離XDG・一時workspace・新規DBでproduction
  CLI／Worker／Hostを使う確認を行う。
  localhostの制御されたprovider応答で、子のrequest・tool待機中のstatusと親の独立作業、collect後の
  別processからの`history --session … --view detail`を通す。これは実provider受入とは区別する。
- 実provider受入候補は、親と`generic`子で、子にread等の短い作業を依頼し、親が独立した確認→status→
  中間報告→collectを行う一つのtask。既存観測元のprovider／modelを候補とするが、実施直前に
  対象provider・model・task・request回数の範囲・保存先を具体化して別途明示承認を得る。
- 実provider確認は隔離XDGのproduction
  TUIをtmuxで操作し、親のstatus結果・中間報告と、保存した子の request
  factをreadbackして照合する。実configへdefault selection等を書かない。
  子が早く終了して実行中snapshotを取得できなかった場合、その部分は未確認として報告する。
- 検証結果には確認した操作、観測、親子のexecution
  ID、request数、保存先を記録する。
  credential値・Authorization・raw通信は記録しない。
- `v0:gate`は本計画では必須にしない。別途要求された場合は安定候補へownerが一回実施する。
  review前のfull gateは要求しない。
- 実装指示、実provider確認、commit／push・配置・公開は今回の計画作成とは別の権限である。

## 未確認事項

- snapshot取得・子factの保存・CLI readbackは以下のfocused確認とlocalhost
  production確認済み。実providerでの実行中snapshot取得と受入は、後述の配置binary E2Eで
  bundled generic起動に失敗し、未確認のまま。
- child保存batchは既存の変換・保存方式に揃える。rootのExecutionJournalはactive
  root executionと
  coordinatorに依存するため、そのclass全体をそのまま子へ接続できるとは扱わない。
- 古い保存済み子executionには、観測されても保存されなかったHTTP
  factを後から復元できない。
- 既存eventから取得できるのはrequest・tool等の観測であり、review内容の進捗率や未報告findingではない。

## 計画作成結果

2026-09-27、current sourceで共通の観測入口、既存semantic保存contract、status
RPC、collectの逐次待機、 およびdetail
exportが子を選択しない点を確認した。A22→readback→A20の段階で一つのincrementへまとめた。
構想・architecture・roadmapは変更せず、通常利用メモから採用項目を移し、handoffには本書へのpointerを置いた。

## 実装・確認結果

### 計画レビューと実装指示

- 利用者指示で、独立したreviewerによる通常レビューと批判的レビューを実施した。
  いずれも必須findingなし。子の識別、既存観測、semantic保存、detail選択、statusとcollectの区別、
  product動作に対応する受入確認を照合し、実装へ進める計画と判断した。
- 同日、利用者の「実装してください」に従い、localコード変更・test追加・非破壊的な検証を実施した。
  新しい実provider callは行っていない。

### 実装内容

- `worker_host_journal.ts`のWorker観測からhistory
  eventへの変換を共通関数へ切り出し、rootとchildで共有。
  rootのevent変換・保存contractを維持した。
- `worker_host_children.ts`は子のprovider／context／semantic
  runtime観測を子executionへ保存する。 子ごとのbatchと既存のflush
  cadenceを使い、通常実行中とterminal前の双方でflushする。
  本文progressは既存storeの最新stateへ集約し、子のthinking本文を新たに保存しない。
- 保存失敗は既存outcomeのjournal durabilityとchild settlement
  errorへ記録し、Workerのexact outcomeと
  区別する。観測保存に失敗した後、terminal保存だけで完全な保存成功として返さない。
- 同じ観測からHost内のprogressを更新し、status
  toolへagent名・phase・更新日時・step・request ordinal・
  直近toolの実行中／終了とoutcomeを返す。statusの読取りだけでは更新日時を変えない。
  tool実行中の補助provider観測もtool
  phaseを維持し、terminalでは直近のstep・toolを残す。
- `streamHumanHistoryExport()`は親Sessionのexecutionへ結び付く子もdetailへ含める。
  header／tailは親を基準に維持し、通常のsession／canonical表示とrecall選択は変更していない。
- `increment_138_child_observation_test.ts`とfocused taskを追加。109のstatus
  fixtureは新しいstatus契約に 合わせた。DB
  schema、TUI表示部品、collect待機、tool逐次実行は変更していない。

### focused確認

- 新規3件が成功。実Worker／Host／production SQLiteとlocalhost
  Responsesを通して、
  親の独立read、子のmodel待ち／tool実行中status、同じ観測の再取得、終了後status、collect、
  store再読込と子detail exportを確認した。
- HTTP
  503と既存adapterの解析failure経路では、子のrequest・HTTP／error・解析項目と値の形が残った。
  これは制御された失敗応答による保存経路の確認であり、実providerの未観測variantを新仕様にしたものではない。
- 子の応答streamを開いたまま、通常cadenceで最新本文が保存されることを確認してからcancelした。
  最後の保存済み本文は一つだけ残り、request／HTTP factも残った。完了model
  resultは合成されなかった。
- 関係する既存確認44件も成功。109／110／111の子起動・並行実行・cancel・settlement、131のgeneric
  child、 99の履歴CLI、134の本文保存、137のroot Responses保存・表示を確認した。
- `v0:check`、変更source／testとconfigのformat確認、変更source／testのlint、`git diff --check`が成功。
  full gateは本計画で要求しておらず、実行していない。

### 隔離production TUI・CLI確認（localhost、2026-09-27）

- 保存先: `/tmp/henji-i138-production/`。一時workspace、隔離XDG、新規v11
  DB、sourceのproduction TUIを専用tmux socket
  `henji-i138`で使用した。外部providerへのrequestは0回。
  隔離configへ宣言型`i138-local` Responses providerと確認用default
  selectionを置いた。
- 親はspawn後に`read marker.txt`で独立作業を完了し、子のmodel待ちstatusとtool実行中statusを取得した。
  parentのassistant
  noteが両snapshotを中間報告し、`collect_subagent …`で子終了を待った。
  子toolの待機を解放後、collect結果と親の最終回答が正常に表示された。子のweb_fetch結果はsuccess。
- Session: `1357a06c-89c2-494a-b67b-2d11bfd61062`。 親execution:
  `fc84375d-a080-45ce-ac34-9c0bc5e30d2b`。 子run／execution:
  `ea383f7b-f9f2-4265-b1dd-011d60977d08`。
- request数は親5回＋子2回。子はstep 1／physical request 1、step 2／physical
  request 2で、双方HTTP 200。 別processのproduction
  `history --session 1357a06c --view detail`で親と子のexecution、request
  metadata、 step・順番・HTTP、tool
  call/resultをreadbackした。親header／tailのidentityも維持されていた。
- 証拠は`evidence/collect-pending.txt`、`completed.txt`、`status.json`、`history.jsonl`、
  `request-facts.json`。履歴はsemantic detailであり、raw
  request／responseやSSEのログは保存していない。
  保存履歴に確認用credential値とAuthorizationが含まれないことを照合した。
- 確認用TUIとlocalhost
  serverは終了した。実configへの変更、実provider確認、binary配置は行っていない。

### コード・testの第三者レビュー（2026-09-27）

利用者指示により、実装担当とは別のreviewerが対象コードとtestをread-onlyでレビューした。
必須findingなし。観測の受信順保存・通常batch・terminal前flush・保存失敗の反映、snapshot更新、
status読取りの時刻不変、collect/lifetime、detailの親子選択を確認した。
reviewerも新規focused 3件を独立実行し成功。testは実Worker・Host・production
SQLiteを通り、 具体的product動作に対応すると判断した。 補助provider
request中のtool phase維持と保存失敗時の扱いはsource確認に留まる。
実provider受入は未確認。review中にrepository変更・外部provider call・full
gateは行っていない。

### 確認範囲と承認境界

- local実装と上記の確認は済んでいる。利用者はこの確認範囲でincrementを完了とした。
  localhost確認を実provider受入済みとは扱わない。今後、実provider確認を追加する場合は、
  対象・回数・保存先を具体化して別途明示承認を得る。
- commit／push・常用binary配置と利用者の完了承認は済んでいる。公開は未指示・未実施。
  構想・architecture・roadmapは今回変更していない。

### Commit・push・常用binary配置（2026-09-27）

- 利用者のcommit／push・配置指示に従い、実装・test・task・本書・A20/A22の採用移動とhandoffを
  commit
  `560c4f6f02a0e68e8d549e635200b97b70fbfc58`へまとめ、`origin/main`へpushした。fetch後のlocal／remote一致を確認した。
  別件A21/A23の通常利用メモ差分とTypeScript調査文書は含めていない。
- push済みcommitのcleanなdetached worktreeからDeno 2.9.7でbuildした。product
  versionは0.7.0、 sourceは`560c4f6f…`（dirtyなし）、buildは
  `1a50c6c9a509019dabe6b8dc3a7cc99bb158c3ad97e30e88f2d57bdd16334232`。保存先は`/tmp/henji-i138-deploy-e_n8_rwx`。
- compiled候補で、localhost production確認済みの隔離Session
  `1357a06c-89c2-494a-b67b-2d11bfd61062`を別の隔離XDGへ複製し、production履歴CLIとtmux上のTUI復元を確認した。
  status・中間報告・collect・最終回答が復元され、detailから親子execution対応と子のstep1/2・
  physical request1/2・HTTP 200・tool結果をreadbackできた。追加provider
  requestは0回。
- 常用先`/home/agent/.local/bin/henji`へ原子的に配置した。候補と配置先のSHA-256はともに
  `f6f499aa86a6abe93c52db541c599ab71a2573d6d0d0df220f105e6b3371ed2e`で一致。version／source／buildも一致し、配置binaryのdetail
  readbackが候補と一致した。
- version・復元画面・semantic
  detail・照合結果は上記保存先の`evidence/`配下へ保存した。
  旧binaryは`henji.previous`へ保持。確認用TUIは終了し、build用worktreeは除去した。
- 稼働中のHenjiは切り替えておらず、新しいプロセスからこのbinaryを使う。実config・実DB・
  旧Sessionは変更していない。実provider
  call・JSR公開・構想/architecture/roadmap変更は行っていない。

### 利用者による完了承認（2026-09-27）

利用者が「インクリメントを完了とします」と明示し、Increment 138を完了とした。
実provider受入は未実施のまま、その確認結果を維持する。完了判断に新しいprovider確認・公開・
構想/architecture/roadmap変更は含めない。実装・配置commitと確認結果は上記を参照する。

## 配置binary・実provider E2Eの起動失敗（2026-09-27）

利用者の133〜138 E2E依頼と実provider許可に従い、配置済み`henji 0.7.0`（source `560c4f6f…`）を
tmuxで使用した。親子とも`openrouter-responses / xiaomi/mimo-v2.6-flash / auto`を指定。
親のspawnが`/tmp/deno-compile-henji/v0/agent/worker/worker_builtin_generic_definition.ts`の
realpathで失敗し、直後にTUIがterminal_failureで終了した。
親はcancelled、子はinterrupted。子のprovider requestは0回。
親Sessionのdetailには親子対応とadmission／settlementが残ったが、
実行中status、collect、子のrequest fact保存は未到達であり、実provider受入成功とはしない。

親子execution ID、current sourceの起動経路、修正案と証拠は
[合同E2E記録](e2e-133-138-2026-09-27.md#dで見つかった配置binaryの不具合)を参照する。
この失敗は下記の追加対応で修正した。以前のlocalhost／source確認と利用者の完了承認は履歴として維持する。

## 配置binary E2E失敗への対応計画（2026-09-27）

状態: 利用者の「138の失敗に対する対応を計画して」に従い作成。
本節は138の追加対応の計画と受入条件の正本。利用者の「では対応してください」と続く「承認します」に従い、
実装・検証・commit／push・常用配置と実provider再確認を進めた。実施結果は下記に記録する。
以前の完了承認とE2E失敗記録を維持し、今回の追加確認と分ける。

### 必要な動作と確認済み根拠

- 利用者が配置binaryのTUIからbundled genericを起動し、親の独立作業、実行中の
  `subagent_status`、中間報告、`collect_subagent`、最終回答まで完了できる。
- 起動した子のstep・physical request順・HTTPとtool結果を親Sessionのdetailから読み出せる。
  136のagent名表示もlive・履歴・TUI再開に残る。
- 子Definitionの事前読込みが失敗した場合は、既存のspawn errorと子interruptedを返し、
  親TUIと次の通常操作を継続できる。子起動失敗をHost全体の終了へ波及させない。
- 根拠は合同E2Eの配置binaryでのrealpath失敗、子request 0回、直後のterminal_failureと、
  以下のcurrent source。新しいprovider制約や一般的hardeningを追加する計画ではない。

### 原因と現行経路

1. `scripts/build_henji.ts`の`BUILTIN_DEFINITIONS`にはgenericがあるが、`ROOTS`にはない。
   genericは文字列で動的に選択され、runtimeの静的import経路にもない。
   `runtimeFiles()`がstagingへのcopyとruntime digestの対象を作り、
   `stagedCompileInputs()`が同じROOTSからcompileのincludeを作る。
   そのためmanifestにはgenericのrevisionがある一方、binaryにはentry実体が同梱されない。
2. `spawn_subagent`→`ChildRunRegistry.childOptions()`→`workerBuiltinModulePath('generic')`→
   `WorkerSupervisor.start()`→`readWorkerModuleRevision()`→`Deno.realPath()`で同梱漏れを検出する。
   sourceではcheckoutにentryがあるため、source起動や既存Sessionの復元だけではこの問題を検出できない。
3. `start()`はDefinition読込みより先にreadyPromiseを作る。読込みがthrowするとawaitまで届かず、
   子の清算で`terminate()`→`messages.fail()`が待機Promiseをrejectする。
   TUIはunhandledrejectionをcrash guardで捕捉して終了する。
   この経路はsourceで確認済みだが、今回の実終了の例外stackは未取得。
   実装前の局所probeで同じ事前読込み失敗と清算を通し、未処理rejectの発生を確認する。
4. 親子executionとsemantic履歴は既存Host／SQLiteが所有する。
   起動失敗時は子のadmission／interruptedが既に保存されている。
   今回はDB schemaや138のsnapshot・保存方式を変更する必要はない。

合同E2E記録にあった「compiled rootと同様の別descriptorを渡す」という初期案は採用しない。
rootも同じmodulePath読込みを使って正常起動しており、直接の修正はgenericの同梱漏れ解消である。

### 修正範囲

| 対象 | 変更する内容 | 利用者への結果 |
| --- | --- | --- |
| `scripts/build_henji.ts` | ROOTSへgeneric entryを追加し、既存経路でstaging・include・runtime digest・build inputへ含める | 配置binaryからinstall／bindなしでgenericを起動できる |
| `v0/agent/worker/worker_host_supervisor.ts` | Definition読込み後、start送信前にready待機を登録する。登録したPromiseは既存send失敗・ready失敗を含めstartの処理内でsettle／回収し、correlationを終了時に戻す | 起動失敗のerrorを返し、未処理rejectでTUIを終了させない |
| 関連focused test・compiled確認probe | 実際の事前読込み失敗と、sourceではなくcompiled genericの新規spawnを確認する | 観測済みの失敗を再検出できる |
| 本文書・合同E2E記録・handoff | 原因の精密化、確認結果、binary identity、残る確認を記録する | 再開時に確認済み範囲と次の一手が分かる |

既存のchild清算・spawn結果・interrupted保存・collect契約を使う。
Definition importerの置換、新しいdescriptor形式、全体のqueue再設計、fallback、retry、
DB変更、旧data削除、構想／architecture／roadmap変更、version変更・JSR公開は対象外。

### 実装と確認の順序

1. **起動失敗のPromise経路を局所再現する。**
   専用processで実WorkerSupervisorに存在しない確認用modulePathを渡し、start失敗後にterminateする。
   既存fileを削除して故障を作らず、実provider requestは0回。
   エラー種別と未処理rejectを確認し、TUI終了原因の未確認部分を解消する。
2. **同梱と起動処理を修正する。**
   ROOTSへgenericを追加。事前読込みをready待機作成より前へ移し、start送信前の待機登録は維持する。
   readyが即時に返る正常起動を取りこぼさず、登録したPromiseの失敗もstartの責任で処理する。
   子registryやTUIへ新しい例外抑制処理を重複追加しない。
3. **変更に対応するfocused確認を行う。**
   局所再現でstartの元errorを受け取れ、terminate後に未処理rejectがなく、processが次の処理へ進めることを確認。
   既存131のbundled generic起動、138の親独立作業→status→collect→detail、
   110の起動失敗保存・清算の関係する確認を選ぶ。
   既存32／78のstaging・build input確認も変更箇所に対応する範囲で使う。
   sourceでの成功を同梱確認の代替にしない。
4. **修正候補を一度buildし、compiled新規spawnを確認する。**
   production build scriptで一時binaryを作り、source起動を使わず、
   隔離XDG・新規DB・tmuxでlocalhost providerへ接続する。
   138の既存controlled応答を使う一つの親子taskで、子model待ち／tool実行中status、
   親read、collect、終了後status、親子detailを確認する。
   `--version`、source／build、SHA-256、genericを含むruntimeとmanifestの対応を記録する。
5. **配置後に実providerの基本ケースDを再確認する。**
   commit／push・常用binary配置の指示を受けた段階で、確認済み変更のcleanなcommitからbuild・配置する。
   配置先のversion・SHA-256を照合後、その配置binaryで下記1taskを実行する。
   候補で成功していても、配置binaryでの新規spawnとreadbackまで確認して結果を記録する。

変更source／testのformat・lint、必要なtype check、`git diff --check`を行う。
本計画はfull gateを必須にしない。133〜137の全ケース再実行も必須にせず、
変更に直接関係する正常起動・136表示・138の実経路を確認する。

### 配置binaryの実provider再確認案

- 引き継ぐmodel指定は`mimo-v2.6-flash`。既存の`openrouter-responses /
  xiaomi/mimo-v2.6-flash / auto`を親子とも使う。
- 親1turn・generic子1run。見込むphysical requestは親子合計8〜12回。
  確認用workspaceの子bashを約75秒待機させ、実行中statusを取得できる時間を作る。
  子には`timeoutMs=120000`を指定し、待機後にmarkerを読んで短く回答させる。
- 親はspawn→独立read→`subagent_status`→観測値の中間報告→collect→終了後status→final。
  前回promptの`get_subagent_status`誤記を修正する。
- 保存先案は`/tmp/henji-i138-recovery-*`。専用tmux socket・隔離XDG・新規DBを使う。
  request fact、tool結果、tmux capture、DB照合、別processのdetail、Session履歴とTUI再開を保存する。
  credential値とAuthorization、raw通信は保存しない。
- 子がstatus前に終了した場合は実行中snapshotを確認済みとしない。
  再試行を重ねて成功扱いにせず、実観測と残る確認を報告する。

### 受入条件と権限

- 修正版compiled／配置binaryの双方で、genericを新規起動して親子taskを完了できる。
- 実行中statusがgeneric・phase・step・request ordinal・lastToolを観測に沿って返し、
  collectは子の完了を待って結果を返す。終了後statusでも最後の観測が残る。
- 子のrequest順・step・HTTP 200とtool結果を、終了後の親Session detailから読み出せる。
  live・Session履歴・TUI再開でspawnのagent名と中間報告・finalを読める。
- 事前読込み失敗の局所再現で、errorと清算を維持したまま未処理rejectがなく、次の処理へ進める。
- 当初は計画作成のみだった。その後の利用者指示と承認で実装・検証・commit／push・常用配置・
  実provider再確認を実施する。対象は上記の基本親子task、保存先は下記。公開は対象外。
  実config・実DB・既存Sessionの変更・削除は行わない。


## 起動失敗への追加対応・確認結果（2026-09-27）

### 修正と起動失敗の再現

- buildのROOTSへbundled generic entryを追加した。同じ既存経路でstaging、compile include、
  runtime digestとbuild inputへ入る。DB schema・tool契約・provider parserは変更していない。
- WorkerSupervisorのDefinition読込みをready待機の作成より前へ移した。
  待機登録はstart送信前に維持し、send失敗時にrejectされた待機も回収する。
  correlationはsend／readyの失敗を含めfinallyで戻す。
- 実WorkerSupervisorへ存在しない確認用Definition pathを渡す独立processで、修正前は
  `Uncaught (in promise) Error: Worker host session closed`を再現した。
  修正後は元のNotFoundを受け取り、terminate後にも次の処理へ進めた。
  subprocess regressionを通常test taskへ登録し、fixture自身もtype checkする。
- focused確認は32・78・131・138と新しい起動失敗regressionで22件成功。
  110の実際のstartup failure保存・清算も1件成功。`v0:check`、変更TSのlint・format、
  `git diff --check`は成功。計画どおりfull gateは実施していない。

### 修正版compiled候補の新規spawn

保存先: `/tmp/henji-i138-recovery-hCmrJWoe`。production build scriptから一度buildし、
隔離XDG・新規DB・専用tmuxで実compiled TUIを使った。source起動や既存Session復元だけを
同梱確認の代わりにしていない。

- 候補は`henji 0.7.0`、source `b67553a7…+dirty`、build `51b813d5…`、
  runtime digest `c08405b373dbbf9f109ff33d8e9b8a4596c1faadb7069799e7908b47b42f01a2`。
- `local/`: localhostのcontrolled Responsesでinstall／bindなしのgeneric新規spawnを確認。
  Session `2419e818-dc0a-420f-a62e-ce66335d5766`、子
  `184c53fe-b8a2-4bbd-a9b3-972c803acaee`。
  親の独立read、model待ち→web_fetch実行中→settledのstatus、collect待機と完了、
  親子detail、generic名のlive・Session履歴・TUI復元が成功した。
  physical requestはローカル8回（親6・子2）。readbackによる追加requestは0回。
- `real/`: 親子とも`openrouter-responses / xiaomi/mimo-v2.6-flash / auto`で基本親子taskを実施。
  Session `d12b24c2-dbd3-4d73-8161-281c184048b7`、子
  `1aa985e8-301c-4e51-add9-b383956be3c8`。親と子はcompleted。
  実行中statusはmodel phase、step 1／request 1だった。観測値を中間報告に使い、
  collectの子結果、終了後statusのbash success、step 2／request 2を確認した。
  子2requestのHTTPはともに200。合計実requestは7回（親5・子2）。
  親がspawnとreadを同じstepで返したため、計画の見込み8〜12回より少なかった。
- 実taskの終了後、確認scriptが実行中phaseをtool限定で判定して止まった。
  観測されたmodel phaseも正しいstatusとして判定を修正し、完了済みSessionから同じ結果を
  readbackした。taskの再実行はしていない。Session履歴・別process detail・TUI再開が成功し、
  追加requestは0回。tool phaseは上記localhost経路で確認済み。
- 証拠は各`evidence/result.json`、statusとcollect、request fact、semantic detail、tmux capture。
  raw通信・credential・Authorizationは保存していない。実キー値が証拠・SQLiteにないことを照合し、
  隔離credentialは除去した。確認TUIとlocalhost serverは終了し、DBと履歴は保持した。

clean commitのbuild・常用配置と配置binaryの実provider確認結果は、次節へ記録する。
