# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-05）

[Increment 191](../docs/increments/increment-191.md)は利用者による通常利用確認・完了承認済み。
常用binaryは191の配置版（source commit `e53a2436`）。結果・配置・利用者確認は191を参照する。

## 次の一手と承認境界

191の必須作業は完了。利用者が0.9.0へのversion更新とJSR公開を明示依頼した。
[公開手順](../docs/operations/jsr-publish.md)に従い、release準備・gate・dry run・commit/push・clean
worktree公開を進める。 JSRの対話認証・browser操作は同手順のOperator boundaryに従い利用者が行う。
191のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
その他の未採用候補は通常利用メモを参照し、個別採用前に実装しない。
architecture/roadmapの189案は未適用patchに留め、正本反映は別承認対象。 今回のJSR公開と手順内のsource
pushは承認済み。native binaryの追加公開は今回の対象外。
必要最小限の実provider利用は承認済み。使用前に対象・回数・保存先を提示する。
旧実データの削除・移行は未承認。S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 191](../docs/increments/increment-191.md): A23の要件、各スライスの実装・確認結果、645
  testのgate通過、commit・常用配置結果、承認境界。
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
