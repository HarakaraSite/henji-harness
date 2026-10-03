# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

[Increment 171](../docs/increments/increment-171.md)は利用者確認・完了承認済み（2026-10-03）。
8色を切り捨て256色を最低ラインとして、user行を黄色文字＋淡いグレー帯（行幅padding）、
見出しをbold soft blueへ変更しgreenを廃止した。要件・検証・完了承認の正本はincrement文書。
sourceはcommit `fdc2ae42`、build IDは`e364a71f…`。commit/push済み。
常用配置・公開は未指示のため未実施。

2026-10-03、利用者の「コミットプッシュして」により、Increment 171（実装`fdc2ae42`、記録`3ef29fd5`）を
origin/mainへpushした。169/170を含むmainの未送信commitも送信済み。公開は未実施。

[Increment 170](../docs/increments/increment-170.md)のS1〜S4はlocal実装、focused検証、通常／批判的reviewと
採用指摘修正が完了。S5のcompiled
TUI/standalone/既存v7コピーと、実provider自然完了・途中cancelが成立した。
旧fixture差分と保存Session選択regressionも修正し、最終compiled候補とownerの最終gate（517件pass）を確認済み。
170のlocal実装・検証は完了。利用者の「常用配置して」により169/170を含む検証済みbuild
`94fd1fe9…`を常用配置済み。
配置先の隔離Core/TUI起動・editor・shutdownを確認した。169/170は利用者指示により
`503a3f5f`へcommitし、origin/mainへpush済み。
公開と利用者の完了承認は未実施。
実providerの予定2 requestsは実施済み。隔離standalone
probeの不完全なselection設定により、ダミーキーの
401外部requestが別途1回あり、170に記録した。詳細・結果・性能・証拠は170を参照する。

[Increment 169](../docs/increments/increment-169.md)も170とともに常用配置済み。 常用binaryはsource
`27f15428+dirty`、build `94fd1fe9…`。配置前の旧168 binaryは170の配置artifactへ退避した。
実config・Session・credential・既に起動中のCore/TUIは保持した。新しいCore/TUIの通常起動から適用する。

## 次の一手

170の常用動作を確認する際は新しいCore/TUIを起動する。
169/170のcommit/pushは完了。171の常用配置・commit/push、完了承認・公開は利用者の指示に従う。
構想・architecture・roadmapは、170に記載した反映案の変更対象・理由・意味を別途提示し、
明示承認を得るまで変更しない。
未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)、未実装範囲は[roadmap](../docs/roadmap.md)を参照する。

## 承認境界

- 2026-10-03の「寝るから
  インクリメント可能な限り進めて」により、170の継続local作業・検証と最低限の実provider利用を承認。
  自然完了1回・途中cancel1回を実施し、追加実provider確認は終了した。
- slice単位の実装・test・通常／批判的reviewは承認済み。token利用枠に伴うS2停止は2026-10-03の再開指示で解除済み。
- 2026-10-03の「常用配置して」により検証済み169/170 binaryの常用配置を承認・実施済み。
- 2026-10-03の「ではまず 170をコミットプッシュ」により、169を含む170までのcommit/pushを承認・実施済み。
  171のcommit/push・常用配置、release/公開・実data削除、計画外機能の実装は未指示。
- 構想・architecture・roadmapの意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)による別途承認が必要。

## 正本への入口

- [Increment 170](../docs/increments/increment-170.md):
  採用要件、slice計画、レビューと実装・検証結果、反映案。
- [Increment 169](../docs/increments/increment-169.md): provider failureへの軽いrecall案内。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的・Why・人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md):
  責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  provider/account/modelの境界。
- [実provider観測](../docs/research/a28-real-provider-observation-2026-10-02.md):
  旧run-2のbaseline。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [roadmap](../docs/roadmap.md): 機能・実装状態・未実装範囲。
