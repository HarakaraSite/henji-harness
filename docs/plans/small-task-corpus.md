# Small versioned task corpus plan

## Concept review

**GO。** 現行normal CLI runtimeを変更せず、24件のversioned corpus、strict loader/validator、
case-local mechanical scorer、direct offline testsだけを追加できる。

24件は`final_only`、4 single-tool categories、`multi_tool`へ各4件を割り当てる。tool利用20件では
各categoryにexplicit/implicitのcontrolled pairを2組ずつ置ける。controlled pair以外の近似重複は
作らない。

本incrementはcorpus data contractとself-validationだけを作る。eval runner、model/provider invocation、
成功率集計、prompt/model比較、live E2E、token/cost、fuzz/load/soakは後続とする。pinned Zotには本data
contractへ直接適用すべきpatternがないため、本計画では無理に採用しない。

## Current boundary

- normal runtimeは`character_count`、`count_json_array_items`、`list_json_object_keys`、
  `uppercase_text`だけをstable orderで公開する。
- JSON toolのpathはliteral `deno.v0.json`だけである。
- maximum model requestsは8、application retryは0である。
- current offline gateは101 tests、process focused suiteは9 tests、reviewはGOである。
- corpus scorerはmodelの`finalText`を対象とし、CLIが付加する末尾newlineは対象外とする。
- `deno.v0.json.tasks`はtask追加で変動するためfixtureに使わない。stableな`fmt`と`lint`だけを使う。
- `fmt`/`lint`が将来変わればsilent driftを許さずvalidationを失敗させ、corpus revisionを明示更新する。

## Canonical data format

canonical pathをliteral `v0/corpus/task-corpus.v1.json`とする。JSONは実行可能codeを含まず、top-level
version/fixtures/tasksとcorpus-level invariantを一体でreviewでき、後続runnerから言語非依存に読める。
task array orderをcanonical orderとする。

```json
{
  "schemaVersion": 1,
  "corpusId": "henji-normal-cli-small-v1",
  "fixtures": [],
  "tasks": []
}
```

全階層でallowlist外fieldを拒否する。loaderへ渡せるcorpus pathも上記literalだけとする。

fixture schema:

```json
{
  "id": "deno-v0-fmt",
  "kind": "local_json_object",
  "path": "deno.v0.json",
  "objectKey": "fmt",
  "expectedSortedKeys": ["lineWidth", "semiColons", "singleQuote"]
}
```

v1 fixtureは次の2件だけである。

| ID | path/object | expected sorted keys |
| --- | --- | --- |
| `deno-v0-fmt` | `deno.v0.json` / `fmt` | `lineWidth`, `semiColons`, `singleQuote` |
| `deno-v0-lint` | `deno.v0.json` / `lint` | `rules` |

task schema:

```json
{
  "id": "v1.uppercase-text.ascii.explicit",
  "category": "uppercase_text",
  "variant": "explicit",
  "pairId": "v1.uppercase-text.ascii",
  "prompt": "Use the uppercase_text tool on exactly this text and return only its result: Henji harness",
  "fixtureRefs": [],
  "oracle": { "kind": "exact_text", "expected": "HENJI HARNESS" },
  "toolExpectation": {
    "requiredSequence": ["uppercase_text"],
    "allowedTools": ["uppercase_text"],
    "forbiddenTools": [
      "character_count",
      "count_json_array_items",
      "list_json_object_keys"
    ],
    "maxCalls": 1,
    "requireSuccessfulResults": true,
    "requireSeparateRounds": false
  },
  "maxRequests": 2
}
```

multi-tool recordは`list_json_object_keys`から`count_json_array_items`へのcausal sequence、
`maxCalls: 2`、`maxRequests: 3`、`requireSeparateRounds: true`を持つ。

IDは`^v1\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`へ限定し、task IDと
fixture IDを一意にする。task arrayはID昇順とする。意味、oracle、期待toolが変わる変更ではIDを再利用せず、
新IDまたは次corpus/schema versionを使う。

## Exact 24-case matrix

`J`は`json_value`、`T`は`exact_text`を表す。`<LF>`はdecode後のLF一文字である。

| ID | Exact prompt | Oracle | Required | req/call |
| --- | --- | --- | --- | --- |
| `v1.character-count.henji-chick.explicit` | `Use the character_count tool on exactly this text and return only its JSON result: Henji 🐣` | J `{"count":7}` | character | 2/1 |
| `v1.character-count.henji-chick.implicit` | `Count the Unicode code points in this text and return only a JSON object with the count: Henji 🐣` | J `{"count":7}` | character | 2/1 |
| `v1.character-count.naive.explicit` | `Use the character_count tool on exactly this text and return only its JSON result: naïve` | J `{"count":5}` | character | 2/1 |
| `v1.character-count.naive.implicit` | `Count the Unicode code points in this text and return only a JSON object with the count: naïve` | J `{"count":5}` | character | 2/1 |
| `v1.count-json-array-items.complex.explicit` | `Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [["a","b"],{"x":1},false,null]` | J `{"count":4}` | array count | 2/1 |
| `v1.count-json-array-items.complex.implicit` | `Count the top-level items in this JSON array and return only a JSON object with the count: [["a","b"],{"x":1},false,null]` | J `{"count":4}` | array count | 2/1 |
| `v1.count-json-array-items.simple.explicit` | `Use the count_json_array_items tool on exactly this JSON array string and return only its JSON result: [1,2,3]` | J `{"count":3}` | array count | 2/1 |
| `v1.count-json-array-items.simple.implicit` | `Count the top-level items in this JSON array and return only a JSON object with the count: [1,2,3]` | J `{"count":3}` | array count | 2/1 |
| `v1.final-only.echo` | `Echo exactly the text between the brackets, without the brackets: [MiXeD 123 !]` | T `MiXeD 123 !` | none | 1/0 |
| `v1.final-only.json` | `Return only this JSON object, with no code fence: {"status":"ready","version":1}` | J same | none | 1/0 |
| `v1.final-only.multiline` | `Return exactly these two lines and nothing else:<LF>alpha<LF>beta` | T `alpha<LF>beta` | none | 1/0 |
| `v1.final-only.token` | `Reply with exactly: HENJI CORPUS READY` | T same | none | 1/0 |
| `v1.list-json-object-keys.fmt.explicit` | `Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "fmt". Return only the resulting JSON array.` | J fmt keys | list | 2/1 |
| `v1.list-json-object-keys.fmt.implicit` | `Read the literal local file "deno.v0.json", list the sorted keys of its "fmt" object, and return only the JSON array.` | J fmt keys | list | 2/1 |
| `v1.list-json-object-keys.lint.explicit` | `Use the list_json_object_keys tool with literal path "deno.v0.json" and object key "lint". Return only the resulting JSON array.` | J lint keys | list | 2/1 |
| `v1.list-json-object-keys.lint.implicit` | `Read the literal local file "deno.v0.json", list the sorted keys of its "lint" object, and return only the JSON array.` | J lint keys | list | 2/1 |
| `v1.multi-tool.fmt.explicit` | `Use list_json_object_keys to list the keys of object "fmt" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.` | J `{"count":3}` | list → count | 3/2 |
| `v1.multi-tool.fmt.implicit` | `In the literal local file "deno.v0.json", obtain the sorted key list for object "fmt", then count the items in that returned JSON array. Return only a JSON object with the count.` | J `{"count":3}` | list → count | 3/2 |
| `v1.multi-tool.lint.explicit` | `Use list_json_object_keys to list the keys of object "lint" in the literal path "deno.v0.json", then use count_json_array_items on the returned JSON array. Return only a JSON object with the count.` | J `{"count":1}` | list → count | 3/2 |
| `v1.multi-tool.lint.implicit` | `In the literal local file "deno.v0.json", obtain the sorted key list for object "lint", then count the items in that returned JSON array. Return only a JSON object with the count.` | J `{"count":1}` | list → count | 3/2 |
| `v1.uppercase-text.ascii.explicit` | `Use the uppercase_text tool on exactly this text and return only its result: Henji harness` | T `HENJI HARNESS` | uppercase | 2/1 |
| `v1.uppercase-text.ascii.implicit` | `Convert this text to uppercase and return only the converted text: Henji harness` | T `HENJI HARNESS` | uppercase | 2/1 |
| `v1.uppercase-text.unicode.explicit` | `Use the uppercase_text tool on exactly this text and return only its result: Straße café` | T `STRASSE CAFÉ` | uppercase | 2/1 |
| `v1.uppercase-text.unicode.implicit` | `Convert this text to uppercase and return only the converted text: Straße café` | T `STRASSE CAFÉ` | uppercase | 2/1 |

| Category | Count | Explicit | Implicit | None |
| --- | ---: | ---: | ---: | ---: |
| `final_only` | 4 | 0 | 0 | 4 |
| `uppercase_text` | 4 | 2 | 2 | 0 |
| `character_count` | 4 | 2 | 2 | 0 |
| `count_json_array_items` | 4 | 2 | 2 | 0 |
| `list_json_object_keys` | 4 | 2 | 2 | 0 |
| `multi_tool` | 4 | 2 | 2 | 0 |
| Total | 24 | 10 | 10 | 4 |

各tool categoryのexplicit/implicit recordは同じ`pairId`、fixture、oracle、tool expectation、ceilingを持ち、
prompt wording、variant、task IDだけが異なる。

## Oracle and tool-scoring semantics

`exact_text`は`finalText`をbyte-for-byte比較し、trim、case fold、Unicode normalization、Markdown除去を
しない。`json_value`は`finalText`全体を`JSON.parse`し、malformed/trailing textを失敗とする。object key
orderとinsignificant whitespaceだけを無視し、array order、type、値をdeep equalityする。expected numberは
finite safe integerだけとする。regex、semantic similarity、LLM judgeは使わない。

tool scoring:

- 全assistant tool callを順番どおり観測する。
- forbidden/allowed外tool、error result、欠落result、call/result ID/name mismatchは失敗。
- successful call名列は`requiredSequence`と完全一致し、call数は`maxCalls`以下。
- `requireSeparateRounds`ではrequired callsのrequest ordinalがstrictly増加することを要求する。
- request countはtask `maxRequests`以下かつ8以下。
- v1では`maxCalls`とrequired countが同じなのでextra callを許さない。
- scorerはdimension別resultとstable failure codeだけを返し、rate、平均、pair比較、rankingを算出しない。

```ts
interface CorpusObservation {
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: readonly {
    readonly requestOrdinal: number;
    readonly callId: string;
    readonly resultCallId: string;
    readonly callName: string;
    readonly resultName: string;
    readonly outcome: 'success' | 'error';
  }[];
}
```

## Strict loader and validator

`v0/corpus/task_corpus.ts`へ外部dependencyなしでJSON parse、exact-key validation、corpus invariant、fixture
drift validation、case scorerを実装する。

```ts
loadTaskCorpus(corpusPath, fixtureReader): Promise<ValidatedTaskCorpus>
validateTaskCorpus(value, resolvedFixtures): ValidatedTaskCorpus
scoreCorpusObservation(task, observation): CorpusCaseScore
```

corpus pathはliteral canonical path、fixture pathはliteral `deno.v0.json`だけを許可する。fixture objectが
存在しobjectであること、actual sorted keysがexpectedと一致することを確認する。loaderはprovider/model
構築より前に全検証を完了できるAPIとする。

negative table-driven testsで次を拒否する。

- malformed/root/version/corpus ID、全階層unknown field。
- invalid/duplicate/non-sorted IDs、duplicate refs、unknown refs。
- unknown category/variant、blank/64 KiB超prompt、fixture ref不足/過剰。
- path widening、blank object key、expected key duplicate/non-sort、missing/non-object/drift fixture。
- unknown/invalid oracle、empty exact text、non-finite/unsafe number。
- unknown/duplicate tools、allowed/forbidden overlap、不完全4-tool partition、category/sequence mismatch。
- invalid bounds、final-only不変条件、pair missing/one-sided/3 records/mismatched pair fields。
- corpus count 23/25、category/variant balance mismatch。
- scorerのtext/JSON差、tool missing/extra/forbidden/order/error/mismatch/same-round、request ceiling超過。

positive testは24件、category matrix、10 pairs、fixture paths、全oracle/tool ceilingsを直接確認する。

## Ownership and unchanged files

Human Gate承認後のownership:

- new `v0/corpus/task-corpus.v1.json`
- new `v0/corpus/task_corpus.ts`
- new `tests/v0/task_corpus_test.ts`
- `deno.v0.json`: `agent:corpus:test`、check、gateへの限定追加
- `README.md`: corpus path/version/count、focused command、eval runner非包含
- new `docs/plans/small-task-corpus-results.md`
- repository ownerだけが`AGENTS.md`と`.handoff/handoff.md`をphase/checkpoint用に更新する

all `v0/agent/` files、normal runtime process test/fixture、production task strings、provider/profile/endpoint、
dependency、lockfile、persistent state、archive、`_refs/`は変更しない。product runtime変更、fixture path read拡張、
実model observationが必要なら停止し、原因、証拠、影響、plan delta、検証方法を返す。

## Ordered increments

1. canonical JSON、types、4-tool enum、oracle、expectation、observation/score typesを追加する。
2. exact-key/type/range/ID/order/unique/reference validationとunknown-version fail-closedを実装する。
3. exact 24/category balance/10 pairsとliteral fixture drift validationを実装する。
4. exact text/JSON/tool event/separate-round/request ceiling scorerをpure functionで実装する。
5. negative matrixとscripted observation scorer testsを追加する。
6. `agent:corpus:test`をexact read permissionだけでcheck/fmt/lint/full gateへ統合する。
7. README、results、future runner handoffを記録し、bounded independent reviewを行う。

focused task:

```text
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt --allow-read=v0/corpus/task-corpus.v1.json,deno.v0.json tests/v0/task_corpus_test.ts
```

production task literalsが不変で、gateがproduction taskを呼ばないことをdirect testする。

## Future eval-runner handoff

後続runnerはprovider/model構築前にcorpusを一度validateし、failure時はrun 0件とする。canonical ID順、
taskごとのfresh runtime、task間state共有なしとし、corpus ID/version、task ID、final text、request count、
correlated tool eventsを同じcase scorerへ渡す。prompt/oracleをrunner側で補正せず、validation、execution、
aggregationを分離する。本incrementはpair rate/diffを算出しない。

## Validation commands

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:corpus:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json agent:runtime:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:check
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:fmt
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:lint
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:test
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
git diff --check
```

`agent:run`、`agent:acceptance`、network/provider commandは実行しない。resultsへrequirements、exact counts、
commands、provider/credential 0、deviation、review、riskを対応付ける。

## Review, acceptance, rollback

30分以内のread-only reviewでschema fail-closed、matrix/balance、prompt/oracle正確性、fixture path、scorer、
gate非provider性、product runtime不変、scope外変更なしを確認する。10分間新証拠がなければ停止し、
changed-lines re-reviewは15分以内で一回とする。Blocker/P1/P2が残ればNO-GO。

完了条件:

- schema v1、exact 24 tasks、category matrix、10 pairsがcanonical dataとvalidatorで一致。
- 全24 prompt/oracle/fixture/tool expectation/ceilingが本計画と一致し、LLM judgeなしでscore可能。
- fixtureはliteral `deno.v0.json`の`fmt`/`lint`だけ。
- malformed matrixとscripted scorer matrixがgreen。
- focused、runtime regression、check/fmt/lint/full test/gate、diff checkがgreen。
- provider/network/production command/credential確認・読取り0。
- results完成、independent review GO。

rollbackはnew corpus JSON、loader/scorer、direct test、resultsを削除し、`deno.v0.json`のfocused/check/gate、
README、phase/checkpointだけを戻す。migrationはなく、existing runtime/process E2E、`_refs/`、worktree全体を
resetしない。

残るriskは、literal taskをmodelがtoolなしで計算できてもtool expectationにより失敗すること、24件は
初期signalにすぎないこと、`fmt`/`lint`変更が意図的にgateを止めること、actual eval runner/live/model品質/
統計的信頼性をまだ証明しないことである。

## Human Gate

本計画の承認は、上記24件のversioned corpus、strict loader/validator、case-local mechanical scorer、
scripted offline tests、focused task/gate integration、README、results、bounded read-only reviewだけを許可する。

eval runner、model/provider invocation、production `agent:run`または`agent:acceptance`、credential確認・読取り、
network、live E2E、集計/A-B、product runtime/tool/CLI変更、dependency/lockfile、persistent state、commit、push、
tag、publish、releaseは含まない。必要になった時点で停止して別判断へ戻す。
