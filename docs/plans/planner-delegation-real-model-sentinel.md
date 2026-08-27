# Fixed planner delegation real-model sentinel plan

## Status and recommendation

**GO、初期 Human Gate L 待ち。** blocking contradictionはない。

bounded synchronous planner delegationをreal modelで一回だけ検証する専用acceptance childと、
repo-external credentialを固定境界で渡すlauncherを追加する。success pathはmodel request orderを
`parent` / `child` / `parent`、parent 2、child 1、aggregate/external 3に固定し、defaultが
`delegate_to_planner`をexactly once呼び、planner child完了後だけparent finalへ進むことを証明する。

通常`agent:run`のstdoutだけではchild実行回数、child完了とparent finalの因果順序、planner-only
registry、request laneを証明できない。sentinelは既存`runRuntime`をsentinel-only guarded fetchで実行し、
outgoing requestをnetwork前、provider responseをtool dispatch前に検証する。production runtime、
delegation、Definition、registry、profile、CLI、TUIは変更しない。

- **Gate L:** local implementation、dummy/fake-provider tests、full offline verification、results、review
- **Gate S:** Gate L GO後に別途承認するexact one-shot credential/provider execution

planningとGate Lはcredential probe/read、provider/network、production command、dependency/lockfile、
`_refs/`、commit、push、tag、publish、releaseを許可しない。

## Authority and baseline

- user selection: `ASK-20260827-planner-delegation-real-sentinel-planning`
- baseline: `e4e3acf` (`feat(agent): add definitions and planner delegation`)
- prerequisite: `docs/plans/bounded-planner-delegation-tool.md`、SHA-256
  `5f8da680dabc7223d6320c5129c0350ed64fe7b0f7d613a4a44a7a9f5d26570d`
- baseline evidence: delegation 16、runtime 35、runtime process 18、TUI direct 30、full 326、
  review Blocker/P1/P2 zero
- runtime guards: parent 8、child 8、aggregate 16、one child/turn、claimはmodel/credential/fetch前
- child: frozen workspace/AGENTS/skills、`read`/optional `skill`/`submit_json_result`、mutation/delegationなし

user-owned `AGENTS.md`、`.handoff/handoff.md`、untracked `_refs/`を保持する。

## Provider contract readback

current profileは`openrouter-google-gemini-3.7-flash-vertex-v0`、model
`google/gemini-3.7-flash`、`https://openrouter.ai/api/v1/chat/completions`、POST、`stream:false`、
maximum 1,024 completion tokens/request、application retry 0、USD 0.064/request ceilingである。

2026-08-27 JSTにOpenRouter公式model pageとtool-calling documentationでexact slug提供中、`tools` /
`tool_choice` support、tool resultを次requestへ渡すflowを確認した。

- <https://openrouter.ai/google/gemini-3.7-flash>
- <https://openrouter.ai/docs/guides/features/tool-calling>

bounded 3-request testなのでroutineなGate S直前price refreshは要求しない。Gate S時点でavailability/API/tool
contractが不確かならofficial sourceを再確認する。profile、bounds、request数、material spendが変われば停止し、
contract/pricingをrefreshして新しい承認へ戻す。

## Fixed task and causal contract

Task ID:

```text
v1.planner-delegation.fixed
```

disposable workspaceはmode `0700`のempty directoryで、`AGENTS.md`とskillsを持たない。parent registryは
exact 6 tools、planner registryはexact 2 toolsとなる。

Exact delegated task:

```text
Return exactly this one-line implementation plan and nothing else:
PLAN: inspect requirements; implement the smallest change; run focused tests.
```

Expected child final:

```text
PLAN: inspect requirements; implement the smallest change; run focused tests.
```

Expected canonical delegation result:

```json
{"ok":true,"agent":"planner","output":{"kind":"text","text":"PLAN: inspect requirements; implement the smallest change; run focused tests."},"usage":{"modelRequests":1,"externalRequests":1}}
```

Exact parent task:

```text
This is a fixed planner-delegation sentinel. Use exactly one delegate_to_planner call and no other tool.

First, call delegate_to_planner as the sole tool call with this exact task:
Return exactly this one-line implementation plan and nothing else:
PLAN: inspect requirements; implement the smallest change; run focused tests.

After, and only after, its successful result confirms that exact planner output with modelRequests 1 and externalRequests 1, answer exactly:
PLANNER_DELEGATION_CONFIRMED

Do not answer before delegation. Do not call a mutation tool, submit_json_result, skill, or a second delegation.
```

Expected parent final:

```text
PLANNER_DELEGATION_CONFIRMED
```

Success requires:

- request order exact `parent` / `child` / `parent`
- parent requests 2、child 1、aggregate model/external 3
- parent `delegate_to_planner` call/result各1、sole batch、exact arguments/correlation
- second parent request contains completed exact delegation result; parent final occurs only after it
- parent tool order exact `delegate_to_planner`
- child request has planner system instruction and sole delegated task、parent transcript 0
- child tools exact `read` / `submit_json_result`; child assistant final exact、tool calls 0
- planner mutation/recursive delegation 0
- parent stop reason `final`、exact final、terminal kindなし
- same canonical mode-`0700` workspace remains empty
- retry/fallback/rerun/follow-up 0

second parent requestはplanner child完了とdelegation result挿入までdispatch不能であり、これをcausal evidenceとする。

## Sentinel-only guarded fetch

underlying fetch前に各outgoing requestをvalidateする。

- exact endpoint/method/model/non-streaming/max completion profile
- exact phase/order、system/user/assistant/tool message topology
- advertised tool definitionsのname/description/schema
- parent request 1はsole fixed task
- child requestはplanner instructionとsole delegated task、parent transcript 0
- parent request 2はnonblank provider call IDとcorrelated exact result
- fourth requestはunderlying fetch前にreject

provider responseは`OpenRouterAgentModel`へ返す前、従ってtool dispatch前にvalidateする。

- parent response 1: sole `delegate_to_planner`、exact arguments
- child response: exact assistant final、tool calls 0
- parent response 2: exact assistant final、tool calls 0

provider call IDはnonblankを許容し、later requestでexact correlationを要求する。raw bodyを保持・報告しない。
unexpected/fourth outgoing requestはfetch 0。wrong/early final、wrong tool、mutation/recursive/second delegation、
child tool、multi-call、wrong argument/text/finalはresponseのfetch 1後、dispatch/next request前に失敗する。
runtime 8/8/16を保持し、sentinelがstrict 2/1/3を追加する。

## Acceptance child

`v0/agent/planner_delegation_sentinel.ts`を追加し、existing `runRuntime`、default selection、OpenRouter
profile/adapter、runtime delegation、guarded fetch、fixed task、empty-workspace validationをcomposeする。
application arguments/selectorsはなく、argumentはmodel前にrejectする。

stdoutはbounded canonical JSON一行、stderr empty。task/expected text、raw transcript、arguments/results、call ID、
provider body/header、exception/stack、credential、absolute pathを出さない。

Success child report:

```json
{"schemaVersion":1,"taskId":"v1.planner-delegation.fixed","profile":"openrouter-google-gemini-3.7-flash-vertex-v0","ok":true,"outcome":"passed","parentModelRequests":2,"childModelRequests":1,"aggregateModelRequests":3,"externalRequests":3,"delegationCalls":1,"delegationResults":1,"requestOrder":["parent","child","parent"],"parentToolOrder":["delegate_to_planner"],"parentStopReason":"final","plannerFinalValidated":true,"childCompletedBeforeParentFinal":true,"plannerNonMutating":true,"plannerNonRecursive":true,"transcriptValidated":true,"workspaceValidated":true}
```

Failureはfixed identity、`ok:false`、`outcome:"aborted"`、bounded counters/order prefix、small stop reason、
validation booleansと次のallowlisted codeだけを持つ。

```text
provider_failure
request_contract_failure
model_adherence_failure
delegation_contract_failure
parent_final_mismatch
workspace_mismatch
internal_failure
```

## Launcher and credential boundary

`v0/agent/planner_delegation_sentinel_launcher.ts`を追加する。既存
`v0/eval/live_corpus_credential_launcher.ts`の`readCredential`を変更せず再利用し、既存launcherを変更しない。

1. argumentsをcredential/workspace前にreject
2. separate probeなしでcredential read exactly once
3. `/tmp/henji-planner-delegation-sentinel-*`を一つ作り、chmod `0700`、canonicalize/lstat、empty確認
4. child at most one
5. stdout/stderr各8 KiB、aggregate deadline 120 seconds
6. timeout/overflow/SIGHUP/SIGINT/SIGTERMはTERM、fixed grace後KILL、await/reap
7. child exact-key report strict parse
8. workspace mode `0700`かつemptyをindependent verify
9. exact owned pathを`finally`でremove
10. cleanup outcome後だけparent report

Exact child command:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run
--no-prompt
--no-remote
--allow-env=HENJI_OPENROUTER_API_KEY
--allow-net=openrouter.ai
--allow-read=<workspace>
/home/masat.guest/src/henji-harness/v0/agent/planner_delegation_sentinel.ts
```

cwdはcanonical workspace、`clearEnv:true`、envはcredential一つ、stdin null、stdout/stderr piped、write/run
permissionなし、application argumentなし。child write/run不在をindependent enforcementとする。

Production task:

```text
agent:planner-delegation:sentinel:credential-file =
  /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt --no-remote
  --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key,/tmp
  --allow-write=/tmp
  --allow-run=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
  --allow-sys=uid
  v0/agent/planner_delegation_sentinel_launcher.ts
```

parentはenv、net、repository write、`/bin/bash` permissionを持たない。

## Launcher report and failures

successはstdout canonical JSON一行、stderr empty、exit 0。

```json
{"schemaVersion":1,"taskId":"v1.planner-delegation.fixed","profile":"openrouter-google-gemini-3.7-flash-vertex-v0","ok":true,"outcome":"passed","parentModelRequests":2,"childModelRequests":1,"aggregateModelRequests":3,"externalRequests":3,"delegationCalls":1,"delegationResults":1,"requestOrder":["parent","child","parent"],"parentToolOrder":["delegate_to_planner"],"parentStopReason":"final","plannerFinalValidated":true,"childCompletedBeforeParentFinal":true,"plannerNonMutating":true,"plannerNonRecursive":true,"transcriptValidated":true,"workspaceVerified":true,"workspaceRemoved":true,"retryCount":0}
```

failureはstdout empty、stderr canonical JSON一行、nonzero exit。fixed identity、`ok:false`、
`outcome:"aborted"`、allowlisted stage/code、child 0/1、external 0..3/null、ceiling 3、retry 0、workspace
removed true/false/nullだけを出す。

Stages: `preflight`、`credential`、`workspace`、`process`、`bounds`、`evidence`、`execution`、
`cleanup`、`internal`。

Codes: `arguments_invalid`、credential reader既存codes、`workspace_create_failed`、`workspace_invalid`、
`child_spawn_failed`、`child_wait_failed`、`child_exit_failed`、`child_signal`、`deadline_exceeded`、
`stdout_overflow`、`stderr_overflow`、`child_report_invalid`、child allowlisted codes、`cleanup_failed`、
`internal_failure`。

extra field/line、child stderr、malformed UTF-8/JSON、impossible tuple/statusは`child_report_invalid`。
cleanup failureはsuccessをoverrideし、raw child bytesをrelayしない。全handled outcomeでcleanupする。

## File ownership and preserved boundaries

一体のimplementerが次だけを所有する。

```text
v0/agent/planner_delegation_sentinel.ts
v0/agent/planner_delegation_sentinel_launcher.ts
tests/v0/planner_delegation_sentinel_test.ts
tests/v0/planner_delegation_sentinel_process_test.ts
tests/v0/planner_delegation_sentinel_topology_test.ts
tests/v0/fixtures/planner_delegation_sentinel_*
deno.v0.json
README.md sentinel section
docs/plans/planner-delegation-real-model-sentinel-results.md
```

results後だけownerが`AGENTS.md`/handoffを更新する。runtime、loop、session、execution context、delegation、
Definition、registries、adapter、existing launchers/sentinels、dependency/lockfile、corpus、archive、`_refs/`は
変更しない。guarded fetchだけで証明できなければ停止してplan deltaを返す。

## Deterministic test matrix

- exact `parent/child/parent` success、exact transcript/correlation/tool definitions
- early parent final、wrong/unknown/mutation tool、second delegation、multi-call、wrong arguments
- child tool call、wrong child final/envelope/usage、wrong parent final、fourth request fail-before-fetch
- planner tools exact、parent transcript isolation、mutation/recursion/parent tool dispatch zero
- provider failure at each phase、child failure admission retained、retry 0、workspace empty
- reports contain no injected secret/task/provider/transcript/argument/result/call-ID/path markers
- arguments fail before credential/workspace/spawn; credential once; workspace/child at most one
- exact executable/argv/cwd/env/stdio/permissions
- nonzero exit、signal、timeout、both overflow、stderr、invalid report、spawn/wait failure
- TERM/KILL/reap、all-path cleanup、cleanup failure overrides success
- embedded Deno fixture from unrelated cwd、dummy credential/fake fetch only
- production literal exact、existing literals unchanged、focused tasks once in gate、production task zero locally

## Gate L verification

repository-pinned Deno 2.9.4で次を実行する。

```text
agent:planner-delegation:sentinel:test
agent:planner-delegation:sentinel:process:test
agent:planner-delegation:sentinel:topology:test
agent:planner-delegation:test
agent:definition:test
agent:definition-selection:test
agent:runtime:test
agent:runtime:process:test
agent:work-tools:sentinel:test
agent:work-tools:sentinel:process:test
agent:work-tools:sentinel:topology:test
agent:corpus:eval:live:credential-launcher:test
agent:corpus:eval:live:credential-launcher:process:test
agent:corpus:eval:live:credential-launcher:topology:test
v0:check
v0:fmt
v0:lint
v0:test
v0:gate
git diff --check
```

Gate Lではproduction `agent:run`/`agent:tui`/credential-file/live providerを実行しない。completionは全gate
green、credential/network/production unreachable、temp residue 0、results complete、review GOかつ
Blocker/P1/P2 zeroを要求する。

## Review and acceptance package

reviewはapproved plan、sentinel diff、resultsを対象にtrusted-local Deno 2.9.4でBlocker/P1/P2を確認する。
initial 30分、新evidence等が10分なければ中断。causal order、one-child、2/1/3 pre-dispatch bound、guard、
transcript isolation、planner topology、composition fidelity、secret/report、kill/reap/cleanup、permission、
normal CLI/TUI preservationを重点とする。hostile same-user、general sandbox、general model quality、later
features、publicationは対象外。fix後はchanged-lines re-review最大一回15分。Gate Sは全severity zeroを要求する。

`docs/plans/planner-delegation-real-model-sentinel-results.md`にplan hash/revision/files、requirements mapping、
request/call/order/topology/lifecycle evidence、commands/counts、local nonreachability、dummy-only statement、review、
deviations/rollback/risks、Gate Lでcredential/provider/production/dependency/`_refs`/publication zeroを記録する。
Gate S後もsanitized launcher result以外のraw evidenceを記録しない。

## Gate S: separately approved one-shot

Gate L GO後、plan path/hash、target revision/diff、local counts、reviewとexact commandを提示して承認を求める。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:planner-delegation:sentinel:credential-file
```

readbackはone command/task/credential-open/workspace/child、exact profile、runtime 8/8/16、sentinel 2/1/3、
completion ceiling 3,072、worst-case USD 0.186624、authorization ceiling USD 0.192、retry/fallback/rerun/
follow-up 0、120-second deadline、8-KiB channels、credential first access、missing/malformedもattempt消費、
resultにかかわらずrerunなしを含める。

credential/provider/adherence/delegation/report/lifecycle/cleanup/hash/revision/review異常はretryなしで停止する。
canonical sanitized result、counts/upper bound、cleanup、retry 0だけをrecordする。

## Rollback, risks, and stop conditions

rollbackはnew sentinel files/tests/tasks/docs/lifecycle bookkeepingだけを除去し、worktree reset、runtime/profile、
credential/`_refs`、consumed evidenceへ触れない。

residual risksはsame-userによるchild env観測、crash時temp残留、irreversible provider effects/cost、fixed taskが
general planning qualityを証明しないこと、parent mutation toolsがadvertiseされたままだがguardで使用を防ぐこと。

次が必要なら停止し、evidence/impact/plan delta/verification/user decisionへ戻す。

- one-child、runtime 8/8/16、sentinel 2/1/3を弱める/超える
- preserved production runtime/delegation/Definition/registry/profile/CLI/TUIを変える
- parent transcriptをchildへ渡す、child mutation/delegation/write/runを許す
- ordinary CLI stdoutをcausal evidenceにする、permissionsを広げる
- retry/fallback/rerun/follow-up、dependency/lockfile、`_refs/` workを加える
- prohibited raw evidenceをemit/persistする
- unrelated working-tree changesと回避不能に競合する

## Human Gate L

**このfixed child/launcher、dummy/fake-provider local tests、full offline verification、results package、
lifecycle bookkeeping、bounded read-only reviewのGate L実装を承認するか。**

承認はreal credential、provider/network、production command、Gate S、dependency/lockfile、`_refs/`、commit、
push、tag、publish、releaseを含まない。
