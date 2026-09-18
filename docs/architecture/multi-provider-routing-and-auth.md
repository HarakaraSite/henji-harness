# Henji 複数provider routing・認証アーキテクチャ

ステータス: **Increment 14〜16の複数provider基盤とIncrement 58〜68のOpenRouter Responses・data-only
Provider declaration・provider ID整列を実装済み。ChatGPT subscription routeはfeasibility確認後に将来へ延期**

作成日: 2026-09-09

現行source照合commit: `9de2255dde970f9cca7cb167c971bdb031e451ee`

## 目的

Henjiのdefault parent、delegated planner等のsubagent、modelを内部利用するtoolが、同じturnまたはSession内で
別々のproviderと認証経路を安全かつ正確に使えるようにする。Increment 14から16は、個別adapterを順番に
足すのではなく、本書の共通route、認証、Session、provider evidence契約へ一つずつ接続した。Increment 17で
ChatGPT subscription routeのfeasibilityを確認したが、runtime実装は将来incrementへ延期した。

必要なproduct動作は次のとおりである。

- OpenAI direct APIを使うdefault parentが、OpenRouter APIを使うdelegated plannerとOpenRouter Sonar
  `web_search`を同じturnで利用できる。
- parentとsubagentが異なるproviderでも、各model requestは自分に指定されたprovider・model・effort・
  認証profileを使う。親のcredentialを子へ暗黙継承しない。
- 将来OpenAI CodexのChatGPT subscription認証を追加する場合も、OpenAI Platform API-key認証とendpoint、
  API contract、課金・管理境界、credentialを混同しない。
- providerを切り替えてもHenji Sessionとsemantic transcriptは継続する。一turnの途中でroot routeは変えない。
- request、raw response bytes、SSEまたはprovider protocol event、parser transition、runtime outcome、provider・
  model・request originをcredentialなしで保存し、各model/providerの挙動を後から照合できる。
- 既存OpenRouter経路、OpenRouter内のmodel/effort切替、planner default、provider deadline、Session一覧、
  footer、OpenRouter Sonar `web_search`を退行させない。

OpenAI Responses APIのbuilt-in Web searchをHenjiの二つ目のsearch backendにする判断は本書では行わない。
現行OpenRouter Sonarと将来backendが同居できる境界だけを維持し、具体的なtool名、同時公開、選択UIは実装時に
検討する。

## 根拠と未確認事項

### 確認済みの外部契約

- OpenAIの公開Responses APIはtext、image、function tool、streamingを扱い、TypeScript SDKの
  `responses.create()`は非stream responseまたはtyped stream eventを返す。
  [OpenAI Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
- Responses APIを手動context管理で使う場合、reasoning output itemは後続inputへ含める必要がある。
  [OpenAI Responses API reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)
- CodexはChatGPT subscriptionによるsign-inとOpenAI Platform API keyによるsign-inを別経路として扱う。
  一般のOpenAI API callにはPlatform API keyを使う。
  [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- Codex app-serverはcustom client向けにauthentication、conversation history、approval、streamed agent eventを
  提供し、ChatGPT browser/device-code login、token保存、refreshをapp-serverが所有できる。
  [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server)
- Codex TypeScript SDKはlocal Codex agentのthread開始・再開・stream eventを扱う高水準interfaceで、公式案内は
  Node.js 18+を要件とする。現行Deno Workerでの利用可否は未確認である。
  [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

### 比較実装から得た設計入力

- pinned Piはmodelを所有するprovider collectionがprovider-scoped authを解決し、API-keyとOAuthをprovider
  authとして分ける。これはHenjiでもmodel routeがcredential routeを所有すべきことを支持するが、Piの契約を
  Henjiの仕様としてコピーはしない。
- pinned Zotは公開OpenAI Responses APIをAPI-key route、ChatGPT Codex backendをOAuth routeとして別provider
  identityで扱う。これはendpointとheaderの混同を避ける比較例であり、非公開backendの外部契約を保証しない。

### Increment 14着手前に残っていた未確認事項（履歴）

- official OpenAI TypeScript SDKを現行Deno runtimeで使い、SDKへ返すstreamを壊さず、実際に送信されたJSON bodyと
  raw response bytesをcredentialなしでtransport境界から取得できるか。Increment 14の最初に最小probeで確認する。
- OpenAI modelごとの利用可能effortとtool continuationに必要な全output item。curated catalog候補ごとに公式schemaと
  簡単な実requestで確認する。
- Codex SDK/app-serverはHenjiの低水準`Model.generate()`を置換するmodel providerではなく、agent loop、history、
  approvalも所有する高水準境界である。Increment 17のfeasibility確認では、Henjiのroot model routeに適合する
  公式の低水準subscription model APIを確認できなかった。
- ChatGPT subscription tokenを直接`chatgpt.com` backendへ送る方式は、pinned比較実装には存在するが、現時点で
  Henjiが依拠する公式public API contractとしては確認していない。本書はそれを既定経路にしない。

## 用語とidentity

`provider`を企業名だけとして扱わず、model requestのAPI surfaceと認証契約を一意に決めるroute identityとする。

| provider identity | API surface | auth profile | 導入increment |
| --- | --- | --- | --- |
| `openrouter-chat` | OpenRouter Chat Completions互換API | `openrouter-api-key` | 14、ID整列は68 |
| `openrouter-responses` | OpenRouter Responses API | `openrouter-api-key` | 58 |
| `openai-chat` | 公開OpenAI Chat Completions API | `openai-api-key` | 64、ID整列は68 |
| `openai-responses` | 公開OpenAI Responses API | `openai-api-key` | 14、ID整列は68 |
| `openai-codex` | 将来再確認するChatGPT Codex subscription経路 | 未決定 | 将来incrementで再採用した場合 |

`openai-chat`／`openai-responses`と`openai-codex`は同じvendorのmodelを使えても別providerである。model IDが
同じでも、API surface、
認証、課金、provider state、evidenceの意味が異なるためである。

Anthropic direct、Google direct等を将来追加するときも、確認済みのAPI surfaceとauth profileを新しいroute branchと
adapterとして加える。Increment 14〜17では未確認のendpoint、認証、provider stateを先回りして共通仕様化しない。

同じvendorと同じcredentialでもAPI surfaceは別routeである。OpenRouterのChat CompletionsとResponsesは
`openrouter-chat`／`openrouter-responses`として併設し、OpenAI directも`openai-chat`／`openai-responses`を
区別する。旧ID `openrouter`／`openai`はIncrement 68でaliasやmigrationなしに廃止した。

current selectionは次の構造を持つ。`provider`はprovider ID、`api`はeffective protocol/surfaceであり、
credential値やendpointは含めない。

```ts
interface ModelSelection {
  readonly provider: string;
  readonly api:
    | 'openrouter-chat-completions'
    | 'openrouter-responses'
    | 'openai-chat-completions'
    | 'openai-responses';
  readonly authProfile: 'openrouter-api-key' | 'openai-api-key';
  readonly modelId: string;
  readonly effort: string;
}
```

Provider declaration v1は`providerId`、binary-owned `protocol`、endpoint、auth profile、固定model catalog、
defaultsをdata-onlyで保持する。protocolは`openai-chat-completions`または`openai-responses`である。external宣言は
新しいprovider IDを追加でき、built-inと同じIDの宣言はprotocol・endpoint・auth profileを維持したままcatalogと
defaultsだけをoverrideできる。email、account ID、API key、access/refresh tokenはselectionとdeclarationへ含めない。
`openai-codex` branchは現時点では追加しない。将来再採用する場合は、その時点の公式contractと実行証拠を確認する。

## 不変条件

1. **requestごとのroute所有**: outbound model/tool requestは、実行主体のroleから推測せず、resolved selectionまたは
   tool backend bindingに明示されたrouteを使う。
2. **credential非継承**: parent、subagent、toolはcredential値を互いに渡さない。各provider adapter/backendが
   Worker内の対応auth resolverをrequest時に呼ぶ。
3. **secret非永続化**: Session、Worker protocol、AgentComposition、manifest、tool argument、transcript、failure、
   provider evidenceへcredential値とAuthorization headerを入れない。
4. **turn内固定**: root selectionはidle時だけ変更でき、admit済みturnの全root model stepでは固定する。subagentは
   invocation開始時に自分のselectionを固定する。tool backendも一call中にrouteを変えない。
5. **semantic transcript共有**: providerを切り替えてもuser text、visible assistant text、tool call/resultからなる
   Henji transcriptは継続する。provider-private replay stateは互換性を確認したadapterだけが使用する。
6. **独立した失敗**: root、subagent、tool backendの認証失敗を別routeのcredentialやproviderへfallbackしない。
   自動retry/fallbackは別の明示要件がない限り追加しない。
7. **request単位の証拠**: evidenceから、どの実行主体が、どのprovider/API/model/auth profileを選び、何を送り、
   providerが何を返し、parserがどう解釈したかを照合できる。

## Worker内のruntime構成

Hostは同梱宣言とexternal宣言をregistryへ解決し、Workerはresolved `ModelSelection`からbinary-owned adapterを
materializeする。roleはcredential選択に使わず、selectionのauth profileがrequest時のresolverを決める。

```text
Agent Definition / Session override
            │ ModelSelection（非秘密）
            ▼
   Worker-local ProviderRegistry
            │ provider declaration + apiでadapter factoryを選択
            ▼
   Provider adapter / tool backend
            │ authProfileでrequest時にresolve
            ▼
 Worker-local AuthResolver ── credential material
            │
            ▼
        outbound request
```

runtime境界は次の責務に分かれる。

- `ProviderRegistry.createModel(selection)`: selectionを検証し、対応adapterを返す。credential値は引数にも戻り値にも
  出さない。
- provider adapter factory: 対応する`AuthResolver` closure、counted fetch、deadline、evidence tapを受け取る。
- `AuthResolver.resolve(authProfile)`: request時にcredentialを取得するWorker-local境界。初期実装では
  `openrouter-api-key`と`openai-api-key`を別の固定file sourceへ対応させる。
- `WebSearchBackend`: model routeと独立したbindingを維持する。Increment 69以降、bundled web_search tool
  Definitionがcredential解決済みprovider request seam（auth profile指定、credential値非公開）を通じて
  `openrouter-api-key`を解決し、OpenAI parentのcredentialを参照しない。

default parentのSession overrideはroot selectionだけを差し替える。delegated plannerはplanner Definitionの
selectionを使い、root selectionを継承しない。将来のsubagentも同じ原則で、自分のDefinitionまたは明示bindingから
selectionを得る。delegation taskとchild execution contextへcredentialは加えない。

## provider stateとprovider切替

provider-private replay stateは生成元を持つtagged unionであり、conversation textとは別にassistant messageへ付く。

```ts
type ProviderState =
  | { provider: 'openrouter-chat'; reasoningDetails: readonly JsonValue[] }
  | { provider: string; replayItems: readonly JsonValue[]; model?: string };
```

- OpenAI Responses adapterは、function call後のcontinuationと後続contextに必要なreasoning/output itemを完全な順序で
  保持する。`previous_response_id`だけをHenji Sessionの正本にせず、Henjiのdurable transcriptとprovider stateから
  requestを再構成する。
- adapterは、自分と互換なtagのprovider stateだけをwireへ戻す。別APIのstateを変換または送信しない。
- context admissionとcompactionのrequest-size計測はactive modelの`measureRequestWire`を使う。providerを
  切り替えた後のrequestを別providerのwire形式で評価しない。
- provider/model切替時のstate互換性はadapter固有とする。OpenRouter内の互換model切替は現行どおり
  `reasoning_details`を維持する。providerをまたぐ切替ではsemantic transcriptだけを使う。元providerへ戻った場合に
  古いprivate stateを再利用するかは、公式契約または実行証拠がない限り行わない。
- routeは一turn中固定なので、tool callを返したproviderとtool result continuationを受けるproviderは同じである。
- Codex routeのprovider stateはfeasibility gate後に採用した境界が必要とする場合だけbranchを追加する。

## Session、Manifest、Surface

現行Session schema v6は`activeModel`、`modelChanges`、`turnModels`へgeneric `ModelSelection`を保存し、turnごとの
buildとDefinition attributionを`turnExecutions`へ持つ。Increment 68より前のprovider IDをaliasまたはmigrationで
読み替えず、旧IDを含むrecordは現行schemaとして解釈しない。

- Sessionはroot selectionだけを永続化する。planner/subagentのresolved selectionは各turnのmanifestとevidenceへ
  attributionし、rootのmodel change historyへ混ぜない。
- 永続Sessionとexecution artifactのdecoderは、selectionの保存構造とtagを検証する。現在のcurated catalogにmodelが
  掲載されているかという利用可能性判定は、resume時のadapter materializationへ分離する。catalog更新だけで過去の
  Sessionやartifactを破損扱いにしない。
- Worker start/select command、ready/selected manifest、execution artifact、Session metadata、presentation projectionを
  同じgeneric selectionへ移行する。
- Worker protocolは`select_model`をgeneric selectionの変更commandとして使う。Surfaceの`/provider`、`/model`、
  `/effort`はidle-onlyなroot selectionのatomic変更へ収束する。
- footer固定2段目と`/sessions`はproviderを独立表示し、同じmodel IDをOpenRouter経由とOpenAI directで区別する。
- semantic context checkpointはprovider-neutralなsummaryとして再利用する。`sourceProfileId`は生成元provenanceのまま
  保持し、active routeとの一致を再利用条件にしない。新schemaでは生成元selection identityを非秘密情報として
  表現する。
- Definitionが宣言するdefault model resourceと、Session overrideを反映したeffective manifest resourceを区別する。
  effective manifestの`model:<provider>:<route-id>`は実際のroot selectionと一致させ、model切替ごとに
  Definition revisionが変わったとは扱わない。

## Provider evidence

request evidenceはraw request/response/SSE/parser/runtime evidenceを維持し、各requestに次を記録する。

- `origin`: root model、named subagent model、context compaction、`web_search`等のtool backendを区別するidentity。
- `provider`、`api`、`modelId`、`authProfile`。auth profileは非秘密のidentityだけを記録する。
- `protocol`: `json`、`sse`、将来app-serverを使う場合の`json-rpc`等。
- provider request ID等、response header/bodyから得たprovider metadata。request header全体は保存しない。

OpenAI SDKを使う場合も、SDKが整形したeventだけを証拠にしてraw bytesを失わない。Increment 14のprobeで、SDKの
custom fetch等の公開seamにevidence tapを置き、次を実証してからadapterを実装する。

1. SDKへ渡る実際のrequest URL、method、credentialを除くserialized bodyを取得できる。
2. SDKが読むstreamと同じresponseのraw bytesを順序どおり取得できる。
3. SDK eventからHenji parser transitionと`ModelResult`への対応を記録できる。
4. Authorization、API key、OAuth token、credential pathを取得するAPI shapeがevidence recorderに存在しない。

official TypeScript SDKは一時的な接続失敗や一部HTTP errorを既定で2回retryし、既定timeoutは10分である。
[OpenAI SDK client configuration](https://github.com/openai/openai-node/blob/main/docs/configuration.md)
Henjiが現在採用する一request 120秒deadlineとactual request countを維持するため、Increment 14の初期経路は
Henjiの`AbortSignal`とdeadlineを渡し、SDKの通常retryを`maxRetries: 0`で無効にする。将来retryを採用する場合は、
retryされた各HTTP requestを別requestとしてevidenceへ記録する設計を先に行う。

このprobeが成立しない場合は、raw evidenceを省略してSDK採用を続けず、利用するSDK seamまたはadapter方式を
Increment 14の計画へ戻して決める。

## Increment 14着手時の実装衝突（履歴）

次表はgeneric route導入前に確認した移行入力であり、現在の実装状態を表さない。完了後のcurrent contractは
本書前半と各increment文書を正本とする。

| 当時の箇所 | Increment 14着手時の前提 | 必要だった変更と影響 |
| --- | --- | --- |
| `provider/openrouter_model_catalog.ts` | selection、catalog、defaultがOpenRouter専用 | generic selectionとprovider別catalogへ分離。既存curated entryとdefault値は保持 |
| `definitions/agent_definition.ts` | provider型がliteral `openrouter`、profileもOpenRouter shape | Definitionのmodel declarationをgeneric selectionへ移行。resource identityへrouteを反映 |
| `worker_agent_api.ts` / `worker_physical_io.ts` | `createModel(role, selection?)`と一つの`credentialSource`をroot、planner、Sonarで共有 | roleとrouteを分離し、provider registryとauth-profile別resolverを導入 |
| `worker_bootstrap.ts` / `worker_runtime.ts` | root routerだけを差替え、planner defaultをOpenRouter constantから生成 | rootとplannerを各selectionから生成。planner固定defaultというproduct動作は維持 |
| `core/contracts.ts` / request・response parser | provider stateがOpenRouter reasoning detailsだけ | tagged provider stateとadapter固有replayへ移行。foreign stateを送らない |
| `semantic_context.ts` / compaction | request sizeをOpenRouter wire encoderで測定 | active adapterのencoder/measure policyへ分離 |
| Session schema v3 / codec / store | exact-key validation、OpenRouter selection、現curated catalogへの所属を要求 | v4 codec、v1〜v3 read migration、catalog availabilityと永続構造の検証分離、metadata/list/resumeのgeneric attributionが必要 |
| Worker protocol / manifest / execution artifact | exact shapeにOpenRouter selection、root/plannerの二lane | protocol・artifact schema migration。request originはtool backendも区別 |
| provider evidence v1 | endpoint/bodyから推定できるがprovider、API、auth profile、tool originがない | request metadataを明示する新schema。既存evidenceはreadableなまま保持 |
| failure diagnostic | OpenRouter error classとparent/planner laneを前提 | provider-neutral error factにroute attributionを追加。表示は既存の短いfailureを維持 |
| instruction composition | Increment 16で共通・role・active tool・workspace・skill・runtime factsをnamed component化し、generation生成時に合成 | 同じresolved instructionを両adapterへ写像し、provider routeは本文へ混ぜない。revision・置換・自己改定は後続F24候補 |
| TUI picker / presentation / footer | `/model`と`/effort`がOpenRouter catalogを直接参照 | Increment 14はstartup route、15で`/provider`とprovider-scoped pickerへ分離 |
| `web_search.ts` | backend interfaceは中立だがSonarがmainと同じcredential sourceを受ける | backend専用OpenRouter auth resolverをbindし、OpenAI rootとの組合せを実経路で確認 |
| checkpoint `sourceProfileId` | current OpenRouter profileとの一致検証が残る箇所がある | provenanceとactive selection compatibilityを分離し、provider切替後もsemantic summaryを利用 |
| `deno.v0.json` | active importはlocalだけで、多くのtestが`--no-remote` | official SDKのversion固定、lock/cache/vendor方針とoffline test再現性をIncrement 14で決める |
| request count / logical budget | 一generateのphysical fetch countを`0 | 1`として扱う | SDK通常retryを無効化して現行契約を維持。複数request採用時だけevidenceとbudget契約を明示変更 |
| runtime launcher | OpenRouter endpointとcredential fileだけを許可 | Increment 14で確認済みOpenAI endpoint、SDK依存、credential sourceに必要な権限だけを追加 |
| `runtime/runtime.ts` / live eval / real-provider acceptance | 単一OpenRouter credential seamとOpenRouter adapterを直接生成 | OpenRouter専用compatibility経路として残すかProviderRegistryへ接続するかをIncrement 14で明示し、generic core移行後もbuildと実provider確認を成立させる |

OpenRouter adapterをOpenAI互換adapterへ一般化して共有しない。OpenRouter固有のreasoning details、SSE variant、
error、provider metadataを維持したまま、OpenAI Responsesは別adapterとして追加する。共通化するのはHenjiの
`Model`、selection、provider state tag、evidence recorderへの入力だけである。

## Increment 14〜17の境界

### Increment 14 — generic route基盤とOpenAI direct API

成立させる動作:

- generic `ModelSelection`、provider registry、auth-profile別resolver、provider-neutral failure/evidence attributionを
  導入する。
- official OpenAI TypeScript SDKを使った公開Responses API adapterを追加し、Platform API keyをrequest時に解決する。
- OpenRouter rootを既定のまま保持しつつ、起動時にOpenAI rootを選べる。既定変更は別の利用者判断とする。
- OpenAI root + OpenRouter planner + OpenRouter Sonar `web_search`を同一turnで実行し、各requestのprovider、model、
  auth profile、raw evidence、request countが一致することをproduction経路で確認する。
- Session schemaをgeneric selectionへ移行し、v3 OpenRouter Sessionを同じ内容でresumeできる。
- effective manifest resource、provider-specific context sizing、過去recordのcatalog非依存decodeをgeneric routeへ合わせる。

このincrementでは同一Session中のprovider変更UI、OpenAI built-in Web search、Codex subscription認証、planner選択UI、
instruction component再設計を行わない。現行system instructionをOpenAI `instructions`へ意味を変えず写像する。

詳細計画では、(1) neutral selectionとroute、(2) Session/protocol/presentation/artifactのmigration、(3) Worker-local
registryとroute別credential resolver、(4) provider-tagged replay stateとactive adapterのcontext measure、(5) effective
manifestとrequest evidence、(6) SDK probeとOpenAI adapter、の依存順にsliceを組む。OpenAI adapterだけを先に
OpenRouter型へ押し込んで、一turn目だけ動く中間contractを正本にしない。

### Increment 15 — 同一Sessionのprovider切替

成立させる動作:

- idle時の`/provider`でroot providerを選び、続くprovider-scoped `/model`と`/effort`で次turnのselectionを確定する。
- selection変更は一つのdurable commitとして保存し、不完全なprovider/model組合せをactiveにしない。
- `/sessions`、resume、footer、turn attribution、execution artifact、evidenceがproviderを含むselectionを表示する。
- OpenRouterからOpenAI、OpenAIからOpenRouterへ切り替え、semantic transcriptを継続する。turn途中のroute変更はしない。

planner/subagent routeの対話的変更、自動provider fallback、複数auth account pickerは対象外とする。

### Increment 16 — built-in instruction component

成立させる動作:

- `Henji共通 + agent role + tool guideline + workspace instruction + skill manifest + runtime facts`を独立componentとして
  合成し、defaultとplannerが利用するcomponentをmanifestへ記録する。
- OpenRouterとOpenAI directが同じresolved Henji instructionを受ける。provider adapter固有のwire fieldや必須metadataを
  Henjiのagent instruction本文へ混ぜない。
- OpenAI direct rootとOpenRouter plannerの組合せでも、planner policyとtool capabilityがrootへ漏れず、rootのproviderを
  plannerが暗黙継承しないことを確認する。

実装結果（2026-09-09）:

- `v0/agent/instructions/`へ共通、role別、runtime facts、component型、固定順composerを配置した。project
  instructionはworkspace rootの`AGENTS.md`または`AGENTS.MD`だけで、Henji-global AGENTSは設けていない。
- Workerとdirect互換runtimeは、各roleでmaterializeしたregistryのguidelineから同じcomposerを使う。runtime
  factsはcwdだけで、provider、model、effort、Session ID、日付を含めない。
- built-in manifestは共通、role、active tool guideline、任意のworkspace/skill、runtime factsのidentityを記録する。
  OpenRouterのsystem messageとOpenAI Responsesの`instructions`には、同じresolved本文を既存adapterが写像する。

### Increment 17 — Codex subscription経路のfeasibility

次のfeasibility gateを行った。

1. official Codex app-serverのmanaged authでChatGPT browserまたはdevice-code login、token refresh、account stateを
   credentialをHenjiへ渡さず利用できるか確認する。
2. Codex SDKまたはapp-serverが現行Deno runtimeから利用でき、Henjiの`Model.generate()`、Henji-owned tool loop、
   Session transcriptへ適合する低水準model境界を
   提供するか確認する。提供しない場合は、Codexをnamed delegated agent backendとして統合する案と、非公開backendへ
   直接接続する案を分け、利用者へ選択を戻す。
3. Henjiが必要とするrequest、stream event、model output、runtime outcomeをどこまで取得できるか確認する。upstream raw
   SSEが取得できない場合は、その証拠差を明示し、同等と称さない。

確認の結果、Pi、OpenCode、Zotには、Codex CLIやapp-serverへagent taskを委譲せず、それぞれのagent/tool loopを
維持したままChatGPT Codex backendへ直接接続する比較実装がある。一方、公式の低水準subscription model APIと
非公開backendの安定したpublic contractは確認できなかった。

2026-09-09、利用者はOpenAI subscription対応を現段階の必須機能とせず、Henjiの既存機能の完成度を先に高めてから
将来incrementとして採否を判断すると決めた。そのため`openai-codex`はprovider registryへ追加していない。将来
再採用する場合も、ChatGPT OAuth tokenをOpenAI public API-key adapterへ渡さず、OpenAI API keyをCodex subscription
routeへ渡さない。

## OpenRouter Responses API経路とProvider設定の外部化（実装済み）

- **OpenRouter Responses API経路**: Increment 58で`openrouter-responses`をChat Completions routeと併設した。
  shared Responses adapterをstatelessに使い、Henji transcriptからitemを再構成する。既定routeは
  `openrouter-chat`のままで、自動fallbackしない。
- **Provider設定の外部化**: Increment 59〜64でProvider declaration v1、Host configからのload、catalog/defaults
  override、新provider ID、ResponsesとChat Completionsのbinary-owned adapter選択を実装した。同梱built-in宣言も
  同じdata contractを使う。declarationはexternal input/configであり、managed revision kindではない。
- **provider identityの一般化**: Increment 61〜64で`providerId` + `protocol` + `authProfile`を一般化し、Responses
  replayを生成元provider/modelへscopeした。Increment 68でbuilt-in IDを`openrouter-chat`、
  `openrouter-responses`、`openai-chat`、`openai-responses`へ整列し、旧IDは破壊的に廃止した。
- **subagent既定**: Increment 65で`subagent:planner`をactivation-level Definition bindingへ接続し、未binding時の
  planner selectionを同梱declarationの`roleDefaults`へ移した。root selectionは継承しない。
- これらは本書の不変条件（requestごとのroute所有、credential非継承、secret非永続化、turn内固定、semantic
  transcript共有、独立した失敗、request単位の証拠）を維持する。

## 各incrementの確認原則

各testは次のproduct動作へ対応させる。providerや認証方式の仮想的な組合せmatrixを件数目的で作らない。

- route解決: 選択された実行主体のrequestだけが対応provider endpointとauth resolverを使う。
- semantic loop: text final、function tool call/result continuation、複数stepが各adapterの公式contractで成立する。
- mixed route: OpenAI root、OpenRouter planner、OpenRouter `web_search`の実際の組合せが成立する。
- persistence: model/provider変更前後のSession commit、list、resume、turn attributionが一致する。
- evidence: raw response、provider event、parser transition、origin、route、request countをreadbackでき、credential値と
  Authorizationを含まない。
- regression: 既存OpenRouter model/effort切替、planner delegation、Sonar検索、deadline、footerが引き続き成立する。

Increment 14では外部contractが実装可否を左右するため、簡単なreal-provider probeを詳細計画に含めた。将来
ChatGPT subscription routeを再採用する場合も、その時点の個別increment計画で同様に外部contractを確認する。
credentialを使う場合も、値、Authorization、credential pathを出力・evidence・repositoryへ保存しない。

## 後続変更をarchitectureへ戻す条件

- ChatGPT subscription routeを将来再採用する場合、official Codex境界とdirect backendの現行contractを再確認し、
  Henjiのmodel provider contractと一致しない経路を同一provider pickerへ追加しない。
- OpenAI built-in Web searchは、上記route/auth基盤とは独立した後続判断とし、provider実装やfeasibility確認を
  止める依存にしない。
- dynamic/remote model catalog、第三のprotocol adapter、複数account auth profileを採用する場合は、declaration、
  selection、credential authority、evidenceへの影響を先に決める。
- Provider declarationをmanaged revisionへ移す場合も、credential解決、auth profile選択、provider evidence
  attributionをHenji-owned boundaryの外へ出さない。

## Review記録

第三者reviewの対象は、本書の利用者要件との一致、既存sourceとの衝突、Increment境界、OpenAI公式契約、Session・
provider state・evidence・credential routingのsource-to-impactである。一般的なsecurity hardeningや未観測provider
variantの列挙は対象外とする。

- 2026-09-09にread-onlyの独立reviewを実施した。初回結果はBlocker/P1なし、P2 3件だった。
- P2は、採用済みfooter/runtime instruction事項の未採用inboxからの移動、direct runtime・live eval・
  real-provider acceptance経路の衝突追記、Codex app-server managed authとSDK/app-server実行境界のgate分離で解消した。
- 変更箇所の再reviewで3件の解消と追加Blocker/P1なしを確認した。
- Increment 17ではCodex公式境界、Pi・OpenCode・Zotのdirect実装、OpenAIのOSS支援方針を確認し、runtime実装を
  将来へ延期した。再採用時には、その時点の外部contractと実行証拠を改めて確認する。
