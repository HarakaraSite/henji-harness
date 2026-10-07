# Increment 140 — S22 Slice 2: 独立serveと読み取り接続TUI

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-09-28

ステータス: 実装・検証・独立review・commit・push・常用配置完了。
利用者の追加指示による配置結果は[合同配置記録](s22-deployment-2026-09-28.md)を参照する。

## 採用範囲と利用動作

人間は別terminalで`henji serve`を起動し、`henji tui --connect URL`からSession状態と保存履歴を読む。
TUIを閉じてもserveは待機し、同じepochへ再接続できる。第三者HTTP clientと
`henji history --connect URL`も、TUIなしで同じworkspaceの履歴を読む。

根拠はS22全8sliceの段階実装・各sliceのコード／test第三者reviewへの既存承認と、
2026-09-27の利用者の再開指示「インクリメントを進めてください」。
[詳細設計のSlice 2](../plans/s22-detailed-design-and-slices.md#slice-2--独立serveと読み取り接続tui)、
[CLI・外部API利用設計](../plans/s22-cli-and-external-api.md)、
[設計review結果](../research/s22-detailed-design-review-results.md)を採用する。
前提は[Increment 139](increment-139.md)の未commit実装であり、これを保持する。

## 現行product経路と変更点

現行henjiはtui_cliがapplication service・Worker
Session・表示binding・Controllerを同一processへ合成する。 Session/historyは既存SQLite
storeが所有し、共通queryからcore projectionがsnapshotを生成する。 Session
navigationの保存Session再開には既存lazy Worker経路があるが、初回factoryはWorkerを起動する。

serveはHTTP adapterとapplication serviceを独立processの入口へ合成する。
初期slotなしで待機でき、明示Session open／初期Session指定はtaskまでlazyに準備する。
保存Session閲覧はslotを置換せず、Worker／provider requestを開始しない。 共有HTTP
client、core/session/history query、SSE先頭snapshotと接続TUIを追加する。
履歴表示は既存session/canonical/detail rendererを再利用する。

接続TUIはこのsliceでは閲覧用と明示し、未対応task／commandを操作案内へ載せない。
通常henjiの入口切替・自動起動はSlice 7／8、task受付・cancel・途中実行の再接続はSlice 3、
follow-upはSlice 4の範囲である。 新しい保存schema、agent
loop、WebUI、構想／architecture／roadmapの意味変更を追加しない。
commit／push／常用配置・公開は未承認。

## 実装と確認方針

HTTP側とCLI／TUI側を境界で分担し、統合・最終検証・finding採否はcoordinating ownerが担当する。
実装後、実Worker／既存SQLiteを使う必要最小限のfocused確認、type check、format、lint、diff
checkを行う。 full gateは要求しない。

隔離XDGのtmuxでsourceと候補compiled binaryを別paneから起動し、同じ保存履歴、workspace、selection、
再接続とTUI終了後のserve生存を確認する。第三者HTTPとhistory CLIのtarget/viewを照合し、
閲覧によるWorker／provider request開始がないことを確認する。 保存履歴はSlice
1の隔離production確認で生成したデータを利用し、追加provider callは必要性が生じた場合に具体化する。
確認先は`/tmp/henji-s22-slice2-probe`、結果は本incrementへ記録する。

独立したread-only reviewerがSlice 2のコードとtestを確認する。
評価対象は承認動作、実経路のcorrectness、shared contract/core/UI整合、変更による具体的regression。
初回上限30分、10分間新しい根拠・tool結果・中間結論がなければ中断する。
re-reviewは一回、変更箇所と既存findingの解消のみ15分以内。
一般的hardening、未観測variantのmatrix、test件数は評価しない。

## 実装・確認結果

### 実装

- `henji serve`をforegroundの独立core入口として追加した。既定はlocalhost・port 0・初期slotなし。
  ready JSONはAPI version、epoch、buildを参照できるURL、canonical workspace、PIDを返す。
  明示初期Sessionと`session.open`は既存lazy Host経路を使い、task前にWorkerを開始しない。
- `/api/v1`にcore、Session一覧／open／snapshot／SSE、history読取を追加した。
  保存Sessionの閲覧と稼働slotを分け、既存SQLite queryとhistory rendererを再利用する。
  共有clientは標準Web APIで動作し、Deno runtime依存なしでimportできる。
- `henji tui --connect URL [--session ID]`はSSE先頭snapshotから同じ表示bindingを使う。
  閲覧用表示、scroll、help、detachを提供し、Worker未評価をhelpへ表示する。
  `henji history --connect URL`のID／prefix／latestと三つのviewは接続先coreで解決する。
  利用方法は[HTTP API運用文書](../operations/http-api.md)に記録した。
- 統合時に既存Session title更新経路、model選択・context付きsubmitの公開型を保持した。 HTTP
  server終了ではSSEを先に閉じる。80列でdetach／help案内が消える実観測を修正した。

### focused確認

CLI remote履歴testとIncrement 139の実Worker・共通read model testは計4件成功。 接続TUIのfocused
testは2件成功し、既存Session titleの回帰testも成功した。 HTTP側のfocused
test結果と独立review結果は後述の確定欄へ追記する。
全`v0:check`は成功した。変更範囲のformat／lintと`git diff --check`を実施する。 full
gateは今回の計画で要求しておらず実行していない。

### production経路

隔離XDGの`/tmp/henji-s22-slice2-probe`でtmux上のsourceとcompiled binaryを別processとして確認した。
保存履歴はSlice 1のproduction probeからコピーし、元config／DBは変更していない。 実provider
callは追加していない。

- source serveの明示Sessionと、compiled
  serveの初期slotなしの両方から、同じ保存Sessionを接続TUIで表示した。 Session
  `a3e8ba12-d283-48a5-9aad-0872daf7dcb4`の8message、2read tool、thinking、本文を確認した。 core
  workspaceは`/tmp/henji-s22-slice1-probe/workspace`、selectionは
  `openrouter-responses / xiaomi/mimo-v2.6-flash / auto`だった。
  接続clientのcwdを`/tmp`に変えても接続先のworkspaceと履歴を取得した。
- PageUp／PageDown／Esc、F1 help、`/exit`、Ctrl-Dを操作した。
  sourceとcompiledのdetach後もcoreは生存し、再接続は同じepochと履歴を復元した。
  最終compiled候補は80×24で`/exit`とF1の案内が残り、helpから操作とWorker未評価を確認できた。
- 第三者HTTPでcore／一覧／snapshotを取得し、historyのID prefixとlatestを三つのviewで照合した。
  source／compiledのhistory CLI出力も同じviewで一致した。保存閲覧後のactiveSessionIdは
  初期slotなしcoreではnullのままで、元保存DBの16tableの行数はすべて不変だった。
- 空workspaceでは初期slotなし、Session一覧空、latest履歴なしを確認した。
  HTTPから`generic`／`none`を明示openすると未評価のSessionが準備され、execution／messageは0件だった。
- coreへSIGTERMを送り、SSE接続中でも終了できることを確認した。
  終了時のTUIは最後の履歴と切断表示を保持し、Ctrl-Dでdetachできた。確認processと専用tmuxは終了済み。

最終候補binaryは`/tmp/henji-s22-slice2-probe/henji-candidate`、buildは
`59ed0e67f023d348b195711c7074a17037db41ad155b0215d37022b25da6012f`。 ready／HTTP結果／history
text／tmux画面／DB件数／type check／compile logは
同directoryの`evidence/`に保存した。候補は常用配置していない。

### 独立review

Slice 1完了時baselineとの差分18source／testを固定し、独立read-only reviewerへ依頼した。
固定manifest、差分、contextは`/tmp/codex-agent-context/s22-slice2-review/`にある。
初回reviewの3件を採用した。

1. P2: 公開Agent `generic`の新規保存Sessionがstoreの古いAgent判定に拒否される。
   割当と通常／初回空record codecを既存contractのgenericへ合わせた。 実Workerの保存・HTTP
   readbackとlazy generic new openをfocused確認した。
2. P2: 同じcommandIdの並行openが別Sessionを返す。
   await前に一つの結果Promiseを登録し、並行配送も同じ結果を待つ形へ変更した。 HTTP
   clientの並行POSTで同一Session IDとslot一致を確認した。
3. P3: 切断後の任意入力EnterでDISCONNECTEDが消える。 connection
   stateをUI-localで保持し、入力案内に反映した。 有限SSEを受けたTUIの切断後入力をfocused確認した。

一回のread-only re-reviewは、最終20source／testのhash・変更差分・対応testを確認し、
3findingすべての解消と変更範囲に新しいfindingがないことを報告した。
reviewerはtest／gate／providerを実行せず、実操作と最終検証はcoordinating ownerが担当した。

最終候補でsource／compiledの80×24表示を再確認した。 compiled HTTPの同commandId並行generic new
openは一つの未評価Sessionを返し、 保存Session閲覧はその稼働slotを置換しなかった。
source／compiledともcore終了後に任意入力Enterを行ってもDISCONNECTED表示を維持した。 Slice
2の受入を満たし、次はSlice 3のtask受付・cancel・実行中再接続へ進む。
commit／push／常用配置・公開は行っていない。
