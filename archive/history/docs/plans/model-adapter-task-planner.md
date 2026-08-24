# Model Adapter / Task Planner 実装スパイク計画

> **STOPPED / SUPERSEDED:** この計画は、反証された旧source-direct方式の歴史的記録である。
> 未完了工程とprovider smokeを実行してはならない。現在のscopeは
> [`candidate-admission.md`](../spikes/candidate-admission.md)のSpike 0計画だけである。

## 位置づけと停止点

この計画は、[承認済みスパイクbrief](../spikes/model-adapter-task-planner.md)を実行可能なincrementへ分解する。v1、正式Supervisor、汎用plugin
framework、自己改訂、tool実行、promotionは対象外である。

この文書の作成時点ではprovider、model、endpoint/operation、secret参照、各resource limit、実provider
smoke testの可否は未決である。これらをHuman Gate
2で明示承認するまで、repositoryの実装・依存導入・test実行・credential参照・外部provider
callを行わない。

## 暫定アーキテクチャ

1. CLIは一回のtaskを簡易Runnerへ渡す。
2. Runnerは独立した短命Deno processとして`model-adapter`を起動し、固定entrypoint/cwdとJSONL
   transportで通信する。
3. Runnerは同じ境界で`task-planner`を起動する。plannerはprovider非依存の`host.model.generate`を一度だけ要求する。
4. Runnerはadapterへ共通model
   requestを送る。adapterは`endpointId + operationId + body`だけを指定した`host.broker.call`を一度要求する。
5. Runner-owned brokerだけが静的registry、credential、endpoint、HTTP
   policyを適用しproviderへ接続する。
6. adapterはprovider responseを共通responseへ変換し、plannerはtextをPlan
   JSONとしてparse・schema検証して一度だけ最終responseを返す。
7. Runnerはtimeout、message/output上限、cancel/kill/wait、redacted traceをprocess境界で扱う。

pluginにはnetwork、run、FFI、env、writeを許可しない。stdoutはJSONL
protocol専用、diagnosticはstderr専用とする。pluginはcredential、endpoint URL、任意HTTP
method/header、Runner環境変数を得ない。

## 実装上の仮定（Gate 2で再確認）

- TypeScriptとDeno標準機能を主とし、外部依存は最小限にする。CLI
  parserが必要な場合だけ固定versionのDeno公式`@std/cli`を使う。
- pluginはrunごとに起動・終了し、poolやlong-lived processを作らない。
- protocol/domainは手書きruntime validationを持つ。test providerはlocalhost mock
  serverだが、pluginにnetwork permissionは与えない。
- protocol IDはRunnerが生成するopaque stringとする。traceは一run単位のredacted JSON/JSONL
  artifactとし、durable storeは作らない。
- limit値は一か所に集約し、初期値はGate 2で承認されたものだけをdefaultにする。

## 予定ファイルと責務

| 範囲            | 予定ファイル                                                                               | 責務                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 基盤            | `deno.json`、`deno.lock`、`.gitignore`、`README.md`                                        | task、固定依存、local artifact除外、起動/安全境界の説明                                  |
| Protocol/domain | `src/protocol/envelope.ts`、`jsonl_codec.ts`、`src/domain/{model,plan,errors}.ts`          | Envelope v1、JSONL byte制限、共通model/Plan schema、structured error                     |
| Runner          | `src/runner/{plugin_process,router,model_host,run,limits,trace,plugin_identity,config}.ts` | process lifecycle、correlation、host call、limit、trace、plugin identity、Runner専用設定 |
| Broker          | `src/broker/{types,registry,http_broker}.ts`                                               | 静的allowlist、secret injection、HTTP timeout/size/redirect、sanitization                |
| Adapter         | `plugins/model-adapter/{manifest,main,provider_codec}.ts`                                  | 一provider・一operationのcommon/provider変換。endpoint/credentialは保持しない            |
| Planner         | `plugins/task-planner/{manifest,main,prompt,plan_parser}.ts`                               | prompt、一回のhost call、Plan parse/schema validation。providerを知らない                |
| CLI             | `src/cli/main.ts`                                                                          | 入力、Runner invocation、Plan/structured failure、safe trace output                      |
| Test            | `tests/{protocol,domain,runner,broker,plugins,integration}/` と `tests/fixtures/`          | 下記のunit/process/HTTP/E2E fixture                                                      |
| 結果            | `docs/spikes/model-adapter-task-planner-results.md`                                        | acceptance packageと観測                                                                 |

モジュールは責務を保つ範囲で小さく統合してよい。ただしcodec、process boundary、broker
policy、provider codec、planner parserを同一moduleへ混在させない。

## 実装increment

### 1. Deno基盤と共通contract

`deno.json`/lockfile方針とdirectory構造を追加し、Envelope v1、common text-generation
request/response、Plan schema、error分類、JSONL codecをI/Oから分離して定義する。

検証: valid encode/decode round trip、invalid JSON、未知version、kindごとの必須field不足、oversized
line、valid/invalid Planをunit testする。repository定義のfmt/lint/type checkと該当testを実行する。

### 2. Process isolationとtransport

固定entrypoint/cwd/引数でpluginをDeno subprocessとして起動する。`--no-prompt`、stdin/stdout
JSONL、並行stderr drain、timeout、message/総output上限、cancel/kill/wait
cleanupを実装する。protocol外stdout、duplicate final response、partial lineはfailureにする。

検証: normal/malformed stdout/early exit/hang/duplicate response/stdout+stderr
flood/limit超過をfixtureで確認する。network/env/run/FFI/write permission
probeが拒否され、plugin由来値がspawn引数へ入らないことを確認する。timeout/failure後にchild
processが残らないことを確認する。

### 3. Broker boundary

static
registryの一`endpointId + operationId`を承認済みorigin/method/pathへ解決し、Runner内部だけでcredential
injection、redirect policy、HTTP timeout、request/response limit、response/error
sanitizationを行う。

検証: localhost mockへallowlisted operationだけが到達し、未知IDとURL/method/path/header
overrideを拒否する。dummy secretはbrokerだけで使え、plugin
environment/payload/stdout/stderr/trace/CLI errorに現れないことを確認する。

### 4. `model-adapter`

Gate 2で決める一provider・一operationに限定したcodecを追加する。adapterはcommon model
requestを受け、broker callを一度行い、common
responseを返す。URL、credential、任意HTTP設定を保持しない。

検証: common request→provider body、mock response→common response、provider error/missing
field/malformed/oversized body、approved ID以外を指定できないことを確認する。

停止条件:
必要機能を`endpointId + operationId + body`で表現できず、adapterがURL、credential、任意header等を要求する場合はconcept
assumption failureとしてDiscoveryへ戻る。

### 5. `task-planner`

task/context/constraintsからpromptを作り、`host.model.generate`を一度だけ呼び、response textをPlan
JSONとしてparse・schema検証する。malformed outputはrepair/retryせずplanner failureにする。

検証: prompt内容、call count、valid Plan、invalid JSON、schema-invalid JSON、empty
text、provider情報がplannerへ渡らないことを確認する。malformed outputがCLI/traceまでplanner
failureとして伝播することを確認する。

### 6. two-plugin E2EとCLI

CLIからplanner、adapter、broker、mock
providerを通る一runを成立させる。正常Planとplanner/provider/broker/protocol/timeout/limit/stderr
floodの失敗を責任層別に表示し、必ずprocessを回収する。

検証: planner一model call、adapter一broker
call、二pluginが別process、Envelope/correlation/cleanup/secret所在がredacted
traceから説明できることを確認する。

### 7. 選択providerの限定smoke test（失効・実行禁止）

Gate 2で外部通信・費用・credential利用が明示承認された場合だけ、non-streaming text
generationを一回実行する。通常suiteから分離し、credential未設定で暗黙skip成功にしない。実施しない場合は理由をacceptance
packageへ残す。

### 8. 観測整理とacceptance package

結果文書に、正本の検証する問いごとの直接証拠、実行command、未実施理由、review結果、deviation分類、残存risk、retain/discard候補と次の判断を記録する。合否線は事後に捏造しない。

## Test strategy

- Unit: Envelope/Plan runtime validation、JSONL byte counting、router
  correlationと一最終response、registry、redaction、error分類、provider codec、planner parser。
- Process integration: permission拒否、protocol外stdout、invalid/oversized message、total
  output超過、stdout/stderr backpressure、timeout、early exit、duplicate response、cleanup。
- HTTP integration: Runnerのみがlocalhost
  mockを呼び、allowlist、registry拒否、redirect、timeout、request/response limit、secret
  injection/redaction、provider error sanitizationを確認する。
- E2E: CLIから二pluginとmock providerを通し、正常Planと代表的な層別failureを確認する。
- 観測: process/model/run duration、可能なら測定方法付き参考memory、message/stdout/stderr
  byte数、Envelope数、plugin ID/version/source/config/artifact hash、broker拒否、malformed
  output伝播、secret所在、fixtureに不足するtrace情報を残す。

## Security / compatibility

- plugin permissionはdeny-by-defaultで、Deno起動に必要なread条件だけを実測して最小化する。
- Runnerのnet/env/run権限とplugin権限を分離して文書化する。
- static registryはplugin inputからorigin/method/path/headerを組み立てない。redirect、各size
  limit、timeoutを強制する。
- Envelope version不一致は明示failureとし暗黙変換しない。trace/error/test snapshotはredactする。
- 既存runtime API・永続dataはないためmigration/compatibility保証は不要。rollbackは該当spike
  codeの除去であり、正式interfaceへ昇格しない。

## Acceptance evidence

| 仮説                         | 直接証拠                                                      |
| ---------------------------- | ------------------------------------------------------------- |
| credentialをpluginへ見せない | permission probe、dummy-secret broker test、redacted trace    |
| broker制約                   | allowlist成功、URL/method/header override拒否、実provider観測 |
| plannerのprovider非依存      | source/test input、provider情報なしのE2E                      |
| process/JSONLの複雑性        | process/Envelope trace、failure test、起動時間・byte数        |
| planner責務                  | planner test、malformed output層別trace                       |
| stdout/stderrと回収          | protocol外stdout/stderr flood、timeout/failure cleanup test   |
| 再現性                       | lockfile、使用command、cached/offline確認結果                 |

## 停止・escalation

次の場合は範囲を拡大せず、証拠と影響を報告してDiscoveryへ戻る:
pluginにnetwork/env/credential等の追加権限が不可欠、adapterに任意URL/method/credential
headerが必要、plannerがprovider固有情報を必要、一run一model callやJSONL
request/responseでは仮説を検証できない、Deno
processがdeny-by-defaultと両立しない、対象外機能が必要、provider仕様またはrepository状態が前提と矛盾する。

局所的で可逆的な不具合は`local-fix`、承認計画の調整は`plan-delta`、concept仮説を変える問題は`concept-review`、対象外は`park`として扱う。

## Human Gate 2: 必要な判断

1. この計画をtwo-plugin spikeの実装許可として承認するか。
2. provider、model、対象operation、origin、HTTP method/pathを何にするか。
3. Runnerだけが参照するlocal secret名と設定方法（値は会話・文書・traceへ記載しない）。
4. 一回の実provider smoke test、その外部通信・費用発生を許可するか。
5. process/HTTP timeout、message/request/response/stdout/stderr/total outputの初期limit値。
6. trace本文はredacted bodyを残すか、hashとmetadataだけにするか。
7. 固定versionの`@std/cli`を導入するか、依存なしの最小parserにするか。

推奨は、一endpoint・一operation、一回の実provider test、trace本文はdefault
redaction、fixtureに必要な最小情報のみ保存である。

### 2026-08-18 Gate 2の承認済み判断（歴史的記録・現在は失効）

- この計画をtwo-plugin spikeの実装許可として承認する。
- provider/modelはOpenRouterのOpenAI互換APIと`google/gemini-3.7-flash`を使う。
- registryは`endpointId: "openrouter-api"`、`operationId: "chat-completions"`、`POST https://openrouter.ai/api/v1/chat/completions`に一件だけ固定する。
- Runnerだけが`HENJI_OPENROUTER_API_KEY`をlocal環境変数から読み、brokerで`Authorization: Bearer …`を注入する。
- 実providerへの一回のnon-streaming smoke testを許可する。
- 初期limitは、run/process 45秒、HTTP 30秒、JSONL message 256 KiB、HTTP request 256 KiB、HTTP
  response 1 MiB、plugin stdout合計512 KiB、stderr合計256 KiB、総出力768 KiBとする。
- 通常traceはpayload本文を残さず、hashとメタデータだけを残す。fixtureは明示的なsanitized
  fixtureとして別作成する。
- CLI parserには固定versionのDeno公式`@std/cli`を使う。versionは導入時に利用可能なDeno
  runtimeとの互換性を確認して決定する。

この計画はHuman Gate 2で停止する。

上記判断はsource-direct方式の停止・NO-GO決定より前の履歴であり、現在の実行権限を与えない。
