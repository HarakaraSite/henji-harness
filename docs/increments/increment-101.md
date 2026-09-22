# Increment 101 — auth profile一般化と宣言request header（OpenCode Go対応）

ステータス: **実装・検証完了（offline v0:gate exit 0、実provider probeでauth/header・chat text/tool call・responses text成立）**

計画日: 2026-09-21

関連: [`architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)、
[`architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、
[`roadmap.md`](../roadmap.md) F02／F06、[`research/opencode-go-api-probe.md`](../research/opencode-go-api-probe.md)、
[`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md) E1／E5、
Increment 58〜71（Provider外部化とtool Definition）。

## 利用者が必要とする動作

- 利用者がexternal provider declaration JSON（`$XDG_CONFIG_HOME/henji-harness/providers/*.json`）と
  credential fileだけで、binary変更なしに新しいproviderを追加できる。
- 宣言JSONの`headers`で、任意のrequest header（静的値、`{credential}`、`{sessionId}`）を指定できる。
- OpenCode Goを`opencode-go-chat`／`opencode-go-responses`として選び、`opencode-go-api-key`で
  **単段text turn**を完了できる（tool callは継続確認まで完了条件にしない）。
- OpenCode Goへのrequestに`x-opencode-session`（Henji Session ID）とclient固有User-Agent
  （`Henji-Harness`）が送られる。

**product boundary**: 汎用header auth（`{credential}`を置く任意header）はChat経路
（`openai-chat-completions`）で成立させる。Responses経路（`openai-responses`）は当面
**標準`Authorization: Bearer`のみ**とし、`{credential}`をResponses宣言で使うことは認めない
（OpenCode Go responsesはBearer）。

## 決定（利用者判断 2026-09-21）

- auth profileは閉じたunionをやめ、pattern許容にし、credentialを
  `$XDG_CONFIG_HOME/henji-harness/<profileId>`から解決する。既存の`openrouter-api-key`／
  `openai-api-key`のfile名はprofile IDと一致するため移行は不要。
- headerは宣言のoptional `headers` mapとplaceholder registry（`{credential}`、`{sessionId}`）で一般化し、
  専用のauth fieldは設けない。
- URL／query templatingは今回入れない。必要になったproviderで追加する。
- catalog capabilities（vision等）は今回入れない。visionはtranscriptとadapterの責務であり、採用時に追加する。
- OpenCode Goの宣言はexternal JSON（利用者が置く）。bundled `provider-defaults.json`には同梱しない。
- Anthropic Messages、Google、Azure OpenAI、AWS Bedrockは調査のみで当面対応しない（E5）。

## 現状の制約（source根拠）

- `AuthProfileId`は`'openrouter-api-key' | 'openai-api-key'`の閉じたunion
  （`v0/agent/provider/model_selection.ts:20`、`v0/agent/provider/provider_declaration.ts:71`）。
- credential pathは`credentialPath(profile)`が`<configRoot>/<profile>`を返すが、引数型は2値union
  （`v0/agent/runtime/runtime_paths.ts:56-59`）。`credential_file.ts:11-12`がこれを使う。
  `credential_resolver.ts:18`は`Record<AuthProfileId, CredentialSource>`。
- declaration schema（`ProviderDeclarationV1`）は`headers`を持たず、`exactKeys`で7 keyに固定される
  （`v0/agent/provider/provider_declaration.ts:141-223`）。built-in overrideはprotocol・endpoint・
  authProfileを固定しcatalogとdefaultsだけ置換する（`:254-285`）。
- declared chatのprofileは`openRouterProfileForDeclaredChat(provider, model, effort, endpoint)`が生成し、
  headerを受け取らない（`v0/agent/provider/openrouter_model_catalog.ts:133-151`）。
  transportは`openrouter_transport.ts:226-229`でheaderを直接構築する。
- declared responsesは`DeclaredResponsesModelOptions`にheaderがなく、基底`ResponsesApiModel`がOpenAI SDKの
  `defaultHeaders`を使う（`v0/agent/provider/openai_responses_model.ts:412-426`、`:588-606`）。
  SDKの`defaultHeaders`はapiKey由来`Authorization`を後段で上書きできる。
- **provider evidenceのrequest metadataはauthProfileを2値に固定検証する**
  （`v0/agent/provider/provider_evidence.ts:59`、`validProviderMetadata` `:409-411`）。
  adapterは選択authProfileをそのまま載せる（`openrouter_transport.ts:184`、
  `openai_responses_model.ts:226`）。宣言chatの`evidenceIdentity.authProfile`も2値union
  （`v0/agent/provider/openrouter_contract.ts:130`）。検証失敗はhistory storeのobservation
  append/readbackでinvalidになる（`v0/agent/history/sqlite_history_store.ts:817,4457`）。
- `createProductionPhysicalIo`はHenji Session IDを受け取らない（`v0/agent/worker/worker_physical_io.ts:161-280`）。
  `createGeneration`は`correlation.session`を持つ（`v0/agent/worker/worker_bootstrap.ts:348-364,463`）。
- Chat parserは`reasoning_details`のみ扱い、`reasoning_content`は未対応
  （`v0/agent/provider/openrouter_sse.ts:358`）。`stop`/`tool_calls`以外の`finish_reason`は失敗にし、
  post-terminal frameは「同一finish_reason＋完全なusage」の1件だけ許す（`openrouter_sse.ts:337-346,392-408`）。

## 参考調査（2026-09-21、official docsのみ。当面対応しない。詳細はE5）

- **Anthropic Messages**: `POST https://api.anthropic.com/v1/messages`、`GET /v1/models`あり。authは
  `x-api-key`または`Authorization: Bearer`、`anthropic-version: 2023-06-01`必須。wireが別で、thinking
  block＋`signature`のecho必須、`max_tokens`必須。→ 新protocol adapterが必要。
- **Google Gemini (AI Studio)**: nativeは`/v1beta/models/{model}:generateContent`、
  `:streamGenerateContent?alt=sse`、authは`x-goog-api-key`。OpenAI互換endpoint
  `https://generativelanguage.googleapis.com/v1beta/openai/`（`Authorization: Bearer`）があり、Chat
  Completionsとtoolsを再利用できる。nativeは`thoughtSignature`のechoが必要で新adapter。
- **Azure OpenAI**: v1 API `https://{resource}.openai.azure.com/openai/v1/`はOpenAI形式で
  `api-key`headerまたはEntra Bearer。classicはdeployment path＋`api-version` queryが必要でURL/query
  templatingが要る。
- **AWS Bedrock native**: SigV4署名はrequestごとの計算が必要で、静的header mapでは表現できない。
- 帰結: authはheader placeholderで一般化できる。GoogleはOpenAI互換で新protocol不要。Anthropicは新adapter。

## 正本変更（承認依頼）

- `architecture/multi-provider-routing-and-auth.md`:
  - declaration v1契約（114-117行付近）にoptional `headers`とplaceholder（`{credential}`、`{sessionId}`）、
    禁止header、merge precedence、Chatの既定Bearer規則、Responsesの標準Bearer境界を追記。
  - `authProfile`の一般化（108、163-164行付近）: pattern許容と`<configRoot>/<profileId>`解決。
    credential sourceが「caller-selected path」になる点（`credential_file.ts:1-7`の前提変更）を明記。
- `architecture/henji-host-agent-worker.md`: provider identity記述（381-391行付近）のauthProfile一般化、
  credential path authorityの変更、built-in overrideがprotocol/endpoint/authProfileを固定したまま
  `headers`も置換できる（378行付近）ことを追記。
- `roadmap.md` F02／F06: 実装状況へOpenCode Go対応とauth profile一般化を追記（採用時）。

## 実装範囲

1. **auth profile一般化**:
   - 単一の`isAuthProfileId`／pattern（`/^[a-z0-9][a-z0-9-]{0,63}$/u`相当）をexportし、declaration
     validation・stored selection decode・credential path前段で共用する。reserved名`providers`と
     `instruction`の拒否もこの共用validatorに含める。
   - `runtime_paths.ts`: `credentialPath(profileId: string)`へ一般化（pattern検証後にpath構築）。
   - `credential_file.ts`: `credentialFileFor(profileId)`とpresenceを一般化。既存の0600／symlink拒否／
     size上限／単一トークン検証を流用。**presenceはregular fileのみ`present`**とし、directory等は
     `unknown`（present/read不整合を防ぐ）。
   - `credential_resolver.ts`: `sources?: Readonly<Record<string, CredentialSource>>`を受け、既定は
     `readCredentialFileAt(credentialPath(profile))`。既存`openRouter`／`openAI` seamはこのmapへ正規化し、
     既存testは更新する。
   - `provider_declaration.ts` `AUTH_PROFILES`をpattern validationへ。
   - `model_selection.ts` `isStoredModelSelection`は**built-in 4 providerのliteral固定を維持**し、未知
     providerのみpattern検証にする。declared selection unionを一般化。
   - `worker_physical_io.ts` `credentialAvailability`を一般化し、optionalなpresence seam
     （`credentialPresence?: (profile) => Promise<CredentialAvailabilityStatus>`）を追加して
     `worker_host_session`の`validCredentialAvailability`を新profileで検証できるようにする。
   - **`provider_evidence.ts`**: `ProviderEvidenceRequestMetadata.authProfile`と`validProviderMetadata`を
     pattern検証へ。`openrouter_contract.ts:130`の`evidenceIdentity.authProfile`unionも一般化。
2. **declaration `headers`**:
   - optional `headers: Record<string, string>`。`exactKeys`をoptional対応へ。schemaVersionは1のまま。
   - **`headers`は新しいprovider idの宣言のみ許可**する。built-in override対象ID
     （`OVERRIDABLE_PROVIDER_IDS`）の宣言に`headers`があればinvalid（経路により黙って無視される
     非一貫を避ける）。
   - header名は小文字正規化しHTTP tokenとして検証。正規化後の重複・case衝突はinvalid。空名／空値はinvalid。
   - `content-type`／`host`／`content-length`の上書きを拒否。
   - `authorization`の規則はprotocol-aware:
     - `openai-responses`: `authorization`を禁止。
     - `openai-chat-completions`: `authorization`を許す場合は値が正確に`Bearer {credential}`であること。
   - `{credential}`の規則:
     - `openai-responses`では`{credential}`を含むheader値を**全面的に禁止**。
     - `openai-chat-completions`では`{credential}`を含むheaderは**1つだけ**許可。`authorization`と
       他の`{credential}`headerの併用も禁止。
   - placeholderは部分置換（値中の`{token}`を文字列置換）。対応tokenは`{credential}`と`{sessionId}`のみ。
     置換対象regexは`\{[^{}]*\}`。既知token以外の`{...}`、閉じない`{`、空白入りtokenは宣言invalid。
     `{sessionId}`はadapterのrequest build時に置換し、sessionId未供給時は`invalid_input`で明示失敗する
     （`missing_credential`とは区別）。
3. **adapter配線**:
   - `openRouterProfileForDeclaredChat`へ`headers`引数を追加し、`worker_physical_io.ts`から
     `declaration.headers`を渡す。`OpenRouterAgentProfile`に`requestHeaders`を追加し、
     `openrouter_transport.ts`でbase headerへmerge。**precedence**は正規化名で宣言がbaseを置換。宣言が
     `{credential}`を使う場合、baseの`Authorization: Bearer`を送らない。
   - `DeclaredResponsesModelOptions`へ`headers`を追加し、`worker_physical_io.ts`から渡す。宣言headerを
     `ResponsesApiModelOptions`／config経由でSDKの`defaultHeaders`へmergeする。
   - `createProductionPhysicalIo`に`sessionId`を渡すseam（`worker_bootstrap`の`correlation.session`）。
     同値を`OpenRouterAgentModelOptions`／`DeclaredResponsesModelOptions`へ渡し、adapterがrequest build時に
     `{sessionId}`を置換する。
   - `{credential}`はadapterがrequest時にcredential値へ置換し、transport boundary外へ出さない。
   - `openRouterProfileForDeclaredChat`の`secretEnv`は非production fallback用である旨を整理（productionは
     `credentialSource`を常に供給）。
4. **OpenCode Go external declaration（利用者が`providers/`へ置く。bundledしない）**:
   - `opencode-go-chat`／`opencode-go-responses`の宣言例と受入手順をincrementへ記録する。
   - `headers`に`x-opencode-session: {sessionId}`と`user-agent: Henji-Harness`を含める。User-Agentは
     静的値とし、version埋め込み（`{productVersion}`）はWorkerでbuild versionが利用可能になった時点の追加候補。
   - catalogは公式docsでroute確認済みのmodelのみ、effortは`auto`のみ（実probeで確定）。
5. **focused test**。

## chat SSE parser互換（2026-09-22、利用者判断Aで追加）

probeで判明したchat非互換を、binary-owned chat SSE parserのwire互換緩和として修正する。

- `v0/agent/provider/openrouter_sse.ts`: `usage: null`を「usageなし」として扱う（`hasUsage`をpresent
  かつ非nullのときだけtrueにする）。terminal後の`choices: []`＋usageのみのframeを許可する
  （OpenAI `stream_options.include_usage`とOpenCode Goが同形）。usage-only frameがterminal前に来る場合は
  従来どおり`invalid_usage_frame`で拒否する。openrouter-chat／openai-chatにも同じ緩和が適用される。
- focused test: OpenCode Go形状（usage-null chunk、terminal後のchoices空usage frame）でfinal textが返る
  こと、usage-only frameがterminal前なら拒否されること。

## OpenCode Go external declaration（利用者が配置）

credential file（既存のprobeで使用したものと同じ場所）:

```text
$XDG_CONFIG_HOME/henji-harness/opencode-go-api-key   # 0600・単一トークン
```

`$XDG_CONFIG_HOME/henji-harness/providers/opencode-go-chat.json`:

```json
{
  "schemaVersion": 1,
  "providerId": "opencode-go-chat",
  "protocol": "openai-chat-completions",
  "endpoint": "https://opencode.ai/zen/go/v1",
  "authProfile": "opencode-go-api-key",
  "headers": {
    "user-agent": "Henji-Harness",
    "x-opencode-session": "{sessionId}"
  },
  "modelCatalog": {
    "kind": "fixed",
    "entries": [
      { "modelId": "glm-5.3-flash", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "glm-5.3", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "glm-5.2", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "glm-5.1", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "kimi-k3", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "kimi-k2.7-code", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "kimi-k2.6", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "longcat-2.0", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "deepseek-v4.1-flash", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "deepseek-v4-pro", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "deepseek-v4-flash", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "mimo-v2.5", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "hy4-preview", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "hy3", "defaultEffort": "auto", "efforts": ["auto"] }
    ]
  },
  "defaults": { "modelId": "glm-5.3-flash", "effort": "auto" }
}
```

`$XDG_CONFIG_HOME/henji-harness/providers/opencode-go-responses.json`:

```json
{
  "schemaVersion": 1,
  "providerId": "opencode-go-responses",
  "protocol": "openai-responses",
  "endpoint": "https://opencode.ai/zen/go/v1",
  "authProfile": "opencode-go-api-key",
  "headers": {
    "user-agent": "Henji-Harness",
    "x-opencode-session": "{sessionId}"
  },
  "modelCatalog": {
    "kind": "fixed",
    "entries": [
      { "modelId": "grok-4.6", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "gpt-5.6-luna", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "muse-spark-1.3-contributor", "defaultEffort": "auto", "efforts": ["auto"] },
      { "modelId": "muse-spark-1.2-contributor", "defaultEffort": "auto", "efforts": ["auto"] }
    ]
  },
  "defaults": { "modelId": "grok-4.6", "effort": "auto" }
}
```

受入手順:

1. credential fileを0600で作成する（値は表示・保存しない）。
2. 上記2 JSONを`providers/`へ置く。
3. TUIの`/provider`で`opencode-go-chat`／`opencode-go-responses`を選ぶ、または`--root-provider`で指定する。
4. 実provider probe（別承認）でturn完了と送信headerを確認する。catalogはprobe結果に合わせて確定する。

## 検証

- focused test:
  - declaration validation: `headers`のoptional互換、built-in overrideでの`headers`拒否、禁止header、
    case重複、protocol-aware `authorization`、Responsesでの`{credential}`全面拒否、Chatでの`{credential}`
    単一・併用拒否、placeholder文法（未対応token、閉じない`{`、空白token）、空名/空値。
  - placeholder部分置換とmerge precedence、Chatで宣言`{credential}`使用時のbase Bearer抑止。
  - **Chat／Responses双方**で、宣言headerをmergeした最終`init.headers`をinjectable fetcherでassert。
    Responsesは`x-opencode-session`/`user-agent`が載り、`Authorization`が`Bearer <credential>`の単一値で
    あること、credentialがevidenceの`requestMetadata`／raw bytes／transcriptへ現れないこと。
  - `opencode-go-api-key`を含むproviderEvidenceのvalidate／history append・readback round-trip。
  - `worker_host_session`の`validCredentialAvailability`が新profile（presence seam注入）で成立すること。
  - auth profile path／presence（regular fileのみpresent、directory/symlinkはunknown、0600でないregularは
    presentのままread失敗、reserved名拒否）。
  - `{sessionId}`がfresh生成と`replaceGeneration`後で同一であること、未供給時に`invalid_input`で失敗すること。
  - `isStoredModelSelection`のbuilt-in literal維持（未知providerはpattern通過、catalog照合は別）を確認。
  - 宣言`headers`（literalの`{sessionId}`含む）がSession／execution artifact／provider evidenceへ
    永続化されないこと。
  - 既存test更新: `tests/v0/increment_14_multi_provider_test.ts:426`の`'unknown-profile'`期待を
    invalid-pattern値（例: `'Upper'`や`'/etc/passwd'`）へ更新。
- `deno check --config deno.v0.json`、`v0:fmt`、`v0:lint`、`git diff --check`。
- authoritative `v0:gate`はcoordinating ownerが安定候補に対し1回。
- 実provider probe（別承認）:
  - 対象・回数・保存先を提示して承認を得る。
  - **実adapter（または完全に同一のbody/header）**でOpenCode Go chat／responsesを実行し、statusと
    実際の送信header（`x-opencode-session`、User-Agent、auth schemeがBearerであること。値は記録しない）を
    記録する。User-AgentはDeno fetchが落とさないことをwireで確認する。
  - Responsesの`include: ['reasoning.encrypted_content']`と`store: false`が受理または無視されることを確認。
  - chatのtool callと`reasoning_content`、responsesのtool callを確認する。
  - 正常なtext turnが`finish_reason: stop`で完了し、post-terminal cost frameがparserを通ることを確認する。

## 実provider probe結果（2026-09-22、利用者承認済み・計9 request = 初回6＋chat再probe 3）

source dev launcher（`deno run`、実adapter、isolated出力`/tmp/henji-i101-probe/`）で実行。credentialは
`~/.config/henji-harness/opencode-go-api-key`からrequest時のみ読み、API keyと`Authorization`は保存していない。

- **auth/header基盤は成立**: chat（`glm-5.3-flash`）・responses（`gpt-5.6-luna`）ともHTTP 200で、
  `user-agent: Henji-Harness`と`x-opencode-session`（Henji Session ID）が送信され、credentialが解決された。
- **responsesは単段text turn成立**: `gpt-5.6-luna`は`PROBE_RESPONSES_OK`で完了。`grok-4.6`はproviderが
  `event: error`「Service temporarily unavailable. The model did not respond to this request.」を返し、
  Henji側のparser gapではなくprovider側の一時エラーと判断（`include:['reasoning.encrypted_content']`／
  `store:false`は受理または無視された）。
- **chatは初回parser非互換で失敗**（下記修正で成立）: OpenCode Go chatの全chunkが`"usage":null`を持ち、
  parserの`hasUsage = hasOwn(object,'usage')`がnullをusage扱いして`invalid_usage_frame`で失敗した。加えて
  terminal後のusage frameが`"choices":[]`で、parserはchoice数1を要求していた。
- **chat再probe（parser互換修正後、2026-09-22、承認済み、3 request）**:
  - `glm-5.3-flash`単段text turnが`PROBE_CHAT_OK`で完了。
  - `glm-5.3-flash`が`echo`toolを呼び（`toolu_02f4…`、`{"text":"ping"}`）、tool resultを返した後の
    continuationがfinal textで完了。chatのtool call継続が成立。
  - `reasoning_content`は未知fieldとして無視されたが、tool call継続にechoは不要だった。
- `grok-4.6`（responses）はprovider側の一時エラー。`gpt-5.6-luna`でresponses単段text turn成立。

## 未確認事項と完了条件

- chat単段text turnとtool call継続、responses単段text turnは実probeで成立（完了条件を満たす）。
- `reasoning_content`は`glm-5.3-flash`では未知fieldとして無視され、tool call継続にechoは不要だった。
  echoが必要なmodelが現れた場合のparser／provider-state対応は別increment候補とする。
- `finish_reason: "length"`またはpost-terminal cost frameが通常turnで問題になる場合は、parser対応を
  別increment候補として記録する。
- modelごとのeffort対応はprobeで確認できた範囲（`glm-5.3-flash`／`gpt-5.6-luna`は`auto`）だけcatalogへ
  反映する。`grok-4.6`はprobe時にprovider側の一時エラーで未確認。

## 対象外

- Anthropic Messages adapter、Google、Azure OpenAI、AWS Bedrock。
- URL／query templating、catalog capabilities（vision等）、画像入力（transcriptがtext-only）。
- Responses経路での非Bearer auth置換。
- built-in override宣言への`headers`適用。
- `{productVersion}` placeholder、OpenCode Go宣言のbundled同梱。
