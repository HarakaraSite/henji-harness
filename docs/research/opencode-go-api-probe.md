# OpenCode Go API調査結果

## 概要

OpenCode GoをHenjiのProviderとして利用できるかを、OpenCode Go公式ドキュメントと、利用者の許可を得た実endpoint probeで調査した。

調査時点では、OpenCode GoはHenjiへ追加可能だが、**外部Provider declaration JSONだけでは正式対応にならない**。Chat CompletionsとResponsesのrouteは既存adapterを再利用できる可能性が高い一方、専用auth profile、credential file、`x-opencode-session`、User-Agent、OpenCode Go固有のreasoningとtool-call挙動を扱う内部実装が必要になる。

今回の調査ではrepository source、repository architecture/research文書、OpenCode Go公式docs、実endpointの応答を確認した。Provider sourceや設定JSONは変更していない。

## 外部の正本と参照URL

- OpenCode Go公式docs: <https://opencode.ai/docs/go/>
- OpenCode Provider docs: <https://opencode.ai/docs/providers/>
- OpenCode Model docs: <https://opencode.ai/docs/models/>

OpenCode Go公式docsが示す基本endpointは次のとおり。

```text
Base URL: https://opencode.ai/zen/go/v1
Models:   GET  https://opencode.ai/zen/go/v1/models
Chat:     POST https://opencode.ai/zen/go/v1/chat/completions
Responses: POST https://opencode.ai/zen/go/v1/responses
Messages: POST https://opencode.ai/zen/go/v1/messages
```

OpenCode Goの公式route表では、modelごとにAPI surfaceが異なる。

- `/chat/completions`: OpenAI-compatible adapter
- `/responses`: OpenAI Responses adapter
- `/messages`: Anthropic Messages adapter

公式docsは、Go利用clientに対して会話ごとの安定した`x-opencode-session`を送ること、一般的なHTTP library名ではなくclient固有のUser-Agentを送ることを案内している。

## 実施したprobe

一時的なDeno TypeScript probeを作成して実行した。

```text
script: /tmp/henji_opencode_go_probe.ts
report: /tmp/henji-opencode-go-probe-1789997131.json
```

認証keyは次の利用者管理ファイルからrequest時だけ読み込んだ。

```text
/home/masat.guest/.config/henji-harness/opencode-go-api-key
```

probeは次を実施した。

1. `GET /models`
2. Chat Completionsのstream requestを1回
3. Responsesのstream requestを1回

probeで送った非秘密header:

```text
User-Agent: henji-opencode-go-probe/0.1
x-opencode-session: <probe内で生成した同一UUID>
```

API keyと`Authorization`は出力・reportへ保存していない。reportのpermissionは`600`。

## 実測結果

### Model一覧

```text
HTTP 200
Content-Type: application/json
model count: 37
```

実測したmodel ID:

```text
minimax-m3
minimax-m2.7
minimax-m2.5
kimi-k3
kimi-k2.7-code
kimi-k2.6
longcat-2.0
kimi-k2.5
glm-5.2
glm-5.3-flash
glm-5.3
glm-5.1
glm-5
deepseek-v4-pro
deepseek-v4-flash
deepseek-flash
deepseek-v4.1-flash
deepseek-v4-flash-vision-exp
qwen3.7-max
qwen3.8-max
qwen3.8-flash
qwen3.7-plus
qwen3.6-plus
qwen3.5-plus
mimo-v2-pro
mimo-v2-omni
mimo-v2.5-pro
mimo-v2.5
hy4-preview
hy3
hy3-preview
gpt-5.6-luna
grok-4.5
grok-4.6
muse-spark-1.3-contributor
muse-spark-1.2-contributor
omen-alpha
```

### Chat Completions

probe model: `glm-5.3-flash`

```text
POST https://opencode.ai/zen/go/v1/chat/completions
HTTP 200
Content-Type: text/event-stream
response bytes: 4300
elapsed: about 1.8s
```

応答はOpenAI Chat Completions SSEの形だった。

```text
data: {"object":"chat.completion.chunk", ...}
data: [DONE]
```

確認できたfield:

- `delta.role`
- `delta.content`
- `delta.reasoning_content`
- `finish_reason`
- usage
- `[DONE]`
- 最終cost event

`max_tokens: 32`を指定したためreasoning出力が上限に到達し、`finish_reason: "length"`になった。HTTP transportとSSE応答は成功したが、完全な最終回答を得るためのtoken budgetとしては小さすぎた。

### Responses

probe model: `grok-4.6`

```text
POST https://opencode.ai/zen/go/v1/responses
HTTP 200
Content-Type: text/event-stream
response bytes: 11515
elapsed: about 2.8s
```

確認できたevent type:

```text
response.created
response.in_progress
response.output_item.added
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.completed
ping
```

最終回答は次だった。

```text
PROBE_RESPONSES_OK
```

## Henji current sourceとの照合

### 既存のProvider declaration

Henjiの外部Provider declarationは次にある。

```text
~/.config/henji-harness/providers/*.json
```

schemaとload/mergeは次にある。

```text
v0/agent/provider/provider_declaration.ts
```

組み込みdataは次にある。

```text
v0/agent/provider/defaults/provider-defaults.json
```

現在のprotocolは次の2つだけ。

```text
openai-chat-completions
openai-responses
```

そのため、OpenCode GoのChatとResponsesは外部JSONのfixed catalogで宣言できる可能性がある。`/messages` routeは現在のHenji契約にない。

### Auth profileとcredential

現在許可されているauth profileは次だけ。

```text
openrouter-api-key
openai-api-key
```

型・validation:

```text
v0/agent/provider/model_selection.ts
v0/agent/provider/provider_declaration.ts
```

credential fileの固定pathとread/validation:

```text
v0/agent/provider/credential_file.ts
v0/agent/provider/credential_resolver.ts
```

既存の本番credential file:

```text
~/.config/henji-harness/openrouter-api-key
~/.config/henji-harness/openai-api-key
```

OpenCode Goのkeyを既存profileへ一時的に流用することは技術的には可能でも、OpenRouter/OpenAI directとOpenCode Goのcredential・課金・route identityを混同する。正式対応では専用profile、例えば次を追加する必要がある。

```text
opencode-go-api-key
```

対応file:

```text
~/.config/henji-harness/opencode-go-api-key
```

### AdapterとSSE

Provider adapterの生成は次にある。

```text
v0/agent/worker/worker_physical_io.ts
```

Chat Completions transportとSSE parser:

```text
v0/agent/provider/openrouter_transport.ts
v0/agent/provider/openrouter_sse.ts
v0/agent/provider/openrouter_response.ts
```

Responses adapter:

```text
v0/agent/provider/openai_responses_model.ts
```

既存Chat SSE parserは標準的な`chat.completion.chunk`、`tool_calls`、`[DONE]`を扱う。既存Responses adapterは`response.created`、`response.output_text.delta`、`response.completed`等を扱う。したがって、OpenCode Goの基本text/SSEは既存adapterを再利用できる可能性が高い。

ただし、OpenCode Go Chat probeは次を返した。

```json
{"delta":{"reasoning_content":"..."}}
```

Henjiの既存Chat parserで明示的に扱う主要なreasoning fieldは`reasoning_details`であり、`reasoning_content`のdurable attributionやprovider state化は未確認である。Responsesのtool callは今回のprobeでは実行していない。

### Request headers

Henjiの現行Chat adapterのrequest headerは概ね次だけである。

```text
content-type: application/json
authorization: Bearer <credential>
```

OpenAI SDKを使うResponses adapterも、現在のsourceではOpenCode Go固有の`x-opencode-session`と専用User-Agentを付与していない。OpenCode Goを正式対応するには、Henji Session IDをWorker-local adapterまで渡し、少なくとも次を送る必要がある。

```text
x-opencode-session: <stable Henji session id>
user-agent: Henji-Harness/<product version>
```

外部Provider declarationには現在任意headerのschemaがないため、JSONへheaderを書く解決だけでは現行adapterを変更しない限り送信されない。

## 外部JSONだけで足りる範囲

次は、既存protocolと既存adapterを使う前提なら、外部Provider JSONで定義できる。

- Chat用Provider declaration
- Responses用Provider declaration
- endpoint base URL
- fixed model catalog
- modelごとのdefault effortとeffort一覧
- Providerごとのdefault model

概念上は次の2 routeに分ける。

```text
opencode-go-chat
  protocol: openai-chat-completions
  endpoint: https://opencode.ai/zen/go/v1
  path: /chat/completions

opencode-go-responses
  protocol: openai-responses
  endpoint: https://opencode.ai/zen/go/v1
  path: /responses
```

Henjiの現行adapterがendpointへprotocol固有pathを付けるため、declaration endpointはbase URLとして扱う。

## 内部コード変更が必要な範囲

### 必須候補

- `opencode-go-api-key` auth profileの追加
- `opencode-go-api-key`用credential fileの追加
- credential resolverへのprofile追加
- OpenCode Go用Chat/Responses declarationを同梱するか、external JSONを読む運用の確定
- Henji Session IDをadapterまで渡す仕組み
- `x-opencode-session`の送信
- OpenCode Go固有User-Agentの送信

### OpenCode Goの挙動に応じて必要

- Chatの`reasoning_content`を保存・evidence・provider stateへ扱う変更
- Chat tool callの実probeと必要なparser修正
- Responses tool callの実probeと必要なparser修正
- modelごとのprotocol分類
- 外部docsにない実測modelのroute分類

### 別protocolとして必要

- `/messages`を使うmodelを追加する場合のAnthropic Messages adapter
- `/messages`用request encoding、stream parser、tool call continuation、reasoning mapping

## Model catalogの確定方針

公式docsのroute表と実`GET /models`は完全には一致しない。実測ではdocs掲載外の次のIDも返った。

```text
deepseek-flash
glm-5
grok-4.5
hy3-preview
kimi-k2.5
mimo-v2-omni
mimo-v2-pro
omen-alpha
qwen3.5-plus
```

そのためcatalogは、次のように扱うのがよい。

1. `/models`を取得してmodel IDの候補を作る。
2. 公式docsのroute表でprotocolを確認する。
3. docsにないmodelは少なくとも最小requestでrouteを実測する。
4. ChatとResponsesのProvider declarationを分ける。
5. `/messages`は別incrementでprotocol adapterを設計する。

なお、`GET /models`の応答にはmodel ID、object、created、owned_byがあるが、reasoning effort一覧、tool support、context/output limit、route surfaceは含まれない。したがってcatalogへeffortsを入れるには、公式情報またはmodelごとの実request確認が別途必要である。

## 推奨する次の実装順

1. OpenCode Goを正式に採用するか利用者判断を確認する。
2. OpenCode Go用auth profileとcredential fileを追加する。
3. Session IDとUser-Agentをrequestへ注入できる内部seamを追加する。
4. Chat用・Responses用の最小Provider declarationを作る。
5. Chatのreasoning/tool callとResponsesのtool callを、利用者承認済みの最小実probeで確認する。
6. 確認済みmodelだけをfixed catalogへ追加する。
7. focused test、`v0:check`、`v0:fmt`、`v0:lint`、`v0:gate`を実施する。
8. 実provider acceptanceは対象・回数・保存先を提示し、別途明示承認を得て行う。

## 変更しなかったもの

今回の調査では、以下を変更していない。

- `v0/agent/provider/defaults/provider-defaults.json`
- `v0/agent/provider/*.ts`
- `~/.config/henji-harness/providers/*.json`
- `jsr.json`
- Provider declaration schema

## 結論

OpenCode Goは、既存のOpenAI-compatible Chat/Responses adapterを使える部分があるため、全体を新規実装する必要はない。しかし、OpenCode Goのcredential identityとsession/header契約をHenjiの内部provider seamへ接続する必要がある。

したがって、**Chat/Responsesのmodel catalogとendpointは外部JSONだけで足りるが、正式なOpenCode Go対応にはauth profile、credential file、session header、User-Agent、reasoning/tool-call検証の内部変更が必要**である。
