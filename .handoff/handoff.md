# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-10-01）

Increment 168まで完了。利用者の「同期して168まで完了してるし」により完了承認を記録した。
構想・Host/Worker architecture・provider/auth architecture・roadmapを168完了時点のsourceへ同期した。
通常利用メモのA10とS8は利用者指示で削除済み。

常用配置は[Increment 168](../docs/increments/increment-168.md)のsource `a692c10a`、build `4db6bd68…`。
配置の適用はTUIを開き直す。既存Core・Session・credentialは保持している。
168までの実装commitのpushは完了。JSR公開済み版は`@henji/harness@0.8.0`で、
その後の167・168は常用配置済み・追加公開未実施。
今回の正本同期と完了記録、およびA10/S8削除はlocal文書変更である。

## 次の一手

採用済みincrementの残作業はない。次の対象は利用者の指示に従う。
未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)、機能の未実装範囲は
[roadmap](../docs/roadmap.md)を参照する。

## 承認境界

- 168までの完了承認と、構想・architecture・roadmapの現行sourceへの同期は指示済み。
- 今回の文書同期のcommit/push・公開、追加provider probe、計画外の実装、実data削除は未指示。
- 正本の新たな意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)に従う。

## 正本への入口

- [構想](../docs/concepts/experience-driven-self-revision.md): productの目的と人間による採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md): 責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md): route、model一覧、認証、account/replay境界。
- [roadmap](../docs/roadmap.md): 必要機能・実装状態・未実装範囲。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [個別increment](../docs/increments/): 採用済みの要件・計画・検証・配置・完了承認。
- [公開手順](../docs/operations/jsr-publish.md): JSR公開時の操作。

状態が変わったら該当箇所を置き換える。計画・検証詳細・完了履歴をここへ積み増さない。
