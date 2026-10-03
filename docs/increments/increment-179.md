# Increment 179 — HTTP/SSEとhenji runの入出力adapterをWorkerへ分離

更新日: 2026-10-03

ステータス:
**実装・受入と実装commit/push完了。3スライスの検証・独立review、最終gate、承認済み実provider確認3回・保存readbackを完了。追加承認されたarchitecture/roadmap反映も完了。常用配置はIncrement
180で完了。**

利用者の「では計画を立ててください 次のインクリメントとします」により、通常利用メモS31の API
Worker案と、追加された`henji run`のCLI Worker案を179へ採用する。
本書を要件・対象範囲・実装計画・受入・結果の正本とする。
計画作成後、利用者の「では計画をスライスに分割し、スライスごとにに実装テストレビューを行ってください」により、
local実装・非破壊的検証・スライスごとの独立reviewを開始する。 実provider
call、常用配置、commit/pushは別途承認の境界を維持する。

## 目的・根拠・成功条件

目的は、Hostの操作判断・実行制御と、HTTP/SSE・CLI入出力の責務と実行場所を分離することである。
Coreとheadless Hostの状態所有、Data/Agent Worker、現在の人間の操作と結果を維持する。
Worker追加による高速化を前提にせず、追加配送の負担を同じworkloadで測定する。

根拠は利用者の方向づけ、現行source、[分離案と事前確認](../research/api-worker-separation-design.md)、
[Increment 170](increment-170.md)のData配置と保存・公開契約である。 事前確認はDeno
2.9.7、source/compiled、provider-freeの実Core/headless Host・Data/Agent Worker・SQLiteで
実施した。CLI
Worker内の物理stdio、三出力形式、保存readback、APIの並行request・SSE・shutdownが成立した。
production切替、実provider、実workload性能を確認したものではない。

批判的reviewは案・現行source・保存済みprobeをread-onlyで確認し、計画開始を妨げる問題なしと判断した。
親は終了順序の明記と、detach後の稼働execution・follow-up継続の受入確認を採用した。
計画自体もreviewerが独立に確認し、実装へ進められる計画・必須修正findingなしとの結論を得た。
runner開始時のDefinitionStartupError/HenjiInstructionErrorも、CLI境界で現在の公開出力へ対応させる。

成功条件は、公式compiled executableのproduction経路で人間が現在のTUI/API操作と`run`を完了でき、
保存履歴を読み戻せること。型確認、offline test、review、gate成功だけでは完了としない。

## 現行の操作経路と状態所有

現行source基準はcommit `1d8d58ede6fe8ee43c799bcb802e42d45b464d9d`。

| 入口から結果までの経路                                                                               | 現在のownerと保存・参照先                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `henji`/`tui` → Core起動・discovery → HTTP/SSE → CoreService → operation/購読 → TUI表示              | `serve_cli.ts`が同じmainでCoreServiceとHTTP serverを起動。Coreがcommand、実行制御、小さいcontrol state、公開revision・合成・購読を所有                                  |
| Core → Data Worker → encoded snapshot/delta/history → Core合成 → HTTP/SSE                            | Dataがcanonical Session・会話state・共有SQLite history DBを所有。`encoded_public_frame.ts`は会話bytesをdecodeせずcontrolを合成                                          |
| Core/headless Host → Agent Worker → provider/tool → Agent–Data直接channel → 保存・採用判断           | Hostが実行と採用判断、Agentがturn/provider/tool、Dataが保存。今回この経路・DB schema・採用契約は変えない                                                                |
| `henji run` → `runtime_cli.ts` → Definition解決 → stdin/引数 → `runHeadlessWorker` → 結果・出力drain | CLI処理とheadless Hostが同じmain。runnerは`persistence: none`のSessionを作り、submit後にclose。canonical Sessionを保存せずexecutionとsemantic履歴を共有history DBへ保存 |
| `run --json/--stream`のevent → CLI投影 → stdout/stderr                                               | `run_events.ts`のprojector/renderer/ordered writerを使用。現在の公開出力を維持                                                                                          |
| CLI/HTTP/signalによるCore停止 → 保存・清算 → endpoint削除・listener終了                              | `startCoreServer()`がCore closeとlistenerを結び付ける。分離後はCore側のlifecycle ownerへ接続し直す                                                                      |

経路の根拠は`v0/agent/cli/{henji_cli,serve_cli,runtime_cli,run_events}.ts`、
`v0/agent/http/server.ts`、`v0/agent/host/core_service.ts`、
`v0/agent/worker/{worker_headless_runner,worker_tui_session,worker_host_coordinator}.ts`、
`v0/agent/data/{client,data_bootstrap}.ts`、`v0/agent/runtime/core_discovery.ts`、
`scripts/build_henji.ts`である。 TUIのMarkdown/layout/draft/cursor/viewportはTUIに残す。
architectureには170前のData配置説明が残るため、現在配置はsourceと170の結果に照合する。

## 採用する配置・維持する動作

```text
henji serve / TUIから起動するCore process
  API Worker ── operation / snapshot・update ── Core main
                                                 ├ Data Worker
                                                 └ Agent Worker ── Dataへの直接channel

henji runのprocess
  CLI Worker ── 選択・実行要求 / event・結果 ── headless Host main
                                                  ├ Data Worker
                                                  └ Agent Worker ── Dataへの直接channel
```

API WorkerはCoreにつき一つ、CLI Workerは`run`のinvocationにつき一つ。
`serve`と`run`は別invocationであり、常駐CoreへCLI Workerを追加しない。同processのmodule Web
Workerを使う。

- 公開HTTP route・status・input/result、commandId照合、snapshot/updateのschemaVersion
  2と意味を維持する。 内部RPCの照合IDは公開commandIdとは別で、公開APIへ追加しない。
- Core mainは操作受付・判断、実行予約/cancel/steering/follow-up、selection・認証操作、採用判断、
  公開revision・control合成・application購読、Agent/process/childのlifecycleを所有する。
- API Workerはlisten、route、request decode、response、SSE framingと接続の終了を所有する。
  重いreadのreply待ちで他のrequestや稼働executionのcancel転送を直列化しない。
- 初回snapshot、後続update、再接続復元、複数接続を維持する。detach/HTTP切断は購読解除であり、
  受付済みexecution・follow-upをcancelしない。
- CLI Workerはrunの引数解釈、stdin、text/NDJSON/stream、stdout/stderr、出力drainを所有する。
  headless HostはDefinition・実行構成の解決、実行と採用判断、Agent/child/processの清算を所有する。
  最終process終了コードはmainが適用する。
- 既存のdefault root binding、`--agent`、`--definition-revision`、`--max-steps`、
  `--provider-timeout-ms`、stdin/`--task`、出力と終了コードを維持する。
  Definition解決は現在どおりstdin読取より先。runをHTTP client化せず、常駐Coreを要求しない。
- credential値とAuthorizationを診断・履歴・検証結果へ記録しない。短いrequest factとsemantic履歴は
  現在の保存経路を使い、raw request/response・SSE断片の常設収集を追加しない。

## 内部portとlifecycleの実装方針

### APIのoperationと購読

HTTP側は非同期operation portを使い、CoreService object・callback・DB handleをWorkerへ渡さない。
CoreService自身の同期`coreRead()`を変更する必要はなく、API側portではreplyを待つ呼出しにする。
現行HTTP routeから使う全operationを次のまとまりで接続する。

| まとまり          | 現行operation                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core・保存読取    | `coreRead`, `coreShutdown`, `sessionsList`, `sessionRead`, `contextRead`, `commandRead`, `executionRead`, `historyRead`                                          |
| Session・実行操作 | `sessionOpen`, `sessionDelete`, `sessionRename`, `selectionChange`, `recall`, `taskSubmit`, `executionCancel`, `steeringSubmit`, `followUpQueue`, `followUpRead` |
| catalog・認証     | `catalogRead`, `modelFavorite`, `credentialPresenceRead`, `chatgptAuth`, `credentialRegister`                                                                    |
| 購読              | `subscribeSession`のsnapshot、encoded update、終了通知、unsubscribe                                                                                              |

requestごとのpending照合を使い、dispatcherは各operationの完了を全体queueの共通待ちにしない。
Coreでの既存command照合・操作可否・予約をそのまま使い、API側へ判断や新しい再送を追加しない。
`coreShutdown`のonAccepted callbackはmainに残し、APIへはlifecycleのdata通知を送る。
errorは現行公開status/code/message等を再現するためのdataへ変換し、境界を越えた同一classの
`instanceof`に依存しない。HTTP request decodeの現在のerrorも維持する。

接続ごとの購読identityをAPI側で先に作り、snapshot reply待ち中のupdate・終了通知を保持する。 Core
mainは現行`subscribeSession`のcutを使い、snapshotを確定し直したりrevisionを別採番したりしない。
APIはsnapshot → pending update → 後続updateの順にSSEへ送る。切断時は該当購読だけを解除する。
購読開始中に切断した場合も、成立したCore購読を解除できるよう開始replyとunsubscribeを対応づける。
購読数とCoreのownershipは現行の一接続一購読を維持し、別の配信logや永続queueは作らない。

Data → Core合成 → API → HTTP/SSEのencoded
bytes経路を使い、全会話のJSON.parse・再encodeを追加しない。
単独返信のbufferはCoreで再利用しないことを確認してtransferする。
Coreが複数subscriberで共有するupdateはstructured cloneで送って元bufferを保持する。
共有bufferを最初の送信でdetachしない。コピー削減の追加方式は先に実装せず、負担は受入で測定する。

### Core/APIの起動と終了

mainがCoreServiceとAPI
Workerを所有する。listen成功のURLを受け取ってから既存のendpoint/readyを公開する。 Core
epoch・PIDはCore processのidentityを維持する。build identityなど必要な起動dataを渡し、
Worker間でmodule-localなstateを共有できるとは扱わない。

CLI stop・HTTP
shutdown・SIGINT/SIGTERMを一つのCore終了処理へ接続する。現行の順序は次のとおり維持する。

1. Coreの新規受付を止め、稼働executionへcancelを送り、Core購読へ終了通知を出す。
   APIは新規受付を止め、SSEを閉じる。SSEを保存完了まで維持する新しい保証は追加しない。
2. HTTP shutdownの場合はaccepted responseをhandlerへ返し、APIからその返却段階をmainへ通知する。
   これはclientの読取ACKを要求するprotocolではない。後続のgraceful listener終了と合わせ、HTTP202の
   bodyを受け取れることを実経路で確認する。
3. APIの既存handler/RPCの完了を待ち、Coreのcommand、Agent/child/processの清算とData保存・closeを終える。
   shutdown handler自身を待ってshutdown replyが返らない循環を作らない。
4. endpointとCore所有lockの後片付けを既存ownerで終え、API listenerのgraceful
   shutdown/finishedを待つ。 最後にAPI Workerを終了し、mainを終了する。

APIのlistener/Worker終了をCore保存省略のterminateへ置き換えない。 現在のserver.finishedがCore
closeを起動する関係もmain側へ引き継ぎ、通信終了時にpending replyを
未解決のまま残さず、既存の終了・error結果へ接続する。自動再起動や再送は追加しない。

### runの選択・実行・終了

run用portはこのinvocationのDefinition解決と一turn実行だけを接続する。
`CoreService`/`ApplicationService`全体や別のcanonical Session managerをheadless経路へ追加しない。

1. mainがrun CLI Workerを起動し、argv、必要なruntime pathとbuild identityを渡す。
2. CLIは現在の引数を解釈し、Definition選択要求をHostへ送る。Hostは`resolveRequestedDefinition`を実行し、
   解決済みobjectをmainで保持して、data-onlyな解決結果・refまたは現在の公開error用dataを返す。
   builtin関数を含む`HostDefinitionSelection`やmanaged executable closureをCLIへ渡さない。
3. CLIがstdin/`--task`を現在の契約で読み、taskと既存実行optionを送る。Hostは保持した選択を使い、
   既存`runHeadlessWorker`を呼ぶ。別の永続選択token/storeを作らない。
4. Hostが現在のeventを順に送り、CLI内の既存projector/renderer/writerが公開出力を組み立てる。 event
   messageとterminal結果の順序を保つ。内部eventを公開NDJSONへそのまま出さない。
5. Hostはturn settlementとrunnerの`created.close()`を終えてから小さい結果を返す。
   CLIはterminal出力とstdout/stderrのdrainを終えて完了/終了コードを返す。
6. mainはCLIのdrain済み完了を受けてWorkerを終了させ、元の終了コードでprocessを終了する。
   input/Definition errorでrunを開始しない経路も出力drain後に終える。

Deno 2.9.7のCLI Workerから物理stdioを直接扱う。mainにstdio relayを追加しない。
現行runには専用のSIGINT/SIGTERM handlerがない。配置変更後もprocess宛signalで終了できることを
確認し、このincrementでrunのgraceful cancel仕様やsignal専用の採用・保存保証は新設しない。

## 対象ファイル・旧経路の撤去

次は責務を置く予定のfile。実装時の局所的な分割・命名は同じ責務と範囲の中で調整できる。

| 対象                                                                        | 変更と廃止する経路                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `v0/agent/http/server.ts`                                                   | 非同期operation portを使うHTTP/SSE adapterへ変更。CoreService close、main listener起動、Coreへのruntime依存を外す |
| 新`http/api_worker_protocol.ts`, `api_worker_client.ts`, `api_bootstrap.ts` | data-only request/reply・購読/lifecycle、main所有のWorker bridge、Worker内の唯一のlisten入口                      |
| `v0/agent/cli/serve_cli.ts`                                                 | API Workerの起動・ready・Core終了ownerへ切替。旧main HTTP listener起動を撤去                                      |
| `v0/agent/host/core_service.ts`と必要なerror/port module                    | operation/判断/状態ownerは維持。HTTPで使うerrorのdata表現とmodule依存を分離する範囲のみ                           |
| `v0/agent/cli/runtime_cli.ts`, `run_events.ts`                              | CLI処理をWorker内へ接続。Definition/runnerのproduction直接呼出しをrun portへ置換し、既存表示処理を使う            |
| 新`cli/run_worker_protocol.ts`, `run_worker_client.ts`, `run_bootstrap.ts`  | run専用port、mainのDefinition/runner bridge、Worker内CLI入口                                                      |
| `v0/agent/cli/henji_cli.ts`                                                 | runのdispatchを新bootstrapへ切替。mainでrunの表示/stdio処理を動かす旧経路を撤去                                   |
| `scripts/build_henji.ts`と必要なtask/package収録設定                        | API/CLI Worker rootをruntime closure/includeへ追加。新module依存に収録漏れがあれば同じ切替で修正                  |
| 関係する既存testと179のfocused確認                                          | 旧`startCoreServer(CoreService)`やrunner seamの確認を正式Worker経路へ接続。test専用の旧production経路を残さない   |
| 本書、research、通常利用メモ、handoff                                       | 採用・計画・結果は本書、researchは前段の証拠、inboxからS31を移動、handoffは現在地/pointerのみ                     |

Workerは新しいDBやstorageを作らず、使われなくなる保存先も生じない。
旧形式converter、dual-read/write、fallback
listener、旧run切替flagを作らない。既存DB/data/fileは削除しない。

対象外はData/Agentの状態所有・DB schema・provider/tool/parserの変更、公開API追加、TUI表示仕様、
他のCLI commandのWorker化、WebUI、別process化、自動再起動/再送、一般的hardeningである。

## 実装工程

| 段階        | 成立させるproduct経路と作業                                                                                                                                        | 確認・次へ進む条件                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| S1 API切替  | operation/購読/lifecycle portを実装し、HTTP/SSEをAPI Workerへ移す。serve/discovery/停止入口を接続し、旧main listener経路を撤去。API Workerのbuild rootもここで追加 | 正式Core APIで起動・操作・snapshot/update・cancel・再接続・複数接続・shutdown/保存が成立。後述のlocal確認とtype/format/lint/diffを行う |
| S2 run切替  | Definition解決/typed error/event/result/完了portを実装。runtime_cliとrun_eventsをCLI Workerへ接続し、henji runのdispatchとbuild rootを切替。旧main表示経路を撤去   | 正式CLIでstdin/--task、三出力形式、Definition選択、Host清算・drain・終了コード、履歴readbackが成立。S1と同じ最小検証を行う             |
| S3 総合受入 | 公式compile、隔離XDGのproduction TUI/CLI、同workload比較、安定候補のreview、ownerによる最終gateと承認済み実provider確認、結果記録                                  | 人間の実経路と保存を確認し、追加配送の負担・未確認事項を報告。全入口の旧経路残存を確認して親が完了判断                                 |

S1/S2は中間実装状態であり、production完了を意味しない。実装中に`v0:test`/`v0:gate`を反復しない。
新しい計画外product bugは原因・観測・利用者影響・案を報告し、独自に修正しない。

### スライスごとの実装・test・review

| スライス                    | 成立させる範囲                                                                                                     | focused確認とreview後の条件                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: API Worker切替（S1）     | 全HTTP operation、購読、ready、終了を正式API Workerへ接続し旧main listenerを撤去。API build root追加               | 実Core/Data/Agentを使うHTTP/SSE・並行read/cancel・保存・停止のfocused確認、type/format/lint/diff。独立reviewでAPI境界と既存公開動作を確認し、採用findingを修正して次へ                                      |
| B: run CLI Worker切替（S2） | HostのDefinition解決・runner、CLIの入力・投影・出力drainを正式portへ接続し旧main表示経路を撤去。CLI build root追加 | stdin/PTY・三形式・選択/error・順序/drain・保存のfocused確認、type/format/lint/diff。独立reviewでHost/CLI境界と既存公開動作を確認し、採用findingを修正して次へ                                              |
| C: compiled総合受入（S3）   | 公式build、sourceから独立した起動、隔離XDG/tmuxで実操作、変更前baseline比較、残る既存入口の確認                    | local providerでdetach/follow-up・再接続・複数接続・cancel・shutdownとrun出力/readback。結果を独立reviewし、親が安定候補へauthoritative gate一回。承認が必要な実provider確認はlocal受入後に具体的対象を提示 |

スライスはA→B→Cの順に進める。各スライスで実装→focused確認→独立review→採用finding修正を行い、
再reviewは既存指摘と変更箇所に限って一回・15分以内とする。完成状態・検証結果・review結果を本書へ記録する。
初回reviewは各スライス30分上限で、一般的hardeningを追加しない。

## 確認する動作と根拠

各確認は上記の維持要件・現行source・事前確認の未確認範囲へ対応させる。test件数・variant数は目標にしない。
localhostの制御可能なprovider/authと実Worker/Data/SQLiteで確認できるものを先に行う。
外部応答のfixtureは実仕様として使わず、provider/parserの契約をこのincrementのtest都合で変更しない。

| 人間の動作・根拠                               | 必要な確認                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動して接続する、既存CoreへID/URLで再接続する | 公式入口の新Core、serve、ready/endpoint、build identity、URL接続・Core ID接続。既存launcher/Core management確認を新API Workerへ接続                                             |
| taskを送り、本文・tool・結果を見る             | task受付と実行完了、commandId結果照合、snapshot/updateのrevision、変更本文とtool順序。現行remote pending・Session/history確認を使用                                             |
| 実行中に追加指示/follow-up/cancelする          | 新port経由の既存steering/follow-up受付と適用、read reply保留中のcancel転送。公開結果と保存履歴をreadback                                                                        |
| detachしても実行が続く                         | local providerでexecutionを稼働させfollow-upを受付→TUI detach/HTTP切断→Coreが両taskを継続→再接続で本文・完了・履歴を読める。先にcancelして代替しない                            |
| 初回購読・更新・複数接続                       | 初回reply待ち中の先着updateを保持し、snapshotから連続するrevisionで送る。二接続で共有bufferが保たれ、片方の切断後ももう片方を更新する                                           |
| Coreを明示停止する                             | HTTP shutdown、CLI stop、既存serve signal入口を共通lifecycleへ接続。HTTP202 body、SSE終了、清算・保存、endpoint/lock、listener/Worker終了を実経路で確認                         |
| catalog・credential・selectionを使う           | 現行catalog/認証/登録/selectionのfocused確認を正式API portで実施。credential値/Authorizationを記録しない既存契約を維持                                                          |
| runの入力・選択・出力                          | stdin日本語、PTYの--task、default binding/builtin/managed選択と既存二つの実行option。text/NDJSON/streamを確認し、tool表示を含むstdout/stderrと末尾result/drain/終了コードを観測 |
| runを振り返る                                  | 自然完了・既存の失敗出力経路を使い、Host終了後のnon-canonical execution・semantic履歴・artifactを読み戻す。input/Definition errorは実行を始めず従来の公開結果で終了             |
| compiled配布で動く                             | 公式buildのroot/closure/includeを確認し、API/CLI Workerをsource treeのfileへ依存せず起動。公開Definition API graphに関わるmoduleを移す場合だけpackage収録も照合                 |

既存確認の入口は142のHTTP/remote pending、145のlauncher/HTTP shutdown、152のCore management、
163のChatGPT API/auth/selection、167のSession/history、170のheadless・preparing cancel・TUI、
175のsteering、78のbuild
provenance等。実装差分から必要なfileを選び、同じ動作のtestを重複追加しない。
新しい橋渡し固有の確認は`tests/v0/increment_179_*_test.ts`として通常`v0:test`へ接続する。

### production TUI/CLI、測定、gate

公式compileのcandidateは`.tools/increment-179/build/`、local受入は`.tools/increment-179/acceptance/`へ保存する。
実configと実DBを変更せず、隔離XDG・一時workspaceでtmux上のproduction TUIを使う。
確認操作・表示観測・Core/API readback・終了状態は本書の結果へ記録する。 実providerなしのlocal
providerを使い、上表の表示・cancel・detach/follow-up・再接続・複数接続・shutdown、 compiled
`run`の三出力形式を確認する。

同じ保存履歴のcopyと同じ更新を用い、変更前のbaselineとcandidateの初回snapshot、SSE配送、
read中の操作/cancel応答、Worker起動、CLIの最初のstream出力・最終drainを比較する。
baseline/candidateのsource/build、payload size、接続数と観測時間を記録する。
事前probeの約2.5msを性能目標にせず、過去170前のprojection probeを現在の基準へ流用しない。
数値SLA・コピー削減率を新たに要求しない。人間の操作が成立するかと追加負担を分けて報告する。

実装中はfocused test・必要なtype check・format/lint・`git diff --check`を使う。
安定候補の通常reviewは変更されたproduct経路と明示契約だけを対象とし、初回30分上限、
再reviewは修正箇所と既存finding解消だけを15分以内の一回とする。一般的security reviewは行わない。
review前にfull gateを要求しない。 親が安定候補に対してauthoritative `v0:gate`を一回実行する。
失敗時はfocused確認で原因を特定し、再実行は修正内容と具体的理由を本書へ記録してから行う。

### 実provider確認案と承認の境界

実provider確認は実装・local受入後に行う。今回の計画作成では呼び出さない。
対象案は登録済み`openai-chatgpt / gpt-6.1-sol / medium`の一account、公式compiled
candidate、隔離XDGである。
認証は既存登録経路を使い、実configへdefault-selection等を書かない。credential/Authorizationは証拠に含めない。

| 操作                           | 目的・予定回数                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| TUIの短い自然完了              | 一task・一推論requestを基本に、API Worker越しの本文/完了とcanonical保存を確認                     |
| TUIの途中cancel                | 一task・一推論requestを基本に、稼働中cancelの応答とnon-canonical保存を確認                        |
| `henji run --stream`の自然完了 | 一task・一推論requestを基本に、CLI Workerの実provider本文と末尾出力/終了・non-canonical保存を確認 |

推論requestは計3回を提案する。追加推論・別provider/model・再試行を包括承認として扱わない。
途中cancelが自然完了へ先行された場合は、観測をそのまま記録し、cancel成功として扱わない。
証拠は`.tools/increment-179/live/`の短いrequest fact、semantic履歴、画面/CLI出力とreadback結果とし、
採否と結果は本書へ記録する。実行前に対象・回数・保存先を利用者へ提示して明示承認を得る。

2026-10-03、利用者の「はい実施してください」により、この対象・回数・保存先の3回を承認済み。

## 正本への反映案と承認境界

- 179への採用・計画作成に加え、スライスごとのlocal実装・非破壊的検証・独立reviewは承認済み。
- 上記3回の実provider確認は追加承認済み。実装・関連記録のcommit/pushも追加承認済み。
  追加推論・常用配置・公開・実data削除は未承認。
- architectureの変更案はCore所有のAPI WorkerとrunのCLI
  Worker、操作/購読/stdio、起動・終了の責務境界を
  記載すること。既存170の未反映Data配置との整合も対象案として提示する。
- roadmapの変更案はF10等の採用範囲と179の実装状態を反映すること。 構想の意味変更は今回必要としない。
- architecture・roadmapの実編集は、対象・理由・意味上の変更内容を別途提示し、明示承認後に行う。
  179の実装や完了承認で自動的に正本を書き換えない。
- 利用者の「architecture/roadmap反映はやろう」により、上記反映案の正本変更を追加承認済み。

## 結果

計画の独立reviewは必須修正findingなし。スライスA/Bの実装・検証・独立reviewと、
スライスCのlocal受入・独立review・最終gateを完了した。変更前baselineはcommit
`1d8d58ede6fe8ee43c799bcb802e42d45b464d9d`の隔離worktreeで公式buildし、
`.tools/increment-179/baseline-build/henji-baseline`へ保存した。実provider結果は下記を参照する。

### 比較用baselineとlocal受入操作の準備

変更前の公式buildはbuild ID `dcc90954aff9f9eb17fd0516b3a40606821f39b9e992b11039cf541c5e92f15b`、
sourceは上記HEAD・clean、Deno 2.9.7である。 隔離XDG・workspaceのlocalhost Responses
providerで、約70KBのsnapshot、SSE初回とrename更新、 HTTP shutdownのaccepted
body、SSE終了・Core終了を確認した。 同じbaselineでproduction
tmuxの二接続、provider応答保留中のdetach、受付済みfollow-upの自然完了、
再接続、途中cancel、三形式のrun/tool出力、PTYの`--task`、Core ID discoveryとCLI stopも成立した。
process終了後、read-only SQLite経路でsettled execution・non-canonical
headless履歴・artifactを読み戻した。
これらは受入操作と変更前baselineの確認であり、候補版の成立性はスライスCで確認する。
証拠は`.tools/increment-179/acceptance/baseline/`と`baseline-cli/`。 測定比較にはbaselineの保存DB
copyを使う。外部provider requestは0。

### スライスA: API Worker切替

- `api_worker_client.ts`がmain所有のCoreServiceへrequestごとにdispatchし、 `api_bootstrap.ts`がHTTP
  listen・route・SSEを実行する。旧main listenerとHTTP側のCore closeを撤去した。
- `CoreServiceError`を中立moduleへ抽出し、公開errorをdataで橋渡しした。
  snapshot待ち中のupdate/end保持、開始中切断unsubscribe、共有update clone、単独encoded reply
  transferを接続した。
- Core beginShutdown・API drain・Core保存/所有lock清算・listener/Worker終了を接続した。
  Worker/listener失敗時もmainのCore closeへ戻す。serveと既存HTTP test/helperの入口、公式build
  rootを切替済み。
- focused確認はHTTP/Core/catalog/auth/history/launcherの22件がpass。
  対象は140、142、144、145（HTTPとlauncher）、150、163 API、170 stream、173、174、175 HTTP、176
  HTTP、178 catalog。 必要なtype・format/lint・diff checkもpass。通常updateのsnapshot
  reply先着を強制するcaseは未実施。
  終了通知先着、複数購読・update・再接続、保留read中cancelは既存focused確認へ対応させた。
- 親が公式compiled candidate build ID
  `ff1f1299ab2e5790ad372a4658da941b85b924503f53397ab55074d907ea73ea`を隔離XDG/tmuxで確認した。
  二接続、provider応答保留中のdetach、受付済みfollow-upの完了、再接続、途中cancel、Core ID
  discovery、 CLI stop・SSE/Core終了と、process終了後のSQLite
  readbackが成立した。旧runの三形式/tool/PTYも成立。
  証拠は`.tools/increment-179/acceptance/api-slice/`と`api-build/`。外部provider requestは0。
- 独立reviewは全新file・production差分・test入口切替・必要な周辺sourceとcompiled証拠を確認し、
  次のスライスへ進める・採用correctness findingなしと結論した。開始時source identityも一致。
  起動/Worker失敗時の清算はsourceで確認した。実providerと最終比較は後続受入として残す。

### スライスB: run CLI Worker切替

- `henji run`は`run_worker_client.ts`からCLI
  Workerを起動し、`run_bootstrap.ts`が既存の入力・投影・表示・drainを実行する。
  `runtime_cli.ts`のDefinition/runner直呼出しを撤去し、run専用portへ置換した。`run_events.ts`はそのまま使用する。
- Hostがstdin前にDefinitionを一回解決し、実行可能selectionをmainで保持する。CLIへはdata-onlyなref/errorを返す。
  同一portでevent→Host close後result、CLI drain後done、main terminate/exitCodeの順を維持した。
  公式buildにCLI Worker rootを追加し、API Worker rootも保持した。
- focused確認は104出力9件・foundation30件・33 managed11件・65 binding10件・新179の2件がpass。
  旧testは新しいresolve/run portへ接続し、実source subprocessのtyped解決error・drain・終了コードと、
  runner-start
  Definition/Instructionのdata-only公開errorを確認した。必要なcheck/fmt/lint/diffもpass。
- 親の公式compiled候補build IDは`2133b3120bb1949540744df27a1cd2bb3d4c4f2f72a7889baaa824b777bf5d59`。
  build stagingを削除した後の隔離workspaceで、text/JSON/stream、tool表示、日本語stdin、PTY
  `--task`、終了コードを確認した。 process終了後のread-only SQLiteでnon-canonical headless
  execution・semantic履歴・artifactを読み戻した。 managed exact selector/default `agent:default`
  bindingの自然完了も成立し、選択refと最終本文を保存readbackで確認した。
  実Hostからの`instruction_invalid`とDefinitionの`worker_start/definition_evaluation_failed`も、既存の公開JSONとexit1を維持し、provider
  requestなしで終了した。
  証拠は`.tools/increment-179/acceptance/{candidate,definition-candidate}/`、build
  identityは`build/identity.json`。
- 独立reviewは指定新CLI file・working diff・変更test・必要な依存sourceとcompiled証拠を確認し、 Slice
  Cへ進める・採用correctness findingなしと結論した。固定source identityも一致。 外部provider
  callとfull gateはこのスライスでは実施していない。

### スライスC: compiled総合受入（local）

安定候補は上記build `2133b312…`。公式buildのstaging entryが削除されたことを確認し、
隔離workspaceからAPI/CLI Workerを起動した。production
tmux/CLIの結果はスライスA/Bの実操作記録へ接続する。 追加のHTTP
shutdown・SIGINT・SIGTERMでは、稼働provider応答を保留し、表示済み部分本文を確認してから停止した。
いずれもCore exit0、SSE終了、discovery/所有lock解除が成立し、read-only
SQLiteでcancelled/non-canonicalのsettled executionと
部分本文のsemantic履歴を読み戻せた。runのprocess宛SIGTERMはbaselineと同じsignal終了（Python観測-15）であり、
新しいgraceful保存保証は主張しない。証拠は`acceptance/lifecycle-{baseline,candidate}/`。

同じ保存DBのcopy（SHA-256 `921e4e58c1ecbf31818027749acdda169395241138fe940c0f19c8f8ae9ac94a`）、
同じworkspace・更新、接続一つでbaseline/candidateを比較した。snapshotは69,860
bytes、historyは590,981 bytes、 cancelと並行したhistory readは796,352
bytesで一致し、両版でread/cancelの時間区間が重なった。

| 観測                                         | baseline | candidate |
| -------------------------------------------- | -------: | --------: |
| Core readyまで（単回）                       | 164.04ms |  225.99ms |
| snapshot（7回の中央値）                      |  1.300ms |   1.363ms |
| SSE初回snapshot（単回）                      |  3.172ms |   3.464ms |
| rename update配送（7回の中央値）             |  1.241ms |   0.927ms |
| history read（7回の中央値）                  |  8.357ms |   8.391ms |
| 並行history read中のcancel受付（単回）       |  1.731ms |   3.781ms |
| CLI最初のstream chunk（同じtool/task・単回） | 252.00ms |  271.67ms |
| 同CLIの最終drain/exitまで（単回）            | 309.68ms |  345.00ms |

証拠は`acceptance/comparison.json`と`{baseline-cli,candidate}/results.json`。
短いlocal観測では起動とcancel/CLI終了に追加負担が見えた。snapshot/historyの中央値はほぼ同程度だった。
単回・小さいworkloadの値から高速化やproduction
SLAを主張しない。人間の表示・操作・保存は上記実経路で成立した。 sourceの旧main
listener/run直接経路を撤去し、新Worker rootsが公式buildへ収録されている。
local結果の独立reviewはcompiled操作・readback・同一DB比較を確認し、最終gateへ進める・
採用correctness findingなしと結論した。比較表のsnapshot中央値の丸めを修正した。
通常updateが初回snapshot replyへ先着する強制確認は未実施。 親が安定候補のauthoritative
`v0:gate`を一回実行し、type・format・lintと全体testがpass （645 passed、0
failed）した。証拠は`.tools/increment-179/gate.log`。 review開始時に固定したsource 424
fileのSHA-256はgate前後で一致した。

保存executionのbuildIdはbaseline/candidateともdevelopment値
`c738494fbbf99c577b5c91b957df9f3f0efcfc755442293665f71c8e3bd30179`だった。 Data Workerへ実build
manifestを渡しておらず、`SessionAuthority`が既定manifestを保存している。 候補の実行identityはbinary
SHA・`--version`・Core readとbuild記録で照合した。
既存の履歴attribution不具合として通常利用メモB9へ記録し、179では修正していない。

### スライスC: 承認済み実provider受入

2026-10-03、公式compiled候補build `2133b312…`、同じ一accountの
`openai-chatgpt / gpt-6.1-sol / medium`を隔離XDGとtmuxで使用した。
推論前の初回起動では`--root-provider`がprovider既定モデルを優先したため、操作scriptからその指定を外し、
隔離default-selectionの対象モデルを確認してから推論を開始した。初回起動で推論requestは送っていない。

| 操作                   | 観測・保存readback                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI自然完了            | `I179 TUI completed 日本語`を表示。HTTP 200、1 request、completed/canonical、settled。canonical Sessionの本文もreadback                                  |
| TUI途中cancel          | 本文`I`が出始めた後にEscapeを送信。約187msで清算を観測。HTTP 200、1 request、cancelled/non-canonical、settled。部分本文をsemantic履歴からreadback        |
| `run --stream`自然完了 | `I179 CLI completed 日本語`をstdoutへ出力、stderr空、drain後exit0。HTTP 200、1 request、completed/non-canonical、settled。本文をsemantic履歴からreadback |

CoreのHTTP shutdownはaccepted bodyを返し、exit0で終了した。 停止後のread-only SQLiteで上記3
executionと各1 request（計3推論request）を確認した。 canonical
Sessionには最初の完了turnを保存し、cancel taskは採用していない。 cancel時はterminal
response未受信に対応する`response.output` absent/expected arrayの parser transition
factも保存された。runtime outcomeはcancelledで、自然完了2件に解析失敗はなかった。
provider/parserの実装は変更していない。

元の登録auth
fileのSHA-256は実行前後で一致した。credential/Authorizationが検証出力へ含まれていないことも
確認した。実config・実DB・常用配置を変更せず、追加推論・再試行は実施していない。 source 424
fileはlocal review時から変更なし。最終gateの再実行は行っていない。
証拠は`.tools/increment-179/live/`の`results.json`、`readback.json`、画面4点、stream出力、
3件のsemantic履歴、`evidence-check.json`。 追加結果の独立reviewも、3
executionの同account/model/effort・各1 physical request・HTTP 200、 semantic本文・Host
adoption、cancel部分本文と保存結果の対応を確認し、必須finding・記録差なしと結論した。
親が以上の実経路・保存・独立reviewと既存gate結果から、179の実装・受入完了と判断する。
通常updateの初回reply先着を強制する確認は未実施として残す。実provider受入時点では常用配置・
architecture/roadmapの変更は行っていない。正本の追加反映は下記を参照する。

### commit/push

利用者の「コミット プッシュしてください」により、実装・関連記録をcommit
`7dc4f501ea44e450e541fc1f0f84085caa0e6975`へまとめ、`origin/main`へpushした。 既にlocal
mainへ作成されていた文書commit `4b069557`も同時に送信した。
push結果の本書・handoffへの記録も同じ承認範囲でcommit/pushする。

### architecture/roadmap反映

利用者の追加承認により、`docs/architecture/henji-host-agent-worker.md`へAPI/CLI Workerの責務、
data-only port、起動・終了順序と関連する170のData Worker所有を反映した。
`docs/roadmap.md`のF04/F05/F09〜F13とSurface置換の基盤説明を現行配置へ合わせた。
F10のWebUI・一般Surface loader/置換は未実装のまま、179のcompiled受入と常用配置未実施を区別した。
既存build attribution不具合B9は未採用として参照し、解消済みとは扱わない。
文書の所有・保存・採用・終了経路をsourceと170/179結果へ照合し、文書内linkとdiff checkで確認した。
runtime sourceの変更・追加provider call・gate再実行は行っていない。

180の追加承認による常用配置で179の変更も配置された。build・配置先確認は[Increment 180](increment-180.md#commitpush常用配置)を参照する。
