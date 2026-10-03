# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

[Increment 171](../docs/increments/increment-171.md)は利用者確認・完了承認済み（2026-10-03）。
8色を切り捨て256色を最低ラインとして、user行を黄色文字＋淡いグレー帯（行幅padding）、 見出しをbold
soft blueへ変更しgreenを廃止した。要件・検証・配置・完了承認の正本はincrement文書。 常用配置はsource
`26071a70`、build `0e41bf02…`。commit/push済み。
稼働中のCoreは停止せず保持し、新しいCore/TUIの起動から適用する。公開は未実施。

2026-10-03、利用者の「コミットプッシュして」により、Increment
171（実装`fdc2ae42`、記録`3ef29fd5`）を
origin/mainへpushした。169/170を含むmainの未送信commitも送信済み。公開は未実施。

[Increment 170](../docs/increments/increment-170.md)は2026-10-03の利用者の
「170は完了とします」により完了。実装・検証・常用配置、169を含むcommit `503a3f5f`と
origin/mainへのpushは実施済み。要件・検証・配置・完了承認の正本はincrement文書。
[Increment 169](../docs/increments/increment-169.md)のcommit/pushも170とともに実施済み。

## 次の一手

170は完了。次のincrementの採用と公開は利用者の指示に従う。
構想・architecture・roadmapは、170に記載した反映案の変更対象・理由・意味を別途提示し、
明示承認を得るまで変更しない。
未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)、未実装範囲は[roadmap](../docs/roadmap.md)を参照する。

## 承認境界

- 2026-10-03の「寝るから
  インクリメント可能な限り進めて」により、170の継続local作業・検証と最低限の実provider利用を承認。
  自然完了1回・途中cancel1回を実施し、追加実provider確認は終了した。
- slice単位の実装・test・通常／批判的reviewは承認済み。token利用枠に伴うS2停止は2026-10-03の再開指示で解除済み。
- 2026-10-03の「常用配置して」により検証済み169/170 binaryの常用配置を承認・実施済み。
- 2026-10-03の「ではまず
  170をコミットプッシュ」により、169を含む170までのcommit/pushを承認・実施済み。
- 2026-10-03の「170は完了とします」により、170の完了を承認。
- release/公開・実data削除、計画外機能の実装は未指示。
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
