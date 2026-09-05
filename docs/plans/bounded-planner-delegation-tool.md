# Bounded synchronous planner delegation tool plan

## Decision

**GO、初期 Human Gate 待ち。** blocking contradictionはない。

通常runtimeのbuilt-in `default` Definitionだけに、nonterminal
`delegate_to_planner({task})` toolを追加する。一つのaccepted parent turnはplanner childを
最大一回だけ同期実行できる。parentとchildはmodel request laneを各8、同一turnのaggregateを
16に固定し、全ての上限をunderlying model call、credential read、fetchより前に
provider-neutral contextでadmitする。

childはstartupで解決済みのworkspace、AGENTS instruction、immutable skill catalogを再利用し、
built-in `planner` Definitionを一回materializeする。parent transcript、mutation tool、再帰的な
delegation、filesystem rediscoveryは渡さない。background、persistence、stable run identity、
recovery、streaming、cancellation、multiple subagents、RPC/MCP/extensions、external sandboxは後続の
別incrementとする。

この計画はlocal implementation、fake model/fake fetch/process/managed PTY test、full offline gate、
results、bounded reviewまでを対象とする。production `agent:run` / `agent:tui`、real provider、network、
credentialは別Human Gateなしに実行しない。

## Authority and baseline

- 利用者承認What: synchronous `delegate_to_planner`、default only、nonrecursive、same startup
  workspace/AGENTS/skills、explicit task only、one child per parent turn、parent 8 / child 8 /
  aggregate 16、no retry/fallback
- prerequisite: `docs/plans/builtin-agent-definition-selection.md`、SHA-256
  `10098e02a2d57897f647ad202aecfa9218934f83d215dd8d8ccf211884031e5e`
- composition boundary: `docs/plans/agent-definition-composition-boundary.md`、SHA-256
  `226692cdc46f466460244dd6df655803831c30ecd06dad92a662f398367e6b55`
- delivered roadmap input: `archive/history/docs/roadmap-inputs/henji-agent-definition-composition-boundary.md`
- implementation baseline: current uncommitted working tree with full v0 gate 297 tests and
  independent review `GO`、Blocker/P1/P2 zero

既存のuncommitted changesとuser-owned `_refs/`は保持する。このincrementは前二つのDefinition
incrementへ積み上げ、rollback時にもそれらを除去しない。

## Reference policy

Henjiのsource、tests、plansをimplementation contractとする。

Cloudflare Agents snapshotはupstream commit
`2f957bc2a3ffb7aee14792bb3cb658ad3176ed93`、MITである。
`_refs/cloudflare-agents/packages/agents/src/agent-tools.ts`と
`agent-tool-types.ts`から、agent toolをtyped toolとして明示し、child start前にadmissionを確定し、
完了と失敗をbounded resultへ投影する考えだけをsupporting evidenceとして参照する。stable run ID、
detached execution、reattach、progress、recovery、cancellation、Durable Objectsは採用せず、codeを
import/copyしない。

Zot snapshot commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`、MITのbackground swarm、
subprocess、persistent session semanticsもこの同期single-child sliceには採用しない。
Cloudflare Sandbox SDK snapshot commit `664d8e36d22f2b8f286a9cac90551113afdb316c`、
Apache-2.0は参照・統合しない。planner capabilityはOS/process sandboxではない。

## Confirmed current boundary

- `v0/agent/runtime.ts`はcomposition開始時にworkspace、AGENTS、skills、Definition、model、registryを
  一度解決し、一つのcounted fetch wrapperを所有する。
- `v0/agent/loop.ts`はpositive `turn`と`maxSteps`を知るが、tool dispatchへturn contextを渡さない。
- `v0/agent/tools.ts`の`Registry.dispatch`と`Tool.execute`はtool argumentsだけを受け取る。
- `v0/agent/session.ts`はaccepted turnを逐次実行し、blank/busy submissionをturn開始前にrejectする。
  registryはsession全体で一つのため、delegation admissionをtool instance stateに置いてはならない。
- current top-level maxStepsはdefault/plannerとも8。counted fetchはexternal fetch startを観測するが、
  nested model requestを共有budgetでfail-before-generateにするseamはない。
- default registryはwork tools、optional `skill`、`submit_json_result`。planner registryはexact
  `read`、optional `skill`、`submit_json_result`である。

## Public tool contract

### Name and description

Nameはexact `delegate_to_planner`。descriptionはexactly次とする。

```text
Delegate one explicit planning task to the built-in planner for this parent turn. The planner receives only task, can read the same workspace and saved skills, cannot mutate it, and returns one bounded synchronous result. Call at most once per turn.
```

defaultだけがadvertise/constructする。top-level planner、child planner、corpus/eval registryは
advertiseもconstructもしない。

### Input

Tool definition schemaは次とする。

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": ["task"],
  "additionalProperties": false
}
```

runtime validationはexact object key `task`だけ、string、trim後nonblank、NULなし、unpaired
surrogateなし、UTF-8最大65,536 bytesを要求する。validated taskはtrimせずverbatimでchildのsole
user messageへ渡す。invalid inputはstatic `ToolInputError`となり、delegation admission、child
Definition/model/registry、credential、fetchを消費しない。

### Result

toolは常にnonterminalである。valid callをadmitした後のsuccess/failureはcanonical JSON textを
continuing success tool resultとして返し、parent modelが判断を継続できる。schema-invalid inputだけは
既存registryのerror tool resultを使う。

Assistant final success:

```json
{"ok":true,"agent":"planner","output":{"kind":"text","text":"..."},"usage":{"modelRequests":1,"externalRequests":1}}
```

Successful `submit_json_result`:

```json
{"ok":true,"agent":"planner","output":{"kind":"json","json":"{\"key\":\"value\"}"},"usage":{"modelRequests":2,"externalRequests":2}}
```

Failure:

```json
{"ok":false,"agent":"planner","error":{"code":"planner_failed","message":"planner delegation failed"},"usage":{"modelRequests":1,"externalRequests":0}}
```

failure code/messageはexactly次とする。

| code | message | condition |
| --- | --- | --- |
| `delegation_limit` | `planner delegation is limited to one execution per turn` | valid child executionが同じturnですでにadmit済み |
| `planner_failed` | `planner delegation failed` | child max_steps、contract failure、materialization/generation exception |
| `planner_output_invalid` | `planner returned an invalid result` | successful outcomeにvalid final text/terminal JSONがない、NUL/unpaired surrogate |
| `planner_output_limit` | `planner result exceeds 64 KiB` | complete success envelopeがUTF-8 65,536 bytes超過 |

child assistant final textとsuccessful terminal JSONの両方を受ける。terminal JSONはchildでは
terminalだが、delegation toolとparent turnはterminalにしない。complete serialized envelopeをUTF-8
65,536 bytes以下とし、oversizeをtruncateせずsmall fixed `planner_output_limit` envelopeへ置換する。
successにはchildが明示的にfinalとしたtextまたはcanonical JSONだけを含める。failureはchild error、
provider body、credential、transcript、tool arguments/results、workspace path、stackを含めない。
usage counterはnonnegative safe integerであり、そのexecutionのdeltaだけを示す。

## Provider-neutral per-turn execution context

新規`v0/agent/execution_context.ts`にinternal contractを置く。

- `RequestLane = 'parent' | 'child'`
- `TurnRequestBudget`
  - parent limit exact 8
  - child limit exact 8
  - aggregate limit exact 16
  - synchronous `claim(lane)`
  - immutable `{parent, child, aggregate}` snapshot
- `ParentTurnExecutionContext`
  - positive integer turn
  - one shared budget
  - synchronous `admitPlannerExecution()`
  - child lane view without delegation admission capability

budget claimは各`model.generate`の直前に行う。claim failureはunderlying modelへ入らないため、
credential sourceとfetchも0である。claimはgenerateがmissing credentialやcontract failureになっても
model request attemptとして消費し、application retry/fallbackは行わない。既存`maxSteps`は維持し、
request budgetを独立したsecond guardとする。

delegation admission orderは次とする。

1. tool argumentsを完全validate
2. parent turn contextの`admitPlannerExecution()`を同期実行
3. successした一callだけchild materializationへ進む
4. await前にflagを立て、same batch、direct `Promise.all`、将来のdispatch変更でも二重startを防ぐ
5. invalid argumentsはadmissionを消費しない
6. materialization/model/output failureは開始済みなのでadmissionを消費したまま

`Registry.dispatch(call, context?)`と`Tool.execute(arguments, context?)`へoptional internal tool
execution contextを追加する。既存tools/direct callersはcontext omissionで挙動不変とし、delegation
toolだけparent turn contextをrequiredとする。context欠落はstatic `planner_failed`ではなくinternal
misconfigurationとしてsanitized fixed failureにし、childを開始しない。

## Turn lifecycle

- one-shot `runRuntime`はone parent turn contextを生成して`runAgentTurn`へ渡す。
- `AgentSession`はruntimeから`createTurnExecutionContext(turn)` factoryを受ける。
- `submit`はblank/busy check後にturn numberを確定し、そのaccepted turn専用contextを生成する。
- contextをその`submit`のawait chainだけへ渡し、session fieldとして次turnへ再利用しない。
- busy-rejected submissionはturn/context/budget/admissionを消費しない。
- synchronous childはparent dispatchがawaitするため、parent `turn_end`後にchild workを残さない。
- failure、event sink exception、max_steps後も次accepted turnはfresh contextを得る。

generic loop/session callersへdelegation featureを強制しない。execution context optionを省略した既存
Registry/loop/sessionは従来どおり動く。normal runtimeだけがfixed 8/8/16 factoryを必ず接続する。

## Frozen child materialization

`createRuntimeComposition`はstartupで解決した次をchild factory closureへcaptureする。

- canonical workspace descriptor
- resolved AGENTS instruction string
- immutable SkillCatalog manifest/body snapshot
- parentと共有するcounted fetch wrapper
- existing credential/credentialSource seams
- fixed OpenRouter profile

admitted executionだけが次を行う。

1. captured inputsでbuilt-in `plannerAgentDefinition`をexactly once評価
2. captured workspace/catalogからplanner registryをconstruct
3. same profile、shared counted fetch、same lazy credential seamからchild modelをconstruct
4. empty committed transcriptとdelegated taskで`runAgentTurn`
5. maxSteps exact 8、shared contextのchild laneを使用
6. child event sinkなし
7. child outcomeとrequest deltasをbounded/sanitized envelopeへ変換

childは`resolveWorkspace`、`discoverAgentInstructions`、`discoverSkills`、parent transcript/event copy、
work tool construction、credential eager read、session/run identity保存を行わない。same workspaceはread toolが
同じcanonical rootを見る意味であり、workspace file内容のsnapshotを意味しない。frozenなのはstartupで
解決したworkspace identityとAGENTS/skill configurationである。

## Definition and registry topology

`v0/agent/agent_definition.ts`:

- `ProductionRegistryDefinition`へhostがmaterializeするexact planner-delegation capability declarationを
  追加する。
- `defaultAgentDefinition`だけがそのdeclarationを持つ。
- `PlannerRegistryDefinition`、default/planner profile/system instruction/maxStepsは変更しない。
- Definitionはpure declarationのまま、handler、model、session、event、executionを所有しない。

`v0/agent/registries.ts`:

- production registry materializerはrequired delegation handlerを受け取る。
- existing work tools、optional skill、JSON submissionへdelegation toolを追加する。
- planner/corpus registryは変更しない。

Expected sorted tool names:

| registry | no skills | with skills |
| --- | --- | --- |
| default | `bash`, `delegate_to_planner`, `edit`, `read`, `submit_json_result`, `write` | 左記 + `skill` |
| planner | `read`, `submit_json_result` | `read`, `skill`, `submit_json_result` |
| corpus/eval | existing exact five | existing exact five |

`agent_catalog.ts`のIDs/resolver、top-level selector、CLI/TUI selection pathは変更しない。child plannerが
delegation declarationを持たないことをcompile-time unionとexact registry testsの両方で固定する。

## Request counting

- per-turn budgetはprovider-neutral model request admissionを数える。
- current counted fetch wrapperは実external fetch startをparent/child共通で数える。
- parent `LoopOutcome.steps`はparent model request countを示す。
- child envelope `usage.modelRequests`はchild lane deltaを示す。
- child envelope `usage.externalRequests`はsynchronous child execution前後のshared fetch deltaを示す。
- one-shot `RuntimeRun.requestCount`はparent+child external fetch starts aggregateを返す。
- session/TUI `requestCount()`はcomposition累積のまま。per-turn testはsubmit前後deltaを測る。
- no-delegation pathはchild Definition/model/registry/credential/fetch/counterを0にする。

provider、model slug/profile、HTTP method/endpoint、stream flag、token bound、response schema、retry、
credential timingは変更しない。default provider requestのadvertised tool definitionsが5/6から6/7へ
変わることはこのfeatureのintentional wire-content deltaであり、schema/protocol変更ではない。omitted
`default`とexplicit `default`は新しい同一wireを持つ。top-level planner wireは不変。

## Event and transcript contract

new event kindは追加しない。parentはexisting event順だけを観測する。

```text
assistant_message
tool_call(delegate_to_planner)
tool_result(delegate_to_planner)
```

- child event/transcriptはemit、forward、map、commitしない。
- parent transcriptにはdelegation callとbounded envelopeだけを追加する。
- parentがfinalまたはtool_terminalで成功すれば通常どおりparent transcriptをcommitする。
- parent failureまたは`turn_end` sink exceptionではparent draftをrollbackするが、完了済みchild requestは
  rollbackできない。
- parent `tool_call` event delivery前のsink failureはchild execution/request 0。
- child後のparent `tool_result` delivery failureはchild execution済みだが次turn admissionはfresh。

## CLI, TUI, permission compatibility

- `agent:run` / `agent:tui` grammar、`--agent`、stdin/stdout/stderr、TTY lifecycleは不変。
- new flag、config、env、slash command、render row、child ID表示は追加しない。
- top-level `--agent planner`は従来のexact planner registryでdelegation不可。
- omitted/explicit `default`は同じnew default registryを得る。
- TUI startup selectionはsession全体で固定し、delegation admission/budgetだけ各accepted turnでresetする。
- production task permission literalsはbyte-for-byte不変。
- childはsame process/user/Deno permission envelopeだがmutation toolをadvertiseされない。security boundaryは
  model capabilityでありOS sandboxではない。

## Files and ordered implementation

### 1. Execution context

- new `v0/agent/execution_context.ts`
- `v0/agent/loop.ts`: optional context、pre-generate lane claim、dispatch context threading
- `v0/agent/tools.ts`: optional execution context on Tool/Registry
- `v0/agent/session.ts`: per-accepted-turn context factory/reset
- new `tests/v0/agent_execution_context_test.ts`
- existing loop/session tests for fail-before-model、busy/failure reset、compatibility

このsliceではまだproduction registryへtoolをadvertiseしない。

### 2. Delegation tool

- new `v0/agent/planner_delegation.ts`
- new `tests/v0/planner_delegation_test.ts`
- strict schema/runtime validation、sync admission、envelope、text/JSON mapping、output byte bound、sanitization

### 3. Definition and registry

- `v0/agent/agent_definition.ts`
- `v0/agent/registries.ts`
- `tests/v0/agent_definition_test.ts`
- `tests/v0/agent_work_tools_test.ts`または新delegation focused testでexact topology

### 4. Frozen child runtime

- `v0/agent/runtime.ts`
- `tests/v0/agent_runtime_test.ts`
- `tests/v0/agent_session_test.ts`
- `tests/v0/agent_runtime_process_test.ts`
- `tests/v0/fixtures/runtime_process_fixture.ts`

startup inputs/shared fetchをcaptureし、one-shot/session factoryへper-turn contextとchild runnerを接続する。

### 5. TUI and topology evidence

- `tests/v0/tui_controller_test.ts`
- `tests/v0/tui_process_test.ts`
- `tests/v0/fixtures/tui_process_fixture.ts`
- `tests/v0/tui_topology_test.ts`

fake session/modelだけでtwo-turn reset、busy rejection、top-level planner nondelegation、permission/task topologyを
固定する。TUI render/grammarは変更しない。

### 6. Tasks and documentation

- `deno.v0.json`: new source/testsをcheckへ追加し、permission-free
  `agent:planner-delegation:test`をgateへexactly once追加。production tasks literals不変。
- `README.md`: tool contract、limits、same-workspace/non-sandbox、deferred features
- new `docs/plans/bounded-planner-delegation-tool-results.md`
- completion時だけ`AGENTS.md`と`.handoff/handoff.md`を実績へ更新

dependency/lockfile、`_refs/`、archive、corpus dataは変更しない。

## Deterministic acceptance matrix

| case | expected evidence |
| --- | --- |
| default final、delegation unused | parent model 1、child 0、external aggregate 1 |
| basic delegation | parent model 2、child model 1、external aggregate 3、parent call/result各1 |
| child read then final | parent 2、child 2、external aggregate 4 |
| child terminal JSON | parent 2、child 1、external aggregate 3、parentはその後normal final |
| two valid calls in one batch | child execution 1、second `delegation_limit`、second child model/fetch 0 |
| invalid then valid in one batch | invalid admission 0、valid child execution 1 |
| same-context concurrent direct dispatch | admitted/executed child exactly 1、flagはawait前 |
| exact request ceilings | parent ≤8、child ≤8、aggregate ≤16、17th claim underlying model/credential/fetch 0 |
| child max_steps | one fixed `planner_failed`、admission retained、retry/fallback 0 |
| missing child credential | child model claim 1、child external 0、retry/fallback 0 |
| output exact byte bound | complete 65,536 accepted、65,537 maps fixed `planner_output_limit` ≤65,536 |
| malformed child output | NUL/unpaired surrogate maps fixed `planner_output_invalid` |
| transcript isolation | child first request has sole delegated user message、parent transcript 0 |
| frozen startup context | workspace/instruction/skill discovery each 1 total、child rediscovery 0 |
| lazy no-delegation | child Definition/model/registry/credential/fetch 0 |
| top-level planner | tools exact 2/3、delegation construction/dispatch 0 |
| two accepted TUI turns | each turn can delegate once、basic case external delta 3 each、cumulative 6 |
| busy TUI submit | new turn/context/child/request 0 |
| failed first then second turn | failed draft noncommit、second has fresh admission/budget |
| sink failure before tool_call | child execution/external 0 |
| sink failure after child result | child complete、parent draft rollback、next turn fresh |
| registry topology | default exact 6/7、planner exact 2/3、corpus exact 5 |
| CLI/process | default delegation fake-provider flow、planner remains nondelegating、sanitized channels |
| permissions | production literals unchanged、focused task permission-free、gate excludes production task |

既存terminal batch、model/result validation、snapshot、maxSteps、session commit/rollback、selector、CLI parser、
PTY、transport、work-tool、corpus/eval regressionもgreenを要求する。

## Verification commands

repository-pinned Deno 2.9.4と実在するtaskだけを使用する。

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:planner-delegation:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition-selection:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:transport:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:instructions:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:skills:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:work-tools:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:process:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:topology:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

`v0:gate`をauthoritative full offline gateとする。new focused taskはpermission-freeで、production
`agent:run` / `agent:tui` / provider tasksを実行しない。E2Eはfake provider、dummy credential、fixture
process、managed PTYに限定する。

## Review contract

実装と必要test後、independent reviewerへread-only reviewを依頼する。

- scope: approved plan、increment diff、results。直前Definition incrementsはdependency baselineとしてのみ扱う
- environment: trusted-local single-user Deno 2.9.4
- severity: Blocker/P1/P2
- initial limit: 30分。新しいevidence、tool result、intermediate conclusionが10分なければ中断
- focus: one-child admission、batch/concurrent race、8/8/16 fail-before-model/fetch、frozen context、
  transcript isolation、lazy credential/shared fetch count、non-recursion、bounded envelope、turn reset、
  event rollback、CLI/TUI/permission compatibility
- exclude: hostile same-user、OS sandbox、real provider、persistence/recovery/cancellation/streaming、SDK integration

findingを修正した場合は、changed linesと既存finding closureだけを15分以内、最大一回re-reviewする。
GO条件はBlocker/P1/P2 zero。

## Acceptance package

`docs/plans/bounded-planner-delegation-tool-results.md`へ次を記録する。

- plan path、SHA-256、implementation revision、exact changed files
- schema、description、success/failure envelope samplesとbyte bounds
- parent/child/aggregate model/external request matrix
- discovery、Definition/model/registry、credential/fetch construction counts
- one-shot、process、two-turn TUI、busy/failure/event evidence
- exact default/planner/corpus registry topology
- focused/full commands、final test count、`git diff --check`
- production task literal/permission comparison
- review findings、fix、final disposition
- deviations、rollback、residual risks
- provider/network/credential/production command、dependency/lockfile、`_refs`、commit/push/releaseがzero

## Migration and rollback

persistent data、CLI、config migrationはない。rollbackはこのincrement固有のexecution context/budget
threading、delegation tool、default registry declaration、runtime child factory、tests/tasks/docs/results/lifecycle
recordだけを除去する。existing `default`/`planner` selection、planner registry、unrelated working-tree changes、
全 `_refs/`を保持する。

## Residual risks

- plannerはmutation toolを持たないがsame OS user/process permissionsでありsandboxではない。
- child readはdelegation時点のmutable workspace file contentsを見る。frozenなのはstartup configuration。
- default requestのadvertised tool追加はmodel selection behaviorを変え得る。real-provider評価は別Human Gate。
- child completion後のparent event failureではexternal costをrollbackできない。
- complete descendant containment、same-user adversary、persistence、recovery、streaming、cancellationはdeferred。

## Stop conditions

次が必要なら実装せず、evidence、impact、必要なplan delta、verification、利用者判断を返す。

- one delegation/turn、parent 8、child 8、aggregate 16のいずれかを弱める
- session sequential/nonqueueing semanticsを変える
- childへparent transcript、mutation tool、delegation toolを渡す
- workspace/AGENTS/skills rediscoveryまたはcredential eager readを行う
- new CLI/config/env/permission/dependency、provider/profile/protocol schema変更を行う
- child event公開、background、persistence、identity/recovery、streaming/cancellationを導入する
- complete envelopeを65,536-byte limit内で安全に表せない
- unrelated working-tree changesと回避不能に競合する

## Explicitly out of scope

- background/detached execution、multiple child agents、recursive delegation
- persistent/durable run identity、history、reattach、recovery
- streaming、abort/cancellation
- RPC、MCP、extensions、plugins
- Cloudflare Agents/Sandbox SDK integration、OS/process sandbox、permission narrowing
- provider/model/profile/protocol schema、retry/fallback
- CLI flag、config、env、slash command、new TUI rendering
- workspace/AGENTS/skills rediscovery
- dependency/lockfile、corpus data、archive、`_refs/`、sibling repository
- real provider/network/credential/production command
- commit、push、tag、publish、release
