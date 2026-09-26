# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-26）

**Increment 133の実装・配置・公開後、入力欠落の解消を常用利用で継続観測する段階。
次のincrementは未選択・実装未指示。**

- 常用binaryは`henji 0.7.0`、source `f10893ba…`、build `36e27ab6…`。
  今回の`henji --version`確認でも一致。配置後のbinaryは次回起動から使われ、既存プロセスの切替は
  行っていない。JSR 0.7.0公開と確認も完了。詳細は
  [Increment 133の配置・公開結果](../docs/increments/increment-133.md#commitpush常用binary配置)。
- 通常利用メモとproduct正本文書の見直しは完了。承認された自己改訂構想の変更と Increment
  133のarchitecture・roadmap反映は済んでいる。候補の記載は実装認可を意味しない。

## 次の一手

1. 利用者の指定どおり、常用利用で同一プロセスの入力・貼り付けの欠落解消を観測する。
   簡単には再現できないため、直接操作の再現試験を先行必須条件にはしない。
   観測を得たら[Increment 133](../docs/increments/increment-133.md#残る受入と承認境界)へ記録する。
2. 次の開発に進む場合は、[通常利用メモ](../docs/experience/normal-use-inbox.md)と
   [roadmap「自己改訂を支える次の増分」](../docs/roadmap.md#自己改訂を支える次の増分)を入口に、
   利用者が選んだ動作を個別incrementへ採用する。現在、選択済みの次incrementはない。

## 未完了・再開対象

- **Increment 133の常用での入力欠落解消**: 継続観測中。配置・公開、自動操作の成功だけでは
  受入済みとしない。正本は[Increment 133](../docs/increments/increment-133.md)。
- **Increment 132の要件C（長時間利用時の数秒の入力・履歴操作遅延）**: 未再現・未完了。
  利用者指示で計測は終了済み。A・Bの逐次表示実装は0.7.0に含まれ、配置・push済み。
  新binaryでの実provider確認は未実施。正本は
  [Increment 132](../docs/increments/increment-132.md#m3-c要件c2026-09-26終了時点-未再現未完了)。
  Increment 133の入力競合修正でC全体を完了扱いにしない。

## 承認境界

- 実provider probeは、対象・回数・保存先を提示して別途明示承認を得る。
- 旧Git chainの恒久終了は未承認。診断時のHenji PID `200048`／Git reader PID `202890`は
  今回の`ps`確認ではともに不在。今回、プロセスへの操作は行っていない。
- 次incrementの採用・実装、新たな外部書き込み・配置・公開は利用者の指示に従う。
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
