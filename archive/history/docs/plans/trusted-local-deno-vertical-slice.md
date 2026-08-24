# Trusted-local Deno vertical slice 実装・検証計画

> Status: proposed at Human Gate 2
> Canonical input: `/tmp/planner-inputs/trusted-local-deno-vertical-slice.md` (concept revision 6)
> Scope: one trusted-local `task-planner` vertical slice; implementation is not authorized by this document

## 推奨計画とHuman Gate 2の前提

新しい`v0/` namespaceに、一つの短命Deno extension process、host-ownedな一回のmodel
generation、人間だけが変更できるrevision registryを実装する。旧`src/`、`plugins/`、`tests/`の
two-plugin spikeは停止済み証拠として変更せず、検証済みのprotocol、process、broker機構だけを
新scopeへ選択的に移植する。Spike 0/1も変更せずretainし、Spike 2以降はparkを維持する。

Extension管理は次の4操作を別commandとして持たせる。いずれも人間がexact digestを含むcommandを
明示的に実行した場合だけstateを変更する。

1. `extension install --source <dir>`: manifestとsourceをmanaged state directoryへcopyし、
   `id`、`version`、`revision`、content digestを記録する。installだけではactiveにしない。
2. `extension activate --id <id> --digest <sha256>`: activeが未設定の場合だけ、install済みのexact
   digestをactiveにする。
3. `extension switch --id <id> --digest <sha256>`: active設定済みの場合だけ、別のinstall済みexact
   digestへ切り替える。
4. `extension rollback --id <id> --digest <sha256>`: 人間が指定した既知のinstall済みexact digestへ
   戻す。失敗やmodel outputを契機に自動rollbackしない。

`run`、sourceの配置・変更、install、test、model response、download、update checkはactive stateを
変更できない。auto-discovery、default enable、hot reload、auto-update、自動promotionを作らない。
same-user malicious差替え、署名、immutable artifact、run直前digest再照合はv0〜betaの対象外とする。

### Human Gate 2で必須の判断

次を一括して承認するまで実装を開始しない。

1. 本計画と、旧資産を変更せず`v0/`へ必要最小限を移植する方針。
2. plan-delta前の初期provider profile。推奨はOpenRouter OpenAI互換
   `POST https://openrouter.ai/api/v1/chat/completions`、exact model
   `google/gemini-3.7-flash`、host env名`HENJI_OPENROUTER_API_KEY`である。2026-08-24の
   [OpenRouter公式model page](https://openrouter.ai/google/gemini-3.7-flash)ではinput
   `$0.375 / 1M tokens`、output`$1.875 / 1M tokens`を確認した。価格はcall直前にも再確認する。
3. plan-delta前のrouting policy。推奨はmodel fallbackなし、`provider.only: ["google-vertex"]`、
   `allow_fallbacks: false`、`require_parameters: true`、`max_price: {prompt: 0.375,
   completion: 1.875}`である。OpenRouterは通常、upstream provider error時にrequest filterが許す
   別providerへrouteするため、今回の一回観測ではそれを無効にする。Google Vertex内のexact regionまで
   固定するかはGate 2で選び、base slugを使う場合は全Vertex regionが候補になることを明記する。
4. generation defaults。plan-delta前のGate 2 baselineは`stream: false`、`temperature: 0`、`max_completion_tokens: 1024`、
   tool/model fallbackなしとする。deprecatedな`max_tokens`は使わない。serialized message contentは
   76 KiB以下とし、一回の最大概算費用を`$0.031104`、承認budgetを`$0.032`とする。
5. credentialはhostだけが上記envを読み、extension processへenvを一切継承せず、protocol、trace、
   error、resultへ値を出さない経路。
6. plan-delta前は本人taskによる実provider acceptance attemptを一件、最大`$0.032`で許可するか。外部通信と費用が
   発生し得る。実行時も別のauthorize command、attempt ID、budget、confirmation flagを要求し、
   provider requestはattemptごとに最大1、automatic retry 0とする。
7. 下記permissionとresource limitの初期値。
8. repository `AGENTS.md`は現在、real AI observation、provider/model選定、credential、provider callを
   scope外としている。Gate 2で2〜6を承認した場合、実装開始前にdefault agentがrevision 6 sliceに
   限ってscopeを整合する必要がある。plannerまたはimplementerが黙って上書きしない。

2〜6またはAGENTS整合が承認されない場合、fixture model adapterまでのlocal実装・検証に限定する。
その場合H-015と最低process境界は検証できるが、本人taskをmodelで完了するH-014は未検証であり、
vertical sliceをGOにしてはならない。

## 確認済みの現在状態

- `AGENTS.md`と`README.md`はrevision 6、trusted-local、人間明示管理、Spike 2 parkを現在scopeとしている。
- `.handoff/handoff.md`の次の一手は本計画一件を作成してHuman Gate 2で停止すること。
- Spike 0はGO、Spike 1 deterministic coreはGOとしてretain済み。v0の必須依存ではない。
- Spike 2はProposal cross-binding不足でNO-GO。Spike 3〜5とともにparkされている。
- 旧`src/`、`plugins/`、`tests/`は未commitの歴史的証拠であり、継続・変更・削除は禁止されている。
- 旧資産にはEnvelope v1、bounded JSONL、短命Deno subprocess、host request一回、timeout/output
  limit、static HTTP broker、Plan parser、redacted traceの実装とtestsがある。ただし旧two-plugin
  source-direct architecture全体はNO-GOであり、そのまま再開できない。
- Deno 2.9.4 binaryは
  `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`にread-only利用可能な実行fileとして存在する。
  shared VMへのglobal installは未承認である。
- `HENJI_OPENROUTER_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY`、
  `ANTHROPIC_API_KEY`はplanning時のguest environmentには存在しない。値は参照していない。
- `_refs/`の4 snapshotはMIT license、固定commit、nested `.git`なしのplanning専用資料である。
- 2026-08-24にDeno 2.9.4実helpと公式permission referenceを確認した。`--deny-import`、
  `--no-remote`、`--no-npm`は存在するが、local static import graphはread permissionなしでもload可能である。
- 同日、plan-delta前にOpenRouter公式model/routing pagesで`google/gemini-3.7-flash`、input `$0.375/M`、output
  `$1.875/M`、filterが許す場合のupstream provider failover、`allow_fallbacks`/`only`/`max_price`を確認した。

## 要件対応と観測可能な成果

| 正本要件 | 実装成果 | 直接検証・受入 |
|---|---|---|
| H-014: 本人taskを実用的なPlanへ変換 | 一つの`task-planner` revision、host-owned generation、strict Plan parse | fixture E2E後、本人taskで一回のacceptance call。result、extension identity、model profileを同じrun IDで確認 |
| H-015: human explicit management | install/activate/switch/rollbackを分離し、全mutationを管理commandだけへ集約 | 配置・install・run・failure・model outputでactive不変。人間がr1→r2→r1を明示操作して確認 |
| credentialをextensionへ渡さない | host-only env readとHTTP injection、child `clearEnv: true` | dummy secretのenv/payload/stdout/stderr/trace/error不在、extension env probe deny |
| 別processと最小authority | exact installed entrypointを短命Deno processで実行 | PID/process境界、permission probes、timeout/output超過時のkill/reap |
| permissionをGateで列挙 | host management、host run、extension runの3 profile | spawn argvとDeno permission testsが下記表と一致 |
| identityとrunの対応 | manifest identity、install digest、active record、run trace | CLI statusとtraceが同じid/version/revision/digestを表示 |
| v0境界を誤認させない | CLI help/README/acceptance packageにtrusted-local disclaimer | 「未信頼codeのsandboxではない」「same-user差替えは対象外」をread-back確認 |
| 自動化を黙示承認しない | management methodをextension protocol/model capabilityから除外 | extension/model入力からstate mutationへ到達するrouteが0 |

## Architecture

```text
human CLI command
  ├─ extension install/activate/switch/rollback
  │    └─ host-owned v0 state store (only mutation boundary)
  └─ run / acceptance run
       ├─ read exact active record
       ├─ spawn exact installed task-planner revision (Deno subprocess)
       │    ├─ plugin.execute(task, context, constraints)
       │    ├─ host.model.generate(messages) exactly once
       │    └─ structured Plan or structured failure
       ├─ host-owned model profile + credential + HTTP call
       └─ redacted run trace (identity, model condition, limits, outcome)
```

### Componentと予定file

既存停止assetへ変更を加えないため、実装は`v0/`と対応する`tests/v0/`へ隔離する。最終file名は責務を
保つ範囲で統合できるが、state mutation、extension process、model HTTP、provider codecを同一moduleに
混在させない。

| Component | 予定file / directory | 責務 |
|---|---|---|
| CLI | `v0/cli/main.ts` | 明示management command、run、status、safe output。commandの意図を勝手に推定しない |
| Contract | `v0/domain/{extension,plan,model,error}.ts`、`v0/protocol/{envelope,jsonl}.ts` | runtime validation、bounded one-call protocol、structured failure |
| Package/identity | `v0/extensions/{manifest,digest,source_guard,installer}.ts` | single-file manifest、source digest、no-import lexical guard、copy-on-install |
| State | `v0/state/{record,store,lock}.ts` | installed/active/action/attemptを含む単一schema v1 record、atomic replace、cross-process lock |
| Runner | `v0/runner/{process,session,run,limits,trace}.ts` | exact entrypoint、permission argv、one host call、timeout/output/concurrency、kill/reap |
| Model host | `v0/model/{profile,openrouter_codec,http_client}.ts` | exact profile、host-only secret、non-streaming one request、size/time/redaction |
| Bundled revisions | `v0/extensions-src/task-planner/{r1,r2}/` | manifest＋self-contained `main.ts`一件。import、network、env、run、FFI、read/writeなし |
| Tests | `tests/v0/{unit,process,integration,e2e,fixtures}/` | management invariant、protocol、permission、limits、dummy credential、fixture E2E |
| Evidence | `docs/spikes/trusted-local-deno-vertical-slice-results.md` | acceptance package。実装が承認された後だけ作成 |

Runtime stateはrepositoryへ置かない。defaultはXDG state conventionに従うuser-local
`henji-harness/v0`相当とし、testsとmanual rehearsalは必ず明示`--state-dir`のtemporary directoryを使う。
管理対象は次の論理layoutとする。

```text
state-dir/
  extensions/<id>/<digest>/manifest.json + main.ts
  state.json
  state.lock
  runs/<run-id>.json
```

各revisionはmanifestとself-containedな`main.ts`一件だけを持つ。Install digestはdomain tag、canonicalized
manifest metadata、`main.ts` bytesをSHA-256へ入れて算出する。manifestは`schemaVersion`、`id`、`version`、
`revision`、固定`entrypoint: "main.ts"`だけを持つ。symlink、追加file、absolute path、`..`を拒否する。

Management processは既に必要なsource readだけで、dependencyを使わないconservative lexical guardを実行する。
comment/string/templateのtoken境界を認識し、live codeの`import` token（static、dynamic、`import.meta`を含む）、
`export`、CommonJS `require`/`createRequire`、`Worker`、triple-slash `reference` directiveをrejectする。
false negativeを避けるため解析不能なlexical formもrejectし、scanner自身のために`run`、network、追加read権限を
与えない。これによりlocal/remote/npm/jsr importをすべてmanifest contract違反にする。

Installはsingle sourceをmanaged digest directoryへcopyするがactivateしない。installed set、active pointer、
bounded management actions、acceptance attempt authorization/statusは、別々のindex/logではなく一つの
`state.json` recordへ持つ。全management mutationとattempt reservation/updateは`state.lock`を開いて
`await lockFile.lock(true)`でexclusive advisory lockを取得し、lock保持中にstateを再読込して直列化する。
[Deno公式API](https://docs.deno.com/api/deno/~/Deno.FsFile.prototype.lock)のcontractは
`lock(exclusive?: boolean): Promise<void>`で、process exit時にもlockは解放される。

State commit順は次で固定する。

1. lock取得後に現`state.json`のschema、sequence、全invariantを検証する。
2. installだけは先にunique temporary package directoryへmanifest/sourceを書き、file sync後、同一filesystemの
   final digest directoryへrenameする。ここでcrashした未参照directoryはactive/install evidenceにならない。
3. transition後の完全なstate recordへ`sequence + 1`と同じaction/attempt evidenceを含め、同一directoryの
   unique `state.json.tmp.<operation-id>`を`createNew`で作り、全bytes write、file `sync()`、closeする。
4. temporary stateを`state.json`へrenameしてcommitする。rename前のfailure/crashでは旧record、rename後は
   新recordだけが正本であり、index/active/log間のpartial commitを作らない。
5. lockを解放する。次回mutationはlock下でorphan tempを正本として読まず、同じoperation IDのretryも
   action/sequenceでduplicate拒否する。install後state commit前のorphan packageは無視し、同digestの再install時に
   bytesを再検証してrecordへ採用できる。

`actions`は最大256件とし、上限で黙ってtruncateせずmanagement mutationを停止して別migration判断を求める。
State mutation methodはCLI composition rootからだけ呼び、extension sessionのhost method allowlistは
`host.model.generate`一件だけとする。

Run開始時はactive recordを一回snapshotし、そのrecordが指すentrypointをrun中固定する。run直前の全file
rehashや悪意ある差替え検知は行わない。run終了後もactiveは不変である。process内および別CLI processを含む
同時run上限は1とし、run専用lockにも同じDeno 2.9.4 `FsFile.lock(true)`を使う。management state lockとは
分離し、runはactive snapshot後にmanagement lockを保持し続けない。

### Extension module/permission contract

2026-08-24に実環境Deno 2.9.4 `deno help run`と
[Deno公式permission reference](https://docs.deno.com/runtime/reference/permissions/)を確認した。Denoは
entrypointから静的解析できるlocal import graphをread permissionなしでもloadでき、remote importにはdefaultで
許可されるhost群がある。このため`--allow-read=<revision-dir>`だけではsingle-file境界にならない。

Extensionのexact spawn flagsを次へ固定する（順序以外の差はplan-delta）。

```text
deno run --no-prompt --no-config --no-lock --cached-only --no-npm --no-remote
  --deny-read --deny-write --deny-net --deny-env --deny-sys --deny-run --deny-ffi --deny-import
  <exact-installed-main.ts>
```

`--no-remote`はcache済みremote/jsrもresolveさせず、`--no-npm`はglobal cacheやnode_modulesのnpm解決を
拒否し、`--deny-import`はDenoのdefault remote import allowlistもdenyする。local static importはDeno module
loaderのread exemptionがあるため、single-file lexical guardと直接negative testを必須にする。Extensionへreadを
含むallow flagを一つも渡さず、child `clearEnv: true`、`env: {}`、固定cwd/entrypointとする。

## Provider / model / credential boundary

Extensionはprovider、model ID、endpoint、credential、HTTP header、retryを指定できない。
`host.model.generate` payloadはprovider-neutral messagesだけを受け、hostがHuman Gate 2で固定した
`ModelProfile`を適用する。provider responseはhost内codecが`{text}`へ正規化し、extensionはtextだけを受ける。

推奨初期profileは、既存broker機構を最小移植できるOpenRouter OpenAI-compatible chat completionsである。
2026-08-24に公式model pageとprovider routing docsを確認し、plan-delta前のGate 2候補を次へ固定した。

- profile ID: `openrouter-google-gemini-3.7-flash-vertex-v0`
- model: `google/gemini-3.7-flash`
- origin/method/path: `POST https://openrouter.ai/api/v1/chat/completions`一件
- secret env名: `HENJI_OPENROUTER_API_KEY`一件
- generation: `stream: false`、temperatureは下記approved plan-deltaにより送信せず、`max_completion_tokens: 1024`、toolsなし、
  `models` fallback listなし。deprecatedな`max_tokens`は送らない
- routing: provider objectを送らず、OpenRouter標準routingとprovider failoverを許容する。exact modelは
  `google/gemini-3.7-flash`一件に固定し、model fallback listとapplication retryは持たない
- request count 1/attempt、automatic retry 0、redirect拒否、HTTP timeout 30秒
- serialized `messages[].content` 76 KiB、HTTP request 256 KiB、response 1 MiBのhard limit

OpenRouterは通常、upstream providerがerrorならrequest filter内の次providerへtransparentにfailoverする。
このplan-deltaではprovider objectを送らないため、OpenRouter標準のprovider routingとfailoverを許容する。
一方、単一`model`でmodel fallbackを禁止し、application retryも0のまま維持する。実providerが取得できる
場合は結果のprovider条件だけをevidenceへ記録し、credentialやrequest bodyは記録しない。

現行default endpointの最大価格`$0.75/M input`、`$3.75/M output`で、76 KiBをtoken数の保守的上界77,824、
completionを1,024 tokensとして計算すると、input `$0.058368` + output `$0.003840` = 一回最大概算`$0.062208`である。
plan-delta後のattempt budgetは切上げ`$0.064`とする。provider objectを送らないため`max_price`による
request filterは適用せず、default endpointの価格上限をlocal budgetで拘束する。これは税、credit purchase fee、
将来のbilling変更を含む請求保証ではないため、call直前に公式価格を再確認する。既存2 attemptsの上界
`$0.064`と新attempt上界`$0.064`を合わせた累積上界`$0.128`は、承認済み累積`$1.00`内である。

CredentialはCLI composition rootが一回読み、host HTTP clientへopaque stringとして渡す。state、profile file、
extension env、request envelope、trace、error causeへ保存しない。child processは`clearEnv: true`かつ`env: {}`。
Provider errorはstatusとstable error codeだけにsanitizeし、response bodyやheadersをそのまま返さない。

外部acceptance callは通常test suiteから分離する。人間はまず`acceptance authorize --attempt-id <new-id>
--max-requests 1 --max-usd 0.064`相当を明示し、単一atomic state recordへ`authorized` attemptをcommitする。
`acceptance run --attempt-id <id> --confirm-external-call`はlock下で未使用authorizationを`started`へ先行commit
してからnetworkへ出る。response/error後に同recordを`succeeded`/`failed`へ更新し、crashで`started`のままなら
`indeterminate`として同IDを再利用しない。transport failureでもautomatic retryしない。

再試行は、新しいattempt IDと追加`maxUsd` budgetを人間が新しいauthorize commandで明示承認した場合だけ
可能にする。新attemptは以前のstatus、累積authorized budget、request countと関連付け、同じID、残budgetの
暗黙流用、CLI内部retry、OpenRouter model fallbackを拒否する。

## Permission inventory（Gate 2承認候補）

| Authority | Host management command | Host run / acceptance | Extension subprocess |
|---|---|---|---|
| read | 明示source `main.ts`/manifest、state-dir | state-dir、固定host source/cache | allowなし。entrypoint loadだけ |
| write | state-dirだけ | `runs/`、run lock、atomic `state.json`のattempt statusだけ。installed/activeは変更不可 | なし |
| env | なし | exact secret名一件だけ。fixture runはなし | なし。`clearEnv: true` |
| net | なし | fixtureはlocalhostだけ。acceptanceはGate承認済みoriginだけ | なし |
| run | なし | exact Deno executable一件だけ | なし |
| FFI | なし | なし | なし |

Host Deno CLI自体の起動flagもcommand別に分ける。management commandへnet/env/runを与えず、source guardは
host内pure functionとして実行する。normal fixture runへcredential envや外部netを与えず、acceptanceだけに
exact envとoriginを追加する。Extensionは上記exact deny/no-resolution flagsで起動する。prompt、source、manifest
からpermission flag、cwd、entrypoint、Deno commandを組み立てない。

### Resource limits（Gate 2承認候補）

- concurrent run: 1
- extension session deadline: 45秒（HTTP 30秒を内包）
- nested host model call: exactly 1
- JSONL message: 256 KiB
- task: 8 KiB、context: 32 KiB、constraints: 最大32件・各1 KiB・合計32 KiB
- HTTP request: 256 KiB、response: 1 MiB
- extension stdout: 512 KiB、stderr: 256 KiB、total: 768 KiB
- Plan steps: 最大32件、step ID 64 bytes、description 2 KiB、Plan全体64 KiB
- provider request: 1/authorized attempt、automatic retry: 0、streaming: false、
  `max_completion_tokens: 1024`、message content 76 KiB、max `$0.064`/attempt

Limit超過はstable structured failureとしてprocessを停止・回収し、active stateを変更しない。stderr本文は
boundedにdrainするがdefault traceへ保存せず、byte countとfailure codeだけを残す。

## Existing assetのretain / discard / migration

| Asset | 判断 | 理由・扱い |
|---|---|---|
| `spike0/` | retain unchanged | accepted canonical content evidence。v0 dependencyにはしない |
| `spike1/` | retain unchanged | accepted deterministic revision evidence。実AI観測は再開しない |
| `spike2/`、`deno.spike2.*` | park unchanged | cross-binding NO-GO。修復・import・test再開をしない |
| 旧`src/protocol/*`、`src/domain/*` | evidenceからcontractを移植 | bounded JSONL/runtime validationは今回も適合。旧fileを変更/importせず`v0/`でscopeを縮小して再実装 |
| 旧`src/runner/plugin_session.ts`等 | evidenceからprocess機構を移植 | timeout、drain、kill/reapはretain価値あり。source-direct identity mapとtwo-plugin routingは捨てる |
| 旧`src/broker/*` | host-only HTTP policyを移植 | static registry、size/time/redactionは適合。exact profileはGate 2で再固定 |
| 旧`plugins/task-planner/*` | prompt/parserだけをreviewして新revisionへ移植 | one-shot taskは適合。旧pathをactive sourceとして使わない |
| 旧`plugins/model-adapter/*` | discard as extension | provider codecはhost内部へ移す。二つ目のextensionは不要 |
| 旧CLI/run composition | discard | active revision管理がなく、固定source pathを直接実行するためrevision 6に不適合 |
| 旧tests | historical evidenceとして保持 | 新architectureを旧test成功で代用せず`tests/v0/`で直接検証 |

既存runtime stateは正本化されていないためmigrationしない。旧plugin directoryをscan、import、install、active化
しない。v0 state schemaは`schemaVersion: 1`とし、未知versionはfail closedする。schema migrationが必要になったら
別計画とbackup/rollback契約を要求する。

## Reference snapshotの採否

| Reference | 採用する最小mechanism | 採用しないもの | 根拠 |
|---|---|---|---|
| Pi `a69bef7…`; `_refs/pi/packages/coding-agent/docs/extensions.md` | trusted sourceを利用者が明示pathで選ぶ考え方、extension codeは強いauthorityを持ち得るという明示 | in-process ExtensionAPI、trusted location auto-discovery、hot reload、package/provider ecosystem、agent/tool loop | 今回は別processかつ配置だけでactive不変が要件。Piの`-e`は比較材料だが、exact revision registryには不足 |
| Pi `a69bef7…`; `_refs/pi/packages/coding-agent/docs/custom-provider.md` | provider/profileをextension behaviorから分離して考える比較軸 | extensionによるprovider登録、credential resolution、dynamic model discovery | provider/model/credentialはhost-ownedでなければならずextensionへauthorityを渡せない |
| Zot `9b7bb6…`; `_refs/zot/packages/agent/extensions/manager.go`、`_refs/zot/docs/extensions.md` | manifest、copy-on-install、external subprocess、newline-delimited JSON、explicit install | enabled default、directory auto-discovery、project-over-global shadowing、long-lived registration/reload、multi-extension/tools | manifest＋stdioは最小境界に合うが、default enableとdiscoveryはH-015に反するため反転する |
| Deno Docs `eb8f78e…`; `_refs/deno-docs/examples/scripts/openai_tool_use.ts` | Denoからprovider clientをhost process内で構成する最小例として比較 | SDK依存、default env resolution、tool loop、extensionからのdirect client | sliceはtoolなし・一回generation。credentialとnetworkをhostに限定するためdirect移植しない |
| Deno Docs `eb8f78e…`; `_refs/deno-docs/examples/scripts/anthropic_tool_use.ts` | providerごとの差をhost codecに閉じ込める必要性の比較 | Anthropic SDK、tool loop、複数tool result | 初期profileは一つに固定しprovider abstractionの一般化をしない |

上流codeのcopyは予定しない。contractを独立実装し、`_refs/`をdependency/import/build対象に含めない。
将来copyが必要になった場合は、exact snippet、MIT notice、採用理由をplan-deltaとして先にreviewする。

## 順序付きincrement

### Increment 0: Gate整合とisolated skeleton

成果:

- default agentがHuman Gate 2の判断を記録し、必要ならAGENTSのprovider scopeをrevision 6 slice限定で整合する。
- `v0/`、`tests/v0/`、v0専用Deno config/taskを隔離し、旧sourceやSpikeをmodule graphへ入れない。
- Deno 2.9.4をglobal installせず、利用可能なexact binary pathを設定として注入する。

検証:

- module graph/preflightが`spike2/`、旧`plugins/`、`_refs/`をimportしない。
- `git diff`で旧assetが無変更。
- provider/profile未承認ならexternal adapter/call incrementがdisabledでH-014未検証と表示される。

### Increment 1: Contract、manifest、digest

成果:

- bounded task/model/Plan/error/Envelope contract。
- v0 single-file manifest parser、no-import lexical guard、deterministic install digest。
- r1/r2はそれぞれself-contained `main.ts`一件。両方とも一回の`host.model.generate`だけを要求する。

検証:

- valid roundtrip、unknown version/kind、missing/extra authority field、oversize、invalid Planをunit test。
- path traversal、absolute path、symlink、追加file、live `import`/`export`/`require`/`Worker`、triple-slash
  reference、解析不能token、local/remote/npm/jsr specifierを拒否。comment/string内の単語との境界も直接testする。
- 同じbytesは同digest、content/identity差はdigest差。checkout absolute pathはdigestへ入らない。

### Increment 2: Explicit install/activate/switch/rollback state machine

成果:

- four explicit commands、installed/active/actions/attemptsを一体化した単一state record、exclusive
  cross-process lock、write-sync-rename commit。
- inspect/list/statusでid/version/revision/digest/source originを人間が確認できる。

検証:

- installはactiveを変えない。activateは未設定時だけ、switchは別targetだけ、rollbackは人間指定の既知targetだけ成功。
- 未install/ambiguous digest、同target、invalid state、unknown schema、partial writeを拒否して旧activeを保持。
- source配置・変更、CLI status、run開始/成功/失敗、model output、restartでactive mutation 0。
- r1 install→activate→r2 install→switch→r1 rollbackの全actionにexplicit commandとdigestが残る。
- 二processのinstall/activate/switch/rollback競合をbarrier付きtestで起こし、sequenceが直列かつactionとactiveが
  同一transitionになることを確認。lock待ちprocess crashでも生存processが取得できることを確認。
- package temp write前後、package rename後、state temp write途中、file sync後、state rename前後へfaultを注入し、
  再起動後に旧または新のvalid `state.json`一件だけを読む。partial JSON、activeだけ先行、actionだけ欠落を許さない。
- orphan temp/packageを正本扱いせず、同operation ID replayとaction上限超過を拒否する。

### Increment 3: Short-lived extension processとlimits

成果:

- active snapshotからexact entrypointを短命Deno childとして起動。
- bounded JSONL、one nested host request、deadline、stdout/stderr drain、kill/reap、single-run lock。
- childはallow permissionなし。single entrypoint load以外のread、import、env/net/run/sys/FFI/writeをdenyする。

検証:

- normal response、malformed/partial/duplicate/unrelated frame、early/nonzero exit、closed stdin、hang、
  stdout/stderr/total overflow、host handler timeoutをprocess fixtureで直接test。
- exact spawn argvに`--no-lock --cached-only --no-npm --no-remote`と全`--deny-*`が揃うことを確認する。
- revision外local static import、literal/nonliteral dynamic local import、cache済み`https:`、`jsr:`、`npm:`を
  個別fixtureで起動拒否する。scannerを意図的にbypassするtest pathでもDeno flagsがremote/npm/jsrを拒否する。
- cache済みcaseはtest harnessだけがisolated `DENO_DIR`へ固定fixtureを事前配置し、その後networkを閉じてchildを
  起動する。product/management codeへcache準備、network、subprocess authorityを追加せず、product composition
  rootからtest-only DENO_DIR injectionへ到達不能であることを確認する。
- read、env、net、run、sys、FFI、write probeがdenyされる。spawn argv/cwd/entrypointへextension inputが入らない。
- failure後にchildとlockが残らずactive不変。concurrent second runは開始前にstable failure。

### Increment 4: Fixture model hostとoffline E2E

成果:

- provider-neutral host method、strict one-call router、fixture adapter。
- CLI task/context/constraints→active extension→structured Plan/failure→redacted traceのoffline E2E。

検証:

- r1/r2ともfixture responseでPlanを返し、call count 1。0回/2回、management method、provider field、
  arbitrary host methodを拒否。
- traceはrun ID、id/version/revision/digest、fixture profile、duration、byte count、result/failure digestを持つ。
- dummy credential文字列がinput/protocol/stdout/stderr/trace/error/resultに現れない。
- install/switch/rollback rehearsalをfixture runで行い、各runがその時点のexact active digestを示す。

### Increment 5: Exact provider profile（Gateで承認された場合だけ）

成果:

- host内static profile、provider codec、bounded HTTP client、host-only env injection。
- extensionはprovider/model/endpoint/credentialを一切受けず、model textまたはsanitized failureだけを受ける。

検証:

- localhost mockでexact origin/method/path/body、`google/gemini-3.7-flash`、`stream: false`、
  temperature absent、`max_completion_tokens: 1024`、provider objectなし、request count 1を確認。
- `max_tokens`、`models`、provider overrideがpayloadにないことを確認。OpenRouter標準routing/failoverを許容し、
  unknown profile、URL/method/path/header/model override、redirect、timeout、oversize、malformed/provider error、
  local budget超過を拒否する。
- dummy secretはAuthorization injection点以外へ出ず、child envはempty。
- external originを通常suiteで呼ばない。provider SDK dependencyは追加しない。

### Increment 6: Review、manual acceptance、acceptance package

成果:

- 全local gateをclean stateで2回、独立review、manual H-015 rehearsal。
- Gateで許可された場合だけ、一回の本人task external acceptance call。
- 結果文書がH-014/H-015、最低安全境界、deviation、残余risk、retain/discard判断を直接証拠へ対応付ける。

検証:

- external call前にlocal tests/reviewがGO、credential present/absentは値なしで確認、exact profileとcall budgetを表示。
- authorize→started→terminal attempt transitionを単一state recordで確認し、同ID再利用、自動retry、budgetなしの
  二回目callを拒否。crash/timeoutのindeterminate attemptにも新ID＋追加budgetの人間承認を要求する。
- userがPlanを実作業の出発点として使えるか、management操作負担が許容できるかを本人判断として記録。
- 実装成功だけでH-014/H-015をGOにしない。

## Test strategyと重複回避

- Pure unit: parser、digest、state transition、provider codec、limit arithmetic。I/O failureはここで重複させない。
- Filesystem integration: install copy、atomic state、lock、unknown schema。same-user malicious tamperやrun前rehashはtestしない。
- Process integration: JSONL/lifecycle/permission/output/timeout/reap。各failure modeを一つの代表fixtureで直接観測する。
- HTTP integration: localhost mockでhost credential/allowlist/limit/error sanitization。extension permission testと役割を重複させない。
- Offline E2E: CLI＋state＋r1/r2＋fixture model。人間明示invariantとtrace correlationを確認する。
- External acceptance: local suiteでは代替できないH-014だけを一回観測する。通常testやretryへ混ぜない。
- Manual acceptance: H-015の操作理解とH-014の実用性はuser判断であり、unit testで代替しない。

Repository gateの最終commandは実装時にv0専用taskへ固定する。少なくともformat check、type check、lint、
unit、filesystem/process/HTTP integration、offline E2E、permission/module graph preflight、`git diff --check`を含める。
外部acceptance commandはこのgate列に含めない。

## Manual acceptance script（実装後の操作契約）

実際のcommand spellingはIncrement 2でCLI helpと同時に固定するが、意味上の順序は変えない。

1. userがr1のmanifest/sourceをreviewし、inspectでid/version/revision/digestを確認する。
2. userがr1をinstallする。statusでactive未設定を確認する。
3. userがexact r1 digestを指定してactivateする。fixture runがr1 digestを表示する。
4. userがr2をreview・installする。installだけではr1 activeのままを確認する。
5. userがexact r2 digestを指定してswitchする。fixture runがr2 digestを表示する。
6. userがexact r1 digestを指定してrollbackする。fixture runがr1 digestへ戻ることを確認する。
7. local gateとreviewがGOで外部callが許可された場合、userが新しいattempt ID、max request 1、
   max `$0.064`をauthorizeする。
8. user自身の小task/constraints、authorized attempt ID、exact profile、external-call confirmationを指定し
   acceptance runを一回行う。failureでも同attempt IDを再利用しない。
9. userがPlan、extension identity、model/provider condition、attempt/budget、traceを対応付け、H-014の
   実用性とH-015の操作負担を判断する。

どのstepでもsource placement、install、fixture result、failureだけで次revisionへ切り替わってはならない。

## Security、compatibility、rollback

- `trusted-local`は人間が選んだ限定的信頼であり、Deno permissionを完全sandboxと説明しない。
- same-user/別local processによるmanaged source、state、dependency差替えはv0 threat model外。署名、immutable
  artifact、run直前digest、Admissionをこの計画へ追加しない。
- credential、task本文、model本文、Plan本文はdefault traceへ保存しない。必要なresultはCLIでuserへ返し、
  traceはhashとmetadataだけを保持する。
- v0 protocol/stateはschema/version不一致をfail closedし、旧spikeとの互換を約束しない。
- 実装rollbackは`v0/`とv0専用tasksの変更だけをrevertできる構造にする。旧assetへforward migrationしない。
- Runtime rollbackは人間の`extension rollback --digest`だけ。automatic failure policyと混同しない。
- Public preparationで必要なthreat model、Admission、signature、distributionはpark一覧に残し、v0 findingの
  local fixに見せかけて逆流させない。

## Deviation handlingと停止条件

### Previous approved plan-delta: Vertex temperature omission (2026-08-24)

初回acceptance attemptのOpenRouter HTTP 404を受け、利用者は当時のVertex限定 routingを維持したまま
request bodyから`temperature`指定だけを外すplan-deltaを承認した。2026-08-24に確認したOpenRouter
公式endpoint metadataでは`google-vertex/global`のstatusは0で、supported parametersに
`temperature`がなく、Google AI Studio側には同parameterがある。`require_parameters: true`は全parameterを
受け付けない候補を除外するため、Vertex限定requestが候補なしの404になり得るという整合である。

このdeltaで保持するものは、exact model、Vertex only、`allow_fallbacks: false`、
`require_parameters: true`、max price、`stream: false`、`max_completion_tokens: 1024`、toolsなし、
retry 0、request count 1/attempt、USD 0.032 budgetである。変更はprofile fieldとserialized bodyの
`temperature`削除だけで、provider変更、fallback許可、budget/retry変更、新attempt作成は行わない。

影響としてsampling temperatureはprovider/defaultへ委ねられ、temperature 0を送る場合よりsamplingの
determinismが弱くなる。一回のlocal mockでtemperature absentと他の固定field不変を直接確認し、初回failed
attemptは再利用しない。新attempt前にlocal gateを再実行し、追加callは利用者の別承認後だけ行う。

### Approved plan-delta: OpenRouter default routing (2026-08-24)

Vertex-onlyで2 attemptsが同じOpenRouter HTTP 404となったため、利用者はexact model
`google/gemini-3.7-flash`を維持し、provider object全体をrequestから外すplan-deltaを承認した。これにより
OpenRouter標準のprovider routingとprovider failoverを許容するが、single exact model、model fallbackなし、
application retry 0、request count 1/attemptは維持する。`temperature`は引き続き送信しない。

保持するprofileは、exact model、`stream: false`、`max_completion_tokens: 1024`、toolsなし、request count 1/attempt、
automatic retry 0である。削除するものは`provider.only`、`allow_fallbacks`、`require_parameters`、`max_price`を
含むprovider objectだけである。default endpointの最大価格はinput `$0.75/M`、output `$3.75/M`、76 KiB inputと
1,024 completionの最大概算は`$0.062208`、attempt budgetは`$0.064`とする。既存2 attempts上界`$0.064`に
新attempt上界`$0.064`を加えた累積上界`$0.128`は、利用者が承認した累積`$1.00`内である。

初回attempt `3DF08279-18A6-43DF-904B-730978BC0FDC`（run
`run-ead3f975-0a97-4626-8dde-66e19a7a7264`）と2回目attempt
`FB2D0628-B7E9-4B7F-AF42-92A9DD5D7980`（run
`run-5781ae82-8c4e-404c-b546-b4f453eef887`）はいずれもexactly 1 request後、同じHTTP 404をsanitized
`protocol_violation`としてfailedした。新attempt前にlocal gateを再実行し、OpenRouter account-wide Privacy
provider allowlistがGoogle Vertexを許可することを利用者が確認するまで、追加retry・attemptを行わない。

- `local-fix`: typo、境界を変えないvalidation、test fixtureの局所修正。直接testを追加して続行。
- `plan-delta`: Deno 2.9.4のlock API差、予定file統合、同等以下authorityのlocal代替。要件、success
  condition、external profile、human gateを変えず可逆的な場合だけ、read-only reviewer確認後に記録して続行。
- `concept-review`: extensionへnet/env/run/writeが必要、一回generationでは本人taskを成立できない、
  tool/filesystem/durable sessionが必要、人間明示command以外でactiveを変える必要がある、provider/modelを
  extensionが選ぶ必要がある、本人taskの価値を観測できない。この場合scopeを広げずDiscoveryへ返す。
- `park`: same-user tamper、signature、immutable artifact、Admission/Proposal、auto-update/promotion、
  multi-extension/tools/streaming/retry。findingとして記録しても実装しない。

Gate 2で選んだexact model/profileが実装・acceptance時に利用不能または契約不一致なら、別modelへ黙って
fallbackしない。availability、error、影響を示し、新しいhuman判断までexternal callを停止する。

## 完了条件

Implementation completionは次の全てを満たすこと。

- 旧asset、Spike 0〜2、`_refs/`を変更・実行せず、v0 isolated module graphを成立させた。
- install/activate/switch/rollbackが人間のexplicit commandだけで動き、暗黙active変更が0。
- exact id/version/revision/digestと各runのresult/failure/model conditionを対応付けられる。
- Extensionはself-contained single fileで、allow permissionなし。local/remote/npm/jsr importと
  read/env/net/run/sys/FFI/writeがscanner、exact flags、直接testで拒否される。
- Host credential経路、process/HTTP/resource limit、single concurrency、kill/reap、redacted traceが直接test済み。
- offline E2Eと全local gateが2回成功し、独立reviewに未解決Blocker/P1がない。
- provider profileを承認しない場合、H-014未検証と明示して停止する。
- provider profileを承認した場合、本人task external callはauthorized attemptあたり最大一回・`$0.064`で、
  追加attemptは新ID＋追加budgetの人間承認を要求し、userがH-014/H-015を別々に判断する。
- acceptance packageが直接証拠、test、manual観測、deviation、残余risk、retain/discard候補を正本要件へ対応付ける。

## 残るriskとユーザー判断

- same-user/local process差替え、supply chain、署名、run直前同一性は意図的に未保証。
- 一つのtask、一つのextension、一つのprovider profileの結果はgeneral plugin frameworkや自動改訂の証拠ではない。
- 一回のmodel outputは品質分散を測れない。H-014は「この一回が出発点として使えるか」だけを判定する。
- OpenRouter model/価格/routingは2026-08-24公式確認であり変動し得る。call直前に再確認し、
  default routingでGoogle Vertexを含む利用可能なproviderがない場合は停止する。credential availabilityは未確認。
- Deno 2.9.4 binaryはsibling repository由来のread-only pathであり、長期toolchain配置はこのslice後の別判断。
- AGENTSのreal AI scope衝突は、外部callを承認するなら実装開始前にdefault agentが解消する必要がある。

この計画はHuman Gate 2で停止する。実装、dependency導入、test、credential変更・参照、provider call、
reference実行、commit、他file変更はHuman Gate 2の判断まで行わない。
