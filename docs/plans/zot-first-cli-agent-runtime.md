# Zot-first normal CLI agent runtime — roadmap step 11 plan

## Concept review result

**GO — concept blockerと未解決のWhy・What・Whetherはない。**

Zotを全面移植せず、通常CLI runtimeの第一リファレンスとして使う。Henjiには既に
provider-neutralな`runAgent`、stableな`Registry`、boundedなOpenRouter adapter、4つのlocal
toolがあるため、step 11は既存componentを一度だけcomposeするsingle-shot vertical sliceとして
成立する。

採用するZotの主要ideaは、CLI parsingとruntime constructionの分離、invocationごとに一度だけ
解決するmodel/registry、provider-neutral loop、stable tool order、boundedなtool-error feedback、
final textだけを出すprint modeである。

第一リファレンスは`_refs/zot/`のpinned upstream commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`（MIT）とする。主な比較sourceは次である。

- `_refs/zot/packages/agent/args.go`
- `_refs/zot/packages/agent/cli.go`
- `_refs/zot/packages/agent/build.go`
- `_refs/zot/packages/agent/modes/print.go`
- `_refs/zot/packages/core/agent.go`
- `_refs/zot/packages/core/tool.go`
- `_refs/zot/packages/agent/tools/permissions.go`
- `_refs/zot/packages/agent/prompt_input_test.go`
- `_refs/zot/packages/agent/modes/print_test.go`

snapshotは比較用のreferenceであり、product dependencyにはしない。refresh時はupstream URL、
pinned commit、license、採用behaviorとの比較を`_refs/README.md`と本計画へ反映する。

## Reference precedence

競合は次の順で解決する。

1. `AGENTS.md`、承認済みの本計画、active handoffにあるHenjiの明示要件と安全境界
2. pinned Zot commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`
3. Zotと現行Henjiに該当patternがない場合だけpinned piとDeno example
4. どのreferenceにも定義がない場合だけ新しいlocal design

Zotに存在するだけでは採用理由にならない。採用ideaはactive Henji TypeScript treeへ再実装し、
reference sourceをimportしない。

## Step 11 product contract

任意のnonblank taskを受けるproduction runtimeとthin CLI adapterを一つずつ追加する。runtimeは
固定OpenRouter modelと現在の4 toolを持つRegistryをinvocationごとに一度だけ構築し、既存
`runAgent`を`maxSteps: 8`で一度だけ呼ぶ。CLIはZot print modeと同じく、成功時にfinal assistant
textだけをstdoutへ出して終了する。

Registryは次の4 toolだけをstable name orderでadvertiseする。

1. `character_count`
2. `count_json_array_items`
3. `list_json_object_keys`
4. `uppercase_text`

`list_json_object_keys`はliteral `deno.v0.json`だけを読める。残り3 toolはstate-freeである。
step 11のtool boundaryはこの4 toolとし、general read/write/edit/shell/network/environment toolは
後続roadmapで扱う。

step 8–10のfixed task guardはnormal runtimeへ持ち込まない。structurally validなmodel responseは既存
generic loopへ渡し、registered callはdispatchし、unknown tool・invalid arguments・execution
failureはsanitized tool-error resultとしてmodelへ返せる。ただし次のrequestが許されるのは
8-step boundの内側だけであり、retry・name/argument repair・task rewrite・fallback modelを追加しない。

1回の`Model.generate`を最大1 external requestとして扱う。8回目のresponseがtool callなら、既存
loopどおり最後のlocal batchは実行してtranscriptへ記録できるが、9回目のmodel requestは行わず
`max_steps`で終了する。fixed step 9–10はtool failure時に後続requestを止めるが、normal runtimeは
任意taskのため、recoverable tool errorをfinite bound内でmodelへ返す点が意図的に異なる。

taskはECMAScript whitespaceを前後trimしたUTF-8で最大65,536 bytesとする。stdin readerは
65,537 raw bytesを読んだ時点でoversizeとして止め、unbounded bufferを作らない。

## Zot adoption matrix

| Zot concept | Step 11 | Henji contract |
| --- | --- | --- |
| CLI parsingとruntime constructionの分離 | Adopt | thin CLIとcomposition moduleを分ける |
| Single-shot print mode | Adopt | final textだけをstdoutへ出す |
| argvまたはpiped stdinのprompt | Adopt with deviation | `--task`とstdinはexactly one、両方はreject |
| model/registryを一度だけresolve | Adopt | fixed modelと4 tool registryをinvocationごとに構築 |
| stable tool order | Adopt済み | 現行`Registry.definitions()`を再利用 |
| provider-neutral tool loop | Adopt済み | 現行`runAgent`をforkしない |
| tool errorをmodelへ返す | Adopt with bound | 最大8 request内だけ許可 |
| unlimited/default-zero max steps | Deviate | positive fixed value 8、user overrideなし |
| transient retry | Deviate | application retry 0 |
| provider/model/API key/base URL選択 | Defer | 現行fixed profileを維持 |
| `--no-tools` / `--tools` | Defer | 4 toolを常にadvertise |
| general read/write/edit/bash | Defer | fixed JSON readとstate-free toolだけ |
| permission manifest | Defer | packaged agentを導入しない |
| JSON events、streaming、TUI | Defer | print-only single-shot |
| sessions、context discovery、extensions、skills、RPC、swarm | Defer | persistent stateなし |
| noninteractive tool execution | Adopt with deviation | explicit `agent:run` invocationがrunをauthorizeし、per-tool promptはない |

## Exact CLI contract

### Command forms

Argv task:

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:run --task 'ARBITRARY TASK'
```

Piped task:

```sh
printf '%s\n' 'ARBITRARY TASK' |
  /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
    --config deno.v0.json agent:run
```

Deno task名とapplication argumentの間へliteral `--`を置かない。

accepted application argumentsは次だけである。

```text
--task TEXT
```

Rules:

- `--task`は最大1回で、直後の1 argv elementだけをvalueにする。
- positional argument、unknown flag、duplicate、missing valueはinvalid。
- task sourceは次のexactly oneとする。
  - stdinがterminalのときのnormalized `--task` value
  - `--task`がなくstdinがnon-TTYのときのnormalized stdin
- non-TTY stdinと`--task`が両方あれば、redirected stdinがemptyでもambiguousとしてrejectする。
- terminal stdinかつ`--task`なしは直ちに失敗し、interactive inputを待たない。
- invalid UTF-8、trim後blank、65,536 bytes超過はrejectする。
- argv/input validationはregistry/model construction、credential lookup、fetchより前に完了する。
- provider/model/profile/max-steps/tool filter/session/context/output/state optionは受け付けない。

### Success output

- exit `0`
- stdoutはfinal assistant text verbatim。末尾がnewlineでなければ1個だけ追加する。
- stderrはempty。
- JSON wrapper、transcript、tool trace、request body、profile、credential metadata、counterを出さない。

### Failure output

- exit `1`
- stdoutはempty。
- stderrはcompact JSON 1行とnewlineだけ。

```json
{
  "ok": false,
  "outcome": "contract_failure",
  "stopReason": "contract_failure",
  "steps": 0,
  "toolCallCount": 0,
  "toolResultCount": 0,
  "requestCount": 0,
  "error": {
    "code": "invalid_input",
    "message": "invalid agent invocation"
  }
}
```

| Condition | outcome / stopReason | code | message |
| --- | --- | --- | --- |
| argv/stdin preflight | `contract_failure` | `invalid_input` | `invalid agent invocation` |
| model/transport/credential/response/contract failure | `contract_failure` | `agent_failure` | `agent run failed` |
| finite limit | `max_steps` | `max_steps` | `agent request limit reached` |

counterはobserved non-negative integerとし、preflightは全て0。unexpected exceptionも`agent_failure`へ
normalizeし、task、transcript、tool arguments/results、endpoint、header、Authorization、credential、
provider body、thrown object、stack、model textをfailureへ含めない。

## Runtime responsibilities

CLI adapterはexact flag parsing、TTY判定、bounded stdin read、fatal UTF-8 decode、single-source
normalization、stdout/stderr/exit mapping、failure normalizationを所有する。provider/profile
選択、tool filtering、loop policy、retry、transcript evaluationは所有しない。

runtime moduleは`MAX_STEPS = 8`、fixed `deno.v0.json` path、4 tool registry、既存
`OpenRouterAgentModel`、fetch-start counter、`runAgent(..., {maxSteps: 8})`の一回のcomposition、offline
dependency seamを所有する。productionではfixed profileとglobal fetchを使う。testだけがfake fetch、
dummy credential/source、bounded stdin、JSON `readFile` seamを注入できる。caller-visible optionでprovider、
endpoint、model、timeout、step limit、registry、allowed pathを変えられない。

direct evidenceなしに次のshared componentを変更しない。

- `v0/agent/contracts.ts`
- `v0/agent/loop.ts`
- `v0/agent/openrouter_model.ts`
- `v0/agent/tools.ts`
- step 7–10 fixed compositions
- current fixture CLI
- `v0/model.ts`
- legacy/basic CLIとstate paths

## Ownership and files

承認後のimplementation ownershipは次に限定する。

- new `v0/agent/runtime.ts`: composition、fixed registry、request counter、offline seam
- new `v0/agent/runtime_cli.ts`: parser、bounded stdin、output、`main`
- new `tests/v0/agent_runtime_test.ts`: permission-free direct CLI/runtime tests
- `deno.v0.json`: `agent:run`、`agent:runtime:test`、check/gate integration
- `README.md`: exact command、output、4 tool boundary、external provider warning
- new `docs/plans/zot-first-cli-agent-runtime-results.md`: acceptance package
- `AGENTS.md`と`.handoff/handoff.md`: repository ownerだけがgate/checkpoint更新

`_refs/`はreferenceとして扱い、dependency、lockfile、provider/profile config、credential、persistent
state、archive、Spike、prior evidenceはこのimplementation incrementのownershipに含めない。

## Ordered increments

### 1. Open the local implementation gate

本計画のpathとSHA-256を記録し、step 11のexact local files、offline tests、results、bounded reviewを
実施する。production provider runは明示された`agent:run` invocationでのみ行い、local testsとgateには
含めない。

### 2. Implement CLI parsing and bounded input

exact argv/stdin contractと64 KiB boundaryを実装する。invalid/ambiguous inputはruntime/model構築前に
rejectし、exact preflight failureだけをstderrへ出す。

Direct tests:

- valid argvとvalid pipe
- duplicate/missing `--task`
- unknown flag、positional input
- terminal stdin without task、task plus non-TTY stdin
- blank、invalid UTF-8
- exact 65,536 bytesと65,537 bytes
- invalid inputでmodel/credential/JSON read/fetchが全て0

### 3. Implement the normal runtime composition

4 tool registryとfixed modelを一度だけ構築し、`runAgent`をmax 8で一度だけ実行する。fixed-task guardを
追加せず、historical compositionを変更しない。

Direct tests:

- final-only、one-tool、sequential two-tool
- one response内のmultiple calls
- unknown/invalid/execution error後のbounded recovery
- 全requestで4 toolがstable order
- different JSON pathはreader invocation前にreject
- 8 fetch、no ninth fetch、`max_steps`

### 4. Implement exact presentation

successはfinal textだけ、failureはallowlisted JSONだけとする。newlineあり/なし、preflight、first/later
request failure、recovered tool error、max stepsのcounterを検証する。credential/provider body/header/task/
tool result/thrown-error markerがfailureへ出ないことをrecursiveに確認する。

### 5. Integrate tasks and documentation

Production task:

```json
"agent:run": ".../deno run --no-prompt --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai --allow-read=deno.v0.json v0/agent/runtime_cli.ts"
```

Permission-free direct task:

```json
"agent:runtime:test": ".../deno test --no-prompt tests/v0/agent_runtime_test.ts"
```

new source/testを`v0:check`へ追加し、`agent:runtime:test`を`v0:gate`へ含める。existing taskを維持し、
local gateが`agent:run`を実行しないことをliteral inspectionで証明する。

### 6. Complete offline evidence

次を順に実行する。

```sh
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json agent:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:acceptance:test
deno task --config deno.v0.json agent:selection:test
deno task --config deno.v0.json agent:json-keys:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
git diff --check
```

resultsへcommand/pass count、requirement mapping、changed files、stable order、maximum request count、
provider calls 0、credential未確認、deviation、review、riskを記録する。productionの`agent:run`と
`agent:acceptance`はoffline sequenceに含めず、明示的なuser instructionがある場合に限り個別に実行する。

### 7. Bounded independent review

CLI/runtime separation、input ambiguityとbound、4 tool/path boundary、generic error recovery、8 fetch/no
ninth、retryなし、stdout/stderr schema、redaction、production commandがgateにないこと、existing pathの
回帰、scope外変更なしを30分以内でreviewする。10分間新しい証拠がなければ停止する。fix後のre-review
はchanged linesだけ15分以内とする。shared contract change、scope expansion、unresolved Blocker/P1/P2は
plan deltaとしてdefaultへ戻し、黙って実装しない。

## Acceptance matrix

| Case | Expected result |
| --- | --- |
| argv final-only | exit 0、exact final+必要時newline、stderr empty、request 1 |
| piped task | normalized inputがfirst requestへ届く |
| finalに既存newline | byte-for-byte、追加newlineなし |
| uppercase/count one-tool | request 2、call/result 1/1、causal result |
| JSON list→array count | request 3、call/result 2/2、fixed path/value |
| 1 responseで2 state-free calls | sequential dispatch、1 tool messageにordered results |
| unknown/invalid/execution failure | error resultを返し、bound内でmodelがrecover可能 |
| step 8もtool call | fetch 8、no ninth、`max_steps` |
| invalid invocation/input | exit 1、stdout empty、1 JSON line、全counter 0 |
| missing credential | request 0、`agent_failure`、fetch 0 |
| first transport/HTTP/body failure | request 1、no second |
| tool round後のtransport failure | request 2、prior counters保持、no extra |
| sensitive exception marker | allowlisted failureだけ |
| Markdown/JSON-looking final | parse/wrapせずverbatim |
| existing direct/full suites | unchanged and green |

lower-level schema permutationは既存Registry/loop/transport testsを再利用し、新規testはnormal composition、
input/output boundary、request cap、fixed guard不在だけを所有する。

## Compatibility and rollback

additiveかつstate-freeで、migrationはない。provider/profile/schema/dependencyを変えず、existing commandを
renameせず、existing output contractとfixed acceptanceを維持し、session/transcript/resultをpersistしない。
新しいpermissionは`agent:run`だけのexisting provider env/netとliteral `deno.v0.json` readである。

rollbackはnew runtime/CLI/test/resultsを削除し、`deno.v0.json`のstep 11 task/check/gate entry、READMEと
gate documentのstep 11部分だけを戻す。worktree reset、`_refs/`削除、step 1–10 evidence変更をしない。

## Completion conditions

- two task input formsとexclusivityがexactly実装される。
- 4 toolがstable orderでadvertiseされる。
- final-only、one/multi-tool、multi-call、error recoveryがofflineで成功する。
- JSON pathをwidenできない。
- maximum 8 request、no ninthを証明する。
- success/failure channel contractが一致する。
- direct/full offline gatesと`git diff --check`が成功する。
- resultsがprovider calls 0、credential未確認を記録する。
- independent reviewがBlocker/P1/P2 0でGOを返す。
- existing pathsがgreenである。

## Human Gate

本計画の承認は、上記local implementation、offline validation、results、bounded reviewを許可する。
`agent:run`は明示的なinvocation自体がそのrunのauthorizationとなり、別のflagやper-tool promptは
用いない。production provider commandはlocal testsとgateから分離し、明示的な
user instructionがある場合にだけ実行する。credential access、destructive repository operation、
commit、push、tag、publish、releaseはrepository lifecycleのapproval guardに従う。

provider runを行う場合はfixed profile、公式pricing、最大8 requestのconservative cost ceiling、exact
command/task、stop conditionをreadbackし、失敗・incomplete attemptをautomatic retryしない。

## Remaining risks and deferred work

- fake fetchはreal modelがarbitrary taskでtoolを適切に使うことを証明しない。
- tool error recoveryはbounded chanceであり、有用なcompletionを保証しない。
- 1 responseのmultiple callsはexisting loopでsequential dispatchする。per-batch call count limitはcurrent
  trusted-local toolsとexternal-request boundを前提にdeferする。
- 64 KiB taskはadapter message limit内だが、8 turnsのtranscriptはexisting 76 KiB message / 256 KiB
  request boundに到達し得る。その場合はsanitized terminal failureとする。
- success textはmodel-originatedで、redact・structure validationしない。
- tool filtering、JSON events、streaming、TUI、sessions、context discovery、extensions、skills、RPC、
  subagents、self-revision、persistent state、general filesystem/shell/network tools、dynamic provider/model、
  permission manifestはdeferredとする。
