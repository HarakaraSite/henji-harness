# Increment 214 — モデル入力の未使用サイズ計測と重複コピーを整理する

現在の状態: **完了（2026-10-08、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は各作業時点の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

状態:
local実装・focused検証・独立review・最小限の実provider確認・別実行のメモリ観測を完了（2026-10-08）。
実provider確認とメモリ観測はreview後の利用者追加指示により実施した。
source・計画書・検証記録は利用者指示によりcommitし、origin/mainへpush。build/配置は未実施。

利用者指定の`/tmp/henji-harness-request-cleanup-instructions.md`を、read-only
reviewerの任意補足を加えて本incrementの計画書へコピーした。本書を今回の要件・計画・結果の正本とする。reviewでは必須修正なし、fake
modelのrequest参照をcloneせず保持する独立性確認が任意補足として提示され、利用者がその反映と計画書化・実装を指示した。

henji-harnessのモデル入力構築について、未使用のサイズ計測と重複した深いコピーを整理し、以下の範囲でlocal実装と必要な検証まで進める。

## 目的と対象

目的は、モデル入力を作る際の冗長な処理を排除し、コピーの責任を明確にすることです。Linuxで数ターンの会話中に約300
MBのRSSが観測されていますが、今回の成功条件はRSSの削減量ではありません。メモリリークの調査、Denoの変更、Worker構成の変更は含めません。

- 対象repository：<https://forge.harakara.site/littleisland/henji-harness>
- 調査基準：2026-10-08、`ad67a85e38057e6f53ceb6bb5875bdbf2e73f9aa`
- 作業先：henji-harness開発checkout。開始時HEADは調査基準と一致。追跡済みfileの変更なし。未追跡の`191-result.json`と`scripts/diagnostics/__pycache__/`は今回の対象外。repositoryの`AGENTS.md`に従う。

以下のパスはrepository相対です。行番号や基準commitを固定条件にせず、現在のsourceで根拠を再確認してください。既に解消されている項目は重ねて変更しないでください。

## 調査で確認した現状

### 1. サイズ計測の結果が利用されていない

`v0/agent/core/context.ts`の`prepareModelContext`は、入力全体を`structuredClone`した後、次の3つをそれぞれ`JSON.stringify`し、`TextEncoder.encode`でUTF-8配列を作ってサイズを数えています。

- system instructionと会話
- ツール定義
- system instruction、会話、ツール定義を含む入力全体

会話とツール定義は、それぞれ二重に走査されます。値の名前には`EstimatedTokens`が含まれますが、実際の計測値はUTF-8バイト数で、provider使用量やtokenizer結果ではありません。

基準commitでは、実際の呼び出しは`v0/agent/core/loop.ts`の`prepareModelContext(projected).request`だけです。`metrics`は捨てられており、表示・圧縮判断などの利用箇所は確認されませんでした。`v0/presentation/contract_types.ts`には対応する古い型が残っています。

### 2. モデル入力が繰り返し深くコピーされる

`v0/agent/core/loop.ts`は、モデル呼び出しごとに`transcript`と`registry.definitions()`をsnapshotして入力を作ります。その後、`prepareModelContext`が入力全体をもう一度深くコピーします。snapshotの実体は`v0/agent/core/events.ts`の`structuredClone`です。

さらにcheckpointを使う場合は`v0/agent/session/semantic_context.ts`、recallを使う場合は`v0/agent/worker/recalled_execution_context.ts`の投影処理でも会話とツール定義を深くコピーします。投影と出所情報の対応は`v0/agent/worker/worker_runtime.ts`で管理されています。

元の会話やツール定義と入力を分離するコピーには用途があります。ただし、同じ所有境界を守るために各段階でコピーを繰り返す必要があるかは整理できます。

## 修正してほしいこと

1. 現在のsource全体で計測値の利用箇所を確認し、未使用であれば3回のJSON化・UTF-8エンコードと計測結果の組み立てを削除してください。不要になる関数・型・定数・importも整理してください。計測結果を使う新機能や互換wrapperを追加して存続させる必要はありません。
2. 入力構築・投影・モデル呼び出しまでの所有関係を確認し、重複した深いコピーを減らしてください。まず`loop.ts`と`prepareModelContext`の重複を対象にし、checkpoint/recallのコピーも同じ責任に統合できる場合は整理してください。コピー回数を一律に1回へ固定することより、残すコピーの用途が説明できることを優先してください。
3. 必要なコピーをどこが担当するか分かる、最小限の構成にしてください。汎用cache、別の計測機構、新しい状態管理層は追加しないでください。

計測値に現在の利用者が見つかった場合は、利用経路と用途を報告し、その利用を壊す削除は避けてください。コピーの統合に大きな責務変更が必要な場合は、確実に省ける部分まで修正し、残る理由を報告してください。

## 保つ動作

- 同じ会話・設定・ツールから、モデルへ同じ意味と順序の入力が渡ること。system
  instruction、ツールschema、tool
  call/result、provider固有情報を今回の整理によって欠落・省略・切り詰めしないこと。
- checkpointの「要約＋保持する会話のsuffix＋現在の入力」と、recallの挿入内容・位置・出所情報が保たれること。provider切替に伴う既存の処理も変えないこと。
- 元の確定会話、ターン内の会話、Registryの定義、各モデル呼び出しの入力の間で、従来必要だった独立性を保つこと。`readonly`型だけで実行時の独立性が保証されるとは扱わないこと。
- 履歴保存、入力の出所記録、実際のHTTP送信に必要なJSON化を保つこと。`JSON.stringify`やsnapshotを一律に削除しないこと。

## 検証と完了条件

既存のCore/Worker経路とtest
fixtureを使い、変更した動作へ直接対応する最小限の確認を行ってください。検証専用のproduction
interfaceは増やさないでください。

- 通常入力と、tool実行後の次のモデル入力について、内容・順序・ツール定義が保たれること。
- 投影経路を変更した場合は、checkpoint/recallの内容・位置・出所情報が保たれること。
- コピーを削減した所有境界について、ネストした値を含め、入力の変更や次のstepの追加が元の会話・Registry・過去の入力へ意図せず伝播しないこと。
  独立性の確認では、fake
  modelへ渡されたrequest参照をcloneせず保持し、ネストした値の変更と後続stepの追加を確認する。受領時にcloneする既存fixtureの内容比較だけで独立性を確認済みにしない。
- 未使用のサイズ計測が通常のモデル入力構築経路から消え、残した深いコピーに具体的な用途があること。

既存の`tests/v0/semantic_context_projection_test.ts`はcheckpoint投影と64 KiBを超えるtool
result保持、`tests/v0/increment_38_recall_context_test.ts`はrecallの確認候補です。現在のtestを確認して、今回の変更に関係するものを選んでください。必要な型チェック、format、lint、`git diff --check`も行い、full
gateの扱いはrepositoryの現行指示に従ってください。ベンチマークやRSS目標の達成は必須ではありません。

今回の指示はlocal修正と非破壊的な検証の範囲です。実provider
call、commit/push、release・公開は、別途明示された許可がある場合だけ行ってください。構想・architecture・roadmapの意味を変える修正は含めません。必要になった場合はrepositoryの承認規約に従って変更案を返してください。

完了時は、削除した処理、変更前後のコピー経路、残したコピーの理由、確認した動作と結果、未確認事項を簡潔に報告してください。source上の処理削減と、実測した性能改善を区別し、RSSや速度の改善を未計測のまま断定しないでください。

## 現行経路とコピー責任の実装計画

利用者のtask → Core/Workerのturn受付 → 確定会話をturn内transcriptへコピー →
Registryの定義とtranscriptで入力を組立て → provider切替・checkpoint・recall投影と出所情報の対応付け
→ request観測・model.generate → tool実行 → 次step、という既存経路を使う。

source全体の照合では、サイズ計測の実行時consumerはloopの`.request`取得だけだった。PresentationContextMetricsもcontractからの型exportだけで、test・表示・圧縮判断・provider
usageに利用されていない。

| 対象                                                                                | 実装する変更と根拠                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0/agent/core/context.ts`                                                          | 計測値、閾値、JSON化/UTF-8エンコード、再cloneだけのprepareModelContextを撤去し、不要になったfileを削除する。互換wrapperは残さない                                                  |
| `v0/presentation/contract_types.ts`、`contract.ts`                                  | 未使用PresentationContextMetricsとexportを削除する                                                                                                                                 |
| `v0/agent/core/loop.ts`                                                             | 投影前のtranscript/toolsのdeep snapshotを省き、純粋・同期的な投影後、request観測とmodel呼出しへ渡す直前に既存snapshotでrequest全体をdeep copyする。これが各requestの所有境界となる |
| `v0/agent/session/semantic_context.ts`                                              | 要約messageとsuffixを新配列へ組み立てる。既存message/toolsのdeep copyはloopの最終snapshotへ統合する                                                                                |
| `v0/agent/worker/recalled_execution_context.ts`                                     | recall文字列の生成・挿入位置を維持し、新配列へ組み立てる。message/toolsのdeep copyは同じ最終snapshotへ統合する                                                                     |
| `v0/agent/core/execution_context.ts`、`loop.ts`の投影interface、`worker_runtime.ts` | 投影が入力を変更しない同期処理で、model用snapshotはloopが所有することを必要なコメントで明記する。出所情報とprovider切替の処理は維持する                                            |

投影のproduction
callerはWorkerの純粋なrequest投影であり、他のcallerはその確認用testである。投影はborrowed
message/toolsから新しい配列や追加messageを作り、元のネストした値を変更しない。深い独立性はreadonly宣言ではなく、投影完了後の実行時snapshotで確保する。

- 残すコピー: 確定会話→turn内会話の開始時snapshot。turn中の追記・tool処理から確定会話を分離する。
- 残すコピー:
  投影後request→request観測/model入力の各stepのsnapshot。元の会話・Registry・過去requestから、ネストしたprovider情報・tool引数・schemaを含めて分離する。
- 残すコピー: event配送、model
  result/ツール引数の採用、outcome/commit等。別のconsumerや保存境界に必要であり、今回削減しない。
- checkpoint/recallの並行source sidecarと、provider切替で過去private
  stateを投影から外す既存処理は変更しない。raw HTTPや履歴保存のJSON化も維持する。

## 動作に対応するfocused検証計画

- 新規`tests/v0/increment_214_model_request_test.ts`で、通常入力・tool後の次requestのsystem
  instruction、message順序、schema、provider state、tool call/resultを確認する。fake
  modelは受領requestをcloneせず保持する。
- 同testで、受領requestのネストしたprovider
  state/schema/tool引数を変更しても、確定会話・Registry・turnの結果・次requestへ伝播しないこと、および次stepの追記が過去requestへ現れないことを確認する。
- checkpoint＋recall経路にも同じ独立性確認を行い、要約、保持suffix、recall位置と本文、現在task、tool後requestを確認する。既存のWorker
  checkpoint/recall testとattribution保存/readback確認も使う。
- 既存`semantic_context_projection_test.ts`でcheckpointと64
  KiB超tool結果、`increment_38_recall_context_test.ts`でWorker
  recallと出所、`increment_15_provider_switching_test.ts`の関係するWorker境界でprivate
  stateの適用範囲を確認する。fixtureの件数を目標にしない。
- 必要なtype check、変更fileのformat/lint、`git diff --check`を実行する。full
  gateは本計画の必須確認にしない。当初計画では実provider
  call、RSS/速度benchmark、build・配置を対象外とした。
  review後、利用者が最小限の実provider利用と別途メモリ観測を明示承認したため、下記の追加確認を実施した。

## 結果

### 削除とコピー経路

- `context.ts`を削除し、prepareModelContext、ContextMetrics、PreparedModelContext、2個の旧閾値、TextEncoder、jsonBytes、計測用envelope、cloneRequestを撤去した。通常入力構築の3回のJSON化・UTF-8配列生成と、捨てられていたmetricsの組立てがなくなった。
- PresentationContextMetricsとcontractの型exportも削除した。active
  source/test/module入口からこれらへの参照は残っていない。過去の計画書・履歴は当時の記録として保持した。
- loopはturn内会話とRegistry定義を参照して同期投影し、その結果を既存snapshotでdeep
  copyしてからrequest観測・model.generateへ渡す。
- checkpointは「要約＋suffix＋現在task」、recallは既存JSON文字列と挿入位置を維持して新配列へ組み立てる。投影内のdeep
  copyをloopのmodel入力境界へ統合した。

| 経路               | 変更前のコピー段階                                                | 変更後                                        |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------- |
| 通常               | loopが会話/toolsをdeep copy → prepareModelContextが全入力を再copy | loopが投影後の全入力をdeep copy               |
| checkpoint         | loop → checkpointが会話/toolsを再copy → prepareModelContext       | summary/suffixの配列組立て → loopの全入力copy |
| recall             | loop → recallが会話/toolsを再copy → prepareModelContext           | recallの配列組立て → loopの全入力copy         |
| checkpoint＋recall | loop → checkpoint → recall → prepareModelContext                  | 両投影の配列組立て → loopの全入力copy         |

loopと両投影関数に直接記述したstructuredClone呼出しは、各requestについて通常3箇所、checkpointまたはrecallのみ5箇所、併用7箇所から、最終requestの1箇所へ整理した。これはsource上の処理構造の比較であり、RSS・速度・アプリ全体のclone件数を測定した結果ではない。

checkpointが呼ぶ`indexSessionHistoryPrefix`は、共有history
indexの返却messagesを元の会話と分離するため、
`session_history.ts`の`makeSessionHistoryIndex`でmessage単位のstructuredCloneを行う。この既存コピーは
維持しており、上記比較の対象外である。checkpoint経路全体のコピーが1回になったという意味ではない。

確定会話をturn内会話へ分離する開始時snapshot、model
result/tool引数の採用、event配送、outcome/commit等の独立した所有・保存境界のコピーは残した。request観測・履歴保存・recall本文・HTTP送信に必要なJSON化も保持した。

### 確認した動作と結果

- 新規214の2 test: 通常とcheckpoint＋recallの各経路で、実際のrequest参照をcloneせず保持し、3 model
  stepと2 tool実行を確認した。system instruction、schema、順序、provider
  replayItems、tool引数/result、checkpoint summary・suffix、recall本文・位置、現在taskが維持された。
- 同testでネストしたprovider
  replayItems、schema、tool引数とtask本文をrequest側で変更し、確定会話・Registry・turn結果・次requestへ伝播しないことを確認した。後続stepが過去requestへ追記されず、投影messageがcanonical
  outcomeへ混入しないことも確認した。
- 既存semantic contextの2 test: checkpoint投影と64 KiB超tool resultの保持が成功した。
- 既存recallの7 test:
  Worker経路の一turn投影、再実行抑止、steering、checkpoint併用、保存artifactの正確なrecall/readback、選択の一回消費が成功した。
- checkpoint併用testへ、context
  deltaにcheckpointとrecallのlogicalIdentity/sourceLocatorが残るassertionを追加した。変更後の当該testを再実行して成功した。
- 既存context revisionの2 test: request出所とsuffix差分、semantic/provider factの記録が成功した。
- provider切替の関係するWorker test: 最新provider segmentのprivate state投影が成功した。
- 以上のfocused確認は14 testが成功。追加した出所assertionの1
  testは変更後に再確認した。test件数は結果の記録であり、完了基準ではない。
- `v0:check`、追加出所assertionを含むrecall testのfocused type
  check、変更fileのformat/lint、`git diff --check`が成功した。full gateは実行していない。
- type checkは通常の`deno check`、focused testはcached-only/no-checkで確認した。cached-onlyのtype
  checkはOpenAI
  SDKの推移的型specifierがcacheにないため使用できなかった。このfocused確認段階では実providerへの通信は行っていない。

### 実装review

2026-10-08の利用者指示により、read-only reviewerが214の計画・実装diff・新規test・直接consumerと
確定会話／turn／投影／model入力／保存の境界を照合した。上限30分の通常correctness reviewで、
一般hardening、実provider call、full gateは対象外とした。

- 必須修正findingなし。計測の撤去、投影後snapshotの独立性、checkpoint/recall・provider切替・出所情報、
  result/event/outcome/commitのコピー境界は維持されているとの評価。
- reviewerが新規214の2 testと、変更されたcheckpoint＋recall出所testの1件を再確認し、すべて成功した。
  `git diff --check`も成功した。
- 任意の文書補足として、history index内の既存コピーをコピー数比較に含めない旨の明記が提示された。
  coordinating ownerがsourceを確認して上記結果へ反映した。実装の追加変更はない。

### 追加の実provider確認

2026-10-08の利用者追加指示「最小限の実プロバイダの利用を認めます」に基づき、対象・最大request数・
保存先を提示し、現在のsourceをDenoから起動してproductionのHost → Data/Worker → HTTP経路を確認した。

- 対象は常用選択の`opencode-go-chat / deepseek-v4.1-flash / max`、Chat Completions SSE。
  隔離workspaceとconfig/data/stateを使用し、実credentialは既存rootから読取りだけ行った。
  実config・credential・既存Sessionは変更していない。
- `read`だけを持つprobe agentへ、`probe.txt`を一度読み、記載値だけ返す1 taskを送った。
  maxSteps=2、物理requestは予定どおり2回、HTTP 200が2回、tool
  call/resultは各1回で成功し、最終回答は`7319`。
- 保存SQLiteのreadbackでも、executionの`settled / completed / canonical`、4個のcanonical message、
  tool引数・結果、最終回答、各stepのrequest/HTTP factを照合した。raw
  HTTP/SSEやAuthorization、credential値は記録していない。
- probe scriptが結果保存後に、存在しない`outcome.kind`を終了判定に使ってexit 1になった。
  正しい`ok / stopReason`判定へ修正した。productは既に成功・保存しており、保存内容の照合で確認を完了した。
  このprobeの誤りを理由に実providerを再呼出ししていない。
- 記録先はgit管理外の`.tools/increment-214/live/`。結果は`result.json`、保存factとsemantic履歴の照合は
  `readback.json`、正本履歴は同配下の隔離stateにあるSQLite。

### 別実行のメモリ観測

実provider確認とは独立に、変更前の`ad67a85e`をgit
archiveしたsourceと変更後の開発sourceを、同じDeno・
同じprobeで各3回、新規processから実行した。メモリ観測では外部providerを呼ばず、別processのlocalhost
HTTP serverがtool callと最終回答を返す。product側はproduction Host/Data/WorkerとChat Completions
adapterを使う。

- 隔離Sessionで20 turn、各turnは約58 KiBの同じfileを`read`し、次requestで最終回答を受け取る。
  全6実行で20 turn・40 requestが成功した。最後のHTTP request bodyは約1.15 MiB。 変更前後のbody長の2
  byte差は、隔離workspaceの`before`/`after`というpath長に対応する。
- Linux `/proc/<pid>/smaps_rollup`のRSS/PSS等を約20 ms間隔で採取し、`status`のVmHWMも記録した。
  測定対象はHost・Data/Agent Worker threadを含むDeno process。別processのmock serverは含めない。
  turn境界と終了後2秒のidleを記録し、強制GCは行わない。TUI・compiled
  binary・長期利用の測定ではない。

| 実行 | 変更前 起動後RSS | 変更後 起動後RSS | 変更前 最大RSS（VmHWM） | 変更後 最大RSS（VmHWM） | 変更前 idle RSS | 変更後 idle RSS |
| ---- | ---------------- | ---------------- | ----------------------- | ----------------------- | --------------- | --------------- |
| 1    | 139.2 MiB        | 104.2 MiB        | 384.0 MiB               | 321.5 MiB               | 378.5 MiB       | 321.5 MiB       |
| 2    | 103.4 MiB        | 104.2 MiB        | 331.1 MiB               | 327.3 MiB               | 330.5 MiB       | 324.5 MiB       |
| 3    | 103.5 MiB        | 104.2 MiB        | 333.8 MiB               | 340.7 MiB               | 331.0 MiB       | 338.5 MiB       |

初回は負荷開始前から約35 MiBの差があり、変更の効果と断定できない。そこで追加した3回目も含め、
開始時RSSが近い2・3回目を見ると、最大RSSの変更後差は−3.8 MiB、＋6.9 MiBで方向が逆転した。 idle
PSSも変更前324.4／324.9 MiB、変更後318.3／332.4 MiBで逆転している。
この観測では安定したRSS削減を確認できず、処理を減らしたsource上の結果からRSS改善量を推定しない。 20
turnの履歴保持・保存を伴うRSS増加を観測したが、この測定だけでメモリリークとは判断できない。

記録先はgit管理外の`.tools/increment-214/memory/`。`summary.json`に全実行の集計、各run配下に
`samples.json`、`stages-with-process-memory.json`、隔離履歴を保存した。再現用probeは
`.tools/increment-214/probe.ts`と`observe_memory.py`。production sourceへ計測機構を追加していない。

### 未確認・権限境界

速度・長期Sessionでの性能改善、compiled binaryのbuild/配置、TUIでの通常利用は今回実施していない。
実providerで確認したのは通常入力→tool→最終回答→canonical保存の1 turn。
checkpoint/recall・provider切替・入力の独立性は既存Core loop/Workerのfocused確認結果に基づく。
RSSは上記の別実行で観測したが、安定した改善は未確認であり、今回の成功条件にはしない。

構想・architecture・roadmapの意味、provider
adapter、Worker配置、履歴保存contractは変更していない。実config・credential・既存保存Session・既存未追跡fileは変更していない。
今回の実provider承認は上記2
requestで消化し、commit/pushは後続の利用者指示に基づき実施した。build/配置・公開/releaseや追加の実provider
callは、後続の明示指示の範囲で扱う。
