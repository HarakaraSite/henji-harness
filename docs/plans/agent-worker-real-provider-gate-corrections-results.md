# Agent Worker real-provider gate blocker corrections — implementation result

## 状態

Reviewed plan `agent-worker-real-provider-gate-corrections.md`（SHA-256
`9f95cab1308216fb35a3a5683657819c7d8168cce41b3f83a6ce3c80b79602ac`）のprovider-free実装結果。
実装のfocused検証自体はprovider-freeである。なお、別途行ったexternal-cwd launcher probeで入力送信を
誤り、repository launcherのproduction modeにliteralな入力を渡してしまった。このprobeでは4件の HTTP
200 provider requestが実際に開始され、max_stepsで終了したため、受入証拠から除外する。追加の
provider/credential/production操作は停止した。credential値は表示・保存・commitしておらず、repository
またはinstalled production stateは変更していない。temporary workspace/stateはcleanupしていない。
初回functional reviewのP1 1件/P2 1件を局所修正し、single narrow re-reviewはGO、
Blocker/P1/P2 0。stable candidateへのowner authoritative `v0:gate`は一回で成功した。

## Incident record（受入証拠外）

- child argv:
  `/home/masat.guest/src/henji-harness/v0/agent/session_launcher.sh --definition
  external_definition.ts --no-session`。1回目はDeno未解決でstartup
  failure（exit 1）、2回目は一時 workspaceからfake PATH Denoを解決してproduction modeへ進んだ。
- stdinはcontrol-D byteではなくliteral `\004`（line submission newline付き）で、1件のturn taskとして
  送信された。正常なlauncher終了statusは記録されず、probe harnessで停止した。
- successful probe cwd/state: `/tmp/henji-worker-launcher-probe.HIj2Ku`、
  `/tmp/henji-worker-launcher-state.krAYRE`。failed probe cwd/stateはそれぞれ
  `/tmp/henji-worker-launcher-probe.clWY70`、`/tmp/henji-worker-launcher-state.bPOI2A`。
- execution ID `2d3c3c02-0cab-42dd-ade5-a2f8c235e703`、in-memory session ID
  `53147c25-3e60-452c-8b5c-4cb791cd33cd`、provider evidence ID
  `bc7efed6-cefe-4c4c-92f0-bf1abbe81a04`、diagnostic ID
  `0c30e894-8ad0-4b8e-9384-6720030761b2`を一時stateへ保存した。
- 4 requests / 4 HTTP 200、reported tokens 3,148（prompt 2,914、completion 234）、reported cost USD
  0.003063、outcome `max_steps`。一時stateのprovider evidence、link、execution artifact以外の
  session recordは`--no-session`のため作成されていない。

## 実装

- `session_launcher.sh`のsessionあり/なし両方の`deno run`へ、repository rootから解決した absolute
  `--config <repo>/deno.v0.json`を追加した。caller cwd、permissions、state root、outer
  wrapperは変更していない。
- `createProductionPhysicalIo()`は既存`OpenRouterAgentModel`へ`responseMode: 'sse'`を明示し、
  production defaultのcredential source/fetchを維持した。provider-free focused seamではその
  source/fetchだけを注入できる。
- Host-owned additive `WorkerExecutionArtifactV1` codec/storeを追加した。artifactはsession・
  provider-evidence schemaと別で、workspace digest配下の
  `worker-executions/<execution-id>.json`へHost settlement後一度だけ保存する。
- bootstrap、turn command、Worker/Host protocol semantic trace、Definition revision、Manifest、
  provider evidence linkage、Host store、commit acknowledgement、settlement、request count、
  non-transactional effect、no-replayをartifactへ相関した。artifact persistence failureは outcome
  metadataへadditiveに返し、canonical sessionをrollback/replayしない。
- 既存diagnostics dispatcher/launcherへread-only `executions list`と`executions show --id`を追加し、
  `README.md`へreadback契約を追記した。既存diagnostic/evidence commandとouter installed
  wrapperは維持した。

## focused evidence

実行済み（provider-free）:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:worker-foundation:test
```

結果: 28 passed, 0 failed（既存22件にexecution artifact/readback、artifact persistence failure、Host
store failure、turn-local sequence、external-cwd provider-free、fake-Deno launcher argv
captureの6件を追加）。

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet --config deno.v0.json agent:provider-stream-compatibility:test
```

結果: 10 passed, 0 failed。追加確認でactual production model constructor/request encoder/parserを
`createProductionPhysicalIo()`から呼び、`stream: true`、evidence `responseMode: 'sse'`、ordered SSE
frames、terminal parser transition、resultを観測した。

必要なsource check:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno check --config deno.v0.json v0/agent/*.ts tests/v0/agent_worker_foundation_test.ts tests/v0/provider_stream_compatibility_test.ts
sh -n v0/agent/session_launcher.sh
sh -n v0/agent/failure_diagnostic_cli_launcher.sh
git diff --check
```

上記check、focused source pathのfmt/lint、両launcherのshell syntax、`git diff --check`はすべて成功
した。

## Functional review

初回reviewはNO-GO（Blocker 0、P1 1、P2 1）。

- P1: Worker generation全体のtrace sequenceとturnごとのbootstrap prefixが組み合わさり、同一generationの
  turn 2以降はartifact-local連番validatorに失敗した。保存時に観測順を保ったturn-local連番へ正規化し、
  actual Worker Hostへ2回submitして両artifactのdurable list/showとcommit維持を確認した。
- P2: `executions list`がcomplete artifactを返していた。exact 8-field summaryへ投影し、`show`だけが完全
  artifactを返す契約へ修正した。

single narrow re-reviewはGO、Blocker/P1/P2 0。external-cwdについても、temporary Definitionがexact
`@henji/agent` importをactual provider-free Worker/Host commit経路で完了するtestと、fake Denoで実launcher
両branchのabsolute config、caller cwd、original argvを捕捉するtestの組合せを受入証拠として確認した。

## Owner authoritative gate

stable correction candidateに対して次を一回だけ実行した。

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

結果: 成功。`v0:check`、fmt 104 files、lint 101 files、current offline 38/38、provider stream
compatibility 10/10がgreen。gateはofflineであり、provider、credential、production launcher/stateへは
接触していない。

## 境界・pending

- planned real-provider Human Gate、installed production state、actual acceptance criteria remain
  unconfirmed; the excluded incident is the only real-provider observation in this work.
- Functional review: **GO**、Blocker/P1/P2 0。
- Owner authoritative `v0:gate`: stable candidateへ一回実行し**成功**。
- 実装計画のWhy/What/Whether、success condition、対象外、Human Gate条件、既存session/provider
  evidence 契約は変更していない。plan外のbug、依存追加、permission拡張、Stage 4、commit
  point移動は観測していない。
