# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-29）

**A25五sliceのlocal実装・各sliceのコード/テストreview・最終受入を完了。**
[Increment 153](../docs/increments/increment-153.md)がcompiled
TUI・親子tool・追加のSession継続/headless併走実測とfull gateの結果の正本。
検証用Core・tool・tmuxは終了済み。利用者が対応を完了承認し、文書更新・commit/push・常用配置を指示した。
現在は[合同配置記録](../docs/increments/a25-deployment-2026-09-29.md)の手順で配置作業中。
全体の順序と受入は[五slice実装計画](../docs/plans/a25-implementation-slices.md)を参照する。

**Increment 148の修正・検証・commit・push・常用配置・配置後確認を完了。**
最新binaryの起動ヘッダ欠落、working／elapsed欠落を修正した。利用者の追加指定によりworking／elapsedは
フッター二行目の先頭、Ctrl-Cはbusy中も入力クリア、cancelはEscとなる。
要件・実装・確認結果・配置情報・途中probeの外部request一回の記録は
[Increment 148](../docs/increments/increment-148.md)が正本。確認用Core・tmuxは停止済み。

常用binaryは`henji 0.7.0`、source `b4ac0b94…`、build `6118ba3b…`へ更新済み。
S22の8slice（139〜146）と147の配置結果は
[合同配置記録](../docs/increments/s22-deployment-2026-09-28.md)、利用方法は
[HTTP API](../docs/operations/http-api.md)を参照する。JSRは更新していない。

以前の完了承認と検証結果は[133〜138の個別increment](../docs/increments/)、
[133〜138合同E2E](../docs/increments/e2e-133-138-2026-09-27.md)、
[1〜132 E2E](../docs/increments/e2e-001-132-2026-09-27.md)、
[追加確認・stream配置結果](../docs/increments/e2e-001-132-followup-2026-09-27.md)を参照する。

## 次の一手

1. A25のcommit/push・clean build・常用配置・隔離tmux確認を完了し、配置記録とhandoffを更新する。
   これらは今回の追加指示で承認済み。構想・architecture・roadmapの意味変更とJSR公開は別承認。
2. 通常利用の新しい観測・未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)へ記録する。
   構想・architecture・roadmapの意味変更とJSR公開は未承認。S22の正本変更案は詳細設計へ残している。

## 承認境界

- A25の参照実装調査、gpt-6-astraへの比較相談とreview、実provider実測、複数Core案・実装計画の作成は指示済み・完了。
  五sliceのlocal実装・非破壊的検証・各slice後のreviewerによるコード/テストreviewは承認済み・完了。
  利用者が完了承認し、関連文書更新・commit/push・配置を追加指示済み。
  architecture/roadmapへの意味変更とJSR公開は別承認。
  詳細と証拠は[複数Core案](../docs/plans/a25-multiple-cores.md)を参照する。検証用Coreは停止済み。
- 148のlocal修正と非破壊的検証、commit／push／常用配置は指示済み・完了。
  配置前確認では`/home/agent`とrepository workspaceのCoreはともに非稼働。実行中の作業は中断しない。
  UIとCoreをまとめて終了するスラッシュコマンド案とsubagent起動判断は「メモだけ」の指示で
  通常利用メモへ記録した。同workspaceの複数Session同時実行は、後続のA25案整理を上記へ引き継ぐ。
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
