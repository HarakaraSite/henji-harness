# Agent Definition local comparison variant implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 78として、compile-time固定のinternal comparison catalogへexactly one variantを追加する。

- variant ID: `default-max-steps-4`
- parent ID / resource topology: `default`
- sole changed axis: `maxSteps`
- parent / variant values: `8` / `4`

variantは一度だけ評価した既存`defaultAgentDefinition`のresolved resultから、resource selectionだけを狭く
置換して導出する。model、profile、registry、workspace、instructions、skills、system instruction、resource
identities、tool/subagent topologyを複製しない。

`BuiltinAgentId`、`BUILTIN_AGENT_IDS`、`resolveBuiltinAgent`、`--agent`、CLI/TUI help、runtime selectionは
`default` / `planner`のまま変更しない。variantはdirect comparison API/testからだけ到達でき、実行runtimeへ
接続しない。

Step 77 schema-v1のcodec/domain/property orderは変更せず、manifestに使用できるfinite internal ID domainだけへ
`default-max-steps-4`を追加する。variant manifestはshared mappingにより`default` topologyへ結び、`maxSteps`
exactly `4`だけを許す。既存4 known-answer payload/identityはbyte-for-byte不変とする。

## Confirmed planning base

- repository HEAD: `59b4ab3cc1325d4f9c8daae057b1e61a46b33fbb`
- tracked worktreeはclean。untracked user-owned `_refs/*`は保持する。
- delivered input: `/tmp/planner-inputs/henji-agent-definition-local-comparison-variant.md`
- input SHA-256: `7c99b4dbbd353f722e0b70e57fc9489f1acc87e06ab0dac21f29820a03b097c6`
- input concept revision 24 / roadmap Step 78
- Step 77 plan SHA-256:
  `9321cbb783844261647c6479757a1a17196eef67ae2771a0ba2bb58151456d3c`
- Step 77 results SHA-256:
  `891cbfefb15c33b0f45410a2f806fc7672b72082a9d66ca8433917b56a882a6b`
- Step 77 commit/gate: commit `59b4ab3`、manifest 9、full gate 537、final Blocker/P1/P2 zero。
- `agent_definition.ts`はpure synchronousな`defaultAgentDefinition` / `plannerAgentDefinition`と
  `DEFAULT_AGENT_MAX_STEPS = 8`を所有する。
- `agent_catalog.ts`のproduction-selectable domainはexact `default` / `planner`である。
- `resource_identity.ts#validateAgentResourceTopology`はStep 76/77共用のexact default/planner topology
  validatorである。
- `resolved_manifest.ts`はschema-v1 compact UTF-8 codec、domain-separated full SHA-256、strict
  descriptor-safe validationを実装済みである。
- `runtime.ts`と`tui_cli.ts`は`BuiltinAgentSelection`だけを使う。Step 78 variantをここへ接続しない。
- `deno.v0.json`と`tests/v0/offline_gate_topology_test.ts`がdirect test ownershipとexact permissionsを固定する。

確認済み要件とlive repository stateにblocking conflictはない。

## Finite identity domains and module boundary

循環importとpublic selector拡張を避けるため、新規dependency-free identity-contract module
`v0/agent/agent_identity.ts`を置く。このmoduleはstring domainだけを所有し、Definition、catalog entry、manifest、
runtime objectをimportしない。

```ts
export const BUILTIN_AGENT_IDS = Object.freeze(["default", "planner"] as const);
export type BuiltinAgentId = typeof BUILTIN_AGENT_IDS[number];

export const COMPARISON_VARIANT_IDS = Object.freeze([
  "default-max-steps-4",
] as const);
export type ComparisonVariantId = typeof COMPARISON_VARIANT_IDS[number];

export const AGENT_MANIFEST_DEFINITION_IDS = Object.freeze([
  ...BUILTIN_AGENT_IDS,
  ...COMPARISON_VARIANT_IDS,
] as const);
export type AgentManifestDefinitionId =
  typeof AGENT_MANIFEST_DEFINITION_IDS[number];

export type AgentResourceTopologyId = BuiltinAgentId;
```

| Domain | Exact values | Reachability |
|---|---|---|
| `BuiltinAgentId` | `default`, `planner` | production startup selector |
| `ComparisonVariantId` | `default-max-steps-4` | internal direct comparison only |
| `AgentManifestDefinitionId` | all three | internal schema-v1 manifest |
| `AgentResourceTopologyId` | `default`, `planner` | shared topology validator |

`agent_catalog.ts`は`BUILTIN_AGENT_IDS`と`BuiltinAgentId`をimport/re-exportする。既存import pathとruntime valueを
維持し、`DEFINITIONS`、`DEFAULT_AGENT_SELECTION`、resolverは`default` / `planner`だけを含む。
`resource_identity.ts`はdependency-free moduleから`AgentResourceTopologyId`だけをimportし、variant IDを直接
受けない。`resolved_manifest.ts`は`AgentManifestDefinitionId`をimportし、finite manifest-ID contractを所有する。

## Schema-v1 manifest ID/topology contract

schema version、property order、payload encoding、domain、identity grammarを変えず、`definitionId`の型だけを
`AgentManifestDefinitionId`へ広げる。`resolved_manifest.ts`にexactなinternal contract tableを一つ置く。

| Manifest ID | Resource topology | Fixed parameter |
|---|---|---|
| `default` | `default` | Step 77 positive-safe-integer contract |
| `planner` | `planner` | Step 77 positive-safe-integer contract |
| `default-max-steps-4` | `default` | `maxSteps === 4` |

mappingはfrozenかつinherited-key safeで、`AgentManifestDefinitionId`に対してexhaustiveに型付けする。
internal resolver `resolveManifestDefinitionContract(id)`相当はexact three IDsだけを受理し、frozen contractを返す。
unknown/malformed/inherited IDは既存sanitized `AgentResolvedManifestError`で拒否し、Definition/runtime stateはresolve
しない。

constructorとvalidatorは同じmappingを使い、(1) contract resolve、(2) selection/resource list validation、
(3) `validateAgentResourceTopology(contract.topologyId, resources)`、(4) optional fixed maxSteps、(5) existing
canonical payload/digestの順で処理する。comparison metadataをschema-v1 payloadへ追加しない。

correctly rehashedであっても、variant IDとplanner topology、extra/missing default resource、`maxSteps !== 4`の
組み合わせはstandalone validationで拒否する。

### Runtime built-in correlation boundary

manifest ID domainを3値へ広げても、既存runtimeのdirect-test factory seamからvariantへ到達させない。
`resolved_manifest.ts`にcomparison catalogをimportしないgeneric correlation helperを追加する。このhelperは
standalone validation済みmanifest、runtimeが要求した`BuiltinAgentId`、validated `AgentResourceSelection`を受け、
次をexactに要求する。

- `manifest.definitionId === requestedBuiltinId`
- manifestとselectionのresource arraysがlength/order/string valueまで同一
- manifestとselectionの`maxSteps`が同一

`runtime.ts#prepareResolvedManifest`はfactory candidateのstandalone validation直後、observer/model/registry/
credential/fetchより前にこのcorrelation checkを通す。production pathとparent/lazy plannerの双方に同じ順序を使う。
したがってcorrectly hashed `default-max-steps-4` manifestを`default` runtimeへ返すfactoryや、同じbuilt-in IDでも
異なるresource/maxStepsを持つmanifestはsanitized manifest errorとなり、observer/materialization/host effectは0になる。

この変更はruntimeにcomparison module/variant IDをimportさせず、既存built-in Definitionとmanifestの相関を強化する
だけである。runtime result/provider/event/transcript/session/persistence shapeは変えない。

## Fixed known-answer fixtures

### Variant, no workspace instruction or skills

```json
{"schemaVersion":1,"definitionId":"default-max-steps-4","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":4}}
```

```text
henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
```

### Variant, workspace instruction and skills `format`, `review`

```json
{"schemaVersion":1,"definitionId":"default-max-steps-4","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","instruction:project-skill-manifest","instruction:workspace-agents","skill:format","skill:review","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:skill","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":4}}
```

```text
henji-agent-resolved-manifest:v1:sha256:26c9197ad70e1f2b89cc574f7da67d2bb9d1c78b3d80879450518fb3e5ab54e0
```

既存Step 77の4 payloadとidentityをexact regression fixtureとして維持する。

| Definition/context | Full identity suffix |
|---|---|
| `default`, no instruction/skills | `bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58` |
| `default`, workspace + `format`/`review` | `7b45d146eecac2dd0f1126889f5d0728b64535e1294ad68556b42d1825545505` |
| `planner`, no instruction/skills | `fc23e5faaddf628f2d30adee4793c196db3e9b5cfc5714629193fbc6c3bd30eb` |
| `planner`, workspace + `format`/`review` | `6974dafb9c9ea74c7bfc93046d5920cc829c5d7d6c75629d51e885d3b75ecc5a` |

codec、domain、property order、hashingの変更によりこれらが変わることを許さない。

## Internal comparison catalog

新規`v0/agent/comparison_variant.ts`がexactly one raw compile-time declarationを所有する。

```text
id: default-max-steps-4
parentId: default
changedAxis: maxSteps
parentMaxSteps: 8
variantMaxSteps: 4
```

validated entryは`topologyId`をmanifest contract mappingからmechanically deriveし、raw declarationへ複製しない。
conceptual result shapeは次とする。

```ts
interface ComparisonVariantEntry {
  readonly id: ComparisonVariantId;
  readonly parentId: BuiltinAgentId;
  readonly topologyId: AgentResourceTopologyId;
  readonly changedAxis: "maxSteps";
  readonly parentMaxSteps: 8;
  readonly variantMaxSteps: 4;
}
```

production constant catalogはnegative direct testと同じconstructor/validatorを通す。そのvalidatorはexact plain
data objects、finite ID set、duplicate/missing/unknown、exact keys/literals、symbols/accessors/prototype、caller
ownershipを検査し、fresh frozen entries/catalogを返す。parent/topologyはmapping上の`default`へbindする。

`resolveComparisonVariant(id)`はfrozen entryだけを返しDefinitionを評価しない。unknown inputは受信値をechoしない
`AgentComparisonVariantError("invalid agent comparison variant")`で拒否する。arbitrary constructor、second variant、
runtime-generated entry、extension hookは追加しない。

## Narrow variant derivation

comparison evaluatorはfixed `AgentDefinitionInput`とvalidated entryを受け、次の順で処理する。

1. `default-max-steps-4`をinternal catalogからresolveする。
2. `defaultAgentDefinition(input)`をexactly once評価する。
3. parentを`validateResolvedAgentResources(parent, "default")`で検証する。
4. `DEFAULT_AGENT_MAX_STEPS === 8`かつparent `maxSteps === 8`を要求する。
5. comparisonだけが所有するparent declaration envelopeをfreezeする。
6. parentと同じresource stringsを持つfresh `AgentResourceSelection(maxSteps: 4)`を構築する。
7. 全non-selection declarationsをparentから共有し、selectionだけを置換したfresh variant resultを作る。
8. variant selectionを`default` topologyで検証する。
9. mechanical sole-axis validatorを実行する。
10. variant IDでschema-v1 manifestを生成しstandalone validationする。
11. catalog metadata、parent、variant、manifestを持つfresh frozen comparison resultを返す。

evaluatorは既存Web Crypto digest以外pureであり、workspace discovery、model construction、credential read、fetch、
registry/tool materialization、session creation、writeをしない。

parent top-level/model declaration/registry declarationはcomparison-owned envelopeとしてfreezeし、existing frozen
selectionを保持する。external `PROFILE`、workspace、skill-catalog objectをfreeze/cloneしない。variantはfresh frozen
top-level/selection/resources/parametersを所有し、parentとexact same model/registry declarations、instructions、skill
catalog、system instructionを共有する。runtime implementation objectをmanifestへ変換したり再帰的にmutateしない。

## Mechanical sole-axis relationship validator

validatorはserialized object comparisonでなくexact descriptors、scalar equality、intentional reference equalityを使う。

parent/variant双方のtop-level own enumerable data keysをcanonical order
`model`, `registry`, `agentInstructions`, `skillCatalog`, `systemInstruction`, `resourceSelection`で要求し、
missing/extra/symbol/accessor/non-plain objectを拒否する。

non-axis contract:

- top-levelはdistinct
- modelとregistry declarationはreference-identical
- model provider/profile、registry kind/workspace/skillCatalog/plannerDelegationは同一
- agent instructions、skill catalog、system instructionは同一
- registryとtop-levelは同じskill catalogを参照
- registryはexact production default topology
- entry parent/topology IDsは`default`

axis/selection contract:

- selections、resources arrays、parameters objectsはそれぞれdistinct
- 両selectionはStep 76 immutable validatorと`default` topologyを通る
- resource arraysはlength/order/string valuesがexactly equal
- parent `maxSteps === DEFAULT_AGENT_MAX_STEPS === 8`
- variant `maxSteps === 4`
- normalized projectionで唯一のsemantic differenceは
  `resourceSelection.parameters.maxSteps`

explicit stable projectionはprovider、profile reference、registry kind、workspace/catalog references、delegation、
instructions、system instruction、resource strings、maxSteps、top-level descriptors、ownership relationsだけを含む。
workspace/profile/catalog runtime objectをstringifyしない。任意のnon-axis driftはsanitized comparison errorになる。

## Public-selection and runtime isolation

次をexactに維持する。

```text
BuiltinAgentId = "default" | "planner"
BUILTIN_AGENT_IDS = ["default", "planner"]
DEFAULT_AGENT_SELECTION.id = "default"
resolveBuiltinAgent(undefined) -> default
resolveBuiltinAgent("default") -> default
resolveBuiltinAgent("planner") -> planner
resolveBuiltinAgent("default-max-steps-4") -> sanitized rejection
```

comparison moduleをruntime/CLI/TUI/provider/events/session/persistence/production registryへimportしない。
`agent_catalog.ts`からcomparison catalog/resolver/evaluatorをre-exportしない。manifest/comparison metadataをprovider
wire、event、transcript、session record、persistence、CLI/TUI output、planner envelopeへ追加しない。runtimeを使う
variant test seamも作らない。

既存manifest factory seamはbuilt-in correlation helperでfail closedとする。これはvariant execution seamではなく、
factory outputがrequested built-in Definitionのvalidated selectionをexactに表すことを保証する境界である。

## File responsibility

| File | Responsibility |
|---|---|
| new `v0/agent/agent_identity.ts` | finite built-in/comparison/manifest/topology ID domains |
| `v0/agent/agent_catalog.ts` | built-in ID import/re-export; selectable catalog不変 |
| `v0/agent/resource_identity.ts` | topology ID type import; behavior不変 |
| `v0/agent/resolved_manifest.ts` | manifest ID contract、variant→default topology、fixed maxSteps 4、built-in correlation helper |
| new `v0/agent/comparison_variant.ts` | fixed catalog、parent transform、relationship validator/evaluator |
| `v0/agent/runtime.ts` | validated manifestをrequested built-in ID/selectionへobserver前にcorrelate |
| new `tests/v0/agent_comparison_variant_test.ts` | catalog/derivation/drift/known-answer/isolation evidence |
| `tests/v0/agent_resolved_manifest_test.ts` | 2 variant answers/negativesと既存4 answers |
| `tests/v0/agent_catalog_test.ts` | exact public IDs/resolutionとvariant rejection |
| `tests/v0/agent_runtime_test.ts` | valid variant/wrong-selection factory injectionのpre-effect rejection |
| `deno.v0.json` | source/test check targets、permission-free leaf、direct full-test edge |
| `tests/v0/offline_gate_topology_test.ts` | exact leaf ownership、permissions、check inventory |
| Step 78 results/lifecycle docs | implementation後のmeasured evidence |

`agent_definition.ts`、TUI、model、registry、tool、event、session、persistence behaviorは変更しない。runtime変更は
manifest factory outputのcorrelation failure boundaryだけに限定する。

## Exact direct test contract

### Catalog and derivation

- exact comparison ID set、one frozen entry、metadata、resolver identityを検証する。
- unknown/malformed/inherited ID、duplicate/missing/second ID、wrong parent/axis/8→4、shape/accessor/symbol/prototype、
  post-construction caller mutationを拒否する。
- no-context/no-skillsとworkspace+`format`/`review`でparent evaluation exactly onceを検証する。
- parent/variantのfrozen/distinct top-level、shared model/registry/profile/workspace/catalog/instructions、fresh frozen
  selection/resources/parameters、equal resources、exact 8/4を検証する。

### Mechanical drift negatives

各axisを一つずつmutateし、model provider/profile、registry kind/workspace/catalog/delegation、instructions、system
instruction、resource add/remove/replace/reorder、selection/resource/parameters alias、wrong parent/variant maxSteps、
top-level shape/accessor/symbol/prototype、wrong parent/topology mappingをすべて拒否する。errorはinstruction/body/path/
profile/credential markerを含まない。

### Manifest and public isolation

- variant 2件と既存4件のcanonical payload/identityをexactに検証する。
- matching parentとのresource equality、payload sole differences、different identitiesを検証する。
- workspace path、instruction body、skill body/source、discovery order、fresh object identityに依存しないことを検証する。
- correctly rehashed wrong topology/resource/maxStepsとunknown manifest IDを拒否する。
- exact built-in IDs、omitted/default/planner resolution、variant pre-evaluation rejection、CLI/TUI help非露出、catalog
  module non-re-export、runtime result shape/nonleakageを検証する。
- runtime manifest factoryからcorrectly hashed variant manifestを`default` parentへ返すcase、およびsame built-in IDで
  resourceまたはmaxStepsがselectionと異なるcaseを注入し、observer/model/registry/credential/fetch前のsanitized
  rejectionを検証する。lazy plannerでもID/selection correlation helperが同じ順序で使われることを固定する。
- variantをruntime/TUI/provider/tool dispatch経由で実行しない。

## Exact permission topology

permission-free leafを一つ追加する。

```text
agent:comparison-variant:test
```

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_comparison_variant_test.ts
```

exact permissionsは`[]`。new source/testを`v0:check`へ追加し、direct test ownershipを一度だけ登録する。leafを
`EXPECTED_LEAVES`とdirect `v0:test` compositionへ一度だけ追加し、このtest fileだけへmapする。既存leafの
permissionsを変えず、read/write/run/env/net/sysを一切広げない。

## Ordered implementation increments

1. 本planをhashし、initial implementation Human Gateで停止する。
2. finite identity-domain moduleを追加し、public catalogを広げずimportをrewireする。
3. manifest contractをvariant topology/fixed maxStepsへ拡張し、既存4 answersを先に確認する。
4. built-in manifest correlation helperを追加し、parent/planner factory seamのpre-effect rejectionを固定する。
5. one-entry catalogとstrict constructor/resolverを追加する。
6. one-evaluation parent→variant transformとowned-envelope freezingを追加する。
7. sole-axis validatorとcomplete non-axis mutation testsを追加する。
8. variant 2 answersとdeterministic invariance testsを追加する。
9. public selector rejection/nonreachability evidenceを追加する。
10. permission-free leafとcentral topology/check inventoryを追加する。
11. focused/related/full offline verificationとresults/lifecycle evidenceを完了する。
12. bounded review、one finding-closure pass、one narrow re-review、owner final gateを実施する。

## Verification commands

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:comparison-variant:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:resolved-manifest:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition-selection:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:offline-gate:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
git diff --check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

provider、credential、network、production CLI/TUI、browser E2E、新規real-TTY testは不要。`v0:gate`をauthoritative
full offline resultとし、future test countは固定せずresultsへ実測値を書く。

## Review contract

initial implementation reviewはapproved plan、Step 78 diff、identity mapping、comparison derivation/validator、
focused/full evidence、task topology、results/lifecycleをBlocker/P1/P2で30分以内に確認する。10分間新しい証拠、
tool output、中間結論がなければ中断する。

重点はpublic ID非拡張、runtime非到達、一回のparent evaluation、copied implementation不在、sole-axis 8→4、
non-axis declaration/ownership、manifest binding、factory seam correlation、six known answers、permission topology、
nonleakageとする。

finding closureはplan-scoped findingsに対するone passだけとし、second variant、public/runtime selector、schema field、
Why/What/Human Gateを追加しない。narrow re-reviewはchanged linesと既存finding closureだけを15分以内に一度行い、
GOはBlocker/P1/P2 zeroを要求する。scope拡張が必要ならownerへ返す。

## Acceptance package

implementation後に`docs/plans/agent-definition-local-comparison-variant-results.md`を作り、authority/plan hashes、
revision、finite sets/catalog、public resolver不変、parent evaluation count、ownership/sole-axis evidence、six answers、
requirements/tests、negative cases、standalone manifest rejection、runtime factory correlation/nonreachability、commands/counts、permissions、
review closure、deviations/rollback/residual risks、external operation zeroを記録する。

completionはexact one-entry catalog、8→4/equal resources、all non-axis checks、six answers、public rejection、runtime
path zero、topology/check/fmt/lint/diff/direct/full gate、final Blocker/P1/P2 zero、reviewed treeとlifecycle evidenceの一致を
要求する。

## Compatibility, rollback and residual risks

migrationやpersistent conversionはない。schema-v1は維持し、internal finite ID contractだけが一値増える。rollbackは
new identity/comparison modules、import rewiring、manifest extension、direct tests、task/check/topology entries、Step 78
docs/lifecycle entriesに限定する。runtime/session data、prior plans/results、user-owned `_refs/`を変更しない。

residual risks:

- variantはstable declarationsとreference relationsを比較し、implementation body hashを比較しない。
- workspace/profile/catalogはopaqueだが、一回のresolution内でexact reference reuseを要求する。
- internal moduleはexplicit path import可能であり、isolationはdependency directionとproduction non-importで守る。
- SHA-256 collision resistanceはStep 77と同じ前提である。
- Step 78はcomparison materialだけを作り、equal-condition execution/qualityはSteps 79–80へ残す。

## Explicit exclusions

second variant/matrix、arbitrary runtime maxSteps、他axis variant、runtime/CLI/TUI selection、dynamic loader/API/file
format、replay/snapshot/execution record、comparison runner/benchmark/UI、scoring/promotion/lineage/self-revision、provider/
event/session/persistence schema changes、dependency/lockfile、`_refs/`、provider/network/credential/production command、
external persistent state、commit/push/tag/publish/release、milestone 100 hardeningは対象外。

## Human Gate

このplanning authorizationはread-only inspection、canonical plan/lifecycle planning statusの記録、plan hashing、
planning reviewだけを含む。product source、tests、task configurationを変更せず、implementation testsを実行しない。

別途implementation承認後はStep 78 repo implementation、permission-free/direct offline tests、existing full offline gate、
results/lifecycle updates、bounded reviewとone closure/re-review cycleだけを許可する。provider/network/credential/
production command、external persistent state、dependency/lockfile、`_refs/`、commit/push/tag/publish/releaseは含まない。
