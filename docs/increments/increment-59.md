# Increment 59 — Provider宣言seam（data-only）とOpenRouter Responsesのexternal化

ステータス: **部分実装（宣言coreとendpoint overrideまで。catalog overrideと新規provider選択はIncrement 60）**

基準commit: `d231addc`

計画日: 2026-09-17

対象候補: inbox E1（Provider設定の外部化）。A8はIncrement 58で実装済み。

## 利用者が必要とする動作

- provider設定（route identity、protocol、endpoint、auth profile参照、model catalog、既定model/effort）を
  data-only宣言として記述でき、Henji再ビルドなしにproviderを追加・変更できる（core protocol adapterを使う場合）。
- Hostがnon-secret auth profile catalogとcredential registryを所有し、宣言はprofile idだけを参照する。
  credential値とAuthorizationは宣言、Session、evidence、transcriptへ入らない。
- OpenRouter Responsesが最初のexternal宣言として動作し、既存Session/evidenceの
  `provider:'openrouter-responses'` identityを維持する。
- 既存のbuilt-in OpenRouter Chat CompletionsとOpenAI direct Responses、planner default、`web_search`(Sonar)を
  退行させない。

## 計画

### declaration schema v1（data-only）

```json
{
  "schemaVersion": 1,
  "providerId": "openrouter-responses",
  "protocol": "openai-responses",
  "endpoint": "https://openrouter.ai/api/v1",
  "authProfile": "openrouter-api-key",
  "modelCatalog": {
    "kind": "fixed",
    "entries": [
      { "modelId": "deepseek/deepseek-v4.1-flash", "defaultEffort": "high", "efforts": ["auto", "max", "high", "low"] }
    ]
  },
  "defaults": { "modelId": "deepseek/deepseek-v4.1-flash", "effort": "high" }
}
```

- `protocol`はcore adapter id（`openai-chat-completions`、`openai-responses`）。coreにないprotocolは対象外とし、
  将来のexecutable provider kindで扱う。
- 宣言は`$XDG_CONFIG_HOME/henji-harness/providers/*.json`に置く。ファイル名はidentity authorityにしない。
- `providerId`はroute identity。built-in provider（`openrouter`、`openai`）と衝突する宣言は起動/選択前に拒否する。

### Host authority

- auth profile catalogはbuilt-in profile（`openrouter-api-key`、`openai-api-key`）を持ち、宣言は既知profileだけを
  参照できる。未知profile参照はtyped failureとし、暗黙のcredential fallbackをしない。
- credential解決は既存のHost-owned credential resolverを使い、宣言にcredential値・path・Authorizationを持たせない。
- model catalogは`fixed` entryのみ対応する。動的取得、remote/JSR、署名は対象外。
- 宣言の読み込み失敗、重複providerId、未知protocol/authProfileは、provider選択とWorker generation作成の前に
  typed failureとして返す。

### selectionと合成

- `PROVIDERS`、`/provider`、`--root-provider`、model pickerがbuilt-in + 有効な宣言を列挙する。
- built-in providerと同じ`providerId`の宣言は、Human Gateで選んだ扱い（下記）に従う。
- protocol=`openai-responses`の宣言は共有Responses adapterへ、`openai-chat-completions`は現行Chat Completions
  adapterへ配線する。endpointとauthProfileは宣言から解決する。
- Sessionとprovider evidenceのidentityは`providerId`/`api`/`authProfile`/`modelId`/`effort`のままとし、宣言の
  endpointやcatalog sourceはidentityへ含めない。

### OpenRouter Responsesのexternal化

- 宣言`openrouter-responses.json`を最初のexternal宣言とする。`providerId`、`api`、`authProfile`はIncrement 58と
  同じ値にして、Session/evidence identityを維持する。
- built-inの`openrouter-responses`を残すか、完全に宣言へ移すかはHuman Gateで決める。

## 対象外

- executor provider kind（coreにないprotocolのexternal code）、動的model catalog、remote/JSR/署名
- built-in OpenRouter Chat Completionsの廃止（P3）、OpenAI directのexternal宣言化
- provider install/transport/rollback、workspace scope、credential登録UI（S2）
- planner defaultと`web_search`(Sonar)の宣言化
- Session migration、既存Sessionの自動変換
- 構想、architecture、roadmapの変更（採用方向は反映済み）

## Verification

- focused test: 宣言のload/validate（正常、重複providerId、未知protocol、未知authProfile、不正catalog）、
  provider列挙と`/provider`/`--root-provider`、宣言endpoint/authProfileでの実request shape、credential非記録。
- OpenRouter Responses宣言で、Increment 58と同じSession/evidence identityが維持されることを確認する。
- 既存回帰: built-in OpenRouter Chat Completions、OpenAI direct、planner、Sonar、Session resume、footer表示。
- 実provider probe（別途許可）: 宣言経由のOpenRouter Responsesで1 turn、canonical commit、evidence。
- 変更箇所のtype check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## 規模見積り

declaration schema/loader、auth profile catalog/credential registry、selection統合、OpenRouter Responses移行、
testまで。**3〜5開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. declaration schemaと保存場所（`$XDG_CONFIG_HOME/henji-harness/providers/*.json`）、fixed catalogのみの範囲。
2. built-in provider（`openrouter`、`openai`）と同じ`providerId`の宣言の扱い（拒否 / 上書き許可）。
3. OpenRouter Responsesの扱い:
   (a) built-inを完全にexternal宣言へ移行（宣言必須、無い場合は選択不可）か、
   (b) built-in既定を残し、同じproviderIdのexternal宣言でendpoint/catalogを上書き可能とするか。
4. 実provider probeを実行直前に別途許可する検証水準。

2026-09-17、利用者はこの計画を承認した。ただし実装前に、現行sourceではprovider catalogと選択がモジュール定数の
静的importであり、宣言によるprovider追加・catalog overrideはHost presentation、Worker bootstrap、catalogの
ランタイムregistry化を伴うため、Increment 59を「宣言core」と「動的選択の配線（Increment 60）」へ分割することに
利用者が同意した。

## 実装・検証結果（Increment 59）

- `v0/agent/provider/provider_declaration.ts`を追加した。data-onlyな`ProviderDeclarationV1`
  （`providerId`、`protocol`、`endpoint`、`authProfile`、fixed `modelCatalog`、`defaults`）、schema/内容validation、
  JSON parse、reserved provider id（`openrouter`/`openai`）の拒否、`builtinProviderDeclarations`、
  `resolveProviderRegistry`（新idの追加、`openrouter-responses`のoverride）、`loadProviderDeclarations`
  （`$XDG_CONFIG_HOME/henji-harness/providers/*.json`、重複across filesの拒否、欠落ディレクトリは空）を実装した。
  typed failureは`provider_declaration_not_found`/`invalid`/`duplicate`/`reserved`/`io_failure`。
- Hostは起動時に宣言をload/validateし、`providerDeclarations`としてWorker start commandへdata-onlyで渡す。
  `worker_physical_io.ts`は宣言の`endpoint`を使って`openrouter-responses`のbaseURLを上書きする。credential値は
  宣言、protocol、Session、evidenceへ含めない。
- focused testをIncrement 14のprovider testへ追加した。validation（正常、reserved、未知protocol/authProfile、
  default不整合）、loader（正常、across-file重複、欠落）、registry（override、新id、conflict）、および宣言
  endpoint overrideで`https://gateway.example/v1/responses`へrequestされることを確認した。increment-14の
  11 testはpassed。`agent_worker_foundation`（26）、increment-51（8）、increment-32（7）もpassed。
- 変更対象のtype check、format、lint、`git diff --check`は成功した。

## 後続incrementへ送る範囲

- 宣言`modelCatalog`/`defaults`の選択surfaceへの反映はIncrement 60で実装した（`docs/increments/increment-60.md`）。
- 宣言で**新しいprovider id**を追加し`PROVIDERS`・`/provider`・`--root-provider`・model pickerから選択可能に
  する変更は、永続`ModelSelection` identityの一般化、Chat Completions adapterのprovider-agnostic化、
  Session/evidence validationの一般化、およびarchitecture判断を伴うため、将来incrementへ送る。
- 実provider probe、authoritative `v0:gate`、commit、build、binary置換はIncrement 60の確定時に扱う。
