# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-04）

[Increment 181](../docs/increments/increment-181.md)は実装・検証・commit/push・常用配置完了。
全スライスのtest・独立review、最終gate、実provider E2E、採用P2修正とre-reviewを完了した。 実装commit
`a9fd01ef`はorigin/mainへpush済み。同commitのclean buildを
`dist/henji`と`/home/agent/.local/bin/henji`へ配置し、隔離Core/API・tmux
TUIで起動とbuild保存を確認した。 配置後の旧catalog拒否を受け、常用agents.jsonとreviewer
JSONを181形式へ切り替えた。 配置版CLIで構成確認済み。旧DB・稼働中常用Coreは変更していない。
配置証拠は`.tools/increment-181/deployment/`、実provider証拠は`.tools/e2e-181/2026-10-04/`。

## 次の一手と承認境界

181の実装・配置は完了。常用設定修正後の新Sessionは構成を通過したが、ChatGPT認証更新が
`invalid_grant`で失敗した。利用者へ`/login`→ChatGPT→`r`で再認証後の再送を案内し、通常利用結果を待つ。
181の§8にある構想・architecture・roadmapの意味変更案は別途承認が必要で、正本へ未反映。
旧実データの削除・移行は未承認。181の検証用Sessionだけを削除確認した。
model省略childの認証登録ID継承不具合は通常利用メモB10の未採用候補。
S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 181](../docs/increments/increment-181.md):
  合意要件、全スライス結果、完了判定、承認境界。
- [181具体contract](../docs/increments/increment-181-contract.md): JSON/tool/new DBの契約。
- [181最終E2E](../docs/increments/e2e-181-plan.md): 操作・実証拠・request集計・最終候補確認。
- [Increment 180](../docs/increments/increment-180.md): 前回常用配置の結果。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): B10・S4等の未採用候補。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md): 責務と状態所有。
- [roadmap](../docs/roadmap.md): 必要機能と実装状態。
