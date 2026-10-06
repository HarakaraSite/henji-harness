# Increment 199 — Data Workerの必要な仕事から状態・保存・公開・読取を再構成する

状態:
利用者による完了承認済み（2026-10-06）。source変更は本commitへ保存し、常用配置は未実施。利用者はData
Workerについて「要件は維持するが、無駄な処理がないか」「現行のコード、構造は肯定しない」と調査を指示し、結果を受けて対応計画の作成を依頼した。
利用者は通常/批判的reviewとスライス分割を確認し、「それで進めてください
承認します」とlocal実装・非破壊的検証を承認した。Slice1〜6の同一入力比較・独立review対応・
最終compiled実経路・authoritative gateを完了した。結果と承認境界は本書末尾を参照する。

## 目的、必要な動作、根拠

目的は、人間とAgentが必要とする保存・操作・表示・参照を成立させるための最適な処理を選ぶこと。
現行class、内部API、dataの形、処理配置の維持を前提にしない。メモリ量は結果指標であり、固定値を成功条件にしない。

維持するproduct動作は以下である。

- 新規/保存Sessionで依頼し、canonical会話と実効model contextを次の依頼へ引き継げる。
  metadata変更・checkpoint・compaction・recallによるcontextの意味とrevisionを維持する。
- 実行中のthinking・本文・toolの進行、確定、失敗・取消を、情報・順序・request帰属を保って表示できる。
  HTTP/TUIとheadless/runの出力を維持する。未完了本文をcanonical会話へ自動採用しない。
- 正常終了では最終data
  sequenceまで保存し、Hostの採用許可とchild/process清算を満たしてからcanonical採用する。
  取消・failure・強制停止・再起動では、成立した保存prefix・最新本文・terminalを保持する。
- request単位の最新本文の置換、model resultとのatomic終了、terminal/採用/Session
  revisionのatomic保存を維持する。
  保存失敗を成功公開へ置き換えない。COMMIT前に確定した会話として配信しない。
- 保存履歴、context、execution、request、artifact、recallをreadbackできる。
  読取が要求する保存時点・本文・順序・semantic identity・relationを維持する。
- 初回接続・追加TUI・再接続・Session切替で、snapshotと後続更新が一致する。
  Dataの保存cutとCoreの単一public revisionを区別し、更新欠落や古いsnapshotへの巻戻りを生じさせない。
- Data
  read/flush/terminal待ちをCoreのcancel送信前に挟まない。共有workspaceの複数CoreとSessionの所有を維持する。
- credential値とAuthorizationを履歴・診断へ含めない。

根拠は利用者の指示、[architecture](../architecture/henji-host-agent-worker.md)のData状態所有とdurable
history、
[170](increment-170.md)の保存/公開・cut契約、[181](increment-181.md)と[181 contract](increment-181-contract.md)のsemantic
authorityとderived artifact、
[195](increment-195.md)・[196](increment-196.md)の復元/metadata取得の結果、[198](increment-198.md)末尾の処理最適化に関する利用者判断である。

## 確認した利用経路と無駄

現行の操作から結果までを次の経路で確認した。

| 操作/更新                          | 現行経路                                                                       | 結果に不要と確認できる仕事                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 保存Session選択                    | Core/Worker TUI → sessionDescriptor → 一時DataSessionOwner → 実行用openSession | descriptorだけのためのcanonical本文2回read・一時owner/lock/clone。その後の実行再開で再度read                               |
| 次の依頼/metadata変更              | Session handle → SessionAuthority → admission/proposal/commit                  | handleとauthorityのcanonical全文二重保持。存在判定で全文clone。変更しない本文をmetadata更新時にclone                       |
| Agentの進捗                        | Agent–Data port → journal → SQLite batch → ConversationState → 配信            | runtime eventごとの使わないbase_message_count query/接続開閉。firstEventOrdinalだけのための旧本文JSON parse                |
| proposal/terminal                  | Endpoint → prepared proposal → terminal transaction → artifact metadata        | record/outcome/messageの独立した全文copy、使わないprepared message.transcript、保存先が4項目しか使わない完全artifact組立て |
| 終端後ACK/cleanup                  | control保存 → live descriptor更新 → artifact再導出/更新/比較                   | 変更したack/settlementが保存対象外で、通常は同値比較に終わるartifact全体の再処理                                           |
| 状態通知/初回購読                  | coordinatorのdescriptor購読 → Data watch → Core watch → 明示snapshot read      | descriptor consumerにも会話payloadを生成/送信。初回snapshotの未使用・重複要求。snapshot内の二重sort                        |
| `/context`/recall/診断/request読取 | events/requests全復元 → 対象選別 → 応答                                        | 無関係な本文hydrate、同eventsの再読込、選ばれないrequestのitems/base64/transcript加工                                      |

source根拠:
`worker_host_coordinator.ts:203`、`data_service.ts:465/715`、`session_authority.ts:177`、
`session_data_owner.ts:769/848/1019/1578`、`sqlite_history_store.ts:1208/1453/1951/2457/2555/2641`、
`conversation_writer.ts:105/463`、`sqlite_history_core.ts:828`。

読取probeは保存DBコピーをread-onlyで使い、現在のsnapshot実装を初回経路に対応する3呼出しで確認した。
同じcut・260 entity・624,826 bytesのsnapshotを3回encodeし、260件のsortを6回実行した。
これはsource経路と同じ呼出しのprobeであり、production起動全体の時間計測ではない。
既存A28の`/context`・終了後artifact・recall/診断候補の量測定も本計画の根拠として移設した。

### A28から移設した既存読取probeの証拠

195・196の類似問題reviewで得た以下の観測を、本計画の読取/終了後更新の根拠へ移設する。
稼働Core・実DBを操作せず、調査用DBコピーをさらにscratchへbackupして確認した。
比較は同じコピーDB一件であり、product sourceは変更していない。

| 経路                            | 現行のdecode量                                                                                       | 限定読取probeのdecode量と一致確認                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/context`のlatestRequest       | 171 bytesの返値に2,080 payload / 32,120,512 bytes。うちassistant_messageは1,726件 / 31,294,685 bytes | model_requestだけで15件 / 61,660 bytes、返値SHA-256一致                                |
| 終了後artifact読取              | admissionと最新metadataのため全semanticを2回読取。4,160 payload / 64,241,024 bytes                   | admission/metadata読取を限定すると14,826 bytes、artifact全体192,949 bytesのSHA-256一致 |
| 終了後artifact metadata同値比較 | さらに2,080 payload / 32,120,512 bytes                                                               | 現調査では保存対象field自体が変更されないため、比較とその前段の再導出を撤去対象とした  |
| recall/診断effects集計          | 32,120,512 bytes                                                                                     | 69,249 bytes、返値SHA-256一致                                                          |
| 診断provider fact抽出           | 32,120,512 bytes                                                                                     | 61,660 bytes、返値SHA-256一致                                                          |
| 診断execution context           | 32,120,512 bytes                                                                                     | 235,433 bytes、返値SHA-256一致                                                         |

証拠はgit管理外の`.tools/review-195-196/similar-probe/`に保存する。
従来の候補は個々のSQLを限定する案だったが、本計画ではconsumerの必要な結果から判断し、
終了後artifact再更新そのものとrecallの二回目の全events復元を撤去する。
必要なartifact/recall本文は明示read時に読む。request一件の復元は今回確認した過去依存を踏まえて計画する。
compiled production全体の時間・常駐メモリ削減幅はこのprobeから確定しない。

通常のowner.descriptor()は保持済みの短いfieldを投影し、DB全文readを行わない。 canonical model
stateと非canonicalを含むConversationState、terminal
cut/保存barrier、contextの過去spliceは異なる目的を持つ。
意味上の区別は維持するが、それぞれの全文を常時materializeする必要があるとは扱わない。
実consumer、必要な時点、所有期間から保持・参照・導出を選ぶ。参照に必要な過去本文は保存正本へ残す。

## 提案する構造

### 1. canonical model dataのownerと保存操作を分ける

Data内にcanonical model
stateのownerを一つ置く。実行用context生成に必要なtranscript、実効model/private-state境界、checkpoint等を所有する。
旧ActiveSessionProjectionの全fieldをそのまま一個にする案にはしない。
次generationが必要としないturnModels/turnExecutionsの全履歴配列は保持・再組立てせず、
DBのsession_turns/executionsを正本として、full SessionRecordが必要な明示readで導出する。
descriptorとgenerationには必要な短いcounts/position/selectionと実効contextだけを渡す。
modelChangesの保存側appendと、live ownerの現在model/private-state境界も分ける案を比較する。
旧履歴配列を保持する前に、generationが必要な値を求める読取/更新の最小範囲を決める。
Sessionの保存handleはidentity・保存済み存在・lock・保存操作を担い、別のcanonical全文を常時持たない。
実行再開の必要な本文readはownerの初期化で一回行い、不要な履歴attribution配列を付けない。descriptorだけの取得では本文を読まない。

prepared proposalはprepare時点で固定したData-owned
transcriptを一つ持つ。次generation用contextと保存に必要な新message suffix/変更fieldを分け、
完全SessionRecordと完全outcomeを保存用に再組立てしない。
元messageから必要なcontextManifest・diagnostic等だけを保持し、重複transcriptを残さない。 prepare
tokenの対象・base revision・sequence、取消判断、COMMIT前後の境界を維持する。
共有する本文を後続hook・checkpoint・metadata変更が変更しないよう、所有と更新点を明確にする。
実際に別版の本文が必要になる操作では、その必要な版を持つ。一般的な全文cloneを不変性の代用にしない。

metadata変更は該当metadataを保存し、保存後にownerの該当fieldを更新する。本文の組立て/検証/保存を経由しない。
新規Sessionの初回保存と既存Session更新の動作・revisionは現契約に合わせる。

canonical採用の保存portは新message suffix・execution correlation・必要なSession変化を受ける。
terminal/採用/Session
revision/checkpointを同一transactionで保存するが、adoptCanonicalInTransactionの後に 同じSession
metadataを全record経由で再更新する経路は撤去する。
過去attribution配列のcloneと、変更されない全recordの再検証/全modelChanges走査を採用ごとに行わない。
実際に変更されたcheckpoint/context/model等の保存と、prepare対象・base
revision・採用許可の照合は維持する。 ownerの採用済みcontext/positionはterminal
COMMIT後に更新する。prepare中の候補を採用済みstateへ上書きしない。
incoming全文proposalの必要な検証は維持する。この保存contract変更だけでAgent–Dataの全文proposal通信も不要とは断定しない。

### 2. 保存時に必要なfactとmetadataだけを組み立てる

Agent入力はexecutionごとの順序を保ち、journalの受信/保存cutとterminal barrierを維持する。
保存batchではsemantic fact、最新本文state、firstEventOrdinal、context
relation等の必要な情報を保存する。

base_message_countの参照はtranscriptを切り出す必要のある入力に限定し、admissionで決まったexecution単位の値を使う。
firstEventOrdinalのlookupは番号だけを取得する。旧累積本文を復元しない。
同じ入力の防御的なcloneを各層で反復する経路は、Dataの所有境界に必要な一回へ整理する。
semanticな出来事・tool/状態変化・順序を「最後の一件」へ一律に潰さない。

terminalでは実際に保存するstoreResult・protocolTrace・childCleanup・storeErrorを直接組み立てる。
protocolTraceのsequence正規化、canonical/noncanonicalの違いを保つ。
outcome/configuration/recall/attribution等を含む完全artifactは明示read時に正本から導出する。
ACK/cleanupはcontrol fact保存とlive state更新で成立させ、消費されないartifact再更新を撤去する。
metadata未作成時のdefault追記を除いた場合も、既存artifact
readbackと必要情報が一致することを確認する。

### 3. descriptor通知と会話配信をconsumerに合わせる

logicalな購読をdescriptorとconversationに分ける。同じData–Core
portでsessionごとの必要な購読を管理し、順序を維持する。
coordinatorはdescriptor、Coreの会話配信はconversationを購読する。headless/runのAgentEvent出力は実consumerが要求する情報を受ける。
descriptorだけの購読で会話snapshot/deltaをencode・コピー・送信しない。
複数consumerが必要とする変更は同じ保存結果から生成する。別の会話正本や表示用DBを増やさない。
descriptorのownerも増やさず、同じSession/execution状態から必要なfieldを通知する。
一回だけのsessionReadを永続watchへ変換しない。実conversation
subscriberの開始/終了に購読lifetimeを合わせる。

ConversationStateは公開/読取viewであり、保存・canonical採用の成立条件ではない。
初回の明示会話read/watchまで全履歴replayとview materializeを行わない。
まだ会話viewを生成していないdescriptor-only/headlessでは保存と必要なdescriptor/AgentEvent出力だけを行い、会話viewの生成・更新・delta
encodeを行わない。 一度会話viewを生成したcurrent/open SessionはSession
closeまで保持し、COMMIT後の共通normalizerで逐次更新する。 会話subscriberがゼロならdelta
encode/転送を行わず、再接続ごとの全replayも増やさない。 closed Sessionのviewは実conversation
subscriberがいる期間だけ保持し、最後のsubscriberが終了したら解放する。 closed
Sessionの一回だけの明示readでは、その応答の生成に必要な期間だけviewを持つ。TTLや容量policyは追加しない。
本文進捗で全会話のparse/encodeやorder再sortを行わない。
会話snapshotは明示readと会話購読開始にだけ生成する。初回watchのsnapshotをCoreがそのまま使い、直後の同じsnapshot再要求を撤去する。
entity辞書を順序化するためのsortは不要である。orderの生成は構造変更に依存させ、本文/metadata更新で同じ順序を再計算しない。

Dataのsnapshot cut、購読登録、登録中の後続delta、Core controlの合成、public
revisionの関係を一つの更新経路で扱う。
保存cutはviewの生成/購読の有無と独立して維持し、初回materializeは同じ保存read時点のfactsから生成する。
購読登録中のCOMMITはそのcut以後のdeltaとして引き渡す。viewの初期化で保存cutをリセットしない。
snapshotとそのcut以後のdeltaを、新subscriberの登録・初回frame引渡しまで保持し、
そのsubscriberへsnapshot→deltaの順で開く。既存subscriberのcursorは変更しない。
現行clientはwatchのPromiseを返す前にbuffered
callbackを実行するため、返却snapshotだけを差し替える実装にはしない。
遅い返信や購読追加が既存subscriberの位置・cutを巻き戻さない。再接続にはその時点の必要なsnapshotを返す。

encoded bytesは送信時の所有を明確にし、最後の所有者からportへ渡す際はtransferを使う。
複数consumerで必要な複製と、単一consumerへ送るだけの複製を区別し、同じ大きいbufferを全層でcopyしない。
返却/保持中のbufferをdetachする方式にはしない。実consumerを追い、未使用のsnapshot/bytes保持も撤去する。

### 4. 読取対象と復元範囲を先に決める

読取をmetadata、対象execution/request、全文history/contextに分け、各応答のconsumerが要求する情報からqueryを作る。
Session descriptor・最新request・request countはmetadata
queryで返す。live受信済みfieldと保存済みreadbackは区別する。
`/context`は現行のexecution選択順・最大requestOrdinal・requestなしexecutionの扱いを維持し、model_requestに関係する保存情報から得る。

recallは同じ保存readから得たeventsを再利用するか、必要なtool/effectだけを読み、二回目の全events復元をなくす。
診断context/provider factは対応するsemantic種類だけを選ぶ。
明示artifact読取でもadmission・最新execution metadataは該当kindのqueryで取得し、
その選別のために全semantic本文を繰り返し復元しない。artifactが要求するoutcome/configuration/recall本文は取得する。
request一件は対象requestを先に特定し、そこまでの必要なspliceと参照occurrence/contentを復元する。
選ばれない後続requestを組み立てない。対象request一件のrowだけでは復元できない過去依存は残す。

明示的な全文history/contextは必要な全体処理を行う。history
exportの全文を求める操作を勝手にページ制限しない。 必要なquery
indexは実際のqueryとEXPLAIN/読取証拠から決め、全本文cacheを追加して過剰readを隠さない。

## 対応範囲、対象外、撤去

対象はData workerのowner/保存handle・journal・writer・service/endpoint/client、SQLite
history/coreの該当queryと保存port、 coordinator/Core/API/CLIの実consumerである。主な変更候補は以下。

- `v0/agent/data/`、`v0/agent/history/sqlite_history_store.ts`・`sqlite_history_core.ts`。
- `v0/agent/data/session_authority.ts`とSession保存handleのcontract/consumer。
- `v0/agent/worker/worker_host_coordinator.ts`・`worker_tui_session.ts`、`recalled_execution_context.ts`。
- `v0/agent/host/core_service.ts`・`encoded_public_frame.ts`と該当API/CLI port adapter。

旧handle.record全文getter/複製保持、prepared
message全文、採用時の履歴attribution再組立て/重複Session
write、完全artifactのwrite-side組立て、終了後artifact再更新、 descriptor
consumerへ会話payloadを配る購読API、consumer不在のview生成/encode、一回readから残る永続watch、未使用初回snapshot、選別前の全文復元経路を置換と同時に撤去する。
旧型やtest
helperを使うためだけのadapterは残さない。内部contract変更は実consumerを同時に切り替え、dual-read/writeや互換fallbackを追加しない。

対象外は198の表示方式/Markdownの再変更、terminal履歴方式、provider機能変更、semantic記録の一律削減、既存実data削除、native/allocator
tuningである。
198の表示動作を変える必要は確認していないが、Data側の会話view生成/保持は199の対象である。

storage schemaの全面置換、新worker/新transportは最初の実装手段に選ばない。
既存のsession_turns/executions参照と採用transactionで、確認した重複保持/再組立て/再保存とconsumer不在の仕事を撤去できる。
これらを全面置換する追加利益は現時点で確認していない。必要な保存port/query/index/lifetimeの変更は行う。

full current-value upsert
wireは固定した対象外としない。本文置換と初回snapshot/再接続は必要だが、毎更新の全文通信が必要とは未確認である。
Slice
4で不要なproducer/encode/copyを撤去した同じ入力について、残る通信量・encode時間・表示遅延を観測する。
append/replace案についても必要な本文復元、非append更新、cut/再接続、変更consumerと更新処理を比較する。
Slice 4を終える前に、同じ動作を成立させる仕事と変更負担を根拠にwireの採否を本書へ記録する。
現行wireの維持、通信量だけの削減、内部変更量の少なさのいずれも、それ単独で選定理由にしない。

## スライス別の実装・検証・review

利用者のスライス分割の確認を受け、元のS1〜S5という作業順を、動作する完成状態・依存・撤去・確認を持つスライスへ具体化した。
変更はDataの状態所有/採用transaction、複数Worker間の購読cut、会話viewのlifetime、過去依存を持つ読取にまたがる。
一括実装では問題の発生境界と修正の効果を切り分けにくいため、実装5スライスと最終統合確認1スライスにする。
query一つ・clone一つ・ファイル一つを独立スライスにはしない。

| スライス                              | 実装と同時に成立させる境界・撤去                                                                                                                                                                                                               | 完了を確認するproduct経路                                                                                                                                    | reviewの具体的対象                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Slice 1: canonical owner/採用contract | generationに必要なownerを一個にし、handleは存在/lock/保存。採用portを変更分へ切替。全turn attribution再組立て、二重Session write、metadata全文経由、prepared本文の重複保持を撤去。旧record/outcomeを消費するterminal保存も四項目metadataへ切替 | 新規保存→次task、保存Session再開、selection/title、checkpoint/compaction、prepare後cancel/commit、failureのcontext、採用結果のhistory readback               | prepare中と採用済みstateの分離、Host許可/terminal COMMIT/owner更新、revisionと履歴帰属、旧contractの実consumer撤去 |
| Slice 2: 保存batch/終了後control      | 使わない基準count query、firstOrdinalだけのための旧本文parse、層ごとの重複cloneを撤去。ACK/cleanupはcontrol factとlive stateだけで成立させ、終了後artifact再更新を撤去                                                                         | 途中本文の初回位置/確定、tool順序、canonical/noncanonical、保存prefix、terminal atomic性、ACK/cleanup後のartifact readback                                   | 所有境界と保存順序、最終sequence/terminal barrier、必要なmetadata/control factが残ること                           |
| Slice 3: 実consumerの購読/初回引渡し  | descriptor/conversationを分け、一回readを永続watchにしない。snapshot→deltaの引渡しを一本化。不要payload/encode、重複snapshot/sort、不要byte copyを撤去                                                                                         | headless進行、実行途中のTUI初回接続、複数接続/再接続/切替、登録中更新、直接cancel。会話viewはこの時点では現行の生成時期でも動作する                          | 同一cutとCore public revision、既存subscriberを巻き戻さないこと、実subscriberの開始/終了、buffer所有とtransfer     |
| Slice 4: 会話viewの必要時生成/保持    | Slice 3のconsumer/lifetimeから初回read/watchまでview生成を遅延。生成済みopen Sessionは利用期間中保持し、closed Sessionは最後のconsumer終了で解放。無consumerのreplay/view更新、残る未使用encode/保持を撤去                                     | viewなしheadless→実行途中の初回会話接続、TUI detach/reconnectで不要な全replayなし、Session close/切替、closed Sessionの明示read/最後のsubscriber終了、次task | 保存cutの独立性、同じcutからの初回生成と後続COMMIT、生成済み/未生成viewとopen/closed Sessionの更新/解放条件        |
| Slice 5: 読取対象を先に選ぶ           | Slice 1のmetadata/再開読取を再利用。`/context`をmetadata直読し、recallは既読events再利用。artifact/診断を種類限定、選択requestを依存範囲だけ復元。不要な全文読取/後続request加工を撤去                                                         | `/context`最新request、history/artifact/diagnostics、noncanonical recall→次task、過去spliceを含む選択requestの同一本文・順序・帰属                           | 保存済みread時点、request選択順、必要な過去splice/参照occurrence、明示全文readの維持                               |
| Slice 6: 統合実経路確認               | 前スライスの結果を統合し、旧経路/不要保持/余分な公開物が残らないことを確認。全体を安定候補にする                                                                                                                                               | 隔離compiled Core/TUI/CLIで保存会話再開→次指示→local streaming→完了/cancel→detach/reconnect、history/context/recall/readback                                 | スライス境界をまたぐ状態所有・採用・公開・復元の整合。既に確認済みの内部詳細を全て再reviewしない                   |

依存はSlice
1→2→3→4→5→6の順とする。同じowner/service/storeを触るため、実装を並行化する前提にはしない。 Slice
3と4を分けるのは、購読と初回引渡しが動く状態を先に確認してから、初回view生成と保持/解放の時期を変えるためである。
Slice 1の採用portと実consumer、Slice
3の登録とsnapshot/delta引渡しは、それぞれ同じスライス内で切り替える。 旧prepared
record/outcomeを使うterminal保存consumerもSlice
1で切り替え、保存用の完全artifact組立てを同時に撤去する。 Slice
2へ残す終了後controlからのartifact再導出は、保存正本を読む別経路であり、旧prepared
contractを必要としない。
未接続の新APIだけを作って終了したり、旧型のためだけのadapterで次スライスへ先送りしたりしない。
後続スライスで撤去する現行処理は、残っているものと次の置換先を本書へ記録し、完了済みの改善とは扱わない。

### wire選定と条件付きSlice 4b

Slice 4終了時に、不要なproducer/encode/copyを撤去した入力でfull current-value
upsertとappend/replace案を比較し、採否と理由を本書へ記録する。
現行wireを選ぶ場合、wire変更の実装スライスは追加しない。 変更を採用する場合はSlice
4bとして、必要なData/Core/API/TUIのwire consumerをまとめて切り替える。
完了条件はappend/非append更新、初回snapshot→delta、cancel/terminal、複数接続/再接続で本文・情報・順序が一致すること。
reviewは変更通知の意味、本文復元、cut、実consumerの切替と旧wire経路撤去を対象とする。 Slice
4bを行う場合はその完了後にSlice 5へ進み、最終統合確認へ未決のwire選定や未接続adapterを持ち込まない。

### スライスの終了条件と途中成果

各実装スライスは、上表の実利用経路が切替後のproduction sourceで動き、対応するfocused確認・必要なtype
check/format/lint/diff checkを終える。
保存/所有/並行処理/読取依存について上表の具体的な観点でreviewし、採用findingへの対応後に次へ進む。
独立reviewはこれらの複雑な境界の確認に使い、スライス数に合わせて新しいreviewerを起動することは求めない。
実装/検証結果、撤去した経路、残る処理、採否判断を本incrementへ記録する。 Surfaceが変わるSlice
3/4/4bは、隔離tmuxのcompiled production TUIで当該操作を確認する。
前スライスの確認は使い回し、新しい変更/失敗/未確認事項がなければ同じ確認を繰り返さない。 full
gateはスライスごとに行わず、Slice 6の安定候補で一回だけ行う。
スライス途中の常用配置/releaseは行わず、commit・常用配置の扱いは利用者の指示に従う。
現行consumerが不足する実装判断はsourceから確認し、要件の意味を変える必要がある場合は利用者へ戻す。

## 検証と評価

実装前に、保存DBコピーとlocal
streaming入力でbaselineを保存する。稼働Core/TUI・実DB・実configへprobeを注入しない。
同じSession/入力/要求で以下を分けて観測する。

- 初回descriptor・会話consumerなしの次task/進捗・初回会話接続・terminal・終端後control・明示read。
- 同じSessionでのTUI detach/reconnect、Session close/切替、closed
  Sessionの最後のsubscriber終了による保持/解放。
- SQL読取対象/回数と採用transactionの重複write、hydrate/parseした本文bytes、attribution再組立て、viewの生成/更新/解放、clone/encode/生成したデータ、snapshot/order生成、通知/byte
  copy。
- Core control応答と表示・readbackの完了、処理時間/CPU、PSS/RSS。累積割当と常駐量を混同しない。
- wire案の比較では、同じ更新列の総通信量/encode時間/表示遅延と、append/非append更新・初回snapshot/cut/再接続に必要な処理を記録する。

評価は、consumerが使わない全文read/復元/生成がなくなり、必要な結果が維持されることで行う。
数値のメモリ目標、test件数、理論上の全処理ゼロを合否条件にしない。 現在のA28
2,552更新はTUI側の再生材料であり、Data保存経路の入力へそのまま流せるものとは扱わない。
Data用にはjournalへ届く順序付きAgent入力と実SQLite保存を使い、公開deltaはその結果として観測する。

既存の170 S3 data service/writer/session/journal/client・170 S2 Data worker、181
persistence/build、196 metadata、 remote/streaming/198
viewport等のfocused確認を該当段階へ対応させる。
追加testは、今回変更する上記product動作と確認済みの不要処理の解消に必要なものに限る。
単なる旧内部APIの維持、fixture固定、仮想provider variant、permission/state matrixは追加しない。

実装中はfocused test・type check・format・lint・diff checkを使う。full
gateの反復やreview前gateは行わない。 Slice 6の安定候補ではownerがauthoritative
`v0:gate`を一回行う。失敗時はfocused確認で原因を特定する。
独立reviewは状態所有/transactionとcut/consumerの具体的な変更を対象とし、通常reviewの範囲に限る。

Surfaceに関係するSlice 3/4/4bと最終Slice 6は、隔離HOME/XDG・専用tmuxのcompiled production
TUIで確認する。 保存済みDBコピーとlocal HTTP providerで操作と保存を確認し、実provider
callを必須にしない。 実providerを使う必要が生じた場合は対象・回数・保存先を提示して別途承認を得る。

## 計画review（2026-10-06）

### 通常の整合性/実装可能性review

調査担当reviewerが15分上限のread-only reviewで、状態所有/prepare/COMMIT、購読cutと初回引渡し、
terminal保存consumer、requestの過去依存をsourceと170・181契約に照らして確認した。
初回watch返却前にbuffered
callbackが実行される点を踏まえ、S3のsubscriber別snapshot→delta引渡しを具体化した。
修正後の計画に実装着手を妨げる未解消findingはない。実装のcorrectnessや削減幅を確認した結果ではない。
本段階の文書format・link存在・diff checkを確認した。product
source・test・実サービスは変更していない。

### 構造/処理の批判的review

利用者の明示依頼を受け、先の調査/整合性reviewを担当していないreviewerが30分上限のread-only
reviewを行った。
必要な仕事、保持する状態/層のconsumer、より単純な案、対象外の根拠をsourceと利用要件から確認した。
計画の不足を2件採用してowner/購読/viewの計画と検証へ反映した。現行productのcorrectness不具合や実装済みの改善としては扱わない。

| 指摘                                                  | current sourceから不要な仕事への経路                                                                                                                               | 計画への反映                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会話viewのlifetimeが未定義                            | writer.beginExecutionが無購読でも全履歴replayし、保存batch後にview更新/delta encode。headlessはdescriptorと別AgentEvent経路を消費。Coreの一回readも永続watchを残す | 初回read/watchまでlazy生成。生成済みopen Sessionは利用期間中保持し、無購読ならencode/転送なし。closed Sessionは実consumerの利用終了で解放。cutはviewから独立 |
| owner一個化だけでは全recordの再組立て/重複writeが残る | authorityがgenerationに不要な全turn attributionをproposal recordへclone。adoptCanonicalInTransaction後にstoreが全record経由でSession metadataを再更新              | live ownerをgenerationに必要なdataへ絞る。採用portを変更分へ絞り、過去attribution再組立てと二重Session writeを撤去。full recordは明示readで導出              |

source根拠: `conversation_writer.ts:173/207/482`、`worker_host_coordinator.ts:183/206`、
`core_service.ts:763/1696`、`session_authority.ts:221`、`session_data_owner.ts:602`、
`sqlite_history_core.ts:169`、`sqlite_history_store.ts:1810`。
会話viewの利用期間中保持と再接続ごとの全replay回避は170:194–199にも対応する。

意味上異なるviewを全量同時保持の根拠にする記述を撤去した。
wireも固定した対象外から外し、不要なproducerを撤去した後の残余costとappend/replace案をSlice
4で比較し採否を決める。
schema全面置換/新worker/新transportを最初の手段に選ばない理由は、現schemaと既存transactionで確認済みの改善を成立できるためである。
レビューはsource/doc変更・test・実DB・稼働サービス・provider操作を行っていない。
反映後の限定re-review（5分上限、変更した文書箇所のみ）でも、2指摘の計画上の解消と新たな必須findingなしを確認した。
未生成viewと生成済みopen Sessionの更新条件を区別する軽微な表現調整も反映した。

## 未確認事項と承認境界

- prepared
  transcript共有の具体的な更新点、変更分の採用port/checkpoint保存、metadata操作のrevision、live
  model境界の最小形、lazy view登録/解放、request復元の最小dependency
  closureは実装時にsourceで確定する。
- wire変更の実効果と追加処理は未確認。Slice
  4の比較と採否記録を終えずに現行wire維持を最適な処理の結論にしない。
- terminal metadata未作成時の既存default追記は有効情報の復旧ではないが、撤去後のderived
  artifact返値を確認する。
- 変更によるCPU/処理時間・常駐量の削減幅は未測定。内部copyの省略をruntime全体の最適性の証明とはしない。
- Dataの状態所有・Hostの採用許可・API/TUIの責務は維持する。必要なarchitecture/roadmap文言の変更案は本incrementへ留め、正本反映前に変更対象・理由・意味を提示して別承認を得る。
- スライス別のlocal実装・非破壊的検証は利用者の承認済み。source
  commitは完了承認時に追加承認された。常用配置、push・公開、新しい実provider
  call、既存data削除は今回の実装承認に含めない。

## 実装・検証の記録

### Slice 1 着手

変更前source `86505b60`をgit管理外の`.tools/increment-199/baseline-src/`へ隔離した。
implementerがSlice
1のowner/保存contractと実consumerの一括切替を担当し、defaultはbaseline・最終検証・review採否・文書を担当する。
既存のuntracked fileと稼働Core/TUI・実DBは変更しない。

### 変更前baseline

隔離source
`86505b60`、保存DBコピー、実DataServiceとDataSessionOwner/Writer/SQLite保存経路で取得した。
新たな実provider callは0。instrumentationは診断processだけに置き、時間/RAMの比較値としては扱わない。

| 操作                      | 確認した不要処理と比較値                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| closed Session descriptor | 1,167 bytesの返値にcanonical full read 2回、JSON parse 363回/1,007,121 UTF-16単位                          |
| 保存Session open          | full read 1回、parse 224回/692,524 UTF-16単位                                                              |
| 会話consumerなしのadmit   | 保存会話view replayを含みparse 2,740回/12,206,322 UTF-16単位、会話delta encode 1回                         |
| 20回本文進捗              | SQL statement実行140回、旧本文を含むparse 19回/59,843 UTF-16単位、会話delta encode 20回                    |
| prepare/採用              | prepareでtranscript clone 2回（計268 message）、採用でclone 1回（134 message）。Session UPDATEは2種類各1回 |

保存会話への順序付き20 progress→model result→prepare→canonical採用→ACK/settled/cleanup→再開で、
canonical本文と再開contextのSHA-256が一致した。read
probeでもdescriptor・snapshot・context・canonical表示の比較hashを保存した。 証拠:
`.tools/increment-199/read-before.json`、`stream-before.json`、`read_probe.ts`、`stream_probe.ts`。
同じ初期DBは`.tools/increment-199/comparison-input/`に保存し、新版ではそのコピーから比較する。
既存のproduction Data owner/commit failure/persistence focused確認3件も隔離sourceでpassした。 記録:
`.tools/increment-199/slice1-focused-before.log`。

compiled旧版の隔離tmux baselineもpassした。local HTTP providerでthinking/tool/body→次task、
TUI二接続・detach/reconnect、表示済みprefixからEsc cancel、2 canonical/1 cancelled保存、 connected
Dataとstandalone CLIのcanonical/session履歴一致を確認した。
取消probeはTUIが表示する実操作のEscを使うよう修正して確認し、Ctrl-Cを取消仕様にはしない。 実provider
callは0、local HTTP requestは4回。証拠: `.tools/increment-199/before-tmux-result.json`と各capture。

### Slice 1 同一入力の比較（実装確認中）

closed descriptor・open
descriptor・会話snapshot・context・canonical履歴の全返値hashがbaselineと一致した。 closed
descriptorはfull Session read 2回→0回、parse 363回/1,007,121 UTF-16単位→3回/284単位となった。
保存Session
openはgeneration用の本文を一度読み、過去attribution/configuration/outcomeを組み立てない。
parse量は692,524→313,357単位となった。

同じ保存Sessionで20
progress→採用→ACK/cleanup→再開した本文hashとterminal返値全体、artifact要約も一致した。
prepareのtranscript cloneは計268 message→今回の固定suffix 2
message、採用時の全文cloneは0回となった。 Session
UPDATEは採用transaction内の1回だけになった。再開のparse量は691,583→320,467単位。
最初のprobeで採用照合queryのmodel_json取得漏れを確認し、query修正後に新しいDBコピーから再実行してpassした。
証拠: `.tools/increment-199/read-slice1.json`、`stream-slice1.json`。

Slice 2〜5の進捗保存・終了後artifact再導出・無consumer view生成・一般readはまだ変更していない。
旧内部contractの既存test移行と、prepare/COMMIT/owner・checkpoint/model境界の独立reviewを継続中。

追加baselineとして、headless実行開始後の初回TUI接続も隔離compiled旧版でpassした。 実provider
0回、local HTTP request 4回。証拠: `.tools/increment-199/before-mid-tmux-result.json`。

### Slice 1 完了

ownerは次generationに必要なcanonical本文・現在model/private-state境界・checkpoint・positionを持つ。
handleの全文record保持/getterと旧save/commit contractを撤去し、metadata
writeとopen時のowner-state移管へ切り替えた。
旧保存consumerと直接fixture/testも同時に切り替え、互換adapterはproductionへ残していない。
prepareはsuffix単独の1 turn因果検証後に一回cloneし、過去prefix再走査とdead
completedTurnCountを撤去した。 terminal保存は四項目metadataのみ、Session
metadataの再保存と過去attribution再組立てを除いた。

独立reviewで採用した2 P2（新しい時刻大小拒否、空canonical Session再開拒否）を修正し、
限定re-reviewでsource上の解消と新たな必須findingなしを確認した。
初回cancel後のempty再開、以前のassistant provider stateを含む2 canonical
turn、changedAt<createdAt保存のfocused確認もpass。 全tests source
typecheck、変更31ファイルのformat/lint、diff checkとfocused 47件passを確認した。

最終候補を同一DBコピーで再比較し、baselineで再開可能な8
Sessionはdescriptor/open返値が8件とも完全一致。 最後のstream比較もcanonical/reopen
hash、terminal返値、artifact要約がbaseline一致した。 証拠:
`.tools/increment-199/all-saved-before.json`、`all-saved-slice1.json`、`stream-slice1-final.json`。

143 HTTP testは保存port変更より前のL152でlocal provider到達を待ってtimeoutした。 frozen
baselineでも同一command、さらに正式worker/sys権限を付けた単件で同じtimeoutを確認した。
今回変更のregressionとは採用せず、credential production経路は変更していない。
このtestの後半操作はこの実行では未確認。fixtureと現契約の整合を親が切り分け、統合実経路確認へ持ち越す。
証拠: `.tools/increment-199/slice1-143-before.log`、`slice1-143-formal-before.log`。

Slice 2へ進む。前スライスとのreview比較用sourceは`.tools/increment-199/slice1-source/`へ隔離した。

143切分けは完了した。repositoryの`v0:test`に定義された正式の起動flagsを対象ファイルだけへ適用すると、
frozen baselineとSlice 1安定snapshotの双方がpassした。取消・recall・Session操作・checkpoint
resumeまで確認済み。 先の限定flagsでのtimeoutをproduct failureと扱わず、credential
production経路・fixtureは変更していない。 証拠:
`.tools/increment-199/slice1-143-authoritative-before.log`、`slice1-143-authoritative-after.log`。
詳細診断は別sourceコピーだけに置き、credential値・Authorizationを出力せず、常設診断は追加していない。

### Slice 2 完了・同一入力比較

保存batchから使わないbase_message_countの別query/connectionを撤去した。
firstEventOrdinalは既存columnだけを読み、前回の累積event_jsonをparseしない。
journal受信で非同期保存までの値を固定し、後段の重複cloneを除いた。
終了後ACK/turn_settled/cleanupはcontrol factとlive
descriptor更新だけで成立させ、artifactの再導出/比較/再保存を撤去した。 明示artifact
readで必要なcontrol由来のACK/settlementを導出する経路は維持した。

同一入力20 progressのparseは19回/59,843単位→0回、cloneは40→20回、SQLは140→120実行。 model
resultの旧本文parseも0回。終了後3 controlはparse 84回/89,088単位→0回、SQL105→9実行。
canonical/reopen本文、terminal返値、turn帰属に加え、artifact全体7,395 bytesのcanonical
hashもbaseline一致。 証拠: `.tools/increment-199/stream-full-before.json`、`stream-slice2.json`。

focused 26件とfoundation provider/tool-terminalの2件、全tests source
typecheck、対象9fileのformat/lint/diff checkがpass。 新journal確認はreceive後flush前のcaller
mutationでも保存値が変わらないproduct所有境界に対応する。 provider factsの複数turn
fixtureは、今回分だけのproposalから実generation context prefixを含むproposalへ修正した。
旧no_session経路で通っていたfixtureの形をproductionへ逆輸入せず、確認済みWorkerRuntimeの経路へ合わせた。
独立reviewは保存順序・journal所有・firstOrdinal key・control fact/derived
artifactをsourceで確認し、必須findingなしで完了した。 Slice
2の安定sourceは`.tools/increment-199/slice2-source/`へ隔離した。Slice 3へ進む。 Slice
3以後の購読・view生成/lifetime・wire・一般readは未変更。

### 後続Slice 5の比較入力固定

保存済みDBのfreshコピーで旧版の明示読取結果を固定した。e4e0c7ce Sessionのd972493a executionは54
requestを持つ。 request 1/27/54の返値は各230,025/731,603/1,044,542
bytes、いずれも全54件を復元しparse 7,547回/23,911,086 UTF-16単位となる。 全contextの返値は42,395,239
bytesであり、この明示full read自体の結果は維持する。 artifact・effects・各request provider
facts・a5952957 noncanonical recallの全返値hashも固定した。 証拠:
`.tools/increment-199/selected_read_probe.ts`、`selected-before.json`。現Slice
3実装とは独立した旧版比較入力である。

### Slice 3のcompiled比較用Session切替baseline

旧compiled binaryで二つのTUIを接続し、新規Sessionへ切替→closed
Sessionのview→元Sessionのresumeまでpassした。
旧Sessionを見続けるもう一つのconsumerと保存会話は維持された。connected/standalone
historyも一致した。 slash pickerのEnterは補完後に実行のEnterを送り、closed
viewは画面に表示されるREAD-ONLY状態を確認する。
これらの実操作に合わせたprobe修正前のtimeoutをproduct failureとは扱わない。 実provider 0回、local
HTTP request 4回。証拠: `.tools/increment-199/before-switch-final-tmux-result.json`。

### Slice 3のdescriptor-only比較入力

in-process DataServiceと実Agent–Data MessagePortで、descriptor
consumerの購読→admission→20回の順序付き本文進捗→prepare/採用を固定した。
旧版の共用watchはdescriptor-only consumerでも購読時に会話snapshotを1回/568,109
UTF-16単位encodeし、20 progressで会話deltaを20回/65,908単位encodeした。
canonical採用後descriptorはstateRevision 4/nextTurn 4/latest settled/canonicalとなる。 証拠:
`.tools/increment-199/descriptor_consumer_probe.ts`、`descriptor-before.json`。実provider callは0。

### Slice 3候補・親のfocused/同一入力確認

Coreはone-shot sessionReadを会話watchから外し、実stream subscriberがいる間だけData conversation
watchを共有する。 初回snapshotも後続updateも同じCore sink→API Worker→HTTP
frame経路で配信する内部contractへ切り替え、snapshot別返却/再包装を撤去した。
新subscriberだけが登録中のframe/cut情報を一時保持し、同じcutに含まれる更新の二重applyと、古いsnapshotへの既存consumerの巻戻りを防ぐ。
slotは短いdescriptor購読を持ち、最後の実conversation unsubscribeでData watchを終了する。

実Data Workerのsnapshot replyをSQLite読取後に保留し、その間にtaskを実行するfocused確認で、
初回接続/追加接続ともcut・Core public revisionに欠落なし、既存subscriberの継続、one-shot
readのwatchなしを確認した。 170 HTTP stream/reconnect、preparing cancel/shutdown、145 HTTP
shutdown、180 trackingを含む親focused10件pass。 143
HTTPも正式flagsでpass。親変更範囲のtypecheck/format/lintがpass。

同一入力descriptor-only consumerでは、初回会話encode 1回/568,109単位→0、20
progressの会話encode20回→0。
descriptor通知は23回→実状態変化の2回となり、採用後stateRevision/nextTurn/lifecycle/adoptionは同じ。
read probeの全返値hashと、headless stream
probeのcanonical/reopen本文・terminal・artifact全体hashはbaseline一致した。 headlessの会話delta
encodeは0だが、admit時の保存会話replayはまだ残り、次のSlice4で撤去する。 証拠:
`.tools/increment-199/descriptor-slice3.json`、`read-slice3.json`、`stream-slice3.json`、`slice3-parent-focused.log`、`slice3-parent-143.log`。
Data側focused S3 7件とheadless foundation 1件、担当type/format/lint/diff checkがpass。 公式build
scriptの私用出力 `henji.slice3` を専用tmuxで起動し、通常接続とheadless実行途中の接続の両方で、
thinking/tool/Markdown/terminal、二つのTUI、detach/reconnect、次taskのcanonical context、Esc
cancel、 新Session/closed Session view/resume、connected/standalone CLI history一致を確認した。
各runはlocal HTTP 4 requests・実provider 0。稼働中の実Core/TUIと常用binaryは変更していない。 証拠:
`.tools/increment-199/slice3-metrics-tmux-result.json`、`slice3-mid-tmux-result.json`。
20分上限の独立read-only reviewで、RPC前callback→初回snapshot/cut、後発subscriber buffer/public
revision、descriptor
sequence、最後のunsubscribe/切替/close、cancelとtransferを確認し、必須findingなし。 全
`tests/v0/*.ts` と `mod.ts` のtypecheckもpass。Slice3を完了し、安定sourceを
`.tools/increment-199/slice3-source/` に隔離した。

### Slice 4のview lifetime比較入力

実DataService・Agent Data port・保存DBコピーで、headless
admission/progress→実行途中read→二つのwatch→detach→ 無consumer
progress→再read/reconnect→canonical採用→subscriber付きclose→最後のdetach→closed
read/watchを固定した。 Slice3はadmit時に1 replay（parse 2,734回/12,204,078
UTF16単位）、その後のread/reconnectでreplay 0。
close後も全viewを保持し、一回readや最後のdetachで解放しない。各snapshotのcut/bytes/hashを比較基準にする。
証拠: `.tools/increment-199/view-slice3.json`。lifetime変更後のclosed
readは必要時replayし、その後保持しないことを確認する。

### Slice 5/6のcompiled診断CLI比較入力

保存DBコピーを隔離XDGへ置き、旧版実binaryで `diagnostics executions request`（1/27/54）、
`context`、`events` の実CLI結果を採取した。返却全体のcanonical JSON
hashを比較し、source関数だけの一致で終えない。 request返値は各640,713/1,142,305/1,455,244
bytes、context全体42,804,254 bytes、events13,132,693 bytes。 旧版requestのwall
timeは各約0.39–0.40秒、CPU約0.48秒。値は単回の比較指標で成功条件にしない。 証拠:
`.tools/increment-199/before-compiled-reads.json`。provider call 0、実DB/実configは変更しない。

### Slice 3残存sortとSlice 4での撤去

親が次のsnapshot生成確認で、Writer snapshotのentities sortとorder sortの重複を確認した。
Slice3の購読/初回引渡しは完了したが、このsort撤去は未完了だったため、snapshot生成/lifetimeを扱うSlice4へ明示して含める。
consumerがkeyed
entitiesと別orderを使う実経路を確認し、必要なorderだけsortする。新たなsort/cacheを増やさない。
比較hashはobject key列順に依存しないcanonical JSONに統一し、本文・metadata・order・cutを比較する。

### 最終compiled recall比較入力

私用旧版Core/TUIでcancelled prefixを保存し、HTTP recall prepare→TUI次task→ordinary taskを確認した。
local HTTP requestには次taskの一回だけ `PARTIAL_199` が入り、その後のordinary requestから外れた。
二つのTUI、closed view/resume、history一致もpass。local 6 requests、実provider 0。 証拠:
`.tools/increment-199/before-recall-final-tmux-result.json`。
最初の診断runは、4完了taskにより最初の回答がviewport外へ移ったのに固定の先頭markerを画面内に要求して失敗した。
最新回答markerを使う観測へ修正してpassし、product bugとして採用していない。

### Slice 4実装・確認結果

Writerの保存cursor（cut/storeRevision）と任意のconversation
viewを分離した。headless未生成ではreplay/apply/encodeなしで保存し、 最初の明示read/watchで既存fact
readerの同一read transactionからreplayする。新しいStore queryはない。 owner
open/closeをWriterへ通知し、生成済みopen
viewはcloseまでCOMMITから更新、closedは実subscriber中だけ保持し最後unsubで解放する。 closed
one-shotはsnapshot生成後にviewを解放し、cutはviewのmaterialize/解放で変えない。 必要なorder
sortだけを残し、Writerの重複executionOrders
Mapと、明示readから全歴史executionIDを恒久cacheへ追加するloopも撤去した。
順序はnormalizerとnextExecutionOrder scalarが所有し、現在executionのsession
cacheと既存metadata明示読取は維持する。

同じ保存入力のheadless admitはparse 2,734回/12,204,078
UTF16単位→0、会話replay1→0、全20progress/prepareは会話encode0。 必要時の初回表示でreplay1、open
repeat/detach後read/reconnectは0、closed subscriber中0、最後unsub後のone-shot/初回watchは各1。
view全段階のcanonical JSON
hash/cut/byte数はSlice3と一致し、canonical/reopen・terminal・artifact全体・明示readもbaseline一致。
closed readのreplay増は、要求されたreadだけのtemporary view生成であり、全closed
view保持を終えた結果である。

implementer focused8件、追加Map撤去focused6件、対象type/format/lint/diff pass。親Core
subscription/170HTTPstream/143HTTP focused3件pass。 20分上限の独立read-only
reviewはcut/materialize/実SQLite順序/open/closed lifetime/orderに必須findingなし。
Map撤去の一回限定re-reviewも必須findingなし。 公式build scriptの `henji.slice4-final`
でheadless途中attach、二つのTUI、detach/reconnect、次task、cancel、
recall一回消費→ordinary、新Session/closed view/resume、CLI history一致を確認した（local6
requests、実provider0）。 証拠:
`.tools/increment-199/{stream,descriptor,read}-slice4.json`、`view-slice4-final.json`、`slice4-final-tmux-result.json`。
安定sourceを`.tools/increment-199/slice4-source/`へ隔離した。wire選定は以下の実scheduler比較を経て別に決定する。

### wire選定・条件付きSlice 4bの不採用

不要producerを撤去したSlice4の実Writer更新を使い、full current-valueとappend/replaceを比較した。
歴史snapshot625,030bytes、32KB累積本文128更新、nonappend置換、再append、model final、canonical
terminalの133deltaを両案へ渡した。
保存入力内の最大thinkingは約25KBで、比較入力の本文は同じ桁である。
appendは前のentity本文とprefixを比較し、suffixと必要current metadataを送り、consumerの一つのowned
entityへ適用する。 初回snapshot/再接続はfull、非appendはupsert、両案の最終conversation/renderer
frame hashは同じ。
delta通信は2,220,752→141,123bytes（約94%減）、初回snapshot込みは2,845,782→766,153bytes。

最初のnative reducer/2Worker/HTTP診断は受信毎にflushRenderを強制していた。
独立批判的reviewがproductionの16ms描画合流を使っていないと指摘し、採用して実schedulerへ修正した。
毎更新強制描画の結果を、production表示遅延の採否根拠には使わない。 修正後は実TuiRenderer
redraw、Data→Core transfer/Core→API clone、localhost HTTP/SSE、実projector/renderer、 native append
branchで最終cutの実frame receiptを待ち、描画回数を記録した。変換adapterは使わない。

burst12交互runsは両案とも2描画/run、表示完了median24.339/24.489ms、全runs CPU74/60ticks。
保存journal
cadence相当の25ms条件4交互runsは両案133描画/run、CPU158/167ticks、p95frame5.029/4.990ms。
appendでburst時のCPUは減るが、25ms条件では処理/表示の明確な改善は確認できなかった。
投入間隔が支配する全体wall timeやCPU10ms粒度・少数runからfullの性能優位は主張しない。 実terminal
I/O、実配信間隔の分布、多consumer/低帯域remoteの性能は未測定である。

今回はfull current-value wireを採用し、条件付きSlice4bは実施しない。
実consumerへ現在値を渡すまでの仕事を比較し、prefix判定・batch先頭prior保持・metadata分解・consumer本文再構成が増える案に、
通常batch間隔での処理改善の根拠がないためである。既存wireであることや変更量の少なさは選定理由にしない。
通信量/burst CPUというappendの利点は認め、この入力/更新条件を超えてfullが常に最適とは扱わない。
独立批判的reviewの一回限定re-reviewは比較finding解消・今回の不採用判断が妥当・次段階を止める指摘なし。
証拠:
`.tools/increment-199/wire-scheduled-{burst,paced}-after4.json`、`wire_scheduled_compare_probe.ts`、`wire_native_reducer.ts`。
Slice4のproducer/lifetime実装とwire選定を完了し、Slice5へ進む。

### 長い保存会話のcompiled統合比較入力

旧版の私用binaryに保存DBコピーを隔離XDGで渡し、260 entitiesのSessionを実TUIで再開した。
PageUp/PageDownで履歴と末尾を往復し、76×24から110×36へのresize、保存tool結果を含む次taskの local
provider adapterへの到達とcanonical採用、私用Core再起動後の同一会話復元、connected/standalone
history一致を確認した。local HTTP 1 request、実provider 0。初回会話のcanonical
hashを新版比較に使い、 process-local
cutは再起動比較から除外する。実DB・実config・稼働Core/TUIは変更していない。 証拠:
`.tools/increment-199/before-saved-final-saved-tmux-result.json`。

### Slice 5実装・比較結果

`/context`は既存latest request metadata
queryを直接使う。artifactはadmissionと最新metadataだけを選び、 effectsはsemantic
`effect_observation/tool_call/tool_result`だけを読む。recallは必要なjournal/provider eventsとpartial
stateを一度取得し、同じeventsからeffectsを導出する。既存の全文event件数はscalar集計で保つ。
全文contextはcontext deltaとその依存だけを先に選び、明示的な全request/本文/relationsを維持した。

選択requestは最初のmatching deltaの保存ordinalまでのspliceを適用し、過去cutのrelation数を累積する。
過去cutごとの全sequenceやrelationOrdinals配列は保持せず、sequence
mapをin-place更新し二つのpassで再利用する。 selected
cutだけで本文read/base64/items/transcriptを生成する。semantic record IDとdeltaのoccurrence IDの
違いをfocused確認で検出し、metadata lookupをpayload occurrence IDへ修正した。

親は最初の候補に残った「全文contextの全events経由」と「effectsの全runtime events経由」を検出した。
保存executionではeffectsに使わないassistant_message 1,930件/約10.44M文字を読んでいたため、
計画内の必要kind先選択へ修正した。旧sourceを維持する理由には扱っていない。

同一保存入力の11返値は、本文・順序・帰属・relation採番・provider facts・artifact・recallを含む
canonical JSON bytes/hashが全てbaseline一致した。全体readの情報は狭めていない。

| 読取                   | JSON.parse対象 UTF16単位（旧→新）    | 備考                                          |
| ---------------------- | ------------------------------------ | --------------------------------------------- |
| `/context`             | 425,776→2,577                        | latest metadata直接                           |
| artifact全体           | 23,428,515→72,473                    | 全返値77,470bytesを維持                       |
| effects                | 11,738,535→425,641                   | 不要assistant/model/contextを読まない         |
| 全文context            | 23,911,086→12,404,502                | 全返値42,395,239bytesを維持、SQL実行2,702→355 |
| request 1/27/54        | 各23,911,086→165,746/441,149/631,066 | 後続requestの本文加工なし                     |
| provider facts 1/27/54 | 各11,738,535→48,919/48,941/48,941    | 選択provider ordinalだけ                      |
| recall                 | 621,971→209,467                      | events/effects再読なし                        |

focused57件・担当type/format/lint/diff check pass。親のread全7返値hash、headless
streamのcanonical/terminal/ artifact全体/reopenもbaseline一致した。公式build
scriptの私用出力`henji.slice5`で実診断CLI request1/27/54、
context全体、events全体の5返値hashも一致した。request CPUは旧約0.48秒、新0.11–0.15秒だったが、
単回・他確認と並行した値で性能保証/成功条件には使わない。 証拠:
`.tools/increment-199/selected-slice5-final.json`、`read-slice5.json`、`stream-slice5.json`、
`slice5-compiled-reads.json`。

私用compiled Core/TUIでは、headless実行途中attach、二つのTUI、detach/reconnect、次task、cancel、
recallの一回消費→ordinary request、Session view/resume、connected/standalone
history一致の10確認がpass （local6
requests、実provider0）。長い保存Sessionでも初回会話hash、初期/PageUp/76×24 resizeの
三画面が旧版と一致し、110×36への復帰、保存tool結果を使う次task、Core再起動後の同一会話復元、
history一致がpass（各run local1 request、実provider0）。
最初のresize比較ではtmuxの行数変更直後に旧frameをclipした画面を採取していたため、
新サイズの末尾にready/model footerが実際に届くことを待つ観測へ修正した。product
bugとして採用していない。 証拠: `.tools/increment-199/slice5-final-tmux-result.json`、
`{before,slice5}-saved-stable-saved-tmux-result.json`と同名のinitial/page-up/resized pane captures。

25分上限の独立read-only reviewは、latest選択順・過去splice/採番・selected本文限定・producer kindとの
対応・artifact由来・明示full read/直接CLI consumerを確認し、必須findingなし。Slice5を完了した。
Slice6の安定候補で統合境界の独立reviewと一回のauthoritative gateへ進む。

### Slice 6統合review・修正・最終実経路結果

25分上限の独立read-only reviewで、通常terminalのmetadata保存前に全semantic
payloadを読む残存経路（P2）と、 実consumerのない旧全文artifact write
adapter（P3）を検出した。親が両件を計画内の撤去対象として採用し、
保存時/明示artifact導出で共通のlatest metadata一件queryを使う形へ修正した。
`executionArtifacts.write`とそのcontract/adapterを撤去し、list/readは維持した。
その他のCOMMIT後suffix移管・解放、snapshot/delta引渡し、one-shot/最後unsubscribe、保存再開、
context/recall/診断CLI接続に必須findingなし。一回限定15分以内のre-reviewで両件解消・追加必須findingなし。

同じ大量保存executionに同値metadataを保存する入口で、JSON.parse 2,540回/11,689,980 UTF16単位、 SQL
2,541回→JSON.parse一件/23,452単位、SQL二回となった。通常terminalが使う同じ保存入口であり、
比較自体は保存済みmetadataの同値skipを測定している。artifact全77,470bytesの前後/旧新hashは一致。
通常terminal appendはfocusedで確認し、stream probeの採用時parseも4回/6,602単位→1回/141単位となった。
修正focused4件・type/format/lint/diff check
pass。初回複合focusedのDataService取消は単件/複合再実行でpassした。 証拠:
`.tools/increment-199/metadata-{before,after}6.json`、`stream-final-fixed.json`。

最終私用binary `henji.final-fixed` を公式build scriptで作成し、変更sourceをfingerprintで固定した。
保存read11返値、compiled診断CLI5返値、canonical/terminal/artifact/reopen
streamの全hashがbaseline一致。 専用tmuxのheadless途中attach・2TUI・detach/reconnect・next
task・cancel・recall一回消費・Session view/resume・history一致の10確認がpass（local6
requests、実provider0）。
長い保存Session260entitiesの会話hashと初期/PageUp/resize三画面も旧版一致、次task/Core再起動/historyがpass
（local1 request、実provider0）。証拠:
`.tools/increment-199/selected-final-fixed.json`、`final-fixed-compiled-reads.json`、
`final-fixed-tmux-result.json`、`final-fixed-saved-saved-tmux-result.json`、`final-fixed-runtime-source.json`。

最初のgate途中に、診断用DBコピーの蓄積で`/tmp`容量不足を起こした。終了済みの私用コピー10ディレクトリを
`.tools/increment-199/temp-archive/`へ移し、実DB/dataは変更していない。以後のcompiled確認はworkspace内の
私用TMPDIRで行う。最初のgateは容量不足後のhistory-init待機を中断し、HTTP143/144/145/149をfocusedで
切り分けて8件passした。別に120のfixture移行漏れ（旧canonical全文をsuffixへ残したもの）を修正し、
103の既存文書変更39974dccに追随していない文言固定test一件を撤去した。baselineで120 pass/103
failを確認し、 修正後focused10件pass。製品機能や文書をtestへ合わせて狭めていない。
terminal/adapter修正・上記切分けとfixture対応後の安定候補に、理由を記録してauthoritative
gateを再実行する。 最初の中断logは`final-gate.log`、安定候補logは`final-gate-stable.log`。
安定候補のauthoritative `v0:gate` はtype check・format・lint・全testを完了し、672 pass/0 fail（test
1m43s）。 gate完了後もruntime fingerprintに変更なし、`git diff --check` cleanを確認した。

### local実装・検証の完了状態

承認済みSlice1〜6の実装・同一入力比較・focused・独立review対応・最終compiled実経路・gateを完了した。
wire選定はfull
current-valueを維持し、条件付き4bは不採用で確定。未接続adapterや未解消採用findingはない。
メモリ値を合否条件にせず、実consumerへ必要な結果を渡すまでの重複所有・全文読取・不要生成/通知を撤去した。
通常利用の課題候補を全て解消したという意味ではなく、採用範囲外の候補は通常利用メモに残る。
local検証完了時点ではcommit・push・公式常用build/配置・release・実provider
callは行っていない。source commitの追加承認と完了記録は末尾を参照する。実稼働Core/TUI、実DB/config、
構想/architecture/roadmapの正本は変更していない。並行Increment200と既存の191-result.json/__pycache__を維持した。
次の変更権限は利用者の指示に従う。

### 完了後の隔離メモリ計測（2026-10-06）

利用者の「隔離環境で、メモリ使用量を計測できる？」を受け、199着手前の私用binaryと修正済み
`henji.final-fixed`を同じ保存DBコピーで各3回起動した。順序は旧/新、新/旧、旧/新とし、同時起動しない。
HOME/XDG/DB/Core/TUI/tmuxをrunごとに隔離し、workspace内の私用TMPDIRを使用した。
保存Sessionはe4e0c7ce、初回260 entitiesで、初回会話hashと初期/PageUp/resize三画面は全6runで一致。
次task・Core再起動後復元・history一致も全run pass。各run localhost
provider短い応答1回、実provider0。
常用配置や実稼働Core/TUI・実DB/configには触れていない。新版binaryには並行200のpromptGuidelinesも含まれる。

`/proc/<pid>/smaps_rollup`を外部から読み、各状態で2秒待機後、0.4秒間隔5sampleの中央値を取得し、
さらに3runの中央値を集計した。全体では0.1秒周期のsampleも保存した。強制GC・runtime
instrumentationなし。 以下はMiB単位で、Coreは同一process内のData/API/Agent
Workerを含む。raw結果の`data199a`はtmux上の TUI process名であり、Data
Worker単体ではない。PSSは共有ページを按分、RSSはprocessごとの常駐ページ全体。

| 状態                        | Core PSS 旧→新 | Core RSS 旧→新 | TUI PSS 旧→新 | TUI RSS 旧→新 |
| --------------------------- | -------------- | -------------- | ------------- | ------------- |
| 保存Session再開、会話read前 | 161.0→116.0    | 169.2→124.2    | —             | —             |
| 保存会話表示後              | 146.8→134.3    | 173.9→161.8    | 60.5→61.6     | 83.2→84.0     |
| Page/resize後               | 146.7→134.3    | 174.1→161.9    | 62.9→63.6     | 85.6→86.1     |
| 次task完了後                | 158.5→152.3    | 186.4→180.8    | 63.1→63.5     | 86.1→86.7     |
| Core再起動・再表示後        | 158.3→115.0    | 184.0→141.0    | 60.4→61.6     | 83.0→84.4     |

この入力/待機時間ではCoreの差を観測し、会話表示前で約45MiB、表示後で約12MiB、task後で約6MiBの
PSS減となった。TUIには大きな減少がなく、PSS約61〜64MiB、RSS約83〜87MiBだった。 再起動後の旧Core
PSSは126.6〜158.8MiBとばらつきが大きく、新版は113.6〜115.1MiBだった。 Data
Worker単体の内訳、長い実provider
streaming、長時間idle後の変化、全環境への一般化はこの計測では確認しない。
メモリ削減を完了条件へ追加せず、承認済み処理最適化の結果指標として記録する。 証拠:
`.tools/increment-199/memory-199-summary.json`と`memory-199-{before,after}-{1,2,3}-saved-tmux-result.json`。
診断programは同directoryの`memory_saved_probe.py`と`memory_compare_runs.py`、production
sourceは変更していない。

### 利用者の完了承認・source commit（2026-10-06）

利用者は隔離計測の結果を確認し、「微減かもしれないけど、処理が効率的になったと思う 完了とする
コミットをして」と完了承認・source commitを指示した。
メモリ値を目標にせず、必要な処理から重複所有・不要な読取/生成/通知を減らした今回の採用範囲は完了とする。
Increment 199のsource・test・採用項目の移設・結果記録を本commitへ保存する。 並行Increment
200とその他の未採用観測はcommitへ含めない。
常用配置・push・公開/releaseは今回の指示に含まれず、実施していない。

### A28全体の完了判断（2026-10-06）

利用者の「A28も完了でいい」により、通常利用時のメモリ・処理調査の候補A28を完了とする。
194のTUI待機loop、195の保存会話復元、196のrequest metadata読取、198の可視領域起点のTUI加工、
本incrementのData Worker処理最適化を採用・実装・確認済みであり、通常利用メモからA28の一覧・本文を除いた。
メモリの固定目標を達成条件とせず、必要な処理から重複所有・不要な生成・読取・通知を減らす方針は維持する。

原観測・実測・比較・旧検討案は[移設したA28記録](increment-199-a28-observations.md)へ保存した。
native memory全体の内訳や長時間のAgent実行など、未確認の事項を解消済みとはしない。
これらの追加調査・別方式比較は今回の完了に必要な残作業とせず、具体的な利用上の問題が出た場合に
改めて採否を決める。新しい実装、計測、provider call、配置やProduct正本の変更は行っていない。
