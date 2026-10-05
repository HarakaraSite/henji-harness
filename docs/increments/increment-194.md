# Increment 194 — TUI待機ループの古いフレーム保持を解消する

状態: local実装・focused確認・compiled production TUI確認・source
commit・常用配置済み（2026-10-05）。

## 必要な動作と採用根拠

長いstream更新を受けるTUIで、処理済みの古い会話フレームを未解決の入力・終了待機が保持しない。
履歴表示、入力、cancel、Session切替、再接続、終了操作を維持する。
利用者の「再現済みのTUI待機ループの保持問題を修正する＞やりましょう」により、
通常利用メモA28の再現済み保持問題を採用し、local修正・非破壊的検証を進める。
Core側のメモリ内訳・原因調査は通常利用メモA28に残す。

採用前の観測（通常利用メモから移設）:

- `remote_session.ts`はloopごとに
  `Promise.race([inputWait.then(...), frameWait, exitWait.then(...)])`を作る。
  stream側が先に完了しても、未解決の入力／終了Promiseに追加したreactionが残り、
  処理済みraceの結果に含まれる古いframeを保持する。累積thinking textも保持し得る。
  exitWaitはTUI終了まで解決せず、turnの完了・cancel・idleでは解除しない。
- 2026-10-05のDeno分離再現は約16 KiBのframeを1,800回処理し、GC後のheapUsedが 2.7→31.7
  MiBとなった。元の記録では終了Promise解決後3.4 MiBだった。 今回同じrace構造を再確認すると3.4→32.8
  MiB、終了Promiseのみ解決後32.4 MiB、 入力も解決後3.4
  MiBだった。両待機が未解決の間の保持は再現した。
  実TUIの増加量に占める割合とCore側の増加原因は未確定。
- 利用者は、未解決Promiseへのreactionが更新ごとに蓄積しないevent待機等を候補とし、
  履歴表示・入力・cancel・終了を維持する修正対象として記録していた。

## 現行の利用経路と変更範囲

通常起動／`henji tui` → `runRemoteTui` → Core snapshot・SSE購読 → `reduceSessionStreamFrame` →
`SnapshotConversationProjector` → renderer → terminal。 同じTUI
loopが`RemoteInputReader`からの入力と終了要求を受ける。 CoreのData
writer、保存履歴、会話entity、表示Map、rendererの責務は今回変えない。

変更するのは`remote_session.ts`の待機と、その単一consumer用のevent queueである。
入力／streamの各読取に一度だけcallbackを登録し、処理後に次の読取を開始する。
終了要求は同じqueueへ直接通知する。Session切替・再接続は既存subscriptionGenerationで
旧購読の結果を除外する。切断後はstream読取を追加せず、入力と終了を受け続ける。
終了時にはqueueを閉じ、処理されないframeと遅れて届く結果を保持しない。

## 実装・確認計画

1. 共通event待機へ置換し、loopごとのPromise.raceと入力／終了の再登録を撤去する。
2. production `runRemoteTui`へ多数のSSE更新を送り、入力・終了を未解決に保ったまま
   GC後heapを比較する。採用根拠の処理済みframe保持を直接確認する。
3. 既存のfocused testで入力・stream表示、Esc cancel、Ctrl-D、Session切替、再接続、 Core
   shutdown時の終了を確認する。変更fileのtype check・format・lint・diff checkを行う。
4. 確認用binaryを`.tools/increment-194/`へ公式buildし、隔離HOME/XDG/workspaceの production
   Core＋TUIを専用tmux上で確認する。local providerでstream更新、履歴表示、
   入力、cancel、次task、終了を操作し、観測を本書へ記録する。

この局所変更ではfull gateを必須にしない。実provider callは行わない。 実Session
`2bc2699f`はread-onlyの参照のみで、確認taskの送信・取消は隔離環境で行う。
常用配置、commit/push、公開、実data削除、構想・architecture・roadmap変更は今回の承認に含めない。

## 結果

- `v0/tui/event_queue.ts`を追加し、`remote_session.ts`を共通event待機へ置換した。
  各読取のcallbackを一度だけ登録する。終了は直接eventを通知し、入力読取の失敗は既存の terminal
  failure経路へ返す。旧購読の世代除外と終了時のstream／terminal復元を維持した。
- production `runRemoteTui`＋local HTTP/SSE＋最新画面のみを保持するTerminalPortで、 約16
  KiBの本文を同一entityへ1,800回更新した。入力と終了は測定中未解決に保った。 GC後のheapUsedを300
  frame処理後と1,800 frame処理後で比較した。 変更前はHEADの`remote_session.ts`を隔離source
  treeへ置き、他のsourceとprobeは同条件にした。

| source | 300 frame後 | 1,800 frame後 | 増分     |
| ------ | ----------- | ------------- | -------- |
| 変更前 | 12.0 MiB    | 37.8 MiB      | 25.8 MiB |
| 変更後 | 7.0 MiB     | 7.2 MiB       | 0.3 MiB  |

- この比較は処理済みframeの保持に対するGC後JavaScript heapの確認であり、実Session全体の
  PSS/RSS削減量やCore側のメモリ原因を示すものではない。
- regression testは上記の実TUI経路をDeno subprocessで実行する。 warmup後に約24
  MiBの古い本文が残る既知の回帰を検出するため、heap増分の許容幅を8 MiBとした。
  productのメモリ上限は追加していない。同じprobeでrevision gap後のsnapshot再取得・表示と、
  入力が未解決のままSIGTERMで終了できることも確認した。
- focused testは17件通過。既存141／143／155／170の入力・Esc cancel・draft・Session view／resume・
  Core shutdownと、新194の保持／再同期確認を含む。最後の再同期確認追加後は変更した194だけを
  再実行して通過した。変更fileとfixtureのtype check、format、lint、diff checkも通過した。
- 公式build scriptで`.tools/increment-194/henji`を生成した。 build
  IDは`f000e7c84ee56219cc5bf5b8bb242b6a6405bed4ee233ed18fe6bda54db65482`。
  local未commitのsourceを含む確認用binaryである。
- 隔離HOME/XDG/workspaceと専用tmux socket上のcompiled production Core＋TUIで、 local
  providerからの100回の本文stream更新、stream中の入力、自然完了、履歴スクロールと最新へ戻る操作、
  Esc cancel、次task、Ctrl-Dによる切離し、同Sessionへの再接続・保存履歴表示を確認した。 SQLite
  read-only確認でoutcome／adoptionは順にcompleted／canonical、cancelled／non_canonical、
  completed／canonicalだった。外部provider requestは送っていない。
- 自己reviewで、各input/frame読取が一度だけqueueへ通知されること、stream終了後に追加読取をしないこと、
  navigation／resyncで旧世代を除外すること、終了時に処理されないframeをqueueから解放することを確認した。
  機能correctness上の未解消findingはない。独立agent reviewは今回の依頼範囲に含めていない。

証拠はgit管理外の`.tools/increment-194/`に置いた。
`memory-before.json`／`memory-after.json`、`before/`、`focused-tests.log`、`type-check.log`、
`lint.log`、`build.log`、`tmux-result.json`、`tmux_check.py`と各操作の画面記録を参照する。
最初のprobe準備ではSSE endpoint／delta形式と終了後controller操作、tmux側の完了判定を修正した。
いずれも確認codeの誤りであり、productのcontractや動作は変更していない。

local修正と上記検証は完了した。source commit・常用配置は後述の追加指示により完了した。
push・公開は未実施。 構想・architecture・roadmapと実Sessionの内容は変更していない。
Core側等の追加調査は通常利用メモA28に残る。

## Commit・常用配置（2026-10-05）

利用者の「コミット配置して」により、194・195・196をsource commit
`da251e56c52eada6d521e1960a973eba2fdc8703`へまとめ、公式buildと常用配置を完了した。
配置先のversion・SHA一致と隔離production Core／TUIの起動・終了を確認した。
詳細は[196の合同配置記録](increment-196.md)を参照する。
新しい起動から適用される。稼働中の実Core／TUIは停止・再起動していない。
