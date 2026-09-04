# Agent Worker real-provider gate blocker corrections

## 1. 状態と認可境界

- 状態: 実装承認前の限定修正計画
- 基準点: commit `3e70b9f`（`feat: run agent definitions in Deno workers`）
- 正本: `AGENTS.md`、`docs/architecture/henji-host-agent-worker.md`、
  `docs/plans/agent-worker-foundation-proof-stages-1-3.md`、同`-results.md`、
  `.handoff/handoff.md`の`ISS-20260904-agent-worker-real-provider-gate-blockers`
- 現在状態: Stages 1–3のprovider-free実装、functional review、owner `v0:gate`は完了済み。
  real-provider Human Gateは未実施で、preflightで確認した3 blockerにより停止している。
- 対象:
  1. production launcherからrepository configを明示する
  2. Worker production modelを既存OpenRouter SSE経路へ接続する
  3. 実際のWorker turnのbootstrap、protocol、provider、Host commit、ack、settlementを
     credential-free artifactとして永続化し、read-only CLIで取得可能にする
- 実装は一体のimplementer、完了後の確認は一体のread-only functional reviewerが担当する。 並列write
  agentは使わない。

この計画はprovider request、credential read、installed production `henji`、production state、 git
historyの操作を認可しない。既存の`.handoff/handoff.md`差分、未追跡`_refs/*`、
`docs/plans/surface-roadmap.md`を保持する。

## 2. 必要なproduct動作と確認済みblocker

### A. external Definitionのproduction起動

repository外のdisposable workspaceからinstalled `henji`と同じlauncher chainを使い、
`@henji/agent`のpublic contractをimportするexternal Definitionを起動できること。built-inとexternalは
同じDeno 2.9.4 Worker bootstrap、module evaluation、runtime、protocol、Host commit経路を使う。

確認済み証拠:

- alias authorityは`deno.v0.json`である。
- installed wrapperはrepositoryの`session_launcher.sh`へ委譲する。
- 同launcherのsession有無両方の`deno run`は`--config`を渡していない。
- cwd `/tmp`からexact alias importはconfigなしで
  `Import "@henji/agent" not a dependency`となり、repository config明示時は成功した。
- 同じcaller cwd条件のfocused Worker testはconfigなしで失敗し、明示config付きで1/1成功した。
- installed outer wrapperはcurrent repository launcherへ委譲するため更新不要である。

### B. Worker productionのSSE

parent、planner、automatic compactionのproduction provider callが既存OpenRouter SSE parserを通り、
requestの`stream:true`、evidenceの`responseMode:'sse'`、ordered SSE frame、parser transition、 raw
response evidenceを保持すること。

確認済み証拠:

- `PRODUCTION_PROFILE.stream`は`false`で、既存non-Worker production runtimeは
  `responseMode:'sse'`を明示する。
- `createProductionPhysicalIo()`は`OpenRouterAgentModel`へresponse modeを渡さない。
- その結果、Worker production requestは`stream:false`、evidenceは`responseMode:'json'`となる。

### C. actual Worker executionのreadback

Hostにadmitされた各Worker turnについて、success、Worker failure、store failure、commit後のgeneration
unavailableを、workspace-partitioned artifactとしてreadbackできること。artifactはsession/turn、
instance/generation、Definition revision ref、Manifest、base/proposed/committed revision、turn
command、 protocol transition、provider evidence、Host store、commit ack、settlementを相関する。

確認済み証拠:

- instance correlation、generation、current correlation、ManifestはHostのprivate memoryにだけある。
- session schema-v2はDefinition refとstate
  revisionを保存するが、generation、Manifest、protocol、ackを 保存しない。
- provider evidenceはrequest/response/SSE/parser/model/tool/outcome/countを保存するが、Host
  store/ackを 所有できず、commit proposal前にWorkerでfinalizeされる。
- session listとprovider evidenceだけでは、actual runのcommon Worker routeを証明できない。

## 3. 最小設計

### 3.1 launcher config

production startupは次のまま維持する。

```text
installed henji → henji_machine_launcher.sh → session_launcher.sh
  → deno run tui_cli.ts → createWorkerTuiSession → WorkerCapsule
  → worker_bootstrap.ts → external Definition imports @henji/agent
```

`session_launcher.sh`の両`deno run`へ次を追加する。

```text
--config "$repo_root/deno.v0.json"
```

caller cwd、workspace authority、permissions、state root、Deno version、outer wrapperは変更しない。

### 3.2 production SSE

`createProductionPhysicalIo()`が`OpenRouterAgentModel`へ`responseMode:'sse'`を明示する。
`PRODUCTION_PROFILE.stream:false`はlegacy/default JSON semanticsとして変更せず、既存non-Worker
runtimeと 同じ明示selectionに合わせる。

actual production constructorをprovider-freeで確認するため、credential sourceとfetchだけを差し替える
小さなtest seamを同factoryに置いてよい。production defaultは現在のcredential fileとglobal
fetchのまま、 別model pathやfixture-only production implementationを作らない。

### 3.3 Host-owned execution artifact

provider evidenceとsession recordの責務を変えず、新しいadditiveな`WorkerExecutionArtifactV1`を使う。
Host settlement後に次を一度だけ確定する。

- `executionId`、created/settled time
- session ID、turn、agent
- instance correlation、Worker generation
- Definition revision refとdata-only Manifest
- accepted `turn` commandとcorrelation
- base/proposed/committed state revision
- ordered protocol trace: direction、top-level kind、semantic subtype、sequence、ack accepted
- provider evidence ID、durability、persistence error
- Host store result: `not_attempted | failed | committed`
- acknowledgement: `not_sent | rejected_sent | accepted_sent | delivery_failed`
- settlement: `uncommitted | committed | committed_generation_unavailable`
- outcome、turn/runtime provider request counts
- `effectCommitRelation: 'not_transactional'`
- `automaticReplay: false`

traceはprotocol payloadを重複保存しない。module pre-read/import、agent event、tool
observation、error stage、 checkpoint/commit proposalとackのsemantic kindだけを失わない。provider
request/response/SSE/parser/tool payloadはprovider evidence
IDで既存artifactへ結ぶ。credential、Authorization、credential sourceを入力可能な
fieldは作らず、それ以外の観測済み診断情報を一般的privacy理由でsanitizationしない。

lifecycle:

1. generationのstart→ready bootstrap traceをHost memoryに保持する。
2. `submit()` admissionでexecution IDとturn recorderを作り、bootstrap prefixを結ぶ。
3. Host send/receive pathでprotocol transitionを順に記録する。
4. provider evidenceとdiagnosticを既存storeへ保存し、そのIDと結果を結ぶ。
5. Host session storeの成否、commit ack delivery、Worker terminal/generation
   availabilityを記録する。
6. settlement確定後にartifactを一度保存する。

artifact write完了はartifact自身のdurability pointであり、Host session commit pointを変えない。
artifact persistence failureはoutcome
metadataへ記録するが、commit済みstateをrollbackせず再実行しない。 store成功後のack delivery
failureはexactに次を残す。

```text
storeResult = committed
acknowledgement = delivery_failed
settlement = committed_generation_unavailable
automaticReplay = false
```

保存先:

```text
<state-root>/<workspace-digest>/worker-executions/<execution-id>.json
```

retention、quota、delete、migration framework、cross-workspace
indexは追加しない。通常TUIへartifact本文や raw protocol JSONを表示しない。

### 3.4 read-only CLI

既存diagnostics dispatcherへ次を追加する。

```text
henji diagnostics executions list
henji diagnostics executions show --id <execution-id>
```

`list`はID、日時、session、turn、Definition kind、generation、settlement、provider evidence
IDを返し、 `show`は完全なartifactを返す。callerのphysical workspace
partitionだけを読み、network、run、credential permissionやdelete commandを追加しない。

## 4. 実装increment

### Increment 1 — launcher config

所有: `v0/agent/session_launcher.sh`、`tests/v0/agent_worker_foundation_test.ts`

- sessionあり/なし双方へabsolute repository configを渡す。
- repository外temporary cwd、isolated temporary state、exact external Definitionを使い、repository
  launcherと 同じargv/config chainでprovider request前のWorker readyまで到達して終了する。
- config明示でactual dynamic importが解決しない、cwd変更、permission拡張、installed wrapper変更、
  dependency追加が必要なら停止する。

### Increment 2 — Worker production SSE

所有:
`v0/agent/worker_physical_io.ts`、`tests/v0/provider_stream_compatibility_test.ts`、必要なactual
Worker assertionだけ`tests/v0/agent_worker_foundation_test.ts`

- production modelへ`responseMode:'sse'`を明示する。
- fake credential/fetch seamからactual request pathをprovider-freeで呼ぶ。
- encoded body `stream:true`、evidence `responseMode:'sse'`、scripted SSEのordered
  frame/parser/resultを確認する。
- provider/profile/model変更、新transport、credential値のtest/protocol/evidence流入が必要なら停止する。

### Increment 3 — artifact contract、store、CLI

所有:

- 新規`v0/agent/worker_execution_artifact.ts`
- 新規`v0/agent/worker_execution_artifact_store.ts`
- `v0/agent/failure_diagnostic_cli.ts`
- `v0/agent/failure_diagnostic_cli_launcher.sh`
- 必要な`v0/agent/contracts.ts`、`v0/agent/events.ts`
- `README.md`
- focused確認は`tests/v0/agent_worker_foundation_test.ts`

- schema-v1 type/validator/codec、fake/Deno store、workspace-local list/showを追加する。
- provider evidence IDを保持し、legacy diagnostics/evidence commandsを維持する。
- session schema migration、既存raw evidence削減、cleanup/quota、dependency追加が必要なら停止する。

### Increment 4 — Host/Worker lifecycle接続

所有: `v0/agent/worker_host.ts`、必要最小限の`worker_protocol.ts`、`contracts.ts`、`events.ts`、
`tests/v0/agent_worker_foundation_test.ts`

- Host recorder、generation bootstrap prefix、send/receive
  trace、Manifest/Definition/correlation/revisionを接続する。
- `turn_failed`、invalid proposal、store failure、commit success、ack delivery failure、Worker
  terminal failureの return pathを一つのsettlement helperへ収束させる。
- provider evidence結果を結び、artifact write failureをadditive outcome metadataで返す。
- session commit、effect、replay semanticsを変更しない。
- actual production module graph＋provider-free modelでbuilt-in/externalを実行し、exit後のCLI
  readback、 Manifest 8/4、common trace、provider evidence linkageを確認する。
- real Worker＋failing Host storeで`uncommitted`、ack send failureで
  `committed_generation_unavailable`、両方でno replay/non-transactional effectを確認する。
- commit point移動、commit済みrollback、WorkerへのHost object移送、fixture-only path、Stage
  4が必要なら停止する。

### Increment 5 — resultと後続gate package

所有: `docs/plans/agent-worker-real-provider-gate-corrections-results.md`、`.handoff/handoff.md`、
修正完了後に別承認対象として作るreal-provider Human Gate plan。

focused evidence、review、owner
gate、残る未確認事項を記録する。このincrementでもprovider、credential、 production
stateを操作しない。

## 5. verification、review、owner gate

| product動作                      | focused verification                                                     | 成果                                                  |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| 外部cwdのexternal Definition起動 | installed-equivalent launcher＋exact external Definition＋actual Worker  | config明示、cwd保持、common bootstrap                 |
| Worker production SSE            | actual production factory＋fake credential/fetch＋scripted SSE           | `stream:true`、SSE metadata/frame/parser              |
| actual execution readback        | built-in/external actual graph＋provider-free model＋Host store/ack＋CLI | Manifest 8/4、common trace、settlement区別、no replay |

test件数は完了条件にしない。実装中はfocused test、必要な`deno check`、repository
`fmt`/`lint`、`sh -n`、 `git diff --check`だけを使い、`v0:test`と`v0:gate`を反復しない。

Increment 1–4のfocused確認後、ownerがscopeを照合し、一体のread-only reviewerへ3
blocker、diff、現実の 実行環境、対象外、Blocker/P1/P2、30分上限を渡す。reviewerはfull
gateを実行しない。採用findingは同じ implementerが局所修正し、変更箇所と既存findingだけを一回narrow
re-reviewする。

product source変更後のstable candidateへownerがauthoritative
`v0:gate`を一回実行する。failure時はfocused
確認で原因を特定し、candidate変更の理由なしに再実行しない。offline gateはreal-provider Human Gateの
代替ではない。

完了条件:

- A/B/Cの3動作がactual provider-free production graphで成立する。
- session schema-v1/v2、provider evidence、既存CLI/flags、outer wrapperを維持する。
- store-not-committedとcommitted-generation-unavailableを正確に区別する。
- focused verification、functional review、owner gate一回を完了する。
- real providerはまだ呼ばれていない。

## 6. 対象外

- real-provider attempt、credential read、production `henji`、production state作成・cleanup
- installed wrapper更新
- Stage 4、resident Agent、mailbox/routing/schedule、daemon/supervision
- retry/replay/fallback/resubmit、provider/tool I/Oの恒久placement
- permission拡張、sandbox、external trust/provenance、cleanup/quota/retention、general migration
- new provider/model/dependency、TUI redesign、通常conversationへのartifact本文表示
- `_refs/*`、`docs/plans/surface-roadmap.md`、commit/push/tag/publish/release

## 7. 後続Human Gateのtask cost

正常系はfresh built-in 1 turn＋fresh external 1 turn、各read exactly one、planner zero、expected
requests 2＋2＝4である。retry、fallback、rerun、additional turnはzero。

| 実績                    | requests | reported tokens |   actual cost |
| ----------------------- | -------: | --------------: | ------------: |
| FR1                     |        6 |           4,242 | USD 0.0055785 |
| Gate 1 successful rerun |       16 |          28,524 |  USD 0.028308 |

4 requestsへの実測比例は次の範囲になる。

```text
0.0055785 × 4 / 6  = USD 0.003719
0.028308  × 4 / 16 = USD 0.007077
```

現時点のtask estimateは約`USD 0.004–0.01`とする。USD 0.01はexact prompt/bodyと生成量差の丸めで、
全requestが最大context/max-outputを使う仮定ではない。

修正後のprovider-free preflightでは、後続gateのexact prompt、built-in/external
Definition、production request encoder、scripted SSEを使い4 requestのbody bytes、model
slug、`max_completion_tokens`、順序を
記録する。providerへは接続せず、その結果と上記actual、実行直前の公式価格からestimateを更新する。

`built-in parent 8 + planner 8 + external parent 4 + planner 8 = 28`はproduct loopの絶対的な
stop/diagnostic boundだけで、task estimateや承認予算ではない。実gateはplanner開始、read以外のtool、
各turnの2 requests/read一回からの逸脱、retry/fallback/resubmit、unexpected provider/stream/parser
outcomeで 停止し、28まで続行しない。

monetary capはcurrent clientでprovider-side
enforcementできないため、この計画では提案しない。後続承認は exact turns/tool/expected 4
requests/逸脱時停止を実行制約とし、終了後にactual request count、reported usage、 actual
costを報告する。

## 8. 実装開始Human Gate

> レビュー済み計画 `docs/plans/agent-worker-real-provider-gate-corrections.md` （SHA-256:
> `<reviewed-plan-sha256>`）どおり、commit `3e70b9f`を基準に、production launcherのrepository
> config明示、Worker production SSE wiring、credential-free Worker execution artifactとread-only
> list/show、 対応するprovider-free focused検証、限定functional review、stable candidateへのowner
> authoritative `v0:gate`一回までを、一体のimplementerで開始してよいですか。provider
> request、credential read、 installed production `henji`、production state作成・cleanup、installed
> wrapper更新、Stage 4以降、
> dependency追加、`_refs/*`、無関係な既存差分、commit/push/tag/publish/releaseは含めません。
