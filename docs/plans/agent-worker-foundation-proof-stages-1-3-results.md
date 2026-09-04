# Agent Worker foundation proof — Stages 1–3 reviewed provider-free implementation result

## 位置付け

この文書は、承認済み計画 `agent-worker-foundation-proof-stages-1-3.md` の Slice 1–6と single
finding-closure passをprovider-free環境で実装し、機能reviewとowner gateを完了した結果である。
real-product Human Gateは未実施であり、この文書はその受入完了を宣言しない。計画本文、handoff、
既存のproduction stateをこの文書から更新しない。

確認日: 2026-09-04

## 実装範囲

### Slice 1–3: Worker実行経路

- `WorkerCapsule`、protocol、bootstrap、Definition loader、built-in/external Definitionの
  共通compositionを追加した。
- Worker内でlive runtime/turnを保持し、planner/context/cancel/effect/commit-proposalの semantic
  eventをWorkerとHostの境界へ渡す。
- Workerへ渡す値はstructured-clone可能なdata-only command/manifest/refとし、Hostのmodel、
  Registry、planner handler、instructions objectをWorker境界へ渡さない。
- built-in `default` と planner、およびworkspace-local external Definitionは同じbootstrap、
  runtime、effect、commit routeを使う。external Definitionの差分はplanで定めた
  `maxSteps: 4`に限定し、built-in defaultは`maxSteps: 8`を保持する。
- provider-free physical I/O seamをWorker側に置き、production modeのmodel constructionも Worker
  bootstrapから選択できるようにした。ただし、この結果取得中にprovider、credential、 installed
  production stateは実行していない。

### Slice 4: Host durabilityとsession compatibility

- Hostにcanonical commit proposal validationを追加した。session、generation、turn、base
  revision、Definition revision ref、transcript、next-turnを検証してから既存のdurable session
  storeへ書き込む。
- Host durable storeの成功を唯一のcommit pointとした。成功時点でHostは
  `committed=true`を投影できる。Workerへのcommit acknowledgementはWorker-local stateの
  前進と次command admissionのためだけに使う。
- acknowledgement delivery failureは、durable stateが既にcommit済みなら
  「committedだが当該generation unavailable」としてsettleする。uncommittedへ戻さず、同じ
  proposalを再送しない。
- 最小のsession schema-v2 recordにDefinition revision refとstate revisionを保存し、既存 schema-v1
  recordはreadできる。v1 sessionは次のWorker commitでv2へ移行するが、既存の legacy read/list
  APIの出力契約は保持した。
- schema-v2のreopenでは保存済みDefinition ref、workspace、agent、checkpointを再検証し、 mismatched
  external revisionを同じsessionとして採用しない。

### Slice 5–6: Surfaceと統合proof

- TUI/CLI/launcherに`--definition`を追加した。通常のproduction TUIはHost-owned surfaceと
  し、WorkerHostSessionを通じてbuilt-in/externalの両方を同じ経路で実行する。明示的な test runtime
  seam以外にsame-process production fallbackは残していない。
- CLIの既存session list/deleteとcontinueをv1/v2の両方に接続した。continueは保存済み Definition
  revision refを尊重し、close/reopen後も同じWorker routeを選ぶ。
- automatic compactionは境界越しに保持した。Workerがcheckpointを決定してdata-only
  proposalを送り、Hostがbase state/correlationを検証して既存checkpoint storeへinstallし、
  ack成功後だけheld user turnを開始する。validation/install/cancel/ack failureではheld
  turnを開始せず、既存契約に沿ってsettleする。install済みcheckpointはclose/reopen後に利用 できる。
- provider-free production-module-graph testで、persistent v2 commit/reopen、v1 readと v2
  upgrade、checkpoint install/reopen、external Definition、TUI factory、ack failure後の durable
  readbackとreplay不実行を確認した。
- Hostのqueue waitはturn/commit settlementの既定timeoutを持たず、provider-freeで5秒を超える delayed
  turnをcommitまで保持した。transport failureはgeneration unavailableとして終了し、 durable
  commit後のack delivery failureはcommittedとしてsettleして再送しない。
- `WorkerTuiSessionOptions.eventSink`を初回・navigation後のHostへ渡し、composition rootから
  presentation adapterへprogress、tool、normal final、committed `turn_end`を流した。
- Worker内のparent/planner/compaction共有request counter、diagnostic owner、credential-free provider
  evidenceを構築し、outcome metadata/evidenceをHostの既存storeへ永続化した。複数turnの
  read/plannerでsteps、tool、parent/planner/request countを確認した。compaction metadataを
  additiveなphaseとして保持し、checkpoint ack後のuser-turn countとruntime totalを分離した。
- accepted checkpoint installのauto-compaction noticeをHostで一度だけ保持・consumeし、adapterが
  一度だけ表示することを確認した。ack delivery failure時はnoticeを消去し、held turnを表示・開始
  しないことを確認した。
- pre-commitのeventSink delivery failureではgenerationをterminateしてuncommittedでsettleし、commit・
  effect continuation・replayを行わないことを確認した。durable commit後のterminal projection failure
  ではcommitted stateを維持した。

## focused evidence

実行したfocused testは次のとおりである。

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:worker-foundation:test
```

結果: 22 passed, 0 failed。追加7件は、5秒超delayed turn、TUI `eventSink`経路、parent/planner shared
accountingとcredential-free evidence、one-shot automatic-compaction notice、compactionと
user-turnのrequest counter/evidence phase境界、checkpoint ack failure時のnotice消去、pre/post-commit
event delivery failureを確認した。

## review・gate記録

- 初回functional reviewはNO-GO（Blocker 2件、P1 1件、P2 1件）だった。
- 初回reviewの4件をfirst closure passで修正した。
- narrow re-reviewではP1 2件、P2 1件が残り、そのうち1件は新規の具体的P1だった。
- 新規P1のsource-to-impactが確認されたため、owner承認のexceptional ultra-narrow closureを実施した。
  compaction/user-turn counter境界、ack failure時notice、pre/post-commit event
  deliveryを局所修正した。
- 最終functional reviewはGO（Blocker/P1/P2 0件）である。
- owner authoritative `v0:gate`は安定候補に対して正確に1回実行し、成功した。check green、fmt 102
  files、 lint 99 files、current offline 38/38、provider compatibility offline 9/9だった。
- Worker-focused taskはowner gateとは別に実行し、22/22 passedを確認した。上記focused
  commandがその記録である。

同じproduction module graphに対して、次のsource checkを実行し、成功した。

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno check --config deno.v0.json v0/agent/session_store.ts v0/agent/session_cli.ts v0/agent/tui_cli.ts v0/agent/worker_host.ts v0/agent/worker_protocol.ts v0/agent/worker_capsule.ts v0/agent/worker_bootstrap.ts v0/agent/worker_agent_api.ts v0/agent/worker_builtin_definition.ts v0/agent/worker_builtin_planner_definition.ts v0/agent/worker_runtime.ts v0/agent/worker_physical_io.ts v0/agent/provider_evidence.ts v0/agent/contracts.ts v0/agent/openrouter_model.ts v0/agent/worker_fixtures/*.ts tests/v0/agent_worker_foundation_test.ts
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno fmt --check --config deno.v0.json v0/agent/session_store.ts v0/agent/session_cli.ts v0/agent/tui_cli.ts v0/agent/worker_host.ts v0/agent/worker_protocol.ts v0/agent/worker_capsule.ts v0/agent/worker_bootstrap.ts v0/agent/worker_agent_api.ts v0/agent/worker_builtin_definition.ts v0/agent/worker_builtin_planner_definition.ts v0/agent/worker_runtime.ts v0/agent/worker_physical_io.ts v0/agent/provider_evidence.ts v0/agent/contracts.ts v0/agent/openrouter_model.ts v0/agent/worker_fixtures/*.ts tests/v0/agent_worker_foundation_test.ts
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno lint --config deno.v0.json v0/agent/session_store.ts v0/agent/session_cli.ts v0/agent/tui_cli.ts v0/agent/worker_host.ts v0/agent/worker_protocol.ts v0/agent/worker_capsule.ts v0/agent/worker_bootstrap.ts v0/agent/worker_agent_api.ts v0/agent/worker_builtin_definition.ts v0/agent/worker_builtin_planner_definition.ts v0/agent/worker_runtime.ts v0/agent/worker_physical_io.ts v0/agent/provider_evidence.ts v0/agent/contracts.ts v0/agent/openrouter_model.ts v0/agent/worker_fixtures/*.ts tests/v0/agent_worker_foundation_test.ts
sh -n v0/agent/session_launcher.sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
git diff --check
git diff --no-index --check /dev/null <each new text file>
```

上記のfocused check、repository-config format、lint、shell syntax、tracked/untracked diff checkは
すべて成功した。`v0:fmt`は102 files checkedで成功した。 testの一時session
rootは`/tmp`配下だけを使い、provider requestは発生させていない。

## 境界と未確認事項

- 実provider response、credential、network、installed production `henji`、persistent production
  state、real-TTYのreal-product Human Gateは未確認である。Human Gateは、公式のmodel/pricing
  情報とinstalled profileを再確認し、別途承認を得た後にだけ実施する。
- final functional reviewはGOでBlocker/P1/P2 0件、owner authoritative `v0:gate`は1回成功済みである。
  ただし、これらはreal-provider Human Gateの代替ではない。
- actual production permission profileでのWorker module loading、provider stream、tool effect、
  cost/accounting、Human Gateのreadbackはこのprovider-free結果から推論していない。
- Stage 4 generation replacement、resident Agent、mailbox、schedule、routing、multi-host、
  self-revision、durable replacement、new dependency、general hardeningは実装範囲外である。
- failure契約のうち、実provider由来の未観測variantや、production process crash後の回復は未確認
  として残す。未観測variantをfixtureで仕様化していない。

## 変更・計画差分

承認済み計画のWhy、What、Whether、success condition、対象外、Human Gate条件を変更していない。 Slice
4–6の実装詳細として、v2 codec、Host session adapter、TUI/CLIのdefinition flag、 provider-free
focused proofを追加した。Stage 4 durable replacement等の後続設計は追加していない。 計画外product
bug、停止条件、外部契約変更、依存追加は観測していない。

この文書はreview済みprovider-free実装結果であり、real-product Human
Gateの受入完了を宣言するものではない。 次の判断は、公式model/pricing再確認と別承認を経たreal-product
Human Gateで行う。
