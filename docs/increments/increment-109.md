# Increment 109 — 非同期subagentの実装（計画上のIncrement C）

ステータス: **実装完了（Slice A〜E。durable child evidence含む。未commit）**

計画日: 2026-09-22

関連: Increment 106（同期subagent削除）、Increment 107（async run contract）、Increment 108（Host責務分割）、
roadmap F02／F06／F12、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 目的

別Deno Worker・別Executionによるparent-execution-scoped one-shot fork/joinを実装する。childは親のtranscriptや
checkpointを暗黙継承せず、taskから始まり、明示collect時だけ親contextへ入る。child resultはnoncanonical
execution evidenceとして保存する。

## 確定する決定（Increment 107の未確認事項）

1. **child Definition catalog authority**: `$XDG_CONFIG_HOME/henji-harness/agents.json` の
   activation-level slotに `agent:<name>`（async agent catalog）を追加する。`agent:default`は従来どおりroot。
   `subagent:<name>`は引き続き廃止（`binding_slot_abolished`）。`agent:<name>`の値はmanaged selector
   `moduleId@sha256:<digest>`で、Hostは親generation開始前にname→exact `DefinitionRevisionRef`へ解決し、
   data-only catalogとして親Workerへ渡す。builtin plannerは`agent:planner`のbundled既定とする。
2. **親Definitionの宣言**: 親Definitionは利用可能なasync agent名（`agent:<name>` identity）を宣言する。
   bundled defaultは`agent:planner`を既定で宣言する。宣言が無いnameはspawnできない。
3. **Worker→Host RPC**: data-only messageを追加する。Worker→Hostは
   `spawn_request`／`subagent_status_request`／`collect_request`／`cancel_request`（`parentExecutionId`、
   `spawnCallId`、`agent`、`task`／`runId`）、Host→Workerは対応するresponse（`runId`、state、terminal
   result/evidence）。correlationは`parentExecutionId`＋`spawnCallId`＋`runId`で行う。
4. **child Workerのsession identity**: childはcanonical Sessionを持たない。child executionの
   `sessionCorrelation`は`parent:<parentExecutionId>:child:<runId>`とし、`canonicalSessionId`は持たない。
   childは`initialTranscript`空、`nextTurn`1、`modelSelection`はchild Definitionの既定から開始する。
   `parentExecutionId`／`spawnCallId`／exact Definition refをchild evidenceへ記録する。
5. **child budget**: childは自身の`TurnRequestBudget`（rootと同じ既定8）を持つ。親のbudgetを消費しない。
6. **child evidenceのv7 record種別**: 既存のnoncanonical execution境界（`beginExecution`＋
   `settleNonCanonicalExecution`）を使い、`parentExecutionId`／`spawnCallId`／child exact refをattributionへ
   記録する。canonical Sessionは更新しない。
7. **cancel伝播**: parent cancel／failure／settle時、ExecutionCoordinatorが未完了childを列挙して
   `cancel`を送り、terminal settlementを待ってからparentをsettleする。child cleanup failureは記録し、
   有効なparent canonical commitをrollbackしない。
8. **child Worker lifecycle**: `WorkerSupervisor`をN generation registryへ拡張し、root generationとchild
   generations（runId keyed）を管理する。Session close／forced interruption／generation replacementで
   child Workerを残さない。

## model-visible操作

- `spawn_subagent(agent, task) -> runId`
- `subagent_status(runId) -> state`
- `collect_subagent(runId) -> terminal result`
- `cancel_subagent(runId) -> state`

spawnはchild完了を待たない。複数childをspawnでき、親はspawn後も自分のmodel/tool loopを続けられる。
collectは対象childがrunningならterminalまで待つ。child resultは自動で親conversationへ挿入せず、collectの
tool resultとして返された時だけ親contextへ入る。child failureはstructured terminal outcomeとしてcollect可能で、
親executionを自動failureにしない。

## 対象範囲

1. `agents.json`の`agent:<name>` async catalogと、`agent_slot_binding.ts`の`agent:<name>`対応。
2. 親Definitionのasync agent宣言（`AgentCapabilityDeclaration`拡張またはcomposition option）とbundled defaultの
   `agent:planner`。
3. Worker protocolのspawn/status/collect/cancel request/response。
4. Worker内の`spawn_subagent`／`subagent_status`／`collect_subagent`／`cancel_subagent` tool。
5. Host側: ExecutionCoordinatorのchild execution管理、WorkerSupervisorのchild generation registry、
   child Definition解決、child admission/settlement（noncanonical）、cancel伝播。
6. child Workerのdetached result mode（commit proposalを送らない）。
7. architecture／roadmap／README更新、`increment-107`未確認事項の解消。

## 対象外（V1）

- Host restart後のreattach／resume、cross-turn mailbox、follow-up message。
- durable addressable AgentInstance、recursive child spawn、automatic task dispatch、swarm/dashboard UI。
- workspace isolation／競合解決（childは選択Definitionのtool capabilityに従い同一workspaceへ作用し得る）。
- child effectのtransactional化、自動retry/replay。

## 受入条件（Increment 107/109の直接観測）

deterministicなfixture/capsuleで次を観測する。

1. spawnがchild完了前にrunIdを返す。
2. 親がspawn後、collect前に別のmodel/tool actionを行える。
3. 二つのchild Workerが時間的に重なって進行する。
4. childを独立にstatus/collectできる。
5. 一つのchild failureが親をabortしない。
6. `cancel_subagent`は指定childだけをcancelする。
7. parent cancel/settle/closeは未完了childをcancel・settleする。
8. collect前にchild outputが親contextへ入らない。
9. child evidenceからrunId、parentExecutionId、spawnCallId、exact Definition ref、terminal outcomeをreadbackできる。
10. child resultは`SessionAuthority`へcommit proposalとして入らない。
11. 親turnが成功した場合だけ、その親turnがcanonical Sessionへ採用される。
12. Workerがterminal後に残らない。

test件数を目的にせず、各testが上記product動作のどれを証明するかを記録する。

## 実装進捗

- **Slice A（完了）**:
  - `agents.json`の`agent:<name>` async catalog対応（`agent_slot_binding.ts`の`AgentSlot`に`agent` kind、
    `parseAgentSlot`、`resolveAgentSlotBindings`。`subagent:<name>`は引き続き`binding_slot_abolished`）。
  - 親Definitionのasync agent宣言（`AgentCapabilityDeclaration.asyncAgents`、`agent:<name>` resource kind、
    bundled defaultが`agent:planner`を宣言）。
  - Host解決: `worker_tui_session.ts`が`agent:<name>` binding＋bundled plannerをcatalog化し、
    `WorkerHostSessionOptions.asyncAgents`→start commandの`asyncAgents`で親Workerへ渡す。
  - protocol型: `WorkerAsyncAgentCatalogEntry`、start commandの`asyncAgents`。
  - 検証: `v0:check`／`v0:lint`／`v0:fmt` exit 0、`v0:test` exit 0。`increment_65`に
    `agent:<name>` catalog解決testを追加（10件pass）。
- **Slice B（完了）**:
  - `v0/agent/tools/async_agents.ts`: fixed four-operation surface（`spawn_subagent`／`subagent_status`／
    `collect_subagent`／`cancel_subagent`）と`AsyncAgentRpc` seam。spawnは宣言catalog外のagent名を拒否、
    child failureはcollectでstructured outcomeとして返し親をabortしない。
  - `registries.ts`／`worker_agent_api.ts`: `PhysicalIoBindings.asyncAgentRpc`と
    `RegistryMaterializationContext.asyncAgentRpc`を追加し、`declaration.asyncAgents`が非空のとき
    async agent toolをmaterialize。
  - Worker→Host RPC: `WorkerAsyncAgentRequestMessage`（`async_agent_request`、`requestId`、`callId?`）、
    Host→Worker `async_agent_response`。`worker_bootstrap.ts`がpending mapでrequest/responseをcorrelateし、
    physicalIoへ`asyncAgentRpc`を注入。
  - 検証: `v0:check`／`v0:lint`／`v0:fmt` exit 0、`v0:test` exit 0（39 suite）。
    `tests/v0/increment_109_async_subagent_test.ts`（3件）を追加し、四操作surface・catalog外拒否・
    child failure非abortを確認。
- **Slice C（完了）**:
  - `v0/agent/worker/worker_host_children.ts`: `ChildRunRegistry`。childごとに別`WorkerSupervisor`を起動し、
    `agent:<name>` catalogからexact refを解決、bundled plannerは`workerBuiltinModulePath('planner')`で
    moduleを解決する。childのcommit_proposalをterminal resultとして受け取り、detached result mode（canonical
    Sessionへcommitしない）として扱う。`spawn`はchild開始後にrunIdを返し、`collect`はterminalまで待つ。
    `cancel`／`cancelAll`を提供。
  - `ExecutionCoordinator`: `async_agent_request`を`ChildRunRegistry`へ委譲し、`async_agent_response`を返す。
    parent turn settle時と`close`時に`cancelAll`で未完了childをcancelする。
  - `ExecutionJournal.appendWorkerObservation`: `async_agent_request`をobservationとして永続化しない。
  - 検証: `v0:check`／`v0:lint`／`v0:fmt` exit 0、`v0:test` exit 0（39 suite）。
    `increment_109`にchild registryのspawn→runId→collect→status→readback testを追加（4件pass）。
- **Slice D（integration完了）**: provider-freeのparent probe modelが`spawn_subagent`→`collect_subagent`を
  実際に呼ぶ経路を実装し、parent Worker tool→Host `async_agent_request`→`ChildRunRegistry`→別planner
  Worker→child terminal→collect response→parent tool result→parent canonical commitを通した。`increment_109`
  のintegration testが`finalText`にchild結果が入ることを確認（acceptance 1/2/4/8/11）。
- **durable child evidence（完了）**: v7 history schemaをversion 8へ上げ、`execution_admissions`に
  `parent_execution_id`／`spawn_call_id`を追加。`HistoryExecutionInput`／`StoredExecutionRow`へ
  `parentExecutionId`／`spawnCallId`を追加し、`beginExecution`／`settleNonCanonicalExecution`とrow projectionで
  運ぶ。`ChildRunRegistry`がchild admissionとterminal settlementを永続化し、`listExecutions()`から
  runId／parentExecutionId／spawnCallId／exact ref／lifecycle／adoptionをreadbackできる。
  検証: `increment_109`のchild registry testが`parentExecutionId='parent-session'`／`spawnCallId`／
  `definition`／`lifecycle='settled'`／`adoption='non_canonical'`を確認（acceptance 9/10）。
- **破壊的schema変更**: `HISTORY_V7_SCHEMA_VERSION` 7→8。既存`history-v7.sqlite3`は`unsupported schema`で
  開けないため、利用者承認（案A・選択1）のもと既存`~/.local/state/henji-harness/v1/*/history-v7.sqlite3`
  （+`-wal`/`-shm`）を削除した。migration/dual-read/fallbackは追加していない。
- **追加観測（完了）**: `increment_109`に次を追加した。
  - parentが1 child failure後も継続しcanonical commitする（acceptance 5）。
  - 2 childが同時に`running`で進行し、独立にcollectできる（acceptance 3/4）。
  - `cancel_subagent`が指定childのみをcancelし、他childはcompletedのまま（acceptance 6）。
  - `cancelAll`（Session close／parent settleで使用）が未完了childをcancelし、durable rowが
    `lifecycle='settled'`／`outcome='cancelled'`になる（acceptance 7）。
  - child terminalでchild Worker generationをterminateする（acceptance 12）。
  - managed async agentのmodule解決: `WorkerHostSessionOptions.resolveAsyncAgentModule`を追加し、
    `worker_tui_session`が`ManagedDefinitionStore`＋`managedWorkerDefinitionLoadRequest`で解決、coordinatorが
    `ChildRunRegistry`へ渡す。`agent:<name>`の外部managed childも起動できる。
- 対象外（診断）: childのprovider evidence／diagnosticの永続化は行わない。architecture上diagnosticはoptionalで
  semantic settlementをgateしないため、V1ではchildのterminal outcome・ref・親子correlationのreadbackで足りる。
- **Slice E（正本更新完了）**: architecture（`agent:<name>` catalogとasync child V1の責務）、roadmap F06、
  README／`v0/agent/README.md`を実装済み挙動へ更新した。

## 実装順序（slice）

1. **Slice A**: `agents.json`の`agent:<name>` catalog、parent宣言、Host解決、protocol型。
2. **Slice B**: Worker内toolとWorker→Host request／Host→Worker response。
3. **Slice C**: WorkerSupervisorのchild generation registry、child admission/start/settle（noncanonical）。
4. **Slice D**: collect/status/cancelとparent lifecycle連携。
5. **Slice E**: architecture／roadmap／README更新、受入観測。

各sliceでfocused test、type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で
coordinating ownerが一回だけ実行する。

## 未確認事項

- child Workerのstart commandでparentのbase instruction／provider declarations／tool Definitionsをどう渡すか
  （child Definitionが宣言するtool identityに必要な範囲）。
- childのprovider evidence／diagnosticの保存先とcorrelation。
- child cleanup failureの具体的な記録先。
