# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

[Increment 177](../docs/increments/increment-177.md)の未使用code・test・export整理、
`v0:test`整備、JSR収録漏れ修正と、[Increment 178](../docs/increments/increment-178.md)の
ChatGPT最新2モデル・公式effort固定記載は、local実装・検証、常用配置と配置先確認が完了した。
実装commit `e76056bab3fb30ccb9661290cb7f84625d1c2f3c`を`origin/main`へpush済み。
関連記録・通常利用メモ・API Worker検討案もこのcommitに含む。
配置、build情報と配置先確認は178を参照する。
起動中の常用Coreと実configは変更しておらず、新しく起動するCoreから配置版が使われる。

## 次の一手

進行中の実装作業はなく、利用者の次の指示を待つ。
最新モデルの根拠・実装・確認は178、未使用除去とJSR収録漏れ修正は177を参照する。
B8の元の原因は引き続き未確定で、実使用で再発した際に
拡充した診断と既存semantic履歴から調べる方針は[176](../docs/increments/increment-176.md)を維持する。
未採用候補の入口は通常利用メモとする。

## 承認境界

- 177・178のlocal変更・検証、常用配置と配置先確認は承認済み・実施済み。
- 利用者の「コミットプッシュはしよう」で177・178と関連記録のcommit/pushを承認。
  実装のpushは完了した。完了状態の文書更新も同じ送信先へcommit/pushする。
- 178の承認済み直接指定probeは実施済み。結果と資料pointerは178を参照する。 追加の実provider/model
  call、公開、実data削除は未承認。
- API Worker検討案と入力履歴削除はメモのみで、個別incrementへの採用・実装は未承認。
- 構想・architecture・roadmapの意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)による別途承認が必要。

## 正本への入口

- [Increment 178](../docs/increments/increment-178.md):
  ChatGPT最新2モデルの固定候補と公式effort、probe・TUI確認。
- [Increment 177](../docs/increments/increment-177.md):
  未使用実装と旧testの撤去、通常test入口の整備。
- [Increment 176](../docs/increments/increment-176.md): B8と共通診断拡充、原観測、review・配置結果。
- [Increment 175](../docs/increments/increment-175.md): B7の要件・計画・結果。
- [Increment 174](../docs/increments/increment-174.md): B6の要件・計画・結果。
- [Increment 173](../docs/increments/increment-173.md): 共通credential登録と利用者確認。
- [Increment 172](../docs/increments/increment-172.md): Exa検索とweb_fetch download。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的・Why・人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md):
  責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  provider/account/modelの境界。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [roadmap](../docs/roadmap.md): 機能・実装状態・未実装範囲。
