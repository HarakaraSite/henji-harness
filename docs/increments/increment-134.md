# Increment 134 — assistant途中本文の保存粒度（A12）

状態: 計画・通常レビュー・批判的レビュー後、利用者がスライス単位の実装を指示（2026-09-26）。
両レビューとも採用候補findingなし。slice 1（保存contractとcore transaction）、slice
2（production保存・終了経路）、slice 3（readback接続）、slice
4（production経路確認と容量比較）を完了。localの受入要件A〜Cを確認済み。
2026-09-27に利用者が正本文書への反映と既存DB削除を指示し、architecture・roadmap反映と対象workspaceの
既存v10 DB削除を完了した。A12からassistant本文の重複保存を減らす範囲を採用した。
2026-09-27に利用者がcommit・push・常用binary配置を指示し、実装commitのpushとclean
build・配置を完了した。 常用binaryはsource `ca25d23b…`、build `aeaad975…`。JSR公開は今回の対象外。

## 必要なproduct動作と根拠

- 利用者目的: 現在のDB容量は緊急の問題ではないが、履歴として必要な情報を保ち、重複を減らす。
- 会話で確認した動作: 各model stepの途中本文は生成完了時に確定本文になる。未完了で停止した場合は
  最後に観測・保存できた途中本文を残す。完成後も過去snapshotをすべて残す現行方式を見直す。
- 成功基準: 人間がproduction経路で逐次表示を追え、完了本文、停止実行の途中本文、tool利用と終了理由を
  後から参照できる。同じ本文の接頭部分を表示更新回数だけ別レコードへ保存しない。
- 対象はassistant本文。thinking、tool
  progress、proposal・確定メッセージ間の重複は別の検討対象とする。

### 容量・件数の実測

対象workspaceのv10 DBをSQLite read-only接続・read transactionで集計した。
本文・引数・credential値を出力せず、件数とbyte量だけを取得した（2026-09-26 22:51 JST）。
machine固有のDB絶対pathは本文書へ保存しない。

| 項目                 |                                           実測 |
| -------------------- | ---------------------------------------------: |
| DB本体               |               138,432,512 bytes（132.020 MiB） |
| WAL                  |                   4,589,712 bytes（4.377 MiB） |
| SHM                  |                      32,768 bytes（0.031 MiB） |
| Session / execution  | 21 / 94（completed 85、cancelled 2、failed 7） |
| semantic occurrence  |                                       41,185件 |
| semantic payload合計 |                72,833,444 bytes（約69.46 MiB） |
| assistant progress   |      15,845件、27,411,714 bytes（約26.14 MiB） |

assistant progressはsemantic payloadの約38%。execution・lane・model step・physical requestごとに
最後のsnapshotだけを抽出すると294件、393,474 bytesだった。これは保存粒度の比較用の参考集計であり、
DB全体の削減率の保証、既存レコードの削除指示、完成本文との同一性の証明ではない。

A12の初期観測（2026-09-24、Session `a2098f7c`）は6実行（確定4、停止2）、semantic履歴4,693件、
payload約10.5 MB、確定会話240メッセージ・約513 KB。4 SessionのDB本体24.1 MiB、WAL 4.5 MiBだった。
DBの保存量と次のmodel requestへ送るcontext量は別である。通常利用メモから採用に伴い移した。

## 現行の利用者操作から保存・参照までの経路

1. provider modelが生成中の累積本文をcore loopへ報告する。 `v0/agent/core/loop.ts`はIncrement
   132のcadenceで`assistant_progress`を受理する。
2. `v0/agent/provider/provider_evidence.ts`の`recordAssistantProgress`が、text、modelStep、lane、
   requestOrdinalを持つprovider observationを送る。production Workerは同じ本文をruntime
   eventへ二重送信しない。
3. `worker_host_journal.ts`が観測をbufferし、既存のbatch／timerで保存する。
   `worker_host_coordinator.ts`は同じ観測からSurface向けの全文snapshotをprojectする。
4. `sqlite_history_v7_production_store.ts`はprogressを`assistant_message`種別のsemantic
   occurrenceとして 追記する。model resultも別のsemantic
   occurrenceへ追記するため、完成後も途中snapshotが残る。
5. TUIのlive entryはsnapshotで置換され、model
   resultで確定する。生成中の表示は全snapshotの永続保持を必要としない。
6. 通常のsession viewはcanonical／non-canonical messageから描画する。thinkingは別途semantic履歴から
   最後のstep snapshotを読む。assistant noteはtool
   callに添えた確定本文であり、途中本文とは区別する。
7. `history --view detail`はsemantic
   authorityをexportする。`recalled_execution_context.ts`はjournalから model
   result・tool情報・request factを読み、対応するmodel resultがないprogressを未完了本文へ投影する。
8. writable storeの起動時はactive executionをreconcileする。read-onlyのhistory
   CLIはreconciliationを行わない。

生成意味とlive cadenceはWorker、durable storageとcanonical adoptionはHost、表示はSurfaceが所有する。
今回の変更はHostの保存表現とreadbackを中心に行う。

## 受入要件

### A — 生成中の表示と最新本文

- 現行の行単位の追従、全文snapshotのSurface配送、headless streamを維持する。
- Hostが保存する生成中本文は、対象requestについて最新の1件とする。表示更新ごとの過去snapshotは保存しない。
- 終了処理だけに保存を頼らず、生成中にも既存journalのflushで最新状態をatomicに保存する。
  異常終了後に参照できるのは最後にcommit済みの本文であり、受信済み・未commitの末尾まで保証しない。
- 本文の更新を、別request・別execution・別laneの本文へ混ぜない。rootとchildは各executionに帰属する。

### B — step完了と実行の停止

- model resultをHostが保存したstepでは、そのresultを確定本文のauthorityとする。
  同じrequestの生成中本文を別の永久レコードとして残さない。
- cancel・failure・強制中断で未完了のrequestは、最新の保存済み本文を未完了のsemantic記録として残す。
- 後続stepでcancelされても、既に完了したstepの本文・assistant note・tool call/resultは残す。
  stepの本文確定とturn全体のcanonical adoptionを同一視しない。
- Hostが終了を観測できず再起動した場合も、最新本文を未完了として保存してから既存reconciliationへ進む。
  provider完了や実際の終了理由を捏造しない。

### C — 履歴参照と容量

- `history --view detail`と`/recall`は未完了requestの最後の本文を一つ参照できる。
  確定本文・toolの順序、引数、結果・runtime outcome・短いrequest fact・context
  attributionを保持する。
- session／canonical view、Session再開、assistant noteの時系列は現行の確定message経路を維持する。
  未完了本文を通常会話へ自動採用しない。
- active executionのread-only
  detailは最新のcommit済み本文を読める。読むだけで記録を確定・変更しない。
- 同じ最終本文に対して表示更新回数を増やしても、本文の永続レコード数は増えない。
  payloadとDB／WALの実測を分けて報告し、WALやSQLiteの空きpageをpayload削減率へ混ぜない。

## 保存方式の提案

### Host-ownedな生成中本文

既存SQLite内に`assistant_text_states`（仮称）を設ける。これはderived cacheではなく、未完了requestの
最新本文のsole authorityとする。新しい別DB、raw stream store、Worker側の永続storeは作らない。

- logical key: execution IDとprovider observationのrequest attribution （lane・modelStep・physical
  requestOrdinal）。現行production observationの値を使用する。
- state: 最新の全文、最後の観測時刻・Worker sequence、初回の表示位置を関連付ける情報。
- progress受理時: journal batch内で当該stateだけを置換する。
  同じbatch内に複数snapshotがあれば、永続化する本文は最後のsnapshot一つとする。Surfaceへの配送は間引かない。
- model result保存時: 既存semantic model resultの追記と当該stateの終了を同じtransactionで行う。
- cancel／failure／interruption／restart reconciliation時:
  残っているstateを未完了semantic本文へ移す処理と
  terminalの保存を同じtransactionで行う。処理完了後はそのstateを残さない。

「確定本文とlive stateのどちらもない」commit済み状態を作らない。
stateの終了は本incrementが新規に生成する実行中データのlifecycleであり、既存DBの過去履歴削除とは別である。

現在のsemantic occurrenceと確定内容は追記方式を維持する。本文更新に対して過去semantic payloadを
全scan／decode／rewriteせず、対象requestのstateだけを更新する。全文state更新は本文長に応じた書込みを要するため、
この計画は保存容量の重複を減らすもので、書込み量や応答時間の改善を保証しない。

### 読戻しと順序

Host storeがactive stateと確定semantic記録を区別してreadbackする。`/recall`の未完了本文は
一requestにつき一つにし、既存の完成step・toolの前後関係を維持する。
生成中の全表示更新の時刻・順序は新たなhistory contractには含めない。

read-only detailではactive stateを実行中の最新観測として出力する。これをappend済みsemantic
occurrenceや 確定messageに偽装しない。停止後の記録は通常semantic authorityとしてexportする。

## 実装計画

1. **保存contractとcore transaction**
   - `history_v7_model.ts`／`history_store_contract.ts`へ最新本文のstateと未完了本文のreadback
     contractを定義する。
   - `sqlite_history_v7_prototype.ts`（production core）にstate表とbatch transactionを実装する。
   - semantic append、本文state更新、model resultによるstate終了を一つのcommit境界に揃える。
     semantic ordinal／countは保存するsemantic factに対応させ、Worker sequenceの保存進捗と区別する。
2. **production保存・終了経路**
   - `sqlite_history_v7_production_store.ts`でprogressをstate更新へ振り分ける。
   - canonical／non-canonical settlementとrestart reconciliationに、未完了stateの引継ぎを接続する。
   - journalのflush・cancel前後の観測順を確認し、必要な接続だけ変更する。
3. **readback接続**
   - detail exportと`recalled_execution_context.ts`を新しい本文authorityへ接続する。
   - 確定message経路、assistant note、tool effect、request factの参照を維持する。
4. **product経路の確認と容量比較**
   - 下記のfocused確認、type check、format、lint、`git diff --check`を実施する。
   - 隔離XDGのproduction TUI／headless
     CLIで表示・停止・再起動・history／recallを確認し、結果を本文書へ記録する。

想定変更先は上記history・Worker readback層。provider
parser、model選択、TUI描画方式の変更は計画しない。 接続上の変更が必要ならcore loop、provider
evidence、journal／coordinatorを限定して扱う。

## 検証計画

| product動作                         | 確認方法と根拠                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A・B: 逐次表示→確定本文             | localhostのmock SSEをproduction Workerへ接続し、複数更新が表示され、model result後にstateが残らないことを確認する。Increment 132の実装済み表示が根拠                                 |
| B・C: 完了step→tool→次step取消      | 実toolを含むproduction経路で、完了本文・assistant note・tool結果が保持され、次stepの最後の途中本文だけをdetail／recallから参照できることを確認する。会話で確認した保持動作が根拠     |
| B: provider失敗で未完了本文を保持   | 本文受信後にmock responseを失敗させ、failure outcomeと保存済み本文を読戻す。現行の失敗実行参照を維持する確認                                                                         |
| A・B・C: Host終了処理が走らない場合 | 隔離環境のheadless実行で保存済みstateをread-only detailから読み、当該確認processだけを停止する。再起動後に未完了本文とreconciliationを読み、終了処理への保存依存がないことを確認する |
| C: 更新回数に依存しない保存件数     | 同じ最終本文を異なる表示更新回数で生成し、semantic件数・本文state件数・payload byte量を比較する。今回実測した累積全文重複への直接確認                                                |

既存の関連focused testはIncrement 94 history core、38 recall、39 cancellation、99 history CLI、104
run output、 129 assistant note、132
streaming。必要な動作に対応するcaseを選び、現行snapshot件数だけを要求するtestは 新しいproduct
contractへ合わせる。thinking保存testをassistant本文変更の都合で弱めない。

tmuxでsource／compiledのproduction TUIから、生成中表示、取消、`/recall`、Session再開を確認する。
隔離XDGにlocal mock providerを宣言し、実configへselection等を書かない。
実provider確認は利用者が2026-09-26に承認した。今回の対象・回数・保存先と結果はslice 4へ記録する。
mock確認は実providerのcadence・挙動の証拠ではなく、変更した保存・参照経路の実行証拠として記録する。

## architecture正本への反映（2026-09-27承認・反映済み）

対象: `docs/architecture/henji-host-agent-worker.md`のdurable history／storage不変条件。

理由: 現行は観測progressをsemantic appendへ載せ、異常終了後の証拠をcommit済みの連続ordinal
prefixとして 説明している。提案では生成中の最新本文を同じHost-owned
DB内の可変stateへ保存するため、そのownerと
semantic履歴への引継ぎ、異常終了時の参照対象を説明する必要がある。

反映した意味上の変更:

- 生成中本文はrequest単位の最新durable stateとしてHostが所有し、全更新をsemantic
  occurrenceへ追記しない。
- 完了時はmodel result、未完了停止時は最後の本文のsemantic記録へ引き継ぐ。
- crash後の読戻しには、commit済みsemantic prefixとcommit済み最新本文stateの双方を含める。 semantic
  occurrenceのidentity・追記・canonical adoption境界は維持する。

利用者の「正本本文の反映して」の指示を受け、上記内容をarchitectureへ反映した。
roadmapではF05の保存・active detailとF26の未完了本文readbackへ結果を反映した。
構想の目的・採用境界は変わらないため構想文書は変更していない。

## 非対象と未決事項

- thinking、tool
  progressの保存粒度変更、確定本文の複数保存先の統合、context削減、保存期間、過去履歴のprune。
- 未再現のIncrement 132 C（長時間入力遅延）の原因調査・完了扱い。
- schemaは新contractへ切り替える方針。旧形式のmigration、compatibility
  read、dual-writeは計画しない。 実装・検証は隔離された新DBで行った。計画時には未決だった既存v10
  DBは、2026-09-27の利用者指示で
  対象workspaceのDBを削除した。過去Sessionの変換・migrationは行っていない。
- 本文stateのread-only detail record形状とjournal
  count／sequenceの具体的接続は下記の結果に記録する。
  実装方式が上記要件・architecture変更案を超える場合は、この計画を更新して利用者へ提示する。

## 計画レビュー結果（2026-09-26）

利用者指示により、通常レビューと批判的レビューを独立したread-only reviewerへ委譲した。
対象は本計画と直接関係するproduction source・既存test、各reviewの上限は30分。
通常は要件・現行経路・regression・検証の対応、批判的はstate表の必要性・transaction・順序・
readbackの成立性を確認した。両レビューは約4分以内に結論を返した。

- **通常レビュー**: 採用候補findingなし。保存・Surface配送の分離、step確定とcanonical
  adoptionの分離、 writable reconciliationとread-only
  detailの分離に計画を接続できる。検証計画は変更するproduct動作に対応する。
- **批判的レビュー**: 採用候補findingなし。同じDBの最新本文stateは、semantic
  occurrenceの追記性を維持しつつ 累積snapshotを除く目的に合う。semantic行の直接更新やstream
  deltaの蓄積へ変える具体的な利点は見つからなかった。
- **coordinating owner判断**: 両結論を採用し、必須の計画修正なしとする。以下は既存slice 1・3で扱う
  接続上の注意であり、新しい要件や独立findingではない。

実装時の注意:

1. stateだけを更新するbatchもcommitする。現行coreの`appendSemantic`は空appendを拒否し、独立transactionを
   開く。production側の`event_count`更新も別connectionなので、新batch
   APIでstate・semantic・保存進捗を 一つのtransactionへ揃える。
2. detail exportでstateを読む際も既存のread transactionのDB接続を使う。
   stateだけ別connectionから読むと、model resultへの引継ぎ中に異なるsnapshotを混ぜる。
3. 停止時に追加する未完了本文のsemantic append順と、元の本文の観測位置を区別する。
   保存した位置情報をreadbackへ接続し、`/recall`の複数projectionで本文を重複させない。

根拠source: [core append](../../v0/agent/history/sqlite_history_v7_prototype.ts)、
[production保存・detail export](../../v0/agent/history/sqlite_history_v7_production_store.ts)、
[recall projection](../../v0/agent/worker/recalled_execution_context.ts)。 coordinating
ownerも上記接続箇所と、レビュー中に計画が変更されていないことを確認した。

確認は文書・source・対応testの読取りまで。新方式のproduction表示・停止・再起動・読戻し・容量は
実装後の検証計画で確認する。レビュー中のtest／gate、実DB操作、provider
call、外部書込みは行っていない。
このレビュー自体は実装許可、architecture正本への反映許可、既存DB削除許可を兼ねない。
その後、利用者がスライス単位のlocal実装を指示した。architecture正本への反映と既存DBの扱いは引き続き別の判断である。

## 結果

### Slice 1 — 保存contractとcore transaction（2026-09-26）

- `history_v7_model.ts`にrequest attribution
  key、最新本文state、put／remove更新、batch入力を定義した。
  stateは最新の`StoredExecutionEvent`を保持し、本文と観測時刻・Worker sequenceを二重保存しない。
  `history_store_contract.ts`からstateとkeyの型を公開する。
- schema versionを11へ切り替え、既存SQLite内に`assistant_text_states`を追加した。
  keyはexecution・lane・model step・physical request。optional attributionはDB内部で区別し、
  存在しないprovider laneやrequestを推定しない。初回event位置は最初のputで保持し、更新時も維持する。
- coreに`appendBatch`を追加した。state-only batch、semantic追記、stateの終了、`event_count`更新を
  同じconnection・transactionへまとめる。既存`appendSemantic`はこのAPIを呼び、既存semanticの意味を維持する。
- `listAssistantTextStates(executionId, db?)`は呼出元のread transactionから読める。
- focused確認:
  新規3件（繰返し／同batch更新と再open、同一snapshotの完成引継ぎ、引継ぎ前commit失敗時の
  本文・result・event countのrollback）と既存Increment 94の17件が成功。新規test fixtureのSession
  admission 指定漏れを修正し、新規3件を再実行した。production
  contractをfixtureへ合わせる変更は行っていない。
- testのtype
  check、`deno check --cached-only --config deno.v0.json mod.ts`、変更した4ファイルのformat／lint、
  `git diff --check`が成功。full gate、実provider call、常用DB操作は行っていない。

Slice 1時点では保存基盤のみで、production progressの振分けは旧経路だった。

### Slice 2 — production保存・終了経路（2026-09-26）

- production storeがprovider observationのassistant progressを最新本文stateへ振り分ける。
  同じbatch・requestの複数snapshotは最後の1件へまとめ、最初のevent位置を保持する。
  既存journalのflushとSurfaceへの配送は変更していない。
- model resultはsemantic履歴へ保存し、対応stateを同じ`appendBatch`で終了する。
  progressだけのbatchも本文と`event_count`をatomicに保存する。
- canonical／non-canonical settlement、強制中断、restart reconciliationの共通terminal処理で、
  未完了stateをsemantic本文へ移す。移送とstate終了、semantic ordinal／count、terminal、outcomeは
  同じtransactionへ保存する。過去semantic payloadのscanは行わない。
- 移した本文eventには`firstEventOrdinal`を追加し、元の最新event ordinal・観測時刻・Worker
  sequenceも保持する。 停止時のsemantic append順と本文の元の観測位置をslice
  3のreadbackで区別できる。
- focused確認: 新規production保存2件、slice 1の3件、既存Increment 94の17件が成功。
  新規確認は同batch更新→model
  result→次step取消の保存、終了commit失敗時のrollback→再起動reconciliation。
  完了resultを維持し、停止stepの最新本文一つだけを保存できた。
- 既存Increment 39取消4件、Increment 38 recall 7件も成功。これらのtype checkはcached-onlyでSDK依存の
  `undici-types/index.d.ts`が未cacheのため起動できず、repositoryの既存taskと同じ`--no-check`で実行した。
  新規test／Increment 94のtype
  checkと`deno check --cached-only --config deno.v0.json mod.ts`は成功。
- 変更したproduction store・contract・新規testのformat／lint、`git diff --check`が成功。 full
  gate、実provider call、常用DB操作は行っていない。

Slice 2時点ではreadbackとproduction受入は未完了だった。

### Slice 3 — readback接続（2026-09-26）

- read-only detail exportへ`assistant_text_state` recordを追加した。request key、最初のevent位置、
  最新eventを出力し、semantic occurrenceと区別する。既存exportと同じread transactionのconnectionから
  読むため、途中でmodel resultがcommitされてもstateとsemantic履歴は一つのsnapshotに揃う。
- 停止時に移した本文は、`listExecutionEvents`で`firstEventOrdinal`に基づいて並べる。
  semanticへの追記位置と、生成開始時の観測位置を区別し、生成中に入ったsteeringより後ろへ本文を移さない。
  元の最新event ordinal・Worker sequence・観測時刻も保持する。
- `/recall`ではprovider本文をruntime observationから一度だけ投影し、journal observationへの
  重複投影を除いた。model resultとの対応もlane・model step・physical requestを一致させる。 assistant
  note、tool、context、確定messageの既存経路は維持する。
- focused確認: production保存／読戻し3件、Increment 94の17件、Increment 99の5件が成功。
  生成中detailのsnapshot継続、確定後のstate終了、read-onlyによるactive状態維持、
  停止本文の位置、recall内の本文一回だけの出現を確認した。 新規detail fixtureのsession
  mode・初期revision・model attributionを既存Session contractへ修正した。
- Increment 38 recallの7件も成功。slice 2で確認したSDK型cache不足により、既存taskと同じ
  `--no-check`で実行した。上記25件のtest type check、
  `deno check --cached-only --config deno.v0.json mod.ts`、変更した3ファイルのformat／lint、
  `git diff --check`が成功。

Slice 3時点ではproduction受入は未完了だった。

### Slice 4 — production経路確認と容量比較（2026-09-26）

source production CLI／Workerを隔離XDG・新規v11 DBで起動した。TUIはtmux 110×45で操作し、
capture-paneとproduction history
CLIのreadbackを照合した。確認用workspaceには`sample.txt`だけを作った。
保存先は`/tmp/henji-i134-acceptance-0vosvjma`。`evidence/`にTUI観測、history export、件数・byte量と
照合結果を残した。probeは`/tmp/henji-i134-verify.py`。通常のsemantic記録と短いrequest factを保存し、
raw request／response・SSE・Authorization・credential値は収集していない。

#### localhost mockのproduction経路

- headless `run --json`: 同一最終本文を4回／40回の更新で生成した。両方で逐次deltaが流れ、
  生成中は最新stateが1件、完了後はmodel resultが1件・stateが0件・永久progressが0件になった。
- TUI: thinking→assistant note→実read tool→最終回答を確認した。次turnでは完成stepのnote・ tool
  call/resultを残したまま後続requestをEscapeで取消し、最後の途中本文だけがsemanticへ移った。
  `history --view detail`で未完了本文を読み、session／canonical viewの既存確定内容を確認した。
- active detail: 生成中に別CLIのread-only detailを実行し、`assistant_text_state`が1件、
  executionがactiveのまま読めた。
- `/recall`: 取消実行を選択し、ready表示から次taskを送った。実際にmockへ届いた次requestのcontextに、
  元の未完了本文の先頭が一度だけ含まれていた。保存されたcompleted step・tool情報も保持された。
- 本文12行の後にmockがerrorを返したheadless実行はfailedで終了した。 model
  resultはなく、最後の12行・456 bytesの本文が未完了記録として1件残り、stateは0件になった。 HTTP
  200・`provider_reported_error`の短いfailure factも読戻せた。
- Host終了確認はpersistent TUIで行った。headlessはnonpersistentでhistory
  CLIのSession参照対象にならないため、 active
  detail→Host終了→再起動の確認を同じproduction保存経路のTUIへ揃えた。
  保存済み本文5行の後に当該paneのHost PIDだけをSIGKILLした。再起動前のread-only
  detailはactiveとstateを
  維持し、writable起動後は最後のpayloadをそのまま1件のsemantic本文へ移して`interrupted`になった。
  完了resultや取消理由は生成されなかった。
- Session再開: 完了turnのnote→tool→最終本文、recall後の確定turnが復元された。
  未完了本文は通常会話へ自動採用されなかった。

probe初回のpiped入力指定と、mockのtool実施済み判定を現行のstdin／turn contractへ合わせた。
再起動後の本文照合ではthinkingも同じsemantic kindに入るため、provider progressを区別して照合した。
productionコードをprobeの都合で変更していない。

#### 実providerのproduction経路

利用者承認後、対象を`opencode-go-chat / mimo-v2.6-pro`、完了・取消の2turn、合計上限6 physical
request、 保存先を上記`live/`配下の隔離XDGと提示した。実施は2turn・3 physical requestだった。

- 完了turnは2 request。read前のassistant note、実read toolによる隔離fileの読取、日本語の30行回答が
  TUIに表示された。2つのmodel resultを保存し、同じrequestのstate／永久progressは残らなかった。
- 取消turnは1
  request。本文の異なるcommit済み更新を3回観測し、TUIの`assistant~`表示からEscapeで取消した。
  `cancelled`と未完了本文1件（143 bytes）が残り、stateは0件になった。
  thinkingの既存逐次保存は維持されており、今回の容量削減対象に含めていない。
- 同Sessionのhistory
  session／canonical／detailを読戻し、再起動後のTUIでnote・tool・30行回答を復元した。
  再開したTUIで`/recall`のready表示も確認した。再開・history・recall選択ではprovider
  requestを増やしていない。 次taskへrecall本文を渡す確認は上記mockで実施した。

確認用TUI・mock serverは終了済み。実config・実DB・常用binaryには書き込んでいない。
隔離configへコピーしたcredentialは確認後に除き、値を出力・記録していない。

#### 容量比較

同じ最終本文は1,680 bytesで、SHA-256も一致した。以下のpayloadはsemantic JSONのみで、 SQLite
page・WALとは分けて集計した。checkpointは確認用DBだけに実行した。

| 項目                                    |       4回更新 |      40回更新 |
| --------------------------------------- | ------------: | ------------: |
| 表示delta                               |           4件 |          40件 |
| semantic occurrence                     |          25件 |          25件 |
| semantic payload                        |  23,567 bytes |  23,571 bytes |
| model result / 永久progress / 残存state |     1 / 0 / 0 |     1 / 0 / 0 |
| checkpoint前DB本体                      |   4,096 bytes |   4,096 bytes |
| checkpoint前WAL                         | 593,312 bytes | 889,952 bytes |
| checkpoint後DB本体                      | 245,760 bytes | 245,760 bytes |
| checkpoint後WAL                         |       0 bytes |       0 bytes |

payloadの4 bytes差はmock model IDの長さの差を含むrequest metadataによるもの。
本文更新回数を10倍にしてもsemantic本文の件数は増えなかった。一方、更新が多い方のWALは増えた。
stateの全文置換も書込みを行うため、書込み量や長時間入力遅延の改善は今回の結果から保証しない。
これは新規DBでの保存粒度の確認であり、実v10 DBの132 MiBを縮小した結果ではない。

#### 最終確認と残る境界

- 関連focused test: Increment 132（5件）、129（2件）、104（7件）、120（5件）の計19件が成功。
  既存taskと同じ`--no-check`で実行した。slice 1〜3の保存・readback確認に加え、thinking、assistant
  note、 headless出力、Surface追従の既存動作を確認した。
- `deno check --cached-only --config deno.v0.json mod.ts`と`git diff --check`が成功。 sourceはslice
  3から追加変更なし。full gateは計画しておらず実行していない。
- local実装・受入要件A〜Cの確認は完了。構想・architecture・roadmap正本の更新、commit／push、
  常用binary配置・公開は未実施。architecture変更案は上記に留めている。
- 既存v10 DBは新sourceの対応外であり、常用切替前に扱いを利用者と決める。
  過去履歴の削除・変換・migrationは行っていない。

### 正本文書反映と既存DB削除（2026-09-27）

- 利用者が正本文書の反映と既存DB削除を明示指示した。architectureのdurable history、storage不変条件、
  Host／Worker責務とturnの流れを最新本文stateの所有・atomic更新・semanticへの引継ぎへ合わせた。
  roadmapのF05／F26へ実装結果を反映した。構想の目的は変更していない。
- 対象workspaceの既存DBをread-onlyで確認した。schema v10、22 Session・96 executionだった。
  Henji実行プロセスおよび対象fileの利用中processがないことを確認し、DB本体とWAL・SHMを削除した。
  削除したbyte量は本体143,142,912、WAL 4,589,712、SHM 32,768。削除後に3 fileの不存在を確認した。
  対象workspace以外のDB、config、managed resource、隔離検証DBは今回の削除対象にしていない。
- 常用binaryはまだIncrement 133のv10実装のままである。次の配置対象はschema v11の新sourceとなる。
  今回はDBを新規作成するHenji起動、binary配置、commit／push、公開を行っていない。

### Commit・push・常用binary配置（2026-09-27）

- 利用者指示により実装と正本文書をcommit `ca25d23bc416bb16779ab3b8581a97ec26a75066`へまとめ、
  `origin/main`へpushした。fetch後のlocal／remote一致を確認した。
- A12の新規6件を`agent:increment-134-assistant-text:test`へまとめ、通常の`v0:test`からも呼ぶようにした。
  当該taskのtest・type check、変更した8ファイルのformat check・7 TSファイルのlint、
  `git diff --check`が成功した。
- cleanな上記commitからDeno 2.9.7で`dist/henji`をbuildした。 product versionは0.7.0、source
  dirtyなし、buildは `aeaad97597f3f3613744ab6baf58f59954924cad4be577c5c239fed4fc934f14`。
- 配置対象binaryをtmux上のproduction TUIで起動し、隔離XDG・localhost mock・新規v11 DBで
  逐次表示、note→実read
  tool→最終本文、後続step取消、history各view、`/recall`選択、Session再開を確認した。
  完了requestのprogress／stateは残らず、取消requestの未完了本文は1件だけ保存された。
  今回の追加確認で実provider requestは行っていない。
- 常用先`~/.local/bin/henji`へ原子的に配置し、候補と配置先のSHA-256一致、version／source／buildの一致を確認した。
  配置binaryで対象workspaceのread-only `history --latest --view session`を実行し、exit 0・no
  historyを確認した。 削除済みの実DBは再作成されていない。次の通常実行は新規v11 DBを使用する。
- artifact:
  `/tmp/henji-i134-deployment-0wqngjvt/{build.log,version.txt,deployment.json,evidence/}`。
  稼働中のHenji切替は行っていない。JSR公開は今回の対象外であり、JSR 0.7.0の内容はIncrement
  133時点のままである。
