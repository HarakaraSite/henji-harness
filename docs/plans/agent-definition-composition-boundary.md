# Agent Definition composition boundary implementation plan

## Decision summary

**GO、初期Human Gate待ち。**

Planning baseはHEAD `06565b7`、記録済みfull offline baselineは266 tests、直近owner final
dispositionはBlocker/P1/P2 zeroである。

このincrementは、外部CLIを変えずにprovider/modelとproduction tool registryを明示する内部構成境界を
追加し、単一のdefault TypeScript Agent Definitionからmodel、instructions、skills、tools、有限loop
parameterを解決する。Definitionは純粋な宣言関数とし、現行`createRuntimeComposition`がhost resourceを
解決して宣言をmaterializeする。loop、transcript、event、session、tool実行、streaming、UIのownershipは
移動しない。

これはDefinition単独の大規模refactorや新公開機能ではない。次の通常runtime composition incrementとして、
現行の暗黙なprovider/model・registry選択を薄い内部境界へ抽出する。

## Requirement and reference decisions

正本入力は
`docs/roadmap-inputs/henji-agent-definition-composition-boundary.md`、SHA-256
`4befcdb6489d3ad6a44328896508a1fc49f42cff45a469022c68c8fee1ffb1ec`である。

OpenComputerの限定参照はApache-2.0、upstream commit
`d54f2c239a293216ff13f069ffc1ed7b853f9761`の次のsnapshotとする。

- `_refs/opencomputer/agent/README.md`
- `_refs/opencomputer/agent/src/index.ts`
- `_refs/opencomputer/README.md`

TypeScript関数がmodel、instructions、capabilitiesをagent構成として宣言する考えだけを採用する。
OpenComputer codeはimport/copyしない。次は明示的に逸脱する。

- HenjiはDefinitionをruntime/session compositionごとに一度だけ評価し、model callごとに再評価しない。
- reactive hook、global render context、managed deploymentを導入しない。
- snapshotに`useSkill`はないため模倣せず、Henji既存`SkillCatalog`をDefinition input/outputとする。
- snapshotに有限loop hookはないため、`maxSteps`はHenji固有のDefinition fieldとする。
- managed sandbox、secret、schedule、billing、self-hostingを採用しない。

Zot commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`からは既に採用済みのcompositionと
agent coreの分離を維持する。model、system instruction、Registry、max stepsをcoreへ渡し、Definitionが
loop/session/UIを所有しない。

## Confirmed current boundary

現行`v0/agent/runtime.ts`の`createRuntimeComposition`は次を直接行う。

1. counted fetch wrapper作成
2. workspace解決
3. workspace `AGENTS.md` discovery
4. project-local skill snapshot discovery
5. system instruction composition
6. production Registry構築
7. `OpenRouterAgentModel`構築
8. 別定数`MAX_STEPS = 8`をone-shot/sessionへ供給

`agent:run`は`runRuntime`、`agent:tui`は`createRuntimeSession`から同じcomposition seamへ到達する。
一方、`OpenRouterAgentModel`は`v0/model.ts`の`PROFILE`を内部importしてmodel slug、endpoint、method、
stream、completion token、credential envを固定している。adapterをDefinition内で単にconstructするだけでは
model選択がDefinitionから読めないため、本計画では宣言とhost materializationを分離する。

## Declarative Agent Definition contract

新規`v0/agent/agent_definition.ts`へ次と同等のinternal contractを置く。

```ts
export interface OpenRouterModelDefinition {
  readonly provider: 'openrouter';
  readonly profile: OpenRouterAgentProfile;
}

export interface ProductionRegistryDefinition {
  readonly kind: 'production';
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
}

export interface AgentDefinitionInput {
  readonly workspace: Workspace;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
}

export interface ResolvedAgentDefinition {
  readonly model: OpenRouterModelDefinition;
  readonly registry: ProductionRegistryDefinition;
  readonly agentInstructions?: string;
  readonly skillCatalog: SkillCatalog;
  readonly systemInstruction?: string;
  readonly maxSteps: number;
}

export type AgentDefinition = (
  input: AgentDefinitionInput,
) => ResolvedAgentDefinition;

export const DEFAULT_AGENT_MAX_STEPS = 8;
export const defaultAgentDefinition: AgentDefinition;
```

`defaultAgentDefinition`は次だけを同期的・純粋に宣言する。

- `model.provider: 'openrouter'`
- `model.profile: PROFILE`
- `registry.kind: 'production'`と、受け取ったworkspace・immutable skill catalog
- 受け取ったagent instructions・skill catalogと既存`composeSystemInstruction`結果
- `maxSteps: DEFAULT_AGENT_MAX_STEPS`

`PROFILE`を複製・移動・変更しない。Definitionにはfetch、credential値/source、filesystem、request counter、
work-tool test seamを渡さない。argv、environment、file、serializationからDefinitionを選ぶ経路も作らない。

## Provider profile and adapter contract

`v0/agent/openrouter_model.ts`にadapterが実際に消費するstructural contractを追加する。

```ts
export interface OpenRouterAgentProfile {
  readonly id: string;
  readonly model: string;
  readonly origin: string;
  readonly path: string;
  readonly method: 'POST';
  readonly secretEnv: string;
  readonly maxCompletionTokens: number;
  readonly stream: false;
}
```

現行`PROFILE`は形と値を変えずこのcontractを満たす。`OpenRouterAgentModelOptions`にはinternalな
`profile?: OpenRouterAgentProfile`だけを追加し、constructorは`options.profile ?? PROFILE`をcaptureする。
adapter内の次の`PROFILE`参照だけをcaptured profileへ置換する。

- credential fallback env name
- request bodyのmodel、stream、max completion tokens
- default endpointのorigin/path
- HTTP method

既存test用`endpoint`はprofile-derived endpointより優先する。fetch、credential、credential source、timeout、
parent signalのseamとlazy timingは変えない。`PROFILE`の`requestLimit`、`retry`、budget metadataを含む
完全なshape、legacy `v0/model.ts`、acceptance/eval/report consumerは変更しない。profile未指定の既存constructorは
引き続きexact `PROFILE`を使う。

## Host materialization and runtime contract

`RuntimeTestSeam`にはtest-only `agentDefinition?: AgentDefinition`だけを追加し、既存infra seamを維持する。
productionは常に`defaultAgentDefinition`を使う。これはpublic selectorではない。

`createRuntimeComposition`は次を一度だけ行う。

1. counted fetch wrapper作成
2. workspace解決
3. 既存seamでagent instructions discovery
4. 既存seamでimmutable skill catalog discovery
5. supplied-or-default Definitionをresolved inputsでexactly once評価
6. `definition.model.provider`をexhaustiveにmaterializeし、declared profile、counted fetch、既存credential
   seamから`OpenRouterAgentModel`を構築
7. `definition.registry.kind`をexhaustiveにmaterializeし、declared workspace/catalogとhost-owned work-tool
   seamから`createProductionRegistry`を構築
8. materialized model、Registry、system instruction、max steps、request counterを返す

host materializerは`runtime.ts`のsmall private helperとする。`RuntimeComposition`は次を追加する。

```ts
readonly maxSteps: number;
```

`runRuntime`と`createRuntimeSession`は共に`composition.maxSteps`を渡す。`runtime.ts`の既存
`MAX_STEPS` exportは`DEFAULT_AGENT_MAX_STEPS`のalias/re-exportとして維持し、sentinelと既存test importを
壊さない。

## Ownership boundaries

Definitionが所有するのは、provider/profile、instruction inputs/final system instruction、skill snapshot、
production registry kind、finite per-turn request parameterという構成判断だけである。

既存componentは次のownershipを維持する。

- `runtime.ts`: workspace、counted fetch、credential/test seam、materialization、composition lifecycle
- `openrouter_model.ts`: provider wire、lazy credential read、transport
- `registries.ts`、work tools、skills: concrete tool construction/executionとdiscovery規則
- `loop.ts`: request loop、ceiling enforcement、tool dispatch、stop reason
- `session.ts`: transcript、turn ordering、commit/rollback、events
- CLI/TUI: invocation、output、TTY/controller/render/terminal lifecycle

Definition評価はmodel generation、fetch、credential read、tool execution、session/event/UI constructionを行わない。

## Scope and file changes

- new `v0/agent/agent_definition.ts`: pure contracts、default Definition、canonical max steps
- `v0/agent/openrouter_model.ts`: structural profile、optional explicit profile、captured profile使用
- `v0/agent/runtime.ts`: once evaluation、exhaustive materialization、composition max steps、互換export
- new `tests/v0/agent_definition_test.ts`: permission-free pure Definition tests
- `tests/v0/agent_runtime_test.ts`: host materialization、single evaluation、one-shot/session wiring tests
- `tests/v0/agent_openrouter_model_test.ts`: explicit profileとdefault byte-equivalence tests
- `deno.v0.json`: source/test check追加、permission-free `agent:definition:test`、focused taskをgateへexactly once追加
- `README.md`: CLI/TUIが一つのinternal startup Definitionを共有し、selectorを追加しないことを短く記録
- new `docs/plans/agent-definition-composition-boundary-results.md`: acceptance evidence
- completion時のみ`AGENTS.md`と`.handoff/handoff.md`をmeasured resultへ更新

`tests/v0/agent_definition_test.ts`はpure functionだけを扱いpermissionを要求しない。workspace resolutionを使う
host wiring testは、既に必要permissionを持つ`agent:runtime:test`へ追加し、permission-free taskのために新しい
runtime seamを発明しない。

## Deterministic test matrix

| Requirement | Direct evidence |
| --- | --- |
| Exact default provider/model | Definition outputが`openrouter`とexact `PROFILE`を保持 |
| Pure declaration | Definition評価中fetch 0、credential-source 0、tool execution 0、session/event/UI creation 0 |
| Instructions | injected discovery結果とexact composed system instructionを保持 |
| Skills | immutable catalog/manifestを保持しbodyをsystem instructionへeager inclusionしない |
| Production tools | materialized registryはskillsなしでexact 5 tools、callable skillありで`skill`だけ追加 |
| Finite parameter | default/projectionはexact 8、injected 1-step Definitionはone nonterminal response後`max_steps` |
| Single evaluation | one `runRuntime`でspy Definition 1回、two-turn session全体でも1回 |
| Shared CLI/TUI composition | one-shot/sessionが同じDefinition contractから同じprofile、system instruction、tools、max stepsを得る |
| Lazy credential | composition/session startupでcredential source 0、first generation時だけread |
| Request count | counted fetch startだけがrequest countを増やす既存contractを維持 |
| Explicit profile wire | offline alternate profileがmodel、derived endpoint、method、stream、completion tokenへ反映 |
| Default compatibility | profile省略と`profile: PROFILE`でendpoint、method、headers、request body bytesが一致 |
| Endpoint precedence | explicit test endpointがprofile origin/pathより優先 |
| External compatibility | runtime/process/session/transport/instructions/skills/work-tools/TUI/topology suites green |
| Permission topology | `agent:run`/`agent:tui` literals不変、focused Definition test permissionなし、production task未実行 |

alternate profileはoffline dummy dataだけを使い、新provider/profileをproductへ追加しない。error code/count、sanitized
text、legacy report ID/model/budgetの既存regressionも維持する。

## Ordered implementation

1. Plan SHA-256を固定し、初期Human Gateで停止する。
2. pure Definition contracts、default declaration、canonical max stepsを追加する。
3. adapterへexplicit structural profileを追加し、defaultとexplicit `PROFILE`のbyte-equivalenceを証明する。
4. runtimeへonce evaluationとexhaustive host materializationを追加する。
5. one-shot/sessionを`composition.maxSteps`へ接続し、`MAX_STEPS`互換exportを維持する。
6. pure Definition、runtime wiring、adapter profileのfocused testを追加する。
7. task/check/gate wiringとREADMEを更新し、production task literal/permissionを不変に保つ。
8. focused/related regressions、full offline gate、diff checkを実行する。
9. resultsとowner lifecycle文書をmeasured evidenceで更新する。
10. bounded read-only review、採用finding修正、最大1回のchanged-lines re-reviewを行う。

## Validation commands

実装gateではprovider、credential、production runtime、network commandを実行しない。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_openrouter_model_test.ts
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

`v0:gate`をauthoritative regressionとし、focused failureが別境界を示さない限り追加のprovider/process matrixは
作らない。

## Review contract

initial independent read-only reviewは、approved plan、changed diff、関連test/config/resultsを対象とする。
実環境はtrusted-local single-user Deno runtime、severityはBlocker/P1/P2、上限30分、新しい証拠・tool result・
中間結論が10分なければ中断する。provider/network/credential実行とspeculative hostile same-user hardeningは
対象外とする。

reviewは特に次を確認する。

- default Definitionがcompositionごとに一度だけ評価される
- provider/profileがDefinitionから明示され、wire byte・lazy credential・request countingが不変
- CLI/TUIに第二のconstruction pathが残らない
- Registry、instructions、skills、max stepsがbehavior-equivalent
- loop/session/event/tool execution/UI ownershipがDefinitionへ移動していない
- public selector/config、production permission、dependency変更がない
- local gateにproduction/provider/credential taskが含まれない

accepted finding修正後、変更箇所とfinding closureだけを15分以内・最大1回re-reviewする。GO条件は
Blocker/P1/P2 zeroとする。

## Acceptance package

results文書へ次を記録する。

- plan path/SHA-256、planning/implementation revision、exact changed files
- Definitionのmodel、instructions、skills、tools、max stepsと成功条件のevidence mapping
- focused/full command resultsとfinal test counts
- production task literal・permission topology不変
- one-shot/two-turn sessionのDefinition evaluation count
- startup時credential read/fetch zero、default/explicit profile wire byte-equivalence
- review findings、fix、re-review disposition
- deviation、remaining risk、rollback
- provider/network/credential/production command実行zero

完了条件はfocused checksと`v0:gate` green、`git diff --check` clean、文書整合、review
Blocker/P1/P2 zeroである。

## Out of scope

- multiple Definitions、runtime/public selection、API/flag/config/environment selection
- serialization、inheritance/diff、versioning、variant/lineage
- per-call/per-turn reactive evaluation、benchmark、candidate、promotion、self-revision
- new provider/model/tool/skill、provider profile値・budget・wire変更
- streaming、persistence、compaction、cancellation、MCP、extensions、RPC、subagents
- provider/network/credential/production execution
- dependency/lockfile、`_refs/`、archive、sibling repository
- commit、push、tag、publish、release

## Stop conditions and rollback

次が必要になった場合は、証拠、影響、plan delta、検証方法を返して停止する。

- current behavior維持にDefinitionのper-call/per-turn評価が必要
- CLI/TUIが同じcontractを使えない、または外部挙動が変わる
- provider/profileまたはRegistryを宣言出力にすると意味論が変わる
- `PROFILE`、legacy report/budget、provider request bytes、credential timing、endpoint overrideが変わる
- loop/session/event/tool execution/UI ownershipを移す必要がある
- public selector/config、dependency、permission、wire変更が必要
- unrelated working-tree changeと回避不能に競合する

rollbackは新Definition source/test/task/resultsを除き、adapterのexplicit profile対応とruntimeの直接composition、
direct `MAX_STEPS`利用、increment固有README/AGENTS/handoff変更だけを戻す。unrelated差分や`_refs/`をresetしない。

## Human Gate

このplanの承認は、internal default Definition、explicit internal provider/profile declaration、thin
`createRuntimeComposition` materialization、permission-free focused tests、既存offline regression、task/check/gate
wiring、README/results/owner lifecycle update、bounded reviewだけを許可する。

production `agent:run`/`agent:tui`、provider/network request、credential access、dependency/lockfile、`_refs/`、
commit、push、tag、publish、releaseは許可しない。
