# Increment 218 Agent Worker終了前後のメモリ測定（2026-10-09）

最新版commit `38eb2423`で、同じlocalhost負荷を**1ターンと200ターン、各一回**実行した。
どちらも最終会話後30秒待ち、Agent Workerだけを正常終了させ、さらに30秒待った。
Core RSSの減少は1ターンで**11.71 MiB**、200ターンで**82.04 MiB**。
PSSの減少はそれぞれ9.75 / 80.08 MiBだった。

## 終了前後の結果

単位MiB、各セルRSS / PSS。終了前は最終会話settled＋30秒、終了後はclose完了からの時間。

| ターン数 | 終了前（待機30秒） | Agent終了＋2秒 | Agent終了＋30秒 | 30秒後までの減少 |
| --- | --- | --- | --- | --- |
| 1 | 108.78 / 83.13 | 96.86 / 73.17 | 97.06 / 73.38 | 11.71 / 9.75 |
| 200 | 182.36 / 154.73 | 104.96 / 79.30 | 100.31 / 74.65 | 82.04 / 80.08 |

200ターンの解放量は1ターンよりRSS **70.33 MiB**、PSS **70.33 MiB**大きい。
初回起動だけで解放される量がある一方、長く利用したWorkerを終了すると追加で減る部分も観測された。
今回の単一ペアでは、これを厳密な固定費・累積量や恒常的なリーク量と断定しない。

Worker終了後も200ターン側は1ターン側よりRSS 3.25 MiB、
PSS 1.27 MiB高い。
このCore内の残差にはData/Core側の保持量やallocatorの履歴、自然GCの時機が含まれ得る。
Agent終了だけで全増分がなくなるわけではない。

![Agent終了前後のCore RSS/PSS](../../.tools/increment-218-agent-release-memory-20261009/agent-release.png)

## 条件と終了経路

毎ターン512行・59,282 byteの`probe.txt`をbundled readで全文読み、localhost Chat Completions SSE
providerがOKを返す2request/turn。inputは昨日の元Aおよび直前の最新版200ターン測定とbyte一致。
`local-memory / memory-model / effort none`、H=32,768、input=65,536、context=131,072、output reserve=65,536。
compiled production TUIをtmux 110×36で接続し、taskはlocalhost APIから投入した。
二つのrunはそれぞれ新しいCore/Session/Agent/隔離XDG・SQLiteで実行し、run内は同じSession/Agentを継続した。
実provider 0、強制GC・heap snapshot・profiler・新しい最適化なし。

診断endpointから既存の`ExecutionCoordinator.supervisor.close()`を呼び、通常のclose command →
runtime_stop → process cleanup → capsule terminateを完了させた。
ApplicationService.close、Data.closeSession、Core.shutdown、TUI切断は終了後30秒の観測が終わるまで行っていない。
Agent generation 1のみalive→terminated、Data/API generation 1・Core/TUIは同じPIDでaliveを確認した。
Worker終了後のheapを0として扱わず、terminatedとして記録した。

## 各contextのheap

単位MiB、heapUsed / heapTotal / external。RSS/PSSとheapは完全同時ではない。

### 1ターン

| context | 終了前 | Agent終了＋30秒 |
| --- | --- | --- |
| core-main | 5.68 / 6.50 / 1.40 | 5.84 / 6.50 / 1.40 |
| data-worker | 6.44 / 7.25 / 1.51 | 6.54 / 7.25 / 1.53 |
| api-worker | 3.56 / 4.25 / 0.53 | 3.58 / 4.25 / 0.53 |
| agent-worker | 5.94 / 9.50 / 1.41 | terminated |
| tui-main | 5.96 / 6.68 / 1.04 | 6.01 / 6.68 / 1.04 |

### 200ターン

| context | 終了前 | Agent終了＋30秒 |
| --- | --- | --- |
| core-main | 6.26 / 7.63 / 1.39 | 6.38 / 7.63 / 1.40 |
| data-worker | 7.67 / 9.38 / 1.51 | 7.93 / 9.63 / 1.62 |
| api-worker | 3.88 / 4.75 / 0.53 | 3.90 / 4.75 / 0.53 |
| agent-worker | 7.38 / 8.88 / 1.41 | terminated |
| tui-main | 6.80 / 8.43 / 0.97 | 6.89 / 8.43 / 0.98 |

TUIは別processとして接続を保持した。単位MiB、RSS / PSS。

| ターン | Agent終了前のTUI | Agent終了＋30秒のTUI |
| --- | --- | --- |
| 1 | 59.14 / 38.54 | 59.19 / 38.69 |
| 200 | 76.83 / 54.29 | 76.90 / 54.47 |

TUIの200ターン側と1ターン側の終了後RSS差は17.71 MiBで、Agentを終了してもこの差は残る。

Agent heapTotalとプロセスRSSの減少量は同じ指標ではない。
終了とともに解放されたプロセス内のnative/runtime/allocator側を含む量を測っており、
特定SDKやallocation元、Worker全体の専有RSSまでは特定していない。

## 保持件数、待機中の変動、mapping

- 1ターン: Data owners 1→1、owner executions 1→1、executionGenerations 1→1、Writer executionSessions 1→1。Agent本文保持committed/selectedは終了前0/0、Core active commands/executionsは0/0。prepared/配送残りは0。
- 200ターン: Data owners 1→1、owner executions 1→1、executionGenerations 1→1、Writer executionSessions 1→1。Agent本文保持committed/selectedは終了前0/0、Core active commands/executionsは0/0。prepared/配送残りは0。

各point直前5秒のsample範囲。待機中の自然回収を含むことを確認するための値。

| ターン | 直前5秒 | Core RSS範囲 | Core PSS範囲 |
| --- | --- | --- | --- |
| 1 | 終了前 | 108.78〜119.63 | 83.13〜94.08 |
| 1 | 終了＋30秒前 | 97.06〜97.06 | 73.38〜73.38 |
| 200 | 終了前 | 182.36〜182.36 | 154.73〜154.73 |
| 200 | 終了＋30秒前 | 100.31〜100.31 | 74.65〜74.65 |

1ターン側は終了前の最後5秒にも自然回収があり、固定費の厳密な推計には使わない。200ターン側は終了直前5秒にRSS/PSSの変動がなく、close＋2秒ですでにRSS 77.39 MiB減っていた。終了操作に対応する大きな減少は観測できるが、無操作で同じ60秒待つ対照runは今回実行していない。

外部から採取したsmapsのRSS分類（MiB）。mapping分類でありallocation元ではない。

| ターン | 時点 | anonymous | file | process_heap |
| --- | --- | --- | --- | --- |
| 1 | 終了前 | 45.82 | 59.52 | 3.52 |
| 1 | 終了＋30秒 | 36.11 | 57.52 | 3.40 |
| 200 | 終了前 | 118.95 | 59.49 | 4.05 |
| 200 | 終了＋30秒 | 39.13 | 57.49 | 3.64 |

## 停止上限、最大値、所要時間

各run開始前に有効空き量から停止上限を記録した。
Core＋TUI RSS合算、min(7 GiB, 有効空きの半分を256 MiB単位で切下げ)。
有効空きはMemAvailableと有限cgroup headroomの小さい方。共有pageはRSS合算で重複する。

| ターン | 有効空きMiB | 停止上限MiB | Core最大RSS/PSS | TUI最大RSS/PSS | 合算最大RSS | 会話処理秒 | 起動〜最終観測秒 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 11199.93 | 5376 | 128.03 / 102.48 | 64.04 / 43.53 | 192.06 | 0.18 | 66.76 |
| 200 | 11196.58 | 5376 | 331.18 / 303.56 | 93.35 / 70.93 | 424.53 | 30.31 | 149.62 |

停止上限に未到達、各Coreの正常shutdown exit 0。終了前後の待機はいずれも約30秒。

各contextの観測最大。Worker message/Core publication/TUI redraw境界とmilestoneで取得し、絶対瞬間最大ではない。

| ターン | context | heapUsed | heapTotal | external |
| --- | --- | --- | --- | --- |
| 1 | data-worker | 8.74 | 12.75 | 1.95 |
| 1 | api-worker | 4.88 | 6.50 | 0.68 |
| 1 | core-main | 7.42 | 9.00 | 1.48 |
| 1 | tui-main | 8.16 | 11.85 | 1.36 |
| 1 | agent-worker | 10.65 | 16.75 | 2.63 |
| 200 | data-worker | 40.70 | 71.63 | 9.85 |
| 200 | api-worker | 6.43 | 7.75 | 1.15 |
| 200 | core-main | 13.07 | 17.48 | 3.04 |
| 200 | tui-main | 16.02 | 24.18 | 3.10 |
| 200 | agent-worker | 38.12 | 71.45 | 5.75 |

RSS/PSSはsmaps_rollupを約20ms周期で採取した。

- 1ターン: 2,943 sample、間隔中央値22.71ms、最大32.65ms。
- 200ターン: 6,328 sample、間隔中央値23.48ms、最大50.19ms。

## 旧実装のAgent終了測定との関係

昨日の元A20ターンでAgentのみ終了すると、RSS 52.39〜56.04 MiB、PSS 50.44〜54.08 MiB減った。
今回は1ターンRSS 11.71 MiB、200ターンRSS 82.04 MiB。
最新版でもWorker終了で下がる部分は残るが、旧20ターンとはsource・turn数・保持方式・自然GCの状態が違う。
旧実装と同turn数で反復した対照実験ではないため、旧値との差を改善率とはしない。
旧実験の正本は `.tools/memory-core-followup-217-20261008/report.md` のAgent終了節。

## 検証と証跡

全201ターン/402 localhost requestが成功。canonical 804messageの全read本文/hash・全OK、
全requestのsource/window差分再構成・実wire/input hash/予算を照合した。
各runで一つのWorker generationを使用し、Agent closeによる追加provider requestはない。
終了前後のCore/Data/API/TUIの存続とAgent terminateを確認した。

- source: `38eb2423bed0506926c40fd3c7d94e35c8406ef5`、通常runtime/script等283fileをcommitとhash一致確認、測定後も変更なし。
- 診断差分: 隔離sourceの15file。前回の数値診断14file＋Agent close hook、production sourceへ反映なし。
- binary SHA256: `cd5a847240c68a0816de9e05492646fea8ba5505619fd7d11baa5b1fc520dbcf`。
- version: `henji 0.11.0 build=4e3f64123d1f45b191359e86742c8e72a9ccbbb45af452e215f57b551196df76 source=38eb2423bed0506926c40fd3c7d94e35c8406ef5+dirty deno=2.9.7 target=x86_64-unknown-linux-gnu runtime=6e56b8a2ac011285dd3793f60f7b784f198fe6968765ef0da8dd54c7db4e4f4b agent-config-schema=1 tool-api=henji-tool/v1 hook-api=henji-hooks/v2`。
- 証跡: `.tools/increment-218-agent-release-memory-20261009/` のmanifest、prepare/run/analyze、
  run-1/run-200（profile/stop-policy/samples/stages/smaps/agent-close/provider-facts/budget-facts/outcomes/DB）、
  aggregate、verification、contexts.csv、図PNG/SVG。
- profileの既存spikeから継承された予定turn数のラベルを測定後に1/200へ訂正し、profile-originalへ元の記載を残した。
  会話数・provider数はoutcomes/DB/実requestから確認した。

各条件一回で、自然GCやallocatorの変動、経過時間による回収を含む。
終了によって解放可能だった量の観測であり、Workerの専有メモリ全量や、定期Worker再起動の効果保証ではない。
実DB/常用binary/configを変更せず、追加最適化・commit/push/配置は行っていない。
