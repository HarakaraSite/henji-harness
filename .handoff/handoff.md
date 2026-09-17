# Handoff

## Records

### Increment 65 — activation-level subagent slot binding（計画承認済み・実装は明日）

- 状態: 計画`docs/increments/increment-65.md`を利用者が承認済み。**実装は未着手**（明日）。実装対象は、
  delegated subagent（まずplanner）のDefinitionをactivation-level slotでbindする基盤と、planner既定のdata化。
  確定した設計:
  - slotはroot `agent:default`（role `parent`）＋delegated `subagent:<name>`。plannerは`subagent:planner`。
    `--agent planner`（plannerをrootで走らせる既存経路）は誤りとして**後続で削除**（65対象外）。
  - roleは`'parent' | 'subagent'`＋`subagentName`へ**破壊的変更**（既存managed planner Definitionは再install、
    built-in planner refは再build前提）。canonical digestも新schemaへ。
  - binding configは`$XDG_CONFIG_HOME/henji-harness/agents.json`（installation/user scope、workspaceは対象外）。
    selectorは`moduleId@sha256:<digest>`。Hostがrole/name検証、解決失敗はtyped failure（fallbackなし）。subagent解決は
    専用経路（rootの`HostDefinitionSelection.id`写像を流用しない）。
  - composition: Hostはref解決のみ。Workerはroot Definitionを評価し、root Definitionの合成（Henji helper）が
    Host提供subagentを組み込む（peer評価しない）。保証はHenji helperを使うDefinitionに限る。
  - attribution: root/subagent exact refはDefinition resource graph／execution artifactへ。context attributionへは
    入れない。subagent refはSession schemaに保存しない（将来AgentInstance領域へ）。
  - contract: start command／ready message／execution artifactのversionを上げ、旧版は解釈しない。
  - planner既定は同梱defaultのslot別`roleDefaults`（key `subagent:planner`）へ移し、コード定数を削除。planner
    instructionは当面built-in role instructionのまま。
  - base instruction finalizerはexternal plannerにも通し、Increment 51のbase適用保証を維持。
  - architecture（`henji-host-agent-worker.md`）へactivation-level slot authority・composition seam・保証範囲を追記、
    roadmapのProvider外部化節（65〜68の内容・順序）を更新（正本更新、別項目）。
  - 未決メモ: Definition-manifest dependency bindingとmanifest/activation bindingの優先・競合規則は後続。
- 次: Increment 65を実装（計画`docs/increments/increment-65.md`のHuman Gate 1〜9に従う）。実装後の検証はfocused test、
  type check/format/lint/`git diff --check`、安定候補でauthoritative `v0:gate`1回、実provider probeは実行直前に
  別途許可。その後Increment 66（web-search subagent化）、67（tool same-identity override）、68（built-in id削除/
  Session影響/入力ブロック）。
- 正本: `docs/increments/increment-65.md`（計画）、`docs/increments/increment-51.md`〜`increment-64.md`、
  `docs/experience/normal-use-inbox.md`、`docs/roadmap.md`のProvider外部化節。
- 注意: 直前の配置はIncrement 64（実装`e8c8ae98`／配置`2fe5506a`、binary SHA-256
  `e0642d4ccb57c71e2f6e1d55c3e1beaf74a0f45790f53898d578c165af7d1ff2`、source`e8c8ae98…`、`sourceDirty=false`）。
  active external revisionは`local/henji-base@sha256:82d67dd2…`。宣言providerは`providers/*.json`、既定selectionは
  `default-selection.json`。`openrouter`/`openai`/`openrouter-responses`はcatalog/defaultsのみoverride可能。新規idは
  `openai-responses`と`openai-chat-completions`。adapterはbinary-owned、protocolは固定enum。OpenAI Chat Completionsは
  `gpt-5.6-terra`でfunction toolsと`reasoning_effort`の併用不可（`/v1/responses`か`reasoning_effort:'none'`）。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
