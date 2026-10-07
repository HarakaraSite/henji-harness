# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界を保持する。
完了した作業の詳細は担当正本へ記録し、ここへ追記し続けない。

## 現在地（2026-10-07）

- [Increment 211](../docs/increments/increment-211.md)へS32＋S37、
  [Increment 212](../docs/increments/increment-212.md)へS36を採用した。211はlocal実装・focused test・
  隔離tmux実表示／操作確認・独立reviewを完了し、sourceはcommit `ac59f0d0`へ保存済み。
  212はlocal実装・focused確認・隔離tmux実表示／操作確認と独立reviewを完了し、sourceは
  commit `894aeb0b`へ保存済み。利用者指示により公式build・常用配置・配置後smokeまで完了した。
  詳細と検証結果は212を参照する。常用環境での利用者確認は211・212をまとめて行う。
  配置後の利用者観測で`/new`のヘッダー重複を再現・修正し、focused／隔離tmux確認を完了した。
  既承認の212配置への修正commit・再配置を実施中。詳細は212の追加記録を参照する。
  pushは未実施。
  順序は211の実表示・操作確認後に212。要件と確認方針は各incrementを参照する。
- [Increment 210](../docs/increments/increment-210.md)は、Coreの重複照会・再投影のlocal改善と検証を完了した。
  通常・批判的reviewとP2のtest修正・再reviewも完了した。
  sourceはcommit `568ed489`へ保存済み。212の常用binaryにbuild・配置済み。pushは未実施。
  要件・比較結果・実経路確認とreview結果は210を参照する。
- [Increment 209](../docs/increments/increment-209.md)は、利用者指定のHTTP APIについて不要な処理を整理し、
  local実装・検証を完了し、sourceはcommit `24e9e357`へ保存済み。212の常用binaryにbuild・配置済み。pushは未実施。
  結果は209を参照する。
- 既存incrementは、履歴へ退避済みのものも含め、2026-10-07の利用者判断で一律完了とした。
  各increment冒頭の現在状態を参照する。当時の実施・未実施記録は保持し、過去作業を再調査しない。
- [Increment 208](../docs/increments/increment-208.md)は、実装・検証・常用配置・利用者受入・pushまで完了。
  wheelによる履歴参照とShift+ドラッグによるコピーの運用を受入済み。採用範囲にpendingなし。
- 常用binaryはHenji 0.10.0、source `894aeb0b`、build `4c7f0dcf…`（`--version`で確認）。
  現行の配置は212、常用環境の利用者確認は211・212で待つ。
  JSR公開は[公開記録](../docs/operations/jsr-publish.md#0100-publication--2026-10-07-jst)を参照する。
- 正本の照合対応はcommit `071ec6ca`へ保存済み。
  反映範囲はarchitecture・roadmapのヘッダ、修正後の残候補は通常利用メモを参照する。
- 今回のhandoff整理と履歴保存は完了し、利用者がcommit・pushを指示した（2026-10-07）。
  整理前の記録は[履歴](../docs/history/handoff-through-2026-10-07.md)へ保存した。
  未追跡の`191-result.json`と`scripts/diagnostics/__pycache__/`はcommit対象外。

## 次の一手

- 212のヘッダー重複修正をcommit・再配置し、新しいCore/TUIで利用者確認へ進む。pushは未承認。
  architectureの旧入力履歴・キー割当とviewportの更新案は211・212に記録し、正本変更への別途明示承認を待つ。
  未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)を参照し、記載だけでは実装を開始しない。
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
  未採用候補と再検討条件。B5等もここを参照する。S32・S36・S37の採用要件は211・212へ移設した。
- [個別increment索引](../docs/increments/README.md): 採用要件・計画・実装・検証・受入結果とアーカイブへの入口。
  100までの既存文書は`docs/history/increments/`へ退避済み。通常の場所には101以降を保持する。
  旧incrementの完了詳細や当時の承認境界を現在地へ重複転記しない。

## 承認境界

- 今回のhandoff整理・履歴保存とcommit・pushは利用者承認済み。
- 後続の実装・build・配置・公開/release・実データ操作は、利用者の指示と該当incrementの承認範囲に従う。
- 新しい実provider callは対象・回数・保存先を提示し、明示承認を得てから実施する。
- 構想・architecture・roadmapの変更は、変更対象・理由・意味上の変更内容を提示して別途明示承認を得る。
