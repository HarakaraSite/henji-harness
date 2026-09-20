# Increment 91 — bounded Worker cancellation and generation recovery

## Status

完了（2026-09-20、利用者確認済み）。

## 採用する事象

2026-09-20の通常利用で、Session `362499de-a0d4-425b-ac3e-7e2dd5c4f5ca`のturn 1に
おける最初の`web_search`が停止した。最後に永続化されたWorker factはSonar request bodyの
`context_observation`で、その後の`provider_request_start`、provider response、tool result、turn settlementは
なかった。Hostは`cancel_requested`と`cancel_sent`を保存したが、Worker settlementがなく、TUIは
`cancelling`のまま待ち続けた。processを終了した後、executionはrestart reconciliationにより
`interrupted`／`non_canonical`となり、canonical transcriptは変化しなかった。

最初の停止位置はcontext observation送出後からprovider request開始観測前の狭い区間まで特定したが、
その区間内の直接原因は未確定である。一方、無期限化した構造上の原因は確認済みである。

- `web_search`の補助provider経路が通常model requestの`providerTimeoutMs`を適用しない。
- Hostのcancelはcommand送信だけで、Worker受領、settlement猶予期限、期限超過時のgeneration terminateを
  持たない。
- 任意toolのPromise、commit後のWorker settlement、model selection応答にもHostが回収する境界がない。

## 必要なproduct動作

1. `web_search`の補助provider I/Oは、通常model requestと同じinvocation-level
   `providerTimeoutMs`（未指定時180,000 ms）でfetchとresponse body読取を停止する。
2. active turnのcancelについて、Hostはrequested、sent、Worker received、grace超過によるescalated、
   terminal settlementを区別して保存・readbackできる。
3. Workerがcancelを正常に処理した場合は、従来どおり`cancelled`／`non_canonical`としてsettleし、
   generationを再利用する。
4. cancel送信後5秒以内にturnがsettleしない場合は、Hostが該当Worker generationをterminateする。
5. canonical commit前の強制停止は`interrupted`／`non_canonical`とし、観測済みfactを保持し、
   未完了effectを`outcome_unknown`とする。Worker outcomeや正常cleanupを捏造しない。
6. canonical commit後のgeneration停止はcanonical結果を維持し、
   `committed_generation_unavailable`として記録する。
7. 強制停止後は、同じSession、canonical transcript、checkpoint、model selection、Definition、tool、
   instruction revisionを使う新しいWorker generationを起動し、次の明示的turnを実行できる。
   interrupted turnを自動replayしない。
8. commit acknowledgement後の`turn_end`とidle時model selection応答には5秒のHost deadlineを置く。
   model selectionがsettleしなければtransactionをrollbackし、旧selectionでgenerationを置換する。
9. TUIは強制停止をrecoverableな`interrupted`として表示し、入力を`/recover`可能にしてidleへ戻る。
10. turn全体または全toolへ一律の実行時間上限は設けない。長時間処理は、人間のcancelまたは個別I/Oの
    明示deadlineまでは継続できる。

## 不変条件

- Hostがcanonical SessionとWorker lifecycleのauthorityであり、Worker generationはephemeralである。
- generation置換でDefinition revisionを変更しない。旧generationのproposalはgeneration fencingで採用しない。
- cancel escalationはtool effectをrollbackまたは自動replayしない。
- credential値とAuthorizationをhistory、protocol、diagnosticへ保存しない。
- start／closeの既存5秒deadline、通常provider、`web_fetch`、`bash`の固有deadlineを狭めない。

## 実装slice

### Slice A — 補助provider deadline

- Worker-local `requestProvider`へinvocationの`providerTimeoutMs`を渡す。
- turn cancelとprovider deadlineを一つのfetch signalへ合成し、fetchとbody readの双方へ適用する。
- cancelとdeadlineが競合した場合はcancelを優先する。

### Slice B — cancel protocolとdurable lifecycle

- Workerがcancel commandを処理した直後に相関付き`cancel_received`を返す。
- Hostは同一turnの最初のcancelだけをrequested／sentとして記録し、以後は`already_requested`とする。
- Hostはcancel送信後5秒のsettlement timerを開始し、受領ackだけでは停止しない。
- 猶予超過時に`cancel_escalated`を保存してgenerationをterminateし、active executionをその場で
  `interrupted`へreconcileする。

### Slice C — generation replacementとSurface settlement

- Worker capsule、message queue、subscription、generation identityを置換可能なHost-owned generation stateへする。
- 強制停止後に同じcanonical projectionから新generationを起動する。
- `LoopOutcome`／Presentationへ`interrupted`を追加し、TUIのrecoverable settlementへ接続する。
- generationをまたぐruntime provider request countを単調増加として表示する。

### Slice D — post-commitとmodel selectionの待機境界

- accepted commit acknowledgement後の`turn_end`待ちを5秒で打ち切り、canonical結果を維持したまま
  generationを置換する。
- model selection応答を5秒で打ち切り、永続transactionをrollbackして旧selectionからgenerationを置換する。

### Slice E — verification

- 補助providerのfetch／body read timeout、turn cancel優先をfocused testで確認する。
- graceful cancel、cancel受領後未settle、cancel未受領の三経路を確認する。
- forced interruptionのhistory順序、partial evidence、effect `outcome_unknown`、canonical不変を確認する。
- forced interruption後の同一Session次turn、generation fencing、request count継続を確認する。
- post-commit timeoutとmodel selection timeoutの結果を確認する。
- TUIの`interrupted` recoveryとsignal／Ctrl-C shutdownを確認する。
- 安定候補に対してauthoritative `v0:gate`を一回実行する。

## 実装結果

- 補助provider requestは通常model requestと同じ`providerTimeoutMs`を使い、turn signalとdeadline signalを
  合成してfetchとbody readの両方へ適用する。両者が競合した場合はturn cancelを優先する。
- Worker protocolへ相関・sequence付き`cancel_received`、durable historyへ`cancel_received`／
  `cancel_escalated`を追加した。Hostは同じexecutionのcancelを一度だけ送信し、ack受領後もterminal settlementまで
  5秒のgraceを維持する。
- grace超過時はHostがgenerationをterminateし、commit前executionを`interrupted`／`non_canonical`へ
  reconcileする。v6 historyは観測済みprovider factをpartial evidence、未完了toolを`outcome_unknown`、
  executionをpartial artifactとしてreadbackできる。
- Worker capsule、message queue、subscription、generation IDをHostが置換可能にした。置換は同一Sessionの
  canonical projection、model selection、Definition、instruction、tool revisionから開始し、旧generationの遅延proposalを
  fencingする。runtime provider request countはgenerationをまたいで単調増加する。
- commit済みturnの`turn_end`とmodel selection応答へ5秒deadlineを追加した。前者はcanonical結果を保持して
  generationを置換し、後者は永続transactionをrollbackして旧selectionから置換する。terminate済みgenerationの
  closeはWorker応答を待たない。
- Presentationへ`interrupted`を追加し、TUIは`worker interrupted; recoverable input available; use /recover`として
  idleへ戻す。

## Focused verification

- `tests/v0/increment_91_worker_liveness_test.ts` 10件で、補助providerのfetch／body deadline、cancel優先、
  graceful cancel、ackあり／なしの強制停止、即時close、partial fact、effect unknown、generation fencing、
  request count継続、post-commit timeout、永続model selection rollbackを確認した。
- `tests/v0/tui_retained_terminal_test.ts` 38件で、`interrupted`から`/recover`して再submitできることと、
  二度目のCtrl-Cによる終了を確認した。
- 関連回帰としてIncrement 7、12、35、39、40、41、90を実行し、合計62件がpassした。
- 安定候補に対するauthoritative `v0:gate`を一回実行し、check、format、lint、全offline testがexit 0となった。
- 利用者の追加指示により現working treeからstandalone binaryをbuildし、`dist/henji`と
  `/home/masat.guest/.local/bin/henji`へ同一artifactを原子的に配置した。build IDは
  `9a6fca79c8840c4999d99c789d31b013b371700480585da8495dc789bbb540a5`、file SHA-256は
  `753ca925fbae5c64ac71e370a94bed30fc37ee8eb423a2da9434e9578df9829f`、sourceは
  `01b3e77381ea4a696ecbe514cb1a6fdbe96a183b+dirty`である。

## 対象外

- 直接原因が未確定なcontext observation直後の停止を、推測した一原因へ固定すること。
- cancelされていない任意のexternal toolへ一律deadlineを課すこと。
- Worker heartbeat、resident Host、durable AgentInstance、processをまたぐ自動restart。
- tool副作用のrollbackまたは自動replay。
- release、tag、push。

## 完了判断

実装・focused verification・一回のauthoritative gate完了後、利用者が配置済みbinaryでcancelの正常動作を確認し、
2026-09-20にincrement完了と判断した。
