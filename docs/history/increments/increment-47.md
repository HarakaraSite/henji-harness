# Increment 47 — Temporary `/new` Session binding

ステータス: **完了（2026-09-13）**

基準commit: `a8857912`

対象機能: F01、F04、F05、F10

## 利用者が必要とする動作

- `/new`は新しいSession bindingへ切り替えるが、その時点ではturn 0の空Sessionを保存しない。
- 最初のturn、rename、provider/model/effort変更は、通常起動と同じ既存commit経路で新Sessionを保存する。
- durable state変更のないまま終了または保存済みSessionへ切り替えた場合、新Sessionは一覧へ残らない。

## 根拠と確認済み状態

- 通常起動はSession handleだけを予約し、最初のdurable state変更前に終了するとSessionを保存しない。
- `/new`だけが`materializeEmptySession()`で空recordを先にcommitし、即時にSession一覧へ残している。
- turn proposal、rename、model selectionには、未materializeのhandleを初回保存できる既存commit経路がある。
- 利用者はS7を採用し、`/new`を通常起動側のlifecycleへ揃える方針を選んだ。

## 承認済み実装範囲

1. `/new`のtarget setupからturn 0の先行materializeを外す。
2. 先行materialize専用のcleanupとHost methodを除く。
3. 最初のturn、rename、provider/model/effort変更による保存を既存durable admissionで成立させる。
4. durable変更のない終了・Session切替でrecordが残らないことと、既存setup failure動作をfocused testで確認する。

## 対象外

- Session schema、一覧UI、通常起動、resume、historyの意味変更
- 新しい保存契機、migration、compatibility経路
- architecture、roadmap、構想の変更

## Verification

- Increment 35の`/new` lifecycle testと、変更したSQLite rollback testを実行する。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`はIncrement 46〜48の安定候補でまとめて実行する。

## 実装結果

- `/new`のturn 0先行commitと、そのrecordを削除するcleanup分岐を除去した。専用だった
  `materializeEmptySession()`も除去し、通常起動と同じ未materialize handleから開始する。
- 無変更の新bindingはSession一覧へ現れず、保存済みSessionへのswitchまたはclose後もreadできないことを確認した。
  最初のturn、rename、provider/model/effort変更は、それぞれ既存commit経路でSessionを保存した。
- Increment 35 suite全3件とSQLite rollback focused testが成功した。既存のnew Session setup failure時にcurrent
  bindingを維持する動作も成功した。static check一式はIncrement 46の実装結果に記録した。
