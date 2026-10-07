# Increment 152 — A25 Slice 4・Core一覧・ID解決・個別管理

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-29

ステータス: 実装・検証・review・利用者完了承認・commit・push・常用配置・配置後確認完了。

## 採用動作と根拠

利用者が五sliceのlocal実装と、各slice後のreviewerによるコード・テストreviewを明示指示した。
構成と操作は[複数Core案](../plans/a25-multiple-cores.md)、本sliceの要件・対象・受入は
[五slice実装計画のSlice 4](../plans/a25-implementation-slices.md#slice-4)を参照する。
同じworkspace・XDGで独立Sessionを並行利用し、通常起動は毎回新Core、再接続はID/URLで明示する。
旧DB移行・互換read/writeは不要。既存data削除は含めない。

## 実装・確認・review

本sliceのproduct動作に対応するfocused testと、必要なtype check・format・lint・diff checkを行う。
reviewerが変更されたコードとテストを独立確認し、親が指摘を採否・修正してから次sliceへ進む。
TUIを変更する場合は隔離XDGのtmuxでproduction経路を確認する。
実provider確認は既許可範囲で、対象・量・保存先を事前提示して親が行う。
結果・review記録は実施後に追記する。

## 承認境界

実装・検証・reviewは利用者が完了承認した。2026-09-29の追加指示で関連文書更新、commit/push、常用配置も承認済み。
配置の現在状態と証拠は[合同配置記録](a25-deployment-2026-09-29.md)を参照する。
構想・architecture・roadmapの意味変更とJSR公開は別承認の対象とする。

## 実装結果とreview記録

workspace collectionをread-only列挙し、instance ownershipとendpoint/API
identityを照合して稼働Coreを表示する。Session titleは既存read APIを使い、新durable
stateを追加しない。終了directoryは一覧から外し、owned/unreachableは区別する。full
epochと一意prefixのresolverをCLI/TUI共通化。core
list/status省略は一覧、stop省略は一覧と指定方法だけ。ID/URL同時指定は接続先が二つとなるため受け付けない。

新management3件と既存launcher3件pass。二same-workspace+他workspaceのrealforegroundcoresでlist
human/JSON、未open/active、ID/prefixstatusPID、prefixstop個別性、no-targetstop非停止、停止済み指定、workspace分離を確認。query-only
emptyworkspaceのstate非作成と、ownedunreachableの一覧・targetstop失敗・代替非起動も確認。ambiguityはpure
resolverの候補制御で確認。type/fmt/lint/diffpass。provider callなし。

reviewer code/test review: Blocking/P1/P2 0件。凍結7filesと必要なHTTPcallerを確認。patchSHA
ce6ab23b3b21d2018a7a2f648558e4c32340deded05020e7b684821fb2cab2f1。実testはowner実行結果を参照。TUI
Core指定・表示はSlice5。
