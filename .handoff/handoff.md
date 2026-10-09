# Handoff

再開時の入口。現在地・次の一手・正本へのpointer・承認境界だけを保持する。
計画・結果・完了履歴は担当正本を参照する。

## 現在地（2026-10-09）

- [Increment 218](../docs/increments/increment-218.md)が現在の作業正本。
  S1〜S7の実装・focused確認・独立review指摘対応と、S8のlocalhost統合確認を終えた。
  修正候補の200turn×3＋保存Sessionの新Core再開20turn、全620turn/1,240requestの照合は成功。
  メモリの初期判断線を満たしたが、20turn以降のRSS増加は残る。結果・未確認・gateの既存6失敗は
  [218第11.12節](../docs/increments/increment-218.md#1112-本実装のlocalhost統合結果と停止位置2026-10-09)と
  [報告書](../docs/research/increment-218-main-memory-2026-10-09.md)を参照する。
  続く全体の通常/批判的reviewで採用したP2 3件を修正し、focused
  11/11、type/format/lintと
  限定re-reviewで解消確認済み。最新状態は218第11.13節。200turn測定は修正前の候補に対応する。
  修正後binaryを `.tools/increment-218-review-fixes/henji` へcompile済み（build
  `a636af89…`）。
  続く明示許可で実providerの基本e2eを4turn実施し成功。結果は218第11.14節。
  基本e2eの実requestは成功6＋隔離設定の準備漏れ1の計7。続く同時計測の指示で最新sourceの
  同じSession/Workerの実provider20turn・21requestを一回実施した。結果は218第11.15節と
  [実providerメモリ報告書](../docs/research/increment-218-real-provider-memory-2026-10-09.md)。
  実装・test・結果は利用者指示による、この記録を含むcommitへ保存した。実DBコピー/切替、常用配置、pushは未実施。
- 利用者判断により217までの既存incrementを一律完了とした。209〜217の冒頭へ完了状態を追記し、
  208以前の2026-10-07完了記録は保持した。各作業時点の実施・未実施記録は現在の残作業として扱わない。
  要件・結果は各increment、文書への入口は[索引](../docs/increments/README.md)を参照する。
- [Increment 217](../docs/increments/increment-217.md)に、214〜217適用後のcompiled
  Core/TUIメモリ観測と
  利用者指示による常用配置の結果を追記した。詳細な条件・結果・未確認範囲は217を参照する。
- 常用binaryはHenji 0.11.0、clean source `6315beed`、build `199c3937…`。
  `dist/henji`と常用binaryへ配置し、配置binaryの隔離Worker/TUI確認を完了した。
  既存の稼働Core/TUIは再起動していない。新しいCore/TUI起動から適用する。
  退避先と検証結果は[配置記録](../docs/operations/native-0.11.0-deployment.md)を参照する。
- 217までの実装sourceは`6315beed`までorigin/mainへpush済み。217の完了・メモリ観測・配置記録と、
  通常利用メモのA37・A38（searchの`!`除外とmode命名）はcommit済み。
  218の実装・test・結果を加え、origin/mainより3commit先。pushは未実施。
  別件の通常利用メモS4（`/reload`）更新は未commitで保全する。
  未追跡`191-result.json`と`scripts/diagnostics/__pycache__/`は保全し、commit対象外。

## 次の一手

- 218のlocalhost確認・全体review指摘対応・実provider基本e2e・最新source20turnメモリ同時計測は記録済み。
  218の受入判断/実DB操作/配置/pushは利用者指示に従う。基本e2eは
  `.tools/increment-218-basic-e2e/`、20turn同時計測は
  `.tools/increment-218-real-memory/`。
  実負荷はread一回＋19会話。旧準備案の毎turn
  read/15＋再開5とは区別し、追加runは行っていない。
  217以前に未完了作業はない。architecture/roadmapは218第12節の案を別途承認してから反映する。
- 未採用候補は[通常利用メモ](../docs/experience/normal-use-inbox.md)を参照する。
  記載だけでは採用・実装を開始しない。過去incrementの未実施記録を新しい必須作業へ戻さない。
- [開発ワークフロー案](../docs/plans/development-workflow.md)は未採用。採用までは作業ルールとして適用しない。

## 正本への入口

- [構想](../docs/concepts/experience-driven-self-revision.md):
  目的と人間の採用境界。
- [Host/Worker architecture](../docs/architecture/henji-host-agent-worker.md)・
  [provider/auth architecture](../docs/architecture/multi-provider-routing-and-auth.md):
  責務・状態所有・境界。
- [roadmap](../docs/roadmap.md): 必要機能・実装状態・未実装範囲。
- [通常利用メモ](../docs/experience/normal-use-inbox.md):
  未採用候補と再検討条件。
- [個別increment索引](../docs/increments/README.md):
  採用要件・計画・実装・検証・受入結果とアーカイブへの入口。
- [0.11.0配置記録](../docs/operations/native-0.11.0-deployment.md)・
  [JSR公開記録](../docs/operations/jsr-publish.md):
  実施済み配置・公開と各時点の検証結果。
- [旧handoffの履歴](../docs/history/handoff-through-2026-10-07.md):
  2026-10-07以前の再開状態の記録。

## 承認境界

- 217までの完了判断と最新binaryの常用配置は利用者の明示指示により実施済み。
- 後続の実装、commit/push、追加build/配置、公開/release、実データ操作は利用者指示に従う。
- 218の実providerは利用者がOpenCode Go / DeepSeek V4.1
  Flash・約20turnを承認済み。
  続く「最小限の実プロバイダを使って基本e2e」の許可により、同routeで4turnを実施した。
  同時計測案への承認で、同じSession/Workerの20turn・21requestを一回実施した。
  対象・回数・隔離保存先・実施範囲は218第11.14〜11.15節を参照する。
  この範囲で再承認を求めない。別route/modelや追加runは別途明示承認を得る。
- 構想・architecture・roadmapの変更は、変更対象・理由・意味上の変更内容を提示して別途明示承認を得る。
