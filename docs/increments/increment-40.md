# Increment 40 — destructive SQLite canonical history cutover

ステータス: **完了（計画承認、実装、test、production受入、差分review済み）**

基準commit: `b41346ab`

対象機能: F04、F05、F08、F11、F15、F26

## 利用者が必要とする動作

- 新しいHenjiはworkspace-local SQLiteを唯一のhistory正本として空の状態から開始する。既存のSession JSON、
  checkpoint、execution artifact、provider evidence、diagnostic、linkはscan、import、変換、互換読込しない。
- 旧JSONは自動削除せず、その場に変更せず残す。ただし新しいproduct経路からはlist、open、recall、diagnostics、
  history exportのいずれにも現れない。旧Session IDを指定しても`session_not_found`になる。
- 成功した新しいturnは、task、execution、canonical turn、canonical message、Session revisionを一つのSQLite
  transactionで確定する。Worker acknowledgementまたはその後のgeneration settlementが失敗しても、確定済みの
  canonical turnをrollbackまたは自動replayしない。
- cutover後に発生したcancelled/failed/no-session execution、provider evidence、failure diagnostic、`/recall`
  source/target attributionをSQLiteから既存のproduction操作で保存・readbackできる。ただしactive executionの
  dispatch前保存とlive event journalはIncrement 41まで行わない。
- `/sessions`、exact Session reopen、model projection、`/recall`、`/history export`、`henji sessions`、
  `henji diagnostics`はJSON directoryを直接読まず、同じSQLite authorityを使う。
- 同じSessionには従来どおり一人のwriterだけが入り、異なるSessionは同時に利用できる。SQLiteの短いwrite競合は
  250 msまで待ち、それを超えた場合はtyped busyとして返し、部分commitを残さない。

## 根拠と確認済みの現在地

- architectureはHostをdurable storageとcanonical adoptionのownerとし、canonical conversation、execution状態、
  context attribution、人間向けhistory view、model projectionを分離している。
- 採用済み全体programは
  [`roadmap-inputs/durable-history-and-context-rebuild.md`](../roadmap-inputs/durable-history-and-context-rebuild.md)で、
  SQLite cutoverをIncrement 40、live journalを41、exact context attributionを42、human history viewを43とする。
- 現行実装は累積Session transcriptとcompanion recordを別々のJSONへ保存する。成功順序はSession JSON commit、
  evidence/diagnostic保存、Workerへのaccepted acknowledgement、Worker settlement観測、execution artifact保存であり、
  canonical Sessionとexecution証拠は同一transactionではない。
- `WorkerSessionStorePort`と`WorkerSessionHandle`はSession create/open/list/commit/checkpointの既存境界だが、
  canonical turnとexecutionを同一transactionにするmethodはない。diagnostics CLIと`/recall`は別storeを直接構築する。
- transcriptは既存のcausal parserにより、先頭user、assistant/tool loop、一回までのsteer、terminal assistant/toolを
  一turnとして扱う。cutover後もこのcanonical grammarとmodel input semanticsを変更しない。
- 導入済みDeno 2.9.4の`node:sqlite`はSQLite 3.53.2を使用できる。別processで`BEGIN IMMEDIATE`を競合させた実測では、
  `busy_timeout=250`に対して約100 ms残るlockは107 msで待ってcommitし、約550 ms残るlockは270 msで
  `ERR_SQLITE_ERROR: database is locked`になった。この結果からIncrement 40のboundを250 msに固定する。

## Product contract

### 1. 破壊的cutoverとSQLite authority

- DBは既存workspace partition rootの`history.sqlite3`、すなわち
  `<stateRoot>/<workspaceDigest>/history.sqlite3`へ一つ置く。workspace identity、XDG state root、canonical
  workspace resolutionは変更しない。
- DBがない場合は空のschema v1を作成する。その際も旧JSON namespaceを検査しない。既存の旧JSONだけがある
  workspaceでもSession listは0件から始まり、最初の新しい操作は新規SQLite stateへ保存される。
- 旧JSON、checkpoint、execution/evidence/diagnostic/linkをscan、import、convert、dual-read、compatibility-read、
  fallbackしない。migration marker、legacy provenance、synthetic legacy executionも作らない。
- 旧ファイルは自動削除または変更しないが、新しいHenjiから到達不能である。旧履歴の削除UI、手動変換tool、
  down-migration、旧binaryと新binaryによる同一state rootの混在運用は対象外とする。
- schemaは`PRAGMA user_version = 1`とDB内metadataで識別する。未知のschema、workspace identity不一致、壊れたDBは
  typed failureとし、schema upgradeや旧JSON fallbackを行わない。

### 2. SQLite configurationとwriter concurrency

- connectionごとに`foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=250`を設定し、
  readbackが一致しない場合は利用を開始しない。transactionは必要なstatementだけを含む短い同期処理とし、
  provider/tool/Worker待機やfilesystem scanをtransaction内で行わない。
- SQLite writeは`BEGIN IMMEDIATE`から明示的にcommit/rollbackする。250 msを超えるconfirmed lock contentionは
  internal `history_busy`へ分類する。Sessionとdiagnosticの既存adapterはそれぞれ`session_busy`、`diagnostic_busy`へ
  写像し、execution/evidence CLIは`history_busy`を返す。他のSQLite errorをbusyへ一般化しない。
- 既存のper-Session file lockを長期writer ownershipとして維持する。同じSessionの二重openはSQLite transactionを
  待たず`session_busy`になり、異なるSessionは別のhandleを同時に保持できる。workspace-lifetimeのsingle-process
  lockは追加しない。

### 3. Schema v1

SQLiteのrelationとpayload authorityを次のように分ける。JSON列は既存codecでvalidateしたcanonical JSONを保持し、
SQLite query用のidentity/state列と意味がずれないことをwrite時とread時に検証する。

| table | 主なkeyと役割 |
| --- | --- |
| `store_metadata` | 一行のschema version、workspace root/digest、作成時刻 |
| `sessions` | `session_id`、agent、created/updated/title、`state_revision`、`next_turn`、current Definition/model JSON |
| `session_model_changes` | Session内ordinal、effective turn、changedAt、selection JSON |
| `semantic_checkpoints` | Sessionごとに一件のV1 payloadとcovered/retained turn、profile、createdAt |
| `tasks` | `task_id`、nullableなcanonical Session ID、常に残すsession correlation、turn、admitted task text |
| `executions` | `execution_id`、task、session correlation、nullableなcanonical Session ID、turn、lifecycle、outcome、adoption、revision、build/Definition/model、nullableなmanifest/Worker attribution、capture status |
| `canonical_turns` | `(session_id, turn)`、unique execution、committed state revision/time、model/build/Definition attribution |
| `canonical_messages` | `(session_id, turn, ordinal)`、execution、Session内global ordinal、validated Message JSON |
| `execution_projections` | target execution、projection kind、source execution/ref、exact projected text、link status |
| `provider_evidence` | evidence ID、必須execution FK、schema/createdAt、validated V2/V3 payload、link status |
| `model_requests` | `(execution_id, request_ordinal)`、evidence ID、lane/phase/model step。payloadはevidence JSONを正本とするindex |
| `failure_diagnostics` | diagnostic ID、必須execution FK、nullable evidence FK、occurredAt、validated V1 payload、link status |
| `diagnostic_evidence_links` | diagnostic IDとevidence IDのexplicit relation |
| `execution_artifacts` | artifact ID、必須execution FK、validated V2/V3 payload、link status |

- 新しいtask IDとexecution IDはUUID v4を使う。v1 schemaはcutover後に生成したrecordだけを表し、legacy record kind、
  legacy ID、import status、import run、推定timestampを持たない。
- new canonical turnではcommitted state revision/timeを必須にする。raw SSE/parser/runtime eventはV2/V3 evidence
  payload内で保持し、model request relationだけをindexする。ordered live journalはIncrement 41の責務とする。
- Session IDのallocateだけではlist可能なrowを作らない。最初のcanonical/metadata commit、または`/new`が要求する
  `materializeEmptySession`で初めてSessionをdurableかつlist可能にする。
- `tasks.canonical_session_id`と`executions.canonical_session_id`は、`--no-session` executionおよびSession delete後の
  evidenceを保持できるようnullableにする。`session_correlation`は常に保持する。Session deleteはcanonical
  Session/checkpointを削除してexecution/evidence/diagnosticを残し、過去のadoption factを書き換えない。
- cutover後のprovider evidence、failure diagnostic、execution artifactは必ず発生元executionへ所属する。Hostは既知の
  execution IDを`commitCanonicalTurn`または`settleNonCanonicalExecution`のtransaction inputとして渡し、3種の必須FKへ
  保存してorphan captureを正規状態として許さない。execution artifactはpayload内`executionId`とFKの一致も検証する。
  execution IDを含まない現行provider evidence/diagnostic payloadは変更せず、evidence/diagnostic IDと、payloadに存在する
  session、turn、build、Definition属性だけをrowおよび発生元executionと照合する。diagnosticのevidence FKはprovider
  request前またはrequestを伴わないfailureを表せるようnullableにする。
- 現行の最大256 valid Sessionとdiagnostic 16件のproduct-visible capacity/error semanticsは維持する。SQLite化で不要に
  なるJSON directory entry制約は新しいstoreへ持ち込まない。

### 4. Store APIとadapter

workspaceごとに一つの`SqliteHistoryStore`を構築し、次のwrite unitを明示する。

- `commitCanonicalTurn(input)`: expected base revisionを照合し、task、settled/completed/canonical execution、
  canonical turn/messages、turn model/build/Definition、Session revision、explicit recall projection、validate済みの
  evidence/model-request index/diagnosticを一transactionで保存する。
- `settleNonCanonicalExecution(input)`: cancelled/failed/no-session executionと、その時点で得たartifact、evidence、
  diagnostic、projectionを一transactionで保存する。dispatch前のactive rowは作らない。
- `recordPostCommitObservation(input)`: acknowledgement、generation availability、protocol settlement、完成した
  V2/V3 execution artifactをcanonical commit後に追記する。この失敗はcanonical transactionをrollbackしない。
- `commitSessionMetadata(input)`: empty Session materialization、title、root model/effort changeをrevision付きで保存する。
  model selectionをWorkerが拒否した場合の現行rollback契約を維持する。
- `installCheckpoint(input)`: checkpointを単独transactionで置換し、commit後にWorkerへacknowledgeする。

read側はSession、execution artifact、provider evidence、diagnosticの既存portをSQLite projectionへ接続する。
`createWorkerSession`、Session navigation、`henji sessions`、`henji diagnostics`、`/recall`が個別のJSON storeを
直接構築しないようcomposition rootを一本化する。fake storeはfocused Host test用に維持する。

### 5. Canonical commitとpost-commit observation

- Workerのcommit proposalを既存causal grammarとrevision/Definition/model contractでvalidateした後、Hostは
  `commitCanonicalTurn`を一回だけ呼ぶ。`lifecycle=settled`、`outcome=completed`、`adoption=canonical`、turn、
  message、Session revisionが同時に成功または失敗する。
- provider evidenceまたはdiagnostic payloadがcodec上invalidな場合は、該当payloadをtransactionへ入れず、executionの
  capture statusへtyped failureを記録する。診断payloadの不正だけで正常なmodel回答を非canonicalにしない。
- diagnostic 16件上限は同じ`BEGIN IMMEDIATE` transaction内で判定する。満杯ならdiagnostic rowだけを省略し、
  executionのcapture statusへ`diagnostic_capacity`を記録して、task/execution/evidence/projection/canonical coreはcommitする。
  `settleNonCanonicalExecution`でも同じ扱いとし、capacityをexecution全体のtransaction failureへ昇格させない。
- SQLite自体のwrite/commit失敗、canonical relationのconstraint failure、expected revision不一致はcanonical transaction
  全体をrollbackし、Workerへrejected ackを返す。個別captureのcodec/capacity failureと区別する。
- commit成功後にHost memoryを更新し、accepted acknowledgementを送る。その後のack delivery failure、Worker
  `turn_end` failure、generation unavailable、execution artifact finalize failureはpost-commit observationとして記録し、
  canonical turnを変更しない。
- processがcanonical commitとpost-commit observationの間で停止した場合、executionはcanonical/completedのまま、
  acknowledgementとgeneration availabilityが`unknown`としてreadbackできる。Increment 40はこのexecutionを
  replayしない。active executionのrestart reconciliationはIncrement 41まで行わない。

### 6. Model projection、recall、history export

- SQLiteから`SessionRecordV6`相当のimmutable projectionを再構築し、既存Worker startup、causal parser、semantic
  checkpoint、model context projectorへ渡す。次のmodel requestへ渡すcontextの意味は変更しない。
- 過去turnの暗黙継承はcanonical messagesとcanonical checkpoint projectionだけから作る。現在executionの
  user/assistant/tool message、明示admitした`/recall` projection、現在task/runtime inputは引き続き加える。
- `/recall`はcutover後にSQLiteへ保存されたsettled non-canonical execution artifact/evidenceだけを選び、次taskだけへ
  投影する。projection本文は`execution_projections`とtarget artifactへ保持し、canonical messagesへ複製しない。
- 現行`/history export`はSQLiteから再構築したcanonical transcriptだけをsnapshotする。non-canonical evidenceを含む
  full-history exportとhuman timelineはIncrement 43まで追加しない。

### 7. CLI contractとfailure readback

- `henji sessions list/delete`の引数、success/error JSON schema、Session metadataをcutover後のdataについて維持する。
  旧JSONをscanしないため、旧JSON由来の`skippedInvalid`は発生しない。
- `henji diagnostics executions list/show`、`evidence list/show`、`list/latest/show/delete`の引数と既存payload schemaを
  cutover後のdataについて維持し、sourceをSQLiteへ切り替える。
- SQLite unavailable、invalid schema/workspace、250 ms超過のbusyを区別する。credential値とAuthorizationは現行どおり
  DBとerrorへ保存しないが、その他の既存diagnostic/evidence payloadは省略しない。
- SQLiteの作成・open・queryに失敗しても、旧JSONをreadback、diagnostics、recall、Session継続の代替に使わない。

## 実装slice

### Slice A — SQLite schema、transaction、port

1. workspace DB path、connection configuration、schema v1、canonical JSON codec、typed error mappingを追加する。
2. `SqliteHistoryStore`のSession metadata/checkpoint、canonical commit、non-canonical settlement、post-commit
   observation、artifact/evidence/diagnostic read portを実装する。
3. canonical transactionの途中statement failureと250 ms busyで全rowがrollbackされること、短い競合後は異なる
   Sessionのtransactionが成功することをreal SQLite/別Workerで確認する。
4. 実際のcanonical transaction payloadで250 ms以内の通常競合と超過時のtyped busyを再確認する。確認済みの
   product経路で250 msが成立しない場合は値を独断で変更せず、測定結果と修正案を利用者へ返す。

### Slice B — production adapterの破壊的cutover

1. Session allocate/open/list/delete、empty materialization、title、model/effort、checkpointをSQLiteへ切り替え、
   `SessionRecordV6` projectionで既存Worker contractを維持する。
2. `WorkerHostSession`をcanonical transactionとpost-commit observationへ分け、commit proposal、rejected/accepted ack、
   generation unavailable、non-canonical settlementを新storeへ接続する。
3. execution/evidence/diagnostic store、diagnostic link、`/recall`を同じworkspace history storeへ接続し、
   `--no-session`のnon-canonical evidence保存を維持する。
4. TUI/Session navigation、`henji sessions`、`henji diagnostics`、canonical-only`/history export`からJSON direct store
   constructionを除き、production composition rootでSQLite authorityを共有する。
5. 旧JSONの存在に関係なく空のSQLite stateから始まり、どのproduction adapterも旧namespaceを読まないことを確認する。

### Slice C — stable candidateとproduction受入

1. READMEへSQLite authority、過去Session非移行、旧JSON非表示/no-fallback、250 ms busy、diagnostics/history exportの
   境界を記載する。
2. Increment 40 focused testと関連regression、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を完了する。
3. stable candidateに対するauthoritative `v0:gate`を一回だけ実行する。
4. isolated XDG root、旧JSON sentinel、standalone binary、real TTYでproduction受入を行い、差分review、結果文書、
   handoffを更新する。

承認後はSlice AからCまで継続し、下記Human Gateまたは停止条件でだけ利用者へ戻す。

## 実装結果

2026-09-12にSlice A〜Cを実装した。workspaceごとの`history.sqlite3`をschema v1で作成し、Session
metadata/checkpoint、task、canonical/non-canonical execution、canonical turn/message、recall projection、provider
evidence、diagnostic、execution artifactを同じauthorityへ保存する。canonical commitとnon-canonical settlementはそれぞれ
明示的な`BEGIN IMMEDIATE`からcommit/rollbackし、canonical commit後のacknowledgementとgeneration状態は
post-commit observationとして分離した。Session削除後もexecution/evidence/diagnostic/artifactは保持する。

productionのTUI、Session navigation、`sessions`、`diagnostics`、`/recall`、`/history export`はSQLiteからの
projectionを使う。旧Session/checkpoint/execution/evidence/diagnostic JSONはscan、import、conversion、compatibility
readせず、SQLite unavailableまたは未知schema時もfallbackしない。同一Sessionのper-Session writer lockを維持し、
異なるSessionのSQLite write競合は250 msまで待つ。

実装後reviewで、canonical commitとpost-commit observationの間でprocessが停止した場合に、既存CLIから
executionを読み出せない窓を発見した。canonical transaction内に`committed_observation_pending`のartifactを
保存し、通常のpost-commit observationで置換するよう修正した。またtransaction helperが
`session_not_found`、`diagnostic_not_found`などを汎用history I/O failureへ変換していたため、既存adapterのtyped
errorを保持するよう修正した。model selection rejectionのSQLite rollback、diagnostic 17件目の
`diagnostic_capacity`、busy probeのevent同期も追加・修正し、再reviewで未解決のBlocker/P1はない。

`agent:increment-40-sqlite-history:test`は14件すべて成功した。Worker foundation 39件、provider stream
20件、Increment 38 recall 6件、Increment 39 cancellation 4件、production CLI E2E 5件のfocused・関連
regressionも成功した。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`は成功し、full `v0:test`も
exit 0だった。authoritative `v0:gate`は一回だけ実行したが、実行終了後にtool出力が回収上限を超えて
終了codeの記録が欠けた。gateを再実行せず、直前のcheck/format/lintのexit 0と、回収のため一回実行した
full `v0:test`のexit 0によりgateの各componentを確認した。

一時standaloneとisolated XDG rootを使うreal TTY受入で、非既定`openai/gpt-5.6-sol`/mediumへの変更、
Session rename、最初のturn、別processからのexact reopenとselection保持、二つ目のturn、canonical-only history
export、SQLite CLI readbackが成功した。異なる二Sessionを二つのreal TTY processで同時実行し、双方の
turnがcommitされた。別のSessionでreal-provider turnをEsc cancelし、source execution
`ec687cfd-f285-44aa-9c98-2f14379a3f50`を`/recall`した次taskが`recall-applied`と応答し、target execution
`ad9c1041-e968-4624-9a93-746e72630bb8`だけをcanonical commitした。history exportにcancelled taskとrecall markerは
混入せず、source/target attribution、diagnostic、evidence、artifactはSQLite CLIでreadbackでき、orphanは0件だった。
read-onlyのDB整合性確認は`integrity_check=ok`、foreign-key violation 0件で、Session 3、task/execution 6、
canonical turn 5、canonical message 10、evidence/artifact 6、diagnostic 1を保持していた。

最終working treeから一時binary `/tmp/henji-i40-candidate`（build
`709539b66e829e21c2f6dfde82adcb3c7fad660835f75f8884cfcaff9b926ee6`）を再生成し、上記SQLiteのSession、execution、
evidence、diagnosticをreadbackできた。validな旧V6 Session/checkpoint sentinelだけを置いたcopyではSession 0件、
旧IDは`session_not_found`となり、sentinelのSHA-256は前後一致した。`history.sqlite3`を利用不能にした
copyは`session_io_failure`となり、旧JSONは同じく変化しなかった。installed binaryは置換しておらず、
実装差分は未commitである。

## Verification

新しい`tests/v0/increment_40_sqlite_history_test.ts`と
`agent:increment-40-sqlite-history:test` taskを追加し、次のproduct動作を一続きに確認する。

- validなV6 Sessionとcompanion JSONをsentinelとしてstate rootへ置いても、first openでscan/importされず、Session listが
  0件、旧exact IDが`session_not_found`で、旧filesのbytesが変わらない。
- 新規Sessionを作成し、title、non-default model/effort、checkpoint、canonical turnを保存する。processを再起動して
  同じSessionを開き、projectionを維持して次turnをcommitできる。allocateだけのSessionはlistに現れず、明示的な
  empty materialization後は現れる。
- cutover後に作成したuncommitted/non-canonical executionを`/recall`し、次turnだけへ投影できる。canonical transcriptへ
  recall本文を複製しない。
- statement faultではcanonical turn/message/execution/evidence/revisionの一部が残らず、ack delivery failureでは逆に
  canonical commitが残り、post-commit observationだけがunknown/failedになる。
- diagnosticが16件ある状態の17件目では`diagnostic_capacity`をcapture status/artifactからreadbackでき、canonicalまたは
  non-canonical executionとevidenceは残る。
- SQLiteを共有する別Worker/別Sessionで、短い競合はcommit、250 ms超過はtyped busy/no-partial-commitになる。
  同じSessionの二重openは既存per-Session lockで`session_busy`になる。
- Session list/delete、empty Session、title、model/effort変更とrollback、checkpoint reopen、no-session settlement、
  execution/evidence/diagnostic CLI、diagnostic-ID evidence lookup、canonical-only history exportをSQLite経路で確認する。
- canonical、failed/cancelled、no-session、Session delete後の各readbackで、provider evidence、failure diagnostic、
  execution artifactが必ず保存済みexecutionへ結び付き、orphan rowがないことを確認する。
- SQLiteを利用不能または未知schemaにした場合に明示failureとなり、sentinel旧JSONへfallbackしない。

実装中はIncrement 40 focused testに加え、変更する具体的経路へ対応する既存の
`agent:worker-foundation:test`、`agent:increment-4-filesystem:test`、`agent:increment-12-model-switching:test`、
`agent:increment-15-provider-switching:test`、`agent:increment-38-recall:test`、
`agent:provider-stream-compatibility:test`だけを必要時に実行する。JSON storageを正本と仮定する既存testは互換性要件にせず、
新しいproduct contractと矛盾するなら修正または削除する。stable candidate前に`v0:check`、`v0:fmt`、`v0:lint`、
`git diff --check`を行い、`v0:test`と`v0:gate`を途中で繰り返さない。

## Production Human Gate

- isolated XDG rootへvalidな旧V6 Sessionとcompanion JSONをsentinelとして置く。candidate standalone binaryでSession
  listが0件、旧exact IDが`session_not_found`、旧filesがbyte-identicalであることを確認する。
- candidateで新規Sessionを作り、model/effortを選択し、real-provider turnを完了する。再起動して同じ新Sessionで
  次turnを完了し、canonical conversationとselectionをSQLiteから継続できることを確認する。
- cutover後のnon-canonical executionを作成して`/recall`し、`/history export`、`henji sessions list`、
  `henji diagnostics`のexecution/evidence/diagnostic list/showを実行する。canonical-only exportとsource/target
  readbackを確認する。
- isolated copyでSQLiteを一時的に利用不能にし、candidateが旧JSONへfallbackせず明示failureになることを確認する。
- 二つのreal TTY processで異なる新Sessionのturnを重ね、正常な短いtransaction競合では双方が完了することを確認する。
  provider timingだけに依存せず、focused別Worker probeの250 ms超過typed-busy結果も受入証拠へ添える。
- production受入は一時binary/stateだけを使い、installed binaryを置換しない。credential値とAuthorizationを記録しない。

## 完了条件

- 旧Sessionとcompanion JSONが存在してもscan/import/convertされず、空のSQLite authorityから開始する。旧filesは
  byte-identicalに残るが新しいproduct経路から到達できない。
- cutover後の新Sessionをproduction経路で作成・reopenし、checkpoint/model/recall/diagnostics/history exportを利用した
  後、次turnを同じSessionへcanonical commitできる。
- 新turnのtask、execution、canonical turn/message、Session revisionが一transactionで確定し、ack/generation
  observationとは分離される。
- failed/cancelled/no-session executionと既存diagnostic/evidence CLIがSQLiteから利用できる。
- 同一Session writer exclusionと異なるSessionの同時利用を維持し、250 ms超過をtyped busyとしてpartial rowなしで返す。
- SQLite unavailable、未知schema、破損時に旧JSONへsilent fallbackしない。
- focused確認、対象check/format/lint、`git diff --check`、一回のauthoritative `v0:gate`、standalone real-TTY
  production受入、差分reviewが完了する。

## 対象外

- 旧Session、checkpoint、execution artifact、provider evidence、diagnostic、linkのmigration、import、conversion、
  compatibility read、synthetic record、proven legacy link、migration report/marker、旧履歴削除UI。
- dispatch前のactive execution保存、event sequence、tool call単位のlive journal、restart reconciliation
  （Increment 41）。
- instruction/skill/tool contract/runtime factのcontent-addressed snapshot（Increment 42）。
- canonical/non-canonical timeline、keyword検索、full-history export、新しいhuman history command（Increment 43）。
- `/rebuild`、`AgentContextGeneration`、Worker交換、resource activation（Increment 44以降）。
- 決定論的replay、過去Worker/外部service/tool effectの再現またはrollback。
- FTS、branch/tree history、remote DB、DB encryption、backup/restore UI、general schema migration framework。
- architecture、構想、installed binary、commit、push、tag、publish、releaseの変更。

## 第三者review

旧migration案への初回reviewは、diagnostic capacityがexecution/canonical coreを失わせないことと、synthetic legacy
executionのunknown fieldを補完しないことを指摘し、修正後に未解決Blocker/P1なしと判定した。その後、利用者が
過去Sessionの移行・変換を不要とし、破壊的cutoverを明示したため、synthetic legacy executionに関するfindingと
migration部分のreview結果は現計画へ適用しない。

本要件変更後の全計画を、同じ独立reviewerが30分上限でread-only re-reviewし、P1を1件報告した。v1をpost-cutover
recordだけに限定した一方、provider evidence、failure diagnostic、execution artifactのexecution参照がnullableで、
orphan captureを正規状態として許す矛盾だった。現行Hostはcanonical、failed/cancelled、no-sessionのすべてでdispatch前に
execution IDを作るため、このfindingを採用した。3種のexecution FKとpayload内`executionId`の一致を必須にし、diagnosticの
evidence FKだけをprovider requestなしfailureのためnullableとした。orphanがないことを各readbackのfocused確認へ追加した。

同じreviewerによる15分上限の再確認では、必須FK化とorphan確認は既存P1を解消したが、provider evidenceとdiagnosticの
現行payloadに存在しない`executionId`との一致まで要求していたsource contract不一致を新しいP1として報告した。既存payload
schemaとCLI payloadを変えず、Hostがtransaction inputとして既知のexecution IDを渡す契約へ修正し、payload内の一致検証は
execution artifactだけへ限定した。provider evidence/diagnosticはそれぞれのIDと、payloadに存在するsession、turn、build、
Definition属性を照合する。追加のbounded確認で既存2件のP1は解消し、変更箇所に新しいBlocker/P1はないと判定された。
read-only reviewのためtestは実行していない。計画はその後、利用者が承認した。

実装後の差分reviewは、機能correctness、明示要件、production経路、transaction不変条件、旧JSON非到達性、
変更したproduct動作の回帰確認を対象に行った。canonical post-commitのreadback窓とtyped error保持の
不具合を修正し、追加したtestとproduction probeで確認した。最終差分に未解決のBlocker/P1はない。

## Human Gateと停止条件

- 利用者はこの文書を承認済みであり、Slice A〜Cの実装・検証を継続できる。
- 承認後はSlice A〜Cを継続して実装・検証し、250 msが実際のcanonical transactionで正常な異Session利用を
  成立させない、JSON direct readを除去できない、またはarchitecture・roadmap、対象機能、外部contract、受入水準を
  変える必要が判明した場合に停止して証拠と代案を利用者へ返す。
- real-provider credentialがproduction Human Gate時に利用できなければ、credential値を読まずavailabilityだけを報告し、
  provider-free fixtureで完了扱いに置き換えず利用者判断を待つ。
- repository外のinstalled binary置換、commit、push、tag、publish、releaseは別の利用者指示を必要とする。
