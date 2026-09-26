# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-27）

**次のincrementは135（S2: Henji内credential登録）。キーの保管場所を維持して登録入口を追加する。
実装・focused test・review・production tmux確認・`v0:gate`・commit／push・常用binary配置まで完了。
常用binaryは`henji 0.7.0`、source `52e84069…`、build `426d8917…`。
正本は[Increment 135](../docs/increments/increment-135.md#実装確認結果)。 Increment
134は実装・正本反映・配置まで完了。Increment 133の入力欠落解消は常用利用で継続観測中。**

- 常用binaryは`henji 0.7.0`、source `ca25d23b…`、build `aeaad975…`。
  配置後のversion・binary一致と隔離v11 DBのproduction経路を確認済み。次回起動から新方式を使う。
  結果は[Increment 134の配置結果](../docs/increments/increment-134.md#commitpush常用binary配置)を参照する。
  JSRは今回更新しておらず、0.7.0の公開内容は
  [Increment 133](../docs/increments/increment-133.md#commitpush常用binary配置)時点のままである。
- 通常利用メモとproduct正本文書の見直しは完了。承認された自己改訂構想の変更と Increment
  133のarchitecture・roadmap反映は済んでいる。候補の記載は実装認可を意味しない。

## 次の一手

1. [Increment 135の実装・確認結果](../docs/increments/increment-135.md#実装確認結果)を確認し、
   残る判断（JSR公開の可否、実provider受理確認の承認、
   `docs/operations/base-instruction-template.md`の外部変更の採否）を利用者に確認する。
2. 利用者の指定どおり、常用利用で同一プロセスの入力・貼り付けの欠落解消を観測する。
   簡単には再現できないため、直接操作の再現試験を先行必須条件にはしない。
   観測を得たら[Increment 133](../docs/increments/increment-133.md#残る受入と承認境界)へ記録する。
   次の通常利用は新規v11 DBで行う。

## 未完了・再開対象

- **Increment 133の常用での入力欠落解消**: 継続観測中。配置・公開、自動操作の成功だけでは
  受入済みとしない。正本は[Increment 133](../docs/increments/increment-133.md)。
- **Increment 132の要件C（長時間利用時の数秒の入力・履歴操作遅延）**: 未再現・未完了。
  利用者指示で計測は終了済み。A・Bの逐次表示実装は0.7.0に含まれ、配置・push済み。
  新binaryでの実provider確認は未実施。正本は
  [Increment 132](../docs/increments/increment-132.md#m3-c要件c2026-09-26終了時点-未再現未完了)。
  Increment 133の入力競合修正でC全体を完了扱いにしない。

## 承認境界

- Increment 135は実装・focused検証・隔離XDGでのproduction tmux確認・`v0:gate`・commit／push・
  常用binary配置まで実施済み。JSR公開、実provider call、実運用credentialの登録・上書きは未指示。
  実運用の`~/.config/henji-harness/openrouter-api-key`は読取確認のみで上書きしていない。
- Increment 134の実provider確認は利用者承認を受け、指定した2turnを実施済み。 新しい実provider
  probeは、対象・回数・保存先を提示して別途明示承認を得る。
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
