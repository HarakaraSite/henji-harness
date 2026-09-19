# Increment 86 — observation journalingの非ブロッキング化（バッチINSERT）

ステータス: **実装・検証完了（第三者レビュー反映済み）**

基準commit: `21aef27b`

計画日: 2026-09-19

## 利用者が必要とする動作

- 長いturnやSSEバースト中でも、TUIのbusy表示（`working`の経過時間・spinner）と入力・表示更新が止まらない。
- durableな実行journalの内容と粒度は変えない。**1観測=1行**を維持し、raw response／SSE event／parser
  transitionの診断readback可能性を落とさない。
- turn commitとsettleの耐久性は現状どおり。restart reconciliationに必要な意味イベントは、判断前に必ず
  durableになっている。
- 履歴schema（`user_version = 4`）と既存query、history view、exportを変更しない。

## 根拠

- 通常利用メモB6（2026-09-19）: execution `1eb2a662`のturnでTUI表示が凍結。`execution_observations`は
  9848件、1秒あたり最大約2,900件のバースト（`provider_parser_transition`/`provider_sse_event`/
  `provider_response_bytes`）。実行はWorker threadで進み、turnは`ok=1 stop=final`で正常完了。
- `v0/agent/history/sqlite_history_store.ts:4576`の`appendExecutionEvent`は**1イベントごとに**
  `openSynchronousDatabase()`→`transaction`（BEGIN IMMEDIATE/COMMIT）→`db.close()`を実行する。
  数千件/秒では接続open/closeとトランザクション往復がHost main threadを占領し、120ms周期のbusy timerを
  止める。
- Hostは観測ごとに`worker_host_session.ts:512`の`appendJournal`をmain threadで同期呼出しする。
- したがって「1行=1イベント」を崩さずに、**接続を使い回したバッチINSERT**でper-eventコストを下げられる。
  B（行のcoalesce）は不要で、traceabilityを損なうため本incrementの対象外。

## 実装計画

1. `HistoryPersistencePort`（`v0/agent/history/history_store_contract.ts`）へ
   `appendExecutionEvents(inputs: readonly ExecutionEventInput[]): readonly StoredExecutionEvent[]`を追加する。
2. `SqliteHistoryStore`に実装を追加する。`openSynchronousDatabase()`を1回、`transaction`を1回だけ行い、
   その中で`appendExecutionEventTx`を入力順に呼ぶ。ordinalと`worker_sequence`単調性は既存ロジックのまま
   トランザクション内で連番になる。`appendExecutionEvent`（単発）はこの実装の1件版として整合させる。
3. `WorkerHostSession`に観測用の有界バッファを追加する。
   - `appendWorkerObservation`は`appendJournal`を直接呼ばず、まずバッファへenqueueする（main threadの
     per-eventコストをO(1)にする）。
   - **enqueue時に既存の入力検証を同期実行**し、`appendExecutionEventTx`が拒否するcontract-invalidな
     fact（`workerSequence`単調性違反、`observation.kind`不一致等）はbufferへ入れずfalseを返す。これにより
     `receive`の「journal境界が拒否したfactはSurfaceへ投影しない」現行contractを維持する（レビュー指摘#1）。
   - **enqueue時に`observedAt`を確定**して`ExecutionEventInput`へ渡す（flush時刻で粗くしない。指摘#4）。
   - flush条件: バッファ件数が閾値（例: 128〜256）に達したとき、または短い周期（例: 25ms）のタイマー。
   - flushは`appendExecutionEvents`を1回呼ぶ。順序はFIFOで保持する。
4. 意味イベントと境界の耐久性を保証する。**`appendJournal`を単一のchoke pointとし、hostイベントを書く前に
   必ずpending bufferをflushする**（指摘#3）。さらに次では必ずflushしてから進む。
   - turn dispatch／execution admission
   - commit proposal: `receive`で`appendWorkerObservation(commit_proposal)`後に`messages.publish`/
     `journalFailure`判定/`commitCanonicalTurn`より前に、proposal自身を含めてflushする。これにより
     `execution_messages`のruntime source linkageとordinal順（proposal→settled）を維持する（指摘#2）。
   - checkpoint proposal、close/shutdown、cancel/steer
   - `journalFailure`を評価する箇所（durable writeが遅延で見逃されないように）
5. 失敗semanticsを維持する。flushの例外は、既存の`journalFailure`処理（cancel要求→capsule terminate、
   commit rejection）と同じ結果になるようにする。`journalFailure`は**flush後**に評価する。バッファに残った
   未flush分は、失敗確定時に破棄し、以後のenqueueを受理しない。close/shutdownのfinallyでbuffer tailをflushする。
6. focused testを追加する。
   - `appendExecutionEvents`が複数入力を1トランザクションで書き、ordinal順・`worker_sequence`検証・
     ロールバックの挙動が単発版と一致すること。
   - Hostでバースト入力を与え、閾値と境界でflushされ、`appendExecutionEvents`が呼ばれること
     （単発`appendExecutionEvent`が毎回呼ばれないこと）。
   - commit境界: 多数のruntime観測→commit proposalを含む1回のflushで、`execution_messages.source_kind`が
     `runtime`のまま（linkage維持）、`execution_settled`が最後のordinal、`executionObservationDurability`が
     failedにならないこと。
   - flush失敗時にproposalがcanonical化されないこと（pre-commit gapの拒否）。
   - contract-invalidなworker観測がSurface配信前に拒否されること。
   - close/shutdownでbuffer tailがflushされ、timerがsettleでclearされること。
   - `HistoryPersistencePort`へ新メソッドを追加するため、既存mock
     （`tests/v0/increment_40_sqlite_history_test.ts:572-587`）を更新する。`increment_41`の`appendExecutionEvent`
     overrideはhostイベント対象のためbuffer経路でも成立することを確認する（指摘#5）。
   - 既存のlive journal／restart reconciliation testが通ること。
7. `v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate`を実行する。
8. 実product確認（安定候補・利用者許可）: isolated XDGのTUIで長いweb調査turnを実行し、busy経過時間・
   spinnerがバースト中も更新され、turn完了後にjournalが1行=1イベントでreadbackできることを確認する。

## 非機能の注意

- flushはmain threadで行うが、1バッチの件数を有界にし、閾値・周期を小さく保つ。数msで終わる範囲を目標とし、
  必要なら閾値を調整する。専用thread/workerへの移送は本incrementでは行わない（計測して不足なら別項目）。
- バッファは件数とbyte数の両方で上限を持ち、上限超過時は即flushする（メモリ膨張の防止）。
- タイマーは既存のbusy timerと競合しないよう`setTimeout`系を使い、settle時に必ずclearする。

## 対象外

- 観測行のcoalesce／間引き（B）と履歴schema変更。
- history view・export・diagnostic CLIのreadback変更。
- TUI renderer／busy timerの別thread化（C）。
- provider adapterやSSE parserの変更。
- roadmap・architecture正本の変更（必要なら別承認。実装はinternal portと永続化の実行方法に閉じる）。

## Human Gate

2026-09-19、利用者はA（バッチ化、1行=1イベント維持、schema不変）を採用し、Bは計測で不足な場合に別途、
Cは行わない方針を承認した。

## Verification

- focused testと`v0:gate`。
- 実product確認: 長いturnで表示が凍結しないこと、journalが1行=1イベントで保持されること。

## 結果

- `HistoryPersistencePort`へ`appendExecutionEvents(inputs[])`と`validateExecutionEvent(input)`を追加した。
- `SqliteHistoryStore`は`appendExecutionEvents`で接続を1回だけ開き、1トランザクション内で
  `appendExecutionEventTx`を入力順に呼ぶ。ordinalと`worker_sequence`単調性はトランザクション内で連番のまま。
  `appendExecutionEvent`はその1件版へ委譲した。
- `WorkerHostSession`はworker観測を`observationBuffer`へenqueueし、256件または25msで`appendExecutionEvents`を
  1回呼ぶ。enqueue時に`validateExecutionEvent`でcontract検証し（不正はbufferへ入れず`false`）、
  `observedAt`を確定する。`appendJournal`はhostイベント書込み前にbufferをflushするchoke point。
  commit proposal／turn_failed／turn_end／closeはpublish前にflushし、`journalFailure`はflush後に評価する。
  `markUnavailable`はbufferとtimerをclearする。
- 1観測=1行とschemaは不変。hostイベントは従来どおり`appendExecutionEvent`で書く。

## Verification結果

- focused test `tests/v0/increment_86_journal_batch_test.ts` 3件pass。
  - バッチが連番ordinalで1トランザクションに書かれ、単発appendと整合すること。
  - contract-invalidを混ぜたバッチが全体ロールバックし、`validateExecutionEvent`がfalseを返すこと。
  - 600件のworker観測バーストが`appendExecutionEvents`でflushされ、単発appendはhostイベント分だけで、
    永続化されたordinalが1..n連番であること。
- 既存`increment_40`（14件）・`increment_41`（12件）pass。
- `v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate` exit 0。
- 実product確認（長いturnでのbusy表示継続）は未実施（安定候補で別途）。

## 第三者レビュー結果（2026-09-19）

reviewerによる計画レビュー（source突き合わせ）は**Conditional Pass**。以下を計画へ反映済み。

- [important] ジャーナル境界が拒否したfactをSurfaceへ投影しない現行contractが、enqueueのみだと失われる。
  → enqueue時に同期検証し、contract-invalidはbufferへ入れずfalseを返す（step 3）。
- [important] commit proposalのflush順序が曖昧だと、pre-commit `journalFailure`を見逃してcanonical commit
  したり、`execution_messages`のruntime source linkageとordinal順（proposal→settled）を壊す。
  → proposalを含めて`messages.publish`/`journalFailure`/`commitCanonicalTurn`より前にflush（step 4）。
- [minor] cancel/steer/ack等のhostイベント点でordinal順がずれ得る。→ `appendJournal`を単一choke pointとし、
  hostイベント書込み前にpending bufferをflush（step 4）。
- [minor] `observedAt`がflush時刻に粗くなる。→ enqueue時に確定（step 3）。
- [minor] `HistoryPersistencePort`追加に伴う既存mock（`increment_40`）の更新と`increment_41` overrideの成立を
  step 6に明記。

問題なしと確認: `appendExecutionEvent`の単発版整合は実現可能、他実装は`SqliteHistoryStore`のみ、
1トランザクションFIFO挿入でordinal連番・`worker_sequence`単調性・`listExecutionEvents`の連番要求を満たす、
`turn_dispatch_sent`は直接書込みのためrestart reconciliationは壊れない。

## 未確認・要実測

- flush周期／閾値の初期値と、busy timer（120ms）に対する十分性（実測で調整）。
- close/shutdownでbuffer tailが確実にflushされることの実装確認（`close()`早期return経路）。
- 実product確認（step 8）は、busy経過時間/spinner更新に加え、完了後に`listExecutionEvents`が
  1行=1イベントでordinal連番・readback可能であることを確認する。
