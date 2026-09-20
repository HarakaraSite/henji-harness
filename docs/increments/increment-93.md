# Increment 93 — terminal ledger後のprotocol観測分離

## 目的

v6 execution ledgerのterminal fenceと、commit確定後に行われるWorker protocolのacknowledgementを
両立させる。正常turnで偽のpost-commit observation failureや待ち時間を発生させず、context captureの結果と
後続観測の永続化結果を混同しない。

## 観測事象と原因

Increment 92の実provider E2Eでは、no-session execution自体、context manifest、provider evidence、exact request
bytesは正常に保存された一方、最終artifactだけが`contextCapture: failed`だった。またturn完了まで約15秒を要した。

原因は、v6の`commitCanonicalTurn`／`settleNonCanonicalExecution`が`execution_settled`をterminal factとして
保存し、以後のledger appendを禁止した後に、Hostが次を同じexecution journalへappendしていたことである。

- `acknowledgement_requested`／`acknowledgement_sent`
- acknowledgement後にWorkerが返す正常な`runtime_event:turn_end`

拒否されたappendは`postCommitObservationFailure`となり、`turn_end`はHost queueへ到達せずtimeoutまで待った。
さらにartifact生成がこの後続観測失敗を`contextCapture`にも反映していたため、保存済みcontext manifestまで
失敗表示になった。

## 承認済み計画

1. `execution_settled`をexecution ledgerの最後のfactとして維持する。
2. commit後のacknowledgement送信と、その応答である`turn_end`／`worker_error`は、ledgerへ追記せず
   `protocolTrace`、`acknowledgement`、settlementを持つ最終artifactへ保存する。
3. commit前の拒否acknowledgement、およびprovider／tool／context等の実行factは従来どおりjournal境界を必須とする。
4. `contextCapture`はcontext保存結果だけを表し、本物のpost-commit observation failureは
   `executionObservationDurability`／`executionObservationPersistenceError`だけで報告する。
5. canonical／no-session両方のv6実経路、真の後続観測失敗、terminal event順をfocused testで確認し、静的検査と
   authoritative `v0:gate`を実行する。

構想、architecture、roadmap、履歴schema、既存dataは変更しない。

## 実装

- `WorkerHostSession.sendCommitAcknowledgement`は、executionが未commitの場合だけrequested／sent／failedを
  journalへ記録する。commit後は`send()`が残すprotocol traceとartifactのacknowledgement状態を正本とする。
- commit後に受信したprotocol terminal（正常`turn_end`または`worker_error`）はterminal ledgerへappendせず、
  protocol traceへ残した上でHost queueへ渡す。それ以外の遅延provider／tool／context factは免除しない。
- artifactの`contextCapture`から`postCommitObservationFailure`との連動を除去した。pre-commit journal failureと
  実際のcontext capture結果は従来どおり反映する。

## 検証結果

- Increment 41 live execution journal: 13件pass。
  - 正常なcommit後protocol factはjournal failureにならず、artifactにaccepted ackと`turn_end` traceが残る。
  - 意図的に遅延させたprovider factの保存失敗は`executionObservationDurability: failed`になる一方、
    `contextCapture`を変更しない。
- Increment 40 no-session v6経路: artifact／executionとも`contextCapture: complete`、ackは`accepted_sent`、
  ledger末尾は`execution_settled`。修正後のfocused実行は18ms（再実行11ms）で完了した。
- Increment 90 canonical v6経路: 同じterminal／artifact条件を満たし、production v6 suite 23件pass。
- Increment 86 journal batch 3件、Increment 92 worker stage probe 11件pass。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`はpass。
- 安定候補に対するauthoritative `v0:gate`は一度だけ実行し、exit 0。

実装と検証は完了した。binary build／配置、commit、push、releaseは行っていない。Increment完了判断は利用者が行う。
