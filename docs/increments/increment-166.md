# Increment 166 — system通知を対象executionの表示位置へ置く

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-10-01

ステータス: **完了（2026-10-01、利用者がIncrement 168まで完了と明示）。**

## 要件と実行証拠

利用者の「ではそれも修正して 他のsystem>は大丈夫か？」により、キャンセル通知の表示順を修正し、
他のsystem通知への同じ原因の影響も確認する。thinkingの有無に依存せず、終了通知を対象executionの
最後の表示行の後へ置く。実行中に受け取った通知は、その時点の表示位置を保持する。

対象Session `fb5a6bb1-8199-4d53-b06c-969d3ae70046`のturn 7には32件のtool callがある。
Coreのsnapshotでtoolはstep順だが、productionのprojectorとnotice mergeを通すと、
`user> → system> CANCELLED → tool 32件`となる。確認用summaryをstep間へ挿入してもcancel位置は変わらない。

## 現行経路と変更範囲

CoreのSession snapshotをremote TUIが受信し、`SnapshotConversationProjector`が表示行を生成する。
`RemoteSystemNotices`はexecution IDが一致する最後の表示行を通知の挿入基準にする。
projectorがuser以外の行へexecution IDを引き継いでいないため、user行が基準になっていた。

- thinking行はrequest key、assistant本文とnoteはmessage、tool行はtool occurrenceからexecution IDを引き継ぐ。
- noticeの保持・更新・挿入処理、semantic履歴、API、provider送信、通知文言・配色は変更しない。
- 同じ経路を使う終了失敗、予約状態、steering受領、executionに紐づくcommand拒否・未確認通知も修正対象。
- execution IDを渡さない接続断、Session操作、recall等の通知は、その時点の表示全体の末尾を基準とし、
  この欠落の影響は受けない。

構想・architecture・roadmap、常用配置、commit/push、公開は本変更の対象外。

## 検証計画

1. 既存projection testで全種類の行がexecution IDを保持し、resyncで表示identityを維持することを確認する。
2. production projectorとnotice mergeを結合して、thinkingなし／ありのcancel位置、assistant本文・
   末尾thinkingの後のfailure位置を確認する。別executionの次入力より前に終了通知を置く。
3. command、queue、steering通知をtoolの後へ置き、状態更新と後続作業で元の位置を保持することを確認する。
   executionに紐づかない接続断通知も同時に確認する。
4. focused test、type check、format、lint、git diff --checkを行う。full gateは実行しない。
5. 隔離XDGのtmuxからcandidate production TUIで既存Coreの対象Sessionへ読み取り接続し、
   最後のtool行の後にCANCELLEDがあること、履歴移動・再接続でも順序が維持されることを確認する。
   model requestや実config変更は行わない。

## 結果

表示行の生成にexecution IDを引き継ぐ5行を追加した。tool結果でcall行を更新するときもIDを維持する。
通知側の挿入・保持処理は変更していない。

### Focused確認

- `increment_154_projection_test.ts`と`increment_159_system_notices_test.ts`: 11 passed、0 failed。
  thinkingなし／ありのcancel、assistant・末尾thinkingの後のfailure、次executionとの境界、
  noteを含むtool後のcommand・queue・steering、接続断、更新時の位置保持、resync、配色を確認した。
- 変更したsourceとtestのtype check、format、lint、git diff --checkはpass。
- 既存Sessionのsnapshotを修正後のproduction projectorとnotice mergeへ渡し、tool occurrence 32件の
  順序がCoreと一致し、全行がexecution IDを保持し、CANCELLEDがturn内の最後（index 33）にあることを確認した。
  `.tools/system-notice-fix/session-check.json`にcredentialを含まないfactを保存した。

追加で既存の`increment_141_remote_tui_test.ts`を実行したところ、2 passed、5 failedだった。
現在のsourceを隔離copyし、projectorだけを本修正前の内容へ戻して比較した結果も、同じ2 passed／5 failed、
同じassertion位置だった。主な失敗は旧フッター文言（例: `[ready`）と操作待ちの条件にあり、
本変更によるregressionではない。該当testは本変更で修正していない。
比較ログは`.tools/system-notice-fix/remote-baseline.log`。full gateは実行していない。

### Compiled production TUI確認

公式`henji:compile --output .tools/system-notice-fix/henji`でcandidateを生成し、隔離HOME／XDGの
160×70 tmuxから既存Core `http://127.0.0.1:43693`のactive Sessionへ読み取り接続した。
task投入、Session open/change、provider request、実config変更は行っていない。

- 実Sessionのuser入力後に32件のtool行がstep順で並び、最後の`collect_subagent`の後へCANCELLEDが表示された。
- PageUp／PageDownで履歴を移動しても、最後のtool行とcancel位置が維持された。
- Ctrl-Dでdetachし、同じSessionへ再接続しても最後のtool行の後へCANCELLEDが一度だけ表示された。
- ANSI captureとfocused testで既存のsystem failure配色を維持した。

証拠は`.tools/system-notice-fix/`の`actual-session.txt`、`actual-session-ansi.txt`、
`page-up.txt`、`page-down.txt`、`reconnected.txt`へ保存した。
candidate build IDは`05b45f04569bb2c024152379209d17ae58ce1d0662af907d9527cbcdd8564c0e`。
確認用TUIはdetach済み。既存Coreと実Sessionは保持した。常用配置、commit/push、公開は行っていない。

後続のcommit/build指示により、本修正を含むsource commitとbinary作成を完了した。
成果物と確認結果は[local build記録](../operations/local-build-2026-10-01.md)。常用配置、push、公開は行っていない。

さらに「了解配置して」により常用配置と配置先の起動確認を完了した。詳細は上記記録を参照する。
push、公開は行っていない。

## 完了承認（2026-10-01）

利用者の「同期して168まで完了してるし」により、Increment 168までの完了承認を記録した。
構想・architecture・roadmapの現行説明への同期も指示され、正本へ反映した。既存の検証・配置結果は上記を正本とし、
今回追加の実provider確認や公開は行わない。
