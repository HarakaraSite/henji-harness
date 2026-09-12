# Increment 41 — durable active execution and live journal

ステータス: **調査・個別計画・第三者review完了（利用者承認待ち）**

基準commit: `daaef099`

対象機能: F04、F11、F15、F26

## 利用者が必要とする動作

- HostはWorkerへturnを配送する前に、taskとexecutionをSQLiteへ`active` / `non-canonical`として
  durableにする。このwriteが失敗したときはWorker、provider、toolを起動しない。
- active execution中にHostが受け取ったprotocol、assistant progress、tool call/progress/result、provider
  request/response/SSE/parser transition、cancel、commit proposal、settlementをexecution内の順序でappend-onlyに保存する。
- 正常完了、cancel、failureは既存のcanonical/non-canonical境界を維持しながら、同じactive executionを
  `settled`へ更新する。成功turnのcanonical commitは一回だけ行い、journalから会話をreplayして再構築しない。
- Host/processがactive executionの途中で停止した場合、次の起動は対象Sessionのwriter lockを取得した後だけ
  そのexecutionを`interrupted`または`unknown`へreconcileする。過去のcanonical conversationは変更せず、
  tool/provider effectを自動replayしない。
- reconcileしたexecutionとそこまでのpartial evidenceは`diagnostics`でreadbackでき、観測内容が
  存在する場合は人間が明示的に`/recall`のsourceとして選べる。sourceはnon-canonicalのままである。
- 同じSessionのwriter exclusionと異なるSessionの同時実行を維持する。workspace全体のsingle-process
  lockは追加しない。

## 根拠と確認済みの現在地

- architectureはdurable historyをHostが観測できたexecutionの入力、progress、assistant output、model request、
  tool call/result、provider evidence、outcome、context attributionと定義し、canonical conversationと分離する。
  executionの`lifecycle`、`outcome`、`conversation adoption`、`effect observation`は独立軸である。
- 採用済みprogramはIncrement 41で、provider/tool dispatch前のactive execution、Host-observed eventの順序付き
  保存、tool callごとの状態、Session lock内のrestart reconciliationを要求する。raw SSE/parser
  transitionと意味上のprogressのevent粒度は個別計画で決めることになっている。
- Increment 40でSQLite schema v1、canonical transaction、non-canonical settlement、post-commit observation、
  execution/evidence/diagnostic readbackを実装した。現在はtask/execution rowをsettlement時に初めてINSERTするため、
  dispatch後のsettlement前にprocessが停止すると実行中だった事実自体が残らない。
- Workerは`turn_start`、user/assistant message、assistant progress、tool call/progress/result、steering、`turn_end`を
  `runtime_event`または`effect_observation`として順序付きでHostへ送る。Hostはその順序番号を現在の
  execution artifactに保持せず、Host-local protocol traceもsettlement時までmemory上にある。
- provider evidence recorderはrequest、response header、exact response bytes、SSE frame、parser transition、runtime
  eventをWorker memoryに保持し、settlement時に一括でHostへ送る。raw provider observationはlive protocolを通っていない。
- tool callの`effect_observation`はWorkerがregistry dispatchの直前に`postMessage`するが、Hostのdurable appendを
  Workerがacknowledgeさせてからeffectを開始するbarrierではない。Increment 41のrecord-before-dispatch保証は
  execution全体のadmissionに置き、個別tool/provider effectはHostが実際に観測した状態だけを記録する。
- 現行のassistant progressはrequestごとに最大256 snapshot、tool progressはcallごとに最大64 snapshotである。
  evidenceでは最新snapshotへcoalesceするが、Host presentationは各accepted eventを観測する。
- 導入済みDeno 2.9.4 / SQLite 3.53.2と現行VM filesystemで、WAL、`synchronous=FULL`、一eventごとの
  `BEGIN IMMEDIATE` / commitを測定した。512-byte event 300件はp95 0.015 ms、16 KiB event 100件はp95
  0.045 ms、64 KiB event 40件はp95 0.084 msだった。これは現VMのlocal測定であり一般的なdisk性能は
  推定しないが、現行のevent上限で意味eventを個別commitする計画を拒む証拠はない。
- Increment 40のreal-provider受入で保存した6 evidenceは、requestごとにSSE 6〜131件、parser
  transition 8〜131件、完成JSON 26〜377 KiBだった。この実測と既存の4096 SSE event regressionを
  使い、live appendの追加latencyとSQLite write競合を実装時に確認する。

## 参照実装と採用範囲

- [Forge durable](https://github.com/NorviaLabs/forge/blob/d0bb0788e7c1fdfbe16291818c39293c1de755f7/crates/forge-durable/src/lib.rs)
  はSQLiteのappend-only eventにDB採番sequenceを付け、callerにtool/model side effect前のappend完了を要求する。
  tool intent/resultも別eventとして保持する。Henjiはappend-only、DB採番ordinal、未完了effectの検出を参考に
  するが、per-Session DB、全履歴replay、各effectのack barrier、checkpoint replay engineはそのまま採用しない。
- [OpenCode V2 Session specification](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/specs/v2/session.md)
  はlocal tool callをdurableにprojectしてから実行し、restart時に`running` toolをinterruptedとして、abandoned
  side effectを黙ってreplayしない。Henjiはinterrupted/unknownの区別とno-replayを採るが、durable inbox、
  context epoch、compaction event、provider向けhistory replayはIncrement 41に含めない。
- [OpenCode run coordinator](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/run-coordinator.ts)
  はkeyごとに実行を直列化し、異なるkeyは同時に実行する。Henjiは現行のper-Session advisory lockで同じ
  性質を維持し、workspace全体のcoordinator/lockは追加しない。
- 参照実装のSession全体event sourcingをHenjiの仕様にしない。Henjiのcanonical conversationは引き続き
  canonical transactionが正本であり、live journalはexecution observationとcrash reconciliationの正本である。

## Product contract

### 1. 破壊的schema v2 cutover

- `history.sqlite3`の`PRAGMA user_version`と`store_metadata.schema_version`を2に更新する。schema v1からの
  migration、ALTER、copy、compatibility read、dual-read/write、fallbackは実装しない。v1 DBは`history_invalid`として
  明示的に拒否する。
- v1 DBやそのWAL/SHMを自動削除・置換しない。Increment 41のproduction受入は空のisolated XDG
  stateで行う。実dataの削除や新しいstate rootへの手動切替は利用者が別途指示する。
- schema v2ではIncrement 40のtableを維持し、`executions`のactive lifecycleを使用可能にし、
  `execution_events`と`execution_effects`を追加する。execution artifact/provider evidence codecもv2の
  interrupted/unknown/partial contractに合わせた新schemaのみを生成・読込する。
- `lifecycle=active`のexecutionは`session_correlation`ごとに最大一件とするpartial unique indexで、
  per-Session/no-session execution lockと同じ所有境界をDB側でも検証する。
- `executions.outcome`はdurable lifecycle向けに`unknown | completed | cancelled | failed | interrupted`へ正規化し、
  provider/loop固有の`final | tool_terminal | max_steps | contract_failure | cancelled`は`outcome_json`に保持する。
  `final` / `tool_terminal`はcompleted、`cancelled`はcancelled、`max_steps` / `contract_failure`はfailedへ写像する。
- schema v2の`executions.outcome_json`はnullableとする。active/unknown/interruptedのように完成した
  `LoopOutcome`を観測していないexecutionは`NULL`とし、正常settlementで実在する`LoopOutcome`を
  validateできた場合だけ必須とする。reconciliationは既存のterminal reasonやtranscriptを擬制しない。
- `ProviderEvidenceV4`は`capture: complete | partial`とdurable outcomeを持ち、completeは現行V3の完成した
  request/response/runtime evidenceを維持する。partialはjournalから実在を証明できるrequest、response
  bytes/SSE/parser/runtime eventだけをordinal順に構成する。
- `WorkerExecutionArtifactV4`はnormalized lifecycle/outcome/adoptionと`interrupted | unknown`のsettlementを表せる。
  reconciled artifactのprotocol/effect/evidenceはjournalに残った事実だけを参照し、完成済みLoopOutcomeを擬制しない。
  schema v2 DBはV4 codecだけを生成・読込し、過去codecのcompatibility readを持ち込まない。

### 2. active execution admission

- `beginExecution(input)`は、task、`lifecycle=active`、`outcome=unknown`、`adoption=non_canonical`のexecution、
  execution ordinal 1の`execution_admitted`、必要なら空のSession rowを一transactionで保存する。
- 新規persistent Sessionの最初のturnは、active executionと同時にempty Sessionをmaterializeする。これにより
  first turn中のcrash/failure後もSession list/exact reopenからreconciliationに到達できる。allocateだけの
  Sessionは従来どおりlistしない。materializationは既存のworkspaceあたり256 Session capacityを維持する。
- Hostは`beginExecution`のcommit後だけWorkerへ`turn`を送る。send前の`turn_dispatch_requested`はbegin
  transactionに含め、send成功後に`turn_dispatch_sent`、失敗後に`turn_dispatch_failed`を追記する。
  requestedのみでsentがないcrash窓は、配送有無を推測せず`unknown`へreconcileする。
- active rowと入力の保存が失敗したらturnをdispatchせず、typed history failureをSurfaceへ返す。存在しない
  executionをsettleしたことにしたりsynthetic artifactを作らない。

### 3. append-only live journal

- `execution_events`は`(execution_id, ordinal)`をprimary keyとし、Hostがtransaction内で次ordinalを採番する。
  `observed_at`、direction/source、event kind、nullableなWorker sequence、discriminated-unionでvalidateしたexact payload
  JSONを持つ。existing eventをUPDATE/DELETEしない。
- Worker由来の`runtime_event` / `effect_observation`は、同じexecutionの直前Worker sequenceより大きいことを
  確認し、Hostが受信した順にappendしてからpresentationまたはsettlement処理へ渡す。Hostからの
  dispatch、cancel、steer、commit/checkpoint acknowledgementはrequested/sent/failedを区別して記録する。
- meaning eventはacceptedされた`turn_start`、user/assistant message、assistant progress、tool
  call/progress/result、steering、turn outcomeを一件ずつ保存し、progressを最新snapshotへcoalesceしない。
  新しいevent数/文字数上限は追加せず、現行loop/provider contractのvalidationと上限を使う。
- provider evidence recorderにcredential-freeのlive observation sinkを追加し、request start、response start、exact
  response byte chunk、SSE event、parser transitionをWorker protocolへ逐次渡す。request headerとcredential/
  Authorizationは型自体に含めない。exact response byte chunkはbase64で保存し、UTF-8 text、SSE frame、
  parsed detailは現行evidence contractのまま保持する。
- provider raw eventもHostがprotocol messageとして受信した単位ごとにappendする。Workerがまだ送っていない
  memory上のobservationはdurableと主張しない。settlement時はjournalのpartial eventとWorkerから受け取った
  final evidenceを次の正規化規則で照合し、既存のprovider evidence rowを完成版の正本として保存する。
  request identityとSSE/parser/request eventはordinal順、response chunkは連結後のexact bytesと各chunkの
  cumulative offset、assistant progressはrequestごと、tool progressはcallごとの最後のsnapshotを比較する。
  journalの全progress/chunk数とcoalesce/連結後のfinal evidenceの配列数は直接比較しない。
- 各appendは短い`BEGIN IMMEDIATE`とし、250 ms busy contractを維持する。append失敗後に通常実行を
  成功扱いせず、executionがactiveな間の失敗ならHostはactive turnのcancelを要求し、canonical
  adoptionを拒否する。保存が復旧していればnon-canonical failureへsettleし、それも失敗すれば
  active rowを次起動のreconciliation対象として残す。canonical transactionがcommitした後の
  acknowledgement sent/failed等のjournal append失敗はpost-commit observation failureであり、既に確定した
  canonical turnをrollback、拒否、または二重settleしない。Surfaceにはcanonical commit済みとobservation
  failureを区別できる既存のpost-commit結果を返す。

### 4. tool effect projection

- `execution_effects`は`(execution_id, call_id)`をkeyとし、tool name、requested/progress/completed event ordinal、
  result outcome、`observed_requested | observed_progress | completed | outcome_unknown`を持つ。これはjournalから作る
  query projectionであり、event payloadの正本性を置き換えない。
- Workerの`tool_call`は物理dispatch直前に送られるがHostのappend ack barrierではないため、
  durable rowを`started`と断定せず`observed_requested`とする。resultがdurableな場合だけ`completed`とする。
- reconciliation時にresultのないtoolは`outcome_unknown`とし、error resultを捨てて成功と推定したり、
  toolを自動再実行したりしない。外部effectのrollbackも行わない。

### 5. normal settlementとcanonical commit

- Increment 40の`commitCanonicalTurn` / `settleNonCanonicalExecution`は新しいtask/executionをINSERTせず、
  `beginExecution`が作成したactive rowのidentity、correlation、base revision、attributionを照合してUPDATEする。
- canonical commitはexecutionをsettled/completed/canonicalへ変更し、canonical turn/messages、Session revision、
  final evidence/diagnostic、`execution_settled`を従来と同じ一transactionで確定する。post-commit
  observationのcanonical保持はIncrement 40の契約を維持する。
- cancel/failureはactive rowをsettled/non-canonicalへ変更し、final evidence/diagnostic/artifact、effect projection、
  `execution_settled`を一transactionで確定する。duplicate settle、既にreconcile済みのexecution、別generation/
  revisionからのcommitは拒否する。
- normal settlementではWorkerのfinal evidenceをprovider evidenceの完成版正本とする。journal eventは観測順序の
  正本であり、canonical transcriptやprovider request projectionをjournal replayで生成しない。

### 6. restart reconciliation

- persistent Sessionの`openExistingWorker`はper-Session advisory lockを取得し、Session recordを返す前に同じ
  `session_correlation`のactive executionを最大一件reconcileする。activeが複数あるDBはinvalidとし、
  時刻やrow orderからownerを推定しない。
- `turn_dispatch_sent`がdurableなexecutionは`interrupted`、requestedのみまたはsent/failureが不明なexecutionは
  `unknown`とする。reconciliation自体を最後のjournal eventとしてappendし、executionとpending tool effect、
  partial provider evidence、execution artifactを一transactionでsettleする。
- partial provider evidenceとexecution artifactは新codecで`capture=partial`、outcome/settlementを
  `interrupted | unknown`とし、journalから証明できる観測だけを保持する。未観測のassistant text、
  tool result、provider terminal状態を補完しない。
- 新規first turnの前にempty Sessionがdurableなため、crash後はSession list/exact reopenがそのSessionに
  到達できる。reopenしたWorkerは既存のcanonical revisionだけから開始し、interrupted taskを自動再送しない。
- `--no-session`のactive executionはexecution IDごとのno-session advisory lockをprocess lifetime中保持する。
  Hostはexecution IDを決めた後、`beginExecution`より前にこのlockを取得し、active rowが見える時点で必ず
  live ownerがlockを保持しているようにする。begin失敗時はlockを解放する。
  次のproduction history initializationは`canonical_session_id IS NULL AND lifecycle=active`だけを走査し、
  そのlockを取得できた場合にreconcileする。lockがbusyな別processのactive executionは変更しない。
- reconciliation writeは対象Session/executionのlockの内側で行い、SQLite transaction自体は短く保つ。
  workspace全体lock、process PIDの推定、time-based lease/timeoutは追加しない。

### 7. diagnosticsと`/recall`

- `henji diagnostics executions list/show`はartifactのみではなくexecution rowを正本にし、active、completed、
  cancelled、failed、interrupted、unknownのlifecycle/outcome/adoptionをreadbackできる新schemaへ破壊的に切り替える。
- `henji diagnostics executions events --id <execution-id>`を追加し、DB ordinal順のraw journalをcredential-free
  JSONでreadbackする。人間向けtimeline/renderer、検索、full-history exportはIncrement 43のままである。
- `RecalledExecutionContextV2`を導入し、sourceのnormalized outcomeと`complete | partial`、
  `cancelled | failed | interrupted | unknown`を擬制なく表す。既存のcancelled/failedのsettled non-canonical
  sourceも引き続き明示選択できる。active/canonical executionはsourceにしない。
- settled interrupted/unknown executionにpartial assistant/tool/provider observationがあれば、`/recall`は現行Sessionの
  明示選択sourceとして扱う。projectionはjournalから証明できるuser/assistant/tool runtime eventに加え、
  provider-only sourceにはrequestのprovider/model/effort、request start、response start/status、受信済みbyte数、
  SSE/parserの最後に観測したevent/state、terminal未観測を明示する構造化summaryを含める。raw
  response bytesを会話textと推定せず、内容のないprojectionを生成しない。自動選択、resume、replay、
  canonical adoptionはしない。target executionのprojection attributionはIncrement 40のrelationを維持する。
- active executionは観測中としてdiagnostics readback可能だが、settled sourceではないため`/recall`対象にしない。

## 実装slice

### Slice A — schema v2とjournal port

1. schema v2、active execution invariant、nullable `outcome_json`、`execution_events`、`execution_effects`、
   新しいexecution/evidence/artifact/recall codecとread modelを実装する。v1は移行せず明示的に拒否する。
2. `beginExecution`、`appendExecutionEvent`、active rowを更新するcanonical/non-canonical settlement、
   `reconcileExecution`を追加する。
3. event ordinal、Worker sequence、correlation、tool projection、final evidenceとlive observationの正規化後の
   整合性を各write時にvalidateする。

### Slice B — Host/Worker live observation

1. `WorkerHostSession.runTask`をbegin-before-sendに切り替え、dispatch requested/sent/failed、cancel、steer、
   acknowledgement、Worker messageを同じexecution journalへ追記する。
2. provider evidence recorderのcredential-free変更eventをWorker protocolでHostへ渡し、response bytes、SSE、
   parser transitionを観測順にappendする。
3. active中のjournal persistence failureに対するcancel、canonical rejection、settlement/reconciliationへの移行と、
   canonical commit後のpost-commit observation failureを区別して実装する。
4. normal canonical/non-canonical settlementをactive rowのupdateへ変更し、Increment 40のcanonical/post-commit
   invariantを維持する。

### Slice C — restart reconciliationとreadback

1. persistent Session openのper-Session lock内reconciliation、new first-turn empty materialization、no-session
   per-execution lockとdetached reconciliationを実装する。
2. partial provider evidence、interrupted/unknown execution artifact、pending tool effectの`outcome_unknown`をmaterializeする。
3. diagnostics execution list/show/eventsの新read modelと、`RecalledExecutionContextV2`によるsettled
   cancelled/failed/interrupted/unknown sourceの明示的`/recall`を接続する。

### Slice D — stable candidateとproduction受入

1. READMEにactive/interrupted/unknown、raw journal diagnostics、no-replay、schema v2の破壊的cutoverを記載する。
2. focused test、関連regression、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を完了する。
3. stable candidateに対するauthoritative `v0:gate`を一回だけ実行する。
4. isolated XDG rootとstandalone real TTY/processを使い、live readback、強制停止、reopen reconciliation、
   no replay、`/recall`、異Session concurrencyをproduction経路で確認する。

利用者承認後はSlice A〜Dを継続し、下記Human Gateまたは停止条件でだけ利用者へ戻す。

## Verification

新しい`tests/v0/increment_41_live_execution_journal_test.ts`とfocused taskで、次のproduct動作を確認する。

- begin transaction完了前にfake/real Workerがturnを受け取らない。begin write失敗でtask/execution/eventの
  partial rowを残さず、provider/tool dispatch countが0のままである。active executionは
  `outcome_json IS NULL`で、完成した`LoopOutcome`を擬制しない。
- new first turnのactive transactionはempty Sessionをmaterializeし、allocateだけのSessionはlistに現れない。
- assistant progress、tool call/progress/result、provider response chunk/SSE/parser transitionを発生させ、DB ordinal順の
  exact payload、Worker sequence、tool projection、credential/Authorizationの非存在を確認する。現行の1 MiB超/
  4096 SSE event経路でも最後のeventとterminal evidenceまで到達する。複数response chunkは連結
  bytes/offset、複数progressはrequest/callごとの最後snapshotでfinal evidenceと照合できる。
- normal canonical commitがactive rowを一回だけsettleし、canonical turn/messages/revision/final evidenceと
  `execution_settled`をatomicに確定する。ack delivery failureまたはcommit後のjournal append failureはcanonicalを
  rollback/拒否/二重settleせず、post-commit observation failureとしてSurfaceで区別できる。
- cancel/failureがactive rowをnon-canonicalへsettleし、過去canonical transcriptを変更しない。journal write failureで
  canonical adoptionせず、保存不能が継続したactive rowは次起動でreconcileできる。
- 別processがactive persistent Sessionのlockを保持中はreconcileできず`session_busy`となる。process強制
  終了後のexact reopenで、dispatch sentありは`interrupted`、sent不明は`unknown`、pending toolは
  `outcome_unknown`となる。canonical revision/messageは不変で、provider/toolの自動再送は0回である。
- no-session processのactive executionは、live lock中に別processから変更されず、強制終了後の次回
  production initializationでreconcileされる。
- diagnostics execution list/show/eventsがactiveとreconciled execution、partial evidence、event ordinal、effect statusを
  readbackできる。reconciled provider-only sourceの`/recall`は観測済みmetadata/count/last stateと
  terminal未観測を次taskだけへ投影し、raw bytesを会話textに推定せず、sourceをcanonical化しない。
  既存のcancelled/failed sourceも引き続き選択できる。
- 異なる二Sessionのactive append/settlementが同時に成立し、250 ms超過はtyped busy/no-partial-writeとなる。
- schema v1 DBが`history_invalid`となり、移行・copy・削除・旧store fallbackが発生しない。

実装中はIncrement 41 focused testと、変更する具体的経路に対応するWorker foundation、provider stream、
Increment 38 recall、Increment 39 cancellation、Increment 40 SQLite historyを必要時に実行する。stable candidate前に
`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を行い、authoritative `v0:gate`は一回だけ実行する。

## Production Human Gate

- empty isolated XDG stateとcandidate standaloneでSessionを作り、長いreal-provider turnまたはlong-running toolを
  起動する。別processの`diagnostics executions list/show/events`からactiveと増加するeventをreadbackする。
- activeなprocessを強制終了し、同じSessionをexact reopenする。前executionが`interrupted`または`unknown`に
  settleし、pending tool effectが`outcome_unknown`、canonical conversation/revisionが不変、過去taskが自動送信
  されないことを確認する。
- reconciled executionのpartial observationを`/recall`して新しいtaskを一回だけ実行し、targetだけがcanonical
  commitされることを確認する。
- two real TTY/processで異なるSessionのturnを重ね、live journalとsettlementの双方が完了することを
  確認する。focused別Worker probeの250 ms超過type busyも受入証拠へ添える。
- candidateへschema v1のcopyを渡し、`history_invalid`となる一方でDB bytesが変わらず、移行、自動削除、
  旧JSON fallbackが起きないことを確認する。
- 受入は一時binary/stateだけを使い、installed binaryを置換しない。credential値とAuthorizationは記録しない。

## 完了条件

- dispatch前のactive executionとtaskがdurableで、begin失敗時にprovider/toolが起動しない。
- Host-observedのmeaning/protocol/provider eventがexecution-local ordinal順にappend-onlyでreadbackでき、toolごとの
  completed/outcome-unknownを区別できる。
- normal settlementがactive executionを新規作成せず同じidentityでsettleし、canonical transactionのatomicityと
  post-commit observation境界を維持する。
- process停止後のSession/no-session executionがlock内でinterrupted/unknownへreconcileされ、partial evidenceと
  effect unknownをreadbackでき、自動replay/canonical adoptionを行わない。
- 新規first-turn Sessionがcrash後にlist/reopen可能で、異なるSessionの同時実行を維持する。
- schema v1を移行・変換・削除せず明示的に拒否し、旧storageへfallbackしない。
- focused・関連検証、check/format/lint、`git diff --check`、一回のauthoritative `v0:gate`、standalone
  production Human Gate、最終差分reviewが完了する。

## 対象外

- schema v1 DB、旧JSON、過去Session/evidence/artifactのmigration、conversion、compatibility read、fallback、自動削除。
- 各tool/provider dispatchが個別のdurable appendをacknowledgeされるまでI/Oを停止するper-effect barrier。
  Increment 41の先行保証はexecutionのadmissionまでである。
- interrupted tool/provider effectのresume、retry、replay、rollback、冪等性制御、過去の外部環境の再現。
- instruction、skill、tool contract、runtime factのexact context attribution/content snapshot（Increment 42）。
- human-friendly timeline、keyword検索、full-history export、TUI history view（Increment 43）。
- `/rebuild`、`AgentContextGeneration`、Worker replacement/resource activation（Increment 44以降）。
- durable user-input inbox、background execution、tool並列化、approval/HITL、remote/cluster owner lease、PID/time-based fencing。
- architecture、構想、roadmap、installed binary、commit、push、tag、publish、releaseの変更。

## 第三者review

2026-09-13に現行source、参照実装、破壊的schema v2、event粒度、reconciliation/no-replay、
Session/no-session concurrency、partial evidence/recall、production Human Gateを対象に30分上限のread-only
reviewを実施した。Blockerはなく、次のP1 4件を採用して本計画へ反映した。

1. active/interrupted/unknownに完成済み`LoopOutcome`を擬制せず、schema v2の`outcome_json`をnullableにする。
2. canonical rejectionをactive中のjournal failureに限定し、commit後のjournal failureはcanonicalを維持する。
3. final evidenceとjournalの照合をresponse byte連結/progress最終snapshot/SSE・parser ordinalに正規化する。
4. `RecalledExecutionContextV2`とprovider-only partial observationの構造化projectionを定義する。

変更箇所と既存findingの解消に限定した15分以内のre-reviewで、4件の解消と新しい
Blocker/P1がないことを確認した。本計画は利用者承認候補である。reviewerはファイル変更、test、
full gateを行っていない。

## Human Gateと停止条件

- この個別計画の実装には利用者の明示承認を必要とする。
- 承認後はSlice A〜Dを継続し、per-effect durable ack barrierが必須と判明する、現行SQLiteの
  一eventごとのcommitが実経路でprovider/toolを利用不能にする、またはarchitecture、roadmap、対象機能、
  外部contract、受入水準を変える必要が判明した場合に停止して証拠と代案を利用者へ返す。
- production Human Gateでreal-provider credentialを利用できなければ、credential値を読まずavailabilityだけを
  報告し、provider-free fixtureで完了扱いに置き換えない。
- repository外のinstalled binary置換、commit、push、tag、publish、releaseは別の利用者指示を必要とする。
