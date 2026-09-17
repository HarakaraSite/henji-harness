# Increment 61 — provider identityの一般化と新しいprovider id（Responses先行）

ステータス: **完了（v0:gate前）**

基準commit: `e1814528`

計画日: 2026-09-17

対象: 延期していた(b)。宣言でbuilt-in（`openai`等）とは別の新しいprovider idを追加し、選択・実行できるようにする。

## 利用者が必要とする動作

- 宣言で新しい`providerId`を追加でき、built-in `openai`とは別にexternalなOpenAI providerを併設できる。
- 追加providerは`/provider`・`--root-provider`・model pickerに現れ、選択すると宣言`endpoint`・`authProfile`・
  `modelCatalog`・`defaults`でturnを実行する。
- built-in `openai`/`openrouter`/`openrouter-responses`は退行しない。
- Session/evidenceは`providerId`/`protocol`/`authProfile`/`modelId`/`effort`でattributionし、credential値を
  含まない。
- 最初の対象protocolは`openai-responses`に限定する（`openai-chat-completions`の新idは後続）。

## 計画

- `ModelSelection`に宣言provider用variant（`provider: <declared id>`, `api: 'openai-responses'`, `authProfile`,
  `modelId`, `effort`）を追加し、`isStoredModelSelection`を構造検証（provider id形式、api、authProfile、
  modelId、effort）へ一般化する。既存3 identityは不変。
- `model_catalog.ts`の選択APIを有効宣言registryからprovider集合とcatalog/defaultsを解決するようにする。
- `openai_responses_model.ts`に宣言provider用Responses adapter（endpoint、provider label、stateless、
  providerStateなし）を追加し、`worker_physical_io.ts`が`api: 'openai-responses'`の宣言providerを
  endpoint/authProfileで解決して配線する。
- `tui_cli.ts`は起動時に宣言をloadした後、`--root-provider`がbuilt-in＋宣言idのいずれかであることを検証する。
- provider evidenceの`provider`は宣言idを許容する。
- architecture（`multi-provider-routing-and-auth.md`、`henji-host-agent-worker.md`）とroadmapは本increment前に更新済み。

## 対象外

- `openai-chat-completions`の新provider id（Chat Completions adapterのprovider-agnostic化）
- 動的model catalog取得、executable provider kind、credential登録UI（S2）
- built-in Completions廃止、planner default/Sonarの宣言化
- Session migration

## Verification

- focused test: 宣言providerの`defaultModelSelectionFor`/`selectModelFor`/`searchModelsFor`/`isModelSelection`、
  `worker_physical_io`が宣言endpointへrequestすること、provider evidenceが宣言idを記録しcredentialを含まないこと、
  既存3 providerの回帰。
- Session/evidenceの構造検証が宣言selectionを受け付けること。
- 実provider probe（別途許可）: 外部OpenAI provider宣言で1 turn。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 実装・検証結果

- `ModelSelection`に宣言provider variant（`provider: string`, `api: 'openai-responses'`, `authProfile`,
  `modelId`, `effort`）を追加し、`isStoredModelSelection`を構造検証へ一般化した。`ProviderId`はstring、
  `BUILTIN_PROVIDER_IDS`を追加した。既存3 identityの意味は不変。
- `model_catalog.ts`は`providerIdsForSelection()`でbuilt-in＋宣言Responses idを列挙し、
  `defaultModelSelectionFor`/`selectModelFor`/`searchModelsFor`/`modelCatalogEntryFor`/`isModelSelection`が宣言
  catalog/defaultsを解決する。`controller_overlay.ts`は動的provider一覧を使う。
- `openai_responses_model.ts`へ`DeclaredResponsesModel`を追加し、`worker_physical_io.ts`が宣言の`endpoint`・
  `authProfile`で配線する。`provider_evidence`のproviderは宣言idを許容する。
- `tui_cli.ts`は宣言をloadした後に`--root-provider`をbuilt-in＋宣言idから検証する。startup/provider表示は
  宣言idをそのまま示す。
- focused test: increment-14へ宣言provider（`openai-alt`, endpoint, authProfile, catalog/defaults）の
  selection・catalog・isModelSelection・request URL/Authorization・evidence provider・credential非記録のtestを
  追加し、13 passed。increment-15（6）、TUI系（86）もpassed。type check/format/lint/`git diff --check`成功。
- 実機: isolated XDG configに`providers/openai-alt.json`（OpenAI Responses、catalog `gpt-5.6-terra`、defaults
  medium）を置き、compiled standaloneを`--root-provider openai-alt`で起動。footerが
  `provider:openai-alt model:gpt-5.6-terra medium`を示すことを確認した（provider requestは行っていない）。
- authoritative `v0:gate`は2026-09-17に実行し全check/fmt/lint/testが成功した。
- 利用者の明示指示により、実装をcommit `6a34bf07`へ確定した。そのclean commitからbuild
  `ee42b5f85bb4f09077b936b437581030d5329402d4ee0087ef1904dfc9508aea`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換した。両方のSHA-256は
  `e8773c10bccf103397cd858c4aa25691f848441eee1597457e9a6f7c1bc062af`で、導入版はsource
  `6a34bf075d5f8a562d94d018779321058aeb9f71`、`sourceDirty=false`を返した。tag、release、publishは行っていない。
- 未実施: openai-altでの実provider probe（`openai-api-key`使用の外部request）。
