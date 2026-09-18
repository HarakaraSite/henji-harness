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

### Increment 74 — TUI表示凍結の修正（実装完了、tmux検証済み）

- 状態: **実装完了**。`v0:gate` exit 0。原因は`v0/tui/terminal.ts`の`Deno.stdout.writeSync`による
  full-frame同期writeが、遅いterminal consumer（tmux detached等）でmain threadを塞ぐこと。`CoalescingWriter`
  （非同期write＋連続full-frameの最新のみ保持）へ変更し、`DenoTerminal.flush`＋
  `TerminalLifecycle.restoreOnce`のflushで終了前に全writeを配送する。`TerminalPort.flush?()`を追加。
- 検証: focused test `tests/v0/increment_74_terminal_write_test.ts`（5件、`v0:test`へ追加）。
  masterをdrainしないptyでsyncはevent loopがblock（hung）、非同期は継続。tmux内source TUIで長時間turn
  （busy 95秒）と大出力turn（150秒）が最大wall gap 1.6秒で継続し凍結なし。`v0:check`/`fmt`/`lint`/gate exit 0。
- B2（`/sessions`）: 別原因を特定し、**increment-75で修正済み**（下記）。
- B3（PageUp履歴）: `a75bd052`は2 turn/24 messageのみで表示上限未到達。加えて利用者情報（2026-09-18）では
  「再現したりしなかったりする」＝間欠的。欠落の決定的証拠は未取得で、再現条件が必要。
- 正本: `docs/increments/increment-74.md`（実装・検証・B2/B3結果まで反映済み）。inbox B1〜B3更新済み。

### Increment 75 — `/sessions`一覧の耐性（実装完了）

- 状態: **実装完了**。`v0:gate` exit 0。`sqlite_history_store.ts`の`listWorker()`が1件の読めないrecordの
  `session_invalid`で全件失敗していた。record単位try/catchへ変更し、`session_invalid`のみskipして
  `skippedInvalid`へ加算、他エラーは再throwする。
- 原因record: `6e8de261-31a7-4dae-81bf-a7024723aac0`（workspace `967fa641…`、過去build `0.1.3`、embedded
  build manifestが現行validation不合格）。利用者許可を得て`store.delete`で削除。
- 検証: focused test `tests/v0/increment_75_session_list_skip_test.ts`（1件、`v0:test`へ追加）。実DBで
  `ok 5 skipped 1`→削除後`ok 5 skipped 0`。production TUI（installed binary、tmux）の`/sessions`で実Session
  5件が一覧され`session list unavailable`が出ないことを確認。
- 残観測（対象外）: 一覧5件は保存Definition digestが現行`builtin/default`（`e28fe12a…`）と異なりpickerで
  `unavailable`表示（exact revision契約による既知挙動）。過去build Sessionを削除するかは別途利用者判断。
- 正本: `docs/increments/increment-75.md`。inbox B2更新済み。
- B4（新規、利用者判断待ち）: `/sessions`は開くが既存Sessionのresumeが`session resume failed`。保存Definition
  digestが現行`builtin/default`と不一致で、roadmap F18（revision transition）未実装のため。原因は「履歴閲覧」と
  「Worker起動による継続」が同じ入口に混在し、`WorkerHostSession`先頭でref一致を要求していること
  （`worker_host_session.ts:244-253`）。admission invariantはlive generationの条件で閲覧には無関係。

### Increment 76 — 保存Sessionの閲覧と現行Definitionでの継続（実装完了）

- 状態: **実装完了**。`v0:gate` exit 0。継続: open時ref一致要求を削除し（`worker_host_session.ts`、
  workspace/agent検証は残置）、`worker_tui_session.ts`の`bindRecord`/`--continue`/`--session`/`switchTo`は
  現行解決済みDefinitionで継続。切替追跡は新規schemaを追加せず既存`turnExecutions`/`canonical_turns`を
  単一authorityとして導出（`session.definition`=現行binding）。閲覧: `human_history_open/page/detail/search`
  intentにoptional `sessionId`を追加し、pickerの`v`で選択Sessionの履歴をread-only overlay表示（active
  binding不変、Worker非起動）。`layout.ts`のpickerに`v view history`。
- 検証: focused test `tests/v0/increment_76_definition_transition_test.ts`（2件）と
  `tui_controller_overlay_test.ts`の`v` test。source/installed binaryのtmuxで、過去build Session
  `375ca4e7`の閲覧とresume（`resume failed`なし）、turn生成で`session.definition`が`e28fe12a…`へ更新、
  turn1-2は`cc214791…`のまま残ることを確認。increment_33の旧exact-ref reopen testは新契約へ更新。
- 設計注記（承認済み設計からの変更点）: 当初の「active sessionをgeneration 0個で開きsubmitでWorker起動」では
  なく、「閲覧はactive bindingを変えないread-only overlay」として実装。理由はincrement-76.md参照。active-lazyを
  明示的に必要とする場合は利用者判断。
- 正本: `docs/increments/increment-76.md`（設計・正本変更・実装状況）。roadmap F18/architecture適用済み。
  inbox B4更新済み。
- 次: 利用者判断待ち = (1) active-lazyを追加で必要とするか。過去build Session 5件は利用者承認のうえ削除済み
  （workspace `967fa641…`、listWorkerは0件）。変更は`f8f458b7`でcommit済み。digest範囲変更はIncrement 77提案
  （下記）でHuman Gate待ち。

### Increment 77 — builtin resource revisionをclosure内容で識別（正本変更案・Human Gate未承認）

- 状態: **計画中（正本・実装とも未変更）**。builtin Definition/toolのrevision digestが`embeddedRuntimeSha256`
  （binary同梱ランタイム全体）から作られ、無関係な修正でも変わる。externalはclosure内容digest
  （`canonicalDefinitionRevisionBytes`）で、builtinだけ不整合。
- 提案: build時にbuiltin resourceごとのclosure digestを算出し`BuildManifestV1.builtinResources`へ埋め込み、
  `builtinDefinitionRef`/`builtinToolDefinitionRef`はそれを使う。`embeddedRuntimeSha256`はbuild identityとして
  `turnExecutions.build`へ残す。既存SessionはIncrement 76のtransitionで現行へ進む。
- 次: 利用者承認（設計、manifest schema追加、roadmap/architecture変更）。承認後に正本適用→実装。
- 正本: `docs/increments/increment-77.md`。


### 環境・配置（再開時の注意）

- binary: `0.2.1`（build `b313a5469b3115db98d135f28dfc83497edb5b6983e21a5563e06f474ff1a810`、binary SHA-256
  `67838a32fe50b09f5f690939b3b9677b6e6fe1b17d49ad44b9a0b52b932566d9`）。increment-76実装後、commit
  `f8f458b7`の直前にbuildしたため`sourceDirty=true`（内容はcommit済みと同一）。installed launcher
  `~/.local/bin/henji`。buildは`deno task --config deno.v0.json henji:compile`（Deno 2.9.6厳密）。
  - 注: 実行中の`~/.local/bin/henji`があったため`cp`→`.new`→`mv`で原子的に置換した。sourceDirty=falseの
    artifactが必要なら現在のcleanなruntimeで再buildする。
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
