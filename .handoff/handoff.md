# Handoff

## Records

### Increment 32以降 — standalone配布とmanaged externalization

- 状態: Increment 32はstandalone配布まで完了済みである。Increment 33は承認済み個別計画のSlice A〜Dを実装し、
  managed Agent Definitionのinstall/list/inspect、exact revision selectionとSession binding、managed closureの共通Worker
  実行、parent/planner、same-identity tool replacement、failure readbackを成立させた。focused test 11件と、一回だけの
  authoritative `v0:gate`（計165 test）が成功した。standalone binaryの隔離production受入では、元source path不在の
  旧revision、編集後の新revision、planner real-TTY turn、別processのexact Session再開、実provider turnとexact
  attribution、破損/API非互換時のno-fallbackを確認した。実装・検証結果はIncrement 33正本へ保存済みであり、
  利用者がIncrement 33の完了を確認した。
- 次: 利用者が次に着手するIncrementまたは作業を指示する。
- 正本:
  `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`のIncrement 32〜34、
  `docs/increments/increment-32.md`、`docs/increments/increment-33.md`。現行の検討資料は
  `docs/roadmap-inputs/increment-32-34-externalization-concept-plan.md`。当初案と初回reviewの履歴は
  `docs/roadmap-inputs/increment-32-33-initial-plan-review.md`。参照実装比較の背景資料は
  `docs/research/externalization-reference-comparison.md`。
- 注意: Increment 32はstandalone binaryとresource共通identity・配置境界、Increment 33は最初のmanaged kindで
  あるAgent Definition、Increment 34はDefinition transportである。tool等の他resource kindは33のlocal基盤後に
  個別Incrementで扱い、34を必須前提にしない。`--definition <path>`はIncrement 32で廃止し、外部sourceを
  Increment 33以降のinstall inputに限定する。自然言語resourceのnative discoveryにinstallを要求しない。MCPは
  32〜34の実装範囲外であり、managed化の採否とclient等の物理配置は後続Integration Incrementで決める。Increment 32の
  installed binary置換、commit `988022ba`、`origin/main`へのpushは実施済みで、publishは未実施。Increment 33の
  実装はcurrent HEADへcommit済みである。architecture・roadmap実装状態更新、installed binary置換、push、tag、
  publishは未承認・未実施である。
  production受入の一時証拠は`/tmp/henji-increment-33-acceptance-XbeQE3`に保持している。利用者の指定に従いIncrement
  境界で停止する。
