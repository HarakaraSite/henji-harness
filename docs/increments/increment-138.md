# Increment 138 — 子Agentの作業状況取得とrequest factの保存・readback（A20・A22）

状態: local実装・focused確認・隔離production
TUIでのlocalhost確認済（2026-09-27）。
利用者がA20・A22をまとめて次のincrementへ採用し、計画レビュー後に実装を指示した。
実provider受入、公開、完了承認は未実施。commit／push・常用binary配置は同日利用者が指示し、実施中。
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
  production確認済み。 実providerでの実行中snapshot取得と受入は未確認。
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

### 残る受入と承認境界

- local実装と上記の確認は済んでいる。localhost確認を実provider受入済みとは扱わない。
  実providerでの実行中status取得・中間報告・子request fact
  readbackは、対象・回数・保存先を具体化して 別途承認を得てから実施する。
- commit／push・常用binary配置は同日利用者が指示し、実施中。公開、完了承認は未指示・未実施。
  構想・architecture・roadmapは今回変更していない。
