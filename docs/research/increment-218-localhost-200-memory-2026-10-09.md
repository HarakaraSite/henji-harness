# Increment 218 最新版のlocalhost 200ターンメモリ測定（2026-10-09）

コミット`38eb2423`の最新版で、同じCore・Session・Agent
Workerを**200ターン継続して一回測定**した。全200turn/400 localhost
requestが成功し、実provider callは0。毎turnのread結果59,282
byte全文と回答OK、canonical
800message、実入力/予算/証跡の全400requestを照合した。

Core RSS/PSSは20turn後 **252.22/224.11 MiB**、200turn後 **303.71/275.57
MiB**、最後の30秒待機後 **158.71/130.57 MiB**。待機後は20turn＋2秒より
**93.51/93.54
MiB低い**。連続処理中は後半にも増加があり、完全な頭打ちは確認できない。待機で大きく下がったことと、長期的な飽和の確認は分けて扱う。

## 昨日の条件の再利用

利用者の「実プロバイダを使わない200ターン」「昨日の測定に倣って」に基づく。2026-10-08の元A
200turn試行のinputをbyte単位で一致確認した。512行・59,282
byteのprobe.txtを各turnにbundled readで一度読み、localhost Chat Completions SSE
providerがOK（2
byte）を返す2request/turn。`local-memory / memory-model / effort none`。tmux
110×36でcompiled production TUIを接続し、taskはlocalhost APIから投入した。

同じSession/Core/Workerを途中で再起動せず、強制GC・heap
snapshot・profilerを使っていない。隔離HOME/XDG/workspace/schema3
SQLiteへ保存し、実credentialは使用していない。通常source・常用binary/config・実DBを変更せず、測定用の新しい最適化も加えていない。今回の200turnを再開20turnや追加runへ拡張していない。

昨日の元Aは履歴全文を持ち続け、88turn目の既存5 MiB
messages上限で止まった。今回は承認・実装済み218のbounded
contextを使う最新版であり、同じinput/tool/TUI負荷でも内部履歴の保持/選択は異なる。H=32,768、input=65,536、context=131,072、output
reserve=65,536は前回218のlocalhost測定と同じ。wire UTF-8
bytes/3＋framingは診断用推計で、実モデルの容量ではない。

## 停止上限、候補、観測方法

開始前の有効空き量 **11012.14 MiB** からCore＋TUI合算RSS停止上限を **5376 MiB**
に定め、開始前に記録した。式はmin(7 GiB, MemAvailableと有限cgroup
headroomの小さい方の半分を256 MiB単位で切下げ)。合算観測最大397.78
MiBで未到達。共有pageはRSS合算に重複計上される。

- source commit:
  `38eb2423bed0506926c40fd3c7d94e35c8406ef5`。診断前のruntime/script等283fileをHEADとhash照合し一致。
- 計測binary: `.tools/increment-218-local-memory-200-20261009/henji-memory`
- binary SHA256:
  `9e5ef0221ee889f54b300aa15827db6cf0e7b3e0cba9ce0718900f4182ad39b8`
- build ID: `08409d6d580ac31b44560f8a617526a8bbf0dd70c255a2a31b160df00720d981`
- embedded runtime SHA256:
  `c7773bcc76efac39c82e6c1e6a5b9e7792c4428055b1013f96958b4cd63a8c28`
- Deno 2.9.7、Linux
  x86_64。隔離sourceの診断差分14fileのみ。versionの`+dirty`は診断差分と別件の未commitメモを含むbuild表示で、測定の通常runtimeは上記commitと一致。

Core/TUIは別PIDで`smaps_rollup`を約20ms周期に読んだ。実測5,054
sample、周期中央値23.66ms、最大47.15ms。通常turnはsettled＋0.2秒、1/5/10/20/50/100/200は合計2秒、最後は同じCore/TUIを残してsettled＋30秒に採取した。Core/session/TUIの各ready後2秒も記録した。

各contextのheapUsed/heapTotal/externalと保持件数はmilestoneで採取した。Worker
message/Core publication/TUI
redraw境界で数値最大を保持する診断は前回218から再利用した。heap最大は観測境界の最大であり、絶対瞬間最大ではない。昨日のheap最大はmilestoneだけだったため、最大値の取得密度は異なる。RSS/PSSと各heapの採取は完全同時ではない。

## 固定費とRSS/PSS

単位MiB。Session前/初会話前にはAgentは未起動。初会話以降の増分にはAgentの遅延起動、adapter/通信初期化等も含まれる。TUI起動時には共有binary
pageのPSS配分が変わる。

| 時点                       | Core RSS | Core PSS | TUI RSS | TUI PSS |
| -------------------------- | -------: | -------: | ------: | ------: |
| Core起動後・Session前      |    84.88 |    78.78 |    0.00 |    0.00 |
| Session後・TUI前・初会話前 |    87.01 |    80.79 |    0.00 |    0.00 |
| Session＋TUI・初会話前     |    87.45 |    64.57 |   61.42 |   41.67 |
| 1ターン＋2秒               |   128.42 |   102.47 |   64.68 |   43.79 |
| 5ターン＋2秒               |   175.85 |   147.80 |   70.81 |   47.83 |
| 10ターン＋2秒              |   196.35 |   168.24 |   72.86 |   49.86 |
| 20ターン＋2秒              |   252.22 |   224.11 |   78.23 |   55.24 |
| 50ターン＋2秒              |   272.30 |   244.16 |   82.61 |   59.59 |
| 100ターン＋2秒             |   273.16 |   245.02 |   82.86 |   59.83 |
| 200ターン＋2秒             |   303.71 |   275.57 |   93.83 |   70.81 |
| 200ターン＋30秒待機        |   158.71 |   130.57 |   78.44 |   55.30 |

| 観測最大（会話＋最終待機） |   Core |   TUI |
| -------------------------- | -----: | ----: |
| RSS                        | 304.37 | 93.83 |
| PSS                        | 276.23 | 70.81 |
| kernel VmHWM               | 304.46 | 94.82 |

会話処理中だけのRSS/PSS最大も同じ値だった。個別の最大は同時刻とは限らない。

| 増分の基準         | Core RSS | Core PSS | TUI RSS | TUI PSS |
| ------------------ | -------: | -------: | ------: | ------: |
| 200＋2秒→＋30秒    |  -145.00 |  -145.00 |  -15.39 |  -15.51 |
| 20＋2秒→200＋30秒  |   -93.51 |   -93.54 |    0.20 |    0.05 |
| 初会話前→200＋30秒 |    71.27 |    66.01 |   17.02 |   13.62 |

20ターン＋30秒は今回採っていないため、20/200の同じ待機条件の比較ではない。初会話前からの増分は残るが、これを全て履歴の増加と見なさない。

## 各contextのheap

各欄は **heapUsed / heapTotal / external
MiB**。通常GCの影響を含み、heapUsedは生存objectだけの量ではない。

| 時点                       |            Core main |                 Data |                API |                Agent |                  TUI |
| -------------------------- | -------------------: | -------------------: | -----------------: | -------------------: | -------------------: |
| Core起動後・Session前      |   5.56 / 8.00 / 1.40 |   6.48 / 8.75 / 1.48 | 3.88 / 5.75 / 0.60 |                    — |                    — |
| Session後・TUI前・初会話前 |   5.99 / 8.00 / 1.41 |   7.04 / 9.50 / 1.58 | 3.98 / 6.00 / 0.60 |                    — |                    — |
| Session＋TUI・初会話前     |   6.10 / 8.00 / 1.42 |   7.14 / 9.50 / 1.58 | 4.66 / 6.50 / 0.61 |                    — |   7.00 / 9.10 / 1.05 |
| 1ターン＋2秒               |   6.12 / 8.50 / 1.42 |  7.75 / 12.75 / 1.61 | 4.58 / 7.00 / 0.69 |  9.35 / 17.25 / 1.79 |  7.64 / 11.60 / 1.24 |
| 5ターン＋2秒               |   6.42 / 9.25 / 1.45 |  8.86 / 19.00 / 1.64 | 4.98 / 6.00 / 0.87 | 11.48 / 41.75 / 2.36 |  6.75 / 11.60 / 1.50 |
| 10ターン＋2秒              |   7.21 / 9.50 / 1.52 | 12.87 / 33.00 / 3.11 | 4.41 / 5.25 / 0.62 | 13.10 / 43.75 / 2.44 |  7.56 / 11.85 / 1.19 |
| 20ターン＋2秒              |  7.92 / 11.00 / 1.62 | 20.97 / 45.75 / 5.07 | 4.65 / 5.25 / 0.71 | 33.63 / 69.45 / 5.57 | 10.16 / 15.10 / 1.78 |
| 50ターン＋2秒              |  7.89 / 11.75 / 1.79 | 21.40 / 51.38 / 4.99 | 5.24 / 6.50 / 0.87 | 36.25 / 71.45 / 5.61 | 10.32 / 17.60 / 1.46 |
| 100ターン＋2秒             |  9.49 / 12.25 / 2.20 |  9.13 / 50.88 / 1.59 | 5.15 / 7.00 / 0.74 | 17.65 / 70.48 / 2.95 | 10.04 / 18.18 / 1.67 |
| 200ターン＋2秒             | 12.72 / 17.23 / 3.02 | 16.62 / 66.13 / 3.83 | 6.13 / 6.75 / 1.07 | 36.46 / 71.83 / 5.58 | 15.63 / 24.43 / 2.88 |
| 200ターン＋30秒待機        |   6.24 / 7.63 / 1.39 |   7.66 / 9.13 / 1.51 | 3.88 / 4.75 / 0.53 |   7.38 / 8.63 / 1.41 |   6.81 / 8.43 / 0.97 |

| context      | 観測最大 heapUsed | heapTotal | external |
| ------------ | ----------------: | --------: | -------: |
| core-main    |             12.90 |     17.23 |     3.02 |
| data-worker  |             41.00 |     74.38 |    10.68 |
| api-worker   |              6.36 |      7.75 |     1.13 |
| agent-worker |             37.44 |     72.08 |     5.66 |
| tui-main     |             15.90 |     24.43 |     3.10 |

待機でData heapTotalは66.13→9.13 MiB、Agentは71.83→8.63
MiBへ下がり、RSSも大きく下がった。自然GC/heap収縮と整合するが、RSS残差の原因の特定や強制GC後の保持量測定は行っていない。

## 増加傾向と保持件数

各turn＋0.2秒の値をturn番号に回帰した傾き、MiB/turn。

| 区間    | Core RSS | Core PSS | TUI RSS | TUI PSS |
| ------- | -------: | -------: | ------: | ------: |
| 21-50   |   0.4167 |   0.4153 |  0.1627 |  0.1613 |
| 51-100  |   0.0306 |   0.0306 | -0.0003 | -0.0003 |
| 101-200 |   0.3494 |   0.3494 |  0.0332 |  0.0332 |
| 151-200 |   0.6925 |   0.6925 |  0.0197 |  0.0197 |

51〜100turnはほぼ横ばいだったが、後半に再び増加した。101〜200turnのRSS/PSS傾き0.3494
MiB/turnは、前回の初期判断線0.25を上回る。51〜100から151〜200へのpeak増分29.72
MiBは初期線64以下。今回は一回の観測であり、前回の3run中央値の受入判定を置き換えない。完全な頭打ちは未確認。

20/50/100/200後と最後の待機後で、Data ownerのexecution index、Data execution
generation index、Writer execution-to-Session indexは各1。Agent
committed/selected本文保持は0、prepared suffix/配送queueは0。Core completed
command ACKは200後32件/19,392 byte、active command/executionは0。

今回の大きなtool resultではpageのbyte境界が先に効き、Writer
pageは20〜200で9execution/54entity、body 54,558→54,720 byteだった。TUI
printedは27件、text 882→891
byte。待機でheap/RSSが下がる一方、これらの保持件数は変わらない。累積履歴の件数800messageは数値counterとSQLiteに残し、Agent本文全保持へ戻していない。

## 昨日の元Aとの比較

同じfile/read/OK/TUI条件、各turn＋2秒のCore値。昨日は88turn失敗で100/200/最終30秒は未取得。

| turn | 昨日Core RSS/PSS | 今回Core RSS/PSS |
| ---- | ---------------: | ---------------: |
| 20   |  308.73 / 280.46 |  252.22 / 224.11 |
| 50   |  550.88 / 522.57 |  272.30 / 244.16 |
| 100  |           未取得 |  273.16 / 245.02 |
| 200  |           未取得 |  303.71 / 275.57 |

同条件の20/50時点でメモリが低く、今回は200turnまで完了した。一回ずつ・別sourceの観測であり、個別修正の効果や再現幅を特定しない。別の前回218の200turn×3もP2修正前source・待機時点数の異なる測定で、今回の一回から変更ごとの因果を結論しない。

グラフ（各turn settled＋約0.2秒、最後の星印は＋30秒）:
[PNG](../../.tools/increment-218-local-memory-200-20261009/comparison.png) /
[SVG](../../.tools/increment-218-local-memory-200-20261009/comparison.svg)。昨日の証跡は
`.tools/memory-core-200turn-217-20261008/` に保持した。

## 処理時間と照合

会話処理合計 **30.63秒**、明示測定待機 **86.60秒**、driver開始から最終pointまで
**119.75秒**。最後のpointはsettled観測から30.000秒。待機はready三箇所各2秒＋200turn各0.2秒＋七milestoneの追加1.8秒＋最後28秒。その他の起動/TUI/観測・JSON保存等のoverheadは完全分離していない。

| 完了turn範囲 | 平均会話処理 ms/turn | 処理合計 秒 |
| ------------ | -------------------: | ----------: |
| 1-20         |               151.96 |        3.04 |
| 21-50        |               155.17 |        4.66 |
| 51-100       |               154.81 |        7.74 |
| 101-200      |               151.93 |       15.19 |
| 151-200      |               150.63 |        7.53 |

後半の処理時間の増大は観測されなかった。処理時間はtask
submit開始からsettled観測までで、API polling間隔も含む。

重い照合はsampling停止後。canonical
200turn/800messageの役割・全read全文/長さ/hash・全OK、全400requestのcanonical
source関係/全体位置/window
delta再構成・実wire/入力hashと予算を照合し成功。同じWorker
UUID一つ、全executionのmodelはlocal-memory、各2request、localhost受信400と一致するため実provider
0。正常shutdown exit 0、停止イベントなし。

## 保存先

`.tools/increment-218-local-memory-200-20261009/`（git管理外）: `prepare.py` /
`run.py` / `verify.py` / `analyze.py` / `plot.py` /
`report.py`、診断前/差分hash、manifest、binary/build/version、run/analysis
log、aggregate/verification、PNG/SVG。`run-1/`にはprofile/stop-policy、RSS/PSS全sample、heap/保持milestone、各turn
outcome/timing、localhost request fact、budget fact、Core/TUI
capture/log、SQLiteを保持した。新しいdirectoryで一回だけ実行し、既存成果物は上書きしない。

結果正本への入口は[Increment 218第11.17節](../increments/increment-218.md#1117-最新commitのlocalhost200turn再測定2026-10-09)。この追加測定で実provider、実DBコピー、常用配置、commit/push、構想/architecture/roadmap変更は行っていない。
