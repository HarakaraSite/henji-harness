# Increment 189 — A26 最小hook機構とruntime開始日時の外部定義

状態: 実装・検証・常用配置・local commit済み（2026-10-04）。6スライスそれぞれの実装・focused
test・独立reviewを完了した。配置結果は§16に記録する。
6種のhook、Worker単位のruntime、外部TSによる処理、開始日時の挿入、親・子に共通するデフォルト適用は
会話で合意した入力である。local実装・非破壊検証・スライスごとのreviewを承認された。
必要な最小限の実provider利用も承認された。使用時は対象・回数・保存先を事前に提示し、結果を本書へ記録する。
当初の承認に常用配置、commit、公開/releaseは含まない。常用配置・commitは§16で追加承認された。

## 1 必要な動作と受入条件

利用者は、決まった実行境界で処理を呼ぶ仕組みをHenjiへ導入し、その具体的な処理を外部TSで
定義・変更できるようにしたい。hookの数を必要最低限にし、初回は次の6種を備える。

| hook            | 必要な動作                                                                |
| --------------- | ------------------------------------------------------------------------- |
| `runtime_start` | Workerの構成完了後、task受付前に1回呼び、外部定義の共通contextを反映する  |
| `runtime_stop`  | Workerの通常停止時に1回呼び、後処理の完了を待つ                           |
| `before_turn`   | 各turnの処理開始前に呼び、そのturnのcontext追加を反映する                 |
| `after_turn`    | 実行・保存・採用結果の確定後に呼び、次turn用contextの更新を保存する       |
| `before_tool`   | 各tool実行直前に呼び、加工後の引数で実行する                              |
| `after_tool`    | toolの通常結果・エラー結果を渡し、加工後の本文を履歴・model入力へ反映する |

ビルトインは呼出点、型付き契約、登録順のawait実行、結果の適用・保存を担当する。
具体的な処理と適用対象の判断は外部TSが担当する。
親Agent、named子Agent、generic子Agentで共通デフォルトの外部定義を有効にし、外部TSへAgent名と
親／子の区別を渡す。例えば全Agentへ開始日時を挿入し、親だけでcompactionを行う定義を書けるようにする。
子のhookは子の実行とcontextを対象にし、親のcontextへ結果を自動挿入しない。

最初の外部定義は`runtime_start`で日時を取得し、UTC offsetとtimezone名を含む開始日時を
共通contextへ挿入する。新Workerは日時を新しく取得し、同じWorkerの後続turnは同じ値を使う。
開始日時は現在時刻という説明にしない。

受入条件は、compiled production経路で外部TSを読み込み、親・子のhookを所定の境界で実行し、
開始日時とcontext／tool加工結果をproviderへ渡す内容・保存履歴から確認できること。
`after_turn`のcontext更新は次taskとSession再開へ反映し、元の会話履歴を保持する。
通常停止では`runtime_stop`の終了後にWorkerを止める。

## 2 根拠と対象外

合意の背景は[A26提案](../research/a26-minimal-hooks-proposal-2026-10-04.md)を参照する。
2026-10-02更新の手元`_refs`を静的に再調査した。Piのtyped TS登録、OpenCodeのhook objectと直列await、
Zot・DeepSeekの通知と介入の区別を参考にした。各実装の動作実測は行っていない。
snapshotとcommitは[`_refs/README.md`](../../_refs/README.md)を正本とする。

本incrementは次を対象外とする。

- 実際に要約modelを呼ぶcompaction外部定義、要約方式・圧縮閾値・残す量の標準方針。
- 毎model呼出し前のhook、stream加工、汎用block、compaction専用hook、hot reload、動的登録。
- Data Worker等への新しいhook呼出点。共通機構を他componentでも利用できる構成だけを保つ。
- 元履歴・旧DB・実fileの自動削除やmigration、旧managed revision方式の復活。
- 一般的なsecurity hardening、permission判定、hook独自のtimeout・入力上限。

credential値・Authorizationをhook入力、context、記録へ含めないという既存の明示境界は維持する。
強制終了・process crash時の`runtime_stop`、Workerが失われた場合の`after_turn`は実行保証の対象外。

## 3 現行product経路と必要な接続変更

### 3.1 設定と起動

task受付／Session選択から`configuration_resolver.ts`が現在のAgent JSONとtoolを選択する。
`worker_bootstrap.ts`はworkspace instructionとskillを読み、Worker内の
`createConfiguredWorkerComposition`が外部toolをimport・factory実行して共通構成を作る。
共通baseをfinalizeし、configuration snapshotとreadyをData／Hostへ渡す。
rootと子は同じfactoryを使うが、genericは同梱default基底で親のJSONを継承しない。

hookは同じWorker起動経路へ追加する。外部moduleのfunction・closureはWorker外へ渡さず、
設定・実効登録一覧・実行結果だけをdataとして保存する。
`runtime_start`の返却contextを最終instructionとconfiguration snapshotへ含めてからreadyにする。

### 3.2 turnとData確定

Workerは各turnの開始時にAgent–Data直接channelからgenerationContextを取得し、transcript・checkpointを
更新する。Agent loopの`turn_end`はData採用前であり、`after_turn`の呼出点には使わない。
loop終了後、Workerが全文proposalをDataへ送り、CoreがDataの採用判断を確定してcommit ackを返す。
CoreはWorkerの`turn_settled`を待って次taskへ進む。

既存失敗経路と子のnon-canonical settlementにもDataの確定結果をWorkerへ返す通知を追加する。
`after_turn`、その効果の保存、Workerの`turn_settled`の順でawaitする。
hookの完了前に次taskへ進まない。
正常なhookを含むready、turn_settled、closedの完了待機へ既存の5秒応答期限を適用しない。
既存HostMessageQueueの期限なし待機を使用し、Worker
error・喪失、明示的な強制取消は既存経路で終了する。 他の短いcontrol
requestや明示取消の清算期限は、正常なhook待機とは別の既存契約として扱う。

### 3.3 checkpoint

既存checkpoint proposalはexecution journalを通る。Dataはprepare／settlementでjournalをsealするため、
確定後の`after_turn`から既存proposalへ送っても受理されない。 旧base revisionも確定後のSession
revisionとは一致しない。
Workerローカルのcheckpointだけを書き換えると、次taskのgenerationContext取得で上書きされる。

確定後のhook効果をAgent–Data直接channelから保存する専用operationを設ける。 Dataが返す確定後のstate
revisionを用い、Session checkpointとhook効果を保存してからackを返す。 既存のsummary＋retained
canonical suffixというprojectionを再利用し、元transcriptを書き換えない。

### 3.4 toolと停止

loopはmodelのtool callをassistant messageとsemantic
eventに記録した後、コピーをRegistryへdispatchする。
引数加工をdispatchだけへ追加すると、記録された原案と実行引数が違うため、両者の対応記録も追加する。
terminal toolのresult本文と最終出力`finalText`は別値である。

現行Hostの通常closeはsupervisorからWorkerを直接terminateする。 Workerには`close`
commandがあるので、通常停止をこの経路へ接続し、hookとresource終了をawaitしてから
`closed`を返す。rootだけでなく通常の子Worker清算にも同じ停止経路を使う。
既存の強制取消・crash処理は強制終了として区別する。

## 4 外部定義の選択と配布の具体案

config rootの`hooks.json`を共通catalogとデフォルト一覧の正本にする。 hook moduleのpathはconfig
root相対または絶対pathとし、外部TSのlocal importはDenoで解決する。 初回にtoolと別のmanaged
storeやhookごとのmetadata fileは設けない。

```json
{
  "schemaVersion": 1,
  "default": ["runtime-start-time"],
  "hooks": {
    "runtime-start-time": "hooks/runtime-start-time/index.ts"
  }
}
```

| Agent JSONの指定                             | 実効登録                                            |
| -------------------------------------------- | --------------------------------------------------- |
| `hooks`省略                                  | 共通catalogの`default`をそのまま使う                |
| `"hooks": ["my-hook", "runtime-start-time"]` | 明示一覧をその順に使い、デフォルトと自動mergeしない |
| `"hooks": []`                                | 外部hookを登録しない                                |

全Agentでこの解決規則を共用する。子は親の登録済みclosureを継承せず、子の起動時に同じconfig rootから
共通デフォルトを解決する。親／子で処理するかの通常の判断は外部TSに置き、設定側にrole
filterは追加しない。 catalogのない環境は登録なしとし、旧formatや別探索先へfallbackしない。
module不在やimport／factory失敗は対象名・path・理由を既存構成不足の仕組みで提示し、
当該moduleを実効登録一覧へ含めない。未知metadataだけを理由に拒否しない。

repositoryの`external-hooks/runtime-start-time/index.ts`で開始日時定義を管理する。
packageへ外部folderを同梱し、installerが隔離config rootの`hooks/runtime-start-time/`へ配置する。
既存外部toolと同じく編集可能なfileを新Workerで読み込み、起動済みWorkerの処理は差し替えない。
再installでは既存hook
folder・catalog設定を保持し、明示的な`--replace-hooks`時だけ配布fileをコピーする。
初回installはdefaultへ開始日時定義を登録する。既存catalogの他entryや既存Agent JSONを書き換えない。
実configと常用binaryへの配置は計画承認後のlocal実装とは別の承認対象とする。

## 5 公開APIと入力の具体案

新しい公開specifierを`@henji/hooks`、contract名を`henji-hooks/v1`とする。
typeと必要なruntime値はbinaryに同梱し、外部TS自体はruntimeでimportする。
`HookFactory`はWorker内で一度呼び、最大6つの任意handlerを持つ`HookHandlers`を返す。
factoryと各handlerは同期・非同期の双方を扱う。

```ts
export type HookFactory = (input: HookFactoryInput) => HookHandlers | PromiseLike<HookHandlers>;

export interface HookHandlers {
  runtime_start?: HookHandler<RuntimeStartInput, ContextAddition>;
  runtime_stop?: HookHandler<RuntimeStopInput, void>;
  before_turn?: HookHandler<BeforeTurnInput, ContextAddition>;
  after_turn?: HookHandler<AfterTurnInput, NextContextUpdate>;
  before_tool?: HookHandler<BeforeToolInput, ToolArgumentsUpdate>;
  after_tool?: HookHandler<AfterToolInput, ToolTextUpdate>;
}

export type HookHandler<I, O> = (input: I) => O | void | PromiseLike<O | void>;
```

公開型の正本は`v0/agent/hook_api.ts`である。factory inputはworkspaceと既存の実行seamを
Worker内で渡す。credentialを利用するrequestは既存のcredential解決付き`requestProvider`を使う。
後処理中のrequest factも確定後hook効果の保存経路で記録できるようにする。

全handlerに次のruntime情報を渡す。

- component（初回は`agent`）、Agent名、実行role（`root`／`child`）。
- workspace root、Session相関、Worker generation。
- 子の場合のparent execution IDとspawn call ID。
- turn／toolの場合のexecution ID、turn番号、必要に応じmodel stepとcall ID、当該処理のsignal。

親／子は`enableAsyncAgents`から推測せず、Hostの起動入力に明示してWorkerへ渡す。
開始時点でまだないturnのexecution IDをruntime情報へ捏造しない。 tool
hooksにはtool名と引数・結果を渡す。runtime_stopには通常停止の理由を渡す。
同じmoduleを複数Workerで読む場合もfactory変数とhandlerはWorkerごとに独立する。

## 6 contextの表現と変更結果

hookへ渡すcontextは本体のlive mutable stateではなく、その呼出時点のsnapshotとする。
snapshotはobjectとして参照でき、変更は明示的な戻り値で本体へ適用する。
handlerがないeventで巨大なcontext snapshotを新しく組み立てない。

context snapshotにはsystem instructionとcomponent出所、実効tool宣言、canonicalなturn単位のmessages、
既存checkpointを区別して含め、checkpoint適用後のmessagesも参照できるようにする。
利用者の採用判断に基づき、元履歴とcheckpoint適用後messagesを毎回別々に全量コピーしない。
canonicalなturn snapshotをreadonlyとして保持し、checkpointとretained suffixの境界から必要なviewを
導出する。projectionはsnapshot内のmessageを参照し、会話本文の重複コピーを避ける。
同じeventのhandler間でも会話snapshotを共有し、追加contextや更新checkpointに対応するviewだけを更新する。
共有するのはsnapshot内のdataであり、本体のlive mutable stateを外部TSへ公開する方式には変えない。
runtime_startは起動構成、before_turnは今回の入力、after_turnはData確定結果と
最終assistant／tool結果を含む完了時点のcontextを参照する。
最後にproviderへ送ったrequestだけをafter_turnのcontextとはしない。 tool
hooksのtranscript/projectedContextは、呼出時点の確定済み会話とcheckpointからのviewである。
turn中はcanonical履歴が進まないため、その会話snapshotを共有する。 今回callの引数/結果とstep/call
IDは別payloadで参照し、system instructionは
before_turnの寄与を含む呼出時点の値を渡す。完了した今回turnの会話はafter_turnで参照する。

`runtime_start`と`before_turn`の戻り値は`{ context: readonly string[] }`の追加寄与とする。
startup寄与はWorker寿命のnamed instruction componentとして、全model requestへ反映する。
before_turn寄与はそのturnのmodel requestに使い、次turnへ自動累積しない。
各handlerはそれまでの追加寄与を含むsnapshotを受け取り、返却分を順に追加する。 base
instruction、role、tool guideline等の既存componentを丸ごと置換しない。

`after_turn`の戻り値は次turn用の`{ checkpoint: { summary, coveredThroughTurn } }`とする。
外部TSがどこまで古い部分を圧縮するかを選び、本体がretainedFromTurn等の保存metadataを生成する。
最初のcontext更新契約は、利用者が示した「古い部分の要約＋最近のcontext」を既存turn境界で表現する。
追加のcontext書換え用途が必要になった場合は、その用途から戻り値を拡張する。
既存checkpointがある場合もsnapshotへ前回summaryと残りのturnを渡し、再圧縮できるようにする。

開始日時の共通componentはcompaction対象の会話messagesとは分ける。
Session再開でcheckpointは復元し、新Workerの開始日時は新たに取得する。 子・non-persistent
runでは自身のData ownerが保持するcontextへ適用し、persistent Sessionへの保存と
区別する。親のcheckpointやcanonical会話を変更しない。
after_turnのcontext更新は確定済みのoutcome・採用結果を変更しない。

## 7 after_turnの確定後プロトコル

root／child、正常／失敗／cancelの通常終了を同じ確定通知に揃える。
Core側の通知にはacceptedだけでなく、Dataが確定したadoption、durability、確定後state
revisionと必要なterminal metadata（ok/outcome/stopReason/error）を含める。
全文contextと更新内容はAgent–Data直接channelを使い、Coreのcontrol channelへ載せない。

1. Workerがloop結果をDataへ送り、Coreが既存の採用／非採用判断と保存を完了する。
2. Coreが小さい確定通知をWorkerへ返す。失敗・子にも同じ通知を返す。
3. Workerが自身の確定結果とcontextでafter_turnを1回実行する。
4. Workerがhook効果と次context更新をDataへ送り、DataがSession／自身のcontextとsemanticな効果を保存する。
5. Dataの保存ackを受けてWorkerがturn_settledを返す。
6. Coreが最終通知・子resultの公開・次task受付へ進む。

確定後のData operationは既存のsealed execution_data受付とは別にする。
checkpointは確定後revisionに結び、既存Data ownerとHistoryStoreの保存処理で更新する。
本体が自動的に圧縮方針を選んだり、古い会話を削除したりしない。
non-canonicalな実行の結果とcanonicalなSession contextを区別し、after_turnに双方の関係を渡す。
失敗した未採用draftをSession会話へ採用する操作にはしない。

通常停止は進行中turnの既存cancel／settlementとafter_turnを待ってからruntime_stopを呼ぶ。
その間はfactoryに渡したprocess等のseamを使用可能にし、runtime_stop終了後にprocess／Registry／Data
portを 閉じ、closedを返す。既存の強制取消経路では停止hookを待つことを保証しない。

## 8 tool加工と実行記録

before_toolは`{ arguments: JsonValue }`を返せる。call IDとtool名を維持して加工後引数を実行する。
modelが発行したassistant messageのtool callは原案として保持する。 実行記録には同じcall
IDの原案・実効引数と加工したhookの出所を対応付ける。
加工後引数を渡したという事実をmodelにも確認できるよう、tool resultのinput補足として投影し、
modelが記憶する原案と実行した値の違いを隠さない。

after_toolは`{ text: string }`を返せる。元の実行outcomeとcall IDを維持し、 加工後textをcanonical
tool message、次request、表示へ同じ値で反映する。 実行の元textと加工の出所はsemantic履歴に残す。
terminal toolの`finalText`とterminal kindは実行結果を維持し、本文加工で最終JSON回答を書き換えない。
terminal finalTextの加工やtool名変更、汎用blockは初回の戻り値に加えない。

configuration snapshotへ実効hook一覧・登録順・module
path・contract・登録handler・構成不足理由を追加する。 runtime_startの寄与は同じsnapshotのinstruction
componentから確認できる。 turn中の効果は既存semantic
journal、after_turnの効果とexecutionに関連するruntime_stopの結果は
Dataの確定後append経路へ保存する。 runtime_startの結果と日時はready時のconfiguration
snapshotを正本とし、既存と同じconfiguration保存時に
残す。executionのないWorkerの停止結果は通常closeのreplyに含め、独立した永続lifecycle
storeは追加しない。 executionの変更した値・hook出所・例外の位置をsemantic factとして保存する。
検証用hookの全呼出順traceは個別probeで取得し、通常実行の常設traceにはしない。
context寄与は既存content保存と出所sidecarを再利用し、request本文やraw SSEを常設収集しない。

## 9 例外の扱いの具体案

外部TSの正常動作を拒むための安全機構を追加しない。
例外はmodule名、hook名、phase、理由を持つ実行失敗として既存の診断・履歴・構成表示へ接続する。
handlerが返した正常な結果は対応するproduct contractで扱い、test fixtureの都合で制限しない。

- import／factory失敗は構成不足として提示する。runtime_startの例外は当該moduleの初期化失敗として
  提示し、初期化済みと記録しない。失敗moduleのhandlerを実効登録から除く。
- before_turnの処理例外はそのturnの失敗、before_toolの例外はそのcallのtoolエラーとして伝える。
  処理成功を装って次へ進めない。これはhook処理自体の失敗であり、permission gateではない。
- after_toolは既に実行済みのtool結果とhook加工の失敗を分けて記録する。元のtool結果を保持し、
  加工失敗をmodelと人間から確認できるようにする。
- after_turnの例外・context保存失敗は確定済みturnを再採用／再失敗にしない。後処理の失敗を別に報告し、
  返却されなかった更新や保存できなかった更新を適用済みと記録しない。
- runtime_stopの例外は停止時の後処理失敗として報告し、既存resourceの終了は継続する。

既存のcancel、process清算、provider requestの契約をhook実行でも使う。
handlerの順序とどのphaseが成功／失敗したかを保存し、通知callbackの例外でDataの確定結果を変えない。
既存checkpoint上限等と新しいcontext更新の整合は、実装時に現行contractを確認し、
本計画を根拠に新しい上限や自動切捨てを追加しない。

## 10 実装順序と変更対象

現行経路の確認に基づく変更対象は以下のとおり。実装は下記スライスで進める。

| 段階                       | 対象と作業                                                                                                                                                  | その段階で確認するproduct動作                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 外部登録と共通API        | `v0/agent/configuration/`へcatalogとAgent hooks選択、`v0/hooks/`へloader／runner、`v0/agent/hook_api.ts`へ公開型、`worker_configuration.ts`へ実効登録を追加 | root／named／genericが同じdefaultを解決し、外部TS factoryとlocal importをWorker内で読める                           |
| 2 起動日時と停止           | Worker bootstrap／runtime／supervisor／host childrenへruntime前後を接続。`external-hooks/runtime-start-time/`を追加                                         | ready前に日時が反映され、同Workerの値を保持し、新Workerで更新する。通常closeでstopをawaitする                       |
| 3 turnとtool               | `core/loop.ts`、`tools/tools.ts`、実行contextとsemantic履歴へbefore_turnとtool前後を接続                                                                    | context追加、実効引数での実行、加工後結果のrequest／履歴整合を確認する                                              |
| 4 確定後context            | Worker／Host／child protocol、Agent–Data contract／client／endpoint、Data owner／HistoryStoreへ確定通知とhook効果保存を追加                                 | 成功・失敗・子でafter_turnが確定後に動き、保存ack前に次task／子resultへ進まない。checkpointが次turnと再開へ反映する |
| 5 standalone配布と利用案内 | `deno.v0.json`の公開specifier、build manifest、`scripts/package_henji.ts`、`scripts/install_henji.sh`、外部hook説明とREADMEを更新                           | repo・別Denoなしのbinaryが外部TSを読める。隔離installで全Agentの日時定義と編集反映が成立する                        |

新しい共通runnerはcomponent非依存のhandler実行と順序だけを所有する。
Agentのcontext適用、Dataの保存、Worker lifecycleを共通runnerへ移さない。
同期AgentEventSinkを非同期hookの代用にせず、既存の表示通知経路を維持する。
checkpoint保存は既存ownerを拡張し、Worker専用の別永続storeを作らない。

### 10.1 実装・検証・reviewのスライス

各スライスを実装し、対応するproduct動作のfocused test・関連type check・format・lintと read-only
reviewを終えてから次へ進む。review findingはownerが要件とsource-to-impactに照らして採否を決め、
採用したcorrectness問題を当該スライスで修正する。既存の未commit変更は保持する。

| slice             | 完成する動作                                                                   | 検証とreview範囲                                                                                    |
| ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| S1 登録・公開API  | hooks.json、Agentの選択、Worker内factory、順序付き共通runner、snapshot登録情報 | root/named/genericのdefaultと明示指定、外部TS local import、同期/非同期factory、診断                |
| S2 runtime        | 親/子identity、開始日時context、通常stopのawait、正常hook待機と5秒期限の分離   | 実Workerの起動・通常停止・再起動、親/子、5秒を超える正常処理、開始時刻の保持                        |
| S3 turn/tool      | before_turn追加、before_tool引数加工、after_tool本文加工とsemantic記録         | turn限定context、原案/実効引数、通常/エラー結果、terminal finalText維持                             |
| S4 確定後context  | rootのafter_turn、Data確定後operation、checkpoint保存・projection              | 保存ackと次task順序、最終回答snapshot、元履歴保持、次turn/再開、重複コピー回避                      |
| S5 子・失敗の確定 | 子・失敗・cancelの確定通知、after_turn、確定後request fact                     | 子自身のcontextと親の分離、子result公開順序、未採用結果とSession context、後処理失敗                |
| S6 配布・実経路   | standaloneの公開API、外部日時定義のpackage/installer、利用案内                 | 隔離build/install、外部編集の新Worker反映、production API/runと履歴readback、必要なら最小実provider |

S4終了時点では子・失敗のafter_turn接続を完了扱いにせず、S5で完了する。
各スライスの実装結果、検証コマンドと観測、review採否を§14へ記録する。

## 11 検証計画と未確認範囲

testは上記のproduct動作と確認済み接続問題に対応させる。 実装中は変更箇所のfocused test、関連type
check、format、lint、git diff --checkを使う。 本計画はfull
gateを要求しない。test件数は完了条件にしない。

- 共通defaultをroot／named／genericへ適用し、外部TSにrole情報を渡して子だけ処理を省略できることを確認する。
- 6 hookの実呼出点を、実Worker・Host・Data経路の小さな検証用外部TSで観測する。 startup
  context、turn追加、引数加工、通常／toolエラー結果、確定後checkpoint、正常closeを確認する。
- compactionの基盤確認には手作業で用意したsummaryと保持境界を返す検証用after_turnを使う。
  元履歴の全文保持、最終回答を含むsnapshot、次turnの要約＋最近のmessages、再開後のprojectionを確認する。
  この検証で要約品質や実compaction定義の完成を主張しない。
- 計画§9に定義した例外の代表経路で、実行済みtoolと採用済みturnの結果が加工失敗で失われず、
  hook失敗の理由を確認できることをfocused確認する。
- 公式buildとpackageを隔離HOME／XDG／workspaceへ配置し、production `serve`／public APIと
  `run`から外部TSのload、親・named／generic子、日時挿入、停止、context・semantic
  readbackを確認する。 model応答はlocalhostの確認用serviceを使い、実provider callは行わない。
- 日時定義のfile編集は既存Workerへ反映されず、新Workerへ反映されることと、再installで既存編集が保持されることを確認する。

初期定義は実行環境のtimezoneを`Intl.DateTimeFormat().resolvedOptions().timeZone`で取得し、
handler内で一度取得したDateから日時とoffsetを作る。固定UTC+09:00にせず、`toISOString()`だけで local
offsetを表したことにしない。UTCの場合も実際のtimezone／offsetとして表す。

既存の構成不足・診断表示にhook項目を追加した結果、TUI表示・操作が変わる場合は、 隔離XDGのtmux
production TUIで登録状態・失敗理由・日時のcontext readbackを確認し、観測を本書へ記録する。
実provider callを伴う確認は今回の最小利用承認の範囲で対象・回数・保存先を事前に提示する。 local
substitute serviceの確認と人間による通常利用の結果は区別して記録する。

## 12 reviewの反映と正本変更案

保存した初期提案をreviewerがread-onlyで批判的に確認し、提案段階の必須修正findingはなかった。
詳細contract事項として挙げた5点を本計画に具体化した。

| reviewで具体化が必要だった点           | 本計画での対応 |
| -------------------------------------- | -------------- |
| after_turnの確定通知・保存・次task順序 | §3.2、§3.3、§7 |
| contextの範囲と寿命                    | §5、§6         |
| tool原案／実効値とterminal finalText   | §8             |
| runtime_stopの通常close接続            | §3.4、§7       |
| default／named／genericの登録範囲      | §1、§4、§5     |

本詳細計画を通常reviewerと批判的reviewerが独立してread-onlyで確認した。
両者共通のP2必須指摘は1件で、正常な非同期hookの完了待機と既存5秒応答期限の分離が必要である。
現行Hostの起動readyとturn_settled待機には5秒期限があり、超過時はWorkerをterminateする。
通常closeへ既存WorkerCapsule.closeを流用する場合も同じ期限が掛かる。
最小修正案は正常なruntime_start、after_turnとData保存ack、runtime_stopの完了待機へこの応答期限を
適用せず、明示取消・Worker喪失の既存終了経路を維持することである。
HostMessageQueueは既に期限なしの待機を扱うため、待機機構の全面変更は不要であり、
既存の起動・turn終了と計画済み通常closeの接続変更が中心となる。修正方針を§3.2とS2へ反映した。

批判的reviewの任意案である、canonical全量とprojectionの重複コピーを避ける方針は利用者が採用し、
§6へ反映した。追加の必須correctness指摘はなかった。この計画review時点は実装前であり、実動作結果は§14以降へ記録した。
構想のWhyや人間の採用境界を変更する提案はない。
architectureにはhookの実行placement、Agent–Dataの確定後context更新、外部TSと本体の責務を
記載する変更案が必要になる。roadmapには6
hookと開始日時定義の採用・実装状態を反映する案が必要になる。
[具体差分案](increment-189-authority-proposal.patch)を別artifactとして保存した。
これらの正本は本計画への包括承認とは別に、具体差分を提示して利用者の明示承認を得るまで変更しない。

## 13 承認境界

local source実装・非破壊検証・スライスごとのreviewと必要最小限の実provider利用が承認範囲である。
常用配置、commit、公開/release、実データ削除・migrationは別の明示承認が必要である。
成果と検証結果は本書へ追記し、現在地と次の一手はhandoffだけへ保持する。

## 14 スライス結果

### S1 登録・公開API

hooks catalog、Agent選択、`@henji/hooks`型とcontract、Worker内loader、順序付きrunner、
構成snapshotへの実効登録と診断を実装した。 runnerは各handlerの結果をcaller
callbackへ渡してawaitした後に次inputを準備する。
context/arguments/textの具体的な適用責務はAgent側に残す。
S1ではruntime/turn/toolの実呼出点は追加していない。

focused testは共通default/明示置換/無効化、local importと非同期factory、順序付き合成、
snapshotとmodule不在の診断を確認し、3 test成功。

```sh
deno test --no-prompt --no-remote --allow-read=.,/tmp --allow-write=/tmp --config deno.v0.json tests/v0/increment_189_hooks_test.ts
```

関連公開型・configuration resolver・Worker configuration・loader/runner・test/fixtureの
`deno check`、`deno fmt --check`、`deno lint`と`git diff --check`も成功した。 full
gateと実providerは使っていない。
独立reviewはS1差分と直接caller・snapshot保存経路を確認し、必須correctness findingなし。
ownerも採用すべき追加問題なしと判断し、S2へ進む。
S2では読込済みclosureをWorker-localな構成結果へ保持し、factory再実行なしでruntimeへ渡す。

### S2 runtime

Worker-localな構成結果に読込済みhandlerを保持し、factoryを再実行せずruntimeへ渡した。
構成完成後・ready前にruntime_startをawaitし、寄与をhook別のnamed instruction componentへ追加する。
内部instruction identityと外部hook名を分け、sourceLocatorに正確なhook名/pathを残す。
親/子identityはHost起動入力から明示的に渡す。 通常root closeと子の正常清算をgraceful
closeへ接続し、進行中turnを待ってからruntime_stop、 process/registry/Data
portの順で清算する。stop例外は後続handlerと清算を止めずclosed/collectの診断へ返す。
正常ready/turn_settled/closedの待機から既存5秒期限を外し、明示取消/Workerエラーの終了経路を維持した。

実Workerのfocused testではstartとstopを各5.15秒待ち、正常完了を確認した。
start失敗moduleの実効登録除外、stop失敗後の後続handler、日時のUTC offset/timezone名、
instruction/configuration snapshotの寄与と出所を確認した。
同じWorkerは編集前のclosureを保持し、新しいchild Workerは編集後のTSを読み込む。
子のparentExecutionId/spawnCallIdとcollectのstop診断も確認した。

```sh
deno test --no-prompt --cached-only --unstable-worker-options --allow-read=.,/tmp --allow-write=/tmp --config deno.v0.json tests/v0/increment_189_runtime_test.ts
deno test --no-prompt --cached-only --unstable-worker-options --allow-read=.,/tmp --allow-write=/tmp --config deno.v0.json tests/v0/increment_181_worker_start_test.ts tests/v0/increment_170_s3_child_control_test.ts tests/v0/increment_170_s3_child_preparing_cancel_test.ts
```

S2変更13fileの関連`deno check`、`deno fmt --check`、`deno lint`と`git diff --check`が成功した。 full
gate・実providerは使っていない。stop効果の永続semantic記録はS4/S5で接続する。
S2の独立reviewはP2必須指摘1件を返し、ownerが採用した。 正常readyの期限を外した結果、rootのlazy
startup中はHost未設定で取消flagだけ更新され、 子のcleanupはstartupCompleteを既存cancel
graceより先に待つため、起動hook中の明示取消が 既存terminateへ到達しなくなる。reviewerの一時Core
probeでは取消後5250msでもtask未完了・
Worker未terminate・preparingを観測し、子probeではgrace=0でもcleanup未完了を観測した。
正常hookの待機は無期限に保ち、明示取消だけ既存grace後のterminateへ接続する局所修正を行う。
ほかのS2経路に必須findingはなかった。修正後に当該findingのみ再reviewする。

P2修正ではrootのlazy startupへ取消signalを接続し、明示取消の既存grace満了時だけWorkerを終了する。
その取消による起動失敗だけ待機状態を解除し、同Sessionの次taskで新Workerを起動する。
子のstartup待機も明示取消時の既存graceとraceし、期限到達後にterminateとcleanupの完了を待つ。
正常ready待機には期限を戻していない。 追加focused
testのroot取消結果と次task、子cleanupのcancelled/durabilityは成功し、
通常start/stop各5.15秒のtestと既存preparing-cancel回帰も成功した。

```sh
deno test --no-prompt --cached-only --no-check --unstable-worker-options --allow-read=.,/tmp --allow-write=/tmp --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME --config deno.v0.json tests/v0/increment_189_startup_cancel_test.ts
```

修正5fileの関連type check、fmt、lintとdiff checkは成功。採用P2の解消を限定再review中。

限定再reviewではterminate接続と子のcleanupを確認したが、rootの取消結果readbackは未解消だった。
起動取消後のsynthetic completionはDataにexecutionを作らず、同じexecutionIdのData/public
executionReadがexecution_not_foundになることをreviewerの実Worker probeで確認した。
この同じP2の残りを採用し、既存Data ownerで予約executionIdの取消を記録・確定する。
Dataの通常executionAdmitはAgent readyを待つため、実Worker由来の構成準備snapshotと
correlationを使える接続が必要であり、架空の構成や別storeは作らない。
既定1回の独立再review後の当該修正は、ownerがsourceとData/public readbackのfocused結果を確認する。

ownerの最終確認で同じP2の解消を確認した。lazy Hostが要求した場合に限り、Workerは
runtime_start前の実configuration/manifest/contextをstartup_preparedで通知する。 ready
barrierは維持し、明示取消時には実Workerのstart correlationとsnapshotを Dataの専用startup
admissionへ渡し、既存owner.admit→sealGenerationで取消を確定する。
通常executionAdmitのready待機は変更しない。Data RPCのcontract/client/bootstrap接続と
Worker通知・Host照合・lazy sessionの保存順序をownerが確認した。 startup-cancel focused
testは3件成功し、Task completion/Data readbackと Core public
executionReadのcancelled/complete、同Session次task、子cleanupを確認した。 既存root/child preparation
cancelと通常長時間hookの回帰確認も成功。

```sh
deno check --config deno.v0.json tests/v0/increment_189_startup_cancel_test.ts
```

11修正fileのfmt/lint/diff
checkは成功した。P2の実際のruntime_start取消経路は解消済みで、S2を完了する。
構成準備通知より前にWorkerが終了した場合は、実configurationが未観測なので元startup errorを返し、
Data execution rowを作らない。この構成未完了時のreadbackは完成したhook経路として主張しない。

S3へ進み、turn限定contextとtool引数/本文加工・semantic記録を実装・focused検証・reviewする。

### S3 turn/tool

before_turnの寄与をturn-localなinstruction componentへ合成し、当該turnのrequestと context
attributionへ渡す。次turnへ累積しない。before_toolは元assistant callを保持して
実効引数だけをdispatchへ渡し、after_toolは本文だけを加工する。terminal finalText、
callId、outcomeを保持する。元値/実効値とhook名/pathはtool_call/resultの ProviderEvidence
sidecarと通常AgentEventへ追加し、Data projectionのmapperへ接続した。 実効引数はtool
result補足としてmodelにも渡す。例外はbefore_turnのturn失敗、 before_toolの未dispatch
toolエラー、after_toolの実行済み結果保持として扱う。

新規focused testはWorkerGenerationのin-process経路で外部TSを読み、3件成功した。
turn指示の非累積、実file書込み、元assistant call維持、通常/エラー本文の加工、 terminal
finalTextとhook失敗を確認した。semantic確認はWorker portのProviderEvidence event
payloadとvalidatorまでで、WorkerCapsule実thread/Data/SQLite readbackは最終compiled
probeの残確認である。

```sh
deno test --no-prompt --allow-read=.,/tmp --allow-write=/tmp --config deno.v0.json tests/v0/increment_189_turn_tool_test.ts
deno check --config deno.v0.json v0/agent/core/hook_effect.ts v0/agent/core/events.ts v0/agent/core/loop.ts v0/agent/provider/provider_evidence.ts v0/agent/data/data_service.ts v0/agent/worker/worker_runtime.ts v0/agent/worker/worker_bootstrap.ts tests/v0/increment_189_turn_tool_test.ts
```

S1登録3件、S2実thread lifecycle1件とstartup-cancel3件の回帰確認が成功。 変更8fileのfmt/lint/diff
checkも成功した。full gate/実providerは使っていない。
S3独立reviewは差分8file、直接callerとData保存mapperを確認し、必須findingなし。
ownerも追加の採用問題なしと判断し、S3を完了する。tool hookの会話snapshotを
確定済みcanonicalとcheckpoint view、今回call情報を別payloadとする範囲を§6へ明記した。
Data/SQLiteの実readbackはS6に残し、S4へ進む。

### S4 root after_turn / checkpoint

root成功turnへData terminal由来のaccepted/adopted/durable/stateRevisionを返し、
after_turnのcheckpoint更新をsealed journal外のAgent–Data portへ接続した。 persistent/nonpersistent
rootの実WorkerCapsuleとData Workerを使うfocused確認はownerが担当する。

初回実経路確認ではhandler間にSUMMARY_Aが見える一方、Data contextReadと次turnにcheckpointが残らず、
Workerから`after_turn context save failed: history_io_failure`を観測した。 原因は専用Data
operationの先で通常writer.appendExecutionEventsを使い、SQLite appendBatchの
active/terminal-null前提に到達することだった。postterminal用semantic保存経路へ接続し直す。
また、次handlerへ渡す更新は前handlerのData保存ack後に反映するようにする。
この実観測の修正・focused検証後、S4全体を独立reviewへ渡す。

修正後の実WorkerCapsule/Data Worker focused確認は2件成功した。 persistent
rootでは5.15秒のafter_turnを待ち、SUMMARY_AのData保存ack後に 次handlerがそのcheckpointとretained
turnを受け、SUMMARY_Bを保存する。 readonly
snapshot内でcanonical/projectedのmessage参照を共有し、最終assistant結果を含む。 Data
contextRead、元履歴、after_turn例外でも元completed outcome維持、Session再開時の
checkpointとcanonical/suffix viewを確認した。persistence:none rootも
accepted=true/adopted=falseで自身のcontextと次turn projectionを更新した。

```sh
deno test --no-prompt --cached-only --unstable-worker-options --allow-read=.,/tmp --allow-write=/tmp --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME --config deno.v0.json tests/v0/increment_189_checkpoint_api_test.ts
```

17 production sourceと新規testの関連type check、fmt/lint、diff checkは成功。
修正後18fileを独立review中。S5の子/失敗/取消/auxiliary request/stop接続はまだ実装していない。

S4独立reviewは必須P2を1件返し、ownerが採用した。after_turnのoutcome.transcriptが
Worker本体arrayを直接参照し、reviewerの実Worker/Data probeでpopすると 次hookのoutcomeが2→1
messages、通常stopが0 turnsになることを確認した。
Data原履歴と確定outcomeは保持されており、snapshot境界の問題である。 ownerがfreezeしたflat array
viewを一度作り、outcomeとcanonical/projectedで
message参照を共有する局所修正を行った。本文の全量cloneは増やしていない。
当該popの拒否とstop最終会話の保持をfocused testに加え、2件とも成功。
修正2fileのcheck/fmt/lint/diffも成功し、当該P2だけを15分以内で限定再reviewする。

S4の限定再reviewは採用P2の解消を確認し、新規findingなし。ownerも追加問題なしと判断し、
S4を完了する。既存HistoryCoreのsemantic/admission/relations/text focused test 2件も成功した。
Data保存失敗/長時間保存ackの実注入は未実施であり、実施済みとして主張しない。
S5へ進み、子/失敗/取消の確定後処理とprovider fact・stop記録を接続する。

### S5 子・失敗・取消と確定後fact

rootの失敗・協調的取消、named/generic子の成功・失敗・取消へ、Dataが確定したsmall settlementを
返す。Workerはその通知でafter_turnを実行し、handlerごとの効果保存ackを待ってturn_settledを返す。
Hostはその後に次taskまたは子result公開・通常停止へ進む。既に通知済みのcommit不採用は同じ確定通知を
使い、二重のfailure_ready/ack待機を作らない。未採用draftはoutcomeへ渡し、contextは確定済み履歴を
維持する。子contextには親履歴を含めない。

runtime_stop効果と確定後の補助provider request factもAgent–Data直接channelから保存する。
requestProvider seamにphase evidenceを接続し、外部TSが任意で明示したprovider/API/model metadataと
実際のendpoint/method/HTTP/errorを記録する。credential値・Authorization・request本文は保存しない。
同じexecutionのpost-settlement recorderをafter_turn/stopで共有し、main recorderの最終request番号から
継続する。実観測では、別recorderの番号重複とpost-settlement保存APIのouter event形式違反
（history_invalid）が見つかり、局所修正した。

focused確認:

- 実ApplicationService/Data Worker/root Workerの成功履歴後の失敗・協調的取消で、完了通知前の
  after_turn実行と未採用draft/確定済みcontextの分離、Data outcome、hook例外の履歴readbackを確認。
- 実ChildRunRegistry/Data Worker/child Workerのnamed/generic成功・失敗・協調的取消で、結果公開前の
  after_turnと通常stop、子自身のcontext、親履歴・turn境界の非変更を確認。
- S4の実Worker checkpoint・再開regressionも含め4件成功。5.15秒の正常handler待機とS4で修正した
  readonly outcome snapshotも維持した。
- in-process WorkerGeneration＋実DataSessionOwner/SQLite/local HTTPの補助test1件成功。 main provider
  requestなしでafter_turn番号1→stop番号2、POST/202/provider/API/model/origin、停止効果の semantic
  readbackとcredential/本文非保存を確認した。main request後の番号継続はsource確認であり、
  このtestでは実測していない。
- 既存hook/turn-tool regression6件、関係sourceのcheck/fmt/lintとdiff check成功。

実provider・full gateは使用していない。S5の17file差分を独立reviewへ渡した。

S5初回reviewは必須P2を2件、任意findingなしで終了した。ownerは双方を採用した。

1. 補助requestの内部契約をrecorder直参照へ変更した際、既存外部web_search callerが旧execution値を
   渡し、request成功でもfactを記録しなかった。実tool＋dispatcherのprobeでrequest1件に対し
   ordinal0/observations空を観測した。callerを現契約へ追従させる。
2. 完成proposal受付直前の明示取消では、拒否ack後のafter_turnへ採用前canonicalを渡し、完成draftと
   finalTextを落とした。実Worker
   probeでDataのcancelledに対しhookのcontract_failure/draft空を観測した。 Dataのsmall terminal
   metadataを通知に足し、完成済みのローカルdraft/finalTextと組み合わせて渡す。
   元canonicalは採用しない。通常の協調取消とは別のこの実regressionをrootの実Worker testへ追加した。

reviewerは追加のlocal HTTP＋実SQLiteからpublic historyRead(detail)でafter_turn/stopのendpoint、
provider/model/API、HTTP 202と停止効果のreadback、credential/本文非保存も確認した。
修正後、両P2の解消だけを一回の限定再reviewで確認する。

P2修正後のfocused確認は、実Worker5件（proposal直前cancelの追加regressionを含む）、
web_search6件（request factとstage
callback）、補助request/SQLite1件、hook/turn-tool6件すべて成功した。
proposal直前cancelでは、公開完了とData outcomeがcancelled、hookもcancelledとなり、完成draftと
finalTextを保持し、canonicalは空・nextTurnは1のままだった。DataのterminalOutcomeは必要な
ok/outcome/stopReason/errorだけを通知し、draft errorをいったん除いて確定metadataを適用する。
関係check/fmt/lint/diff check成功。11fileの修正差分を一回の限定再reviewへ渡した。

S5の限定再reviewはP2二件の解消を確認し、新規必須/任意findingなし。ownerも解消を確認し、S5を完了する。
S6でstandalone公開API、package/installer、利用案内とcompiled実経路を確認する。

### S6 配布・公開API・利用案内

build manifestとbuild identityにsupportedHookApiContractsを追加し、実際のhook APIをbuild graphと
source digestへ含める。JSR hooks subpathと必要な公開source依存を加え、既存のcurrent manifest
fixtureも 現契約へ追従した。旧manifest変換・fallbackは追加していない。

packageへ日時hookと利用説明を同梱する。installerは初回のhook folderとhooks.jsonを配置し、
再installでは編集済みhookと既存catalogを保持する。--replace-hooksは配布fileだけを上書きし、
catalogとAgent
JSONを変更しない。READMEへdefault/明示置換/無効化、外部TS編集と新Worker反映を記載した。

authorのfocused確認は新distribution test2件、既存build provenance2件、standaloneとexternal agentの
manifest確認各1件、実Data build identity readback1件が成功した。package/installer testのbinaryは
fixtureであり、compiled binaryによるインストール・実行確認はrootの最終probeで別途行う。

S6の独立reviewは必須/任意findingなし。manifest/CLI/API codec/Data保存、build graph/source digest、
JSR source export依存、配布entry、既存編集保持と明示置換、利用案内の整合を確認した。
新hookのJSR公開済みと読める案内はownerが除去した。source exportは用意したがpublishは実施していない。

## 15 最終compiled production確認と完了判定

official build scriptをDeno 2.9.7で一回実行し、packageを作成した。

- build ID: `fa42c095cfde3dd337f308d60eefbcf3569a365e4142eff5068826b22023f568`
- binary: `/tmp/henji-increment-189-validation-AlnWL9/henji`
- package:
  `/tmp/henji-increment-189-validation-AlnWL9/packages/henji-0.8.0-x86_64-unknown-linux-gnu-5a3fdacf/`
- archive: 同名の`.tar.gz`。常用binary/configへは配置していない。

`probe_increment_189.ts`の成功した最終probeは、隔離HOME/XDG/workspaceにpackageをinstallし、
DenoをPATHへ置かず実binaryを起動した。localhost model request13件、補助request2件で以下を確認した。

- 初回hooks.json/defaultと実tools.json登録、外部TSの@henji/hooks runtime値とlocal import。
- 六hookの実行、UTC offset/timezone付き開始日時、turn寄与の非累積。
- before_toolの原案/実効引数、after_toolの本文加工とsemantic出所readback。
- 手動checkpointの次turn投影、元canonical保持、別Core/新WorkerでのSession再開。
- 起動済みWorkerのclosure維持、編集後の新Worker反映、root/named/generic識別、子自身のcontext。
- normal stop、public APIとstdinからのheadless run。
- 同じexecutionでmain→after_turn→runtime_stopのrequest番号1→2→3、HTTP 200/202/202のsemantic
  readback。 補助request本文とcredential値は履歴へ保存されていなかった。

最終probeの証拠: `/tmp/henji-increment-189-validation-AlnWL9/hooks-package-a53e1e767e2d74e3/`の
`evidence.json`、`history.ndjson`、`post-settlement-history.ndjson`、`workspace/hook-events.ndjson`。
初回probeのcredential modeと非TTYの--task指定は既存contractに合っておらず、probe側を修正した。
product source変更・再compileは必要なかった。失敗したprobeを最終成功証拠の代わりにはしていない。

最小実provider確認は、事前提示した`opencode-go-chat / openai-chat-completions /
deepseek-v4.1-flash`（既存選択のeffort
max）へtoolなし1 turnを送った。物理requestは1件だった。
隔離installの日時hookがmodelへ到達し、モデルは
`Worker started at 2026-10-04T21:48:44 UTC+09:00 (Asia/Tokyo)`をそのまま返した。
Dataのaccepted/adopted/durableがtrue、after_turn後のpublic processSettlementがcompleteとなり、
compiled history(detail)からreadbackできた。helperの最初のAPI URL prefix誤りはtask受付前に修正し、
実provider requestは発生していない。実configを変更せず、コピーしたcredentialのある一時runtimeは
確認後に削除した。記録へcredential値・Authorization・raw request/responseを残していない。

実provider証拠: `/tmp/henji-increment-189-validation-AlnWL9/live-clock/`の
`evidence.json`、`execution.json`、`clock.json`、`after-turn.json`、`history.ndjson`。

ownerは6スライスの実装・focused確認・review、採用finding修正、compiled
package/API/run/readback/reopen、
実modelへの日時到達を確認し、189のlocal実装・検証を完了と判断する。full gateは実行していない。
TUI専用の表示・操作sourceは変更していない。

実際に要約modelを呼ぶcompaction定義・閾値は対象外のままである。after_turnとcheckpoint基盤は
外部TSでその処理を実装するために利用できる。Worker喪失・強制終了時のhook実行保証は設けていない。
起動構成の通知前に失われたWorkerは実startup errorとして扱い、完成したexecutionの保存済み結果とは
扱わない。architecture/roadmap正本変更は別承認対象として具体patch案に留めた。

## 16 常用配置・commitの承認（2026-10-04）

利用者の「常用配置・commit」により、local commitと常用binary/configへの配置、配置確認と結果記録を
追加承認された。公開/release・push、architecture/roadmapの189案の適用、旧実データ削除は含まない。
反映済み186〜188が未commitだったため、確認済みの着手前snapshotから先行分を`560031e9`へ分けて
commitした。189はその後の独立commitとする。

常用配置はcommit済みsourceからofficial buildし、隔離package probeを通してから行う。
実providerの追加呼出は必要としない。既存外部TS/catalog/Agent設定を保持し、日時hookを初回登録する。
常用web_searchは前配布sourceと同一で未編集と確認したため、新しいrequest fact契約への追従sourceを
配置対象へ含める。既存Core/TUIは再起動しない。

### 配置結果

- 186〜188の先行sourceは`560031e9`、189のsourceは
  `ecb63510bbd87f6ea089d9e3ccdf2f565df5dc77`へcommitした。
- commit済みsourceからofficial buildしたcandidateはsourceDirty=false、build ID
  `4630b231aa10e7b6ecdf50df14d00d6e912d1a647b9aee5ec25691f819bc76d1`。 embedded runtime
  SHA-256は§15で実provider確認済みのruntimeと一致する
  `cdca4eee496ebcfb28ed080c5aad5362ae5b26af4887ab2543fb3c0147d62e00`。
- このcandidateをpackage化し、隔離installのcompiled production probeを再実行した。
  §15の六hook、checkpoint保存・再開、子Worker、補助requestの証跡、public APIとheadless runを
  再確認した。localhostのmodel request13件と補助request2件、実provider requestは0件。
  証拠は`.tools/increment-189/deployment/verification/hooks-package-ba6cf6182af72/`。
- package
  installerで`/home/agent/.local/bin/henji`と初回日時hookを配置し、`dist/henji`もatomic配置した。
  両binaryのversion・diagnostics・SHA-256はpackage manifestと一致した。 binary
  SHA-256は`bcc3b1062697cc5e194b399e35ac0db1ee62740ef23a0ea5818f764b270ae243`。
- `hooks.json`のdefaultへ`runtime-start-time`を登録し、配布sourceと一致する
  `hooks/runtime-start-time/index.ts`を配置した。既存外部tool、Agent、provider/model
  catalog、選択設定、
  instructionの24fileを前後比較し、変更は未編集の`tools/web_search/main.ts`だけだった。
  他の23fileはhash一致。credential値とAuthorizationはsnapshotへ含めていない。
- searchとweb_fetchの全配布fileは常用配置と一致しており、変更不要だった。searchはローカル検索、
  web_fetchは通常のfetchを使うため、web_searchのrequestProvider証跡契約変更の影響を受けない。
  常用binaryの`tool inspect`で三toolとも既存外部folderへの登録を確認した。
- 既存Core/TUIは再起動していない。現在workspaceのCore一覧は配置前後とも空だった。
  新binaryと日時hookは新しく起動するCoreから利用する。
- package、manifest、配置readback、config/Coreの前後snapshot、`deployment.json`は
  `.tools/increment-189/deployment/`へ保存した。旧binaryと旧web_search sourceも同folderへ保存した。

189の常用配置・source commitを完了した。配置記録は別のdocs commitとする。
architecture/roadmapの189案は未適用であり、公開/release・pushは行っていない。
