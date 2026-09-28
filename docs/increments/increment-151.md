# Increment 151 — A25 Slice 3・Core別discoveryと新規起動

更新日: 2026-09-29

ステータス: 実装・検証・review・利用者完了承認済み。commit・push・常用配置は作業中。

## 採用動作と根拠

利用者が五sliceのlocal実装と、各slice後のreviewerによるコード・テストreviewを明示指示した。
構成と操作は[複数Core案](../plans/a25-multiple-cores.md)、本sliceの要件・対象・受入は
[五slice実装計画のSlice 3](../plans/a25-implementation-slices.md#slice-3)を参照する。
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

epochをspawn前に採番し、bootstrap引数・service・HTTP/SSE・endpoint/bootへ同一identityを渡す。discovery
metadataとstartup/instance lockはworkspace collection内のepoch
directory単位。通常launcherとserveのsingleton再利用を廃止。serveは毎回foregroundの新Coreを作る。URL
connect/stopは維持し、stopのlocal
ownership待機を対象epochへ限定。引数なしstatus/stopは、この中間sliceではURL指定案内だけを返す。

確認: source
launcher3件pass。並行prepareの別PID/epoch/URL、別workspace、二Session、対象URLstop後endpoint消去・instance解放・他Core存続、次launch新epoch、no-targetstop非停止、foregroundserve二起動・unopenedslot・HTTPreadyを確認。HTTPshutdown3件pass（activeBash/SSE/slotopening
cleanup）。type/fmt/lint/diffpass。

compiled binaryをrepository外workspace・隔離XDGのproduction
tmuxで通常henji二起動。別Core/Session、Adetach、URLreattach、Bdraft維持、個別stopでB存続を確認。初回証拠
/tmp/codex-agent-context/a25-implementation/tui-slice3-20260928-235811/summary.json。provider
callなし。確認用Core/tmuxは個別cleanup済み。

reviewer初回:
Blocking0/P10、P2一件（F1help/HTTP操作文書の旧再実行reattach案内）。採用しURL明示接続へ変更。compiled
F1確認で末尾案内がviewport外だったため、同じ修正内で上部へ移し実表示を確認。最終compiled
hash724d381068cd9c93d5013994e10d18f7dfb7e75a3c0dddf4c3e10583822d4abe、tmux証拠
/tmp/codex-agent-context/a25-implementation/tui-slice3-fixed-20260929-000432/{a-help.txt,summary.json}。初回text位置確認probeはtimeoutしcleanup済み、移動後probeはpass。

限定re-reviewは同一P2の解消と変更部分だけを確認。最終patchSHA
a8ffb3944e4c752fbb59167e40473bf4c505fa2f7acdda52f6f05157f6c9aad1。限定re-review追加finding0、既存P2解消。ID管理・TUI
Core表示は後続slice。
