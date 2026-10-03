# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-04）

[Increment 181](../docs/increments/increment-181.md)はlocal実装・検証完了。
全スライスのtest・独立review、最終gate、実provider
E2E・停止DB照合、採用P2修正と指摘限定re-reviewを完了した。
最終sourceのcompiled候補は`.tools/increment-181/final/henji`。実provider証拠は`.tools/e2e-181/2026-10-04/`。
利用者の追加指示で181のcommit/push・常用配置は承認済み、実施中。実config・旧DB・常用Coreは変更していない。

## 次の一手と承認境界

181の実装・関連記録をcommit/pushし、clean
sourceからbuildして既存の常用binaryへ配置する。配置後の起動・build
identityを隔離環境で確認し、結果を報告する。
181の§8にある構想・architecture・roadmapの意味変更案は別途承認が必要で、正本へ未反映。
旧実データの削除・移行は未承認。181の検証用Sessionだけを削除確認した。
model省略childの認証登録ID継承不具合は通常利用メモB10の未採用候補で、修正は次の採用判断を待つ。
S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 181](../docs/increments/increment-181.md):
  合意要件、全スライス結果、完了判定、承認境界。
- [181具体contract](../docs/increments/increment-181-contract.md): JSON/tool/new DBの契約。
- [181最終E2E](../docs/increments/e2e-181-plan.md): 操作・実証拠・request集計・最終候補確認。
- [Increment 180](../docs/increments/increment-180.md): 現在の常用配置までの結果。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): B10・S4等の未採用候補。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md): 責務と状態所有。
- [roadmap](../docs/roadmap.md): 必要機能と実装状態。
