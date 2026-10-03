# Increment 180 Coreの実行状態全件転記とtask受付後の重複再投影を削除

更新日: 2026-10-03

ステータス:
**スライスA・B・Cの実装・test・独立review、最終gate一回、実provider4実行と保存readback、最終限定reviewが完了。local受入・commit/push・常用配置と配置先確認が完了。**

利用者の「次はA28をやろうと思う」「では計画を作って」により、
[Coreの冗長な処理削除案](../research/core-redundant-processing-removal.md)の案1・2を180へ採用する。
本書を要件・対象範囲・計画・結果の正本とする。利用者の「では計画をスライスに分け
スライスごとに実装テストレビューを行ってください
最後に実プロバイダによる確認を行ってください」により、
local実装・非破壊的検証・スライスごとの独立review・最後の実provider確認を承認された。
常用配置、commit/push、実利用dataの削除は含まない。

## 目的と成功条件

人間が同じSessionでtaskを繰り返すとき、状態更新のたびに過去の実行状態を全件転記する処理と、
task受付成功後の重複再投影を除く。受付結果、実行状態の表示・照会、cancel、steering、follow-up、
保存履歴とSession切替後の参照を維持する。

成功条件は、全件転記と対象の重複呼出しが実経路から消え、正式API Workerとcompiled TUIを通じて
現在の操作を完了でき、保存結果を読み戻せることである。処理件数の削減だけで完了とはしない。
CPU時間・入力遅延の改善は現在の証拠から保証できず、本計画の達成条件に数値目標を置かない。

根拠は利用者の指示、削除案のsource調査とprovider-free測定、179の受入結果、現行sourceである。
従来の測定は1 Core・1 Session、toolなし正常完了100 turnで、refresh 1,900回、Map走査95,950件、
admit成功後の明示refresh 100回すべて変更なしだった。HTTP/TUIと実providerは測定していない。
詳細な条件・元証拠は削除案と`.tools/redundancy-probe/`を参照する。

179の受入・baseline比較は完了しているため、順序の前提は満たした。 本計画のsource基準はcommit
`0dba4dc291a433592084dd7bf1840f8f3ece86b1`。
179以前の測定値をこのsourceのbaselineとみなさず、実装前に測り直す。

## 現行の操作経路と状態所有

TUIまたはHTTP clientのtask送信は、API Workerのoperation RPCからCoreの`taskSubmit()`へ届く。
Coreはcommandを登録し、`ApplicationTaskService.admit()`がexecution
identityと準備中のlaneを予約して、 共通Worker Sessionの`host.admit()`へ渡す。Agent
Workerが実行し、Data Workerがsemantic履歴・
canonical会話・実行記録を保存する。CoreはTaskService/runtime通知とData更新を合成し、
公開revisionを採番してAPI Worker経由のsnapshot/updateをTUIへ送る。

| 状態                                                       | 現在のownerと参照先                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| taskの予約、preparing、steering、follow-upと実行終了の制御 | `ApplicationTaskService`。`active`等のlaneとfollow-up recordを保持              |
| command相関と後処理状態                                    | TaskServiceの`executions` Mapで生成・変更し、Coreの同名Mapへ毎refreshで全件転記 |
| 複数Sessionにまたがる実行追跡と公開状態                    | CoreのMap、`sessionSnapshots`、`publishSnapshot()`、`executionRead()`           |
| canonical会話、semantic履歴、durable実行記録               | Data Workerと共有history DB。CoreはDataの記録へ追跡情報を合成                   |
| HTTP/SSE配送と画面表示                                     | API Workerが配送し、TUIが表示・入力を所有                                       |

Coreの`refreshSlotSnapshot()`は、TaskServiceのMapを全件転記してからcontrol stateを再投影する。
`makeSlot()`のapplication購読は通知の種類を問わずこのrefreshを呼び、`taskSubmit()`も
admit成功後に明示refreshする。`publishSnapshot()`が変更なし配信を抑えても、転記・再投影・比較は済んでいる。

sourceで確認した影響経路は次のとおり。

- TaskServiceの`begin()`が予約を追加し、受付失敗で取り消す。`settle()`が後処理完了を記録する。
- 両Mapは現行では同じ状態objectを参照する。親が完了してfollow-upを開始する経路は、
  親の`processSettlement`を変更した後、次の実行の`begin()`が通知する。
  親完了だけの通知を待つ設計では、この変更を落とす。
- `executionStates()`は全件転記以外に、Coreの`steeringSubmit()`と`followUpQueue()`の
  execution所属照会、および170のtask予約testから参照されている。
- `executionRead()`と公開snapshotは`submittedByCommandId`と`processSettlement`を合成する。
  Dataの終了確定とCoreの後処理完了を同一視できない。

根拠sourceは`v0/agent/host/{task_service,application_service,application_port,core_service}.ts`。
API Workerからの操作は`v0/agent/http/`、Data更新はCoreの`ensureWatch()`とData client、
画面確認は既存TUI/launcher経路を使う。

## 差分反映の設計

### 既存task通知に変更した実行を載せる

`task_state`に内部用のexecution差分を載せ、application購読がCoreのMapへ差分を反映してから
既存のsnapshot refreshを行う。公開HTTP schema、Data通信contract、runtime通知は変更しない。

差分はexecution ID、Session ID、command ID、後処理状態を含む追加・更新と、
受付失敗で未成立となった予約の取消を表す。変更のないtask通知は空の差分とする。
過去実行全件の配列、別のpolling、同期用Map、永続queueは作らない。

| 状態変更                           | 既存通知に渡す差分と反映順                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 新taskの準備開始                   | 予約の追加を、最初のtask通知と同時に反映。最初のadmission awaitより前にCoreが追跡できる               |
| admission成功                      | preparing解除等は既存task通知で反映。追跡fieldが変わらなければexecution差分は空                       |
| admission失敗                      | 当該の未成立予約の取消を、既存の失敗通知へ載せる。保存済みexecutionや履歴を消す処理には使わない       |
| 正常終了、cancel、失敗後の清算完了 | `processSettlement: complete`を、既存の終了通知へ載せる                                               |
| 親完了からfollow-up開始            | 親の完了と次executionの予約追加を、次の準備開始を知らせる既存通知へまとめて載せる。親の更新を先に適用 |
| follow-up開始失敗、予約破棄        | 親完了を既に反映したうえで、次の未成立予約の取消または既存recordの状態を通知                          |

一つの通知で複数executionが変わる親・follow-upの経路を扱うため、差分は配列で渡す。
共有objectの事後変更をCoreが偶然参照する方式をやめ、通知時点のfield値を反映する。
追加の親完了通知によって一時的なidle表示や公開revisionを作る方式は採らない。

### 不要になる全件保持とAPIを撤去する

Coreの追跡Mapは、実行照会とSessionをまたぐ参照に必要なので保持する。
TaskServiceは現在の実行と完了待ちに必要な値だけを持ち、履歴全件の`executions` Mapと
`executionStates()`を撤去する。終了待ちの関数内で必要な値は保持できるが、別の全件Mapへ移さない。

Coreの追跡Mapのentryには、Session
IDに加えて、executionを生成したApplicationServiceとの相関を保持する。
新規予約の差分を受ける購読callbackで生成元serviceを付加し、その後の状態更新でも同じ相関を維持する。
この相関はCore内の既存service
object参照で表し、内部通知のpayload、公開schema、Dataの保存項目へ追加しない。
Sessionを再openして新しいserviceを作っても、過去entryの生成元を新ownerへ付け替えない。

Coreのsteering/follow-upでData照会を省略できるのは、追跡entryのSession IDが対象と一致し、
生成元serviceが`knownServices.get(sessionId)`の現在ownerと同一である場合だけとする。
entryがない、現在ownerがない、または旧service由来である場合は、既存のData実行照会へ進む。
その後のowner有無の判断と、Dataの404に対する`notFound`、既存executionの非active状態に対する
`idle`の意味を維持する。所属用の別MapやTaskServiceの全件Mapは追加しない。
170のtestにあるMap直接参照は、通知された予約・取消・完了と公開照会の確認へ置き換える。
productionへtest専用の全件読取APIを残さない。

現行Coreは受付失敗時にTaskServiceから消えた予約を全件転記で消せない。
取消差分はこの未成立予約の内部追跡に限り、公開された失敗結果・Dataの記録・既存保存dataを変更しない。
公開挙動の変更が必要と分かった場合は、原因と影響を報告して利用者へ判断を戻す。

### task受付成功後の重複再投影を削除する

差分反映が成立してから、`taskSubmit()`のadmit成功後だけの明示refreshを削除する。
成功通知が同期購読を通じてsnapshotを更新した後にadmitが戻り、返すcursorが必要な予約・状態を
参照することを確認する。await中に進んだ状態を過去へ戻してはならない。

admission失敗時のcatch、cancel/steering/follow-up等の別operationの明示refreshは今回削除しない。
runtime通知のno-op、JSON比較、Dataのprojection、TUIのrendererも対象外とする。

## 実装と確認の工程

### 工程1 変更前のbaselineを保存

実装前sourceを固定し、元probeのcounter付きCore複製を179後のsourceから作り直す。
importの置換とcounter追加だけの差分、source hash、Deno version、実行条件を保存する。 1 Core・1
Session・100 turn・toolなし正常完了・byte購読1本という元のprovider-free条件で測定する。
refreshの呼出し元、全件走査件数、差分反映件数、公開update/revision、終了結果を記録する。

正式API Workerを通すcompiled確認は、179で使ったlocalhostの制御可能な応答serverと隔離configを
再利用する。変更前版でも後述の操作とreadbackを確認し、source直結の件数測定と区別して保存する。
localhost応答は実providerの応答や性能の証拠として扱わない。

### 工程2 差分反映と全件転記の撤去

内部差分型、TaskServiceの状態変更通知、ApplicationServiceからCoreへの配送を実装する。
Coreで生成元serviceとの相関を付加して差分適用をsnapshot投影より先に行い、全件転記、
TaskServiceの履歴全件Map、不要APIと所属照会の旧参照を同じ工程で撤去する。
所属照会の置換では現在ownerとの同一性を確認し、旧service由来のexecutionには既存Data照会を使う。
受付成功後の明示refreshはこの工程では残す。

予約から終了・follow-upへの変更と、Session切替後の照会をfocused確認する。
差分通知だけでCoreの追跡情報が成立したことを確認してから次へ進む。

### 工程3 受付成功後の重複再投影を撤去

対象の明示refreshを削除し、正式API Worker経由の受付cursorと準備中cancelを確認する。
既存の購読順・公開revisionの意味と実行照会が保たれることを確認する。

### 工程4 同条件測定と人間の操作確認

候補版のsourceからcounter付き複製を再生成し、工程1と同条件で100 turnを測定する。 過去のsettled
executionの全件転記とadmit成功後の対象呼出しが消えたことを確認し、
差分件数・refresh・配信件数は実測値で報告する。両削除の効果を二重計上しない。 100
executionの正常完了・canonical採用、最後の`committedTurn=100`とidle復帰も照合する。

候補の公式compiled executableを隔離HOME/XDG/workspace/stateで起動し、 正式API
Worker経由のHTTP/SSEとtmux TUIで下表の変更された動作を確認する。
Core停止後に同じ隔離DBをhistory読取経路で読み戻す。常用Core・実config・既存dataは使わない。
処理件数のprobeは恒久的なruntime診断やraw収集機構にしない。

## スライスごとの実装とreview

工程1のsource固定、100 turn測定、compiled baseline確認を実装前に完了する。
以降は次の順で進め、各スライスの実装・focused確認・独立reviewの結果を本書へ記録する。

| スライス | 範囲と確認                                                                                                                                                                         | reviewの境界                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A        | 工程2。内部差分通知、Core適用・生成元service相関、全件Map/API撤去、170 testの旧参照更新。予約・取消・清算完了・親からfollow-upの状態反映と所属照会をfocused確認                    | Host四sourceと該当test。通知からCore照会・公開状態までを確認し、受付成功後refreshは残す |
| B        | 工程3。taskSubmit成功後のrefreshのみ撤去。正式API Worker経由の受付cursor・準備中cancelと実行照会をfocused確認                                                                      | 対象呼出しと同期通知・購読の順序。スライスAの未変更箇所を再走査しない                   |
| C        | 工程4。同条件100 turn測定、正式compiled API・tmux TUIのsteering/follow-up・cancel・再接続・Session参照、停止後readback。安定候補のgateを一回実行後、最後の実provider確認とreadback | sourceの最終差分と測定・人間の操作・保存証拠を確認。reviewerはfull gateを実行しない     |

通常reviewは初回30分以内、新証拠・中間結論が10分ない場合は中断する。
修正後の再reviewは変更箇所と既存finding解消だけを15分以内で確認する。
Findingの採否、計画外の判断、最終受入はcoordinating ownerが担う。

### 最後の実provider確認

利用者の実provider確認の明示指示に従い、179と同じ登録accountの
`openai-chatgpt / gpt-6.1-sol / medium`を公式compiled候補で使う。
隔離HOME/XDG/workspace/stateへ必要な登録を非公開で複製し、元の実config・DB・常用Coreは変更しない。
対象・回数・保存先は推論開始前に利用者へ提示する。

TUIの通常完了1実行、親taskとF2予約follow-upの自然完了2実行、本文が出始めた後のcancel1実行の計4実行を行う。
各実行はtoolなし・maxSteps 1で1推論requestを想定し、providerが実際に返した短いrequest
factから物理request数を報告する。
steeringの反映はスライスCのlocalhost実経路で確認する。今回のlive確認へrun
CLIや追加モデルは含めない。
保存先は`.tools/increment-180/live/`で、公開snapshot、画面、終了結果、Core停止後のsemantic/history
readbackを保持する。 credential値・Authorization・raw
responseを結果へ記録しない。予定外の追加確認が必要なら対象と理由を報告する。

## 動作と確認方法の対応

| 必要な動作と根拠                                                        | 確認方法                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 予約と受付cursor。差分適用と明示refresh削除が直接変える                 | 170のtask予約・preparing cancel確認を差分通知へ対応させ、HTTP/SSEで受付cursor以降のsnapshotに同じexecution/command相関があることを確認                                        |
| Data終了とCore清算完了の区別。`executionRead()`の合成が依存する         | 既存の終了待ちを制御できる実経路で、清算中の照会と公開状態、完了後の`processSettlement`を確認。通知unit確認だけで代用しない                                                   |
| 親からfollow-upへの継続。共有objectをやめる変更が直接変える             | 制御可能な応答でsteering適用と予約follow-upを実行し、親のcomplete、次executionの予約/command相関、最後のidleと保存を確認                                                      |
| cancel・失敗・受付失敗。追跡状態の変更箇所を置き換える                  | 既存の170予約test、175 HTTP steering、176 failure確認から該当経路を選ぶ。準備中cancel、実行中cancel、観測済みfailure形式、admission失敗の予約解除を確認                       |
| Session切替後の既存execution照会。TaskService Map撤去が所属照会を変える | 完了後に別Sessionを開き、前Sessionの実行照会・command相関とsteering/follow-upの既存結果を確認。別Sessionのexecutionを所属と誤認しない                                         |
| snapshot/update順と再接続、画面のworking/idle                           | tmuxのproduction TUIで送信、完了、F3 steering、F2 follow-up、cancelとdetach/reconnectを確認。公開revisionと表示・入力受付が一致することを記録                                 |
| semantic履歴とcanonical採用の維持                                       | Core停止後のhistory readbackで本文、execution outcome、canonical/non-canonicalを照合。command相関・後処理情報は稼働Coreの照会で確認し、同じexecution IDで保存結果と対応づける |

既存testは変更経路に関係するassertionを維持し、撤去する内部Mapへの依存だけを置き換える。
所属照会はSession切替だけでなく再openによるowner交代を確認する。
reviewで確認した具体的regression経路として、隔離環境で作成したSession Aの実行完了、Bへの切替、
Aの再open、Bへの切替、Aの削除後に、旧A実行へのsteering/follow-upが変更前と同じ`notFound`となることを
確認する。これは既存operationによる所属照会の確認であり、Session削除の実装修正や実利用dataの削除は含まない。
新しいtestは上表の具体的動作に不足がある場合だけ追加する。未観測のprovider variant、
permission/状態matrix、test件数目標は設けない。表中のfailureは既存確認済み形式を使う。

実装中はfocused test、必要な型確認、format/lint、`git diff --check`を使う。
安定候補で実経路の受入を終えた後、coordinating ownerがauthoritative `v0:gate`を一回実行する。
途中確認やreviewのためのfull gateは行わず、再実行には変更・失敗等の具体的理由を必要とする。
最終確認では通知からCore照会・公開状態・保存までを本書の動作と照合する。

## 対象ファイルと記録先

主な実装対象は`v0/agent/host/{task_service,application_service,application_port,core_service}.ts`と、
変更された内部APIを参照する170のtask予約testである。追加のfocused確認が必要なら
`tests/v0/increment_180_*.ts`へ置き、通常test入口・JSR収録は新規moduleの有無に応じて確認する。
Data/API/TUIの実装変更は計画しない。

測定・compiled操作の証拠はgit管理外の`.tools/increment-180/`配下へbaseline/candidateを分けて保存する。
source hash、counter差分、条件、集計、操作観測、DB/readbackへのpointerを保存し、判断に必要な結果は
本書へ記録する。credential値・Authorizationは保存しない。raw request/responseは常設収集しない。

## 未確認事項と承認境界

通知差分の設計はsourceに基づく計画であり、実装後の件数、公開状態の比較、compiled TUI操作は未確認。
Data終了とCore清算の間を制御する受入probeは、既存の170/179の実経路helperから実装時に具体化する。
CPU時間・入力遅延、実providerのstream・tool loopの性能は本計画で保証しない。

今回の追加指示により、local実装・非破壊的検証、スライスごとの独立review、最後の実provider確認を開始する。
実providerの具体的な対象・回数・保存先は上記に定めた。常用配置、commit/push、実利用dataの削除は含まない。

構想・architecture・roadmapの正本は変更しない。本変更はCore内の追跡情報の反映方法を整理するもので、
Dataの状態所有や公開operation contractを変更する計画ではない。正本の意味変更が必要と分かった場合は、
本書へ案を置き、対象・理由・意味上の変更を利用者へ提示して別途承認を得る。

## 計画作成の確認と次の一手

計画作成時に現行source、179の結果、元測定報告とA28削除案を照合した。
全件転記のconsumer、親完了とfollow-up予約の同時反映、受付失敗の予約取消、受付cursorの確認を計画へ含めた。

利用者の「計画を批判的レビューさせて」により、reviewerがread-onlyで独立reviewを実施した。
結論は「P2の計画修正1点後に実装へ進める」で、coordinating ownerもsourceを照合して指摘を採用した。
現行のservice単位の所属判定をSession IDだけに置換すると、再open・削除後の旧executionへの
steering/follow-upが`notFound`から`idle`へ変わるため、生成元serviceとの相関で既存Data照会の分岐を維持する。
根拠はCoreの`makeSlot()`、`sessionDelete()`、`steeringSubmit()`、`followUpQueue()`である。

利用者の「修正して」により、生成元相関、所属判定、工程2、該当regressionの確認方法を計画へ反映した。
修正後の文書をcoordinating ownerが現行sourceと照合した。計画修正時点では独立再review、
実装、probe再実行、full gate、実provider確認は未実施だった。以降の結果は下記を参照する。

実装指示を受け、工程1の変更前baseline取得を開始した。以降の現在地と結果は本書の結果欄で管理する。

## 実装と受入の結果

### 変更前baseline

179後のsourceでcounter付きCoreを作り直し、provider-freeの100 turnを正常完了した。
Session初期化を除くrefreshは 1903 回、全件走査 96134 件、公開update 1003 回だった。
`committedTurn=100`、`active=false`、100件のcompleted/canonical・清算完了を確認した。
元測定と件数が完全には一致しないため、以前の数値を期待値として固定しない。
証拠は`.tools/increment-180/baseline/`のsource hash、counter差分、results、run.log。

公式compiled baselineのlocalhost・tmux確認はsteering、親とfollow-upの完了、detach/reconnect、
cancel、Session再open・削除後の所属照会の`notFound`、SSE revision順を確認した。
Core停止後に4件の保存executionとsemantic kind・request件数をreadbackした。
所属regressionのために作成した別Sessionのdataだけを隔離DBで削除しており、主Sessionの履歴は保持した。
証拠は`acceptance/baseline-final/`、build/baseline.log、acceptance-baseline-final.log。
初回は未保存の空Sessionの再open、二回目はprobeの初回snapshot frameのcursor参照で失敗した。
probeだけを修正して再実行し、上記結果は三回目の成功試行を使用した。実providerは呼んでいない。

### スライスA 実装とfocused確認

implementerがHost四source、170のtask予約test、新規180のtracking testを変更した。
executionChangesのupsert/removeを既存task通知で送り、Coreのsnapshot refresh前に差分を適用する。
親completeとfollow-upの予約は単一通知で届き、Core entryへ生成元ApplicationServiceを付加する。
TaskServiceの全件Mapと`executionStates()`を撤去し、所属照会をSession・現在ownerの同一性で置換した。
スライスBの受付成功後refreshはこの時点では残している。

workerのfocused確認9件、6file type/format/lint、diff checkは成功した。
親は変更されたHTTP経路を含め、170予約6件、180 tracking3件、HTTP preparing-cancel、175 HTTP
steering、 176 HTTP failureの計12件を確認して全て成功した。証拠は`slice-a/focused.log`と固定source
hash・patch。 cleanup制御はproduction Worker
capsuleを使ったCoreの実操作・購読経路で、Data終了後のsettlingと、
follow-up清算中の親complete・子予約/command相関を確認した。HTTP経由のcleanup制御ではない。
受付失敗の予約取消と再open・削除後のnotFoundも確認した。

スライスAの独立reviewは指定6file・focused証拠・hashを確認し、「スライスBへ進める、必須findingなし」と判定した。
前回P2解消、親/子同一通知、Data終了とCore清算の区別、成功refreshを残した範囲を確認した。
親は結論を採用し、スライスBへ進めた。reviewerによるtestやfull gateは実行していない。

### スライスB 実装とfocused確認

親が`taskSubmit()`のadmit成功後の明示refresh一行だけを撤去した。失敗catchと他operationのrefreshは維持した。
新規receipt testは正式API WorkerのHTTP/SSEでaccepted cursorのrevisionを再構築し、
execution/command相関、workingと入力受付状態を確認して、同じexecutionのcanonical完了・保存結果を照合する。
HTTP preparing-cancelと合わせ2件pass、type/format/lint/diff checkも成功した。証拠は`slice-b/`。
最初の型確認はtestのoptional
cursor参照で失敗し、存在assertionを加えて成功した。公開contractの変更はない。
スライスBの独立reviewは同期publishからcursor返却の順序、失敗catch維持、正式API/SSE確認とhashを照合し、
「スライスCへ進める、必須findingなし」と判定した。親は結論を採用した。

### スライスC 同条件測定

同条件のprovider-free 100 turnで、初期化を除く全件走査はbaseline 96134 件から候補0件になった。
候補のexecution差分適用は200件（各executionの予約と清算完了）だった。
baselineのadmit成功後refreshは100回で、候補では当該呼出しがなくなった。 refresh全体は 1903 回から
1801 回、公開updateは 1003 回から 1002 回だった。
非同期runtime/data通知の件数差を含むため、配信件数の完全一致や速度改善は主張しない。
両版とも100件のcompleted/canonical・清算完了、最終committedTurn=100・idleを確認した。
証拠はbaseline/candidateのsource hash・counter-only.diff・results・run.logとcomparison.json。
公式compiled候補もlocalhost・tmux操作が成功した。F3 steeringが最終回答後の次requestへ適用され、
F2予約follow-upが親完了後に開始・完了し、detach/reconnect、本文途中cancelとidle復帰を確認した。
別Sessionへ切替後の親execution照会はcommand相関・completeを保持し、再open・削除後の旧実行への
steering/follow-upはbaselineと同じnotFoundだった。HTTP/SSEの57 frameでrevision順が連続した。
Coreはshutdown後exit0で終了し、停止後SQLite読取で4 executionの本文・semantic kind・request件数・
outcome/adoptionを照合した。baseline/candidateの保存factはexecution IDを除いて一致した。
証拠はacceptance/candidate/、acceptance-candidate.log、saved-comparison.json、build/candidate.log。
公式compiled候補のbuild IDは`1b2399d89aaaed6b00eeee573959aba19e778331d19db480e65bbb0c929ac6cd`。
スライスCのlocal結果の独立reviewは測定・build・5画面・HTTP/SSE実frameと停止後SQLiteを確認し、
「local受入成立、authoritative gate一回と承認済みliveへ進める、新findingなし」と判定した。 57
frameを独立再構成し、親completeと子preparingの間のidleなし、実行自身の非context semantic本文を
read-only SQLiteで照合した。429 source/test/configのhashも一致した。親は判定を採用した。
安定候補に対するauthoritative `v0:gate`を一回実行し、type・format・lint・全体testが成功した（649
passed、0 failed、約1分18秒）。 最終429
source/test/configのhashはgate前後で一致した。続いて下記の実provider確認を最後に実施した。

### 最後の実provider確認と保存readback

公式compiled候補の同じbuildで、隔離HOME/XDGとtmux上の
`openai-chatgpt / gpt-6.1-sol / medium`を使い、予定した4 executionを確認した。

| 操作                  | 結果と停止後readback                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI通常完了           | completed/canonical、HTTP 200・1 request。本文markerを画面とsemantic履歴、canonical会話で確認                                                       |
| 親task自然完了        | F2予約を受け付けた後completed/canonical、HTTP 200・1 request。親本文とcommand相関、清算完了を確認                                                   |
| 予約follow-up自然完了 | 親完了後に起動しcompleted/canonical、HTTP 200・1 request。予約のexecution/command相関、本文、最後のidleを確認                                       |
| 本文途中cancel        | 部分本文表示後にEscapeを送信しcancelled/non-canonical、HTTP 200・1 request。部分本文をsemantic履歴で読み戻し、canonical会話へ採用されないことを確認 |

推論requestは各実行1回、合計4回で、追加推論・別モデル確認は行っていない。 Core
shutdownはacceptedを返し、exit0で終了した。停止後read-only SQLiteから4 executionと本文・
outcome/adoption・model/effort・request factを照合し、canonical会話に3つの完了turnが保存され、
cancel
taskが混ざらないことを確認した。本文確認は自然完了3件の`model_result`のresult本文と、cancelの`assistant_message`にある
`assistant_progress`本文を直接対象とし、context/admission・user入力文だけでは成功としない。自然完了3件にparser
transition失敗はなかった。 cancelのrequest factには`response.output` absentによるparser transition
failureが1件記録されたが、
公開結果はcancelled/non-canonicalで、部分本文の保存とreadbackは成立した。今回この既存parser経路は変更していない。
元登録auth fileのhashは実行前後で一致し、証拠19 fileにcredential値の露出はなかった。 最終429
source/test/configはgate/live前後で一致している。
証拠は`live/`のresults.json、readback.json、semantic履歴4件、画面6点、evidence-check.json、
live-probe.log、live-readback.log。実利用config・DB・常用Core・配置先は変更していない。

追加されたgate/live結果の限定reviewは15分以内で完了した。
reviewerは一回のgate、local確認と同じbinary SHA/build、4
requestの終了結果、停止後DBのassistant本文、 canonical3件、shutdown exit0、露出検査と429 source
hashの一致を独立に照合した。
補助readbackの初版はcancel本文をmodel_result全体のsubstringで照合してuser入力にも一致したため、
指摘を採用してassistant_progress本文fieldへ限定した。自然完了とcanonical会話も回答本文fieldを直接照合し、
同じ停止済みDBのreadbackを更新した。reviewerは補助確認の修正と保存本文を確認し、解消と判定した。
production source、gate、providerを再変更・再実行していない。
保存buildIdのdevelopment値表示は既存B9であり、compiled binaryのversion/build照合と区別した。
同parserのcancel時transitionも含め、今回の新product
regressionとする根拠はなく、必須findingは残っていない。

coordinating ownerは各review結論と実行・保存証拠を照合して採用し、180のlocal受入を完了とした。
全件転記と対象の重複refreshを除き、受付・実行照会・steering/follow-up・cancel・Session参照・
画面操作・保存readbackが実経路で成立した。CPU時間や入力遅延の改善は保証しない。
commit/push・常用配置は行っておらず、構想・architecture・roadmapの正本も変更していない。

## Commit/push・常用配置

利用者の「コミットプッシュ配置をしてください」により、180の実装・関連結果記録のcommit/pushと、
現在sourceの常用配置を追加承認された。実provider受入済みsourceが変わっていないことを確認して進める。
配置先は既存の`dist/henji`と`/home/agent/.local/bin/henji`。追加の実provider callは行わない。

実装・関連記録をcommit `5fc6c2aa3d784b89952e3962a084eade3443bfc1`へまとめ、`origin/main`へpushした。
先行するarchitecture/roadmap反映と文書整理の2 local commitも同じpushで反映した。 そのclean
sourceから公式`henji:compile`でbuildし、`dist/henji`と`/home/agent/.local/bin/henji`へ配置した。
前の常用binaryを`.tools/increment-180/henji.previous`へ保存し、staging fileから置き換えた。

- version: `0.8.0`、Deno `2.9.7`、sourceは上記実装commit（dirtyなし）。
- 配置build ID: `d04c91c6f041affbc9fa5ea1e83295c178838f1c6d981920929782b54326e02f`。
- Runtime digest: `801e9c8a9841304305cbdb623e3d59f7d32c5b08569e10300874c1d1e3cd65c5`。
  local/live受入済み候補と一致する。build IDの差はcommit/sourceのprovenance更新による。
- Binary SHA-256と旧binaryの保存情報は`.tools/increment-180/deployment.json`へ保存した。
  配置先とdistのhashは一致し、配置先`--version`と起動Coreのbuild/sourceも一致した。

配置先binaryを隔離HOME/XDG/workspace/stateで起動し、production Core/API Workerとtmux TUIで
localhostの1 taskを送信した。回答本文を画面で確認し、completed/canonical・清算完了・idle復帰、
shutdown accepted/exit0、停止後1 executionの保存readbackを確認した。
証拠は`acceptance/deployed/`、deployment-build.log、deployment-probe.log、deployment-readback.log。
追加の実provider callは0回。確認用Core/TUI/providerは停止済み。
常用Coreや実config・既存DBは変更せず、新しく起動するCoreから179・180を含む配置版が使われる。 最終429
source/test/configのhashは受入時と一致し、gateを再実行していない。
完了状態の文書更新も同じ承認範囲でcommit/pushする。記録commit後にbinaryは再buildしない。
