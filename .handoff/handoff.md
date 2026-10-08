# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。
計画・結果・完了履歴は担当正本を参照する。

## 現在地（2026-10-08）

- 利用者判断により217までの既存incrementを一律完了とした。209〜217の冒頭へ完了状態を追記し、
  208以前の2026-10-07完了記録は保持した。各作業時点の実施・未実施記録は現在の残作業として扱わない。
  要件・結果は各increment、文書への入口は[索引](../docs/increments/README.md)を参照する。
- [Increment 217](../docs/increments/increment-217.md)に、214〜217適用後のcompiled
  Core/TUIメモリ観測と
  利用者指示による常用配置の結果を追記した。詳細な条件・結果・未確認範囲は217を参照する。
- 常用binaryはHenji 0.11.0、clean source `6315beed`、build `199c3937…`。
  `dist/henji`と常用binaryへ配置し、配置binaryの隔離Worker/TUI確認を完了した。
  既存の稼働Core/TUIは再起動していない。新しいCore/TUI起動から適用する。
  退避先と検証結果は[配置記録](../docs/operations/native-0.11.0-deployment.md)を参照する。
- 実装sourceは`6315beed`までorigin/mainへpush済み。今回の完了・メモリ観測・配置記録と、
  通常利用メモのA37・A38（searchの`!`除外とmode命名）はcommit済み。pushは未実施。
  未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`は保全し、commit対象外。

## 次の一手

- 採用済みincrementに未完了作業はない。追加の作業は利用者の指示に従う。
- 未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)を参照する。
  記載だけでは採用・実装を開始しない。過去incrementの未実施記録を新しい必須作業へ戻さない。
- [開発ワークフロー案](../docs/plans/development-workflow.md)は未採用。採用までは作業ルールとして適用しない。

## 正本への入口

- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md)・
  [provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  責務・状態所有・境界。
- [roadmap](../docs/roadmap.md): 必要機能・実装状態・未実装範囲。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補と再検討条件。
- [個別increment索引](../docs/increments/README.md):
  採用要件・計画・実装・検証・受入結果とアーカイブへの入口。
- [0.11.0配置記録](../docs/operations/native-0.11.0-deployment.md)・
  [JSR公開記録](../docs/operations/jsr-publish.md): 実施済み配置・公開と各時点の検証結果。
- [旧handoffの履歴](../docs/history/handoff-through-2026-10-07.md): 2026-10-07以前の再開状態の記録。

## 承認境界

- 217までの完了判断と最新binaryの常用配置は利用者の明示指示により実施済み。
- 後続の実装、commit/push、追加build/配置、公開/release、実データ操作は利用者指示に従う。
- 新しい実provider callは対象・回数・保存先を提示し、明示承認を得てから実施する。
- 構想・architecture・roadmapの変更は、変更対象・理由・意味上の変更内容を提示して別途明示承認を得る。
