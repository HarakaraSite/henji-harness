# Increment 75 — `/sessions`一覧の耐性（不正recordによる全件失敗の解消）

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

ステータス: **完了（B2実装済み、現行保存形式のSession一覧も確認済み）。**

基準commit: `093a14be`

計画日: 2026-09-18

対象: `/sessions`が`session list unavailable`となる不具合（通常利用メモのB2）。原因は
`sqlite_history_store.ts`の`listWorker()`が、`sessions`表の1件の読めないrecordで`readRecord`が投げる
`SessionStoreError session_invalid`を全体へ伝播させ、そのworkspaceの有効Sessionが全件一覧できなく
なること。record単位でskipして残りを一覧する。

## 利用者が必要とする動作

- `/sessions`で、読める既存Sessionが全件一覧される。
- 読めないrecordが1件あっても一覧全体が`session list unavailable`にならない。
- 上記はproduction TUIの実経路で確認できる。

## 計画

- `listWorker()`をrecord単位でtry/catchし、`session_invalid`のrecordをskipして`skippedInvalid`へ加算する。
  `session_invalid`以外の失敗は再throwし、DB障害等を隠さない。
- 対象Sessionが過去buildのため読めない場合、そのrecordは利用者判断で削除してよい（本incrementで1件削除済み）。

## 対象外

- 読めるが現行Definition revisionと一致しないSessionのresume可否（別問題。一覧には出る）。
- 過去buildのSession recordのmigration/互換読込み（product policyとして追加しない）。
- `listWorker`以外の一覧経路（human history等）。

## Verification

- focused test: `tests/v0/increment_75_session_list_skip_test.ts`（1件、`v0:test`へ追加）。有効record 1件＋
  読めないrecord 1件を用意し、`sessions`が有効1件、`skippedInvalid`が1になることを確認。
- 実データ確認: workspace `967fa641…`のstate DBで、修正前は`listWorker()`が`session_invalid`で失敗。
  修正後は`ok 5 skipped 1`。原因record `6e8de261-…`（productVersion `0.1.3`の過去build）を`store.delete`で
  削除後は`ok 5 skipped 0`。
- production TUI（installed binary、tmux内）で`/sessions`を開き、実Session 5件（`375ca4e7`／`a75bd052`／
  `a44d5c2c`／`84198c9f`／`69dc2e7a`）が一覧され、`session list unavailable`が出ないことを確認。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## Human Gate

- 利用者指示（2026-09-18）: 「B2を先に対応する。過去バージョンセッションが原因なら削除して良い」。
  これに基づき、record単位skipの実装と、原因record 1件の削除を実施した。

## 結果（2026-09-18）

- `listWorker()`をrecord単位try/catchへ変更（`session_invalid`のみskip、他は再throw）。`skippedInvalid`を実数化。
- focused test 1件を追加し`v0:test`へ接続。
- 原因record `6e8de261-31a7-4dae-81bf-a7024723aac0`（過去build `0.1.3`、embedded build manifestが現行で
  validation不合格）を削除。
- installed binaryを再build・配置（build `45d55d6f…`、SHA-256 `1bab8f38…`）。
- `v0:gate` exit 0。
- 残観測: 一覧される5件はいずれも保存Definition digestが現行`builtin/default`（`e28fe12a…`）と異なり、
  pickerで`unavailable`表示。これはexact revision契約による既知の挙動で、本incrementの対象外。過去build
  Sessionを削除するかは別途利用者判断。


## 現行状態の完了整理（2026-09-27）

B07-RでSession
rename・参照・継続を確認した。当初の旧codec不正record対応は後継保存形式で置換済み。仮想不正data
matrixは今回の受入対象ではない。
根拠は[配置binary・実provider E2E](../../increments/e2e-001-132-2026-09-27.md)と、利用者のincrement文書を完了へ整理する指示。
当時の未実施・未確認の記録は履歴として保持し、現在の完了状態とは区別する。
