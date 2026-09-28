# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-28）

**現在地: S22の8sliceとIncrement 147のlocal実装・検証・独立reviewを完了。
利用者のセッション終了指示に基づき、文書更新・commit・push・常用配置を実施中。**
要件・計画・結果は[Increment 147](../docs/increments/increment-147.md)が正本。
通常入口切替と最終binary・review結果は[Increment 146](../docs/increments/increment-146.md)、
各sliceの要件・計画・結果は[個別increment文書](../docs/increments/)が正本。
利用者の追加指示による全体reviewの結果は
[/tmpのreview結果](/tmp/henji-s22-overall-review-none-probe/review-result.md)と
[最小実行証拠](/tmp/henji-s22-overall-review-none-probe/result.json)を参照する。
操作方法は[HTTP API](../docs/operations/http-api.md)を参照する。
workspaceの既存未commit変更・未追跡fileを保持する。HEADは`c4da8f7956d5152f739c868c38f6ca25f1903388`。
commit／push／常用binary配置は利用者が2026-09-28に明示指示した。
現在の配置結果は[合同配置記録](../docs/increments/s22-deployment-2026-09-28.md)を参照する。

**Increment 133〜138は2026-09-27に利用者がすべて完了と明示した。**
各incrementの要件・検証・完了承認は[個別increment文書](../docs/increments/)を参照する。
133〜138の配置binary基本確認は[合同E2E記録](../docs/increments/e2e-133-138-2026-09-27.md)、
138の起動失敗修正と配置後の実MiMo flash確認は
[追加対応結果](../docs/increments/increment-138.md#追加対応のcommitpush常用配置と実provider確認2026-09-27)が正本。
利用者は1〜132由来の現行機能について、配置binary・実providerの
基本E2Eを機能ブロック別に行うよう依頼した。
[1〜132 E2E](../docs/increments/e2e-001-132-2026-09-27.md)は全9ブロック実施済み。
[追加確認結果](../docs/increments/e2e-001-132-followup-2026-09-27.md)でGoの試験宣言不備を特定し、通常宣言の直接経路は成立。
streamは修正・候補binary確認・commit・push・常用配置完了。
利用者の指示に基づき、increment文書の古い未完了表示を現行証拠へ合わせて更新した。
132も「再現を受けて133を対応した」という利用者判断で完了。

- 常用binaryは`henji 0.7.0`、source `1d7e0bb6…`、build `41d37741…`（stream末尾欠落修正）。
  配置結果と実provider確認は
  [stream配置結果](../docs/increments/e2e-001-132-followup-2026-09-27.md#stream修正のcommitpush常用配置2026-09-27)を参照する。
  JSRは今回更新しておらず、0.7.0の公開内容は
  [Increment 133](../docs/increments/increment-133.md#commitpush常用binary配置)時点のままである。
- 通常利用メモとproduct正本文書の見直しは完了。承認された自己改訂構想の変更と Increment
  133のarchitecture・roadmap反映は済んでいる。候補の記載は実装認可を意味しない。

## 次の一手

1. [合同配置記録](../docs/increments/s22-deployment-2026-09-28.md)に従ってcommit・push・常用配置と終了記録を完了する。
   JSR公開とarchitecture・roadmapの意味変更には別途明示承認が必要。
   要件は[詳細設計](../docs/plans/s22-detailed-design-and-slices.md)、[CLI・外部API設計](../docs/plans/s22-cli-and-external-api.md)を参照する。
2. 通常利用で新しい観測や改善候補が得られた場合は、
   [通常利用メモ](../docs/experience/normal-use-inbox.md)へ記録する。
   133の常用入力観測は133の完了待ち項目にはしない。B6は利用者が修正を指示し、147へ採用した。

## 承認境界

- S22の議論の文書化、参照実装調査、詳細設計・slice分割計画の作成、review指摘への設計修正は指示済み。
  通常henjiを明示TUI起動の省略形とし、未起動coreを自動起動する。
  core単独起動のサードパーティ接続、WebUI別入口という利用者指定とCLI形式の委任を反映した。
  8sliceのlocal実装と各sliceのコード・test第三者reviewは指示済み。
  実provider確認は利用者が以降すべて承認した。少量の確認は追加承認なしで進める。
  20前後など多くのstep・turnを伴う場合は実行前に対象と見込み量を報告する。 Slice
  1の実provider確認結果と保存先は[Increment 139](../docs/increments/increment-139.md)を参照する。
  commit／push／常用配置はセッション終了に伴う2026-09-28の明示指示で承認済み。
  architecture・roadmapの意味変更とJSR公開は未承認。
  内容は[詳細設計・slice計画](../docs/plans/s22-detailed-design-and-slices.md)を参照。
- 全体reviewで確認したP1／B6のlocal修正と、その周辺のBlocking／P1／P2追加reviewは指示済み。
  採用結果は[Increment 147](../docs/increments/increment-147.md)を参照する。
- 133〜138の完了承認は取得済み。各incrementの実施結果・未確認事項は正本文書を参照する。
  追加の実provider probe・公開・計画外の変更は今回の完了承認には含めない。
  実運用configへの`/login`登録は利用者の通常操作として残る。
- 1〜132
  E2Eは計画作成済み。基本・最小case、両API、最新仕様のみという範囲と、検索Sonar一回を確認済み。
  各ブロックの対象・予定量・保存先と実行結果は計画参照。実行は2026-09-27に明示承認済み・実施済み。
  Agent自身の参照再実行とstream local修正・確認は追加指示済み・実施済み。 Go HTTP
  400再現性確認と原因調査probeは利用者指示済み・実施済み。Goのproduction修正は不要。 reasoning
  wire追加probe・公開は未指示。stream修正と文書更新のcommit・push・常用配置は追加指示済み・完了。
- 旧Git chainの恒久終了は未承認。診断時のHenji PID `200048`／Git reader PID `202890`は
  今回の`ps`確認ではともに不在。今回、プロセスへの操作は行っていない。
- Increment 134のlocal実装、architecture・roadmap反映、対象workspaceの既存DB削除は指示済み・完了。
  commit・push・常用binary配置も指示済み・完了。JSR公開は未指示。
- 構想・architecture・roadmapの新たな意味変更は、対象・理由・変更内容を提示して別途明示承認を得る。
  詳細は[AGENTS.md](../AGENTS.md#product正本の変更承認)。

## 正本への入口

- [構想](../docs/concepts/experience-driven-self-revision.md): productの目的と人間による採用境界。
- [architecture](../docs/architecture/henji-host-agent-worker.md): 責務・状態所有・component境界。
- [roadmap](../docs/roadmap.md): 必要機能・実装状態・未実装範囲。
- [通常利用メモ](../docs/experience/normal-use-inbox.md): 未採用候補。S17〜S20、A15等もここにある。
- [個別increment](../docs/increments/): 採用済みの要件・計画・検証・配置・公開結果。
- [公開手順](../docs/operations/jsr-publish.md): JSR公開時の操作。
- [整理前のhandoff記録](../docs/history/handoff-through-2026-09-26.md): 過去の証拠のみ。

状態が変わったら該当箇所を置き換える。計画・検証詳細・完了履歴をここへ積み増さない。
