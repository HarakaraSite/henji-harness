# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-27）

**Increment 133〜138は2026-09-27に利用者がすべて完了と明示した。**
各incrementの要件・検証・完了承認は[個別increment文書](../docs/increments/)を参照する。
133〜138の配置binary基本確認は[合同E2E記録](../docs/increments/e2e-133-138-2026-09-27.md)、
138の起動失敗修正と配置後の実MiMo flash確認は
[追加対応結果](../docs/increments/increment-138.md#追加対応のcommitpush常用配置と実provider確認2026-09-27)が正本。
次のincrementは未指定。利用者は1〜132由来の現行機能について、配置binary・実providerの
基本E2Eを機能ブロック別に行うよう依頼した。
[1〜132 E2E](../docs/increments/e2e-001-132-2026-09-27.md)は全9ブロック実施済み。
[追加確認結果](../docs/increments/e2e-001-132-followup-2026-09-27.md)でGoの試験宣言不備を特定し、通常宣言の直接経路は成立。
streamはlocal修正・候補binary確認済み、常用配置は未実施。
利用者の指示に基づき、increment文書の古い未完了表示を現行証拠へ合わせて更新した。
132も「再現を受けて133を対応した」という利用者判断で完了。

- 常用binaryは`henji 0.7.0`、source `3878ffcd…`、build `cfbfd683…`（138の起動失敗修正）。
  配置結果と実provider確認は
  [Increment 138](../docs/increments/increment-138.md#追加対応のcommitpush常用配置と実provider確認2026-09-27)を参照する。
  JSRは今回更新しておらず、0.7.0の公開内容は
  [Increment 133](../docs/increments/increment-133.md#commitpush常用binary配置)時点のままである。
- 通常利用メモとproduct正本文書の見直しは完了。承認された自己改訂構想の変更と Increment
  133のarchitecture・roadmap反映は済んでいる。候補の記載は実装認可を意味しない。

## 次の一手

1. stream追加修正はlocal実装・検証完了。利用者がcommit・push・常用配置を追加指示し、実施中。
   [追加確認結果](../docs/increments/e2e-001-132-followup-2026-09-27.md)を参照する。
   次のincrementは利用者の指定待ち。

2. 通常利用で新しい観測や改善候補が得られた場合は、
   [通常利用メモ](../docs/experience/normal-use-inbox.md)へ記録する。
   133の常用入力観測は133の完了待ち項目にはしない。

## 配置待ち

- [Increment 104のstream追加修正](../docs/increments/increment-104.md):
  local実装・検証完了、常用binaryは未配置。
- 132は利用者の明示判断で完了。経緯は[132の完了判断](../docs/increments/increment-132.md#現行状態の完了判断2026-09-27)を参照する。

## 承認境界

- 133〜138の完了承認は取得済み。各incrementの実施結果・未確認事項は正本文書を参照する。
  追加の実provider probe・公開・計画外の変更は今回の完了承認には含めない。
  実運用configへの`/login`登録は利用者の通常操作として残る。
- 1〜132
  E2Eは計画作成済み。基本・最小case、両API、最新仕様のみという範囲と、検索Sonar一回を確認済み。
  各ブロックの対象・予定量・保存先と実行結果は計画参照。実行は2026-09-27に明示承認済み・実施済み。
  Agent自身の参照再実行とstream local修正・確認は追加指示済み・実施済み。 Go HTTP
  400再現性確認と原因調査probeは利用者指示済み・実施済み。Goのproduction修正は不要。 reasoning
  wire追加probe・公開は未指示。stream修正と文書更新のcommit・push・常用配置は追加指示済み。
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
