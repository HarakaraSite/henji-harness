# Increment 153 — A25 Slice 5・TUIでのCore指定・識別と通常利用の完成

更新日: 2026-09-29

ステータス: 実装・検証・review・利用者完了承認済み。commit・push・常用配置は作業中。

## 採用動作と根拠

利用者が五sliceのlocal実装と、各slice後のreviewerによるコード・テストreviewを明示指示した。
構成と操作は[複数Core案](../plans/a25-multiple-cores.md)、本sliceの要件・対象・受入は
[五slice実装計画のSlice 5](../plans/a25-implementation-slices.md#slice-5)を参照する。
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

通常起動は毎回新Core・新Sessionとなり、`henji --core ID`
は生存Coreへの明示再接続となる。IDは完全値または一意なprefixを使い、`--connect URL`
との同時指定はできない。Coreを選んだ後に既存のSession操作を適用するため、`--core ID --new`
は選択したidle CoreだけでSessionを切り替え、`--session savedID` は新Coreで保存Sessionを再開する。

HTTP snapshotの既存cursor epochをpresentationへ渡し、通常・compact表示のSession行に短いCore
IDを表示する。永続Session
stateは増やさない。help、README、HTTP操作文書を新規起動・一覧・ID/URL再接続・個別停止の操作へ揃えた。旧DBのmigration、互換read/write、既存data削除は行っていない。

確認結果:

- Slice 5の新規focused test 2件と既存terminal確認26件が通った。既存の143 activation/remote
  Session確認5件も通った。各testはCore選択とSession targetの分離、Core
  identity表示、既存TUI操作に対応する。
- 安定候補のauthoritative `v0:gate` がtype
  check・format・lint・全478件のtestを通過した。初回は既存143の二test
  fileのformatで停止したためformatだけ修正した。次は92のjournal失敗注入が旧append入口だけをoverrideし、実際の
  `appendExecutionEventsWithSemanticIds`
  を通る経路へ注入されていなかった。fixtureを現行入口へ合わせ、focused92の10件を確認してからgateを再実行した。production
  journalを変更していない。再実行理由と各logは
  `/tmp/codex-agent-context/a25-implementation/gate-final*.log` に保存した。
- checkout外のcompiled binaryを隔離XDG・tmuxで起動し、二つの通常TUIから実provider
  taskを並行実行・完了・canonical履歴readbackした。実行中のdetachとID再接続で同じCore・Session・tool
  PIDが継続し、他方のdraft・workingも継続した。Ctrl-Cの入力クリア、同Coreへの二TUIのdraft分離、選択Coreだけの新Session、保存Sessionの新Core再開、通常100×35でのCore
  ID表示を確認した。証拠は
  `/tmp/codex-agent-context/a25-implementation/tui-final-20260929-001753/`。
- 同じcompiled binaryで二Coreの親・子bashを同時稼働させ、親cancelと `core stop --core ID`
  の二ケースを確認した。Aの親子toolだけが終了し、Bは同じPIDで継続して親・子ともcompleted、親canonical履歴を保存・readbackした。終了したA
  childはcancelled/interruptedとしてsettledとなった。全観測descendantと検証Coreは終了した。証拠は
  `/tmp/codex-agent-context/a25-implementation/children-20260929-001946/summary.json`。

実providerは事前報告済みのOpenRouter Responses / `xiaomi/mimo-v2.6-flash`
を使った。semantic履歴のphysical request startから、成功TUI確認4回、親子cancel9回、親子Core
stop9回、途中のprobe
timing修正前の確認2回＋2回、計26回とreadbackした。途中probeは二client目へのkey送信がTUI準備前だったcaseと、初回model
response待ち40秒で確認側が打ち切ったcaseであり、source変更ではなくprobeの待ち合わせを修正した。隔離configのcredential
copyは全caseで除去済み。実configやcredential値を変更・出力していない。

検証compiled buildは `29a43b113ede34b012e9fe21dd58d7eb65f58ed5de279a2c8155fd3c6d8ebc72`（source
revision `c5ad9c72…`、local変更を含む）。artifactは
`/tmp/codex-agent-context/a25-implementation/compiled-acceptance/henji`。常用binaryは更新していない。

初回60×14のcompact TUIもcompiled
binaryで別途確認し、Core・Session双方の短いID全8桁がidentity行に表示された。証拠は
`/tmp/codex-agent-context/a25-implementation/compact-initial-20260929-002855/{summary.json,screen.txt}`。最初の100→60
resize画面は通常枠が残っていたため、compact初期描画の証拠とは分けた。追加確認のprovider
callは0回。確認scriptのHTTP
prefix誤りによる404はscriptだけを修正し、両試行のCore・tmuxは終了した。production
sourceは変更していない。

reviewerによるread-only code/test reviewは最大15分で完了し、Blocking/P1/P2
0件。凍結13filesと関連caller、Core選択後のHTTP
Session操作、表示だけへのepoch受渡し、Session切替時のCore
identity保持、143のformatだけの差分と92のfixture入口を確認した。compiled実測の保存証拠も照合した。patch
SHA256は `0de480291caadd54028d72dfb4e3ceb77d6d384457452d3569e37683c653233b`。reviewerはfull
gate・provider
callを実行せず、ownerの結果を参照した。追加compact確認にもsource/test変更はなく、レビュー後の凍結差分は維持している。

## 追加E2E — 保存tool履歴の継続とheadless caller併走

利用者がgpt-6-astraへ未実測の実利用case設計を依頼し、その推奨scenarioの実行を明示許可した。
初回tool付き作業を保存して元Coreを停止し、新Coreで保存Sessionの会話を使って実provider taskを続けた。
そのtool待機中に同workspace/XDGのcompiled `henji run --json`
を通常子processのstdinから呼び、別作業を併走した。

一回の実行で成功。OpenRouter Responses / `xiaomi/mimo-v2.6-flash`、見込み・実績とも6 physical
requests （初回2、保存会話継続2、headless2）、HTTP response statusは全て200だった。
過去の案件情報を再記載せずに生成した案内文は、元tool結果の案件名・仮押さえ・確認ボタンで確定という方針を反映した。
再開後のmodel contextへ前回のtool_call/tool_resultがcanonical source
relationで入ることもsemantic履歴から確認した。

両toolの同時PID生存をbarrierで観測し、TUIの新turnはcompleted/canonical保存とHTTP readback、
headlessはtool_call/tool_resultとterminal result/ok:trueを含む有効なNDJSON・最終応答・exit
code0・正しい独立成果物を確認した。
共有SQLiteの三Executionは全てsettled/completed。TUI二turnはcanonical、headlessはnon_canonicalで、
headlessの保存Session/canonical生成は成功条件にしていない。

証拠と詳細結果: `/tmp/codex-agent-context/a25-additional-e2e/run-20260929-005712` の
result.md、summary.json、 resumed-history-replay-proof.json、HTTP
readback、tmux画面、NDJSON、成果物、短いrequest facts。 再試行・production source/test変更・full
gate再実行なし。作成Core・headless process・観測tool・tmuxは終了、一時credential copyは除去済み。
今回までの実装後実provider実績は、先の26回と追加6回で計32回。常用binaryは更新していない。

## 全体コード・テスト俯瞰review

利用者指定により、五sliceの凍結31fileと関連callerを新しいreviewerがBlocking/P1だけに限定して確認した。
最大15分・実績約6分、Blocking0/P10。Core epochの受渡し、Core選択後のSession操作、共有DBの初期化・
再発見・write待機・recovery lock解放、親子tool終了、独立headless経路と対応testを確認した。
compiled実測の保存証拠も照合し、今回のreviewではsource/test変更・test/gate/build/provider再実行は行わなかった。
凍結patch SHA256は `909adbd0c6156eacfa3544780cbe589dfacae21fa7401e379c3c04902852d990`。 詳細記録は
`/tmp/codex-agent-context/a25-overall-review-20260929/review-result.md`。
