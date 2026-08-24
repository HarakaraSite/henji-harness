# Model Adapter / Task Planner スパイク結果

> **STOPPED / SUPERSEDED:** この文書は、反証された旧source-direct方式の歴史的証拠である。
> 実装とprovider smokeを再開してはならない。現在のscopeは
> [`candidate-admission.md`](candidate-admission.md)のSpike 0計画だけである。

## 実装済み境界

- pluginは短命Deno processで実行し、network、env、run、FFI、writeを許可しない。
- Runner-owned brokerだけが`openrouter-api` /
  `chat-completions`を`POST https://openrouter.ai/api/v1/chat/completions`へ解決し、Bearer認証を注入する。
- plannerはprovider非依存の`host.model.generate`を一回要求し、adapterは`host.broker.call`を一回要求する。
- stdoutはJSONL protocol、stderrはbounded diagnosticとして扱う。process/HTTP/message/output
  limitを実装した。
- failed host handler、pluginの`ok: false`、protocol/output-limit failureはstructured failureとして
  優先し、final responseを破棄する。output limit検出時はchildを停止・回収する。
- CLIの`--trace <path>`は、payload/credential本文を保存せず、plugin source hash、process時間、
  stdout/stderr byte数、failure codeだけをlocal artifactへ出力する。

## 直接証拠

| 仮説                         | 証拠                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| credentialをpluginへ見せない | env probe、broker dummy-secret test、`clearEnv`                      |
| broker allowlist             | unknown operation拒否、固定URL/Authorization test                    |
| plannerのprovider非依存      | planner session integration test                                     |
| 二plugin往復                 | `runTask`とtwo-plugin integration test                               |
| malformed output             | Plan parser/schema test                                              |
| process boundary             | timeout、stderr limit、duplicate final、permission probe test        |
| failure/trace 観測           | host handler failure、structured plugin failure、redacted trace test |
| response size limit          | Content-Lengthとchunked stream cancel test                           |

## 実行済み検証

`deno task check`、`deno task lint`、`deno task test`、`deno task fmt` が成功。現在のtest総数は46。

## 未実施・残存リスク

- `HENJI_OPENROUTER_API_KEY`が未設定だったため、実provider smoke testは実施されなかった。
- 旧Gateでのprovider smoke許可は、source-direct方式の停止・NO-GO判断により失効した。keyの有無に
  かかわらず実行してはならない。
