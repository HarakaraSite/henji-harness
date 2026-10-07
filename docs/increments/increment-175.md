# Increment 175 — 最終回答時にも受け付けた追加指示を取り込む

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-10-03

ステータス:
**完了（2026-10-03、利用者承認）。local実装・focused確認・隔離production
TUI確認・通常review・常用配置済み。commit/push済み。**

利用者の「b6の次に対応する記録して」と、174完了時の「次のb7に進む」によりB7を採用した。

## 採用要件と原観測

- 実行中に受け付けた追加指示は、modelがfinalを返したときにも同じexecutionの次のmodel
  requestへ 取り込む。追加指示を残したまま元のfinalで正常終了しない。
- 元のassistant応答とprovider replay stateを保持し、その後に追加指示をuser
  messageとして一度だけ
  追加する。実適用は既存のsemantic履歴／steering_messageとrequest
  attributionへ保存する。
- TUIの受付済み表示はWorkerが実際に指示を受け付けた場合だけ出す。終了して受付できない場合は
  既存の拒否経路で結果を返し、追加指示を適用したように表示しない。
- 既存のtool後の取込み、cancel、follow-up、1
  executionに追加指示1回という受付数は保持する。
  step／request制限は変更せず、制限へ達した場合に未処理指示を残して成功終了扱いにはしない。
- エラーメッセージは英語。credential・Authorizationを記録しない。

利用者の「表示は現在の仕様のままでいい」に従い、表示形式は変更しない。Worker受付を確認した時点で
既存の`Additional instruction received · ...`を表示し、実適用時は既存の`steer>`行へ置き換える。

原観測（2026-10-03、173配置後）: 利用者が実行中に「Webで調べて」を送り、
`Additional instruction received · Webで調べて`が表示されたが、元の回答でreadyへ戻った。
Session `6842cfcf-6a79-422c-ad82-b271e5473efe`、execution
`8ff7914b-eeee-41f6-998a-af02e41295ae`の保存会話には元taskのuser message
1件だけがあり、 追加指示の適用messageはない。model step
8の元の最終回答で`completed`／`final`となった。 観測調査に追加provider
callは使っていない。

## 現行経路と修正計画

TUIのF3 → Core steering API → ApplicationTaskService → Host coordinator →
Workerのsteer command → WorkerGenerationのSteeringOwner → loopのconsume →
steering_message → Agent Data semantic保存 → Hostへsteering_applied →
TUIの受付noticeを適用user行へ置き換える、という経路である。

loopはtool batch後だけで指示をconsumeし、model
finalのbranchでは取り込まずreturnする。
finallyのcloseが未処理指示を破棄する。finalのassistantを記録した後に指示を取り込み、
未処理指示があれば次のmodel
stepへ継続する。正常終了を決める際は受付laneを閉じる。

HostのsteerActiveTurnはcommand送信だけでacceptedを返し、Workerの受付結果を確認していない。
Workerがloopを終了してlaneを閉じた後もHostのexecutionはcommit／settlement中に見えるため、
その間の要求が受付済みとして表示される経路がある。小さいWorker受付replyを追加し、
Coreのcommand結果はそのreplyを待つ。既存HostMessageQueueと相関IDを使い、別の保存機構は作らない。
終了後や異なるexecutionの受付はWorkerの実際の結果で判断する。

受付reply待ちと実適用の順序をTaskService側で扱い、適用済み指示のpending表示を復活させない。
production
HTTP確認では、継続requestとsemantic会話は成立したが、Session保存のcausal
parserが
元のassistant回答でturnを区切り、`commit proposal invalid`で保存を拒否することを確認した。
追加指示のuser
messageに`steering: true`を保持し、回答後の指示も同じturnとして扱う。
modelには既存のuser本文を送り、表示・provider replay
state・通常taskのturn境界を保持する。
これは175の同じexecutionで継続・保存する要件の一部であり、migrationや別保存先は作らない。
新しいqueueや追加指示の複数回受付は作らない。B8の診断拡充、一般的hardening、認証、
構想・architecture・roadmap変更は対象外。

## 確認計画

- loopのfinal中に受け付けた指示が元のassistantとreplay
  stateの後に追加され、次requestで使われる。
  制限へ達した場合も指示のsemantic記録を残し、元のfinalを成功として返さない。
- Worker受付replyとTaskServiceのreceipt確認を検証し、閉じたlaneの拒否、適用済み指示のpending非復活を確認する。
- production Worker／Core HTTPとlocalhost providerで、final応答中の追加指示 →
  継続request → 新しい最終回答 → 保存会話・request readbackまで確認する。
- 既存142 HTTPのtool後取込み・follow-up／cancelと、関係する170
  TaskService確認を使う。
- source/testのtype check、format、lint、git diff --checkを実施する。full
  gateは計画しない。
- 隔離XDG・tmuxのproduction
  TUIでfinal応答中のF3、受付notice、実適用user行、継続した最終応答を localhost
  provider経由で確認する。資料はtmpへ保存し、実provider callは行わない。

## 結果

### 実装

- loopはmodel finalのassistantとreplay
  stateを記録した後、未処理指示を取り込んで次requestへ進む。
  指示は一度だけsemantic履歴とrequest
  attributionへ記録する。step制限へ達した場合も指示を記録し、
  元のfinalで成功終了せず`max_steps`となる。正常終了を決める時点で受付laneを閉じる。
- Workerの相関付き`steering_received`replyをHostが待ち、Coreが実受付結果を返す。
  TaskServiceはreply待ちを予約し、適用がreplyより先に届いた場合もpendingを復活させない。
- Session codec／history indexは`steering: true`を含むuser
  messageを同じturnの指示として保存・参照する。
  途中のassistant回答と継続後の回答を含めて1 turnとなり、次の通常taskはturn
  2へ進む。
- TUIの表示形式、tool後取込み、cancel、follow-up、受付数、request／step制限は変更していない。
  B8と構想・architecture・roadmapは変更していない。

### Focused確認

175のloop／TaskService 5件とproduction Worker／Core HTTP
1件が成功した。最終回答からの継続、
replay保持、step制限時の指示記録、正常終了前のlane閉鎖、Worker
receipt待ち、閉じたlaneの拒否、
適用後のpending非復活を確認した。HTTPではlocalhost Responses endpointを使い、2
request、
元task→元assistant→追加指示→継続後assistantの保存会話、`completed`／`final`／`canonical`、
pending解消、その履歴から次の通常taskがturn 2で正常保存されることを確認した。

既存142 HTTP 1件、170 TaskService 6件、38 recall 7件、39 cancellation
4件、current code 17件が成功した。関係するsource/testのtype
check、format、lint、`git diff --check`も成功した。 full gateと実provider/model
callは行っていない。

### 隔離production TUI

資料: `/tmp/henji-increment-175-tui-5jf5pea5/evidence/`。 source版の通常CLI
`serve`と接続TUIを tmuxの100×32
terminalで起動し、config/data/stateを同tmp配下のXDGへ分離した。
外部宣言の`increment175-local`とdummy credential、localhost Responses
endpointを使った。 network permissionは127.0.0.1だけで、実credential・実provider
callは使っていない。

1. `Original task`をEnterで送信し、最初の応答を保留した。既存thinkingとassistant部分表示、busyを確認した。
2. `Research the web before answering.`を入力し、F3で送信した。Worker受付後に既存の
   `Additional instruction received · ...`が表示され、pendingにも同じ指示があった。
   資料は`01-busy-before-steering.txt`、`02-steering-received.txt`、`02-accepted-snapshot.json`。
3. 応答保留を解除すると、同じexecutionが2回目のrequestへ進み、指示は`steer>`行となった。
   継続後のthinkingと`Updated answer reflecting the additional instruction`、readyを確認した。
   受付noticeは消え、pendingも解消した。資料は`03-final-tui.txt`、`03-final-snapshot.json`。
4. execution readbackは`completed`／`final`／`canonical`、requestCount 2だった。
   providerの2回目のuser inputsに指示があり、canonical `session_messages`の4
   messageはすべてturn 1で、 追加指示には`steering: true`が保存されていた。
   資料は`04-execution.json`〜`06-saved-semantic.json`と`checks.json`。

TUIをdetachし、今回の検証用Coreだけを通常`core stop --connect`で停止した。
localhost応答サーバーも停止済み。常用Coreと実configは変更していない。
このlocal確認時点では常用配置・commit/pushは未実施。

追加のコード確認で、F2のqueueはCoreが保持し、追加指示による継続中も残り、
継続後の正常終了と後処理完了を待って次taskを開始する経路を確認した。
cancel／失敗時の既存の破棄経路にも175による変更はない。この追加確認では変更・実行はしていない。

2026-10-03の利用者の「ではインクリメントを完了とする」で本incrementの完了承認を受けた。

### 通常reviewと常用配置

2026-10-03の174〜176の通常reviewでfindingはなかった。追加のproduction
HTTP／DB／CLI確認で、 追加指示のrequest
readbackとattribution、その後の通常taskがturn 2で保存されることを確認した。
続く配置指示により176までを含む常用binaryを配置した。配置先の隔離production
TUIでも、F3の受付表示、
元のfinalから同じexecutionの次requestへの継続、同じturnへの追加指示保存、pending解消を確認した。
配置・review資料とbuild情報は[Increment 176](increment-176.md#常用配置)を参照する。
