---
concept: deno-self-revising-agent-harness
concept_revision: 17
input: agent-definition-composition-boundary
status: delivered-not-activated
date: 2026-08-26
target_repository: ai-dev:/home/masat.guest/src/henji-harness
---

# TypeScript Agent Definition composition boundary

## 目的

Henji Harnessでは、TypeScript関数をdeploy単位ではなく、再現可能なagent構成と
将来の実験単位として使う。model、instructions、skills、tools、有限loop parameterを
単一のAgent Definitionから解決し、既存の共通runtimeへ渡せる構成境界を目指す。

この入力は方針の配送だけを行う。planning、詳細設計、実装、test、reviewを開始しない。

## 固定する責務境界

- Agent Definitionはruntimeへの入力を構成する。agent loop、event、session、tool実行、
  streaming、UIを所有しない。
- 現行`createRuntimeComposition`を将来の最初の接点とする。
- 最初は一つのinternalなdefault Definitionだけを対象とし、CLIとTUIの外部挙動を
  変えない。
- Definition単独の大規模refactorは行わない。後日、runtime compositionへ触れる通常の
  roadmap incrementが選ばれた場合に、そのincrementの中で薄い境界を導入する。
- Zotはloop、event、session、queue、compaction、tool registry、extension、subagentなど
  agent coreの参照実装とする。
- OpenComputerはTypeScript関数からmodel、instruction、tool、skillなどを選ぶ構成表現
  だけの限定参照とする。managed deployment、sandbox、secret、schedule、課金、
  self-hostingをHenjiへ取り込まない。
- OpenComputerの毎model callで同期的に関数を評価するreactive semanticsは現時点で
  採用しない。必要性を観測するまではruntimeまたはsession開始時の固定構成を優先する。

## 初期導入時の成功条件

1. default agentのmodel、instructions、skills、tools、有限loop parameterが一か所から
   読める。
2. CLIとTUIが同じDefinitionから同じruntime compositionを得る。
3. 外部挙動と既存testを変えず、Definition導入だけを理由に新しい公開設定や機能を
   追加しない。

## roadmapへの接続

- 直近: 次にruntime compositionへ触れる通常incrementの一部として、単一default
  Definitionと挙動不変のcomposition boundaryを導入する。独立milestoneにはしない。
- milestone 45〜50: provider・model交換とtool registry変更がDefinitionから共通runtimeへ
  渡る形に収まるか検証する。
- milestone 60: 用途別の複数TypeScript Agent Definitionを作成・選択可能にする。
- milestone 80: Definitionだけが異なるvariantを同一runtime、task、workspaceで比較する。
- milestone 85〜99: current Definitionを親にAIがcandidateを作り、人間が比較結果から
  次revisionを採用するcycleへ接続する。

## 現時点の対象外

- planning、詳細設計、source・test・repository文書・handoffの変更
- 複数Definition、公開API、turn別reactive構成
- 差分・継承、versioning、serialization、variant・lineage表現
- benchmark contract、candidate生成、昇格、self-revision
- dependency変更、provider call、credential参照、commit、push、release

## 参照

- operations正本: `discovery/concepts/deno-self-revising-agent-harness/README.md`
  revision 17
- ai-dev固定snapshot: `_refs/opencomputer/`
- OpenComputer upstream commit:
  `d54f2c239a293216ff13f069ffc1ed7b853f9761`
- 参照対象: `agent/`、`examples/typescript/`、root `README.md`、`LICENSE`

## activation条件

この入力を受領しただけでは作業を開始しない。利用者がai-devで次の通常roadmap
incrementとplanningまたは実装開始を明示した後に、repositoryの現行`AGENTS.md`、handoff、
source、test、current plansと照合して詳細化する。
