# Increment 106 — 同期subagentの削除（計画上のIncrement A）

ステータス: **実装・検証・commit・push完了**

計画日: 2026-09-22

関連: Increment 65（subagent slot binding）、Increment 72（named subagent）、Increment 94（history v7）、
`v0/agent/worker/`、`v0/agent/tools/`、`v0/agent/definitions/`、roadmap F02／F06／F24、
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 目的とproduct動作

- 親Worker内でchild agentを同期実行するsubagent機能（`delegate_to_planner`／`delegate_to_<name>`、child lane、
  `subagent:<name>` activation slot、`declaredRole:'subagent'`）をproductionから完全に削除する。
- child／subagentはDefinitionの固定roleではなく、Execution間の親子関係として扱う（非同期childは後続increment）。
- standalone `--agent planner`は削除せず、root-runnableな通常Definitionとして残す。
- product動作は、同期delegationの除去以外は変えない。root agentのmodel/tool loop、cancel、history、canonical
  commit、standalone planner実行は従来どおり。

## 対象範囲

1. 同期delegation tool（`planner_delegation.ts`）と専用validation sentinel（`planner_delegation_sentinel*.ts`）の削除。
2. Worker内child実行: `createSubagentHandler`／`resolveSubagentComposition`／`additionalSubagents`／
   `AgentSubagentModule`／`AgentCompositionOptions.additionalSubagents`／`ExecutableAgentDefinitionInput.subagents`。
3. child lane: `ChildTurnExecutionContext`、`ParentTurnExecutionContext`のsubagent admission、共有child budget、
   `plannerModelSelection`、`ModelExecutionContext.lane`の`'child'`。
4. 同期tool専用contract: `PlannerDelegationFailureError`、delegation envelope、`MAX_PLANNER_*`、`replay_value`の
   planner replay bound（historical decoderとして保持）。
5. Host/Worker protocol: `WorkerSubagentLoadRequest`、start commandの`subagents`、ready manifestの`plannerModel`／
   `subagents`、`WorkerHostSessionOptions.subagentDefinitions`、Hostのsubagent slot解決・module供給。
6. Definition capability/role: `AgentCapabilityDeclaration.subagents`、default presetの`subagent:planner`／
   `tool:delegate_to_planner`、`agents.json`の`subagent:<name>` slot、新規installの`declaredRole:'subagent'`／
   `subagentName`。
7. legacy `runtime.ts`の同期delegation、provider-free probeのdelegate call。
8. docs/README/architecture/roadmap/inboxの同期subagent記述。

## 対象外

- standalone `--agent planner`とplanner root実行（維持）。
- 非同期subagentの実装（後続Increment B0／B／C）、Host責務分割（Increment B）。
- 既存data（`agents.json`、managed revision、Session、history DB、execution artifact）の削除・自動変換。
- `history-v7.sqlite3`等の実データ削除。
- v7 schema／store／pipeline／CLIの変更。
- 過去increment文書（Increment 65／72等）の書き換え（履歴として保持）。

## 既存データの扱い

- `agents.json`に`subagent:*` entryが残る場合、黙って無視せず、`AgentBindingError('binding_slot_abolished')`で
  「subagent activation slotは廃止された」と分かるtyped diagnosticを返す。
- 新規installは`declaredRole:'parent'`のみ受け付け、`--role subagent`／`--subagent-name`と
  `importManagedDefinition`のsubagent roleを`module_invalid`で拒否する。
- 既存のsubagent-role managed revisionはmanifest schema（`declaredRole`／`subagentName`）とdigest計算を維持し、
  inspect／transport decode／readbackできる。`builtin/planner`のdigestも変更しない。
- execution artifactの`plannerModel`／`subagents`はhistorical stored manifest型
  （`WorkerExecutionStoredManifestV1`）としてread-onlyに検証する。live protocol型を流用せず、新規artifactは
  これらのfieldを出力しない。`plannerModel`はoptional検証へ変更した。
- 旧`delegate_to_planner` tool resultのreplay bound（`session_record_codec.ts`）はhistorical decoderとして保持する。

## 実装結果

- 削除: `v0/agent/tools/planner_delegation.ts`、`v0/agent/validation/planner_delegation_sentinel.ts`、
  `v0/agent/validation/planner_delegation_sentinel_launcher.ts`、task `agent:planner-delegation:sentinel:credential-file`。
- `core/execution_context.ts`: child lane／child context／subagent admission／plannerModelSelectionを削除し、
  request budgetを単一lane（`parent`／`aggregate`）へ単純化。
- `core/loop.ts`: planner delegation failure分岐、child lane分岐、`sourceCallId`／`lane`引数を削除。
- `tools/registries.ts`: delegation materialization・coherence check・`createProductionRegistry`／
  `createPlannerRegistry`を削除。
- `worker_agent_api.ts`: subagent module／handler／compositionを削除。`createPlannerAgentComposition`は維持。
- `definitions/agent_definition.ts`・`resource_identity.ts`: `subagents` capabilityとdefault presetの
  `subagent:planner`／`tool:delegate_to_planner`を削除。
- `definitions/agent_slot_binding.ts`: root slotのみ。subagent slotは`binding_slot_abolished`。
- `definitions/managed_definition_importer.ts`・`cli/module_cli.ts`: subagent roleの新規installを拒否。
- `worker/worker_definition_revision.ts`・`worker_tui_session.ts`・`worker_host_contract.ts`・
  `worker_protocol.ts`・`worker_bootstrap.ts`・`worker_host_session.ts`・`worker_runtime.ts`・
  `worker_physical_io.ts`: subagent module供給・child lane・`plannerModel`を削除。
- `worker/worker_execution_artifact.ts`: historical stored manifest型を導入し、`plannerModel`をoptional検証。
- `runtime/runtime.ts`・`reproductions/deno-worker-sqlite-wake/run.ts`: 同期delegationを削除。
- 正本: architecture（root slot・Definition role・Worker責務）、roadmap（F02／F06／F24と経緯）、
  inbox（A7を採用・削除）、README、`v0/agent/README.md`を更新。

## 受入条件に対応する直接観測

- **root agentのmodel/tool loop、cancel、history、canonical commitが従来どおり**: `v0:test` exit 0
  （`current_code_test`13件、`agent_worker_foundation`、`increment_12/13/14/15/33/34/35/38/39/65/76/91/92/99/100/
  101/103/104/105`、`provider-stream-compatibility`19件、`increment_7`5件、TUI suiteを含む）。
- **standalone plannerをrootとして実行できる**: `increment_33`のplanner fixture／
  `createPlannerAgentComposition`経路、`roleDefaultModelSelection('subagent:planner')`データは維持。focused
  test（`increment_12`／`increment_65`）がplanner既定dataを確認。
- **root manifest、Worker startup protocol、model-visible toolsに同期delegationが存在しない**:
  `WorkerAgentManifest`から`plannerModel`／`subagents`を削除、start commandから`subagents`を削除、
  `declarationsFor('production')`から`tool:delegate_to_planner`／`subagent:planner`を削除。`v0:check` exit 0。
- **新しいDefinitionはsubagent role/slotを宣言・bindできない**: `increment_65`が`binding_slot_abolished`と
  install rejection（`module_invalid`）を確認。`increment_33`もsubagent install拒否を確認。
- **reachable sourceにWorker-local child `runAgent()`がない**: Worker内`runAgent`呼出は
  `createSubagentHandler`のみで、削除済み。`rg "delegate_to|subagent:" v0 tests scripts`はhistorical decoder
  （artifact stored型、session replay bound、planner roleDefaults data、docs）以外に残らない。
- **focused test、type check、format、lint、`git diff --check`**: `v0:check` exit 0、`v0:fmt` exit 0、
  `v0:lint` exit 0（`no-unused-vars`含む）、`git diff --check` clean。
- **`v0:gate`はこの時点では実行しない**（指示どおり）。

## 未確認事項・後続

- 非同期subagent（別Worker・別Executionのparent-scoped one-shot fork/join）はIncrement B0／B／Cで扱う。
- Host責務分割（`WorkerHostSession`／`ExecutionCoordinator`／`WorkerSupervisor`／`SessionAuthority`／
  `ExecutionJournal`）はIncrement Bで扱う。
- 実provider probeは未実施（product動作不変のため不要。必要時は別途承認）。
- binary配置・push・publishは未実施。
