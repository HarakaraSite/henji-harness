# Increment 170 — 共通逐次更新による会話表示と操作経路

更新日: 2026-10-03

ステータス:
**S1〜S5のlocal実装・検証が完了。通常／批判的reviewの採用指摘、compiled実経路、実provider自然完了／cancel、最終gateが成立。常用配置・commit/push済み。2026-10-03の利用者による完了承認で完了。公開は未実施。**

## 目的、採用範囲、根拠

利用者は[共通逐次更新の設計案](../research/a28-unified-conversation-update-design-2026-10-02.md)を承認し、
計画作成と通常・批判的レビューを指示した。「現状の責務を念頭に置かない」を原則とする。
必要な動作と更新規則から配置を決め、既存担当・同期API・コード変更量を採否理由にしない。
本incrementへ通常利用メモA28を採用する。当初の三段階案を実装工程の前提にしない。

人間が新規／保存済み会話で指示を送り、thinking・本文・toolの進行を順に見て、途中でキャンセルし、
保存された最終状態を開き直し、次の指示を送れることを成立条件とする。
保存履歴の初回入力と実行中の入力で、一つの更新器と同じidentity・順序・確定規則を使う。
受信・保存通知のたびに過去を読み直して全体を再構築する経路を廃止する。TUIも項目単位で更新する。

[実provider観測](../research/a28-real-provider-observation-2026-10-02.md)のrun-2では物理request一回に対し
全projection414回、362.781秒、journal write合計142.786msだった。cancel返答まで346.068秒のうち
handler開始待ちは344.897秒。198件保存batchの通知処理は178.295秒だった。
仕事量の削減と操作経路の独立を同時に実装する。配置を試して測定結果から設計を選ぶ工程にはしない。
当時の2.5GiB保持は再現しておらず、本incrementの解消保証に含めない。CPU・RSS・処理遅延は再測定する。

対象は共通会話更新器、DB／model用Session
dataのデータWorker、Coreの操作・配信、Agentのdata／control経路、
TUI、関係するAPI／CLI利用者、Workerの起動・終了・buildへの組込みである。
WebUI、新しいprovider対応、自動再試行、raw常設保存、追加API／CLI
Worker、表示専用DB、既存data削除は含めない。 Increment 169の変更は保持する。後方互換のdual
path、旧API fallback、旧表示の初回専用projectorは追加しない。 既存history
v7を正本として使うことは、旧形式への互換処理の追加ではない。

## 現行の実経路と置換対象

sourceは必要動作と現在の利用者を確認する資料であり、現行責務を保持する条件にはしない。

| 人間の操作・出来事       | 現行の入口から結果まで                                                                                                              | 計画での置換                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 指示を送る               | HTTP server → Core task.submit → ApplicationTaskService → WorkerHostCoordinator／SessionAuthority → journal／Agent                  | Coreが小さい実行予約を持ち、Dataでadmission・contextを作り、Agentへ直接渡す           |
| thinking／本文／tool更新 | Agent observation → coordinatorの受信通知 → Core refresh → query／api_projection → snapshot diff。保存後はjournalの各resultでも反復 | Dataへ順序付き入力、保存batchから一度apply、変更entityを一度配信                      |
| 保存会話を開く           | Core sessionRead／makeSlot → readWorker／readSessionHistory／restoreRecordMessages → api_projection                                 | Dataで原factを初回再生し、保持した共通stateからsnapshotを出す                         |
| 再接続・追加指示         | snapshot購読 → reducer → TUI projector。model contextは別途SessionAuthorityから                                                     | snapshot cutとwatchを連続させ、保持stateを継続。model用dataはDataから取得             |
| キャンセル               | executionReadで全履歴読取 → task.cancel → runtime通知／stage snapshot／journal flush → Agentへcancel → Core refresh                 | Coreの実行indexで対象を選び、直接送信。記録・表示は後続の非同期更新                   |
| 終了・canonical採用      | coordinatorでrecord全文組立て・検証 → children cleanup → terminal transaction → authority更新 → 通知                                | Dataでprepare／保存、Coreで採用判断、COMMIT後のterminal factと小さいcontrol状態を配信 |
| TUI更新                  | API reducerの配列検索・コピー → SnapshotConversationProjector全messages → entries全置換 → window描画                                | keyed stateへ全deltaを即時適用、同じentity mapperで該当entry更新、dirty描画だけ合流   |

主な現行箇所はCoreのrefreshSlotSnapshot／publishSnapshot／sessionRead／executionCancel、
ExecutionJournal.appendHistory、api_projectionのthinkingForVisibleExecutions／buildToolOccurrences、
worker_tui_sessionのrestoreRecordMessages、TUIのrenderSnapshot／applyConversationProjection／updateConversation。
TUIのlayout自体は既にwindowを限定している。全履歴layoutが原因だとは扱わない。

## 会話状態と共通入力の契約

データWorkerがSessionごとのConversationStateの唯一のwriterとなる。
DB読取adapterと新規保存adapterは同じFact型へ変換し、同じnormalizer／applyFactへ渡す。
normalizerはrequest開始・tool開始のindexを逐次維持し、関連の解釈を初回とliveで分けない。
初回の保存factsも、liveの保存batchも元の順序で入力する。初回に完成表示を事前集約しない。

| 対象        | キー・更新規則                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution   | executionId。指示、outcome、adoption、terminal、model attributionを保持する                                                                                                                                                               |
| request本文 | executionId＋lane＋modelStep＋requestOrdinal。同requestの途中本文と確定本文は同一entity。terminalでsemantic IDが付いても作り直さない                                                                                                      |
| thinking    | request key＋thinking kind。最新textとcompleteを更新する                                                                                                                                                                                  |
| tool        | 保存model_resultのoccurrenceId＋call位置を表示identityにする。開始済みcallのsemantic occurrenceIdは独立属性。宣言がない実callはその保存occurrenceIdをidentityにする。execution/request/call indexで対応付け、callIdだけで実行をまたがない |
| steering    | 要求中はpending操作状態、実適用steering_messageで会話へ追加。同じ指示を二つのuser行にしない                                                                                                                                               |
| 表示順      | executionとrequest開始・firstEventOrdinal・occurrence順序を関連として保持。文字更新では並べ直さない                                                                                                                                       |

FactはSession／execution identity、入力の保存ordinal／worker sequence、entity
key、順序の根拠、内容、確定状態を持つ。
版は保存位置と元の入力番号から正規化し、apply回数やbatch分割から作らない。
保存済み途中本文が最新値一件に圧縮されていても、liveで複数回更新した結果とidentity・位置・内容・確定状態を一致させる。
tool宣言はmodel_resultに保存されたcallsから入力する。本文がないtool-only resultでも宣言を取り出す。
未開始callを表示し、同request＋call位置に対応するtool_callが来たら同entityへ実semantic
IDを付けて更新する。 宣言対応indexと開始済みopen-call
indexを分け、progress／resultは開始済みcallへ対応させる。 保存履歴再生とliveでも同じmodel_result
originからidentityを作り、開始時に別のtool行を増やさない。
これにより、複数callを宣言した後に途中停止しても、開始していないcallが表示から欠落しない。

toolの宣言元はmodel_resultを生成した時点で固定する。実行loopはそのrequest attributionとcall内位置を
開始・progress・resultへ引き継ぎ、tool記録時の最新HTTP requestから帰属を選び直さない。 補助HTTP
requestは別request factとして記録するが、tool entityの宣言元・表示位置を変えない。 physical
request番号がないmodel resultについても、途中の補助request番号を後付けしない。
toolは外部Definitionから追加・差替え可能であり、関連付け・更新を内蔵tool名の一覧へ依存させない。
外部module → ExecutableToolDefinition → ToolComponent.materialize → Registry →
共通loopの経路を維持し、 任意のtool名・宣言した引数・進行・結果にも同じorigin規則を使う。

本文stateに最新版の番号がない場合は同じDB読取transaction内の対応event／payloadから一度取得し、Coreで探索しない。
terminal本文のfirstEventOrdinalと最終保存位置を、配置と版で混同しない。

会話stateは現在値と関連indexを持ち、thinkingの全過去snapshotを保持しない。
通常更新の計算量は変更entityの内容と関係するindexに依存し、過去会話全体の長さに依存させない。
変更本文そのもののコピー／Markdown解析は残るため、一文字更新の全処理が定数時間になるとは主張しない。
初回snapshot、明示的な全文history／context取得、model開始contextの生成では必要な全体処理をData側で行う。

出力はentity upsert／removeと構造変更、execution変更、Session／contextの必要なmetadata更新。
APIのmessages／requestsの二重本文とbeforeMessageIndexを新entity・順序契約へ置き換える。
配列を毎回再生成して旧APIへ適合させるadapterは残さず、codec・client・TUI・HTTP利用者を同時に切り替える。
snapshotのschemaVersionは2へ切り替え、entityと順序構造を正規のwire契約にする。旧版とのdual
decodeはしない。

## 実行単位と通信

| 実行単位     | 状態・処理                                                                                                                       | やり取り                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Data Worker  | history v7、canonical model data、record組立て・検証、admission／terminal transaction、共通会話state、初回再生、公開dataのencode | Agentのdata channel、Coreの非同期command／reply・保存batch通知              |
| Core         | command受付、Session／execution／generationの小さいindex、実行予約、採用判断、process／child制御、購読と単一public revision      | Agentへの直接control、Data command、HTTP／SSE中継                           |
| Agent Worker | provider／tool、実行中context、proposal作成                                                                                      | Coreへready／control／process／child要求、Dataへcontext・semantic・proposal |
| TUI          | keyed entity／entry、同一mapper、scroll anchor、Markdown・layout・viewport                                                       | snapshotと後続deltaを受信し、操作をCoreへ送る                               |

常駐CoreにつきData Worker一つ。Sessionを開くたびに増やさない。 standalone runも同じData
service／controllerで一つを所有し、終了時に閉じる。 offline history CLIはread-only DB
adapterと同じ更新器を使える。canonical viewとdetail exportの正本契約は維持する。

Core→Agentのcontrol channelとAgent↔Dataのdata channelを分ける。
MessageChannel／移譲したMessagePortをbootstrap時に渡し、context・全文proposalをCoreでコピーしない。
core-owned process／childの要求はcontrolに残し、大きい履歴・context・recordをcontrol
replyに混ぜない。 Worker protocolのdata-only値を維持し、callback・DB handle・authority
objectを転送しない。 data側の各execution/generation sequenceとcontrol側のcorrelationを、terminal
barrierで対応させる。

内部Data commandはrequest IDとSession／execution correlationを持つ非同期request／replyにする。
最低限のoperationはinitialize／open／read／admit／append／prepareProposal／authorizeCommit／settle／
sealGeneration／recall／selection・title更新／context・history・execution read／closeである。
同期HistoryPersistencePortをCoreで呼ぶadapterは撤去する。同期store処理はDataの内部でのみ呼ぶ。
artifactForCaptureはData内のcapture結果とartifact dataから組み立て、関数をportへ渡さない。
childのappend／settleもこの経路へ替え、Coreに同期DB writeを残さない。

## 保存から配信まで

AgentのdataをDataのjournal bufferへ入れ、順序を保ってatomic batch保存する。
現行25ms／256件を初期のbatch基準として使い、terminalは対象sequenceまでの保存を待つ。
新しい表示用保存先は作らない。受信時と保存時に同じfactを二度applyしない。
保存結果は元の入力、保存版、semantic occurrenceId、本文stateの変更をまとめて返す。
COMMIT後に同じ更新器へ全factを順に入力し、配信では同entityの最新値へ合流する。
構造変更・指示・tool関連・terminalを合流で失わない。

terminal transactionの残存本文semantic化、本文state削除、terminal identity、outcome／adoption、
canonical Session
revisionを、canonical／noncanonical／reconcileの全経路でCommitDeltaとして取り出す。
transaction内部から配信せず、COMMIT成功後にだけapply・配信する。再読取による確定通知を使わない。
保存failure時に成功表示や再実行を作らず、現在成立しているfailure／noncanonicalの動作を維持する。

Dataは公開会話payloadをencodeし、初回の大きいsnapshotは移譲可能なbytesとして返す。
Coreは小さいcontrol envelopeとpublic cursorを付けてHTTP／SSEへ中継する。
全会話のJSON.parse／再encode／structuredCloneをCoreの通常処理に入れない。
HTTPのsnapshotを含むcommand応答もこの経路へ切り替える。会話stateのCore側複製は作らない。
Coreはdata／controlの両更新へ一つのpublic revisionを付ける。Dataの保存版は公開cursorと区別する。

## admission、採用、キャンセルの順序

Coreは指示受付でexecution予約とgeneration correlationを先に作り、Dataへadmissionを要求する。
Dataへのawaitより前にcommandId・executionId・preparingをruntime.reservationとして公開し、
pending.activeTaskとexecution.cancelの操作可否も更新する。予約は保存済みExecutionViewのrowと区別する。
TUIはtask.submitのreceipt待ち中でも、同commandIdの予約をcancel対象にできる。
API／Core／TaskService／TUIのpendingSubmission・acceptedSubmissionの扱いを一緒に変更する。
Dataがcanonical
data・contextを準備し、Agentへ直接渡す。Coreは小さい開始可能通知を受けて開始を許可する。
待っている間のcancelは予約を取消し、遅れてcontextが完成してもAgentを開始しない。
元のtask.submitの完了と保存executionの結果はData admissionの実際の成立に合わせて確定し、
cancel応答を待たせる根拠にしない。TUIは取消後の遅着receiptで予約をrunningへ戻さない。

proposal全文はAgent→Dataへ送り、Coreへはproposal IDと最終data sequence等の小さい通知を送る。
Dataはそのsequenceまでjournalを保存し、recordを組み立て・検証してprepare tokenをCoreへ返す。
tokenにはproposal ID、execution/generation correlation、base Session revision、最終data
sequenceを含める。 Coreは必要なchild/process
settlementと現在の取消状態を確認し、同じcontrollerで採用許可または取消を順序化する。
別portの到着順を採用順序にしない。Dataは許可されたtokenに対応するtransactionだけを実行する。

選択の境界はCoreの採用許可。取消判断が先ならcanonical許可を出さない。
許可後の取消は既に決めた採用を巻き戻す要求にせず、残るAgent／processの停止へ送る。
保存が終わるまではsettlingでありcommittedと表示しない。取消の受付・Agent受信・保存済みoutcomeを混同しない。
Agentのprovider／tool用AbortSignalとcommit判断待ちを分離する。proposalを送った後のcommit waiterは
abortをfalseへ変換せず、Core／Dataの明示的な採用・拒否・保存failureで完了する。
取消が先ならCoreの拒否を受けてnoncanonical終了へ進み、許可が先なら保存結果を受けてその結果で終える。
同executionへ二度目のsettlementを作らない。COMMIT後のturn_end・停止・ackの遅着は通常のsemantic
appendにせず、 既存のpost-commit観測へ相関し、保存済みterminalのoutcomeを変更しない。
COMMIT後の通知でCoreのcanonical positionとDataの会話stateを進め、Agentへacknowledgementを返す。
process cleanup完了は別のcontrol factとし、canonical採用と同じ状態にしない。

cancelはCoreのexecution indexとactive correlationで対象を決め、Agent・process・childへ直接送る。
executionRead、画面更新、Dataのread／flush／保存、terminalの終了待ちを送信前に挟まない。
Coreのcancel command応答は送信の結果で返し、記録はcontrol sequence付きでDataへ非同期に送る。
終了済みexecutionの確認は小さいrow readだけをDataへ要求し、全events／semanticを読む経路を使わない。
既存のgrace・escalation・cleanupの利用者動作を維持し、Data待ちでwatchdogを止めない。

## 初回、再接続、履歴からの継続

DataはDBの一つのread transactionから原factsを取り、空stateへ初回再生する。
保持中のSessionはこのstateを再利用し、新指示も同じstateへ追加する。model contextはcanonical model
dataから作る。 Core再起動時には保存factsから同じ手順で再生する。private
stateをTUI向けの正本にしない。

Data側でsnapshot cutとwatch登録を同じ境界に置き、snapshotとcut以後のdeltaを同じ順序付きportで出す。
Coreは受信時に最新control状態を合わせ、public revisionを確定してsubscriberへ初回frameを出す。
snapshotの配信とsubscriber登録の間にawaitを挟まない。先行する公開frameとcutの対応を保持する。
Coreでcontrolが変われば後続revisionで必ず配信する。初回snapshotで旧control状態へ巻き戻さない。
複数TUIが接続してもDB再生や会話更新器を増やさず、同じdata変更を配信する。
接続解除はwatch／sinkを解除する。状態保持はCoreが保持するSessionの利用期間に対応させ、全履歴を毎接続で再生しない。

## TUIの更新

初回全entityとliveの変更entityを、同じentity→entry mapperへ渡す。 API client stateとUiStateはkeyed
storeと順序indexを持ち、文字変更で全配列findIndex／map／copyをしない。
表示entryのID・版・順序も入力entityから定め、初回専用のbeforeMessageIndex解釈器を残さない。
全受信revisionをすぐstateへ適用し、schedulerはdirty entryの描画だけを合流する。 latest
callbackの置換で未適用deltaを落とす現行updateConversationの使い方を廃止する。

tool call／progress／result、途中／確定本文、thinking、execution noticeを項目単位で更新する。
RemoteSystemNoticesの全entries mergeもexecution単位へ替え、Increment 169のrecall案内を維持する。
scroll anchorはentry IDと本文offsetを保持し、同entry更新で移動させない。
構造削除時だけ近傍anchorを選ぶ。history
windowは順序indexから必要範囲を取り、通常更新で全配列を作らない。
EntryLayoutCache・window限定描画・frame
writerを使い、変更entryと画面に必要な範囲だけを再layoutする。
初回は入力終了後に一度描画する。ライブ中のeditor、scroll、modal、session切替も実TUIで確認する。

## 起動、終了、障害とbuild

Core起動でData bootstrapを一度開始し、DB
initializeと必要な既存reconciliationの完了後にSession操作へ進む。
Coreのhealth／controlはこの非同期準備によってmain threadを占有しない。 Agent
generationへ二つのportを渡し、置換・終了で旧generationのportとwaiterを閉じる。 Data
error／close時はpending commandを完了不能として返し、Coreが既存unavailable・停止動作へ進む。 busy
Dataの応答を待たずAgent／process／childへ停止要求を出せる。自動再起動や透明な再実行は追加しない。

旧generationのData受信側portとwaiterを閉じる順序は、入力cutの確定・flush・terminal保存・seal
ackの後とする。 正常proposal／turn_failedは最終data
sequenceを通知し、Dataがその番号まで受けて保存してからsealする。 強制停止／generation
replacementではCoreがAgentとphysical実行を直接止めた後、DataへsealGenerationを非同期送付する。
Dataは旧generationの新規入力をsealし、その時点で受信済みの連続prefixを保存対象cutとしてflushする。
未受信のin-flight入力が全て保存されたとは報告しない。seal後の旧generation入力を通常appendへ流さない。
Coreが既に決めた採用許可または取消に従ってterminalをCOMMITし、CommitDeltaとcutのackを返す。
採用許可済みならsealで別のinterrupted settlementを作らず、既存のCOMMIT結果へ合流する。
Data受信側port／pending bufferを保存前に閉じず、Coreはseal ackとphysical
cleanupの後に次世代admissionを許可する。
Coreの即時停止送信はこのackを待たない。正常終了・grace後の強制停止・shutdownに同じ手順を適用する。

parent／childとも同じseal／保存ackを使う。childはnoncanonical settlementとし、計算完了、Data
terminal COMMIT、 physical cleanupを別状態にする。child acknowledgementと親へ返す完了状態はchild
COMMIT後に出す。 parent採用許可はchildのterminal COMMIT ackとphysical cleanupが揃ってから出す。
childの結果収集・cleanup待ちを同期DB操作へ戻さず、Coreのcontrol処理を継続する。

Core
shutdownは新規操作を止め、直接cancel／cleanupを開始し、残るsemanticをflush・terminal保存してからDataのDB／lockを閉じる。
正常終了の保存を省いてforce terminateへ置き換えない。完了通知を得てportを閉じ、Dataを終了する。
standalone runもfinallyで同じ終了処理を呼ぶ。新Worker
rootをscripts/build_henji.tsのclosure／includeへ加え、 source
Denoと公式henji:compileの両方で同じ入口が動くことを確認する。

## スライス単位の実装・検証・レビュー

利用者は計画をスライスにし、その単位で実装・test・reviewするよう指示した。
承認済み配置・更新規則を維持し、利用者が使う入口から結果まで確認できる単位に組み直す。
各sliceはlocal sourceで実経路を確認する単位。常用配置／公開をsliceごとに行う意味ではない。
未移行の入口は次sliceの対象として明記し、新経路に旧形式fallback・dual read／writeは追加しない。
同じ入口を切り替える際は旧処理もそのsliceで外す。全体切替まで常用版は更新しない。

| Slice                             | 人間が確認できる成果                                                                                   | 実装と切替対象                                                                                                                                                                                                                                                                                   | 完了確認・レビュー                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1 共通会話更新と履歴CLI          | history --view=sessionで途中／確定本文、thinking、tool、試行履歴が同じ規則で表示される                 | v0/conversation/のFact・entity・normalizer・apply・初回／保存adapter、history storeの原fact取得と同期append／terminal CommitDelta、history_view／history_cli。完成表示の事前集約をこの入口から除去                                                                                               | 実storeのappend／terminal保存結果を逐次入力したstateと同DBの初回読取が一致し、さらに新executionを追加できる。隔離DBコピーでproduction CLIを実行。通常・批判的review                                                                                    |
| S2 Data Workerでの明示読取        | Coreのhistory／context／execution等の明示的readが別Workerで成立し、読取中もCore healthが応答する       | read-only Data service／bootstrap／client、Core明示read入口、encoded payload、build root。各readは一read transactionからS1 engineを作る。保持live state／watchとwriter lock／reconciliationはS3                                                                                                  | 実Worker／実store／HTTPのread、Core start／close、読取中control、旧writerの保存後に次readで更新が見えることを確認。実行writer・公開live配信は未移行。通常・批判的review                                                                                |
| S3 Agent実行の保存・操作とAPI配信 | standaloneとHTTP/headlessで自然完了／cancel／履歴再開とchild/processが新しいdata/control経路で成立する | model Session dataとrecord組立て、非同期journal／admission／prepare／COMMIT／seal、Agent直接data port、Core予約・採用・cancel、child保存／ack／cleanup、Data保持state／cut／watch、schemaVersion2 entity wire、Core単一public revision／購読。旧同期writerとCore refresh／projection／diffを撤去 | production Worker／store／headlessで本文・tool・terminal保存、prepare/cancel順序、強制停止、次指示、child、HTTP/SSE cutを確認。保存batch一回で変更entityが一度配信され、Coreの過去query／全projectionを通らない。TUIはS4まで未移行。通常・批判的review |
| S4 TUIの逐次表示と操作            | 人間がTUIで指示→thinking/tool/本文→停止/完了→再接続→次指示を行える                                     | TUI keyed store／初回とdirtyの共通mapper／dirty描画、予約cancel、notice、CLI利用者。全entries置換と初回専用restoreを対象入口から撤去                                                                                                                                                             | focused client/TUI確認と隔離tmux production TUI。複数接続／再接続／scroll／editor、更新時過去queryゼロを確認。通常・批判的review                                                                                                                       |
| S5 compiled総合受入と計測         | 常用と同じcompiled経路で機能と停止応答が成立する                                                       | 未使用旧pathの残存確認、公式compile、source/compiledの入口、実provider計測と結果文書                                                                                                                                                                                                             | 既存実DBコピー、production tmux、自然完了一回・途中cancel一回の実provider確認、CPU/RSS/表示・制御遅延を分けて記録。安定候補でownerがgate一回。全sliceの実装review・結果を総括                                                                          |

各sliceは実装後に対応するfocused test、type check、format、lint、diff checkと実経路確認を行う。
そのsliceの安定差分だけを通常・批判的reviewへ渡し、具体的なfindingを親が採否判断し、必要な修正と一回の限定再reviewを終える。
件数や旧fixture契約を完了条件にしない。次sliceは前sliceの契約と結果を入力とする。
S1〜S4のreviewerはfull gate・外部providerを実行しない。S5でownerが総合受入を行う。

sliceを越える変更が必要なら原因と対象を同文書へ反映し、承認済み動作内の依存修正として扱う。
配置選択のtrial-and-error、一般的hardening、未観測variantの追加は行わない。
architecture／roadmapの正本は承認境界に従い、当面は本書の具体的反映案に留める。

## 検証と受入

test件数は目標にしない。変更された人間の動作と観測済みregressionだけを次の確認へ対応させる。

| 動作／根拠                      | 必要な確認                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 保存とliveを同一規則で継続する  | 実storeへのappend／terminalから作るstateと、同DBを初回adapterで読むstateを比較。本文・thinking・tool・steering・canonical/noncanonicalが一致し、読み込み後に新executionを追加できる  |
| 414回の全再構築を廃止する       | thinking／本文更新と保存batchで、過去query・full projection・全snapshot diffが呼ばれないことをproduction traceで確認。1保存batchは1 data配信、変更entityだけを更新                   |
| busy Dataが停止要求を遅らせない | 隔離Dataの実read／prepare中にHTTP cancelを送り、Coreの受信・送信、Agent cancel_received、Data terminal、cleanupを別々に観測。制御送信がData処理完了前に到達する                      |
| 採用判断を誤らない              | production controller／Data transactionで、取消が先ならnoncanonical、採用許可が先ならdurable結果を維持。commit failureを成功にせず、terminal残存本文を再接続で重複させない           |
| 初回と再接続で抜けない          | snapshot cut近傍のdata／control更新を実port・HTTP/SSEで確認し、複数TUI／再接続のstateと表示が一致する                                                                                |
| 人間が表示と操作を続けられる    | tmux production TUIで途中thinking／本文、tool、停止、最終表示、履歴再開、scroll anchor、editor、notice、detach／再接続を確認                                                         |
| 既存の入口が動く                | compiled Core start／shutdown、standalone runの通常／stream、HTTP history／context／execution、offline history、recall、child/processの開始／停止・保存を関係箇所のfocused確認で検証 |

レビューで具体化した終了動作も上記へ接続する。commit待機中のcancelではAgentの失敗通知とcanonical保存が
競合しないこと、preparing予約のreceipt待ち中でもtmux TUIのEscで取消できることを確認する。
正常終了・強制停止の入力cut、terminal一回、cut後の旧入力、Data port終了、次指示への復帰を
実Worker／実storeで確認する。childではCOMMIT→ack／親への完了→physical
cleanup確認→parent採用の順序を確認する。

既存testsは139 API read、140/141/143 HTTP/TUI、142 pending、146 history、150 shared history、154
projection／scheduler、 155 shutdown、159 outcome／notices、167 historyと39 cancellation／133
process等から変更動作に対応するものを選ぶ。
旧array契約やfixtureのみに依存する期待値は新しいproduct契約へ修正し、旧経路をtestのために残さない。
新たな共通engine・Data port確認は実store／実Workerを使うfocused testとして追加する。 実装中はfocused
test、対象のtype check・format・lint・git diff --checkのみ。 安定候補でcoordinating
ownerがv0:gateを一回行う。reviewerにfull gateを要求しない。

隔離XDG／workspaceとe71f582aのDBコピーで公式compiled binaryのCore／TUIを使う。
証拠保存先は.tools/increment-170/。実config・既存DB・稼働Coreへ接続して検証しない。
比較baselineは既存run-2であり、旧版への追加provider requestは行わない。
長い途中更新の確認は同じprovider/model
opencode-go-chat／mimo-v2.6-proで、自然完了一回、途中cancel一回の 計2 physical
requestを予定する。tool／複数stepの表示はlocalhost providerのproduction経路で先に確認する。
実providerの対象・回数・保存先はこの計画で提示するが、今回の計画作成では呼び出さない。 前回許可の計2
requestは実施済みであり、新しい実provider確認は実行前に明示承認を得る。

計測はAgent送信→表示、HTTP cancel→Core送信→Agent受信、terminal／cleanup、CPU、main
loop遅延、RSSを分ける。
provider処理時間をCore改善と混同しない。更新ごとの過去queryと全再構築はゼロを受入条件とする。 busy
Dataの処理終了より前にcancelを送信・受信でき、数分のhandler受付滞留が消えたことを確認する。
自然完了後のterminal反映が過去履歴再構築待ちにならず、TUIが途中から順に表示できることを確認する。
CPU／RSSは入力数・本文量・provider時間と共に記録し、履歴全体を毎更新で再走査しないsource／traceと合わせて判断する。
2.5GiBの内訳追究や、架空の一律メモリ上限を完了条件に追加しない。

## 正本への反映案と承認境界

計画・レビュー文書作成に加え、後続指示でslice単位のlocal実装・非破壊的test・reviewが承認された。
常用配置・commit/push・公開・実data削除は行わない。

architectureの変更案は、Host内にData Workerを追加し、Core／Data／Agent／TUIの物理配置、共通state、
二channel、採用許可・保存完了、snapshot cutを本計画に合わせて記載すること。
roadmapの変更案はA28をIncrement 170の採用済み機能として参照し、実装状態を実際の進捗へ同期すること。
構想の目的と人間による採用境界は変更しない。
architecture／roadmapの実編集は、変更対象・理由・意味を別途提示して明示承認を得てから行う。

## 計画検証用の小規模probe

2026-10-02。利用者は計画検証のための小規模probeと実provider実行を許可した。
現段階では通信primitiveの実行可能性を確認するprobeが必要と判断し、実provider
requestは不要として0回とした。
観測済みの旧production経路を再び実providerで動かしても、未実装の新更新・保存経路は検証できない。
実providerでの表示・停止・CPU／RSSの確認は、修正後のproduction受入で行う。

隔離probeは実Deno Web Worker二つを作り、Core相当のmainからMessagePortを移譲した。
Data→Agentへ1MiBのArrayBufferを直接移譲し、Agent側の長さ・内容とData側bufferのdetachを確認した。
Dataが250msの同期CPU処理を行う間に、mainから別control経路でAgentへcancelを送り、
Dataの処理終了より前にAgentのcancel_receivedがmainへ返ることを確認した。

| 実行                                    | 結果                                                     | mainでbusy開始通知を受けてからcancel受信通知まで |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Deno 2.9.7 source                       | port移譲・1MiB直接配送・buffer detach・独立controlが成立 | 約0.16ms                                         |
| Deno 2.9.7 compile、Worker入口をinclude | 同じ動作が成立                                           | 約3.71ms                                         |

この時間は小規模probe内の観測であり、productionのcancel遅延保証や性能改善率ではない。
COMMIT、sealGeneration、会話状態更新器、TUI、HTTPは本probeに含めておらず、成立確認済みとはしない。
配置や方針を試行錯誤で選ぶprobeではなく、採用済みの通信方法が実行環境で使えるかを確かめた。
production source、実config、既存DB、既存Coreは変更していない。probe Workerは終了済み。

証拠は.tools/increment-170/plan-probes/transport.ts、transport_worker.ts、
transport-source.json、transport-compiled.jsonと隔離compiled executable。
公式henji:compileへの新Data Worker root組込み確認は実装後の工程に残る。

## 計画レビューと親判断

通常reviewは動作の成立、実経路のcoverage、契約と工程の整合を確認する。
批判的reviewは共通化の抜け、隠れた全体処理、controlの滞留、二portの順序と採用・購読の境界を反証し、
問題があれば具体的な対案と推奨を出す。現行責務の保持・変更量・一般的hardeningを評価基準にしない。
対象は本計画と関係sourceのみ。reviewerはread-only、実provider・full gateなし、各20分上限、
10分間新しい根拠／中間結論がなければ中断する。再reviewは変更と既存findingの確認に限定し一回15分以内。
両初回reviewはread-onlyで完了し、配置と共通更新の方針を支持した。次の三点を親が採用して計画へ反映した。

| ID     | findingとsourceから利用者影響への経路                                                                                                                                                                                                                            | 採用した修正                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1／P1 | Agentのcommit waiterはabortでfalseとなり、runtimeがturn_failedを送る。Data COMMIT非同期化で、許可済みcanonical保存と失敗通知が競合し、確定結果が食い違う。worker_bootstrap.ts:260、worker_runtime.ts:1121、sqlite_history_v7_prototype.ts:411                    | provider/toolのabortとcommit判断待ちを分離し、Core/Dataの明示結果で待機を完了。COMMIT後の遅着はpost-commit観測とし二重settlementを作らない。工程3へworker_runtimeを追加                                           |
| N2／P2 | Coreのtask.submitはadmit後までexecution IDを返さず、TUIはreceipt待ち中のcancelを拒む。Core内部予約だけでは人間が準備中の停止を操作できない。core_service.ts:1403、task_service.ts:71、remote_session.ts:1364                                                     | await前にruntime.reservationとpending.activeTaskを公開。保存済みrowと区別し、TUIは同commandIdの予約をreceipt待ち中でも取消。遅着receiptでrunningに戻さない                                                        |
| C1／P1 | 最終proposalがない強制停止で別portのCore settleがAgent dataを追い越すと、本文buffer欠落またはterminal後append拒否を招く。現行flush-before-terminateを二portで成立させる契約が不足。coordinator.ts:275、prototype.ts:413。childも保存前ackを送る。children.ts:695 | sealGenerationで受信済みprefix cut→flush→terminal COMMIT→cut ack→Data port終了／次世代admission。正常終了は最終sequenceまで保存。childもCOMMIT後にack／親への完了を出し、parent許可は保存とphysical cleanupを確認 |

親は上記のsource経路を確認し、明示したproduct動作を成立させる修正として採用した。
通常reviewのcheckpoint proposal候補は、確認したproduction runtimeに送信側呼出しがなく、
自動compactionの実利用経路として根拠を得られなかったため必須findingにしない。
保存済みcheckpointをmodel contextへ戻す動作はcanonical model dataの対象に含める。

批判的reviewの具体的対案は、追加Workerや配置変更ではなく、共通seal操作へ終了境界を集約すること。
通常reviewの具体的対案は、commit判断待ちの分離と公開予約による停止対象の確立である。
いずれも共通更新器とcontrol/data分離を維持し、終了・準備時の欠落した規則だけを補う案として推奨された。
修正後の再reviewを各一回、三findingの解消と変更箇所に限定して実施した。
通常reviewerはN1／N2の解消と追加追記不要、批判的reviewerはC1の解消と追加の必須修正なしと回答した。
親も修正された契約・工程・受入の整合を確認し、計画作成を完了と判断した。
これは計画が実装へ進める状態という判断であり、実装開始・配置・完了の承認を代替しない。

未確認は未実装の実Worker／compiled表示・操作・実provider／性能受入であり、レビュー成功で確認済みとしない。

## スライス境界のレビューと親判断

2026-10-02。通常・批判的reviewを各10分以内のread-onlyで実施した。
対象はslice境界と依存順だけで、実装差分の確認ではない。
通常reviewのS1保存adapter不足を採用し、同期append結果／terminal CommitDeltaをS1へ含めた。
これにより逐次対復元の確認を手組み入力や再読取で代用しない。
両reviewのS2保持stateと旧writerの不整合を採用し、S2は毎explicit readのread-only Workerとした。
批判的reviewのS3 writer撤去と旧Core producer依存を採用し、API
producer・cut/watch・旧refresh撤去をS3へ移した。 TUI
consumerはS4で切り替える。中間段階のための全文cacheや旧形式adapterは作らない。
いずれも承認済み動作と配置を変えず、各入口で旧経路を外せるよう工程の境界を修正した。

## S1 実会話確認で得た修正

隔離したe71f582aのDBコピーをproduction CLIで読んだ。canonical表示とdetail
exportは修正前とbyte一致した。 session viewは11 executions／39
thinking項目を保持したが、tool行が51から49へ減った。
最終executionのmodel_result（semantic:543／event460）は3 callsを保存していたが、開始tool_call
（semantic:544／event461）は先頭一件だけだった。adapterがmodel_result.callsを落としたため未開始二件が消えた。
実利用で確認した表示欠落として修正対象に採用した。

批判的reviewへこの一点の具体的対案を依頼した。保存model_resultのoccurrenceId＋call位置をentity
identityとし、 開始時のtool_call semantic IDを属性へ付ける単一entity案を親が採用した。
宣言対応indexと開始済みindexを区別し、text未定義のtool-only resultでも宣言を処理する。 origin
IDを実semantic IDへ逆decodeしない。元設計の「toolは保存call occurrenceID」を、
未開始callの保存originも扱える規則へ具体化した。旧完成messagesから補充する経路は追加しない。
S1の全差分reviewと再実行確認はこの修正後に行う。

逐次対replayのfocused確認でも二つの保存契約差を検出した。
途中本文からmodel_resultへ確定した場合、liveは最初の本文位置を保つが、保存resultにはfirstEventOrdinalがなく、
replayは最後のordinalを位置にしていた。model_result保存時に対応本文keyのfirstEventOrdinalを付け、
同batchの更新または対応keyの一点lookupで取得する修正を採用した。全履歴走査は追加しない。
steer_sentはappend結果には含まれるがsemantic occurrenceとして保存されず、初回raw
replayから欠落した。
同じpending操作状態を復元するため、sent／failedの制御結果もcontrol_decisionとして保存する修正を採用した。
新規保存factの契約修正であり、既存DBのmigrationや後付け補充は行わない。

## S1 検証とreviewの現在地

2026-10-02。S1 sourceを安定させ、通常・批判的な全差分reviewを各20分上限で開始した。
review中はS1ファイルを凍結する。親の採否判断と必要な修正・限定再reviewが済むまでS2を開始しない。

親は隔離実DBコピーのproduction source CLIで最終session viewを確認した。 11 executions／39
thinking項目／51 tool行を保持し、未開始二callの欠落と開始後の二重表示はない。
canonical表示139,046bytesとdetail export17,255,230bytesは修正前とbyte一致。
実DBへの書込みや実providerの追加requestは0回。証拠は.tools/increment-170/s1-cli/に保存した。

実装者の実store focused比較は、途中本文・thinking・tool宣言/開始/進行/結果・steering・取消terminal・
初回replay・同stateへの次execution追加とcanonical COMMITまで通った。 batch1 progress→batch2
progress→model_resultでもpositionとIDの一致を確認した。 親がproduction
storeへの変更に対応する既存134の最新本文/取消/terminal動作と、
既存167の取消・recall・後続commit・SSE・Core再起動時の履歴動作も確認し、いずれも通った。
167の初回commandは必要env権限不足で起動に失敗し、隔離環境を維持したまま正しいenv権限で再実行した。
full gateは未実行。TUIの新entity consumerやData
Workerの成立確認は後続sliceの対象であり、S1で完了とはしない。

### S1 全差分reviewと親判断

通常・批判的reviewはsourceとfocused test内容の確認を終え、同じP2を一件指摘した。
reconcileExecutionはterminal helperが作るdeltaを捨て、保存portもvoidで返すため、
active途中本文を持つ保持engineへ確定本文・semantic ID・terminal
ID・outcomeを再読取なしで反映できない。 現S1 CLIは保存後raw
replayで表示できるが、共通保存結果の契約からこの経路が漏れる。
正本のcanonical／noncanonical／reconcile全経路の要件とsource経路を根拠に親が採用した。

修正は戻り値をHistoryCommitDelta | undefinedとし、active時はhelper結果をCOMMIT成功後に返すこと。
既にsettledなら保存せずundefined、失敗時は成功結果を返さない。 実storeのpartial append→reconcile
delta適用→raw replayの一致をfocused確認へ加える。 既存150 recovery
testのwrapperも戻り値を伝えるよう局所調整する。
両reviewerは追加findingなしと回答した。修正後は変更と既存findingに限る再reviewを各一回15分以内で行う。

確認済みは本文ID/初回位置、thinking最新値、宣言toolから開始への継続、独立semantic ID、
初回/append/terminalの共通adapter、通常applyに過去query/全sort/全snapshot diffがないこと、
production session CLIのraw入口とcanonical/detailの非変更である。
レビュー成功をS2以降のData/Agent/TUI/性能確認の代替にしない。

## S1 保存例を仕様としない生成元の監査

利用者は「限られた実保存の履歴を正本としてテストすると抜けが出る」ことを指摘した。
実DBは再現・実会話確認の資料であり、必要動作の正本やtestの期待値の生成元にはしない。
逐次適用と保存再生の一致だけでは、両経路が同じ誤りを持つ場合にcorrectnessを判定できない。
合意した必要動作から期待するentity・帰属・順序・確定を定め、productionの生成元から保存・更新まで
対応を確認し、その動作を直接assertする。DB例はその後のregression確認として使う。

| 必要動作                         | productionの生成元                                                   | 保存・共通更新への対応                                                      | 確認する期待動作                                                                |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 本文の途中更新から確定           | loop/providerのassistant_progress・model_result                      | 最新本文stateとfirstEventOrdinal、model_result semantic → request本文entity | 同じ本文IDと初回位置を保ち、新値と確定状態になる                                |
| thinkingの更新                   | loopのassistant_thinking → Worker runtime_event                      | assistant_message semantic → request/kind entity                            | 同keyの最新値になり、過去snapshotを表示項目として増やさない                     |
| 宣言されたtoolの開始・進行・結果 | loopのmodel_result.callsと順次tool execute、ProviderEvidenceRecorder | model_result/tool semantic → 宣言originと開始IDを持つ一entity               | 未開始宣言も表示し、開始後の別行を作らず、補助requestを挟んでも所属と結果を保つ |
| steeringの要求と実適用           | Core制御結果とloopのsteering_message                                 | control_decisionは操作状態、user_message semanticは会話行                   | 実適用した指示を一つのuser行にする                                              |
| 終了と次の指示                   | storeのcanonical/noncanonical/reconcile COMMITと次admission          | CommitDelta → 同engine、次execution factsを継続入力                         | COMMIT後に確定本文・outcomeを反映し、開き直しと継続入力で同じ意味になる         |

通常・批判的reviewへ生成元契約の監査を各15分以内で依頼した。両者は本文・thinking・tool・steeringの
production生成経路を確認し、以下のP1を確認した。既存reconcile P2は解消済みと通常reviewが確認した。
子実行・Data Worker・新API/TUI consumerは後続sliceの対象であり、この監査で確認済みとはしない。

### 発見したP1と親の採否

loopはmodel_resultで二callを宣言した後、順に実行する。先頭のweb_searchが補助HTTP
requestを記録すると、
共有recorderのactiveRequestが置換される。その後のtool結果と次tool開始が補助request番号を持つ。
normalizerは宣言request＋callIdで開始を探すため、次toolを新entityにし、元の未開始宣言も残す。
先頭toolの結果はcallIdで元entityを選べるが、requestKeyを補助request側へ移動する。
sourceはcore/loop.ts、tools/web_search.ts、provider/provider_evidence.ts、conversation/normalizer.ts。
production Workerはprovider observationをdurable factとして使うため、人間の表示へ届く経路である。

親は実ProviderEvidenceRecorder → 実store append →
共通engineの小規模probeで、二callが三entitiesになり、
先頭のrequest番号も変わることを確認した。同時にliveEqualsReplay=trueとなり、同値確認だけでは検出できない。
実providerは0回、実DBは変更していない。証拠は.tools/increment-170/s1-audit/producer-audit.tsと
producer-result.json。これはsource由来の欠陥の確認であり、配置を試行錯誤で選ぶprobeではない。

対案は、producerが宣言元を明示的に保持する案と、engineがexecution/lane/step/callIdから宣言を推論する案。
両reviewerの推奨を採用し、因果関係が確定するmodel_result時にattributionを固定してloopから全toolイベントへ
引き継ぐ。call位置も保持し、共通engineは宣言entityを更新する。補助HTTP
requestの最新値を帰属に使わない。
web_search専用分岐、最新requestの巻戻し、既存entityのrequestKeyだけ保持する対症修正は採用しない。

この契約は承認済みのtool関連付けを成立させるS1依存として、provider
recorderとloopを修正範囲へ含める。
実loop・recorder・storeを通し、「二entities・両方が同じ宣言元・次toolの未開始重複なし・先頭のprogress/result保持」
を直接確認してから、live/raw
replay比較も行う。修正・focused確認・限定再review・親判断までS1完了を保留する。

利用者の外部定義toolに関する確認を受け、親はworker_bootstrapの外部module loadとToolComponent生成、
registriesの宣言materialize、Registry.dispatch、loopの共通tool記録までを確認した。
既存の外部定義も同Registryとloopへ入るため、修正は内蔵tool名を判断しない共通経路に置く。
focused確認でも任意のcustom名を持つ外部ToolComponentから実Registryを作る。
moduleの読込み・binding・tool返却契約へ新しい制限を加える変更ではない。 親は既存Increment
70の外部tool追加・bound revision解決のfocused確認を実行し、通った。
これは外部Definitionの既存入口の確認であり、修正後のtool
progress/result関連付けを確認済みとはしない。

### S1 origin修正・検証・限定再reviewの結果

producerはmodel_result記録時のimmutable
attributionを返し、loopがcall位置とともに全tool開始・進行・結果へ
渡す。tool記録時に最新activeRequestから帰属を選ばない。physical
requestがないresultは番号なしで保持する。
共通engineは宣言originを保持し、明示位置と、保存済みcallId/実行/lane/stepの関連indexで同entityを更新する。
補助requestで保存番号がずれた事実も、所属・位置・引数・結果を失わず処理する。完了時のindex終了はoriginから行う。
provider名やtool名による分岐、旧完成表示補充、新しいversion fallbackは追加していない。

実loop・recorder・storeのfocused確認は、外部ToolComponentの任意名二toolを実Registryへmaterializeして実行した。
最初のphysical
requestから二callを宣言し、先頭tool内の補助requestを挟んでも二entities・宣言元・元位置・
進行・結果を保持した。続いてphysical ordinalなしのmodel
resultから外部toolを実行し、補助番号を後付けしない ことも確認した。その後にlive/raw
replayを比較した。保存側のfocused確認では、番号がずれたraw toolと、 宣言がないgeneric
toolの関連・引数・結果の保持も直接確認した。

Increment 170のfocused二test、既存38の七test、変更source/testsのtype check・scoped lint・format・
diff checkは通った。実装者の最初のposition
assertは保存eventの位置を定数で仮定しており、宣言位置を保持する
必要動作に沿って確認する形へ修正した。productionの位置をtest定数へ合わせる変更はしていない。

親は隔離DBコピーのmetadataで、e71f582aのexecution 751d3a43-5ebe-4534-82a0-ade2e9cc9cafに
開始request1→結果request2の実保存事実を確認した。修正後は同toolの宣言元request1と結果本文を保持し、
本文のdigestも保存factと一致した。全会話は11 executions／39 thinking／51
tools、うち48件が結果を保持した。 production
CLIのsession出力はorigin修正前とbyte一致、canonicalとdetailはS1前とbyte一致した。
証拠は.tools/increment-170/s1-audit/saved-attribution-drifts.json、saved-tool-result.jsonと
.tools/increment-170/s1-cli/のorigin-fixed成果物。親の確認helperは初回のstateRoot段階と抽出scopeが誤っており、
正しい隔離rootと対象call IDを指定して再実行した。これによるproduction変更はない。

通常・批判的な限定再reviewを各15分以内で実施し、P1/P2の解消と追加findingなしを確認した。
通常reviewはsourceとtestの必要動作を確認。批判的reviewは対象focused二testを実行し、加えて番号ずれ後の
二callが二entities・元の所属/位置・両結果を保ち、全declared/open indexを終了することを直接確認した。
保存再生との一致だけをcorrectnessの判定にしていない。 親も源流契約と隔離production
CLIの証拠を確認し、S1の完了条件を満たしたと判断した。 実provider追加requestとfull
gateは0回。Data/Agent/control/API/TUIと性能受入は後続sliceの対象である。

### S2実装接続と、DB未作成の会話の扱い（実装中）

Coreのhistory/context explicit readをencoded
replyへ切替え、HTTPはDataが生成したbytesをResponseへ渡す。 execution explicit readはDataのsmall
public metadataを受け、CoreのsubmittedByCommandIdとprocessSettlementを 融合する。Data
bootstrapをofficial build rootへ追加した。Coreの初期Session open失敗と通常closeでもDataを
閉じる。旧projection・writer・配信はS3まで残り、この時点でcancel改善を完了としない。

生成元のsource確認で、保存しないnone会話にはcanonical Session
rowがなく、checkpointはMemoryWorkerHandleの 状態であることを確認した。production noneのexecution
evidenceはSQLiteに保存されるためexecutionReadはDataへ 移せるが、contextの現正本はactive
snapshotである。S2だけはnone modeのcontextをそのsnapshotからencodeし、 S3でlive
stateをDataへ移すときにこの分岐を廃止する。DB読取失敗時のfallbackではない。

保存するnew会話でもallocate直後・初回admission前にはcanonical rowが未作成である。CoreはcontextReadへ
activeSessionという小さいdescriptorを渡し、Dataは有効なactive会話として保存checkpoint/latest
requestを
読める範囲で読む。DB未作成なら空contextまたはpendingRecallのみを返せる。inactiveのsession_not_foundは維持する。
新しいlive cacheや旧writerからのbridgeは追加しない。

この二つは限定された保存履歴を再生するtestからは見つからず、現在の利用者操作→handle割当→admission→保存先を
追って確認した。既存143の初回task前context readと147のnone context readへ直接assertを追加した。
検証・通常/批判的review・S2完了判断はこの記録時点では未実施である。

利用者は処理の重複も内容を確認しながら進めるよう指示した。親は各処理の入力、参照先、更新する状態、
呼出timingを追う。S2実装中にlatest requestの全semantic走査をundefined検査と値生成で二回呼ぶ箇所を
sourceから発見し、一回の結果を使うよう修正した。Data生成payloadをCore/HTTPで再decode/encodeしないことも
review対象にする。receive時とsave通知後の414再構築経路はS3で置換・不要処理除去の対象であり、S2完了の
主張へ混ぜない。

### S2候補のfocused確認と実DBコピーread（review中）

Data client/bootstrap/serviceとCore explicit read/HTTP/build
rootの接続を凍結し、通常・批判的reviewを各30分以内で
依頼した。対象は新しいread経路とstartup/close、public wire、mode別context、重複処理の内容である。
S3のwriter/live配信/cancel、S4のTUI、S5の最終受入をS2へ混ぜない。

Data executionReadが既存readExecutionを呼ぶと、settled
rowでは全transcriptまで復元していた。親は既存の private metadata一点readをpublic
readExecutionMetadataとして公開し、Dataから再利用した。SQLの全execution
走査や第二の復元経路を追加せず、Dataはpublic metadataだけを返す。既存内部callerも同methodを使う。

実装者の実Worker・SQLite
focused確認1件はDB未作成の空history、別writer作成後の次read、session/detail、 checkpoint/latest
request/pendingRecallとexecution requestCountを直接assertした。Data bootstrap/focused testの
check・lint・format・diffも通った。

親はCore/HTTP/build/149 fixtureのtype
check、親担当差分のlint/format/diffを確認した。既存140/143/147の production localhost-provider
HTTP確認3件、149のschema/init/DB未作成3件、150の既存HTTP Coreが別process作成の
DBを発見する経路とshared/recovery4件、78のbuild graph3件が通った。full gateは未実行。

隔離実DBコピーのproduction Core+HTTP+実Data Workerでdetail 17,255,230bytes（encoded response
17,888,170bytes）を 273.6msで読み、その間Core
readが23件完了、最大応答4.80msだった。これはS2のexplicit read中のmain応答を
確認する証拠であり、実行中streaming/cancelの改善値ではない。session 152,696bytes、canonical
139,046bytes、detailの 三出力はS1 production CLI baselineとbyte一致。context latest
requestとexecution metadataもreadbackした。 追加の実provider
requestは0回、元DBへ書込んでいない。証拠は.tools/increment-170/s2-http/probe.tsとresult.json。

親の初回type checkはclient input Omit unionの型errorで止まり、distributive
Omitへ修正後に通った。HTTPの初回は
親commandのallow-sys=uid不足でcredential解決できず、通常productionと同じuid許可を付けて通った。
helper初回はinitialSession:noneを「activeなし」と誤解したassertで止まり、initialSession指定なしの正規noactive
Core経路へhelperを修正した。product制限やfallbackでtestを通す変更はない。

候補freeze
hashは.tools/increment-170/s2-review/source-hashes.json。reviewのfinding採否・必要修正・限定再reviewと
親のS2完了判断は、この記録時点では未実施である。

### S2 reviewと親の完了判断・停止位置

通常・批判的reviewは変更前候補に必須correctness
findingなしと判断した。Coreでの大payload再parse/encode/cloneが なく、metadataのpublic
fieldとmode別context、Worker起動/終了、build includeが成立することを確認した。
両者はrequestCountの取得時に同じexecution metadata行を再読取し、件数だけのため全semantic
JSONをJavaScriptで parseする具体的重複を確認し、専用SQL COUNTを対案として推奨した。

親はS2 explicit metadata
readの実装選択として、readExecutionRequestCount(id)を追加した。保存producerと同じ
execution_id、kind=model_request、payload.event.kind=provider_request_startを条件に件数だけを返す。Dataは
metadataを一回読んで存在/errorを確定し、COUNTの数を既存public
mapperへ渡す。旧helper、全semantic列挙、 JavaScript側のJSON
parseと同metadata二回目lookupを除去した。新cacheや保存stateは増やしていない。
SQLで件数を数え、JSON条件を評価する仕事は残る。

この二file差分だけを各15分以内の限定再review一回へ渡し、両者とも追加findingなし、保存契約/COUNT対象の一致、
404/errorとwire意味保持、重複除去を確認した。変更後freeze hashも一致した。親は実Worker/SQLite
focused1件を type check込みで再実行し、二file lint/format/diffと実DBコピーの旧中断execution
requestCount=1を確認した。
批判的reviewerもfocused1件を独立再実行して通った。証拠は.tools/increment-170/s2-review/count-source-hashes.jsonと
.tools/increment-170/s2-http/count-read.ts。

親はS2の範囲と受入を満たしたと判断し、S2を完了とする。414回につながったlive
receive/save後の全会話再構築、 writer/state所有、キュー・追指示・キャンセル経路はS3、TUI
consumerはS4、compiled/実provider最終受入はS5である。
現在のキュー継続とcancel後recallのHTTP確認を、変更後のS3/S4の保証として扱わない。

利用者がtoken利用枠のため「キリのいいところで停止」を指示した。S2完了を区切りとして、S3へ着手せず一時停止する。
再開時はこの計画のS3から進める。local変更は保持し、常用配置・commit/push・公開・実data削除・full
gate・ 追加実provider requestは未実施。構想/architecture/roadmapの正本は変更していない。

## S3実装過程の確認記録（2026-10-03）

以下はS3再開時点の途中記録であり、最終結果は本書末尾を参照する。利用者の「作業を再開します」でS3のlocal実装を再開した。この時点ではS3の完了判定をまだ行っていない。
Data writer、Agent直結、Core control、公開APIの一括置換を進めており、S4・S5は未完了である。

利用者は続けて「寝るから
インクリメント可能な限り進めて」と指示し、検証に必要な最低限の実provider利用も
承認した。S5の計画済み自然完了1回・途中cancel1回を基本に実施し、実施回数と保存先を結果に記録する。
常用配置・commit/push・公開の承認とは扱わない。

- task.submitとキュー継続はHost admissionのawait前にexecution IDとcommand
  IDを予約し、preparingを公開する。 Lazy
  Workerの起動待ちにもcancelを保持する。実HTTP・Worker・SQLiteで、起動待ち中の予約cancel、
  重複cancel、遅着receiptの同identity、turn未送信、noncanonical取消保存、次taskの送信を確認した。
- Workerのcommit判断待ちはprovider/toolのAbortSignalから分離した。実provider-free
  Workerでproposal後の cancelが判断待ちを終わらせず、accepted/rejected
  ackに応じて一回だけ終わることを確認した。 現行runtimeではproposal前にcancel
  ownerが通常終了するため、この確認を旧product bugの再現とは扱わない。
- DataのConversationWriterは実storeのCOMMIT結果を共通engineへ一度適用し、Sessionのcutとwatchを保持する。
  batch通知、任意外部toolのorigin、途中/確定identity、canonical/noncanonical後の継続を実SQLiteで確認した。
  通常reviewで見つかったadmission await中のwatch stateの分裂は、共有stateのawait前登録で解消した。
  re-reviewでは当該findingの解消と追加findingなしを確認した。
- キューcancel後の遅着admission receiptでは、discarded状態を戻さずexecution
  IDを結果照合用に保持する。
  reviewで採用した具体的なqueue結果の欠落を修正し、focused確認と一回のre-reviewを実施した。
- ExecutionDataJournalはWorker control sequenceとは独立したData
  sequenceを使い、最終番号まで受信・保存する。
  強制sealは受信済み連続prefixをflushし、後続入力をappendしない。実MessagePortとproduction
  ProviderEvidenceRecorderで、batch一回、最新本文、prefix保存、遅着入力除外を確認した。
  途中取消の本文はproviderの未完了状態を保ち、terminal保存のsemantic
  IDを付けてもcomplete=trueへ変更しない。
- AgentDataClientは実Workerへ移譲したMessagePortで全文context/ready/checkpoint/proposal/failureをDataへ送り、
  Core用の小さいproposal/failure markerを生成する。production
  bootstrapと実Workerで、start/turnごとの Data basisとrecall、contextを除いたCore
  ready、Data直送、cancel後の明示accepted/rejected ackを確認した。 CoordinatorとData
  serviceを含むproduction接続全体は後続のfocused確認で扱う。
- schemaVersion 2の公開会話はid-keyed entitiesとorderを使う。Dataのencoded
  payloadへCoreの小さいenvelopeを
  付け、clientは変更entityだけを適用する。実storeの保存batchからcodec/reducerへ通し、本文更新がentity/order
  storeと無関係のuser entityを置換しないこと、Data
  snapshotのreadbackと一致することをfocused確認した。
  session.openのreceiptはsessionIdを返し、会話snapshotは明示readで取得する。旧全文snapshotのcommand保管を外す。
  既存outcomeのstopReasonと短いdiagnosticもentityへ引き継ぎ、169のrecall案内に使える形を保持する。
  実SQLiteのterminal outcome、encoded差分、codec/reducerのreadbackまで確認した。
- model
  SessionのauthorityをData側へ移し、Coreのqueryは操作状態、位置、選択、短いexecution/context情報に絞る。
  Data watchの遅延通知がsnapshotを追い越すcut問題をsourceで確認し、serviceの配信境界を調整した。
  snapshot/watch登録前に保留通知を配信し、admission/terminalのdescriptor更新後にbatchを公開する。
  close→保存view→reopenでもservice-lifetimeのcutを維持する。
- 実HTTP/SSEの二つの購読、本文更新中の再接続、terminal、次taskで、各購読のcutが連続し、
  最終conversationがHTTP readbackと一致した。143のrecall/checkpoint/保存会話再開、147のnone会話の
  キュー・次task・title更新も通過した。通常更新のCoreはencoded bytesと小さいcontrolだけを扱う。
- 実Data proposalだけをrelayで保留し、Coreのprepare待ち中にAgentへcancelが届くことを確認した。
  cancel→marker、marker→cancelの両順序で受信済み本文prefixのnoncanonical保存と次Worker世代への継続が
  通った。marker受信時にgraceを止める実装は通常reviewで採用して修正した。
- production Workerのprocess確認で、background保持→Session close、非協調toolの強制停止→世代置換、
  child collect後の物理cleanup、後続call取消時の先行background保持が通った。検証commandの
  NODE_V8_COVERAGE読取権限不足による初回失敗は、既存taskと同じ権限で解消した。 detached
  childの相関IDへ保存Session用UUID codecを適用していた問題も、canonical recordだけを
  同codecの対象とする修正で解消し、138のchild進行/HTTP・解析failure/取消prefixが通った。
- headless実Workerを通常入口から実行し、noneのterminal保存、全文transcriptを含まないoutcome、
  opt-inのAgent event配信、Data終了後の実SQLite readbackを確認した。
- S3全体の通常reviewはP2を4件報告した。marker後のgrace停止、childの即時停止とmarker後grace、
  rejected ACK後のAgent idle待機不足、cancel/ACK/post-COMMIT/cleanupの短いData保存接続の欠落である。
  親は明示要件とsource-to-impactを確認して4件を採用した。短controlのpostterminal保存と限定
  re-reviewを実施中であり、ここではS3を完了としない。
- 独立した批判的reviewは追加P2を3件報告し、親は実probeと要件・source-to-impactを確認して採用した。
  noncanonical terminalのartifact生成欠落、preparing中shutdownで準備完了後にturnを開始する順序、
  shared Dataを使うstarted Session closeで旧writer lockを解放しないlifetimeである。
  前者はData担当が修正中。shutdownは入口で直接予約取消を先行し、実Core/Workerのstart保留→close→解放で
  turnゼロ、同予約identityのcancelled/noncanonical terminalを確認した。 個別Session closeはData
  owner/port/lockの解放をjoinし、実started Sessionで別writerによる旧会話のopen、
  Dataの公開会話・cut保持、同Dataへの再openを確認した。closeの再呼出しは同じ完了promiseへ合流する。
  追加P1以上は報告されていない。通常更新からCoreの過去query・全projection・全diffが外れていることも
  sourceで確認された。各findingの修正後の限定re-reviewは未実施である。

- 140/141/142の実HTTP確認を新receipt/entity契約へ移行し、read-only履歴、task重複照合、
  本文・thinking・toolの順序、切断・再接続、取消、steering、queue継続、Session切替を確認した。
  145の実HTTP shutdownでは非協調Bashと子processの停止、SSE終了、起動中Sessionのclose合流が通った。
- 基盤testは実Data portとSQLiteへ移行した。production settlement faultでcanonical revisionと
  transcriptが進まないこと、未settled実行がrecall選択対象にならないことを確認した。
  transaction前のderived artifact単体は残るが、実行metadataのartifact linkはrollbackされる現契約を
  維持した。別の実Worker Host確認ではData commit errorをfalse/history_io_failureで返し、成功採用せず
  canonical turnゼロを保つことを確認した。
- 実recall確認でData RPCがambiguousを一般failureへ変換する問題と、正しいv7 artifactがJSON key順で
  無効とされる問題を確認して修正した。38のactual SQLite/Workerでambiguous理由、最新/明示選択、
  one-shotとclear、正確なrecall attribution、通常generation contextへの非混入が通った。
- child進行表示に全文AgentEventのglobal購読が残り、親の本文やtool結果までCoreへ送る経路を確認した。
  通常child表示はrequest_startedとchild_progressの小controlへ切り替え、phase・step・request番号と
  tool名/callId/state/outcomeを維持する。138の実Worker進行とcontrol本文/引数/result
  body除外が通った。
  headlessで明示eventSinkを要求した場合の全文配信は既存opt-inとして保持し、session単位APIは増やしていない。
- OpenRouter→OpenAI→OpenRouterの実Worker確認では、SessionのturnModelsは正しいがartifact manifestが
  初回modelのままになる問題を確認した。AgentのreadyをData更新ACKまで待つ経路にし、model選択後も
  最新manifestをDataへ直接送り、ACK後にCoreへ選択結果を返す。15の実保存/再開確認は全件通過した。
- API-key catalog/credential/selectionの144は対象providerを限定して通過した。ChatGPT
  account未登録時に
  provider一覧全体が失敗する既存の計画外問題を発見し、通常利用メモB6へ未採用として記録した。
  170で修正していない。39のcleanup failure fixtureはproduction同様のturn_settledを送り、終了待ちの
  timeoutによる世代置換を避ける形へ移行し、診断保存と永久unavailableを確認した。

通常reviewの限定re-reviewでN1〜N3とroot経路のN4の解消を確認した。批判的reviewの限定re-reviewも
C1〜C3の解消と残存findingなしを確認した。rootの短controlは新tableを作らず、既存v7
derived_documentsのexecution_controlへ保存する。semantic terminalやcanonical採用は再openせず、
ACK・終了通知・物理cleanupの観測を後から読み返せる。cancel_receivedはAgentの実受信時刻を保持し、
保存時刻に置き換えない。failure/取消prefixのartifactとcontrol、headless
accepted_sentは実SQLiteで確認した。
親の集約focused検証は55件通過し、別の拒否ACK後idle保留、shutdown、shared Data個別close、 timestamp
readbackも確認した。拒否ACKの追加testはprocess fixtureの通常完了taskを誤指定していたため、
親の再実行で修正し、Data terminal済みでも終了通知の保留中はbusy、解放後は次task成功を確認した。

child自身のcancel/ACK/cleanupの短control保存は通常reviewのN4範囲へ含め、同じData経路への接続を追加中である。
この接続と最小readback確認をS3の残作業とする。旧非UI testの入力契約も新Data経路へ移行中であり、
旧fixtureの全本文snapshotや同期history注入をproductionへ戻さない。

旧child確認を実Data経路へ移す過程で、開始直後cancelがcompletedになることと、Data admissionを保留した
cleanupが先にcancelledを返し、その後active/unknown rowを残すことを親が実証した。前者はAgentの
generationContext待ち中にcancelActiveTurnがidleとなり、後続runTurnへ取消を引き継がない経路である。
後者はchildのadmission promiseがData Session openだけを指し、executionAdmitの完了をjoinしていない
経路である。170の準備中取消・child terminal COMMIT/physical
cleanup要件に対する具体的regressionとして 採用し、修正を実施中である。また110で明示されたstartup
failureのinterrupted保存が新経路で欠落する 意味差を確認した。未admitted startup
attemptを明示して同じData admission/sealへ保存する最小拡張を採用し、 成功経路のready/model
manifest境界を維持する。未実行step/requestやWorker generation実行証拠は作らない。

確定したS3の公開契約を入力として、S4のkeyed store/dirty mapper/renderer/control
consumer実装へ着手した。 S3のchild保存追加はこの公開契約を変えない。S3・S4の完了判断は分けて残す。
cancel応答の性能改善、S3の完了、production TUIの成立はまだ報告しない。 追加の実provider
request、full gate、常用配置、commit/push、公開、実data削除は行っていない。

### S3統合確認での旧contractとの差分

旧110のparent result維持testは、実Dataのchild terminal COMMIT失敗をphysical
cleanupの補助artifact失敗と同一に扱っていた。170の承認済みparent採用条件はchild terminal COMMIT
ackとphysical cleanupの両方なので、child COMMIT前の失敗ではparent
proposalを採用しない。旧期待をこの条件へ移行する。parent
COMMIT後に補助fact保存が失敗しても採用を取り消さない条件は維持する。

旧92のauxiliary gap stage snapshotは、Core
writer撤去後に読み出しと保存経路が欠落していた。実Data/SQLiteの既存product
proofで確認したため、Coreへ全文観測を戻さずData所有で短stage factを保存する復旧案を調査中。

### S4実経路の中間確認（2026-10-03）

keyed store/dirty
mapperへ切替後、focused16件と実HTTP/SSEの167履歴・再接続2件が通った。rootのS3統合確認は新child/startup/preparing/control
proofを含め77件通過。これらをslice全体の完了判定にはまだ使わず、診断snapshot復旧とS4通常・批判的reviewを継続している。

隔離XDG、source production CLI、localhost
providerのtmux確認を実施した。`.tools/increment-170/s4-tmux-5`に起動画面、本文/thinking/tool、二接続、編集中更新、scroll、stream中help、cancel済prefix、再接続、followup完了、Session
pickerとnew Sessionの画面・短い結果を保存した。localhost物理request3回、実provider0回。read
tool後のpartial本文とthinkingを保持し、cancel後の次指示は一回のcanonical
commitで重複assistantなし。help中もworkingを維持し、new操作でSession IDが変化した。

初回probeはserveにinitial Session指定がなくTUIへnull IDを渡したため起動不能。次の試行ではslash
pickerの選択とcommand実行を一回のEnterで済ませ、help/newが未実行だった。成功試行では二段階操作と実activeSession
ID変化を確認した。これらはprobe手順の訂正でありproduct
bugとは判定していない。初回証拠を削除せず保存している。

### S3診断復旧とS4準備中取消の修正

既存92のstage snapshotをData所有へ接続した。SharedArrayBufferは固定stage
code/epoch/ordinalだけで、Data journalがauxiliary gap、cancel、escalation、terminalの短snapshotをv7
control factへ保存する。三cursorはDataに直通するsemantic observationのWorker
sequence高水位であり、sealに使うData-port連続sequenceとは別に追跡する。Coreのcompact
markerを合成する全文経路は増やさない。実SQLiteでData seq1/Worker
seq7とexpected8を区別したreadback、provider startによるtimer解除、sealed後のcontrol
readbackを確認し、92の7件とData関連3件が通った。診断の保存失敗はoutcome/adoptionを変更しない。rootはreceived
watermarkをsemantic解析前に進め、受信とbuffer validationの段階も区別した。

S4通常reviewは対象経路に具体findingなし。独立批判的reviewと並行したrootの実tmuxでは、receipt
pendingを一律に拒否する旧cancelActiveExecution guardが残り、reservation IDが取得できてもHTTP
cancelが送られないregressionを発見した。guardを『まだreservation
IDを得られない場合』に限定した。`.tools/increment-170/s4-preparing-tmux-5`でproduction
TUI、実Core/Worker/Dataを使い、Worker
startだけを隔離probeで保留して確認した。EscでHTTPcancelがrequestedとして返ることを保留解除前に記録し、解除後cancelled/noncanonical、canonical
turn0、turn command0、idleを確認した。provider呼出し0回。

このprobeの初回2回は公開phaseをstopping/cancellingと仮定して待ち続けた手順誤りだった。receipt前は公開reservationのpreparingを維持するため、成功手順では短いHTTPcancel
receiptを実証とした。旧拒否guardの発見以降の修正前証拠と修正後証拠は保持している。

## S3・S4の最終確認とS5総合受入（2026-10-03）

S3はData-owned stage snapshot復旧、childのstartup/cancel/cleanup、preparing reservation、 commit
waiter、seal後の短control保存を含むfocused確認と通常・批判的reviewの採用指摘修正を終えた。
S4の通常reviewは必須findingなし。批判的reviewはnotice更新に残った全notice置換・全order再構築と、
pending steering判定の全履歴走査を指摘し、親は170の通常dirty更新要件に基づき採用した。
`RemoteSystemNotices`はdirty notice IDだけをupsert/removeし、同placementの本文更新ではrow
Mapだけを更新する。 steering適用判定はdirty
entityから維持する索引を使う。追加・削除・reanchorのみlocal spliceとsuffix index更新を行い、
旧ID列は実構造変更に限って作る。初回resetだけ全noticeを適用する。remote Sessionはnoticeの
`structureChanged`をUI stateへ渡す。追加focused proof3件と関連testsは通過し、一回15分以内の
限定re-reviewで両findingの解消を確認した。re-review担当の関連10件もpass。

旧`restored_log`、`renderRestored`、旧restored presentation types、使われなくなったAPI配列typesと
旧fixture converterを撤去した。benchmarkと既存TUI
testsはentity入力へ移行し、長履歴scroll、thinking順序、 tool
preview等の必要動作を保持した。`v0/`と`scripts/`に`beforeMessageIndex`、`restored_log`、
`renderRestored`、`diffSessionSnapshots`、`setConversationEntries`の残存はない。

### compiled経路

公式`henji:compile`にData
Workerを含めた候補buildは`ae85d30233dc6d47a887e4dbddf28e2e2621cef7863fcd2469f9980fc89a47bd`。
sourceは`27f154283631c3770f28d52159863498d8fa1174+dirty`、Deno 2.9.7、runtime digestは
`1de7866e3f539f9651fdd0c80b2611305e67e75ef727a96dbe15f822ee184fed`。
常用配置せず`.tools/increment-170/henji`で確認した。

- 隔離XDG・workspaceのproduction tmuxで、new Session、本文・thinking・read
  tool、editor保持、二接続、 busy中help、scroll、cancel、partial prefix再接続、次指示、Session
  picker、別のnew Sessionを確認した。 localhost Responses providerは3
  requests、実providerは0回。取消後の部分本文は未完了のまま残り、
  次指示は一つのassistant行としてcanonical turn1へ保存され、readyへ戻った。
  証拠は`.tools/increment-170/s5-compiled-tmux/`。
- standalone `run`の通常出力と`--stream`を同compiled binary・隔離configのlocalhost
  providerで確認し、 各1 request、両方exit0と最終marker表示を確認した。証拠は`s5-compiled-cli-2/`。
- 既存v7コピーのoffline `history --view session`をcompiled CLIで読み、152,696bytesを得た。 source
  CLIの同結果とbyte一致を確認した。証拠は`s5-compiled-existing-v7.md`。

最初のstandalone
probeでは親が隔離`default-selection.json`を3fieldだけで書き、必要なapi/authProfileを
欠いたため読取時に採用されず、既定`openrouter-chat / deepseek/deepseek-v4.1-flash`へダミーキーで 1
physical requestが送られ、HTTP401になった。正しい5fieldへ修正した後はlocalhostの2
requestsで成立した。
この誤送信を隠さず追加外部利用1回として数える。実credentialはこのprobeに使っていない。
証拠は`s5-compiled-cli/request-facts.json`。production
provider/default-selectionの仕様は変更していない。

### 最低限の実provider確認

利用者の2026-10-03の指示に基づき、`opencode-go-chat / mimo-v2.6-pro / auto`を自然完了1回・途中cancel1回、
計2 physical requestsで確認した。どちらも同じe71f582aの132MiB
v7コピー、337文字の同prompt、maxSteps1、 独立した隔離XDG/config/workspaceを使い、provider
responseはHTTP200だった。旧baselineへの追加実行はない。
実DB・実config・稼働Coreを変更していない。上の誤送信を含むこのS5工程の外部HTTP provider
requestは計3回。

計測用sourceは`.tools/increment-170/observed-source-2/`へcopyし、短いtiming/identity/文字数だけを追加した。
production workspaceへ観測コードを入れていない。raw
request/response、SSE断片、header、credential値、 Authorizationは収集しない。公式build
workflowのsource rootをこのcopyへ固定し、probe用envを許可した 観測compiled
buildは`693a7536926e2708d60b46490b43c704e57de022fe1166bb899956c63cb816b7`、 runtime
digestは`36db175acb362a48703619cda01183ca0ea1570611f9a21c7ceec3834a2f92ed`。 先行観測copyではbuild
scriptが親git rootへ戻りinstrumentationを含めなかったため、実requestを行う前に
root固定・closureへのprobe include・異なるruntime digestを確認した。

| 観測                                               | 自然完了                                 | 20秒後cancel                                |
| -------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| execution                                          | `17f4a8fd-0dc3-45df-a836-735d046140ce`   | `a077fd26-6f6a-4ca7-8d47-91a018624f24`      |
| 最終保存                                           | completed / canonical / cleanup complete | cancelled / noncanonical / cleanup complete |
| request数 / step数                                 | 1 / 1                                    | 1 / 1                                       |
| 最大本文 / thinking文字数                          | 1,613 / 5,339                            | 0 / 1,896                                   |
| SSE message/thinking更新                           | 198                                      | 31                                          |
| Agent送信→TUI適用（中央値 / p95 / 最大）           | 38 / 40 / 52ms（197対応）                | 35 / 40 / 68ms（30対応）                    |
| Agent送信→次frame write完了（中央値 / p95 / 最大） | 45 / 55 / 65ms                           | 39 / 46 / 71ms                              |
| Core health RTT最大 / timeout                      | 2.53ms / 0回                             | 2.97ms / 0回                                |
| Core 100ms tick最大実行間隔                        | 102.45ms                                 | 104.92ms                                    |
| Data過去query（初回 / Agent実行開始後）            | 1 / 0回                                  | 1 / 0回                                     |
| 全snapshot encode（明示初回read / Agent開始後）    | 5 / 0回                                  | 5 / 0回                                     |
| Data append batch                                  | 198                                      | 32                                          |
| Core process RSS最大 / 最後5秒中央値               | 246.67 / 159.74MiB                       | 297.09 / 297.09MiB                          |
| Core process CPU中央値 / p95 / 最大                | 3.96 / 7.94 / 71.64%                     | 0 / 3.99 / 63.76%                           |
| TUI process RSS最大 / 最後5秒中央値                | 127.01 / 127.01MiB                       | 110.07 / 107.08MiB                          |
| TUI process CPU中央値 / p95 / 最大                 | 3.96 / 3.99 / 15.87%                     | 0 / 3.99 / 7.97%                            |

自然完了のprovider request開始→Agent model_result送信は105.607秒であり、Core改善の時間とは扱わない。
model_result送信→turn_settled/physical cleanup
finishedは66ms、acknowledgement_sent→turn_settledは2ms。 APIのtask
receiptは112.26ms、TUIは途中更新から最終回答・readyまで表示した。

cancelのHTTP返答は2.18ms、Core cancel_requested→cancel_sentは1ms、cancel_sentと物理Agent
cancel_receivedは 同一ミリ秒の記録（時刻の分解能1ms）、cancel_requested→physical cleanup
finishedは69ms。 API task
receiptは89.01ms。thinking途中に取消が届き、1,896文字の未完了thinkingとCANCELLEDを表示してreadyへ戻った。
実providerからassistant本文が出る前のcancelであり、実provider本文prefixの確認とは呼ばない。
本文/toolの部分保存・再接続・次指示は先述のcompiled localhost経路と実Core/Worker/Data
testsで確認した。

旧run-2はcancel HTTP346.068秒（handler開始前344.897秒）、全会話再構築414回、合計362.781秒、
Core定期処理最大間隔350.048秒、health65回中51 timeoutだった。新経路では通常更新時の過去queryと
全snapshot
encodeが0回で、数分の受付滞留は両runで観測されなかった。旧Coreの過去query/projectorはsourceから撤去済み。
Core
tickの測定周期は今回100ms、旧観測1秒である。表示遅延はexecution/kind/step/文字数でAgent送信とdirty
mapperを対応させ、 その後の最初のframe
write完了までを測った。coalescingにより全revisionが別frameになるとは主張しない。
RSSはCore/Data/Agentが同一processの合計であり、各Worker
heapの内訳とは呼ばない。終了後の観測は約5秒だけで、
長時間のメモリ安定や当時の2.5GiB状態の解消保証に広げない。

証拠は`s5-complete/`と`s5-cancel/`のresults、timing-results、display-matches、request/control
facts、 process/health samples、tmux
captures、隔離DBと、run_acceptance.py/prepare_observed_source.py/analyze_acceptance.py。
実provider追加確認はこの2回で終了した。

### 総合gateの結果

最初のgateはcheck/fmt後に167 SSE
fixtureの不要asyncでlint停止した。局所修正と実HTTP/SSE2件を確認して再実行した。
二回目は13の旧Host-only startup fixtureで停止したため、Data port
readyと隔離state/config/dataを用いるfixtureへ移し4件通過。
残りのtaskは失敗箇所以降だけを一度走らせ、48 task passと33/91/138/149/150の旧fixture差分を確認した。
138はpre-read失敗のHost testを実Data descriptorへ、149はschema-lock観測をData
Workerへ、150は子processの終了を session.closeからcreated.close（Data終了を含む）へ移した。138
focused1件、1493件、1506件が通過した。
33は11件、91は10件のfocused再確認が通過した。確認済み旧fixture差分を閉じた安定候補で、親が最終gateを一回実行して成功した。前二回は具体的なfixture/lint不整合で止まり、局所修正とfocused確認後にだけ再実行した。

33のsaved Session mismatchはfixtureだけではなく170の切替regressionだった。Data descriptorから得た
saved.agentを現在のrequested Definitionへ上書きしたため、invalid agent selectionとなり、従来の
`definition_role_mismatch / session_binding`とstored Definitionへのエラー帰属を失っていた。
親はHEADのbindRecordと33の既存要件を照合し、現在のexplicit selector/config
binding/defaultでDefinitionを 解決した後、saved.agentとの不一致を旧typed
errorで返す動作へ戻した。stored exact revisionを暗黙の activation
authorityへ変える案は、旧規則と異なるため採用しなかった。scalar descriptorだけを使い、
過去会話やtranscriptをCoreへ戻していない。追加実provider requestは不要と判断した。
実provider計測candidateと最終candidateの差分はこのstartup選択修正とfixture/task設定であり、
計測時のdefault Definition・bindingなしSessionでは同じDefinitionを選ぶ。timing経路の変更はない。

最終source候補の公式compiled
buildは`94fd1fe91bfbef26ec3fce468c99c0b24b28ed6650f95c1a9e660ce130d8731a`。
前述の観測candidateからのruntime変更は保存Sessionのtyped binding選択修正である。
この候補でもcompiled tmuxの表示・取消・次指示（localhost3
requests）、standaloneの通常/stream（localhost2 requests）、既存v7コピーのoffline CLIを
再確認し、全て成立した。offlineの152,696bytesはsource
CLIの結果とbyte一致した。実providerは再実行していない。証拠保存先は`s5-final-compiled-tmux/`、`s5-final-compiled-cli/`、
`s5-final-compiled-existing-v7.md`。

最終gateは`v0:check`・`v0:fmt`（414files）・`v0:lint`（409files）・`v0:test`が全てexit0。 60
test実行群の517件がpass、失敗0件。170の新規focused群38件も通常gateへ組み込んでpassした。 最終runtime
digestは`c472627992e4affc3d30d69ccb4a684f76b0284fae44212da6024efe8c065e84`。
ログは`.tools/increment-170/authoritative-gate.log`、buildは`final-build.log`、集約は`acceptance-summary.json`。
変更箇所のfocused確認に加え、schema初期化待ち、複数process保存・recovery、Definition/module、child/process、
none/headless、HTTP/SSE、準備中cancel、tool関連付け、表示identity/scrollの実経路を確認した。

親はS1〜S5のlocal実装・検証を完了と判断した。実provider計測はminimumの自然完了／cancel各1回と
既存baselineとの比較であり、未観測provider variantや長期性能を保証しない。 通常利用メモB6のprovider
catalog一覧問題は計画外として未修正のまま候補に残している。
構想・architecture・roadmapの正本は変更していない。必要な反映案は本書の承認境界に留める。
S5検証完了時点では、常用配置・commit/push・release/公開・実data削除は行っていなかった。
その後の配置・commit/push・完了承認は以下に記録する。

## 常用配置（2026-10-03）

利用者の「常用配置して」により、最終検証済みの公式compiled build
`94fd1fe91bfbef26ec3fce468c99c0b24b28ed6650f95c1a9e660ce130d8731a`を
`dist/henji`と常用`/home/agent/.local/bin/henji`へatomic配置した。
新しいbuildを作り直さず、S5の最終compiled確認に用いたbinaryを配置した。sourceは
`27f154283631c3770f28d52159863498d8fa1174+dirty`で、169と170のlocal実装を含む。
検証artifact・dist・常用binaryのSHA-256一致と配置先の`--version`一致を確認した。
SHA-256は`40bb69254719cf7521e36701dd60c1c910a01a9907c855d981351b50af43cdbc`。

旧168 build `4db6bd68…`は`.tools/increment-170/deployment/henji.previous`へ退避した。
配置先binaryのCoreとTUIを隔離HOME/XDG/workspace・110×32 tmuxで起動し、none Sessionの
ready表示、editor入力、idle・execution0のAPI readback、detach、Core shutdownを確認した。
task投入・provider requestは0回。確認用Core・TUIは終了済み。
記録は`.tools/increment-170/deployment.json`、証拠は`deployment/probe/`。

新しいCore/TUIを通常起動すると適用される。既に起動中の実Core/TUIは再起動しておらず、
実config・保存Session・credentialは変更していない。配置確認時点ではcommit/push・release/公開は未実施。
構想・architecture・roadmapの正本は変更していない。

## commit/push（2026-10-03）

利用者の「ではまず 170をコミットプッシュ」により、169を含む170までの変更をcommit
`503a3f5fac4a1a82f162c9ebadf1d18266368895`へまとめ、origin/mainへpushした。
171の256色・user背景帯・見出し色とその文書はこのcommitに含めず、作業treeへ保持する。
170の検証済みruntimeとcommit対象の一致を確認し、既存の最終gate・compiled実経路確認を根拠とする。
構想・architecture・roadmapの正本は今回変更しない。

commit対象を隔離treeへ展開し、公式buildと同じruntime content-closure（213 files）のSHA-256を
計算した。`c472627992e4affc3d30d69ccb4a684f76b0284fae44212da6024efe8c065e84`で、
最終検証・常用配置済み170 binaryのruntime digestと完全一致した。 切り分け後のconversation/retained
terminal/tool previewのfocused 67件も全てpassした。 171の作業treeのsourceと文書は保持した。

## 完了承認（2026-10-03）

利用者の「170は完了とします」により、Increment 170を完了とする。
実装・検証・常用配置・commit/pushの実施済み結果を受けた完了承認である。
構想・architecture・roadmapの反映案は別途承認待ちとし、この完了承認で正本を変更しない。
