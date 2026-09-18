# Increment 69 — tool Definition資源kindとweb_searchの外部化

ステータス: **実装完了（offline gate pass、実provider probe・binary配置は未実施）**

基準commit: `fe9fd82d`

計画日: 2026-09-18

実装日: 2026-09-18

対象: toolをmanaged resource kind `tool-definition` として扱い、binary内の固定`tool:web_search`（Sonar backend、
`ToolComponentCatalog`特別扱い）を**削除**する。最初のweb_search実装（Sonar）を同梱tool Definitionとして提供し、
external managed tool Definitionと同じ解決・load・composition・attributionの仕組みで扱う。runtimeのbackend選択は
持たず、install/bindされたexact revisionで決まる。

roadmapの「Increment 69: `web_search`(Sonar)をsubagent化する」は本計画で置き換える（roadmap正本の変更は別承認）。
本計画はF24（Definition以外のresource外部化）のtool対象を扱うため、architecture正本の変更提案を末尾に分離する。

## 背景（決定の経緯）

- `web_search`はroot agentが呼ぶclient-side toolである。Sonar backendが`message.annotations[].url_citation`を
  Henji側で読み、answer本文＋直接URLへ合成して返す。この経路はgeneric model層のannotation surfaceを必要としない。
- Sonarはtool call非対応（Perplexity公式）。OpenRouter metadataで`tools`非対応のpure-text modelは59件あるが、
  `web_search_options`を持つのはPerplexity Sonar系5件のみ。
- provider-native検索（OpenAI built-in `web_search`、`openrouter:web_search`）のcitationは`url_citation`
  annotationsで返り、Henjiのgeneric model層はこれを読まない。参照実装（Pi、DeepSeek Harness、Zot等）もgeneric
  model層でannotationsをsurfaceせず、検索をmodel registryの外（backend/server tool）に置く。
- 利用者判断（2026-09-18）:
  - web_search subagentは作らない。
  - 同梱のSonar実装は「過去のゴミを積み重ねない」ため残さず**削除**し、web_searchはtool Definitionが提供する。
  - 新しいmanaged resource kind `tool-definition` を導入し、instruction／agent-definitionと同じくinstall・bind・
    attributionを持つ。同梱Sonar実装はexternalと同じ仕組みで読み込む特別扱いなしのtool Definitionとする。
  - runtimeでbackendを選ぶUIは持たない。

## 利用者が必要とする動作

- 人間は`web_search` toolを、同梱のSonar tool Definition（ゼロ-configの既定）で通常利用できる。tool resultは
  現行どおりanswer本文＋直接source URLを含む。
- 人間はmanaged tool Definitionをinstallし、activation bindingで`tool:web_search`へbindすることで、Sonar実装を
  自分の実装（例: OpenAI Responses built-in `web_search`、別backend）へ差し替えられる。binding解決の失敗は
  暗黙fallbackせずtyped failureとし、bundled Sonarへ黙って戻らない。
- 差し替え実装はWorker-localなcredential解決済みprovider request手段を使える。credential値とAuthorizationは
  tool Definition、manifest、Session、transcript、evidence、tool argumentへ渡らない。
- 使用したtool Definitionのexact revisionをexecution artifactからreadbackでき、provider evidenceで
  tool Definition由来のrequest（origin、model/backend identity、raw response、parser transition）を診断できる。
- 通常利用経路（TUI／非対話）は同じ解決・load・composition・commitを使う。

## 計画

### managed resource kind `tool-definition`

- `ManagedResourceRefV1.resourceKind`に`tool-definition`を追加し、`ToolDefinitionRevisionRef`と`is*` predicate、
  external resource id predicate（`builtin/web-search`を含む）を`managed_resource_ref.ts`へ追加する。
- authoring packageは`henji-resource.json`＋entry `.ts`＋local closureとする。manifestは
  `resourceKind`、`resourceId`、`apiContract: 'henji-tool-definition-v1'`、`toolIdentity`（例:
  `tool:web_search`）、`entry`、`files`、canonical digestを持つ。closure制約（`@henji/agent`＋相対`.ts`のみ、
  dynamic import不可）とcanonical digestの方式はagent-definition（`managed_definition_*`）を踏襲する。
- storeは`managed/tool-definition/v1`とし、staging＋atomic rename、inspect、exact revision resolve、
  list、removeをagent-definition／henji-instructionのstore方式に合わせる。
- CLI（`henji tool install|list|inspect|active|activate|deactivate|uninstall`相当）をinstruction CLIの形に
  合わせて追加する。transport（export/import）は本incrementの対象外とし、後続でagent-definition transportの
  envelopeをkind対応に拡張する。

### Worker loadとcomposition

- tool Definitionのentry default exportはWorker内で評価され、`ToolComponent`（既存`{identity, materialize}`）を
  返す`ExecutableToolDefinition`とする。`ToolDefinitionInput`はworkspace・skill catalog・Worker-local
  physical I/Oを含む。TypeScriptの物理module closure検証（サイズ・sha256・依存lineage）はagent-definitionの
  load方式（`withDigestQuery`）を再利用する。
- Worker start commandへ、root Definitionが宣言する`tool:<name>`ごとの解決済みtool Definition
  （exact ref＋physical load descriptor）を追加する。Hostはref解決のみ、評価とmaterializeはWorkerが行う。
- `createDeclaredRegistry`／`createDeclaredTool`は、`tool:<name>`を「解決済みtool Definitionが提供する
  `ToolComponent`」からmaterializeする経路を追加する。bundled work tool（`bash`、`read`、`write`、`edit`、
  `bash_output`）と既存`tool:skill`／`tool:delegate_to_planner`／`tool:submit_json_result`は当面維持し、
  `tool:web_search`だけをDefinition提供へ移す。
- `ToolComponentBindings`／`ToolDefinitionInput`へ、credential解決済みprovider request seamを追加する。
  返すのはcredential値ではなく認証済みrequestを実行できるclosureとし、`ProviderEvidenceRecorder`／
  `observeAuxiliaryRequest`相当でrequest・response・parser transitionを記録する。raw bytesのreadback
  accessorは追加しない。

### 固定実装の削除

- `tool:web_search`を`workToolNames`（`tool_components.ts`）、`builtinToolComponents`、`agent_definition.ts`の
  固定tool宣言、`resource_identity.ts`の固定topology期待から削除する。
- 同梱Sonar実装はbundled tool Definition module（`builtin/web-search`）へ移す。Sonarの非streaming呼び出し、
  annotations解析、`[n]`→直接link正規化、source一覧整形、grounding system message、`web_search_options`、
  request count／evidence記録をこのmoduleへ移し、`v0/agent/tools/web_search.ts`の固定catalog配線は削除する。
- bundled web_search tool Definitionは、explicit selectorもexternal bindingも無いときのdefaultとしてHostが
  load descriptorを作る（builtin agent Definition／builtin instructionと同じ扱い、特別なcatalog経路は作らない）。

### selectionとbinding

- activation-level bindingはinstruction baseのbinding方式を踏襲し、Host-owned config（例:
  `$XDG_CONFIG_HOME/henji-harness/tools.json`、`schemaVersion:1`＋`bindings: { "<toolIdentity>": "<managed selector>" }`）
  とする。workspace scopeは対象外。
- Hostはroot Definitionが宣言する`tool:*`ごとに、explicit selector（将来）> activation binding > bundled defaultの
  順でexact refを解決する。binding解決失敗（missing revision、`toolIdentity`不一致、apiContract不一致）はtyped
  failureとし、bundledへ暗黙fallbackしない。binding変更は次のWorker generationから効く。
- tool DefinitionはSession schemaへ保存しない。exact refはmanifest／execution artifactへ記録する。

### attributionと契約版

- `WorkerAgentManifest`へ、実際に解決・合成したtool Definitionの`[{toolIdentity, ref}]`を追加する。
  root Definitionの`tool:<name>`宣言との整合をWorkerで検証する。
- execution artifactへtool Definition refの一覧を追加する（schema versionを上げ、旧版は解釈しない）。
- context attributionは既存`tool_contract` relationを拡張し、tool Definitionのexact source locator
  （kind/id/digest）とcontentDigestを相関する。完成payloadの別authorityは追加しない。
- `WORKER_PROTOCOL_VERSION`（start command／ready message）とexecution artifact schemaを更新し、旧版は
  解釈しない（互換読込・migrationなし）。

## 対象外

- web_search subagent化、`subagent:web_search` slot、named subagent一般化。
- `bash`／`read`／`write`／`edit`／`bash_output`のtool Definition化、任意の新tool identityの一般公開
  （`web_search`を最初の適用例とし、他toolは後続）。
- tool Definition transport（export/import）、remote registry、hot reload、remove/GCの高度化。
- generic model層へのannotation/citationチャネル追加、provider-native検索のroot/planner model対応、
  OpenAI backendの同梱。
- runtimeのbackend選択UI、workspace scope binding、manifest dependency bindingとactivation bindingの優先規則。
- MCP、tool sandbox（R2/R3）。

## Verification

- focused test: tool Definitionのauthoring manifest検証・canonical digest・store publish／resolve／list、CLI
  install/inspect/activate/deactivate、binding解決（正常・missing・toolIdentity不一致・apiContract不一致・
  malformed）、bundled defaultへの解決、external bindingによる`tool:web_search`差し替えとroot compositionへの
  反映、未bind時のbundled Sonar動作、tool resultの`answer＋直接URL`契約、plannerへ伝播しないこと、manifest／
  artifactのtool Definition ref readback、`[n]`→link正規化の維持、credential非漏洩。
- 既存回帰: Increment 7/9のweb search citation、Increment 32〜34のagent-definition load、Increment 51の
  instruction binding、root provider/model切替、Session resume、base instruction finalizer。
- 実provider probe（別途許可）: isolated XDGでbundled web_search tool Definition経由の1 turnを実行し、tool
  resultの直接URL、artifactのtool Definition ref、provider evidence（origin、model selection、raw response、
  parser transition）をreadbackする。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

新managed kind（ref／manifest／store／CLI／binding）、Worker loadとcomposition、固定実装の削除とbundled tool
Definitionへの移設、provider request seam、attribution／contract版更新、testで**10〜18開発日相当**。単一increment
としては大きいため、実装は次を一区切りとする。
1. kind基盤とbundled web_search tool Definition、固定実装削除、Host解決・Worker合成、attribution。
2. 任意で分割する場合は、external install／activateとbindingを先行し、bundled移設を後続にする案も比較する。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. Increment 69を「web_search subagent化」から「`tool-definition`資源kind導入とweb_search外部化」へ変更する
   （roadmap正本の変更は別途承認）。
2. 新managed kind `tool-definition`（`henji-resource.json`＋entry TS closure、`apiContract`、canonical digest、
   store、CLI、activation binding）を導入する。
3. 固定`tool:web_search`（`ToolComponentCatalog`特別扱い、`agent_definition.ts`固定宣言、topology期待）を削除し、
   同梱Sonar実装をbundled tool Definition（`builtin/web-search`）へ移す。
4. Hostはtool identityごとにexplicit selector > activation binding > bundled defaultで解決し、解決失敗は
   暗黙fallbackしない。runtime backend選択UIは持たない。
5. Worker-localなcredential解決済みprovider request seamをtool Definitionへ公開する（credential値は公開しない）。
6. `WorkerAgentManifest`／execution artifact／context attributionへtool Definition exact refを記録し、
   `WORKER_PROTOCOL_VERSION`とartifact schemaを上げ、旧版を解釈しない。
7. 他work toolと任意の新tool identityの一般公開は本incrementの対象外とし、`web_search`を最初の適用例にする。
8. OpenAI等の個別backendは同梱しない。generic annotation channelは作らない。transportは対象外。
9. architecture正本（`henji-host-agent-worker.md`、`multi-provider-routing-and-auth.md`）とroadmapの更新は、
   本incrementの承認とは別に明示承認を得る。実装時は必要な正本変更案をこの文書または報告へ留め、承認まで
   反映しない。
10. 実provider probeを実行直前に別途許可する検証水準。

## architecture正本への提案（別承認。未反映）

- F24／externalization境界: managed resource kindとして`tool-definition`を追加し、toolのcontract・executor・
  backendをAgent Definitionから分離する。tool identityごとのselection authority（activation binding、将来的な
  manifest dependency bindingとの関係）、execution placement（Worker内でDefinition moduleを評価）、
  provider access seam、attribution（manifest／artifact／context）の責務をarchitectureへ明記する。
- F06: Agent Definitionはtool identityを宣言し、Hostが解決したtool DefinitionをWorkerが合成する。固定
  `ToolComponentCatalog`はbundled work toolの暫定実装であり、tool Definitionが優先する。
- roadmap: Increment 69の記載を「web_search subagent化」から本計画へ変更し、Increment 70の「tool same-identity
  override」を`tool-definition`一般化の後続へ再定義する。

## 結果（2026-09-18）

- 新managed kind `tool-definition`（`resourceKind`、`apiContract: henji-tool-definition-v1`、`toolIdentity`、
  canonical digest、`managed/tool-definition/v1` store）を実装した。`managed_definition_importer.ts`の
  module closure取込を汎用`importManagedModule`へ分離し、agent-definitionとtool-definitionで共有する。
- activation binding `tools.json`（`schemaVersion:1`＋`bindings`）とtyped errorを実装し、`tool:web_search`の
  `writeToolBindingRef`／`deactivateToolBinding`／prefix解決を提供した。CLI `henji tool
  install|list|inspect|active|activate|deactivate|uninstall`を追加し、`henji_cli.ts`へ配線した。
- Worker protocol（start `toolDefinitions`、ready manifest `tools`）とWorkerのtool Definition module load・
  評価・`finalizeWorkerToolAttribution`を実装した。`createDeclaredRegistry`は解決済みtool Definitionを
  materializeし、bundled work toolよりDefinition提供を優先する。
- 固定`tool:web_search`を`workToolNames`／`builtinToolComponents`から削除し、Sonar実装をbundled tool
  Definition `worker_builtin_web_search_tool.ts`へ移した。固定catalog特別扱い（`createWebSearchTool`配線）は
  `tool_components.ts`から除去した。`tool:web_search`はdefault Definitionの宣言と固定topology validatorには
  残る。
- provider request seam（`v0/agent/provider/auxiliary_request.ts`、`PhysicalIoBindings.requestProvider`）を
  公開し、`OpenRouterSonarWebSearchBackend`が`requestProvider`を受けられるようにした。
  `createProductionPhysicalIo`はSonar backendを直結せず、credential解決済みの`requestProvider`を供給する。
  非Host経路（legacy `runtime.ts`・直接`createDeclaredRegistry`）にはbackend/requestProviderからのweb_search
  互換bridgeを残した。
- Host（`worker_tui_session.ts`）はroot Definitionの`tool:web_search`を、`tools.json` binding > bundled
  tool Definitionの順で解決し、Worker start commandへexact ref＋physical descriptorを渡す。binding解決失敗は
  typed `ToolBindingError`／`DefinitionStartupError`で、bundledへ暗黙fallbackしない。
- attribution: `WorkerAgentManifest.tools`、execution artifact schema v7（`tools`）、`sqlite_history_store`の
  v7永続化・復元を実装した。`WORKER_PROTOCOL_VERSION`は据え置き（`PhysicalIoBindings`はpostMessageを越えず、
  start/readyの`toolDefinitions`／`tools`は既存version内の追加field）。
- 検証: 新規`tests/v0/increment_69_tool_definition_test.ts`（5件）を`v0:test`へ追加。artifact schema v6→v7に
  伴う既存focused test期待と、web_searchのDefinition提供化に伴う合成testを更新した。authoritative
  `v0:gate`（check/fmt/lint/test）exit 0。
- 未実施: 実provider probe、`henji:compile`でのbinary build・配置。architecture／roadmap正本の更新は未反映
  （末尾の提案は別承認）。
