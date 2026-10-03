# Increment 176 — 失敗の分類と短い診断情報の拡充

更新日: 2026-10-03

ステータス:
**完了。local実装・focused検証・通常review・常用配置・配置先production
TUI確認済み（2026-10-03）。commit/push済み。**

利用者の「176を進めよう」によりB8と、合意済みの他の実行失敗への小さい情報拡充を採用した。

## 採用要件

- HTTP 200のSSEでSDKがprovider APIエラーをthrowした場合は接続エラーと区別する。
  B8の元の失敗原因は未確定のままとし、診断で原因を断定しない。
- 失敗した処理、元の例外種類・短いメッセージ・code/type/param、原因例外の種類・codeを、
  取得できる場合に残す。providerではrequest/response
  ID、stream件数・最後のevent・completed有無も残す。 既存の解析failure
  field／期待した型／実際の型を診断へ引き継ぐ。
- toolの例外は既存のtool結果へ、Worker／保存処理の例外は既存のexecution診断へ紐づける。
  正常動作・正常な外部responseの受付・再試行・cancel・履歴の採用判断は変更しない。
- 正常時の保存項目・DB書込み回数は増やさない。stream全文・raw応答・stack全文の常設保存は追加しない。
  共通detailsは1 record最大4 KiB、messageは最大512 UTF-8
  bytes、その他文字列は最大128 bytesとし、
  切り詰めた場合はその事実を残す。streamではcounterと最後の状態のみを保持する。
- API
  credentialとAuthorizationはdetailsから除外する。境界で既知のcredentialを除去してから短くする。
- SQL schema、table、column、DB
  migrationは変更しない。既存JSONの型・検証・保存・readbackを拡張する。
  エラーメッセージは英語。構想・architecture・roadmap変更と常用配置は対象外。

## 現行経路と計画

provider adapter → request_failure／FailureDiagnostic →
Workerの既存observation／terminal → Agent Data → SQLiteの既存JSON → diagnostics
CLI、がprovider失敗の保存経路である。
元のSDK例外をcatchで汎用errorへ置き換え、diagnostic
projectionが短い分類以外を落としている。 共通のbounded
details生成を失敗branchだけで使い、既存の経路で受け渡す。

tool例外はRegistryで文字列のerror
resultとなり、loop／effect／semantic履歴へ保存される。
そのresultにdetailsを加える。tool引数・結果・runtime
outcomeは既存semantic履歴を正本とし、 新しいfailure eventや別保存先を作らない。

Workerの例外とHostのcommit／settlement例外は、既存worker_errorとsealGeneration経由で
元の例外種類・処理段階を残す。B5のboolean
validator全体を理由付きへ置き換える作業は含めず、
現在取得できるreasonを保存する。

最終commitの保存例外は既にauthorizationを受けた後なのでsealGenerationで再settlementしない。
Agent Dataの既存commit
catchから既存derived_documentsへ診断を書き、execution_admissionsの
既存diagnostic_idへ紐づける。この失敗branchだけ診断保存を追加し、canonical採用・outcome・
settlementは動かさない。診断保存も失敗した場合は元のcommit例外を維持する。

## 確認計画

- localhost ResponsesのHTTP 200 SSE
  APIエラー、解析失敗、通信例外で分類とdetailsを確認する。
  credentialを含む模擬例外でも追加情報へcredential／Authorizationを出さない。
- 既存Chat Completions／auxiliary
  requestのfailure、tool例外、Worker／commit例外を短く記録・readbackする。
- production Worker／Core HTTP → DB →
  diagnosticsで実経路を確認する。正常成功時の観測数とpayloadは
  拡充前と同じであることを確認し、失敗時の保存量・共通captureの処理時間をローカルで測る。
- 関係するfocused test、type check、format、lint、git diff --checkを使う。full
  gateは行わない。
- エラー分類によるTUI理由表示は隔離XDG・tmuxのproduction
  TUIとlocalhost応答で確認する。 実provider
  call・実config変更・commit/pushは行わない。

## 原観測・診断調査

### OpenAI応答中の失敗が接続エラーにまとめられ、直接原因を特定できない

- 観測（2026-10-03、173配置後の通常利用）: Session
  `6842cfcf-6a79-422c-ad82-b271e5473efe`の execution
  `385073f9-d5fd-4878-b248-a33cb7aedddf`で、Exa検索2件とweb_fetchが成功した後、
  `FAILED · provider connection failed · try /recall`となった。
- 保存fact: 物理request順はOpenAI step 1 → Exa → Exa → OpenAI step 2 → OpenAI
  step 3。 5 requestともHTTP
  200を受信した。最後のrequestの直後に`transport_error`／`transport`が記録され、
  第3stepのthinking／assistant本文はない。診断IDは`a318ac92-2fc3-42d6-b4e7-ee50a57fb272`。
  元のSDK例外の種類・provider error
  code/type/paramは保持されていないため、接続障害と断定できない。
- 現行source: OpenAI SDKはSSE内の`data.error`でHTTP
  status未指定の`APIError`をthrowする。 共通Responses
  adapterのcatchはstatusなしの未知例外を`transport_error`へまとめるため、
  providerが返したAPIエラーも接続エラーとして表示され、元の例外情報が失われる。
- Probe承認: 利用者の「probeで調査できる？」に対し、OpenAI
  Responsesのgpt-6-luna／mediumへ 保存logical request
  3の入力を最大1回再送し、再試行・Exa検索・tool実行を行わず、tmpへ短いfactを
  保存する範囲を提示した。同日の「はいお願いします」で実行承認を受けた。
  初回成功の後、「追加の三回の実行を許可する」で同じ保存入力の追加3回を承認した。
- Offline結果: 保存入力をproduction adapterで組み立て、模擬HTTP 200のSSE
  APIエラーを返した。
  SDKが示す`APIError`／`invalid_request_error`がHenjiでは`transport_error`となることを確認した。
  これは分類問題の確認であり、元の実失敗が同じAPIエラーだった証拠ではない。
- 実probe結果: 承認されたOpenAI callを1回実行し、HTTP
  200、`response.completed`、modelの`final`まで
  成功した。同じ保存済み入力から作ったrequestは501,054
  bytes。検索・toolは再実行せず、再試行は0。
  受信responseのメモリ内コピーをSDKへローカル再生しても成功した。追加API
  callは使っていない。 追加3回も各1 request、HTTP
  200／`response.completed`／`final`まで成功し、SDKローカル再生も成功した。
  4回ともrequestは501,054
  bytesで、例外・再試行はなかった。受信byte数は初回から順に
  287,592／212,863／362,675／407,961。計4回で元の失敗は再現せず、直接原因は未確定。
  同じ入力が常に失敗するという証拠はなく、一時的な接続障害とも断定していない。
- 確認資料:
  `/tmp/henji-response-failure-probe-nzawsru6/`の`probe.ts`、`proposal.json`、
  `offline-facts.json`、`live-facts.json`、`additional-proposal.json`、
  `run-2`〜`run-4`の各`probe.ts`／`live-facts.json`。credential・Authorization・raw本文は保存していない。
- 対応候補: 接続・provider
  API・解析の例外を区別し、credentialを含まないSDK例外種類とprovider error
  code/type/param等を短いfactへ残す。次回発生時の実原因に沿って修正を判断する。
  今回は診断のみで、分類・通常記録の修正は未採用。B6 →
  B7の対応順は変更していない。
- 利用者指定（2026-10-03）:
  失敗情報の保存拡充はB8対応時に詳しく検討する。今回は候補の記録だけとし、
  保存項目・実装方式は確定しない。検討候補は元の例外種類／メッセージとproviderのcode/type/param、
  原因例外の種類・コード、失敗した処理、最後のstreamイベント種別／受信数／完了イベント有無、
  provider request ID／response ID、解析失敗のfield／期待した型／実際の型。
  既存のWorker → Host → SQLite →
  diagnosticsのrequest単位の短いfactを拡張する案とし、
  credential・Authorizationを除外する。raw本文・SSE断片の常設収集は増やさない。
- 関連:
  `v0/agent/provider/openai_responses_model.ts`の`evidenceFetch`／`generate`のcatch、
  `vendor/jsr.io/@openai/openai/7.2.0/core/streaming.ts`、`v0/tui/system_notices.ts`。

## 結果

### 実装

- 共通`FailureDetails`とcapture／validatorを追加し、既存request_failure、FailureDiagnostic、
  tool_result、worker_error、Data error replyに短いscalar情報を通した。SQL
  schemaは変更していない。
- ResponsesのHTTP 200 SSE内SDK
  APIErrorをresponse_error／provider_reported_errorへ分類した。
  SyntaxErrorによるJSON解析失敗もtransportと区別する。HTTP API
  rejection、timeout、cancel、
  再試行の既存動作は維持した。B8の元の実失敗の直接原因は引き続き未確定。
- ResponsesはSDKがyieldしたevent数・最後のevent・response.completed有無を保存する。
  SDKがthrowしたAPIエラーframeはyieldされないためevent数に含まれない。 Chat
  Completionsはparserへ渡ったdata
  payload数・最後のobject種別／[DONE]・[DONE]受信有無を残す。
  通常応答にはこれらを追加しない。Chatのreader／buffered
  body例外も汎用分類で失う前に保持する。
- credentialはprovider／auxiliary request境界で除去してからbyte上限を適用する。
  共通captureはAuthorizationを除去し、stackやraw responseを追加保存しない。
  下位処理で既に置き換えられた例外の元情報は復元せず、取得できた例外・fieldだけを保存する。

### 確認

- 新規176の7 focused case、production Core HTTP／Worker／DB／diagnostics CLIの1
  case、 実Workerのturn例外→Host seal→Data Worker保存の1 caseを確認した。
  既存170のcommit失敗caseでは、非採用のまま元のHistoryStoreErrorとcodeをreadbackできた。
- Chat streaming互換20 case、cancel／cleanup4 case、175 steering5 case／HTTP1
  case、 Responses thinking順序1 caseを含む関連focused確認は計41 case通過。
  39のbody-read確認は、追加された元例外のidentityも確認し、従来のkindとcleanup結果の確認を維持した。
- CLI入口と新規・変更testのtype check、変更29 source/testのformat／lint、git
  diff --checkを確認した。 full gateは実行していない。
- tmux、100×32、隔離XDGのproduction source TUIでlocalhost dummy
  providerを使った。
  `provider error`は`FAILED · provider response invalid · try /recall`、`tool error`は
  read失敗表示の後に回答継続、`normal success`は通常回答・readyを確認した。
  同じ診断をCLIで読み出し、APIError／invalid_request_error、request/response
  ID、event数2、
  completed=falseを確認した。模擬credentialとAuthorizationは追加情報へ残っていない。
  確認用Coreとproviderは停止済み。実Core／config／既存DBは変更していない。

### データ量・処理負担

- 変更前HEADのResponses adapterと現在のadapterへ同じ32
  delta＋completedをローカル再生した。
  正常時のobservationはともにrequest_start／response_startの2件、496
  bytesでpayload完全一致。 正常時に新しいDB書込みを呼ぶbranchは追加していない。
- 各50回warm-up、200回×3 batchを交互に測定した。正常generateは旧0.210〜0.300
  ms/request、 新0.198〜0.268
  ms/request。ローカルの短い応答での測定であり、外部通信の性能保証には用いない。
  短い例外の共通captureを10,000回測り平均5.04 μs、details単体154 bytesだった。
- production
  TUIの保存JSONについて追加details／failureを除いた場合との差を集計した。
  provider失敗は既存semantic記録・診断・outcomeを合わせて2,028 bytes、tool失敗は
  immutable contentとsemantic履歴を含め360 bytes、続く正常成功は追加0
  bytesだった。 SQLite
  page／WALの物理増加量ではなく、今回のfixtureで追加したJSON情報のbyte数である。
  上限は1 details最大4 KiB（診断全体最大6 KiB）、message512 bytes、他文字列128
  bytes。 同じ失敗を既存の複数の記録へ保持するため、1 execution合計の上限を4
  KiBとする意味ではない。
- 資料:
  `/tmp/henji-increment-176-tui-4yvin33n/evidence/`の各pane、`diagnostic.json`、
  `performance.json`、`storage-size.json`。比較用scriptは同じtmpの`perf.ts`／`baseline_responses.ts`。

上記のlocal実装・確認では常用配置・実provider call・commit/pushは行っていない。
構想・architecture・roadmapは変更していない。

### 通常review

2026-10-03の利用者の「b6からb8まで通常レビューさせて」により、reviewerが174〜176をread-onlyで
通常reviewした。明示要件、production経路、変更によるregression、具体的な動作確認を対象とし、
一般的なsecurity reviewとfull gateは行っていない。findingは0件で、対象43
fileのhashは不変だった。

追加のlocalhost production確認4件はすべて成功した。175の追加指示のrequest
readback／attributionと 次taskのturn保存、176のtool失敗metadataのCLI
readback、Worker例外、170のcommit保存例外を確認した。 実provider
callとsource変更は0件。資料は`.tools/increment-176/normal-review.json`。

### 常用配置

利用者の「では配置してB8の元の実失敗原因は実使用で観測したらでいい」により、172〜176の現在の
local
sourceから通常の`henji:compile`でbuildし、`/home/agent/.local/bin/henji`と`dist/henji`へ配置した。
versionは0.8.0、sourceは`49e8195b33f0bd2252cc7b40d00cab39717d61ec+dirty`、Denoは2.9.7。

- Build ID: `d993f696415bad8b601d09659d95864777c1b5dae72472b069589ff5c3722120`
- Binary SHA-256:
  `5a9cf37e7947683fe76b6502ade8ed46c21415a3d13316fefc31582fa8099af8`
- 配置資料:
  `.tools/increment-176/deployment.json`、`build.log`、`deployed-tui/`。
  前のbinaryは`.tools/increment-176/henji.previous`へ退避した。配置先と`dist`のhashは一致した。

配置先binaryをtmuxの100×32 terminal、隔離XDG、localhost dummy
providerで起動した。 Coreのbuild IDが配置版と一致することをHTTP APIで確認した。

1. B6: ChatGPT未登録の`/provider`一覧、未登録ChatGPTの選択、API-key
   providerへの切替が完了した。
2. B7:
   F3のWorker受付noticeを確認した。元のfinal後に同じexecutionの2回目のrequestへ進み、
   元task→元assistant→追加指示→継続後assistantの4 messageがturn 1へ保存された。
   追加指示には`steering: true`があり、終了後のpendingは空だった。
3. B8: 模擬HTTP 200 SSE
   APIエラーは`provider response invalid`と表示され、配置先CLIで
   `response_error`、APIError、code/type/param、request/response
   ID、event数2、completed=falseを読み戻せた。 dummy
   credentialとAuthorizationは追加診断から除去されていた。
4. read
   tool失敗はsemantic履歴に`tool_execute`／`Error`／`file not found`を保存し、回答を継続した。
   続く正常taskは通常回答とreadyになり、execution診断は追加されなかった。

合計4 task、localhost provider requestは6回、実provider callは0回。
検証用Coreだけを通常`core stop --connect`で停止し、検証用TUIと応答サーバーも終了した。
実config、既存DB、起動中の常用Coreは変更していない。新しく起動するCoreから配置版が使われる。

B8の元の実失敗原因は未確定である。利用者指定に従い追加の実probeは行わず、実使用で再発した際に
今回拡充した短い診断と既存semantic履歴から原因を調べる。再現待ちは本incrementの配置を妨げない。

### Commit／push（2026-10-03）

利用者の「忘れてたコミットプッシュして」により、172〜176の実装・test・結果記録を
`c9b5d9d6`（`feat: ship increments 172-176 for web tools, credentials, and diagnostics`）へまとめ、
`origin/main`へpushした。完了状態の文書更新は別のdocs
commitで同じ送信先へ反映する。
今回の作業はcommit／pushと記録更新に限定し、追加の実provider
callや再配置は行っていない。
