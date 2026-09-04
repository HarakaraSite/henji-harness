# Agent Worker foundation proof — Stages 1–3

## 計画の位置付け

- 状態: 実装承認前の計画候補
- 基準点: commit `2a2c47d`
- 正本architecture: [`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)
- 正本運用Record: `.handoff/handoff.md` の `POL-20260904-henji-host-agent-worker`
- 実装許可: この文書の作成時点では未承認。後段の明示Human Gateで別途承認する
- 対象: accepted architecture の Stages 1–3。Deno Web Worker capsule、built-in Definitionの
  Worker実行、external trusted Definitionとの同一経路証明まで
- 目的: executable TypeScript Agent DefinitionをDeno Web Worker内で評価・合成し、built-inと
  user-supplied external trusted Definitionが、同じWorker bootstrap、semantic protocol、
  live runtime/turn、Host commit pathを通ることを、現行TUIをHost側Surfaceとして示す

この計画は実装手順を認可する文書ではない。計画承認後にだけ、記載した範囲のrepository実装、
provider-free focused検証、read-only functional review、stable candidateに対するownerの
authoritative `v0:gate`一回を実施できる。architecture文書が未決定としているwire schema、
permanent I/O placement、migrationの一般化、security hardeningは、この計画で必要な最小限を
越えて決めない。

## 1. 利用者が必要とする最終動作

Stages 1–3完了時、利用者は次のproduct経路を使える。

1. 既存の `henji` TUIを通常どおり起動し、built-in `default`（およびそのplanner lane）を
   Workerで実行できる。端末、stdin/stdout、editor、layout、rendering、Surface actionの
   command変換はHostに残る。
2. Worker内でDefinitionがprovider/model、effort、loop、work tools、planner、instructions、
   skills、contextをlive compositionとして構築し、現行と同じ一つのturnを実行する。
3. Hostはruntime event、effect observation、commit proposalをsemantic messageとして受け、
   canonical session stateを検証してからdurable storeへcommitする。Host durable storeの成功時点を
   唯一のcommit pointとし、その時点でSurfaceへ `committed=true` を投影できる。Workerへのcommit
   acknowledgementはWorker-local stateの前進と次commandのadmission用であり、ack delivery failureは
   「committedだが当該generation unavailable」としてsettleし、uncommitted扱いにも再送にも変えない。
4. 利用者は `--definition ./henji.agent.ts` でcaller workspace内のtrusted-local TypeScript
   Definitionを選べる。built-inとexternalの選択だけが違い、実行経路、能力、event、commit、
   resumeの意味は同じである。
5. external Definitionは同じ標準componentを用いながら、`maxSteps: 4`という実際のcomposition
   差を示す。built-in `default`は`maxSteps: 8`のままとする。
6. 通常入力、streaming/progress/tool projection、final answer、cancel、error、session context、
   close/reopenが、fixtureだけではなく同じproduction module/runtime graphで機能する。

### 成功条件と未確認事項

成功条件はtest件数ではなく、人間が実際のproduction経路で目的のturnを完了できることである。
offline seamは局所的な因果確認に使うが、fixtureの成功をproduct acceptanceへ読み替えない。
現時点で次が未確認であり、Stage 1で実行証拠を取得してから実装詳細を固定する。

- repository-pinned Deno 2.9.4のmodule Workerに、built-inとworkspace-local external file URLを
  動的importできるか
- external moduleから同じimport mapで`@henji/agent`を解決できるか
- entry URLへのdigest queryがrelative importを保ち、別module evaluationを分離できるか
- Workerがentryをimportする前にpre-read/hashし、正確なdefault export functionを検証できるか
- structured clone境界を関数、module namespace、Host objectが越えないこと
- production launcherの安定permissionだけでこのloaderと実行経路が動くこと
- provider/tool physical I/OをWorker-directで置くproof-local選択が、後のRPC/capabilityまたは
  subprocess設計を不要に固定しないこと

Stage 1のimport-map/query/export前提のうち1–4が実証できない場合はStage 2へ進まない。観測結果、
失敗地点、最小のalternative loader案だけをownerへ返し、独自のloader仕様を追加しない。

## 2. 現行sourceの事実とcall graph

### 2.1 現行call graph

現物確認した現在のproduction経路は次のとおりである。

```text
session_launcher.sh
  → tui_cli.main
    → resolveBuiltinAgent
    → prepareRuntimeComposition
      → workspace / AGENTS / skills discovery
      → current data-only AgentDefinition evaluation
      → resource / resolved-manifest validation
    → materializePreparedRuntimeComposition
      → Host-process OpenRouter model
      → Host-process Registry/tool factories
      → Host-process planner handler
    → AgentSession.submit
      → runAgentTurn
        → model.generate / registry.dispatch
        → persistence.commit
        → turn_end(committed)
    → TuiPresentationAdapter
      → retained Host-side TUI
```

このgraphは「現在そう動く」ことの記録であり、最終Worker protocolではない。移行後は
`DefinitionRevisionRef → common Worker bootstrap → module evaluation → live composition →
semantic messages → Host proposal validation/commit`を共通pathとする。

### 2.2 Definition、catalog、registry

- [`v0/agent/agent_definition.ts:41-59`](../../v0/agent/agent_definition.ts) の
  `AgentDefinitionInput`はHost-resolved `Workspace`、instructions、`SkillCatalog`を入力に取り、
  `ResolvedAgentDefinition`（model、system instruction、capability identity、limits、
  resource selection）を返す。`AgentDefinition`は同ファイル59行の同期関数型である。
- 同ファイル128–167行はmodel/capability identityをflattenし、同173–181行は
  `defaultAgentDefinition`と`plannerAgentDefinition`をそれぞれdata projectionとして定義する。
  現在のDefinition自身はfilesystem、credential、network、tool、session、event、UI workを
  しない（同169–181行）。つまり現行はlive compositionではない。
- [`v0/agent/agent_catalog.ts:49-75`](../../v0/agent/agent_catalog.ts) は固定の
  `DEFINITIONS` tableに`default`/`planner`だけを持ち、`resolveBuiltinAgent`が省略時defaultまたは
  exact built-in selectorを返す。これは現行CLI admissionの証拠だが、external executable
  compositionのauthorityとして維持しない。
- [`v0/agent/registries.ts:29-68`](../../v0/agent/registries.ts) の
  `RegistryMaterializationContext`はHostのworkspace、skills、work-tool seams、planner handlerを
  保持し、`createDeclaredTool`のswitchが宣言identityをexecutable toolへ変換する。
  同80–111行の`createDeclaredRegistry`もsubagentとskill declarationを検査し、tool registryを
  materializeする。external Definitionのauthorityをこの固定ID switchに戻さない。
- 同ファイル126–168行のproduction/planner registryは、現在のnormal compositionとoffline
  sentinelを別々に組み立てる。新pathではstandard constructors/interfacesを`@henji/agent`の
  importable defaultとして公開し、Hostの固定allowlistではなくDefinition codeがcompositionを
  選ぶ。

### 2.3 Runtime、provider、tool、planner

- [`v0/agent/runtime.ts:247-314`](../../v0/agent/runtime.ts) の
  `prepareRuntimeComposition`はworkspaceをresolveし、AGENTS/instructionsとskillsをdiscoverし、
  選択Definitionを同期評価し、resource selectionとresolved manifestを検証してdisplay stateを
  投影する。現在これらは同一processである。
- [`v0/agent/runtime.ts:167-201`](../../v0/agent/runtime.ts) はresolved modelをprovider別switchで
  materializeし、registryは`createDeclaredRegistry`でHost側に構築する。同317–429行はplanner
  delegation、child Definition、child model、child registry、parent modelを順にmaterializeし、
  runtime compositionを返す。
- [`v0/agent/runtime.ts:441-468`](../../v0/agent/runtime.ts) はこのcompositionをHost側の
  `AgentSession`へ注入する。同497–549行の`runRuntime`は一回のcompositionと一回のnormal loopを
  結び、provider evidenceを任意に保存する。
- [`v0/agent/openrouter_model.ts:1344-1407`](../../v0/agent/openrouter_model.ts) はcredentialを
  毎回resolveし、requestをencodeしてからfetchを開始する。同1437–1463行はAuthorization付きの
  provider fetchとresponse metadataを扱い、同1513–1567行はSSE responseを読む。credential値と
  Authorizationはprotocol/evidenceへ渡さないが、診断上必要なrequest、response、SSE、metadataは
  readback可能なevidenceとしてWorker内からHostへ返せる形にする。
- [`v0/agent/work_tools.ts:42-47`](../../v0/agent/work_tools.ts) はDenoのreal pathからworkspaceを
  resolveする。同193–265行がreadのfilesystem effect、同268–352行がwrite/editのatomic replace、
  同679–831行が`/bin/bash`のspawn、capture、timeout、cancel cleanupを実行する。これがWorker-direct
  proofでWorker側へ移るphysical effectの現物である。
- [`v0/agent/planner_delegation.ts:175-243`](../../v0/agent/planner_delegation.ts) は
  `delegate_to_planner`をparent contextへ接続し、子のusage、result envelope、failureを扱う。新path
  ではplanner child laneもDefinition evaluationとsemantic correlationを持たせる。

### 2.4 Loop、session、persistence、cancel

- [`v0/agent/loop.ts:253-307`](../../v0/agent/loop.ts) の`runAgentTurnInternal`はcommitted
  transcriptのcopyから一つのuser turnを作り、event sinkを通してturn startを出す。同498–547行で
  step、context、request admissionを同期的に進め、同574–625行でmodelを呼び、同627–825行でfinal、
  tool call/result、progress、planner failure、steer、max stepを処理する。
- [`v0/agent/loop.ts:423-481`](../../v0/agent/loop.ts) の`finishNormal`はsuccessful outcomeで
  `options.commit`を呼んだ後に`turn_end`を送り、commit failureはuncommitted contract failureと
  する。これは現行same-process経路でもpersistence成功がcommit pointとして先行する証拠であり、
  新protocolではloopの内部callbackをWorker-to-Host proposalへ置き換える。Worker ackをcommit表示の
  前提にはしない。
- [`v0/agent/session.ts:101-185`](../../v0/agent/session.ts) の`AgentSession`はcommitted
  transcript、active state、next turn、context checkpoint、persistence、session identityを所有する。
  [`v0/agent/session.ts:329-406`](../../v0/agent/session.ts) はsummaryを生成して既存のcheckpoint
  persistenceへinstallする。さらに[`v0/agent/session.ts:438-579`](../../v0/agent/session.ts) の`submit`
  はheld user textを自動compactionの成否後までadmitせず、cancellation/evidence/diagnosticを作り、
  loopのcommit callbackからpersistenceを呼ぶ。
  同582–679行でevidence/diagnosticをsettleし、失敗時にrollbackまたはunavailable化する。
- [`v0/agent/cancellation.ts:26-76`](../../v0/agent/cancellation.ts) の
  `TurnCancellationOwner`は同一processのAbortControllerをturn単位で所有する。Worker移行後は
  semantic `cancel`をWorkerへ送り、Worker-local abortとHost側lifecycleを混同しない。
- [`v0/agent/session_store.ts:31-40`](../../v0/agent/session_store.ts) の`SessionRecord`はschema-v1で
  `agent: 'default' | 'planner'`だけをadmitする。`validateSessionRecord`は同267–300行で厳密な
  keys、causal transcript、next turnを検証する。
- [`v0/agent/session_store.ts:600-695`](../../v0/agent/session_store.ts) の`writeAtomic`と
  `createSessionPersistence`はtemporary fileのsync後renameし、Hostのdurable commit/rollback portを
  提供する。同917–950行はper-session lock後にrecord/checkpointをhydrateする。
- [`v0/agent/session_store.ts:1125-1227`](../../v0/agent/session_store.ts) はsession recordと
  semantic checkpointのatomic write、rollback、lock closeを実装する。これはWorkerのcanonical
  state authorityに移さずHostに残す。

### 2.5 Surface、TUI、launcher、task

- [`v0/agent/tui_cli.ts:154-210`](../../v0/agent/tui_cli.ts) のparserは現状`--agent`、
  `--continue`、`--session`、`--no-session`を扱う。同249–274行の`main`はselectorを解決してから
  real TTYを確認する。
- 同281–395行はproduction session factoryでprepareをstore operationより先に完了し、storeを
  allocate/openしてからsession compositionを作る。同562–688行はpresentation adapter、controller、
  raw terminal lifecycle、startup、restore、closeをHost processで実行する。
- [`v0/agent/tui_presentation_adapter.ts:45-123`](../../v0/agent/tui_presentation_adapter.ts) は
  UIが受け取るsmall session portを定義し、core session objectを渡さない。同579–764行はcore eventを
  bounded presentation eventへ変換し、同766–915行はsubmit、cancel、steer、navigationをadapterに
  閉じ込める。
- [`v0/presentation/contract.ts:2-6`](../../v0/presentation/contract.ts) はpresentation moduleを
  data-onlyとし、runtime/provider/session store/terminal/TUIをimportしない。同295–369行はUIから
  coreへ渡すtyped data-only intentを定義し、同371–526行はturn、tool、lifecycle、failure、startup、
  projection eventを定義する。これをWorkerに移さずHost-side Surfaceの契約として維持する。
- [`v0/agent/session_launcher.sh:15-54`](../../v0/agent/session_launcher.sh) は現行selectorと
  session modeをparseし、同121–149行はDeno 2.9.4を確認してstable permissionでTUIを起動する。
  productionに`--unstable-worker-options`を足さない。
- [`deno.v0.json:1-34`](../../deno.v0.json) はpinned Deno path、agent run/TUI tasks、`v0:check`、
  `v0:fmt`、`v0:lint`、`v0:test`、`v0:gate`をauthoritative taskとして定義する。

## 3. 移行後の責務境界と不変条件

### 3.1 HostとWorkerの責務

| 責務 | Host | Agent Worker |
| --- | --- | --- |
| Surface | terminal/stdin/stdout、TUI layout/editor/rendering、Surface action→command | 所有しない。headlessで動作する |
| lifecycle | Worker起動、generation、close、forced `terminate`、監視 | cooperative closeとturn-local cleanupを返す |
| Definition | revision refをpre-startで確定し、entryをpre-read/hashする | canonical specifierをimportし、exact default exportを評価する |
| composition | runtime objectを所有しない | provider/model/effort/loop/tools/planner/contextをlive構築する |
| semantics | command admission、proposal検証、canonical session revision | transcript/context、turn state、loop、event/effect evidenceを意味付けする |
| physical I/O | terminal/Surface、session store、diagnostic/evidence store | Stages 1–3ではprovider/tool I/Oをdirectに行うproof-local choice |
| durability | lock、load/store、atomic commit、session schema、store成功時のcommit投影、Worker ack送信 | state commitを提案し、canonical sourceにはならない。ackはlocal state前進用 |

Host canonical persistenceとWorker semantic ownershipを二重の正本にしない。1 Sessionは一つの
AgentInstanceに属する将来関係を阻害しないよう、Stages 1–3では`instanceCorrelation`をsession-bound
のproof-local identityとして持つ。durable AgentInstance、resident service、generation replacementは
対象外だが、session、Definition revision、generation、base state revisionを相関できないprotocolは
作らない。

### 3.2 Definition revision、Manifest、fencing

Worker起動前に、概念上次のdata-only `DefinitionRevisionRef`をHostが確定する（field名はproof-local
提案であり、permanent schemaではない）。

```ts
type DefinitionRevisionRef = Readonly<{
  kind: 'builtin' | 'external';
  canonicalSpecifier: string;
  entrySha256: string;
  sourceBytes: number;
}>;
```

Hostはcanonical file URL、entry byte count、SHA-256をstart直前に計算する。Workerはimport前にentryを
pre-read/hashし、digest query付きcanonical URLをimportし、同じrefを`ready`で返す。Hostはready後にも
entryを再hashして記録する。digest queryはimmutability保証ではない。このstable-enough refはtrusted
single-host proofのためであり、transitive graph hash、hostile TOCTOU対策、package store、distribution、
promotion、self-revisionを意味しない。

評価後に返すdata-only `AgentManifest`は、選択内容を説明するprojectionであってadmission/permission
authorityではない。HostはManifestのcapability IDを固定switchへ戻してexternal Definitionを縮小せず、
pre-start ref、generation、base Host state revision、commandの完全一致だけでproposalをadmitする。

### 3.3 Semantic protocolの最小契約

wireのfield名とencodingはこの計画で固定しないが、各messageは少なくとも次を相関する。

`session`、proof-local `instanceCorrelation`、`DefinitionRevisionRef`、`workerGeneration`、
`baseStateRevision`、`command`。

Host→Workerのsemantic kindは`start`、`turn`、`steer`、`cancel`、`checkpoint acknowledgement`、
`commit acknowledgement`、`close`。Worker→Hostは`ready`、`runtime event`、`effect observation`、
`checkpoint proposal`、`commit proposal`、`turn failed`、`closed`、`worker error`とする。runtime event、
effect observation、checkpoint proposal、commit proposalは一つに融合しない。effect request、effect
started/completed/unknown evidence、state commit proposalも別の意味として保持し、commitがないこと
だけでeffect未発生またはsafe replayと判断しない。

Hostはcurrent admitted generation、同一Definition ref、同一base state revision、同一commandのproposal
だけを受理する。Host durable storeの成功がturnの唯一のcommit pointである。store failure、worker error、
cancel、correlation failureはuncommittedでsettleするが、store成功後のcommit ack delivery failureは
committed stateを取り消さず、「committedだが当該generation unavailable」としてsettleする。いずれも
provider/tool effectの可能性がある場合にsilent retry、fallback、auto-resubmit、ack再送をしない。

### 3.4 Automatic compactionの境界

現行の`AgentSession`が行うautomatic compactionを、Worker内だけの隠れた副作用にも、Hostだけの
独立機能にも変えない。Workerがthreshold到達と有用なboundaryを判断し、summaryとcheckpoint metadataを
data-only `checkpoint proposal`として返す。proposalには少なくともsession、instanceCorrelation、
Definition ref、generation、base Host state revision、commandを相関させる。

Hostはcurrent correlation、base revision、checkpointのsession/turn/profile整合を検証し、既存の
checkpoint storeへinstallする。install成功後、Workerへ`checkpoint acknowledgement`を返す。held user
textはこのackまでturn admissionせず、ack成功後だけWorkerが次のuser turnを開始する。したがって
checkpointのinstallとturnのcommitは別のpointである。

- validation/install前のfailureまたはcancelはcheckpoint未変更、held turn未開始、user-turn provider
  request 0として明示的にfailed/cancelledへsettleする。
- 既存契約どおりsummary生成がprovider requestを必要とする場合、そのrequestはcompaction laneの
  requestとして記録し、failure/cancel時はsummaryとheld turnを再送しない。summary requestの発生と
  held user turnのrequestをevidence上で分離する。
- checkpoint install成功後にack deliveryが失敗した場合はcheckpointをrollbackせず、held turnを開始せず、
  generation unavailableとしてsettleする。user textの自動再送、ack再送、provider user-turn requestは
  行わない。close/reopenではdurable checkpointを読み取り、選択・revision bindingとともに再利用する。

これはStage 4のgeneration replacementやresident recoveryを実装する指定ではない。Stages 1–3で必要な
「held textはcheckpoint ack後のみ開始」「checkpoint durabilityとturn commitを混同しない」という境界を
証明するための最小semantic seamである。

## 4. How decisionの推奨と選択要求

### 4.1 provider/tool physical I/O placement

推奨はStages 1–3に限るWorker-directである。現在のOpenRouter/SSE、work tools、plannerをlive TS
composition内へ移す最短の可逆経路であり、RPC protocol設計をproofそのものにしないためである。

- Worker内に`PhysicalIoBindings`相当の小さなcomposition input/factory seamを置く。
- Host/Worker semantic protocolにはprovider transport、raw credential、Authorizationを通さず、
  runtime event、effect observation、commit proposalだけを流す。
- Workerは現行launcherのstable production permissionを継承して使う。Workerごとのpermission narrowing
  probeだけは`--unstable-worker-options`を使ってよいが、production launcherへそのflagを持ち込まない。
- Host RPC/capability、split placement、subprocess境界、permanent placementは後続の別計画に残す。
- seamをphysical I/O constructionの唯一の入口にし、Worker-directを将来の恒久決定として名前や
  protocolへ埋め込まない。

このHow選択について追加のuser decisionは不要である。計画承認は、このbounded proof placementだけを
承認する。Stage 1のstable permission/import結果と実product挙動が両立しない場合は、ownerへ停止して
alternativeを返す。

### 4.2 external DefinitionのCLI/module contract

最小のuser-facing contractは次のとおりとする。

```text
henji --definition ./henji.agent.ts
henji --definition ./henji.agent.ts --continue
henji --definition ./henji.agent.ts --session <uuid>
henji --definition ./henji.agent.ts --no-session
```

- `--agent`と`--definition`はmutually exclusive。既存`--agent default|planner`は維持する。
- selector省略はbuilt-in `default`。既存のdefault invocationもWorkerを通る。
- external pathはcaller workspace-relative、workspace-contained、`.ts`に限る。launcherのread
  permissionを広げない。
- external codeはtrusted-local codeであり、signature、provenance tier、marketplace、permission
  matrix、fail-closed hardeningを追加しない。

repository-localの小さなpublic composition facadeを`@henji/agent`として`deno.v0.json`のimport mapへ
追加する。契約例は次である。

```ts
import {
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from '@henji/agent';

const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition(input, {
    limits: { maxSteps: 4 },
  });

export default definition;
```

built-in `default`/`planner`も同じexact default-export function contractとdynamic import/export
validationを使う。Hostはcomponent IDをswitchしてexternalを再構築しない。externalは同じ標準default
componentを使い、maxSteps 4だけを差分にして、built-in maxSteps 8とのactual composition差を示す。

### 4.3 残るuser decision

追加のWhy/What/Whether判断は残していない。実装を始めるには、最後のapproval wordingにある計画承認が
必要である。provider credential参照、network、installed production TUI、real provider Human Gate、
actual state cleanup、commit/push/tag/publish/releaseは、その承認に含めない。

## 5. 実装slice（依存順）

各sliceのcandidate pathは実装時に現物へ合わせる。下記以外のproduct bug、依存追加、permission
拡張、external service操作が必要になったら自己判断で広げずownerへ返す。

### Slice 1 — exact-runtime Worker capsuleとdata protocol

**規模:** 4–6 person-days

**所有候補:** 新規Worker protocol/bootstrap/host bridge module、Worker capsule probe/test module、
`deno.v0.json`のfocused task wiring。既存product runtimeは変更しない。

**動作:**

- pinned Deno 2.9.4の`new Worker(url, { type: 'module' })`を実際に起動する。
- module startup/evaluation/ready、同一senderのmessage ordering、structured-clone data isolation、
  functionの`DataCloneError`、module/worker-originated errorを観測する。
- Worker cooperative `close`とHost forced `terminate`を別のlifecycle outcomeとして観測する。
- permission optionはWorker-specific probeとして観測する。narrowing probeにだけ必要なら
  `--unstable-worker-options`を使い、production task/launcherには追加しない。
- 代表的incremental event、1 MiB data-only transfer、既存300 KiB超answer regressionを確認する。
- ready/error/closeとcorrelationをStage 2が再利用できる最小seamとして返す。daemon、mailbox、
  scheduler、remote router、durable Instance、general sandboxは作らない。

**focused verification:** pinned binary/version、module import-map/query probe、ordering/clone/error/
close probe、large transfer probe、stable permission probe、`deno.v0.json`のcheck/fmt/lint対象への
型・format確認、`git diff --check`。

**stop condition:** built-in/external file URL import、`@henji/agent`解決、digest queryのrelative import、
pre-read/hashとexact default-export validationのいずれかが実証不能なら停止し、観測と最小alternative
loader案をownerへ返す。production permissionにunstable flagが不可避なら停止し、permission policyを
独自変更しない。

**rollback boundary:** 新規capsule/protocol/probe/taskだけを除去可能。既存runtime/session/TUI/stateは
触れないため、Stage 1失敗時にproduct経路を戻す作業は発生しない。

### Slice 2 — executable Definition API、loader、revision ref

**規模:** 6–9 person-days

**所有候補:** executable Definition/public facade/revision/loader module、built-in default/planner
entry module、必要最小限の`agent_definition.ts`/`agent_catalog.ts`/`registries.ts`、import map。

**動作:**

- `ExecutableAgentDefinition`を入力からlive compositionを返す関数として定義し、functionそのものを
  `postMessage`しない。
- Hostでcanonical external pathとentry hash/byte countを計算し、Workerでpre-read/hash、digest-query
  import、exact default function validationを行う。
- built-inとexternalで同じ loader/default-export validation、同じready ref、同じManifest projection
  を使う。Manifestは説明用data-onlyに限定する。
- standard component constructors/interfacesをpublic facadeへexportする。Host ID switchを
  external executable compositionのauthorityにしない。
- built-in maxSteps 8、external proof Definition maxSteps 4をlive compositionの差分として保持する。

**compatibility:** schema-v1のbuilt-in default/planner data recordsはこのsliceでは読み取り可能なまま
にする。ただしproductionへ旧data-only Definitionと新Worker Definitionを静かに二重採用しない。branch
中のlegacy seamは新pathが通った時点でproduction入口から外す。current Manifestはadmission authorityへ
昇格させない。

**focused verification:** built-in/external同一loader trace、default export形、function/module namespace
clone rejection、relative importとdigest queryの評価分離、Definition ref pre/post hash、Manifestと
refの分離、maxSteps 8/4、unknown export/invalid refのstartup failure。provider-free compositionで
actual constructor graphを通す。

**stop condition:** externalがRPC-only/reduced-capability pathを必要とする、Host registry switchを
authorityとして残す、Manifest allowlistがなければ動かない、またはnew provider/dependencyが必要なら
停止して理由・影響・最小修正案を返す。

**rollback boundary:** Worker実行へsessionを接続する前はpublic facade/loader/builtin entry/new protocol
だけを戻せる。external CLI契約を実装した後に契約を変える場合はuser approvalへ戻す。

### Slice 3 — Worker-owned live runtime/turn

**規模:** 15–22 person-days

**所有候補:** Worker runtime/loop/session coordinator、provider/tool/planner/context/events/cancellation
のWorker-side module、physical I/O bindings。Host TUIとpersistenceはまだ最終接続しない。

**動作:**

- Definition評価後、一つのWorker generation内でprovider/model/effort/loop/work tools/planner/
  instructions/skills/contextをlive materializeする。built-in parentとplanner childは同じ semantic
  laneの規約を使う。
- automatic compactionが必要なturnではWorkerがcheckpointを決定し、summaryとmetadataをdata-only
  `checkpoint proposal`として先に返す。Hostのcheckpoint install成功と`checkpoint acknowledgement`
  の後までheld user textをturnとして開始せず、compaction requestとuser-turn requestを分離する。
- turn、steer、cancel、runtime progress/tool/final、effect observation、turn failed、close/errorの
  semantic eventを相関付きで返す。
- cooperative closeとforced terminateを区別し、uncaught error/cancel/cleanup failureはuncommittedで
  settleする。provider/tool effectの可能性がある場合は自動retry/resubmitしない。
- Worker-direct I/Oは`PhysicalIoBindings` seamからだけ構築する。Host側へprovider transport detailを
  RPC化しない。
- streaming eventはincrementalに送るが、structured-clone data-only契約を守る。credential/Authorization
  はevidenceに記録しない。

**compatibility:** 現行loopのtool/progress/final意味、planner bounded envelope、cancellation ownerの
product behaviorを保つ。session canonical transcriptはまだHostのみを正本とし、Worker内のdraftは
ephemeralとする。既存のsame-process pathを実行時に裏口として残さない。

**focused verification:** production module graph上のfake model/fake standard toolでstartup→ready→turn→
runtime events→proposalの順序、planner child lane、progress ordering、steer/cancel、uncaught exception、
unknown effect、no replay、cooperative close/terminate、large incremental transferを確認する。

**stop condition:** WorkerがTUIを要求する、Hostへfunction/object capabilityをcloneしようとする、
provider/tool effectとcommit proposalが混線する、error後にsilent resubmitする場合は停止する。

**rollback boundary:** Host store/commit ack接続前ならWorker runtime/seam/protocolだけを戻せる。ここで
protocolのcorrelation fieldを削る変更はStage 4以後を阻害するため計画変更としてownerへ返す。

### Slice 4 — Host canonical commitとminimal session schema-v2

**規模:** 8–12 person-days

**所有候補:** Host runtime/Worker-backed session port、proposal validator、`session.ts`、
`session_store.ts`、diagnostic/provider evidence readback adapter。canonical storeをWorkerへ移さない。

**必要理由:** 現行schema-v1の`SessionRecord.agent`は`default|planner`だけをstrict admissionするため、
external selection/revisionを記録せずに同じcommit/resume pathを共有できない。external-as-defaultや
external-no-sessionはStage 3の同一path要件に反する。

**v2の限定:** built-in/external selectionと`DefinitionRevisionRef` discriminantだけを追加する。既存の
transcript/message/causal/accounting/atomicity semantics、v1 read、default/plannerの既存record形は変えない。
次のsuccessful commitでv2を書く。externalのstartはv2とする。resumeはcanonical specifier/digestが
一致する場合だけ許可し、不一致はstartup failure、state transitionゼロ、resubmitゼロとする。

**動作:** Worker commit proposalをHostがsession、instance correlation、ref、generation、base state
revision、commandでvalidateし、Host durable store成功をturnの唯一のcommit pointとする。store成功時点で
Hostは`turn_end.committed=true`を投影でき、Workerへのcommit ackはWorker-local state前進と次command
admissionのために送る。ack delivery failureは「committedだが当該generation unavailable」とsettleし、
  commit済み状態を維持し、store rollback、ack再送、turn再実行をしない。effect evidenceはproposalと別readback
recordに保持し、credential/Authorizationを保存しない。

同じsliceで、Workerのcheckpoint proposalをHostがsession、instance correlation、ref、generation、base
state revision、command、checkpoint turn/profileでvalidateし、既存checkpoint storeへinstallする。
install成功後に`checkpoint acknowledgement`を返し、held user textはack成功後だけturnとして開始する。
install/validation failureまたはcancelはcheckpoint/held turnを変更せず、user-turn provider request 0で
failed/cancelledへsettleする。summary生成に既存契約上のprovider requestがある場合はcompaction laneと
して記録し、user-turn requestと混同しない。checkpoint install後のack delivery failureはdurable
checkpointを保ったままgeneration unavailable、held turn未開始、再送なしでsettleする。

**focused verification:** valid proposalのstore成功時点commit projection、stale generation/ref/base revision
rejection、store failure/error/cancelでcommitがないこと、store成功後のack failureがcommitted/unavailable
となりrollback・ack再送・turn再実行をしないこと、v1 read/v2 write、external resume exact-match、mismatch
no transition、evidence durability/readback、no automatic replayをproduction graphで確認する。加えて、
automatic compactionのthreshold/useful boundaryをWorkerが判断し、data-only checkpoint proposal、Hostの
既存store install、checkpoint ack前のheld text/no user-turn provider request、ack後のturn開始、validation/
cancel/install/ack failureの明示settle、close/reopen後のcheckpoint利用を確認する。

**stop condition:** Hostがproposal前にstoreを変更する、Workerがcanonical transcript/checkpointを所有する、
checkpoint ack前にheld turn/provider requestを開始する、v1 recordを読めなくする、またはv2拡張がtransitive
revision/Instance migrationを要求する場合は停止する。

**rollback boundary:** v2 writerへ接続する前はHost adapter/proposal validatorを戻せる。v2 writer接続後は
v1 recordを保持しても旧binaryがnew v2 recordを読めない可能性があるため、Human Gate前に明示 disclosureし、
その後のschema変更はuser approvalへ返す。

### Slice 5 — Host TUI/CLI selectionとlauncher

**規模:** 5–8 person-days

**所有候補:** `tui_cli.ts`、`tui_presentation_adapter.ts`、presentation contractへの最小projection、
`session_launcher.sh`、startup wiring、import map/task設定。

**動作:** `--definition`と既存session modeの全組合せをparseし、`--agent`との排他、workspace-contained
`.ts`、省略時defaultを守る。built-in invocationも同じWorker pathへ入る。TUIのterminal/editor/layout/
rendering、slash/history/navigation、Surface command変換はHostに残し、external表示は必要最小限の
startup/projection labelだけとする。

**compatibility:** `--agent default|planner`、`--continue`、`--session`、`--no-session`の既存利用を壊さず、
schema-v1 built-in recordのreadbackを維持する。launcherはDeno 2.9.4、現行stable permissions、既存state
rootを使い、worker optionのunstable flagを本番へ追加しない。

**focused verification:** parser flag order/mutual exclusion、new/continue/exact-session/no-session、
built-in/external common bootstrap trace、Host-side presentation event、normal progress/tool/final、
cancel/error、close/restore、external session resume mismatchをfake Worker plus production graphで確認する。

**stop condition:** TUIへWorker objectを渡す、externalだけ別Surface/RPC pathになる、launcher read permissionを
workspace外へ広げる必要がある場合は停止する。

**rollback boundary:** final provider Human Gate前はCLI selection/projectionを戻せる。ただし`--definition`
の公開契約を変更する場合はplan deltaとしてowner/user判断へ戻す。

### Slice 6 — provider-free integrated product-path proof

**規模:** 5–7 person-days

**所有候補:** provider-free test seam、実production module graphのintegrated probe、必要なsmall test task。
product sourceのfixture-only別pathは追加しない。

**動作:** 実際のTUI composition root、Worker bootstrap、Definition loader、semantic messages、proposal→Host
durable store→committed projection→Worker ack、presentation projectionを一つのtraceで通す。built-in 8と
external 4のcomposition差、同じstandard components、Host TUI所有、correlation、diagnostic/effect evidenceを
readbackする。compactionが発生するoffline scenarioではcheckpoint proposal→既存store install→checkpoint
ack→held user turn開始を同じproduction graphで通す。

**focused verification:** offline model seamが実production runtime graphを通ること、fake Worker単独でなく
installed-equivalent TUI pathでnew/continue/commit/cancel/error/closeを確認する。Host store成功時点のcommit
projection、commit ack failure後のcommitted/unavailable/no-resubmitを確認する。さらにcompaction decisionと
data-only checkpoint proposal、Host validation/install/ack、ack前のheld turn停止、ack後の開始、cancel/failure
settle、close/reopen checkpoint readbackを確認する。作業中はfocused check、fmt、lint、`git diff --check`だけ
を使い、full gateはownerへ残す。

**stop condition:** fixture-only path、Host Definition materialization、external special path/reduced registry、
credentialのprotocol/evidence流入、store前のcommitted表示、store成功済みturnを失敗状態へ戻す投影またはack再送、
checkpoint ack前のheld turn/provider request、auto-resubmitが必要なら停止して返す。

**rollback boundary:** provider実行前なのでintegrated probe/seamを戻せる。provider/credential/production
stateは操作しない。

### Slice 7 — review、gate、Human Gate package

**規模:** 2–4 person-days（Human Gateの実行時間・provider incidentを除く）

**所有候補:** review input、evidence checklist、Human Gate disposable workspace/package、plan results文書。
plan document自体はこのsliceで書き換えない。

**動作:** focused completion後にfunctional read-only reviewを実施し、必要なら一回だけ局所finding closure、
一回だけnarrow re-reviewする。reviewはcorrectness、明示要件、公式Deno契約、実product path、regression、
具体的test不足だけを見る。一般hardening、仮想failure matrix、test count目標は追加しない。

**gate timing:** ownerはstable candidateに対してauthoritative `v0:gate`を一回だけ実行する。reviewerはfull
gateを実行しない。gate失敗時はfocused check/testで原因を特定し、具体的理由なしに再実行しない。

**rollback boundary:** Human Gate前はprovider-free candidateを戻せる。provider/credential/installed stateの
cleanupやgit history操作は別承認がない限りしない。

## 6. 最終real-product Human Gate

### 実行前準備

provider executionの前に、disposable workspaceへ次を置く。

- `worker-proof.txt`：exact bytes/text `henji-worker-proof-20260904`
- reviewed external `henji.agent.ts`：`createDefaultAgentComposition`を使い、maxSteps 4だけを
  built-inとの差分にしたもの

installed production TUIでfresh sessionを二つ、built-in→externalの順に一回ずつ実行する。promptは
次のexact textとする。

> このターンでは planner を呼ばず、read toolだけをちょうど1回使って `./worker-proof.txt` を読み、内容が `henji-worker-proof-20260904` なら、最終回答を `WORKER_PATH_OK` の1行だけにしてください。write、edit、bashは使わないでください。

### 受入条件、上限、停止

- 各turnはread tool exactly one、write/edit/bash/planner zero、final line exactly `WORKER_PATH_OK`。
- built-in/externalの両traceが同じbootstrap、protocol kinds、runtime/commit routeを示す。
- trace/evidenceはsession、instance correlation、Definition ref、generation、base revision、commandを
  readbackでき、ManifestはmaxSteps 8対4を説明する。
- committed表示はHost durable store成功時点（turnの唯一のcommit point）以後。Worker commit ackは
  Worker-local state前進用であり、ack delivery failureでもstateをuncommittedへ戻さず、
  「committedだが当該generation unavailable」としてsettleする。close/reopen/readback後も選択と
  revision bindingが保持される。
- provider-free compaction evidenceでは、Workerがcheckpointを決定してdata-only proposalを返し、Hostが
  base state/correlationを検証して既存checkpoint storeへinstallし、checkpoint ack成功後だけheld user turnを
  開始することを示す。validation/install/cancel/ack failureではheld turnとuser-turn provider requestを
  開始せず、install済みcheckpointはclose/reopenで利用できる。real-provider promptがthreshold未到達なら
  compaction未発生も証拠として記録する。
- agent tool-effect ceilingはread二回（各turn一回）。startup Definition/module readsはこのtool-effect
  ceilingとは別に記録する。
- retry、fallback、rerun、resubmit、additional turnはzero。plannerが起動、read以外のtoolが起動、
  expected totalを越えた場合は即停止し、証拠を保持してrerunしない。

request数の期待値はparent 2 per turn、child 0、合計4。絶対的なtheoretical product boundはbuilt-in
parent 8 + planner 8 = 16、external parent 4 + planner 8 = 12、combined 28である。これはprovider価格を
今固定する根拠ではない。

Human Gate直前に公式情報とinstalled profileを再確認する。

- exact model slug availability、input/output price、tool/SSE support
- current 65,536 completion requestとprompt/input bound
- 28 request conservative ceilingから導くUSD ceiling

計画段階ではUSDを発明しない。provider、credential、network、production execution、費用上限は、この
再確認結果を添えてuserが別途承認する。拒否、unexpected provider shape、credential error、tool effect
可能性があった場合もretry/fallbackをせず、raw provider payloadをcredential/Authorizationなしで保存し、
request、response、SSE、provider metadata、parser transition、runtime outcome、request countをreadbackする。

## 7. 検証と成果物

### 実装中

各sliceでは変更箇所のfocused test、必要なtype check、repository定義のformat/lint、`git diff --check`だけを
使う。`v0:test`と`v0:gate`を途中で繰り返さない。testは上記の具体的product behaviorまたは確認済みregression
へ一対一で対応させ、fixtureの都合でproduction interfaceを狭めない。

### review前後

Slice 1–6完了後、ownerは変更範囲とacceptance contractを照合する。reviewerにはdiff、現在段階、realistic
environment、対象外actor/failure mode、必要severity、通常30分の時間上限を渡す。findingは根拠、source-to-
impact経路、product correctness問題の三点が揃う場合だけ採用する。re-reviewは一回、変更箇所と既存findingの
解消だけを確認する。

stable candidateでownerが`v0:gate`を一回実行し、結果（check/fmt/lint/test、実行環境、commit候補、未検証risk）を
記録する。Human Gateはfull gateの代替ではなく、その後の別承認付きproduction proofである。

### 完了判定

Stages 1–3の完了には、capsule facts、built-in Worker turn、built-in/external common path、provider-free
  integrated product-path proof、automatic compactionのcheckpoint boundary proof、functional review、owner gate
  一回、さらに別承認されたreal-product Human Gateが必要である。Stage 4 replacement/crash-point proof、resident
  Agent、mailbox、schedule、routing、multi-host、self-revisionは完了と主張しない。

## 8. リスク、延期、見積り

### リスク

- Deno 2.9.4のmodule Worker、import map、digest query、relative import、stable permissionの実挙動が想定と
  異なる可能性。Stage 1の観測を設計入力とし、推測でloaderを狭めない。
- Worker-direct provider/tool I/Oのpermission、stream cleanup、`terminate`後のeffect outcome、structured
  cloneのcopy/memory cost。
- 現行synchronous loopからsemantic proposal/ackへcommit境界を切り出す際のevent順序とcancel競合。
- schema-v2の最小migration、v1 read/v2 write、external revision mismatchのreadback。
- planner child request budget、large answer、incremental event、effect evidenceの相関。

### 延期

Stage 4 generation replacement、durable multi-session AgentInstance、resident service、lazy activation、
supervision daemon、mailbox/schedule/remote routing、subprocess sandbox、general hardening、provenance/signature/
marketplace、transitive dependency hash、promotion/self-revision、new provider/model、dependency追加、UI redesign、
`_refs/*`変更、provider/credential/production実行、commit/push/tag/publish/releaseを延期する。

Worker-direct、Host RPC/capability、split、subprocessの恒久placement、exact wire/storage schema、effect
idempotency/exactly-once、retry algorithm、backpressure、composition lifetime（generation一度かturnごとか）は、
このproofで偶然に固定せず後続計画へ残す。ただしStages 1–3のsemantic相関、Host durability、effectとcommitの
分離は削らない。

### 見積り

| slice | person-days |
| --- | ---: |
| 1 capsule/protocol | 4–6 |
| 2 executable Definition/loader/ref | 6–9 |
| 3 Worker runtime/turn | 15–22 |
| 4 Host commit/schema-v2 | 8–12 |
| 5 TUI/CLI | 5–8 |
| 6 integrated provider-free proof | 5–7 |
| 7 review/gate/package | 2–4 |
| **合計** | **45–68** |

一人のwrite agentとreview待ちを含むcalendar見積りは11–17週間。Human Gateの予約、provider incident、
plan外product bugは含めない。

## 9. 実装開始Human Gate

計画review後、次の質問へ明示回答を得るまで実装を開始しない。

> レビュー済み計画 `docs/plans/agent-worker-foundation-proof-stages-1-3.md`（SHA-256: `<reviewed-plan-sha256>`）どおり、Stages 1–3のrepository実装、provider-free focused検証、機能限定read-only review、stable candidateに対するauthoritative `v0:gate`一回までを開始してよいですか。provider credential参照、network接続、installed production `henji`実行、実provider Human Gate、実state cleanup、commit/push/tag/publish/releaseはこの承認に含めません。
