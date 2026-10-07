# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界を保持する。
完了した作業の詳細は担当正本へ記録し、ここへ追記し続けない。

## 現在地（2026-10-07）

- [Increment 208](../docs/increments/increment-208.md)は、実装・検証・常用配置・利用者受入・pushまで完了。
  wheelによる履歴参照とShift+ドラッグによるコピーの運用を受入済み。採用範囲にpendingなし。
- 常用binaryはHenji 0.10.0、source `c39e39a6`、build `a4f8394f…`（`--version`で確認）。
  現行の配置・受入は208、JSR公開は[公開記録](../docs/operations/jsr-publish.md#0100-publication--2026-10-07-jst)を参照する。
- 正本の照合対応はcommit `071ec6ca`へ保存済み。
  反映範囲はarchitecture・roadmapのヘッダ、修正後の残候補は通常利用メモを参照する。
- 今回のhandoff整理と履歴保存は完了し、利用者がcommit・pushを指示した（2026-10-07）。
  整理前の記録は[履歴](../docs/history/handoff-through-2026-10-07.md)へ保存した。
  未追跡の`191-result.json`と`scripts/diagnostics/__pycache__/`はcommit対象外。

## 次の一手

- 次の個別incrementは未採用。利用者の指示と[通常利用メモ](../docs/experience/normal-use-inbox.md)から対象を選ぶ。
  候補の記載だけでは実装を開始しない。
- [Increment 206](../docs/increments/increment-206.md)のfile集計と専用tool選択は反映済み。
  実modelの自発的なtool選択と使い勝手は通常利用での観測待ちであり、追加probeを必須作業にしない。
- [開発ワークフロー案](../docs/plans/development-workflow.md)は未採用・利用者review待ち。
  採用までは作業ルールとして適用しない。

## 正本への入口

- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md)・
  [provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  責務・状態所有・境界。
- [roadmap](../docs/roadmap.md): 必要機能・実装状態・未実装範囲。
- [通常利用メモ](../docs/experience/normal-use-inbox.md):
  未採用候補と再検討条件。S35・A34・B5等もここを参照する。
- [個別increment](../docs/increments/): 採用要件・計画・実装・検証・受入結果。
  旧incrementの完了詳細や当時の承認境界を現在地へ重複転記しない。

## 承認境界

- 今回のhandoff整理・履歴保存とcommit・pushは利用者承認済み。
- 後続の実装・build・配置・公開/release・実データ操作は、利用者の指示と該当incrementの承認範囲に従う。
- 新しい実provider callは対象・回数・保存先を提示し、明示承認を得てから実施する。
- 構想・architecture・roadmapの変更は、変更対象・理由・意味上の変更内容を提示して別途明示承認を得る。
