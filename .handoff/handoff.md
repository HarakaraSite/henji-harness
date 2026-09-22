# Handoff

## Records

### OpenCode Go chat SSEのterminal usage frame修正（Increment 101の欠陥、実装・検証・配置完了）

- 状態: 実装・検証完了。`v0:gate` exit 0。Session `b1ae02bf`の`provider response invalid`（deepseek-v4.1-flash
  effort `high`）の原因は、OpenCode Go chatが**terminal frame（`finish_reason`）に`usage`を同梱**して返し、
  `openrouter_sse.ts`がterminal確定前の非null usageを一律`invalid_usage_frame`で拒否していたこと。terminal frame
  （`finish_reason`が`stop`/`tool_calls`）が`usage`を持てるよう修正し、`usageSeen`を立てる。`finish_reason`を
  持たないusage frameは従来どおり拒否。focused test追加（terminal frameがusageを持つstop／tool_calls）。
- 検証: 実provider再probeでdeepseek-v4.1-flash effort `high`が`tool_calls`を正常に返すことを確認。focused test
  13件、`v0:gate` exit 0。glm-5.3-flash `high`で一度出た`unsupported_delta_shape`は再現せず（一時的の可能性、
  未確定）。
- 正本: `v0/agent/provider/openrouter_sse.ts`、`tests/v0/increment_101_provider_headers_test.ts`。commit
  `0255f8a4`。調査記録は`docs/research/pi-zot-command-surface-comparison.md`、
  `docs/research/external-agent-interface-comparison.md`（commit `80f477cf`）。
- 配置: clean commit `80f477cf`からDeno 2.9.7でbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `2fa03b6e…`、source `80f477cf…`、SHA-256 `75054799…`、embedded runtime `805b6958…`）。隔離XDG smoke
  exit 0。commit済み、pushは未実施。
- 次: 通常利用でOpenCode Go（特にeffort指定）を継続観察。再発時は実SSEを捕捉する。
- 注意: P1（`run`の構造化出力）は未着手。双方向RPC／ACPは将来課題（inbox P10）。

### Increment 103 — built-in base instructionの最小化と外部instruction直接読み込み（E4、実装・検証完了）

- 状態: 実装・検証完了。`v0:gate` exit 0。built-in `HENJI_COMMON_INSTRUCTION`を最小core（役割identityと
  credential/Authorization境界）へ縮小し、詳細方針（成果物忠実性、tool再利用、順序方針）を外部へ移した。
  外部baseは`$XDG_CONFIG_HOME/henji-harness/instruction.md`をinstall/activateなしで直接読み込み、あれば
  built-in coreを置換、無ければ最小core。contentはbyte-equivalent、source identity `user/instruction.md`＋
  content digestをattributionへ固定。managed `henji-instruction`（install/activate/XDG data store/
  `henji instruction` CLI）はproductionから削除（破壊的変更）。新モジュール
  `v0/agent/instructions/base_instruction.ts`。`henji_common.ts`最小化に伴いbuilt-in digestを再計算。
- 正本: `docs/increments/increment-103.md`。architecture（`henji-host-agent-worker.md`）・roadmap（F03/F06、
  Increment 51節は履歴注記）・README・`v0/agent/README.md`・`jsr.json`・inbox（E4削除）更新済み。
- 配置: clean commit `f179753f`からDeno 2.9.7でbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `d1bc25f7…`、source `f179753f…`、SHA-256 `bf8ba9a0…`、embedded runtime `838e8353…`）。隔離XDG smoke
  exit 0。利用者の`~/.config/henji-harness/instruction.md`へ雛形を配置済み（source identity `user/instruction.md`、
  content digest `sha256:10b04232…`、順序方針を含む）。
- 次: 通常利用で外部instructionの編集・反映を確認する。文言効果はmodel挙動依存でoffline検証不可。
- 注意: commit済み（`f179753f`）、pushは未実施。instructionのmanaged revision方式は廃止。`instruction/`ディレクトリ
  （旧activation binding置き場）は未使用のまま残置。R4（instruction自己改訂）とF27（`/rebuild`）は対象外。

### Increment 102 — 外部integration依頼の調査順序方針（A9、実装・検証完了）

- 状態: 実装・検証完了。`v0:gate` exit 0。共通instruction（`HENJI_COMMON_INSTRUCTION`）に「実装変更の前に
  既存configuration/declaration/dataで満たせるかを確認し、外部service/provider/API/dependencyの追加では
  official contractを先に取得、実装内部は不足時か利用者が明示した時だけ調べ、最小十分な変更を選ぶ」段落を追加。
  planner roleを「smallest sufficient changeを決めるのに必要な範囲だけ調べる」へ変更。
  `managed_instruction.ts`の`BUILTIN_REVISION_DIGEST`／`BUILTIN_CONTENT_DIGEST`を再計算
  （revision `1edd3953…`、content `b1b8e58b…`、`verifyBuiltinHenjiBaseInstructionIdentity()` true）。
- 正本: `docs/increments/increment-102.md`。inbox A9は採用して削除済み。architecture・roadmapは不変。
- 配置: clean commit `11059d56`からDeno 2.9.7でbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `f5584c87…`、source `11059d56…`、SHA-256 `4b1ccb62…`、embedded runtime `fc6524d8…`）。
  隔離XDG smoke exit 0。commit済み、pushは未実施。
- 次: 通常利用で、外部integration依頼時にmodelが先にofficial contractと宣言十分性を確認する順序をとるかを観察し、
  不十分なら文言を調整する。実provider callを伴う確認は承認が必要。
- 注意: 文言の効果はmodel挙動依存でoffline検証不可。active base instructionはbuilt-in（外部instructionが
  activateされていれば本変更は効かない）。

### Increment 101 — auth profile一般化と宣言request header（実装・検証完了）

- 状態: 実装・検証完了。`v0:gate`（check/fmt/lint/test）exit 0。auth profileをpattern検証
  （`isAuthProfileId`、reserved `providers`／`instruction`拒否）へ一般化し、credentialを
  `$XDG_CONFIG_HOME/henji-harness/<profileId>`から解決する。宣言`ProviderDeclarationV1`にoptional
  `headers`（`{credential}`はChat経路のみ・1 header、`{sessionId}`、部分置換、protocol-aware
  `authorization`）を追加し、declared chat transportとdeclared Responses `defaultHeaders`へmergeする。
  `createProductionPhysicalIo`に`sessionId` seamと`credentialSources`／`credentialPresence`を追加。
  provider evidenceのauthProfile検証もpattern化。chat SSE parserをOpenCode Go形状
  （`usage:null` chunk、terminal後の`choices:[]` usage frame）へ互換化。
- 正本: `docs/increments/increment-101.md`（決定・実装範囲・parser互換・OpenCode Go宣言例・受入手順・検証）。
  architecture `multi-provider-routing-and-auth.md`／`henji-host-agent-worker.md`、roadmap F02／F06、
  inbox E5更新済み。
- 実provider probe（2026-09-22、承認済み、計9 request、source dev launcher、`/tmp/henji-i101-probe/`）:
  auth/header基盤成立（200、`user-agent`／`x-opencode-session`送信）。chatは`glm-5.3-flash`で単段text turn
  とtool call継続が成立。responsesは`gpt-5.6-luna`で単段text turn成立。`grok-4.6`はprovider側の一時エラーで
  未確認。`reasoning_content`は無視され、tool call継続にechoは不要だった。
- 次: 利用者によるIncrement完了判断。clean commit `bacdde5f…`からDeno 2.9.7で`dist/henji`をbuildし
  `~/.local/bin/henji`へ原子的に配置済み（build `bde72a4a…`、source `bacdde5f…`、SHA-256 `ebf8ad78…`、
  embedded runtime `4a428546…`）。responsesのcatalogは確認済みmodel（`gpt-5.6-luna`等）に限定する。
- 注意: commit済み（`bacdde5f`）。pushは未実施。Responses経路の非Bearer auth置換、URL/query
  templating、catalog capabilities（vision）、Anthropic／Google／Azure／Bedrockは対象外。
  `{productVersion}` placeholderは将来候補。

### instruction改善候補 — 外部integration依頼の調査順序（未採用メモ）

- 状態: Session `c7c7a106`のturn 13（「プロバイダにopencode goを追加したい」）とturn 15（同種）で、modelは
  外部API調査と並行して実装内部（credential resolver、transport/request/contract、`worker_physical_io.ts`、
  `loop.ts`、`worker_protocol.ts`等）を深く読み、`delegate_to_planner`で実装計画まで進めた。利用者は5〜7分で
  キャンセル。共通instructionに「既存configuration/declarationで足りるかを先に判定し、実装内部は不足時だけ見る」
  方針がない。利用者は2026-09-21に「帰宅するのでメモ」と判断（実装は未着手）。
- 次: 採用するなら、共通instruction（`v0/agent/instructions/henji_common.ts`）への段落追加と、planner role
  （`v0/agent/instructions/roles/planner.ts`）のsmallest-sufficient化を比較し、文言確定後に実装・rebuild・配置。
- 正本: `docs/experience/normal-use-inbox.md` A9。
- 関連メモ: base instructionのexternal revisionはinstall/activateが必要で`AGENTS.md`より重い。利用者は
  「Definitionとinstructionは扱いを変え、instructionは`AGENTS.md`同様に簡単に読み込めるほうがよい」と
  2026-09-21に判断（未採用）。`docs/experience/normal-use-inbox.md` E4。
- 注意: 現在activeなbase instructionはbuilt-in（`~/.config/henji-harness/instruction/active-v1.json`なし）。
  本handoff内の「active external revision `local/henji-base@sha256:82d67dd2…`」は現状と一致しない（別途確認）。

### OpenCode Go API probe

- 状態: Deno TypeScriptの一時probe（`/tmp/henji_opencode_go_probe.ts`）で、OpenCode Goの`GET /models`、Chat Completions、Responsesを各1回、利用者許可のもと実行。`/models`は200・37 model IDs、chatは`glm-5.3-flash`で200 SSE、Responsesは`grok-4.6`で200 SSEと`response.completed`を確認。key・Authorizationは出力／reportへ保存していない。
- 次: Henjiへ追加する場合は、ChatとResponsesを別provider declarationに分け、`opencode-go-api-key` auth profile、`x-opencode-session`／User-Agent送信、current model catalogの更新を実装計画にする。現時点ではsource・provider JSONを変更しない。
- 正本: `docs/research/opencode-go-api-probe.md`、OpenCode Go公式docs（`https://opencode.ai/docs/go/`）、probe report `/tmp/henji-opencode-go-probe-1789997131.json`
- 注意: 公式docsの固定model route表と実`/models`の37件には差があり、未掲載modelのprotocolは未確認。chat probeは`max_tokens:32`で`finish_reason:length`となり、tool callは未検証。

### JSR 0.4.0 release preparation and Deno PATH

- 状態: `@henji/harness@0.4.0`をclean release worktreeからpublish完了。Authorization successful、Successfully publishedを確認し、JSR metadataのlatestが`0.4.0`、exact-version importとexport列挙も成功。commit `da4b282d`はForgejo `origin/main`と一致。
- 次: なし。
- 正本: `jsr.json`、`README.md`、`mod.ts`、`docs/operations/jsr-publish.md`
- 注意: Deno 2.9.7は既存の`/home/masat.guest/.local/bin/deno`から`/usr/local/bin/deno`へ配置し、`/usr/local/bin`（既存PATH）で`command -v deno`が成功する。publish transcriptは`/tmp/henji-jsr-publish-0.4.0.tty.log`に残る。

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
- 検証: focused test `tests/v0/increment_76_definition_transition_test.ts`（3件）と
  `tui_controller_overlay_test.ts`の`v` test。source/installed binaryのtmuxで、過去build Sessionの閲覧・
  lazy選択・resume、turn生成で`session.definition`が現行digestへ更新、過去turn attributionが不変であることを
  確認。increment_33の旧exact-ref reopen testは新契約へ更新。
- lazy activation: pickerで保存Sessionを選ぶと`LazyWorkerSession`（`TuiActiveSession`）としてactive sessionに
  なる（Worker generation 0個）。transcript/position/model/historyはrecordから返し、submit等のlive操作で初めて
  現行Definitionのgenerationを起動する。startup `--session`/`--continue`と`createNew`はeager。read-only閲覧
  overlay（`v`）はlazyとは別に残す。
- 正本: `docs/increments/increment-76.md`（設計・正本変更・実装状況）。roadmap F18/architecture適用済み。
  inbox B4更新済み。
- 次: 利用者判断待ちなし。digest範囲変更はIncrement 77提案（下記）でHuman Gate待ち。

### Increment 77 — builtin resource revisionをclosure内容で識別（実装完了）

- 状態: **実装完了**。`v0:gate` exit 0。`BuildManifestV1`へoptional `builtinResources`を追加し、build scriptが
  builtin default／planner／bundled toolのentry＋local closureからclosure digestを算出してmanifestへ埋め込む。
  `builtinDefinitionRef`／`builtinToolDefinitionRef`はそのdigestを使い、compiled manifestでentryが無ければ
  typedに失敗（development manifestのみ固定identityへfallback）。`embeddedRuntimeSha256`はbuild identityとして
  `turnExecutions.build`へ残す。roadmap F07とarchitecture適用済み。
- 検証: focused test `tests/v0/increment_77_builtin_revision_test.ts`（5件、`v0:test`追加）。closure digestは
  TUI追記で不変、tool実装追記でtoolのみ変化、contract境界（`worker_agent_api.ts`）追記で不変であることを直接確認。
- closure境界（#1）: externalと同様に`@henji/agent`（`worker_agent_api.ts`）をcontract境界として辿らず、
  type-only edgeを除外。builtin defaultのclosureはwrapperのみ、toolは自身の実装helperのみ。revisionは
  artifact identityでありbehavior変更の根拠にはしない（behaviorは観測）。
- 正本: `docs/increments/increment-77.md`。roadmap F07とarchitecture適用済み。
- 次: 利用者判断待ちなし。

### Increment 79 — product正本とdelegation契約の整合（実装・検証完了）

- 状態: Session継続時のDefinition選択、Provider外部化とbuilt-in ID、F19 attribution、historical tool replacementを
  architecture／roadmap／READMEで現行sourceへ整合した。`delegate_to_planner`のmodel-visible説明をexternal
  `subagent:planner`にも成立する契約へ変更し、回帰testを追加した。focused 63件、`v0:check`、`v0:fmt`、
  `v0:lint`、`git diff --check`はpass。変更はcommit済み。
- 次: 利用者から明示依頼があればpushする。runtime protocolとprovider requestは不変で、installed binaryの
  rebuild・配置は未実施。
- 正本: `docs/increments/increment-79.md`。
- 注意: conceptの意味、通常利用メモ、live provider、実TTYは今回変更・検証していない。


### Increment 80 — `web_fetch`取得URLのtool activity表示（実装・検証完了）

- 状態: 実装・検証完了。`v0:gate`（check/fmt/lint/test）exit 0。`toolActivityPreview`に`web_fetch` caseを
  追加し、live tool activity・保存履歴のtool行・direct renderer（`toolCallText`）で取得先URLを
  `web_fetch <url> …`／`✓`／`✗`として表示する。長URLは既存96-byte headで省略。redirect後final URLとtool result
  本文は表示対象外。focused test 3件追加（`tests/v0/tui_tool_preview_test.ts`、15件pass）。
- 検証中に基準commit `6cdfc407`の`v0/agent/README.md`がdeno 2.9.6の`v0:fmt`に不合格（prose reflowのみ、
  increment-79の「fmt pass」記載と不一致）と判明。利用者承認を得てdeno fmtで整形（意味変更なし）。
- 次: なし。変更はcommit・push済み（`f3f22934`）。compiled binaryをclean treeからrebuildし`~/.local/bin/henji`へ
  原子的に配置済み（build `a2300b1d…`、source `f3f22934…`、version `0.2.1`）。
- 正本: `docs/increments/increment-80.md`。inbox S7は削除済み。
- 注意: runtime protocol、provider request、Session/Definition schemaは不変（binaryはTUI表示変更を含むためrebuild）。
  roadmap F01への取得URL表示追記は未実施（roadmap変更は別承認）。

### Increment 81 — フッター3行化（実装・検証・配置完了）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。footerを1行目status、2行目cwd・Session短縮ID・Session title、
  3行目root provider・model・effortへ変更（`v0/tui/layout.ts`）。title未設定は`untitled`、幅・高さ不足時は
  既存方針で省略。focused test（`increment_13`／`increment_15`／`tui_conversation_presentation`）とTUI suite
  91件pass。roadmap F01／F10／TUI節、architecture Surface記述、`v0/agent/README.md`も3行へ更新。
- 次: なし。commit・push済み（`830fcc51`＝S8メモ、`69abbd2d`＝footer3行化）。compiled binaryをclean treeから
  rebuildし`~/.local/bin/henji`へ原子的に配置済み（build `f89e4500…`、source `69abbd2d…`、version `0.2.1`）。
- 正本: `docs/increments/increment-81.md`。inbox S8（startup header表示候補）記録済み。
- 注意: Worker protocol、Presentation contract、Session schemaは不変。実TTYでの表示確認は未実施。

### Increment 82 — startup headerのbase instruction表記・skills複数行・時刻TZ追従（実装・検証・配置完了）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。`startup_render.ts`で`base:`→`base instruction:`、`skills:`を値幅で
  `, `境界優先に折り返す複数行表示へ変更。ラベル列を18 cellsへ広げ、複数行描画を`headerContentLines`へ分離
  （将来のMCP欄が再利用可能）。時刻表示を`terminal_text.ts`の`localTimestampText`（ローカル日時＋
  `Intl.timeZoneName:'short'`、Asia/Tokyo・en-USでは`GMT+9`）へ集約し、startup headerとsession pickerの
  更新日時を統一。focused test pass（JSTと`TZ=UTC`）。
- 次: なし。commit・push済み（`c7ab8503`）。compiled binaryをclean treeからrebuildし`~/.local/bin/henji`へ原子的に
  配置済み（build `53bc1270…`、source `c7ab8503…`、version `0.2.1`）。
- 正本: `docs/increments/increment-82.md`。inbox S8は未採用のMCP欄予約のみへ縮小。
- 注意: MCP欄は表示対象resourceが未採用のため実装しない。`/history export`・JSONL exportはISO UTCのまま
  （data artifact）。Worker protocol、Presentation contract、Session schemaは不変。実TTY確認は未実施。

### Increment 83 — streaming中のassistantラベル色（実装・検証・配置完了）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。`conversation_renderer.ts`のtone判定を`assistant>`または
  `assistant~`で`assistant`へ揃え、streaming開始の最初のframeから`assistant~`が黄色になる。focused test追加
  （`tui_conversation_presentation_test.ts` 14件pass）。
- 次: なし（Phase A完了）。commit・push済み（`9fce3c89`）。compiled binaryをclean treeからrebuildし
  `~/.local/bin/henji`へ原子的に配置済み（build `66d29bec…`、source `9fce3c89…`、version `0.2.1`）。次は
  Phase B（assistant本文レイアウト＋Markdownタグ着色、`**bold**`はSGR1）をIncrement 84で進める（利用者承認済み）。
- 正本: `docs/increments/increment-83.md`。
- 注意: 最終frameでstyleを注入する境界、canonical transcript、Presentation contractは不変。実TTY確認は未実施。

### Increment 84 — assistant本文の読みやすいレイアウトとMarkdownタグ着色（実装・検証・配置完了）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。renderer seamを`render(text, phase, width)`＋inline spanへ拡張し、
  自前line-based renderer（`v0/tui/assistant_layout.ts`）でword wrap（CJK対応）・list/heading/quote hanging
  indent・`|`pipe表（alignment marker・セル折り返し・列最小3・recordsフォールバック）・fence保護・
  `**bold**`/backtick code spanを実装。既定`assistantRenderer`を`markdownAssistantRenderer`へ差し替え、
  `LayoutRow.spans`＋最終frameの複数span描画でheading=blue/list/code=green/table=dim/quote=magenta/bold=SGR1を
  注入。focused test 8件＋TUI suite追加test pass。
- 次: commit・push済み（`84e8e920`＝参照実装調査、`1a472e19`＝Increment 84）。compiled binaryをclean treeから
  rebuildし`~/.local/bin/henji`へ原子的に配置済み（build `72b073f0…`、source `1a472e19…`、version `0.2.1`）。
  実機で本文レイアウト・表・タグ着色を確認する。**roadmap F01/F10/TUI節、architecture Surface記述、
  `v0/agent/README.md`の正本更新は別承認**（increment-84計画に明記）。
- 正本: `docs/increments/increment-84.md`。参照実装調査は`docs/research/terminal-markdown-rendering-comparison.md`
  （parser外部ライブラリ化は未決メモ）。
- 注意: 会話logのみ対象で、canonical transcript・`/history`・export・Presentation contractはplainのまま。
  長履歴での毎frame再parse性能は未確認。

### Increment 85 — recoverable stopの可視化とprovider deadline延長（実装・検証・配置完了）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。`controller.ts`のsettlementから自動`popRecovery()`を削除し、
  recoverableではeditorを変更せず`<reason>; recoverable input available; use /recover`を表示、`/recover`で
  明示復元。`DEFAULT_PROVIDER_TIMEOUT_MS`を120,000→180,000へ変更。roadmap F01/F02/TUI節・architecture・
  `v0/agent/README.md`・`increment_13` testを更新。inbox B5に由来追記、E3（runtime config）追加。
- 次: なし。commit・push済み（`d86c716e`＝inbox候補、`6a1b51e5`＝Increment 85）。compiled binaryをclean treeから
  rebuildし`~/.local/bin/henji`へ原子的に配置済み（build `d29f7b8e…`、source `6a1b51e5…`、version `0.2.1`）。
  実機でrecoverable表示（自動復元しない）と180秒deadlineを確認する。
- 正本: `docs/increments/increment-85.md`。
- 注意: `commit proposal invalid`の恒久diagnosticは未実装（B5）。Host runtime tunablesのconfig化はE3、recovery
  lane削除はS9、入力履歴のセッション横断保存/snippetはS10で別increment。隔離再現環境`/tmp/opencode/henji-repro`
  （credentialコピー0600を含む）が残っている。

### Increment 86 — observation journalingの非ブロッキング化（実装・検証・配置完了、B6は部分クローズ）

- 状態: 実装・検証・配置完了。`v0:gate` exit 0。`HistoryPersistencePort`に`appendExecutionEvents`（1接続1
  トランザクションのバッチ）と`validateExecutionEvent`を追加。`WorkerHostSession`はworker観測をbufferへenqueueし、
  256件/25msでflush、`appendJournal`をchoke pointとしてhostイベント前にflush、commit proposal/turn_end/closeは
  publish前にflush。1観測=1行・schema不変。focused test 3件＋increment_40/41 pass。
- 実product確認（2026-09-19、isolated XDG・実provider・tmux内installed binary）: 8 steps/13 toolsのturnが
  `ok=1 stop=final`で正常完了、busy経過時間は`00:03`→`02:44`まで概ね連続更新し**従来の完全凍結は再現せず**、
  journalは6310件がordinal 1..6310の欠番なし。batchflush実測256件15〜42ms。
- 次: commit・push済み（`04efd19b`＝B6記録、`a2e7300d`＝Increment 86）。binaryは`a2e7300d`から配置済み。
  **残存課題**: 約`01:11`で16秒のstallが1回（同時刻は最大358件/秒のprovider観測バースト）。batchflushでは説明
  できず原因未特定。CPU profile等での追跡は未実施。tmux session `henjiv`（isolated XDG）は起動したまま。
- 正本: `docs/increments/increment-86.md`（第三者レビュー結果と実product確認を記載）。
- 注意: 観測行のcoalesce（B）とTUI render別thread化（C）は対象外。B6は残存stallのため未クローズ（部分クローズ）。

### Increment 92 — auxiliary exact capture欠落とjournal failure停止の根本修正

- 状態: 原因確定後の承認済みSlice 1–5を実装し、通常code／test reviewはfindingなしでGo。production auxiliary
  dispatchはcredential／cancel確認後にexact capture→metadata request start→同一bytes fetchを一元発行する。
  pre-commit journal failureはfirst-code-wins latchからtyped non-canonical outcomeを即時返し、canonical adoptionを
  禁止して次turnでgenerationを交換する。non-canonical indexingの過去Session transcript decode経路も除去した。
  focused回帰と唯一のauthoritative `v0:gate`はexit 0。実provider compiled-CLI E2Eもexit 0で、root→web_search→root
  の3 request startと3 exact streams（auxiliary 491 bytes）がv6で対応し、executionはcompletedまでsettleした。
- 次: 利用者によるIncrement完了判断。必要なら別途、binary build／配置を指示する。
- 正本: `docs/increments/increment-92.md`（原因、review済み計画、実装結果、検証結果）。
- 注意: E2E用一時binaryだけを`/tmp/henji-i92-e2e-build-qKNSjg`へbuildし、配置済みbinaryは変更していない。
  E2E証拠は`/tmp/henji-i92-e2e-run-vuszI7`。no-session settlement後のack journalがsettled v6 executionに拒否され、
  保存済みcontext manifestがあるのにartifactが`contextCapture: failed`へ上書きされる別問題を観測した。今回の停止は
  再発せず、provider evidence／exact bytesはcomplete。commit、push、releaseは未実施。concept、architecture、roadmap
  は変更していない。`reproductions/deno-worker-sqlite-wake/`は撤回したDeno仮説の調査遺物。

### Increment 94 — 目的別history authorityの再設計（history v7、完了）

- 状態: Human Gate 3で利用者承認を得てSlice Gのproduction破壊的cutoverを実施した。production selector、Session／
  diagnostic CLI、production E2E layoutは`history-v7.sqlite3`／`locks-v7`だけを使い、production module graphから
  v6 store／pipelineを外した。実利用Session `db175b53`の追試で、normal artifactの全protocol trace、context bytesの
  inline再保存、commit transcript二重格納、未使用semantic projection複写を検出し、sourceを修正した。contextは
  immutable content＋mandatory item relation、normal artifactは空trace、transcriptはsingle-copyとなり、durable
  exportもimmutable contentを含む。その後の通常code／test reviewで、settlement transaction間crashによる再open
  不能、human projectionの背景欠落／stale非表示、projectionとrelation counterのSession／execution長依存、exportの
  relation／manifest欠落を確認し修正した。terminalとsettlementは単一transaction、projectionはmetadata-onlyかつ
  execution単位cache、relation counterはdelta更新、human pageはcontext／request／diagnostic locatorとstale件数を
  表示し、exportはsemantic relation／context manifest／recall relationを含む。focused regression 21件と関連test、
  authoritative `v0:gate`は通過済み。配置済みbinaryの実provider Session `e284da25`もread-onlyで確認し、1 turn／
  3,000 runtime eventを37 semantic occurrenceへ保存、context 20件をimmutable contentへ正規化、inline blobなし、
  transcript single-copy、normal trace／diagnostic attachment／未使用projectionなし、backlog 0、settlement・canonical
  adoption・SQLite integrity正常を確認した。その後利用者がHuman Gate 4でIncrement完了を承認し、旧v6／v4／v5 DBの
  削除を明示許可した。state treeから`history-v4.sqlite3`／`history-v5.sqlite3`／`history-v6.sqlite3`（各-wal／-shm）
  と`locks-v4`／`locks-v5`／`locks-v6`を削除した（releaseは未実施）。
- 次: なし。v7常用で具体的な利用上の観測が生じたら通常利用メモまたは新incrementへの採否を判断する。
- 正本: `docs/increments/increment-94.md`（Slice A〜Gの実装結果、計測、Go判断、未確認範囲、完了・旧DB削除）。
- 注意: v7は`history-v7.sqlite3`／`locks-v7`を使い、v6 migration、dual-read/write、fallbackを作らない。
  Human Gate 2は未発動で実provider diagnostic E2Eは未確認。今回確認した`e284da25`は`normal-v1`の1 turnであり、
  長期Sessionの処理量契約を単独で追加実証するものではない。通常review修正後のauthoritative `v0:gate`初回は追加test
  fixtureの必須field不足だけでtype check停止し、fixture補正後の全体再実行はexit 0。実装commitは`7383daef`。
  配置済みbinaryはbuild `0c0f1f71…`、source `7383daef…`、SHA-256 `47335a0b…`で隔離XDG smoke成功。

### Increment 95 — 会話ログのPageDownがassistant本文で停止する修正（実装・検証完了）

- 状態: 実装・検証完了。保存Session再開後の会話ログで、PageUpで先頭へ到達後にPageDownしてもassistant本文で
  停止し先へ進めない事象（利用者観測2026-09-21、inbox B3）を修正した。原因は`v0/tui/layout.ts`の`logRows`が
  assistant entryの全行へ`sourceScalarOffset: 0`を固定し、`TuiRenderer.scrollPage`のアンカー探索
  （`entryId`＋`sourceScalarOffset`）が常にentry先頭行へ解決されること。行ごとに単調増加するoffsetを付与した。
  回帰test「retained PageDown advances through a large assistant entry after oldest」を
  `tests/v0/tui_retained_terminal_test.ts`へ追加（修正を戻すと失敗、修正後pass）。実Session `e284da25`の
  canonical transcript復元でも停止解消を確認。focused test 39件、`deno check`、`fmt`、`lint`、
  `git diff --check`は成功。
- 次: 利用者によるIncrement完了判断。実TTY目視は未実施。
- 配置: `scripts/build_henji.ts`の`EXPECTED_DENO`を2.9.7へ変更（commit `70972d37`）し、clean commit
  `70972d37`からDeno 2.9.7で`dist/henji`をbuildして`~/.local/bin/henji`へ原子的に配置済み（build `3b202074…`、
  source `70972d37…`、SHA-256 `aa80dbf7…`、embedded runtime `44c6c625…`）。commit・push済み。
- 正本: `docs/increments/increment-95.md`。inbox B3は本incrementへ採用し削除済み。
- 注意: 履歴ビュー（`/history`、pickerの`v`）は`wrap`経由で元から正常で変更していない。roadmap／architectureは
  未変更。検証中に実stateへ作成した一時Sessionは削除済み（残存は`e284da25`／`db175b53`のみ）。

### Increment 96 — assistant Markdownの見出し全行着色と`***強調***`の緑化（実装・検証完了）

- 状態: 実装・検証完了。会話ログのassistant本文で、Markdown見出し（`#`／`##`／`###`等）を`#`記号だけでなく
  内容込みの行全体（折り返し継続行も）青へ、強調`*`／`**`／`***`をいずれも緑（`emphasis` tone）へ変更した
  （proseの強調にボールドは使わない）。`v0/tui/assistant_layout.ts`（見出しspanの全行化、triple/double/single
  強調の検出、隣接star分離）、`v0/tui/conversation_renderer.ts`（`emphasis` tone追加）、`v0/tui/tui_renderer.ts`
  （`emphasis`→`GREEN_SGR`）。初版は`***`のみ緑化したが、実際の出力の強調は`**`（2個）で、利用者の訂正により
  3種すべてを緑（`*`記号を含む全体）とする最終契約へ更新した。さらに、wrap後の各行へspanを適用していたため
  折り返し境界をまたぐ強調／inline codeが無着色だった問題を、`wrapCellsWithSource`でsource offsetを追跡し
  `clipSpans`で各行へクリップする方式で修正した。increment-84 layout testと
  `tui_conversation_presentation_test.ts`の期待を新契約へ更新。authoritative `v0:gate`はexit 0。
- 次: なし（利用者が常用中。不満が出たら通常利用メモへ起票）。実TTY目視は未実施。inbox S5（assistant本文
  rendering）は利用者判断で完了としinboxから削除。次increment候補はinboxの未採用一覧を参照。
- 配置: commit `c3bfb157`からDeno 2.9.7で`dist/henji`をbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `3ff6f3c0…`、source `c3bfb157…`、SHA-256 `bf44b2c3…`、embedded runtime `eeccc928…`）。commit・push済み。
- 正本: `docs/increments/increment-96.md`。
- 注意: 履歴ビュー（`/history`）とPresentation contractは不変。table header cellの`bold` toneは維持。inbox S11／
  S12（`/history`の可読性・別プロセス参照viewer）は未採用候補として記録済み。

### Increment 97 — recovery laneの削除（S9採用、実装・検証完了）

- 状態: 実装・検証完了。利用者がinbox S9（recovery laneの削除）を採用。recoverable settlementではeditorを
  変更せず停止理由をstatusへ示し、recovery slotへ退避しない。再送は入力履歴（Up）。recovery待ちでも新taskの
  submitとnavigationをブロックしない。`/recover` slash commandとhelp行、footerのrecovery lane表示を削除。
  `pending_input.ts`（recovery slot／`recover*`／`hasRecovery`／side-effect warningを削除、`clearActiveTask`／
  `clearSteering`追加、`snapshot`は4 laneのみ）、`controller.ts`（recoverable分岐、`popRecovery`、`/recover`、
  `hasRecovery`ブロック除去、status文言）、`controller_editor.ts`（`recover()`削除）、`slash_command.ts`、
  `startup_render.ts`、`editor_render.ts`、`layout.ts`。正本: architecture（recoverable settlement節）、
  roadmap F01（`/recover`除去）。focused testと`deno check`／`fmt`／`lint`／`git diff --check`は成功。
- 次: 利用者によるIncrement完了判断。実TTY目視は未実施。
- 配置: commit `053b60b0`からDeno 2.9.7で`dist/henji`をbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `c28c32f3…`、source `053b60b0…`、SHA-256 `4d85043c…`、embedded runtime `fb680c75…`）。commit・push済み。
- 正本: `docs/increments/increment-97.md`。inbox S9は採用し削除済み。
- 注意: 未消費steering／follow-upの救済は対象外（必要時に別途設計）。decoderの`unknownAfterBareEscape`で
  bare Esc直後の1回目のarrowがunknownになる挙動は既知で対象外。

### Increment 98 — コードの無着色化とPageUpのoldest到達修正（実装・検証完了）

- 状態: 実装・検証完了。assistant本文のinline code（`` `text` ``）とfenced code blockを無着色にした
  （`AssistantSpanTone`から`code`を削除、SGRマップの`code: GREEN_SGR`も削除。list／強調の緑は維持）。
  また、会話ログのPageUpで`nextStart`がentryIdなし行（startup header）に入ると上方探索が失敗し
  `latest()`で最下行へ戻っていた問題を、`direction==='up'`では`oldest`へ遷移するよう修正した。
  実Session `e8e99332`（startup header込み）で`logStart=46`からPageUpが最下行へ飛ぶことを再現し、修正後に
  `oldest`へ到達することを確認。回帰test「retained PageUp reaches oldest across the startup header」を
  `tui_retained_terminal_test.ts`へ、code無着色のtestを`increment_84_assistant_layout_test.ts`へ追加。
  authoritative `v0:gate`はexit 0。
- tmux確認: 完了（production TUI 100x45、session `e8e99332`をresume）。PageUpで`history rows 1-39/293`の
  先頭（startup header）へ到達、inline／fenced codeが無着色、見出し青・強調緑は維持。隔離XDGコピーは
  resume不可（WAL整合）のため実stateをread-onlyで使用。
- 次: 利用者によるIncrement完了判断。
- 運用: `AGENTS.md`へSurface変更検証ルールを追加（`af43fbe1`）。TUI Surface変更はtmux実経路確認を必須、
  実provider確認は承認必須。
- 配置: commit `fc81813d`からDeno 2.9.7で`dist/henji`をbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `e0472268…`、source `fc81813d…`、SHA-256 `6e2b0a8a…`、embedded runtime `b5b908dd…`）。commit・push済み。
- 正本: `docs/increments/increment-98.md`。
- 注意: list marker・table・見出し・強調の着色は維持。履歴ビュー（`/history`）は対象外。

### Increment 99 — `/history`廃止と`henji history` CLI統一（S11/S12統合、実装・検証完了）

- 状態: **実装・検証完了**。利用者判断で`/history`・`/history export`・`/history export all`・pickerの`v`を廃止し、
  `henji history` CLIへ統一した。3種類: `session`（resume時のメインlog相当＝committed canonical turn、
  `user>`／`assistant>`／`tool>`label、tool結果は`tool>`へ畳み込み`tool<`なし、生assistant Markdown）／
  `canonical`（Markdown）／`detail`（JSONL、non-canonical含む）。既定は`--view session`・`--session --latest`、
  **stdoutのみ**（ファイルは`> file`）、`--follow`なし、組み込み検索なし（viewer検索で代替）。read-only seam
  （`readOnly` option、schema作成・reconcile・lockなし）、単一snapshot read、空DBは`# no history` exit 0。
  TUIはhumanHistory overlay／export／picker `v`／presentation contractの`human_history_*`を削除。正本
  （roadmap F01／F05、architecture）更新済み。`v0:gate` exit 0。
- 次: 利用者によるIncrement完了判断。
- 配置: commit `3679b16b`からDeno 2.9.7で`dist/henji`をbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `73e5a7ae…`、source `3679b16b…`、SHA-256 `547415dd…`、embedded runtime `9dab6947…`）。installed binaryで
  `henji history --latest --view session|canonical|detail`、`--session e8e99332`（短縮ID prefix）、空XDGで
  `# no history` exit 0を確認。commit・push済み。`--session`は完全UUIDまたは8文字hex短縮IDのprefixを受け付ける。
- 正本: `docs/increments/increment-99.md`（実装結果・検証を記載）。inbox S11／S12は本計画へ採用し削除済み。
- 注意: `DenoHistoryExporter`／`DenoHumanHistoryExporter`クラスは残置（production未使用）。non-canonicalの
  人間可読viewは将来項目。F10の陳腐化更新は別承認。

### Increment 100 — provider request deadlineが実streamで発火しない問題（実装・検証完了）

- 状態: **実装・検証完了**。利用者はproduct動作 **B（total deadline既定180秒を維持し、確実に発火）** を選択。
  原因は**macrotask timerのstarvation**で確定（ローカルの連続SSE burst（gapなし）に対し`timeoutMs: 1000`でも
  15秒abortしないことを再現。既存ローカルテストは200ms間隔でloopがyieldしていたため非再現）。
  `ResponsesApiModel.generate`の`for await`loopに`Date.now() - startedAt >= timeoutMs`判定を追加し、
  `controller.abort()`＋`provider_timeout`をthrow。chat経路（`openrouter_transport.ts`＋
  `openrouter_sse.ts`の`readSseResponse`）も成功chunkごとに`isTimedOut()`（elapsed版）を判定するよう修正。
  timerはno-data用に維持。同種箇所をprovider/tool/Hostで監査し、`auxiliary_request`（arrayBuffer）・
  `web_fetch`（有界）・bash（subprocess）・Host側timer（macrotask駆動）は影響なしと確認。
- 検証: focused test `tests/v0/increment_100_provider_deadline_test.ts`（3件、Responses連続／chat連続／stall）、
  `agent:provider-stream-compatibility:test` 20件、`deno check`／`fmt`／`lint`／`git diff --check`、`v0:gate` exit 0。
- 次: 利用者によるIncrement完了判断。実provider確認は未実施（承認必要）。
- 配置: commit `2beb6351`からDeno 2.9.7で`dist/henji`をbuildし`~/.local/bin/henji`へ原子的に配置済み
  （build `2cf73932…`、source `2beb6351…`、SHA-256 `976d2e2c…`、embedded runtime `5d028555…`）。commit・push済み。
- 正本: `docs/increments/increment-100.md`（原因・決定・修正・検証）。
- 注意: 実provider callは利用者承認が必要。Increment 99とは別。

### 環境・配置（再開時の注意）

- binary: `0.4.0`。OpenCode Go chat SSE修正と調査記録を含むclean commit `80f477cf…`からDeno 2.9.7でbuildし、
  `dist/henji`と`~/.local/bin/henji`へ原子的に配置済み（build `2fa03b6e…`、file SHA-256 `75054799…`、
  embedded runtime `805b6958…`）。`scripts/build_henji.ts`の`EXPECTED_DENO`と`README.md`のQuick Startは2.9.7。
  現在のbuild/source identityは`~/.local/bin/henji --version`を正本とする。
- base instruction: built-inは最小core。外部は`~/.config/henji-harness/instruction.md`を直接読み込む
  （source identity `user/instruction.md`）。雛形は`docs/operations/base-instruction-template.md`。managed
  `henji instruction` CLIは削除済み。
- JSR: `@henji/harness@0.3.0`がlatest。`0.2.0`はpackaged READMEがstaleなままimmutableに残置。publishは
  `docs/operations/jsr-publish.md`の手順（README例のversion更新→gate→push→clean worktree→dry-run→device認証→
  registry/import検証→cleanup）。
- provider: built-in idは`openrouter-chat`/`openrouter-responses`/`openai-chat`/`openai-responses`。旧
  `openrouter`/`openai`は削除（互換aliasなし）。宣言providerは`providers/*.json`、protocolは
  `openai-chat-completions`または`openai-responses`のみ。credentialは`~/.config/henji-harness/{openrouter,openai}-api-key`
  （0600・単一トークン）。
- 検証の注意: TUI/pty検証は**隔離XDG**で行い、実configへ`default-selection.json`等を書かない。
- Git tagとForgejo Releaseは未作成。現行JSR release手順はtag不要で、別のrepository release policyもない。
  release automation（CIでのbinary build等）は未実装。
- 履歴DB: productionは`history-v7.sqlite3`／`locks-v7`のみ。Increment 94完了時に利用者許可を得て、state treeの
  `history-v4.sqlite3`／`history-v5.sqlite3`／`history-v6.sqlite3`（各-wal／-shm）と`locks-v4`／`locks-v5`／
  `locks-v6`を削除済み。さらにversioned以前の`history.sqlite3`（-wal／-shm）も利用者許可を得て削除し、現在のstate
  DBはv7のみ。他workspaceの旧state DBは旧chat evidenceを含むとreadbackが失敗するため、必要時に同様に切捨てる。
- active external revision: `local/henji-base@sha256:82d67dd2…`。
