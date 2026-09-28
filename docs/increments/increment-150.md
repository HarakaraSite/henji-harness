# Increment 150 — A25 Slice 2・共有DBの発見・write待機・recovery

更新日: 2026-09-29

ステータス: 実装・検証・review・利用者完了承認・commit・push・常用配置・配置後確認完了。

## 採用動作と根拠

利用者が五sliceのlocal実装と、各slice後のreviewerによるコード・テストreviewを明示指示した。
構成と操作は[複数Core案](../plans/a25-multiple-cores.md)、本sliceの要件・対象・受入は
[五slice実装計画のSlice 2](../plans/a25-implementation-slices.md#slice-2)を参照する。
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

未初期化のCore history queryは現在のDB存在を再statし、他processの新規DB作成を認識する。helper
write接続とsemantic長寿命接続は、WAL等の設定前に同じbusy_timeout=5000msを適用する。operation
retryは加えていない。recoveryが取得したSession/Execution
lockは、対象rowの処理終了時にfinallyで解放する。

確認: Increment150新規6件pass。B CoreをDB未作成で起動し別process
Aが保存、BのHTTP一覧/historyでreadback（B
slotはnull）。二writerをbarrierで同時submitし、別Sessionのcanonical
turn/readbackを確認。生存親/子Executionのlockを尊重してactiveを維持し、owner終了後のrecoveryと取得lock解放を確認。一覧取得後に別storeがsettledへ変えたcanonical
Sessionを、recovery storeを開いたまま明示resumeできることを確認。

実SQLite writer transactionを別processのBEGIN到達markerから400ms保持し、helper admissionとsemantic
appendの双方が待って完了・保存することを確認。旧helper250msを超える実保持で、5秒設定の短transactionへの妥当性を確認した。負荷上限や長いtransaction全般の保証にはしていない。

既存134productiontext/105list4件、headless104のfinal/JSON/stream9件pass。変更source/fixture type
check、fmt、lint、diff check pass。realproviderなし。

reviewerはimmutable
Slice2差分893004762ee42d3359ac4f5ac162df1ac0665f69052eba8dab14b69f075de07dをcode/test
review。初回Blocking/P1/P2 0件。reviewerがwrite-wait
fixtureのbeginも長寿命接続を通ることを確認し、確認範囲の記述を修正した。fixtureをsessionRecord付き初回persistent
admissionへ変更し、helperの#writeSession
BEGINへ到達する形で2件再確認、fixtureの限定re-reviewを実施した。最終差分SHA104ade41404fb584f6849ce6a26b71e7670626e757dff5d31d30ed442ce92653。限定re-review
finding0。helper/semantic接続それぞれの待機実経路を確認。
