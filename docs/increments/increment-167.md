# Increment 167 — Session表示履歴の整合性

更新日: 2026-10-01

ステータス: 利用者確認・完了承認済み（2026-10-01）。local実装・検証・commit・binary作成・常用配置完了。

## 要件と根拠

利用者の「対症療法じゃなくちゃんと治して」「履歴全体が整合性を保てるように」に従う。
Session `f75a8810`ではcancelした`a149e625`の後、recall、続行`e4ff4181`の完了を経て、
cancelとrecallの通知が成功回答の下へ移動した。配置済み新buildでも発生している。
DBには両executionが保存されているが、Session snapshotはcanonicalと最新non-canonicalだけを表示し、
過去cancelの行を除去していた。TUIは消えたanchorの通知を末尾へ追いやっていた。

architectureの既存方針（人間向けsession historyはcanonical/non-canonicalを時系列で表示、
model contextはcanonicalを既定入力とする）に表示経路を合わせる。正本の意味変更は不要。

## 経路と修正方針

既存SQLite semantic／execution履歴 → Core API projection → HTTP snapshot／SSE reducer →
TUI conversation projector → system notices → rendererを対象とする。

- 全executionの表示記録を既存履歴から生成し、成功・cancel・failure後と次task後も保持する。
- live、settlement、canonical adoption、Core再起動で同じsemantic identityを使う。
  canonical transcriptを再び別IDの表示行へ置き換えて二重表示しない。
- executionの開始順とexecution内のsemantic順を使う。未成功attemptと成功attemptは同じturn番号を
  持つため、turnだけで混ぜない。user/steerの区別もexecution単位にする。
- 全root executionの結果をsnapshot／SSEへ渡し、再接続後も各executionの末尾へ結果を表示する。
- UI内だけで保持する操作通知は発生位置を維持する。anchor消失時の末尾送りを廃止する。
- DB記録形式、model入力、recallの文脈選択、通知の保存範囲、配色は変更しない。

## 検証

localhost providerの実Coreで「成功→tool/note/thinking→cancel→recall→続行→成功→次task→成功」を
実行する。snapshotとSSEで行・結果の欠落、重複、移動がないこと、Core再起動後に同じ履歴を取得できる
ことを確認する。provider requestの入力も確認し、recallした明示材料以外のcancel履歴が既定contextへ
混入しないことを確認する。

focused test、必要なtype check、format、lint、diff checkを行う。full gateは実行しない。
隔離HOME/XDGとtmuxのproduction TUIでもcancel→recall→続行→完了、履歴移動・再接続を確認する。
外部provider callは0。実Session／稼働Core／credentialを変更しない。

## 結果

Core projectionがcanonical transcriptと最新attemptだけを組み合わせる経路を修正し、既存executionの
semantic記録を全attempt共通の表示authorityとして使う。settlementやadoptionでmessage/request/thinking
identityを切り替えない。root executionの結果一覧をAPI snapshotへ追加し、SSEの`executions.replace`でも
同じ一覧を更新する。TUIは全rootの非成功outcomeを各executionの末尾へ表示する。

user/steerの区別はturn番号からexecution IDへ変更した。assistant messageのない末尾thinkingは、その
executionの境界へ置く。UI操作通知は元のsemantic anchorを維持し、正当な行削除時には直前の残存行へ
境界を引き継ぐ。消えたanchorの通知を全履歴末尾へ送る処理は廃止した。

### 確認

- focused 41件がpass。CoreのHTTP、cancel、none Session、outcome、表示identity、note/tool、通知と
  新しい履歴継続の実経路を確認した。新規二件は実Worker・SQLite・localhost Responsesを使用する。
- 「成功→cancel→recall→成功→次の成功」で全行の順序とidentityを比較した。同turnの別attemptも
  別userとして表示され、cancelの全行とrecall受領が続行入力より前に残る。
- HTTP codec・snapshot差分・SSE reducerを通した結果は直接snapshotと一致する。Core再起動後も
  messages/tools/thinkingが完全一致し、新TUIでも保存済みcancel outcomeを同じ位置へ復元する。
- 次のmodel requestにはcanonicalの成功履歴と明示recall材料だけが入り、その次にはcancel入力と
  途中本文が混入しない。外部provider requestは0。
- thinkingだけで停止した次stepのsummaryも、後続回答の末尾へ移動せず、そのexecution末尾と
  CANCELLEDの前へ残る。
- mod.ts、remote TUIと全tests/v0/*.tsのtype check、変更sourceのformat/lint、diff checkはpass。
  full gateは実行していない。

### production TUI

隔離HOME/XDG、160×70 tmux、candidate compiled TUIとproduction Core/Worker/SQLite、localhost APIを使用。
最初の確認入力は操作待ち中にprovider deadlineへ到達したため、実際のFAILED履歴として保持した。
続く入力ではtoolと途中本文を取得してEscでcancelし、/recall（補完Enter、実行Enter）、続行、次taskを操作した。
FAILEDの作業、cancelした作業、CANCELLED、RECALL PREPARED、続行のuser/thinking/note/tool/answer、
次taskの順序を確認した。PageUp/PageDownでも順序を保持した。detachして同Coreへ再接続後も、
保存済みFAILED/CANCELLEDと各作業を同じ順序で一度だけ表示した。

recall受領など操作通知の保存範囲は従来どおり同TUI内だけであり、新TUIへの再接続では復元しない。
保存済みexecution結果と作業記録はCoreから復元する。操作通知をDBへ新規保存する変更は行っていない。

証拠: `.tools/increment-167/tui-probe/`のlive/cancelled/recall/continued/next-task/page-up/page-down/
reconnectedのcapture、facts.json。localhost requestは8、外部provider requestは0。

### 実Sessionの保存履歴

f75a8810のDBをSQLite read-only接続から隔離backupした。実DBへ書き込まず、新projectionでinactive
Sessionのreadを行った。キャンセルa149e625と成功e4ff4181が開始順で復元され、15表示行中CANCELLEDは
index 9、続行のuserはindex 10となる。証拠は`.tools/increment-167/actual-restored/facts.json`。
実Session、既存Coreとcredentialは変更していない。

### 適用

新snapshot契約はconversation.executionsを必要とする。旧Coreへの新TUI接続を混在させず、新Coreで
保存Sessionを再開する。binary配置だけでは現在稼働中のCoreには反映しない。既存Coreの停止は利用者の
操作に任せる。push・公開は行わない。

### commit・build・常用配置

追加修正の継続として、承認済みのcommit/build/配置を行った。
source commitは`72d14f4ae81b28ec317f9940cb53d08eebf6fbc1`。
公式henji:compileでdist/henjiを作成し、dirtyなし、build
`d94601c7c41a7427f14651d4f89c701511340d2ac858763ab8801d96f13ff21f`。
検証candidateと確定binaryのruntime digestは
`ad5ac7e9967692491bcbad3f27d13b7c126237fd7efacf34dba66a18f48695e1`で一致する。

常用`/home/agent/.local/bin/henji`へatomicに配置した。distと配置先のSHA-256は
`3fecd1c3602b5ca290fb91a178dd99047d1fad94074b01fb428799f46f3b0498`で一致する。
以前のbinaryは`.tools/increment-167/deployment/henji.previous`へ保持した。

配置先のbinaryから隔離HOME/XDGで新Core/TUIを起動し、readyへの到達を確認した。
続いて隔離backupのf75a8810を同じcompiled Core/TUIの/viewで読み、キャンセル前のuser、thinking、
assistant note、tool四件、CANCELLED、続行userと成功回答の順序を確認した。
長い回答のため160×70の最新viewportでは前半が外れるので、160×160の全体captureと70行の履歴移動で確認した。
provider requestは0。証拠は`.tools/increment-167/deployment/`のdeployment.json、startup.txt、
actual-session-full.txt、actual-session-page-up.txt。確認用Core/TUIは終了済み。
実Coreは保持する。新Coreで同Sessionを再開する例:

```sh
henji --session f75a8810-7302-400e-951e-b93e27ccf798
```

既存HenjiのCoreを終了してから実行する。旧Coreへの再接続では修正が反映されない。
push・公開は行っていない。

### 利用者確認・完了承認

2026-10-01、利用者の「確認しました このインクリメントを完了とします」により、
Increment 167を完了とする。常用配置済みの修正について利用者確認を受け、handoffを更新した。

### 後続のpush指示

2026-10-01、利用者の「コミットプッシュして」により、本incrementの実装・配置・完了承認記録を含む
mainの未送信commitをorigin/mainへpushした。公開は行っていない。
