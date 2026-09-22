# Increment 108 — Host責務の分割（計画上のIncrement B）

ステータス: **計画（未実装）**

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

### WorkerSupervisor（root Worker lifecycle）

- capsule creation、generation identity、start/ready/close、protocol message transport/routing、liveness、
  cancelとforced interruption、generation replacement。
- child registry／multi-worker APIはIncrement 109で拡張する。未実装child APIを先に設計しない。

### SessionAuthority

- canonical transcript/state revision、revision fencing、commit proposal validation、canonical adoption、
  projection更新。

### ExecutionJournal

- admission、Worker observation/event/evidence、noncanonical failure/cancel settlement、diagnostic/artifact
  readback。

## atomic commitの不変条件

現行のcanonical Session adoptionとexecution settlementを行うatomic persistence operationを二つのwriterへ
分断しない。

- persistence成功前にprojectionを進めない。
- persistence成功前にaccepted acknowledgementを送らない。
- `SessionAuthority`と`ExecutionJournal`が同じ内容を二重保存しない。
- `WorkerHostSession` facadeが独自にcommitを再実装しない。

model streaming、provider I/O、通常tool I/O、context構築、agent loop、一時的loop stateはWorker側へ残し、
Host RPCへ移さない。

## 完了条件

行数ではなく責務所有。helper関数を別fileへ移し、shared mutable stateと判断を`WorkerHostSession`へ残すだけの
分割は不可。

## 受入条件

- CLI／TUI／Session／historyの意図的なproduct挙動変更がない。
- root Worker replacement、cancel、forced interruptionがSupervisor経由になる。
- successful commit、failure/cancel non-adoption、evidence persistenceがfocused testで維持される。
- atomic persistenceとack順序が維持される。
- focused test、関連type check、format、lint、`git diff --check`を実行する。
- `v0:gate`はこの時点では実行しない。

## 対象外

- 非同期subagentの実装（Increment 109）。
- Worker protocolのwire schema変更。
- provider/tool物理I/Oのplacement変更。

## 未確認事項

- 分割境界の正確なfile構成と、既存test seam（capsuleFactory、workerResponseTimeoutMs等）の配置は実装時に決める。
