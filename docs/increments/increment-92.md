# Increment 92 — auxiliary provider開始停止の直接原因特定

## Status

原因確定済み（2026-09-20）。production停止の直接原因は、v6 history
pipelineがすべてのprovider request_startに先行exact byte
captureを要求するのに対し、`web_search`のauxiliary request経路が exact
captureを発行しない契約不整合であって、`appendExecutionEvents`がthrowし
`handleJournalFailure`がWorkerをterminateするため。offline
replayでcredential不要・決定論的に再現 （「原因確定」節）。Deno
runtime・OpenRouter・SQLite・module Workerは直接原因ではない。根本修正と
`handleJournalFailure`のterminate方針を含む修正計画はGPT-6 Astra
xhighの通常・批判的reviewを反映済みで、実装は利用者承認待ち。Deno向け公開reproducer案は撤回済み。

本文は調査の時系列を残している。「暫定仮説」「棄却済み」と記した節は原因確定前の観測と判断であり、
現在の原因判定ではない。現行の結論と修正候補は「原因確定」以降を正とする。

## 採用する事象

2026-09-20のSession `362499de-a0d4-425b-ac3e-7e2dd5c4f5ca` turn 1では、最初の
`web_search`が完了せず、利用者がcancelした後も旧実装はsettleしなかった。Increment
91はcancel後の
無期限待機を解消したが、最初に処理が止まった直接原因は対象外として残した。

保存済み`history-v6.sqlite3`をpayload本文を読まずに再確認した結果は次のとおりである。

- execution `5ae8b8b8-b76a-4cf1-bf33-a9df4ee2d8a7`はturn 1、143
  records、最終的に `interrupted`／`non_canonical`でsettleしている。
- root provider responseとtool callに続く最後のWorker由来recordは、ordinal 140の
  `resource_attribution`（auxiliary context
  delta、`2026-09-20T02:00:47.492Z`）である。
- 次はHostの`cancel_requested`相当record（ordinal
  141、`02:09:36.071Z`）で、約528.6秒の間に `provider_request_start`、provider
  response、tool result、turn settlementはない。
- cancel送信後も旧実装ではsettleせず、process終了後のreconciliationまでさらに約375.8秒を要した。

現行sourceで、最後のrecordに対応する処理から次のprovider
requestまでの順序は次のとおりである。

1. `worker_runtime.ts`がauxiliary request bodyのcontext deltaを作り、
   `port.contextObservation(...)`を呼ぶ。
2. `worker_bootstrap.ts`のportはWorker
   sequenceを増やし、`postMessage`して同期的にnumberを返す。
3. 呼出側はそのnumberを`await`するため、一度microtask境界を通る。
4. `web_search.ts`が`providerEvidence.startRequest(...)`を呼ぶ。
5. `provider_evidence.ts`はrequest recordを作り、`request_start`
   observationをWorker portへ送る。
6. その後で初めてWorker-local
   `requestProvider(...)`、credential解決、`fetch`、body読取へ進む。

この区間には通常のnetwork
awaitはない。一方、履歴に`provider_request_start`がないことだけでは、次を
区別できない。

- Workerがcontext observation送信後のmicrotaskへ復帰しなかった。
- request evidence構築または`postMessage`中で停止した。
- Workerはrequest startを送ったが、Hostのmessage受信まで到達しなかった。
- Hostは受信したが、observation bufferまたはv6永続化まで到達しなかった。
- request startの履歴だけが欠落し、実際にはcredential解決またはprovider
  I/Oへ進んでいた。

したがって調査開始時点では、「provider
request開始前で止まった」が特定できた最小範囲であり、直接原因は
まだ確定していなかった。

関連する既存観測として、Session
`375ca4e7`では完了したturnにも`context_observation`から次の
`provider_request_start`まで12.2秒、18.8秒、25.7秒のgapがあった。ただし同一原因である証拠はないため、
再発候補として比較するだけに留める。

## 目的と完了条件

目的は、停止を回避する一般的timeoutを追加することではなく、停止時に最後に完了した実処理境界を証明し、
原因をHenji source、Worker message transport、Host journaling、Deno
runtime、provider I/Oのいずれかへ source-to-impactで帰属させることである。

完了には次をすべて必要とする。

1. 同種の遅延または停止が再発したexecutionについて、Workerが到達した最後のstage、Hostが受信した最後の
   Worker sequence、永続化した最後のWorker
   sequenceを一つのexecutionへ関連付けてreadbackできる。
2. 特定したstageから、停止している具体的な関数呼出し、`await`、message
   transport、またはjournal境界を示す。
3. Henji固有でないruntime挙動が原因候補なら、同じDeno
   versionで最小再現または反証を得る。
4. 再現しなかった場合は「未再現」とし、既存履歴から原因を推定で確定しない。

「最後のrecordがcontext
observationだった」「計測後は正常完了した」「providerかDenoの問題らしい」だけでは
完了としない。

## 必要な診断動作

### 1. message経路と独立したWorker stage latch

HostがWorker
generationごとに小さな`SharedArrayBuffer`を作り、start時にWorkerへ渡す。Workerは
`Atomics.store`で次だけを更新する。

- execution epoch
- 単調増加するstage ordinal
- stage code
- 次に送ろうとしている、または送信を終えたWorker sequence

これはmessageを送らず、request
body、credential、Authorization、URL、prompt、responseを含まない。 Hostはactive
executionへ結び付けて値を読む。通常処理にHost
acknowledgement待ちを加えないため、計測によって 問題のmicrotask/message
timingを別物へ変えない。

実装前に、現行Denoのmodule
Workerで共有bufferの可視性と`Atomics`順序を最小probeで確認する。成立しない場合は
product codeへ入れず、このsliceをNo-Goとして代替設計へ戻す。

### 2. 最小stage集合

最初は、事象を分離できる次の境界だけを計測する。

| stage                                                        | 証明すること                                           |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `aux_context_post_entered`                                   | context observationのstructured clone／enqueueへ入った |
| `aux_context_post_returned`                                  | context observationの`postMessage`が同期的に戻った     |
| `aux_context_await_resumed`                                  | 呼出側がnumberの`await`後にmicrotaskへ復帰した         |
| `evidence_start_entered`                                     | provider evidence record構築へ入った                   |
| `provider_start_post_entered`                                | `request_start`のclone／enqueueへ入った                |
| `provider_start_post_returned`                               | `request_start`の`postMessage`が同期的に戻った         |
| `aux_request_provider_entered`                               | productionのWorker-local provider seamへ入った         |
| `credential_resolve_entered` / `credential_resolve_returned` | credential解決の開始／完了                             |
| `fetch_entered` / `response_headers_received`                | network request開始／headers受信                       |
| `response_body_read_entered` / `response_body_read_returned` | body読取開始／完了                                     |

stageは処理前後に単純なatomic storeを置き、文字列生成、body encode、hash、DB
writeを行わない。

### 3. Host receive／buffer／durable cursor

Hostはactive executionについて、次をin-memoryで単調に追跡する。

- `lastWorkerSequenceReceived`: `Worker.onmessage`からHost
  sessionへ届いた最後のsequence
- `lastWorkerSequenceBuffered`: validation後にobservation
  bufferへ入った最後のsequence
- `lastWorkerSequenceDurable`: SQLite appendが成功した最後のsequence

auxiliary context observationをHostが受信し、対応するprovider request
startを1秒以内に受信しない場合、 診断watchdogはexecutionを止めずに一度だけstage
latchと三つのcursorを保存する。cancel requested、cancel escalated、terminal
settlementでも同じsnapshotを保存する。watchdogは診断観測であり、provider
timeout、tool timeout、turn timeoutとして使わない。

snapshotはversion、trigger、generation、execution、context request
ordinal、stage ordinal/code、expected Worker
sequence、三cursor、Host観測時刻だけを持つ。bodyやcredentialは複製しない。保存先はv6のversionedな
runtime observationとし、canonical transcriptやcontext graphへ混ぜない。

### 4. 証拠の判定規則

再発時は次の規則で判断する。

| 観測                                                                    | 帰属できる範囲                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| `aux_context_post_returned`で止まり`aux_context_await_resumed`なし      | Worker microtask復帰境界                         |
| `evidence_start_entered`後、`provider_start_post_entered`前             | evidence record構築の同期区間                    |
| `provider_start_post_entered`後、`..._returned`前                       | structured cloneまたはWorker message enqueue     |
| `provider_start_post_returned`、expected sequence > received            | Worker→Host message delivery                     |
| received > buffered                                                     | Host validation／buffer投入                      |
| buffered > durable                                                      | observation flush／SQLite v6永続化               |
| durableにrequest startなしだがlatchは`aux_request_provider_entered`以降 | 履歴経路の欠落であり、provider開始前停止ではない |
| credential／fetch／body stageで停止                                     | 対応するWorker-local I/O境界                     |

一つのsnapshotだけで関数内部まで確定しない場合は、判明した狭い区間だけへ次の一時stageを追加する。
最初から全関数を細分化しない。

## 実装sliceとGo／No-Go

### Slice A — 証拠contractとruntime feasibility

- module
  WorkerとHost間で`SharedArrayBuffer`／`Atomics`が現行Denoで期待どおり見えることを最小probeで確認する。
- stage code、epoch、sequence、snapshot schema、判定規則を型として固定する。
- Go条件: Worker messageを使わずHostが最後のatomic stageを再現可能に読める。
- No-Go条件: shared stateが使えない、またはWorker
  lifecycleと安全に対応付けられない。この場合はproduct codeを
  変更せず代替観測設計を利用者へ戻す。

### Slice B — Worker stage latch

- generation startで共有latchを渡し、turn dispatchごとにexecution
  epochを更新する。
- `web_search`、provider evidence port、production
  `requestProvider`へ上記の最小stageを置く。
- stage更新失敗を通常処理の失敗条件にせず、診断機構が機能処理を狭めない。
- Go条件: fake
  providerによる正常経路でstage順序が単調で、request結果が現行と同一になる。

### Slice C — Host cursorとdurable snapshot

- receive、buffer、successful flushの各cursorを分離する。
- 1秒gap、cancel、escalation、settlementでsnapshotをv6へ保存し、history
  readback可能にする。
- snapshot保存失敗は既存history failure契約に従い、成功したと捏造しない。
- Go条件: 同じWorker sequenceについてreceive／buffer／durableの差をfault
  injectionで識別できる。

### Slice D — focused verification

- context post後のmicrotask未復帰、provider start
  post中、message未受信、buffer未投入、flush未完了、
  credential待ち、fetch待ちをそれぞれ一箇所ずつ制御して、判定規則が実際のsnapshotと一致することを確認する。
- 正常なauxiliary requestではwatchdog snapshotが増えず、既存provider
  evidenceとtool resultが変わらないことを 確認する。
- 同じ量の新規factに対する診断処理が固定個数のatomic
  store、cursor更新、必要時の小さいsnapshotだけであり、
  Session全体、過去turn、既存payloadをscan／decode／rehashしないことを確認する。
- 安定候補に対し、coordinating ownerがauthoritative
  `v0:gate`を一回だけ実行する。

### Human Gate 1 — binary配置と実provider確認

source上の検証後に停止する。compiled
binaryのbuild・`~/.local/bin/henji`への配置と、外部providerを使う
再現確認は利用者の明示指示後に行う。

### Slice E — 実経路での再現とreadback

- 隔離XDG、配置が承認された診断build、production
  Worker経路で、最初の`web_search`を含む通常turnを実行する。
- 正常完了した場合も、12〜26秒級gapが再発すればsnapshotから境界を判定する。
- 停止した場合は、まずhistoryとlatch snapshotをreadbackし、その後Increment
  91のbounded cancelで回収する。
- 再現しない場合は無制限にprovider
  requestを繰り返さず、「未再現、次回発生時に証拠採取可能」と報告する。

### Slice F — 原因の確定または狭い再計測

- Henji関数内に帰属した場合は、該当入力と呼出順を最小再現する。
- Worker transport／microtask／Deno runtimeに帰属した場合は、同じDeno
  versionのHenji非依存module Workerで
  最小再現し、runtime一般かHenji固有かを分ける。
- 区間がまだ複数操作を含む場合だけ、その区間へ追加stageを置いて再計測する。
- 原因、証拠、利用者影響、修正案、修正後の検証方法をIncrement
  92へ記録して停止する。原因修正は、計画外bugの 修正として利用者の指示を待つ。

## 非線形処理を増やさない条件

- stage latchはgenerationあたり固定長で、Session長、turn数、tool
  call総数に比例して大きくしない。
- stage更新は現在のexecutionだけを上書きし、過去stage列をWorker
  memoryへ蓄積しない。
- Host cursorは数個の整数だけとし、過去eventから再計算しない。
- durable
  snapshotはgap発生時とsettlement境界だけの小さいrecordで、request／response
  bodyを持たない。
- readbackはexecution IDとordinal
  indexを使い、Session全履歴の復号を完了条件にしない。

これにより、同じ量の新規factを追加する限り、Sessionが長くなっても本診断処理量は増えない。

## Slice A–D 実装結果

- 現行Deno 2.9.6のmodule
  Workerで、Workerが`Atomics.store`した`SharedArrayBuffer`をHostが Worker
  messageなしにreadbackできることを最小probeで確認し、Slice AをGoとした。
- generationごとに20 bytesの固定長stage
  latchを追加した。Hostがturnごとのepochを設定し、Workerはstage code、 stage
  ordinal、expected Worker sequenceだけをseqlock形式で更新する。request
  body、URL、prompt、response、 credential、Authorizationは含まない。
- `web_search`のcontext post前後、await復帰、evidence開始、provider start
  post前後、production `requestProvider`、credential解決、fetch、response
  headers、body readへ最小stageを追加した。
- Hostはgeneration内で`received`、validation後の`buffered`、SQLite
  append成功後の`durable`という三つの Worker sequence cursorを単調に追跡する。
- auxiliary contextを受信後1秒以内に対応するprovider request
  startを受信しない場合、executionを停止せず
  `worker_stage_snapshot`を一度保存する。cancel requested、cancel
  escalated、terminal settlementでもsnapshotを 保存する。provider request
  startを受信した正常経路ではgap watchdogを解除する。
- snapshotはv6のversioned runtime observationとしてreadbackでき、canonical
  transcriptとcontext graphには 混ぜない。diagnostic
  failureは機能結果として捏造せず、既存history failure契約に従う。
- 判定関数はmicrotask復帰、evidence構築、Worker message enqueue、Worker→Host
  delivery、Host validation／buffer、 history
  flush／persistence、credential、fetch、body readをcursorとstageから分類する。

## Offline verification

- `tests/v0/increment_92_worker_stage_probe_test.ts` 5件で次を確認した。
  - return messageを送らないmodule Workerのatomic stageをHostがreadbackできる。
  - 計画したsource-to-durability境界を各snapshotから分類できる。
  - production auxiliary I/Oのstage順序が固定で、response bytesが変わらない。
  - Workerがprovider start postを完了し、Hostが受信しない人工停止では、expected
    sequence 2に対して
    received／buffered／durableがすべて1として保存され、`worker_message_delivery`へ分類される。
  - provider request startがHostへ届く正常経路では1秒gap snapshotを作らない。
- 関連回帰としてIncrement
  40、41、86、90、91を実行し、新規testを含む65件がpassした。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`がpassした。
- 安定候補に対するauthoritative `v0:gate`を一回実行し、全offline
  testがpassした。
- このoffline verification時点ではbinary build・配置、外部provider、実TTYをHuman
  Gate 1まで保留した。

## Human Gate 1後のbinary配置

- 2026-09-20、利用者承認後にcurrent working treeからstandalone
  binaryをbuildし、`dist/henji`と
  `/home/masat.guest/.local/bin/henji`へ同一artifactを原子的に配置した。
- build
  IDは`67d33f29bf9ad38182da851fd4b28b5d0a081fe2dd5d49b0b5e75c7bcaf9e267`、file
  SHA-256は
  `f145b589328c8b667cb98e7b2fe4ae84e8eab80b7ba574a44183944cd1869ecd`、embedded
  runtime SHA-256は
  `fd406fd44cc115ed8ffec349ec893515291b1d661fa1cc9ad74e61156484cc01`である。両配置先のhash、size、mode、
  `--version`が一致することを確認した。

## Slice E — 実provider再現結果

isolated XDG root
`/tmp/henji-increment92-live.nGeDmC`と配置済みbinaryを使い、最初のtoolとして
`web_search`を一度呼ぶturnを実行した。credential値は出力せず、確認後にisolated
configへ作ったcredential copyを 削除した。履歴DBは証拠として保持している。

### headless経路

- execution `906fa1ce-1d5a-4359-b651-4fdba7359573`はroot provider
  requestを完了し、`web_search`用の context observationをWorker sequence 110、v6
  ordinal 86まで永続化した。
- 次のauxiliary provider request startを永続化する前に、compiled
  processが約6.3秒で `Top-level await promise never resolved`としてexit
  1になった。headless processでは1秒watchdog snapshotを 保存する前にevent
  loop自体が終了したため、TUI経路で再確認した。

### production TUI経路

- tmux上の実TTYでSession
  `dd4b7a44-09d4-4e47-b3f2-b86a7d807a13`を作成した。execution
  `5704e686-8b16-4310-815d-df9db00343f0`はroot provider
  requestを完了し、`web_search` context observationを Worker sequence 98、v6
  ordinal 74へ保存した後、次のdurable request startなしで停止した。
- context observationから約81.5秒後に履歴prefixをreadbackしてからEsc
  cancelした。5秒後のescalationで `interrupted`へsettleし、Increment 91のbounded
  cancellationは実経路でも機能した。
- `cancel_requested`と`cancel_escalated`のsnapshotはともに`stage=fetch_entered`、
  `response_headers_received`未到達だった。Workerはcredential解決とrequest start
  postを越え、OpenRouterの `perplexity/sonar` auxiliary
  requestを`fetch`してresponse headersを待っていた。
- snapshotのWorker sequence
  cursorは`received=99`、`buffered=99`、`durable=95`だった。すなわちrequest
  startは
  Hostへ届きbufferへ入っていたが、履歴上はまだ見えなかった。このため旧履歴だけでは「request開始前停止」に見えた。

## Slice E時点の中間判定

再現executionの直接停止境界はHenjiのcontext構築、Worker
microtask、message送信、credential解決ではなく、
`createProductionPhysicalIo().requestProvider()`内の`await fetch(...)`である。response
headers未受信のため、
OpenRouterへのnetwork／upstream処理のどちらが応答しなかったかはHenjiの現証拠から分離できない。

### curlによるHenji非依存replay

利用者許可後、同じOpenRouter endpointと`perplexity/sonar`へcurl
8.14.1から送信した。

- 同等の最小bodyではHTTP 200、TTFB 1.337秒、総時間1.998秒、response 4,061
  bytesだった。
- execution `5704e686…`のv6 authorityから`web_search` request body 506
  bytesをbyte-for-byte復元したreplayも HTTP 200、TTFB
  1.159秒、総時間1.878秒、response 4,261 bytesで完了した。
- exact replay responseはprovider `Perplexity`、model `perplexity/sonar`、finish
  reason `stop`で、 `https://deno.com/`を含む20件のURL citationを返した。
- credentialはcurl出力・process引数へ出さず0600の一時configから渡し、各request後にconfigを削除した。

したがって、保存request bodyまたはOpenRouter/Sonar
endpointが決定的に停止させる事象ではない。同時点のcurl経路は
正常であり、残る候補は元request時だけの一過性network／upstream遅延、またはDeno
`fetch`経路固有の接続待ちである。 後発の成功replayだけでは両者を区別できない。

### Deno経路A／B比較

利用者承認後、同じexact body、credential、endpoint、Deno
2.9.6、30秒deadlineで三経路を各3回実行した。

| 経路                                                 | 結果         | response headers |       body完了 |
| ---------------------------------------------------- | ------------ | ---------------: | -------------: |
| Deno main threadの直接`fetch`                        | 3/3 HTTP 200 |   1.120〜1.690秒 | 1.613〜2.202秒 |
| 最小module Worker内の直接`fetch`                     | 3/3 HTTP 200 |   1.233〜1.316秒 | 1.632〜2.047秒 |
| 現行`createProductionPhysicalIo().requestProvider()` | 3/3 HTTP 200 |   1.170〜1.416秒 | 1.510〜1.755秒 |

`requestProvider`では全回が`credential_resolve_entered/returned`、`fetch_entered`、
`response_headers_received`、`response_body_read_entered/returned`の順で完了した。したがってDeno
main thread、module Worker、credential
resolver、`AbortSignal.timeout`、現行request
seamのいずれも、Sonar単発requestを決定的に停止させない。

失敗した完全Henji経路との未分離差は、同じWorker／同じglobal `fetch` poolでroot
modelのstreaming SSE requestを 完了した直後にSonarの非stream
requestを開始する二段request列である。次の最小調査は、root SSE
responseを最後まで 消費した後にexact Sonar
requestを同じWorkerで送るcaseと、Sonarだけをfresh
Workerで送るcontrolを比較する。 これによりconnection
reuse／前request後処理と、requestごとの一過性upstream遅延を分ける。

### streaming SSE→Sonar二段比較

利用者承認後、失敗executionから復元したroot request body 20,240 bytesとSonar
request body 506 bytesを使い、 最小module Worker内でroot streaming SSE
responseをEOFまでchunk単位で消費してから、直ちに同じWorker／同じglobal `fetch`
poolでSonar nonstream requestを送った。各trialでは別のfresh
WorkerからSonarだけを送るcontrolも実行した。

| 経路                        | 結果         |  root body完了 | Sonar response headers | Sonar body完了 |
| --------------------------- | ------------ | -------------: | ---------------------: | -------------: |
| 同一Workerのroot SSE→Sonar  | 3/3 HTTP 200 | 3.411〜5.187秒 |         1.132〜1.188秒 | 1.637〜1.802秒 |
| fresh WorkerのSonar control | 3/3 HTTP 200 |              — |         1.194〜1.318秒 | 1.728〜1.939秒 |

root SSEは全回でresponse
headers、最初のchunk、EOFまで到達し、その直後のSonarも全回正常に完了した。Sonarの
headers／body時間はfresh Worker
controlより悪化していない。したがって、同じWorker／global fetch
poolの接続再利用、 streaming response直後というrequest順序、root
responseのEOF消費だけでは停止を決定的に再現しない。ただし一過性の connection
reuse問題を、成功した3 trialだけで完全には否定しない。

### 実transport・完全Host・v6永続化のA/B

実際の`OpenRouterAgentModel`、SSE parser、provider evidence、root model
result、tool call、auxiliary context deltaを 使い、失敗executionのroot body
20,240 bytesとSonar body 506 bytesをbyte-for-byte再現する最小module Workerを
作った。このWorkerはHostへ完全なstructured-clone
payloadを送るが、Hostは永続化しない。

- `deno run`とcompiled standaloneのどちらでもroot→Sonarを反復完了した。
- 最終確認はroot 9.879秒、Sonar 1.636秒で、両body一致、root
  providerは実停止時と同じ`Relace`、provider evidence 79件、Host messageはexact
  root、model result、tool call、context deltaを含めすべて受信した。
- live turn `AbortSignal`、WebCryptoによる完全なcontext occurrence／revision
  digest、完全なroot observation送信を 一つずつ加えても完了した。

一方、完全Henjiでは次を反復観測した。

- Session `7c9bfe66`、execution `f1b1ff71-0eb0-4b6b-ae5a-d1d060939c4d`では
  `fetch_call_returned`まで到達した後に停止した。`fetch()`はPromiseを返したがresponse
  headersへ進まず、processには TCP／UDP socketが一つも作られていなかった。
- 停止中にsteerを送ってもWorkerはmessageを処理せず、cancelもWorker内ではsettleしなかった。Hostの5秒escalationだけが
  回収できた。すなわちprovider timeout、timer、cancel messageも同じWorker
  runtimeでは進行しない。
- requestごとの専用`Deno.HttpClient`と`poolMaxIdlePerHost: 0`を使っても同じ
  `fetch_call_returned`で停止した。global pool／root SSE connection
  reuseは必要条件ではない。この専用client変更は 診断後に戻した。

TUIを外した`createWorkerSession`でも、Host event
loopを明示的に生かすと同じ停止を再現した。さらに
`WorkerHostSession`を直接構築して比較した結果は次のとおりである。

| Host側の履歴処理                                            | 結果                             |
| ----------------------------------------------------------- | -------------------------------- |
| 履歴portなし                                                | root→Sonar→rootの3 requestを完了 |
| 同じjournal契約のin-memory実装                              | 3 requestを完了                  |
| 単純な`node:sqlite` WAL/FULL insertを各Worker messageで実行 | 完了                             |
| `SqliteHistoryV6ProductionStore`を接続                      | 停止                             |
| v6 admission／Host判断だけをSQLite、Worker観測はmemory      | 完了                             |
| provider観測だけをSQLiteから除外                            | 完了                             |
| context観測だけをSQLiteから除外                             | 停止                             |
| exact request保存を除外                                     | 停止                             |
| raw response bytes／raw SSE frame保存を除外                 | 停止                             |
| parser transitionも除外しrequest／response metadataだけ保存 | 停止                             |
| root `provider_request_start`だけ保存                       | 完了                             |
| auxiliary `provider_request_start`だけ保存                  | 停止                             |

auxiliary request-startだけを残すcaseは二回とも停止した。最後の計測ではv6
appendは3 recordを4.03 msで正常に返しており、
SQLite内でblockし続けてはいない。当時はその直後にWorkerが再pollされなくなったと解釈し、snapshotは
`provider_start_post_returned`だった。完全v6
caseでは同じ現象が少し後ろへずれ、snapshotは
`fetch_call_returned`だった。後続調査では、いずれもappend失敗後のWorker
terminateで説明できると判明した。

次も必要条件ではなかった。

- Worker側でfetch開始を250 ms遅らせても停止したため、4 msのSQLite
  transactionとの単純な同時実行raceではない。
- v6 core
  connectionを一時的に`synchronous=OFF`にしても停止したためfsyncは必要条件ではない。
- segment
  codecを一時的に`identity`にしても停止したため`gzipSync`は必要条件ではない。
- auxiliary provider処理中に10 ms
  timerを置いてもtimer、fetch、cancelのいずれも進まなかった。

これらの一時診断変更はすべてsourceから戻した。repositoryへ残した追加計測は
`fetch_call_returned` stageだけである。

## 調査中の暫定原因仮説（棄却済み）

> **履歴上の位置付け:** この節は、stage latchと初期A/Bから一時的に採用したDeno
> wake欠落仮説を記録する。 後続の機構分離とoffline
> replayにより棄却した。現在の判定には使わず、「原因確定」節を正とする。

この時点では、同一Deno processでHostがauxiliary
`provider_request_start`をv6へ同期appendした後、Agent module Workerのevent
loopが次のasync処理を再pollしなくなることを直接原因と判断した。完全構成で`fetch()`がPromiseを
返した後もnetwork socket作成前に止まり、同じruntimeに属するprovider
deadline、timer、steer、cancelも進まない
ように見えたためである。この判断は後に、履歴append失敗に伴う明示的なWorker
terminateをwake欠落と誤認したものと 判明した。

内部機構については、Deno 2.9.6および2.9.7で共通するruntime
scheduling／wake欠落と推定した。Deno公式issue
<https://github.com/denoland/deno/issues/34369>と修正PR
<https://github.com/denoland/deno/pull/34387>には、別の`Deno.serve`＋`node:net`構成で、async
I/Oがreadyでも外側の
`JsRuntime`がwakeされず再pollされない同型の不具合が記録されている。ただし今回のmodule
Worker＋`node:sqlite`経路と
同一bugである証拠はなく、Henji非依存の完全な最小再現も得られなかった。この類似だけを根拠にしたDenoへの原因帰属は、
原因確定により撤回した。

Session `362499de`も同じ「web_search contextはdurableだが次のrequest
startがない」という症状だったため、今回の再現は
同一原因の強い証拠である。ただし旧executionにはstage
latchがないので、過去事象そのものをprovider fetchだったと 遡及的に断定はしない。

また、実snapshotではdurableなcontext recordがWorker sequence
98を含む一方、durable cursorは95だった。
現行の単一分類関数は`buffered > durable`を先に見て`history_flush_or_persistence`と判定するため、
`stage=fetch_entered`という実処理境界を覆い隠す。このcursor契約／分類優先順位は診断実装のcorrectness問題であり、
原因修正とは分けて補正が必要である。

### 暫定仮説下でのDeno 2.9.7再検証

2026-09-20にVMのDenoを2.9.6から2.9.7へ更新し、sourceから同じ実provider
A/Bを再実行した。

- auxiliary `provider_request_start`だけをv6へ保存する縮約caseは、appendが3.96
  msでreturnした後、
  `provider_start_post_returned`から進まず、30秒でtimeoutした。
- 完全なv6履歴caseも30秒で進まず、cancel要求後に`interrupted`として回収した。
- 同じprovider、同じ三段request列でroot
  `provider_request_start`だけを保存するcontrolは
  `requestCount=3`、`stopReason=final`で完了した。
- Increment 92のfocused test 5件、`v0:check`、`v0:fmt`はDeno 2.9.7でpassした。

この比較から、2.9.7への更新は今回の停止のworkaroundにならず、2.9.6だけに固有のregressionでもないと判断した。
Deno 2.9.7のrelease noteには今回のmodule
Worker＋同期SQLite経路を明示した修正はなく、上記はrelease noteからの
推定ではなく同一再現条件による実測である。配置済みcompiled binaryはDeno
2.9.6を埋め込んだままだが、2.9.7で
不具合が再現したため、この比較だけを目的とするrebuild／再配置は行わない。

## Deno upstream issue用の再現・証拠収集計画（撤回済み）

この計画はDeno wake欠落仮説を検証するために承認されたが、Henji側のproduct
bugをofflineで確定したため中止した。
以下は実施範囲と棄却までの経緯を追跡するための履歴であり、再開する計画ではない。

### 報告可能とする成功条件

Deno側がHenjiを理解せず、一つのcommandで現象と正常対照を実行できる小さなprogramを作る。最終artifactは
Henji module、実provider、credential、保存済みSession、remote
networkへ依存しない。次を満たした時点でissue draftを作成可能とする。

1. Deno 2.9.7で、同期SQLite操作がreturnした後にmodule
   Workerのasync処理が進まないfailure caseを3回連続で 再現できる。
2. SQLite操作を外すcontrolと単純な一行insert controlは各3回連続で完了する。
3. failureをWorker messageだけで判定せず、`SharedArrayBuffer` stage
   latchをHostがreadbackできる。
4. 外側のwatchdogでboundedに回収でき、内部timerが進まないことをfailure出力から区別できる。
5. Deno
   2.9.6と2.9.7で同じ結果を確認し、可能なら失敗が始まるversion境界を特定する。
6. issue本文とartifactにAuthorization、credential、実request／response、Henji履歴payloadを含めない。

小さなprogramへ縮約できなかった場合は、成功したところまでの最小Henji依存caseを成果物とし、Deno内部bugを
断定しない。再現を作るために観測していない挙動をfixture化したり、成功caseをfailureとして扱ったりしない。

### 公開artifactの形

縮約作業は`/tmp`で行い、failureとcontrolが固定した時点だけ
`reproductions/deno-worker-sqlite-wake/`へ次を追加する。

- `main.ts`: module Worker生成、synthetic SQLite操作、stage latch
  readback、Host側deadline、結果のJSON Lines出力。
- `worker.ts`: request-start相当messageを送った後、timerとlocal async
  I/Oを開始し、各境界をatomic stageへ記録する。
- 必要な場合だけ`local_server.ts`: loopback responseを返す独立child
  process。remote serviceは使わない。
- `README.md`: 一つの実行command、expected
  failure／control出力、確認versionとOS、終了方法。

二ファイルで成立する場合は`local_server.ts`を追加しない。依存はDeno標準APIと`node:sqlite`だけとし、npm／JSR
package、 repositoryのimport map、Henji sourceを最終artifactから除く。SQLite
DBは毎run新しい一時directoryへ作る。

### Slice G — credential不要のbridge reproducer

1. 現在の縮約caseから実providerを外し、Workerがsyntheticなauxiliary
   request-start messageを送る。
2. Hostは現行`SqliteHistoryV6ProductionStore`へ同じ三recordのappendを同期実行する。
3. Workerはmessage送信直後にtimerをarmし、loopback fetchまたは同等の実async
   I/Oを開始する。
4. stage
   latchで`postMessage returned`、`fetch called`、`timer fired`、`headers received`をmessage経路と独立して読む。

Go条件は、実providerなしでもfailure 3/3、historyなしcontrol
3/3完了である。No-Goならproviderを戻さず、root→auxiliary 順序、Host
session、append前record列のうち必要な境界を一つずつ戻して、外部serviceを使わない最小の再現可能構成を探す。

### Slice H — Henji非依存のSQLite操作列へ縮約

Bridge reproducerがGoなら、現行store
importを次の順で除く。各変更ではfailureを3回、直対応controlを3回実行し、
failureが消えた変更を戻してから次の分割へ進む。

1. 実際に失敗したappend
   batchを、実データを含まない固定record／固定byte列へ置換する。
2. `SqliteHistoryV6ProductionStore`を外し、`SqliteHistoryV6Store.append()`相当のSQL操作列だけをprogram内へ移す。
3. object、byte
   stream、sequence、projection、FTS更新のうち実行されない経路を削除する。
4. record encoding、digest、segment policyを固定値へ置換する。既に反証済みのgzip
   levelとfsyncは原因候補として 再調査しない。
5. schemaのtable、index、foreign
   keyと、transaction内のstatementを二分探索で削り、failureに必要な最小操作列を残す。
6. record数とpayload byte数を減らし、必要最小値を記録する。

単純な`node:sqlite`一行insertは既に成功しているため、「SQLiteを呼ぶだけ」をreproducerにしない。複数statementや
transaction順序が必要なら、その操作列を小さいprogramの本質として残す。

### Slice I — async境界と正常対照の確定

最小SQLite操作列を固定した後、Worker側のasync処理を次の順で比較する。

- `setTimeout(0)`だけ。
- loopback TCP／HTTPへの`fetch`。
- `MessagePort`受信。
- 同じasync処理をmain runtimeで実行するWorkerなしcontrol。

issueの主reproducerには最も小さく決定的なasync処理を一つだけ使う。複数で停止する場合は残りを補助matrixにする。
failure判定のdeadlineはWorker内timerへ依存させず、Host deadlineと外側process
timeoutの二段にする。

### Slice J — version・process情報の収集

global Deno
2.9.7は変更せず、過去versionは一時directoryへ置いた個別binaryで実行する。

1. 2.9.6と2.9.7を必須matrixとする。
2. 2.9系列、2.8系列、関連issue
   #34369の正常基準だった2.7.14へ順に遡り、最初のpassが得られた場合だけ
   pass／fail間を追加で狭める。
3. 全versionで失敗する場合はregression開始versionを推測せず、「確認した最古versionでも再現」と記載する。
4. `deno --version`、kernel、architecture、glibc、実行command、各trialのstage／append時間／終了状態を保存する。
5. stall中に`/proc/<pid>/task/*/wchan`、open file descriptor、TCP
   socket有無、CPU時間を取得する。

現VMに`strace`は入っていないため、初回issueの必須条件にしない。Deno
maintainerからsyscall traceを求められた場合は、 system
package追加の許可を利用者へ戻す。

### Slice K — issue draftとHuman Gate

英語draftには次だけを事実として記載する。

- expected／actual behaviorと一command reproducer。
- version／platform matrix、failure／control出力、再現率。
- SQLite call自体は数msでreturnし、その後Workerのtimer／async
  I/O／cancelが進まないこと。
- latchとprocess観測から確定できる最後の境界。
- 関連例としてDeno issue #34369／PR #34387。ただし同一bugとは断定しない。
- Henjiでの利用者影響は背景として一段落に留め、providerやproduct
  schemaを再現手順へ持ち込まない。

タイトル案は
`Module Worker stops being polled after synchronous node:sqlite work on the host thread (Deno 2.9.6 and 2.9.7)`
とする。Deno
runtime内の具体的な欠陥箇所や回帰開始versionは、reproducerの証拠を超えて主張しない。

artifact、実行結果、issue draftを利用者へ提示した時点で停止する。GitHub
issue作成、comment、gist／別repository作成は
外部変更なので、明示承認後にだけ行う。Deno sourceのpatch／debug
buildとHenjiの根本修正はこの計画の対象外とする。

### 計画内の検証

- artifact自身の`deno check`。
- failure／control runnerによる上記trialとversion matrix。
- 公開予定directoryにcredential、Authorization、remote
  endpoint、実履歴payloadがないことの確認。
- `git diff --check`。

product sourceを変更しないため`v0:gate`は実行しない。reproducer作成中にHenji
product bugを見つけた場合は、原因、影響、 修正案を報告して別承認を待つ。

## Upstream再現実装の到達点（2026-09-20、撤回済み）

利用者承認後にSlice Gを開始し、`/tmp`で縮約した後、作業中artifactを
`reproductions/deno-worker-sqlite-wake/`へ追加した。以下は原因確定前に実験を停止した地点の記録である。
artifactは公開用reproducerとして成立しておらず、原因確定後は公開候補から外した。

### 原因帰属の訂正

追加したbatch metadata計測により、停止直前に約4 msでreturnしたSQLite batchは
`auxiliary provider_request_start`ではなく、次の非provider三recordだった。

1. `runtime_event` → `agent_event` → `turn_start`
2. `runtime_event` → `agent_event` → `user_message`
3. `context_observation` → `model_request_delta`（purpose=`user_turn`）

Deno 2.9.7での実測は38,507 bytes、append 3.78〜4.34 msだった。旧診断mode
`sqlite-aux-request-start-only`は「provider observationのうちauxiliary
startだけを許可し、非provider eventはすべて許可する」
filterであり、名称からappend対象を誤認していた。Worker stage latchはその後
`provider_start_post_returned`または`fetch_call_returned`まで進んだことを示すが、そのmessageはHostへ到着していない。
従って現在確定している境界は、「初期三recordの同期v6
appendがreturnした後、production経路のAgent Workerから次の
messageが届かず、同Worker内のprovider
deadline・timer・cancelも進まない」である。

ただし、初期三recordのappend自体を直接原因または十分条件とは扱わない。次のcredential不要controlは同じappend後もすべて
完了したためである。OpenRouter、認証済み成功response、remote
transportのいずれが必要条件かもまだ確定していない。

### 成立したproduction再現

- Deno 2.9.7、実OpenRouter credential、実Agent Worker bootstrap、v6
  historyの完全構成は停止する。
- provider observationを縮約したcaseでも、初期三recordのappend
  return後に停止する。
- 対応するroot-only controlはroot→Sonar→rootの3 requestを完了する。
- Deno 2.9.6でも同じproduction症状を確認済みで、2.9.7更新はworkaroundではない。
- 完全caseでは`fetch_call_returned`後、response headers前で止まり、cancelはHost
  escalationでのみ回収できる。

### 成立しなかった縮約と否定できた十分条件

| 縮約／control                                                                                   | 結果                       |
| ----------------------------------------------------------------------------------------------- | -------------------------- |
| 小さいmodule Workerが同じ三種messageを送り、Hostがv6へappend                                    | 完了                       |
| 実測38 KBの同一context deltaを小さいprotocol Workerから送信                                     | 完了                       |
| `WorkerGeneration`を直接実行し、合成root→web_search→rootを実行                                  | 完了                       |
| 同direct generationへbase instruction、workspace instruction、skill／tool startup contextを追加 | 完了                       |
| 実Agent Worker bootstrap＋timerだけで返す正常な合成response                                     | SQLiteあり／memoryとも完了 |
| 実Agent Worker bootstrap＋localhost native fetch                                                | SQLiteあり／memoryとも完了 |
| localhost 200 responseを1秒遅延                                                                 | SQLiteあり／memoryとも完了 |
| `https://example.com`への本文なしremote TLS GETを各request前に実行                              | SQLiteあり／memoryとも完了 |
| OpenRouter endpointへdummy tokenで元requestを送り、401後に合成responseへ戻す                    | SQLiteあり／memoryとも完了 |

一度「credential不要で3/3再現」と判断したscratch caseは、合成fetchが`Uint8Array`
bodyを`String()`で処理してJSON parseに 失敗し、rejected
Promiseになっていた。UTF-8
decodeへ直すとSQLiteありでも3/3完了したため、この結果は再現証拠から除外する。
同様に`httpbin.org/delay/1`はmemory
controlも5秒を超え、この環境からの外部応答遅延と区別できないため採用しない。

### 機構分離前の暫定結論（棄却済み）

production事象は実在し、停止区間もWorkerのprovider
request開始前後へ狭められている。しかし、Deno本体のbugと報告できる
Henji非依存・credential不要の再現はまだない。同期SQLite、38 KB payload、module
Worker、active `WorkerGeneration`、timer、 localhost fetch、remote
TLS、遅延responseは、それぞれ単独または現在試した組合せでは十分条件でなかった。

この段階では「production構成でAgent Worker
runtimeが再pollされない」までを暫定結論とし、発火条件は未特定とした。
しかし後続調査により、再poll停止ではなく、v6
appendのthrowを受けたHostがWorkerを明示的にterminateしていたことが
判明した。Deno issueの英語draft、version matrix、process
evidenceは作成せず、GitHub投稿のHuman Gateにも到達していない。

### v5／v6 × Chat Completions／Responses API比較

利用者の指示により、Deno 2.9.7、同じcurrent Worker／provider
code、同じtask、同じ実credentialを使い、root modelのAPI形式と history
storeだけを切り替えた。web_searchのSonar backendは全条件でOpenRouter Chat
Completionsのままである。

| history store                                     | root OpenRouter Chat Completions         | root OpenRouter Responses API            |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| current code＋v5 `SqliteHistoryStore`             | `ok=true`、3 requests、final             | `ok=true`、3 requests、final             |
| current code＋v6 `SqliteHistoryV6ProductionStore` | 30秒停止、Host escalationで`interrupted` | 30秒停止、Host escalationで`interrupted` |

v6の両条件は再試行でも停止し、停止時のHost表示request
countはいずれも0だった。この値はHostが
`provider_request_start`を受信していないことを示すが、Worker-local stage
latchは別trialで
`provider_start_post_returned`／`fetch_call_returned`まで進んだことを示しているため、network
requestが内部で開始されていない とは断定しない。正常実績のあるdetached commit
`01b3e773`でも、v5＋Chatとv5＋Responsesは各3 requestsで完了した。

この比較から、root Chat Completions API固有説は支持されず、v6
persistence経路が強い発火条件であることまでは分かった。
この時点では実provider経路とv6同期処理の相互作用によるDeno
Workerの再poll欠落を有力仮説としたが、後続調査で exact capture契約違反とWorker
terminateへ置き換えた。

### v6発火箇所の縮約テスト実行記録（N1まで実行、以降撤回）

このrunbookは原因確定前に、外部providerを使う診断の目的と境界を固定するために作成した。N1まで実行したが、
診断filterがrequestの依存連鎖を切る交絡を含むと判明したため、N2以降は撤回した。

#### 目的

current Worker／provider codeと実OpenRouter経路を固定し、v6
historyへ永続化する初期Worker observationのうち、どの分類または
組合せが停止の発火に必要かを特定する。Deno内部bugをこの段階で断定せず、v6の処理を小さくしたときに停止が残るかだけを測る。

#### 既知の基準

- Deno 2.9.7、current code、実OpenRouter、v5 storeはroot Chat／Responsesとも3
  requestsでfinalになる。
- 同条件のv6 storeはroot Chat／Responsesとも30秒停止し、Host
  escalationで`interrupted`になる。
- root API形式は結果を変えないため、以後は`openrouter-chat`へ固定する。
- 停止直前にv6へ入る最初の自然batchは、`turn_start`、`user_message`、`user_turn`
  context deltaの3件、約38.5 KBで、 append自体は約4 msでreturnする。
- 小さいWorker、direct `WorkerGeneration`、正常な合成response、localhost
  fetchではv6を接続しても完了する。
- Host表示`requestCount=0`はHostがrequest-startを受信していないことだけを意味し、Worker内部のfetch未開始を意味しない。

#### 許可範囲

- 現在設定済みのOpenRouter credentialを、既存production credential
  resolver経由でrequest時だけ使用してよい。
- credentialの値を読む、表示する、copyする、別pathへ保存する、command
  lineへ埋め込むことは禁止する。
- request body、response body、Authorizationを新しいlogへ出さない。既存v6
  authorityが通常どおり保存することは変更しない。
- `/tmp`のrunner、隔離state directory、detached worktreeを診断に使ってよい。
- repositoryのproduct source、schema、通常XDG state、配置binaryは変更しない。
- commit、push、release、publish、GitHub issue作成は行わない。
- 実行環境または監督機構がcommandを拒否した場合、迂回せず、拒否されたcommandと必要な代替だけを報告する。

#### 固定条件

- current repository source、Deno 2.9.7、`openrouter-chat`、built-in default
  Definition、built-in tool／planner Definitionを使う。
- taskは
  `Use web_search exactly once to search for the official Deno documentation home page, then briefly report the result.`
  に固定する。
- `WorkerHostSession`、workspace、credential resolver、provider timeout、Worker
  bootstrapを試験間で変えない。
- exact requestとprovider
  observationのv6保存は、最初の二分試験では両方とも無効化する。
- v6の`beginExecution`とHost admission recordは全試験で共通に残す。
- 一試験で変えるのは、Worker
  observationのどの分類を`appendExecutionEvents()`からv6へ渡すかだけとする。

#### runnerと未実行mode

scratch
runnerは`/tmp/henji-i92-direct-host-runner.ts`である。N1で両modeを1回ずつ実行し、
runtime-onlyの再現確認（2回目）まで行った（結果は「Slice N1実行結果」節）。

- `sqlite-v6-runtime-only`:
  Worker由来`runtime_event`だけをv6へ渡す。context、provider、exact
  requestはmemory/no-op。
- `sqlite-v6-context-only`:
  Worker由来`context_observation`だけをv6へ渡す。runtime、provider、exact
  requestはmemory/no-op。

runnerはv6へ渡したbatchについて、mode、append時間、件数、JSON換算byte数、event
kindだけをJSON Linesで出す。payload本文は 出さない。

#### Slice N1 — 初期batchの二分

1. `sqlite-v6-runtime-only`を一回実行する。
2. 30秒以内にfinalになればpass、30秒無進行ならHost
   cancelを要求し、5秒の既存escalationで`interrupted`として回収する。
3. process全体は外側40秒timeoutでもboundedにする。
4. processが残っていないことを確認してから`sqlite-v6-context-only`を同じ条件で一回実行する。
5. 最初の二試験では反復回数を増やさない。少なくとも一方が停止した場合だけ、その条件をもう一回実行して再現性を確認する。

判定は次のとおり。

| runtime-only | context-only | 当時予定した判定と次の一手                                                          |
| ------------ | ------------ | ----------------------------------------------------------------------------------- |
| stop         | pass         | `turn_start`／`user_message`側を次に二分する                                        |
| pass         | stop         | context delta処理をmetadata／occurrence／blob／revision／flushへ分ける              |
| pass         | pass         | runtimeとcontextの組合せが必要。三record combinedを再確認後、二件ずつの組合せを試す |
| stop         | stop         | 両者に共通するv6 record append／segment flush／SQLite transactionを分ける           |

#### Slice N1実行結果（2026-09-20実行、N2未実施）

利用者の実行指示によりN1を実行した。Deno 2.9.7、source `01b3e773…`+Increment
92診断を含むworking tree、root `openrouter-chat`、task固定、実OpenRouter
credential（production resolver経由・request時のみ）。 各mode
1回、停止したruntime-onlyのみもう1回の再現確認を行った。process外側40秒timeout、残留processなし。

| mode                     | 回    | 結果                                                                                                                                                                           |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sqlite-v6-runtime-only` | 1回目 | 停止。v6 append: worker runtime_event 2件（1,313 bytes、0.40 ms）return後、30秒無進行。cancel→5秒escalation→`interrupted`。requestCount=0                                      |
| `sqlite-v6-runtime-only` | 2回目 | 停止。同一batch（1,313 bytes、0.49 ms）、同一signatureで`interrupted`                                                                                                          |
| `sqlite-v6-context-only` | 1回目 | 完了。`ok=true`、`stopReason=final`、requestCount=3。context_observation 3 batch（37,251 / 2,498 / 7,850 bytes、1.9〜3.7 ms）すべてappend return。execution 7秒弱で`completed` |

当時の判定はruntime-only=stop（2/2）、context-only=pass（1/1）であり、runbook判定表の「stop
/ pass」に 該当するとした。しかし原因確定後は、runtime-only filterがroot request
startをmemoryへ落としたために別の
v6契約違反を作った結果と判明した。従って、この結果からevent分類の二分へ進む判断は無効である。

readback証拠（`/tmp/henji-i92-n1/`にlog、temp DB rootは各logの`sqlite_root`行）:

- 両runtime-only停止runとも、stage latchは`fetch_call_returned`（stageOrdinal
  30、epoch 1）。Workerは auxiliary fetch開始直後、response
  headers前に到達できず。
- 両runともcursorはreceived=60/81、buffered=60/81、durable=56/77（差はちょうど4）。
- durable recordsはadmission 3件、runtime_event 2件、`worker_stage_snapshot`
  2件（cancel_requested／ cancel_escalated）、cancel 3件、reconcile
  1件。Host由来eventはfilterなしでv6へ入る契約通り。
- `auxiliary_gap` triggerのsnapshotは無し。root requestが約29秒続き、web_search
  context観測の到着から
  30秒timeoutのcancelまで1秒未満だったため、watchdogがcancelにclearされたと整合する。
- v6へ渡したbatchのlog（`v6_append_returned`）は初回2件分のみで、以降のkept
  batch logは無い。

N1時点の観測と暫定解釈:

- context-onlyは同規模のcontext appendを含んだまま3
  requestを完走した。このため当時は、停止直前と見ていた 38.5 KB三record
  batchのうち、context deltaのv6 appendは発火に不要と解釈した。
- runtime-onlyはworker runtime_event 2件（1,313 bytes）のdurable
  append後に停止した。ただし後に、filterが
  request依存連鎖を切って別のv6契約違反を作った結果と判明したため、runtime_eventを発火条件とは扱わない。
- 一方、両停止runで (1) 最後の4 sequenceのobservation
  batchがdurable化されず（durable=received-4）、 (2) 以降のkept batchのappend
  return logが無く、(3) Workerがstage latch上`provider_start_post_returned`
  を通過した直後のrequest-start相当message（seq
  61/82）がHostへ届いていない（received停滞）、 (4) Slice
  E完全v6停止runと同じ`buffered > durable`の最終batch未flush
  signature（99/99/95）が現れる。 これらは、Worker
  runtimeの再poll停止に加えて、Host側最終observation batchのappendがreturnしない
  （throwまたは非復帰）可能性を示す。`handleJournalFailure`経由のcapsule
  terminateと、 Worker自身のfreezeの両方と整合し、N1の証拠だけでは分離できない。
- したがって「runtime_event系の保存が発火に必要」というN1判定は、Host側append失敗によるWorker終了という
  代替機構を排除できていなかった。N2へ進む前にrunnerのProxyへthrow log
  seamを追加して再実行し、その結果を 後段の「原因確定」節へ記録した。

#### Slice N2 — event分類の縮約（未実施・撤回）

次は当時予定した分岐である。N1の交絡が判明したため実施しない。

- runtime側なら、`turn_start`だけ、`user_message`だけ、両方の三条件を比較する。
- context側なら、delta全体を固定fixtureへ置換する前に、production
  deltaを入力としたまま、v6 pipeline内の
  occurrence/blob保存とrevision/splice保存を別々に無効化できるscratch
  seamを作る。
- combinedだけ停止するなら、`turn_start + context`、`user_message + context`の二条件を比較する。
- 各段階で最初の一回がpassなら反復せず、stopだけ二回目を行う。

#### Slice N3 — v6内部処理の縮約（未実施・撤回）

次はN2で停止する最小event集合が得られた場合の予定だった。product
sourceを直接編集せず、必要なv6 moduleを`/tmp`へcopyした scratch
variantまたは明示的な診断seamを使い、次の境界を一つずつ比較する。

1. logical record構築まででflushしない。
2. record encode／digestまで行い、圧縮とexact object保存をしない。
3. segment構築まで行い、SQLite transactionをしない。
4. SQLite transactionを行うがprojection／anchor／index更新をしない。
5. projection、anchor、index更新を一つずつ戻す。

単純な一行insert、`synchronous=OFF`、identity
codecは既に十分条件でないため、同じ試験を繰り返さない。処理を外した結果
停止が消えたら、その直前の最小差分を一度だけ戻して再現を確認する。

#### 各試験で保存する証拠

- Deno version、git source identity、mode、root provider。
- 開始・終了時刻、result、stop reason、Host request count。
- v6へ渡したevent kind、件数、合計byte数、append所要時間。
- Worker stage latchの最後のstage、expected Worker sequence、Host
  received／buffered／durable cursor。
- cancel要求結果とHost escalation結果。
- 一時DB pathとprocess exit code。DB payload本文は通常報告へ転記しない。

#### 停止条件

- N1の二条件が終わった時点で一度結果を報告する。N2はN1の判定から一意に選べる枝だけ進める。
- 実行中にcredential、Authorization、request／response本文が標準出力へ出た場合は直ちに中止する。
- 40秒でprocessを回収できない場合は新しいtimeoutやkill
  loopを追加せず、残存PIDを報告して停止する。
- 二回連続で結果が変わる場合は試行回数を無制限に増やさず、間欠性そのものを結果として報告する。
- v6 moduleの大規模copy、Node版移植、Deno source
  buildが必要になった時点で、このrunbookの範囲を超えるため停止する。
- 最小v6操作列が小さく確定した場合だけ、Deno／Node比較programを別計画として作る。

### 調査artifactの扱い

- `reproductions/deno-worker-sqlite-wake/run.ts`
- `reproductions/deno-worker-sqlite-wake/synthetic_definition.ts`
- `reproductions/deno-worker-sqlite-wake/README.md`

artifactには、実credentialを使う`sqlite-real`／`memory-real`とcredential不要の
`sqlite-local`／`memory-local`を分ける作業途中の変更がある。最新のmode分割後はまだtype
checkも実行結果も確定しておらず、 READMEは旧local-only説明のままである。Deno
issue用の再現としては使用せず、原因確定までの調査履歴としてのみ扱う。

## 原因確定 — v6 pipelineのauxiliary request exact capture欠落（2026-09-20、N1後の機構分離）

N1報告後、利用者承認の「機構分離run」として、runnerのProxyにflush entry・throw
log seamを追加し
`sqlite-v6-runtime-only`を1回、次に無filterの`sqlite-history`（完全production
v6経路）を1回実行した。 さらに全history入力（`beginExecution`、各flush、exact
request、Uint8Arrayはbase64 marker付き）を
`/tmp/henji-i92-n1/capture.jsonl`へcaptureし、`/tmp/henji-i92-replay.ts`でprovider・Worker・credential
なしのoffline
replayを行った。`asHistoryError`への一時cause保持（取得後ただちにrevert、現sourceは不変）
で元errorを取得した。

### 直接原因（product bug、offline決定論的再現済み）

`IsolatedV6HistoryPipeline.#matchRequestStart`（`v0/agent/history/v6_history_pipeline.ts:549`）は
すべてのprovider `request_start`観測に対し、先行するexact byte capture（Hostの
`appendExactRequestObservation`）とのFIFO一致を要求する。

- root model requestは`openrouter_transport`がexact capture（captureBoundary
  `openrouter-chat:http-body-v1`）を発行し、`startRequestMetadata`（空body）で一致する。
- `web_search`のauxiliary
  requestは`v0/agent/tools/web_search.ts:153-159`が`startRequest`を body 491
  bytes込みで呼ぶが、aux
  seam（`worker_physical_io.ts`の`requestProvider`）はexact captureを
  一切発行しない。capture実測でもexact requestはroot分の1件のみ。
- そのためaux request_startで`#unmatchedRequests.shift()`がundefinedとなり、
  `provider request evidence does not match exact byte capture`がthrowする（`asHistoryError`により
  `history_io_failure`へwrap）。

### 停止の伝播

throw → `flushObservationBuffer`のcatch →
`handleJournalFailure`（`worker_host_session.ts`）→
Workerへcancel送信＋`capsule.terminate()` → Workerがaux
fetch実行中に終了する。Worker内のtimer・ provider
timeout・cancel処理・次messageがすべて止まるのはWorkerがterminateされているためであり、
再poll停止ではない。Hostは30秒timeout→cancel→5秒escalation→`interrupted`でのみ回収する。
stage latchが`fetch_call_returned`で凍結するのはterminate時点の位置である。

### 従来観測の再説明

- Slice E完全v6停止の`buffered > durable`（99/99/95）:
  throwしたbatchはcursor更新に至らない。
  同batch内の先行入力のrecordはpipelineの途中flush（保留record数しきい値）で一部durable化し得るため、
  DBにseq 98のcontext recordがありながらdurable cursorが95のままだった。
- headlessの`Top-level await promise never resolved`: Worker
  terminate後の未解決promise。
- `sqlite-aux-request-start-only`停止: aux request
  startをv6へ残すため同throw。「3 record 4 msで
  return」は先行する別batchであり、throwしたflushのlogは存在しなかった。
- `sqlite-root-request-start-only`・provider観測除外control群の完了: aux request
  startがSQLiteへ 渡らないためthrowしない。
- v5完了、Deno 2.9.6/2.9.7で同一、curl再現でendpoint正常: いずれもv6
  pipeline固有の契約違反のため。
- N1 `sqlite-v6-runtime-only`停止: 別機構。model_result/tool_callはrequest
  ordinal 1へ紐づくprovider runtime eventで、filterがroot request
  startをmemoryへ落としたため`#appendObservationRecord`が
  `provider observation precedes request capture: 1`（`v6_history_pipeline.ts:611`）をthrowした。
  診断filterが依存連鎖を切ったartifactであり、production
  bugとは別。N1の「runtime側が発火条件」 という判定はこの交絡により無効。
- N1 `sqlite-v6-context-only`完了: context観測はrequest一致に関与しないため。

### 結論と撤回

production停止の直接原因は「Deno module Workerの再poll停止」ではなく、上記v6
pipeline契約とaux 経路の不整合である。Deno
runtime・OpenRouter・SQLite同期処理・38 KB batch・module Worker・credentialは
直接原因ではない。「Deno issue #34369と同型」という推定とupstream再現計画（Slice
G〜K）は本確定により
不要となった。`reproductions/deno-worker-sqlite-wake/`は公開候補から外し、調査履歴としてのみ扱う。

## 根本修正計画（2026-09-21、review反映済み・実装済み）

### 採用する設計

1. `IsolatedV6HistoryPipeline.#matchRequestStart`の厳密な不変条件を維持する。inline
   body付き`request_start`を別の証拠契約として受理する案は採らない。
2. Worker内のauxiliary `requestProvider`を、request
   bodyの一回のbyte化、credential解決、cancel再確認、exact
   capture、`request_start`、`fetch`開始を一つの同期的ordering
   ownerで行う契約へ変更する。
3. exact captureと`fetch`には同じ`Uint8Array`を渡す。exact
   captureと`request_start`は別々のWorker message／Host永続化であり、Host
   transactionとしてatomicとは扱わないが、Workerからの発行順序は一箇所で保証する。
4. credential解決とcancel確認は証拠発行より先に行う。credential不足や開始前cancelで、実際にはdispatchしなかった
   requestを履歴へ作らない。Authorizationはfetch時だけ加え、exact bytesとrequest
   metadataには含めない。
5. `web_search`固有backendとdirect test
   fallbackへ証拠発行を分散させない。productionとdirect testのtransportは
   同じdispatch
   ownerの背後に置き、`web_search.ts`から直接の`evidence.startRequest(...)`を除く。
6. pre-commit history failureは、active
   execution生成時に作るfirst-code-winsのlatched signalでHostへ通知する。
   waiter登録前の失敗も後から必ず観測でき、Worker
   terminateは通知手段ではなく後続cleanupとする。
7. pre-commit journal failure専用のtyped
   contractを`LoopOutcome`と`turn_end`へ追加する。admission failureおよび
   post-commit observation failureとは混同せず、canonical
   commitを一切許可しない。
8. non-canonical settlementが過去Session
   messageを全decodeする現行経路を除去する。current executionのindexは current
   execution／turnのfactだけで構築し、同じ量の新規factに対する処理をSession長から独立させる。

### Slice 1 — regressionと契約の固定

- `/tmp`
  captureから原因を再現する最小のcredential不要fixtureをrepositoryへ置く。root
  exact request、root request start／runtime event、exact captureなしのaux
  request startで、現行v6の同じ契約errorを再現する。
- 実`OpenRouterSonarWebSearchBackend`とproduction auxiliary dispatch seamへfake
  credential／fetchを入れ、実際の product pathからexact
  captureとrequest-startを採取してreal v6 production storeへ渡すfocused
  testを作る。
- 次を契約として固定する。
  - exact captureがaux `request_start`より先に発行される。
  - capture bytesとfake fetchへ渡したbodyがbyte-for-byteで一致する。
  - endpoint、method、lane、phase、model step、metadataが一致する。
  - credentialとAuthorizationをcapture／durable readbackへ含めない。
  - response、tool result、final settlementまで継続できる。

Go条件は、現行sourceでproduct-path
testが確認済みのmissing-capture境界で失敗し、fixtureも同じv6 contract
errorを再現すること。test-only
interfaceへの置換なしに実経路を通せない場合はNo-Goとし、seam設計を見直す。

### Slice 2 — auxiliary provider dispatchの統一

- `ProviderHttpRequest`／`ProviderRequestFn`を変更し、provider-backed
  toolがexact captureと独立して `request_start`を発行できないようにする。
- web-search
  JSONを一度だけ`Uint8Array`へencodeする。credential解決とcancel再確認後、間に`await`を挟まず、exact
  observer、`startRequestMetadata`、同じbytesを使う`fetch`の順に実行する。
- exact observerがないprovider-free経路だけはfull-body
  `startRequest`を使い、unmatched exact captureを作らない。
- productionとdirect testの低位transportを同じdispatch
  ownerの背後へ置き、二つ目のordering実装を残さない。
- auxiliary adapterの実serializerを識別できる固定capture boundary／serializer
  versionを定義する。
- v6 pipelineのFIFO照合と欠落時のrejectは変更しない。

Go条件は、exact capture一件と対応するrequest
start一件が順序どおりdurableになり、capture bytesがfake fetch
bodyと一致すること。独立した再encode、複数のoptional ordering
owner、または`#matchRequestStart`の緩和が必要ならNo-Goとする。

### Slice 3 — non-canonical settlementのSession長依存除去

- `SqliteHistoryV6ProductionStore`のcurrent-execution indexingで、settlement
  outcomeを得るためだけの
  `readExecution()`呼出しをやめる。既に選択済みのexecution
  rowからoutcomeを渡し、過去canonical transcriptを 復元・decodeしない。
- non-canonical human-history indexはcurrent
  executionのevents、effects、context、request／evidence IDsと、indexを
  使うattempt lookupだけから構築する。
- wall
  timeではなくdecode／query境界の決定論的counterで、短いSessionと長いSessionの同じfailed
  turn settlementが ともに過去canonical messageを0件decodeすることを確認する。

Go条件は、non-canonical settlementとindexingが過去canonical
messageをdecodeしないこと。処理量が過去message数に
比例する経路が残る場合はNo-Goとする。

### Slice 4 — pre-commit journal failureの即時terminal化

- active executionへ最初のtyped journal codeと、dispatch前に作るlatched
  deferredを持たせる。
- `executionJournalDurability: 'failed'`と`executionJournalPersistenceError`を`LoopOutcome`、`turn_end`、projection、
  validation、artifact
  compact、outcomeを保存・readbackするsurfaceへ追加する。既存のpost-commit
  `executionObservation*`は流用しない。
- `handleJournalFailure`をidempotentな一つの遷移へまとめる。
  - 最初のerror codeだけを保持する。
  - canonical commitを禁止する。
  - latched Host signalをsettleする。
  - generationをreplacement対象にする。
  - その後にWorker cleanup／terminateを行う。
- `submit()`はterminal
  message待ちの開始時点からsignalをrace／確認し、genericなWorker transport
  failureではなく typedなfailed／non-canonical outcomeを返す。provider
  timeout、利用者cancel、cancel escalationを待たない。
- `validateExecutionEvent(...) === false`とpre-commit malformed journal
  inputも`history_invalid`として同じ遷移へ入れる。
- canonical commitへ入る直前にterminal snapshot／flush成功とlatched
  failureなしを必ず再確認する。現在無視している
  `recordWorkerStageSnapshot('terminal')`のfalseを無視しない。
- Slice 3で局所化したnon-canonical
  settlementを試みるが、同じstoreが失敗する場合はdurability成功を捏造しない。
  最初のtyped codeを即時返し、admitted active rowをrestart
  reconciliation可能な状態で残す。
- 既にcommit済みのoutcomeは成功のまま、post-commit observation durability
  failureを別fieldで報告する現行契約を維持する。

検証では次の四境界を別々にfailure injectionする。

1. waiter登録前の`turn_dispatch_sent`
2. terminal message待機中のbuffered `appendExecutionEvents`
3. proposal受信後、canonical commit直前のterminal snapshot／flush
4. `validateExecutionEvent`がfalseを返すpre-commit入力

各caseで、一回だけtyped non-canonical turn endを返し、transcript／state
revision不変、canonical rowなし、cancel 不要を確認する。次turnはreplacement
generationで完了できること、最初のcodeを後続callbackが上書きしないこと、既存の
post-commit observation
failureと通常cancel／escalationが変わらないことも確認する。

Go条件は、全failureがlatched signalからsettleし、次turnがreplacement
generationで動くこと。Worker／provider timeout依存、またはcleanupとcanonical
adoptionのraceが残る場合はNo-Goとする。

### Slice 5 — combined verification

- repository-owned replayで、missing captureは失敗し、corrected
  captureは成功することを確認する。
- `/tmp/henji-i92-n1/capture.jsonl`が残っている場合は補助証拠としてoriginal
  replayも行うが、必須test inputにはしない。
- web search、v6 production history、live execution journal、Worker
  liveness、Increment 92 stage probeのfocused
  testと、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
- 安定候補にauthoritative `v0:gate`を一回実行する。
- 実provider確認、binary build／配置、commit、push、releaseは次のhuman
  gateまで実行しない。

### 受入条件

1. fake credentialだけを使うproduction-path web-searchがv6
   history付きでfinalまで完了し、aux exact capture一件が request
   start一件へ一致する。
2. durable readbackのcapture bytesがfake
   fetchへ渡したbytesと一致し、credential値とAuthorizationを含まない。
3. credential不足と開始前cancelはexact capture、request
   start、fetchをいずれも0件にする。
4. missing／reordered captureは引き続き失敗し、pipeline不変条件を弱めていない。
5. pre-wait、buffered、terminal-flush、validation failureは最初のtyped journal
   codeを即時に返し、Worker stateを
   adoptせず、cancel／escalationを必要としない。
6. 次turnはreplacement generationで継続できる。
7. post-commit canonical successの意味を変えない。
8. non-canonical settlementは過去canonical Session
   messageをdecodeせず、追加処理量は新規request bytesとevent数だけに 比例する。

### GPT-6 Astra xhigh review結果

- 通常review初回:
  **No-Go**。waiter登録前のfailure通知消失、credential解決前の架空request記録、pre-commit
  failure専用typed contract不足、direct fallbackに残る第二のordering
  ownerを指摘した。全件を計画へ反映した。
- 批判的review初回: **No-Go**。上記を独立に再確認し、さらにcanonical
  commit直前のterminal flush failure無視と、 non-canonical
  settlementが過去Session messageを全decodeする非線形経路を指摘した。validation
  falseのtyped化も含めて 全件を計画へ反映した。
- 批判的re-review:
  **Go**。初回の全P1と通常reviewの修正が反映され、実装承認へ進める状態と判定した。

## 根本修正の実装結果（2026-09-21、Increment完了判断待ち）

- Slice 1–2: auxiliary provider dispatchを`createProviderRequestDispatcher`へ統一した。credential解決と
  cancel確認の後、同じ`Uint8Array`をexact capture、metadata-only `request_start`、fetchへ順に渡す。
  `web_search`のproduction seamとdirect fallbackは同じordering ownerを使い、exact observerがない経路だけ
  full-body evidenceを生成する。fixture replayではmissing／reordered captureを引き続きrejectする。
- Slice 3: v6 non-canonical indexingからsettlement outcome取得目的の`readExecution()`を除き、既に選択済みの
  execution rowを渡すようにした。回帰testはsettlement中の`readExecution()`呼出しが0回であることを固定した。
- Slice 4: active execution作成時にfirst-code-winsのjournal failure latchを作り、Worker terminal waitとraceする。
  `turn_dispatch_sent`前後、buffer flush、canonical commit直前のterminal snapshot、validation falseを同じtyped
  pre-commit failureへ集約し、`executionJournalDurability`／`executionJournalPersistenceError`をoutcome、
  `turn_end`、artifact、v5/v6 persistence readbackへ通した。failureはcanonical stateをadoptせず、次turnで
  generationを交換する。post-commit `executionObservation*`契約は維持した。
- Slice 5: production auxiliary seamのfake fetchでcaptureとfetchが同じbyte objectであること、v6 durable
  readbackが同じbytesを復元すること、credential／Authorizationを保持しないこと、credential不足／開始前cancelが
  capture・request start・fetchを0件にすることを確認した。

通常code／test reviewはfindingなし、**Go**。非blocking注記は、Session長依存のtestが短／長Sessionを別々に
生成する形式ではなく、旧非線形経路の`readExecution()`呼出しを決定論的に0回とする形式である点のみ。source上でも
non-canonical entryがcanonical messageを復元しないことを確認済み。

検証はIncrement 7（5件）、Increment 41（12件）、Increment 90（23件）、Increment 91（10件）、Increment 92
（11件）がpass。安定候補に対する唯一のauthoritative `v0:gate`もexit 0。実provider E2Eは下記のとおり実施した。
配置用binaryのbuild／配置、commit、push、releaseは未実施で、Incrementの完了判断は利用者が行う。

### 実provider E2E（2026-09-21）

利用者指示により、現行sourceをDeno 2.9.6で一時binaryへbuildし、配置済みbinaryと通常stateを変更せず、隔離stateで
compiled CLIの`henji run`を実行した。taskは`web_search`を一度だけ使うよう指定し、15.8秒、exit 0、stderr 0で
回答まで完了した。一時binaryのbuild IDは`fb96f903…`、run証拠は
`/tmp/henji-i92-e2e-run-vuszI7`に保持した（credential copyなし）。

v6 readbackではexecution `fa7be625…`が`settled/completed/non_canonical`（`henji run`のno-session契約）で、
provider requestは`root_model → web_search → root_model`の3件、responseはいずれも200、provider evidenceは
`complete`だった。対応するexact byte streamも3本あり、順に20,209 bytes、auxiliary 491 bytes、23,064 bytes。
auxiliaryは`openrouter-chat:auxiliary-http-body-v1`／`json-stringify-utf8-v1`で、durable request startは
metadata-only、復元したauxiliary bytesに`Authorization`／Bearer token構文は含まれない。`execution_settled`は1件、
auxiliary gap snapshotは0件で、元事象の停止は再発しなかった。

別件の観測として、no-session経路ではcontext manifestが実在する一方、最終artifactが
`contextCapture: failed`になった。原因は`settleNonCanonicalExecution`がexecutionをterminal化した後にHostが
acknowledgement journalをappendし、settled v6 executionに拒否されてpost-commit observation failureになる既存の
順序である。今回のexact-capture欠落やpre-commit hangは再発しておらず、保存済みcontext／provider evidence／exact
bytesも失われていないため、本実装へ混ぜず別問題とした。後続の修正と検証は
[`increment-93.md`](increment-93.md)で扱う。

## 修正時に維持する条件

- request-startを捨てる、非durableにする、過去履歴をscanするfallbackを導入しない。
- 同じ量の新規factに対する履歴処理量をSession長から独立させる。
- history failureを無応答に見せず、pre-commit failureとpost-commit observation
  failureを区別する。
- stageによる実処理境界とreceive／buffer／durable差を別軸で報告し、history
  lagが現在stageを覆わない。

旧仮説に基づくprovider I/Oまたはhistory writerのOS
process分離は、確定原因の修正には不要であり、Increment 92の
修正候補から除外する。

## 対象外

- turn全体または全toolへの一律timeout追加。
- 原因未確定の段階でのretry、fallback、自動replay。
- 原因診断だけを目的としたprovider response、request
  body、credential、Authorizationの追加複製。根本修正として
  v6の証拠契約に従って保存するexact requestはこの対象外に含めない。
- Increment 91のcancel／generation replacement契約の変更。
- concept、architecture、roadmap正本の変更。
- 実provider確認、binary配置、commit、push、release。

## 停止条件

- Slice A–Dは承認済み範囲として完了した。
- Slice
  AがNo-Goなら別方式を推測で実装せず、観測できない境界と代替案を利用者へ返す。
- Human Gate 1の承認後、binary配置と実provider確認を完了した。
- 原因を確定できた時点、または計測後も再現せず追加の実利用発生待ちになった時点で調査結果を報告して停止する。
- Deno upstream再現計画は原因確定により撤回し、GitHubへ投稿しない。
- 根本修正計画はreview済みで、実装開始前の利用者承認をHuman Gate 2とする。
- Incrementの完了判断は利用者が行う。
