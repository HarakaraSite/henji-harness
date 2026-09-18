# Handoff

## Records

### Increment 66 — provider picker crash修正（完了）

- 状態: 2026-09-18に`/provider`/`/model`のprovider検証を修正。実装commit`29c900d8`、binary配置済み。
- 原因: `v0/presentation/contract_intent.ts`がproviderを`openrouter`/`openai`の2値に限定し、pickerが提示する
  `openrouter-responses`（および宣言provider）を`PresentationDeliveryError`として致命`output_failure`にしていた。
- 修正: provider検証を構造的検証へ変更し、`select_provider`の未知providerを`{kind:'rejected',reason:'invalid'}`へ
  変換。新規`tests/v0/increment_66_provider_picker_test.ts`（3件、`v0:test`追加）。ptyでsource/binaryとも
  `/provider`→`openrouter-responses`のfooter反映とexit 0を確認。authoritative `v0:gate` exit 0。
- 配置: installed launcher `~/.local/bin/henji`（=`dist/henji`）。binary SHA-256
  `cf3abe3e0e9c4e267659329278d85e31cfa6409bf73450ddfcd5595e9e749c12`、build
  `9bcc9f2bd9992f6fba02c8e9449d1c0645c5ef8dec9edadfce66462abc687c28`、source`29c900d8…`、`sourceDirty=false`。
- 正本: `docs/increments/increment-66.md`。roadmap Provider外部化節の予定番号を67/68/69へ繰下げ（利用者承認済み）。

### Increment 65 — activation-level subagent slot binding（実装完了・probe受入済み）

- 状態: 計画`docs/increments/increment-65.md`は利用者が承認済み。2026-09-18に次を実装しauthoritative `v0:gate`
  がexit 0。実provider probeも受入済み。作業ツリーは未commit（利用者からのcommit指示待ち）。
  1. role一般化（破壊的）: `declaredRole:'parent'|'subagent'`＋`subagentName`、canonical digest新schema、
     built-in planner ref再build、module CLI `--role subagent --subagent-name <name>`、root slotは`parent`のみ
     （managed subagent refは`definition_role_mismatch`@resolution）。旧schemaは互換読込しない。
  2. activation binding config: `v0/agent/definitions/agent_slot_binding.ts`。`agents.json`のload/validateと
     slot→exact managed revision解決。typed `AgentBindingError`、暗黙fallbackなし。
  3. composition seam: Hostが生成ごとに`subagent:planner`を解決し（bound managedまたはbundled planner）、
     start commandの`subagents`としてexact ref＋物理descriptorを渡す。Workerはsubagent moduleを検証読込し
     `ExecutableAgentDefinitionInput.subagents`としてroot DefinitionのHenji helperへ渡し、helperが合成する。
     保証範囲はHenji helperを使うDefinitionに限る。
  4. contract: `WORKER_PROTOCOL_VERSION`=`slice1-data-only-v2`、execution artifact=schema-v6。ready manifestと
     v6 artifactに実際に合成した`subagents`（name＋exact ref）を記録。
  5. 正本更新（利用者承認済み）: architecture `henji-host-agent-worker.md`へ`AgentSlotBinding`用語、roleモデル、
      activation-level slot節、composition seam、attribution/contractを追記。roadmap Provider外部化節の段階リスト・
      サマリ表をIncrement 64〜68の実内容へ更新し、F06/F24行をslot binding基盤へ更新。
  6. planner既定data化: 同梱`provider-defaults.json`へtop-level `roleDefaults`（key `subagent:planner`）を追加し、
     `roleDefaultModelSelection(slot)`がactive catalogに対して解決。hardcodeの`PLANNER_DEFAULT_MODEL_SELECTION`等を
     削除。root provider既定は従来どおりdeclaration `defaults`。
- 検証済み: authoritative `v0:gate`（check/fmt/lint/test）exit 0。`increment_65`新規7件（`v0:test`へ追加）＋
  `increment_38`/`40`/`41`の版assert更新、`increment_12`/13/14/15/38/39/40/41/42、`production_cli_e2e`もpass。
- 実provider probe受入済み: isolated XDG rootにexternal planner（`subagent:planner`、system instructionへmarker）を
  install＋`agents.json` bindし、production physicalI/Oでreal turn 1回。artifact v6の`subagents[0].ref`一致、
  planner laneのprovider request bodyにmarkerを確認（source-driven production path。compiled binary配置は別途）。
- フォローアップ候補（未承認）: architecture 406行付近の「delegated plannerはrootの選択を継承せずplanner defaultを
  使う」をslot binding（bindが無ければplanner default）へ合わせるか。external plannerが標準helper以外で独自model
  selectionを使う場合の`manifest.plannerModel`/Host validationの扱い。
- 注意: `increment_33`/`increment_34`の「external plannerをrootとして実行」testはsubagent root拒否検証へ置換した
  （計画どおり）。external plannerのdelegated child turn反映は`increment_65`のcomposition testで確認する。
- 確定した設計:
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
    roadmapのProvider外部化節（65、67〜69の内容・順序）を更新（正本更新、別項目）。
  - 未決メモ: Definition-manifest dependency bindingとmanifest/activation bindingの優先・競合規則は後続。
- 次: Increment 65・66はコード・正本・検証・binary配置まで完了。次はroadmapの予定どおりIncrement 67
  （web-search subagent化）、68（tool same-identity override）、69（built-in id削除/Session影響/入力ブロック）。
- 正本: `docs/increments/increment-66.md`、`increment-65.md`、`increment-51.md`〜`increment-64.md`、
  `docs/experience/normal-use-inbox.md`、`docs/roadmap.md`のProvider外部化節。
- 注意: 直前の配置はIncrement 66（実装`29c900d8`／配置は本commit、binary SHA-256
  `cf3abe3e0e9c4e267659329278d85e31cfa6409bf73450ddfcd5595e9e749c12`、build=`9bcc9f2bd9992f6fba02c8e9449d1c0645c5ef8dec9edadfce66462abc687c28`、
  embedded runtime=`f9d5823f97ccc76e51880b66febe2eb95af79ab705b5902b52b2fb1ff0f0f77b`、source`29c900d8…`、`sourceDirty=false`）。
  直前はIncrement 65（binary SHA-256 `02081658…`）、Increment 64（binary SHA-256 `e0642d4c…`）。
  active external revisionは`local/henji-base@sha256:82d67dd2…`。宣言providerは`providers/*.json`、既定selectionは
  `default-selection.json`。`openrouter`/`openai`/`openrouter-responses`はcatalog/defaultsのみoverride可能。新規idは
  `openai-responses`と`openai-chat-completions`。adapterはbinary-owned、protocolは固定enum。OpenAI Chat Completionsは
  `gpt-5.6-terra`でfunction toolsと`reasoning_effort`の併用不可（`/v1/responses`か`reasoning_effort:'none'`）。
  未実施: tag、Forgejo Release、JSR publish（JSR latestは0.1.3）。
