# Built-in Agent Definition selection implementation plan

## Decision summary

**GO、初期Human Gate待ち。blocking contradictionは確認されていない。**

現行のshared runtime composition boundaryを拡張し、compile-time built-in Definitionを正確に
`default`と`planner`の二つだけ持つcatalogを追加する。`agent:run`と`agent:tui`は同じresolverで起動時に
一度だけ選択し、そのDefinitionを既存composition boundaryへ渡す。

`--agent`省略時は`default`を選び、現行CLI/TUI入出力、provider wire、tool topology、instruction
composition、permissions、credential timingを維持する。TUIへ選択IDは表示せず、既存PTY/render outputを
変えない。

`planner`はmodel capability boundaryであり、OS/process sandboxではない。production taskのDeno
permissionsは変更しない。

## Confirmed baseline

- preceding composition plan:
  `docs/plans/agent-definition-composition-boundary.md`、SHA-256
  `226692cdc46f466460244dd6df655803831c30ecd06dad92a662f398367e6b55`
- current uncommitted baseline: Definition 2、runtime 18、OpenRouter 16、full v0 277、review
  Blocker/P1/P2 zero
- `createRuntimeComposition`はworkspace、AGENTS、skills discovery後にDefinitionを一度評価し、modelと
  Registryをmaterializeする
- `agent:run`は現在、piped inputのzero argvまたはexact `--task TEXT`だけを受理する
- `agent:tui`は現在zero argv、real-TTY preflight、raw acquisition前session composition、session全体で
  一つのcompositionを使う
- existing constructorsから`read`、conditional `skill`、`submit_json_result`だけのRegistryを新toolなしで
  構成できる
- active worktreeには直前incrementとuser-owned `_refs/` additionsがあり、全て保持する

## Reference decisions

Cloudflare snapshotsはselector設計を直接決めない。approved WhatとHenji既存composition seamが正本であり、
以下はbounded supporting/future evidenceとする。

Cloudflare Agents:

- upstream commit `2f957bc2a3ffb7aee14792bb3cb658ad3176ed93`、MIT
- `_refs/cloudflare-agents/packages/agents/src/agent-tools.ts`と`agent-tool-types.ts`のtyped class dispatch、
  explicit `agentType`、stable run identityは、agent identityとexecution dispatchを明示的・typedに保つ判断を
  支持する
- code/interfaceはcopyしない
- `agentTool`、subagents、stable child run、detached execution、lifecycle/recovery、persistence、streaming、
  abort、MCP、deployment、frontend、voice、emailは採用しない

Cloudflare Sandbox SDK:

- upstream commit `664d8e36d22f2b8f286a9cac90551113afdb316c`、Apache-2.0
- named `getSandbox(..., id)`とruntime-scoped identityは、将来のexternal isolation/identity比較だけの証拠
- SDKをimportせず、sandbox作成/reuse、agent name normalization、Bash/workspace permission変更、container、
  Durable Objects、session/process API、streaming、cancellation、managed executionを採用しない

このincrementで`_refs/`を変更しない。

## Exact catalog contract

新規`v0/agent/agent_catalog.ts`へ次と同等のinternal catalogを置く。

```ts
export const BUILTIN_AGENT_IDS = ['default', 'planner'] as const;
export type BuiltinAgentId = typeof BUILTIN_AGENT_IDS[number];

export interface BuiltinAgentSelection {
  readonly id: BuiltinAgentId;
  readonly definition: AgentDefinition;
}
```

Rules:

- identifier syntaxはexact ASCII `/^[a-z][a-z0-9-]{0,31}$/`
- accepted nameはcase-sensitive exact `default`と`planner`だけ
- case folding、alias、prefix、environment/config fallback、normalizationなし
- omissionは`default`
- catalogは二つのDefinition function objectへのfrozen compile-time mapping
- lookupはprototypeではなくexact own-key check
- resolutionはDefinition評価、filesystem、tool、credential、model constructionを行わない
- malformedとwell-formed unknownは同じinternal selection error、同じsanitized public failure

`defaultAgentDefinition`の挙動は変更しない。

## Planner Definition contract

`v0/agent/agent_definition.ts`へ`plannerAgentDefinition`と次の固定policy stringを追加する。

```text
You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.
```

Planner output:

- `model.provider === 'openrouter'`
- `model.profile === PROFILE` by object identity
- `maxSteps === 8`
- resolved workspace、discovered AGENTS instructions、immutable skill catalog/manifest/saved bodiesを保持
- system instructionは次のexact composition

```ts
composeSystemInstruction(
  composeSystemInstruction(input.agentInstructions, input.skillCatalog.manifest),
  PLANNER_AGENT_INSTRUCTION,
)
```

workspace contextとcompact skill manifestを先に置き、fixed non-mutation policyを最後に置く。skill bodyは
on-demandのままとする。default Definitionは現行compositionを維持し、system message bytesを変えない。

Registry declaration unionへ次を追加する。

```ts
interface PlannerRegistryDefinition {
  readonly kind: 'planner';
  readonly workspace: Workspace;
  readonly skillCatalog: SkillCatalog;
}
```

runtime materializerは`production`と`planner`をexhaustiveに処理する。

## Planner registry

`v0/agent/registries.ts`へ`createPlannerRegistry`を追加し、既存constructorだけを使う。

- always `createReadTool(workspace)`
- callable saved skillが一つ以上なら`createSkillTool(skillCatalog)`だけ追加
- always `createJsonResultSubmissionTool()`
- `bash`、`edit`、`write`はconstruct/advertiseしない
- schema、execution、sorting、terminal semanticsを変更しない

Expected names:

- skillsなし: `read`, `submit_json_result`
- skillsあり: `read`, `skill`, `submit_json_result`

valid selectionでは現行どおりworkspace instructions/skillsをDefinition評価前にdiscoverする。invalid selectionは
CLI/TUI layerでcompositionへ入る前にrejectするため、discoveryはzeroとなる。

## Exact `agent:run` grammar

Accepted forms:

```text
agent:run --task TEXT
agent:run --agent NAME --task TEXT
agent:run --task TEXT --agent NAME
printf ... | agent:run
printf ... | agent:run --agent NAME
```

Rules:

- `--task`と`--agent`は任意順、各最大1回
- 各optionは直後のargv elementを、`--`で始まっても値としてverbatim consumeする
- consume済みvalueをoptionとして再解釈しない
- `--agent=planner`、positional、その他optionはinvalid
- missing value、duplicateはinvalid
- explicit `--agent default`を受理
- argv taskとnon-TTY stdinのambiguity rejectionは現行どおり
- `--task`なしではnon-TTY bounded stdinだけをtask sourceとする
- trimming、blank rejection、fatal UTF-8 decode、65,536-byte boundは不変

parserは`{ taskArg, rawAgentName }`を返す。syntax parse後、shared catalog resolverを次の全てより前に呼ぶ。

1. `stdin.isTerminal`
2. stdin read/decode
3. runtime runner/composition
4. workspace/instruction/skill discovery
5. registry/tool/model construction
6. credential source/fetch

resolved selectionをrunnerへexplicit internal argumentとして渡す。success stdout/stderrへagent IDを追加しない。
invalid selectionは既存compact `invalid_input` preflight record、全counter zeroとする。

## Exact `agent:tui` grammar and lifecycle

Accepted formsはexactly次だけ。

```text
agent:tui
agent:tui --agent NAME
```

duplicate、missing、extra args、`--agent=planner`、malformed/unknown IDはinvalid。

Ordering:

1. exact argv parse
2. shared catalog resolve、omissionならdefault
3. terminal port construct/useとstdin/stdout TTY probe
4. renderer/lifecycle creation
5. selected Definitionでone session compose
6. controller/signal/crash guard installation
7. raw terminal acquisition

invalid selectionではproduction terminal construction/access、workspace discovery、session/model/registry/tool
construction、credential source、fetch、raw acquisitionがzero。valid non-TTYは現行どおりsession composition/raw
acquisition前にfailする。

selectionはsession factoryで一度captureし、`AgentSession`全体に固定する。controller state、slash command、queue、
event、later turnから変更するpathは作らない。TUI renderingは変更せずIDを表示しない。

## Runtime ownership and API

selectionは`RuntimeTestSeam.agentDefinition`へ隠し続けず、catalog resultにcompatibleなexplicit production input
として`createRuntimeComposition`、`runRuntime`、`createRuntimeSession`へ渡す。omissionはcatalog defaultへ
defaultし、現行internal callerを互換に保つ。

existing injected-Definition testsはexplicit selection argumentへ移行し、test-only `agentDefinition` seamを削除する。
Definition selectionの二つのprecedence pathを残さない。

Ownership:

- catalog: stable ID validation、exact lookup、Definition function resolution
- CLI/TUI: parse once、one resolved selectionを渡す
- Definition: declarative profile/instruction/registry/max-step choice
- runtime: workspace discovery、counted fetch、credential/test seams、exhaustive materialization
- registries/tools: concrete construction/execution
- session: fixed composition、transcript、turn/events
- TUI: terminal lifecycle/rendering

## Scope and file changes

- new `v0/agent/agent_catalog.ts`: ID grammar、catalog、selection error/resolver
- `v0/agent/agent_definition.ts`: planner policy/Definition、planner registry declaration union
- `v0/agent/registries.ts`: exact planner Registry constructor
- `v0/agent/runtime.ts`: explicit resolved selection、planner materialization、old injection path removal
- `v0/agent/runtime_cli.ts`: combined parser、early resolution、selection-aware runner seam
- `v0/agent/tui_cli.ts`: exact optional selector grammar、resolver-before-terminal、selection-aware session factory
- new `tests/v0/agent_catalog_test.ts`: permission-free catalog/resolver tests
- `tests/v0/agent_definition_test.ts`: exact planner declaration/instruction tests
- `tests/v0/agent_runtime_test.ts`: planner materialization、once/fixed selection、default equivalence
- `tests/v0/agent_runtime_process_test.ts`とfixture: argv/piped planner、sanitized invalid paths
- `tests/v0/tui_controller_test.ts`: selectionとearly preflight ordering
- `tests/v0/tui_process_test.ts`とfixture: planner session、invalid-selection PTY/process evidence
- `tests/v0/tui_topology_test.ts`: permission/task/gate topology
- `deno.v0.json`: new source/test check、permission-free `agent:definition-selection:test`、gate exactly once、
  production task literals不変
- `README.md`: stable names、CLI forms、fixed-session、planner tools、non-sandbox boundary
- new `docs/plans/builtin-agent-definition-selection-results.md`: measured acceptance evidence
- completion時のみ`AGENTS.md`、`.handoff/handoff.md`

`openrouter_model.ts`、profile、loop/session/event、tool schema、TUI renderer、dependencies/lockfilesは変更しない。
source evidenceがcontradictionを示さない限りscopeを広げない。

## Deterministic test matrix

| Contract | Evidence |
| --- | --- |
| Catalog | frozen exact IDs/functions、omission→default、exact function identity |
| ID rules | empty、uppercase、underscore、punctuation、overlength、unknown well-formed reject |
| Default | existing exact PROFILE/instruction bytes/registry/tools/maxSteps |
| Planner | same PROFILE/maxSteps、exact appended policy、AGENTS/manifest保持 |
| Planner tools | skillsなしexact 2、ありexact 3、bash/edit/writeなし |
| Skills | manifest startup、bodyは`skill`まで不在、saved body unchanged |
| CLI grammar | both option orders、explicit default、planner argv/piped |
| CLI rejection | duplicate/missing/positional/unknown/`--agent=`/malformed/unknown/ambiguity |
| Default compatibility | omissionとexplicit defaultのstdout/stderr/request body/tools/stop behavior一致 |
| Invalid early stop | terminal probe/stdin read/runner/workspace/credential/fetch/Definition/tool construction zero |
| Runtime | selected Definition exactly once per one-shot composition |
| TUI | planner Definition once、two turns同じmodel/instruction/registry、switch pathなし |
| TUI preflight | invalid selection before terminal access/session/raw、valid non-TTY behavior不変 |
| Default TUI | existing direct/render/controller/PTY golden behavior不変 |
| Process | fake-provider planner argv/piped、fake-session planner TUI、invalid sanitized failure |
| Permission topology | production literals不変、new focused task permissionなし、gateはproduction除外 |
| Regression | runtime/session/instructions/skills/work-tools/transport/TUI/full offline green |

process fixtureはdummy credential/fake fetch/sessionだけを使う。provider/network/real credentialは禁止。

## Ordered implementation

1. Plan SHA-256を固定し、初期Human Gateで停止する。
2. catalog、exact ID contract、permission-free direct testsを追加する。
3. planner Definition/registry declarationとpure testsを追加する。
4. planner Registry materializationとexact topology testsを追加する。
5. test-only Definition injectionをexplicit runtime selectionへ置換し、omission compatibilityを保つ。
6. `agent:run` parser/early resolutionとdirect/process casesを追加する。
7. `agent:tui` grammar/resolver-before-terminalとdirect/fake-session/PTY casesを追加する。
8. task/check/gate wiringとREADMEを更新し、production permissionsを不変にする。
9. focused/full offline verification、results、owner lifecycle recordsを完成する。
10. bounded independent read-only review、accepted fixes、最大1回changed-lines re-reviewを行う。

## Validation commands

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:definition-selection:test
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

new focused taskは追加時にexact permission-free commandとして固定する。`v0:gate`をauthoritative regressionとする。

## Review contract

Initial read-only reviewはapproved plan、changed source/tests/config/docs/resultsを対象とする。

- environment: trusted-local single-user Deno 2.9.4
- severity: Blocker/P1/P2
- time limit: 30分、新しいevidence/result/intermediate conclusionが10分なければ中断
- focus: default byte compatibility、parser ambiguity、early-failure order、planner mutation tools exclusion、
  shared catalog/composition path、fixed TUI selection、permission/provider/credential timing不変
- exclude: hostile same-user hardening、OS sandbox設計、provider実行、Cloudflare SDK統合、future subagents

accepted fix後、15分以内のchanged-lines/finding-closure re-reviewを最大1回行う。GOはBlocker/P1/P2 zero。

## Acceptance package

Completionはfocused checksと`v0:gate` green、`git diff --check` clean、production task literals不変、文書整合、
review Blocker/P1/P2 zeroを要求する。

Resultsは次を記録する。

- plan path/hash、implementation revision、exact changed files
- catalog IDs/grammar
- omission/explicit-default equivalence
- planner profile/instruction/tools/maxSteps evidence
- argv/piped/TUI cases
- invalid-selection zero-use counters
- one-shot/multi-turn Definition evaluation counts
- permission/gate topology
- focused/full command results/counts
- review findings/fixes/disposition
- deviations、rollback、remaining risks
- provider/network/credential/production execution zero

## Out of scope

- two以外のDefinition、別agent purpose
- different/new provider/model/profile/value/budget/wire
- external/project-local Definition code loading、dynamic import、plugin/package、reload
- OS sandbox/permission narrowing、新security-boundary command
- mid-session selection、selection persistence/history/resume
- automatic routing、reactive hooks、alias、config/env selection
- new tool/behavior、confirmation changes
- subagent/agentTool、streaming、abort/cancellation、recovery、persistence、RPC/MCP/extensions
- dependency/lockfile、`_refs/`、archive、sibling repositories
- provider/network/credential/production commands、commit/push/tag/publish/release

## Rollback and stop conditions

Rollbackはcatalog、planner Definition/Registry、selector parsing/wiring、increment固有tests/tasks/docsを除き、direct
default runtime compositionへ戻す。unrelated worktree changesと全`_refs/`を保持する。data migrationはない。

次が必要ならevidence、impact、plan delta、verificationを返して停止する。

- exact default invocation/output/provider bytesを維持できない
- option-looking task valueをverbatim維持できない
- invalid selectionをworkspace/session/terminal/tool construction前にrejectできない
- CLI/TUIが別catalog/composition pathを必要とする
- planner mutation tool exclusionにtool behavior/process permission変更が必要
- selectionがper-turn、persistent、reactive、config/env-driven、dynamic loadになる
- provider/profile/wire、dependency/lockfile、credential behavior、unrelated source変更が必要
- existing uncommitted workと回避不能に競合する

## Human Gate

このplanの承認は、local implementation、dummy/fake deterministic tests、task/check/gate wiring、README/results/
owner lifecycle updates、full offline verification、bounded reviewだけを許可する。

production `agent:run`/`agent:tui`、provider/network/credential、dependency/lockfile、`_refs/`、external sandbox、
commit、push、tag、publish、releaseは許可しない。
