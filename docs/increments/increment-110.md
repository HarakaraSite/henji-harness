# Increment 110 — async child run contractの収束

ステータス: **実装・検証・commit・push完了**

計画日: 2026-09-22
完了日: 2026-09-23

関連: Increment 107（async run contract）、Increment
108（Host責務分割）、Increment 109（async child V1実装）、
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 目的

Increment 109のproduction経路を、Increment
107/109で確定済みのparent-execution-scoped one-shot fork/join契約へ
収束させる。新しいsubagent機能は追加せず、managed child・tool binding・durable
admission/settlement・parent境界・cancel/close
cleanupを実際のHost/Worker経路で成立させる。

利用者が必要とする動作は次のとおり。

1. `agent:<name>`で選ばれたmanaged childがexact Definition
   revisionから起動する。
2. childはHostが解決済みのexact tool Definition bindingを使い、bundled
   definitionへ黙って差し替わらない。
3. spawnはchild executionのdurable admission完了後だけ成功し、collectはdurable
   terminal settlement完了後だけterminal resultを成功として返す。
4. status/collect/cancelはspawn元のparent
   execution内だけで使え、後続turnから過去runをmailboxとして使えない。
5. parentの正常settle、failure、cancel、forced interruption、Session
   close、Worker generation replacementでは、
   未完了childをcancelし、期限内にterminalへ到達しなければterminateして`interrupted`としてsettleする。
6. child cleanup failureは観測可能にするが、有効なparent canonical
   commitをrollbackしない。
7. `collect_subagent`待機中にparentがcancelされた場合、親Workerのpending
   RPCが解放され、parentとchildが上記契約で収束する。

## 根拠と確認済みの不具合

2026-09-22の`28eeba11^..8ab22841`に対する自己reviewと独立review、およびcurrent
sourceの再確認で、次を確認した。

1. `worker_tui_session.ts`は`resolveAsyncAgentModule`を構築するが、`ExecutionCoordinator`はそれを
   `ChildRunRegistry`へ渡していない。productionのmanaged
   childはresolverを一度も呼ばず起動に失敗する。
2. childの`toolDefinitions`は親Hostが解決した`options.toolDefinitions`ではなく、常にbundled
   definitionsから 再生成される。`tools.json`のexact
   bindingと追加toolがchildから失われる。
3. `HistoryPersistencePort.beginExecution`は`void | Promise<void>`で、production
   store実装は`Promise<void>`を返すが、 child
   spawnはawaitしていない。admission失敗を捕捉できず、durable
   admissionより先にspawn成功を返し得る。
4. terminal時の`settleNonCanonicalExecution`例外を捨てた後でwaiterを解放するため、durability失敗時にもcollectが
   successを返す。
5. status/collect/cancelはregistry全体を`runId`だけで検索し、terminal
   runも残り続ける。後続parent executionが
   過去runを参照でき、V1で対象外としたcross-turn mailboxになる。
6. `cancelAll()`はcancel送信だけの同期APIで、coordinatorのparent
   settle/closeはchild terminal、durable settlement、 supervisor
   terminationを待たない。closeには同じ呼出しが重複している。
7. startup
   failureはmemory上の`failed`だけを設定し、admission済みexecutionをsettleせず、部分起動したsupervisorも
   terminateしない。terminal metadataに解決済みparent
   idでなくoptional引数を使う経路もある。
8. Worker側のasync-agent
   RPC待機は`AbortSignal`を監視しないため、`collect_subagent`中のparent
   cancel後もpending promiseが残る。
9. childの`interrupted`
   terminalを現行の`settleNonCanonicalExecution`へ渡すと、storeが非completed／非cancelledを
   一律`failed`へmapするため、durable readback上の`interrupted`が失われる。
10. `agent:planner`はparent-roleのmanaged
    bindingがbundled既定に優先するが、childのmodule、history agent label、
    Worker root role、初期model selectionはexact
    refでなく`entry.name === 'planner'`だけから選ばれる。managed planner
    bindingでもbundled planner code/role/modelを実行し、evidenceにはmanaged
    refを記録する不一致になる。

これらは一般的なhardeningではなく、Increment
107/109の明示契約とproduction経路を直接破るcorrectness問題である。

## 確定する実装方針

### 1. Host解決済みauthorityの伝播

- `ExecutionCoordinator`は`options.resolveAsyncAgentModule`を`ChildRunRegistry.resolveManagedModule`へ渡す。
- child startには`options.toolDefinitions`のexact refs/load
  descriptorsをそのまま渡す。child側でbundled一覧を 再解決しない。production
  Hostが未解決のtool authorityを暗黙補完するfallbackは追加しない。
- module選択はagent名ではなくexact refで行う。catalog refがexact bundled planner
  refと一致する場合だけbuiltin module pathを使い、planner history label／Worker
  root role／planner modelを選ぶ。同じ`agent:planner`名でもmanaged refなら
  resolverからload descriptorを得て、parent/default history label／Worker root
  role／root modelを選ぶ。Definition code、 role/model、evidenceのexact
  refを同じprovenanceから決める。model routingの種類自体は変更しない。

### 2. parent executionによるaddressability fence

- `ChildRunRegistry.handle`は全操作でcurrent
  `parentExecutionId`を必須authorityとして扱い、runに記録された
  `parentExecutionId`との完全一致を確認する。active parent
  executionがないrequestも拒否する。
- parentのsettlement開始時に、そのparentに属するrunをmodel-visible操作から閉じる。同じparent内では既存どおり
  statusとcollectを利用でき、terminal
  resultの同一parent内collectはidempotentとする。
- durable child execution
  rowは履歴証拠として残すが、後続turnからstatus/collect/cancelできるmailboxにはしない。

### 3. admissionとterminal durability

- spawnは`await history.beginExecution(...)`を完了してからWorkerを起動し、admission失敗時はrunをaddressableにせず
  errorを返す。
- runは共有するadmission promiseとcancel/close intentを持つ。parent
  cleanupが`starting`中に始まった場合は同じ admission promiseへjoinし、late
  admission成功後もWorkerを起動せず`cancelled`としてsettleする。spawn requestへ
  successを返さない。admission失敗時はsettlementを試みず、runを閉じて同じ失敗をspawn/cleanupへ返す。
- memory上のsemantic terminalとdurable
  settlement完了を別状態として管理する。waiterはsemantic terminalだけで collect
  successにならず、`settleNonCanonicalExecution`成功後にだけdurable terminal
  resultを受け取る。
- `status`もdurable terminal completion後だけterminal
  stateを返す。childが実行中なら`running`、semantic terminal後に
  settlementが未完了または失敗した場合はerror
  responseとし、`completed`／`failed`／`cancelled`／`interrupted`を lifecycle
  settledより先に観測させない。
- child message、explicit cancel、cleanup期限超過が競合しても、semantic
  terminalはsingle-assignment、durable
  settlementはexactly-onceとする。遅着したterminal
  messageは既に確定したstateを上書きしない。
- settlement失敗はasync-agent error responseとしてcollect/cancel/parent
  cleanupへ返し、成功結果へ変換しない。 retry/replayはIncrement
  109で対象外のため自動retryは追加しない。
- durable admission後のstartup failureは`interrupted` terminalとしてnoncanonical
  settlementし、生成途中を含む child supervisorを必ずterminateする。terminal
  correlationにはrunへ確定保存したparentExecutionId/spawnCallIdを使う。
- child
  `interrupted`は`LoopOutcome.stopReason='interrupted'`として渡し、production
  history storeの noncanonical mappingもdurable
  `outcome='interrupted'`を保持するよう修正する。
- history storeが無いprovider-free test seamではmemory
  terminalを完了境界とできるが、productionで
  `historyPersistence`がある場合のdurability条件を緩めない。

### 4. await可能なparent cleanup

- `cancelAll()`を、parent idとsettlement期限を受けて結果を返すawait可能なcleanup
  APIへ置き換える。
- 対象parentの未完了childへcancelを送り、semantic terminal、durable
  settlement、supervisor terminationまで待つ。
  `cancelSettlementGraceMs`の期限を超えたchildはsupervisorをterminateし、`interrupted`としてsettleする。
- parentの正常settle、failure、cancelの全出口は、parent
  outcome/adoption候補の検証後、parentのcanonical commitまたは noncanonical
  settlementより前にcleanupをawaitする。cleanup failureをparent
  artifactへ付けたうえで、validなparent proposalは予定どおりcanonical
  commitし、cleanup failureを理由にrollbackまたはnoncanonical化しない。
- cleanup待機後、canonical commitの直前にparent fenceを再検証する。cancellation
  requested、forced interruption、 pre-commit journal failure、active
  execution/correlation/generationの変化、proposalの失効があれば古いproposalを
  canonical採用せず、その時点のcancelled/interrupted/failed
  outcomeとしてsettleする。cleanup待機中の利用者cancelを cleanup
  failureと混同しない。
- forced interruptionではroot Worker terminateとinterruption
  flag設定までをwatchdogで行い、parent historyの `reconcileExecution`はchild
  cleanup後のcoordinator settlementへ移す。pre-commit journal
  failure経路も同じ順序へ揃える。
- `close()`は全未完了childに同じcleanupを一度だけ行ってからroot
  supervisor/session handleを閉じる。
- submit finalizationと`close()`が競合しても、parent idごとの共有cleanup
  promiseに合流し、cancel、terminal確定、settlementを
  二重実行しない。`close()`はcleanup failureを返す場合もroot supervisor/session
  handleを必ず閉じる。
- root Worker generation replacement/forced
  interruptionでは、そのgenerationのactive parentに属するchildを同じ
  cleanup経路へ送る。新generationへrun addressabilityを引き継がない。
- cleanup結果にはrunId、最終state、durability成否、errorを含める。`WorkerExecutionArtifactV7`へoptionalな
  `childCleanup` observation（versioned
  data、対象runごとのstate/durability/error）を追加し、active parentではcleanup
  完了後のsettlement/final artifactに保存する。model-visible parent
  outcomeとcanonical adoptionは変えない。既存artifactの readbackを保ち、SQLite
  schema versionは変更しない。active
  parentがない`close()`で失敗した場合は`close()`をrejectして 呼出側へ返す。

### 5. cancellation-aware Worker RPC

- `AsyncAgentRpc`は`AbortSignal`を受け取れる契約にし、`collect_subagent`等のtool実行signalを
  `worker_bootstrap.ts`のpending requestへ渡す。
- abort時はpending
  mapから該当requestを除去して待機promiseを終了する。Host側で既に始まったcollectはparent
  cleanupによるchild terminalで収束し、遅れて届いたresponseはobsolete
  requestとして無視する。
- abortは`TurnCancelledError`としてtool/loopへ再throwし、通常の`{ok:false}` tool
  resultへ変換しない。
- Hostがresponseを返す時点でroot Worker
  generationが利用不能でも、二重sendやunhandled rejectionを起こさない。
- `cancel_subagent`はcancel送信受付時点ではなく、対象childのterminal/durability完了後のstateを返す。

## 対象範囲

- `v0/agent/worker/worker_host_children.ts`: parent fence、durability
  state、startup failure、awaitable cleanup。
- `v0/agent/worker/worker_host_coordinator.ts`: resolver/tool
  authority伝播、全parent出口とclose/replacementのcleanup連携、 cleanup
  failure観測。
- `v0/agent/worker/worker_bootstrap.ts`、`v0/agent/tools/async_agents.ts`:
  AbortSignal対応とpending RPC解放。
- `v0/agent/worker/worker_execution_artifact.ts`とvalidator/store projection:
  optional child cleanup observationの保存・ readback。SQLite table/schema
  versionは変更しない。
- `v0/agent/history/sqlite_history_v7_production_store.ts`: noncanonical
  `interrupted` outcomeの既存列への正しいmapping。
- 必要な範囲の`worker_host_contract.ts`／protocol型。wire
  schema追加は、実際にrequest cancel通知が必要と確認された 場合だけ行う。
- `tests/v0/increment_110_async_child_contract_test.ts`と該当task登録。既存Increment
  109 testは既存動作のregression として保持し、誤った期待だけを修正する。
- 本文書への実装結果と検証証拠の追記。

## 対象外

- 新しいagent operation、recursive spawn、follow-up message、Host
  restart後のreattach/resume。
- cross-turn mailbox、durable addressable AgentInstance、automatic
  dispatch、swarm/dashboard UI。
- child effectのtransactional化、自動retry/replay、workspace isolation。
- child provider evidence／diagnosticの新規保存方式。
- architecture／roadmapの意味変更。本incrementは既存正本へ実装を合わせるため、両文書は変更しない。
- 実provider call、binary配置、commit、push、release。

## 受入条件と対応する確認

test件数ではなく、次のproduct動作をproductionと同じHost/Worker境界で確認する。

1. **managed child起動**: `WorkerHostSession`へmanaged `agent:researcher`
   catalogとresolverを与え、resolverがexact refで
   呼ばれ、childがterminalまで到達する。加えてmanaged
   refを`agent:planner`へbindしたname collisionでもresolverが呼ばれ、 bundled
   planner code/role/modelへ差し替わらず、parent/default
   role/modelで起動し、manifest/evidenceが実行したmanaged refと一致する。exact
   bundled planner refは引き続きplanner role/modelで起動する。
2. **tool authority**: managed tool bindingまたはbundled外toolを親Host
   optionsへ与え、child start manifestと実行結果が 同じexact refを示し、bundled
   fallbackへ置換されない。
3. **durable spawn順序**:
   非同期`beginExecution`をbarrierで止め、barrier解放前はspawn
   responseが返らない。 admission rejectionではchild Workerが開始せず、success
   responseも返らない。 barrier中にparent
   cleanupを開始した場合、admission完了へjoinし、解放後もchild Workerとspawn
   successを発生させず durable `cancelled`へ収束する。
4. **durable collect順序**: terminal
   settlementをfailureにするstoreで、collect/cancel/cleanupがsuccessを返さず、
   statusもterminal stateを返さず、semantic terminalをdurable
   terminalと偽らない。terminal messageとcancel/timeoutの
   競合でもsettlementは一回だけである。
5. **parent fence**:
   spawn元parentではstatus/collectが使え、別parentまたは後続turnでは同じrunIdを拒否する。
   durable rowは引き続きreadbackできる。
6. **startup failure cleanup**: durable admission後のmodule/start
   failureがdurable rowでも`outcome='interrupted'`として
   settleし、supervisorが残らない。cleanup期限超過interruptionも同じmappingでreadbackできる。
7. **normal parent settle**: uncollected childをcancelし、child durable
   terminalとterminationが終わるまでsubmitが完了しない。 有効なparent canonical
   commitは維持し、cleanup結果をfinal parent artifactからreadbackできる。
8. **failure/cancel/close/replacement**: 各実在する出口で同じcleanup
   invariantを満たし、未完了child Workerと addressable
   runを残さない。重複cancel/settlementをしない。
9. **collect中parent cancel**: pending collect
   RPCがabortで解放され、parentが期限内にsettleし、childもcancelまたは
   interruptedでdurably settleする。abortはmodel-visibleの通常tool
   errorとしてconversationへ追加されない。
10. **pre-commit cleanup中cancel**: validなcommit proposal受領後のchild
    cleanupをbarrierで止め、その間にparentを
    cancelする。barrier解放後も古いproposalはcanonical採用されず、parentとchildがcancelled/interruptedへ収束する。
11. **並行性regression**: 既存の2 child barrier
    testで、両childが開始してから解放され、独立collectできる。

## 実装順序

1. **Slice A — registry contract**: parent fence、awaitするadmission、durable
   terminal state、startup failure cleanupを `ChildRunRegistry`へ実装し、direct
   focused testで確認する。
2. **Slice B — production authority**: coordinatorからmanaged resolverとexact
   tool Definitionsを伝播し、実際の `WorkerHostSession`境界を通るmanaged
   child/tool binding testで確認する。
3. **Slice C — lifecycle convergence**:
   await可能なcleanupと期限超過interruptionをparent settle/failure/cancel/close/
   replacementへ接続し、各出口のfocused testで確認する。
4. **Slice D — RPC cancellation**: AbortSignalをasync-agent
   RPCへ通し、collect待機中cancelとobsolete responseを確認する。
5. **Slice E — regressionと記録**: 既存Increment
   109動作を再確認し、本書へ実装結果と対応する証拠を記録する。

実装中は各sliceのfocused
test、`v0:check`、format、lint、`git diff --check`を使い、`v0:test`／`v0:gate`を反復しない。
安定候補に対するauthoritative `v0:gate`はcoordinating
ownerが最後に一回だけ実行する。

## 停止条件

- optionalなartifact observationではcleanup failureを表現できず、SQLite
  schemaまたはarchitecture上の新しい永続契約が 必要になる。
- exact tool
  authorityの伝播に、既存architectureと異なるchild固有activation規則が必要になる。
- 正常parent canonical commitを維持したままcleanup
  failureを観測可能にするため、外部contractの変更が必要になる。

いずれかが判明した場合は、原因、影響、選択肢を利用者へ提示し、構想・architecture・roadmapを独断で変更しない。

## 実装結果

利用者承認後、計画したcontract収束を実装した。停止条件には該当せず、SQLite schemaと構想は変更していない。
実装・検証完了後の利用者承認により、architectureへ既存contractの不変条件を明文化し、roadmapのF06／F11を
現実装状態へ更新した。いずれも今回新しいproduct動作を追加する意味変更ではない。

- `ChildRunRegistry`をparent execution単位へ閉じ、durable admission、single-assignment terminal、durable
  settlement、期限付きcleanupを一つのrun stateで管理するようにした。cleanup開始後のlate spawnとcross-turn
  addressabilityは拒否し、startup failureとcleanup期限超過はdurable `interrupted`へsettleする。
- exact bundled planner refだけをplanner role/model/moduleとして扱い、同名のmanaged `agent:planner`はmanaged
  resolver、default role/root modelで起動する。childへは親Hostが解決したexact tool Definition bindingを渡す。
- parentの全settlementとWorker replacement／Session closeにawait可能なchild cleanupを接続した。canonical proposal
  前のcleanup後にparent fenceを再検証し、待機中にcancelされたproposalを採用しない。cleanup failureは
  `WorkerExecutionArtifactV7.childCleanup`へ保存し、有効なparent result／commitは維持する。
- Worker側async-agent RPCへ`AbortSignal`を通し、abort時にpending requestを除去して`TurnCancelledError`を保持する。
  Hostのlate responseはactive parentが変わっていれば送らない。
- live forced interruptionをrestart reconciliationと区別し、`execution_settled`、durable
  `outcome='interrupted'`、実outcome付きartifactとして保存する。restart reconciliationのoutcomeなしartifact契約は
  維持した。
- provider-freeのuncollected-child確認はprobe/ack barrierとし、childが実際に開始したことを確認してからparent
  proposalとcleanupへ進む決定的なtest構造にした。

受入確認はproductionと同じHost/Worker境界を使い、managed planner name collisionとexact tool binding、非同期
admission中cleanup、settlement failure、parent fence、startup failure、cleanup期限超過、RPC abort、pending collect中の
parent cancel、正常uncollected cleanup、cleanup failure下の有効なparent result、pre-commit cleanup中cancelを確認した。
既存の2 child並行testも、両child開始後にreleaseするbarrier構造のまま成功した。

検証結果:

- Increment 91 focused test: 10件成功。
- Increment 109 focused test: 9件成功。
- Increment 110 focused test: 11件成功。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`: 成功。
- 安定候補に対するauthoritative `v0:gate`: 一回実行しexit 0。
- このIncrementの実装時点では実provider call、binary配置、commit、pushを実施していなかった。その後commit
  `25f41765`を`origin/main`へpushし、Increment 111までを含むcommit `8f57788e`のbinaryを配置した。

## 計画reviewと承認境界

- 本計画は実装前に否定的reviewを一回行い、明示契約、production
  source-to-impact、受入確認の不足だけを採否する。
- review反映後も利用者の計画承認までは実装しない。
- 実装承認は本incrementのsource/test/本文書の結果更新までを対象とし、実provider
  call、配置、commit、pushは含まない。

### 否定的review結果（2026-09-22）

read-only reviewerの指摘を受け、次を計画へ反映した。

- noncanonical storeで`interrupted`を`failed`へ潰さず、durable
  outcomeへ保持する。
- admission中のparent cleanupは共有admission promiseへjoinし、late
  admission後のWorker起動/spawn successを防ぐ。
- statusもdurable terminalより先にterminal stateを返さない。
- `agent:planner`の名前ではなくexact ref provenanceからbuiltin/managed
  module、role/lane/modelを一貫して選ぶ。
- pre-commit cleanup待機後にparent
  fenceを再検証し、待機中にcancelされた古いproposalをcanonical採用しない。

再確認の結果、未解決のBlocker／P1／P2はなく、reviewer判定は**承認可能**だった。その後、利用者が計画を承認し、
上記の実装と検証を完了した。
