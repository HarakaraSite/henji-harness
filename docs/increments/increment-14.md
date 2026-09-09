# 通常利用 increment 14 — generic provider routeとOpenAI direct API

ステータス: **実装・offline検証・第三者review完了。OpenAI実provider確認待ち**

対応architecture:
[`docs/architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)

## 利用者が必要とする動作

- 現行OpenRouter rootを既定のまま維持しつつ、起動時にOpenAI direct APIのrootを選べる。
- OpenAI rootがHenji tool loopを実行し、OpenRouter plannerとOpenRouter Sonar
  `web_search`を同じturnで利用できる。
- root、planner、Web searchはそれぞれのprovider routeとcredential
  sourceを使い、親のcredentialを暗黙継承しない。
- providerにかかわらずSessionを保存・一覧・resumeでき、provider/model/effortとturn
  attributionを復元できる。
- request、raw response bytes、SSE/provider event、parser transition、runtime outcome、request
  origin、provider、model、 auth profile
  identityを後からreadbackできる。credential値とAuthorizationは保存しない。

## 確認済みの根拠

- OpenAI Responses APIとofficial TypeScript SDKはstreaming responseとfunction toolを扱える。
- official SDKはcustom `fetch`、request timeout、`maxRetries`を設定できる。Increment
  14では既存の一request 120秒deadlineとphysical request countを維持するため通常retryを無効にする。
- 現行sourceはOpenRouter selection、provider state、Session v3、Worker
  protocol、manifest、presentation、 credential
  source、context計測へ直接結合している。衝突一覧はarchitecture正本に記録済みである。
- 2026-09-09時点の実行環境にはOpenRouter credential fileだけがあり、OpenAI credential
  fileと対象環境変数はない。
  したがってOpenAI実provider確認はcredentialが用意されるまで実行できない。offlineのproduction構成経路は実装・確認する。

## 採用する入口と初期catalog

- production TUIへ`--root-provider openrouter|openai`を追加する。未指定は`openrouter`である。
- `openai`指定時はIncrement 14の固定direct catalog
  defaultを使う。同一Session内の`/provider`はIncrement 15で実装する。
- OpenAI credential
  sourceは`/home/masat.guest/.config/henji-harness/openai-api-key`とする。既存OpenRouter fileと
  同じくWorkerがrequest時に読む。値はSession、protocol、evidence、logへ出さない。
- official SDKはJSRの`@openai/openai`をexact versionで固定し、lockfileへ解決結果を記録する。

## 実装slice

1. provider-neutral `ModelSelection`、provider/API/auth profile
   identity、provider別catalog/validatorを追加する。 OpenRouterのcurated listとdefaultを維持する。
2. Session schema v4、Worker protocol、manifest、execution artifact、presentationをgeneric
   selectionへ移す。 v1〜v3 SessionはOpenRouter
   routeとしてmigrationし、永続recordの構造検証を現curated catalog所属から分離する。
3. Worker-local provider registryとauth-profile別credential
   resolverを導入する。root、planner、Sonarを独立routeへbindし、 production launcherへ確認済みOpenAI
   endpointとcredential fileだけを追加する。
4. provider stateをtagged unionにし、OpenAI Responses output/reasoning/function-call
   continuationを保持する。 request構築時はactive adapterと同じprovider stateだけを使う。context
   admission/compactionはactive adapterの request measurementへ切り替える。
5. provider evidenceのrequest metadataへorigin、provider、API、model、auth
   profile、protocolを加える。 OpenAI SDKへcredential-free custom
   `fetch`を渡し、SDKが読むstreamと同じraw bytesを記録する。
6. official SDKを使うOpenAI Responses adapterを追加する。通常retryは無効、Henji
   deadline/AbortSignalを適用し、 text final、function call、tool result
   continuationを既存`ModelResult`へ写像する。
7. startup、Session、mixed-provider、evidenceに対応するfocused testを実施し、type
   check、format、lint、差分reviewを行う。

## 対象外

- 同一Session中の`/provider`切替UI（Increment 15）
- built-in instruction component再設計（Increment 16）
- Codex/ChatGPT subscription認証（Increment 17）
- OpenAI built-in Web search、OpenRouter SDK移行、vision
- planner/subagent provider選択UI、複数account picker、自動retry/fallback

## Human Gate

2026-09-09、利用者がIncrement 14〜17の横断設計を承認し、Increment
14の実装・test・reviewまで進めることを承認した。

## 実装結果

- provider/API/auth profileを含むgeneric `ModelSelection`とprovider別catalogを導入し、既存OpenRouter
  curated list/defaultを維持した。
- production TUIに`--root-provider openrouter|openai`を追加した。OpenAI routeはofficial
  `@openai/openai` 7.2.0 Responses SDKを使い、text、Henji-owned function tool loop、reasoning/output item
  replay、120秒deadline、retry無効化、provider固有wire計測へ対応した。
- OpenAI root、OpenRouter planner、OpenRouter Sonar `web_search`はそれぞれのauth resolverを使う。
  SDKのambient custom headerにAuthorizationが含まれても、選択routeで解決したOpenAI credentialを最終値とする。
- Session v4、Worker protocol、execution artifact、presentationをgeneric selectionへ移行した。v1〜v3
  SessionをOpenRouter routeとして読み、次のcommitでv4へupgradeする。`/sessions`はprovider/model/effortを表示する。
- evidenceにrequest origin、provider、API、model、auth profile、protocolを追加し、OpenAIでもSDKが送るbody、raw
  response、SSE event、parser transitionを保存する。credential値とAuthorizationはevidence interfaceへ渡さない。
- SDKと依存物はrepositoryの`vendor/`へ固定し、production launcherとoffline testをremote accessなしで起動できるようにした。

## 検証とreview

- Increment 14 focused test: 10 passed。SDK request/response evidence、AgentSessionを通るtext finalとfunction-call
  continuation、OpenAI rootとOpenRouter planner/Sonarのauth分離、ambient header回帰、Session v4とv3 migration、Host /
  Worker persistence/resume、launcher権限を確認した。
- Worker foundation: 40 passed。関連TUI/presentation: 26 passed。type check、lint、`git diff --check`も通過した。
- 第三者reviewは、初回にcore loopのOpenAI provider state拒否とSDK ambient Authorization上書きを検出した。
  修正後の限定再reviewで両finding解消、`/sessions` provider表示、新規Blocker/P1なしを確認した。
- repository authoritative `v0:gate`はtype check、format、lintと全114 testsを通過した。初回はAgent READMEの
  format、次は旧Increment 7 taskの`--no-remote`が新しいvendored SDK module graphを拒否して停止したため、各原因を
  focused修正・確認してから再実行した。
- 実行環境にOpenAI credential fileまたは環境credentialが存在しないため、実OpenAI APIへのproduction callは未実施である。
  credentialを用意した時点で、production TUIのtext final、tool continuation、plannerまたは`web_search`併用とevidence
  readbackを人間が確認する。
