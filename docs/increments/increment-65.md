# Increment 65 — activation-level subagent slot binding

ステータス: **実装完了（実provider probe受入済み）**

基準commit: `2fe5506a`

計画日: 2026-09-17

## 実装状況（2026-09-18 時点）

完了した区間:

- role一般化（破壊的）: `declaredRole`を`'parent' | 'subagent'`＋`subagentName`へ変更した。
  `managed_definition_manifest.ts`（canonical digestへrole/nameを追加、旧schemaは互換読込しない）、
  `managed_definition_importer.ts`、`managed_definition_revision_validator.ts`、
  `managed_definition_store.ts`、`managed_definition_transport.ts`、`module_cli.ts`（`--role subagent
  --subagent-name <name>`）、`managed_resource_ref.ts`（built-in planner refをsubagent＋nameへ再build）、
  `definition_selection.ts`（rootは`parent`のみ受理、managed subagent refは
  `definition_role_mismatch`@resolutionで拒否）。
- activation-level binding config: `v0/agent/definitions/agent_slot_binding.ts`を追加。
  `$XDG_CONFIG_HOME/henji-harness/agents.json`（`schemaVersion:1`＋`bindings`）のload/validateと、
  slot（`agent:default`／`subagent:<name>`）からexact managed revisionへの解決。role/name不一致・
  未知slot・malformed・missing revisionはtyped `AgentBindingError`で、built-inへ暗黙fallbackしない。
- root slot適用（追補）: `resolveRequestedDefinition`が明示selector無しのとき`agent:default` bindingを
  managed parent rootとして解決する。優先順位は「明示selector > 再開/継続Sessionの保存ref > `agent:default`
  binding > bundled default」。binding解決失敗はtyped `DefinitionStartupError`で、bundledへの暗黙fallbackは
  しない。selector解析は循環import回避のため`definition_selector.ts`へ分離。
- composition seam: Host（`worker_tui_session.ts`）がroot parent生成ごとに`subagent:planner`を解決し、
  bound managed revisionまたはbundled plannerの`WorkerSubagentLoadRequest`（exact ref＋物理descriptor）を
  start commandへ渡す。Worker（`worker_bootstrap.ts`）はroot moduleとsubagent moduleを検証読込し、
  `ExecutableAgentDefinitionInput.subagents`としてroot Definitionへ渡す。Henji helper
  （`worker_agent_api.ts`の`createDefaultAgentComposition`）がHost提供plannerを合成し、無ければbundled plannerへ
  fallbackする。保証範囲はHenji helperを使うDefinitionに限る。
- contract version: `WORKER_PROTOCOL_VERSION`を`slice1-data-only-v2`へ、execution artifactをschema-v6へ更新。
  ready manifestとv6 artifactへ、実際に合成した`subagents`（subagentName＋exact ref）を記録する。
- 検証: focused test `tests/v0/increment_65_subagent_slot_binding_test.ts`（10件、`v0:test`へ追加。bindingの
  load/validate、bound external plannerのdelegated turn合成とartifact readback、`agent:default` root bindingの
  解決・明示selector上書き・invalid bindingのtyped failure・bound rootでの新規Session起動を確認）。artifact
  schema版更新に伴い`increment_38`/`40`/`41`の版assertを更新。`v0:test`全体、`v0:check`、fmt、lint、
  `git diff --check` pass。

- 正本更新（利用者承認済み、2026-09-18）: architecture `henji-host-agent-worker.md`へ`AgentSlotBinding`用語、
  roleモデル、activation-level slot節、composition seam、attribution/contractを追記。roadmap Provider外部化節の
  段階リスト・サマリ表をIncrement 64〜68の実内容へ更新し、F06/F24行をslot binding基盤へ更新。

- planner既定のdata化: 同梱`provider-defaults.json`へtop-level `roleDefaults`（key `subagent:planner`、
  `providerId`/`modelId`/`effort`）を追加。`provider_defaults.ts`がtypedに読み、`model_catalog.ts`の
  `roleDefaultModelSelection(slot)`がactive provider catalogに対して解決する。hardcodeされていた
  `PLANNER_DEFAULT_MODEL_SELECTION`/`PLANNER_DEFAULT_MODEL_ID`/`PLANNER_DEFAULT_EFFORT`を削除し、Host/Workerの
  全既定解決をこのresolverへ統一。root provider既定は従来どおりdeclarationの`defaults`。
- 検証追加: `increment_65`に「planner既定が同梱`roleDefaults` data由来である」testを追加（計7件）。

- 実provider probe（利用者許可、2026-09-18）: isolated XDG rootにexternal planner（`subagent:planner`、system
  instructionへprobe markerを追加）をinstallし、`agents.json`でbindしてproduction physicalI/Oのreal turnを1回
  実行。turn成功、execution artifact v6の`subagents[0].ref`がexternal revisionと一致、planner laneのprovider
  request bodyにprobe markerを確認（root laneは2 request）。binding解決→composition→delegated plannerの実
  provider実行をreadbackした。
- binary配置（2026-09-18）: 実装commit`d63ee395`から`henji:compile`。binary SHA-256
  `0208165889aea4d7e5db4aa89fd36b84de5c556246a91a86fd8a2a7d437a83bd`、build
  `bf60013c3bd3984c27b9dc57b150afb3b2eefb7808c5ce925426321f578b3d40`、`sourceDirty=false`。`dist/henji`を
  `~/.local/bin/henji`へ配置し、同binaryでexternal planner bind済みのproduction smoke test（`henji run`）が
  marker付き最終応答でexit 0。stateのartifact v6 `subagents`とplanner lane markerも確認。

未着手:

- フォローアップ候補（未承認）: architecture 406行付近の「delegated plannerはrootの選択を継承せずplanner
  defaultを使う」をslot binding（bindが無ければplanner default）へ更新するか。
- フォローアップ候補（実装スコープ外の可能性）: external plannerが標準helper以外で独自model selectionを
  使う場合、`manifest.plannerModel`とHost validationが既定値固定のままである。model/effort差し替えの完全な
  readback/validationは必要なら別途計画する。

注: 本区間で`increment_33`／`increment_34`にあった「external plannerをrootとして実行する」product testは、
計画どおりsubagentはroot slotで拒否する検証へ置き換えた。external plannerのdelegated child turnへの反映は
`increment_65`のcomposition testで確認する。

対象: 完全外部化(c)の続き。delegated subagent（まずplanner）のDefinitionを**activation-level slot**でbindできる
基盤を作り、planner既定をdata化する。Definition-manifest dependency binding（Agent自身の改訂経路）、`--agent
planner`の削除、web-search subagentは66、tool overrideは67、built-in削除は68。

## 前提の訂正

- plannerは**subagent**でありroot agentではない。plannerをrootで走らせる既存`--agent planner`は誤った実装で、
  後続で削除する（本incrementでは扱わない）。
- Workerがparent/plannerを**peerとして別々に評価**するのではない。**Definitionがsubagentを`AgentComposition`へ
  合成**し、Workerは**選択されたroot Definitionを評価**する。
- subagentのexact refは`context attribution`ではなく、**解決済みDefinition resource graph／execution artifact**へ
  記録する。
- roleは`'parent' | 'subagent'`とし、subagentは`subagentName`で識別する（planner=`subagentName:'planner'`）。
  既存managed Definitionの`declaredRole:'planner'`とbuilt-in planner ref identityは変わる（破壊的変更を許容し、
  再install・再buildを前提とする）。

## 利用者が必要とする動作

- 人間が`subagent:planner`へ、subagent role（name=planner）のexternal managed Agent Definition revisionをbindでき、
  delegated plannerのinstruction/toolsをDefinitionで差し替えられる。model/effortの差し替えは本incrementでは
  未対応で、標準helper使用時はbundled planner defaultが使われ、`manifest.plannerModel`も既定値のまま
  （follow-up候補）。`agent:default`へbindしたmanaged parent Definitionは、明示selectorが無い新generationの
  rootとして使われる。
- bindが無ければ同梱built-in plannerで従来どおり動く（ゼロ-config維持）。解決失敗は暗黙fallbackしない。
- 使用したroot Definitionとsubagentのexact refをexecution artifactからreadbackできる。
- root/plannerのlane、evidence、budgetの分離と、Henji base instructionのplannerへの適用を退行させない。
- plannerの既定（model/effort等）がコード定数ではなく同梱default（data）から供給される。

## 計画

### slot model

- slotは2種。**root slot**は`agent:default`のみ（root role=`parent`）。**delegated slot**は`subagent:<name>`。
- plannerは最初のdelegated slot `subagent:planner`。subagent Definitionは`declaredRole:'subagent'`＋
  `subagentName:'planner'`を持つ。新しいsubagentは`subagentName`を変えて追加する。
- `--agent planner`（plannerをrootで走らせる既存経路）は本incrementの対象外であり、binding対象slotにも含めない。
  後続incrementで削除する。

### binding config（activation-level slot）

- `$XDG_CONFIG_HOME/henji-harness/agents.json`を追加する:
  `{ "schemaVersion": 1, "bindings": { "subagent:planner": "<managed selector>" } }`。selectorは既存managed Agent
  Definitionの`moduleId@sha256:<digest>`形式を再利用する。
- scopeは**installation/user（XDG config）**とする。workspace scopeは65の対象外。
- Hostは起動時に解決し、slotの期待role（`subagent:planner`=`subagent`＋name `planner`）とmanaged revisionの
  `declaredRole`/`subagentName`が一致することを検証する。role/name不一致・missing revision・未知slotはtyped
  failureとし、built-inへ暗黙fallbackしない。
- subagent解決は**専用経路**とし、rootの`HostDefinitionSelection.id`（'default'/'planner'）写像を流用しない。
- activation-level slotはarchitectureのlocal `ResourceSlotIdentity`／manifest dependency bindingとは**別namespaceと
  authority**として定義する。Definition-manifest dependency bindingと、manifest bindingとactivation bindingの
  **優先/競合規則**は後続incrementで決め、65の対象外とする（メモ）。
- 解決したroot Definitionとsubagentの**data-only ref・physical load descriptor**をWorker start commandへ追加する。
  Hostはref解決のみを行い、評価はWorkerが行う（関数は境界を越えない）。

### role一般化（破壊的）

- `declaredRole`を`'parent' | 'subagent'`へ変更し、subagentは`subagentName`を持つ。既存`declaredRole:'planner'`の
  managed Definitionは本変更後はinvalidとなる（再install前提）。built-in planner Definitionのref identityも変わる。
- `resolveDefinitionRef`のrole→slot写像と`AgentResourceIdentity`（`subagent:<name>`）検証を一般化する。root slotは
  `parent` roleのみを受理する。
- canonical digest計算は新schemaに合わせて更新する（旧schema revisionは互換読込しない）。

### composition（Definitionがsubagentを合成）

- Hostがroot Definition revisionと、bind済みsubagentのexact refを解決する。
- Workerは**選択されたroot Definitionを評価**する。root Definitionの合成（Henji helper）が、Host提供の
  Worker-local subagent module/descriptorを使ってplanner subagentを組み込み、`delegate_to_planner`へ配線する。
- Workerがparent/plannerをpeer評価する経路は作らない。保証範囲: Host-provided subagentが反映されるのは
  **Henji helperを使うDefinition**に限る。opaqueな自作root Definitionはhelperを使うか自前で合成する。この保証範囲を
  architectureへ明記する。
- Henji base instructionのmandatory finalizerは、built-in/externalの別にかかわらずrootとdelegated plannerの
  contributionへ同じselected baseを一度だけ前置する現行動作を維持する（Increment 51の保証を退行させない）。

### attributionと契約版

- 解決したroot Definition refとsubagent exact refを、**Definition resource graph／execution artifact**へ記録する。
  `context attribution`へは入れず、二重authorityを作らない。
- 本incrementで`WorkerHostCommand`（start）と`WorkerReadyMessage`、および`WorkerExecutionArtifact`のcontractを変更する
  ため、**それぞれのversionを上げ、旧版は解釈しない**（互換読込・migrationなし）。変更点とversionを計画内に列挙する。
- subagent refは**Session schemaに保存しない**（conversation stateではない）。`agents.json`はHost-level selectionで
  あり、変更は次のgenerationから効く。将来AgentInstanceが導入されたらbindingをInstance領域へ移す。

### planner既定のdata化

- 同梱defaultへslot別既定（`roleDefaults`、keyはslot `subagent:planner`）を追加し、
  `PLANNER_DEFAULT_MODEL_SELECTION`等のコード定数を削除する。root provider既定とは独立に扱い、既知providerに限定する。
- plannerのinstructionは当面built-in（binary-owned role instruction）のままとし、external planner Definitionが
  自前のinstructionを持つ場合はそれを用いる。

## 対象外

- `--agent planner`の削除・是正、root slotの一般化（`agent:<role>`）
- Definition-manifest dependency binding、manifest/activation bindingの優先・競合規則、binding transport
- web-searchのsubagent化（Increment 66）、`tool:read|write|edit|bash`のsame-identity override（Increment 67）
- 新規tool identity、MCP、tool実行sandbox（R2/R3）
- built-in id削除・Session影響・既定解決不能時の入力ブロック（Increment 68）
- workspace scope binding、instruction resource kindの一般化、Session schema変更

## Verification

- focused test: `agents.json`のload/validate（正常、slot role/name不一致、missing revision、未知slot、malformed）、
  `subagent:planner`のbindあり/なしでのplanner合成選択、external plannerがdelegated child turnに反映されること、
  root/subagent refのartifact readback、base instruction finalizerのplanner適用、lane/evidence/budget維持、
  planner既定のdata由来化、role変更後のinvalid旧Definitionが明示的に拒否されること。
- 既存回帰: built-in parent/planner delegation、root provider/model切替、Session resume、footer。
- 実provider probe（別途許可）: external planner Definitionをbindして1 turn。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 規模見積り

binding configと解決、role一般化（破壊的）、composition seam、protocol/artifact contract版更新、planner既定data化、
testで**4〜6開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. slotをroot `agent:default`＋delegated `subagent:planner`に限定し、`--agent planner`は後続で削除する扱い。
2. activation-level slotを別namespace/authorityとし、Definition-manifest bindingと優先/競合規則は後続（メモ）にする扱い。
3. `declaredRole`を`'parent' | 'subagent'`＋`subagentName`へ**破壊的変更**し、既存managed planner Definitionは
   再install、built-in planner refは再buildとする扱い。
4. Hostはref解決のみ、Workerはroot Definitionを評価し、root Definitionの合成がHost提供subagentを組み込む扱い。
   保証はHenji helperを使うDefinitionに限る旨をarchitectureへ明記。
5. root/subagent refをDefinition resource graph/execution artifactへ記録し、context attributionへ入れない扱い。
6. start command/ready message/execution artifactの**contract versionを上げ、旧版を解釈しない**扱い。
7. planner既定を同梱default（slot別`roleDefaults`）へ移し、コード定数を削除する扱い。
8. architecture（`henji-host-agent-worker.md`）へactivation-level slot authority、composition seam、保証範囲を追記し、
   roadmapのProvider外部化節（Increment 65〜68の内容・順序）を更新する（正本更新、別項目）。
9. 実provider probeを実行直前に別途許可する検証水準。
