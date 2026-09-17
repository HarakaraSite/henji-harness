# Increment 62 — Responses replayのprovider identity一般化

ステータス: **完了（v0:gate前）**

基準commit: `e88a8026`

計画日: 2026-09-17

対象: 延期していたA方式。宣言providerでもResponsesのproviderState replayを維持し、誤送信を防ぐ。

## 利用者が必要とする動作

- OpenAI built-in（providerState replayあり）の既存挙動を退行させない。
- 宣言provider（Responses protocol）でも、同じprovider/modelの続きとしてreasoning item等をreplayする。
- provider/modelが変わった続きでは、そのproviderのitemを戻さずtranscriptから再構成する（私有itemの誤送信防止）。
- credential値とAuthorizationは引き続き保存しない。

## 参照実装から得た設計入力

- pi（`_refs/pi/.../openai-responses-shared.ts`）: assistant messageの`provider`/`api`/`model`でreplay可否を判定。
  同一provider/api/modelのみreplayし、model違いでは`function_call`のitem idを落とす。`output_item.done`の
  `encrypted_content`を優先し、`response.completed`で補完する。foreign providerはitem idを正規化する。
- zot（`_refs/zot/.../openai_responses.go`）: Responsesを別provider idとして扱い、baseURL/provider nameを
  パラメータ化する。

## 計画

### providerStateの一般化

- `core/contracts.ts`のResponses replay stateを、`OpenAIProviderState`（provider literal `'openai'`）から
  生成元identityを持つ形へ一般化する: `{ provider: string; replayItems; model?: string }`。
  `provider`は生成元providerId、`model?`は生成元modelId。
- 既存保存行の`{ provider: 'openai', replayItems }`はそのまま有効（providerをstringへ緩めるだけで、model/apiは
  任意）。dual-read専用codeは追加しない。
- `loop.ts`・`context_attribution.ts`・`sqlite_history_store.ts`・`session_record_codec.ts`・`provider_evidence.ts`の
  Responses state検証を、provider string／任意modelへ合わせる。SQLite schema（DDL/version）は変更しない。

### replayのスコープ

- `openai_responses_model.ts`の`requestInput`に現在の`providerId`と`modelId`を渡し、各assistant messageの
  providerStateについて`state.provider === providerId`かつ（`state.model`未設定または`state.model === modelId`）
  のときだけreplayItemsを戻す。それ以外はtranscriptから再構成する。
- これにより、turn間・Session再開・宣言編集でprovider/modelが変わっても、他providerのitemを送らない。
- Responses adapterの`ResponsesApiModelConfig.stateProvider`を`string | null`とし、OpenAI directは`'openai'`、
  宣言providerは自身のproviderId、statelessなOpenRouter Responsesは`null`のままとする。生成時に`model`も記録する。

### encrypted_contentの補完

- `response.output_item.done`のreasoning itemを取得し、`response.completed`のitemへid一致で`encrypted_content`を
  補完してからreplayItemsを作る。done側を優先し、doneに無ければcompletedで埋める（piと同じ）。

### 対象外

- `openai`/`openrouter` built-in定義の削除、Chat Completions adapterのprovider-agnostic化
- providerState以外のdurable schema変更、SQLite migration/backfill
- provider/modelをまたぐitemの正規化replay（跨ぎは再構成する）

## Verification

- focused test:
  - 同一provider/modelのturnでreasoning itemがreplayされ、`output_item.done`由来の`encrypted_content`が保持される。
  - provider違い・model違いでreplayItemsが送られずtranscript再構成になる。
  - 宣言providerが自身のproviderStateを生成・replayする。
  - 既存`{provider:'openai'}`形状の読み取りとreplayが従来どおり。
  - 既存OpenAI回帰（Increment 14のreplay test）と、OpenRouter Responses stateless挙動。
- 実provider probe（別途許可）: OpenAI directでreasoning＋tool loopを跨ぐreplay、宣言providerで同様。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 規模見積り

providerState一般化、スコープ判定、encrypted_content補完、検証更新、testで**2〜4開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. Responses replay stateを`{ provider: string; replayItems; model? }`へ一般化し、既存`{provider:'openai'}`を
   そのまま有効とする扱い（SQLite schema変更なし）。
2. replayは生成元provider＋model一致時のみとし、不一致はtranscript再構成にする扱い。
3. `output_item.done`を優先するencrypted_content補完。
4. 実provider probeを実行直前に別途許可する検証水準。

2026-09-17、利用者はこの計画を承認し、実装を指示した。

## 実装・検証結果

- `core/contracts.ts`のResponses replay stateを`ResponsesProviderState { provider: string; replayItems; model? }`へ
  一般化した。既存`{provider:'openai', replayItems}`はそのまま有効で、dual-read専用codeは追加していない。
- `openai_responses_model.ts`の`requestInput`へ現在の`providerId`/`modelId`を渡し、`replayItemsFor`が
  `state.provider === providerId`かつ（`state.model`未設定または一致）のときだけreplayする。不一致はtranscript
  再構成。生成stateへ`model`を記録し、`DeclaredResponsesModel`は自身のproviderIdをstate providerとする。
  `OpenRouterResponsesModel`はnull（stateless）のまま。
- `response.output_item.done`のreasoning itemから`encrypted_content`を収集し、`response.completed`のitemへ
  id一致で補完してからreplayItemsを作る（done優先）。
- `loop.ts`・`context_attribution.ts`・`sqlite_history_store.ts`・`session_record_codec.ts`・
  `provider_evidence.ts`・`openrouter_request.ts`のResponses state検証をprovider string／任意modelへ合わせた。
- focused test: increment-14へ、provider/model一致時のreplay、別provider・別modelでの非replay、done由来
  `encrypted_content`の補完を追加し、15 passed。provider_stream_compatibility（20）、increment-15（6）、
  TUI系（86）、agent_worker_foundation（26）、increment-51（8）もpassed。type check/format/lint/
  `git diff --check`成功。
- 利用者の許可を得て実provider probeを実行した。isolated XDG configでbuilt-in `openai`（`--root-provider openai`）
  と宣言provider `openai-alt`のそれぞれで`note.txt`を読むtaskを一turn実行し、`tool> read note.txt ✓`の後
  `assistant>`が完成した。SQLiteのprovider observation request bodyをreadbackすると、**2番目のmodel requestに
  provider item id（`rs_`/`fc_`/`msg_`）が含まれ**、replayされたことを確認した（1番目は含まない）。canonical
  commitと`model_selection`（`openai`/`gpt-5.6-sol`、`openai-alt`/`gpt-5.6-terra`）も確認した。
- authoritative `v0:gate`は2026-09-17に実行し全check/fmt/lint/testが成功した。
- 利用者の明示指示により実装をcommitし、clean commitからbuildして`dist/henji`と`~/.local/bin/henji`を置換する
  （配置記録は下記）。tag、release、publishは行わない。
