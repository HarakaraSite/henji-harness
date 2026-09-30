# Handoff

再開時の入口。現在地と次の一手をここで確認し、要件・計画・結果はリンク先の正本を参照する。

## 現在地（2026-09-30）

**[Increment 160](../docs/increments/increment-160.md)としてミニマルなフッターデザインを採用。**
local実装・検証・commit/push・常用配置・配置後の隔離TUI確認完了。
利用者確認・完了承認は未取得。結果・検証証拠はincrement正本を参照する。

常用binaryは`henji 0.7.0`、source `9359337d…`、build `d8afc403…`へ更新済み。
新規TUI起動から適用する。配置前のHenjiプロセス2件を保持し、確認用Core/TUI/tmuxは終了した。

**[Increment 159](../docs/increments/increment-159.md)は利用者確認・完了承認済み（2026-09-30）。**
Slice 2/3の採用findingを修正し、限定re-reviewで解消。残るBlocker/P1/P2は0。
四slice実装・検証・review・commit/push・常用配置・配置後の隔離TUI操作確認は完了。要件・結果はincrement正本を参照する。
確認用Core/TUI/tmuxは終了、credential参照は解除済み。既存Henjiプロセス二件・実configは保持し、常用binaryを更新した。

**[Increment 158](../docs/increments/increment-158.md)のlocal実装・検証・commit/push・常用配置完了。**
フッター2・3行目の区切りとprovider/modelラベル省略を実装し、compiled production TUIで確認済み。
利用者確認・increment完了承認は未取得。配置後の操作確認は利用者指定により省略した。
検証経路と結果はincrement正本を参照する。確認用Core/TUI/tmuxは終了済み。

**E6の[Increment 157](../docs/increments/increment-157.md)は利用者確認・完了承認済み。**
2026-09-29、利用者の確認と指示によりincrement完了・関連文書更新・セッション終了。
取得中overlay削除とGo暫定カタログ方式を含む要件・検証・review・配置結果はincrement正本を参照する。
確認用Core/TUI/tmuxは終了済み。常用配置を保持し、既存Core三つの停止・移行は行わない。

**S15の[Increment 156](../docs/increments/increment-156.md)は利用者確認・完了承認済み。**
2026-09-29、利用者のEsc確認と指示によりincrement完了・セッション終了。
要件・TUI分離後の経路・検証・commit/push・常用配置・配置後確認はincrement正本を参照する。
確認用Core/TUI/tmuxは終了済み。
既存Core二つは保持した。追加指示による/tmp清掃と証拠の通常ディスク移動も完了。

**S25の[Increment 155](../docs/increments/increment-155.md)は利用者確認・完了承認済み。**
2026-09-29、利用者の指示によりincrement完了・セッション終了。
実装・検証・reviewer通常レビュー・commit/push・常用配置・配置後確認の結果はincrement正本を参照する。
確認用Core/TUI/tmuxは終了済み。既存Core二つは保持し、再接続URLはincrementの配置節を参照する。
JSR公開は未指示。

**S17・S18・S19の[Increment 154](../docs/increments/increment-154.md)は利用者確認・完了承認済み。**
2026-09-29、利用者の指示によりincrement完了・セッション終了。
変更前後の実測、隔離tmuxのsource/compiled実経路、コード/testの通常・批判的reviewを完了した。
採用P1二件を修正し、両限定re-reviewはBlocking 0／P1
0。結果・実測・未確認事項はincrement正本を参照する。
追加指示によりcommit/push・常用配置・配置後確認も完了。確認用Core/TUI/tmuxは終了済み。
既存Core二つは保持し、再接続URLはincrementの配置節を参照する。

**A25五sliceの実装・各slice/全体review・E2E・commit/push・常用配置・配置後確認を完了。**
[Increment 153](../docs/increments/increment-153.md)がcompiled
TUI・親子tool・追加のSession継続/headless併走実測とfull gateの結果の正本。
検証用Core・tool・tmuxは終了済み。配置identityと確認結果は
[合同配置記録](../docs/increments/a25-deployment-2026-09-29.md)を参照する。
配置時点で稼働していた旧Coreは停止せず保持した。再接続URLも合同配置記録を参照する。
全体の順序と受入は[五slice実装計画](../docs/plans/a25-implementation-slices.md)を参照する。

**Increment 148の修正・検証・commit・push・常用配置・配置後確認を完了。**
最新binaryの起動ヘッダ欠落、working／elapsed欠落を修正した。利用者の追加指定によりworking／elapsedは
フッター二行目の先頭、Ctrl-Cはbusy中も入力クリア、cancelはEscとなる。
要件・実装・確認結果・配置情報・途中probeの外部request一回の記録は
[Increment 148](../docs/increments/increment-148.md)が正本。確認用Core・tmuxは停止済み。

Goは両外部宣言のカタログ方式へ更新し、Chat側へQwen3.8 Maxを追加済み。新規Coreから適用する。
通常起動は毎回新Core・Session。再接続は`henji --core ID`または`--connect URL`で明示する。
S22の8slice（139〜146）と147の配置結果は
[合同配置記録](../docs/increments/s22-deployment-2026-09-28.md)、利用方法は
[HTTP API](../docs/operations/http-api.md)を参照する。JSRは更新していない。

以前の完了承認と検証結果は[133〜138の個別increment](../docs/increments/)、
[133〜138合同E2E](../docs/increments/e2e-133-138-2026-09-27.md)、
[1〜132 E2E](../docs/increments/e2e-001-132-2026-09-27.md)、
[追加確認・stream配置結果](../docs/increments/e2e-001-132-followup-2026-09-27.md)を参照する。

## 次の一手

[Increment 160](../docs/increments/increment-160.md)の利用者による表示確認・increment完了承認を待つ。
新しい未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)へ記録する。

## 承認境界

- Increment 160は利用者の「1でミニマルにしようかな　次のインクリメントはそれで」により採用。
  追加指示「実装して」によるlocal実装・非破壊的検証は完了。
  追加指示「コミットプッシュ配置をして」によるcommit/push・常用配置・配置後確認は完了。
  公開・外部provider確認は未指示。
  正本は[Increment 160](../docs/increments/increment-160.md)。

- Increment 159は利用者指示により案review・四slice計画・reviewerの通常／批判的計画review完了。
  実装時はsliceごとのreviewerコード・test reviewと最小実provider確認が承認済み。正本は
  [Increment 159](../docs/increments/increment-159.md)。
  具体的な実provider確認の対象・見込み回数・保存先を報告して進め、同じ最小確認の再承認は不要。
  追加指示による四sliceのlocal実装・非破壊的検証・各slice reviewは完了。
  commit/push・常用配置は2026-09-30の追加指示により承認済み・完了。利用者確認・increment完了承認も同日に取得した。構想・architecture・roadmapの変更は未指示。

- Increment 158のlocal表示修正と非破壊的検証は今回の指示で承認済み・完了。
  正本は[Increment 158](../docs/increments/increment-158.md)。
  追加指示によるcommit/push・常用配置とbinary同一性確認は完了。配置後の操作確認は利用者指定により省略した。
  公開は未指示。 構想・architecture・roadmapは変更不要。

- E6の要件整理・計画作成は指示済み。正本は[Increment 157](../docs/increments/increment-157.md)。
  実装、実provider確認、その後の通常reviewは承認済み。対象・回数・保存先は確認前に提示する。
  commit/push・常用配置と配置後確認は追加指示に従い完了。
  利用者確認・increment完了承認済み。関連文書更新とセッション終了は指示済み。
  最後の配置指示に伴う追加の動作確認は利用者が不要と指定した。Product正本の意味変更は別承認。

- S15のlocal実装・非破壊的検証は今回の指示で承認済み。正本は[Increment 156](../docs/increments/increment-156.md)。
  追加指示によるcommit/push・常用配置・配置後確認と/tmp清掃は完了。
  利用者のEsc確認・increment完了承認済み。公開と構想・architecture・roadmapの変更は未指示。

- S25のlocal実装・非破壊的検証は今回の指示で承認済み。追加指示により`/exit`を`/detach`へ改名し、
  スラッシュ＋最初の文字から候補を案内する。正本は[Increment 155](../docs/increments/increment-155.md)。
  通常reviewと、追加指示に基づくcommit/push・常用配置・配置後確認は完了。
  利用者確認・increment完了承認済み。 JSR公開、構想・architecture・roadmapの意味変更は未指示。

- S17・S18・S19の調査、統合案作成とgpt-6-astraによる案review、計画作成とreviewerによる通常/批判的reviewは指示済み。
  local実装、計画の実測/非破壊的実経路検証、実装後コード/test reviewは追加指示済み。
  commit/push・常用配置と配置後確認は追加指示済み・完了。利用者確認・increment完了承認済み。
  JSR公開は未指示。 正本は[Increment 154](../docs/increments/increment-154.md)。
- A25の参照実装調査、gpt-6-astraへの比較相談とreview、実provider実測、複数Core案・実装計画の作成は指示済み・完了。
  五sliceのlocal実装・非破壊的検証・各slice後のreviewerによるコード/テストreviewは承認済み・完了。
  利用者の完了承認・関連文書更新・commit/push・配置指示に従い、すべて完了。
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
- [通常利用メモ](../docs/experience/normal-use-inbox.md):
  未採用候補。S20、A15等はここ、S17〜S19はIncrement 154。
- [個別increment](../docs/increments/): 採用済みの要件・計画・検証・配置・公開結果。
- [公開手順](../docs/operations/jsr-publish.md): JSR公開時の操作。
- [整理前のhandoff記録](../docs/history/handoff-through-2026-09-26.md): 過去の証拠のみ。

状態が変わったら該当箇所を置き換える。計画・検証詳細・完了履歴をここへ積み増さない。
