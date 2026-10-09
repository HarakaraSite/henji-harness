# Increment 218 実行中Core trimスパイク（2026-10-09）

利用者の「これをスパイクで試そうか」に基づく隔離調査。必要な実行状態を残し、
長い1ターンの実行中にCoreから`malloc_trim(0)`を呼んで、解放済みページ返却の効果と処理負担を比較する。
前回はAgent存続・待機中に95.43
MiB減少したが、実行中の効果と継続動作は未確認だった。

## 計画

- commit `38eb2423`のcompiled Core＋production
  TUI。前回の隔離診断sourceをコピーし、
  Core診断moduleへ周期trimと同じ統計を採るshadow
  timerだけを追加する。通常sourceの変更はしない。
- 新しい隔離Core/Session/Agentを条件ごとに一つ作る。従来と同じ59,282
  byte全文read→OKの
  localhost200ターンで温め、そのまま同じWorkerで長い1ターンを実行する。
- 長い1ターンでは128 byteのfileを200回readし、最後にOKを返す。localhost
  providerの各responseに
  250ms待機を入れる。現在ターンの全文保持が必要なため小さいtool結果を使い、既存のcontext予算を維持する。
  従来の200ターンと同じ負荷とは扱わず、単一実行中の返却と継続性を評価する。
- control／5秒ごとtrimを各一回、逐次実行する。5秒は実験用でありproduction方針ではない。
  controlも同じ周期でnative統計とRSSを採取し、trim呼出しだけを省く。
  timerはCore内で動き、Agentのtool完了やターン終了を待たない。
- 長いターン終了時にtimerを止め、次の通常read→OK会話を実行する。最後の30秒待機後も観測する。
  実provider、強制V8 GC、Worker再起動、実DB/config/常用binaryの変更はしない。
- 約20msの外部RSS/PSS、各context
  heapとgeneration、allocator使用中/空き、各trim時間と前後RSS、
  実行中のlifecycle、処理時間とprovider待機時間、最大値を記録する。
  開始前の空きメモリから前回と同じCore＋TUI停止上限を記録する。
- canonical履歴の全tool引数/結果/hash、final OK、全requestの入力hashと予算、
  長い実行中のtrim発火と同じAgent generationでの継続、正常shutdownを照合する。

## 結果

Coreの5秒周期timerから、**同じ1ターンの実行中にtrimでき、200回のtool呼出し・final
OK・次の通常会話まで完了した**。 全timer
tickの前後を、同じexecutionがまだsettledしていないAPI観測で挟んで照合した。
Agent/Data/API/Core/TUIは同じPID/generationのまま。trim処理はAgentのtool完了やターン終了に連動しない。

単位MiB。時刻は最終request処理後のsettlement観測を含む。

| Core RSS/PSS          | control         | 5秒周期trim     |
| --------------------- | --------------- | --------------- |
| 長いターン開始前      | 337.63 / 310.01 | 335.41 / 307.69 |
| 長いターン終了直後    | 294.35 / 266.72 | 246.92 / 219.20 |
| 次の会話＋30秒        | 196.11 / 168.48 | 155.01 / 127.29 |
| 実行中・中央値        | 276.96 / 249.33 | 241.46 / 213.74 |
| 実行中・95 percentile | 349.78 / 322.15 | 337.47 / 309.75 |
| 実行中・観測最大      | 351.31 / 323.69 | 342.35 / 314.62 |

実行中のRSS中央値は276.96→241.46 MiB、差35.49 MiB。
最大値には開始から最初の5秒のtrim前も含む。Core＋TUIの全run最大はwarm区間も含むため、
本スパイクの実行中返却の効果と区別する。controlでも自然回収による減少があった。

同じ負荷でも開始時のheap状態・自然GCの位相は一致していないため、この中央値差の全量をtrim単独の効果とは断定しない。呼出し直前/直後のRSS減少とnative使用中量がほぼ不変だった観測を、実行中のページ返却を示す直接の証拠とする。

![単一実行中のRSS/PSS](../../.tools/increment-218-active-trim-spike-20261009/active-trim.png)

| 条件            | 長いターン秒 | 設定provider待機秒 | 観測provider処理秒 | 設定待機を除く秒 | timer回数 | call中央値ms | call最大ms | call合計ms |
| --------------- | ------------ | ------------------ | ------------------ | ---------------- | --------- | ------------ | ---------- | ---------- |
| run-control-200 | 57.408       | 50.25              | 50.347             | 7.158            | 11        | 0.002        | 0.007      | 0.027      |
| run-trim-200    | 57.205       | 50.25              | 50.376             | 6.955            | 11        | 2.817        | 7.375      | 40.075     |

待機を除いた時間も純粋なCPU時間ではない。通常のtool/DB/TUI/HTTP処理とdriver観測を含む。
controlのcall時間は空の計時区間、trimは`malloc_trim`単独の時間。前後の統計採取時間を含まない。
各条件一回の逐次比較であり、処理時間差にはrunの揺らぎも含む。10時間耐久やCPUを占有し続ける負荷は未確認。

trimは11回、ページ返却の返り値1は11回。
一回の直前/直後RSS減少は中央値8.43、最大48.27 MiB。
同じ区間のnative使用中変化は中央値0.0003 MiB。
Agentの必要なlive状態を解放した量とは扱わない。各回の前後RSS/使用中/空き、native結果、時間はtimer.csv/jsonに保存した。

## 各context・allocator・最大値

各値の単位MiB。heapはheapUsed / heapTotal / external。

| 条件            | 時点        | native使用中 | native空き |
| --------------- | ----------- | ------------ | ---------- |
| run-control-200 | beforeLong  | 38.03        | 61.88      |
| run-control-200 | longSettled | 19.65        | 78.33      |
| run-control-200 | idle30      | 14.50        | 84.02      |
| run-trim-200    | beforeLong  | 38.66        | 57.08      |
| run-trim-200    | longSettled | 18.30        | 78.13      |
| run-trim-200    | idle30      | 14.64        | 80.13      |

| 条件            | context      | 長いターン前         | 終了直後             | 次の会話＋30秒      |
| --------------- | ------------ | -------------------- | -------------------- | ------------------- |
| run-control-200 | data-worker  | 12.54 / 69.88 / 2.74 | 8.51 / 36.13 / 1.53  | 7.67 / 9.88 / 1.52  |
| run-control-200 | api-worker   | 6.00 / 7.00 / 1.01   | 6.19 / 7.00 / 0.98   | 3.90 / 4.75 / 0.54  |
| run-control-200 | agent-worker | 39.82 / 74.44 / 5.82 | 29.62 / 72.52 / 3.01 | 7.61 / 8.88 / 1.41  |
| run-control-200 | core-main    | 12.67 / 17.23 / 3.02 | 7.63 / 9.63 / 1.62   | 7.41 / 9.88 / 1.59  |
| run-control-200 | tui-main     | 15.27 / 24.68 / 2.74 | 16.71 / 28.93 / 1.71 | 6.82 / 8.68 / 0.98  |
| run-trim-200    | data-worker  | 25.98 / 69.38 / 6.27 | 8.57 / 36.38 / 1.53  | 7.75 / 10.38 / 1.52 |
| run-trim-200    | api-worker   | 6.08 / 7.00 / 1.06   | 6.29 / 7.25 / 0.99   | 3.89 / 4.75 / 0.54  |
| run-trim-200    | agent-worker | 29.17 / 73.72 / 3.21 | 19.32 / 71.62 / 2.22 | 7.62 / 9.88 / 1.41  |
| run-trim-200    | core-main    | 11.37 / 17.23 / 2.94 | 7.71 / 9.63 / 1.65   | 7.51 / 9.88 / 1.62  |
| run-trim-200    | tui-main     | 12.75 / 24.43 / 1.99 | 15.14 / 28.93 / 1.52 | 6.83 / 8.43 / 0.98  |

各contextの全run観測最大はmessage/publication/redraw境界とmilestoneに対応し、絶対瞬間最大ではない。

| 条件            | context      | heapUsed最大 | heapTotal最大 | external最大 |
| --------------- | ------------ | ------------ | ------------- | ------------ |
| run-control-200 | data-worker  | 44.46        | 76.88         | 11.88        |
| run-control-200 | api-worker   | 6.49         | 8.25          | 1.21         |
| run-control-200 | core-main    | 12.83        | 17.23         | 3.09         |
| run-control-200 | tui-main     | 20.50        | 28.93         | 2.93         |
| run-control-200 | agent-worker | 39.83        | 79.48         | 10.84        |
| run-trim-200    | data-worker  | 42.09        | 74.88         | 10.73        |
| run-trim-200    | api-worker   | 6.47         | 8.00          | 1.23         |
| run-trim-200    | core-main    | 12.75        | 17.23         | 3.05         |
| run-trim-200    | tui-main     | 20.31        | 28.93         | 2.99         |
| run-trim-200    | agent-worker | 39.75        | 77.93         | 7.38         |

| 条件            | 開始時有効空き | 停止上限 | Core全run最大RSS | TUI全run最大RSS | 合算全run最大RSS |
| --------------- | -------------- | -------- | ---------------- | --------------- | ---------------- |
| run-control-200 | 13833.21       | 6912     | 351.31           | 97.24           | 444.41           |
| run-trim-200    | 13819.64       | 6656     | 342.35           | 97.48           | 435.38           |

開始前の有効空き（MemAvailableと有限cgroup headroomの小さい方）の半分を256
MiB単位で切下げ、 7
GiBとの小さい方を停止上限にした。いずれも未到達。全run正常shutdown exit 0。

## 照合・証跡・限界

両条件で202ターン（warm200＋連続1＋継続1）/603 localhost
request、合計404ターン/1,206 request。 canonicalは各1,206 message・合計2,412
message。全read引数/全文結果/hash・全final OKと、全model requestの context
source/splice再構成・wire/system/tool hash・予算照合に成功した。Agent
generationは一つ。 実provider 0、強制V8
GCなし。全体warmの負荷は従来Aとbyte一致、長い1ターンの負荷は別設計。
H=32,768、input=65,536、context=131,072、output
reserve=65,536を両条件で維持した。

model messages最大はcontrol 94,464 / trim 94,461 byte、 input見積最大は33,249 /
33,247。5 MiB messages上限にも到達していない。

source commit `38eb2423bed0506926c40fd3c7d94e35c8406ef5`、binary SHA256
`fcb02c695f4982a2b5b4ae6603cbfb528a590ef5f40cbb9634cb2b085fd717d4`。
通常runtime/script等283fileはcommitとhash一致、診断16fileは測定後も不変。
前回診断との差はCore診断moduleへのtimer/shadowと数値記録だけ。Linux/glibc限定FFIは隔離compileのみ。
準備時の依存cacheを診断file数から除外して再確認し、driverの128
byte入力長を起動前に修正した。
これらはCore起動/正式run前の準備で、正式runは各条件一回だけ。

- raw/artifacts: `.tools/increment-218-active-trim-spike-20261009/`。
- `run-control-200 / run-trim-200`:
  隔離SQLite/XDG、samples/stages/smaps、各context、provider/budget事実、
  execution polls、timer events、turn timings、stop policy、TUI最終表示、normal
  shutdown。
- `aggregate.json / verification.json / timer.csv`:
  数値集約、全request/履歴照合と発火中lifecycle照合。
- `prepare.py / run.py / analyze.py / verify_active.py / plot.py / write_report.py`とsource/diagnostic/binary
  hash。

短い単一長時間実行での成立性を確認した。今回のprovider待機は1requestあたり250msで、実行時間の大半を占める。
CPU・allocatorを連続占有する実負荷、複数Session同時実行、10時間の保持増加は未測定。
5秒周期は実験用であり、productionの適切な間隔/条件は未決定。
trimは解放済み領域の返却で、必要な現在ターン/context/runtime状態や常時liveの削減ではない。
通常実装への組込み、実DB/config/常用配置、構想/architecture/roadmap変更、commit/pushは行っていない。
