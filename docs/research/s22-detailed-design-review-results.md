# S22詳細設計・CLI設計 — 通常レビュー・批判的レビュー結果

実施日: 2026-09-27

## 初回レビューの結論

独立した二人のread-only reviewerが、詳細設計とCLI設計の同じ凍結版を確認した。
**Blocking／P1は確認されなかった。P2は通常レビューから1件、批判的レビューから1件。**
coordinating ownerも該当する文書・production sourceを確認し、2件を採用する。

Slice 1への進行を妨げる問題は確認していない。 ただし、Slice
4のfollow-up読取経路とSlice
5のcompaction範囲は、下記の修正を設計に反映してから採用する必要がある。
今回の依頼はreviewであり、修正案の記録に留めた。対象設計とruntimeは変更していない。
実装着手の承認、HTTP化後の動作確認、実装受入を意味しない。

## 対象・条件

- [詳細設計・8slice計画](../plans/s22-detailed-design-and-slices.md)。 SHA-256:
  `24b9b91ee5d2a76694aaca46fe9cf77b65abfaba997c3e0e35c123dbae617f08`。
- [CLI・外部API利用設計](../plans/s22-cli-and-external-api.md)。 SHA-256:
  `adeb7763db6f6c14e725786c7795521a9e3c0604a7a8e1a9de360fb776cfd453`。
- Source基準: commit `c4da8f7956d5152f739c868c38f6ca25f1903388`。
- 現在段階: 詳細設計・slice計画案。runtime実装は未着手。
- 通常レビュー:
  明示要件、現行機能、schema／core／UI、CLI／slash、段階移行の整合。
- 批判的レビュー: 起動、独立lifetime、active／view Session、受付／commit／清算、
  follow-up、snapshot／SSE、identity、第三者API、run／history／streamの具体的破綻。
- 上限: 各20分。新しい証拠・tool結果・中間結論が10分なければ停止。
  両レビューとも2026-09-27 11:14〜11:20 UTC内に完了し、延長していない。
- 対象外: 一般的hardening、仮想的状態matrix、未採用機能の追加、cosmeticな改善、
  test件数、full gate、provider call、production TUI、runtime変更。

会話履歴は継承せず、親が作成した一時context packetと凍結文書を渡した。
旧検討文書へのreview結果は入力に含めず、独立に判断した。
findingは明示要件・sourceの根拠、利用者影響までの経路、test不足だけではないcorrectness問題を必要条件とした。

## 通常レビュー: P2 — 手動compactionを既存操作として移管している

対象は詳細設計644行、782〜801行。
補正対象には同文書366〜368行のpreview／compact／cancel
routeと414行のoperation設計も含む。 設計はpreview・confirm
overlayと手動compactionを「既存操作」として接続TUIへ移し、Slice
5の受入に置いている。

しかし、productionの[createWorkerSession](../../v0/agent/worker/worker_tui_session.ts#L669)が生成する
[WorkerHostSession](../../v0/agent/worker/worker_host_session.ts#L25)には、
`compactContext`も`contextCompactionPreview`もない。
[adapterのpreview](../../v0/presentation/tui_presentation_adapter.ts#L286)はoptionalなcore操作を参照し、
存在しなければundefinedになる。
したがって[tui_cliのcanCompact](../../v0/agent/cli/tui_cli.ts#L438)はfalseで、
現行production TUIに手動開始のoverlay／slash経路はない。
残存する[旧AgentSessionのpreview・開始API](../../v0/agent/session/session.ts#L272)は、
現在のWorker経路から呼ばれるものではない。

このまま受入を満たすには、新しいWorker側開始処理とUI操作を追加する必要があり、
単純な分離・移管として計画したslice内で未採用機能のscope判断が発生する。
automatic
compaction、checkpointの読取・再開適用が存在することは、手動開始経路の存在を意味しない。

**採用する修正案:**
既存checkpoint読取・再開適用の維持と、未実装の手動compactionを区別する。
手動開始のroute・operation・overlay・受入は利用者の採用判断へ戻す。
S22で追加採用する場合は、Worker側開始経路を含む新機能として範囲を明示する。
今回のreviewだけで追加採用や廃止を決めない。

## 批判的レビュー: P2 — 清算済みfollow-up本文のreadback元がない

対象は詳細設計489〜493行。
親executionがcancel／interrupted／max_steps等で終了した場合、pending
laneを清算し、 入力と停止理由を「execution
evidence・既存再送用の観測」から読めると記述している。

現行の予約本文は[PendingInputCore.queueFollowUp](../../v0/tui/pending_input.ts#L98)と
[ControllerのfollowUpText](../../v0/tui/controller.ts#L1662)に保持される。
入力履歴への記録は、親が成功し、follow-upを[自動submitする時点](../../v0/tui/controller.ts#L1236)である。
[履歴event契約](../../v0/agent/history/history_store_contract.ts#L51)にもfollow-up受付記録はない。
親の失敗時は[clearFollowUp](../../v0/tui/controller.ts#L1203)で予約本文を消す。

UI終了後に親が失敗し、提案どおりlaneを清算すると、再接続先から予約本文を読む正本が残らない。
未実行のfollow-up本文は親executionのtask本文でもないため、既存のexecution
evidenceで代用できない。
これはcore再起動後の永続化要求ではなく、設計自身が約束する同一core
lifetime内のreadbackの問題である。

**採用する修正案:** 清算済みqueue結果の`queueId`・本文・停止理由を、 同一core
lifetimeのquery／read modelに保持すると明記する。
実行待ちlaneからは外し、自動再送は行わず、人間が内容と結果を確認できるようにする。
durable command log、新しい保存schema、UI入力履歴の複製は必要ない。 Slice
4のcore移管とsnapshot／queryの対象に含める。

## その他の確認結果

受付と完了を分ける方針は現行経路と整合している。
[coordinator.submit](../../v0/agent/worker/worker_host_coordinator.ts#L1391)のdurable
admissionは Worker
dispatchの前にあり、`turn_end`後もfinallyで子実行・process清算を待つ。
清算後に次task／follow-upを始める設計には、抽出対象となる実在の境界がある。

共有contractを状態ownerにせず、コア正本、API read model、client
reducer、UI-local stateを分ける依存方向、 active／view Sessionの分離、none
Sessionのruntime identity、CLI設定のscope、 runのone-shot
headless経路、historyのlocal／remote read、stream出力とSSE購読の区別、
第三者HTTP利用、8sliceの順序に、上記以外の採用基準を満たすfindingは確認していない。
未実装であることや局所的実装詳細の留保だけをfindingにはしなかった。

## 確認範囲・限界

通常レビューは凍結2文書全体、shared contractの依存、Session／none identity、
履歴occurrence・本文state、受付／commit／清算、pending、navigation、CLI設定、run／history、sliceを確認した。
批判的レビューは起動・discovery、独立lifetime、複数UI、admission・pending、
snapshot／SSE／identity、第三者APIとCLIの関係を重点確認した。
親は2件のfindingについて、文書記述と該当するproduction sourceを再確認した。

HTTP実装、再接続表示、tmux操作、provider動作、source／compiled
binaryのprocess寿命は未検証。 これらは各sliceの実経路確認として残る。
reviewerによるfile変更、test、gate、provider call、外部書込みはない。
対象文書のhashはreview完了後も一致している。
対象を修正していないため、re-reviewは実施していない。

[以前のreview記録](s22-design-review-results.md)は、詳細設計前の検討文書への結果として維持する。
本記録によって旧reviewの確認範囲を遡って広げない。

## 指摘への設計対応（2026-09-27）

利用者の「対応後、gpt-6-astraで10分上限・Blocking／P1限定の批判的review」という指示を受け、
上の2件を[詳細設計](../plans/s22-detailed-design-and-slices.md)へ反映した。
初回reviewの文書hashと判定は当時の記録として維持する。

- 手動compaction: 旧AgentSessionのAPIと現production Worker経路を区別した。
  手動preview／開始／cancel route、専用operation query、confirm overlay、Slice
  5の手動操作受入を取り除き、 未実装の手動開始は別採用と明記した。 既存automatic
  compaction、checkpointの読取・再開適用は維持し、context.read／snapshotで観測値を共有する。
- follow-up:
  清算前に、service所有の予約recordを本文・停止理由付きの結果へ遷移させる。
  discarded／started／startRejectedを現在の実行待ちlaneと分けて保持し、 Session
  snapshot・SSEとfollowUp.readから同じ状態を読めると定めた。 同一core
  lifetime中はidleのslot置換後も元Session／queue IDで参照できる。
  自動再送、予約の永続化、保存schema変更は加えていない。 Slice
  4の作業と受入にも再接続・清算結果の読取を反映した。

2件とも設計上の対応を完了した。runtime実装・実動作の確認は行っていない。
CLIのgrammar・run／history／streamの契約、8sliceの構成は変更していない。
構想・architecture・roadmapの正本は変更していない。

修正版のSHA-256は次のとおり。

- 詳細設計: `d195630fb31ce18ad24fc834894c1bdbf84e1527dc70df5aeb55f4e38af23ed4`。
- CLI設計:
  `adeb7763db6f6c14e725786c7795521a9e3c0604a7a8e1a9de360fb776cfd453`（変更なし）。

## 修正版の追加批判的レビュー: gpt-6-astra

利用者指定のgpt-6-astraが、上記修正版の詳細設計・CLI設計を独立にread-onlyで確認した。
**結論: Blocking／P1なし。** coordinating ownerもこの判定を採用する。

上限は10分、延長不可。2026-09-27 11:28〜11:33 UTC内に完了した。
Blocking／P1のみを評価対象とし、P2以下は検討・報告・改善提案の対象外とした。
会話履歴や旧review判定は入力に含めず、親が作成したcontext
packet、修正版の凍結文書、必要なsourceを渡した。
review後も両対象のSHA-256は上記修正版hashと一致している。

確認範囲は、schema／core／UIの依存、active／view Session、複数UIの受付、
独立processの起動・終了責任、admission／完了／commit／清算、follow-upの開始と取消し、
結果recordの本文・理由・相関ID、snapshot／SSEの初期化・順序、tool／request
identity、 history、none
Session、設定scope、credential境界、第三者HTTP利用、run出力、8sliceの依存関係。

受付と清算の分離には現行coordinatorの再利用可能な境界がある。
follow-up結果の同一core lifetimeでの保持、slot置換後の読取と、
手動compactionを別採用へ戻し既存automatic
compaction・checkpointを維持する修正に、 重大な矛盾は確認されなかった。

未実装HTTP経路の実動、source／compiled binaryのprocess寿命、tmux操作、
実providerでの再接続・follow-upは未確認。
これは設計の静的reviewであり、production受入を示す判定ではない。
reviewerによる変更、test、gate、provider call、外部書込みはない。

## 実装指示後の文書更新

追加review後、利用者が8sliceの段階実装・各sliceのコードとtestの第三者review、
以降の実provider確認を指示したため、設計2文書のステータスと確認承認方針を更新した。
上記hashはその更新前の凍結review対象を識別する。API・状態所有・slice構成は変更していない。
現在の実装・検証記録は[Increment 139](../increments/increment-139.md)と後続incrementを参照する。
