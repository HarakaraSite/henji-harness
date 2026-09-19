# Increment 87 — journalingのper-insert走査除去（worker_sequence index）

ステータス: **実装・offline検証完了（実provider stallは未解消、B6継続）**

基準commit: `ce69ace3`

計画日: 2026-09-19

実装日: 2026-09-19

## 利用者が必要とする動作

- 長いturnやprovider観測のバースト中でも、TUIのbusy表示（`working`の経過時間・spinner）と入力・表示更新が
  止まらない（B6の残stallを解消する）。
- durableな実行journalの内容・粒度（1観測=1行）・schemaの論理構造は変えない。既存DBにも安全に適用する。

## 根拠

- 通常利用メモB6（2026-09-19）: 長いturnでbusy経過時間が停止。phase計測で`appendExecutionEvents`の
  トランザクションbodyが最大5秒（`BEGIN IMMEDIATE`=0.0ms、`COMMIT`=0.1ms）と判明。
- bodyの実体は`appendExecutionEventTx`が1イベントごとに実行する
  `SELECT max(worker_sequence) ... WHERE execution_id=?`。`execution_observations`に`worker_sequence`の
  indexが無く、PKの`execution_id`前方一致で当該executionの全行を走査していた。実測: `max(ordinal)`=0.01msに対し
  `max(worker_sequence)`=0.8〜1.5ms/回（10,257行時）。バッチ256件で256行時16ms→10,240行時223msとO(n)増大。
- increment 86のバッチ化はper-eventの接続open/closeを除去したが、per-insertのmax走査は残っていた。

## 実装計画

1. `execution_observations(execution_id, worker_sequence)`のpartial index（`WHERE worker_sequence IS NOT NULL`）を
   schema DDLへ追加する。
2. 既存DB（新規作成でないversion 4）にも適用するため、`database()`でindexの存在を確認し、無ければ
   `CREATE INDEX IF NOT EXISTS`を1回実行する。
3. focused testで、indexの列と、既存DBからindexを落として再`initialize()`した場合の再作成を確認する。
4. focused test、`v0:check`／`fmt`／`lint`／`git diff --check`／authoritative `v0:gate`を実行する。
5. 安定候補でisolated XDG＋実providerのtmux検証を行い、busy経過時間が止まらないことを確認する。

## 対象外

- 観測行のcoalesce（旧B）、journalingの別thread/lane化（旧C）、`synchronous`の変更。
- journalの粒度・schemaの論理変更、既存dataの削除。

## Human Gate

2026-09-19、利用者はB6のphase計測結果に基づき、per-insert`max(worker_sequence)`走査の除去（index追加、
必要ならバッチ局所割当）を承認した。indexで十分なことをオフライン計測（バッチ256件が行数に依らず約11ms）で
確認したため、バッチ局所割当は実装しない。

## 結果

- `schemaSql`へ`execution_observations_execution_worker_sequence`（`execution_id, worker_sequence`のpartial
  index）を追加した。
- `database()`で既存DBにindexが無ければ`CREATE INDEX IF NOT EXISTS`をトランザクションで作成するようにした。
- 効果（オフライン）: バッチ256件のflushが10,240行時223ms→**約11ms一定**、5件flushが4.6ms→**0.4ms**。
  O(n)の増大が解消した。

## Verification結果

- focused test `tests/v0/increment_87_journal_index_test.ts` 2件pass（index列の確認、既存DBでの再作成）。
- 既存`increment_40`／`41`／`86` test、`v0:check`／`fmt`／`lint`／`git diff --check`、authoritative `v0:gate` exit 0。
- tmux実機検証（isolated XDG＋実provider）: indexは作成されていてofflineのO(n)は解消したが、**実turnでは
  依然stall**（busy経過時間が最大約10分停止）。計測で`store.tx`の`body`が3〜12件のbatchで15〜29秒、
  `BEGIN IMMEDIATE`と`COMMIT`は0ms台と判明。**index（max(worker_sequence)走査）は残stallの主因ではない**。
- したがって本incrementはindexによる改善（offline O(n)→flat、正しい・有益）を残すが、B6の実stall解消には
  至っていない。残因は`appendExecutionEventTx`のbody内の別処理（live特有のI/Oまたはper-event処理）。
