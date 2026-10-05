# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-05）

A23を[Increment 191](../docs/increments/increment-191.md)の標準run_typescript計画へ採用した。
実AI/compiled実行と未同梱stdの実行時importスパイク・計画の通常/批判的レビューは終了。
承認済み別process方式のlocal実装、各スライス確認・review、compiled TUIと実provider総合E2Eを完了。
追加承認scopeの既存3件失敗・91停止修正とstd限定importも完了。 全体gateは645 passed / 0
failed。最終compiled TUI・実provider総合E2Eも通過。詳細は191の結果を参照する。
codeはasync関数本文、workspaceと/tmpのread/write、生成code自身のnetwork許可を利用者が決定した。

B11の[Increment 190](../docs/increments/increment-190.md)は利用者による確認・完了承認済み。
実装・検証・常用配置・source commit済み。 source
commitは`def02bb2`。配置結果はincrement文書を参照する。

常用binaryは190の配置版。191確認用Core/TUIは隔離XDGで実行・終了し、実config/DBは変更していない。

## 次の一手と承認境界

191の追加承認scopeと確認は完了。std以外のimportはtool側で拒否し、通常fetch/evalは維持する。
191のcommit・常用配置は利用者の最新指示で承認済み。source commit・clean
build・atomic配置・配置後確認を実行する。
191のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
その他の未採用候補は通常利用メモを参照し、個別採用前に実装しない。
architecture/roadmapの189案は未適用patchに留め、正本反映は別承認対象。公開/release・pushは未承認。
必要最小限の実provider利用は承認済み。使用前に対象・回数・保存先を提示する。
旧実データの削除・移行は未承認。S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 191](../docs/increments/increment-191.md):
  A23の要件、各スライスの実装・確認結果、全体gateの既存未通過事項、承認境界。
  [実Agent・スパイク記録](../docs/research/a23-agent-generated-code-probe-2026-10-05.md)、
  [正本変更案](../docs/increments/increment-191-authority-proposal.patch)。

- [Increment 190](../docs/increments/increment-190.md): B11の採用範囲、一覧フィルタと確認結果。

- [Increment 189](../docs/increments/increment-189.md):
  A26の要件、6スライス結果、最終compiled/実provider証拠、完了判定と未適用正本変更案。

- [Increment 188](../docs/increments/increment-188.md): edit対象file 1
  MiB拡張、実装・確認結果と承認境界。

- [Increment 187](../docs/increments/increment-187.md): searchの出現数集計、実行証拠と正本変更案。

- [Increment 186](../docs/increments/increment-186.md):
  外部search、web外部化とpackage配布の採用要件・実装・確認。

- [Increment 185](../docs/increments/increment-185.md): A18の採用要件、実装・確認結果と未確認範囲。

- [Increment 184](../docs/increments/increment-184.md): S24の採用要件、実装・確認計画と結果。

- [Increment 183](../docs/increments/increment-183.md): S26の採用要件、実装・確認計画と結果。

- [Increment 182](../docs/increments/increment-182.md): B10の採用要件、実装・確認計画。

- [Increment 181](../docs/increments/increment-181.md):
  合意要件、全スライス結果、完了判定、承認境界。
- [181具体contract](../docs/increments/increment-181-contract.md): JSON/tool/new DBの契約。
- [181最終E2E](../docs/increments/e2e-181-plan.md): 操作・実証拠・request集計・最終候補確認。
- [Increment 180](../docs/increments/increment-180.md): 前回常用配置の結果。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): S4等の未採用候補。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的と採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md): 責務と状態所有。
- [roadmap](../docs/roadmap.md): 必要機能と実装状態。
