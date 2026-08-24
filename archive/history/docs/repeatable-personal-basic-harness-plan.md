# Repeatable personal basic Harness 実装・検証計画

> Status: proposed at Human Gate 2  
> Canonical input: `/tmp/planner-inputs/henji-repeatable-personal-basic-harness.md`  
> Canonical input SHA256: `844729f283d3748eacd04c406929af7ff25ce9bdf7d0d112e12696b91fcc302a`  
> Concept revision: 8 / Hypothesis: H-016

## 推奨計画と前提

既存trusted-local v0を削除・再構築せず、`v0/cli/main.ts`へ次の通常commandを追加する。

```text
basic run --task TEXT [--context TEXT] [--constraints JSON] --confirm-external-call
```

この一commandを一requestの開始authorityとし、`acceptance authorize`、`--attempt-id`、
`--max-usd`、`--state-dir`、active extensionを要求しない。host内で有限inputを検証し、
current固定OpenRouter modelへ一度だけrequestし、raw assistant textをpassive dataとして最小metadataと
ともにterminalへ返して終了する。次taskは別processの同commandで開始し、前runのstateを読まず、作らず、
復旧しない。

既存の`run`、`acceptance authorize/run`、extension管理、state、traceは互換性のため残すが、
basic経路から呼ばない。課金管理を別名で作らず、provider生成上限は既存
`max_completion_tokens: 1024`だけをrequest量の境界として再利用する。

| 境界 | basic経路の上限 | 超過時 |
| --- | ---: | --- |
| task | UTF-8 8 KiB | request前のbounded failure、request count 0 |
| optional context | UTF-8 32 KiB | request前のbounded failure、request count 0 |
| constraints | 最大32件、各UTF-8 1 KiB | request前のbounded failure、request count 0 |
| serialized model messages | 76 KiB | request前のbounded failure、request count 0 |
| serialized provider request | 256 KiB | request前のbounded failure、request count 0 |
| provider生成量 | 1024 completion tokens | 一request内で終了 |
| provider response body | 1 MiB | bodyをcancelして終了 |
| request開始からbody read完了 | 30秒 | abortしてsanitized failure |

`--confirm-external-call`は同じcommand内の確認であり、別commandやpersistent authorizationではない。
inputはJavaScript文字数でなく`TextEncoder`のbyte数で判定する。小さく可逆的なfield配置は実装者が
調整できるが、command名、上限、state非依存、one-request semantics、観測fieldはGate 2の契約とする。

## Concept review request

なし。current codeには固定送信先、host-only credential injection、一fetch、retry 0、有限request/response/time、
raw response readbackがあり、Revision 8の安全境界を緩めずbasic経路を構成できる。

ただしrepositoryの`AGENTS.md`とREADME/HandoffはRevision 7をcurrent scopeとしており、配送済みRevision 8を
未反映である。これはconcept衝突ではなくrepository scope同期の未実施である。Gate 2で本計画を承認する場合、
source変更前にRev. 8の許可fileと停止条件へrepository指示を整合することを同じ判断に含める。
整合が承認されない場合は実装を開始しない。

## 確認済みの現在状態

- `v0/cli/main.ts`の実provider経路はactive extension/stateに加え、事前のpersistent attemptと
  `maxUsd` authorizationを要求する。これがRevision 8の通常loopとの差分である。
- `v0/model.ts`はhostだけで`HENJI_OPENROUTER_API_KEY`を読み、固定origin/pathへ
  `redirect: 'error'`で送る。CLIからendpoint、model、fallbackを指定するinterfaceはない。
- current requestはfixed model、`stream: false`、生成1024 tokens、retry 0、76 KiB messages、
  256 KiB request、1 MiB response、30秒deadlineを持つ。
- `v0/runner.ts`はextension経由のhost model callをexactly oneへ制限するが、basic経路で使うと
  extension/stateを通常前提から外せない。basicはrunner/childを迂回しhostから一回だけmodel関数を呼ぶ。
- Revision 7でassistant textはparse前に`responseText`へ保持され、parse failureでもterminalへ出る。
  本文はstate/traceへ保存されない。
- result文書の直近記録はDeno 2.9.4のv0 gate 24 tests、check/fmt/lint成功である。本計画ではtest未実行。
- worktreeには既存未commit変更がある。実装・rollbackとも対象差分だけを扱い、reset、checkout、
  他sliceの削除を行わない。

## Pinned reference evidenceと採否

`_refs/README.md`に従い、次のsnapshotはread-only planning evidenceとしてだけ確認した。いずれもMIT
licenseで、Henjiのproduct source、dependency、実装contractではない。sourceのcopyは不要であり、
workerは下記exact pathの示したmechanismだけを比較する。snapshotをbuild、実行、変更、refreshしない。

### Pi: request seamは採用し、agent/tool/extension loopは採用しない

**Evidence**

- Pinned commit: `a69bef789bc95abf0acee16f7b4660b70b650bb9`
- License: `_refs/pi/LICENSE`
- `_refs/pi/packages/agent/src/agent-loop.ts`は、provider境界を注入可能な`streamFunction`へ集約する一方、
  `runLoop`の内外loopがtool calls、steering、follow-upを処理し、tool resultをcontextへ追加して次の
  assistant requestへ進める。
- `_refs/pi/packages/agent/src/agent.ts`はtranscript、session ID、tool state、queue、retry関連optionを持つ
  stateful wrapperである。
- `_refs/pi/packages/coding-agent/src/core/extensions/loader.ts`はTypeScript extensionをhost processへ
  loadし、tool/command/provider registration等のaction surfaceを与える。
- `_refs/pi/packages/coding-agent/examples/sdk/06-extensions.ts`はstandard locationからextensionを発見し、
  agent event interceptionとcustom tool registrationを行う利用例である。

**Adopt**

- model/provider callをhost-ownedな一つの注入可能関数へ集約し、CLI orchestrationと分ける形だけを採用する。
  これはIncrement 1のbasic wrapperとIncrement 2の狭いtest seamへ反映する。
- model responseを受け取る境界と、terminalへ出すobservation組立てを分け、responseを先に保持する。

**Do not adopt**

- `runLoop`、streaming event machinery、message queue、follow-up、retry、tool execution、session/transcript、
  provider abstractionを導入しない。
- Pi extension loader、auto-discovery、in-process third-party module、tool/command/provider registrationを
  basic pathへ接続しない。

**Concrete plan impact / worker exact paths**

- workerがPiで読むのは
  `_refs/pi/packages/agent/src/agent-loop.ts`の`runLoop`と`streamAssistantResponse`、
  および`_refs/pi/packages/coding-agent/src/core/extensions/loader.ts`のruntime/action surfaceだけでよい。
- `v0/model.ts`へ一request関数を局所化するが、Piの`Agent` classやevent typesは模倣しない。
- `v0/cli/main.ts`のbasic handlerが二回目のmodel callを起こすloop/queue/tool branchを持たないことを
  reviewとtestで確認する。

### Zot: single-shot CLIの外形だけ採用し、session/retry/tool/subprocess extensionは採用しない

**Evidence**

- Pinned commit: `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`
- License: `_refs/zot/LICENSE`
- `_refs/zot/packages/agent/cli.go`の`runPrintMode`は一commandのpromptを読み、elapsed timeを測り、
  stdoutへresponseを返す軽量なnon-interactive外形を持つ。
- 同fileの`setupNonInteractiveExtensions`は`args.Exts`を`LoadExplicit`で先に読み、
  `args.NoExt`時だけinstalled extension discoveryを省く。explicit path選択はあるが、defaultでは
  enabled installed extensionもdiscoverする。
- 同じ`runPrintMode`はextension discovery、session open/create、transcript writeを行うため、
  current basic pathのstate非依存contractとは一致しない。
- `_refs/zot/packages/core/agent.go`の`runLoop`はtool use後に継続し、queued messagesを次requestへ入れ、
  transient provider errorを`canRetryError`でapplication retryする。
- `_refs/zot/packages/agent/extensions/manager.go`はmanifestをdiscoverし、enabled extensionをsubprocessとして
  spawnし、stdin/stdout newline-delimited JSONとhello handshakeで接続する。extensionはprocess分離されるが、
  tool/command/intercept surfaceとlifetime管理を追加する。

**Adopt**

- 一commandの明示prompt、stdoutのpassive response、elapsed metadata、process completionという外形だけを
  採用する。
- hostと任意extensionの境界を混ぜないという設計上の分離を採用し、basic pathにはextension manager自体を
  作らない。

**Do not adopt**

- session open/create、transcript persistence、automatic extension discovery、subprocess handshake、
  registered tools/intercepts、queued message、tool-result continuation、application retryを採用しない。
- basic commandへ`--ext`/`--no-ext`を追加しない。extension managerを生成しないこと自体を
  current sliceの明示的な非接続とする。
- Zotのfail-soft multi-extension管理はcurrent scopeのextension frameworkを再導入するため採用しない。
  subprocessであることだけをsecurity boundaryとも主張しない。

**Concrete plan impact / worker exact paths**

- workerがZotで読むのは`_refs/zot/packages/agent/cli.go`の`runPrintMode`、
  `setupNonInteractiveExtensions`、
  `_refs/zot/packages/core/agent.go`の`runLoop`/`canRetryError`、
  `_refs/zot/packages/agent/extensions/manager.go`の`LoadExplicit`/`Discover`/`loadOne`/`spawn`だけでよい。
- `v0/cli/main.ts`のbasic handlerはZotのsingle-shot CLI外形に対応させるが、state/session/extension
  setupを呼ばない。failure testは、Zotと異なりretry count 0でprocessが終了することを直接確認する。
- current `v0/runner.ts`の既存subprocess extension境界はlegacy pathに保持し、basic implementation fileに
  含めない。

### Deno公式例: concrete requestの小ささは採用し、tool-use while loopは採用しない

**Evidence**

- Pinned commit: `eb8f78e90dbc72f3b3ab7dcd85609622379b5bca`
- License: `_refs/deno-docs/LICENSE`
- `_refs/deno-docs/examples/scripts/openai_tool_use.ts`はtop-level inputからrequestする最小Deno例だが、
  `while (true)`でtool callを実行し、tool resultをmessagesへ追加してproviderへ再投入する。生成上限も
  この例では明示されない。
- `_refs/deno-docs/examples/scripts/anthropic_tool_use.ts`も同じtool-result loopを持つ一方、
  requestに`max_tokens: 1024`を明示する。
- 両例ともnpm SDKとprovider固有clientを導入する例で、current Henjiのbounded direct HTTP実装を
  置き換える根拠ではない。

**Adopt**

- inputからhost-owned request objectを一箇所で構築し、provider生成量をrequest parameterで明示する考え方を
  採用する。具体値はcurrent evidenceと一致する1024のままとする。

**Do not adopt**

- tools配列、tool dispatch、`while (true)`、assistant/tool resultのmessagesへの再投入、SDK dependency、
  streaming、provider変更を採用しない。

**Concrete plan impact / worker exact paths**

- workerがDeno referenceで読むのは上記二fileのtop-level requestと`while (true)` blockだけでよい。
- `v0/model.ts`はcurrent direct fetch、fixed OpenRouter endpoint/model、`max_completion_tokens: 1024`
  を維持する。`deno.json`/`deno.lock`へOpenAI/Anthropic SDKを追加しない。
- local testはserialized provider requestにtool declaration/tool choiceがなく、二回目のfetchがないことを
  assertする。

### Reference比較から確定した実装方向

三referenceともfull agent価値は複数turn、tool、sessionまたはextension integrationから得ているが、
それらはH-016の検証条件と逆向きである。よって初回計画のdirect host basic pathを維持し、参照からは
「host-owned request seam」「single-shot CLI外形」「request parameterによる生成上限」だけを採用する。
新file、dependency、provider abstraction、agent loop、extension frameworkを追加する計画変更はない。

## Plan-delta

Revision 8は、Revision 7でacceptance専用だったprovider経路に、attempt/budget/extension stateなしの
通常commandを追加する。現行Gate 2範囲外なので`plan-delta`であり、本書のHuman Gate 2承認が新しい
implementation authorityになる。Why・What・Whetherの変更はない。

## Increment 0: repository scopeをRevision 8へ同期

**成果と対象**

- Human Gate 2承認後、source変更前に`AGENTS.md`をRev. 8、本計画、許可file、external call禁止、
  次gateの停止条件へ更新する。
- `README.md`はbasic commandが実装完了するまではplannedとし、legacy v0を削除済みとは書かない。
- `.handoff/handoff.md`はlocal gate完了など再開状態が変わった時だけRecordと短いcheckpointを更新する。

**依存関係と検証**

Gate 2の明示承認に依存する。正本input、本計画、AGENTSのrevision、許可file、未承認操作が一致することを
readbackし、source変更前gateとする。scope矛盾が残れば実装を止める。

## Increment 1: budget非依存のcurrent provider primitiveを分離

**成果**

`v0/model.ts`で既存OpenRouter transport/body codecをprivate実装として共有し、次を分ける。

1. legacy acceptance entryは従来どおり`validateProfileBudget`を通す。
2. basic entryはprice、`maxUsd`、attemptを受け取らず、固定endpoint/model、生成上限、credential、
   redirect禁止、request/response/time上限だけを適用する。

basic entryは一呼出しにつきfetchを最大一回だけ実行し、retry、fallback、continuationを持たない。
credentialはhost envまたはlocal testのdummy injectionからだけ得てAuthorization headerへ付加し、
messages、return value、Failureへ入れない。productionではendpoint/model/credential値をCLI/taskから
上書きできない。

**対象**

- `v0/model.ts`: shared current-provider request、legacy budget wrapper、basic wrapper。
- `tests/v0/v0_test.ts`: local HTTP/fetch-spyによる直接test。

**検証**

- valid requestはfetch exactly 1、fixed URL/body、`stream: false`、completion 1024で、
  provider field、fallback list、temperature、tools/tool choiceがない。
- redirect、transport/non-2xx、invalid response、overflow、body stallはretryせずsanitized failure。
  shared primitiveの既存testと同じfailure modeは重複追加しない。
- dummy credentialはserver側Authorization header以外のbody、return、serialized errorへ現れない。
- legacy budget/attempt testsは不変。

## Increment 2: state非依存の`basic run`を追加

**成果**

`v0/cli/main.ts`のbasic handlerは次の順にだけ動く。

```text
parse command
  -> validate byte limits and same-command confirmation
  -> build host-owned fixed messages from task/context/constraints
  -> call basic model entry exactly once
  -> optional Plan parse as supplemental observation
  -> print passive response + metadata
  -> exit
```

messagesはcurrent trusted-local task-planner r2と同じhost-owned system instructionと、
`{task, context, constraints}`のJSON user contentを使う。task/model outputからsystem instruction、
endpoint、model、credential、tool authorityを変更するprotocolは作らない。

成功terminal objectは少なくとも`responseText`、`parse`、`requestCount: 1`、
`durationMs`、`outcome: {ok: true}`を持つ。`parse`はsuccess valueまたはsanitized errorとし、
non-Plan textでもraw取得は成功なのでexit 0とする。parse failureからrequest、repair、continuationを
起動しない。

provider/transport failureはresponseがなければ`responseText`を出さず、sanitized error、実際の
request count（fetch前0、fetch開始後1）、duration、failure outcomeを一objectへ出してexit 1とする。
input/confirmation/credential preflight failureもcount 0で終了する。

basic handlerは`readState`、`activeExtension`、`runExtension`、`saveTrace`、attempt API、
filesystem writeを呼ばない。responseはterminal serializationだけへ渡し、state/traceへ保存せず、
tool、shell、filesystem、process、external writeをdispatchしない。

**対象**

- `v0/cli/main.ts`: help、validation、message assembly、basic execution/readback。
- `tests/v0/v0_test.ts`: CLI-level direct tests。dependency injection seamはmodel/fetch置換だけに限定し、
  provider abstractionやextension interfaceにしない。

**直接test**

1. state directoryなしのvalid taskでmodel/fetch 1、exact messages、raw response、parse success、
   metadata、exit 0、temporary state非作成。
2. 独立した二taskを別handler invocationで実行し、各run count 1、前run ID/response/approval/state入力なし。
3. exact non-Plan responseでraw text、parse error、count 1、success outcome、exit 0、tool/write/次call 0。
4. task/context/constraintsの代表limit超過でmodel/fetch 0。同型caseの網羅matrixは作らない。
5. provider failureでsanitized error、実count、duration、failure outcome、exit 1を確認後、
   recovery stateなしの別commandが成功。
6. basic handlerのtest doubleがtool call相当のdataを返してもdispatchせずpassive textとして扱い、
   provider failureでもapplication retryが0であることを確認する。

## Increment 3: local gate、限定review、acceptance package

**成果と対象**

- `docs/repeatable-personal-basic-harness-results.md`へrequirements-to-evidence形式でlocal結果を記録する。
  response本文、credential/header、task全文は書かず、test、gate、request count、failure classification、
  real acceptance未実施だけを残す。
- `README.md`を実装済みcommandとlegacy経路の区別へ更新する。
- `.handoff/handoff.md`はlocal gate完了状態と次gateへ更新する。
- source/testはIncrement 1-2だけ。`v0/runner.ts`、`v0/state.ts`、extension source、
  dependency、lockfileは変更しない。

credential/request boundaryを変えるため、local gate後のdiffだけを10分以内でread-only reviewする。
軸はcredential source-to-destination、fixed endpoint/redirect、exactly-one fetch、state/write非依存、
passive responseである。新しいBlocker/P1の直接経路がなければ拡張しない。

**Local verification**

credentialを設定せずOpenRouterへ接続せず、実装承認後に実行する。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

loopback server/fetch spyとdummy credentialだけを使う。gate成功に加え、direct testsがone-request、
limits、redaction、repeatability、parse independence、state/write非依存を観測してlocal完了とする。

## 実provider acceptance（別Human Gateのみ）

Human Gate 2はcredential参照、provider call、real taskを承認しない。implementation、local gate、review、
package完了後、本人が別Human Gateで最大3個のside-effect-free taskを承認する。各taskは別の
`basic run` commandで一度だけ実行し、同commandの`--confirm-external-call`がauthorityになる。
persistent attempt ID、budget state、再承認commandは作らない。

本人は各runのcount 1、retry/fallback/continuation 0、response/parse/duration/outcome、credential不在、
副作用0、前run復旧なしの次task開始を確認する。3 task以内の操作負担とresponse価値からH-016を
GO/NO-GO/保留判断する。provider failure時も自動retryしない。承認数を超える追加commandは別判断とする。
resultsにはraw responseを自動copyせず、sanitized metadataと本人判断だけを手動記録する。

## 互換性、移行、rollback

- state schema、installed extension、active pointer、attempt、traceをmigrationしない。既存command/dataを保持。
- basic導入で既存stateを変換・削除・初期化しない。既存stateがinvalidでもbasicは独立開始できることをtestする。
- rollbackはbasic CLI branch/basic model wrapperと対応test/docsだけを対象patchで戻す。既存未commit差分へ
  reset、checkoutを行わない。
- shared primitive分離でlegacy behaviorを保持できなければ、重複排除を強制せずbasic wrapperを局所化する。
  provider一般化や全面refactorをrollback容易性より優先しない。

## 停止条件

- fixed endpoint、host-only credential、一fetch、retry 0、finite limitsのいずれかを保持できなければ
  `concept-review`。
- extension、persistent attempt/budget、responseの自動execution/writeが必要なら`concept-review`。
- `v0/runner.ts`、`v0/state.ts`、extension protocol/schema、dependency/lockfile変更が必要なら
  直接証拠を示す`plan-delta`としてGateへ戻り、変更しない。
- provider APIの有限性がcodeから判断不能になった場合だけOpenRouter/Deno公式一次資料へ限定調査する。
  provider/model比較、価格調査へ広げない。
- 無関係な既存bugは`park`。basic受入を直接妨げる局所bugだけcause/evidence/impact/fix/verificationを
  示して`local-fix`判断を受ける。

## 完了条件とHuman Gate 2判断点

計画成果は本書一件だけである。本人が次を承認、修正、保留、終了するまで実装、test、review、
credential/provider/state操作を開始しない。

1. `basic run ... --confirm-external-call`を通常interfaceにする。
2. 上表のlimitsと、non-Planをraw success/parse failureとしてexit 0にする。
3. basicをstate/extension/attempt/budget非依存にし、legacy経路は残す。
4. source/testを`v0/cli/main.ts`、`v0/model.ts`、`tests/v0/v0_test.ts`に限定し、
   scope/resultsを`AGENTS.md`、`README.md`、`.handoff/handoff.md`、
   `docs/repeatable-personal-basic-harness-results.md`へ限定する。
5. local gateと10分review後もreal provider acceptanceを別Human Gateへ残す。
6. pinned referenceから採用するのはhost-owned request seam、single-shot CLI外形、generation limitだけとし、
   agent/tool/session/extension loopとSDK dependencyを採用しない。

Gate 2承認後のlocal完了はIncrement 0-3とgate成功、acceptance packageがreal call未実施を明記した状態である。
H-016最終判断は、別承認された最大3 taskの本人利用まで確定しない。
