# Increment 64 — 同梱default declarationsと宣言chat completions provider

ステータス: **完了（v0:gate前）**

基準commit: `b001b74e`

計画日: 2026-09-17

対象: 完全外部化(c)の第2段。curated catalogをコード定数から同梱default declarations（data）へ移し、宣言で
`openai-chat-completions` protocolの新providerを追加できるようにする。

## 利用者が必要とする動作

- providerのcatalogと既定が**コード定数ではなく同梱default declarations（data）**として供給され、宣言で
  上書きできる。宣言が無ければ同梱defaultで従来どおり動く（ゼロ-config維持）。
- 宣言で`openai-chat-completions` protocolの新provider（OpenAI互換Chat Completions endpoint）を追加し、`/provider`・
  `--root-provider`・model pickerから選択・実行できる。
- 既存の`openrouter`/`openai`/`openrouter-responses`/宣言Responses providerを退行させない。

## 計画

### 同梱default declarations（data化）

- `v0/agent/provider/defaults/provider-defaults.json`へ`openrouter`/`openai`/`openrouter-responses`の宣言
  （providerId、protocol、endpoint、authProfile、fixed modelCatalog、defaults）を置く。
- `provider_defaults.ts`を追加し、JSON import（`with { type: 'json' }`）で読み、`bundledDefaultDeclarations()`を
  公開する。`builtinProviderDeclarations()`はここから返す。
- `openrouter_model_catalog.ts`/`openai_model_catalog.ts`の`OPENROUTER_MODEL_CATALOG`等のliteral配列を削除し、
  同梱default declarationのentries/defaultsから導出する。`ROOT_DEFAULT_MODEL_SELECTION`等もそこから構築する。
- import cycle回避: `provider_defaults.ts`は`provider_declaration.ts`をtype-onlyで参照し、
  `provider_declaration.ts`と両catalogが`provider_defaults.ts`を参照する。

### 宣言chat completions provider

- `ModelSelection`へ`DeclaredChatModelSelection`
  `{ provider: string; api: 'openai-chat-completions'; authProfile; modelId; effort }`を追加し、
  `isStoredModelSelection`を拡張する。
- `providerIdsForSelection`・`declaredEntriesFor`・`selectModelFor`・`defaultModelSelectionFor`がchat宣言providerも
  扱う。
- `worker_physical_io.ts`はapi `openai-chat-completions`の宣言providerを、宣言endpointから構築したprofile
  （origin=宣言endpoint、path=`/chat/completions`、model、reasoningEffort、maxCompletionTokens）で
  `OpenRouterAgentModel`へ配線する。credentialは宣言authProfileのresolverから解決する。
- provider evidenceの`api` unionへ`openai-chat-completions`を追加する。

## 対象外

- planner default・Sonarのrole別既定（Increment 65）
- built-in id削除とSession影響、既定解決不能時の入力ブロック（Increment 66）
- 動的model catalog discovery、OpenAI互換以外のChat Completions wire差異の作り込み（互換endpoint前提）
- SQLite schema変更

## Verification

- focused test: 同梱defaultのcatalog/defaultsが従来のliteralと一致し、宣言なしで既存動作になること。
  `openrouter`/`openai`宣言override、chat宣言providerのselection・検証・`searchModelsFor`・request URL（宣言
  endpoint）・evidence api。
- 実機: 同梱defaultで`openrouter`起動、chat宣言provider（例 `local-chat`, endpoint, catalog）のfooter表示。
- 変更箇所のtype check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 規模見積り

同梱default data化、catalog導出の変更、宣言chat providerのidentity/配線、testで**2〜3開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. curated catalog/既定をJSON dataの同梱default declarationsへ移し、`builtinProviderDeclarations`がそれを返す扱い。
2. chat宣言providerを`OpenRouterAgentModel`（宣言endpoint/profile、credentialは宣言authProfile）で実行する扱い。
   OpenAI互換Chat Completionsを前提とし、非互換wire差異の作り込みは対象外。
3. 実provider probeは実行直前に別途許可する検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `v0/agent/provider/defaults/provider-defaults.json`を追加し、`openrouter`/`openrouter-responses`/`openai`の
  宣言（protocol/endpoint/authProfile/catalog/defaults）をdataとして同梱した。`provider_defaults.ts`がJSONを
  importし、`bundledDefaultDeclarations()`を公開する。`builtinProviderDeclarations()`はこれを検証して返す。
- `openrouter_model_catalog.ts`/`openai_model_catalog.ts`のliteral catalog配列を削除し、同梱default declarationの
  entries/defaultsから`OPENROUTER_MODEL_CATALOG`・`ROOT_DEFAULT_*`・`OPENAI_MODEL_CATALOG`・
  `OPENAI_DEFAULT_MODEL_SELECTION`を導出した。import cycleは`provider_defaults.ts`のtype-only参照で回避した。
- `ModelSelection`へ`DeclaredChatModelSelection`（api `openai-chat-completions`）を追加し、`isStoredModelSelection`・
  `providerIdsForSelection`・`declaredEntriesFor`・`selectModelFor`・`defaultModelSelectionFor`がchat宣言providerを
  扱う。`worker_physical_io.ts`は宣言endpoint/profile（origin=endpoint、path=`/chat/completions`）で
  `OpenRouterAgentModel`へ配線する。`OpenRouterAgentModelOptions.evidenceIdentity`でprovider/api/authProfileを
  正しく記録し、`provider_evidence`のapi unionへ`openai-chat-completions`を追加した。
- focused test: 同梱defaultのcatalog件数・既定が従来値と一致すること、chat宣言providerのselection・検証・
  宣言endpointへのrequest URL・Authorization・evidence apiを追加し、increment-14は19 passed。
  provider_stream_compatibility（20）、increment-15（6）、increment-16（4）、increment-33（11）、increment-51（8）、
  increment-32（7）、TUI系（86）、foundation（26）もpassed。type check/format/lint/`git diff --check`成功。
- 実機: isolated XDGでchat宣言provider `local-chat`が`--root-provider local-chat`のfooterに
  `provider:local-chat model:llama-3-70b medium`として現れ、宣言が無い場合は同梱defaultの`openrouter`
  `deepseek/deepseek-v4.1-flash high`になることを確認した（provider requestは行っていない）。
- 実probe（利用者許可）: 宣言`openai-chat`（`protocol: openai-chat-completions`, endpoint
  `https://api.openai.com/v1`, `authProfile: openai-api-key`, model `gpt-5.6-terra`）で、当初HTTP 400を観測した。
  原因は、OpenRouter形式の`reasoning: { effort }`をOpenAI Chat Completionsへ送っていたこと。`OpenRouterAgentProfile`へ
  `reasoningEffortField`（`reasoning` / `reasoning_effort`）を追加し、宣言chatは`reasoning_effort`を出力するよう
  修正した（builtin OpenRouterは`reasoning`のまま）。修正後、`reasoning_effort: 'none'`でtool turnが完走し、
  `tool> read ...`→`assistant>`、canonical commit、`model_selection`（provider `openai-chat`、api
  `openai-chat-completions`、authProfile `openai-api-key`）、evidence api `openai-chat-completions`、endpoint
  `https://api.openai.com/v1/chat/completions`を確認した。
- OpenAI側の制約を確認した: `gpt-5.6-terra`のChat Completionsは**function toolsと`reasoning_effort`の併用を
  受け付けない**（`/v1/responses`を使うか`reasoning_effort:'none'`を要求）。これはprovider/model固有の契約差で
  あり、宣言chat providerの汎用対応は対象外。tools併用時は`none`、またはResponses protocolを使う。
- 未実施: authoritative `v0:gate`、commit、build、binary置換。
