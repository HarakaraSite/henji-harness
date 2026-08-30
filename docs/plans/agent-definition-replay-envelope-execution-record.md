# Agent Definition replay envelope and execution record implementation plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 79として、Step 80がparentとvariantへ同じ実行条件を渡したことを証明するinternal
schema-v1 replay envelopeと、一回のnormalized observationを表すinternal schema-v1 execution recordを追加する。

- replay envelopeはcanonical payloadとdomain-separated full SHA-256 identityを持つ。
- execution recordはdeterministic `runOrdinal`でrunを識別し、実測durationをidentityまたはrecord同一性へ使わない。
- constructor、strict validator、canonical representation、pure in-memory recorder、direct offline fixturesだけを作る。
- runtime、CLI、TUI、events、session、persistence、provider、Step 80 comparison runnerへ接続しない。

provider token usageとcostは現runtimeが提供しないため、0を捏造せずexact literal `"unsupported"`で表す。
workspace snapshotはcallerが明示したrelative pathとcontent digestの有限集合であり、workspace scanner、source bundle、
checkout identityではない。

## Confirmed planning base

- repository HEAD: `0ddc7549af29f08d53870407189936d98efa24a3`
- tracked worktreeはclean。untracked user-owned `_refs/*`は保持する。
- delivered input: `/tmp/planner-inputs/henji-agent-definition-replay-envelope-execution-record.md`
- input SHA-256: `dc4d2046f00170c5575606feba320859d2b982d62349a3acd02887ac5fc4d775`
- input concept revision 25 / roadmap Step 79
- Step 78 plan SHA-256:
  `4d134e26ea4e96fffa43997e085b3d900c1a108a06eb0fb963dc691be919b72d`
- Step 78 results SHA-256:
  `de25f3fbd8d394c34d1861ca28d03fd722165b61609efe445c17d3da4727adde`
- Step 78 commit/gate: commit `0ddc754`、full offline gate 547/547、final Blocker/P1/P2 zero。
- `contracts.ts`のprovider-neutral `Message`はuser text、assistant text/nonempty tool-call batch、nonempty tool-result
  batchを持つ。
- `loop.ts`のexact stop reasonは`final`、`tool_terminal`、`max_steps`、`contract_failure`、`cancelled`であり、
  `LoopOutcome`はsteps、tool call/result counts、transcriptを持つ。
- successful one-shot loopはcommit callbackがなければ`committed === false`になり得る。session turnだけがsuccessful
  transcript commitを所有する。
- planner childのmodel attemptsはparent `LoopOutcome.steps`へ含まれない。request budgetはparent 8、planner 8、
  aggregate 16を上限とする。
- runtimeはexternal request countを観測できるが、provider token usage/costを公開しない。
- `session_store.ts`にはstrict causal transcript validationがあるがprivateであり、Step 79の共有pure validatorへ抽出する
  場合もsession schema/behaviorを変えてはならない。
- `deno.v0.json`と`tests/v0/offline_gate_topology_test.ts`がdirect test ownershipとexact permission topologyを固定する。

確認済み要件とlive repository stateにblocking conflictはない。delivered inputの「durationはdeterministic identityや
record同一性の前提にしない」を優先し、execution recordへcontent identity fieldは追加しない。

## Shared strict data boundary

新規`v0/agent/replay_value.ts`がStep 79用のstrict plain-data validationとcanonical cloneを所有する。
既存`JsonValue` / `Message`型を再利用し、別のwire/runtime型を作らない。

### JSON-shaped value contract

- accepted scalar: `null`、boolean、finite number、string
- numberはfiniteかつ`-0`でないこと。`NaN` / infinitiesを拒否する。
- arrays/objectsはordinary own enumerable data propertyだけを持つ。symbol、accessor、sparse array、extra array
  property、custom/non-null prototypeを拒否する。
- object keyはUTF-8 1..128 bytes、最大128 properties、UTF-16 code-unit順のstrict ascending canonical order。
- arrayは最大256 items、nesting depthは最大16、総node数は最大4,096、canonical UTF-8は最大65,536 bytes。
- validatorはfresh deeply frozen cloneを返し、caller mutationやobject identityをrecordへ持ち込まない。
- errorはfixed sanitized class/messageで、受信値、path、content、credential markerをechoしない。

### Message and causal transcript contract

- text fieldsはUTF-8最大65,536 bytes。empty assistant/user textはcurrent `Message` contractに従って許容する。
- `callId`はUTF-8 1..128 bytes。
- tool nameはASCII `[a-z0-9][a-z0-9._-]{0,127}`。
- assistant tool-call batchとtool-result batchは1..32 entries。
- call/result argumentsは上記JSON-shaped value contract、tool result textはUTF-8最大65,536 bytes。
- transcript arrayはplain dense arrayで、envelope initial transcriptは0..128 messages / canonical UTF-8最大
  262,144 bytes、record transcriptは1..512 messages / 最大524,288 bytes。
- empty initial transcriptは許容する。nonempty initial transcriptはcompleted causal turnsだけを許し、unanswered
  assistant tool call、orphan/duplicate result、result name/callId mismatch、assistant final後の同一turn継続を拒否する。
- shared causal parserを`session_store.ts`から抽出する場合、既存session fixturesをbyte/behavior regressionとして維持し、
  persistence schema、size cap、error surfaceを変更しない。

## Replay envelope schema-v1

`v0/agent/replay_envelope.ts`にpure async constructor、standalone validator、canonical payload encoderを置く。
exact top-level property orderは次とする。

```text
schemaVersion, caseId, task, workspace, modelIdentity, budget,
initialTranscript, manifest, identity
```

### Exact fields and bounds

```ts
interface AgentReplayEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly task: string;
  readonly workspace: {
    readonly entries: readonly {
      readonly path: string;
      readonly digest: string;
    }[];
  };
  readonly modelIdentity: AgentResourceIdentity;
  readonly budget: {
    readonly maxSteps: number;
    readonly modelRequests: RoleCounts;
    readonly maxExternalRequests: number;
    readonly maxWallTimeMicros: number;
  };
  readonly initialTranscript: readonly Message[];
  readonly manifest: AgentResolvedManifestV1;
  readonly identity: string;
}

interface RoleCounts {
  readonly parent: number;
  readonly planner: number;
  readonly aggregate: number;
}
```

- `caseId`: same ASCII grammar as tool name、1..128 bytes。
- `task`: nonempty、UTF-8最大65,536 bytes。
- workspace entries: 0..256、canonical array payload最大294,912 bytes。
- workspace path: relative forward-slash path、UTF-8 1..1,024 bytes、各segment 1..128 bytes。absolute path、empty
  segment、`.` / `..`、backslash、colon、NUL/control、trailing slashを拒否する。
- entriesはpathのUTF-16 code-unit順strict ascending。duplicate、noncanonical orderを拒否する。
- content digest grammar:
  `henji-workspace-content:v1:sha256:<64 lowercase hex>`。
- content digest domain: exact UTF-8 bytes `henji-workspace-content:v1\n` + raw file bytes。Step 79はdigest
  known answersを検証するが、fileをread/walk/hashするsnapshotter APIは公開しない。
- `modelIdentity`はvalidated manifest resources中のexact sole `model:*` resourceとbyte-identicalであること。
- `maxSteps`: integer 1..8、manifest `parameters.maxSteps`とexactly equal。
- `modelRequests`: exact order `parent,planner,aggregate`。parentは`maxSteps`とequal、plannerは0..8、aggregateは
  parent + plannerかつ1..16。
- `maxExternalRequests`: integer 0..modelRequests.aggregate。
- `maxWallTimeMicros`: integer 1..3,600,000,000。
- `manifest`: Step 77 standalone validatorを通ったfresh frozen schema-v1 manifest全体。identityだけへ縮約しない。
- envelope canonical payloadはidentity fieldを除いたexact compact JSON、UTF-8最大524,288 bytes。
- identity domain: exact UTF-8 bytes `henji-agent-replay-envelope:v1\n` + canonical payload。
- identity grammar:
  `henji-agent-replay-envelope:v1:sha256:<64 lowercase hex>`。

constructorもstandalone validatorも同じbounds/order/correlationを使う。unknown/missing/extra、wrong order、inherited
field、symbol、accessor、non-plain object、correctly rehashed contradictory fieldをfail closedで拒否する。

workspace descriptorが証明するのは、callerが列挙したcanonical relative pathとfull content digestの組だけである。
未列挙file、absolute workspace root、Git commit/tree、permission、mtime、symlink semantics、actual file presenceは証明しない。

## Fixed replay-envelope known answer

workspace content digest fixtures:

| Raw bytes | Full identity |
|---|---|
| `alpha\n` | `henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf` |
| `beta\n` | `henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4` |

exact envelope payload:

```json
{"schemaVersion":1,"caseId":"v1.fixed.final","task":"Return OK.","workspace":{"entries":[{"path":"AGENTS.md","digest":"henji-workspace-content:v1:sha256:32ebafd879a1dc968107ec2e9a063ab8963e8854ea49c236e464f5c6e2a976bf"},{"path":"deno.v0.json","digest":"henji-workspace-content:v1:sha256:371631304952cb768c5d06dbf46fae0e60bee30cf2f38578ad48a6d3b0f951e4"}]},"modelIdentity":"model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","budget":{"maxSteps":8,"modelRequests":{"parent":8,"planner":8,"aggregate":16},"maxExternalRequests":16,"maxWallTimeMicros":60000000},"initialTranscript":[],"manifest":{"schemaVersion":1,"definitionId":"default","resources":["model:openrouter:openrouter-google-gemini-3.7-flash-vertex-v0","tool:bash","tool:delegate_to_planner","tool:edit","tool:read","tool:submit_json_result","tool:write","subagent:planner"],"parameters":{"maxSteps":8},"identity":"henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58"}}
```

exact identity:

```text
henji-agent-replay-envelope:v1:sha256:8779910633ac41ff36b9aec498d80f0c525aac16279c431ef5a8382797f9fa72
```

このknown answerはplanning時にrepository指定Deno/Web Cryptoで独立再計算済みである。

## Execution record schema-v1

`v0/agent/execution_record.ts`にstrict standalone validator、canonical compact representation、pure recorderを置く。
recordはenvelopeをexplicit argumentとしてvalidateし、embedded identityだけを信用しない。exact top-level property orderは
次とする。

```text
schemaVersion, runOrdinal, envelopeIdentity, manifestIdentity, durationMicros,
outcome, usage, modelCalls, toolCalls, toolResults, transcript
```

execution recordにdigest identity field/domainは置かない。`runOrdinal`がrecord ID/orderであり、durationを除外した暗黙の
同一性規則も作らない。Step 80がrecordsを比較するときはdurationを観測値として個別に扱い、record全体のbyte equalityを
same-run判定へ使わない。

### Outcome, duration and usage

- `runOrdinal`: integer 1..1,000,000。
- recorder clockは注入したmonotonic microsecond function。envelope/runOrdinal/clock shapeの検証成功直後のrecorder
  construction時にstartをexactly once、finish時にendをexactly once読む。最初のmodel attempt前からdurationへ含める。
- clock valueはnonnegative safe integer。end >= start、duration <= envelope `maxWallTimeMicros`を要求する。
- outcome exact order: `ok,stopReason,committed,terminalKind`。
- `terminalKind`は`"none" | "json_result"`。`json_result`は`tool_terminal`だけ、他は`none`。
- `ok === true` iff stop reason is `final` or `tool_terminal`。
- `committed`はok outcomeだけでtrueを許す。successful one-shot `committed:false`も許す。
- usage exact order:
  `steps,modelRequests,externalRequests,toolCalls,toolResults,providerTokenUsage,cost`。
- role countsはexact order `parent,planner,aggregate`、aggregate === parent + planner。
- `steps === modelRequests.parent`。parent/planner/aggregateはenvelope ceilings以内。
- externalRequestsはinteger 0..envelope maxExternalRequestsかつmodelRequests.aggregate以下。
- toolCalls/toolResults role countsは各0..512、aggregate equationを満たす。
- parent tool call/result countsはsupplied `LoopOutcome`とexactly equal。planner countsはexplicit child observationsから導出する。
- `providerTokenUsage === "unsupported"`、`cost === "unsupported"`。number/object/null/zeroを拒否する。

### Model-call observations

exact property order:

```text
ordinal, role, roleOrdinal, resultKind
```

- arrayは0..16 entries、global `ordinal`は1からcontiguous。
- `role`は`parent | planner`、roleOrdinalもroleごとに1からcontiguous。
- `resultKind`は`final | tool_calls | error | cancelled`。
- array lengthとrole countsはusage modelRequestsへexact correlateする。
- `steps`/parent model observations、stop reason、last parent result kindをcorrelateする。
- raw prompt/response、assistant text、HTTP/provider metadata、stream chunks、provider IDを含めない。

### Tool-call observations

exact property order:

```text
ordinal, role, roleOrdinal, modelCallOrdinal, callId, name, arguments
```

- arrayは0..512 entries、global/role ordinalsは1からcontiguous。
- referenced model observationはsame roleの`tool_calls` resultでなければならない。
- `(role, callId)`はrecord内でunique。name/callId/argumentsはshared strict value contractを通す。
- parent observationsはparent transcript/LoopOutcome countsへ、planner observationsはexplicit child countersへ相関する。

### Tool-result observations

exact property order:

```text
ordinal, role, roleOrdinal, callOrdinal, callId, name, outcome, terminal, result
```

- arrayは0..512 entries、global/role ordinalsは1からcontiguous。
- `callOrdinal`、role、callId、nameはexact one prior tool-call observationへcorrelateする。
- resultはshared bounded JSON-shaped value。raw/unbounded stdout/stderrやprogress snapshotを渡さない。
- `outcome`はcurrent `ToolResultOutcome` finite set、`terminal`は`"none" | "json_result"`。
- successful sole `submit_json_result`だけが`json_result` terminalになり、record stop reasonは`tool_terminal`。
- result countはcall count以下。missing resultsはfailure/cancellation prefixでだけ許す。

### Transcript correlation

- record transcriptはenvelope initial transcriptとbyte/shape equalなprefix、その直後のexact envelope task user
  message、今回のparent causal suffixからなる。
- parent model/tool observationsはsuffixのassistant/tool messagesとordinal/call/name/outcome/terminal/countをexactに
  correlateする。
- planner transcriptはparent transcriptへ独立したmessagesとして挿入しない。planner observationはrole-tagged arrays
  とusageだけに残す。
- final/tool_terminalはcompleted causal suffixを要求する。max_steps/contract_failure/cancelledはcurrent loopが返せる
  bounded causal prefixだけを許す。
- final/tool_terminal/max_stepsのcompleted tool batchでは、assistantが宣言した全calls、dispatch済みcall/result
  observations、tool transcript messageをfull exact correlateする。
- contract_failure/cancelledの最終partial tool batchでは三層を区別する。assistant tool-call messageはmodelが宣言した
  batch全体、record tool call/result observationsとLoopOutcome countersは実際にdispatch/result取得まで進んだstrict
  prefix、tool transcript messageはbatch全体がcommitされた場合だけ存在する。したがってdispatch前cancelではassistant
  batchだけ、multi-call batchの一result後cancelではassistant batch全体とfirst call/result observationだけがあり、
  未commit batchのtool transcript messageはない。このcaseでも観測prefixのcallId/name/arguments/outcome/orderはassistant
  declarationとexactに一致し、未観測suffixをrecordへ捏造しない。
- initial transcriptの改変、task差し替え、orphan result、duplicate call ID、wrong role/count/stop/commitを拒否する。

canonical record representationはexact compact JSON、UTF-8最大1,048,576 bytes。representationはstorage/export/public
formatではなく、direct fixtureとStep 80 internal consumptionのためのpure bytes contractである。

## Fixed execution-record fixture

上記fixed envelopeに対するsuccessful final one-shot fixtureをexact representationとして固定する。

```json
{"schemaVersion":1,"runOrdinal":1,"envelopeIdentity":"henji-agent-replay-envelope:v1:sha256:8779910633ac41ff36b9aec498d80f0c525aac16279c431ef5a8382797f9fa72","manifestIdentity":"henji-agent-resolved-manifest:v1:sha256:bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58","durationMicros":1250,"outcome":{"ok":true,"stopReason":"final","committed":true,"terminalKind":"none"},"usage":{"steps":1,"modelRequests":{"parent":1,"planner":0,"aggregate":1},"externalRequests":1,"toolCalls":{"parent":0,"planner":0,"aggregate":0},"toolResults":{"parent":0,"planner":0,"aggregate":0},"providerTokenUsage":"unsupported","cost":"unsupported"},"modelCalls":[{"ordinal":1,"role":"parent","roleOrdinal":1,"resultKind":"final"}],"toolCalls":[],"toolResults":[],"transcript":[{"role":"user","content":{"kind":"text","text":"Return OK."}},{"role":"assistant","content":{"kind":"text","text":"OK"}}]}
```

同じnormalized observationでもdurationが異なればrepresentationは異なるが、run相同性・比較条件の一致は
`runOrdinal`と`envelopeIdentity`/`manifestIdentity` correlationで扱い、duration equalityを要求しない。

## Pure recorder seam

conceptual API:

```ts
createAgentExecutionRecorder({ envelope, runOrdinal, clock })
recordModelCall(observation)
recordToolCall(observation)
recordToolResult(observation)
finish({ outcome, externalRequests, transcript })
```

- stateは`new -> recording -> finished`、validation/clock/ordering failureは`failed`へpoisonする。
- constructorはenvelope/runOrdinal/clock shapeをside-effect-freeに検証した後、start clockを一度だけ取得してvalidateする。
  start clock failureではusable recorderを返さない。finishはend clockを一度だけ取得する。
- finishは全counts/ordinals/correlation/transcript/stop/commit/budgetを再計算してfresh deeply frozen recordを返す。
- finished/failed後のrecord/finish、out-of-order/duplicate ordinal、future call referenceをsanitized errorで拒否する。
- caller-supplied aggregate countsやdurationを信用せず、observations/clockから導出する。
- recorder moduleはruntime、events、session、TUI、provider、registry、tools、filesystemをimportしない。
- construction/validation failureにmodel、credential、fetch、tool dispatch、session、read/writeのside effectはない。

Step 80はfresh runtimeのexplicit observer/adaptorからこのrecorderへnormalized observationsを渡せるが、Step 79では
そのadapter、runner、comparison、reportを実装しない。

## File responsibility

| File | Responsibility |
|---|---|
| new `v0/agent/canonical_identity.ts` | shared domain-separated SHA-256 helper; manifest known answers不変 |
| `v0/agent/resolved_manifest.ts` | private digest pathをshared helperへ寄せるだけ; schema/API/answers不変 |
| new `v0/agent/replay_value.ts` | strict JSON/message/causal canonical clone and bounds |
| `v0/agent/session_store.ts` | causal validatorをshared helperへ委譲する場合のbehavior-preserving rewire |
| new `v0/agent/replay_envelope.ts` | envelope constructor/validator/payload/identity |
| new `v0/agent/execution_record.ts` | execution record validator/representation/pure recorder |
| new `tests/v0/agent_replay_record_test.ts` | known answers、matrix、invariance、nonleakage、recorder evidence |
| existing manifest/session/comparison tests | extraction regression、Step 77/78 known answers/relationship/isolation |
| `deno.v0.json` | source/test check targets、permission-free leaf、direct full-test edge |
| `tests/v0/offline_gate_topology_test.ts` | exact leaf ownership、permissions、check inventory |
| Step 79 results/lifecycle docs | implementation後のmeasured evidence |

manifest helper extractionはgeneric `domain + canonical payload -> identity`だけを共有する。manifest codec/domain/order/error
surfaceを変えず、既存six known answersをexact regressionとする。session causal extractionが不要ならsession fileを変更しない。

## Exact direct test contract

### Envelope positives and identity

- fixed payload/identityと二つのworkspace content digest known answersをexactに検証する。
- same logical inputsをfresh objects、異なるcaller absolute-root marker、異なるconstruction orderから渡してbyte-identical
  payload/identityを得る。
- task、各workspace path/digest、model identity、各budget scalar、initial transcript、manifest identityの一件差で
  envelope identityが変わる。
- `default` / `default-max-steps-4` manifestと4/8 budgetのcorrect correlationを検証する。
- manifest内sole model identityとのexact correlation、manifest full standalone validation、fresh/frozen ownershipを検証する。

### Envelope negatives

- all object levelsでunknown/missing/extra/wrong-order/inherited property、symbol、accessor、non-plain prototype。
- sparse/oversize array、depth/node/property/key/value/payload limits、nonfinite/-0 number。
- empty/oversize case/task、absolute/traversal/backslash/colon/control/empty-segment/trailing/duplicate/noncanonical/oversize
  workspace path、malformed/uppercase digest/identity。
- duplicate/unordered entries、wrong content digest domain fixture、multiple/missing model resource、model/manifest mismatch。
- zero/negative/fractional/overflow budget、wrong maxSteps/manifest、wrong role aggregate、external > aggregate、wall limit。
- malformed/unfinished/orphan/duplicate/mismatched/oversize initial transcript。
- errorsにtask/path/content/instruction/skill/profile/credential markerがないこと。

### Record positive fixtures

- fixed final committed fixtureとsame outcome one-shot uncommitted fixture。
- successful sole `submit_json_result` / `tool_terminal`。
- `default-max-steps-4`のfour parent attempts / `max_steps`。
- `contract_failure`のmodel errorとtool-result prefix。
- model/tool cancellation前後の`cancelled` prefix。
- multi-call tool batchについて、最初のdispatch前cancelと一result後cancelのexact three-layer correlation fixture。
- parent/planner observationsを含むdelegation fixtureでparent/planner/aggregate equationsを検証する。
- injected clock read exactly twice、constructorからfirst observationまでのdelay、zero-observation failure、first
  observation前のwall-limit超過、duration 0/boundary、fresh frozen result、finish idempotence rejection。
- same non-duration fields/different durationを受理し、identity/deterministic equality fieldが存在しないことをexact key testで
  固定する。

### Record negative matrix

- envelope/manifest identity mismatch、runOrdinal、duration clock、wall ceiling、unknown/missing/extra/order/shape limits。
- all stop reasons × ok × committed × terminalKindのinvalid combinations。
- steps/model/external/tool call/result role/aggregate/ceiling/count contradictions。
- model global/role ordinal gap/duplicate/order、unknown role/result、last-result/stop mismatch。
- tool call global/role ordinal、wrong/non-tool model reference、duplicate `(role,callId)`、name/arguments bounds。
- tool result global/role ordinal、future/wrong role/call/name correlation、duplicate result、result-without-call、terminal mismatch、
  result count > calls。
- initial prefix/task mismatch、assistant/tool suffix mismatch、partial batchの宣言/dispatch/result/commit層 mismatch、
  orphan/duplicate/missing/unexpected result、planner message leakage。
- failed/finished recorder reuse、late/out-of-order events、clock throw/noninteger/nonfinite/negative/backward/over-budget。
- provider token/cost number/null/object、raw provider metadata/header/chunk/progress/session/runtime fieldsをextra fieldとして拒否。
- credential/absolute path/content/provider metadata/progress markersがpayload/errorへ出ないこと。

### Regression and topology

- Step 77 six manifest known answersとStep 78 sole-axis relationship/public/runtime isolationを維持する。
- session causal validator extractionを行った場合はexisting store/process/TUI fixturesとcanonical persistence bytesを維持する。
- runtime/events/TUI/session/provider importsからnew replay/record modulesへproduction edgeがないことをtopology testで固定する。
- new sourceがDeno/filesystem/network/env/run permission APIを使わないことをsource inventoryで固定する。

## Exact permission topology

permission-free leafを一つ追加する。

```text
agent:replay-record:test
```

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/agent_replay_record_test.ts
```

exact permissionsは`[]`。new source/testを`v0:check`へ追加し、direct test ownershipを一度だけ登録する。leafを
`EXPECTED_LEAVES`とdirect `v0:test` compositionへ一度だけ追加し、このtest fileだけへmapする。既存leaf permissionsを
変えず、read/write/run/env/net/sysを広げない。

## Ordered implementation increments

1. 本planをhashし、initial implementation Human Gateで停止する。
2. shared canonical identity helperを追加し、manifest known answers不変を先に固定する。
3. strict JSON/message/causal value moduleを追加し、必要時だけsession parserをbehavior-preservingにrewireする。
4. replay envelope constructor/standalone validator/canonical payload/identityを実装する。
5. fixed envelope/content-digest known answersとidentity invariance/difference/negative matrixを追加する。
6. execution record types/standalone validator/canonical representationを実装する。
7. poisoned finite-state pure recorderとinjected monotonic clockを実装する。
8. final/tool_terminal/max_steps/contract_failure/cancelled/planner positive fixturesを追加する。
9. ordinal/correlation/count/outcome/duration/nonleakage negative matrixを追加する。
10. permission-free leaf、check inventory、full-test edge、topology assertionsを追加する。
11. focused/related/full offline verificationとresults/lifecycle evidenceを完了する。
12. bounded implementation review、one finding-closure pass、one narrow re-review、owner final gateを行う。

## Verification commands

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:replay-record:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:resolved-manifest:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:comparison-variant:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session-store:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:session:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:tui:test
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

initial implementation reviewはapproved plan、Step 79 diff、schema/bounds/canonical order、identity known answer、record
correlation、recorder state machine、focused/full evidence、permission topology、results/lifecycleをBlocker/P1/P2で30分以内に
確認する。10分間新しい証拠、tool output、中間結論がなければ中断する。

重点はduration非identity、manifest/model/budget binding、workspace descriptor boundary、strict descriptor-safe validation、
parent/planner ordinal equations、stop/commit/transcript correlation、unsupported usage、nonleakage、production non-import、
permission-free topologyとする。

finding closureはplan-scoped findingsへのone passだけとし、Step 80 runner、runtime/event/session integration、persistence、
provider field、public format、Why/What/Human Gateを追加しない。narrow re-reviewはchanged linesと既存finding closureだけを
15分以内に一度行い、GOはBlocker/P1/P2 zeroを要求する。scope拡張が必要ならownerへ返す。

## Acceptance package

implementation後に`docs/plans/agent-definition-replay-envelope-execution-record-results.md`を作り、authority/plan hashes、
revision、schema-v1 exact fields/bounds/order、content/envelope known answers、record exact fixture、duration nonidentity、
manifest/model/workspace/budget/transcript correlation、recorder state/clock、positive/negative matrices、unsupported usage、
nonleakage、regressions、commands/counts/permissions、review closure、deviations/rollback/residual risks、external operation zeroを
記録する。

completionはfixed envelope bytes/identity、all field-difference identities、all validation/correlation negatives、five stop
families、planner observations、duration boundary/nonidentity、unsupported token/cost、production import zero、topology/check/fmt/
lint/diff/direct/full gate、final Blocker/P1/P2 zero、reviewed treeとlifecycle evidenceの一致を要求する。

## Compatibility, rollback and residual risks

migration、persistent conversion、public selector/APIはない。rollbackはnew pure modules、optional behavior-preserving helper
rewires、direct tests、task/check/topology entries、Step 79 docs/lifecycle entriesに限定する。runtime/session data、prior
plans/results、user-owned `_refs/`を変更しない。

residual risks:

- workspace descriptorはcaller-declared digest setだけを証明し、actual filesystem completeness/authenticityを証明しない。
- normalized tool result JSONとcurrent transcript textのsemantic equivalenceはcaller adapter contractであり、Step 79はbounded
  correlationだけを証明する。
- provider token usage/costはunsupportedであり、Step 80のquality/cost comparisonには使えない。
- durationはclock sourceに依存する観測値で、same-condition identity/equalityには使わない。
- failure/cancellation recordはcompleted replayではなくobserved causal prefixである。
- SHA-256 collision resistanceはStep 77と同じ前提である。
- Step 79はdata/recorder contractだけを作り、fresh-runtime orchestrationとparent/variant comparisonはStep 80へ残す。

## Explicit exclusions

Step 80 runner/orchestration/comparison/report/score/winner、runtime/CLI/TUI/event/session/persistence integration、provider/
network/credential/live replay、record command/storage/export/import/public format、workspace scanner/walk/Git capture/source bundle、
raw provider request/response/header/chunks/IDs、token/cost/billing exposure、model-output deterministic playback、additional
variants/matrix/dynamic loader、AI evaluator/candidate/lineage/promotion/self-revision、managed deployment/sandbox/secret/MCP/
schedule/channel/billing、dependency/lockfile、`_refs/`、production command、commit/push/tag/publish/release、milestone 100
hardeningは対象外。

## Human Gate

このplanning authorizationはread-only inspection、canonical plan/lifecycle planning status、plan hashing、planning reviewだけを
含む。product source、tests、task configurationを変更せず、implementation testsを実行しない。

別途implementation承認後はStep 79 repo implementation、permission-free/direct offline tests、existing full offline gate、
results/lifecycle updates、bounded reviewとone closure/re-review cycleだけを許可する。provider/network/credential/production
command、external persistent state、dependency/lockfile、`_refs/`、commit/push/tag/publish/releaseは含まない。
