# Handoff

## Records

### Review follow-up — root slot binding適用と第三者review指摘対応（完了）

- 第三者review（独立reviewer×2、read-only）をIncrement 65〜68に対して実施。実利用経路を壊すregressionは無し。
- F1（Should）: `agent:default` root slot bindingが解決・検証されるだけで未適用だったため、**適用を実装**。
  `resolveRequestedDefinition`が明示selector無しのときroot bindingをmanaged parent rootとして解決。優先順位は
  「明示selector > 再開/継続Sessionの保存ref > `agent:default` binding > bundled default」。selector解析を
  `v0/agent/definitions/definition_selector.ts`へ分離し循環importを回避。実装commit`e0ab97ee`。
- F2（Should, doc）: plannerのmodel/effort差し替えは未対応のためincrement-65の要求文を是正（instruction/toolsは
  対応）。F3（Nit）: `AgentBindingError`を`DefinitionStartupError`へ写像しtyped表示。F4（Nit）: 未使用
  `PLANNER_PROFILE`を削除。test名/ハードコードも修正。`increment_65`にroot binding testを追加（計10件）。
  authoritative `v0:gate` exit 0。
- JSR release prep: `jsr.json`を`0.2.0`へbumpし、`publish.include`をmod.tsのmodule graphに合わせて更新（
  `deno publish --dry-run`成功）。commit`ebf879a2`。binary`0.2.0`を再配置。JSR publishはauth待ち。

### Increment 68 — provider id整列とbuilt-in id移行（完了）

- 状態: 2026-09-18に修正・検証・binary配置まで完了。
- 内容: built-in provider idを`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`へ
  **破壊的変更**（`openrouter`／`openai`は互換aliasなしで削除）。`openai-chat`（protocol
  `openai-chat-completions`、endpoint api.openai.com）を同梱declarationとして追加。protocol enumと
  authProfile idは据え置き。
- Session/evidence: 旧idは未知providerとして明示失敗（自動migration・fallbackなし）。`default-selection.json`の
  解決不能は無効preferenceとして既定へfallback。providerState/evidence providerも`openrouter`→`openrouter-chat`。
- `openai-chat`制約: function tools併用時は`reasoning_effort`が`none`以外でHTTP 400のため、gpt-5.6-sol/luna/
  terraの`defaultEffort`を`none`に設定。gpt-6-astraは`none`を持たず`openai-chat`ではtool turn不可（未解決の
  フォローアップ候補）。Reasoningは`openai-responses`を使う。
- 検証: `increment_14`のfocused test追加、`v0:gate` exit 0。実provider probe（source）で`openrouter-chat`と
  `openai-chat`（none）のturn成功、installed binaryでも両selectionの`henji run`成功。
- 配置: installed launcher `~/.local/bin/henji`（renameで差替え）。binary SHA-256
  `e5a97e963d2f9ebdf4bfb6f1778d01bace0acda3ab88aaa87804c6c9ceba31a7`、build
  `cb0ced4cde802f05ae2e6a7776c2ce93e2d3577f95ace3db8a7a3a2d18a9a454`、embedded runtime
  `c665e31aaeb352670278af8ebe359e35c415ba14a47ded2d58ac1e9b5c7f052`、source`fb066aa4…`、`sourceDirty=false`。
- 正本: `docs/increments/increment-68.md`。roadmap Provider外部化予定をweb-search=69、tool=70へ繰下げ（旧
  「built-in id削除/Session影響/入力ブロック」は68へ統合）。

### Increment 67 — Responses APIの`auto` effort修正（完了）

- 状態: 2026-09-18に修正・検証・binary配置まで完了。
- 原因: `v0/agent/provider/openai_responses_model.ts`がResponses APIへ常に`reasoning:{effort}`を送り、
  `auto`をproviderが拒否（HTTP 400）。`openrouter-responses`の`qwen/qwen3.8-flash`（既定effort `auto`）等で
  全turn失敗。Chat Completionsは`auto`時に`reasoning_effort`を省略しており非対称。
- 修正: effort `auto`のとき`reasoning`を省略（`include:['reasoning.encrypted_content']`は維持）。focused testは
  `increment_14_multi_provider_test.ts`に追加。authoritative `v0:gate` exit 0。
- 実provider probe（利用者許可）: isolated XDGで`openrouter-responses`/`qwen/qwen3.8-flash`/`auto`の1 turn成功
  （`RESPONSES_AUTO_PROBE_OK`）。
- 配置: installed launcher `~/.local/bin/henji`（renameで差替え）。binary SHA-256
  `4e0bc0acf6874b898f4b46a195c07d22c3303757bb28c2094e5e963d21e77fa6`、build
  `4759ce1e842b9d6ea1abe065ec103fce67990daebfe1dc6aed8e4afaaf39041c`、embedded runtime
  `3df03fb074c7699f06c2e9d7f428fdd8aa04c81f2d5730b3a792fcd74ff55170`、source`fd616c79…`、`sourceDirty=false`。
- 正本: `docs/increments/increment-67.md`。roadmap Provider外部化予定をweb-search=68、tool=69、built-in=70へ
  繰下げ（利用者承認済み）。

### Increment 66 — provider切替UIの修正（完了）

- 状態: 2026-09-18に`/provider`/`/model`のprovider検証クラッシュと選択確認statusの残留を修正。実装commit
  `29c900d8`（クラッシュ）と`5536a893`（status）、binary配置済み。
- 原因: 不具合1は`v0/presentation/contract_intent.ts`がproviderを`openrouter`/`openai`の2値に限定し、pickerが
  提示する`openrouter-responses`（および宣言provider）を`PresentationDeliveryError`として致命`output_failure`に
  していた。不具合2はprovider/model選択確認のstatusを`ready`へ戻す処理が無く、footer 1行目に残り続けていた。
- 修正: 1) provider検証を構造的検証へ変更し、`select_provider`の未知providerを
  `{kind:'rejected',reason:'invalid'}`へ変換。2) 選択確認を次回editor入力時に（idle時のみ）`readyStatus()`へ戻す
  （利用者選択A）。新規`tests/v0/increment_66_provider_picker_test.ts`（3件）と
  `tui_retained_terminal_test.ts`のconfirmed-clear test。authoritative `v0:gate` exit 0。
- 配置: installed launcher `~/.local/bin/henji`（=`dist/henji`、実行中プロセスのためrenameで差替え）。binary
  SHA-256 `fc584309e620d91ecede7d2f48de0cf444d9a8f648fb04b2844f921ccb48d24b`、build
  `d5a5083cd84d5d3d7545fa07ec141800653e5bbf205d3b11285c258d92d363c2`、embedded runtime
  `8bbba492daa19e95ad852d9839b8f585fc900333ff1ee90061d93d7df2a9b520`、source`5536a893…`、`sourceDirty=false`。
  ptyで`/provider`→`openrouter-responses`のfooter反映、切替後`/`入力で`ready │ cmds: ...`を確認。
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
    roadmapのProvider外部化節（65、69、70の内容・順序）を更新（正本更新、別項目）。
  - 未決メモ: Definition-manifest dependency bindingとmanifest/activation bindingの優先・競合規則は後続。
- 次: Increment 65〜68とreview follow-upはコード・正本・検証・binary配置まで完了。次はroadmapの予定どおり
  Increment 69（web-search subagent化）、70（tool same-identity override）。
- 正本: `docs/increments/increment-68.md`、`increment-67.md`、`increment-66.md`、`increment-65.md`、
  `increment-51.md`〜`increment-64.md`、`docs/experience/normal-use-inbox.md`、`docs/roadmap.md`のProvider外部化節。
- 注意: 直前の配置は`0.2.0`（実装`ebf879a2`／配置は本commit、binary SHA-256
  `a797a83db7ea5b7a7940e45c28dbca56ef6cabfe59bea2ce7ff0e415a3be9b07`、build=`425a21be50fd52d7b3fcead60c3dccc8ce59c55319deffc0229caf69452dd32d`、
  embedded runtime=`65a331ca9cc8501450bd2c24a9d2135df4795af5ec34e2b4d08482a4fecf5143`、source`ebf879a2…`、`sourceDirty=false`）。
  直前はIncrement 68（binary `e5a97e96…`）、67（`4e0bc0ac…`）、66（`fc584309…`）、65（`02081658…`）。
  active external revisionは`local/henji-base@sha256:82d67dd2…`。宣言providerは`providers/*.json`、既定selectionは
  `default-selection.json`。built-in provider idは`openrouter-chat`/`openrouter-responses`/`openai-chat`/
  `openai-responses`（旧`openrouter`/`openai`は削除、互換aliasなし）。宣言providerのprotocolは
  `openai-chat-completions`または`openai-responses`（binary-owned fixed enum）。OpenAI Chat Completionsはfunction
  tools併用時に`reasoning_effort`が`none`以外で400（`openai-chat`のsol/luna/terraは既定`none`、gpt-6-astraは
  `none`を持たずtool turn不可）。
  未実施: tag、Forgejo Release、JSR publish（`0.2.0`をprep済み・`deno publish --dry-run`成功。publishはJSR auth待ち。JSR latestは`0.1.3`）。
