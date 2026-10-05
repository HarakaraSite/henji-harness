# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-05）

[Increment 196](../docs/increments/increment-196.md)はA28の最新request・request件数のmetadata読取を
採用し、local修正・focused確認・実DBコピー比較・compiled production Core／TUI確認済み。
通常・批判的reviewでも未解消findingはない。結果と証拠は196を参照する。常用配置は未実施。

[Increment 195](../docs/increments/increment-195.md)はA28のCore保存会話復元の一括本文保持を採用し、
local修正・focused確認・実DBコピー比較・compiled production Core／TUI確認済み。
通常・批判的reviewでも未解消findingはない。
復元単体のピークは減ったがCore全体の常駐PSSに残る課題はA28へ残した。
結果と証拠は195を参照する。常用配置は未実施。

[Increment 194](../docs/increments/increment-194.md)はA28のTUI待機loopの保持問題を採用し、
local修正・focused確認・compiled production TUI確認済み。結果と証拠は194を参照する。
常用配置は未実施で、常用binaryは193のsource commit `fa258148`のまま。

[Increment 193](../docs/increments/increment-193.md)の追加指定の配色はCodexへの引継ぎを完了した。
local実装・focused確認・独立review・source commit・公式build・常用配置済み。 常用binaryのsource
commitは`fa258148`。新しい起動から適用される。
詳細は193の「追加指定の配色・引継ぎ結果」を参照する。利用者の見た目確認・完了承認は残る。

[Increment 192](../docs/increments/increment-192.md)は利用者による確認・完了承認済み。
利用者はこの後セッションを終了する。実装・検証・配置・完了の記録は192を参照する。

[Increment 191](../docs/increments/increment-191.md)は利用者による通常利用確認・完了承認済み。
192時点の常用binaryはsource commit `4312d81e`からbuildした0.9.0。
前回の[0.9.0配置記録](../docs/operations/native-0.9.0-deployment.md)と191の機能・利用者確認は191を参照する。
JSR `@henji/harness@0.9.0`は公開・両entrypointの実import・公開型の確認済み。
公開結果は[公開手順](../docs/operations/jsr-publish.md)を参照する。

## 次の一手と承認境界

194・195・196のlocal修正・非破壊的検証は承認済みで完了した。 常用配置、commit/push、公開、実provider
call、構想・architecture・roadmap変更は未承認。 A28のCore全体等の追加調査候補は通常利用メモに残る。
195後のmetadata読取候補は196へ採用・移設した。native内訳などの追加候補は未採用である。
類似問題reviewで見つかったcontext読取・終了後artifact更新等の別経路は、通常利用メモA28の未採用候補を参照する。

次は193の利用者による見た目確認・完了承認。
利用者は今回の隔離TUI・配置時の表示確認を省略し、自分で確認すると明示した。 新しい実provider
callは行わない。配置後は利用者のGhostty上での見た目確認・完了承認を待つ。
193のpush、公開/release、構想・architecture・roadmap変更は未承認。
S33は193へ採用・移設した。その他の未採用候補は通常利用メモを参照する。
192のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
192の追加指示はarchitecture/roadmap正本変更、push、公開/release、
旧実データの削除・移行の承認を含まない。実provider callを計画上の必須確認にしない。
191のarchitecture/roadmap案は未適用patchに留め、正本反映は別承認対象である。
その他の未採用候補は通常利用メモを参照し、個別採用前に実装しない。
architecture/roadmapの189案は未適用patchに留め、正本反映は別承認対象。 今回のJSR公開と手順内のsource
pushは承認済み。後続指示でnative binaryのbuild・常用配置も承認済み。
必要最小限の実provider利用は承認済み。使用前に対象・回数・保存先を提示する。
旧実データの削除・移行は未承認。S4の`/reload`も別候補として残る。

## 正本への入口

- [Increment 196](../docs/increments/increment-196.md):
  最新request・request件数の採用要件、必要な記録だけの読取、focused確認、実DBコピーの一致と compiled
  Coreのメモリ比較、Core／TUI／履歴CLI確認、残る課題と承認境界。

- [Increment 195](../docs/increments/increment-195.md):
  A28のCore保存会話復元の採用要件、逐次復元の修正、同一snapshot・読取順の確認、
  実DBコピーの復元一致とメモリ比較、compiled Core／TUI／履歴CLI確認、残る課題と承認境界。

- [Increment 194](../docs/increments/increment-194.md):
  A28のTUI保持問題の採用要件、event待機修正、変更前後のGC後heap比較、focused確認、 隔離compiled
  production TUIの操作・保存結果と承認境界。

- [Increment 193](../docs/increments/increment-193.md):
  S33の採用要件・計画・実装・focused確認・独立review・compiled TUI／最小実provider結果、 source
  commit・常用配置・配置後確認結果、見た目確認待ちと承認境界。

- [Increment 192](../docs/increments/increment-192.md):
  `openai-chat`廃止の採用要件、実行記録・公式契約、 現行利用経路、実装・gate・compiled
  TUI確認・commit・常用配置結果、利用者確認・完了承認、承認境界。
  [正本変更案](../docs/increments/increment-192-authority-proposal.patch)は未適用。

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
