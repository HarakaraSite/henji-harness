# DefinitionContent Roundtrip Spike 0 実装計画

## 位置づけと停止点

この計画は、[candidate admission brief](../spikes/candidate-admission.md)のSpike 0とH-009だけを
実装可能なincrementへ分解する。`DefinitionContent`を意味上の正本とし、host-ownedなhidden
fieldをRevision Viewへ露出せず保持しながら、visible fieldのno-op往復後に同一のcanonical
bytesとcontent hashを得られるかを観測する。

この計画の作成後はHuman Gateで停止する。Gate承認前には、実装、依存導入、test実行、candidate
またはlegacy pluginの実行、child process起動、AI、model/provider呼出しを行わない。

旧two-plugin spikeの`deno.json`、`deno.lock`、`src/`、`plugins/`、`tests/`、旧計画、旧結果文書は
停止済み証拠である。変更、import、実行、削除しない。Spike 0は新規`spike0/` treeと新規
`deno.spike0.json`だけで実装・検証し、新規依存は追加しない。

## 実証対象

Spike 0で実証するのは次だけである。

1. `DefinitionContent`のschema、field ownership、default、normalization、unknown field rejection。
2. host-owned hidden fieldを除いたRevision Viewの生成。
3. exact baseと変更のないRevision Viewをmergeしたresolved `DefinitionContent`。
4. deterministic canonical encodingとcontent hash。
5. 同じ入力、正規化上同値な入力、key順だけが異なる入力について、反復呼出しと独立test
   commandで同じbytes/hashになること。
6. no-op exact-base roundtrip後のcanonical bytes/hashがbaseと一致すること。
7. artifact、`DefinitionRevision`、current、`DeploymentState`を作成、発行、登録、更新しないこと。
8. Spike 0 codeによるfilesystem read/write、child process、network、environment、system
   information、FFI、remote import、model/provider/broker到達が0であること。

## 非対象

- AI、model/provider選定、credential、provider API call
- candidateまたはlegacy pluginの実行
- parser/compiler/runtimeの選定、TypeScript accepted-subset検査
- Admission Builder、artifact生成、`DefinitionRevision`発行またはregistry
- `RevisionTicket`、`DefinitionProposal`、stale/conflict、provenance lifecycle
- Admission、Evaluation、Approval、promotion、rollback、`DeploymentState`
- tool実行、broker、general plugin framework、Spike 1以降
- 旧two-plugin資産の再利用、変更、削除、import、実行

`RevisionView`はDefinitionContentのvisible projectionだけを表し、`DefinitionRevision` lifecycleを
導入したことにはしない。

## DefinitionContent v1の予定schema

Human Gateで次のschemaを承認してから固定する。値はJSON
domain、すなわち`null | boolean |
finite number | string | array | object`に限定し、class
instance、function、symbol、bigint、 `undefined`、sparse array、non-finite numberを拒否する。

```ts
type DefinitionContentV1 = {
  schemaVersion: 'definition-content/v1';
  identity: {
    pluginId: string;
    namespace: string;
    kind: 'text-transform';
  };
  source: {
    mediaType: 'application/typescript';
    text: string;
  };
  manifest: {
    displayName: string;
    description: string;
  };
  publicContract: {
    input: 'text';
    output: 'text';
  };
  pluginOwnedTests: Array<{
    name: string;
    input: string;
    expectedOutput: string;
  }>;
  config: JsonObject;
  requestedCapabilities: [];
};
```

parser/compiler/runtime、artifact、revision metadata、provenance、timestampは含めない。

### Validation constraint

Spike 0 v1では、上記の型、literal、JSON/I-JSON domain以外のapplication constraintを設けない。

- 全stringはUnicode scalar valueの列であり、空文字を許可する。lone surrogateは拒否する。
- `pluginId`、`namespace`、`displayName`、test `name`にも文字種、形式、予約語、最大長を設けない。
- `pluginOwnedTests`は空配列、同名test、同一内容、任意順を許可し、最大件数を設けない。
- `config`はplain JSON objectであり、任意depth/件数を許可する。array順を保持する。
- numberはfinite IEEE 754 binary64とし、safe integerへの限定は設けない。NaNと±Infinityを拒否する。
- source、各string、array、objectのsize/depth/budget制約はSpike 1以降へparkする。

resource exhaustion対策を保証しないことをremaining riskへ記録する。上限がSpike 0にも必要と判明した
場合は、実装者が値を創作せずplan-deltaとしてHuman Gateへ戻す。

### Field ownershipとRevision View

各logical pathは一つのownerだけを持つ。versioned ownership tableを実装し、同一pathの重複、
親子pathの競合、schemaに存在しないpathを拒否する。

| Logical path            | Owner             | View    | 扱い                                    |
| ----------------------- | ----------------- | ------- | --------------------------------------- |
| `schemaVersion`         | host              | hidden  | hostが固定しbaseから保持                |
| `identity.pluginId`     | host              | hidden  | host-assigned opaque valueとして保持    |
| `identity.namespace`    | host              | hidden  | host-assigned opaque valueとして保持    |
| `identity.kind`         | host              | hidden  | `text-transform`に固定                  |
| `source`                | definition author | visible | そのまま投影                            |
| `manifest`              | definition author | visible | そのまま投影                            |
| `publicContract`        | host              | hidden  | text-to-text contractとしてbaseから保持 |
| `pluginOwnedTests`      | definition author | visible | 配列順を意味の一部として保持            |
| `config`                | definition author | visible | JSON objectとして投影                   |
| `requestedCapabilities` | host policy       | hidden  | Spike 0では空配列                       |

`identity`はrevision identityではなくhost-owned plugin identityである。DefinitionContentに含めるか、
別のhost-owned field名へ変えるかはHuman Gateで判断する。

Revision Viewには`source`、`manifest`、`pluginOwnedTests`、`config`だけを含める。hidden fieldを
placeholder、hash、複製値としても含めない。mergeはexact baseとRevision Viewを引数に取り、hidden
fieldをbaseからだけ復元する。

Revision Viewはpartial patchではなく、全visible field必須のfull projection/full replacementとする。

```ts
type RevisionViewV1 = {
  source: DefinitionContentV1['source'];
  manifest: DefinitionContentV1['manifest'];
  pluginOwnedTests: DefinitionContentV1['pluginOwnedTests'];
  config: DefinitionContentV1['config'];
};
```

- `source`と`manifest`はobject全体を置換し、leaf mergeを行わない。
- `pluginOwnedTests`と`config`も値全体を置換する。
- 4 fieldのmissingはno-changeやdefaultではなくinvalid Viewとして拒否する。
- top-levelまたはnestedのunknown field、hidden fieldの注入を拒否する。
- `null`はmissingと同一視しない。schema上object/array/stringの位置では型不一致として拒否し、
  `config`内部のJSON valueとしてだけ許可する。
- defaultはraw DefinitionContentのnormalize時だけ適用する。Revision Viewのmergeでは適用しない。
- resolved contentはbaseのhidden fieldとViewの4 visible fieldから新規構築し、full schemaで再検証・
  再normalizeする。

## Validation、default、normalization

入力処理は次の順に固定する。

1. plain JSON objectであることを確認する。
2. rootと各nested objectのunknown fieldをdefault適用前に拒否する。
3. required fieldの型、literal、制約を検査する。
4. 承認済みdefaultを適用する。
5. 承認済みnormalizationを適用する。
6. 新しいnormalized valueを返し、入力objectを変更しない。
7. canonical encodingとhashはnormalized valueだけを受け取る。

推奨default:

- `manifest.description`: `''`
- `pluginOwnedTests`: `[]`
- `config`: `{}`
- `requestedCapabilities`: `[]`

`schemaVersion`、`identity`、`source`、`manifest.displayName`、`publicContract`にはdefaultを設けない。

推奨normalization:

- source: 先頭UTF-8 BOMを一つだけ除去し、CRLF/CRをLFへ統一する。それ以外の空白、末尾改行、
  comment、literal内容は変更しない。
- human-readable metadataとtest文字列: Unicode NFC。trimとcase foldingはしない。
- `pluginOwnedTests`: 自動sort/deduplicateせず、配列順を保持する。
- `config`: object key順はcanonical encodingで吸収し、array順は保持する。
- `-0`は`0`へ正規化し、NaNと±Infinityは拒否する。

sourceと文字列のnormalizationは意味を変え得るため、Human Gateで承認または縮小する。未承認の
方針を実装者が決めてはならない。RFC 8785自体はUnicode normalizationを行わないため、承認された
application normalizationを先に一度だけ適用し、その結果をJCSへ渡す。

## Canonical encodingとhash

canonical
bytesは[RFC 8785 JSON Canonicalization Scheme (JCS)](https://www.rfc-editor.org/rfc/rfc8785.html)へ準拠する`definition-content/v1+jcs`
codecとして固定する。独自のstring/number表現は定義しない。

- 入力はI-JSON subsetとし、duplicate property name、lone surrogate、NaN、±Infinityを拒否する。
  APIはparsed valueを受けるためduplicate keyを生成せず、plain objectだけを受理する。
- object property nameはraw/unescapedなUTF-16 code unit列として比較し、unsigned code unitの
  lexicographic ascending orderへ再帰的にsortする。locale比較とUnicode code-point順は使わない。
- array順を保持し、array内objectも再帰的にsortする。
- literalは`null`、`true`、`false`として出力する。
- stringはRFC 8785 §3.2.2.2に従う。U+0008/0009/000A/000C/000Dは`\\b`、`\\t`、`\\n`、
  `\\f`、`\\r`、その他U+0000〜U+001Fはlowercase `\\uhhhh`、quoteとbackslashだけをescapeする。
  slash、非ASCII、U+2028/U+2029をescapeせずUTF-8へ出力し、lone surrogateを拒否する。
- numberはfinite IEEE 754 binary64をRFC 8785 §3.2.2.3 / ECMAScriptのshortest round-trip
  serializationで出力する。V8 15.0.245.2上の`JSON.stringify` primitive serializationを使い、
  `-0`は`0`、exponentはlowercase `e`、正指数には`+`を含め、不要なleading zeroを出さない。
- whitespaceと末尾改行を出力せず、`TextEncoder`でUTF-8 bytesへ変換する。
- SHA-256にはcanonical bytesだけを渡し、`sha256:<lowercase hex>`で表現する。
- path、cwd、clock、randomness、locale、process stateを入力に含めない。

Human Gate用golden vectorは次とする。canonical JSONの末尾にnewlineはない。`source.text`中の
`\\n`はJSON escapeであり、decode後のsource末尾LFを表す。

```text
{"config":{},"identity":{"kind":"text-transform","namespace":"example","pluginId":"plugin-1"},"manifest":{"description":"","displayName":"Example"},"pluginOwnedTests":[],"publicContract":{"input":"text","output":"text"},"requestedCapabilities":[],"schemaVersion":"definition-content/v1","source":{"mediaType":"application/typescript","text":"export default (input: string) => input;\n"}}
```

- UTF-8 byte length: `387`
- SHA-256: `sha256:7630b115e3beeb0f6fb81021a5e3988fc2c6a26fd8f62734d2c9ec91123bc247`
- 独立導出: 計画作成時に上記literalをimplementation codeではなく`/usr/bin/sha256sum`へnewlineなしで
  pipeして算出した。実装後はWeb Cryptoの結果とこの固定値を比較する。

testにはRFC 8785 §3.2.2のstring/number例、Appendix Bのnumber境界例、§3.2.3のproperty sort例も
含める。hashだけをDefinition、Admission、artifact、revision identityへ拡張しない。

## no-op exact-base roundtrip

```text
raw base
  → validate + normalize
  → canonical bytes/hash A
  → project Revision View
  → unchanged view
  → resolve against the same normalized exact base
  → validate + normalize
  → canonical bytes/hash B
  → A == B
```

resolverはbase content hashも受け取り、baseを再hashして一致を確認する。不一致ならfail closedと
する。これは`RevisionTicket`や`DefinitionRevision`ではなく、同じexact baseを使ったことをtestで
観測するための引数である。

mergeではhidden fieldの保持、hidden/unknown field注入の拒否、visible以外の作成・削除・上書き
禁止、base/viewの非mutationを保証する。

## 予定ファイルと責務

| File                                                  | 責務                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `deno.spike0.json`                                    | Spike 0専用taskとfmt/lint scope。外部dependencyなし          |
| `spike0/src/definition_content.ts`                    | v1型、JSON domain、strict validation、default、normalization |
| `spike0/src/field_ownership.ts`                       | versioned ownership/visibility tableと整合検査               |
| `spike0/src/revision_view.ts`                         | projection、exact-base検査、hidden-preserving resolution     |
| `spike0/src/canonical_content.ts`                     | canonical bytesとSHA-256 content hash                        |
| `spike0/tools/check_module_graph.ts`                  | `deno info --json` closureのallowlist検査                    |
| `spike0/tests/assert.ts`                              | dependency-free assertion helper                             |
| `spike0/tests/all_test.ts`                            | preflight/test用の単一test entrypoint                        |
| `spike0/tests/definition_content_test.ts`             | schema、default、normalization、unknown、immutability        |
| `spike0/tests/field_ownership_test.ts`                | ownership一意性、schema coverage、visibility                 |
| `spike0/tests/revision_view_test.ts`                  | hidden保持、注入拒否、exact-base no-op                       |
| `spike0/tests/canonical_content_test.ts`              | golden bytes/hash、key順、反復、正規化同値性                 |
| `docs/spikes/definition-roundtrip-spike-0-results.md` | Gate後に作るacceptance package                               |
| `.handoff/handoff.md`                                 | Gate後の完了または停止checkpoint                             |

既存`deno.json`、`deno.lock`、`src/`、`plugins/`、`tests/`、旧計画、旧結果文書はplanned filesに
含めない。validation errorはSpike 0 namespace内に定義し、旧error moduleを再利用しない。

## 依存方針

新規依存は0とする。

- JSR、npm、remote URL、既存import mapを使わない。
- 既存`@std/assert`、`@std/cli`、lockfileを参照・更新しない。
- 新しいlockfileを作らず、`deno.spike0.json`にimportsを定義しない。
- assertionはlocalの`spike0/tests/assert.ts`だけで提供する。
- Deno標準global API以外が必要なら、自動追加せずplan-deltaとしてHuman Gateへ戻す。

## 実装increment

### 1. 隔離基盤、schema、ownership境界

新規`deno.spike0.json`、strict parser/normalizer、versioned ownership table、Revision Viewの型と
projectionを追加する。

直接検証:

- Spike 0 moduleが`spike0/`外をimportしない。
- valid minimal/full inputと、root・全nested levelのunknown field拒否。
- required field、literal、型、invalid JSON domain、non-finite numberの拒否。
- default、normalization、入力非mutation。
- 全logical pathにownerが一つだけ存在する。
- hidden pathがRevision Viewのruntime valueとserialized formに存在しない。

停止条件:

- ownerを重複なく決められない。
- hidden fieldをViewから返させないと復元できない。
- revision metadata、artifact、旧資産、外部dependencyが必要になる。

### 2. Canonical encodingとcontent hash

versioned canonical encoder、SHA-256 content hash、dependency-free golden vectorを追加する。

直接検証:

- golden canonical bytes/hash。
- object挿入順だけが異なる入力とnormalization上同値な入力で一致。
- array順または意味上の値が異なる入力で不一致。
- 同一test run内の反復と独立したtest command二回で同じgoldenを満たす。
- ambient path、cwd、clock、randomnessを使わないことをreviewする。

停止条件:

- bytesがruntimeのambient stateへ依存する。
- number/string ruleや独立goldenを固定できない。
- hashingに外部dependencyが必要になる。

### 3. Exact-base no-op roundtrip

exact base hash検査、Revision View projection、base-preserving resolutionを追加する。

直接検証:

- `hash(base) == hash(resolve(base, project(base)))`かつcanonical bytesも一致。
- hidden field保持、hidden/unknown injection拒否、異なるbase hash拒否。
- visible field変更時だけhashが変わる。
- base/view/resolvedにaliasやmutationがない。

停止条件:

- no-opでbytes/hashが変わる。
- hidden fieldが欠落またはViewへ漏れる。
- exact-base不一致を検出できない。
- resolverがrevision発行やregistry writeを必要とする。

### 4. Side-effect境界とacceptance evidence

scoped check/test/fmt/lint、requirement-to-evidence表、独立review、結果文書、handoffを完成させる。

直接検証:

- `check_module_graph.ts`自体にimportとside-effect APIがないことを先にread-only reviewする。
- `deno info --json`で`all_test.ts`の解決済みclosureを取得し、全specifierがcanonicalized repository
  rootの`spike0/`配下にあることを機械検査してからtestを許可する。
- preflightは`file:`以外、repository内の`spike0/`外、`node:`、npm、JSR、remote、data URLを拒否する。
- 新規module graphが`spike0/`とDeno標準global APIだけで閉じる。
- 旧資産を変更、import、実行していない。
- Spike 0 codeに`Deno.read*`、`Deno.write*`、`Deno.Command`、`fetch`、WebSocket、env/sys/FFI、
  provider/broker、artifact/revision/current/deployment APIがない。
- testを全deny、no-prompt、local-only、no-lockで実行する。
- candidate/plugin process、artifact、DefinitionRevision、registry write、provider callが0。
- dependency resolutionが0。

停止条件:

- testにread/write/net/env/sys/run/ffi/import permissionが必要になる。
- 旧資産、external/JSR/npm import、Spike 1 lifecycleが合否に必要になる。
- side-effect 0を直接説明できない。

## Test strategyと直接証拠

| Requirement            | Direct evidence                                              |
| ---------------------- | ------------------------------------------------------------ |
| H-009 no-op正本性      | exact-base roundtripのcanonical bytes/hash equality          |
| owner一意              | duplicate、parent/child conflict、schema coverage            |
| hidden保持             | projectionで不存在、resolutionで保持、injection拒否          |
| View merge contract    | full projection、missing/null/unknown拒否、whole replacement |
| unknown拒否            | rootと各nested objectのtable-driven rejection                |
| default/normalization  | raw inputとexpected normalized value                         |
| deterministic encoding | RFC 8785 vector、fixed golden、key permutation、command二回  |
| meaning change         | scalar、array順、config value変更でhash不一致                |
| immutable processing   | frozen inputと処理前後のdeep equality                        |
| dependency 0           | local assertion、remote/npm/import map不在                   |
| read/write 0           | pure API、`--deny-read --deny-write`、forbidden API review   |
| process 0              | `--deny-run`、`Deno.Command`不在、plugin fixture不使用       |
| network/provider 0     | `--deny-net --deny-import`、provider/broker import不在       |
| env/sys/FFI 0          | `--deny-env --deny-sys --deny-ffi`、対応API不在              |
| lifecycle write 0      | artifact/revision/current/deployment writerを実装しない      |
| 旧資産不使用           | diff、import search、明示config/path                         |
| 実行前closure guard    | `deno info --json` allowlist成功後だけtest                   |

test runner自身の起動はprocess 0の対象外だが、test codeからchild processを起動しない。Denoのruntime
read permissionとinitial module graph読込みは区別し、deny flagsをuntrusted-code isolationの証明には
使わない。

## Spike 0専用configと検証command

`deno.spike0.json`は既存configをextendせず、importsなしの独立configとする。format/lint scopeも
`spike0/`、この計画、Spike 0結果文書だけに限定する。testはdirectory discoveryを使わず、全testを
static importする`spike0/tests/all_test.ts`一件だけをentrypointにする。

Deno 2.9.4のhelpで、以下のflagが利用可能であることを計画作成時にread-only確認済みである。

- test: `--no-prompt`、`--no-remote`、`--no-npm`、`--no-lock`、`--deny-read`、
  `--deny-write`、`--deny-net`、`--deny-env`、`--deny-sys`、`--deny-run`、`--deny-ffi`、
  `--deny-import`
- check: `--config`、`--no-remote`、`--no-npm`、`--no-lock`、`--deny-import`

Human Gate後は、handoffに記録されたDeno 2.9.4 binaryをtask専用変数へ設定し、次を順番どおり
実行する。preflight失敗時はtestへ進まない。

1. `check_module_graph.ts`を目視し、import、filesystem/process/network/env/sys/FFI APIがないことを
   確認する。
2. `deno check --config deno.spike0.json --no-remote --no-npm --no-lock --deny-import
   spike0/src/*.ts spike0/tests/*.ts`
3. `deno info --json --config deno.spike0.json --no-remote --no-npm --no-lock --deny-import
   spike0/tests/all_test.ts`の出力を、全denyで起動した`spike0/tools/check_module_graph.ts`へpipeする。
   checker側は`deno run --config deno.spike0.json --no-remote --no-npm --no-lock --no-prompt
   --deny-read --deny-write --deny-net --deny-env --deny-sys --deny-run --deny-ffi --deny-import
   spike0/tools/check_module_graph.ts`で起動する。toolは`import.meta.url`からallowed
   rootを算出し、rootと 全module specifierがcanonical `spike0/`配下の`file:`
   URLであること、全dependencyが解決済みで allowlisted
   moduleを指すこと、予定した全`spike0/src/*.ts`がclosureに含まれることを検査する。
4. preflight成功後だけ`deno test --config deno.spike0.json --no-remote --no-npm --no-lock --no-prompt
   --deny-read --deny-write --deny-net --deny-env --deny-sys --deny-run --deny-ffi --deny-import
   spike0/tests/all_test.ts`
5. 同じunit testをもう一度独立実行する。
6. `deno lint --config deno.spike0.json spike0/`
7. `deno fmt --check --config deno.spike0.json`で新規Spike 0 pathだけを検証する。
8. `git diff --check`。
9. 同じmodule graph preflightを再実行し、forbidden APIをread-only reviewする。
10. reviewerによる要件・code・test・acceptance evidenceの独立突合。

既存`deno task check/test/lint/fmt`は実行しない。Deno 2.9.4のhelpに包括的な`--deny-all`はないため、
確認済みdeny flagsを個別に列挙する。新規dependencyがないため`--cached-only`は合格根拠にしない。

## Compatibility、security、rollback

- production compatibilityと永続data/schema migrationは対象外。
- canonical schema/codec/hashを`v1`として明示し、暗黙変更を禁止する。
- Spike 0変更は新規`deno.spike0.json`、`spike0/`、結果文書、handoffだけで識別する。
- rollbackでは新規資産をretain、park、削除候補として提示し、実際の削除は別のhuman approvalを
  要求する。
- Spike 0成功はuntrusted code isolation、Admission、artifact安全性を意味しない。
- deny flagsはside-effect検知の補強であり、initial module graphのsecurity boundaryではない。

## Deviation分類と停止ルール

- `local-fix`: 承認済みschema/境界を変えない新規Spike 0 file内の実装・test・文書誤り。
- `plan-delta`: file分割、専用config、default、normalizationなどH-009内の承認変更。
- `concept-review`: 正本性、ownership、hidden保持、deterministic hash、side-effect 0が成立しない。
- `park`: Spike 1以降、Admission、artifact、AI、provider、promotionなどH-009に不要な事項。

hidden復元にViewからの返却が必要、unknown fieldを黙って保持/除去する必要がある、no-opでhashが
変わる、side effectや旧資産・外部dependency・Revision lifecycleが必要、未決schemaを実装者が
創作する必要がある場合は停止し、該当gateへ戻る。

## Acceptance package

Gate後の実装完了時に`docs/spikes/definition-roundtrip-spike-0-results.md`へ次を記録する。

- H-009と各要件からsource、test名、実測結果への対応表。
- 承認済みschema、ownership、visible/hidden境界。
- codec version、normalization/default、golden bytes/hash。
- 実行commandと要約結果。
- read/write/process/net/env/sys/FFI/import/model/provider/broker/artifact/revision/current/deployment
  到達が0である証拠。
- dependency/external resolution/lockfile利用が0であること。
- 旧資産を変更、import、実行していないこと。
- review findings、deviation、remaining risk、retain/discard。
- H-009のGO/NO-GO。Spike 1、Admission、v1、実行方式のGOとは扱わない。
- 次のHuman Gateで、Spike 1へ進む、Spike 0を縮小再試行、方向転換、保留、終了の判断を求める。

## Human Gateで必要な判断

実装開始前に次を一括して明示承認する。

1. `DefinitionContentV1`のfield構成、validation constraint、size/budgetをSpike 1以降へparkすること、
   `identity`を含めること。
2. ownershipとRevision Viewのvisible/hidden区分、および全visible field必須のfull projection/full
   replacement merge contract。
3. `publicContract`と`requestedCapabilities`をhost-owned hiddenにすること。
4. default値。
5. source BOM/改行とmetadata/test文字列のUnicode NFC方針。
6. RFC 8785 JCS準拠、I-JSON/lone-surrogate制約、UTF-16 key順、string/number rule、提示したgolden
   vectorと独立導出方法。
7. SHA-256と`sha256:<lowercase hex>`表現。
8. 新規dependency 0とlocal assertion helper。
9. 新規`deno.spike0.json`と`spike0/`への完全分離。
10. 旧資産を変更、import、実行しないこと。
11. Deno 2.9.4の`deno info --json` closure allowlist preflightをtest前に必須とし、確認済み
    deny/no-resolution flagsを使うscoped command。
12. increment、停止条件、acceptance package。
13. 承認範囲はSpike 0の新規実装、scoped test、review、証拠整理までとし、Spike 1以降、AI、
    provider/model、artifact、Admission、revision lifecycle、plugin実行を含めないこと。

以上が承認されるまで、計画作成以外のrepository変更、dependency installation、test executionを
開始しない。
