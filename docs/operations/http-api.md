# HTTP API — S22・A25

この文書は[Increment 140](../increments/increment-140.md)以降の独立core APIの利用方法を管理する。
共有型の正本は`v0/api/contract.ts`、JSON境界は`v0/api/codec.ts`である。 Slice
8までのSession操作、task受付・明示cancel・固定steering・follow-up、catalog・credential・pathとshutdownを提供する。
接続TUIは稼働Sessionでtaskを送り、保存Sessionへの操作は閲覧と明示resumeを区別する。
credential登録はCore全体の操作なので、idleなら保存Session閲覧中でも利用できる。

実装と常用配置の結果は[S22・147合同配置記録](../increments/s22-deployment-2026-09-28.md)、
起動ヘッダ・working／elapsed・Ctrl-Cの修正と配置は[Increment 148](../increments/increment-148.md)、
複数Coreの実装・review・実provider受入は[Increment 149〜153](../plans/a25-implementation-slices.md)、
その常用配置は[A25合同配置記録](../increments/a25-deployment-2026-09-29.md)を参照する。

## 起動と接続

```sh
henji
henji tui --continue
henji tui --new --agent generic
henji serve --port 5270
henji serve --port 0 --json
henji serve --port 5270 --session <saved-session-id>
henji tui --connect http://127.0.0.1:5270
henji tui --connect http://127.0.0.1:5270 --session <saved-session-id>
henji history --connect http://127.0.0.1:5270 --latest --view session
henji core list
henji --core <core-id>
henji --core <core-id> --new
henji --session <saved-session-id>
henji core status --core <core-id> --json
henji core stop --core <core-id>
```

`serve`はforegroundで待機する。既定hostは`127.0.0.1`、portは`0`（OS割当）。
`--json`はlistenと初期化完了後に一つの`core.ready` JSON recordをstdoutへ出す。 URL、API
version、core epoch、canonical workspace、PIDを含む。
Session指定なしのserveは稼働slotなしで待機し、taskを開始しない。
`--new`、`--continue`、`--session ID`、`--no-session`で初期Sessionを明示できる。
SessionのDefinition、provider、最大step、timeoutの指定は既存TUIと同じoptionを使う。

接続TUIの`--session`は、稼働中の同IDならattach、保存済みなら明示openで継続する。 保存閲覧はTUI
pickerのview、またはGET APIで行い、実行slotを変更しない。
TUIの終了・入力EOF・signalはclientのdetachであり、Coreや受付済みtaskを停止しない。
`henji core list [--json]`と対象省略の`core status`は、このworkspaceのCore一覧を返す。 Core
ID、PID、workspace、Session ID/titleまたは未open、phase、URLを確認できる。
`core status --core ID [--json]`と`core stop --core ID`はfull IDまたは一意なprefixで一つを指定する。
複数一致なら候補を表示し、停止済み・未発見なら状態を返す。代替Coreは起動しない。
`--connect URL`でも指定先を照会・停止でき、`--core`と同時には指定しない。
対象省略stopは一覧と指定方法だけを表示し、Coreを停止しない。
明示stopとserve自身へのSIGINT／SIGTERMはHTTP shutdownと同じ資源清算へ入る。
同じworkspace・XDGでも、serveと通常TUIは毎回新PID・epoch・URLのCoreを起動する。
launcherはspawn前にepochを採番し、そのepochのdescriptor・boot結果・APIを照合する。
引数なし`henji`と`henji tui`は同じHTTP clientへ入り、新Coreの空slotへ新Sessionを開く。
`--core ID`では一覧のfull
IDまたは一意なprefix、`--connect URL`では指定先だけへ接続し、新Coreを起動しない。
再接続は現在の稼働Sessionへattachし、
`--new`は新規Sessionを明示する。`--help`でcommandとoptionの所属を確認できる。
起動ヘッダは接続先の短いCore IDとSession IDを表示する。Session切替後もCore IDは保持する。
`henji --core ID --new`は選んだidle CoreのSessionだけを切り替える。
Core指定なしの`henji --session ID`は新Coreで保存Sessionを再開し、生存Coreへのattachとは別操作となる。
同じ保存Sessionが生存writerに所有されている間は二重writerを開かない。
config・credentialは共有、新Sessionの既定modelは共有config、稼働Sessionの選択はSession
stateに属する。 Core間で同じworkspace fileを編集する順番の調停は行わない。

WebUIは将来の別入口で、今回のbinaryでは未実装と説明する。 headless `run`とlocal
`history`／`sessions`／`module`／`tool`／`diagnostics`は既存local経路を維持する。

## 公開入口

すべて`/api/v1`以下で、JSON
responseを返す。coreが実装済みの操作は`implementedOperations`で確認する。

| HTTP                                              | 操作                | 結果                                                                            |
| ------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `GET /core`                                       | `core.read`         | API version、epoch、build、workspace、activeSessionId、phase、実装済みoperation |
| `GET /sessions`                                   | `session.list`      | 保存Session一覧とruntime Session                                                |
| `POST /sessions/open`                             | `session.open`      | 明示したSessionのlazy activationとsnapshot                                      |
| `GET /sessions/{id}`                              | `session.read`      | SessionSnapshot。閲覧だけではactivationしない                                   |
| `GET /sessions/{id}/events`                       | `session.subscribe` | SSE。先頭snapshotと以後の順序付き更新                                           |
| `GET /history?session={id-or-prefix}&view={view}` | `history.read`      | 解決したSession ID、view、既存rendererのtext                                    |
| `GET /history?latest=true&view={view}`            | `history.read`      | 接続先workspaceの最新保存Sessionの同じ結果                                      |

taskと実行の入口は次のとおり。

| HTTP                                                  | 操作               | 結果                                                 |
| ----------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| `POST /sessions/{id}/tasks`                           | `task.submit`      | commandId・textから受付結果とexecutionId             |
| `POST /sessions/{id}/executions/{executionId}/cancel` | `execution.cancel` | 対象実行への明示cancel受付                           |
| `GET /commands/{commandId}`                           | `command.read`     | 同epochのprocessing／accepted／rejected              |
| `GET /executions/{executionId}`                       | `execution.read`   | task、outcome、adoption、清算、request数とdurability |

historyのviewは`session`、`canonical`、`detail`。`detail`のtextは既存human history
exportのJSONLである。 対象ID・prefix・latestはcore側で解決する。接続失敗時にclientのlocal
storeへ切り替えない。 Session openと履歴閲覧を区別し、GETだけではWorker・provider
requestを開始しない。

Session openのJSON inputは`commandId`（UUID）と`selection`を持つ。
`selection.kind`は`new`、`continue`、`exact`、`none`で、`exact`には`sessionId`を指定する。
任意の`activation`に`agent`／`definitionRevision`、`maxSteps`、`providerTimeoutMs`、`rootProvider`を指定できる。
結果は共有command形式で、acceptedの`value.snapshot`を参照する。openも同じ`command.read`で照合できる。
`fromSessionId`をnewへ指定すると、Coreが表示元selectionと現slotのactivation条件を引き継ぐ。
保存resumeは保存activeModelを優先し、rootProviderで上書きしない。

```sh
curl -X POST http://127.0.0.1:5270/api/v1/sessions/open \
  -H 'Content-Type: application/json' \
  -d '{"commandId":"14000000-0000-4000-8000-000000000001","selection":{"kind":"new"}}'
```

この操作はSessionを準備するだけで、taskを送らない。 openのsnapshotはcursor（epoch・Session
ID・revision）、Sessionのposition／selection／startup、
runtime、conversation（messages・tools・thinking・requests）、pending、credential
availability、contextを持つ。 lazy
Sessionのstartupは既知のversion／workspace／agent／model／sessionMode等を起動直後から含む。
`status: "unevaluated"`ではcontext／skillsをWorkerの実評価結果として扱わない。
Worker評価後は`status: "evaluated"`と実際のinstructions／skillsを通知する。

## TypeScriptに依存しない読取

```sh
curl http://127.0.0.1:5270/api/v1/core
curl http://127.0.0.1:5270/api/v1/sessions
curl 'http://127.0.0.1:5270/api/v1/history?latest=true&view=canonical'
curl -N http://127.0.0.1:5270/api/v1/sessions/<id>/events
```

SSEの先頭frameは`session.snapshot`で、JSON dataの`snapshot`がclient初期値となる。
`session.update`はcursor、previousRevision、changesを持つ。
再接続は新たな先頭snapshotから表示を復元し、同じcore processではepochを維持する。
coreの再起動を越える実行の自動継続・SSE frameの永続再送は提供しない。

共有TypeScript clientは`HenjiApiClient`であり、標準fetch・stream・AbortSignalを使う。
TUIなしでも上記HTTP契約を直接利用できる。

## task受付・明示cancel・結果参照

稼働Sessionのsnapshotにある`runtime.operations`から、現在使える操作を確認する。
coreの`implementedOperations`は実装済み操作の一覧であり、Sessionの現在の受付条件とは別である。
保存Sessionのsnapshotを読むだけではtaskの送信先を変更しない。

```sh
curl -X POST http://127.0.0.1:5270/api/v1/sessions/<session-id>/tasks \
  -H 'Content-Type: application/json' \
  -d '{"commandId":"14100000-0000-4000-8000-000000000001","text":"依頼"}'
curl http://127.0.0.1:5270/api/v1/commands/14100000-0000-4000-8000-000000000001
curl http://127.0.0.1:5270/api/v1/executions/<execution-id>
curl -X POST http://127.0.0.1:5270/api/v1/sessions/<session-id>/executions/<execution-id>/cancel \
  -H 'Content-Type: application/json' \
  -d '{"commandId":"14100000-0000-4000-8000-000000000002"}'
```

受付が成功するとHTTP 202で`kind: accepted`、`commandId`、`target`、`value.executionId`を返す。
この時点はtaskの完了ではない。同commandIdの再配送は同じ受付を照合し、別実行を開始しない。
業務上の拒否は`kind: rejected`と`reason`で返す。 受付responseとSSE
updateの到着順は前後し得る。会話状態はsnapshot／SSEから適用し、
受付responseの本文をもう一度会話へ追加しない。

送信したresponseを受け取れなかった場合は、同じcommandIdを`command.read`で照合する。
`processing`は受付処理中、`accepted`は対応executionを参照、`rejected`は理由を確認する。 未発見やcore
epoch変更では受付を未確定として扱い、自動的に別taskを再送しない。 command照合はcore
process内の情報であり、再起動を越える再送保証ではない。

cancel結果の`value.result`は`requested`／`already_requested`／`idle`。
UIの終了やHTTP接続の切断は、この明示cancel操作を送らず、受付済み実行を継続する。
接続TUIではbusy中のEscが対象実行へのcancel。Ctrl-Cはbusy中もdraftを消す。
`/detach`・Ctrl-D・TERM／HUPはdetachし、受付済み実行とfollow-upを継続する。
通常の`henji`は毎回新Core・新Sessionを開く。
生存Coreの稼働Sessionへ戻るときは`henji --core ID`または`henji --connect URL`で再接続する。
working／cancellingと経過時間はフッター二行目の先頭に表示する。
経過時間はexecution開始時刻から表示し、再接続でも引き継ぐ。

`execution.read`の結果は`{ "execution": ... }`。
`execution`はtask、turn、lifecycle、outcome、canonical adoption、requestCount、durabilityを持つ。
`submittedByCommandId`はこのcoreでの受付と実行を相関する。
`processSettlement`は`running`／`settling`／`complete`／`unknown`で、
outcomeとcanonical採用が決まること、process清算が完了することを別々に示す。
保存履歴から清算を確認できない場合は`unknown`とする。 Session
snapshotの`runtime.execution`から直近実行と同じ状態を参照でき、
cancel後の結果と未採用の途中表示も再接続で読める。

## steeringとfollow-up

稼働executionにはsteering一回とfollow-up一枠を受付できる。接続TUIはbusy中のEnterでsteering、Alt-Enterでfollow-upを送る。draftは受付結果を待って処理し、受付不明時は元command
IDを照合する。

| HTTP                                                    | 操作              | 結果                                         |
| ------------------------------------------------------- | ----------------- | -------------------------------------------- |
| `POST /sessions/{id}/executions/{executionId}/steering` | `execution.steer` | commandId・textから対象executionへの受付     |
| `POST /sessions/{id}/follow-up`                         | `followUp.queue`  | commandId・afterExecutionId・textからqueueId |
| `GET /sessions/{id}/follow-up/{queueId}`                | `followUp.read`   | 予約・開始・取り下げのrecord                 |

steering／follow-upの成功はHTTP202のaccepted
receiptを返す。snapshot／SSEの`pending`はCoreが所有する受付済み入力を示す。`steering`は消費待ち、`followUp`は開始待ちで、消費されたsteeringはsemantic会話へ移る。`followUps`は開始・取り下げ・開始失敗の結果recordを持つ。

follow-upは親executionの成功とprocess清算後に同じCoreが一度だけ開始する。TUIのdetachで取り消さない。明示cancelまたは失敗では自動開始せず、本文と停止理由を残す。recordは`queueId`、`afterExecutionId`、本文、`status`（queued／started／discarded／startRejected）、開始時のexecutionIdまたは理由を持つ。

`followUp.read`の結果は`{ "followUp": ... }`。同じCore epochでは、idle
slotを別Sessionへ置換した後も元Session／queue
IDで結果を読める。読取は旧Hostをactivateしない。Core再起動を越える予約保存・自動再実行は行わない。

## Sessionの変更とcontext

| HTTP                         | 操作                   | 結果                                                                    |
| ---------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `POST /sessions/{id}/title`  | `session.rename`       | commandId・title、renamed／unchanged                                    |
| `POST /sessions/{id}/recall` | `recall.prepare/clear` | commandId・action・任意executionId、準備したIDとevidenceまたはclear結果 |
| `GET /sessions/{id}/context` | `context.read`         | checkpoint、準備済みrecall、実際の直近request ordinal／step／item数     |

変更はidleの稼働Sessionを対象とし、busyは共有rejected結果を返す。
recallのprepareは既存の非採用executionをID／prefix／latestから選び、providerを呼ばず準備する。
次の一taskで消費する。clearは準備済み状態を取り消す。
contextの読取はcompactionを開始せず、保存SessionにもHostを起動しない。

稼働snapshotの`runtime.effectiveConfig`は実際のDefinition、maxSteps、provider
timeoutとactivation条件を示す。 managed Definitionの未評価既定はmaxSteps
null／unevaluatedとして示し、Workerの実評価後に値が確定する。
保存閲覧には過去のruntime設定を推測して付けない。

## catalog・selection・credential・path

| HTTP                                                             | 操作                      | 結果                                                     |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `GET /catalogs?kind=providers`                                   | `catalog.read`            | providerとそのdefault selection                          |
| `GET /catalogs?kind=models&provider={provider}`                  | `catalog.read`            | 実catalogのmodel・default effort・利用可能effort         |
| `GET /catalogs?kind=efforts&provider={provider}&modelId={model}` | `catalog.read`            | 対象modelのeffort                                        |
| `GET /catalogs?kind=credentials`                                 | `catalog.read`            | authProfileとそれを利用するprovider                      |
| `POST /sessions/{id}/selection`                                  | `selection.change`        | commandId・selection、selected／unchangedと実効selection |
| `GET /credentials/presence`                                      | `credential.readPresence` | authProfile別のpresent／missing／unknown                 |
| `POST /credentials/register`                                     | `credential.register`     | 専用入力の保存結果とpresence                             |
| `GET /workspace/paths?prefix={prefix}`                           | `path.read`               | Core workspace、探索complete、相対path候補               |

selection inputは`{commandId, selection: {provider, modelId, effort}}`。
idleの稼働Sessionを変更し、Sessionと次回defaultへ保存する。実際のprovider declarationとmodel
catalogをCoreが使用し、client側のcatalogやcwdへ切り替えない。読取だけではWorker・providerを起動しない。

credential register inputは`{authProfile, value}`だけを専用requestで送る。
一般commandのcommandId・照合cacheを使わず、valueをSession履歴・snapshot・診断へ保存しない。
結果は`{kind: "registered", authProfile, status}`、または`{kind: "rejected", reason}`。
Coreが既存の固定credential保存経路へ登録し、presenceを更新する。busy中は登録しない。
TUIの`/login`は引数を取らず、専用dialogでtype／pasteする。credential値は画面へ表示しない。

path候補はCore workspaceの既存indexから読み、file内容はこのAPIで返さない。
prefix省略はindex全体の候補を返す。clientは引用・曖昧候補・不完全探索の既存操作を使い、
file-referenceの実際の読み込みはtask実行時のHostが行う。

## Coreの明示shutdown

`POST /api/v1/core/shutdown`へ`{"commandId":"<UUID>"}`を送る。acceptedはHTTP 202で、 targetはCore
epoch、valueは`{"result":"requested"}`となる。同じepoch内のcommand形式を共有する。
これは停止の受付であり、受付時に新規受付とSSEを閉じ、202返却後に進行中HTTPをdrainして、
Worker／子実行／process／history、metadataとinstance lockを清算してからlistenerを閉じる。
停止中の後続HTTPは503 `core_stopping`を返す。
`core stop`は停止を観測してから終了し、localの場合はinstance lockの解放も待つ。
接続TUIでは`/shutdown`またはCtrl-Qが接続先Core全体を停止し、清算後に操作元TUIも終了する。
busy中や保存Sessionの閲覧中も同じCoreを停止する。他の接続TUIはDISCONNECTEDとなり、
各利用者が`/detach`またはCtrl-Dで閉じる。複数Coreがある場合、ほかのCoreは継続する。
`/detach`・Ctrl-Dは接続だけを切る。従来の`/exit`は`/detach`へ改名した。
`/`だけでは候補を表示せず、`/s`等の最初の文字から案内する。候補が一つならTabで補完できる。
次の人間の起動は新epochとなり、保存Sessionは明示再開できるが、途中taskを自動送信し直さない。
UIのdetachや最後のclientの切断からshutdownを呼ばない。

```sh
curl -X POST http://127.0.0.1:5270/api/v1/core/shutdown \
  -H 'Content-Type: application/json' \
  -d '{"commandId":"14500000-0000-4000-8000-000000000001"}'
```
