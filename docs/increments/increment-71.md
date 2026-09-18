# Increment 71 — 組み込みwork toolのtool Definition統一

ステータス: **実装完了（offline gate pass。実provider probe未実施）**

基準commit: `8db3e96c`

計画日: 2026-09-18

実装日: 2026-09-18

対象: `bash`／`bash_output`／`edit`／`read`／`write`を、binary内の固定catalog（`ToolComponentCatalog`／
`workToolNames`）と同一identity置換seam（`AgentCompositionOptions.toolComponents`）から、Increment 69/70の
managed tool Definition経路へ移す。`web_search`／`web_fetch`と同じくbundled tool Definitionが既定を供給し、
external tool Definitionの`tools.json` bindingが同一identityを差し替える。固定catalogと置換seamは削除する。

## 利用者が必要とする動作

- default parentは従来どおり`bash`／`bash_output`／`edit`／`read`／`write`をゼロ-configで使え、動作は退行しない。
- これらのtoolも、external managed tool Definitionをinstallして`tools.json`で`tool:<name>`へbindすると、その
  Definitionのcontract・executor・backendに差し替わる。差し替えの仕組みは`web_search`／`web_fetch`と同一。
- Henji helperを使うexternal Agent Definitionは、Hostが供給するbundled tool Definition componentを
  `additionalTools`宣言とともに受け取れる（追加work toolの一般化はIncrement 70の`additionalTools`）。
- `read`のguideline、`bash`のtruncation guideline、`bash_output`の継続取得、`edit`／`write`のworkspace契約、
  `bash`／`bash_output`がRegistry lifetimeごとに一つのoutput storeを共有する挙動は維持する。
- attribution（manifest／execution artifactの`tools` exact ref）は全work toolについて記録される。

## 計画

### bundled tool Definition

- `v0/agent/worker/worker_builtin_bash_tool.ts`、`_bash_output_tool.ts`、`_edit_tool.ts`、`_read_tool.ts`、
  `_write_tool.ts`を追加し、各identity（`tool:bash`等）の`ToolComponent`を返す`ExecutableToolDefinition`を
  default exportする。実体は既存factory（`createBashTool`等）を使う薄いwrapperとし、`materialize`が受け取る
  `ToolComponentBindings`（workspace、workTools、bashOutputStore）で構築する。
- `worker_definition_revision.ts`の`BUNDLED_TOOL_DEFINITIONS`へ5 identityと`builtin/<name>` resourceId／
  module pathを追加する。`web_search`／`web_fetch`は据え置き。
- `scripts/build_henji.ts`の`ROOTS`へ5 moduleを追加し、compiled binaryへ含める。

### 固定catalogと置換seamの削除

- `tool_components.ts`から`ToolComponentCatalog`、`workToolNames`、`selectedWorkToolName`、
  `isWorkToolComponentIdentity`、同一identity置換検証を削除する。`ToolComponent`と`ToolComponentBindings`、
  各toolのfactory（bundled moduleが使う）は残す。必要ならfactory群を`bundledToolComponentFactories`として
  明示する。
- `AgentCompositionOptions.toolComponents`、`RegistryMaterializationContext.toolComponents`／
  `toolComponentCatalog`、`createDefaultAgentComposition`／`worker_agent_api.ts`の該当受け渡しを削除する。
- `createDeclaredTool`は、`tool:*`を`toolDefinitionComponents`（Host供給または`additionalTools`）だけから
  materializeする。bundled provider-free/legacy用のweb_search／web_fetch fallbackも削除し、非Host呼出側は
  componentを渡す。core-owned tool（`tool:skill`／`tool:delegate_to_planner`／`tool:submit_json_result`）は
  現行のswitchを維持する。
- `worker_agent_api.ts`の`ToolComponentCatalog`再exportを削除する（`ToolComponent`は維持）。

### 非Host経路の更新

- legacy `v0/agent/runtime/runtime.ts`は、bundled tool Definition moduleを評価して`toolDefinitions`として
  registryへ渡す（または同moduleのfactoryからcomponentを構築する）。テスト用の`webSearchBackend`上書きseamは
  tool Definitionの`requestProvider`／backendに置き換える。
- Host（`worker_tui_session.ts`）は`BUNDLED_TOOL_DEFINITION_IDENTITIES`を一括解決し、全bundled tool Definition
  componentをWorkerへ渡す（現行の一般化経路をそのまま使う）。

### 既存test／fixtureの更新

- `tests/v0/current_code_test.ts`の`createDefaultAgentComposition(..., { toolComponents: [...] })`置換testを、
  tool Definition componentを`input.toolDefinitions`で渡す形へ変更する。
- `tests/v0/fixtures/increment_33/replacement/`と`increment_33`の置換testを、managed tool Definitionの
  `tools.json` bindingによる差し替えへ作り替えるか、Increment 71のfocused testへ移す。
- default tool一覧・guideline・manifest resources・compile権限・fresh-runtime identityの既存期待を更新する。

## 対象外

- `tool:skill`／`tool:delegate_to_planner`／`tool:submit_json_result`（core-owned。Definition化しない）。
- 新しいwork tool identityの追加、tool Definition transport、remote registry、hot reload、remove/GC。
- generic model層のannotation/citation、provider-native server tool。
- 追加toolの宣言一般化（Increment 70で実装済み）。

## Verification

- focused test: 5 work toolがbundled tool Definitionからmaterializeされ、`read`／`bash`／`bash_output`等の
  guidelineと挙動（bash truncation→bash_output、edit/writeのworkspace契約、bash系のstore共有）が退行しないこと、
  external tool Definitionを`tools.json`で`tool:read`等へbindして差し替わること、未解決identityがtyped failureに
  なること、manifest／artifactの`tools` attribution。
- 既存回帰: Increment 7/9 web_search、Increment 69/70 tool Definition、foundation Worker turn、artifact schema v7、
  history、fresh-runtime comparison。
- 実provider probe（別途許可）: isolated XDGで`bash`や`read`を含む1 turn。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. `bash`／`bash_output`／`edit`／`read`／`write`の5つを一度にbundled tool Definitionへ移す。
2. `ToolComponentCatalog`／`workToolNames`／同一identity置換seam（`AgentCompositionOptions.toolComponents`等）を
   削除し、差し替えは`tools.json`のexternal tool Definition bindingへ一本化する（破壊的）。
3. 非Host呼出側（legacy `runtime.ts`・直接registry呼出）はcomponentを自分で渡す。bundled fallbackは置かない。
4. core-owned tool（`skill`／`delegate_to_planner`／`submit_json_result`）はDefinition化しない。
5. 既存の置換test／fixtureをtool Definition binding経路へ作り替える。
6. 実provider probeを実行直前に別途許可する。

## 結果（2026-09-18）

- bundled tool Definition module `worker_builtin_{bash,bash_output,edit,read,write}_tool.ts`を追加し、
  `BUNDLED_TOOL_DEFINITIONS`とcompile ROOTSへ登録した。`web_search`／`web_fetch`と合わせて7 identityをHostが
  一括解決する（`bundledToolDefinitionLoadRequests`）。
- 固定catalogと置換seamを削除した。`ToolComponentCatalog`／`workToolNames`／`isWorkToolComponentIdentity`、
  `AgentCompositionOptions.toolComponents`、`RegistryMaterializationContext.toolComponents`／
  `toolComponentCatalog`を除去し、`createDeclaredTool`は`toolDefinitionComponents`だけから`tool:*`を
  materializeする。bundled fallbackは置かず、非Host呼出側（legacy `runtime.ts`・直接registry呼出）はcomponentを
  自分で構築する。`createPlannerAgentComposition`もHost供給の`toolDefinitions`を使う。
- `ToolComponent`／`ToolComponentBindings`は型として維持し、各factory（`createBashTool`等）はbundled moduleが
  使う。
- 既存置換test／fixtureをtool Definition経路へ作り替えた。`fixtures/increment_33/replacement/`（agent Definition
  による置換）を削除し、`increment_33` testはmanaged tool Definitionを`tools.json`で`tool:read`へbindして
  差し替わることを確認する形へ変更した。`current_code_test`の置換testは`input.toolDefinitions`でcomponentを
  差し替える形へ更新した。
- 検証: `v0:check`／`fmt`／`lint`／`v0:gate` exit 0。work toolのguideline・bash/bash_output store共有・
  write/edit/read挙動・plannerへの同一identity適用を既存testで確認。
- 未実施: 実provider probe、binary build・配置、architecture／roadmapの正本反映（別承認）。
