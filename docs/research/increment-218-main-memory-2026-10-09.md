# Increment 218 本実装のlocalhostメモリ測定（2026-10-09）

本報告の数値は、全体reviewで見つかった3件のP2修正前の測定候補に対応する。 元のsource
hash・binary・ログは保持した。修正内容とfocused/re-review結果は
[Increment 218第11.13節](../increments/increment-218.md#1113-インクリメント全体reviewと指摘対応2026-10-09)を参照する。
修正後sourceでの長時間メモリ再測定は実施していない。

compiled Core＋production
TUIで200ターンを3回、代表runの同じ保存Sessionを新Coreで20ターン再開した。実プロバイダは0回。
Coreの101–200ターン傾き中央値はRSS **0.155 MiB/turn**、PSS **0.155
MiB/turn**。区間peak増分中央値はRSS **11.27 MiB**、PSS **11.26
MiB**。初期判断線（それぞれ≤0.25、≤64）は**満たした**。
判定は後半の増加率についてであり、RSSの完全な頭打ちを証明するものではない。有限保持と、20ターンから最終時点までの実測増分は分けて記録する。

## 条件と停止線

Deno 2.9.7、同じ512行・59,282
byteのread負荷、1ターン2物理request（read→OK）。各mainは新Core／Session／SQLite、main内は同じAgent
Worker。tmux 110×36の通常TUIを開いた。タスク投入はlocalhost
API、キーボード操作の確認は別のproduction
TUI区間で実施した。隔離XDGを使い、通常config／実DB／常用binaryは変更していない。
H=32,768、input=65,536、context=131,072、output reserve=65,536。wire UTF-8
bytes/3＋framingはtoken推計であり、localhostの診断予算。実モデルのtoken容量を確認した値ではない。各ターンsettled＋0.2秒、20／50／100／200＋2秒で記録。強制GC・main内Worker再起動なし。
RSS／PSSはCoreとTUIを別PIDでsmaps_rollupから約20ms間隔で取得。heapは隔離sourceの診断patchでWorker
message／Core publication／TUI
redraw境界の数値最大とmilestoneの値を記録した。通常runtimeへ診断endpointは追加していない。重いDB／入力照合・過去閲覧・全出力はsampling終了後。

| run | 開始時有効空き MiB | 停止RSS合計 MiB | sample数 | 周期中央値 ms | 最大周期 ms |
| --- | ------------------ | --------------- | -------- | ------------- | ----------- |
| 1   | 11527.61           | 5632.00         | 3414     | 25.00         | 31.82       |
| 2   | 11520.80           | 5632.00         | 3416     | 24.93         | 35.31       |
| 3   | 11517.03           | 5632.00         | 3431     | 24.97         | 44.08       |

停止線はmin(7GiB, 有効空きの半分を256MiB単位で切下げ)。有効空きはMemAvailableと有限cgroup
headroomの小さい方。Core＋TUIのRSS合計を監視し、上限超過時は隔離processを停止して部分ログを残す。今回の3
main／再開で停止線には達していない。詳細は各runのstop-policy.jsonとrun-1/resume-stop-policy.json。

## 固定費とターン時点

MiB。各時点は＋2秒。Session前／初会話前にはAgentがまだ起動していない場合があり、その後の増分には遅延起動の費用も含まれる。

| run | 時点                   | Core RSS | Core PSS | TUI RSS | TUI PSS |
| --- | ---------------------- | -------- | -------- | ------- | ------- |
| 1   | Core起動・Session前    | 86.25    | 80.21    | 0.00    | 0.00    |
| 1   | Session＋TUI・初会話前 | 88.65    | 65.96    | 61.73   | 42.15   |
| 1   | 20                     | 252.06   | 224.30   | 79.59   | 56.98   |
| 1   | 50                     | 296.93   | 269.14   | 82.34   | 59.70   |
| 1   | 100                    | 328.93   | 301.14   | 82.91   | 60.27   |
| 1   | 200                    | 348.82   | 321.01   | 91.71   | 69.05   |
| 2   | Core起動・Session前    | 86.32    | 80.24    | 0.00    | 0.00    |
| 2   | Session＋TUI・初会話前 | 88.76    | 65.15    | 61.08   | 40.68   |
| 2   | 20                     | 248.79   | 219.97   | 77.91   | 54.33   |
| 2   | 50                     | 296.57   | 267.76   | 81.57   | 58.00   |
| 2   | 100                    | 332.18   | 303.30   | 82.42   | 58.78   |
| 2   | 200                    | 343.33   | 314.45   | 90.68   | 67.04   |
| 3   | Core起動・Session前    | 85.88    | 79.85    | 0.00    | 0.00    |
| 3   | Session＋TUI・初会話前 | 88.38    | 65.85    | 61.18   | 41.71   |
| 3   | 20                     | 251.93   | 224.25   | 78.48   | 55.96   |
| 3   | 50                     | 299.50   | 271.79   | 80.84   | 58.29   |
| 3   | 100                    | 336.26   | 308.52   | 82.06   | 59.47   |
| 3   | 200                    | 341.66   | 313.88   | 90.89   | 68.27   |

| run | 20→最終 Core RSS増分 | Core PSS増分 | TUI RSS増分 | TUI PSS増分 |
| --- | -------------------- | ------------ | ----------- | ----------- |
| 1   | 96.76                | 96.71        | 12.12       | 12.06       |
| 2   | 94.54                | 94.48        | 12.77       | 12.71       |
| 3   | 89.73                | 89.64        | 12.40       | 12.31       |

## 各contextのheap

heapUsed MiB。各時点＋2秒、未起動contextは「—」。heapにはGC前の不要objectも含む。

| run | 時点      | Core main | Data  | API  | Agent | TUI   |
| --- | --------- | --------- | ----- | ---- | ----- | ----- |
| 1   | Session前 | 5.58      | 6.53  | 3.86 | 0.00  | —     |
| 1   | 初会話前  | 6.05      | 7.68  | 4.54 | 0.00  | 6.93  |
| 1   | 20        | 7.03      | 8.36  | 4.58 | 35.61 | 9.53  |
| 1   | 50        | 8.15      | 14.12 | 5.20 | 36.23 | 11.83 |
| 1   | 100       | 9.28      | 22.65 | 5.66 | 18.86 | 10.59 |
| 1   | 200       | 10.34     | 23.98 | 5.91 | 39.56 | 11.36 |
| 2   | Session前 | 5.56      | 6.50  | 3.88 | 0.00  | —     |
| 2   | 初会話前  | 6.03      | 7.64  | 4.55 | 0.00  | 6.93  |
| 2   | 20        | 6.72      | 8.37  | 4.57 | 22.12 | 8.45  |
| 2   | 50        | 7.67      | 14.15 | 5.05 | 25.74 | 10.98 |
| 2   | 100       | 8.87      | 26.48 | 5.70 | 37.32 | 10.53 |
| 2   | 200       | 8.44      | 26.94 | 5.99 | 29.16 | 9.47  |
| 3   | Session前 | 5.57      | 6.52  | 3.88 | 0.00  | —     |
| 3   | 初会話前  | 6.04      | 7.77  | 4.11 | 0.00  | 6.93  |
| 3   | 20        | 7.08      | 19.23 | 4.63 | 23.63 | 7.39  |
| 3   | 50        | 8.40      | 24.96 | 5.20 | 25.75 | 8.86  |
| 3   | 100       | 8.03      | 13.21 | 5.73 | 37.57 | 9.73  |
| 3   | 200       | 9.18      | 20.87 | 6.02 | 29.16 | 14.18 |

200＋2秒のheapUsed／heapTotal／externalと、message等の境界で観測した最大（MiB）。境界間の瞬間最大は保証しない。

| run | context      | used  | total | external | 最大used | 最大total | 最大external |
| --- | ------------ | ----- | ----- | -------- | -------- | --------- | ------------ |
| 1   | core-main    | 10.34 | 17.48 | 2.88     | 12.66    | 17.48     | 3.04         |
| 1   | data-worker  | 23.98 | 72.13 | 6.09     | 44.50    | 79.13     | 10.66        |
| 1   | api-worker   | 5.91  | 6.75  | 0.97     | 6.23     | 8.00      | 1.15         |
| 1   | agent-worker | 39.56 | 74.94 | 5.80     | 39.71    | 74.94     | 5.80         |
| 1   | tui-main     | 11.36 | 24.43 | 1.68     | 16.13    | 24.43     | 3.04         |
| 2   | core-main    | 8.44  | 12.25 | 2.11     | 11.28    | 15.75     | 2.34         |
| 2   | data-worker  | 26.94 | 70.38 | 6.27     | 44.61    | 76.63     | 9.85         |
| 2   | api-worker   | 5.99  | 7.00  | 1.00     | 6.30     | 8.00      | 1.14         |
| 2   | agent-worker | 29.16 | 73.86 | 3.20     | 39.81    | 74.33     | 5.80         |
| 2   | tui-main     | 9.47  | 24.18 | 2.86     | 15.81    | 24.18     | 3.22         |
| 3   | core-main    | 9.18  | 12.75 | 2.19     | 11.23    | 15.75     | 2.35         |
| 3   | data-worker  | 20.87 | 76.13 | 4.95     | 43.43    | 76.38     | 9.90         |
| 3   | api-worker   | 6.02  | 7.00  | 1.00     | 6.62     | 8.00      | 1.13         |
| 3   | agent-worker | 29.16 | 74.86 | 3.20     | 39.70    | 75.33     | 5.80         |
| 3   | tui-main     | 14.18 | 24.43 | 2.30     | 15.80    | 24.43     | 3.04         |

## process最大と後半の傾き

| run | 会話中Core RSS最大 | Core PSS最大 | TUI RSS最大 | TUI PSS最大 |
| --- | ------------------ | ------------ | ----------- | ----------- |
| 1   | 350.50             | 322.69       | 91.72       | 69.08       |
| 2   | 343.46             | 314.58       | 91.77       | 68.13       |
| 3   | 341.66             | 313.89       | 92.33       | 69.74       |

| run | 51–100 RSS/turn | PSS/turn | 101–200 RSS/turn | PSS/turn | peak RSS差 | peak PSS差 |
| --- | --------------- | -------- | ---------------- | -------- | ---------- | ---------- |
| 1   | 0.44            | 0.44     | 0.17             | 0.17     | 15.07      | 15.05      |
| 2   | 0.51            | 0.50     | 0.15             | 0.15     | 11.27      | 11.26      |
| 3   | 0.52            | 0.52     | 0.07             | 0.07     | 3.05       | 3.02       |

傾きは各turn＋0.2秒値に対する最小二乗直線。peak差は51–100区間と151–200区間のsample最大の差。各runの10turn区間最大と全系列は[集計JSON](../../.tools/increment-218-acceptance/aggregate.json)。

![各turnのRSS／PSS](../../.tools/increment-218-acceptance/memory-trend.png)

## 保持件数と保存／実入力照合

| run | turn | owner exec | Data索引 | Writer索引 | 完了command | 表示exec | entities | entity JSON bytes | Agent committed | TUI printed |
| --- | ---- | ---------- | -------- | ---------- | ----------- | -------- | -------- | ----------------- | --------------- | ----------- |
| 1   | 20   | 1          | 1        | 1          | 21          | 9        | 54       | 54558             | 0               | 27          |
| 1   | 50   | 1          | 1        | 1          | 32          | 9        | 54       | 54567             | 0               | 27          |
| 1   | 100  | 1          | 1        | 1          | 32          | 9        | 54       | 54587             | 0               | 27          |
| 1   | 200  | 1          | 1        | 1          | 32          | 9        | 54       | 54720             | 0               | 27          |
| 2   | 20   | 1          | 1        | 1          | 21          | 9        | 54       | 54558             | 0               | 27          |
| 2   | 50   | 1          | 1        | 1          | 32          | 9        | 54       | 54567             | 0               | 27          |
| 2   | 100  | 1          | 1        | 1          | 32          | 9        | 54       | 54587             | 0               | 27          |
| 2   | 200  | 1          | 1        | 1          | 32          | 9        | 54       | 54720             | 0               | 27          |
| 3   | 20   | 1          | 1        | 1          | 21          | 9        | 54       | 54558             | 0               | 27          |
| 3   | 50   | 1          | 1        | 1          | 32          | 9        | 54       | 54567             | 0               | 27          |
| 3   | 100  | 1          | 1        | 1          | 32          | 9        | 54       | 54587             | 0               | 27          |
| 3   | 200  | 1          | 1        | 1          | 32          | 9        | 54       | 54720             | 0               | 27          |

Dataのowner／descriptor／sequence、Coreのowner／executions／配送待ち、Agentの選択／draft、normalizer、TUI
notice／steering等の全numeric counterは各stages.jsonに保存。完了command cacheは32件／2MiB、表示は50
settled
executionか2MiBの小さい方＋active。200ターンの同一Sessionでは完了execution索引が各1件へ戻った。sampling後に同じ修正sourceで再確認した40子Agent反復／40
Data Session／41 Core Sessionでは、consumer終了後のowner・descriptor・sequence・Writer
cursor／closedSet／索引解放とinactive cache最大32件を確認済み。

| run（1は再開を含む） | canonical turns | messages | 物理request | budget fact | 全read原文一致 |
| -------------------- | --------------- | -------- | ----------- | ----------- | -------------- |
| 1                    | 220             | 880      | 440         | 440         | True           |
| 2                    | 200             | 800      | 400         | 400         | True           |
| 3                    | 200             | 800      | 400         | 400         | True           |

全620ターン／1,240物理requestで、保存された全read結果59,282 bytes、canonical本文、context
occurrence／digest／source locator／window splice、実入力のrole／tools／system、実wire
SHA256／byte数、予算factと計算をsampling後に照合した。main内のWorker
generationは同一、代表再開では別generation。証拠は[verification.json](../../.tools/increment-218-acceptance/verification.json)。

各main終了後の最初のcommand
read／同ID再送は、cache退避後も同じreceipt／executionを返し、turn／provider
requestを増やさなかった。代表Sessionは全220executionを古いpageまで辿り、旧readのdetail原文を確認。HTTP全出力とcompiled
CLIのoffline／connected stdoutはsession／canonical／detailの3
viewでbyte数・SHA256が一致した。結果は[post-sampling-readback.json](../../.tools/increment-218-acceptance/run-1/post-sampling-readback.json)。

## 保存Sessionの新Core再開20ターン

| 時点                             | global turn  | Core RSS | Core PSS | TUI RSS | TUI PSS |
| -------------------------------- | ------------ | -------- | -------- | ------- | ------- |
| resume_core_ready_plus_2s        | —（保存200） | 86.09    | 79.91    | 0.00    | 0.00    |
| resume_session_tui_ready_plus_2s | —（保存200） | 96.46    | 73.08    | 62.75   | 42.60   |
| resume_turn5_plus_2s             | 205          | 190.74   | 162.42   | 72.53   | 49.30   |
| resume_turn10_plus_2s            | 210          | 200.42   | 172.10   | 73.20   | 49.97   |
| resume_turn20_plus_2s            | 220          | 252.04   | 223.65   | 77.39   | 54.17   |

再開のmemory／context
heap／最大はaggregate.jsonのresume区間へ分離。初会話前→再開は新しい固定費を含み、mainの傾きへ混ぜない。

## 中断候補と検証状態

最初の候補はrun1の200＋2秒でData／Writer索引が200件、ownerが1件となる保持漏れを発見した。run1とrun2途中を保存して中断し、ownerのactive＋最新terminalの保持範囲へ索引解放を連動、旧IDのDB解決で再cacheしない修正を入れた。本文は削除していない。focused
11件成功・独立re-review findingなし、compiled 20ターンで1／1件を確認後、上記3
mainを改めて実行した。中断候補は[退避先](../../.tools/increment-218-acceptance/pre-active-execution-index-fix/)に保全し、最終3
mainへ混ぜていない。

最新full gateは**710 passed／6 failed**。6件は変更前HEAD 93e9cで再現した既存失敗（tool guideline
2件、read description 1件、外部child Tool応答1件、editor row 1件、TUI frame memory probe
1件）。今回由来の新Session hook／pre-admit取消receipt／Session削除／current-turn保存／Responses wire
effort等の回帰はfocusedで修正確認済み。gateは成功扱いにしない。[gate5](../../.tools/increment-218-main/s8-gate-5.log)、[元sourceの5件](../../.tools/increment-218-main/baseline-focused.log)、[元sourceの194](../../.tools/increment-218-main/baseline-194.log)。

通常compiled binary SHA256: `7419b7e2d98ad2fd5704802027401b847e250cd77dfd516d20d1348d0130cc26`。
測定用compiled binary SHA256: `31e1090c667302c3c24a89c18f392f8f1574bd9106e884bd08defb012a25c8e7`。
診断前source
hash一覧は[source-before-instrument.json](../../.tools/increment-218-acceptance/source-before-instrument.json)、診断差分hash一覧は[diagnostic-files.json](../../.tools/increment-218-acceptance/diagnostic-files.json)。

RSSはlive object量と一致せず、SQLite／native allocation／V8
heapの予約領域／共有pageを含む。今回の保持counterだけで残量の原因を断定しない。200ターン以降、別負荷、実モデルのcontinuation品質・実token容量は未確認。localhost結果と実プロバイダ結果は別に扱う。

結果の独立reviewは必須findingなし。保存raw samplesからの再計算で傾き・peak増分、
表の数値とグラフが一致した。全620turn/1,240requestの照合記録、再送・閲覧・全出力hash、
保持寿命、診断前source 288件／診断差分14件とbinary hashの整合を確認した。
reviewerはtest/build/gate/providerや測定の再実行を行っていない。

実プロバイダはユーザー指示により最後の呼出し直前で停止。予定はOpenCode Go／deepseek-v4.1-flash／Chat
Completions SSE／effort auto、同一Session 15ターン＋新Core再開5ターン、隔離
.tools/increment-218-live/、物理request最大40。実DBコピー／切替、配置、commit／pushは未実施。構想・architecture・roadmapは変更していない。
