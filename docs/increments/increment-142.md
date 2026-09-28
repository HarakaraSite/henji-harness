# Increment 142 — S22 Slice 4: steering・follow-upのコア所有

更新日: 2026-09-28

ステータス: local実装・検証・独立review完了。
利用者の追加指示によりcommit・push・常用配置を実施中。結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用動作と根拠

busy中にsteering一回とfollow-up一枠を受付し、UIを閉じても親の成功後にfollow-upを一回自動実行する。
再接続で予約本文、queue ID、開始したexecution、清算済み結果を読む。
cancel／失敗では自動実行せず、follow-up本文と親の停止理由を同一core
lifetimeの結果recordとして保持する。

根拠は利用者のS22全8slice実装・各slice第三者reviewへの承認と、就寝前の「スライスを進められるだけ進めてください」。
[詳細設計のSlice 4](../plans/s22-detailed-design-and-slices.md#slice-4--steeringfollow-upのコア所有)、同文書の受付・pending
lifecycleと公開APIを採用する。 前提のsourceと完了記録は[Increment 141](increment-141.md)を参照する。
複数steering・任意長queue、永続予約・restart replay、新schema、一般hardeningは追加しない。
構想・architecture・roadmap変更、commit／push／常用配置・公開はこの作業に含めない。

## 現行経路と責務の切替

接続TUIはHTTPからCoreService、ApplicationService、lazy Host、coordinator.admitへ進む。
現行通常TUIは同じApplicationServiceのHostをpresentation
adapterで呼び、ControllerとPendingInputCoreがaccepted laneを所有している。 follow_up_queue
intentは予約を作らずacceptedを返し、Controllerが親completion後に自動submitする。
steeringのPromiseは実際の結果を待たずacceptedと扱われる。

ApplicationService内に既存Hostのadmission／completionを使うtask
ownerを置き、固定laneと自動開始を一つにする。 親completionはHost-owned
process清算まで待ち、queue取得と次taskのpreparing予約をawait前に確定する。
CoreServiceのcommand照合とHTTPはこのownerへ操作を配送し、snapshot／SSE／followUp.readも同じrecordを参照する。
旧通常TUIも同じownerを使う。Controllerのaccepted lane所有と自動送信、予約しないadapter
stubを同時に除去する。 editor、draft、入力履歴、表示先はUIが所有する。headless runの一task
completion契約は維持する。 slot置換後の旧Sessionの結果読取では、旧Hostをactivateしない。

## 実装・検証

Rootはtask owner、ApplicationService、Host getter、HTTP、旧CLI compositionと統合を担当する。
backend担当は共有DTO／client／codec／projectionとCoreServiceへの接続、TUI担当はremote入力とController／adapterの切替を担当する。
分担は独立した所有箇所を並行実装できるため。共有contractを先に揃え、他担当の変更を戻さない。

focused確認は実Worker／有効localhost provider経路で、親清算後の単一child開始、steering受付・消費、
UI detachとqueueの独立、cancel時の本文・理由保持、slot置換後の同record読取へ対応させる。
TUIの版付きdraft処理はsteering／queueの非同期受付にも使い、未確定なら元commandを照合する。
変更箇所のtype check／fmt／lint／diff checkを行う。full gateは要求しない。

隔離XDGのtmux production sourceで、親＋follow-up二executionをdetachを挟んで一回ずつ実行する。
別親は予約後detachし、第三者HTTPからcancel、再接続とslot置換後の結果を確認する。 OpenRouter
Responses xiaomi/mimo-v2.6-flash
autoで接続TUIは三task・四request前後、旧通常TUIも二task・三request前後を確認する。
保存先は/tmp/henji-s22-slice4-probe/evidence。credential／Authorizationは記録しない。
安定候補はコード・test差分とhashを固定し独立read-only reviewへ渡す。
通常review30分、10分新証拠なしで停止、限定re-review一回15分。Rootがfinding採否と最終確認を担当する。

## 結果

AppTaskServiceが固定lane、親のprocess清算を含むcompletion、一回だけのchild開始、cancel時の破棄と結果recordを所有する。
HTTPと旧通常TUIは同じownerへsubmit／steer／queue／cancelを配送する。Controllerのaccepted
lane所有とlocal自動開始を除いた。 保存SessionのreadもCore lifetime内のstarted／discarded
recordを読み、旧Hostを再起動しない。

隔離XDG・80×24 tmuxのproduction sourceで以下を確認した。保存先は
`/tmp/henji-s22-slice4-probe/evidence`。外部providerはOpenRouter Responses MiMo flash
auto、合計5task・7物理request。

- 接続TUI:
  親bash実行中にsteeringとfollow-upを受付しCtrl-Dでdetach。親の清算後にchildが一回開始し、同epochへ戻ると本文・queue
  ID・開始execution・完了結果が表示された（3request）。
- 別親の予約後にdetachし第三者HTTPからcancel。親はcancelled／non_canonical／清算complete、childは未開始。
  再接続は予約本文・ID・cancelled理由を保持した（1request）。
- 旧通常TUIも親・steering・follow-upの二executionを一回ずつ実行し、canonical
  historyとreadyへの復帰を確認した（3request）。
- idle slot置換後の旧Session表示で結果recordが欠ける問題を実観測で修正。 production
  CLI／実Worker／localhost
  Responsesでstarted・discarded本文と理由を読み戻し、旧Host非activateを確認（外部0、localhost3request）。

独立reviewは固定24filesのhashを照合し、P2を一件採用した。旧TUIが同期受付をmicrotaskへ遅延し、
同入力chunkの「送信＋次draft」で本文を混入・消去する問題である。
同期receiptを同stackで処理するよう修正し、同chunkのEnter／AltEnter後の新draftとownerの受付本文を確認した。
修正後のproduction旧TUIもlocalhost providerで実操作を確認し、受付済み本文が次taskへ混入せず、
新しいdraftが残った（外部0、localhost2request）。限定re-reviewでP2解消、追加findingなし。

focused確認は新HTTP1、remote新旧11、旧HTTP regression1、read4、CLI1、retained UI＋binding55がpass。
担当・統合箇所のtype／fmt／lint／diff確認がpass。full gateは実施していない。
最終固定source／testは`/tmp/codex-agent-context/s22-slice4/review/final2`とmanifest／patchに保持した。

local実装・検証・第三者reviewは完了。利用者の朝確認、commit／push／配置は未実施。
構想・architecture・roadmapは変更していない。旧CLI全体のHTTP経由への切替はSlice
8、B6は未採用のまま。
