# Increment 149 — A25 Slice 1・初回DB作成とread-only起動の同期

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-29

ステータス: 実装・検証・review・利用者完了承認・commit・push・常用配置・配置後確認完了。

## 採用動作と根拠

利用者が五sliceのlocal実装と、各slice後のreviewerによるコード・テストreviewを明示指示した。
構成と操作は[複数Core案](../plans/a25-multiple-cores.md)、本sliceの要件・対象・受入は
[五slice実装計画のSlice 1](../plans/a25-implementation-slices.md#slice-1)を参照する。
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

workspace DB rootのOS advisory directory lockで、writer/read-only双方をschema
open完了まで待ち合わせる。readerはlock fileやDBを作らず、writerはschema
transaction内でversionを再読取する。同期はschema openまでで、Session
lifetime・recoveryを含めない。VMでdirectory FD lockと二owner排他を実測した。

確認: real subprocessで二writerの初回Session作成/readback、DB file作成後・schema完了前にB
Coreのlock到達をbarrierで確認、schema完了後のCore history/new
Session利用、read-only空workspace非作成が3件pass。既存Increment99/105の履歴確認6件pass。変更source/fixtureのtype
check、repository configでのfmt/lint、diff check pass。

既存session snapshot test fixtureのstartup
statusが現行contractと不一致だったため、evaluatedのstartup projectionへ修正した。production
contract変更なし。初期schema後の同時provider-free
submitでhistory_io_failureを観測したため、初期化testはstore
allocate/commit/readbackに限定し、write競合はSlice 2で扱う。

reviewerのread-only code/test review: 最大15分、immutable patch
2fa76b6f58453db1ae04eeb86cd5bfb6745f686650ab9b61dfff778cfb1dabcd。Blocking/P1/P2
0件。呼出し経路と3testの対応を確認。readAll
helper単体の余り消失は現fixtureのbarrier後出力に具体的影響がなくfinding不採用。実processはowner実行結果を参照。
