# Increment 132 — 通常実行中の逐次表示（S16）と長時間利用時の入力応答

状態: A・Bは実装・focused test・check／fmt／lint／`git diff --check`・M1／M2／M3-S確認済み（2026-09-26）。
要件Cは**未再現・未完了**（同一プロセス約3時間26分の計測でも数秒遅延なし）。
利用者指示で計測を終了した。A・Bの実装はIncrement 133の0.7.0公開に含まれ、binary配置・push済み。
新binaryでの実provider確認は未実施。配置・公開結果は[Increment 133](increment-133.md#commitpush常用binary配置)を参照。
このincrementは新規セッションで最初から進めた（別セッションの6ステップで止まった作業の継続ではない）。

## 必要なproduct動作と根拠

- 利用者目的（2026-09-26）: **通常実行のassistant本文やthinkingが生成に合わせて一行ずつ追える**。
  また**長時間利用でも入力とPageUp／PageDownが数秒遅れない**。
- 根拠（通常利用メモS16、2026-09-24観測）: 生成中の表示がまとまって現れ、進行を追いにくい。
  thinkingはproviderから断片を受け取ってもmodel step終了時にまとめて表示される。現行TUIは更新のたびに
  画面を再描画する。
- S16の範囲: 保存Session復元時の逐次再生は含めない。thinkingの途中表示と画面全体の描画方式は変更範囲が
  異なるため、必要な見え方を採用時に決める。
- 見え方の解釈（本incrementで採用）: live entry（`assistant~`／`thinking~`）が生成中のsnapshotで更新され、
  **少なくとも行単位で生成に追従して見える**こと。append-onlyな行streamへの描画方式変更は行わない
  （現行のlive entry更新・markdown折り返し表示を維持し、更新の追従性だけを変える）。描画方式自体の
  変更が必要になったら別incrementで扱う。
- 成功基準: 通常実行中に全文が行単位で見えること（先頭だけで凍結しない）、thinkingがrequest完了前に
  見えること、長時間利用で入力・PageUp／PageDownが数秒遅れないこと。
- 要件Cの受入証拠（利用者指定、2026-09-26）: **同一Henjiプロセスを長時間動かしたときの計測**だけを
  受入証拠とする。保存Sessionの再起動・restore後の応答速度はCの受入証拠にしない（利用者観測で遅延が
  再現しないため）。遅延が再現しない場合はCを「達成」と断定せず**未再現**と記録する。修正は測定根拠が
  得られた箇所だけに限る。

## 現行経路（調査済み事実。provider stream → TUI描画）

1. provider stream受信（Worker内model）
   - chat SSE（`opencode-go-chat`等）: `v0/agent/provider/openrouter_sse.ts`。text deltaは
     `assembly.textParts`へ蓄積し、`report(assembly.progressText)`（完全なprefix snapshot）を
     **1 content deltaにつき1回**呼ぶ（553〜574行。delta内の文字はprogressTextへ逐次蓄積）。
     progress bytesが`MAX_ASSISTANT_PROGRESS_TEXT_BYTES`（1 MiB）を超えると`liveFrozen`で以後のreportを
     停止。thinking deltaは`reportThinkingDelta({kind:'text'|'summary', text})`（451〜454行）。
   - Responses API（`opencode-go-responses`等）: `v0/agent/provider/openai_responses_model.ts`。
     `response.output_text.delta`ごとに`reportAssistantProgress(progress)`（359行）、reasoning delta
     ごとに`reportThinkingDelta`（364〜386行）。
2. `v0/agent/core/loop.ts`（`runAgentTurn`、model requestごと）
   - `reportAssistantProgress`（652〜677行）: snapshot検証（`isValidAssistantProgressSnapshot`、175行）。
     **`acceptedProgress >= 256`（`MAX_ASSISTANT_PROGRESS_UPDATES_PER_REQUEST`、50行）で以後のreportを
     全て捨て、live更新が凍結する**。受理ごとにsinkへ`assistant_progress` event＋
     `evidence.recordAssistantProgress`（provider observationとしてdurable記録）。
   - `reportThinkingDelta`（683〜686行）: `thinkingParts`へ蓄積するだけで、途中は表示されない。
     `assistant_thinking` eventは**model request終了時1回だけ**（`emitThinking`、633〜651行。成功=
     `complete:true`＋`readableThinkingFromState(providerState)`優先、失敗・取消=`complete:false`）。
3. Worker→Host（`v0/agent/worker/worker_runtime.ts` eventSink、1005〜1035行）
   - production port（`providerObservation`あり）では`assistant_progress`／`assistant_message`は
     runtime event channelへ出さず、evidence観測（`provider_observation`）が単一のdurable factとなる。
     `assistant_thinking`は`port.runtimeEvent`経由（`runtime_event` message）。
4. Host（`v0/agent/worker/worker_host_coordinator.ts` `receive`、385〜480行）
   - 全Worker messageは`journal.appendWorkerObservation`（`worker_host_journal.ts`。contract検証＋
     buffer、batch 256件／25 msでdurable append）を通る。`provider_observation`の
     `assistant_progress`をSurfaceへproject（479〜480行）、`runtime_event`のagent eventを`deliver`。
5. presentation（`v0/presentation/tui_presentation_adapter.ts`、147〜161行）
   - `assistant_progress`／`assistant_thinking`（`complete`付き）をそのまま`PresentationEvent`へ。
6. TUI state（`v0/tui/state.ts`）
   - `assistant_progress`（446行〜）: liveな`assistant~` entryをsnapshot textで置換、なければappend。
   - `assistant_thinking`（480行〜）: `thinking~`（`complete:false`）／`thinking>`（`complete:true`）の
     entryを**1 event = 1 entry**でappend（idは`turn-N:attempt-A:thinking:S`でevent間は同一）。
   - `appendEntry`／`replaceEntry`（262／284行）はentries全体をcopy（O(全entries)）。
   - 表示窓は`HISTORY_WINDOW_ENTRIES = 48`／`HISTORY_WINDOW_BYTES = 1 MiB`（205〜206行）。
7. TUI描画（`v0/tui/tui_renderer.ts`）
   - eventSink（328〜395行）はeventごとに同期`redraw()`。`redraw`（763〜774行）は`layoutUi`（可視窓のみ）
     →`renderFrame`（170〜215行。行ごとにcandidate文字列を組み直してbyte判定するループ）→
     `terminal.write`。`v0/tui/terminal.ts`の`CoalescingWriter`（increment 74）がfull frameをcoalesceし
     非同期write。
   - key入力も同期`redraw()`（`setEditor`等）。PageUp／PageDownは`scrollPage`（533行〜）で
     `layoutSnapshot`を複数回計算し、`pageHistoryWindow`（state.ts 238行〜）が48 entry窓を全entries上に移動。
8. 入力loop（`v0/tui/controller.ts` `run`、334〜395行）
   - stdin read promiseとturnを`Promise.race`し、`processIdle`／`processBusy`がrendererを同期操作。
     同一event loop上のため、処理系が飽和すれば入力dispatchはその分だけ遅れる。

### 密接な既存テスト

- `tests/v0/provider_stream_compatibility_test.ts`: SSE→generate契約。`reportAssistantProgress`の
  最終snapshotが全文（`progress.at(-1) === text`、300 KiB case）。
- `tests/v0/increment_120_thinking_history_test.ts`: `reportThinkingDelta`→`assistant_thinking`→
  durable history・restoreのthinking表示（取消時`complete:false`含む）。
- `tests/v0/tui_conversation_presentation_test.ts`、`tests/v0/tui_retained_terminal_test.ts`、
  `tests/v0/increment_74_terminal_write_test.ts`: TUI event→state→frame、write coalescing。
- `tests/v0/increment_84_assistant_layout_test.ts`: assistant/thinking本文のmarkdown折り返し表示。
- `tests/v0/increment_39_cancellation_settlement_test.ts`: progress reportと取消settle。
- `tests/v0/increment_13_timeout_footer_test.ts`: busy経過表示（redraw経路）。

## 観測できる現状（code fact。遅延原因は未断定）

- O1: assistant本文のlive更新はmodel requestごとに**最大256 reportで打ち切られ**、残りの出力は
  request終了時まで表示されない。reportはprovider content delta単位のため、打ち切りまでに表示される
  割合はproviderのdelta粒度に依存する（M2測定で定量。測定結果の節を参照）。これがS16の「まとまって
  現れる」の機構だが、実利用での見え方はM3-Sと利用者計測で確認する。
- O2: thinkingはprovider deltaを受けてもmodel request終了まで表示されない（loopが蓄積のみ）。
- O3: event・keystrokeごとにfull-frame redrawとentries全体のcopyが走る。表示窓は48 entry／1 MiBに
  限定されており、layout対象は窓内のみ。
- O4: 長時間利用での入力・PageUp／PageDown遅延の原因は**未測定**。窓内テキスト量、streaming event量、
  entries copy、frame encode、journal/観測経路のどの寄与かは測定で切り分ける。
- O5（利用者観測、2026-09-26）: **保存Sessionの再起動では遅延が再現せず、同一Henjiプロセスを長時間
  動かしたときにだけ遅くなる**。したがってrestored sessionはstreaming表示（要件A・B）の確認には使えるが、
  入力遅延（要件C）の受入証拠にはならない。この観測は「restore済みentries数・窓内テキスト量だけが単独の
  原因」とする説明を否定する（inference）。プロセス稼働時間とともに蓄積する要因の関与を示唆するが、
  具体的な原因は未特定。

## 未確認事項

- U1: 入力・PageUp／PageDownが数秒遅れる原因（M1〜M3-Cで切り分ける。測定なしに断定しない）。
  説明すべき観測はO5で、**同一プロセスの稼働時間蓄積で悪化し、再起動・restoreでは再現しない**こと。
  restore時のentries数では再現しないため、per-op costのentries数依存だけでは説明がつかない（inference）。
  プロセス内蓄積（in-memory成長、event backlog、timer/listener、GC圧等）の候補も測定で確認するまで
  原因としない。
- U2: thinking snapshotのlive event化によるsemantic履歴量の増分。A12（保存粒度）は未採用候補のままで、
  本incrementでは保存粒度の削減・変更を扱わない。現状`assistant_progress`もaccepted reportごとに
  durable観測が1件立つ設計で、thinking snapshotも同じpatternに揃える。
- U3: mock SSE providerによるtmux確認は、実providerのdelta粒度・速度・cadenceを完全には再現しない。
  長時間計測に用いたHenjiは変更前のinstalled binaryであり、新実装を実providerで確認した証拠にはならない。

## 測定計画（遅延原因は測定してから特定する）

- M1: TUI component単体のper-op測定。entries数（1千〜数万）・窓内テキスト量を変えて、
  `assistant_progress` event処理、keystroke（`setEditor`→redraw）、`scrollPage`の所要時間を測る。
- M2: SSE→loop経路のlive更新観測。長文responseでaccepted report数・snapshot長・打ち切りの有無を測る
  （O1の実測）。
- M3-S（streaming表示の確認。要件A・B）: 隔離XDG・tmuxでsource production TUIを操作し、mock SSE
  provider（localhost。実provider不使用）のstreamingでassistant本文・thinkingの行単位追従を目視・計測する。
  restored sessionはこの表示確認に使ってよい。
- M3-C（入力遅延の確認。要件C）: 受入証拠の条件は上記「要件Cの受入証拠」に従う。**同一Henjiプロセスを
  長時間維持したまま**、キー入力・PageUp／PageDown・出力到着をtimestamp付きで測る。利用者は新規Sessionと
  同一のtmuxクライアントを維持して4時間規模の計測を進行中で、その計測がCの受入証拠となる。側のprobeは
  同一process内でstreaming turnと定期的なキー／PageUp／出力到着probesを継続し、経過時間に対する応答時間を
  記録する（probe自体が短時間で終わるものは証拠にならない）。
- 記録: 測定値と条件はこの文書の「測定結果」へ記録する。利用者の長時間計測結果も同じ節へ記録する。

## 提供するproduct動作

- A: 通常実行中、assistant本文が生成に合わせて行単位で追える（request先頭だけでなく全文が追従する）。
- B: 通常実行中、thinkingが生成に合わせて行単位で追える。model request完了時に確定表示
  （`thinking>`）。保存Session復元は現状どおり確定thinkingを表示する（逐次再生なし。復元表示の重複も出さない）。
- C: 長時間利用でも入力・PageUp／PageDownが数秒遅れない。受入証拠・未再現時の扱いは上記「要件Cの
  受入証拠」に従う。

## 対象範囲

- `v0/agent/core/loop.ts`: progress reportの打ち切り方式（cadence coalescing）とthinkingのlive event化。
- `v0/tui/state.ts`: live thinking entryの置換更新、restore時のthinking重複排除。
- 測定で特定した遅延箇所の最小修正（対象は測定結果に基づいて決める）。
- 対応するfocused test、check・fmt・lint・`git diff --check`、隔離XDG・tmux実操作。

## 非対象

- 保存Session復元時の逐次再生（S16範囲外）。
- append-only行streamへの描画方式変更、画面全体の描画方式の再設計。
- semantic履歴の保存粒度変更（A9／A12）。
- 構想・architecture・roadmapの変更。意味変更が必要なら提案だけに留め、本incrementでは反映しない。

## 実装計画

1. `loop.ts`:
   - `reportAssistantProgress`の「256回で打ち切り」を、行完了＋最小間隔（partial lineは最大間隔）の
     **cadence coalescing**へ変更。全文が生成を通じて追従する。最終確定は既存の`assistant_message`
     （`settleAssistantEntry`）が担う。
   - `reportThinkingDelta`で蓄積しつつ、同cadenceで`assistant_thinking`（`complete:false`）snapshotを
     deliver。request終了の`emitThinking`（`complete:true`／`false`）は現状維持（確定textは
     `readableThinkingFromState`優先）。
2. `v0/tui/state.ts`: `assistant_thinking`をentry id（turn／attempt／modelStep）で置換更新する。
3. history restore: `readSessionHistory`由来のthinkingは(turn, modelStep)ごとの最終eventを採用し、
   現状の復元表示contract（1 step = 1 thinking entry、取消時`thinking~`）を維持する。
4. 測定（M1〜M3-C）で寄与が確認できた遅延hotspotだけを最小修正する。測定根拠のない修正はしない。
5. focused test追加→check／fmt／lint／`git diff --check`→隔離XDG・tmux実操作→結果を本文書へ記録。

## test計画（対応するproduct動作）

- A: loopにfake modelで長いtext streamを流し、accepted progress snapshotが全文を生成中にカバーする
  （先頭のみで止まらない）。SSE側の最終snapshot全文契約（provider_stream_compatibility）は維持。
- B: thinking deltaが`complete:false`のlive eventとして途中まで届き、request完了で`complete:true`の
  確定eventになる。TUI stateで同じstepのthinkingが1 entryに置換される。restoreでは1 step =
  1 entry（取消時は`thinking~`）。
- C: 遅延修正を入れた箇所だけ、測定ベースの確認（M1相当のper-op計測、M3-Cの同一プロセス計測）を行う。
  Cの受入は「要件Cの受入証拠」に従う。test件数は成果の記録であり完了条件にしない。

## 測定結果

### M2（2026-09-26、`scripts/benchmark_streaming_display.ts m2`、実SSE parse→loop、wall clock）

- 判明（transport契約の訂正）: chat SSEの`report`は**1 content deltaにつき1回**であり、文字単位ではない
  （delta内文字はprogressTextへ蓄積）。したがって旧ルール（requestあたりaccepted report 256で打ち切り）の
  下でlive更新が止まる位置は、providerのdelta粒度に依存する。
- Case A（line粒度delta 37 chars／50 ms間隔、1,110 chars、30 deltas）:
  transport reports=30、新実装accepted snapshots=15（cadence coalescing）、最終snapshot coverage **96.7%**、
  残りは`assistant_message`で確定。旧ルールは256未満のためこのcaseでは打ち切りなし。
- Case B（token粒度delta 3 chars／10 ms間隔、1,110 chars、370 deltas）:
  transport reports=370、accepted snapshots=31、最終snapshot coverage **100%**。
  **旧ルールではreport 256でlive更新が凍結しcoverage 69.2%**で停止（残り31%はrequest終了まで非表示）。
- 結論（測定事実）: 新実装は生成全文へ追従し、event数はreport数より少ない（coalescing）。旧256 cutoffは
  fine-grained delta streamで途中凍結を起こす。実providerでのdelta粒度と見え方はM3-Sと利用者計測。

### M1（2026-09-26、`scripts/benchmark_streaming_display.ts m1`、TuiRenderer＋markdown renderer、
120×40、stub terminal write、per-op wall time平均）

| 条件 | assistant_progress event | keystroke（setEditor+redraw） | scroll up+down 往復 |
| --- | --- | --- | --- |
| entries 1,000（小entry） | 4.2 ms | 3.6 ms | 13.9 ms |
| entries 10,000（小entry） | 5.3 ms | 3.8 ms | 15.5 ms |
| entries 30,000（小entry） | 6.3 ms | 4.1 ms | 16.6 ms |
| entries 1,000＋窓内fat 48×8 KiB（≒384 KiB） | 150 ms | 149 ms | 596 ms（1 press ≒ 300 ms） |

- live text成長（entries 1,000、redraw 1回）: 1 KiB→4.8 ms、10 KiB→6.9 ms、50 KiB→25.5 ms、
  100 KiB→51 ms。
- 測定事実: per-op costは**entries数ではほぼ変わらず、窓内テキスト量に比例**する（unchanged entryを含む
  窓全体のmarkdown re-renderが毎frame走る）。streaming中にevent処理×このcostが飽和すれば、input
  dispatchはqueued eventの後ろに回り遅延する（旧実装は最大256 event/requestをこのcostで処理していた）。
- ただし**「同一プロセス長時間でだけ再現し、restore後は再現しない」というCの観測（O5）はこれでは
  説明しきれない**（fat窓はrestore後にも存在しうる）。M1はper-op costの地図であり、Cの受入証拠ではない。
  Cは未再現として扱い、原因はM3-Cと利用者計測で追う。

### M3-S（2026-09-26、隔離XDG `/tmp/henji-i132-tui`・tmux 94×48・source production TUI・mock SSE
provider `127.0.0.1:8877`（thinking 8行＋answer 24行、各250 ms間隔。実provider不使用）

- live追従（要件A・Bの実経路確認）: 0.5秒間隔captureで、`thinking~ thinking line 01`から
  02〜08まで行単位で追加表示。thinking完了後`assistant~ answer line 01`が現れ、02〜24まで
  行単位で追加表示。いずれも途中frameで中間行（例: line 05→06→07）が観測でき、先頭凍結なし。
- 確定後の非重複: 各turnは`thinking>`（8行）1ブロック＋`assistant>`（24行）1ブロック。
  `thinking~`／`assistant~`の残存なし、live snapshot由来の重複entryなし。
- restore後の非重複: 同一Session（`8e0d19d0-…`）を`--session`で再起動し、復元logが
  6 records（user 2＋thinking 2＋assistant 2）＝1 step=1 thinking entryを確認。
  復元表示にlive snapshotの重複なし（逐次再生なし）。restore後のfollow-up turnでも
  live追従と確定後の非重複を確認。
- 注記: mock providerのdelta粒度・cadenceは実providerの再現ではない（U3）。実providerでの見え方は
  利用者の通常利用と長時間計測で確認する。

### M3-C（要件C。2026-09-26終了時点: **未再現・未完了**）

- 本increment側の短時間probes（M1・M3-Sのtmux操作）では入力・PageUp／PageDownの数秒遅延は再現せず、
  per-op測定（M1）にも同一プロセス稼働時間に比例する寄与は観測していない。
- 新規Session `ea2ca0e4-1607-412b-9de4-11043711e00f`を変更前のinstalled binaryで開始し、
  **同一Henjiプロセス（PID 179485）を約3時間26分維持**した。途中のmodel実行失敗・取消の後も
  Session／プロセスを再起動していない。擬似端末のtmux clientを接続した定期的なPageUp／PageDown
  720操作（2026-09-25 21:28〜26日00:20 UTC）は、client出力到着が中央値27.81 ms、最大58.34 ms、
  pane更新が中央値30.61 ms、最大63.43 ms。文字入力20操作（22:14 UTC）のclient出力到着は
  中央値16.06 ms、最大18.99 msだった。記録は`/tmp/henji-latency-y9w3rlpl/`に残した。
- その後、同じプロセスに利用者の**実端末client**を接続して入力とPageUp／PageDownを操作した。
  利用者報告では数秒遅延は起きなかった。pane出力時刻の収集は行ったが、物理キー押下時刻との
  対応付けはできていないため、この実端末試行の数値latencyは算出しない。
- 元の遅延は約4時間25分の旧セッションで観測された。本計測は約3時間26分で利用者指示により終了した。
  **再現しないためCは「達成」と断定せず未再現・未完了と記録する。**
- 測定根拠のある遅延箇所は得られていないため、遅延を目的とした修正は今回入れていない
  （M1で判明した窓内テキスト量比例のper-op costは、O5の再現条件と整合しないため原因としない）。

## 実装結果（2026-09-26）

- `v0/agent/core/loop.ts`: progress reportの「256 acceptedで打ち切り」を廃止し、行完了＋最小間隔
  100 ms（部分行は最大間隔500 ms）のcadence coalescingへ変更。`reportThinkingDelta`でthinking snapshot
  （`complete:false`）を同cadenceでlive deliver。request終了の`emitThinking`は確定eventとして維持し、
  末尾のlive snapshotと完全に同一のincomplete settleは重複deliverしない（fact追加なし）。
  時刻は`AgentTurnOptions.now`で注入可能（test用seam、既定はwall clock）。
  live snapshotの全文検証・thinking断片のjoinはcadenceでdeliverするときに限った。1 KiB×1,024個の
  thinking deltaを流す局所測定では修正前約1,029 msから修正後34 msとなり、同一event loopの入力処理を
  妨げる新たなhotspotを避けた。修正後のcheck・focused test（Increment 132／120）・lint・
  `git diff --check`は通過した。
- `v0/tui/state.ts`: `assistant_thinking`をentry id（turn／attempt／modelStep）で**置換更新**（1 step =
  1 entry、途中は`thinking~`、確定で`thinking>`）。
- `v0/agent/history/sqlite_history_v7_production_store.ts` `readSessionHistory`: thinkingは(step)ごとに
  最終snapshotを採用（逐次再生なし。durable semantic履歴自体は全eventを保持）。
- focused test `tests/v0/increment_132_streaming_display_test.ts` 5件（A: 行cadence全文追従・部分行
  fallback、B: thinking live→確定、TUI 1 step=1 entry、human timeline 1 step=1 entry）。
  task `agent:increment-132-streaming-display:test`を`deno.v0.json`へ追加（v0:test chainにも登録）。
  測定probe `scripts/benchmark_streaming_display.ts`（task `agent:increment-132-measure`）。
- regression: increment-120（thinking履歴・restore、event stream契約の変更に合わせてassertion更新、
  5件通過）、provider_stream_compatibility（20件）、tui系＋increment-84（111件）、current_code＋
  tui_conversation（41件）、increment-39（4件）、increment-129（2件）、increment-13（5件）通過。
- 品質確認: `v0:check`・`v0:fmt`・`v0:lint`・`git diff --check`すべて通過（2026-09-26）。
- tmux実操作: M3-Sのとおり隔離XDG・mock SSE providerでlive追従・確定後の非重複・restore後の非重複を確認。
- 通常利用メモ: S16はこのincrementへ採用済みのため、inboxの候補一覧・S16節を削除し、正本をこの文書へ移した
  （AGENTS.md「個別Incrementへ採用した項目はその正本へ移し、この一覧から除く」に従う）。
- 未了: 要件Cの再現・原因特定、新binaryの実provider確認。
- 後続の配置・公開: 実装commit `2b162bff`はIncrement 133のrelease source `f10893ba`に含まれる。
  0.7.0として常用binaryへ配置し、push・JSR公開済み。詳細は
  [Increment 133の配置・公開結果](increment-133.md#commitpush常用binary配置)を参照。
  この配置・公開を要件Cの完了または実provider確認の代替とはしない。
