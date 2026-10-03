# A28 実provider・compiled Coreの観測 — 2026-10-02

利用者は、現行sourceへの必要な観測コード挿入と、実providerへの長いrequestを許可した。
最初の停止があったSession `e71f582a` の指示・model・履歴をread-onlyで確認し、
履歴コピーを使う隔離環境でproduction Core/HTTP/SSE/TUIと実providerを動かした。
対策実装、常用配置、既存Coreへの介入、構想・architecture・roadmapの変更は行っていない。

## 対象と実行条件

元の停止executionは `4119fc5f-667b-48d9-abc0-c4200418892a`。
指示は「8色は切り捨て、256色を最低ラインとする」。 provider/model/effortは
`opencode-go-chat / mimo-v2.6-pro / auto`。
そのまま再投入すると現在の実装を変更する可能性があるため、同じテーマの設計報告を新たな指示とした。
元の実行の完全な再実行ではなく、同じ保存履歴に対する新しい実provider更新の観測である。

- run-1:
  toolを使わず、256色TUIについて18,000字以上を目安に長い設計報告を求めた。
  開始180秒でcancelを送信した。
- run-2:
  同じ履歴コピーで、palette候補を1,500〜2,000字程度にまとめる報告を求めた。
  開始20秒でcancelを送信した。run-1の停止後に起動し、二つのCoreを同時に負荷実行していない。
- 両runとも `--max-steps 1 --provider-timeout-ms 1200000`。
  各runのXDG、HOME、workspace、DBは隔離した。DBのworkspace
  bindingはコピー内だけを変更した。
- compiled production
  TUIをtmuxでCoreへ接続した。task投入とcancel送信は外部観測runnerが
  TUIと共通のHTTP
  operationへ直接行った。keyboard/Esc入力からの所要時間は今回の計測範囲に含まない。
- 外部providerへ直接接続した。既存のresponseを全量bufferするproxyは使っていない。

## 観測コードと保存

現行sourceの六つのmoduleへ一時的に計測を挿入し、補助moduleを一つ追加した。
会話projection、各query、snapshot refresh、journal writeと通知、HTTP
handler、Host cancelを計測し、 Agent
Worker送信とCore受信をsequenceで照合した。定期的なイベントループ実行と
`Deno.memoryUsage()`、外部process/thread CPU・RSSも記録した。

ログは時刻、identity、kind、回数、時間、本文の文字数、メモリ量等である。
本文、raw
request/response、SSE断片、credential、Authorizationは計測ログへ保存していない。
計測処理自体のoverheadを独立に測ったものではない。

観測は隔離XDGでだけ有効にした。計測sourceはbinary作成後に元へ戻し、七つのfileについて
保存した変更前hashと一致することを確認した。変更前から存在した169等の差分は保持した。
観測source、tracked fileのpatch、元sourceのhash、prompt、binary、DB、計測結果は
`.tools/a28-production-observation/`
に保存した。生成したcredentialコピーは観測終了後に除去し、
実configのcredentialは変更していない。

型確認、対象fileのformat/lint、diff checkを実施し、公式build scriptでcompiled
binaryを作成した。 観測helperの型エラーを一度修正してbuildを再実行した。full
gateは実行していない。

観測binary:

- version `0.8.0`、Deno `2.9.7`
- source `27f154283631c3770f28d52159863498d8fa1174+dirty`
- build ID `911d5d33d7e3f05739f3db54d233016b83134a17324701545aead34118ebe74a`
- runtime SHA-256
  `f5257070df2aa5ee15ace087e153c6bdc7ebbe08cfd38edc31fc89e944d71f60`

## run-1: 長い応答中の受付停止

execution `1e321dfe-907f-4d70-a295-7134dc82ba52`。 Agent Workerのrequest開始から
`model_result` 送信までは678.440秒だった。
Workerは約11分18秒でprovider結果を得て `commit_proposal`
を送ったが、Coreはその受信に追いつかなかった。 観測終了時はWorkerの送信sequence
1451に対し、Coreの受信は541だった。

cancelは開始約180秒で送信した。600.098秒待ってもHTTP応答がなく、外部clientがtimeoutした。
この範囲ではcancelのHTTP handler入口とWorkerのcancel受信は記録されていない。
provider終了後も再構築が続いていたため、bounded
observationとして隔離Coreを停止した。
この停止はcancel成功、正常なsettlement、または完了後のメモリ観測として扱わない。

| 計測                                  | 結果                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| 完了が記録された会話再構築            | 973回、合計970.065秒                                  |
| Core main threadのCPU使用率           | process samplingの中央値約99.74%（1 CPUを100%とする） |
| 保存batch一件の通知処理               | 最大257.942秒                                         |
| journal write                         | 記録された5回の合計342.578ms                          |
| `executionEvents` query経路           | 合計505.299秒                                         |
| `semanticOccurrences` query経路       | 合計339.594秒                                         |
| 上記二queryの再構築時間に占める割合   | 約87.1%                                               |
| Worker送信→Core受信の最大確認済み遅延 | 502.978秒                                             |
| health                                | 記録された139回すべて2秒timeout                       |
| 最大RSS                               | 776.047MiB                                            |

query時間にはDB取得、JSON復元、clone、context hydration等の該当経路を含む。
SQL実行時間だけと呼ばない。またprojection、refresh、journal
notificationは入れ子の区間であり、
これらの時間を合算して総処理時間にしない。kill時点で未完了だった区間は完了span集計へ入らない。

## run-2: 短めの応答と終了後の状態

execution `66c7ed2a-5c79-4d22-bd42-0786f036666e`。 Agent Workerのrequest開始から
`model_result` 送信までは97.969秒だった。 Coreの `model_result`
受信はその約81.930秒後だった。 外部clientが `processSettlement: complete`
を確認するまで、provider結果送信から266.950秒かかった。

cancelは開始約20秒で送信し、HTTP返答までは346.068秒（約5分46秒）だった。
344.897秒はHTTP handler開始前の待ちで、handler内は1.170秒だった。 返答は
`idle`。最終executionは `completed / canonical / processSettlement: complete`
であり、
キャンセルは既に終了した実行へ間に合わなかった。これもcancel成功とは扱わない。

| 計測                           | 結果                                     |
| ------------------------------ | ---------------------------------------- |
| 会話再構築                     | 414回、合計362.781秒                     |
| 保存batch一件の通知処理        | 最大178.295秒                            |
| journal write                  | 記録された5回の合計142.786ms             |
| Worker送信→Core受信の最大遅延  | 82.793秒                                 |
| Coreの定期処理の最大実行間隔   | 350.048秒                                |
| health                         | 65回中51回が2秒timeout。終了後は応答した |
| 最大RSS                        | 630.102MiB                               |
| task投入前のRSS中央値          | 376.434MiB                               |
| settlement確認から採取した時間 | 約60秒                                   |
| 終了後の最後30秒のRSS中央値    | 355.480MiB                               |
| 同区間のCPU使用率中央値        | 0%                                       |

TUIは最終回答を表示してreadyへ戻った。計測された範囲では、終了後のRSSはtask投入前より低く、
2GB規模の増加や終了後の高メモリ維持は再現していない。
同じ履歴コピー・同じmodelでも、当時のメモリ状態の再現を保証するものではない。

## 現在の判断

実providerの更新を処理するproduction Coreで、同期の全会話再構築がmain
threadを占有し、
Workerからの更新受信とHTTP/cancel受付を遅らせることを直接観測した。
保存batchを先に書き終えた後、各イベントの通知で全体を再構築する経路は、
同じ保存済み履歴への処理を繰り返す大きな負担になっている。
「重い会話組み立て」の計測範囲の大部分は、履歴取得・復元を含むquery経路だった。

一方、provider自身の応答時間も存在する。run-1の678.440秒をCore処理の時間と取り違えず、
過去の10分待ち全体を会話再構築だけで説明したとは扱わない。
高CPUと更新滞留、数分のcancel受付遅延は実providerで再現した。
当時の2.5GiBの内訳や保持原因は今回の観測だけでは確定していない。
run-2では終了後のRSSが低下しており、このメモリ症状まで同じ原因と断定しない。

観測直後は三段階案の段階1として、通知合流・読取共有・Core外実行の組合せを検討していた。
後続議論で利用者は現状の責務を念頭に置かないことを原則とし、保存履歴とliveの共通逐次更新を指摘した。
現在の推奨案と批判的レビュー結果は
[共通更新器を基本にした再検討](a28-unified-conversation-update-design-2026-10-02.md)を参照する。
Worker化だけによるCPU・メモリ・会話表示待ちの解消は、今回の証拠から主張しない。
本観測は対策の実装承認や採用incrementの決定ではない。

## local証拠

- [実行runner](../../.tools/a28-production-observation/run_observed.py)
- [集計script](../../.tools/a28-production-observation/summarize_observation.py)
- [元指示とmodel](../../.tools/a28-production-observation/original-task.json)
- [run-1結果](../../.tools/a28-production-observation/run-1/results.json)
- [run-1集計](../../.tools/a28-production-observation/run-1/summary.json)
- [run-2結果](../../.tools/a28-production-observation/run-2/results.json)
- [run-2集計](../../.tools/a28-production-observation/run-2/summary.json)
- [source復元・credential非露出・実request数の確認](../../.tools/a28-production-observation/verification.json)

実providerのphysical requestは各run一回、計二回だった。

各run directoryにprocess/thread
sampling、health、Core/Agentのtrace、task/cancel返答、 TUI
capture、隔離DBを保存した。既存のDBと稼働Coreは変更していない。
