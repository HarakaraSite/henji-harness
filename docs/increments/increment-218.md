# Increment 218 計画・本実装結果 — 最新contextの予算管理と長時間実行の状態保持

## 現在の状態・権限

2026-10-09現在。利用者の「まず計画を立てようか」に基づくスパイク前の計画を通常レビュー・批判的レビューに
付し、両者とも「方針として進める」、必須修正なし。続く利用者指示で隔離スパイクを承認し、
新しい隔離DB・localhostによる実装・測定・照合と結果reviewを完了した。
次の利用者指示で本実装計画を第11節へ具体化し、8スライスへ分けた（第11.8節）。
本実装スライスの通常/批判的reviewはともに「要補足で進める」。共通P2と実装具体化事項を
利用者指示で反映した（第11.10節）。続く利用者指示「では実施してください」により本実装S1〜S8を開始した。
S1〜S7の実装、S8のlocalhost統合確認・200turn×3＋保存Session再開20turn・全保存/入力照合を終えた。
localhost測定は第11.12節と[メモリ報告書](../research/increment-218-main-memory-2026-10-09.md)、
全体review指摘対応は第11.13節。続く利用者の明示許可により、実providerによる基本動作e2eを
4turnで実施し、成功した（第11.14節）。さらに最新sourceで同じSession・Workerの実provider
20turnとメモリ同時計測を一回実施した（第11.15節）。続く利用者指示で実装・test・結果を
commitした（第11.16節、`38eb2423`）。続く指示で、同commitの最新版を昨日と同じlocalhost負荷で
200turn一回再測定した（第11.17節）。常用DB変更/配置/pushと第12節の正本変更は未承認。
以下の全体計画は本実装前の提案であり、隔離スパイクで実施した部分と未実施部分は第10節に記録する。
実行、実provider、commit/push、常用配置はそれぞれの利用者指示に従う。

入力は利用者が置き直した[引継ぎ原文](increment-218-input.md)。以前のreview用contextと
単体コピー診断の提案は今回の作業指示へ含めない。
要求・範囲・計画・今後の結果の正本は本書。構想・architecture・roadmapは本計画から変更しない。
それらへの具体的な変更案と承認境界は第12節に置く。

## 1. 必要な動作と根拠

長い会話を全保存しながら、通常の連続実行・保存Session再開・過去閲覧における主要な
RAM保持と毎turn処理を、総履歴量ではなく選択context・現在turn・閲覧範囲に依存させる。
履歴A→B→…→X→Y→Zから、予算に入る最新側X→Y→Zを時系列順に渡す。

| 必要な動作 | 根拠・維持する境界 |
| --- | --- |
| 拡張可能な前置context＋最新履歴＋現在turn | 引継ぎの利用者入力方針。instruction/tools以外の注入情報と将来の要約も同じ入力容量を消費する |
| 現在turnを含めrequestごとに再選択 | 引継ぎ。tool結果・steering・前置contextの変化後も最新入力とcall/resultの因果を維持する |
| provider/model別の柔軟な予算 | 引継ぎ。容量、出力予約、履歴予算、将来のcompaction閾値を混同しない |
| 全文と途中記録をDBへ保存 | architectureのData所有・atomic adoption。canonical/non-canonical、cancel/failure、元tool引数・結果、childを維持する |
| Data/Agent/表示/registryを限定保持 | mem4/mem5では入力制限・再取得削減後も増加。引継ぎは本文に加えID/索引の全件保持も対象にする |
| 入力証跡から実送信内容を再構成 | 既存semantic履歴を正本とする方針。保存側の位置とwindow内位置を分ける |
| 再送・採用・取消・後処理を保持 | 現sourceのcommandId重複実行防止、revision/correlation fence、Data保存とHost採用を維持する |

対象外は自動compaction、要約生成、常時background要約、履歴検索tool、交換可能なContext Strategy、
DB engine置換、未承認の実データ削除、一般的hardeningである。診断の固定8ターンは採用しない。

### 基準と既存実験

着手HEADは`93e9c3448edcf78135d88b397d23c9138e0df10c`。
実験基準`6315beed73cb4c68ec46189c30e08487a83d0028`との差は文書13ファイルだけで、
実装sourceは同じ。未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`を保全する。
217までのincrementは利用者判断で完了している。

- [mem4報告](../../.tools/memory-context-causality-217-20261008/report.md)：入力を8完了turn＋現在turnへ
  絞るとピークRSS中央値505.68→379.79 MiB。ただし後半も増加。
- [mem5報告](../../.tools/memory-generation-context-causality-217-20261008/report.md)：同じ入力で毎turnの
  generation全文再取得・転送・basis cloneを省くと400.51→371.36 MiB。
  対応差−42.59/−0.82/−49.42 MiB。21–50turn傾き4.857→3.774、41–50は0.754→3.035 MiB/turn。
  200messagesの全文保持、loop開始clone、index本文copy、全文commitが残る。
- 以前の200turn試行は87turn完了、88turnで5MiB messages上限に停止。OOMや200turn完遂の証拠ではない。

旧診断worktree/binary/driver/patchはそのまま保存する。本変更へCの診断receiptや固定8turnを持ち込まない。
追加のコピー単体A/Bを計画開始の前提にしない。

## 2. 現行の実経路と変更の到達範囲

| 操作・経路 | 現在の本文/位置所有と問題 | 今回置き換える動作 |
| --- | --- | --- |
| Coreのtask→Data admission→Agent | `session_data_owner.ts:513`が全文snapshot、Agent basis適用とloop開始で全文copy | Dataから選択contextとcanonical位置を取得し、現在turnのdraftを別に所有 |
| 保存Session再開 | `sqlite_history_store.ts:743`が全message locatorを`.all()`し全文decode。`WorkerSessionOwnerState`にもtranscript | descriptor/位置のみで開き、最新側の必要範囲をkeyset取得 |
| provider request | `loop.ts:331`全文copy、requestごとの投影→snapshot→観測→生成。`worker_runtime.ts:915`全文index | requestごとに予算解決と範囲取得。選択済み本文だけをsnapshot/観測/生成 |
| commit採用 | `session_authority.ts:254`は全文件数からproposal suffixを切る。Workerは全文proposalを送り全文を保持 | current turn差分＋canonical anchor/revisionをprepare。既存Host許可・Data atomic commitを維持 |
| 実入力の証跡 | `worker_runtime.ts:1175,1269`はpreviousTranscriptLengthによるappend-only前提。`context_attribution.ts:125`のsplices型自体はdelete/insertを表せる | stable source identity付きの順序列を比較し、縮小・置換・前置変更をdelete/insertで記録 |
| Data表示の初回read/watch | `conversation_writer.ts:436`から全executionをreplayし、生成したviewをopen Session中保持 | 最近の表示page＋active execution、過去はDBから別page取得 |
| Data完了execution | `session_data_owner.ts:400,1520`で一部本文を外すがMapはcloseまで残る。Writerの`#executionSessions`も累積 | 後処理完了でregistry/索引ごと解放、後日のreadはDBへ |
| Coreのcommand/execution | `core_service.ts:349,350,891`のMap。commandId再送の結果・signatureを保持。完了executionのowner参照も保持 | active処理＋限定cache。完了receiptをDataで保存して重複実行防止とcommandReadを保つ |
| 購読/HTTP | `core_service.ts:1809`のsnapshot待機pending、`http/server.ts:340`のSSE stream、API portのsubscription map | 有限のsnapshot/pageと配送中frame。遅延時の再同期を定義し、過去全updateをRAMに溜めない |
| TUI | `keyed_conversation_store.ts:108`のrows/order/索引、`conversation_flow.ts:136`の印字receiptが表示scopeに残る | 最近のpageと未印字/可視tailに限定。過去はpage閲覧と既存terminal scrollbackで参照 |
| hook/child/headless | hookのtranscript snapshotは現在全文。childは別Worker/Executionで`releaseParent`あり。runも同じData/Agent経路 | 共通の選択context/差分保存へ接続。hookへ渡す保持範囲を明示、既存child清算を維持 |

Core/APIのqueueが現環境で何MiBを占めるかは未測定で、これらを増加の主因とは断定しない。
確認した所有・追加・解放経路を変更範囲に含める。遅い購読、hook、childに関する詳細は本実装前に
consumer終端まで追い、実際の保持先を記録する。

## 3. request入力・予算の設計案

### 3.1 前置contextと現在turn

前置寄与を、役割・順序・stable source identity・計数量を持つ有限の集合として扱う。
現在の共通base/Agent instruction/native AGENTS/Skill/runtime facts等の組立て順を維持し、
追加注入や既存checkpointの要約を同じ計数へ接続する。今回新しい要約は作らない。
tool定義は実providerが要求する独立field/namespaceへ送り、前置容量へ一度だけ計上する。
論理的な前置とAPI上のrole/fieldを同一視しない。

現在turnは、現在user、受理済みsteering、assistantの必要state、tool callと全resultの因果列。
current draftと選択済み過去本文を別に持ち、windowから落ちた過去本文をdraft/commitへ混ぜない。
現在turnの一回の巨大tool返却を受け取る瞬間の負荷は、過去履歴の常駐とは別に記録する。

### 3.2 容量・設定・計数

概念式は引継ぎの`V=min(I,C−R)`、`B=min(H,V−P−O)`、過去枠`B−K`を用いる。
Pは全前置/tool、Oはそこに含めていないwire framing、Hは完了履歴＋現在turn、Kは現在turn。
推定と実測を混ぜず、budget resolutionへ値・情報源・計数profile・保証範囲を残す。

設定はconfig rootの専用`context-budget.json`にまとめる案とする。Agent JSONのroleと分け、
共通runtimeの運用設定としてroot/child/headlessが同じresolverを使う。
優先順は **provider+modelの明示上書き → provider上書き → defaults**。未指定fieldだけを下位から補う。
容量値は明示設定→確認したprovider一次情報/route固有metadata→不明の順で解決する。
現在のmodel catalogはeffort等を扱い、context容量やoutput上限を持つ契約ではないため、
そこから容量が得られるとは仮定しない。models.dev等の第三者値は推定として区別する。
容量の自動取得のためにtaskごとの追加provider呼出しを作らない。

| 項目 | 計画案の既定/決定 |
| --- | --- |
| H | 32,768 estimated tokens。実model容量の主張ではなく設定可能な会話予算 |
| C/I不明時 | 運用上の入力予算65,536 estimated tokensを用いる。model選択は拒否しない。容量適合が推定であることを表示/保存 |
| C/Iの一方のみ既知 | 既知I、または既知C−Rを使い、Hと前置/overheadを差し引く。不明値を実容量として補わない |
| R | Chatは実送信max_completion_tokens（現既定65,536）。Responsesは現行で明示max_output_tokensを送らないため、確認済みmodel output上限か明示予約を使用 |
| ResponsesでRも不明 | 65,536を運用上の予約推定として記録。C−Rも推定扱い。新しい出力上限を黙って送らない |
| 設定反映 | 既存の起動snapshotに合わせ新Worker起動で反映。人間のidle model切替は既存経路で次turnから再解決。新reload/UIは作らない |
| 精度 | 正確な計数profileを使用できるrouteは実wire変換後の内容で計数。未知profileはUTF-8 bytes/3を基本にframingの明示推定を加える。推定を厳密token上限保証と呼ばない |

既定値は本計画で提案した運用値であり、Pi等の値の流用やmodel固有仕様ではない。
実装前に選択routeのcapacity/output/reasoning契約を一次資料または実行証拠で確認し、
使用する計数profileの対象を明記する。未確認variantを推測で仕様化しない。
今回は計画のために新しいmodel/provider容量値を外部から取得していない。

保存本文のUTF-8 byte量だけをtoken数と呼ばない。provider変換によるrole/call/result構造、
tool schema、Responses replayItems/暗号化reasoning、model/providerのprivate stateを計数対象へ含める。
JSON/base64の保存byte量とモデルに課金されるtokenの対応が不明な部分は推定fieldへ分ける。
provider usageはrequest後の照合に使い、事前計数の厳密さを後付けで主張しない。

### 3.3 選択と収まらない場合

各request前に、前置/tool/現在turn/selectionを計数し、最新完了turnから連続suffixを選ぶ。
因果単位はまず完了turn全体とし、一つ前のturnが残量に入らなければ、さらに古い小さいturnへ飛ばない。
空の過去windowも有効。現在turnのtool call/resultを切らず、選択後は時系列順に送る。
tool結果追加後は過去windowを縮めてよく、同件数で内容が変わる場合も証跡へ反映する。

DBの軽量候補metadataをkeysetで有限page取得し、全ID/sizeの配列を作らない。
候補を一つずつ計数/materializeし、選択範囲と一つの判定候補以上の過去本文を同時に保持しない。
必要な計数cacheは選択範囲と同じ有限scopeへ限定する。profile別の既存costがない履歴も、
最新候補からlazyに計数し、全件のJSON化/再計数を再開条件にしない。

入力budgetを確認してから、選択済みrequestのsnapshot→観測→生成へ進む。
DB取得が必要になるので、現在同期的なprojectorへ無理に全文を渡さず、request準備境界に必要な
非同期取得を置く。取消/steering/物理request相関を同じ共通loopで維持する。

**予算不足時の提案動作**：必須前置＋現在turnが収まらないなら、そのmodel requestを送らず、
通常のexecution失敗として`context_budget_exceeded`相当の理由を表示・保存する。
不足がtoken推定/確認済み容量/既存5MiB messages/6MiB bodyのどれかを区別し、
変更できる設定・modelと保存済みexecutionへの入口を人間に示す。
受理済みuser/toolの元本文はnon-canonicalに全保存し、canonical revisionは進めない。
最新入力の脱落、tool結果の黙った省略、DB削除、自動要約、自動model切替は行わない。
次の試行で人間が予算/model/taskを変更できる。初回taskの表示・draft扱いは既存の失敗経路に整合させる。

過去の選択量を縮めれば既存byte上限に入る場合は古いturnから外す。
現在turn単体がbyte上限を超える場合も上の動作とし、上限引上げを対策にしない。
byte制限通過とtoken適合は別に判定する。

## 4. 保存位置・差分commit・証跡

### 4.1 全文の正本とcanonical anchor

全文は現在のnormalized SQLiteのcontents/messages/session_turns/conversation_messagesへ保存する。
DataはsessionId、canonical revision、nextTurn、全体message count、末尾execution位置等の
小さいanchorとactive journalを持つ。window長から総件数を推測しない。
保存Sessionはmetadata/anchorで開き、モデル入力も閲覧も必要な範囲だけDBへ問い合わせる。

Agentは選択context・現在draft・対応するstable locatorを持つ。採用後も過去全文へ戻さない。
新turnの差分proposalには、base anchor/revision/correlation、current turnの新messages、
outcome/evidence manifest/final sequence等、採用に必要な情報だけを含める。
Dataはadmissionのbaseと照合してprepareし、Hostのcancel/child/process清算判断を経て
既存のtransactionでsuffixとcanonical位置をatomicに採用する。
failure/cancel/途中保存は引き続きnon-canonical。採用された差分をwindowへ無条件appendして
将来の全文常駐へ戻ることも避け、次requestで選び直す。

### 4.2 証跡の置換

sourceはcanonical session/turn/execution/messageのstable locatorで表し、
window内indexはrequest上の位置だけに使う。過去を落としても保存位置を振り直さない。
前置寄与にもstable sourceを付ける。privateStateFromTurn/checkpointは全体turn番号で解決する。
全文indexを復元して境界を探す方法を外す。

現在のdelta型が持つdeleteCount/insertionsを用いる案を第一候補とする。
producerのpreviousTranscriptLengthによる単純slice/append-only検査を置き換え、
直前の有限request列と現在列の差を記録する。保持されたoccurrenceを再利用し、変わった
位置/本文/前置/tool contractは置換として扱う。revision digestとmanifestの照合を保つ。
Data保存・読取・export・context表示まで再構成し、producerだけで完了としない。
既存schemaVersion 2で表現できるなら新しい証跡形式/互換層は増やさない。

RAMのevidence状態は現在executionの有限request量、直前列、stream中の未保存batchへ限定する。
全Sessionのsource/digest/occurrence索引を追加しない。保存済みrequestはDBから再構成する。
推定予算、選択範囲、selected/current/prefixの量を短いrequest factへ結び付ける。
raw request/SSE/parser全文やcredential値/Authorizationは常設保存しない。

### 4.3 hookと後処理

after_turn、post-settlement hook、runtime_stop、child/process清算、journal flush、terminal公開の
順序を追い、必要consumerが終わるまでactive stateを残す。
runtime_stopが最新settlementを必要とする場合は最新1件を保持するかDBから参照し、全executionを残さない。
無期限の「小さいDB参照Map」で置き換えない。

hookの現transcript snapshotは全文を意味するので、bounded入力へ変える際には
**保持turnの全体位置・省かれた範囲・canonical総位置**を明示した契約へ変更する案とする。
選択windowを全文と偽って渡さない。共通hook API・同梱external hook・公開文書を同じ変更へ含め、
既存hookの実使用を確認して契約案を確定する。今回履歴検索toolは追加しない。
この変更で利用者の必要なhook動作が成立しない場合は具体例と選択肢を戻す。

## 5. RAM保持・閲覧・command receipt

保持上限はproductの入力を勝手に削る制限ではなく、選択/表示/callbackのcache配置を決める。
本計画の数値は計測条件と初期実装案であり、実利用に必要なpayloadをDBへ全保存する。

| 所有者 | 保持するもの・初期案 | 解放/過去参照 |
| --- | --- | --- |
| Dataの生成用本文 | 選択window＋active draft/journal＋判定候補1turn。取得metadata pageは64turnまでのscratch | model/window変更で不要本文/計数cacheを解放。古い本文/位置はkeyset DB read |
| Agent | 前置集合＋H内の選択/現在turn、直前request/evidence。model/profile切替で不要cacheを外す | settle後は現在turnの必要consumerだけ、次turnで新windowを取得 |
| Data execution/Writer索引 | active、settling、hook待ち、最新settlement。完了read cacheは最大32件・合計2MiB案 | consumer完了でentry削除。過去executionはSQLite read |
| Core | active command/execution/slot/subscriber、最新control状態。完了cacheは最大32件・合計2MiB案 | receipt/実行stateはDB、owner/Promise/本文参照を切る |
| Data表示/各Surface | 最近の完了execution page、active entry、閲覧中page。page初期値は完了50executionか本文2MiBの小さい方 | window外entity/normalizer/order/印字receiptを削除。DB pageまたはterminal scrollbackへ |
| API/TUI配送 | initial/current pageと配送中の有限buffer。初期byte予算は2MiB＋一つの合法なframe | snapshot待機終了でqueue解放。遅延時は最新pageへの明示resyncを行う |

一つの合法なmessage/entityがpage目標より大きい場合は、DB上の全文を一括でcacheへ載せず、
本文detailをchunk取得する。要約して元本文を置き換えない。active tool/resultの既存利用を狭めない。
これらの表示/配送上限で正常なtool結果やrequestを拒否しない。

過去閲覧は、最新tailと過去pageの区別・cursor・前後page有無を公開APIへ持たせる案。
既存の履歴閲覧入口とTUI操作へ接続し、過去へ進む操作で前pageを解放する。
全履歴export等はstream/chunkで全件を出力できるようにし、通常viewのcache上限をexport件数の上限にしない。

購読は公開revision/cutを維持し、遅延時にdropしたdeltaを適用済みとして見せない。
再同期を知らせて有限snapshotを取得する。既存HTTP切断は購読解除でありexecution取消ではない。
SSEの実backpressureとsnapshot先行updateの所有を追って方式を確定する。
正常な更新、再接続、過去page閲覧をtmuxのproduction TUIで確認する。

### commandIdの重複実行防止

Coreの`commands`を単純LRUにすると、同じcommandIdを再送したときに新しいtaskを実行してしまう。
現行Core epoch内のsignature比較、commandRead、同じ結果の再送を維持するため、
active中はCoreが所有し、完了receiptはDataへ保存して限定cacheから外す案とする。
receiptはcoreEpoch+commandIdをidentityにし、operation/signature digest/result/対応execution等を保存する。
Core終了後のcommand再実行保証を新設する意味ではない。
保存前にentryを捨てず、再送照合と完了保存の順序を定義する。
DB参照を非同期にする際も、同じcommandIdのactive PromiseをCoreへ同期登録してから参照し、
並行する二つの再送が別々にworkを開始しないようにする。既存のslot予約・admission/cancel順を保つ。
accepted/rejectedというcommand結果を保存完了してからcacheの退避対象にする。
future follow-up/steering/controlの小さいfactも後日readに必要な情報を保存し、
完了executionのownerやrequest Promiseへ参照を残さない。

## 6. DB変更と既存データの扱いの提案

既存のcontents/messages/canonical linkは再利用し、engineはSQLiteのまま。
範囲取得は既存のsession/turn/message keyでkeyset化する。
必要な補助index、core command receipts、完了control readbackに必要な小さい列/tableを追加する
**本実装schema 3案**とする（スパイクschema2とは構造を区別する。第11.7節）。計数cost tableを作る場合はcontent digest＋計数profileで導出値を区別し、
選択範囲をlazy計数する。全履歴のbackfillを通常起動や再開の条件にしない。
具体的table/column/APIはスパイクで最小化し、結果を基に第11節へ本実装案を詳細化した。

スパイクは新しい隔離DBだけを使う。既存schema 1を上書きしない。
本実装の旧data確認は、明示承認された一貫したDBコピーへ追加schema変更を行う案とする。
変換は既存のrecord/content/digest/ordinalを保持し、新tableは空で始める。元DBは保全する。
暗黙のon-open migration、dual-read/write、旧形式fallback、元fileの削除は作らない。
schema切替と既存DBコピーへの変換の採用は、本計画の未承認の具体的選択肢である。
未承認のまま常用DBを開き直したり配置したりしない。

コピー変換を採らない場合も、新schemaで保存したSessionの再開はスパイク/本受入で確認する。
既存schema 1のSessionを最新版で継続する利用要件は、変換方式を採用するまで未完了として残し、
旧binaryだけで閲覧できることをその代替の完了条件にしない。

## 7. 隔離スパイク

### 7.1 仮説・範囲

実DB→Data→Agent→差分保存の経路を通し、最新入力、全履歴、atomic adoption、正しい証跡を同時に保ち、
対象本文/metadata/完了registryを保持範囲へ収められることを確認する。
prototypeはroot 1 Session/1 Agent、既存localhost read負荷だけ。会話表示全体、全provider/child、
設定UIは完成対象にせず、本実装へ残す。selector単体fixtureの成功だけで成立としない。

計画承認後、新しい隔離worktree/XDG/workspaceとDBを用意する。
基準は現在HEADの実装source、旧診断patchは保全し混ぜない。
prototype patch、実source/binary SHA、builder/flags、driverと入力設定を保存する。
実providerを使わず、localhost endpointにmodel budgetの異なる二つのsynthetic modelを宣言する。

### 7.2 実装する一本の経路

1. Sessionをanchor/metadataで開き、keyset candidate取得と予算resolverから必要本文だけを取得する。
2. loopのrequest準備を選択context＋current draftへ変え、tool結果で過去windowが動くようにする。
3. window/prefixの変更を表す証跡とstable sourceを保存し、各requestを再構成する。
4. current turn suffixをDataへprepareし、既存採用判断とatomic adoptionで全保存する。
5. after_turn等のconsumer完了後、Data/Writerの実行entryとAgentの不要状態を解放する。
   Coreの未変更registryを残す場合はその件数を別記し、Core全体の改善と呼ばない。

この順は依存順で、公開型/APIを先に固定する指示ではない。
成立に必要な共通protocol/保存処理はprototype内で整合させる。
失敗したらどの入力/保存/証跡/解放が破綻したかを報告し、目的を狭めて通過扱いにしない。

### 7.3 観測条件案

| 項目 | スパイクで確認する条件 |
| --- | --- |
| 長さ | 新規Sessionで200turn連続、その保存Sessionを別Core/新Workerで再開して20turn。main runは1回 |
| 負荷 | 512行、read全文59,282 bytes、OK 2bytes、通常2物理request/turn。旧driver/providerを再利用して新契約の照合を加える |
| 予算 | H=32,768、synthetic C=131,072/I=65,536、Chatの実送信R=65,536。計数profile/overheadを保存する。実model容量の主張ではない |
| request選択 | read結果追加後に同turnの過去windowが縮むことを短い実経路確認で先に示す。縮小/同件数置換の証跡を照合 |
| 別予算/前置 | 短い別scenarioで人間のidle model切替、起動instruction追加＋保存Session再開を使う。追加前置と現在turnを計数、反映時点を既存経路で確認 |
| 現在turn不足 | 同負荷を意図的に小さいHへ設定して実行し、providerへ超過requestを送らず元readをnon-canonicalに全保存することを確認。main成功runへ混ぜない |
| 会話閲覧 | mainは会話snapshot/watch/TUIを開かない。未変更の全会話projectionを測定経路へ混ぜず、未確認範囲を明示 |
| 待機/時点 | 通常settled+0.2秒。1/5/10/20/50/100/200後は合計2秒、起動計2秒。最終+2秒で終了。30/60秒/強制GC/heap snapshotなし |
| sampler | Core外/procの20ms設定、実周期も保存。Core起動後Session前、Session後会話前、20/50/100/200のRSS/PSSとmain/Data/Agent/API heapを記録 |
| 最大/傾き | 会話中最大、起動含む最大、最終+2秒を別集計。turn+0.2秒系列、10turn区間、51–100/101–200傾きと50→200の区間peak差を報告 |
| 停止 | 開始前のMemAvailableとcgroup headroomから、7GiBと空き半分の256MiB切下げの小さい方をCore+TUI RSS停止値として保存。製品上限とは別 |
| その他 | Deno/公式builder/追加V8 flagなしは前回条件。途中Worker再起動はしない。再開確認だけ別runとして区別 |

軽いcounterは、DB本文read件数/bytes、候補metadata page件数、Data/Agent本文message数/bytes、
active/settled registry/索引数、current draft/選択/evidence量、proposal message数、全件取得/走査回数。
新しい全文clone/hash/JSON化を観測のために追加しない。
重いcanonical/Agent/input/source/元read照合はsampler停止後に外部readonly DBで行う。

短いscenarioの具体的task/model名・prefix量は実装後、主計測前に設定を固定して保存する。
小予算で正常readまで拒否することをmain負荷の仕様へ逆輸入しない。

### 7.4 スパイク成立判定

全turn保存、実入力/source/evidenceの一致、予算内の最新連続suffix、現在tool因果が成立すること。
200turn＋再開20turnが成功し、全件本文/ID配列を通常起動/毎turnへ展開する旧経路が外れていること。
対象のregistryは定めたactive/consumer/cache範囲へ戻り、履歴総件数に比例して増えないこと。
DBの記録増加は必要な全文保存として許容する。

RSS/PSSは補助的に残す。未変更のCore receipt/表示等があるprototypeではCore全体の増加停止を
成立条件と呼ばず、残りのsource-to-stateを本実装へ渡す。
対象経路のstate上限が成立しない、全文取得が残る、または保存/入力/証跡が破綻すれば要再検討。
結果を本書へ追記して、本実装計画の型/保持/DB変更を確定する。

## 8. 本実装の順序と受入

スパイク成立後に結果を使って詳細化する。計画段階でroot専用の最終設計へ固定しない。

1. **共通保存/生成**：range読取、budget resolver、current draft、suffix commit、置換証跡、
   checkpoint/private stateの全体位置、hook/terminal consumer完了を共通Data/Agentへ実装する。
2. **Core/完了索引**：command receipt/control factのDB参照、bounded cache、owner/Promise/registry解放。
   親childのcleanup/release、headless run/CLI drain、cancel/failureにも適用する。
3. **閲覧/購読/TUI**：有限page、keyset再取得、entity/normalizer/印字索引の退避、配送再同期。
   旧全view loadと各all()/全文snapshot利用を、使われなくなる処理も含めて除く。
4. **実運用と受入**：設定反映・既存DBコピーの再開・child/明示hook・過去閲覧を確認し、長時間推移を記録する。

テストは変更後の実経路が成立した後に、以下の具体的動作へ対応する最小の確認を追加/修正する。
旧testの全文常駐/append-only/全view前提を新機能の仕様へ逆輸入しない。

| 確認 | 目的と経路 |
| --- | --- |
| inputとwire | 直近連続suffix、前置、model別予算、現在read、reasoning/stateの適用範囲を実adapterの変換と証跡で照合 |
| 保存/採用 | actual Data/Host経路でsuffix採用・revision照合、cancel/failure/途中/non-canonicalを全保存 |
| window置換 | tool結果後の縮小、同件数の差替え、前置変更を保存deltaから完全再構成 |
| 再開/旧data | 保存Sessionを全件RAM展開せず再開。承認された旧DBコピーの元記録と位置を保つ |
| state解放 | after_turn/runtime_stop/child/process/CLI drainの必要consumer完了後のentry数、古いexecution/commandReadのDB参照、cache退避後と並行再送でcommandIdの二重実行を起こさないこと |
| 閲覧/配送 | 最新tail、過去page、再接続、SSE snapshot先行更新、通常cancel/draftをproduction TUIで確認 |
| 共通経路 | headless run、Core root、実際に共通処理を使うchild、明示hookのbounded context契約 |

実装中はfocused test/type check/fmt/lint/diff check。review前full gateは要求しない。
安定候補にauthoritative `v0:gate`をcoordinating ownerが一度実行する案とする。
実provider確認は将来の最小route/count/保存先を具体化して明示承認を得る。今は呼び出さない。
ローカルmockだけで実providerのtoken容量/continuation品質確認を完了扱いにしない。
TUI変更は隔離XDG・tmux110×36のproduction操作で確認し、操作/観測を本書へ残す。

### 長時間受入の提案条件

本実装候補は同じlocalhost負荷を**200turn各3回**、同一条件のCore/TUIで連続実行する。
各runで新Core/Session/state、main内は同じAgent。20/50/100/200で外部RSS/PSSとcontext heap、
各turn+0.2秒、会話中最大、最終+2秒、10turn区間、51–100/101–200傾きを記録する。
全3回の重い照合は採取後。旧A/B単体コピー比較は追加しない。
別の保存Session再開・過去閲覧操作はその同じデータを用いる別区間で確認し、mainピークへ混ぜない。

まず全3回で全文保存/予算/最新入力/証跡とstate件数・本文の有限保持が成立することを必須とする。
memoryの初期判断線は、101–200turnのCore RSS/PSS傾き中央値がそれぞれ**0.25MiB/turn以下**、
51–100区間から151–200区間へのCore peak RSS/PSS増分中央値が**64MiB以下**とする案。
これは当該負荷で従来の数MiB/turnの継続増加を大きく減らす目標で、製品の停止上限ではない。
各runの範囲/傾きも必ず報告し、中央値だけで一回の大きな増加を隠さない。

判断線を超えた場合は、stateが範囲外へ累積するなら未達として修正対象を特定する。
stateは収まるがnative/allocator/共有page等が増える場合も、観測した残量・source/時点と
必要な追加確認を示して受入判断を利用者へ戻す。gate通過だけで完了としない。
閾値を通すために正常入力を狭め、本文を削り、強制GC/Worker再起動を入れない。
RSSが数学的定数になること、全provider・任意巨大turnで同じMiB上限になることは主張しない。

## 9. スパイク前/本実装前の確定事項と正本変更案

この計画でreview可能な選択肢まで具体化した事項は次のとおり。

| 判断 | 現在の提案 | 確定時点 |
| --- | --- | --- |
| 予算不足の人間向け動作 | 当該request送信を止め、全文non-canonical保存＋理由/調整先を表示 | スパイク計画承認時 |
| 予算運用値/未知model | H32,768、未知入力65,536、推定profile。未知modelの選択拒否なし | スパイクで影響を観測、本実装前に既定を確定 |
| DB切替/旧data | spike schema2、本実装schema3案、元DB保全、明示されたコピーだけ追加変換 | スパイクは新DB。旧dataの変換方式は本実装/運用承認時 |
| hookの全文契約 | 保持範囲と全体位置を明示するbounded snapshot | 実使用確認とスパイク結果から本実装前に確定 |
| 保持数・memory判断線 | 上記cache/page、200turn、RSS/PSS目標を初期案として採用 | スパイク結果で合理的な修正理由を記録、本受入前に固定 |

構想のWhyと人間の採用境界は変更しない。
architectureには、全文proposal/全文Session stateをanchor＋差分＋必要範囲へ改めること、
表示/consumer lifetime、hookの保持範囲、command receipt保存、DB版切替を反映する変更が必要になる。
roadmapには、最新context予算とbounded Data/Agent/閲覧が今回採用された範囲であることを記録し、
自動compaction/外部Context Strategy/履歴toolを未実装・対象外として区別する変更が必要になる。
architecture/roadmapの実際の修正は、対象・理由・意味上の変更を別途提示し、利用者の明示承認後に行う。
A3の将来戦略全体を採用済みへ移さない。通常利用メモの既存候補は今回そのまま保持する。

隔離スパイクの結果は第10節、本実装の具体計画は第11節。次の一手は、本実装の着手判断と正本変更の別途承認。
この承認を本実装・常用DB更新・正本更新・配置の許可と扱わない。

## 10. 隔離スパイクの結果（2026-10-08）

**隔離スパイクは成立した。本実装の完了・Core全体のメモリ頭打ちを示す結果ではない。**
同じCore・Session・Agent Workerで200turnを完了し、そのCoreを終了した後、同じ保存Sessionを
新しいCore・Agent Workerで再開して20turnを完了した。全220turn・440物理requestの保存と入力照合が通った。
通常checkoutの実装source、常用DB/config/binaryは変更していない。実provider callは0回。

### 実装した経路

作業treeは `.tools/increment-218-spike/source`。着手HEADは
`93e9c3448edcf78135d88b397d23c9138e0df10c`。本番のSession開始・task submit・Worker・Chat adapter・
read tool・Data保存経路を使い、providerだけlocalhostの決定的な応答へ置き換えた。

- DataのSession開始/再開はanchorと件数を返し、canonical本文・全件ID配列を常駐させない。
  完了turnのexclusive keyset範囲読みにより、最新側の候補を1turnずつ取得する。
  metadata取得内部のmodel変更全件走査とexecution件数走査も除いた。
- Agentは現在turnのみ保持し、各request直前に、予算に入る最新の連続した完了turn suffixを選ぶ。
  tool結果が増えた場合も再選択し、現在turnのcall/resultを切らない。proposalは現在turnの差分だけ送る。
- 入力証跡はstableな全体位置とsource locatorを維持し、window縮小・同数置換をdelete/insertで表す。
  既存の証跡readbackで実入力を再構成できる。DataとWriterの完了execution索引は最新1件へ整理した。
- provider/model別予算と、実Chat adapterのwire byte計測を使う。
  `context-budget.json`のfield別優先順位はmodel > provider > defaults。
  未知modelにも運用上の推定値を適用し、未知であることだけで選択を拒否しない。
  現在turn＋前置contextだけで予算不足なら、次requestを送らず全文をnon-canonical保存する。

追加した診断は各contextのheapと数値の保持件数、短いrequest予算factのみを返す。
raw request/response・Authorization・credential値は常設保存していない。
Core command/execution registry、Surfaceの閲覧cache、child/hookの全経路はこのスパイクで置換していない。

### 測定条件と停止線

公式build scriptでcompileした診断binary `henji-spike-v3`を使用した。
build IDは `7aee47792a7379172d636ece238b0cf11a92e41682fc97726ef0feaf40fbe68a`、
binary SHA256は `72be91b9247f561c34807bd610c22a55003a9dc7041598bcc5975c5076a0d144`。
[provenance](../../.tools/increment-218-spike/provenance.json)、[source manifest](../../.tools/increment-218-spike/source-files.json)、
[prototype patch](../../.tools/increment-218-spike/prototype.patch)を保存し、終了後に全hash一致を確認した。
manifestはbuild/configを含む272ファイルで、driverの1233ファイルfingerprintとは収集範囲が異なる。

新しい隔離DBを使い、旧DBの変換は行っていない。各turnで512行・59,282 byteの同じfileを1回readし、
次requestでOKを返す。1turnは4canonical messages・2provider requests。
履歴H=32,768、入力I=65,536、全容量C=131,072、出力予約R=65,536を明示した。
これは合成modelの設定であり、実modelの容量確認ではない。
推定tokenはUTF-8 wire byte/3とframingから計算し、正確なtokenizerの保証はしない。
既存のmessages 5MiB/body 6MiB制限も同時に照合した。

開始前のMemAvailableは13,183,463,424 byte（12.28GiB）、祖先cgroupに有限のmemory.maxはなかった。
実効空きの半分を256MiB単位で切り下げ、7GiB以下にする計算で、Core RSS停止線を
**6,144MiB**に設定・保存した。停止線には達しなかった。

主測定は**1回だけ**。200turn中は同じCore/Agentを維持し、再開測定のみ新Coreを使った。
強制GC・追加V8 flag・TUI/watchは使用していない。各turn完了＋0.2秒と、節目の完了＋2秒を観測した。
起動/Session開始は＋1秒。30秒/60秒待機はこの計画の測定に含めない。
外部RSS/PSSのpoll間隔は要求20ms、実測中央値23.57ms、p95 24.95ms、最大28.69ms。
再開区間は中央値22.70ms、p95 23.80ms、最大38.37ms。
重いDB全文照合はsampling停止・Core終了後に実施し、後処理の使用量を測定へ混ぜていない。

### RSS/PSSと各contextのheap

単位はMiB。RSS/PSSは同じCore PID全体の値、各heapはWorkerごとのheapUsedであり、RSSとして加算しない。
Agent Workerは最初のtask時に起動するため、会話前の値は「未起動」。heapは節目のsnapshotで、全実行中のheap最大値ではない。

| 時点 | RSS | PSS | Data heap | API heap | Agent heap | Core main heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Core起動後＋1秒、Session前 | 85.38 | 79.32 | 6.34 | 3.86 | 未起動 | 5.52 |
| Session開始後＋1秒、会話前 | 87.47 | 81.28 | 6.79 | 3.96 | 未起動 | 6.47 |
| 20turn後＋2秒 | 226.89 | 218.47 | 10.26 | 4.94 | 12.83 | 7.91 |
| 50turn後＋2秒 | 257.23 | 248.81 | 11.49 | 4.97 | 11.96 | 8.32 |
| 100turn後＋2秒 | 309.03 | 300.61 | 15.25 | 3.85 | 21.97 | 8.91 |
| 200turn後＋2秒 | 345.16 | 336.74 | 15.32 | 4.16 | 15.25 | 10.14 |
| 新Coreで保存Session再開＋1秒、会話前 | 88.12 | 81.89 | 6.97 | 3.96 | 未起動 | 5.91 |
| 再開20turn後（通算220）＋2秒 | 229.41 | 220.94 | 12.52 | 4.95 | 32.63 | 7.90 |

主200turn区間のsampled最大は**RSS 345.55 / PSS 337.13MiB**。
最後の＋2秒は**345.16 / 336.74MiB**で、20turn時点より両方**118.27MiB増**。
再開20turn区間のsampled最大はRSS 229.41 / PSS 220.94MiB。
poll間の短いpeakは取り逃し得るため、これらを厳密な連続時間最大とは扱わない。

主区間の起動を含むsampled最大も会話区間と同じだった。10turn区間peakで比較すると、
41–50turnはRSS 257.23 / PSS 248.81MiB、191–200turnは
RSS 345.39 / PSS 336.97MiBで、差はRSS 88.16 / PSS 88.16MiB。
各10turn区間のpeakは集計JSONに保存した。

各turn完了＋0.2秒のRSS/PSSに対するOLS傾きは次のとおり。

| 区間 | RSS/PSS傾き（MiB/turn） |
| --- | ---: |
| 21–50 | 1.079 |
| 51–100 | 1.016 |
| 101–200 | 0.260 |
| 151–200 | 0.090 |

後半は増加が鈍ったが、Core全体の頭打ちは未確認。
101–200の0.260は計画の初期目標0.25を少し上回り、1回・TUIなしの本測定を、本受入の3回中央値へ置き換えない。
再開20turnは別PIDの初期増加区間であり、主区間後半との傾きの直接比較はしない。
以前の固定8turn等の診断とは入力が異なるため、今回を対照A/Bの削減率として扱わない。

[時系列図](../../.tools/increment-218-spike/memory-trend.png)、[集計JSON](../../.tools/increment-218-spike/aggregate.json)、
[各節目](../../.tools/increment-218-spike/runs/main/stages.json)、[全poll](../../.tools/increment-218-spike/runs/main/samples.json)を保存した。

### 保持量と保存・入力照合

200turn後、Data/Writer完了execution索引は各1件、conversation cursorは1件。
Agentのcommitted本文保持は0件、終了時のdraft/入力証跡保持も0件だった。
requestで選んだ完了履歴は最大4messages（1完了turn）、現在turnは最大3messages。
canonical件数800は本文配列ではなく件数のcounterである。
Data範囲readは累計599回、再開20turnは60回で、履歴総量に比例する全件読取りへ戻っていない。

Coreの未変更registryには200turn後commands 201件・executions 200件が残る。
application ownerとSession snapshotは各1件だったが、1Session測定なので複数ownerの解放は確認していない。
RSSの残りをこのregistryだけに帰属させる因果実験はしていない。
V8 heap確保量・external・native allocatorの保持もheapUsedとRSSの差に含まれ得る。
Data/Agentの対象状態を限定できた証拠と、Core RSSの頭打ちの証拠を区別する。

sampling後の[全文照合](../../.tools/increment-218-spike/runs/main/post-sampling-readback.json)で次を確認した。

- 同じSessionに220canonical turns・880messages・220executionsを保存。主測定にnon-canonical executionは0件。
  全turnの元task・read引数・call/result全文・OKを照合した。
- 440requestすべてで、保存証跡からmessage/instruction/toolsを再構成し、実wireのbyte数・hashと一致。
  全体位置・source locator・window縮小/置換を維持した。
- 440requestの履歴/入力/出力予約/byte制限を照合。
  最大推定入力20,667 tokens、最大履歴使用20,135 tokensで、設定内だった。
- 200turnは同じAgent Worker、再開は新Agent Worker。同じ保存Sessionをexact選択し、
  通算201–220turnとして継続した。再開前Session開始のRSSは88.12MiBで、既存800messagesを復元保持しない経路も確認した。

### 短い機能確認と初期の修正

主測定と分離した新DBで、次の実経路を確認した。短いscenarioのRSSを主測定の対照値には使わない。

| 確認 | 結果 |
| --- | --- |
| tool結果後のwindow縮小 | 2turn/4request。入力5messages→3messagesへ縮小し、保存証跡の再構成が一致 |
| 同数のwindow置換 | 2turn/3request。過去2messages＋現在1→現在3へ同数置換し、全体位置とdeltaが一致 |
| idle model変更でHを変更 | 3turn/6request。H49,152→32,768で最新suffixを再選択。合成modelを使用 |
| 前置contextの変更＋保存Session再開 | 2turn/4request。追加instructionのwire/予算反映を確認。前置変更だけでwindow縮小する大きさではない |
| 現在turnだけで予算不足 | H8,192。read後の次requestを送らず、元read全文とfailed executionをnon-canonical保存。canonical revision不変 |

Dataの範囲取得・metadataのみ再開・差分保存・failed非canonical保持を対象にした新focused testと、
既存assistant text保存testを合わせて4件通過した。変更箇所のtype check・format・lint・diff checkと
公式compileが通過した。full gateは実施していない。

初版の予算計算は空transcriptをChat adapterへ渡し、adapterに拒否された。
provider request前の短い失敗として保存し、合法な最小user messageで前置分を差し引く計算へ修正した。
2版の短いscenarioでは測定後のverifierがDB descriptor/ordinalの形式を誤解していたため、
verifierを修正し同じ保存DBを読み直した。再測定はしていない。
最終版では予算Hと使用量のlog field衝突も修正した。
主測定の最初の起動commandはPython import時のindentation errorで終了し、Core/taskは未起動だった。
修正後、実測200turn＋再開20turnを1回実施した。これらの失敗log・初版binary/patchも保全した。

### 次の範囲と権限

本実装へ進む前に、今回の成立経路を基にCore receipt/registryの保存・限定cache・owner解放、
Surfaceの必要範囲閲覧、child/headless/hookの契約、旧DB切替と残る利用経路の計画を具体化する。
実providerの容量・品質、tmux production TUI、3回の本受入測定は未確認である。
本実装・旧DB操作・architecture/roadmap変更・commit/push・常用配置を、このスパイク承認へ含めない。

実装patch・binary・driver・verifier・設定・入力・DB・全測定factは隔離artifactへ保存した。
終了後にsource/binary/patch/manifestのhash一致と、両測定Coreの終了を確認した
（[artifact検証](../../.tools/increment-218-spike/artifact-validation.json)）。

## 11. スパイク評価と本実装計画の具体化（2026-10-08）

利用者の「結果をレビュアに評価させて」によりread-only reviewerが独立評価し、
**「承認された隔離スパイクの範囲で成立、必須findingなし」**と判断した。
immutable SQLiteから220turn/880messages/440requestを再照合し、元task・read引数・callId/result・
結果全文・OK、wire byteから再計算した予算、短scenario、source/binary hashを確認した。
RSS/PSSのpeak・最終値・OLS傾きも独立再集計で一致した。
追加測定をスパイク成立の前提にする必要はなく、残る共通経路・保持契約・受入条件の具体化へ進む評価だった。

続く利用者の「では次のステップに進めようか」に基づき、本節へ本実装計画を具体化した。
本節は第3〜9節の初期案をスパイク結果と現sourceで詳細化する。競合する数値/方式は本節の提案を用いる。
通常checkoutへの実装適用、既存DB操作、実provider、配置はまだ行っていない。
構想/architecture/roadmapは修正せず、必要な意味上の変更案を第12節へ分けた。

### 11.1 操作から結果までの確認と変更範囲

必要な利用動作は、会話を続ける、同じ保存Sessionを再開する、過去を閲覧する、
切断後に再接続する、返答を失ったcommandを再照合することである。
以下は通常checkoutの現sourceを追加確認した結果。spikeのsource確認/数値を本実装の証拠へ流用しない。

| 操作・入口 | 現owner/保存/参照の経路 | 必要な変更 |
| --- | --- | --- |
| task送信/再送/結果照合 | `core_service.ts` registerCommandはsignature文字列・state・Promiseをcommands Mapへ登録。commandReadもMapだけを読む | activeを同期登録し、完了receiptをData/SQLiteへ保存。退避後も同じ結果を返す |
| task終了/古いexecution参照 | `task_service.ts` settleはcomplete upsertをpublishし、Core execution Mapはそのownerを残す | Hostの後処理完了とcontrol保存ack後にremove。古いcontrolはDBへ |
| follow-up/Session切替 | `ApplicationTaskService.records`に終了follow-upも残り、pendingViewが全件配列化。Coreは閉じたApplicationServiceをservicesBySession配列へ残す | active laneはowner、終了follow-upはDB。小さい最新pageのみ表示し、旧owner参照を外す |
| 会話を開く/購読 | Writer #loadSessionが全execution metadataを配列取得してreplay。normalizer/stateはopen Sessionで保持 | DBから最新pageだけ生成。stable全体位置、active entry、必要detailを範囲取得 |
| 過去閲覧/全履歴出力 | `/view ID`はsessionRead後に表示Sessionを切替。HTTP historyReadは全文を一つのtextへ結合。offline historyのsession/canonicalも全replay/readWorker | viewへ過去page操作を接続。全出力はDB keyset＋streamで完遂する |
| 初回snapshot/遅い購読 | Core watch.pending、subscriber pending、API port、HTTP pending/controller enqueueにpayloadが渡る。HTTP sinkはbackpressureを返さない | snapshot待ち・port・HTTPで配送を有限化。置換snapshotへの再同期を同じ契約で通す |
| TUI描画 | reducer entities/order→SnapshotConversationProjector→KeyedConversationStore。ConversationFlow.printedとRemoteSystemNoticesのSession別Mapも保持 | entity/order/normalizer/notice/印字receiptをpage・未解決操作へ限定。過去はDB viewer/terminal scrollback |
| root/child/headless終了 | headlessはpersistence:noneで共通Worker経路。childは別Workerで、親のHost finallyがcleanupParent/process清算/controlWrites/releaseParentを待つ | 同じresolver/range/suffix保存を使う。既存の清算終端まで所有し、その後に解放 |
| hook/semantic context | hookContextはcommitted全文からturn viewを作る。spikeはcommit後本文を空にするためhook完成契約ではない | bounded canonical viewと全体位置を公開し、current outcomeを別に渡す。checkpoint/recallも共通の位置へ |

Core RSSの残量を特定のMapのMiBへ帰属させる追加実験は今回不要。
上記の確認できた保持経路を置換し、実装後のstateとRSS/PSSを共に評価する。

### 11.2 共通Data/Agent経路の採用とprototype整理

spikeのrange read、anchor/counter、current draft、suffix commit、window置換証跡、
request前async準備を本実装へ採用する。ただしprototype patchをそのままmainへ当てて完了としない。
共有contract/consumerを合わせ、診断だけのimport、probe endpoint、numeric probe callbackは通常runtimeへ持ち込まない。
診断driver/verifier/source/binary/DBは隔離artifactのまま保全する。
通常request factの短い予算記録と元semantic履歴は製品側へ残す。

`readContextTurn(correlation, beforeTurn)`はexclusive keysetで最新候補1turnを取得し、
全体turn、canonical message開始位置、execution locator、本文/byte量を返す。
Session開始はcanonical revision/nextTurn/messageCount/privateStateFromTurn/checkpoint等のanchorだけ。
モデル変更履歴の全件読込みや、再開時の全件count検査を戻さない。
proposalはbase revision/correlationとcurrent messagesで採用し、countはData保存側で更新する。

checkpoint/recallは既存の意味と組立て順を確認し、共通projectorへ接続する。
prototype固有のcheckpoint文字列へ置き換えず、既存semantic_contextのformatterを共用する。
retainedFromTurnは全体turn番号で適用し、既存checkpointより古いturnを再選択しない。
model変更後のprivate state境界も全体turnで判定し、同じprofileだけのreplayを維持する。
windowへ入らない過去のproviderStateは送信/常駐させないが、元DBからは削除しない。
前置・checkpoint・recall・hook寄与・現在turn・tool schemaを実request全体で計数する。

予算はspikeで使った設定配置・優先順位・H32,768・未知入力65,536・推定profileを採る案とする。
未知容量を既知と表示せず、capacity/output情報がないrouteを選択拒否しない。
ChatのRは実送信profile、ResponsesのRは明示予約/確認済みoutput情報、なければ運用推定65,536。
出力予約のためにResponsesへ新しいmax_output_tokensを黙って送らない。
provider usageと推定の差は確認できたrequestのfactへ記録し、事前推定をexactへ格上げしない。

現Responsesのwire計測はmodel/instructions/input/tools/stream/storeを組み立て、
実送信側はさらにinclude/reasoning等を付ける。実装ではadapterごとの共通request builderを
計測・送信の両方から呼び、現在の実送信fieldとreplayItems/namespace toolsを保つ。
Chatも同様に一つのbuilderから計数する。未知の外部variantを新しい拒否仕様へ追加しない。

### 11.3 Coreのreceipt・control・owner解放

Core RAMはactive/preflight中command、進行中execution/lane、current slot、購読中Sessionと
必要consumerのみに必須保持を限定する。完了read cacheは最大32件か合計2MiBの小さい方。
一つの正常な結果がcache予算を超えたらcacheせず、DBから必要時に返す。command入力を拒否する上限ではない。

command受付/退避の順序を次のようにする。

1. 同じcommandIdがactive/cacheにあれば現行と同じ結果へ接続し、異なるsignatureは現行conflictを返す。
   cache missも、**DB照会の最初のawaitより前に**commandIdとprocessing Promiseを同期登録する。
2. `(coreEpoch, commandId)`でDataの完了receiptを読む。存在するならsignature digestを照合して同じ結果を返す。
   同時に来た同じcommandIdはこのPromiseへ接続し、別workを起動しない。
3. 新commandだけ現行work/admissionへ進む。receipt照会で現行の同期slot予約順を崩さないため、
   新受付のpreflight（lookupとworkの同期開始）だけ到着順に通す。同期のslot予約成立後にpreflightを解放し、
   workのadmission awaitやprovider/turn完了を待つlockにはしない。
   cancel/steering/follow-upは既存のpreparing/active laneへ到達し、照会中の二つのsubmitを両方admitしない。
4. accepted/rejectedの**command結果**をDataへ保存してからprocessingをresolve・完了cacheへ移す。
   task.submitのacceptedはtask admission receiptであり、execution完了と混同しない。
   保存未ackのentryを退避せず、未保存のaccepted/rejectedをcommandRead可能と偽って公開しない。
5. cache退避後のcommandReadと再送はDataからreceiptを取得する。shutdownはreceipt/control flush後にDataを閉じる。

signature digestは現行operationごとの署名入力を用い、DBへtask全文の第二のcopyを作らない。
credential.registerは現行registerCommand経路外であり、credential値/Authorizationをreceiptへ入れない。
Core epochが変わった後のcommand再実行保証は新設しない。

Host coordinatorのcompletionはafter_turn ack、turn settled、child/process清算、controlWritesまで待つ。
この終端後、submittedByCommandId/processSettlement等の小さい完了controlをDataへ保存し、
保存ack後の最終controlを公開snapshotへ反映してからexecution removeをpublishする。
Core owner/Promise参照を外した後も、公開snapshotとDB readbackのterminal/controlが一致する順序にする。
Data/Writerはactive・settling・hook待ちと最新settlement1件を保持し、残りはDBへ戻す。
runtime_stopは最新settlementを使い、effect/provider factの保存ack後にその参照も解放する。

follow-upはqueued/starting中をtask ownerが持ち、started/discarded/startRejected等の現statusと理由を
Dataへ保存後にrecords Mapから外す。受理したtextはcontentsのdigest参照で保存し、queuedの保存もcommand receipt ackより前に行う。
followUpRead(queueId)はDBへ、pending.followUpsは最近32件のpage＋cursorへ。
既存のstatus遷移、cancel/discard、開始したexecutionId、lost responseのcommand照合を保つ。
表示一覧を限定することと、保存済みfollow-upを参照できなくすることを区別する。

閉じたslotのserviceはclose完了・未保存control/follow-upなし・購読解除後にservicesBySessionから外す。
この配列を全Sessionの完了DB参照Mapへ置き換えない。Session control snapshotもcurrent/subscribed＋最大32件/2MiB cache。
退避するinactive Sessionの最後のpublic revisionをDataへ保存し、同Core内で再読したときのcursorを保つ。
購読中/処理中を強制cache退避せず、その寿命は解除/settlementまで。Core終了後の旧epoch cursorを通常起動へ全件復元しない。

#### Data/WriterのSession metadata・cursorの寿命（review P2）

現行Data closeSessionはownerを削除するが、`descriptors`/`descriptorSequences`を残し、
Writer closeSessionも`#sessions`/`#closedSessions`を残す。childは毎回別correlationでDataを開くため、
root Sessionを替えなくても完了childごとのmetadata/IDが累積する。Core owner解放だけを対策の完了としない。

**解放の責任はData service、Writerのcursor/索引解放はWriter自身、終端通知はHost**とする。
S1でchild/headlessの終端とDataのSession参照解放を実装し、S4でpersistent/inactive Sessionの退避・再取得へ適用する。

1. after_turn/runtime_stop、journal/control保存ack、child/process清算、Generation/Data portの終了を待つ。
   Dataの進行中mutation/read/deliveryと、conversation/descriptor購読の寿命も解放条件へ含める。
2. ownerが閉じ、必要consumer/購読がなくなったSessionの最後のcut/storeRevision/descriptor sequenceと
   再取得に必要な小さいanchor/locatorをDBへ退避する。保存ackまで参照を外さない。
3. Dataのdescriptor/sequenceとWriterのSession cursor/closedSet/そのSessionのexecution索引を同じ寿命で解放する。
   実装では現行releaseSession相当のRAM参照解放を使用し、実Session/ExecutionのDB削除を呼ばない。
4. close後も必要購読がある間はstateを保持し、最後の購読解除とdelivery完了時に同じ退避処理を通す。
   inactive persistent Sessionのread cacheは最大32Session・合計2MiB、不要なchild/headless stateはcacheへ永久に残さない。
5. 再読はpersistentのDB metadata又は保存execution/anchorから必要な1Sessionだけを作り、
   同じData instanceでは保存済みcut/descriptor sequenceを復元してからsnapshot/watchを登録する。
   新しいData instanceは新しい寿命として開始し、旧instanceの全Session索引をloadしない。

この退避に必要な小さいData cursor/anchor tableを第11.7節のschema3へ含め、S1の最終DDL確定時に定義する。
RAMに永久の「解放済みSession→DB参照」Mapを作らず、再取得もkey指定のDB readへ戻す。
S1で同じrootからchildを反復しても終端後のData descriptor/sequence/Writer cursor/closedSet数が累積しないことと、
保存済みchild execution/hook/controlのreadbackを確認する。S4はSession切替・cache退避・再購読を確認し、
snapshotのcut/sequenceの巻戻り、delta欠落/二重適用がないことを確認する。
RSSへの寄与量は未測定であり、これらの保持件数とRSS/PSSを区別して評価する。

### 11.4 会話page・大きい本文・全出力

会話pageはcanonical turnだけでなくfailed/cancelled/non-canonical executionと確定後hook eventを含む。
範囲はstableなSession内execution順でkeyset取得する。各executionの全体表示位置をDBへ保存し、
page内の0始まりindexで全体位置を付け直さない。parent/child関係も元execution locatorを使う。
通常projectionを作るために全execution metadata/ID配列を取得しない。

製品contractとして`conversationPageRead(sessionId, cursor?, direction)`を追加する案。
応答はpage範囲、前後cursor/有無、Data cut/storeRevision、bounded entities/orderを持つ。
最新snapshotと過去pageは同じbuilderを使い、page初期値は**完了50executionか本文2MiB**の小さい方＋active entry。
ページ外へのremove/order removeを同じData deltaへ含め、normalizerのrequest/call/source索引も解放する。

2MiBを超える正常なmessage/result/executionは拒否・黙った省略をしない。
pageへstable locator、表示preview、全文byte量、detail cursorを載せ、本文の残りは
`conversationContentRead(locator, offset, length)`で最大256KiBずつ取得する案とする。
UTF-8境界をまたぐchunkはdecode stateを維持する。全量検索/要約などの新機能は追加しない。
active assistant文字列も受領直後の合法な更新1件のtransient保持と、表示中chunkを区別し、
Data/view/TUIへ全文を毎delta複製する経路を外す。元本文はDBの正本へ保存する。

公開Session/Conversationのschemaは3へ切替える案。page/本文locator、remove、follow-up page、resyncを
codec/reducer/client/HTTP/同梱TUI/CLIの同じ変更へ含める。旧form兼用parseやfallbackを推測追加しない。
新protocolのcapability/format識別はCore readに載せ、同梱clientを同時に切り替える。
S3の同scope snapshot置換でも旧pageにしかないentity/order/normalizer/UI rowを除く。
scope変更時だけstoreをclearする現処理に頼らず、旧pageと新pageの有限範囲で差を扱う。
detail locatorは内容版/digestとcutの意味をrequest/responseで確定し、chunk間に別版の本文を混ぜない。

`/view [ID]`とSession pickerのviewで、表示Sessionの最新pageと過去閲覧に接続する。
ID省略は現在の表示Session。閲覧中のPageUp/PageDownで前後page、↑/↓で表示entryを選び、
Enterでmessage/tool結果の本文detailを開く。detailは同じpage操作でchunkを辿り、Escで会話pageへ戻る。
会話pageからEscで最新tailへ戻る操作案とする。
このviewは表示先だけを変え、Core active Sessionの切替/新task開始は`/resume`へ分ける。
過去pageは取得時cutの静的表示とし、進行中の新結果はlatest側へ保存する。未読増分は小さい位置/counterで示す。
過去閲覧のためにlatest全履歴や更新backlogを別Mapへ保持しない。

`henji history`のsession/canonical/detailは**全件出力**を維持する。
offlineはkeyset iterator→render/export→stdout write、connectedはData/HTTP stream→CLI writeへ置換する。
HTTP historyReadの全文text結合とofflineの全replay/readWorkerを外し、per-execution又はcanonical turn単位で出力する。
出力途中でclientが切断したらreadを閉じるが、Agent executionは取消しない。
一貫したDB read cut/transactionで順序と本文を維持し、page cache件数をexport件数上限へ使わない。

### 11.5 配送とTUIの保持

Data→Core→API Worker→HTTPを、subscriber単位の有限な配送scopeとして変更する。
初期cache目標は2MiB＋一つの合法なframe。MessagePortへ転送した後もin-flightを計数する。
CoreSessionFrameSinkのvoid callbackだけではbackpressureを戻せないため、
internal subscriptionにdelivery sequence/ack（credit）を加え、ack前にportへ無制限pushしない。
HTTP ReadableStreamはpull/desiredSizeを使い、HTTP送信用queueとcontroller内queueの両方を数える。

snapshot待ち/遅延でdeltaをすべて保持できない場合、未配送deltaを適用済みとは扱わずresyncを要求する。
resync待ちは最新cut/control位置だけを保持し、creditが戻ったら**有限の最新page snapshot**で置換する。
置換は一つのpublic revision/Data cutへ揃え、その後のdeltaだけを送る。
Coreのwatch初期化、snapshot先行update、API port、HTTP queueが別々に全履歴bufferを作らない。
正常な更新を受け取ったclientは同じsemantic表示を得る。切断/遅延は購読の解放で、execution取消ではない。

TUIは現在page、active rows、現在の本文detail chunk、未確認commandだけを保持する。
reducer/projector/KeyedConversationStoreのentity/order/indexと、RemoteSystemNoticesのsteering索引/Session別noticeも
範囲置換時に解放する。解決済みnoticeは印字済み位置とbounded表示pageへ、
未解決commandのnotice/draftは解決するまで保持し、page外だからという理由で破棄しない。
表示Sessionを離れた後に全notice/本文のMapを常駐させず、必要な保存済み状態はcommand/control readbackから得る。

ConversationFlowは印字済み全ID Mapの代わりにstable全体位置のfrontierと現在のmutable tail receiptを持つ。
同じ表示scopeの再同期で古い行を再印字せず、activeの未完了text/遅い確定hook更新は有限の現在receiptへ適用する。
過去page/detailはread-only paneで表示し、通常tail drainへ混ぜてterminal scrollbackを重複させない。
resize、view変更、同Session再接続の既存display scope意味を確認して採用する。
S3の旧entity除去とS5の印字frontier維持を分け、同scope resyncで表示storeを置換しても
印字位置と未解決commandのdraft/noticeはresetしない。

### 11.6 hook・child・headlessの契約

同梱/現在default HOME configで確認できたhookはruntime-start-timeだけで、
canonical全文・projectedContext・checkpointを読まない。利用者の別XDG/別catalogのhookは未確認であり、
「すべての外部hookが全文に依存しない」とは主張しない。

Hook APIは**henji-hooks/v2案**とする。snapshotへcanonical nextTurn/messageCount、
保持turnの全体位置/省かれた範囲/selection予算・profileを持つrangeを追加する。
`transcript.turns`は明示されたbounded canonical viewとし、選択windowを全文として渡さない。
現在draft/outcomeはcanonical viewへ混ぜず、after_turnのoutcomeはそのcurrent turnだけを含む契約へ揃える。
phaseに必要なviewをData rangeから準備し、起動/停止hookのためだけに全文を復元しない。

before_turn寄与→request再計数、before_tool実効引数、after_tool本文変換と元call/result記録、
after_turnのData採用後実行・checkpoint保存ack、runtime_stop effect保存の順序を維持する。
checkpointのcoveredThroughTurn検査は全体anchorへ変更し、retained配列長で総turnを検査しない。
retainedFromTurn/privateStateFromTurn、model変更、recall、prefix/source証跡を同じ位置契約で整合させる。
共通型、loader、build manifest、同梱hookの型import・説明、既存189の実機能確認を同じ変更へ含める。
v1/v2の二重実装や全文fallbackは追加しない。新contractへ移せない実利用が判明したら具体的操作と選択肢を戻す。

childは空canonical basisから始める現契約を保ち、親履歴/checkpointを暗黙継承しない。
child startupにも同じ予算snapshot/async準備/差分保存を接続する。
親cancel時のchild cleanup、child terminal保存/after_turn後のresult公開、releaseParent前のcontrol ackを確認する。
headless CLI runはpersistence:noneでも元execution/call/result/non-canonicalを保存し、
CLI drainとWorker runtime_stop/Data closeまで同じconsumer終端を使う。

S1ではpersistence:noneのruntime採用とDBのcanonical linkを区別して読取り元を定義する。
child/headlessは空basis、実行中はcurrent draft、採用後/停止phaseは保存済みexecutionのsuffix/anchorから
bounded viewを作る。保存されたnon-canonical executionを、Session canonical範囲readで存在すると仮定しない。
永続Sessionのcanonical総位置と、非永続runtimeで採用したturn位置/locatorをhook rangeへ明示し、
全文配列や親履歴へfallbackしない。このviewが必要なphaseのack前にchild Session stateを解放しない。
終端後のData/Writer参照解放は第11.3節のData-owned処理をHost closeから呼ぶ。

### 11.7 DB版と切替案

本実装は**schema 3**を提案する。spike schema2とはreceipt/page等の構造が異なるため、
同じversionで二つの構造を暗黙に開かない。schema2 spike DB/binaryは実験artifactとしてそのまま保全する。
本実装の新DBは以下を追加し、既存のcontent/messages/semantic記録とcanonical adoption transactionを再利用する。

| 追加する状態 | identity/内容/参照 |
| --- | --- |
| Session anchor | spikeのprivate_state_from_turn、canonical count/nextTurn、最新metadataを直接読むためのindex |
| command_receipts | PK(core_epoch,command_id)。operation/signature digest、完了result、target、対応execution、完了時刻。Dataが保存/読取 |
| execution_control_facts | execution locator、submittedByCommandId/processSettlement、最新control。owner/Promiseなし |
| follow_up_receipts | PK(core_epoch,queue_id)、Session/元command/親execution、textのcontent digest、既存status/reason/開始execution。最新pageをindexed keysetで読む |
| core_session_cursors | PK(core_epoch,session_id)、inactive退避時のpublic revision。旧epochを通常起動へloadしない |
| data_session_read_cursors | PK(data_instance_id,session_correlation)、退避時のcut/storeRevision/descriptor sequence、再取得用の小さいanchor/最新execution locator。本文/全件ID/owner/Promiseを持たない |
| execution_display_positions | Session correlation＋monotonic execution ordinal＋execution_id。canonical/failed/child等をstable順序でpage読取するindex |

display ordinalはbeginExecutionの既存DB transactionで付与し、indexed末尾位置から次を得る。
conversation cursor/canonical global message位置とwindow位置は混同しない。
この導出位置の追加のために元executionやcontentのID/digestを振り直さない。
既存のData→Agent range indexとactive/latest execution indexも維持する。
Data cursorの退避/復元は同じData instance内の読取り寿命を保つためで、canonical採用やCore public revisionとは別に扱う。
旧DBコピーから存在しなかった旧Data instanceのcursor/anchorを捏造せず、新tableは空で始める。
全履歴のtoken cost backfill tableは現段階で不要とし、選択範囲をlazy計数する。

通常runtimeの実装・検証は新しい隔離schema3 DBで行う。S7の変換toolは自己生成schema1も読取り入力に使う。
通常on-open migration/互換dual-read/writeを追加しない。
既存schema1の継続利用を満たすには、別途承認された**一貫したDBコピーの明示変換**を行う案とする。
変換処理は元DBを書かず、追加column/table/indexとDB versionだけをコピーへ反映する。
private state境界は現行model変更のprofile境界規則でderiveし、display ordinalは元の順序をkeysetで付与する。
content digest/bytes、元record/ordinal、canonical link、Session/execution ID、checkpointを保持する。
旧Core epochのcommand receiptは元DBに存在しないため、新tableは空で始める。

変換後の全保存tuple/hash照合と、新Coreによる同じSessionの続行/過去閲覧を確認するまで切替完了としない。
schema1の旧binary/元DBは保全し、コピーの常用切替/既存Core再起動/配置は別承認。
実DBコピー未承認なら、新DB受入と既存data継続の未確認を分けて報告する。

### 11.8 実装スライスと確認

利用者の「計画をスライスに分けられる？」により、本実装を次の8スライスへ分ける。
各スライスは、実経路の動作・保存・保持状態を確認して個別にレビューできる単位とする。
要件/結果の正本はこの218文書を維持し、別incrementを自動採番しない。
スライスの実装・確認済みと、218全体の受入済みを区別する。
2026-10-09時点でS1〜S7の実装・focused確認・独立review指摘対応を終えた。S8のcompiled localhost TUI、200turn×3と代表保存Sessionの新Core再開20turn、全保存/実入力/予算/保持照合も完了した。最新結果は第11.12節。実providerは最後の呼出し前で停止しており、218全体の受入済みとはしない。

実装順は **S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8** を基本とする。
次表の依存は変更の成立に必要な先行成果を表し、並行agentや未承認の実装開始を指示するものではない。

| Slice | 利用者に成立させる動作/成果 | 必須の先行成果 | 個別の確認・レビュー境界 |
| --- | --- | --- | --- |
| S1 共通生成・保存・hook | 予算内の最新contextで連続/再開し、root/child/headlessの元全文とhook効果を保存できる | 成立したspikeと第11節の契約案 | range/anchor/current suffix/証跡、model・prefix・checkpoint・recall、非永続hook view、child/headless終端後のData/Writer参照解放 |
| S2 command receipt・execution control | 古いcommandをRAMから外してもcommandRead/同ID再送が同じ結果を返す | S1のData/SQLite保存基盤 | 保存ack後のcache退避、並行同ID、現行conflict、slot予約/cancel、古いexecution controlのreadback |
| S3 会話page・detail・閲覧UI | 最新/過去/非canonical履歴と大きい本文をTUIから閲覧できる | S1の保存位置/schema | Data→API→同梱client/TUIを同時切替。page/detail/最新復帰、stable位置、通常更新の操作確認 |
| S4 follow-up・owner・Session保持 | follow-upを後日参照でき、Session切替後にCore/Data/Writerの古いowner/完了metadataが残り続けない | S2のcontrol保存、S3のpage付き公開contract、S1のData参照解放 | follow-up ack/status/readback、owner解放、Data/Writer限定cacheと退避/再取得、public revision/cut/sequenceと再購読の整合 |
| S5 配送・TUI保持 | 遅延/再接続でも現在表示へ追い付き、配送queue・印字receipt・noticeが累積しない | S3の有限snapshot/閲覧、S4のcontrol/owner寿命 | 初回snapshot先行update、port/HTTP credit、resync、page/notice/印字位置の解放と重複印字防止 |
| S6 全履歴stream出力 | offline/connectedのhistoryで全件を出力できる | S1/S3のDB keyset・stable表示位置 | session/canonical/detailの元全文/順序、CLI stdout/HTTP stream、途中切断時の読取り解放 |
| S7 明示DBコピー変換 | schema1の保存Sessionを元DB保全のままschema3候補へ移せる | S1〜S4で確定した最終schema/保存contract | 変換toolと自己生成schema1 DBの確認。実DBコピーでの継続は別承認の実施事実として記録 |
| S8 統合受入 | 長時間会話・再開・閲覧・照合が成立し、保持範囲とRSS/PSS結果を評価できる | S1〜S7の安定候補 | full gate1回、production TUI、200turn×3＋再開20、全保存/入力/保持照合。実provider/実DBは承認範囲だけ |

#### S1：生成・保存の共通経路を完成させる

第11.2/11.6節を一つの変更へまとめる。hookの全文契約だけを旧状態に残して
Agent本文を空にする途中実装にはしない。history/schema/store、Data/Agent contract/endpoint、
session authority、loop/runtime、adapter builder、hook API/runner、Host children/headlessを対象にする。

schema3の最終table/column/index定義は、後続receipt/page/controlとData Session cursor/anchor退避を含めてこのスライス着手時に確定する。
未使用の後続APIや仮handlerは作らない。後続の保存table定義を先に含めるのは、
同じschema3で異なるDB構造を作らず、S1の保存Sessionを後続スライスでも開けるようにするためである。
確定後にDB構造変更が必要になればversion/検証DBの扱いを計画へ明記し、on-open追加を推測しない。
生成anchorの読取りと人間向け履歴読取りは用途を分け、後者を空transcriptへ変えて現行閲覧/CLIを壊さない。

短いlocalhostの連続/再開、window縮小/同数置換、model/前置変更、現在turn不足時の非canonical全保存を照合する。
既存hookのbefore/after tool/turn・checkpoint/recall・runtime_stopと、root/child/headlessの
cancel/failure/terminal公開を、実際に変更した共通経路で確認する。
persistence:noneの採用後/停止hookの読取り元と、consumer完了後のData-owned Session参照解放を
第11.3/11.6節どおり実装する。同じrootでchildを反復して、Data descriptor/sequence・Writer cursor/closedSet/索引の
終端後件数と保存executionのreadbackを確認する。persistent inactive cache/再購読はS4へ渡す。
この時点で生成側の本文保持は限定されるが、Core registry/会話projection/配送/TUIの全体改善は残る。

#### S2：完了commandとexecution参照をDBへ戻す

第11.3節のregisterCommand/commandRead、command_receipts、execution_control_facts、
Host completion後のexecution removeまでを対象とする。Data/SQLite receipt、Core service、
task service/application portを変更し、旧command Promise/ownerをreceiptのcacheへ残さない。

cache退避後に最初のcommandをread/同ID再送し、同じreceipt/executionで新task/provider requestが増えないことを確認する。
DB lookup前の同期登録とpreflight順序、同ID接続、異署名conflict、task submitとcancelを確認する。
完了control保存ack→公開snapshot反映→execution removeの順序と、退避後のDB readbackも確認する。
preflightは同期予約成立後、admission await前に解放する到達点を確認する。
follow-up records、servicesBySessionの閉じたowner、Session snapshotの全解放はS4へ残す。
S2だけでCore全体の保持量やRSSが限定されたとは判定しない。

#### S3：人間の過去閲覧をpage/detailへ切り替える

第11.4節の会話page/detailと、それを人間が使うTUI操作を同時に実装する。
Writer/history adapter、API contract/codec/reducer/client、HTTP read、remote Session、
snapshot presentation/keyed store、slash/helpを対象とする。

Session/Conversation schema3のpage/locator/範囲契約へ同梱consumerを同時に切り替える。
この公開切替に含まれるpending.followUpsのpage表示も、Dataの保存/queryとcodec/TUIまで通す。
queued/終了statusは公開前に保存し、旧owner内のrecordsを解放する処理はS4で行う。
Core更新のpublic revision/Data cutを保ち、bounded snapshotの通常配信と置換をclientが読めるようにする。
同scopeの置換でも旧entityを除去し、detailのlocator/内容版/cutを確認する。印字receiptの限定保持はS5へ渡す。
APIだけを切り替えてTUIが旧全文を期待する状態や、最新50件だけを残して過去を辿れない状態で完了にしない。

隔離XDG・tmuxのproduction TUIで、`/view [ID]`、前後page、本文detail/chunk、最新tail復帰、
failed/cancelled記録、Session view/通常会話更新を確認する。page外entity/order/normalizer索引を解放する。
全history出力のstream化、遅延queue、TUIの印字receipt/noticeの累積は後続へ残る。

#### S4：follow-upと閉じたSessionのownerを解放する

第11.3節のfollow-up status/readback、servicesBySession、Core inactive snapshotとData/Writer Session metadata/cursor退避を対象とする。
S3の保存済みfollow-up/page contractを使い、task ownerの終了recordsとCoreの旧ApplicationService参照を外す。
Data service/SQLite control・cursor、ConversationWriter、Core service/task service、pendingのprojection/必要なclient処理を変更する。

queued ack、開始/discard/startRejectedと後日のfollowUpRead、cancel、Session切替/再表示を確認する。
slot closeとconsumer/control保存の終端を待ち、ApplicationService owner数が切替回数に比例しないこと、
snapshot cache退避後も同Core epoch内のpublic revisionが巻き戻らないことを確認する。
S1のData参照解放をpersistent inactive cacheへ適用し、close後の最後の購読解除にも同じ退避を通す。
Data descriptor/sequence、Writer Session cursor/closedSet/execution索引も保持範囲へ戻り、
再取得・再購読snapshotのcut/sequenceと後続deltaに巻戻り/欠落/二重適用がないことを確認する。
DB execution/hook/controlの記録は保持し、実data削除を解放手段に使わない。
購読中/処理中stateは寿命が終わるまで保持し、cache目標だけで正常操作を拒否しない。
購読配送とSurfaceローカルの保持はS5へ残る。

#### S5：配送とTUIの累積を外す

第11.5節のCore watch/subscriber、Data/Agent portとは別のAPI配送port、HTTP stream、
TUI flow/noticesを対象とする。必要なack/resync contractとconsumerを同じスライスへ含める。

snapshot待ち/port/HTTP queueを2MiB＋一つの合法なframeのscopeへ限定し、
遅延時は最新cut/control位置から有限page snapshotへresyncする。
TUIのprinted/notice/steering索引もpage・mutable tail・未解決操作へ限定する。

tmuxで通常更新、snapshot先行update、受信を遅らせた後のresync、切断/再接続、
resize、page往復を確認する。未解決commandのdraft/noticeを失わず、同scopeの古い行を重複印字しない。
確認後のqueue/in-flight/row/receipt/notice件数を記録する。S3の同scope store置換で印字frontierをresetしないことも確認する。
全件exportと既存DBは後続へ残る。

#### S6：全件出力をstreamにする

第11.4節のhistory出力を対象とする。SqliteHistoryStoreのkeyset iterator、history renderer/export、
Data/HTTP streamとAPI client、history CLIを変更する。
page上限を全出力上限へ転用せず、session/canonical/detailの全件をstdoutへ出す。

同じ保存DBでoffline/connectedの元全文・順序・canonical/non-canonical識別を照合し、
全text結合/全execution配列/全文replayが通常出力経路から外れたことを確認する。
出力途中のclient切断でread transaction/subscriptionを閉じ、Agentの会話は継続できることを確認する。
このスライスのreadbackは会話中のRSS samplingへ混ぜない。

#### S7：DBコピー変換toolを用意する

第11.7節の明示コピー変換を独立toolとして実装する。通常DB openへmigrationを追加しない。
source/destinationを明示し、schema1元DBを読取り側として一貫したコピーを作り、
コピーへschema3の追加column/table/index/versionと必要な導出位置だけを反映する。

まず自己生成したschema1 DBで、content/record/ID/digest/ordinal/canonical link/checkpointの保全と、
新Coreで同じ保存Sessionの続行/過去閲覧を確認する。旧binary/元DBも保全する。
実DBのコピーを作成/変換する操作、常用切替、Core再起動/配置は個別の承認範囲であり、
S7のtool確認済みだけを実dataの継続利用確認済みへ変えない。

#### S8：安定候補を統合受入する

以下の共通検証方針と第8節の長時間条件を適用する。
S1〜S7の個別確認/レビュー結果と残りを揃えた候補へ、authoritative full gateを1回実行する。
同じlocalhost負荷・compiled Core＋production TUIで200turn×3、代表1runの保存Sessionの新Core再開20turn、
過去page/detail/exportを確認する。全3runのsampling終了後、各Coreのcache退避後commandRead/同ID再送を確認する。

全保存/実入力/証跡/予算と、Data/Agent/Core/Surface/配送の保持件数・本文量、RSS/PSSを記録する。
保持件数はCore ownerやexecution索引だけでなく、Data descriptor/sequence、Writer Session cursor/closedSet/索引、
active/consumer/購読とinactive cacheの内訳を含める。child反復・Session切替/再購読の確認区間で、
完了Session総数に比例せず寿命とcache範囲へ戻ることを記録する。counterは診断patch/既存focused観測で取得し、
計測のための全文clone/全件ID dumpや通常runtimeの新しい診断endpointは追加しない。
実providerと実DBコピーの操作は承認された対象/回数/保存先に限り、未実施ならその事実を残す。
配置/commit/pushをS8の自動処理へ含めない。

スライスごとの結果は、変更した動作、source/test/実経路の証拠、残る範囲を本節へ追記する。
focused確認を終えた理由なく200turn×3やfull gateを各スライスで繰り返さない。

testは上のproduct動作へ対応するfocused確認だけを追加/更新し、旧全文/append-only前提を直す。
既存141〜143（Core/API/remote/pending）、189（hook/settlement/checkpoint）、child/headless、
214（request保存）等は変更で実際に影響する経路を選んで実行する。全variant matrixやtest件数目標を置かない。
実装中はfocused test/type/fmt/lint/diff check。reviewerはfull gateを実行しない。
安定候補にcoordinating ownerがauthoritative v0:gateを1回実行する。再実行には失敗/変更等の理由を要する。

Surfaceは隔離XDGのcompiled production TUI、tmux 110×36で操作を確認し、実configを書かない。
localhost応答を使い、read/複数request/steering/follow-up/cancelを実操作から通す。
main長時間runのTUIは通常表示を開き、過去閲覧の追加操作は別区間へ分ける。

本受入の長時間条件は第8節を維持する。200turn×3、Core/TUI別PIDのRSS/PSS、各context heap、
各turn＋0.2秒、20/50/100/200＋2秒、sampled最大、最終＋2秒、区間傾きを記録する。
main内のWorker再起動/強制GCなし。停止線を空き/cgroupから各run前に記録し、重い照合はsampling終了後。
Coreの101–200傾き中央値≤0.25MiB/turnと区間peak差中央値≤64MiBを初期判断線として維持する。
spikeの0.260だけを根拠に判断線を緩めない。stateが収まっても残るRSSを無条件に解決済みとしない。
3回の結果と保持件数を報告し、判断線未達はsource/時点を示して利用者へ戻す。
各mainのsampling終了後、Core終了前にcacheから外れた最初のcommandをread/同ID再送し、
同じreceipt/executionを返して新turn/provider requestを増やさないことも照合する。
その後の再開20turn/過去page/detail/exportは同じ保存Sessionで別区間として記録する。

2026-10-08、利用者はOpenCode GoのDeepSeek V4.1 Flashによる約20turnの実provider利用を承認した。
対象は既存実利用経路の `opencode-go-chat / deepseek-v4.1-flash`、Chat Completions SSEとし、
effortは実施前に既存選択を確認して記録する。公式Go文書でもmodel IDとChat endpointを確認した
（[OpenCode Go](https://docs.opencode.ai/docs/go/)）。Responsesや他modelの呼出しはこの承認へ含めない。

確認は合計20turnの1回とし、同じSession・Agent Workerで15turn継続後、保存Sessionを新Coreで
再開して5turn行う。短い会話とread toolを使い、会話継続、tool call/result、全文保存、再開後の
応答を照合する。1turn最大2model requestsのprobeで、物理requestは合計最大40回とし、
成功確認のための別runや自動再試行を加えない。予算によるsuffix縮小を実接続でも確認する場合は、
診断用Hを実容量とは区別して設定・記録する。20turnだけで実context容量や長時間の頭打ちを
確認済みとはしない。長時間メモリ受入は上記localhostの200turn×3を維持する。

保存先はgit管理外の `.tools/increment-218-live/` とし、隔離XDG/workspace/SQLite、
実行条件、request単位fact、semantic履歴のreadback、メモリ観測と結果を置く。
実credentialは既存profileから読取り利用し、元credential値/Authorization、raw HTTP/SSEは記録しない。
RSS/PSSは実provider runでも区間を分けて観測するが、負荷が異なるlocalhost結果へ混ぜない。
実capacityの値は確認した一次情報/route metadataだけを既知扱いにし、推定routeの品質確認と区別する。
まだ実providerは呼び出していない。後続の利用者指示により、S8のlocalhost検証/測定等の最後に
実provider確認を置き、呼出し直前で停止する。この承認は本実装着手、実DB操作、配置の
承認とは分けて保持する。

### 11.9 完了判断と承認境界

本実装完了は、必要な連続/再開/過去閲覧/command照合と共通root/child/headless/hookが成立し、
元全文/位置/証跡を保ち、対象本文・ID・metadata・完了registry・配送/表示が保持範囲へ収まること。
新DBでの成功、旧DB継続確認、実provider容量/継続品質、配置を別の実施事実として報告する。
未承認の外部呼出し/実DB操作を代替fixtureの成功で実施済みへ変えない。

この段階で作成したのはreview可能な本実装計画とスライスであり、mainのproduct sourceは変更していない。
個別Sliceの実装/確認/レビュー完了は記録できるが、218全体の受入完了や配置済みを意味しない。
本実装の着手判断は本節、第12節の正本変更案、上記実provider承認範囲、未承認の旧DB操作/配置を区別して行う。

### 11.10 本実装スライスのreviewと指摘反映（2026-10-08）

利用者依頼により通常/批判的reviewerが独立read-onlyレビューを行った。
対象計画のSHA256は `4e4af0c7a66280773c239bb7236ef13cccac905b7d3323270af7b9a780c91346`。
両者とも**「要補足で進める」**。8スライスの分割方針と、生成/hook・閲覧API/TUIの同時切替、
保存ack後の解放、個別確認と全体受入の区別は妥当と評価した。

共通P2は**Dataの閉じたSession metadata/cursorの解放担当と確認到達点の不足**。
sourceは `data_service.ts` のdescriptors/descriptorSequences/closeSession、
`conversation_writer.ts` の#sessions/#closedSessions/closeSession、
`worker_host_children.ts` の別correlation起動と終端Data close。
同じrootでchildを繰り返してもID/metadataが累積する経路があり、必須補足として採用した。
RSSのMiB寄与は未測定。スパイクの成立評価を取り消す指摘ではない。

利用者の「指摘を反映して」により次を計画へ反映した。

| 項目 | 担当と反映箇所 |
| --- | --- |
| P2 Data/WriterのSession state解放 | 第11.3節。責任はData/Writer、終端通知はHost。S1のchild/headless close、S4のpersistent inactive退避/再購読へ割当。DB readback、保存ack、購読/deliveryの終端、cut/sequence、件数確認を明記 |
| schema先行確定 | 第11.7節とS1。Data instance＋Session correlationのcursor/小さいanchor tableをschema3最終定義へ含め、RAMに永久のDB参照Mapを作らない |
| 非永続range/hook | 第11.6節とS1。runtime採用とDB canonical linkを分け、空basis/current draft/保存execution suffixのphase別読取り元を明記 |
| preflight/完了control | 第11.3節とS2。同期slot予約後・admission await前のpreflight解放、control保存ack→snapshot反映→removeを明記 |
| snapshot/detail/印字 | 第11.4/11.5節とS3/S5。同scopeの旧entity除去、locator/内容版/cut、印字frontierをresetしない境界を明記 |
| 統合受入のcounter | S8。Data descriptor/sequenceとWriter cursor/closedSet/索引を、active/consumer/購読/cache寿命ごとに確認 |

S1着手前の担当境界とschema確定対象を明記した。実際の解放・再取得はS1/S4で確認する。
本記録は計画への反映であり、実装結果や修正後の再review済みを意味しない。
reviewでtest/build/gate/provider/追加測定は行っていない。実装source/常用DBは変更していない。

### 11.11 本実装の途中結果（2026-10-09）

以下は索引修正直後までの途中記録。再review・再測定を含む最新結果は第11.12節。

S1〜S7は実装・focused確認済みで、独立reviewで指摘された修正も反映した。S1ではDataのwhole-turn range readとAgentのempty basisを接続し、canonical/runtimeのsourceとglobal message位置を保ったまま、実adapter builderのwireに沿ってcontext budgetを選択する。canonical全文の保存、checkpoint/recall、hook v2、child/headless終端後のData/Writer解放、provider usageが返る場合のrequest単位factを確認した。S2では完了command receiptとexecution controlを保存ack後に退避し、再読込・同ID再送・shutdownの順序を確認した。独立reviewのP2（Chat wire byte計数、実request usage差、receipt未ack中のcommand保持）を修正し、focused確認を再実行した。

S3はpage/detail/follow-upをData→API→HTTP/client/TUIへ接続した。S4/S5はinactive Session cursorの保存/再取得、bounded cache、delivery ACK/resync、TUIの表示frontierとnotice寿命を確認した。S6はoffline/HTTP historyをpull型streamへ切り替え、元の本文と順序のreadback、reader closeを確認した。独立reviewで指摘された全履歴JS重複Setを同一reader transactionのSQLite判定へ移した。S7は自己生成schema1 DBのコピー変換とschema3でのreadbackを確認した。実DBのコピー/切替は実施していない。

S8のlocalhost production TUI確認は `.tools/increment-218-main/s8-tui-2/` に保存した。隔離XDG・compiled binary・tmux 110×36で過去page、UTF-8 detailの先/次/戻り、最新tail、read toolと結果、F3 steering、F2 follow-up、cancel、resizeを操作し、result artifactは `providerRequests: 59`、`realProviderCalls: 0` を記録する。

保持件数のfocused観測は `.tools/increment-218-acceptance/lifetime-focused.log` の3件成功。40回のchild consumer終了後は、root/child closeでData owner、descriptor/sequence/generation、Writer Session、closed set、execution/session indexが0へ戻り、有限cursor cacheは32件だった。40 Session切替/close後も同じactive state群は0、cursor cacheは32件・12,480 bytesで、再購読で保存revisionを復元し、active selectionは変化しなかった。Coreの41 Session観測ではsnapshot cacheがactive 1＋inactive 32、command cache 32、owner 1、inactive cursor 32を記録した（`.tools/increment-218-acceptance/core-counters.log`、`core-lifetime/result.json`）。

Gate4は709 passed / 6 failed（`.tools/increment-218-main/s8-gate-4.log`）。6件は元HEAD `93e9c` のbaselineで5件（`baseline-focused.log`）とIncrement 194の1件（`baseline-194.log`）を再現した。218由来のGate3 Data/history回帰は対象focused確認で解消済み。foundation regressionの最新focused結果は2 passed（`.tools/increment-218-main/s8-foundation-regression-focused-2.log`）。以前の `s8-foundation-regression-focused-final.log` は失敗した旧実行であり、成功根拠には含めない。

localhostの200turn候補run1は200turn＋2秒まで完了したが、完了後にDataの
`executionGenerations=200`、Writerの`executionSessions=200`が残り、ownerの`executions=1`との
不整合を示した。これは本計画の完了後保持範囲に反するため、run2途中で中断し、未着手のrun3・新Core再開20turnを含め候補を取り下げ、原因を調べて最小修正した後に再測定する。40 child consumer/40 Session切替の
focused lifetime試験結果は別条件の確認として保持し、長時間の同一Sessionでexecution単位のregistryが
収束する証拠にはしない。run1のRSS/PSS等は親の結果記録で追記する。全保存/入力照合と受入判断は
未完了。実providerは0回で、最新指示に従い呼出し直前で停止する。実DBコピー、常用配置、commit/pushも
未実施。

この原因は、DataServiceのexecution→generation索引とConversationWriterのexecution→Session索引が、
Session/generation closeまで完了executionを保持していたこと。Session owner自身はactiveと最新settlementだけを
残す設計だったため、完了索引の解放が連動していなかった。承認されたData範囲の修正では、ownerが古い
terminalを落とす時にWriter索引を解放し、DataServiceもterminal後にownerの保持判定に従って古いgeneration
索引とendpoint payloadを解放する。active executionと最新terminalは残し、過去executionのSession解決は
既存のSQLite `readExecutionMetadata` 経路で一時的に行い、live索引へ再登録しない。focused regressionは
最新terminalの保持、旧executionのSQLite再解決とpost-settlement追記を確認した。

修正後のfocused確認は11 passed（Data lifetime 3、Data service 1、hook 3、child 4）。Data関連source/testの
`deno check`、`deno lint`、`deno fmt --check`と`git diff --check`も成功した。full gate/build/providerは
実施していない。独立re-reviewと修正sourceのcompiled numeric observationは親が担当するため、200turn候補
run2/run3と新Core再開20turnは未再開であり、execution registryの収束とS8受入判断は未確認である。

### 11.12 本実装のlocalhost統合結果と停止位置（2026-10-09）

本節は全体review指摘修正前の候補で実施した結果であり、修正と最新状態は第11.13節を参照する。
S1〜S7の実装と、実providerを除くS8のlocalhost確認を終えた。実providerは利用者の最新指示どおり
最後の呼出し直前で停止している。通常binaryと測定用binaryは最新sourceでcompile済み。
本記録は218全体の採用・完了承認、常用DBコピー/切替、常用配置、commit/pushを意味しない。

Data/Writerの完了execution索引漏れは、ownerのactive＋最新terminalの寿命へ解放を連動し、
過去IDのSQLite解決で索引を再導入しないよう修正した。独立re-reviewは新findingなし。
focused 11/11成功後、compiled同一Session20turnでData/Writer索引が各1件へ戻ることを確認した。
修正前run1とrun2途中は `.tools/increment-218-acceptance/pre-active-execution-index-fix/` に保全し、
最終集計に混ぜていない。

最新候補の200turn×3（main内同一Worker）と、代表run1の同じ保存Sessionを新Coreで20turn再開した。
全620turn・canonical 2,480 messages・1,240物理requestの全read原文、保存/実入力、context occurrence/digest/
source locator/window splice、wire SHA256/byte数、予算factをsampling後に照合し、すべて一致した。
各main終了後の最初のcommand read/同ID再送も、同じreceipt/executionを返しprovider requestを増やさなかった。
全220executionの旧page閲覧、旧read detail 59,282 bytesの原文一致、HTTP/offline CLI/connected CLIの
session/canonical/detail全出力のbyte数/SHA256一致も確認した。

Coreの101–200turn傾き中央値はRSS 0.1546、PSS 0.1546 MiB/turn。
51–100から151–200への区間peak増分中央値はRSS 11.27、PSS 11.26 MiBで、
初期判断線（各傾き≤0.25、peak増分≤64）を満たした。Core 200＋2秒RSSは348.82/343.33/341.66 MiB。
20turn時点より増えており、完全な頭打ちは確認したとはしない。各context heap、最大、固定費、
TUI別PID RSS/PSS、再開区間、不確実性は[報告書](../research/increment-218-main-memory-2026-10-09.md)に記録した。
停止線は各run前の有効空きから算出したCore＋TUI RSS合計5,632 MiB。到達なし、強制GC/Worker再起動なし。
結果の独立reviewは必須findingなし。raw sampleからの再計算、表/グラフ、保存照合/保持counter/
provenanceの整合を確認した。reviewでtest/gate/build/provider/追加測定は実行していない。

Data/Writer完了execution索引は各1件、Agent committed全文は0。Core完了command cacheは32件、
通常表示は9 execution/54 entities、TUI printedは27件で、20/50/100/200の保持counterを記録した。
sampling後に同じ修正sourceで40 child/40 Data Sessionのnumeric観測（4 focused成功）と
compiled Core 41 Session切替/再購読も再確認した。consumer終了後のData owner/descriptor/sequence/
Writer Session cursor/closedSet/索引は0、inactive cursorは32件/12,480 bytes。
Coreはactive1＋inactive32 snapshot、command cache32、owner1に収まり、再購読のcursorとactive selectionを維持した。

最新 `v0:gate` は710 passed/6 failed。6件は元HEAD93e9cで再現した既存失敗で、gate成功とはしない。
今回由来のstartup/取消receipt/Session削除/current-turn保存/Responses wire等の回帰はfocusedで修正確認済み。
再gateの理由は前回失敗のtype/lint/実際の回帰修正と、計測で見つかった索引漏れの修正であり、
reviewerはgateを実行していない。ログとbaseline根拠は報告書を参照する。

実provider予定はopencode-go-chat/deepseek-v4.1-flash、Chat Completions SSE、catalog defaultのeffort auto。
既存default-selectionは別modelのmimo-v2.6-pro/autoであり、確認対象は明示されたDeepSeekへ設定する。
[準備manifest](../../.tools/increment-218-live/readiness.json)と20turnの入力を保存した。
15turn＋新Core再開5turn、最大40物理request（production再試行も算入）、隔離保存先 `.tools/increment-218-live/` の準備までとし、
本turnではCore起動やrequest送信を行わない。実token容量/continuation品質は未確認。
実DBコピー/切替、常用配置、commit/push、構想/architecture/roadmapの正本変更は未実施。

### 11.13 インクリメント全体reviewと指摘対応（2026-10-09）

利用者の指示で、S1〜S8を跨ぐ通常review・批判的reviewを独立に実施した。
基準HEAD93e9cに対する未commit候補116ファイル（新規source/testを含む）をhashで固定した。
通常reviewはP2が1件、批判的reviewはP2が3件。親が明示要件とsourceから利用者影響までを確認し、
重複を除いた3件を採用した。続く「対応お願いします」に基づき、次を修正した。

| 指摘と利用者影響 | 修正 | 確認したproduct動作 |
| --- | --- | --- |
| checkpoint/recallをPではなくHへ計上し、入力容量内でも最新履歴を落とす／現在turnを拒否する | request全体のwire/inputは維持し、Hへは完了turn＋current draftだけを渡す。hook viewも同じ分離を適用 | 12,000-byte checkpointを保存し新Workerで再開、低めHでも次turnを完遂。Chat wireを使うcheckpoint＋recallのrequestで履歴を保持し、入力Vが不足する場合は送信前に失敗する |
| 遅いdetail exportでexecution本体とACK/generation派生値のDB時点が混ざる | execution rowとdescriptorのcontrol読取にも同じDB接続を渡し、detailのsnapshot cutを維持 | 256KiBの先頭chunkを読んだ後にACKとcleanupを更新し、旧streamはnot_sent/unknown、fresh readはaccepted_sent/availableを返す |
| production deferred adapterが実Chatの出力予約を落とし、設定Rと送信Rがずれる | built-in/declared Chat両branchで同期既知のprofile.maxCompletionTokensをwrapperへ公開。Responsesは予約未定義の契約を維持 | 初回generate前のproduction physical I/Oからbudgetを解決し、設定R=2048でも実送信max_completion_tokensをRに用いる。fetchはfixtureで、実provider callは0 |

前置がない通常経路はrequest/current候補のtranscriptを借り、追加のconversation wire計測を行わない。
選択した履歴だけを処理する範囲と、元の保存・source証跡・実送信のrole/順序は維持した。

最新focusedは11 passed / 0 failed、対象source/testのtype check・format・lint・git diff --checkも成功した。
ログは `.tools/increment-218-review-fixes/focused-3.log`、`check-3.log`、`format.log`、`lint.log`。
途中の失敗ログも保全し、最新結果へ混ぜていない。指摘したreviewerによる15分以内の限定re-reviewで、
3件の解消と具体regressionの追加findingなしを確認した。reviewerは追加test/gate/build/providerを実行していない。

第11.12節とメモリ報告書の200turn×3＋新Core再開20turnは、修正前の測定候補に対応する実行証拠として保持する。
今回の修正sourceでfull gate・長時間メモリ再測定は実施していない。
既存gateの710 passed/6 failedとbaseline再現は従来候補の記録であり、今回sourceのgate成功を意味しない。
修正sourceを `.tools/increment-218-review-fixes/henji` へcompileし、`--version`で
build `a636af89…`、runtime SHA256 `513f3166…`、hook v2を確認した。
binary SHA256は `306adf1ba788cfb1abf9c18e14a7b56a682590c3ad5e3f25fd8b6b4e9d3c3019`。
build/versionログと `binary.json` を同directoryへ保存し、実provider準備manifestをこの候補へ更新した。
旧測定binaryは保全した。新候補ではCore起動・provider呼出しを行わず、常用binaryへ配置していない。
実providerは最後の起動/呼出し前で停止中。実DBコピー/切替、常用配置、commit/push、
構想/architecture/roadmapの変更は未実施。

### 11.14 最小限の実providerによる基本動作e2e（2026-10-09）

利用者が「今回の修正点に観点を置かず、henjiの基本的な動きを確認するe2eシナリオを考え
最小限の実プロバイダを使って確認して 許可する」と明示したため、実provider前での停止を
この確認範囲で解除した。4turnの小さいシナリオを定め、既存のOpenCode Go / DeepSeek V4.1 Flash、
effort auto、Chat Completions SSEを使用した。20turn負荷案を追加実行したものではない。

修正後の通常compiled binary（build `a636af89…`、binary SHA256 `306adf1b…`）を使用した。
隔離XDG・workspace・schema3 SQLite、tmux 130×40のproduction TUIから4turnすべてを入力した。
APIはSessionの選択とexecution状態の観測に使用し、task送信はTUIのEnter操作を通した。
Agentはbuiltin Henji base instructionに、会話の保持とファイル操作を指示する短いinstruction、
read/writeを設定した。各turnはmaxSteps=3、providerTimeout=60秒。追加の成功runは行っていない。

| 論理turn | 操作と必要な結果 | 観測結果 | 実request数 | 会話処理秒 |
| --- | --- | --- | --- | --- |
| 1 | 会話で合言葉を伝え、短く返答する。toolは不要 | `HENJI-61D436B0`を返答、TUIに表示 | 1 | 1.926 |
| 2 | `numbers.csv`をreadし、数量37＋58を計算、writeで`result.txt`へ保存する | read→writeの元引数・結果を保存。生成fileは正確に`total=95\n`。最終回答とTUIも95を表示 | 3 | 4.184 |
| 3 | 同じ会話の合言葉と計算結果を、fileを再読せず回答する | 合言葉と95を返答。追加toolなし | 1 | 1.335 |
| 4 | Core/TUIを終了・再起動し、同じ保存Sessionで合言葉と計算結果を回答する | Core epochとWorker generationは変化、Session IDは同じ。履歴を再表示し、合言葉と95を返答。追加toolなし | 1 | 1.706 |

成功シナリオの4turnはすべてcanonical採用・processSettlement complete。
最初の3turnは同じAgent Worker、最後の1turnは新Core/Workerでの再開である。
会話処理は合計9.152秒、setup/TUI/再起動/履歴出力/終了を含む実行区間は10.982秒だった。
成功requestは6回、すべてHTTP 200。返されたusageは物理request単位で重複観測をまとめ、
input 6,267・output 212・total 6,479 tokens。これはこの短い負荷の観測であり、実容量の検証ではない。

最初の試行では、親が隔離provider設定へ通常設定の`user-agent`と`x-opencode-session`を
コピーしなかったため、HTTP 400 / MissingSessionIDを1回受けた。そこで停止し、保存request factを
調べて準備漏れを特定した。通常設定と[OpenCode Go公式要件](https://opencode.ai/docs/go/#where-can-i-use-it)を
照合し、既存のheader設定機能で隔離設定だけを補正、同じ保存Sessionで上の4turnを実施した。
production codeの変更や別modelへの切替は行っていない。
この失敗1回もDBとartifactへ保全した。総実request数は**7回（成功6＋準備漏れ1）**である。

実行後の照合ではcanonical 4turn/12messages、stateRevision=5/nextTurn=5を確認した。
4入力と4最終回答はcanonical全出力に含まれ、readの元結果は入力fileと一致、writeの元引数・結果も
生成fileと一致した。旧失敗executionはnoncanonicalで保持されている。
session/canonical/detailの全履歴を取得し、TUIの各回答・tool成功表示と再開後の履歴表示を確認した。
2つの成功区間のCoreはともに正常終了。一時credentialコピーは除去し、保存artifactにcredential値がないことを確認した。
通常config・実DB・常用binaryは変更していない。

保存先は `.tools/increment-218-basic-e2e/`。`driver.py`、`run.log`、`run-1/result.json`、
`verification.json`、各turnのTUI capture、3種類のhistory、生成file、SQLiteを保持した。
準備漏れの記録は`pre-header-fix-*`へ分け、成功結果へ混ぜていない。raw request/response/SSEは保存していない。
基本動作の確認は完了した。長時間の実provider負荷、child/async/cancel/queueの実provider動作、
常用DBコピー/切替・配置、increment全体の採用/完了承認、commit/pushは今回の確認に含めない。

### 11.15 最新sourceの実provider20turnメモリ同時計測（2026-10-09）

利用者の実provider約20turn許可と同時計測案への「ではやろうか」により、P2 3件修正後の
最新版で実施した。準備案の15turn＋新Core5turnを、同じSession・Agent Workerの20turnへ変更。
OpenCode Go / DeepSeek V4.1 Flash / effort auto、compiled production TUI keyboardで入力した。
最新sourceの隔離コピーへ数値診断と承認済み40fetch上限のcounterを加えたbinaryを使い、
通常runtimeは変更していない。今回counter上限には達していない。

20turnすべて完了・canonical採用、21物理requestすべてHTTP 200。準備した121 byteのread負荷は、
モデルが「exactly once」を会話全体の一回と解釈したため、turn 1でread一回、残り19turnは履歴から
回答した。途中で変更・追加runは行わず、実負荷を報告書へ記録した。毎turn readの確認としては扱わない。

| 時点 | Core RSS/PSS MiB | TUI RSS/PSS MiB |
| --- | ---: | ---: |
| Core起動後・Session前 | 87.30 / 81.25 | — |
| Session後・TUI前・初会話前 | 89.03 / 82.86 | — |
| Session＋TUI・初会話前 | 89.85 / 67.05 | 61.71 / 41.88 |
| 5turn＋2秒 | 132.38 / 104.39 | 73.83 / 50.91 |
| 10turn＋2秒 | 148.56 / 120.58 | 80.69 / 57.76 |
| 20turn＋2秒 | 155.82 / 127.82 | 80.93 / 58.01 |
| 最後の30秒待機後 | 138.17 / 110.18 | 75.32 / 52.27 |

開始前有効空き10,917.72 MiBからCore＋TUI RSS停止上限5,376 MiBを記録した。
合計観測最大238.45 MiBで未到達。Core RSS/PSS観測最大157.55/129.55、TUIは81.15/58.23 MiB。
各contextのheapUsed/heapTotal/external、境界/定期観測最大、保持件数は
[実providerメモリ報告書](../research/increment-218-real-provider-memory-2026-10-09.md)へ保存した。

後半の増加は緩やかになり、30秒待機でCore RSS/PSSが17.65/17.63 MiB下がった。
初会話前からの増分48.32/43.13 MiBは残り、完全な頭打ちは未確認。Agentのsettled時履歴保持は0、
Data/Writerのexecution indexは各1、配送残り0。20turnは閲覧pageの50件境界に届かず、page内保持は増えた。
旧localhostとはsource・file量・tool回数・providerが異なるため、同じ負荷の改善比較は行わない。

canonical 42messageの全入力・全final・read引数/全文結果・content hashとexportを照合し成功。
会話処理34.97秒、明示測定待機43.40秒、driver全体79.35秒。raw/credential/Authorizationは記録せず、
保存runのcredential露出0、一時credential削除、正常shutdown exit 0を確認した。
証跡は `.tools/increment-218-real-memory/`。実DBコピー/配置/commit/pushと第12節の正本変更は未実施。

### 11.16 コミット（2026-10-09）

利用者の「コミットして」に基づき、本実装・test・入力/計画・review対応・localhost/実provider結果と
メモリ報告書を、この記録を含むcommitへ保存する。コード・test・scriptは全体reviewの固定候補または
検証済みP2修正のhashと一致し、`git diff --check`を確認した。追加の実provider実行は行っていない。
測定用 `.tools/`、無関係な `191-result.json` / `scripts/diagnostics/__pycache__/` と別件の
`normal-use-inbox.md`の`/reload`メモ更新はcommit対象外で保全する。
push、常用配置、実DB変更、第12節の正本変更、increment全体の完了承認はこの指示へ含めない。

### 11.17 最新commitのlocalhost200turn再測定（2026-10-09）

利用者の「実プロバイダを使わない200ターン」「昨日の測定に倣って」に基づき、
commit `38eb2423`のsourceを隔離コピーして数値診断だけを加え、compiled Core＋production TUIで
一回実施した。昨日の元Aとbyte一致する512行/59,282 byteのfileを毎turn一度readし、localhost
Chat Completions SSEがOKを返す2request/turn。tmux 110×36、task入力はlocalhost API。
Core/Session/Agent Workerは同じものを継続し、途中再起動・強制GC・追加最適化は行っていない。

全200turn/400requestを完了し、実providerは0。canonical 800messageの全read本文/hash・全OKと、
400requestのsource/全体位置/window差分再構成・実wire/input hash/予算照合に成功した。

| 時点 | Core RSS/PSS MiB | TUI RSS/PSS MiB |
| --- | ---: | ---: |
| Core起動後・Session前 | 84.88 / 78.78 | — |
| Session後・TUI前・初会話前 | 87.01 / 80.79 | — |
| Session＋TUI・初会話前 | 87.45 / 64.57 | 61.42 / 41.67 |
| 20turn＋2秒 | 252.22 / 224.11 | 78.23 / 55.24 |
| 50turn＋2秒 | 272.30 / 244.16 | 82.61 / 59.59 |
| 100turn＋2秒 | 273.16 / 245.02 | 82.86 / 59.83 |
| 200turn＋2秒 | 303.71 / 275.57 | 93.83 / 70.81 |
| 最後の30秒待機後 | 158.71 / 130.57 | 78.44 / 55.30 |

開始前の有効空き11,012.14 MiBからCore＋TUI RSS停止上限5,376 MiBを記録し、
合算観測最大397.78 MiBで未到達。Core RSS/PSS観測最大304.37/276.23、TUIは93.83/70.81 MiB。
各contextのheap/保持件数/最大、傾き、昨日との比較は
[200turn報告書](../research/increment-218-localhost-200-memory-2026-10-09.md)と
`.tools/increment-218-local-memory-200-20261009/`へ保存した。

51〜100turnはほぼ横ばいだが、101〜200のCore RSS/PSS傾きは0.3494 MiB/turnで初期判断線0.25を上回る。
区間peak増分29.72 MiBは初期線64以下。この一回を前回3run中央値の判定へ置き換えず、完全な頭打ちは
確認していない。30秒待機でCore RSS/PSSが145.00/145.00 MiB下がり、20turn＋2秒より93.51/93.54 MiB低い。
20turn＋30秒は今回採っていないため、同じ待機条件の比較とはしない。

20〜200でData/Writer execution indexは各1、Agent本文保持0、prepared/配送残り0。
Writer閲覧pageは9execution/54entity、TUI printedは27を維持した。待機でheapTotalが縮小しても保持件数は同じ。
会話処理30.63秒、明示測定待機86.60秒、driver開始から最終pointまで119.75秒。正常shutdown exit 0。
今回の追加測定結果は未commit。実DB/常用配置/push/product正本変更は行っていない。

### 11.18 Agent Workerのみ終了する追加メモリ測定（2026-10-09）

利用者の「では計測しようか」に基づき、最新版commit `38eb2423`・同じlocalhost負荷で、
新しい隔離Core/Session/Agentの1ターンと200ターンを各一回測定した。毎turn read 59,282 byte→OKの
2request、production TUI接続、各run内は同じSession/Worker。最終会話後30秒待ち、既存の
`ExecutionCoordinator.supervisor.close()`でAgentだけを正常終了し、さらに30秒待機した。
Data/API/Core/TUIは同じPID・generationで残した。実providerは0、強制GC・追加最適化なし。

| ターン | 終了前Core RSS/PSS MiB | Agent終了＋30秒 | 減少量 |
| --- | ---: | ---: | ---: |
| 1 | 108.78 / 83.13 | 97.06 / 73.38 | 11.71 / 9.75 |
| 200 | 182.36 / 154.73 | 100.31 / 74.65 | 82.04 / 80.08 |

200ターン側の解放量は1ターンよりRSS/PSS各70.33 MiB大きく、終了後のCore差は3.25/1.27 MiBに縮まった。
Agent終了前のheapTotalは1ターン9.50、200ターン8.88 MiBであり、RSS解放量の差を説明しない。
本文保持0、Data/Writer execution index各1、prepared/配送残り0を確認した。
200ターン側のCore anonymous RSSは118.95→39.13 MiB。Workerの寿命に対応して解放される部分が残るが、
native/runtime/allocatorのallocation元・Worker専有RSS全量・リークとは特定していない。
TUIは別processで残り、終了後の200ターンと1ターンのRSS差17.71 MiBは残った。

開始前の有効空き11,199.93 / 11,196.58 MiBから、各runのCore＋TUI RSS停止上限5,376 MiBを記録した。
合算最大192.06 / 424.53 MiBで未到達。200ターンCore最大RSS/PSSは331.18/303.56 MiB。
全201ターン/402 localhost request、canonical 804messageのread全文/hash・全OKと全requestの
source/window/実wire/input hash/予算の照合に成功し、正常shutdown exit 0。
会話処理は0.18 / 30.31秒、Core起動〜最終観測は66.76 / 149.62秒。

各条件一回、1ターン側は終了前の最後5秒にも自然回収があり、固定費の厳密な推定とはしない。
200ターン側は終了直前5秒が安定し、close＋2秒ですでにRSS 77.39 MiB減った。
無操作の同時間待機対照・allocation元の特定・再起動後の動作や定期再起動の評価は実施していない。
条件、heap/最大/時系列/smaps/存続確認は
[Agent終了メモリ報告書](../research/increment-218-agent-release-memory-2026-10-09.md)と
`.tools/increment-218-agent-release-memory-20261009/`を参照する。
測定結果は未commit。通常source・実DB・常用配置・product正本は変更していない。

### 11.19 native allocator統計・Agent存続trim・割当/解放stack測定（2026-10-09）

利用者の「ではその順番で計測して」に基づき、同commit・同じlocalhost200ターン負荷を使い、
allocator使用中/空き統計、Agentを残した`malloc_trim(0)`、独立したnative stack profilingの順に実施した。
数値診断とlibc限定FFI許可を隔離binaryにだけ加え、通常runtime/script等283fileはcommitとのhash一致を維持した。
最終会話後30秒、trim後30秒、Agentのみ正常終了後30秒の間、Data/API/Core/TUIは維持した。

| プロファイラなしの時点 | Core RSS/PSS MiB | glibc使用中/空き MiB |
| --- | ---: | ---: |
| 200ターン＋30秒 | 220.98 / 192.33 | 14.05 / 112.59 |
| Agent存続・trim＋30秒 | 125.55 / 96.91 | 14.07 / 112.10 |
| Agent終了＋30秒 | 103.80 / 77.12 | 10.30 / 115.87 |

trimは6ms・返り値1。Agentを終了せずRSS/PSSが95.43 MiB減り、使用中allocationはほぼ不変。
allocatorが保持する解放済みresident pageが大きいことを確認した。空きbyte accountingはresident量ではない。
trim後のAgent終了でさらにRSS/PSSが21.75/19.79 MiB減り、native使用中量は3.77 MiB減った。
前回82.04 MiBは別runであり、その全byteの厳密な内訳に今回の値を置き換えない。

heaptrackとfree backtrace補助をCoreだけへpreloadして独立測定した。初回は補助のunwind header不足で
free一段しか採れず、初回rawを保全してlink修正後にstack測定だけ再実行した。
修正後、終了前のlive cohortのうち終了＋29秒までに解放された3.55 MiBをfree pointer/stackへ全量照合した。
主な経路はSourceMap drop、V8ConsoleMessage deque clear、StringTable/Isolate destructor。
Worker lifetimeのnative metadataを観測したが、診断consoleログと他contextの自然回収も含む。
深いfree stackが途中で止まる経路、直接mmap、プロファイラ自身のallocationは区別し、RSS全量やリークとは扱わない。

全3run・600ターン/1,200 localhost request、canonical 2,400messageの全文/hash・全OKと全request照合に成功。
実provider 0、強制V8 GCなし。開始前の停止上限5,888/5,888/6,656 MiBに未到達、正常shutdown exit 0。
各contextのheap/最大、allocator統計、割当/解放stack、再実行理由と限界は
[native allocator報告書](../research/increment-218-native-allocator-memory-2026-10-09.md)と
`.tools/increment-218-native-memory-20261009/`へ保存した。
今回は診断のみで、通常実装へのtrim組込み・追加最適化・実DB操作・常用配置・commit/push・product正本変更は行っていない。

### 11.20 長い1ターンの実行中にCoreからtrimする隔離スパイク（2026-10-09）

利用者の「これをスパイクで試そうか」に基づき、必要な実行状態を維持したまま、
ターン終了に依存しないCore周期trimを隔離環境で比較した。前回の診断sourceをコピーし、
Core診断moduleにtimer/shadow観測だけを加えた同じbinaryで、control／5秒周期trimを各一回実行した。

各条件、新しい隔離Core/Session/Agent＋production TUIで従来とbyte一致の200ターンを実行後、
同じWorkerで「128 byte fileを200回read→OK」の単一ターンを実行した。各localhost responseに250ms待機。
既存context予算を維持するため小さいtool結果を使い、従来の200ターンと同じ負荷とは扱わない。
Core timerは単一ターンの実行中に11回発火し、全発火の前後を同じexecutionの未settled API観測で照合した。
その後の通常read→OK会話も同じAgent generationで正常完了した。

| 単一ターン実行中 | control | 5秒周期trim |
| --- | ---: | ---: |
| Core RSS/PSS中央値 MiB | 276.96 / 249.33 | 241.46 / 213.74 |
| Core RSS/PSS最大 MiB | 351.31 / 323.69 | 342.35 / 314.62 |
| ターン処理秒 | 57.408 | 57.205 |
| 設定provider待機秒 | 50.25 | 50.25 |
| 設定待機を除いた秒 | 7.158 | 6.955 |

RSS中央値差35.49 MiB、PSS差35.59 MiB。開始時heapと自然GC位相は一致しておらず、差の全量をtrim単独へ帰属しない。
最大値は最初のtrim前5秒も含む。
全11回でtrim返り値1。一回の直前/直後RSS減少は中央値8.43、最大48.27 MiB、native使用中変化は中央値
0.0003 MiB。trim呼出し時間は中央値2.817ms、最大7.375ms、合計40.075ms。
この一回比較では遅延増加を観測していないが、runの揺らぎを含み性能保証とはしない。

全404ターン/1,206 localhost request、canonical 2,412messageの全tool引数/結果/hash・全OKと、
全requestのcontext source/splice再構成・wire/system/tool hash・予算を照合した。
messages最大94,464/94,461 byteで5 MiB上限未到達。開始前のCore＋TUI停止上限6,912/6,656 MiBは
未到達、両run正常shutdown exit 0。実provider 0、強制V8 GCなし、通常source283fileと診断16fileのhash不変。

短い単一長時間実行で、Coreから実行中に空きページを返す経路の成立と継続動作を確認した。
provider待機が実行時間の大半を占める。10時間耐久、CPU/allocator連続占有、複数Session同時負荷は未測定。
5秒周期は実験用で、production採用や間隔は未決定。必要なlive状態の削減とは扱わない。
計画・全数値・各context heap/最大・timerと処理時間・限界は
[実行中trimスパイク報告書](../research/increment-218-active-trim-spike-2026-10-09.md)と
`.tools/increment-218-active-trim-spike-20261009/`を参照する。
通常実装への組込み・実DB/config/常用配置・構想/architecture/roadmap変更・commit/pushは行っていない。

## 12. 本実装に伴う正本変更の具体案

個別incrementの承認と正本変更の承認を混同しないため、以下を実装計画から分けて提示する。

| 正本 | 変更対象/理由 | 意味上の変更案 |
| --- | --- | --- |
| architecture `docs/architecture/henji-host-agent-worker.md` | Data/Agent状態所有、保存/生成、conversation公開、Core control、hook、DBの記述。現行の全文state/proposalとschema1では新経路を説明できない | anchor＋current差分、最新context budget/range、stable全体位置とwindow置換証跡、consumer終端でのregistry/ownerとData Session metadata/cursor解放・DB再取得、Data-owned receipt、bounded page/detail/配送resync、hook v2の保持範囲、schema3/明示コピー切替を反映 |
| roadmap `docs/roadmap.md` | 今回の必要機能/状態。スパイク成立を本実装済みに誤記しない | 218の本実装・localhost確認済みと、実provider未実施・受入判断待ちを分けて記録。最新入力予算、全文保存/限定保持、閲覧/共通経路の実装状態を明記。A3全体や自動compaction/履歴toolは採用済みにしない |

構想の目的/Why/人間の採用境界の変更案はない。
上のarchitecture/roadmapはまだ修正していない。repository AGENTS.mdの
「構想、architecture、roadmapの正本を修正する前に、変更対象、理由、意味上の変更内容を利用者へ提示し、明示的な承認を得る」
に従い、反映前に本表への別途承認を必要とする。
