# Agent Definition resolved manifest implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 77として、Step 76で検証済みのbuilt-in Agent Definition resource selectionから、
internal・immutable・schema-v1・data-onlyのresolved manifestを生成する。

manifestはschema version、built-in Definition ID、canonical resource identities、`maxSteps`、full SHA-256に
よるdeterministic identityを固定する。同じ意味のselectionはprocess、checkout、workspace path、object
identity、filesystem enumeration orderに依存せずbyte-identicalとなる。manifest identity自身はdigest inputへ
含めない。

Step 76 validationとDefinition topologyの対応は複製しない。`resource_identity.ts`のknown-topology derivationを
shared helperへ分離し、Step 76 resolved-Definition validatorとStep 77 standalone manifest validatorの双方が
使う。

parentとadmitted lazy plannerはいずれも、Definition評価、Step 76 validation、Step 77 manifest生成、
standalone再検証、test-only observer、model/registry materializationの順を守る。persistent TUIではparentの
manifest検証までをsession storeのlist/open/allocate/lock/writeより前に完了し、store record検証後にだけprepared
Definitionをmaterializeする。manifestはprovider wire、events、transcript、session、persistence、CLI/TUIへ出さない。

## Confirmed planning base

- Repository HEAD: `e359cda9bef9ad44e115881c5e9e0ebeaa057f12`
- tracked worktreeはclean。untracked user-owned `_refs/*`は保持する。
- delivered input: `/tmp/planner-inputs/henji-agent-definition-resolved-manifest.md`
- input SHA-256: `5520f69a1ec0dc2c5f7e5a5f08894e792543f5b661b789970c27fc76ab687df0`
- Step 76 plan: `docs/plans/agent-definition-resource-identity.md`
- Step 76 plan SHA-256: `d27878f34ed90893f371084aa8886d9bd1db31209aaed23502306a1d6560cc42`
- Step 76はcommit `e359cda`で完了し、Definition 12、runtime 38、direct v0 516、owner gate
  518がpass、final reviewはBlocker/P1/P2 zeroである。
- `resource_identity.ts`はstrict grammar、canonical ordering、immutable selection、resolved Definition
  validationを所有する。現行`expectedResources`はprivateであり、Step 77用にsingle-source化が必要である。
- `agent_catalog.ts`がbuilt-in ID `default` / `planner`を所有する。
- `runtime.ts#createRuntimeComposition`はparentとlazy plannerのStep 76 validationを既にmaterialization前に行う。
- pinned Deno 2.9.4ではpermissionなしのglobal `crypto.subtle.digest("SHA-256", ...)`が利用でき、追加dependencyは
  不要である。4件のknown-answer digestも同runtimeで独立再計算済みである。
- `deno.v0.json`と`offline_gate_topology_test.ts`がdirect test ownership、exact leaf permissions、check target、
  gate compositionを固定する。

確認した要件とlive repository stateにblocking conflictはない。

## Normative schema-v1 contract

新規internal module `v0/agent/resolved_manifest.ts`に次と同等の型を置く。

```ts
export type AgentResolvedManifestIdentity = string & {
  readonly __agentResolvedManifestIdentity: unique symbol;
};

export interface AgentResolvedManifestV1 {
  readonly schemaVersion: 1;
  readonly definitionId: BuiltinAgentId;
  readonly resources: readonly AgentResourceIdentity[];
  readonly parameters: Readonly<{ readonly maxSteps: number }>;
  readonly identity: AgentResolvedManifestIdentity;
}
```

Normative own-property orderは`schemaVersion`、`definitionId`、`resources`、`parameters`、`identity`、
`parameters`内は`maxSteps`だけとする。schema-v1のDefinition IDはcatalogのexact `default` / `planner`だけで、
unknown version/IDはfail closedとする。

top-levelと`parameters`はplain object、`resources`はplain Array、leafはstringまたはnumberだけとする。
function、class instance、symbol、accessor、custom/null prototype、runtime objectを許さない。constructorとvalidatorは
freshなdeep-frozen envelopeを返し、resources/parametersもcloneしてfreezeしてcaller-owned inputとmutable ownershipを
共有しない。

## Canonical payload and identity

identityを除くcanonical payloadは、次のproperty orderによるexact compact JSONである。

```text
{"schemaVersion":1,"definitionId":"<id>","resources":["<resource-0>",...],"parameters":{"maxSteps":<decimal>}}
```

EncodingはUTF-8、BOM/whitespace/trailing newlineなしとする。resourcesはStep 76 canonical orderのまま、stringは
validated ASCII、`maxSteps`はpositive safe integerのcanonical base-10 decimalとする。locale、untrusted object
enumeration、filesystem enumeration、workspace pathを使わない。validated primitive snapshotからfixed-order payload
objectを新規構築する。untrusted inputを直接`JSON.stringify`して正規化しない。

domain-separation prefixは次のexact ASCII bytesである。

```text
henji-agent-resolved-manifest:v1\n
```

digest input:

```text
UTF8("henji-agent-resolved-manifest:v1\n") || canonicalPayloadBytes
```

identity grammar:

```text
henji-agent-resolved-manifest:v1:sha256:<64-lowercase-hex>
```

Web Crypto `crypto.subtle.digest("SHA-256", bytes)`で256 bits全体をlowercase hex化する。identity fieldはpayloadと
digest inputから除外する。validatorはgrammar検査後に再計算してexact一致を要求する。unknown versionはmigrationを
試みず拒否する。future versionは新しいexplicit schema/codec/domainを持つ別incrementとし、Step 77でmigration
engineやcollision registryを作らない。full SHA-256 collision resistanceをinternal equalityの前提とし、理論上の
collision riskをresidual riskとして記録する。

## Fixed schema-v1 known-answer fixtures

### `default`, no workspace instruction, no skills

```json
{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8}}
```

```text
henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58
```

### `default`, workspace instruction and skills `format`, `review`

```json
{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:skill","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8}}
```

```text
henji-agent-resolved-manifest:v1:sha256:7b45d146eecac2dd0f1126889f5d0728b64535e1294ad68556b42d1825545505
```

### `planner`, no workspace instruction, no skills

```json
{"schemaVersion":1,"definitionId":"planner","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:builtin-planner-policy","tool:read","tool:submit_json_result"],"parameters":{"maxSteps":8}}
```

```text
henji-agent-resolved-manifest:v1:sha256:fc23e5faaddf628f2d30adee4793c196db3e9b5cfc5714629193fbc6c3bd30eb
```

### `planner`, workspace instruction and skills `format`, `review`

```json
{"schemaVersion":1,"definitionId":"planner","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:builtin-planner-policy","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:read","tool:skill","tool:submit_json_result"],"parameters":{"maxSteps":8}}
```

```text
henji-agent-resolved-manifest:v1:sha256:6974dafb9c9ea74c7bfc93046d5920cc829c5d7d6c75629d51e885d3b75ecc5a
```

## Strict validation and Step 76 reuse

### Shared topology helper

current private `expectedResources`をbehavior変更なしでshared helperへrefactorする。helperはknown built-in topology
rulesの唯一の実装とする。

- `default`はproduction tools、`tool:delegate_to_planner`、`subagent:planner`を要求する。
- `planner`は`instruction:builtin-planner-policy`を要求し、production mutation/delegation resourcesを拒否する。
- skills、`instruction:project-skill-manifest`、`tool:skill`はcoherentに現れる。
- workspace instruction identityはpath/contentと独立する。
- model、instruction、skill、tool、subagent order/topologyはStep 76 contractを維持する。

`validateResolvedAgentResources`はselected built-in IDを受ける形へ狭く拡張し、existing resolved-Definition correlation
check後にshared helperを使う。`validateAgentResolvedManifest`もmanifest ID/resourcesを同じhelperへ渡す。したがって、
correct digestを持つ`default`名のplanner topologyと`planner`名のdefault topologyも拒否する。
`resolved_manifest.ts`へ第二のtopology tableを作らない。

### Untrusted manifest validation

getterを読まず、次の順で検査する。

1. own descriptorsを取得する。
2. exact property namesとcanonical orderを要求する。
3. symbolを拒否する。
4. enumerable data descriptorsだけを許しaccessorを拒否する。
5. exact plain prototypesを要求する。
6. async digest前にprimitive/array dataを同期snapshotする。
7. `schemaVersion === 1`とexact built-in IDを要求する。
8. Step 76 grammar、duplicate、canonical order、known topologyを検査する。
9. `maxSteps`をpositive safe integerとして検査する。
10. identity grammarを検査する。
11. canonical payloadを再encodeしSHA-256を再計算する。
12. exact identity一致後、fresh deep-frozen manifestを返す。

missing/unknown/extra key、wrong key order/type、symbol、accessor、non-enumerable、null/custom prototype、array
subclass/sparse/extra property、unknown/noncanonical resource、duplicate/order drift、malformed/wrong-domain/wrong-digest
identity、unknown version、Definition/topology mismatchを修復せず拒否する。input mutabilityだけはdefensive copyで扱う。

failureはsanitized `AgentResolvedManifestError('invalid agent resolved manifest')`だけを返し、path、instruction/skill
content、profile/credential、received identityをechoしない。

## Runtime integration and failure order

### Two-phase parent composition

current `createRuntimeComposition`を、internalなprepare phaseとmaterialize phaseへ分ける。

- `prepareRuntimeComposition`相当はworkspace/instruction/skill snapshotをresolveし、selected Definitionを一度だけ
  evaluateし、Step 76 validation、Step 77 generation、standalone validation、test observerまでを行う。
- prepared valueはruntime外へ公開しないinternal envelopeで、resolved Definition、validated resource selection、
  fixed startup snapshot、selected IDだけを保持する。manifestはobserver通過後に保持・公開しない。
- `materializePreparedRuntimeComposition`相当は同じprepared Definitionを再評価せず、model、planner handler、registry、
  turn contextを構築する。
- normal CLI、ephemeral TUI、既存`createRuntimeComposition`はprepare直後にmaterializeするcompatibility wrapperを使う。
- persistent TUIだけはprepare、session store record acquisition/validation、materialize、`AgentSession` constructionの
  順に分ける。

この分離はDefinition評価を一回に保ち、manifest failure前のpersistent writeを防ぎつつ、invalid resumed-session
metadataではmodelをmaterializeしない既存propertyも維持する。

### Parent

1. prepare phaseでcurrent startup snapshotをresolveする。
2. selected Definitionを一度評価する。
3. Step 76 validationを`selection.id`で行う。
4. validated selectionからschema-v1 manifestを一度生成する。
5. standalone validatorを通す。
6. optional direct-test observerへ通知する。
7. nonpersistent pathは直ちにmaterializeする。persistent TUIはこの時点で初めてstore list/open/allocate/lockを
   行い、recordのworkspace/agent metadataを検査する。
8. validated record/persistence handleを得た後、prepared Definitionからmodel、credential source、fetch consumer、
   planner handler、registry、`AgentSession`をmaterializeする。

manifest generation/digest/factory failure時はpersistent TUIでもstore construction以外のlist/open/allocate/lock/
writeを0とする。store acquisition/record validation failure時は現行どおりmodel/registry materializationを0とし、
取得済みhandleを既存cleanup contractでcloseする。

### Lazy planner

existing parent-turn delegation admission後だけ、fixed/test-overridden planner Definitionを一度評価し、exact ID
`planner`でStep 76 validation、manifest generation、standalone validation、test observer、child model/registry
materialization、child turnの順に進む。no-delegation pathはplanner manifestを生成しない。

test-only seamとして、malformed/wrong-digest/cross-bound inputを注入できるoptional async manifest factory overrideと、
successful validation後かつmaterialization前の`onResolvedManifestValidated(role, manifest)` observerを加える。
productionはbuilt-in constructorだけを使う。overrideはDefinition/provider behaviorを変更しない。

manifestを`RuntimeComposition`、`RuntimeRun`、runtime-session return、`AgentSession`、execution context、planner
result、event、transcript、persistenceへ追加しない。internal prepared envelopeにもmanifestそのものは残さず、test
observerだけをruntime observation seamとする。

parent failureはmodel/credential/fetch/registry/tool/sessionとpersistent store list/open/allocate/lock/writeへ到達しない。
lazy failureはchild側の同じ効果へ到達せず、existing sanitized `planner delegation failed` envelopeとcounter behaviorを
維持する。retry/regenerationは行わない。

## File responsibility

| File | Responsibility |
|---|---|
| `v0/agent/resolved_manifest.ts` | schema-v1、canonical codec、SHA-256 constructor、strict validator、freeze、sanitized error |
| `v0/agent/resource_identity.ts` | shared built-in topology helper、existing Step 76 validator reuse |
| `v0/agent/runtime.ts` | two-phase prepare/materialize、parent/lazy generation-validation order、test-only factory/observer |
| `v0/agent/tui_cli.ts` | persistent store acquisitionをparent prepare成功後へ移し、record validation後にmaterializeする |
| `tests/v0/agent_resolved_manifest_test.ts` | permission-free known-answer、invariance、strict negative matrix |
| `tests/v0/agent_definition_test.ts` | shared helperとStep 76 no-regression |
| `tests/v0/agent_runtime_test.ts` | once-only/order/pre-materialization/nonleakage |
| `tests/v0/agent_session_tui_test.ts` | production default session-factory pathをfake terminal/disposable state rootで直接実行し、prepared composition、persistence ownership、store/artifact zero、record validation no-materializationを検証する |
| existing session/transport/process/TUI tests | external contract nonleakageのtargeted regressions |
| `deno.v0.json` | permission-free leaf、direct `v0:test` edge、check inventory |
| `tests/v0/offline_gate_topology_test.ts` | exact leaf/target/empty permissions/direct ownership |
| results/lifecycle docs | measured acceptance evidence |

model、transport、tool/registry behavior、session/persistence schema、CLI/TUI renderingは変更しない。

## Exact test contract

### Permission-free manifest suite

- 上記4 payload/identityをbyte-for-byte known answersとして固定する。
- BOM/whitespace/trailing LFなし、identity fieldがpayload/digest inputにないことを検証する。
- fresh objects、別workspace/source path、別instruction/skill body、別filesystem discovery orderで同じsemantic
  selectionが同じbytes/identityになることを検証する。
- Definition ID、model、instruction、skill、tool、subagent、`maxSteps`の一件差がbytes/digest差になることを検証する。
- topology-invalid mutationはcorrect digestを再計算してもstandalone validationが拒否することを検証する。
- missing/extra/order/type、symbols/accessors/non-enumerable/prototype、array subclass/sparse/extra property、duplicate/
  noncanonical order、malformed identity/version、cross-bound Definition topologyのexact negative matrixを持つ。
- constructor/validator outputのdeep freeze、non-aliasing、plain JSON round-tripを検証する。
- path/content/profile/credential/runtime markerがpayload/identity inputにないことを検証する。

### Step 76 and runtime regressions

- existing four exact selectionsは不変で、各Definitionはcorrect built-in IDだけで通る。
- skill-manifest、delegation dual-resource invariantsとsanitized Step 76 errorを維持する。
- parent/top-level planner manifestは一度だけ生成され、observerはmodel/registryより前に呼ばれる。
- no-delegationはlazy manifest 0、accepted delegationはparent/planner各1でcausal orderを持つ。
- injected invalid parent manifestはmodel/credential/fetch/registry/tool/sessionとpersistent store list/open/allocate/
  lock/writeすべて0で失敗する。
- injected invalid planner manifestはchild側の同じcounterが0でexisting sanitized delegation resultを保つ。
- factory throw/reject、malformed shape、wrong digest、cross-bound topologyも同じfailure orderを持つ。
- `agent_session_tui_test.ts`からcustom `createSession`を渡さずproduction default session-factory pathを使い、fake
  terminal、disposable state root、manifest seamとstore-operation observerを注入する。new/continue/exact-session各pathの
  manifest failureでsession JSON、lock、temp、directory allocationが増えず、store list/open/allocate/write callbackと
  materialization counterが0であることを検証する。
- valid manifest後のinvalid resumed metadataではstore handleをcloseし、model/registryをmaterializeしない既存propertyを
  production default session-factoryを通るdirect regressionで維持する。
- cancellation、parent 8 / child 8 / aggregate 16、one-child-per-turnは不変である。

### Nonleakage

unique domain markerとexact object-key assertionsにより、provider request JSON、events、committed transcript、
persistent session JSON、CLI stdout/stderr、TUI render、planner task/result、runtime/session public/test snapshotsへ
manifest field/identity/domain markerがないことを検証する。existing resource-selection nonleakageも維持する。

production provider、browser E2E、real-child PTY、real-TTY testは不要である。既存process fixtureはcustom
`createSession`でproduction persistent factoryを迂回するため、このinvariantの証拠には使わない。

## Exact permission topology

permission-free leafを一つ追加する。

```text
agent:resolved-manifest:test
```

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_resolved_manifest_test.ts
```

exact permissionsは`[]`。`resolved_manifest.ts`とdirect testを`v0:check`へ追加し、新leafを`EXPECTED_LEAVES`と
`v0:test`へexactly once追加する。target ownershipは新testだけ、permission vectorはemptyとし、existing leaf
permissionsとouter/inner topology、production/provider/credential reachability rejectionを変更しない。

## Ordered implementation increments

1. pure schema-v1 codec/constructor/validatorとknown-answer testsを追加する。
2. Step 76 topology derivationをshared helperへrefactorし、existing Definition testsを先に通す。
3. runtimeをinternal two-phase prepare/materializeへ分け、normal/ephemeral compatibility wrapperの回帰を通す。
4. parent generation/validationをprepare phaseへ接続し、failure countersを追加する。
5. persistent TUIのstore acquisitionをsuccessful prepare後、materializationをrecord validation後へ置き、new/continue/
   exact-sessionのzero-write/no-materialization regressionを追加する。
6. admitted lazy plannerを同じvalidation順序へ接続し、no-delegation/one-child/cancellationを回帰確認する。
7. provider/event/transcript/persistence/CLI/TUI/runtime nonleakage assertionsを加える。
8. permission-free taskとexact topology/check inventoryを加える。
9. focused/related tests、check/fmt/lint/diff、direct full test、owner gateを実行する。
10. results/lifecycle evidenceを作成する。
11. bounded initial review、finding closure一回、changed-lines re-review一回、owner final gateを行う。

各incrementは独立にrollback可能とし、codec/topologyをruntime wiringより先に確定する。

## Verification commands

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:resolved-manifest:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session-store:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:offline-gate:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
git diff --check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

`v0:gate`をauthoritative full offline resultとし、将来countは固定せずresultsへ実測値を記録する。

## Review and acceptance contract

initial implementation reviewはapproved plan、Step 77 diff、Step 76 helper refactor、focused/full evidence、task
topology、results/lifecycleを対象とする。環境はtrusted-local single-user pinned Deno 2.9.4、severityは
Blocker/P1/P2、上限30分、新証拠/tool result/中間結論が10分なければ中断する。canonical bytes、domain/version
binding、full hash、identity exclusion、descriptor-safe validation、cross-binding、parent/lazy failure order、
nonleakage、exact permissionsを重視する。

accepted plan-scoped findingsだけを一回修正し、changed linesとexisting findingsだけを最大一回・15分で再review
する。GO条件はBlocker/P1/P2 zero。contract変更や残存findingがあればownerへ返し追加passを自動開始しない。

`docs/plans/agent-definition-resolved-manifest-results.md`にはauthority input/plan path/hash、implementation revision、
schema/codec/domain/identity、four known answers、requirement-to-test mapping、strict negative/cross-binding、parent/lazy
countsとpre-materialization zero evidence、nonleakage、commands/counts、permission topology、review/closure、deviation、
rollback/residual risk、provider/network/credential/production/persistent-state operation zeroを記録する。

completion条件はknown answers、strict/cross-binding、failure order、nonleakage、exact topology、check/fmt/lint/diff、
direct `v0:test`、owner `v0:gate`がgreen、final Blocker/P1/P2 zero、lifecycle evidence一致である。

## Compatibility, rollback and residual risks

schema-v1 manifestはinternal、ephemeral、nonpersistentで、migration/data conversionやsession/file format変更はない。
rollbackは`resolved_manifest.ts`、shared helper refactor、runtime two-phase seam、persistent TUI acquisition ordering、関連tests、task/check/topology、Step 77
results/lifecycle entriesだけに限定し、provider、session data、workspace、user-owned `_refs/`、prior plans/resultsを
変更しない。

Residual risks:

- SHA-256 collisionは理論上可能だがfull 256-bit collision resistanceを前提とする。
- identityはstable resource IDsと`maxSteps`を同定し、instruction/skill/tool本文やprofile全fieldのcontent hashではない。
- Web Crypto failureはstartup manifest failureとなりretry/fallbackしない。
- future schemaはnew codec/domainを要し、Step 77はmigration compatibilityを提供しない。
- manifestはreplay proofではなく、workspace/task/model conditions/transcript等はStep 79の責務である。

## Explicit exclusions

- Steps 78–80、arbitrary/dynamic Definition loading、replay/execution/workspace snapshot
- persistence/file format/CLI/public API/display、instruction/skill/tool body content addressing
- provider/model/tool/registry capability、session/event/transcript/persistence schema変更
- self-revision、promotion、evaluator、lineage、additional milestone 100 hardening
- dependency/lockfile、`_refs/` refresh
- production provider/TUI、credential read、network execution
- commit、push、tag、publish、release

## Human Gate

このplanの保存、hash固定、read-only reviewとplanning-only修正までがplanning scopeである。ユーザーがcanonical
planを別途明示承認するまでproduct source、tests、`deno.v0.json`、resultsを変更せずtestを開始しない。

承認後のscopeはStep 77実装、permission-bounded offline tests、full offline gate、results/lifecycle更新、bounded
reviewだけとする。provider/network/credential/production command、actual persistent product state、dependency/
lockfile、`_refs/`、commit/push/tag/publish/releaseは含めない。
