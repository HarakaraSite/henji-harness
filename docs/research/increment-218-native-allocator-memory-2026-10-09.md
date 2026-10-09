# Increment 218 native allocator統計・trim・割当/解放stack測定（2026-10-09）

利用者の「ではその順番で計測して」に基づき、(1) native
allocatorの使用中/空き領域、 (2) Agentを残した`malloc_trim(0)`、(3) 残ったnative
allocationの割当/解放stackの順で調査した。

**Workerを終了せずにCore RSS/PSSが95.43 MiB減った。**
この間、nativeの使用中量は約14
MiBのままで、Agentのheapと履歴保持/各contextの存続も維持された。 前回82.04
MiBの大きな終了時減少を、すべて「生きたAgent専有オブジェクト」と解釈する根拠はない。
今回の介入は、**解放済みだがallocatorがresident
pageを保持していた部分**が大きいことを確認した。
前回の二つの匿名mappingで約70.79
MiB減った観測と整合する。ただし別runなので、前回82.04 MiBの全byteを
今回の内訳に直接置き換えない。

trim後にAgentを終了するとさらにCore RSS 21.75 MiB / PSS 19.79
MiB減り、glibcの使用中量は3.77 MiB減った。 この小さいnative
live部分を、独立したstack付きrunでDeno source map、V8 string
table/isolate、console
metadata等へ帰属した。終了後の区間には他のcontextの自然回収も含み、全freeをAgent専有量とは扱わない。

## 1・2: プロファイラなしの結果

単位MiB。Core列はRSS / PSS。glibc統計はprocess全体で、Worker別RSSやV8 JS
heapではない。

| 時点                  | Core RSS/PSS    | 使用中 uordblks | 空き fordblks | arena合計 | 独立mmap hblkhd |
| --------------------- | --------------- | --------------- | ------------- | --------- | --------------- |
| 200ターン＋30秒       | 220.98 / 192.33 | 14.05           | 112.59        | 126.64    | 1.59            |
| Agent存続・trim＋2秒  | 125.36 / 96.72  | 14.00           | 112.17        | 126.17    | 1.59            |
| Agent存続・trim＋30秒 | 125.55 / 96.91  | 14.07           | 112.10        | 126.17    | 1.59            |
| Agent終了＋2秒        | 108.44 / 81.76  | 10.66           | 115.51        | 126.17    | 1.59            |
| Agent終了＋30秒       | 103.80 / 77.12  | 10.30           | 115.87        | 126.17    | 1.59            |

`malloc_trim`は6msで返り値1（ページ返却あり）。使用中量はtrim前後で約0.02
MiB増えた程度で、 約95 MiBのRSS減少を使用中allocationの解放で説明できない。
`fordblks`や`arena`が大きく残っていてもRSSは下がる。これらはallocatorのbyte
accountingであり、 現在residentな物理ページ量ではない。

![RSSとallocator accountingの比較](../../.tools/increment-218-native-memory-20261009/native-trim.png)

Agent generation 1はtrim＋2秒/30秒でalive、Agent close後のみterminated。
Core/Data/API/TUIは同じPID・generationでalive。Data owners/owner
executions/executionGenerations、 Writer
executionSessionsは各1を維持し、prepared/配送残り0。Agentのsettled時本文保持は0。
ApplicationService.close、Data.closeSession、Core.shutdown、TUI切断は最後の観測後に実施した。
強制V8 GCは行っていない。

## 3: 残ったnative allocationの割当/解放stack

Coreにのみheaptrack
1.5.0を起動時からpreloadし、同じ200ターン負荷を別runで実行した。
同じtrim→30秒→Agent正常終了→30秒を行い、終了直前のallocation
cohortがどう解放されたかを照合した。 heaptrackは割当stackとfree
pointerを記録する。解放側の呼出しstackは、既存allocatorへそのままforwardする
小さいC補助をpreloadし、Agent終了直前〜終了30秒後の`free`だけをbacktraceした。
空き領域のページ返却を、malloc allocationのfreeと同じものとして扱わない。

初回stack runの解放backtraceは補助の`free`一段で止まった。共有ライブラリにunwind
headerを付ける
`--eh-frame-hdr`を加え、別の`deno --version`確認で呼出し元まで採取できることを確認後、
**stack計測だけ200ターンを一回再実行**した。初回結果とrawは保全した。
効果量には最初のプロファイラなしrunを使用し、以下の割当/解放帰属は修正後のstack
runを使用する。

malloc-familyの実requested live量は終了直前 **14.16 MiB**。
その時点で生きていたcohortのうち、close＋1秒までに **3.45 MiB**、
close＋29秒までに **3.55 MiB**が解放され、 10.62
MiBがCore/Data/API等の生きたprocessに残った。 解放cohortとfree
stackのpointer照合量は **3.55 MiB**。

終了とその後の待機で解放されたcohortの主な**割当側stack**。同じ用途でも別stackは別行。top10であり総量ではない。

| 割当経路                                                | 解放されたMiB | allocation数 |
| ------------------------------------------------------- | ------------- | ------------ |
| Deno source map decode/cache                            | 0.994         | 33           |
| V8 console message metadata                             | 0.329         | 344          |
| V8 internalized string table                            | 0.250         | 1            |
| V8 isolate初期化                                        | 0.117         | 1            |
| V8 isolate初期化                                        | 0.117         | 1            |
| V8 isolate初期化                                        | 0.117         | 1            |
| <deno_core::runtime::jsruntime::JsRuntime>::new_inner   | 0.111         | 1            |
| Deno extension OpDecl vector                            | 0.108         | 32           |
| V8 console message metadata                             | 0.071         | 344          |
| v8::internal::Isolate::New(v8::internal::IsolateGroup*) | 0.069         | 1            |

同じcohortに対応する主な**解放側stack**。完全なsymbol列はstack-analysis.jsonを参照。

| 解放経路                                                                                 | 対応MiB | free数 |
| ---------------------------------------------------------------------------------------- | ------- | ------ |
| SourceMap drop                                                                           | 1.057   | 35     |
| V8ConsoleMessage deque clear                                                             | 0.382   | 400    |
| StringTable destructor                                                                   | 0.250   | 1      |
| <alloc::rc::Rc<deno_core::runtime::jsrealm::ContextState>>::drop_slow                    | 0.130   | 104    |
| v8::internal::Isolate::~Isolate()                                                        | 0.117   | 1      |
| v8::internal::Isolate::~Isolate()                                                        | 0.117   | 1      |
| v8::internal::Isolate::~Isolate()                                                        | 0.117   | 1      |
| <alloc::rc::Rc<deno_core::runtime::jsrealm::ContextState>>::drop_slow                    | 0.111   | 1      |
| v8::internal::MemoryPool::PoolImpl<v8::internal::PooledPage>::ReleaseUpTo(unsigned long) | 0.097   | 23     |
| V8ConsoleMessage deque clear                                                             | 0.082   | 400    |

解放側は最初の呼出し元までsymbol化した。compiled Denoでbacktraceが2〜5
frameで止まる経路もあり、すべての深い呼出し階層を復元できたわけではない。割当側の長いstackとpointerを対応させて用途を判断する。

Deno source map/loaded moduleに関する保持と、V8 isolateに属するnative
metadataは、 Worker
lifetimeに対応する保持として観測された。これを会話履歴の全文保持やリークと呼ばない。
V8 console
message側には今回追加した`context.budget`等の診断ログの影響が含まれ得るため、
通常実装だけの不要メモリ量とは扱わない。

全malloc-family割当イベント67,576,494、freeイベント67,568,526、 累積requested
allocation 22578.94 MiB、観測tracked live peak 109.66 MiB。
累積量は短命allocationの繰返しを含み、待機後のlive量やRSSではない。

## 各contextのheapと最大値

プロファイラなしrun。単位MiB、heapUsed / heapTotal / external。

| context      | trim前             | Agent存続・trim＋30秒 | Agent終了＋30秒    |
| ------------ | ------------------ | --------------------- | ------------------ |
| core-main    | 6.29 / 7.13 / 1.39 | 6.40 / 7.13 / 1.40    | 6.52 / 7.13 / 1.40 |
| data-worker  | 7.67 / 9.13 / 1.52 | 7.93 / 9.38 / 1.62    | 8.17 / 9.38 / 1.72 |
| api-worker   | 3.89 / 4.75 / 0.53 | 3.91 / 4.75 / 0.53    | 3.92 / 4.75 / 0.53 |
| agent-worker | 7.36 / 9.13 / 1.41 | 7.38 / 9.13 / 1.41    | terminated         |
| tui-main     | 7.14 / 8.43 / 0.98 | 6.89 / 8.43 / 0.98    | 6.93 / 8.43 / 0.98 |

各run開始前に有効空き量から停止上限を定めた。Core＋TUI RSS合算、min(7 GiB,
有効空き半分を256 MiB単位で切下げ)。有効空きはMemAvailableと有限cgroup
headroomの小さい方。単位MiB、時間は秒。

| run           | 有効空き | 停止上限 | Core最大RSS/PSS | TUI最大RSS/PSS | 合算最大RSS | 会話処理秒 | 起動〜最終観測秒 |
| ------------- | -------- | -------- | --------------- | -------------- | ----------- | ---------- | ---------------- |
| native        | 12039.05 | 5888     | 357.55 / 328.91 | 94.07 / 70.53  | 451.17      | 30.45      | 180.13           |
| stack         | 11967.88 | 5888     | 446.85 / 417.93 | 92.88 / 70.28  | 531.55      | 125.41     | 275.86           |
| stack-recheck | 13490.25 | 6656     | 447.33 / 418.75 | 95.21 / 72.91  | 529.31      | 125.76     | 276.27           |

全runとも上限未到達、正常shutdown exit 0。初回stack runはfree
stackの取得不備があり、割当証跡と会話結果を保全した。profilingのmemory/timing
overheadをnative runの改善量へ合算しない。

プロファイラなしrunの各context観測最大（MiB）。Worker message/Core
publication/TUI redrawとmilestoneの境界最大で、絶対瞬間最大ではない。

| context      | heapUsed | heapTotal | external |
| ------------ | -------- | --------- | -------- |
| data-worker  | 35.60    | 57.13     | 7.38     |
| api-worker   | 6.23     | 8.00      | 1.14     |
| core-main    | 12.91    | 17.73     | 3.02     |
| tui-main     | 15.92    | 24.68     | 3.05     |
| agent-worker | 39.68    | 72.94     | 5.81     |

RSS/PSSは外部smaps_rollupを約20ms周期で採取した。

- native: 7,426 sample、周期中央値23.96ms、最大52.38ms。
- stack: 11,419 sample、周期中央値24.17ms、最大94.13ms。
- stack-recheck: 11,305 sample、周期中央値24.38ms、最大78.08ms。

## 条件・照合・証跡

最新版commit `38eb2423`、Deno 2.9.7、glibc 2.41、Linux x86_64。 512行・59,282
byteのfile全文を各turnに一回read、localhost Chat Completions
SSEがOKを返す2request/turn。
inputは前回/昨日の元Aとbyte一致。`local-memory / memory-model / effort none`、H=32,768、input=65,536、
context=131,072、output reserve=65,536。compiled production TUIをtmux
110×36で接続しtaskはlocalhost APIから投入した。
各runは新しい隔離Core/Session/XDG/SQLite、run内は同じAgent Worker。実provider
0。

3run、**600ターン/1,200 localhost request**を完了し、canonical
2,400messageのread全文/hash・全OKと、
全requestのsource/window再構成・実wire/input
hash/予算を照合した。全runの通常runtime/script等283fileはcommitと
hash一致し、測定後も変更なし。隔離診断16file（数値/close/native統計の診断＋compileのlibc限定FFI許可）のみ。

- source: `38eb2423bed0506926c40fd3c7d94e35c8406ef5`。
- binary SHA256:
  `86e456009a8b129123d6dc9812b1da12d72ccdd9808aaed3c6766607a7d86ec4`。
- version:
  `henji 0.11.0 build=b4a85c7f1eaeabe932585bae40cfb16d7357376a4b825bffbd8050968cdb944c source=38eb2423bed0506926c40fd3c7d94e35c8406ef5+dirty deno=2.9.7 target=x86_64-unknown-linux-gnu runtime=9dd76cecad2b0582f836d22aabcca1b1c174a9ff92c289daea083a9cc3a76376 agent-config-schema=1 tool-api=henji-tool/v1 hook-api=henji-hooks/v2`。
- raw/artifacts: `.tools/increment-218-native-memory-20261009/`。
- `run-native-200`:
  profilerなしのsamples/stages/smaps/native-trim/stop-policy、各context、provider/budget/outcomes/SQLite。
- `run-stack-200`:
  初回stack試行のrawとfree一段のbacktrace。`stack-analysis-initial.json/log`へ解析結果を保全。
- `run-stack-recheck-200`: unwind修正後のraw
  malloc/free、free-trace、markers/clock、同じ会話/メモリ証跡。
- `stack-analysis.json/log`: 修正後runのlive
  cohort、割当/解放symbol列とpointer照合。時刻原点はprocess startを基準とし、
  rawの約10ms刻みと原点の約100ms不確実性を明示した。終了前−100ms/終了後＋1秒/＋29秒のplateauを使用した。
- `profiler/`: Debian
  packageをlocalに展開したheaptrack/compiler/binutilsとC補助source/binary、準備ログ。
  systemへのpackage installや常用プロセスへのattachは行っていない。
- `aggregate.json / verification.json / contexts.csv / manifest.json`、図PNG/SVG、prepare/run/analyze/stack_analyze/write_report。

## 結論の限界と次の判断

一回のnative runで介入の効果を確認し、独立したprofiling runでnative
liveの用途を観測した。 プロファイラ自身の内部allocation、V8の直接mmap、allocator
metadata/padding、kernel residencyは heaptrackのmalloc
requested-byte集計と同一ではない。`mallinfo2`の使用中量、V8
heap/external、RSSを単純加算しない。 stack
runの`mallinfo2`使用中量はプロファイラ内部allocationも含み、終了前に約76〜78
MiBまで増えた。 heaptrackが追跡したapplication requested live量の約14
MiBや、プロファイラなしrunの約14 MiBと混同しない。 source
map/console/isolate等のnative内訳はこの診断binaryに対応する。

前回82.04
MiBのexactなallocation履歴は遡って復元できない。今回の結果は、主要な増分がresidentな
allocator
free領域として解放可能であることを支持する。同時に、Worker終了まで生きる小さいnative
metadataもある。
allocatorのページ返却を通常実行へ組み込む変更や、保持方式・Worker再起動方針の変更は今回は実装していない。
実DB/常用binary/config/product正本を変更せず、commit/push/配置は行っていない。
