# Agent Definition fresh-runtime comparison implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 80として、一つのversioned fixed offline caseから、built-in `default`とinternal
`default-max-steps-4`用の別々のschema-v1 replay envelopeを作り、それぞれをfresh offline runtimeで一回実行する。
二つのnormalized execution recordをstrictに相関し、stable plain-text reportとして比較する。

2026-08-31のユーザーclarificationを正本として次を固定する。

- Step 79 schema、digest、manifest-budget相関は変更しない。
- `maxSteps` 8 / 4に伴い、`budget.modelRequests.parent`と`aggregate`だけを機械的派生差分として許可する。
- `budget.modelRequests.planner`、`maxExternalRequests`、`maxWallTimeMicros`は共通ceilingとする。
- その他のenvelope、Definition、resource、case条件差分は実行前に拒否する。

implementation、test、review、results/lifecycle更新は別のHuman Gateまで開始しない。

## Confirmed planning base

- repository: `main` / HEAD `55f3edc7fe12145ecdd37edaeb8484c32c3a8c81`
- tracked worktreeはplanning開始時にclean。既存untracked `_refs/*`はuser-ownedであり未参照・未変更。
- delivered input: `/tmp/planner-inputs/henji-agent-definition-fresh-runtime-comparison.md`
- input SHA-256: `1ade0a708bc059537c6c0733898590e73e1c855ed20e7df2b3428650800d6b09`
- input concept revision 26 / roadmap Step 80。
- Step 79 plan SHA-256:
  `e5327c39e01adb89569375051705135319b40de525b3c0127f910d6974a4300f`
- Step 79 results SHA-256:
  `4ad45c5aa6a8016936571e0993c24a3462378992c06f105a51e7f7e695ba5586`
- Step 79はcommit `55f3edc`で完了し、authoritative full offline gate 560/560、final
  Blocker/P1/P2 zero。
- current direct Step 79 taskは`agent:replay-record:test`。
- `replay_envelope.ts`は`modelRequests.parent === maxSteps`と
  `modelRequests.aggregate === parent + planner`を強制する。
- current loopは各model request前にstep limitを検査し、許可された最終stepのnonterminal tool batchを
  dispatch/result/transcriptへ完了した後、次requestを出さず`max_steps`で停止する。
- execution recorderはmodel/tool observations、outcome、transcript、ceilingsをstrictに相関し、token/costは
  exact `unsupported`。
- Step 80 runner/reportはまだ存在しない。

当初inputの「model request ceiling共有」とStep 79の8/4相関にはplanning Blockerがあった。plannerと独立reviewerが
NO-GOを確認後、ユーザーが上記の機械的派生差分を許可する選択肢1を承認した。clarification後の要件とlive repository
stateに残るblocking conflictはない。

initial planning reviewはP2 2件を検出した。accepted call/result境界をdispatch有無から分離してsynthetic resultと
observer failure precedenceを固定し、nested result/count/state schemaと完全なliteral report bytesを追加した。single
narrow re-reviewは全件Closed、GO、Blocker/P1/P2 zero。

## Scope and boundaries

このincrementは次だけを追加する。

1. fixed comparison caseと二run-specの導出・pair validation
2. Step-80-only opt-in loop observation seam
3. fresh scripted runtime二件のoffline実行
4. strict bounded comparison result
5. pure stable plain-text report
6. permission-free focused testsとoffline gate topology integration

次は変更しない。

- runtime event/session/persistence/provider contracts
- normal `runRuntime`、CLI、TUI、public selector
- Step 79 manifest/envelope/record schema、digest、known answers
- production registry、provider adapter、credential handling
- dependency/lockfile、persistent state、`_refs`
- production command、provider/network attempt、commit/push/tag/publish/release

## File responsibilities

| File | Responsibility |
|---|---|
| new `v0/agent/fresh_runtime_comparison.ts` | fixed case、run-spec、pair validator、fresh fixture composition、runner、strict result、sanitized error |
| new `v0/agent/fresh_runtime_comparison_report.ts` | strict result projectionとstable bounded plain-text renderer |
| `v0/agent/loop.ts` | standard optionsへ露出しないStep-80-only observed-run wrapperとexact boundary callbacks |
| new `tests/v0/agent_fresh_runtime_comparison_test.ts` | pair、known answers、fresh execution、failure、order、report、nonleakage |
| `tests/v0/agent_loop_test.ts` | model/tool boundary exact-onceとnormal unobserved path regression |
| `deno.v0.json` | permission-free direct task、check、`v0:test` composition |
| `tests/v0/offline_gate_topology_test.ts` | exact source/test ownership、permission、production reachability、gate composition |
| `docs/plans/agent-definition-fresh-runtime-comparison-results.md` | implementation後の実測証拠、review、final disposition |
| `README.md`、`AGENTS.md`、`.handoff/handoff.md` | implementation後のcurrent stateとcheckpointだけを同期 |

`runtime.ts`、`events.ts`、`execution_record.ts`、`replay_envelope.ts`、`resolved_manifest.ts`のbehavior/schema変更は
不要である。

## Fixed comparison case

`fresh_runtime_comparison.ts`はexactly one compile-time caseを所有する。exact case key orderは次とする。

```text
schemaVersion, caseId, task, workspace, modelIdentity, initialTranscript,
ceilings, scriptId, toolFixtureId
```

```ts
interface FreshRuntimeComparisonCaseV1 {
  readonly schemaVersion: 1;
  readonly caseId: "v1.default-max-steps-comparison";
  readonly task: "Complete four uppercase checks, then finish.";
  readonly workspace: AgentReplayEnvelopeV1["workspace"];
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscript: readonly Message[];
  readonly ceilings: {
    readonly plannerModelRequests: 0;
    readonly maxExternalRequests: 0;
    readonly maxWallTimeMicros: 1_000_000;
  };
  readonly scriptId: "five-step-uppercase-v1";
  readonly toolFixtureId: "uppercase-text-v1";
}
```

workspace descriptorはStep 79 fixed content identitiesを再利用する。

| Relative path | Content identity |
|---|---|
| `AGENTS.md` | `henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf` |
| `deno.v0.json` | `henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4` |

- actual file read、workspace scan、Git inspectionは行わない。
- production constantもnegative testと同じstrict validatorを通す。
- exact keys/order、plain data、finite IDs、bounds、workspace order、model identity、empty initial transcript、fixed
  ceilingsを検証し、fresh deeply frozen snapshotを返す。
- `caseId`をreportのtask identifierとして使い、task本文はreportへ出さない。

## Fresh Definition and run-spec derivation

各runは別のDefinition evaluationを所有する。

1. fixed caseをstrict snapshotする。
2. 同じimmutable comparison conditionsからfresh `AgentDefinitionInput` wrapperを二つ作る。
3. fixed `evaluateComparisonVariant`を二回呼ぶ。
4. 第一評価のvalidated `parent` / `parentManifest`をcurrentへ使う。
5. 第二評価のvalidated `variant` / `variantManifest`をvariantへ使う。
6. 各評価内で既存Step 78 sole-axis relationship validatorを通す。
7. run間のfreshnessとstable semantic projectionを検証する。

二評価間でDefinition top-level wrapper、resource selection、manifestはdistinctでなければならない。profile、workspace
descriptor、empty skill catalog等のimmutable declaration inputは同条件の証明として共有可能だが、model instance、
registry implementation、tool/model counters、abort stateは共有しない。

Exact run-spec key order:

```text
side, runOrdinal, definitionId, definition, manifest, envelope, scriptId, toolFixtureId
```

```ts
interface FreshRuntimeRunSpec {
  readonly side: "current" | "variant";
  readonly runOrdinal: 1 | 2;
  readonly definitionId: "default" | "default-max-steps-4";
  readonly definition: ResolvedAgentDefinition;
  readonly manifest: AgentResolvedManifestV1;
  readonly envelope: AgentReplayEnvelopeV1;
  readonly scriptId: "five-step-uppercase-v1";
  readonly toolFixtureId: "uppercase-text-v1";
}
```

run ordinalはexecution orderでなくsemantic sideへ固定する: current `1`、variant `2`。

## Envelope budgets and known answers

### Current

```text
definitionId: default
maxSteps: 8
modelRequests: parent 8 / planner 0 / aggregate 8
maxExternalRequests: 0
maxWallTimeMicros: 1000000
manifest identity:
henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58
envelope identity:
henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8
```

### Variant

```text
definitionId: default-max-steps-4
maxSteps: 4
modelRequests: parent 4 / planner 0 / aggregate 4
maxExternalRequests: 0
maxWallTimeMicros: 1000000
manifest identity:
henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
envelope identity:
henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633
```

二envelope identityはplanning時にexisting Step 79 constructorとrepository-pinned Deno 2.9.4をpermission-freeで
独立再計算し一致した。implementation testではconstructor、validator、exact compact payload bytes、domain-separated
identityをbyte-for-byte固定する。

## Pair validation

pair validatorは両runtimeのmodel/tool/recorder作成前に完了する。

1. fixed case schema、shape、bounds、ownership。
2. exact side order、semantic run ordinals、Definition IDs。
3. 各Step 78 evaluationのentryとrelationship。
4. current `default` / 8、variant `default-max-steps-4` / 4。
5. 各Definition resource selectionとmanifestのexact correlation。
6. 各manifestのstandalone revalidationとidentity再計算。
7. 各envelopeのstandalone revalidationとidentity再計算。
8. case ID、task、workspace、model identity、initial transcript、script/tool fixture IDの一致。
9. planner request、external request、wall-time ceilingの一致。
10. resource arraysのlength/order/string value一致。
11. stable Definition projectionの一致。
12. exact allowed difference projection。
13. unknown difference zero。

Stable Definition projectionはmodel provider/profile identity、registry declaration kind、planner-delegation declaration、
agent instructions、skill manifest/skill identities、system instruction、resource identity sequenceだけを比較する。opaque
runtime objectやworkspace contentをserializeしない。

Exact allowed differences:

```text
manifest.definitionId
manifest.parameters.maxSteps
manifest.identity
envelope.budget.maxSteps
envelope.budget.modelRequests.parent
envelope.budget.modelRequests.aggregate
envelope.identity
```

`modelRequests.parent`と`aggregate`はそれぞれ`maxSteps`および`parent + planner`から再導出し、独立の変更軸として
扱わない。

次をpre-executionでsanitized rejectionする。

- task、workspace、model、initial transcript一件差
- planner/external/wall ceiling一件差
- resource identityのmissing/extra/reorder/value差
- wrong side、ordinal、Definition ID、parent/variant relationship
- same manifest、same envelope、wrong manifest/envelope identity
- correctly rehashed wrong `maxSteps`
- derived parent/aggregate以外のbudget差、またはderived値が8/4と一致しないcase
- unknown/extra/accessor/symbol/non-plain/caller-mutated shape

## Step-80-only observation seam

standard `AgentLoopOptions`やeventsへrecorderを追加しない。`loop.ts`内部のprivate runnerへoptional observer引数を追加し、
次の専用wrapperだけがobserverを渡せるようにする。

```ts
runAgentTurnObservedForComparison(
  task,
  committedTranscript,
  model,
  registry,
  observer,
  options,
)
```

normal `runAgentTurn` / `runAgent`はprivate runnerへ`undefined` observerを渡す。runtime、session、CLI、TUIは専用
wrapperをimportしない。

```ts
interface AgentComparisonExecutionObserver {
  readonly modelSettled: (
    kind: "final" | "tool_calls" | "error" | "cancelled",
  ) => void;
  readonly toolCallAccepted: (call: ToolCall) => void;
  readonly toolResultAccepted: (result: ToolResultContent) => void;
}
```

`toolCallAccepted`は`Registry.dispatch`の実行ではなく、current loopが一件のcallをevent/counterへ反映した境界を表す。
したがってinvalid terminal multi-call batchのようにdispatchしないcallも、exactly one call observationとexactly one
synthetic result observationを持つ。method名とrecord semanticsに`dispatch`を使わず、未dispatch callをdispatch済みと
表現しない。

Exact callback order:

### Model attempt

```text
request admission
steps += 1
model.generate settlement
result/error/cancelled classification
observer.modelSettled(...)
normal outcome/transcript processing
```

- valid `final` / `tool_calls`はresult shape検証後、assistant transcript追加前に一回通知する。
- model throwまたはinvalid resultは`error`を一回通知してからcurrent contract-failure処理へ進む。
- accepted requestのcancellationは`cancelled`を一回通知してからcurrent cancellation処理へ進む。
- request admission前のfailureはmodel attemptではないため通知しない。

### Accepted tool call

```text
tool_call event delivery succeeds
toolCallCount += 1
observer.toolCallAccepted(call)
post-counter cancellation arbitration
invalid-terminal handling or Registry.dispatch
```

- event delivery前またはcounter increment前のfailureはaccepted callではないため通知しない。
- invalid terminal batch、unknown tool、normal dispatch、tool failureの全てが同じaccepted-call boundaryを使う。

### Accepted tool result

normal dispatch resultとloop-generated synthetic resultの双方で次の順序を使う。

```text
normalized ToolResultContent is selected
tool_result event delivery succeeds
toolResultCount += 1
observer.toolResultAccepted(result)
tool transcript batch processing
```

- invalid terminal batchは`terminalBatchError(call)`をresultsへ追加後、同じevent/counter/observer順を使う。
- unknown tool、invalid arguments、tool execution errorもnormalized resultとして同じboundaryを使う。
- event deliveryまたはcounter increment前のfailureはaccepted resultではないため通知しない。
- recorder用result projectionはbounded `{text: result.text}`、outcome、terminalだけで、progress/raw error/runtime objectを
  含めない。

observer callbackはexisting model-generate catch、registry-dispatch catch、tool-normalization catchの外側に置く。callback
throwを`model contract failure`や`tool execution error`へ変換しない。model observer throwはassistant message追加前、call
observer throwはdispatch前、result observer throwはtool transcript batch前にobserved wrapperをrejectする。Step 80
runnerのouter boundaryだけがfixed comparison errorへsanitizeする。

Focused loop testsはnormal dispatch、invalid-terminal synthetic result、unknown/error resultのcall→result observationを
event/counter順とexactに相関する。model-final/error、tool-call、normal/synthetic-result各observerのsentinel throwが
exact identityでrejectされ、LoopOutcomeやtool errorへ変換されないこと、call throw後のdispatch、result throw後の
transcript commit、late callbackがzeroであること、observer未指定pathが不変であることを直接固定する。

## Fresh offline runtime composition

各run execution開始時に次を新規作成する。

```text
scripted model instance
side-effect-free uppercase tool instance
Registry instance
AgentExecutionRecorder
injected clock
commit tracker
model/tool/request counters
abort controller/state
transcript working state
```

comparison runtimeはvalidated Definition/manifest/system instruction/maxStepsを使うが、OpenRouter modelやproduction
work-tool registryはmaterializeしない。fixed scripted modelとfixture registryは同じcomparison conditionをofflineで
再生するためのStep-80-only materializationである。Definition model identityはenvelope比較条件として保持し、scripted
modelをprovider実行と偽らない。external request countはexact zero。

## Deterministic five-step fixture

両runへ同じfinite scriptの別instanceを渡す。

```text
step 1: uppercase_text(call-1, {"text":"one"})   -> "ONE"
step 2: uppercase_text(call-2, {"text":"two"})   -> "TWO"
step 3: uppercase_text(call-3, {"text":"three"}) -> "THREE"
step 4: uppercase_text(call-4, {"text":"four"})  -> "FOUR"
step 5: assistant final "comparison complete"
```

各script stepはrequest transcriptの直前suffix、call ID/name/arguments、prior success resultをexactに確認する。toolは
run-local ordinalを持ち、1–4以外の順序、再利用、extra callを拒否する。tool executionはmemory-onlyであり、filesystem/
network/provider/process side effectを持たない。

### Exact expected records

| Field | Current | Variant |
|---|---:|---:|
| `runOrdinal` | 1 | 2 |
| state | completed | stopped |
| `ok` | true | false |
| `stopReason` | final | max_steps |
| `committed` | true | false |
| `terminalKind` | none | none |
| steps / parent model requests | 5 | 4 |
| planner / external requests | 0 / 0 | 0 / 0 |
| parent tool calls/results | 4 / 4 | 4 / 4 |
| transcript messages | 10 | 9 |
| last model result | final | tool_calls |
| provider token usage / cost | unsupported / unsupported | unsupported / unsupported |

currentはsuccessful finalのcommit callbackをexactly once呼ぶ。variantは第四tool resultとtool messageをtranscriptへ
入れた後、current loopのpost-batch `steps >= limit`で停止し、fifth model attemptとcommit callbackはzero。

各known-answer clockはfreshに`1000`, `2250`を返し、両durationを`1250` microsecondsへ固定する。別testではduration
だけを変え、pair validity、identity、state、descriptive non-duration deltaが不変であることを確認する。

## Runner failure contract

internal public failureは一種類にする。

```ts
class AgentFreshRuntimeComparisonError extends Error {
  message = "agent fresh-runtime comparison failed";
}
```

runnerはcase/pair setup、Definition/manifest/envelope、model/registry/tool/clock/recorder construction、model throw/invalid/
script drift、tool throw/error/order drift、observer/recorder poison、outcome/transcript/counter/correlation、unexpected stop、
first/second run、partial second runの全failureを一つのouter sanitized boundaryで扱う。

first runが成功してもsecond runが失敗した場合、record、partial result、reportを返さない。raw cause、task、path、
arguments、result、markerをerrorへ付加しない。

## Comparison result

Exact top-level shape and property order:

```ts
interface AgentFreshRuntimeComparisonResultV1 {
  readonly schemaVersion: 1;
  readonly caseId: "v1.default-max-steps-comparison";
  readonly shared: AgentFreshRuntimeComparisonShared;
  readonly current: AgentFreshRuntimeRunResult;
  readonly variant: AgentFreshRuntimeRunResult;
  readonly allowedEnvelopeDiff: AgentFreshRuntimeAllowedEnvelopeDiff;
  readonly executionDelta: AgentFreshRuntimeExecutionDelta;
}

interface AgentFreshRuntimeComparisonShared {
  readonly taskIdentifier: "v1.default-max-steps-comparison";
  readonly workspaceEntryCount: 2;
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscriptCount: 0;
  readonly plannerModelRequestCeiling: 0;
  readonly maxExternalRequestCeiling: 0;
  readonly maxWallTimeMicros: 1_000_000;
  readonly scriptId: "five-step-uppercase-v1";
  readonly toolFixtureId: "uppercase-text-v1";
}

interface AgentFreshRuntimeRunResult {
  readonly runOrdinal: 1 | 2;
  readonly definitionId: "default" | "default-max-steps-4";
  readonly manifestIdentity: AgentResolvedManifestIdentity;
  readonly envelopeIdentity: AgentReplayEnvelopeIdentity;
  readonly maxSteps: 8 | 4;
  readonly state: "completed" | "stopped";
  readonly counts: AgentFreshRuntimeRunCounts;
  readonly record: AgentExecutionRecordV1;
  readonly causalToolPath: readonly AgentFreshRuntimeCausalToolNode[];
}

interface AgentFreshRuntimeRunCounts {
  readonly modelRequests: number;
  readonly externalRequests: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

interface AgentFreshRuntimeCausalToolNode {
  readonly ordinal: number;
  readonly name: string;
  readonly outcome: "success" | "error";
}
```

Run-result semantics:

- `state === "completed"` iff validated record is successful with `final` or `tool_terminal`。
- `state === "stopped"` iff validated record is unsuccessful with `max_steps`。fixed resultはcurrent
  `completed/final`とvariant `stopped/max_steps`だけを受理し、contract failure、cancelled、tool terminalはwhole-comparison
  failure。
- `counts.modelRequests`はaggregate、`counts.externalRequests`はexternal、`counts.steps`はparent model requests、
  `counts.toolCalls` / `toolResults`は各aggregate。planner countsは両runでexact zero。
- every countはvalidated recordからderiveし、caller supplied duplicate authorityを持たない。
- record ordinal、identity、maxSteps、outcome、countsはcontaining runへexact correlateする。
- causal pathはvalidated tool call/result observationsからordinal/ID/nameを相関してderiveし、transcriptから再構成しない。
  最大32 nodes / 4,096 UTF-8 bytesでarguments/result textを含めない。

Every descriptive pair has exact property order `current, variant`。

```ts
interface AgentFreshRuntimePair<T> {
  readonly current: T;
  readonly variant: T;
}

interface AgentFreshRuntimeAllowedEnvelopeDiff {
  readonly definitionId: AgentFreshRuntimePair<
    "default" | "default-max-steps-4"
  >;
  readonly maxSteps: AgentFreshRuntimePair<8 | 4>;
  readonly parentModelRequestCeiling: AgentFreshRuntimePair<8 | 4>;
  readonly aggregateModelRequestCeiling: AgentFreshRuntimePair<8 | 4>;
  readonly manifestIdentity: AgentFreshRuntimePair<AgentResolvedManifestIdentity>;
  readonly envelopeIdentity: AgentFreshRuntimePair<AgentReplayEnvelopeIdentity>;
}

interface AgentFreshRuntimeExecutionDelta {
  readonly state: AgentFreshRuntimePair<"completed" | "stopped">;
  readonly stopReason: AgentFreshRuntimePair<"final" | "max_steps">;
  readonly committed: AgentFreshRuntimePair<boolean>;
  readonly modelRequests: AgentFreshRuntimePair<number>;
  readonly externalRequests: AgentFreshRuntimePair<number>;
  readonly steps: AgentFreshRuntimePair<number>;
  readonly toolCalls: AgentFreshRuntimePair<number>;
  readonly toolResults: AgentFreshRuntimePair<number>;
  readonly durationMicros: AgentFreshRuntimePair<number>;
  readonly providerTokenUsage: AgentFreshRuntimePair<"unsupported">;
  readonly cost: AgentFreshRuntimePair<"unsupported">;
}
```

Allowed diff fixed values are definition `default` / `default-max-steps-4` and maxSteps/parent/aggregate `8` / `4`。
parent/aggregate are re-derived from maxSteps and shared planner ceiling zero, not independent axes。Execution delta fixed values are
completed/stopped、final/max_steps、true/false、model 5/4、external 0/0、steps 5/4、tools 4/4、duration 1250/1250、
token/cost unsupported/unsupported。It is a descriptive pair, not subtraction、ranking、or winner。

result validatorはexact plain-data shape/order、fresh deep-frozen ownership、record correlation、pair values、causal boundsを
検証する。durationを除いたsemantic projectionだけをexecution-order invarianceへ使い、record transcriptやfull envelopeを
rendererへ直接stringifyしない。

## Stable plain-text report

Rendererはstrict resultだけを入力とする。leading/blank lines zero、two-space indentation、key separator `: `、pair
separator ` -> `、causal separator ` > `、LF-only、trailing spaces zero、final line後exact one LFを固定する。known-answer
UTF-8 textは次である。

```text
agent_definition_fresh_runtime_comparison
schema_version: 1
case_id: v1.default-max-steps-comparison
shared:
  task_identifier: v1.default-max-steps-comparison
  workspace_entry_count: 2
  model_identity: model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0
  initial_transcript_count: 0
  planner_model_request_ceiling: 0
  max_external_request_ceiling: 0
  max_wall_time_micros: 1000000
  script_id: five-step-uppercase-v1
  tool_fixture_id: uppercase-text-v1
current:
  run_ordinal: 1
  definition_id: default
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58
  envelope_identity: henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8
  max_steps: 8
  state: completed
  stop_reason: final
  committed: true
  model_requests: 5
  external_requests: 0
  steps: 5
  tool_calls: 4
  tool_results: 4
  causal_tool_path: 1:uppercase_text:success > 2:uppercase_text:success > 3:uppercase_text:success > 4:uppercase_text:success
  duration_micros: 1250
  provider_token_usage: unsupported
  cost: unsupported
variant:
  run_ordinal: 2
  definition_id: default-max-steps-4
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
  envelope_identity: henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633
  max_steps: 4
  state: stopped
  stop_reason: max_steps
  committed: false
  model_requests: 4
  external_requests: 0
  steps: 4
  tool_calls: 4
  tool_results: 4
  causal_tool_path: 1:uppercase_text:success > 2:uppercase_text:success > 3:uppercase_text:success > 4:uppercase_text:success
  duration_micros: 1250
  provider_token_usage: unsupported
  cost: unsupported
allowed_envelope_diff:
  definition_id: default -> default-max-steps-4
  max_steps: 8 -> 4
  parent_model_request_ceiling: 8 -> 4
  aggregate_model_request_ceiling: 8 -> 4
  manifest_identity: henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58 -> henji-agent-resolved-manifest:v1:sha256:90121c85e8c3a26f48eeca0ede02667584cd9056d53ba85173b2022812dca389
  envelope_identity: henji-agent-replay-envelope:v1:sha256:d2100020f44dbb1072d39c3ad83f5adc842f120d6725c26e4188bd61a352a0e8 -> henji-agent-replay-envelope:v1:sha256:09251dd6a3028d50efe09dbe31e2cbc19418556c3c659ee1d5ebd12c9212b633
execution_delta:
  state: completed -> stopped
  stop_reason: final -> max_steps
  committed: true -> false
  model_requests: 5 -> 4
  external_requests: 0 -> 0
  steps: 5 -> 4
  tool_calls: 4 -> 4
  tool_results: 4 -> 4
  duration_micros: 1250 -> 1250
  provider_token_usage: unsupported -> unsupported
  cost: unsupported -> unsupported
```

Known-answer bytes end immediately after exact suffix `  cost: unsupported -> unsupported\n`。

Renderer contract:

- report全体をUTF-8 16 KiB以下に固定。
- validated identifiers、identities、enums、safe integers、bounded causal nodesだけを明示変換する。
- objectのimplicit `String()`やgeneric `JSON.stringify`を使わない。
- task本文、workspace path/digest/content、instruction/skill本文、tool arguments/result text、absolute path、credential
  marker、raw provider metadata、stream/progress、runtime objectsを含めない。
- `winner`、`score`、`recommendation`、`promotion`、quality判断を持たない。
- durationは表示のみで、identity、pair validity、pass/fail、state判定に使わない。
- provider token usageとcostはexact `unsupported`。
- exact string/`TextEncoder` testで全separator、indentation、LF-only、final LF、trailing-space zeroを一回で検証する。

## Ordered implementation increments

### 1. Pair data boundary

- fixed case validator、two fresh evaluation/run-spec derivation、exact pair validator、two known-answer envelopesを追加。
- exact fresh evaluation count 2、complete unauthorized-difference matrix、pair acceptance前のfixture construction zeroを検証。

### 2. Exact observation seam

- comparison-only observed loop wrapper、model/tool exact boundary callbacksを追加。
- final/tool-calls/error/cancelled exact-once、accepted call/result exact-once、dispatch-zero synthetic result、normalized
  errors/terminal boundary、callback failure precedence、observer omitted path invarianceを検証。

### 3. Fresh execution and record correlation

- fresh model/tool/registry/clock/recorder/abort/commit state、exact records、whole-comparison failure arbitrationを追加。
- 5/4 model、4/4 tools、10/9 transcript、final/max_steps、true/false commit、external/planner zero、ownership、全failure
  pathを検証。

### 4. Result and report

- frozen strict result、stable bounded renderer、descriptive deltasを追加。
- exact report known answer、reverse order、duration non-decisive、unsupported usage、nonleakageを検証。

### 5. Offline integration and closure

- permission-free leaf、exact offline topology ownership、check/fmt/lint/full gate inclusionを追加。
- focused/full verification、bounded review、results/lifecycle evidenceをHuman Gate内で完了する。

## Success-criteria evidence mapping

| SC | Required evidence |
|---|---|
| 1 | one fixed case、exact current/variant manifest/envelope known answers、clarified allowed differences only |
| 2 | task/workspace/model/transcript/shared-ceiling/resource mutation matrix、wrong ID/relationship/identity/maxSteps/derived-budget rejection before fixture creation |
| 3 | two Definition evaluations、distinct Definition/selection/manifest/model/tool/registry/clock/recorder/abort/counter ownership |
| 4 | exact current 5/4/final/committed and variant 4/4/max_steps/uncommitted records、transcript/observation correlation |
| 5 | current-first/variant-first semantic resultとreport equality excluding duration、ordinal remains 1/2 |
| 6 | setup/runtime/model/tool/observer/recorder/correlation/partial-second-run all return fixed sanitized error only |
| 7 | exact one-screen report order、allowed definition/envelope differences、descriptive delta、no winner/score/recommendation |
| 8 | injected-clock known answer、varied duration non-decisive、token/cost exact unsupported |
| 9 | production modules do not import comparison modules/observed wrapper、runtime/CLI/TUI/event/session/persistence no-regression |
| 10 | new leaf permissions `[]`、exact source/test/check ownership、topology mutations、full offline gate |

## Required focused tests

`tests/v0/agent_fresh_runtime_comparison_test.ts` must cover:

- fixed case、manifest/envelope payload and identity known answers
- exact allowed diff including derived parent/aggregate
- task、workspace、model、initial transcript一件差
- planner、external、wall ceiling一件差
- each resource identity missing/extra/reorder/value mutation
- wrong Definition ID、entry、relationship、manifest/envelope identity
- same manifest/envelope、wrong maxSteps、wrong derived parent/aggregate
- exact nested top-level/shared/run/count/pair/allowed-diff/execution-delta keys/order
- state derivation、contradictory state/outcome rejection、aggregate count semantics
- record/run identity、ordinal、maxSteps、counts、causal-path correlation
- current/variant exact observations、records、counts、commit、stop
- fresh ownership and evaluator/fixture call counts
- current-first / variant-first
- setup/model/tool/observer/recorder/clock/correlation/partial-second failure
- fixed and varied duration、token/cost unsupported
- exact literal report values/separators、LF-only、blank-line zero、trailing-space zero、final LF exact one、16 KiB bound、
  forbidden content non-exposure

Non-exposure markers include:

```text
task-body-marker
workspace-content-marker
absolute-path-marker
credential-marker
raw-provider-marker
progress-marker
unbounded-tool-marker
[object Object]
```

`tests/v0/agent_loop_test.ts` must directly cover observed wrapper semantic boundaries and normal wrapper invariance。

## Task and permission topology

Add exact leaf:

```text
agent:fresh-runtime-comparison:test
```

Exact command:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt \
  tests/v0/agent_fresh_runtime_comparison_test.ts
```

Permissions: `[]`。

Topology changes:

- add both new source modules to exact check target inventory
- assign the new test file exactly once to the new leaf
- insert the leaf exactly once after `agent:replay-record:test` in `v0:test`
- add leaf/source/test permission and ownership snapshots
- assert production runtime/CLI/TUI do not import comparison modules or observed wrapper
- retain existing forbidden provider/network/credential/production-task grammar
- mutation tests for missing/duplicate leaf、permission addition、target drift、check omission、production import reachability

## Verification

Focused:

```text
agent:fresh-runtime-comparison:test
agent:test
agent:definition:test
agent:resolved-manifest:test
agent:comparison-variant:test
agent:replay-record:test
agent:runtime:test
agent:runtime:process:test
agent:tui:test
agent:tui:process:test
agent:tui:topology:test
v0:offline-gate:topology:test
```

Full owner gate:

```text
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

planning中に実行したのはknown-answer digestのpermission-free再計算だけで、test/gateは実行していない。

## Rollback

このincrementはinternal source/test/taskだけで、schema/data migrationやpersistent artifactを持たない。

1. new comparison/report/test modulesを削除。
2. `loop.ts`のobserved comparison wrapper/private callbacksを戻す。
3. `deno.v0.json`のleaf/check/full compositionを戻す。
4. offline topology inventory/expectationsを戻す。
5. results/lifecycleを未実装状態へ整合する。

provider、credential、network、session、database、workspace cleanupは不要。

## Completion evidence and Human Gate

Step 80 completeには次を全て要求する。

- clarified pair contractを満たす二known-answer envelope
- exact current/variant normalized records
- exact report known answerとnonleakage
- complete pair mutation/failure/order/freshness evidence
- permission-free exact topology
- Step 76–79/runtime/CLI/TUI no-regression
- check/fmt/lint/direct/full gate green
- independent bounded reviewとowner final Blocker/P1/P2 zero
- no plan delta、stop condition、unplanned bug
- provider/network/credential/production command/persistence/dependency/lockfile/`_refs`/commit/push/tag/publish/release
  operation zero

未解決のWhy/What/Whether判断はない。次の停止点は、このcanonical planに対する別の初期implementation Human Gateである。
