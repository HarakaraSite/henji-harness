# Increment 74 — Host timer飢餓の原因特定と修正（TUI進捗・履歴・sessions）

ステータス: **計画中（Human Gate未承認。実装未着手）**

基準commit: `3316fc07`

計画日: 2026-09-18

対象: turn実行中にHostのtimer（macrotask）が発火しなくなる事象を原因特定し、busy表示（`working`＋spinner＋
経過時間）がturn中も更新されるようにする。あわせて、通常利用で報告された`/sessions`の`session list
unavailable`（B2）とPageUpで履歴先頭へ到達できない（B3）を、共有原因か別原因かを切り分け、共有原因なら同じ
incrementで修正する。観測は`docs/experience/normal-use-inbox.md`のB1〜B3。

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
