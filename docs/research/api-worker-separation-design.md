# HTTP/SSEとhenji runの入出力を専用Workerへ分離する案

作成日: 2026-10-03

ステータス:
**方向づけ・事前確認の研究記録。採用後の要件・計画・結果の正本は[Increment 179](../increments/increment-179.md)。**

## 利用者の方向づけと目的

利用者は、HenjiのAPIサーバーがCore側にあることを確認したうえで、Coreから分離するか、
表示を組み立てるWorkerへ寄せられるかの調査を依頼した。
調査後、「HTTP/SSEをAPI専用Workerへ移す」案について「これが自然かな」と述べ、
案を一旦ファイルにまとめるよう指示した。本書はその案を保存する。

その後、利用者は`henji run`も切り離す検討を依頼し、APIとCLIをそれぞれ通信・出力adapterとして
Hostの実行制御から分離する整理に「はいその整理で進めたい」と述べた。
「事前確認を許可します」によりproviderなしの技術調査と小規模probeを実施した。
追加案と確認結果は本書に記録し、production実装と実provider確認は次の段階として扱う。

HTTP/SSEの実行場所を、操作判断・実行制御を所有するCoreと、重い会話dataを処理するData Workerの
双方から分離する。状態の所有者を変えず、通信adapterの責務と実行境界を明確にする案である。
性能向上を保証する提案ではなく、追加配送による負担も実経路で確認する。

本案と`henji run`の追加案は、利用者の「次のインクリメントとします」により179へ採用した。
以下は採用前の検討・事前確認記録として残し、実装工程と受入は179を参照する。
本書は調査・配置案の詳細であり、architectureやroadmapの正本を置き換えない。

## 確認した現在の経路

現在のworkspace sourceでは、HTTP listenerとSSE処理はCoreのmain側にある。
一方、会話state・履歴・公開会話payloadの生成とencodeは、すでに別のData Workerへ移っている。

```text
TUI / 外部HTTP client
        │ HTTP / SSE
        ▼
Core main
  ├ HTTP受付・応答、SSE接続・配信
  ├ application operation、command照合、実行予約・cancel・採用判断
  ├ 小さいcontrol state、公開revision、snapshot合成・購読
  │
  ├── Data Worker
  │     history DB、canonical Session data、会話state
  │     conversation snapshot/delta、history/context、公開dataのencode
  │
  └── Agent Worker
        Agentのturn実行、provider/tool
        └─ Data Workerと直接data channelで通信
```

Data Workerは画面描画専用Workerではなく、DB・Session dataも所有する。
Markdown、layout、draft、cursor、viewport等の最終描画とUI-local stateはTUI側にある。
API専用WorkerはAgent Workerとは別のHost-side adapterとし、Agent generationの寿命へ結び付けない。

### 現行sourceの根拠

| 対象        | 確認したsourceと現在の責務                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動        | [`serve_cli.ts`](../../v0/agent/cli/serve_cli.ts)がCoreServiceとHTTP serverを同じprocess内で作り、URL・Core epoch・PIDを公開する                                                                                        |
| HTTP/SSE    | [`server.ts`](../../v0/agent/http/server.ts)が`Deno.serve()`、route、request decode、HTTP応答、SSE streamを実装し、CoreServiceを直接呼ぶ                                                                                |
| Core        | [`core_service.ts`](../../v0/agent/host/core_service.ts)がoperation、command状態、小さいcontrol snapshot、公開revision、購読を所有する                                                                                  |
| 合成        | [`encoded_public_frame.ts`](../../v0/agent/host/encoded_public_frame.ts)がDataのencoded bytesをdecodeせずcontrol envelopeへ合成する                                                                                     |
| Data        | [`client.ts`](../../v0/agent/data/client.ts)、[`data_bootstrap.ts`](../../v0/agent/data/data_bootstrap.ts)、[`data_service.ts`](../../v0/agent/data/data_service.ts)がData Workerの起動・通信・保存・読取・encodeを担う |
| 公開契約    | [`contract.ts`](../../v0/api/contract.ts)、[`client.ts`](../../v0/api/client.ts)が`/api/v1`の操作とsnapshot/updateを定義・利用する。現行snapshotは`schemaVersion: 2`                                                    |
| TUI         | [`remote_session.ts`](../../v0/tui/remote_session.ts)がHTTP/SSE clientとして接続し、会話・control状態を画面と操作へ変換する                                                                                             |
| 発見・build | [`core_discovery.ts`](../../v0/agent/runtime/core_discovery.ts)がCore endpointを管理する。[`build_henji.ts`](../../scripts/build_henji.ts)には既存Data/Agent Workerのroot/includeがある                                 |

現行Data配置の要件・結果は[Increment 170](../increments/increment-170.md)を参照する。
architecture・roadmapには導入前の説明が残り、170の[正本への反映案と承認境界](../increments/increment-170.md#正本への反映案と承認境界)で反映が別承認待ちとされている。
今回の案は、古い説明だけから配置を推定せず、現在のsourceと170の導入結果を基準にする。

## 第一案: 状態所有を変えず、HTTP/SSEだけを分離する

```text
TUI / 外部HTTP client
        │ HTTP / SSE
        ▼
API Worker（Coreが所有する通信adapter）
        │ data-only operation request / reply・購読
        ▼
Core main
  ├── Data Worker
  └── Agent Worker
        └─ Data Workerと直接data通信
```

CoreにつきAPI Workerを一つ所有する案とする。TUI接続ごと、Session切替ごと、Agent generationごとに API
Workerを増やさない。同一Core process内のDeno Web Workerとし、別process化は含めない。

| 責務                                                                                                      | 第一案のowner         |
| --------------------------------------------------------------------------------------------------------- | --------------------- |
| listen、HTTP route、request decode、HTTP応答、SSE framingと接続の終了                                     | API Worker            |
| 操作受付・実行可否の判断、commandIdの照合、予約、cancel、selection、認証操作、採用判断、process/child制御 | Core                  |
| 小さいcontrol read model、公開revision、snapshot合成、application-levelのSession購読                      | Coreに残す            |
| DB、canonical Session data、会話state、snapshot/delta生成、公開dataのencode                               | 既存Data Workerのまま |
| provider/toolとAgent turn                                                                                 | Agent Workerのまま    |
| Markdown、layout、入力、viewport、表示用cache                                                             | TUIのまま             |

API Workerの接続管理と、Coreのapplication-level購読を区別する。 HTTP
clientの切断は、該当するCore購読の解除へ変換し、実行cancelへ変換しない。 Coreの内部Worker
protocolやDB handleを外部clientへ公開する案ではない。

## 維持するproduct動作

- `henji`、`henji serve`、ID/URL指定の再接続、複数TUI接続は、同じCoreの公開APIを使う。
- 公開HTTP route、入力・結果、snapshot/updateのschemaと意味を、この配置変更のために変更しない。
- taskの受付と実行完了を区別する。公開commandIdの照合はCoreが引き続き所有する。
- 初回snapshotと後続updateの順序、公開revision、再接続後の状態復元を維持する。
- 稼働executionへのcancelは、Dataの読取・保存や表示の完了を待たず、Coreから直接送る。
  API側でも、履歴readのreply待ちによって後続cancelの受付・Coreへの転送を直列化しない。
- TUI detachやHTTP切断では、受付済みexecution・follow-upを停止しない。
- 明示Core shutdownでは新規操作を止め、cancel・SSE終了通知を出し、Agent/process/childの清算と保存を
  終えてlistenerを閉じる。SSE終了とlistenerの最終終了を区別する。
  listenerの移動を、保存を省略したWorker terminateへ置き換えない。
- `henji run`は独立したheadless Host経路のままとし、HTTP Coreへの接続を必須にしない。
- credential値とAuthorizationを診断・通常履歴へ記録しない。認証操作のownerはCoreのままとする。

これらは新しい機能や保証ではなく、配置変更で維持する現在の利用契約である。

## 実装へ進む場合に必要な変更

### 1. 非同期のCore操作port

現在のHTTP handlerはCoreService objectを直接呼ぶ。objectや関数をWorkerへ渡すのではなく、
必要なoperationをdata-only request/replyへ変換する。 内部RPCのrequest
correlationと、公開APIのcommandIdは別の目的として扱う。
現在同期の`coreRead()`も、Worker境界ではreplyを待つ呼出しになるため、HTTP側の呼出し方を変更する。

API側は同時進行するoperationをそれぞれ照合できるようにし、重いreadの完了を全requestの共通待ちにしない。
具体的なmessage schemaとport構成は、採用incrementで決める。

### 2. 購読の橋渡しとencoded bytesの配送

第一案のdata経路は、`Data → Coreでcontrol合成・revision確定 → API Worker → HTTP/SSE`とする。
全会話のJSON.parse・再encodeをAPI Workerへ追加せず、Coreからencoded bytesを受けて送信する。
現行CoreのSession購読開始・snapshot取得・後続frameの順序を、RPC経由でも保持する。

Core→APIの境界が一つ増える。ArrayBufferの移譲と複数SSE接続への配送では、bufferの所有権・再利用を
具体化する必要がある。大きいsnapshotや変更本文のコピーが自動的に減るとは主張しない。
公開revisionの採番・control合成をData/APIへ移す案は、第一案へ混ぜない。

### 3. 起動・終了とCore discovery

`serve_cli.ts`からAPI Workerを起動し、listen成功のURLを受けた後に既存のCore
endpointとreadyを公開する。 Core epoch・PIDはCore processのidentityとして維持する。

現在の`startCoreServer()`は、HTTP server終了とCoreService closeを結び付けている。
これをCore側のlifecycle ownerとAPI側のlistener/stream制御へ分け、shutdown reply、購読終了、 pending
request、Coreの保存・清算、Worker終了の順序を実装計画で具体化する。
同じCoreを止める現在のCLI・HTTP・signal入口を、分離後もこの終了経路へ接続する。

### 4. buildと旧経路の撤去

API Workerの入口を公式compileのclosure/includeへ組み込む。 切替後は、Core
mainでHTTP/SSEを動かす旧起動経路を残さず、二重listenerや選択式fallbackを作らない。
既存dataやDBは削除しない。

## 追加案: henji runのCLI adapterをheadless Hostから分離する

`henji run`は現在も常駐HTTP Coreに接続しない独立した一turn実行である。
[`henji_cli.ts`](../../v0/agent/cli/henji_cli.ts)から
[`runtime_cli.ts`](../../v0/agent/cli/runtime_cli.ts)へ入り、引数・stdin、Definition選択の解決、
headless実行呼出し、CLIイベントへの変換、stdout/stderrと終了コードを同じmainで扱う。
[`worker_headless_runner.ts`](../../v0/agent/worker/worker_headless_runner.ts)は
`createWorkerSession(persistence: 'none')`、submit、closeを所有する。
[`worker_tui_session.ts`](../../v0/agent/worker/worker_tui_session.ts)はData WorkerとAgent Workerを
起動し、headless Hostの実行制御を構成する。Agent/provider/toolとDBはすでに別Workerにある。

```text
henji serve
  API Worker ── operation / 購読 ── Core main
                                     ├ Data Worker
                                     └ Agent Worker

henji run
  CLI Worker ── 実行要求 / event / 結果 ── headless Host main
                                             ├ Data Worker
                                             └ Agent Worker
```

`serve`と`run`は別のinvocationであり、常駐CoreへCLI Workerを追加する図ではない。 CLI
Workerは`run`のinvocationにつき一つとし、headless Hostの終了とともに終了する。

| 責務                                                                          | 追加案のowner      |
| ----------------------------------------------------------------------------- | ------------------ |
| runの引数解釈、stdin、text/NDJSON/streamの表示変換、stdout/stderr、出力drain  | CLI Worker         |
| Definition選択・実行構成の解決、実行開始、採用判断、Agent/child/processの清算 | headless Host main |
| DB、non-canonical executionとsemantic履歴の保存                               | 既存Data Worker    |
| Agentのturn、provider/tool                                                    | 既存Agent Worker   |
| invocationの起動、最終終了コードによるprocess終了                             | mainのbootstrap    |

CLI Workerは内部の表示adapterであり、公開CLI出力へprovider-private stateや内部protocolを
追加する変更ではない。canonical
Sessionを保存せず、executionとsemantic履歴を保存する現在の動作を維持する。
API用のCoreService全体をheadless経路へ追加せず、同じdata-only通信の考え方を使う小さいrun用portとする。

実装計画では次を具体化する。

- 現行の`HostDefinitionSelection`にはbuiltinの実行可能関数が含まれるため、そのobjectをWorker間で
  渡さない。CLIから選択要求を送り、Hostが解決してdata-onlyな結果・参照を返す。
  現行の「Definition解決をstdin読取より先に行う」順序を維持する。probeでは参照だけをHostへ返して
  解決したが、正式実装のDefinition解決portを導入したものではない。
- Hostの`AgentEventSink`とrunner関数をWorkerへ渡さず、イベントと実行結果をmessageへ変換する。
  既存の`CliRunEventProjector`、`CliRunStreamRenderer`、`OrderedTextWriter`の動作を引き継ぐ。
- `DefinitionStartupError`、`HenjiInstructionError`、APIの`CoreServiceError`等は、Worker境界を
  越えた同一classの`instanceof`に依存しない。現在の公開errorを組み立てるための項目をdataとして返す。
- Hostはturnのsettlementと`created.close()`を終えてからrun結果を返す。CLIは結果の表示と
  stdout/stderrのdrainを終えて完了を返し、mainがその終了コードでprocessを終了する。
  結果受信だけでCLI Workerをterminateしない。
- buildのclosure/includeへCLI Worker入口を追加し、切替後はmainで表示変換する旧run経路を撤去する。
  module内の状態をWorker間で共有できるとは扱わず、必要なbuild identityも起動時のdataで渡す。

## 今回含めない変更

- Data WorkerへのHTTP同居、Dataの二重起動、表示専用DBの追加。
- API WorkerからDataへ直接接続する経路、公開revisionやsnapshot合成の移管。
- `henji run`以外のCLI commandのWorker化、`henji run`のHTTP client化・常駐Core必須化。
- Agent Workerの責務、canonical採用、DB schema、provider/tool実行経路の変更。
- WebUI、新しい公開API、外部process化、protocol negotiation、自動再起動・再送。
- TUIの表示形式や操作仕様の改訂。

## 技術確認と限界

前段の調査で、Deno 2.9.7のmodule Worker内から`Deno.serve()`を起動する小規模probeを実行した。
localhostのHTTP 200、SSE形式の応答、HTTP serverのshutdownが成立した。

| probeの配置                | 同期CPU処理 | HTTP応答時間 |
| -------------------------- | ----------- | ------------ |
| HTTPと同期処理が同じWorker | 600ms       | 約595ms      |
| HTTPと同期処理が別Worker   | 600ms       | 約1ms        |

これは独立したイベントループと同居時の影響の確認であり、HenjiのHTTP/SSE全経路や性能改善率を
検証したものではない。SSEは単発の形式確認で、継続購読・再接続を確認したprobeではない。
この旧probeはsource実行のみで、当時はcompiled binary・production TUIを確認していない。
今回追加したsource/compiled確認は後述する。

probeの一時sourceは`/tmp/henji-api-worker-probe.6w3ZMs/main.ts`と`worker.ts`にあり、
恒久的な証拠保存先ではない。結果は本書に記録する。実config・DB・稼働Coreの変更や、Henjiの実provider
callは行っていない。

参照した公式文書:

- [Deno Workers](https://docs.deno.com/api/web/workers/): Workerは別threadと独立したevent
  loopを持つ。
- [Deno HTTP Server](https://docs.deno.com/api/deno/http-server/):
  `Deno.serve()`のlisten、handler、shutdownの契約。

### API/CLI追加の事前確認（2026-10-03）

Deno 2.9.7、同processのmodule Web Workerで、sourceとcompiled binaryの両方を確認した。
証拠source、compile command、各結果、出力と実行summaryは
`.tools/api-cli-worker-preflight-20261003/`に保存した。
このdirectoryはgit管理外のlocal証拠であり、永続的に共有する結果は本節とする。

実config・常用Core・実DBを使わず、probe専用の一時workspace・state/config/dataを使用した。
実行のXDGも`.tools/api-cli-worker-preflight-20261003/isolated-xdg/`へ隔離した。
headless/APIのturnは既存の`physicalIoMode: 'provider-free'`を使い、実Data Worker、Agent Worker、
CoreService/headless runner、SQLiteを接続した。実provider requestは0回である。

| 確認対象                     | sourceとcompiledの観測                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI Workerの物理stdio        | stdinから日本語を読め、stdout/stderrへ直接出力できた。pipeでは`isTerminal() = false`、PTYではmain/Workerとも`true`                              |
| Workerとprocessの終了        | Workerの`Deno.exit(7)`後もmainは生存した。CLIの成功0・入力error1をmainへ返し、process終了コードとして受け取れた                                 |
| CLIと実headless Hostの橋渡し | 既存`runtime_cli.main`をWorker内で実行し、data-onlyなDefinition参照、イベントと小さい結果をHostと交換できた                                     |
| text / NDJSON / stream       | 三形式の出力が成立。遅延writerを通してもNDJSONのresultは末尾にあり、turn_end→Host close完了→CLI drain完了の順序を確認                           |
| headlessの保存               | close後に実SQLiteをreadbackし、executionは`settled/completed/non_canonical`、artifactは`committed`。全会話transcriptをrun replyへ追加していない |
| API内の非同期request照合     | Coreの履歴read replyをprobeのgateで保留したまま、別requestの稼働execution cancelが先に返った。source約2.7ms、compiled約2.5msの単発観測          |
| SSEのbootstrapと複数接続     | 二接続ともsnapshotが先頭、そのcursorに続くupdateを受信。最初の購読replyを意図的に遅延させ、先着updateをAPI側で保持してsnapshotの後へ送れた      |
| detachと再接続               | 切断をCore購読のunsubscribeへ変換し、再接続の先頭に現在のsnapshotを受け取った                                                                   |
| shutdown                     | HTTP202のbody受信、SSE終了、Coreの保存・close、listener終了を確認。SQLiteでcancelled executionを再読取できた                                    |
| build                        | `stagedCompileInputs()`の既存Worker includeと新API/CLI入口を含め、公式buildと同じcompile flagsでprobe binaryを作成・実行できた                  |

`Deno.exit()`がWorker内では当該Workerを閉じる契約は
[Deno Runtime公式文書](https://docs.deno.com/api/deno/runtime/#function-denoexit)とも一致する。
今回の環境ではCLI Workerから物理stdioを直接扱えるため、mainにstdio relayを追加する必要は
確認されなかった。processの最終終了だけはmainに残す方向とする。

Coreは同じencoded updateを複数のsubscriberへ渡す。probeはCore→APIをstructured cloneで送り、
Core側bufferを保持したまま二接続へ配送できた。broadcast共有bufferを最初の送信でtransferすると
後続subscriberで再利用できないため、単独replyのtransferと共有updateの配送を計画で区別する。
今回、copy削減・大容量性能・最適なtransfer方式は確認していない。

probeは現行production実装の切替ではない。API Workerには対象routeだけの小さいadapterを置き、
CLIは既存のdependency seamをrun RPCへ接続した。未確認の範囲は、全公開operationの正式port、
HostによるDefinition解決とtyped errorの橋渡し、全CLI引数、CLI signal経路、正式build scriptへの
入口追加、production TUI、実providerによる完了/cancel/run stream、追加配送の実workload比較である。
APIのcancel時間は「保留中の別replyで直列化しない」確認であり、現行版との性能比較ではない。
sourceのtype checkとprobe sourceのformat/lintも通過した。full gateは実行していない。

## 過去の案との関係と意図的な違い

[Core応答性・Surface調査](core-responsiveness-and-surface-conversation-review-2026-10-01.md)と
[A28三段階レビュー](a28-three-stage-review-and-reference-comparison-2026-10-02.md)にも、
API/CLIを別Workerへ置く案と、責務混在を防ぐという利用者の目的が記録されている。
追加中継のコピー負担に関する旧probeもあるが、170以前のprojection/wireを対象とした診断であり、
今回のschemaVersion 2・encoded bytes経路の性能保証として流用しない。

本書は旧三段階計画の再開ではない。現在のData Worker配置を前提に、API第一案はHTTP/SSEを
対象とし、追加案は`henji run`のCLI adapterを対象とする。 全CLI
commandのWorker化や会話更新器の再設計は含めない。
Coreに公開revision・snapshot合成・application購読を残すのも、今回の第一案で明示した範囲である。
「Coreからすべての表示・中継処理を外す」変更が完了する案とは扱わない。

## 採用時の確認と承認境界

採用と計画作成は179へ移した。以下は検討時の確認項目であり、現在の工程・承認境界は179を正本とする。

次に進む場合は、この範囲を個別incrementへ採用し、operation port、購読橋渡し、起動・終了の
計画を具体化する。追加案を合わせて採用するときはrun用portとCLI終了経路も具体化する。
確認対象は、現在のproduction経路での起動・接続、task受付、表示更新、cancel、
detach後の実行継続、再接続、複数接続、明示shutdownと保存である。
`henji run`はstdin/`--task`、三出力形式、non-canonical executionの保存とreadback、Host清算・
出力drain・終了コードを確認する。
追加境界の負担は、現在の同じ履歴・更新を用いて初回snapshot、SSE、操作応答、Worker起動を比較する。

focused確認とtype/format/lint/diff確認に加え、公式compileと隔離XDGのproduction
TUIをtmux上で確認する。 実provider
callが必要な確認は、対象・回数・保存先を提示し、利用者の明示承認を得てから行う。

architectureを変更する場合の案は、Coreが所有するAPI Workerを追加し、HTTP/SSEの物理配置と
Core/APIの操作・購読・lifecycle境界と、headless Host/CLI adapterの境界を記載すること。
roadmapを変更する場合は、その採用範囲と
実装状態を反映すること。これらの正本変更は、個別incrementの採用・実装とは別に承認を得る。
方向づけと今回の事前確認は、production実装・配置・commit/push・正本文書変更の承認として扱わない。
