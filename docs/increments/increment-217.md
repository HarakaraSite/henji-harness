# Increment 217: 選択protocolに応じたprovider adapterの読み込み

作成日：2026-10-08。

状態：計画詳細化・local実装・focused検証・一時compile/binary確認・独立reviewを完了。利用者の明示指示により原指示書を本incrementへ採用した。

## 依頼と目的

productionのWorkerが、選択したモデルのprotocolに必要なadapterを読み込む構造へ整理してください。Chat
Completionsを使うWorkerの起動で、未選択のResponses adapterとOpenAI
SDKを一括評価する依存を除くことが主な目的です。

今回の範囲でlocal実装と必要な検証を行い、結果を報告してください。provider選択、model切替、生成結果、保存と再開、単一binaryでの利用を保ってください。

RSSの測定は必須ではありません。読み込み境界の整理と、メモリ・起動時間・binaryサイズへの効果は分けて扱ってください。

## 対象と基準

- repository：<https://forge.harakara.site/littleisland/henji-harness>
- 調査commit：`b73290524ae7a6512652293e433af5d62b4e7b51`（Increment 216）。
- 実装checkout：`/home/agent/projects/henji-harness`。着手時HEADは調査commitと一致。
- 着手時にrepositoryの`AGENTS.md`と現在のsourceを確認し、以下の根拠が現在も成立するかを確認してください。他の作業の変更は保全してください。
- 背景：構造・処理・責務・フットプリントの分析（参照入力：`/tmp/henji-harness-structure-footprint-analysis-2026-10-08.md`）。同資料の再評価はIncrement
  214までです。モデル入力整理、Core→Data実装の不要な依存除去、CLIのコマンド別読み込みは、Increment
  214〜216で対応済みです。

本書が今回の作業範囲を定義します。背景資料の他の改善候補は今回の対象に含めません。

## 確認済みの現状

`v0/agent/worker/worker_physical_io.ts`は、次の二つのadapterをstatic importしています。

- `provider/openrouter_model.ts`から`OpenRouterAgentModel`。Chat Completionsを扱います。
- `provider/openai_responses_model.ts`からResponses用の4クラス。OpenAI、OpenRouter、ChatGPT、宣言されたResponses
  providerを扱います。

`openai_responses_model.ts`は`@openai/openai`を値としてimportしています。そのため、Chat
Completionsを選ぶ場合でも、physical I/O入口の静的依存にResponses adapterとSDKが含まれます。

ここで整理する単位は主にChat CompletionsとResponsesのprotocolです。同じResponses
module内の4クラスをprovider名ごとに別ファイルへ分割する要求ではありません。

現在の生成経路は、`worker_bootstrap.ts`のWorker構成 → `createProductionPhysicalIo` → `createModel` →
選択したadapterです。未指定時は`defaultModelSelectionFor('openrouter-chat')`を使います。built-in
providerの判定と、宣言されたproviderの`api`／`protocol`による判定には既存の順序があります。

起動後もモデルは固定ではありません。`worker_bootstrap.ts`の`rootRouter`は現在の`rootModel`へ処理を委譲し、`worker_runtime.ts`ではmodel切替、Dataから得た次turnの選択、ChatGPTのregistration
bindingによってmodelを置き換える経路があります。

## 今回の変更範囲

主対象は`worker_physical_io.ts`のadapter構成と、それに直接関係するWorker内の初期化・切替・importです。必要な場合だけ軽い共有型／計測処理の配置、関連テスト、build入力・同梱の確認を含められます。具体的な実装方法は、現在の契約と呼出経路を確認して決めてください。

文字列リテラルのdynamic
importで必要なadapterを取得する方法が候補です。adapter本体やSDKを、型・定数・共有処理の値import経由で再び起動時に読み込まないよう、残る依存も確認してください。

現在の`PhysicalIoBindings.createModel`は同期的に`Model`を返します。また`Model`には、`generate`に加えて任意の同期的な`measureRequestWire`があります。両adapterはこの計測を提供し、`rootRouter`もgetterで公開しています。既存テストには、生成前に計測して送信bodyと照合する利用があります。

同期factoryの契約を保つ方法をまず検討してください。内部構成を非同期にする方法を採る場合は、初期化と切替の必要な呼出箇所まで整合させてください。`generate`だけを代理することで既存の計測を失ったり、初回生成の前後で計測の有無が変わったりする実装は避けてください。Coreのloopや公開APIの全面的な非同期化は今回の目的から要求しません。

選択したadapterを利用可能にする時点を明示してください。モデル構成・切替時、または既存の同期計測も保てる遅延方式などを比較し、生成と計測が同じselectionに対応する方法を選んでください。汎用plugin
loader、新しいWorker、provider parserの書換えは今回の目的から要求しません。

## 保つ動作

- built-inのOpenRouter Chat、OpenAI Responses、OpenRouter Responses、ChatGPT
  Responsesと、宣言されたChat Completions／Responsesの選択・既定値・宣言によるendpointやheaders。
- 既存のprovider／api判定順序と、宣言が利用できない場合の失敗の扱い。
- credentialをprovider request時に解決する動作。ChatGPTのregistrationId、session情報、credential
  presenceの扱い。adapterの読込みのためにcredentialを先読みしないこと。
- `generate`へのrequestとoptionsの受渡し。AbortSignal、timeout、assistant
  progress、thinking、provider evidence、物理request counterの既存の意味。
- adapterが提供する`measureRequestWire`と、その計測内容。
- Chat→Responses→Chat等のmodel切替、次turnへの反映、private provider stateの区切り、tool
  continuation、保存・再開。
- tool／hook用の`requestProvider`とcredential
  availability。モデルadapterを使わない補助requestが、モデル生成を先に実行することを要しないこと。

切替後もprovider・model・auth profileとadapter
instanceの対応を保ってください。既に読み込んだmoduleを切替時にunloadすることや、メモリを強制回収することは今回の対象ではありません。

## 完了条件と検証

1. productionのphysical
   I/O入口から、両adapterを起動時に一括評価する静的な値依存が除かれていること。変更前後の依存と、選択したprotocolから読むadapterを示してください。
2. Chat Completionsだけを使う新しいWorkerで、未選択のResponses
   adapter／SDKを評価する別の依存が残っていないこと。対象とした入口、残る関連依存、その理由を示してください。Responsesを選ぶ場合は対応するadapter／SDKを利用できること。
3. 選択・生成・計測・model切替と、上記の既存動作が維持されていること。
4. source実行と単一binaryの両方でadapterを解決でき、遅延したsourceがbuild入力・staging・同梱対象に残ること。
5. repositoryの規約に従う必要な型チェック・format・lint・差分チェックが成功していること。

dependency graphでは、静的な値依存、dynamic
import、型だけの参照を区別してください。起動時の静的な依存と、選択したadapterを実際に利用する経路の両方を確認してください。評価の観測が必要な場合は、他のadapterを直接importしない一時probeや別process／新しいWorkerを使ってください。両adapterを先にimportする既存テストだけでは、未選択moduleの評価を避けたことは確認できません。

動作確認は、productionのphysical I/O factoryを通し、注入したfetcherまたはlocalhost
mockと隔離credential／XDGを使って行ってください。実providerへの呼出は今回の読み込み整理に必要ありません。

既存テストから変更に対応するものを選んでください。

- `increment_14_multi_provider_test.ts`：production
  factoryでのResponses、宣言されたChat／Responses、endpoint、tool continuation、Worker保存・再開。
- `increment_15_provider_switching_test.ts`：一つのSessionでのprovider切替とprivate stateの区切り。
- `increment_101_provider_headers_test.ts`：宣言されたheaders、session情報、wire計測と送信body。
- `provider_stream_compatibility_test.ts`：production factory経由のChat SSE、request
  counter、progressと結果。
- `increment_163_chatgpt_runtime_test.ts`：ChatGPTのregistrationとruntime選択。
- `increment_173_auxiliary_credentials_test.ts`：モデル生成に依存しない補助provider request。

全テストの再実行やproviderごとの全組合せを合格条件にしないでください。変更した具体的な経路を既存テストで確認できない場合だけ、必要な確認を追加してください。特に、選択的読み込みを使ったproduction経路でChatとResponsesの利用および切替が成立することを確認してください。

localの一時出力へcompileし、宣言されたlocalhost providerなどを使って、compiled
binaryの実Workerから遅延したadapterを利用できることを確認してください。既存builderの収集するbuild入力とstagingも照合し、必要な場合だけ最小限を修正してください。[Denoのdynamic import同梱の資料](https://docs.deno.com/runtime/reference/cli/compile/#dynamic-imports)も参照できます。help／versionだけの成功はadapterの同梱・利用の確認にはなりません。

module評価やbuildの観測は一時probeに置けます。productionへ検証専用loader、常設ログ、計測機構を追加する要求はありません。RSS・起動時間・binaryサイズを測定しなければ、その効果は未確認として報告してください。

## 対象外と実行範囲

SDKの撤去や独自HTTP実装への置換、provider API／SSE
parserの仕様変更、retry・timeout方針の変更、認証方式の変更、Core／Dataの責務やWorker配置の変更、終了済みownerの保持、thinking更新、モデル入力コピーは対象外です。機能や利用できるproviderを狭めないでください。

この指示はlocal変更、非破壊的な検証、検証用のlocal
compileを対象にします。稼働中のCoreや常用binaryを更新せず、commit・push・配置・公開・実provider呼出は利用者からの別の明示指示に従ってください。

局所的な読み込み整理で、製品要件や責務分担の変更が必要と判明した場合は、根拠と追加範囲を報告してください。

完了報告には、読込みの時点、同期factory／計測の扱い、変更ファイル、依存比較、選択・切替・生成の確認、build入力／binaryの確認、残る依存と未確認事項を含めてください。

## 現行product経路と採用する計画

Worker bootstrapがproduction physical I/Oから同期的にroot modelを作り、rootRouterが生成とwire計測を
現在のmodelへ委譲する。WorkerGenerationはmodel切替、Dataの次turn選択、ChatGPT registration bindingで
modelを同期的に置き換える。選択とprivate
state区切りは既存Worker/Core/Dataが所有し、保存先は変えない。 credential
resolverはrequest時にcredentialを解決し、補助requestとpresenceはmodel生成と独立している。

### 実装方法と影響範囲

- `worker_physical_io.ts`のfactoryは同期契約を保つ。各選択branchで同じselection/optionsを保持したModelを
  返し、その最初のgenerateでliteral dynamic importから対応protocolのadapter instanceを作る。
  同じmodel内では生成したinstanceを再利用し、model切替では新しいmodelを構成する。
- wire計測は作成直後から同期的に利用可能にする。Chatは既存`openrouter_request.ts`の計測を直接共有する。
  Responsesは既存の入力・tool組立て・計測をSDK非依存の`openai_responses_request.ts`へ移し、adapterの
  生成と計測も同じ処理を使う。既存のstore、namespace tools、registrationを含むreplay
  identityを保つ。
- Worker bootstrap/WorkerGeneration/Core/public APIの非同期化、新しいWorkerや汎用loaderは不要。
  provider/api判定順序、宣言検証の同期失敗、credential解決、request/optionsの委譲を維持する。
- Responses
  adapterの4クラスは同じmoduleに保持する。SDK、parser、retry、timeout、認証仕様を変えない。
  構想・architecture・roadmapに意味上の変更はなく、その正本は変更しない。

### 動作に対応する確認

1. Worker bootstrapとphysical I/Oの変更前後graphでstatic code、dynamic code、typeを区別する。
   Chatだけを利用するfresh process/WorkerでResponses/SDK評価が起きないこと、Responses生成時に
   読み込めることを、adapterを先にimportしない一時probeで観測する。
2. 生成前後の同期wire計測と、selectionに対応したreplay/toolの送信をproduction factoryで確認する。
   新規testはこの変更動作の既存未確認範囲に限定する。
3. 14のbuilt-in/宣言provider・tool continuation・保存再開、15のSession内Chat→Responses→Chat、101の
   headers/session/wire、stream compatibilityのproduction Chat SSE、163のChatGPT registration、173の
   独立した補助requestから変更経路に対応するfocused testを選ぶ。網羅matrixは追加しない。
4. builderの全graph/buildInputFilesと実stagingに両adapter、SDK関連依存、新しい共有request
   moduleが残ることを
   照合する。一時binaryへ一回compileし、隔離workspace/XDGとlocalhost宣言providerを使い、compiled
   binaryの実WorkerでChatとResponsesの生成・切替を確認する。既存builderで成立するなら変更しない。
5. 変更source/testのtype check、format、lint、git diff --checkを行う。full gateは要求しない。

一時probe・graph・compile/binaryはgit管理外`.tools/increment-217/`へ保存する。実provider
call、常用binaryの
更新、commit/push/配置/公開は今回の承認に含めない。RSS・起動時間・binaryサイズへの改善量は測定しない。
未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`を保全する。

着手時の未確認はdynamic import後の実module評価、既存builderによる同梱とcompiled Worker解決であり、
上記実行証拠で確認する。計測の既存body項目はそのまま移し、別の計測精度変更を加えない。

## 結果

### 実装と読み込み時点

`worker_physical_io.ts`から両adapterへの静的な値importを除いた。factoryは同期的にModelを返し、
各modelの最初のgenerateでliteral dynamic importからそのprotocolのadapterを取得する。
model内のPromiseは一つのadapter instanceを保持する。model切替時は従来通り新しいModelを構成し、
既に評価したmoduleはDenoのmodule cacheを使う。unloadや強制GCは行わない。

| 選択                                             | 最初のgenerateで読むmodule                               |
| ------------------------------------------------ | -------------------------------------------------------- |
| built-in／宣言されたChat Completions             | `provider/openrouter_model.ts`（Chat transportを含む）   |
| OpenAI／OpenRouter／ChatGPT／宣言されたResponses | `provider/openai_responses_model.ts`（OpenAI SDKを含む） |

Responsesの4クラスは従来のmoduleに残る。provider/apiの判定順序、宣言不在の同期失敗、endpoint／headers、
request-time credential、ChatGPT registration/session、fetch
counter、request/optionsの委譲は保った。 補助request dispatcherとcredential
availabilityも独立した既存経路を保つ。

同期wire計測はmodel構成直後から常に利用可能で、adapterが読み込まれる前後でも変わらない。
Chatは既存`openrouter_request.ts`の計測を直接共有する。新しい`openai_responses_request.ts`は、既存Responses
入力・replay・tool組立て・計測をそのまま移したSDK非依存moduleである。Responses adapterのgenerateも
同じ入力/tool関数を使い、producer/model/accountに対応するreplayとnamespace toolsを保つ。
従来のwire計測bodyが含む項目はそのままで、reasoning/includeを追加する計測精度変更は行っていない。

Worker
bootstrap／WorkerGeneration／Core／公開API、SDK/parser/retry/timeout/認証、保存形式と状態所有に変更はない。

### 依存比較と評価観測

Worker bootstrapを入口とする解決済みDeno graphのcode依存だけを辿り、dynamic
importとtype依存を除外した。 JSRのredirectも解決した上で比較した。起動時のstatic
code経路には未解決moduleがない。

| 入口                    | 変更前static code | 変更後static code | 変更後の両adapter本体／SDK |
| ----------------------- | ----------------: | ----------------: | -------------------------- |
| `worker_bootstrap.ts`   |               255 |                89 | 到達しない                 |
| `worker_physical_io.ts` |               195 |                21 | 到達しない                 |

変更前のstatic codeにはSDKの161 moduleが含まれ、変更後は0。physical
I/Oからadapterへの2本のcode依存は literal dynamic importとなった。全graphは290→291
moduleで、両adapterとSDKを保持し、共有request moduleが
一つ増えた。static依存数の減少をbinary全module数、RSS、起動時間の減少と解釈しない。

残るstatic値依存は既存credential resolver、catalog/default、Chatのrequest/wire関数、Responsesの軽い
request/wire関数、補助request dispatcher等。同期選択・計測・credential
presence・補助requestに必要であり、 adapter本体やSDKを値importしない。初回の`--no-remote`
graphではJSR manifestが未解決だったため、
最終比較は通常の解決済みgraphで取得し直した。SDK由来の未解決type-only参照はstatic
code比較から除外した。

評価観測はcheckoutのsource/vendorをgit管理外のコピーへ複製し、Chat transport、Responses adapter、SDK
entryへ ラベルだけを出すmarkerを追加した。JSR
import設定と実装経路は原本と同じにし、隔離Coreから新しい実Workerを 起動した。観測結果は以下の通り。

- Worker構成／Session openの直後：adapter／SDK markerなし。
- 最初のChat生成後：Chat transportだけ評価。Responses／SDK markerなし。
- Responsesへ切替えて生成後：SDKとResponses adapterが初めて評価された。
- Chatへ戻って生成後：既評価moduleのmarkerは再出力されない。
- Coreを停止・再起動して保存Sessionを再開しChat生成後：新しいWorkerでは再びChatだけ評価された。

初回のSDK観測probeはvendor directoryをfile importのaliasにしてDenoのvendor制約に当たった。
コピーのimport設定を元のJSR specifierへ戻し、vendored entryのmarkerを観測する方式で成功した。
このprobe修正に伴うproduction変更や再compileはない。productionに常設marker／loader／ログを追加していない。

### product動作の確認

19種類のfocused既存testが成功した（計測追加後のOpenAI testを含む20実行）。 14の10、101の3、stream
compatibilityの1、173の1、15の1、163の2、78のbuild graphの1である。

- production factoryのbuilt-in OpenAI／OpenRouter Responses、宣言Chat／Responsesのendpoint、
  headers/session、Responses tool continuation、Chat SSE／counterを確認。
- 14のOpenAI factory
  testへ、生成前の同期wire計測、credential先読みなし、送信input/tool/storeと計測の
  対応、生成後の計測維持を追加した。
- 163のChatGPT route testを直接class構成からproduction factory経由へ変更した。生成前後の計測に加え、
  account replay、namespace tools、thinking、tool結果を確認。既存のchild
  registration固定testも成功した。
- 173でモデル未生成の補助provider requestが独立して使えることを確認。
- 14/15のprovider-free Worker testでは保存再開・Session選択の維持を確認した。 production
  adapterを使った実Workerの切替は、次のsource/binary localhost smokeで別途確認した。

source原本、観測用sourceコピー、一時binaryの各々で隔離workspace/XDGとlocalhost宣言providerを使った。
同じSessionの実WorkerへChat→Responses→Chatの3turnを送り、各turnのcanonical採用・completed outcome・
requestCount=1とprovider/model対応、historyへの返信保存を確認した。その後Coreを停止・再起動して同じ保存
Sessionを開き、Chat選択と履歴を保ち、4turn目の生成が成功することを確認した。最終smokeは各4turn。
mock providerはHTTP/SSEを返す別processのlocalhost serverで、外部provider通信は発生していない。

### buildと静的検証

既存78のbuild graph testへ、Chat入口／transport、Responses adapter、新しいrequest moduleが
buildInputFilesに含まれる照合を追加した。既存builderは全module
graphを収集する方式のままで変更不要だった。

`.tools/increment-217/henji`へ既存builderで一回compileし、成功した。実stagingでは両adapter入口、Chat
transport、 新しいrequest module、vendored SDK
entryの5fileが原本と同じ内容であることをSHA-256で照合した。 終了後のtemporary staging
cleanupも成功した。上記compiled Workerのlocalhost生成・切替・保存再開は、
staging削除後にcheckout外から実行した。

一時binaryはHenji 0.11.0、Deno 2.9.7、Linux x86_64、source `b7329052+dirty`。 build
IDは`85748d2432e75c25f4c40fec8311f0ab9a46f9abe3cc51442cbb25d48328e763`。
常用binaryと稼働中Coreは更新していない。

変更source/testの6fileのtype check・format・lint、文書format、git diff --checkが成功した。 full
gateは実行していない。独立reviewは次項の通り完了した。

### 独立review

2026-10-08の利用者指示により、read-only reviewerがコードとテストの差分、直接consumer、
計画と保存した実行証拠を確認した。通常correctness reviewとして初回上限30分内に完了した。

- 必須findingなし。修正が必要なcorrectness問題、変更regression、具体的なtest不足は見つからなかった。
- 同期factory／生成前後のwire計測、全provider branchのselection・credential・options委譲、
  rootRouterとmodel置換の3経路、Responses helperへの既存処理の移動を確認した。
- builderの全graph／入力収集とstaging証拠を照合した。保存graphを独立に集計し、変更後のWorker static
  code 89、physical I/O static code 21と、両adapter本体／SDKへのstatic
  code経路がないことを確認した。
- 観測用コピーと原本の差分が評価markerだけであること、source／観測コピー／binaryのsmoke記録で各4turnの
  completed outcome、provider/model、保存履歴、再開後の選択が対応することを確認した。
- OpenAI計測、ChatGPT計測・account replay／namespace tools、production Chat SSE、宣言Chat
  replay／wire、 build graphのfocused testを計5件独立に再実行し、すべて成功した。git diff
  --checkも成功した。
- source/testの追加修正は不要との判断。reviewerはsource/docsを編集していない。
  全gate、追加compile、smokeの再実行、実provider call、性能測定はreviewでは行っていない。

coordinating ownerは上記結果を採用した。承認済み217のlocal実装・検証・reviewに残作業はない。
commit/pushは後続の利用者明示指示に基づき実施した。常用配置は利用者の後続指示に従う。

### 記録と残る範囲

一時証拠はgit管理外`.tools/increment-217/`に保持した。
`imports-before.json`／`imports-after.json`／`import-summary.json`、`test-14.log`／`test-paths.log`／
`test-measure-build.log`／`type-check.log`、`compile.log`／`staging.json`、
`worker-smoke.json`（source原本）／`worker-smoke-observed-binary.json`（観測用sourceとbinary）を参照する。
観測用コピーと`worker_smoke.py`／`compile_probe.py`も同じ場所にある。

変更fileはphysical I/O factory、Responses adapter、新しい共有request module、14/163/78の既存test、
本計画書と`.handoff/handoff.md`。構想・architecture・roadmapは変更していない。
実providerとの成功、RSS・起動時間・binaryサイズへの効果、常用配置は未確認であり、今回の完了条件に含めない。
利用者の実config／credential／保存Sessionと既存未追跡fileは保全した。
source・計画書・検証とreviewの記録は、2026-10-08の利用者指示によりcommitし、origin/mainへpushした。
配置/公開・実provider callは後続の利用者明示指示に従う。
