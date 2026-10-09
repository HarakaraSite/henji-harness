# Increment 219: production 5分周期trimの長い2ターン測定（2026-10-09）

利用者が選んだ「約6分×2ターン＋短い確認会話」を一回実施した。 **productionのCore
timerが二回ともターンの途中で発火し、現在ターン・同じWorkerを維持して完了した。**
ターン間でtimerをリセットせず、短い次の会話と最後30秒待機、正常shutdownまで確認した。 実provider
0、強制V8 GCなし。

## 条件と本実装

[Increment 219](../increments/increment-219.md)の実装候補を隔離コピーして数値診断を追加した。
`serve_cli.main`からnative runtime
helperを一つだけ起動し、Core終了時のfinallyでtimerとlibraryを閉じる。 Linux
x86_64/glibcの`malloc_trim(0)`を300,000ms周期で呼び、timerはunrefする。
他platformの返却は今回対象外。native機能をLinuxで読み込めなかった場合のfallbackは加えていない。
compileはlibc限定FFIを付与し、source Core起動は既存の`-A`経路を使う。
通常実装にCPU/RSS記録、履歴、probe、V8低メモリ通知は加えていない。

前回200ターンのwarmupを行わず、新しい隔離Core/Session/Agentとtmuxのproduction TUIを接続した。
長い各ターンは128 byteのfileを200回read→final OK。localhost Chat Completions SSEの201requestに
各1.8秒待機を入れ、設定provider待機は各361.8秒。maxSteps=201。 最後は従来とbyte一致する59,282 byte
fileをread一回→OK（2request）。 各run内は同じCore/Session/Agent generation
1。H=32,768、input=65,536、context=131,072、output reserve=65,536。
今回の負荷は単一実行を長くする人工負荷であり、通常利用の固定費やCPU連続占有の負荷とは扱わない。

## 発火時の返却と直接CPU負担

| 回 | Core timer起動から秒 | 返り値 | 直前→直後RSS MiB | 減少MiB | 経過ms | thread user CPU ms | thread system CPU ms | thread CPU合計ms |
| -- | -------------------- | ------ | ---------------- | ------- | ------ | ------------------ | -------------------- | ---------------- |
| 1  | 300.003              | 1      | 198.76 → 197.45  | 1.32    | 0.333  | 0.000              | 0.000                | 0.000            |
| 2  | 600.004              | 1      | 259.06 → 223.16  | 35.90   | 5.712  | 0.000              | 3.115                | 3.115            |

全発火を同じexecutionの未settledなAPI観測で前後から挟んで照合した。
RSSは呼出し直前/直後のDeno.memoryUsageと外部smapsを保存。glibc使用中/空き統計も前後で採った。 Core
thread CPUはgetrusage(RUSAGE_THREAD)で呼出しを挟む最小区間を採取した。
区間には診断の短い計時/数値処理も含み、他threadのCPUや後続のページ再確保は含まれない。
小さい呼出し区間でCPUカウンタ差が0の記録は、変化を検出できなかった値であり、CPU負担ゼロの証明ではない。
経過時間にはallocator lock待機やOSのscheduleも含み得るため、CPU時間と同じものとして扱わない。
[getrusage仕様](https://www.man7.org/linux/man-pages/man2/getrusage.2.html)。

| 回 | native使用中MiB | native空きMiB   | thread minor fault差 | thread major fault差 |
| -- | --------------- | --------------- | -------------------- | -------------------- |
| 1  | 56.239 → 56.240 | 4.484 → 4.479   | 2                    | 0                    |
| 2  | 22.284 → 22.284 | 42.513 → 42.388 | 0                    | 0                    |

allocatorの空きbyte accountingはresident量ではない。返却量を必要なlive状態の削減量とは扱わない。

## ターン別のメモリ・CPU・所要時間

| ターン | 処理秒  | 設定provider待機秒 | 観測provider処理秒 | 設定待機を除く秒 | Core user CPU秒 | Core system CPU秒 | Core minor fault差 | Core major fault差 |
| ------ | ------- | ------------------ | ------------------ | ---------------- | --------------- | ----------------- | ------------------ | ------------------ |
| 1      | 368.081 | 361.8              | 361.895            | 6.281            | 9.80            | 2.83              | 205524             | 0                  |
| 2      | 371.961 | 361.8              | 361.978            | 10.161           | 12.56           | 2.79              | 36718              | 0                  |

Core
CPUはprocess全threadの累積値を外部/proc/pid/statから読み、各ターンの最初/最後のsampleの差を取った。
設定待機を除いた時間には通常tool/HTTP/DB/TUI/driver観測を含み、純CPU時間ではない。

| ターン | Core RSS/PSS中央値MiB | Core RSS/PSS最大MiB | Core平均CPU・1論理CPU=100% |
| ------ | --------------------- | ------------------- | -------------------------- |
| 1      | 156.61 / 127.82       | 248.84 / 220.02     | 3.431                      |
| 2      | 258.74 / 229.91       | 262.08 / 233.25     | 4.127                      |

![Core memoryと累積CPU](../../.tools/increment-219-five-minute-memory-20261009/five-minute-trim.png)

## 起動・待機・各context

| 時点                                | Core RSS/PSS MiB | TUI RSS/PSS MiB |
| ----------------------------------- | ---------------- | --------------- |
| core_ready_before_session           | 87.40 / 81.25    | 0.00 / 0.00     |
| session_ready_before_tui            | 89.66 / 83.40    | 0.00 / 0.00     |
| session_tui_ready_before_first_turn | 90.02 / 66.34    | 61.33 / 40.84   |
| turn1_settled                       | 248.86 / 220.03  | 82.40 / 58.79   |
| turn2_settled                       | 257.21 / 228.35  | 93.17 / 69.52   |
| recovery_settled                    | 262.84 / 233.98  | 93.18 / 69.53   |
| recovery_plus30s                    | 260.18 / 231.32  | 93.36 / 69.54   |

TUI接続による共有ページのPSS配分変化は、Core内のlive状態削減とは扱わない。

| 時点                                | context      | heapUsed MiB | heapTotal MiB | external MiB |
| ----------------------------------- | ------------ | ------------ | ------------- | ------------ |
| session_tui_ready_before_first_turn | data-worker  | 7.16         | 9.50          | 1.58         |
| session_tui_ready_before_first_turn | api-worker   | 4.77         | 6.50          | 0.61         |
| session_tui_ready_before_first_turn | core-main    | 6.20         | 8.25          | 1.42         |
| session_tui_ready_before_first_turn | tui-main     | 7.02         | 10.35         | 1.05         |
| turn1_settled                       | data-worker  | 7.38         | 36.38         | 1.50         |
| turn1_settled                       | api-worker   | 4.80         | 5.50          | 0.69         |
| turn1_settled                       | agent-worker | 24.20        | 67.27         | 2.61         |
| turn1_settled                       | core-main    | 7.43         | 8.25          | 1.61         |
| turn1_settled                       | tui-main     | 7.75         | 14.93         | 2.80         |
| turn2_settled                       | data-worker  | 7.51         | 46.13         | 1.50         |
| turn2_settled                       | api-worker   | 5.19         | 5.75          | 0.76         |
| turn2_settled                       | agent-worker | 18.39        | 69.63         | 2.20         |
| turn2_settled                       | core-main    | 8.46         | 9.25          | 1.82         |
| turn2_settled                       | tui-main     | 12.21        | 23.93         | 1.61         |
| recovery_plus30s                    | data-worker  | 27.10        | 49.63         | 4.25         |
| recovery_plus30s                    | api-worker   | 5.36         | 6.00          | 1.00         |
| recovery_plus30s                    | agent-worker | 27.51        | 70.14         | 2.99         |
| recovery_plus30s                    | core-main    | 8.22         | 9.75          | 1.81         |
| recovery_plus30s                    | tui-main     | 11.20        | 23.93         | 1.80         |

各contextの観測最大。message/publication/redraw境界とmilestoneで採取した値で、絶対瞬間最大ではない。

| context      | heapUsed最大MiB | heapTotal最大MiB | external最大MiB |
| ------------ | --------------- | ---------------- | --------------- |
| data-worker  | 28.62           | 49.63            | 4.25            |
| api-worker   | 5.55            | 7.25             | 1.00            |
| core-main    | 9.12            | 10.50            | 2.01            |
| tui-main     | 16.74           | 26.18            | 7.29            |
| agent-worker | 38.35           | 72.41            | 5.00            |

開始前の有効空き13557.48 MiBからCore＋TUI RSS停止上限6656 MiBを記録した。
有効空きはMemAvailableと有限cgroup headroomの小さい方、上限はmin(7 GiB, 有効空き半分を256
MiB単位で切下げ)。 合算RSS最大356.25 MiBで未到達。Core最大RSS/PSS 262.88/234.02、 TUI最大
93.71/70.10 MiB。 外部sample 31,258、周期中央値24.48ms、最大277.57ms。

## 照合・証跡・限界

全3ターン/404 localhost request、canonical 808messageの全tool引数/結果/hash・全final OKを照合した。
全requestのcontext source/splice再構成、実wire/system/tool hash、設定予算を照合した。
messages最大87,513 byte、input見積最大33,253で5 MiB上限未到達。
同じWorkerでの継続、timerの300秒/600秒での発火、全発火時の実行中lifecycle、正常shutdown exit
0を確認した。 通常candidate 284fileと診断16fileは測定後もhash不変。

base commit `38eb2423bed0506926c40fd3c7d94e35c8406ef5`＋219 local実装。 production binary SHA256
`69714a7147b1ec7c6dfd8dd776d15f7ab33764f5401ffc051f6b12c8b2f6acd1`、 測定binary SHA256
`efe457c94ff13aa07d41679b9ff95949b008524d69afcc1a428628c2e4409a87`。

証跡は `.tools/increment-219-five-minute-memory-20261009/`。
source/診断hash、production/測定build・version、profile、SQLite/XDG、samples/stages/smaps、各context、
provider/budget事実、execution polls、production trim events、turn timings、stop
policy、TUI最終表示、
aggregate/verificationとprepare/run/analyze/verify_long/plot/write_reportを保存した。

対照runは追加していない。全体CPU/page
faultには通常処理と観測が含まれ、trim後の再確保負担を単独に分離していない。
provider待機が大半の人工負荷であり、CPU連続占有、複数Session、10時間耐久は未確認。
5分を最適間隔とは判断せず、利用者が選んだ暫定値として保持する。
必要なlive状態は残す。今回は通常実装をlocalに追加したが、実DB/config操作・常用配置・commit/push、
構想/architecture/roadmapの変更は行っていない。
