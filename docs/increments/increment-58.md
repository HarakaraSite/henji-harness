# Increment 58 — OpenRouter Responses API経路（built-in）

ステータス: **完了**

基準commit: `26a65b04`

計画日: 2026-09-17

対象候補: inbox A8（OpenRouter Responses API経路）。provider外部化seamはIncrement 59で扱う。

## 利用者が必要とする動作

- 人間がroot providerとしてOpenRouter Responses API経路を選択し、通常のturnを完了できる。
- 経路はOpenRouterの同じcredential（`openrouter-api-key`）を使い、endpointは
  `https://openrouter.ai/api/v1/responses`とする。
- 既存のOpenRouter Chat Completions（既定）、OpenAI direct Responses、planner default、`web_search`
  (Sonar)を退行させない。
- 使用したprovider、api surface、model、effortをSessionとevidenceからreadbackできる。
- credential値とAuthorizationはSelection、Session、evidence、transcriptへ含めない。

## 確認済みの外部契約（2026-09-17）

- endpoint `POST https://openrouter.ai/api/v1/responses`、`Authorization: Bearer <OpenRouter API key>`。
- OpenAI Responses互換（OpenResponses形式）。`input`は文字列またはitem配列、`model`必須、streaming、
  function tool calling（parallel含む）、reasoning（`reasoning.effort`、encrypted content）、usage。
- **stateless**: `store`と`previous_response_id`は使わない。OpenRouterはstateful指定を400で拒否する。
  Henjiの既存OpenAI Responses adapterも`store: false`で会話履歴を都度`input`へ入れるため整合する。
- OpenRouter固有: `session_id`（sticky routing/observability、任意）、annotations、canonical error envelope、
  routing metadataのopt-in header。
- 公式: [`api_reference/responses/overview`](https://openrouter.ai/docs/api_reference/responses/overview)。

## 計画

### route identityと選択

- `ModelSelection`へ`OpenRouterResponsesModelSelection`
  `{ provider: 'openrouter', api: 'openrouter-responses', authProfile: 'openrouter-api-key', modelId, effort }`
  を追加する。`isStoredModelSelection`と`sameModelSelection`を拡張し、`modelRouteProfileId`は既存式のまま
  apiを含める。
- 選択surfaceの`ProviderId`へ`'openrouter-responses'`を追加し、catalog関数と`defaultModelSelectionFor`が
  OpenRouter catalogからapi=`openrouter-responses`のselectionを返すようにする。`/provider`と
  `--root-provider openrouter-responses`で選択できる。
- footerとstartup orientationのprovider表示は`openrouter-responses`を区別して示す。既定は現行どおり
  `openrouter`（Chat Completions）のまま変更しない。
- planner defaultと`web_search`(Sonar)は現行Chat Completions routeのまま変更しない。

### transport

- 既存の`openai_responses_model.ts`を、baseURLとprovider identityを差し替え可能な共有Responses transportへ
  一般化し、OpenAI directとOpenRouter Responsesの両方から使う。OpenRouterでSDK互換が実provider応答で
  成立しない場合だけ、OpenRouter固有の薄い差分（error envelope、annotations、routing metadata）を加える。
- `worker_physical_io.ts`の`createModel`は`selection.api`でadapterを選び、OpenRouter Responsesには
  `openrouter-responses` transportと`openrouter-api-key` resolverを割り当てる。`store`/`previous_response_id`
  を送らない。
- request単位timeout、request count、raw response、SSE/parser transition、provider/API/model/auth-profile
  evidenceは既存OpenAI Responses経路と同じ仕組みで保持する。

### Sessionとattribution

- Sessionは`provider:'openrouter'`,`api:'openrouter-responses'`を保存できる。旧binaryは新api値を解釈しない
  ため、forward-onlyとしmigration/dual-read/fallbackを追加しない。
- execution artifactとprovider evidenceのprovider/API attributionは`openrouter-responses`を区別して保持する。

## 対象外

- Provider declaration seam、data-only外部宣言、credential registry（Increment 59）
- built-in OpenRouter Chat Completionsの廃止、OpenAI directの外部宣言化、executable provider kind
- ChatGPT subscription route（A1）
- planner default、`web_search`(Sonar)、context compactionのResponses化
- 動的model catalog取得、`session_id`/routing metadataのopt-in、Server-side web search toolの採用
- Session migration、既存Sessionの自動変換
- 構想、architecture、roadmapの変更（採用方向は反映済み）

## Verification

- fake transportのfocused test: request shape（statelessで`store`/`previous_response_id`を送らない）、
  SSE streaming、text final、function tool call/result continuation、reasoning、usage、
  error envelope、evidence/attribution。
- 既存回帰: OpenRouter Chat Completions既定turn、OpenAI direct、planner delegation、Sonar検索、
  provider deadline、Session list/resume、footer/startup provider表示。
- 実provider probe（実行前に利用者の許可を確認）: OpenRouter Responsesでtext、streaming、tool call/result
  continuation、reasoning、evidence readback、canonical commitを一turnで確認する。
- compiled standalone buildでisolated XDGから`--root-provider openrouter-responses`起動を確認する。
- 変更箇所のtype check、format、lint、`git diff --check`。実providerを使う確認は別途許可を得て行う。

## 規模見積り

route identity追加、選択surface、共有Responses transport化、adapter配線、Session/attribution、test更新まで。
**3〜5開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. route identityと選択名`openrouter-responses`、既定をOpenRouter Chat Completionsのまま据え置く扱い。
2. planner defaultと`web_search`(Sonar)をResponses化しない対象範囲。
3. 既存OpenAI Responses adapterを共有transportへ一般化する方針（実contract不一致時のみOpenRouter差分を追加）。
4. Sessionはforward-onlyでmigration/fallbackを追加しない扱い。
5. 実provider probeを実行直前に別途許可する検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- route identityは`{ provider: 'openrouter-responses', api: 'openrouter-responses', authProfile:
  'openrouter-api-key', modelId, effort }`とした。multi-provider設計の「初期selectionは名前を実装時に調整できる」
  に従い、OpenRouter Responsesを独立したroute identityとして表す。`ModelSelection`、`isStoredModelSelection`、
  `ProviderId`、`PROVIDERS`、catalogの`selectModelFor`/`defaultModelSelectionFor`を拡張した。
- `openai_responses_model.ts`を共有`ResponsesApiModel`へ一般化し、`OpenAIResponsesModel`（baseURL
  `https://api.openai.com/v1`、`store:false`、providerState replay）と`OpenRouterResponsesModel`（baseURL
  `https://openrouter.ai/api/v1`、statelessで`store`を送らずproviderStateを出さない）に分けた。
  `worker_physical_io.ts`は`provider: 'openrouter-responses'`を新adapterへ配線した。
- provider evidenceの`provider`/`api` unionへ`openrouter-responses`を追加し、request metadataへ
  provider/api/authProfile/model/effortを記録する。credential値とAuthorizationは記録しない。
- selection surface（`/provider`、`--root-provider openrouter-responses`）、presentation/startupのprovider表示、
  footerのidentityを`openrouter-responses`に対応させた。既定はOpenRouter Chat Completionsのまま、planner
  defaultと`web_search`(Sonar)も現行Chat Completionsのまま変更していない。
- focused test: `increment_14_multi_provider_test.ts`へOpenRouter Responses adapter test（URL、Bearer認証、
  `store`非送信、providerStateなし、evidence metadata、credential非記録）と`--root-provider
  openrouter-responses`の受理を追加し、9 passed。`increment_15_provider_switching_test.ts`のprovider pickerを
  3 providerへ更新し6 passed。`increment_12`（3）、`increment_16`（4）、`provider_stream_compatibility`（20）、
  TUI系7 file（86）もpassed。
- 変更対象のtype check（`v0:check`相当）は成功した。
- 利用者の許可を得て実provider probeを実行した。`dist/henji --root-provider openrouter-responses`を
  `/tmp/opencode/inc58-probe`で起動し、`note.txt`を読むtaskを一turn実行した。TUI表示で`tool> read note.txt ✓`
  の後、`assistant>`に`HENJI-OPENROUTER-RESPONSES-PROBE`がstreamingで完成した。
- canonical commitとattributionをworkspaceのSQLiteからreadbackした。`execution_outcomes.final_text`は
  `HENJI-OPENROUTER-RESPONSES-PROBE`、`canonical_turns`/`executions`/`model_requests`のmodel selectionは
  `provider:'openrouter-responses'`、`api:'openrouter-responses'`、`authProfile:'openrouter-api-key'`だった。
  provider evidenceのrequest observationはendpoint `https://openrouter.ai/api/v1/responses`を保持し、
  credential値とAuthorizationを含まなかった。
- authoritative `v0:gate`は2026-09-17に実行し、初回は`v0/agent/README.md`の整形のみで停止した。整形修正後の
  再実行で全check/fmt/lint/testが成功した（再実行の理由は整形修正）。
- 利用者の明示指示により、実装をcommit `4d21a9ea`へ確定した。そのclean commitからbuild
  `a540a567e3d42d6f9756654a80b32f2275ae92ea3305106428756a221499c637`を生成し、`dist/henji`と
  `~/.local/bin/henji`を同一artifactへatomic置換した。両方のSHA-256は
  `2f80559e6ea7b17311852ccd634c99a4039e0e09ba7be86eb99648d314110c70`で、導入版はsource
  `4d21a9ea0e08acbe066f72ed0b80fc5d363ac3b8`、`sourceDirty=false`を返した。tag、release、publishは行っていない。
