# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。

## 現在地（2026-10-03）

利用者の最新モデル固定記載と公式effort反映の指示により、
[Increment 178](../docs/increments/increment-178.md)のlocal実装・確認、常用配置と配置先TUI確認が完了した。
`openai-chatgpt`に`gpt-6.1-sol`と`gpt-6-luna`を固定候補として追加し、隔離XDGの production source
TUIで選択とeffort変更を確認済み。配置版は177・178を含む。

利用者の未使用コード・旧経路テスト除去、参照のないexport削除、`v0:test`整備の指示により、
[Increment 177](../docs/increments/increment-177.md)のlocal実装・検証が完了した。
追加指示によるJSR収録漏れ5 fileのinclude追加と依存graph確認も完了し、178と一緒に常用配置した。
配置、build情報と配置先確認は178を参照する。177・178のcommit/pushは追加承認済みで、送信作業中。

[Increment 176](../docs/increments/increment-176.md)までのlocal実装・通常review・常用配置と
配置先production TUI確認が完了した。配置版は172〜176を含む。実装commit
`c9b5d9d6`を`origin/main`へpush済み。 配置、build情報、通常review、確認結果は176を参照する。
起動中の常用Coreは変更しておらず、新しく起動するCoreから配置版が使われる。

## 次の一手

利用者の「コミットプッシュはしよう」に従い、177・178と関連記録をcommitし、`origin/main`へpushする。
最新モデルの根拠・実装・確認は178、未使用除去とJSR収録漏れ修正は177を参照する。
B8の元の原因は引き続き未確定で、実使用で再発した際に
拡充した診断と既存semantic履歴から調べる方針は[176](../docs/increments/increment-176.md)を維持する。

## 承認境界

- 178の2モデル固定記載、公式effort反映、local検証は承認済み・実施済み。
  承認された直接指定probeの結果は178の資料pointerを参照する。
  「その後配置して」による177・178の常用配置と配置先確認は実施済み。
  178のcommit/pushは「コミットプッシュはしよう」で追加承認済み。追加の実provider
  call、公開は未承認。
- 177のlocal source・test・task/package includeと記録の変更、非破壊的local検証は承認済み。
  177のcommit/pushも同じ追加指示で承認済み。実provider call、公開、実data削除は未承認。
- 2026-10-03の「では配置してB8の元の実失敗原因は実使用で観測したらでいい」で、
  通常review済みの174〜176の常用配置を承認。配置・配置先確認は実施済み。
  B8の元の原因調査は通常利用での再発観測に従う。
- 176のlocal失敗情報拡充と分類修正は「176を進めよう」で承認された。
  174／175は利用者の完了承認済み。172／173も常用配置・利用者確認済み。
- 承認済みの元B8実probeは初回と追加3回の計4回を実行済み。追加の実provider/model callは未承認。
- 利用者の「忘れてたコミットプッシュして」で172〜176のcommit/pushを承認。実装のpushは完了した。
  完了状態の文書更新も同じ送信先へcommit/pushする。 公開、実data削除は未承認。
- 構想・architecture・roadmapの意味変更は[AGENTS.md](../AGENTS.md#product正本の変更承認)による別途承認が必要。

## 正本への入口

- [Increment 178](../docs/increments/increment-178.md):
  ChatGPT最新2モデルの固定候補と公式effort、probe・TUI確認。
- [Increment 177](../docs/increments/increment-177.md):
  未使用実装と旧testの撤去、通常test入口の整備。
- [Increment 176](../docs/increments/increment-176.md): B8と共通診断拡充、原観測、review・配置結果。
- [Increment 175](../docs/increments/increment-175.md): B7の要件・計画・結果。
- [Increment 174](../docs/increments/increment-174.md): B6の要件・計画・結果。
- [Increment 173](../docs/increments/increment-173.md): 共通credential登録と利用者確認。
- [Increment 172](../docs/increments/increment-172.md): Exa検索とweb_fetch download。
- [構想](../docs/concepts/experience-driven-self-revision.md): 目的・Why・人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md):
  責務・状態所有・component境界。
- [Provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  provider/account/modelの境界。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。
- [roadmap](../docs/roadmap.md): 機能・実装状態・未実装範囲。
