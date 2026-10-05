# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-05）

[Increment 193](../docs/increments/increment-193.md)の初版は実装・review・配置済み。
利用者の見た目確認を受けた配色再調整はlocal実装・focused確認・追加差分review・production
TUI確認済み。 再調整のcommit・常用配置は未実施。確認用binaryと結果は193の再調整節を参照する。
利用者から初版の識別しにくさを指摘され再調整中。完了承認は未実施。詳細結果と未確認事項は193を参照する。
193のsource commit・常用配置・配置後の隔離production TUI確認も実施済み。 常用binaryは193のsource
commit `b399f053`からbuildした0.9.0。配置結果は193を参照する。

[Increment 192](../docs/increments/increment-192.md)は利用者による確認・完了承認済み。
利用者はこの後セッションを終了する。実装・検証・配置・完了の記録は192を参照する。

[Increment 191](../docs/increments/increment-191.md)は利用者による通常利用確認・完了承認済み。
192時点の常用binaryはsource commit `4312d81e`からbuildした0.9.0。
前回の[0.9.0配置記録](../docs/operations/native-0.9.0-deployment.md)と191の機能・利用者確認は191を参照する。
JSR `@henji/harness@0.9.0`は公開・両entrypointの実import・公開型の確認済み。
公開結果は[公開手順](../docs/operations/jsr-publish.md)を参照する。

## 次の一手と承認境界

193の実装・test・review・review後のtmux最小実provider確認と、source commit・公式build・常用配置は
承認済みで実施した。配置後は隔離XDGのproduction TUIとlocal providerで再確認済み。
初版配置後の実providerへの追加呼び出しは行っていない。
最新の配色再調整はlocal修正・検証だけが承認対象で、commit・常用配置は別指示を受ける。
追加差分reviewと隔離production TUI確認は完了した。次は利用者の見た目の再確認。
常用binaryで確認するには、再調整のcommit・build・配置について別指示を受ける。
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
