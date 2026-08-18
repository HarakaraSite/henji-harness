# Henji Harness: Model Adapter / Task Planner実装スパイク

## 位置づけ

これはv1実装でも正式なplanner inputでもない。`model-adapter`と`task-planner`の境界を発見するための、捨ててもよい実装スパイクである。

事前に完成条件を固定せず、観測結果からconceptの仮説、責務境界、次の判断を更新する。対象開発repositoryは`ai-dev:/home/masat.guest/src/henji-harness`とし、利用者はこのスパイク文書の`ai-dev`への配送を承認している。

## 検証する問い

- credentialをpluginへ見せずに`model-adapter`を成立させられるか。
- `endpointId + operationId`でprovider接続を十分に制約できるか。
- `task-planner`がproviderを知らず、host model call経由で計画を生成できるか。
- 別Deno processとJSONL Envelopeの複雑性は許容できるか。
- prompt作成、parse、Plan schema検証をplanner責務に保てるか。
- errorやmalformed model outputをどの層で観測すべきか。
- 将来のself-revision fixtureに必要なtraceは何か。
- process起動、memory、message処理の負荷は次段階を妨げるか。

## スパイク対象

### 簡易Runner

- plugin processの起動と停止
- JSONL codec/transport
- 最小Envelope routing
- host model callの仲介
- endpoint/operation broker
- secret注入
- timeout、message、output上限
- 最小trace
- 小さなCLI

簡易Runnerは正式Supervisorではない。将来のSupervisor責務を確定せず、plugin境界を観察するために必要な部分だけを持つ。

### `model-adapter`

- 共通text generation requestからprovider bodyへの変換
- provider responseから共通responseへの変換
- 一つのprovider
- 一つのoperation
- non-streaming
- tool callなし
- retryなし

### `task-planner`

- task、context、constraintsを受け取る
- hostへmodel generationを一度要求する
- model responseをPlan JSONへ変換する
- schema違反を観測可能なfailureとして返す
- provider、endpoint、credentialを知らない

## 実装順の意図

`model-adapter`を先に試し、その後`task-planner`を接続する。

plannerを先に作るとprovider接続がplanner内部へ入り、後からmodel boundaryを分離する可能性があるためである。これは詳細な実装順を承認するものではなく、スパイクの依存関係を示す。

## CLI

- 最初はDeno公式の`@std/cli`を利用候補とする。
- Cliffyなど本格的なCLI frameworkの比較は対象外とする。
- command数と正式UXは確定しない。
- CLI層とRunner責務を分ける。

## Reviewerが要求した事前境界

2026-08-18のconcept reviewでは条件付きGoとなり、実装前に次の3境界を最小限定義するよう指摘された。

### A. JSONL Envelope

論理protocolとtransport/codecを分ける。論理Envelopeは最低限、次を表現する。

- `v`
- `kind`: `request | response | event | cancel`
- `id`
- `replyTo`
- `parentId`
- `targetId`
- `method`またはevent `name`
- `payload`
- success/error

例:

```json
{"v":1,"kind":"request","id":"r1","method":"plugin.execute","payload":{"task":"調査計画を作る"}}
{"v":1,"kind":"request","id":"c1","parentId":"r1","method":"host.model.generate","payload":{"model":"default","messages":[]}}
{"v":1,"kind":"response","id":"s1","replyTo":"c1","ok":true,"payload":{"text":"..."}}
{"v":1,"kind":"response","id":"s2","replyTo":"r1","ok":true,"payload":{"status":"planned","steps":[]}}
```

スパイクでは次を維持する。

- 一run一model callでよい。
- stdoutはprotocol専用、stderrはlog専用とする。
- 1 messageのbyte上限を設ける。
- requestごとの最終responseは一度だけとする。
- codec/transport依存を一か所へ閉じ込める。
- stdoutとstderrを常時並行して読む。

streaming event、tool schema、subagent、binary、圧縮、別transportは確定しない。

### B. `endpointId + operationId` broker

adapterは任意URL、HTTP method、credential headerを指定しない。

```json
{
  "endpointId": "provider-api",
  "operationId": "text-generate",
  "body": {}
}
```

Runner所有registryが、許可されたorigin、method、pathへ解決する。redirect、timeout、request/response size、secret injection、response sanitizationはRunnerが担う。

### C. Deno plugin process制約

少なくとも次を観察対象として明示する。

- `--no-prompt`
- pluginへnetwork、run、FFI、env、writeを許可しない
- lockfile固定とcached/offline実行条件
- 固定cwdとcanonical entrypoint
- plugin由来の値から起動引数を組み立てない
- stdout/stderrを並行消費する
- timeout
- messageおよび総出力量上限
- protocol外stdoutをfailureにする
- 終了時にprocessを回収する

具体的なflagと数値はスパイクで確認し、ここでは確定しない。

## 責務の暫定境界

| 部分 | スパイクでの責務 |
|---|---|
| `task-planner` | prompt作成、model結果のparse、Plan schema検証 |
| `model-adapter` | 共通model requestとprovider形式の相互変換 |
| 簡易Runner | Envelope、resource limit、broker policy、secret、process |
| malformed model output | planner failureとして観測し、修復やretryを行わない |

## 残す観測

- 実際のprocess起動条件
- Envelopeのmessage例と例外
- host callの往復数
- pluginとRunner間で責務が曖昧になった箇所
- secretが存在した層
- brokerが拒否した要求
- malformed outputの伝播
- process起動時間と処理時間
- 参考memory使用量
- message sizeと総出力量
- stdout/stderrの挙動
- plugin ID、version、source/config/artifact hash
- provider、model、生成parameter
- redacted request/response
- traceから再実行fixtureを作れるか
- スパイクcodeのうち残す価値がある部分と捨てるべき部分

正式session/event systemは作らないが、後の比較やfixture化に使える最小traceを残す。

## 対象外

- 正式Supervisor
- 自己改訂Agent
- evaluator
- current/candidate比較
- promotionとrollback
- 正式`policy.toml`
- streaming
- tool call
- retry、schema repair
- filesystem、shell、tool実行
- durable session system
- concurrency、queue、process pool、long-lived process
- Deno Worker
- production security hardening
- v1 completion criteria
- 詳細な実装計画とtest case一覧

## 結果の解釈

スパイク後は、数値的な合否線を遡って作らず、観測に基づいて次から判断する。

- 現方向を継続する。
- Envelopeまたはbroker境界を修正して再スパイクする。
- Deno WorkerまたはWasmを別途検証する。
- DeepSeek HarnessまたはOpenCodeの拡張へ方向転換する。
- 構想を保留する。
- 独自harnessの検討を終了する。

次の問いは「v1を定義できたか」ではなく、「独自Supervisor/plugin境界を継続検討する価値があるか」である。
