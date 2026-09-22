# Increment 108 — Host責務の分割（計画上のIncrement B）

ステータス: **計画（通常・批判的レビュー反映済み。未実装）**

計画日: 2026-09-22

関連: Increment 106（同期subagent削除）、Increment 107（async run contract）、Increment 109（非同期subagent）、
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、`v0/agent/worker/worker_host_session.ts`。

## 目的

`WorkerHostSession`（約2,838行）に集約されているHost側の責務を、次の構造へ分離する。

```text
WorkerHostSession
  └─ ExecutionCoordinator
       ├─ WorkerSupervisor
       ├─ SessionAuthority
       └─ ExecutionJournal
```

product動作は変えない。CLI／TUI／Session／historyの意図的な挙動変更をしない。

## 責務

### WorkerHostSession（facade）

- TUI／headlessが使うSession facade。submit、cancel、steer、history/navigation等の入口。
- 各実行の`ExecutionCoordinator`を生成・接続する。
- 詳細なWorker lifecycle、commit、journal状態機械を直接実装しない。

### ExecutionCoordinator（1 Executionの状態機械）

- terminal message、journal durability、proposal/result、settlementを調整する。
- parent root executionとdetached child executionの違いを扱う（childはIncrement 109）。
- component間の調整判断を`WorkerHostSession`や`WorkerSupervisor`へ漏らさない。

### WorkerSupervisor（Worker lifecycle）

- capsule creation、generation identity、start/ready/close、protocol message transport/routing、liveness、
  cancelとforced interruption、generation replacement。
- **最初からN generation registryとして設計する**。V1ではroot 1 generationだけを使うが、child Workerを
  Increment 109で追加したときに境界を作り直さないため、`capsule`／`messages`／`activeExecution`の単数前提を
  supervisor内部へ残さない。child semantics（spawn/collect/cancel伝播）はIncrement 109で足す。
- 未実装child APIを先に大量設計しない。

### SessionAuthority

- canonical transcript/state revision、revision fencing、commit proposal validation、canonical adoption、
  projection更新。

### ExecutionJournal

- admission、Worker observation/event/evidence、noncanonical failure/cancel settlement、diagnostic/artifact
  readback。

## atomic commitの不変条件

現行のcanonical Session adoptionとexecution settlementを行うatomic persistence operationを二つのwriterへ
分断しない。

- **`commitCanonicalTurn`は単一のcommit transaction owner（`SessionAuthority`）が所有する。** canonical
  session write、`execution_admissions`／`execution_settled`、`canonical_turns`、`session_heads`は同一store portの
  同一transactionで確定し、canonical adoptionとexecution settlementを別writerへ割らない。`SessionAuthority`は
  `handle.acceptCommitted`とprojection更新も同じ操作の一部として所有する。
- **`ExecutionJournal`はnoncanonical failure/cancel settlementとobservation/evidence appendだけを所有する。**
  成功pathのcanonical turnのexecution settleは`SessionAuthority`のtransactionに含め、`ExecutionJournal`へ
  二重writer化しない。
- `artifactForCapture` callbackはstoreの`#capture`から呼ばれる。artifact構築が`currentManifest`／`projection`／
  `workerGeneration`を読むため、このcallbackの供給元を`SessionAuthority`と`WorkerSupervisor`の共有stateを
  跨がせない。callbackは`ExecutionCoordinator`が供給し、必要なsnapshotを`WorkerSupervisor`から明示的に受け取る。
- persistence成功前にprojectionを進めない。
- persistence成功前にaccepted acknowledgementを送らない。
- `WorkerHostSession` facadeが独自にcommitを再実装しない。

### HistoryPersistencePortのowner対応

| method（`history_store_contract.ts`） | owner |
| --- | --- |
| `beginExecution`／`admitExecution`相当（admission） | ExecutionJournal |
| `appendExecutionEvent(s)`（observation/event/evidence） | ExecutionJournal |
| `settleNonCanonicalExecution`（failure/cancel/interrupted） | ExecutionJournal |
| `commitCanonicalTurn`（canonical adoption＋成功execution settlement） | SessionAuthority |
| `reconcileExecution`（cancel escalation） | ExecutionJournal（呼出順序は下記） |
| artifact/diagnostic readback | ExecutionJournal |

### ackとjournalの非対称性

- 現行は`settlement === 'uncommitted'`の場合だけackをjournalへ追記する。成功commitのackは`execution_settled`が
  terminal factであるためjournalへ追記しない。分割後もこの非対称性を維持し、成功ackを`ExecutionJournal`へ
  流してterminal invariantを破らない。成功ackはterminal settlement所有者がprotocol trace/artifactへ記録する。

### journal failure → generation replacement

- `ExecutionJournal`はjournal失敗をtyped event（例: `executionCannotContinue(executionId, code)`）として
  `ExecutionCoordinator`へ返す。`ExecutionCoordinator`がgeneration replacementの必要性を判断し、
  `WorkerSupervisor`へ駆動を依頼する。`ExecutionJournal`が直接capsuleをterminateしない。
- `replaceGeneration`のreset対象はsupervisor所有（capsule、messages、generation id）に限定し、`currentManifest`／
  `currentStartupSnapshot`／`credentialAvailability`／sequence等のauthority/journal所有fieldのresetは明示
  callbackにする。
- pre-commit observation gap時にcommit proposalをcanonicalへ昇格させず`finishJournalFailure`へ落とす規則を
  維持する。cancel escalationでは`reconcileExecution`がreplacementに先行する。

### model selection／recall／checkpoint／title

| 操作 | 永続（SessionAuthority） | live generation（WorkerSupervisor） |
| --- | --- | --- |
| `selectModel` | handle＋projection書込 | `select_model`送信、manifest/credential更新、拒否時`rollback`＋`markUnavailableForReplacement` |
| `prepareRecall` | history read＋`pendingRecall`保持（Coordinator） | なし |
| `installCheckpoint` | handle＋projection書込 | ack送信 |
| `renameTitle` | handle＋projection書込 | なし |

`selectModel`の永続成功後にのみlive generationへ送り、拒否時はrollbackを先に、replacementを後にする。

### receive pipelineとobservation buffer

- `receive`のtransport・validation gating・stage probe・post-commit terminal判定・Surface deliveryは
  `WorkerSupervisor`と`ExecutionCoordinator`の境界に置き、observation buffer/flushは単一component
  （`ExecutionJournal`）が所有する。terminal判定とflush順序を分断しない。

model streaming、provider I/O、通常tool I/O、context構築、agent loop、一時的loop stateはWorker側へ残し、
Host RPCへ移さない。

## 完了条件

行数ではなく責務所有。helper関数を別fileへ移し、shared mutable stateと判断を`WorkerHostSession`へ残すだけの
分割は不可。

## 受入条件

- CLI／TUI／Session／historyの意図的なproduct挙動変更がない。次を具体的なregression evidenceとして確認する
  （test件数を完了条件にしない）。
  - canonical commit durability → ack順序、projection更新が永続成功後: `increment_92_worker_stage_probe_test.ts`、
    `increment_94_history_v7_prototype_test.ts`、`provider_stream_compatibility_test.ts`。
  - failure/cancel non-adoption、evidence readback: `increment_91_worker_liveness_test.ts`、
    `increment_39_cancellation_settlement_test.ts`。
  - model selection／recall／checkpoint／title: `increment_12_model_switching_test.ts`、
    `increment_15_provider_switching_test.ts`、`increment_38_recall_context_test.ts`、
    `increment_76_definition_transition_test.ts`。
- root Worker replacement、cancel、forced interruptionがSupervisor経由になる（構造基準として、capsule操作が
  `WorkerSupervisor`以外に現れないことを`rg`で確認）。
- atomic persistenceとack順序が維持される（`commitCanonicalTurn`が単一transactionであること、成功ackが
  `execution_settled`の後ろにjournalされないこと）。
- focused test、関連type check、format、lint、`git diff --check`を実行する。
- `v0:gate`はこの時点では実行しない。

## 対象外

- 非同期subagentの実装（Increment 109）。spawn/collect/cancel伝播のwire schema変更はIncrement 109が所有する。
- provider/tool物理I/Oのplacement変更。
- 既存test seam（`capsuleFactory`、`workerResponseTimeoutMs`等）の注入互換を壊す移動。

## 未確認事項

- 分割境界の正確なfile構成と、test seamの配置（注入互換を維持する）。
- `WorkerSupervisor`のN generation registryの具体的な内部表現。
