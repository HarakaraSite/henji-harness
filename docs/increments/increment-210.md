# Increment 210 — Coreの重複照会・再投影を整理する

状態: local調査・改善・検証とP2対応・source commit完了（2026-10-07）。常用binaryには212のbuild・配置で反映済み。
sourceは`568ed489`。配置結果は[Increment 212](increment-212.md)を参照する。

## 目的・承認範囲・維持する動作

利用者の「次にコアの無駄な処理も見直してほしい」を、直前のHTTP API改善に続くCoreのlocal調査・改善・
非破壊的検証の指示として扱う。操作の受付結果、公開revision、実行と清算の区別、steering・follow-up、
Session切替後の参照と保存履歴を維持し、結果に不要な再計算を除く。
構想・architecture・roadmap、Data/Agentの保存契約、provider adapter、TUI Surface、実data操作は対象外。
新しい実provider call、build・配置、push、公開/releaseは行わない。
commitは改善とP2対応の完了後、2026-10-07の利用者の「コミットして」により追加承認された。

## 現行の経路・状態所有・確認した無駄

HTTP API → Core operation → ApplicationTaskServiceの予約・制御 → Worker Host/Agent/Data →
Task/runtime通知・Data descriptor → Coreのcontrol合成・公開revision → API snapshot/update。
会話・semantic履歴はData、実行とprocessの制御はHost、pending laneはTaskServiceが所有する。
Coreはcommand照合とexecution追跡、稼働slot、公開controlを所有する。

| 現行処理 | 不要と判断する根拠 | 改善 |
| --- | --- | --- |
| busy判定で`query.currentSession()`を呼ぶ | 必要なのはTaskServiceのbusyとHostのruntime.activeだけ。queryはpending履歴等も生成する | 同じownerの小さいruntime snapshotを直接参照する |
| 一refresh内で稼働pendingをprojection、pending合成、owner全件走査から繰り返し生成 | 同期処理内の同一pendingを再利用できる | projectionのpendingを合成にも使い、active ownerの二度目の照会を除く |
| pendingとfollow-up照会で全Sessionの過去ApplicationServiceを走査 | recordはownerのSessionに属する。別Sessionのownerは結果を返さない | Session別にownerを保持し、既存のlatest owner索引と全owner集合を統合する |
| 稼働状態通知ごとに閲覧済みSession全件へread-only runtimeを再投影 | 別Sessionへ伝える変更はactiveSessionIdと共通operation availabilityだけ | この共通controlが変わったときだけ他Sessionを更新する |
| 同一object参照のsnapshot項目もJSON文字列を二つ生成して比較 | 同じ参照なら両者は同じ値 | 参照が同じ場合は文字列化を省略する |
| Session open・rename・selection・recall成功時に更新し、直後のfinallyでも同じ更新をする | successのcursor取得前に更新済みで、finallyまでawaitも状態変更もない | finallyでは未解放のopening状態だけを解放・更新する |

Session別owner索引は閉じたownerのfollow-up recordも保持する。recordの削除、履歴移行、追加の永続保存先を
作らない。read-only runtimeの前回値は再計算判断用の派生controlで、公開Session stateの別正本にはしない。
runtime通知そのものを間引かず、Data descriptorと会話cutの同期も維持する。

## 現行sourceの測定

12個のpersistent Sessionを順次作成後、最後のSessionをCoreのbyte sinkで購読し、provider-freeの既存
Worker経路で10 turnを実行した。実Core/Data/Agentを使い、HTTP/TUI・実providerは使わない。
counterのみを加えたCoreの一時複製から、既存production moduleを参照した。
10 turnの保存、idle、購読とreadbackの同一cut、最後の入力本文を確認した。

- refresh: 201回、full Session query: 461回、pendingView: 3,074回。
- snapshot項目比較: 12,460回、比較のJSON文字列: 8,826,033 code unit。
- read-only再投影loopのSession訪問: 2,412件（稼働Sessionのskipを含む）。
- この測定にはfollow-up recordがなく、record本文のclone量は測っていない。
- scriptとbaselineは`.tools/increment-210/`（git管理外）。過去180の測定を今回のbaselineにしない。

## 検証計画

- 同条件でquery・pending・比較・他Session訪問の件数と保存結果を比較する。
  CPU時間や入力遅延の改善率は保証しない。
- focused実経路でtask受付cursor、終了と清算、steering、follow-up開始・取消・切替後の照会、
  Session metadataとactivation、複数購読・再接続、Core停止を確認する。
- 新規testは、別Sessionの操作可能状態がbusy/idle・切替・metadata処理に応じて更新されることと、
  同じSessionを開き直しても旧ownerのfollow-upを参照できることを対象にする。
  既存testで成立済みの動作を重複testの目標にしない。
- 変更sourceのtype check・format・lint・`git diff --check`を行い、full gateは要求しない。
- 別Session更新とowner履歴は複数lifetimeに関わるため、実装後に限定した独立reviewを行う。
  reviewは最大30分、進展が10分なければ中断し、一般的なhardeningは対象外。

未確認: 通常の実provider・TUI利用での体感速度、常用binaryへの配置後の人間の確認。

## 実装結果

変更sourceは`v0/agent/host/core_service.ts`だけである。

- busy判定はTaskServiceとHostのruntimeを直接参照し、operation一覧を生成する際もbusyを一度だけ評価する。
- pending合成にはprojectionで取得したactive pendingを再利用する。
- `knownServices`と`allServices`を`servicesBySession`へ統合した。Session内の最後のownerが制御受付を担当し、
  過去ownerもそのSessionのpending/follow-up参照のために保持する。
- 別Sessionのruntimeに伝えるactiveSessionId・共通operationsが同じなら、全Sessionの再投影を省略する。
  共通controlが変われば従来と同じruntimeを公開する。saved read/watchの初期状態はその時点のcontrolから生成する。
- snapshot項目が同じ参照ならJSON比較を省略する。別の参照は従来のJSON比較を使う。
- open・rename・selection・recallの成功cursor取得前の更新は残し、直後のfinallyの重複更新を省略する。
  未解放のopening状態については、拒否・例外を含め従来どおりfinallyで解放・更新する。

## 同条件の比較結果

baselineはsource commit `24e9e357`。12 Session作成後の同じ10 turnを変更後でも実行した。
一時複製のcounterは呼出し・比較文字列の長さ・loop訪問数だけを数え、実行分岐を変更していない。
最終`committedTurn=10`、idle、最後の入力本文、購読とreadbackの同一cutを両方で確認した。

| 指標 | 変更前 | 変更後 |
| --- | ---: | ---: |
| refresh | 201 | 201 |
| full Session query | 461 | 201 |
| pendingView生成 | 3,074 | 201 |
| snapshot項目比較 | 12,460 | 2,505 |
| 比較のJSON文字列量（code unit） | 8,826,033 | 2,045,527 |
| read-only loopのSession訪問（稼働slotのskip含む） | 2,412 | 240 |

runtime/Task通知と稼働slotのrefreshは削っていない。pending生成は約93.5%、別Session更新loopの訪問は
約90.0%、比較JSON量は約76.8%減った。これは上記条件での処理件数・生成量であり、Core全体の速度改善率ではない。
follow-up本文のclone量や、実provider利用時の待ち時間はこの比較には含めない。

## 検証・review結果

- focusedの確認は新規210の1件と既存14件、計15件で成立した。
  既存180 tracking/receipt・142 HTTP pending・143 HTTP Session・144 HTTP catalog・199 Core subscription・
  189 checkpoint API・145 HTTP shutdown・170 S3 HTTP streamを使用した。
- 実Core/Data/Agentと正式API Workerのlocalhost HTTP/SSEから、受付cursor、親終了とfollow-up清算、
  steering、取消、Session activation・metadata・recall、checkpoint、複数購読・再接続、Core停止を確認した。
  実provider callは0回。TUI Surfaceは変更していない。
- 新規210は、保存Session Aを購読したままSession Bで親とfollow-upを二回実行し、busy/idleの
  operation availability、B→A→B切替時のactiveSessionId、再開前の旧follow-up参照と最新ownerへの受付を
  確認した。rename後の公開title・receipt cursor・操作可能状態、会話のreadback一致も確認した。
- 初版の追加testは未実行のSession Aを「保存済み」として開き直そうとして失敗した。
  変更前sourceでも同じ失敗を再現したため、対象の保存済みSessionを一turnで準備してから確認するsetupへ修正した。
  production codeの変更や拒否条件の追加はしていない。保存済みSessionの変更経路は修正後にpassした。
- `core_service.ts`と新規testのtype check、format、lint、repository全体の`git diff --check`はpass。
  full gateは実行していない。
- 独立reviewはCore差分と必要な依存sourceに限定し、別Session更新の省略、owner索引、busy/pending再利用、
  finallyとcursor公開を確認した。対応が必要なfindingはなかった。reviewerはsource確認のみを行い、
  実行結果と新規testの最終確認はdefaultが担当した。

## 通常・批判的レビューとP2対応（2026-10-07）

利用者の指示により、コードとtestの通常reviewと、見落としを確認する批判的reviewを独立して行った。
通常reviewではfindingなし。批判的reviewでは、renameの受付cursorに対するtest不足をP2として採用した。
production codeの不具合は確認されていない。

従来のtestは受付revision以上になるまで待ち、最新snapshotのtitleと操作可能状態を確認していたため、
受付cursorが古くても後続の正しい更新でpassし得た。P2対応では、購読snapshotをrevision別に保持し、
renameの受付cursorと同じrevisionのsnapshotについてcursor全体の一致、変更後title、`task.submit`の
利用可能状態を確認するよう修正した。production sourceはこの対応で変更していない。

修正した210のfocused testはtype checkを含めpass。testのformat・lintと`git diff --check`もpassした。
実provider callとfull gateは実行していない。
同じ批判的reviewerによる変更箇所と元findingに限定した再reviewでも、P2解消と新規findingなしを確認した。
reviewerは静的確認を担当し、testの実行結果はdefaultが確認した。

local改善としての残作業はない。sourceは今回のcommitへ保存し、push・常用build・配置は利用者の指示を待つ。
通常利用での体感速度は未確認であり、処理件数の削減をその代替にしない。
