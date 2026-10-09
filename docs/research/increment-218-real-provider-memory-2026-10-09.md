# Increment 218 最新版の実provider 20ターン同時計測（2026-10-09）

最新の全体review指摘修正後sourceで、同じSession・Agent
Workerの20ターンを1回実行した。全ターン完了、21物理requestはすべてHTTP 200。Core
RSS/PSSは初会話前 **89.85/67.05 MiB**、20ターン後 **155.82/127.82
MiB**、最後の30秒待機後 **138.17/110.18
MiB**。増加は後半に緩やかになり、待機中に一部解放されたが、初会話前からの増分
**48.32/43.13 MiB** は残った。完全な頭打ちは確認していない。

## 実行条件と実際の負荷

利用者の実provider約20turn許可と、メモリ同時計測案への「ではやろうか」に基づく。OpenCode
Go / `opencode-go-chat` / `deepseek-v4.1-flash` / effort `auto`、Chat
Completions SSE。tmux 130×40のcompiled production
TUIへ毎ターンkeyboardで入力し、APIはSession選択・状態観測に用いた。途中のCore・Worker再起動、強制GC、コピー整理は実施していない。隔離XDG/workspace/schema3
DBを使用した。

準備案の15ターン＋新Core5ターンは、継続中の増加を測るため同じSession・Workerの20ターンへ変更した。入力は121
byteの`probe.txt`を読んでmarkerと短いdetailを返すもの。ただしモデルは「exactly
once」を会話全体で一回と解釈し、実際にはturn 1のread一回、turn
2〜20は履歴に基づく回答だった。途中で負荷や入力を変更せず、この一回を測り切った。**毎ターンreadの受入結果としては扱わない**。実requestはturn
1が2回、残り19turnが各1回。

通常のprovider declarationと同じ`user-agent` /
`x-opencode-session={sessionId}`を使用。context-budgetの追加設定はなく、H=32,768、input推計上限65,536、実requestのoutput
reserve=65,536。これはruntimeのoperational
estimateであり、実モデルのcontext容量を確認した値ではない。input推計最大4,148、H使用推計最大3,604。最後のrequestはturn
1〜19をすべて選択しており、予算による履歴切捨ては起きていない。

## 候補と計測方法

通常sourceはHEAD `93e9c344`＋未commitのIncrement 218・P2
3件修正。通常compile候補 `.tools/increment-218-review-fixes/henji`
と同じ最新sourceを隔離コピーしてから診断を加えた。通常runtimeは変更していない。Deno
2.9.7 / x86_64 Linux。

- 計測binary: `.tools/increment-218-real-memory/henji-memory`
- binary SHA256:
  `f4c16268401d54e0e0500c06a29c0cb1d938ac97fb37b00e7d6f5a6f4925ef57`
- build ID: `30265522508b25284a0736a7b708fc33380b44e1b9d088fe0634527d081bec50`
- embedded runtime SHA256:
  `51926953d45929d35b4bf104260258e9a3d402357ec17814cd29f1c167da9980`
- 診断差分15file:
  数値heap/保持件数/予算観測の14fileと、承認済み40物理fetch上限を実行前に守る隔離用counter
  1file。今回は上限未到達。

RSS/PSSはCore/TUIを別PIDで`smaps_rollup`から約20ms間隔に取得した。実測3,447
sample、周期中央値22.94ms、最大25.77ms。heapは約0.5秒の数値snapshot（157回、取得失敗0）に加え、Worker
message / Core publication / TUI
redraw境界で最大値を保持した。観測最大であり、全命令間の絶対最大を保証しない。RSS/PSSと各isolateのheapは同時刻の完全なcutではない。

開始前の有効空きメモリ10,917.72 MiBから、停止上限を **Core＋TUI RSS合計5,376
MiB** と定めて`run-1/stop-policy.json`へ保存した。式はmin(7 GiB,
MemAvailableと有限cgroup headroomの小さい方の半分を256
MiB単位で切下げ)。実測合計最大238.45 MiBで、停止線に達しなかった。

## 固定費、5/10/20ターン、30秒待機後

単位MiB。基準時点と5/10/20ターンはready/settledから約2秒待機後。Session後・TUI前も別に測った。Agentは初会話まで未起動なので、20ターン増分にはAgentの遅延起動費用も含まれる。

| 時点                       | Core RSS | Core PSS | TUI RSS | TUI PSS |
| -------------------------- | -------: | -------: | ------: | ------: |
| Core起動後・Session前      |    87.30 |    81.25 |    0.00 |    0.00 |
| Session後・TUI前・初会話前 |    89.03 |    82.86 |    0.00 |    0.00 |
| Session＋TUI・初会話前     |    89.85 |    67.05 |   61.71 |   41.88 |
| 5ターン                    |   132.38 |   104.39 |   73.83 |   50.91 |
| 10ターン                   |   148.56 |   120.58 |   80.69 |   57.76 |
| 20ターン                   |   155.82 |   127.82 |   80.93 |   58.01 |
| 20ターン＋30秒待機         |   138.17 |   110.18 |   75.32 |   52.27 |

TUI起動時に同一binaryの共有pageのPSS配分が変わるため、Core単独のSession前/後PSSとCore＋TUIのPSSは条件を区別する。

| 初会話前（Core＋TUI）からの増分 | Core RSS | Core PSS | TUI RSS | TUI PSS |
| ------------------------------- | -------: | -------: | ------: | ------: |
| 20ターン                        |    65.96 |    60.77 |   19.22 |   16.13 |
| 30秒待機後                      |    48.32 |    43.13 |   13.60 |   10.39 |

| 実行中の観測最大 |   Core |   TUI |
| ---------------- | -----: | ----: |
| RssMiB           | 157.55 | 81.15 |
| PssMiB           | 129.55 | 58.23 |
| VmHWMMiB         | 157.78 | 82.35 |

`VmHWM`はkernelが保持するRSS high-water
mark。Core/TUIの個別最大は同時刻とは限らない。

## 各contextのheap

各欄は **heapUsed / heapTotal / external
MiB**。通常GCを含む値で、heapUsedは生存objectだけの量ではない。

| 時点                       |          Core main |                 Data |                API |               Agent |                 TUI |
| -------------------------- | -----------------: | -------------------: | -----------------: | ------------------: | ------------------: |
| Core起動後・Session前      | 6.07 / 8.00 / 1.41 |   6.62 / 8.75 / 1.48 | 4.54 / 6.00 / 0.60 |                   — |                   — |
| Session後・TUI前・初会話前 | 6.38 / 8.25 / 1.42 |   7.37 / 9.75 / 1.58 | 4.16 / 6.25 / 0.61 |                   — |                   — |
| Session＋TUI・初会話前     | 6.58 / 8.25 / 1.44 |  6.74 / 10.25 / 1.58 | 4.35 / 6.25 / 0.62 |                   — |  6.97 / 9.85 / 1.05 |
| 5ターン                    | 6.84 / 7.75 / 1.47 |  8.55 / 13.50 / 1.71 | 5.18 / 6.00 / 0.87 |  7.76 / 9.88 / 1.49 | 8.32 / 12.23 / 2.20 |
| 10ターン                   | 6.95 / 8.75 / 1.52 |  9.84 / 17.75 / 1.87 | 4.60 / 5.75 / 0.64 | 8.75 / 11.38 / 2.82 | 9.77 / 16.48 / 2.85 |
| 20ターン                   | 7.26 / 9.00 / 1.61 | 10.11 / 18.75 / 1.92 | 4.71 / 6.25 / 0.65 | 8.85 / 12.88 / 3.32 | 9.91 / 16.56 / 1.91 |
| 20ターン＋30秒待機         | 6.28 / 7.25 / 1.41 |   8.08 / 9.50 / 1.89 | 5.06 / 6.50 / 0.65 |  7.31 / 8.63 / 1.42 |  7.26 / 9.06 / 1.10 |

| context      | 観測最大 heapUsed | heapTotal | external |
| ------------ | ----------------: | --------: | -------: |
| core-main    |              8.56 |     11.25 |     1.87 |
| data-worker  |             13.36 |     19.05 |     2.36 |
| api-worker   |              5.50 |      7.00 |     1.65 |
| agent-worker |             10.06 |     12.88 |     7.37 |
| tui-main     |             11.42 |     16.73 |     3.29 |

## 保持件数と増加の判断

5/10/20ターン後のAgent committed/selected保持は0、最後も0。Data ownerのexecution
index、Data execution generation index、Writer execution-to-Session
indexは各1で維持された。Core active command/executionは0、completed
ACKは6/11/21（20turn後12,692 byte、設計上32件/2
MiBまで保持）。配送queueとprepared suffixの残りは0。

閲覧pageはまだ50 settled executionの件数境界に達していないため、Writer page
executionは5/10/20、entityは27/51/101、bodyは18,544/34,236/65,562
byteへ増えた。TUI printedは16/30/60、printed textは3,061/5,040/7,946
byte。30秒待機でこれらの保持件数は変わらなかった。今回の20ターンは、閲覧page境界を越えた後の保持安定性を確認するものではない。

Core RSSの各turn＋0.2秒値による回帰傾きはturn 2〜10が2.842
MiB/turn、11〜20が0.655
MiB/turn。後半は緩やかだが正の傾きが残る。20ターン＋2秒→＋30秒でCore
RSS/PSSは17.65/17.63 MiB、TUIは5.62/5.74
MiB下がり、各contextのheapTotalも縮小した。自然GC/heap収縮と整合する観測だが、RSS残差の内訳や原因をこの測定だけで特定しない。

旧localhost測定は59,282
byteのreadを毎ターン、200turn×3、修正前sourceだった。今回は121
byteのread一回＋19会話、実provider、修正後sourceであり、**同じ負荷での改善比較には使えない**。20turn一回なので、長期頭打ち、再現幅、大きなtool
result負荷は未確認。

## 会話時間と照合

会話処理（TUI submit開始からsettled観測まで）の合計
**34.97秒**。20turn区間wallは
**44.73秒**、測定用の明示待機は起動/session/TUI各2秒＋各turn0.2秒＋5/10/20追加1.8秒＋最後28秒の計
**43.40秒**。driver全体は **79.35秒**。定期サンプリング、API観測、TUI
capture、export/shutdown等のoverheadは完全分離していない。

重いreadbackはsampling終了後。canonical 42messageについてcontent
byte長/SHA256と、全20入力・全20final answer・read引数と121
byte全文結果の保存/exportを照合した。同じSession/Worker、全20 canonical採用、21
request_start/response_start、HTTP 200、request failure 0。unique physical
request単位でusageを集約し、input 36,857 / output 1,371 / total 38,228
token。正常shutdown exit
0。一時credentialは削除し、保存run全fileをcredential値と照合して露出0。raw
request/response/SSEとAuthorization値は取得していない。

## 保存先

`.tools/increment-218-real-memory/`（git管理外）: `prepare.py` /
`make_driver.py` / `driver.py` / `analyze.py` /
`report.py`、`source-before-instrument.json` / `diagnostic-files.json` /
`manifest.json`、計測binary/build/version、`run.log`、`aggregate.json` /
`verification.json`。`run-1/`にはstop policy、result、RSS/PSS全sample、heap
snapshot、各turn/節目のstages、TUI captures、Core/TUI logs、SQLiteと3view
exportを保持する。`run-1`は一度だけ作成するdriverであり、再実行は追加の実provider利用となる。

報告書は本file。結果正本への入口は[Increment 218第11.15節](../increments/increment-218.md#1115-最新sourceの実provider20turnメモリ同時計測2026-10-09)。実DBコピー、常用配置、commit/push、product構想/architecture/roadmap変更は実施していない。
