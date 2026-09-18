# Handoff

## Records

### 通常利用の改善 — Increment 69（実装完了: offline gate・binary配置。実provider probe未実施）

- 状態: `tool-definition`資源kindとweb_search外部化を実装完了。`v0:gate`（check/fmt/lint/test）exit 0。
  `henji:compile`でbinary `0.2.1`をbuildし`~/.local/bin/henji`へ配置（build
  `c2bfabd5e562d294fd0e4e9e57708b27806a091f793f8f1d5daec43d97dccf49`、binary SHA-256
  `ad1e1d15b271b2a1d56d318a732b905163cfab0a8efde3215dc3c8687b836795`、`--version`と`tool list --json`を
  isolated XDGでsmoke確認）。
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
  (1) 実provider probe（Sonar経由の1 turn。実行直前に別途許可）。
  (2) architecture/roadmap正本の更新提案（別承認。`increment-69.md`末尾）。
  (3) 変更のcommit（利用者の明示指示があるまでcommitしない）。
- 正本: `docs/increments/increment-69.md`（結果まで反映済み）。roadmap/architectureの正本更新は別承認。
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

### 環境・配置（再開時の注意）

- binary: `0.2.1`（build `32b126bbd5d9999f58fffd1943a4f1ba16251310f731b6b98d155232e2b06b65`、binary SHA-256
  `e4c2a7dd21c21158711ccc8c12d725c0dc981b736403a605859953f2fed3f30f`、embedded runtime
  `11ed86a9066af9e74332bb62e2a453c7572b6f30c45363ea976929be6a0fbdf8`、source`eea20898`・`sourceDirty=false`）。
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
