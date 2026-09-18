# Increment 74 — terminal出力の同期writeによる表示凍結の修正（TUI進捗）

ステータス: **実装完了（B1）。B2は別原因を特定、B3は該当Sessionの履歴が少なく再現せず**

基準commit: `3316fc07`

計画日: 2026-09-18

対象: TUIのbusy表示（`working`＋spinner＋経過時間）がturn中に凍結する事象（B1）を原因特定し、修正する。
原因は`v0/tui/terminal.ts`の`Deno.stdout.writeSync`によるfull-frame同期writeが、遅いterminal consumerで
main threadを塞ぐこと（調査メモ 追加計測6）。表示を非同期write＋coalescingへ変更する。あわせて`/sessions`
の`session list unavailable`（B2）とPageUpで履歴先頭へ到達できない（B3）を切り分けた。結果は末尾の
「B2/B3の切り分け結果」。観測は`docs/experience/normal-use-inbox.md`のB1〜B3。

用語注記: 本incrementの初版は「Host timer飢餓」と表現したが、計測5・6でtimerは稼働しており表示writeが
原因と判明したため、以降は「同期writeによる表示凍結」と読み替える。

## 利用者が必要とする動作

- turn中（model応答中・tool実行待ち）もbusy表示のspinnerと経過時間が更新される。
- `/sessions`で既存Sessionを一覧・選択できる（`session list unavailable`が出ない）。
- PageUpで履歴先頭まで遡れる。
- 上記は実経路（production TUI、実Session）で確認できる。

## 計画

### 原因特定（evidence-first）

- 実観測済み: busy timerはturn開始後約0.36秒で3回発火後に停止、`stopBusyElapsed`は未呼出、独立1000ms
  heartbeatもidleで21回・turn中4回で停止。よってrendererではなくHostのevent loop飢餓。
- 飢餓を起こす経路を特定する。候補と確認方法:
  - provider SSEの読み込み／parseがsynchronousに長時間回りmacrotaskを塞ぐ → streaming中のheartbeatとCPU、
    1 model requestのみのturnで再現するか。
  - Worker待ちの経路がbusy loopまたはmicrotask連鎖でmacrotaskを塞ぐ → tool待ちのみで再現するか、delegation
    待ちで再現するか。
  - render/terminal writeのbackpressure（同期write）→ 大frame時のstdout書込み。
  - 特定はinstrumentation（一時計測）と最小再現で行い、証拠を残す。
- B2/B3が同じ飢餓で説明できるか確認する。説明できない場合は別原因として切り分け、本incrementではB1の修正を
  行い、B2/B3は原因に応じて同一または別incrementへ。

### 修正

- 飢餓の原因に応じて、Hostのturn処理をmacrotaskを塞がない形へ直す（synchronous処理の分割、await境界の追加、
  同期write/backpressureの解消等）。renderer側の見かけの回避（timer以外での再描画）で塗りつぶさない。
- 修正後、busy timerがturn中も発火し、spinnerと経過時間が進むことを確認する。

### 履歴・sessions

- B2/B3がB1と共有原因なら同時に修正し、`/sessions`一覧とPageUp先頭到達を実経路で確認する。
- 別原因なら、原因、証拠、影響、修正案をinboxまたは本incrementへ記録し、勝手に広げず個別計画する。

## 対象外

- spinnerのframe集合・外観変更（Increment 73で確定）。
- 進捗率表示、toolごとの詳細進捗。
- 履歴/sessionsの新機能追加（検索・export改善等）。
- Worker protocol、Presentation contract、canonical transcriptの変更（原因特定の結果、必要なら別承認）。

## Verification

- focused test / 計測: turn中（model streamingとtool待ち）にbusy timerが継続発火すること、経過時間が進むこと。
- pty確認: production TUIで長めのtool（例: `sleep`）と長い応答中に`working`＋spinner＋経過時間が更新されること。
- B2/B3: `/sessions`で既存Session（`a75bd052`等）を一覧・選択できること、PageUpで履歴先頭へ到達できること。
  共有原因でない場合は、原因と証拠を記録し、本incrementの検証対象から分離する。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

原因特定、修正、回帰test、pty確認で**2〜5開発日相当**（原因により変動）。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. turn中のHost timer飢餓を原因特定し、macrotaskを塞ぐ経路を修正する（rendererの見かけの回避をしない）。
2. B2（`/sessions`）とB3（PageUp履歴）を同じ原因特定の中で切り分け、共有原因なら同時に修正する。
3. 別原因だった場合は、B1の修正を本incrementで行い、B2/B3は証拠を記録して個別に計画する。
4. architecture／roadmapの正本更新が必要になった場合は別承認。

## 調査メモ（2026-09-18時点、未完了）

- 再現（pty, source TUI, `deno task agent:tui`）: turn中は独立1000ms heartbeatが4回で停止、idleでは21回継続。
  busy timer（120ms）はturn開始後約0.36秒で3回発火後に停止。`stopBusyElapsed`／`cancelInterval`は呼ばれていない。
- CPU: tool待ち（`sleep`）を含むturn中もプロセスCPUはほぼ0（14秒で約0.3秒）で、spin loopではない（parked）。
- 分離実験: 素のDenoでmodule Worker（6秒sleep後にpostMessage）を動かすと、main threadのintervalはworker活動中も
  継続して発火した。**Worker待ち自体はmainのtimerを飢餓させない**（この経路は原因から除外）。
- まだ特定できていない: Henji Host側でturn中にmacrotaskを塞ぐ経路。候補は限られる。
  - terminal write/backpressure（同期write）: tool待ちで書込みが無い間も止まるため否定的だが未確認。
  - controller/`readEvents`の`Promise.race`と`sleep`は`setTimeout`ベースで飢餓要因ではなさそう。
  - presentation event処理がmicrotask連鎖を生み、macrotaskを継続的にstarveしている可能性（未確認）。
- 次アクション: `WorkerCapsule.enqueue`／presentation dispatch／`finishTurn`に計測を入れ、heartbeat停止区間で
  「Worker messageが流れているか」「Hostがどの処理に入っているか」を対応付ける。これでmicrotask starveか
  sync parkかを確定し、修正対象を決める。

### 追加の切り分け（2026-09-18）

- `eventSink`へ全presentation event、rendererへ独立500ms heartbeatを一時計測として入れて再現した。起動時は
  heartbeatが継続し、`EV turn_start`→`EV user_message`の直後に**1回だけ**heartbeatが出て以後停止した。
  Workerからの応答eventはまだ来ていない段階で既に停止している（＝model応答待ちの間にHostのtimerが止まる）。
- したがって飢餓はtool実行固有ではなく、turn dispatch直後から始まる。CPUはほぼ0でspinではない。
- 素のDeno module Worker（sleep後にpostMessage）ではmainのintervalは止まらなかったため、Worker待ち一般ではない。
- 原因候補は、turn dispatch後のHost側処理（`submitIntent`／presentation dispatch／`readEvents`の`Promise.race`
  周辺、またはその後のpark状態）に絞られる。次はこれらへ計測を入れ、どのawait/処理でmacrotaskが止まるかを
  特定する。

### 追加計測2（2026-09-18）

- `WorkerCapsule.onmessage`とcontroller `submitIntent`、renderer 300ms heartbeatを計測。順序は
  `SUBMIT-DISPATCH` → `WM runtime_event`×2 → `WM context_observation` → `WM provider_observation` → HB 1回 →
  停止。つまり**model request開始直後**（provider_observation到着後）にHostのtimerが止まり、以後Worker応答まで
  更新されない。
- `terminal.write`を`Deno.stdout.writeSync`から非同期`Deno.stdout.write`へ一時変更しても停止は再現（HBは
  provider_observation後に停止）。**同期stdout writeは原因ではない**。
- `stopBusyElapsed`／`cancelInterval`は呼ばれていない。CPUはほぼ0（parked）。
- 素のDeno Worker（sleep→postMessage）ではmain timerは止まらない。Worker+fetchの分離は環境設定ミスで
  未確定。
- 次の計測: `WorkerHostSession.receive`／`deliver`／`messages.publish`、および`submit`がprovider応答を
  awaitする経路に計測を入れ、provider_observation処理の直後にmainがどの同期処理／parkへ入るかを確定する。
  Worker内fetchの分離も再試行する。

### 追加計測3（2026-09-18）

- `receive`／`appendWorkerObservation`／`appendJournal`（SQLite書込み前後`JB`/`JA`）／`deliver`／`submit`と
  renderer 300ms heartbeatで計測。turn開始後は
  `SUBMIT-ENTER`→`RCV runtime_event`×2→`DELIVER turn_start`→`DELIVER user_message`→
  `RCV context_observation`→`RCV provider_observation`→`APPEND provider_observation`→`JB`→`JA`→`HB`1回→停止。
- SQLite journal append（`JB`→`JA`）は完了している。最後のprovider_observation処理後にHostは何もログせず、
  以後timerが止まる。**journal書込みは原因ではない**。
- 分離実験（正しく再実行）: mainがmodule Workerを起動し、Workerが`fetch`で6秒かかるlocal responseを取得する間、
  mainの500ms intervalは継続して発火（HB 17、RECV後も継続）。**Worker内fetch自体もmain timerを止めない**。
- 結論: 原因は「Worker fetch一般」「SQLite append」「stopBusyElapsed」「同期stdout write」のいずれでもない。
  残るのはHenji Host main isolate固有の、turn中にtimerだけが止まる経路。
- 次の計測: busy中にmain loopが入力に応答するか（keystroke処理）を確認し、main thread block か
  timer-specific starvation かを切り分ける。その後`controller.run`の`Promise.race([input, active])`、
  `readEvents`／`readChunk`、`TerminalLifecycle`、presentation `deliver`経路を計測する。

### 追加計測4（2026-09-18、入力応答性）

- 12秒の`bash sleep` turn中、フリーズ区間（dispatch後4秒）でCtrl-Cを送ると、**`cancelling`へ遷移する出力**
  （約22KB）が得られた。つまりフリーズ中もmain loopは入力eventを処理しており、**main threadはblockされていない**。
- したがって本件はthread全体のblockではなく、**timer（macrotask）だけがturn中に発火しない**現象である。
  入力（I/O event）は処理されるのにtimerが動かない。
- 残る焦点: Deno event loopでtimerがI/O処理に飢餓する理由。考えられる方向:
  - turn中にstream read/event処理がmacrotask queueを継続的に占有し、timer callbackが後回しになり続ける。
  - rendererの`setInterval` callbackが例外を投げて以降schedulerから外れる（ただしTICK計測では例外なし、HBも独立に停止）。
  - main isolateのtimer queueに問題を起こすHenji固有の何か（例: turn中だけ多数のI/O eventが連続する）。
- 次の計測: turn中に`setTimeout`の単発（例: 9秒後）を仕込み、turn終了前後で発火するかを確認する。また、busy中の
  input処理とtimerの比率を計測し、I/O eventがtimerを完全にstarveする条件を特定する。

### 追加計測5（2026-09-18、決定的）

- busy timer callbackの実行回数`__TICK`と独立intervalの実行回数`__HB`をグローバルカウンタで数え、9秒後の単発
  `setTimeout`でファイルへ保存した（console出力に依存しない）。
- 12秒の`bash sleep` turn中、9秒時点で`__TICK=40`、`__HB=29`。つまり**busy timer callbackも独立intervalも
  実行されている**。9秒の単発timerも発火した。
- 一方、`console.error`による`HB`／`TICK`出力はturn中に止まっていた。したがって「timerが止まる」のではなく、
  **turn中はconsole.error（stderr）出力が止まる／表示へ反映されない**。display更新の問題である。
- 再解釈: B1の症状（busy表示・経過時間・spinnerが更新されない）の原因はtimer飢餓ではなく、turn中に
  **terminalへのwrite（stdout/stderr）が表示へ反映されない経路**にある可能性が高い。次の計測は、
  `Deno.stdout.writeSync`の戻り／例外、`Deno.stderr`出力、TUIのframe書き込みがturn中にどうなるかを直接確認する。
- 前段の「heartbeatが3〜4回で停止」はconsole.error出力の停止を観測していたもので、timer停止の証拠ではなかった。
  計画の「timer飢餓」という表現はこの結果に合わせて修正が必要（表示/write経路の調査へ変更）。

### 追加計測6（2026-09-18、tmuxで再現）

- 直接pty（Python `pty.openpty`＋継続drain）では再現せず。**tmux 3.5a内**でinstalled binaryを起動し
  `tmux capture-pane`で`working MM:SS`を採取すると、同じ日本語promptのturnで更新gapが発生:
  **10.0秒（02:09→02:19）、5.1秒、3.6秒**等（150秒turn、135 updates）。
- 直接ptyではconsumerが継続drainするため`Deno.stdout.writeSync`がblockしないが、tmux（特にdetached paneで
  consumerが遅い）ではbaseline full-frame writeがbackpressureでblockし、event loop（redraw/timer/入力）が
  止まる、という説明と整合する。
- 結論（修正対象）: `v0/tui/terminal.ts`の`Deno.stdout.writeSync`によるfull-frame同期writeが、遅いterminal
  consumerでmain threadをblockしbusy表示が凍結する。**表示write経路（同期write/毎frame全書き）が原因**。
- 修正方針候補: redrawを非同期write＋coalescing（write中は次の最新frameだけ保持して古いframeを捨てる、
  または有界レート）にし、sync writeでevent loopをblockしない。順序と最終frame整合を保つ。
- 検証: tmux内で長時間turnのgapが消えること、直接ptyでも退行しないこと、frame順序が壊れないこと。

## 実装（2026-09-18）

- `v0/tui/terminal.ts`:
  - `CoalescingWriter`を追加。chunkをFIFOで1件ずつ非同期に書き、連続する未書込みのfull-frame
    （`\x1b[2J\x1b[H`始まり）は最新のみ残して置換する。flushは受付済みの全chunkを書き終えるまで解決する。
  - `DenoTerminal.write`を`Deno.stdout.writeSync`から`CoalescingWriter`（`Deno.stdout.write`）へ変更。
  - `TerminalPort.flush?(): Promise<void>`を追加し、`TerminalLifecycle.restoreOnce`が全write（exit sequence含む）
    後に`flush`をawaitする。`Deno.exit`はpending writeを待たないため、終了前に必ず配送する。
- 変更は`v0/tui/terminal.ts`のみ。renderer/controller/Worker protocolは変更しない。

## 検証（2026-09-18）

- focused test: `tests/v0/increment_74_terminal_write_test.ts`（5件、`v0:test`へ追加）。chunk順序、連続frameの
  coalescing、frame間control chunkの非coalescing、flush中の追加chunk drain、restoreのflush待ちを確認。
- 機構検証（backpressure）: masterをdrainしないptyへ2000 frameを書き、sync実装はevent loopがblockして
  4秒後の結果保存に到達せず（hung、結果なし）。非同期coalescing実装はtimerが継続し`ticks=39`で正常終了。
  同期writeがblock要因であることと、非同期化の効果を分離確認した。
- tmux検証（source TUI、隔離XDG、tmux 3.5a detached）: 長時間turn（busy 95秒）でbusy表示が継続更新、
  連続更新の最大wall gapは1.5秒（0.5秒間隔採取の粒度）。大出力turn（bash `seq 100000`＋`sleep 120`、
  frame上限近くまで成長）でも150秒間継続し最大gap 1.6秒。凍結なし。
- `v0:check`／`v0:fmt`／`v0:lint`／`git diff --check`、authoritative `v0:gate` exit 0。

## B2/B3の切り分け結果（2026-09-18、B1とは別原因）

- B2（`/sessions`の`session list unavailable`）: **原因を特定**。workspace `967fa641…`のstate DBで
  `listWorker()`が`SessionStoreError session_invalid`を返すため、`controller_overlay`の失敗handlerが
  `session list unavailable`を表示する。`listWorker`は`SELECT session_id FROM sessions`の各行を
  `readRecord`するが、1件の不正record（`6e8de261-31a7-4dae-81bf-a7024723aac0`）で例外が全体へ伝播する。
  `skippedInvalid`は`0`固定で、不正recordをskipする実装になっていない。実Session `a75bd052`は同DBに存在し
  正常に読める（24 message、2 turn）。B2はB1（write凍結）とは別原因。
  - 修正案（別increment）: `listWorker`をrecord単位でtry/catchし、読めないrecordをskipして
    `skippedInvalid`へ加算する。`/sessions`は残りの有効Sessionを一覧する。
- B3（PageUpで履歴先頭へ到達できない）: 対象Session `a75bd052`は2 turn・24 messageのみで、
  restored表示の上限（100 message／2 MiB）に達していない。表示上数画面で先頭に着くのは履歴量と整合し、
  B1/B2のような欠落の証拠は得られなかった。利用者情報（2026-09-18）では「再現したりしなかったりする」
  ＝間欠的で、再現には具体的条件（どの画面・key・履歴量・間欠の条件）が必要。B1とは別として個別に扱う。
  - ただし本incrementのHuman Gate項目3の記載どおり、B2/B3の修正は本incrementへ含めない。
