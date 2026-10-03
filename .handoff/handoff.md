# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

利用者の「セッションを完了する」により本セッションを終了した。進行中の作業はない。

[Increment 176](../docs/increments/increment-176.md)までのlocal実装・通常review・常用配置と
配置先production
TUI確認が完了した。配置版は172〜176を含む。commit/pushは未実施。
配置、build情報、通常review、確認結果は176を参照する。
起動中の常用Coreは変更しておらず、新しく起動するCoreから配置版が使われる。

## 次の一手

実使用でB8の元の失敗が再発した場合、拡充した短い診断と既存semantic履歴から原因を調べる。
元の原因は未確定で、追加の実probeは行わない。原観測と過去の4回のprobe結果は
[176の原観測](../docs/increments/increment-176.md#原観測診断調査)を参照する。
新しいincrementや追加修正には利用者の指示を待つ。

## 承認境界

- 2026-10-03の「では配置してB8の元の実失敗原因は実使用で観測したらでいい」で、
  通常review済みの174〜176の常用配置を承認。配置・配置先確認は実施済み。
  B8の元の原因調査は通常利用での再発観測に従う。
- 176のlocal失敗情報拡充と分類修正は「176を進めよう」で承認された。
  174／175は利用者の完了承認済み。172／173も常用配置・利用者確認済み。
- 承認済みの元B8実probeは初回と追加3回の計4回を実行済み。追加の実provider/model
  callは未承認。
- 利用者の「忘れてたコミットプッシュして」で172〜176のcommit/pushを承認。今回実行する。
  公開、実data削除は未承認。
- 構想・architecture・roadmapの意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)による別途承認が必要。

## 正本への入口

- [Increment 176](../docs/increments/increment-176.md):
  B8と共通診断拡充、原観測、review・配置結果。
- [Increment 175](../docs/increments/increment-175.md): B7の要件・計画・結果。
- [Increment 174](../docs/increments/increment-174.md): B6の要件・計画・結果。
- [Increment 173](../docs/increments/increment-173.md):
  共通credential登録と利用者確認。
- [Increment 172](../docs/increments/increment-172.md): Exa検索とweb_fetch
  download。
- [構想](../docs/concepts/experience-driven-self-revision.md):
  目的・Why・人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md):
  責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  provider/account/modelの境界。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [roadmap](../docs/roadmap.md): 機能・実装状態・未実装範囲。
