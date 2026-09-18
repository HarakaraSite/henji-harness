# Handoff

## Records

### 通常利用の改善 — Increment 69（実装完了: offline gate・binary配置・実provider probe受入済み）

- 状態: `tool-definition`資源kindとweb_search外部化を実装完了。`v0:gate`（check/fmt/lint/test）exit 0。
  binary `0.2.1`をbuildし`~/.local/bin/henji`へ配置済み（最新のbuild/hashは「環境・配置」節）。
  完了した区間:
  - `managed_resource_ref.ts`（`ToolDefinitionRevisionRef`等）、`build_manifest.ts`
    （`HENJI_TOOL_DEFINITION_API_CONTRACT`／`supportedToolDefinitionApiContracts`、compile script更新）。
  - `managed_definition_importer.ts`を汎用`importManagedModule`へrefactor。
  - `managed_tool_definition_manifest.ts`／`_revision_validator.ts`／`_store.ts`（`managed/tool-definition/v1`）。
  - `tool_definition_selector.ts`、`tool_binding.ts`（`tools.json`のread/validate/resolve、typed error）。
  - Worker protocol（start `toolDefinitions`／ready manifest `tools`）、`worker_bootstrap`のload・評価、
    `registries.ts`／`worker_agent_api.ts`のDefinition提供tool経路、`finalizeWorkerToolAttribution`。
  - `worker_builtin_web_search_tool.ts`（bundled Sonar web_search tool Definition）。
    `tool:web_search`を固定catalog（`workToolNames`／`builtinToolComponents`）から削除。
  - provider request seam（`provider/auxiliary_request.ts`、`PhysicalIoBindings.requestProvider`、
    `OpenRouterSonarWebSearchBackend`の`requestProvider`対応、`createProductionPhysicalIo`からSonar backend
    直結を除去）。
  - Host解決（`worker_tui_session.ts`の`resolveToolDefinitions`、binding > bundled）、manifest/artifact検証
    （schema v7、tools attribution）、sqlite history storeのartifact v7対応・復元。
  - focused test `tests/v0/increment_69_tool_definition_test.ts`（5件、`v0:test`へ追加）。
  - tool CLI（`v0/agent/cli/tool_cli.ts`、`henji tool install|list|inspect|active|activate|deactivate|uninstall`）。
  - binary build・配置（上記）。
- 次: 利用者判断待ち／残作業:
- 実provider probe（利用者許可、2026-09-18）: isolated XDGの`henji run`（stdin task）でbundled Sonar
  web_searchが回答＋直接source URLを返し`I69_PROBE_OK`、exit 0。
- 次: architecture/roadmap正本とcommitは完了（別項目）。残作業なし。
- 正本: `docs/increments/increment-69.md`（結果まで反映済み。architecture/roadmapも更新・commit済み）。
- 注意: 既存testの期待を新契約へ更新済み（artifact schema v6→v7、web_searchのDefinition提供）。
  非Host経路（legacy `runtime.ts`・直接`createDeclaredRegistry`）には、backend/requestProviderからの
  web_search互換bridgeを残した（productionはHost提供bundled tool Definitionが優先）。
  `tool:web_search`は固定topology validatorに残置（default Definitionが宣言するため）。
  未採用のfollow-up候補（実装時に正本へ反映するか判断）:
  - delegated plannerのmodel/effort差し替え（`increment-65.md`）
  - `openai-chat`のgpt-6-astra（`none`を持たずtool turn不可。`increment-68.md`）
  - architecture `henji-host-agent-worker.md` 406行付近の「delegated plannerはplanner default」記述の整合
  - S6 busy表示のspinner化（`docs/experience/normal-use-inbox.md`）
  - generic model層のprovider annotations/citation（調査済み・作らない方針。OpenRouterで`tools`非対応の
    pure-textは59件、`web_search_options`保持はSonar系5件のみ）

### Increment 70 — tool宣言のDefinition統一とweb_fetch（実装完了、実provider probe受入済み）

- 状態: 実装完了。`v0:gate` exit 0。toolの可視性のownerを各Agent Definitionに統一し、
  `AgentCompositionOptions.additionalTools`でDefinitionが追加`tool:<name>`を宣言、Hostがbundled tool Definition
  一覧＋`tools.json` binding一覧を解決してWorkerへ渡す。registryは宣言identityのみmaterialize。`tools.json`は
  bindingのみ。bundled `web_fetch`（`tool:web_fetch`／`builtin/web-fetch`）を追加し、bundled default parentが
  宣言する。web_fetchは素のHTTP GET（redirect follow、timeout 30s、1 MiB上限・切り詰め表示、text/JSON/XMLは
  UTF-8 decode、HTMLは最小text抽出、非textualはメタのみ、非2xx/network/invalid URLはtool error）。compiled
  binaryと`agent:run|tui|sessions`の`--allow-net`を無制限化。
  新規`tests/v0/increment_70_tool_declaration_test.ts`（2件）と`increment_70_web_fetch_test.ts`（4件）。
- 実provider probe（利用者許可、2026-09-18）: isolated XDGの`henji run`でmodelが`web_fetch`を呼び
  `https://example.com/`を取得。status 200・`text/html`・本文抽出・`truncated:false`、`I70_PROBE_OK`でexit 0。
- 次: 他work toolのDefinition化とtool Definition transport（後続increment）。
- 正本: `docs/increments/increment-70.md`。architecture（`henji-host-agent-worker.md`）とroadmapを本incrementへ
  更新済み。
- 注意: 追加toolを使うには、それを宣言したAgent Definition（bundled defaultまたはexternal）と、tool Definition
  のinstall/bindが必要。bundled moduleが無いidentityはexternal binding必須（無ければtyped failure）。

### Increment 71 — 組み込みwork toolのtool Definition統一（実装完了、実provider probe受入済み）

- 状態: 実装完了。`v0:gate` exit 0。`bash`／`bash_output`／`edit`／`read`／`write`をbundled tool Definition
  （`worker_builtin_*_tool.ts`）へ移し、`BUNDLED_TOOL_DEFINITIONS`（7 identity）とcompile ROOTSへ登録。固定
  `ToolComponentCatalog`／`workToolNames`／`isWorkToolComponentIdentity`と`AgentCompositionOptions.toolComponents`
  を削除し、`createDeclaredTool`は`toolDefinitionComponents`のみから`tool:*`をmaterialize。`createPlannerAgentComposition`
  もHost供給`toolDefinitions`を使う。非Host呼出側（legacy `runtime.ts`・直接registry呼出／test）はcomponentを自分で
  構築する（test用`tests/v0/bundled_tool_components.ts`を追加）。core-owned tool（`skill`／`delegate_to_planner`／
  `submit_json_result`）はDefinition化しない。
- 実provider probe（利用者許可、2026-09-18）: isolated XDGの`henji run`でmodelが`bash`（`echo HELLO_I71`）と
  `read`（AGENTS.md 1-3行）を呼び、stdoutと本文・continuation noticeを得て`I71_PROBE_OK`、exit 0。
- 検証: 既存置換test／fixtureをtool Definition経路へ作り替え（`fixtures/increment_33/replacement/`削除、
  `increment_33`はmanaged tool Definitionを`tools.json`で`tool:read`へbind、`current_code_test`は
  `input.toolDefinitions`差し替え）。`v0:check`／`fmt`／`lint`／`v0:gate` exit 0。
- 次: tool Definition transportと任意kindの一般化（後続increment）。
- 正本: `docs/increments/increment-71.md`。architecture（`henji-host-agent-worker.md`）とroadmapへ反映済み。

### Increment 72 — named subagentの一般化（実装完了、実provider probe受入済み）

- 状態: 実装完了。`v0:gate` exit 0。delegation toolを`createSubagentDelegationTool(name, handler)`へ、
  child admissionを`admitSubagentExecution(name, callId)`（per-name、child budget共有）へ一般化。
  `registries.ts`は`subagentDelegations`（name→handler）で`tool:delegate_to_<name>`をmaterializeし宣言整合を
  一般検査。`worker_agent_api.ts`は`resolveSubagentComposition(name)`＋`createSubagentHandler`と
  `additionalSubagents`を追加。Hostはbundled subagent（planner）＋`agents.json`の`subagent:*` bindingを解決
  （root Definitionの種別を問わない。bundled moduleが無いnameはbinding必須）。manifest `subagents`（name＋ref）は
  不変。新規`tests/v0/increment_72_named_subagent_test.ts`（1件、`v0:test`へ追加）。
- 実provider probe（利用者許可、2026-09-18）: isolated XDGでexternal subagent Definition
  `example/researcher`をinstallし`agents.json`の`subagent:researcher`へbind、additionalSubagents＋
  additionalToolsを持つexternal root `example/root`を`--definition-revision`で選択。modelが
  `delegate_to_researcher`を呼び、subagentの返答を`I72_PROBE_OK`付きで出力、exit 0。
- 次: tool Definition transportは**tool Definitionを通常利用で安定させた後に別incrementで実装**する（決定:
  2026-09-18。roadmapに反映済み）。他kind候補は`docs/experience/normal-use-inbox.md` E2で管理する。
- 正本: `docs/increments/increment-72.md`。
- 注意: 子lane provider evidenceのmodel selectionはplanner既定のまま（named subagent固有selectionのevidence
  属性はfollow-up。Definitionは`createModel('planner', selection)`で自モデルを選べる）。他候補は
  `docs/experience/normal-use-inbox.md`のE2に記録。

### Increment 73 — busy表示を`working`＋spinnerへ（完了）

- 状態: 実装完了。`v0:gate` exit 0。footer busy表示を`busy`＋blinkから`working`＋braille spinner
  （`BUSY_SPINNER_FRAMES`、120ms周期）へ変更。`cancelling`・経過時間・`Esc cancel`は維持。`state.ts`に
  `busySpinnerFrame`／`busy_spinner`、`tui_renderer.ts`のbusy timerを120msへ、`layout.ts`からbusy blinkを削除。
  terminal styleは最終frameのみ（busyでは`BLINK_SGR`不使用）。
- pty確認（2026-09-18）: isolated XDGでinstalled binaryのTUIをpty起動し、task投入中に`working`表示とspinner
  frame（3種）を観測、`BLINK_SGR`は出力に現れなかった。
- 正本更新: `docs/roadmap.md` F01関連を`working`＋spinnerへ、`docs/experience/normal-use-inbox.md`のS6を採用済み
  として削除（increment-73へ移管）。
- 正本: `docs/increments/increment-73.md`。

### Increment 74 — TUI表示凍結（原因特定済み、修正未実装）

- 状態: **原因特定済み、修正未実装**。利用者報告の不具合:
  - B1: busy表示（`working`＋spinner＋経過時間）がturn中に更新停止（利用者再現: Session `375ca4e7`、prompt
    「denoとnodeを比較したい webで情報を収集して」）。
  - B2: `/sessions`が`session list unavailable`（実Session `a75bd052`が存在）。
  - B3: PageUpで履歴先頭まで到達できない（`a75bd05`で2ページ目程度）。
  - 記録先: `docs/experience/normal-use-inbox.md`「観測した不具合（未修正）」B1〜B3。
- 原因（特定済み）: `v0/tui/terminal.ts`の`Deno.stdout.writeSync`によるredrawごとの**full-frame同期write**が、
  terminal consumerが遅い場合（tmux 3.5a内のdetached pane等）にbackpressureでblockし、main threadを塞いで
  redraw/timer/入力が止まる。Pythonの直接pty（継続drain）では再現せず、tmux内で`working`更新に10.0/5.1/3.6秒の
  gapとして再現。timer飢餓・SQLite・同期terminal以外のwriteではない（`__TICK`/`__HB`は進行、`writeSync`例外なし、
  frame本文は更新）。
- 次（修正）: redrawを**非同期write＋coalescing**にし、write中は最新frameのみ保持して古いframeを破棄、有界レートで
  描画する。sync writeでevent loopを塞がない。frame順序と最終frame整合を保つ。B2/B3は同じ原因か別かを切り分ける。
- 正本: `docs/increments/increment-74.md`（調査ログ・原因・修正方針）。Human Gateは承認済み（実装開始）だが、
  計画の「timer飢餓」表現は「同期full-frame writeのblock」へ読み替えて実装する。
- 注意: 検証は**tmux内**で行う（直接ptyでは再現しない）。`inbox`のB1は「再現未確定」と古い記述が混在しているため、
  実装時に「tmuxで再現・原因=同期write」へ整理する。デバッグコードは全て除去済みで作業ツリーclean。

### 環境・配置（再開時の注意）

- binary: `0.2.1`（build `1cafc161a751c7854c4e63426e5b650b13b64d7cad95fabec1138baa07ee0c0f`、binary SHA-256
  `60f6904de9b5ea23a08af15498ca82716f6622f68fe50a10d57238c2acee955a`、embedded runtime
  `705c7126de2ccb716b544050eb398aa504c815d9db895f9ba376bdc296a73457`、source`010cd959`・`sourceDirty=false`）。
  installed launcher `~/.local/bin/henji`。buildは`deno task --config deno.v0.json henji:compile`（Deno 2.9.6厳密）。
- JSR: `@henji/harness@0.2.1`がlatest。`0.2.0`はpackaged READMEがstaleなままimmutableに残置。publishは
  `docs/operations/jsr-publish.md`の手順（README例のversion更新→gate→push→clean worktree→dry-run→device認証→
  registry/import検証→cleanup）。
- provider: built-in idは`openrouter-chat`/`openrouter-responses`/`openai-chat`/`openai-responses`。旧
  `openrouter`/`openai`は削除（互換aliasなし）。宣言providerは`providers/*.json`、protocolは
  `openai-chat-completions`または`openai-responses`のみ。credentialは`~/.config/henji-harness/{openrouter,openai}-api-key`
  （0600・単一トークン）。
- 検証の注意: TUI/pty検証は**隔離XDG**で行い、実configへ`default-selection.json`等を書かない。
- 未実施: Git tag、Forgejo Release、release automation（CIでのbinary build等）。releaseは安定後に別途計画する
  （利用者判断: ずっと先）。
- 履歴DB: このrepo workspaceの旧state DBはlegacy providerState非互換のため削除済み。他workspaceのstate DBは
  旧chat evidenceを含むとreadbackが失敗するため、必要時に同様に切捨てる。
- active external revision: `local/henji-base@sha256:82d67dd2…`。
