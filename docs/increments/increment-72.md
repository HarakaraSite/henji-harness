# Increment 72 — named subagentの一般化

ステータス: **実装完了（offline gate pass。実provider probe未実施）**

基準commit: `4bd9bf2f`

計画日: 2026-09-18

実装日: 2026-09-18

対象: Increment 65で成立したactivation-level subagent slot（`subagent:<name>`）と`agent-definition`の
`declaredRole:'subagent'`＋`subagentName`を、planner専用からnamed subagent一般へ広げる。Agent Definitionは
複数のnamed subagentを宣言し、`tool:delegate_to_<name>`でそれぞれへ委譲できる。bundled plannerは
`subagent:planner`の既定として挙動を維持する。

## 利用者が必要とする動作

- Agent Definition（bundled defaultまたはexternal root）が`subagent:<name>`を宣言し、対応する
  `tool:delegate_to_<name>`でタスクを委譲できる。委譲はchild laneで実行され、bounded resultを返す。
- 人間は`$XDG_CONFIG_HOME/henji-harness/agents.json`の`subagent:<name>`へ、同名subagent roleのexternal
  managed Agent Definition revisionをbindできる。bindが無ければ同梱default（plannerのみ存在）を使う。
- 使用した各subagentのexact refをexecution artifactからreadbackでき、lane／evidence／budgetの分離を維持する。
- bundled default parentは従来どおり`subagent:planner`＋`delegate_to_planner`で動作し、退行しない。
- 1 turnにつき各named subagentへ最大1回委譲でき、child laneのrequest budgetは共有する。

## 計画

### slot/compositionの一般化

- `agent_slot_binding.ts`の`subagent:<name>`解決は既に一般形のため維持する。Host
  （`worker_tui_session.ts`）の`resolveSubagentDefinitions`をplanner固定から、bundled subagent一覧＋
  `agents.json`の`subagent:*` binding一覧を解決する一般経路へ広げる。bundled moduleが無いidentityはbindingを
  要求し、無ければtyped failureとする。
- `worker_definition_revision.ts`のbundled subagentを一覧化し（現在planner）、`bundledSubagentLoadRequest(name)`
  と`builtinSubagentDefinitionRef(name)`を一般化する。
- `worker_agent_api.ts`の`resolvePlannerComposition`を`resolveSubagentComposition(name)`へ一般化し、
  `createDefaultAgentComposition`がroot Definitionの宣言するsubagentを合成する。Definitionが追加subagentを
  宣言できるよう`additionalSubagents`を`AgentCompositionOptions`へ追加する（Increment 70の`additionalTools`と
  対にする）。
- `registries.ts`の`subagent:planner`固定検査を、宣言された`subagent:<name>`と対応する
  `tool:delegate_to_<name>`の整合検査へ一般化する。未知subagentは拒否する。

### delegation toolとchild admission

- `planner_delegation.ts`を`createSubagentDelegationTool(name, handler)`へ一般化し、`delegate_to_planner`と同じ
  envelope・上限・cancel・failure semanticsをnamed subagentで共有する。model-visibleなtool名とdescriptionは
  subagentごとに持つ。
- `ParentTurnExecutionContext`の単一child admission（`admitPlannerExecution`）をsubagent名ごとのadmissionへ
  一般化する。child laneの`TurnRequestBudget`は共有し、各subagentは1 turn 1回までとする。
- subagentごとのmodel/effortは、bundled default（`roleDefaults[subagent:<name>]`）またはDefinition/明示binding
  から決める。planner既定（`subagent:planner`）は据え置き、他nameはDefinitionが指定するかtyped failureとする。

### attributionと契約

- 合成したsubagentのexact refは既存の`WorkerAgentManifest.subagents`／execution artifact `subagents`へ記録する
  （リストは既にsubagentName＋refで一般形）。name一般化に伴うshape変更がある場合だけcontract versionを上げ、
  旧版は解釈しない。
- subagent refはSession schemaへ保存しない。binding変更は次のgenerationから効く。

## 対象外

- bundled planner以外のbundled subagent追加（web_search subagentは採用しない）。
- 非同期・並行subagent、複数childの同時実行、結果合流（inbox A7）。
- subagent Definition transport（export/import）、任意kindの共通framework、汎用plugin discovery。
- manifest dependency bindingとactivation bindingの優先規則。
- tool/work toolの追加一般化（Increment 70/71で完了済みの範囲）。

## Verification

- focused test: 複数named subagentの宣言と`delegate_to_<name>`の整合、unknown subagent／tool不一致の拒否、
  external managed subagent Definitionを`agents.json`でbindしたdelegated turnの合成とartifact readback、
  subagent名ごとの1 turn 1回admissionとchild budget共有、plannerの退行なし、lane/evidenceの分離。
- 既存回帰: Increment 65の`subagent:planner` binding、foundation Worker turn、artifact schema v7、history。
- 実provider probe（別途許可）: external named subagentをbindした1 turn。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

slot/composition一般化、delegation tool一般化、per-subagent admission、attribution、testで**5〜9開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. `subagent:<name>`をplanner以外へ一般化し、`tool:delegate_to_<name>`で委譲する。bundled plannerの挙動は維持する。
2. Hostはbundled subagent一覧＋`agents.json`の`subagent:*` bindingを解決し、bundled moduleが無いnameはbindingを
   要求する（暗黙fallbackなし）。
3. Definitionが追加subagentを宣言できるよう`additionalSubagents`を追加する（Increment 70の`additionalTools`と対）。
4. child admissionをsubagent名ごとにし、child lane budgetは共有する。
5. attributionは既存の`subagents`（subagentName＋ref）を維持し、必要時のみcontract versionを上げる。
6. architecture正本（`henji-host-agent-worker.md`のsubagent節・F06、roadmap F06/F24）の更新は別承認。
7. 実provider probeを実行直前に別途許可する。

## 結果（2026-09-18）

- delegation toolを`createSubagentDelegationTool(name, handler)`へ一般化し、`delegate_to_planner`は
  `createSubagentDelegationTool('planner', ...)`の互換wrapperとした。envelopeの`agent`はsubagent名を持つ。
- `ParentTurnExecutionContext`の単一child admissionを`admitSubagentExecution(name, callId)`へ一般化し、
  subagent名ごとに1 turn 1回、child lane budgetは共有する。`admitPlannerExecution`は互換wrapper。
- `registries.ts`は`subagentDelegations`（name→handler）で`tool:delegate_to_<name>`をmaterializeし、宣言
  subagentとdelegation toolの整合を一般検査する。
- `worker_agent_api.ts`は`resolveSubagentComposition(name)`と`createSubagentHandler`へ一般化し、
  `createDefaultAgentComposition`が宣言subagentを合成する。Definition追加subagent用に`additionalSubagents`を
  追加（Increment 70の`additionalTools`と対）。manifest `subagents`はsubagentName＋refで一般形を維持。
- Host（`worker_tui_session.ts`）はbundled subagent（planner）＋`agents.json`の`subagent:*` bindingを解決する。
  bundled moduleが無いnameはbinding必須（暗黙fallbackなし）。`worker_definition_revision.ts`に
  `BUNDLED_SUBAGENT_NAMES`／`bundledSubagentLoadRequest`を追加。
- 検証: 新規`tests/v0/increment_72_named_subagent_test.ts`（named subagentへの委譲、envelope agent名、
  per-name admissionによる2回目拒否、manifest subagents記録、planner併存）。`v0:check`／`fmt`／`lint`／
  `v0:gate` exit 0。既存Increment 65のplanner slot binding回帰もpass。
- 未実施／follow-up: 実provider probe、binary配置、architecture／roadmap正本更新（別承認）。子laneの
  provider evidenceに記録するmodel selectionはplanner既定のままで、named subagent固有selectionのevidence
  属性は今後の候補（Definitionは`createModel('planner', selection)`で自モデルを選べる）。
