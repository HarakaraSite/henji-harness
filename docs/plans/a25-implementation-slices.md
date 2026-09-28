# A25 — 複数Coreの実装計画・スライス分割

2026-09-28。利用者の依頼に基づき、[複数Core案](a25-multiple-cores.md)を五つの実装sliceへ分ける。
利用者指示によりlocal実装と各sliceのreviewを採用し、2026-09-29に全五sliceを完了した。
実装・検証・review結果は各increment、最終compiled実経路受入とfull
gateは[153](../increments/increment-153.md)を参照する。
構成・操作・対象外の判断は複数Core案、実装順・各sliceの責務・受入は本計画を参照する。 Slice
1〜5は[Increment 149](../increments/increment-149.md)、[150](../increments/increment-150.md)、
[151](../increments/increment-151.md)、[152](../increments/increment-152.md)、[153](../increments/increment-153.md)へ割り当てる。

## 必要な動作と根拠

同じcanonical
workspace・同じXDGで、通常の`henji`を二つ起動し、独立したSessionの作業を並行に完了する。
各起動は新Core・新Sessionを作り、生存Coreへの再接続はIDまたはURLで明示する。
一Coreは一稼働Sessionと、その親Executionに属する子Agent・tool processを所有する。
履歴DB、保存Session、config・credential・managed resourceの既存保存先は共有する。

利用者指定（2026-09-28）: 最終的な旧DBの移行は不要。
旧DBの引継ぎや互換性維持を完了条件に含めず、migration・converter・互換read/writeを追加しない。
現計画ではschema・履歴形式の変更を必要としないが、旧DB互換のために実装を制約しない。

| product動作                                                     | 根拠                                                                                          | 完了を確認する地点 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| 二つの通常起動が別Core・別Sessionになる                         | 利用者が選んだ通常起動方針。現行launcherは同じCoreを再利用する                                | Slice 3、5         |
| 初回DB作成中でも別Coreが正常起動する                            | 初回writer競合のsource経路と、astra reviewで採用したread-only起動のP1                         | Slice 1            |
| 他Coreで作ったDB・保存履歴を読み、別Sessionの保存を並行に進める | fresh DB発見失敗は実再現。二Coreのcanonical保存・readbackは実測済み。接続の待機差はsource確認 | Slice 2、最終受入  |
| 起動時recoveryが生存Sessionを中断せず、取得lockを残さない       | 既存Session lockとrecoveryのearly returnをsource確認                                          | Slice 2            |
| 一覧から接続先・停止先を指定できる                              | 複数Coreを人間が使い分けるために複数Core案で定めた操作                                        | Slice 4、5         |
| detach・親cancel・Core stopが他Coreの親・子・toolを止めない     | 既存production Core serviceを二processで動かした実provider実測                                | Slice 3、最終受入  |

計画作成時点ではDB初期化race・待機不足・recovery lock残留はsourceに基づく調整事項だった。
実装中に初回DBのprocess間同期、短いwriter保持中の保存待機、recoveryのlock解放を確認した結果は
[149](../increments/increment-149.md)・[150](../increments/increment-150.md)を参照する。
計画前の実測はsingleton discoveryを迂回した入口であり、変更後の通常launcherやTUIの受入を代替しない。
原資料・固定した参照実装・実測結果・reviewは[複数Core案](a25-multiple-cores.md#確認済みの根拠)を参照する。

## 現行の操作から保存・参照まで

調査対象sourceは`c5ad9c72e2298f72302723cd6bda4182269536f3`。

| 経路                                                                | 現行の責務・状態所有                                                                | 本計画で変更する部分                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `henji` → `tui_cli` → `remote_tui_cli` → `prepareLocalCore`         | 引数なしと明示TUIは同じ入口。workspace単位endpointを発見・再利用する                | 毎回新Coreを準備する。指定先への接続は別の明示経路にする                 |
| detached bootstrap → `serve_cli` → `createCoreService` → HTTP ready | bootstrap tokenで結果を照合。Core serviceがepochを生成。serveも生存Coreを再利用する | 起動前にepochを採番し、spawn・service・metadata・HTTPを同じepochへ揃える |
| `core_cli` → discovery → HTTP status/shutdown                       | 一つのworkspace ownerを照会・停止。local stopはinstance lock解放まで待つ            | Core一覧・ID解決・対象ごとの状態照会と停止へ変更する                     |
| Core `ensureHistory` → read-only production store                   | 起動時にDB存在をcache。fileがあれば直ちにschemaを読む                               | schema初期化の完了と、別CoreによるDB新規作成を認識する                   |
| Worker Session factory → writable production store → SQLite         | Session writer lock、admission、semantic append、canonical commit、recoveryを所有   | 初回open同期、write待機の統一、recovery取得lock解放を整える              |
| HTTP/SSE → `remote_session` → snapshot projection → renderer        | Core・Sessionの状態はserver側。draft・viewport・terminalはclient側                  | Core選択とSession選択を分け、接続中Coreの短いIDを表示する                |
| `henji run` → `runHeadlessWorker`                                   | HTTP discoveryへ合流しない独立headless実行。storeは共通                             | HTTP Coreへ付け替えず、共有DB変更による出力regressionだけ確認する        |
| local `history`／`sessions`／diagnostics → production store         | HTTP接続なしでも同じworkspace DBを読む・利用する                                    | 共通storeの初期化変更を適用。read-only閲覧でDB・schema・Workerを作らない |

新しい永続Session stateは加えない。Core metadataのみ次の単位へ変更する。

```text
stateRoot/cores/<workspaceDigest>/<coreEpoch>/
  endpoint.json
  startup.lock
  instance.lock
  boot.json

stateRoot/<workspaceDigest>/history-v7.sqlite3
stateRoot/<workspaceDigest>/locks-v7/
```

epochはprocess lifetimeのidentity、bootstrap tokenは起動結果の相関、Session
IDは保存作業のidentityである。 workspace共通のschema初期化同期は短いopen処理、Session
lockは稼働writerを所有する期間に属する。 両者を同じlockへまとめず、DB初期化の待ち合わせ中にSession
recoveryやtask実行を抱え込まない。

## スライスの順序と到達点

DBの初期化と継続利用を先に成立させ、次にprocess起動単位を切り替える。
既存のbootstrap、serve、通常TUIを同じsliceで切り替えるため、workspace
singletonとの暫定dual-readは設けない。 Slice 3の時点で通常起動は新Coreになる。ID操作はSlice
4・5で加え、途中の明示接続・停止には既存URL操作を使う。

| slice | 利用できる到達点                                                          | 前提 | 主な変更責務                                     |
| ----- | ------------------------------------------------------------------------- | ---- | ------------------------------------------------ |
| 1     | 初回DB作成中のwriter／read-only Coreが、schema commit後に利用を開始できる | なし | store初期化とschema readiness                    |
| 2     | 生存Coreを維持したまま別Sessionの保存を進め、他Coreの新規DB・履歴を読める | 1    | DB発見、write接続、recovery取得lock              |
| 3     | 同じworkspaceで新Coreを毎回起動し、URLで接続・停止できる                  | 1、2 | epoch別discovery、bootstrap、serve、通常launcher |
| 4     | 一覧からCoreを識別し、IDで状態確認・個別停止できる                        | 3    | 列挙、ID解決、管理CLI                            |
| 5     | 通常TUIでCoreを識別し、IDで再接続・Session操作して並行作業を完了できる    | 4    | TUI接続、表示、help・通常利用文書、最終受入      |

実装はこの順に進める。同じDB・launcher・TUI fileを複数sliceが変更するため、並行実装を前提にしない。
各sliceでproduct動作を確認し、結果と残る未確認事項を対応incrementへ記録してから次へ進む。
常用binaryへの配置は五slice完了後の別操作とし、途中sliceを常用配置する計画にはしない。

<a id="slice-1"></a>

### Slice 1 — 初回DB作成とread-only起動の同期

利用動作: 新しいworkspaceで二processが初めて履歴を利用するときも、
schema作成中のDBを別Coreが未対応schemaとして拒否せず、commit後に正常利用を開始する。

実装すること:

- writable production storeのDB file作成前からschema commitまで、workspace
  DB単位で初期化を同期する。 Core historyとlocal history CLIのread-only初期化も同じ完了境界を通す。
- writer transaction取得後にschema versionを再読取し、その時点で必要な初期schemaだけ作る。
  同期範囲をschema準備までに限定し、recoveryやSession lifetimeへ持ち越さない。
- Core起動時と、起動後にDBを初めて開く`ensureHistory`の両方で、fileの存在とschema準備完了を区別する。
  DBがまだなければCoreの履歴queryは空の結果を返せる。read-only storeはDB・schemaを新規作成しない。
- 同期方式の第一候補は既存と同系統のOS advisory file lockとする。
  既存`acquireLock`の`tryLock`による即時`session_busy`とは分け、初期化完了を待つ。
  lockの配置とopen方法はread-onlyのDB非作成を保つ形で実装時に確定する。
  新しい同期metadataが必要でもschema準備の責務だけを持たせ、ready markerや常駐ownerを重ねない。
- 同じproduction storeを使うheadless run、Session CLI等もこの初期化を通す。 現計画ではschema
  version・履歴形式の変更を想定していない。 旧DB変換・互換読み取りや全operation retryは追加しない。

主な対象: [production store](../../v0/agent/history/sqlite_history_v7_production_store.ts)、
[SQLite core](../../v0/agent/history/sqlite_history_v7_prototype.ts)、
[Core service](../../v0/agent/host/core_service.ts)。必要ならhistory配下に小さい初期化同期helperを置く。
同期constructorを無理にasync化せず、production storeのasync `initialize`でprocess間同期を所有する。
SQLite内部のversion再判定はconstructorのtransaction内で行う。

受入・対応するfocused確認:

- 同じ未作成DBを二つの実processからwriter openし、両方で新規Sessionを作成・readbackできる。
- AがDB fileを作りschema transactionをcommitする前にB Coreを起動する。
  Bが初期化完了を待ち、Aのcommit後に起動・履歴query・新規Session利用を完了する。
  process間の進行はfixture側のbarrierで制御し、固定sleepだけでrace成立を判定しない。
- 既存schemaのDBを通常起動とlocal read-only historyから開ける。
  DB未作成workspaceの履歴閲覧で、DB・schema・Workerが作られないことも確認する。

このsliceはprovider callを必要としない。二writerとwriter／readerの確認は別processで行い、
同一process内のPromise並行だけでprocess間同期の成立を結論にしない。

<a id="slice-2"></a>

### Slice 2 — 共有DBの発見・write待機・recovery

利用動作: DB未作成時に起動したCoreでも、別Coreが後から作った保存Sessionを一覧・履歴で読める。
別Sessionの保存を並行に進め、Core起動が生存Sessionの実行を中断しない。

実装すること:

- `ensureHistory`で未作成の判定を固定せず、履歴を使うqueryでDBの現在の存在を確認する。
  一度開いたread-only storeは利用し続け、既存DBの置換・削除へのfallbackを仕様として加えない。
- helperの短寿命write接続とsemantic append用長寿命接続へ同じbusy待機設定を適用する。
  5秒を初期候補として、実際の短いwriter transactionで評価する。operation全体のretryは加えない。
- recoveryが取得したSession／Execution lockを、そのrecovery処理の終了時に解放する。
  元Executionが一覧取得後にsettledとなった場合のearly returnも同じ解放経路に含める。
- 生存ownerが保持するSession lockは引き続き尊重する。
  同じSessionの二重writerを許さず、別Sessionのwriterまでworkspace単位で拘束しない。

主な対象: [Core service](../../v0/agent/host/core_service.ts)、
[production store](../../v0/agent/history/sqlite_history_v7_production_store.ts)、
[SQLite core](../../v0/agent/history/sqlite_history_v7_prototype.ts)。

受入・対応するfocused確認:

- B CoreをDB未作成のまま起動し、別process AでSessionを保存する。 B自身でwriterを開かずに、BのHTTP
  Session一覧と履歴queryからAの保存結果が読める。
- 別Sessionの二processでadmission・semantic append・commitを重ね、両方のcanonical履歴が保存される。
  実DBの短いwriter保持中に他方が待って完了することを確認し、設定値を読むだけのtestにしない。
- Aの親・子Executionがactiveでlockを所有する間にBを初期化し、Aがinterruptedへ変わらない。
- recovery対象の一覧取得後に元ownerがsettledした経路で、取得lockが解放され、次のresumeが利用できる。
  通常の未settled ownerのrecoveryも、取得lockを保持し続けない。

既存のhistory保存・list・startup recovery確認を必要な箇所へ対応させる。
待機5秒の負荷上の妥当性は、この確認前に実測済みとは記録しない。

<a id="slice-3"></a>

### Slice 3 — Core別discoveryと新規起動

利用動作: 同じworkspaceで`henji`または`henji serve`を二つ起動すると、別PID・別epoch・別URLになる。
通常TUIはそれぞれ新規Sessionを開き、URL指定で同じCoreへ再接続・個別停止できる。

実装すること:

- workspaceのCore集合と、epochを含む個別Core locationを分ける。 endpoint・startup lock・instance
  lock・boot結果のすべてをepoch directoryへ置く。
- launcherでepochをspawn前に採番し、内部bootstrap引数、serve options、Core service optionsへ渡す。
  直接serveも起動前に採番する。HTTP/SSE cursor、ready record、metadata、終了処理が同じepochを使う。
  内部bootstrap tokenは別に保持し、ready照合ではtokenとepochの双方を対象起動へ対応させる。
- `prepareLocalCore`の「発見して再利用」を新規起動責務へ置き換え、serveの既存Core再利用も同時に外す。
  compiledは同じexecutable、sourceは既存Deno entry、stdio分離・detach・unrefは既存経路を使う。
- 引数なしTUIが必ず新Coreへ接続するよう、共通launcherの呼出しを同じ変更で切り替える。
  Session指定がなければ既存`implicit`→空slotに`new`というHTTP操作で新Sessionを開く。
- `--connect URL`の明示接続・停止を維持し、local stopのmetadata／instance
  lock待機を対象epochへ限定する。
  ID管理前のこの段階では、対象省略のstatus／stopは複数Coreから一つを選ばず、URL指定方法を示す。
  一つのCoreだけがある場合も、通常起動の再利用や対象省略stopを残さない。
- workspace singleton探索の関数・呼出し・注釈・旧前提のtestを同じ変更で置き換える。
  help・操作文書の起動とURL停止の説明もこのsliceで実際の動作へ合わせる。

主な対象: [discovery](../../v0/agent/runtime/core_discovery.ts)、
[serve CLI](../../v0/agent/cli/serve_cli.ts)、 [henji入口](../../v0/agent/cli/henji_cli.ts)、
[remote TUI CLI](../../v0/agent/cli/remote_tui_cli.ts)、
[Core service](../../v0/agent/host/core_service.ts)、
[Core CLI](../../v0/agent/cli/core_cli.ts)、CLI help・HTTP操作文書。

受入・対応するfocused確認:

- 同じworkspace・XDGでlauncherを同時起動し、別PID・epoch・URLと、それぞれに対応するreadyを確認する。
  `serve --json`の二回起動でも新Coreとなり、出力後もforeground Coreが稼働する。
- 二つの通常TUIが別Sessionを開き、片方のdetach後も両Coreが残る。
  `--connect`で指定したCore／Sessionへ戻り、URL指定stop後ももう片方のCoreが応答する。
- 個別stopが対象epochのendpoint・lockを清算し、他epochのmetadata・lockを保持する。
  次の通常起動は新epochとなり、保存Sessionは明示resumeできる。
- 新たに作ったcompiled
  binaryをrepository外のworkspaceから使い、source版と同じ二Core起動・停止を確認する。
  build／includeの変更は実際に必要な場合だけ行い、PATH上のDenoやcheckoutを配布時に要求しない。

[既存launcher test](../../tests/v0/increment_145_launcher_test.ts)の「二起動が同epoch」「serveがreused」
「対象省略stopで一つを停止」は新要件へ書き換える。
test用cleanupも作成した各URL／epochを明示する。全Coreを止める新しいproduct APIは作らない。

<a id="slice-4"></a>

### Slice 4 — Core一覧・ID解決・個別管理

利用動作: `henji core list`で同じworkspaceのCoreを見分け、
`core status --core <id>`と`core stop --core <id>`で一つだけ操作できる。

実装すること:

- workspace directoryを列挙し、個別locationのendpoint・instance ownershipとHTTP
  `core.read`を対応させる。
  終了済みdirectoryを稼働Coreとして数えず、一覧queryからCore起動・Session切替・metadata削除を行わない。
- 一覧にCore ID、PID、workspace、稼働Session ID/titleまたは未open、phase、URLを表示する。
  titleは稼働Sessionの既存read APIから読み、一覧表示のために新しいdurable stateやHTTP
  APIを増やさない。 ownerがいるがHTTP応答を確認できないCoreは、既存のunreachableとして区別する。
- full epochと、一覧の候補へ一意に一致するprefixの解決を共通化する。
  複数一致なら候補と指定方法を返す。停止済み・未発見の指定は状態を伝え、代替Coreを起動しない。
- `core list [--json]`、対象省略`core status`の一覧、ID指定status／stopを接続する。
  対象省略stopは一覧と指定方法だけを表示し、停止しない。
  `--core`と`--connect`は一つの接続先を表すため、同時指定を受け付けない。
- JSON一覧はworkspaceとCore行の集合を返し、各行にfull `coreEpoch`を持たせる。
  人間向け短縮IDと機械向けidentityを混同しない。help・操作文書を同じsliceで更新する。

主な対象: [discovery](../../v0/agent/runtime/core_discovery.ts)、
[Core CLI](../../v0/agent/cli/core_cli.ts)、CLI help・HTTP操作文書。 ID解決helperはSlice
5のTUI入口からも利用する。

受入・対応するfocused確認:

- 同じworkspaceの二Coreが別行で表示され、別workspaceのCoreが混ざらない。
  Session未openのserveと、Sessionを開いたCoreを人間・JSONの両方で区別できる。
- 一意なprefixで対象status／stopを実行し、対象外Coreが稼働し続ける。
  省略stopでは二Coreがともに稼働し、queryだけのworkspaceでCoreが新規起動されない。
- ambiguityの確認はID解決helperで候補を制御して行い、production ID生成をtest都合で変えない。
  停止済み指定と既存unreachableの確認を管理対象の解決へ対応させ、追加のpermission matrixは作らない。

<a id="slice-5"></a>

### Slice 5 — TUIでのCore指定・識別と通常利用の完成

利用動作: `henji --core <id>`で選んだ生存Coreへ戻り、画面上でCoreとSessionを識別する。
通常の二terminalで独立作業を完了し、選んだCoreだけでSessionを切り替え・停止できる。

実装すること:

- TUI invocationへ`--core`を加え、Slice 4の解決結果のURLで既存HTTP TUIを開く。
  Coreを選んだ後にSession targetを適用し、TUI内へ新しいlauncher／DBアクセスを作らない。
- Core指定なしは新Core、指定ありはattachを基本とする。
  `--new`／`--continue`／`--session`／`--no-session`は既存Session操作としてselected Coreへ渡す。
  保存Sessionの新Core resumeと生存Core attachを区別し、同一Session writer lockは引き続き尊重する。
- HTTP core／snapshotの既存epochをpresentationへ渡し、起動表示に短いCore IDをSession表示と並べる。
  Sessionを切り替えても接続Coreの表示を保持し、URL明示接続でもserverのworkspace・epochを使う。 Core
  IDをSession durable stateや会話履歴へ埋め込まない。
- 実装済みの起動・一覧・再接続・停止例をhelp、README、HTTP操作文書へ揃える。 live
  Coreへの再接続と保存Session再開、TUI detachとCore stopを説明する。
- singletonの残存参照・表示・cleanupを確認し、使われなくなった処理を削除する。 `henji run`、local
  history／sessions等の既存経路までHTTP discoveryへ付け替えない。

主な対象: [remote TUI CLI](../../v0/agent/cli/remote_tui_cli.ts)、
[remote Session](../../v0/tui/remote_session.ts)、
[snapshot presentation](../../v0/tui/snapshot_presentation.ts)、
[presentation型](../../v0/presentation/contract_types.ts)、
[startup表示](../../v0/tui/startup_render.ts)、必要なrenderer、CLI help・README・HTTP操作文書。

受入・対応するfocused確認:

- 隔離XDGのtmuxで引数なし`henji`を二つ起動し、別Core ID・Session IDを画面と一覧から照合する。
- AのTUIをdetachし、`--core <A-id>`で同じCore・Sessionへ戻る。Bのdraftと実行は継続する。
  同じCoreへ二TUIを明示接続した場合も、各clientのdraft・viewportを独立して利用できる。
- `--core <A-id> --new`でidle Aだけを切り替える。
  Core指定なし`--session <saved-id>`は新Coreで再開し、生存Coreへのattachとは別操作になる。
  選択中SessionのmodelはSession state、新Sessionの既定は共有configという既存scopeを確認する。
- 起動表示・再接続・Session切替後も接続先IDを読める。
  通常の端末と既存のcompact表示でtmux確認し、working／elapsedと入力操作の既存regressionをfocusedで確認する。
- sourceの操作確認後、最終compiled binaryの通常起動から下記の統合受入を完了する。

## 最終受入と検証の進め方

各sliceで変更箇所のfocused test、必要なtype check・format・lint、`git diff --check`を行う。
既存testがsingleton再利用を前提にしている場合はproduct要件に合わせて修正し、旧動作を保つ分岐を足さない。
TUI経路を変更するSlice 3・5は、隔離XDGのtmuxでproduction TUIを操作して結果を記録する。
reviewは変更されたproduct動作・明示要件・regressionと、対応する具体的な確認を対象にする。

最後に同じworkspace・XDGの通常launcherで次を確認する。

| 操作                                    | 成立すべき結果                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| 二terminalから新規起動・並行依頼        | 別PID・epoch・Session。両taskが完了し、共有DBからcanonical履歴をreadbackできる   |
| 実行中のA TUI detach→IDで再接続         | A Coreと受付済みtaskが継続。Bの作業も継続する                                    |
| 両Coreの親・子がtool実行中にA親をcancel | A親・子・対応toolが停止。Bの同じprocessが継続し、子のcollectと親の保存が完了する |
| 同様の並行実行中にAをIDでCore stop      | AのWorker・子・tool・listener・ownershipが清算。Bは継続して完了・保存する        |
| Core一覧・履歴参照・保存Session再開     | 人間が選んだ接続先・停止先を識別し、保存Sessionを明示的に新Coreで再開できる      |

実providerの再確認は変更後の通常launcherとcompiled binaryの成立に必要な範囲へ絞る。
先の実測scriptは比較材料として再利用し、調査用の直接Core生成を最終受入入口にしない。
二Coreの通常task確認は一turnずつ、親子tool確認は既存のcancel・shutdown二caseを基本とする。
先の親子確認では二caseで18物理requestだったが、今回の見込みと実績は実行時に分けて記録する。
既に許可された実provider実測の範囲で、対象、provider/model、見込みrequest、保存先を実行前に提示する。
計画作成中にはprovider callを行わない。

保存先は各sliceのincrement文書と、隔離probe directoryとする。 PID・epoch・Session／Execution
ID、通常の短いrequest fact、semantic履歴、HTTP readback、tmux操作結果を残す。
credential値とAuthorizationは記録せず、raw provider payloadやSSE断片の常設収集を増やさない。
確認用Coreの停止は作成した個別ID／URLで行い、他の常用Coreを対象にしない。

共有storeやlauncher変更による既存regressionは、local read-only history、Session resume、 headless
`run`のfinal／JSON／stream出力のfocused確認で扱う。
shutdown時の既存`failed/contract_failure`分類は複数Core固有の問題と確認していないため、
本計画で成功分類を新たに要求したり、分類変更を必須実装へ加えたりしない。

slice途中とreview前にfull gateは要求しない。 五sliceの安定候補に対し、ownerがauthoritative
`v0:gate`を一回実行する計画とする。
失敗はfocused確認で原因を特定し、修正による再実行が必要な場合だけ理由を記録する。
gate成功とは別に、通常TUIから上記操作を完了できたことを受入とする。

## 未確認事項と承認境界

初期化同期のlock配置・read-only接続のopen方法、busy待機5秒の実経路での動作は
[149](../increments/increment-149.md)・[150](../increments/increment-150.md)で確認した。
通常起動のcompiled TUIとcompiled CLIによる親子toolの独立性は
[153](../increments/increment-153.md)の実provider受入で確認した。 未確認のprovider
variant、filesystem／permission matrix、一般的hardeningは追加しない。
Core間mailbox、swarm、同じworkspace fileの編集調停、共通gateway、DB分割も範囲外である。

実装計画の作成と五sliceのlocal実装・各slice後のreviewerによるコード/テストreviewは利用者指示済み。
実装指示時点ではlocal変更が範囲だった。2026-09-29に利用者が対応を完了承認し、関連文書更新・commit/push・常用配置を追加指示した。
その結果は[合同配置記録](../increments/a25-deployment-2026-09-29.md)を参照する。JSR公開は含めない。
architecture・roadmapの意味変更案は[複数Core案](a25-multiple-cores.md#正本への反映案と承認境界)に保持し、
本計画への包括承認から正本変更の承認を推定しない。 既存DBや旧Core
metadataの削除、旧形式migration・dual-readは計画しない。 配置前に `/home/agent`
の旧Coreがidleで稼働していることを確認し、停止せず保持する。
旧discoveryのdual-readは追加せず、生存旧Coreへの接続には記録したURLを使う。
