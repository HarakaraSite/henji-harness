# DefinitionContent Roundtrip Spike 0 結果

## 判定

H-009のSpike 0観測は、独立review済みの`GO`とする。DefinitionContentのno-op exact-base
roundtripは同一canonical bytes/hashを返し、hidden fieldをRevision Viewへ露出せずbaseから保持した。
Spike
1以降へ進む許可、AI・provider・plugin実行、artifact・revision・current・DeploymentStateの作成を
この判定には含めない。

独立reviewは、初回と再reviewで検出した全findingの修正後に、対応可能な新規findingなしとして Spike 0 /
H-009をGOと判定した。

## 実装範囲

- `deno.spike0.json`と`spike0/`を新設し、外部dependencyを追加しなかった。
- strictなDefinitionContent v1 validation、default、normalizationを実装した。
- versioned field ownership表と、その重複・親子競合・schema漏れ検査を実装した。
- visible 4 fieldだけのfull Revision View projection/replacementとexact-base resolverを実装した。
- RFC 8785 JCS canonical encoding、UTF-8 bytes、SHA-256 content hashを実装した。
- 停止済み旧資産`deno.json`、`deno.lock`、`src/`、`plugins/`、`tests/`を変更、import、実行しなかった。

## 要件と直接証拠

| 要件                                        | 実装証拠                             | test証拠                               |
| ------------------------------------------- | ------------------------------------ | -------------------------------------- |
| schema、default、normalization、unknown拒否 | `spike0/src/definition_content.ts`   | `definition_content_test.ts` 7件       |
| field ownerが重複なく一意                   | `spike0/src/field_ownership.ts`      | `field_ownership_test.ts` 2件          |
| hiddenを除いたfull View                     | `spike0/src/revision_view.ts`        | `revision_view_test.ts` 4件            |
| exact-base、hidden保持、no-op同一性         | `spike0/src/revision_view.ts`        | no-op、stale、注入、非mutation test    |
| deterministic JCS bytes/hash                | `spike0/src/canonical_content.ts`    | `canonical_content_test.ts` 7件        |
| 外部module closureなし                      | `spike0/tools/check_module_graph.ts` | `deno info --json` preflight通過       |
| filesystem等のruntime authorityなし         | Deno permissionを全拒否              | 同条件で20 testを2回通過               |
| artifact/revision/current等を作らない       | Spike 0本体4 module                  | 対象概念・write APIなし、write権限拒否 |

golden canonical JSONは387 UTF-8 bytesで、Web Cryptoの結果は計画時に`sha256sum`で独立導出した
`sha256:7630b115e3beeb0f6fb81021a5e3988fc2c6a26fd8f62734d2c9ec91123bc247`と一致した。

## 検証結果

使用runtimeはDeno 2.9.4、V8 15.0.245.2、TypeScript 6.0.3。

1. scoped `deno check`: 11 TypeScript files成功。
2. `deno info --json` module graph preflight:
   成功。rootは`spike0/tests/all_test.ts`だけで、closureは `spike0/`内、予定した本体4
   moduleをすべて含んだ。
3. 全permission、remote/npm/lockfileを拒否した`deno test`: 20 passed / 0 failedを独立に2回。
4. scoped `deno lint`: 11 files成功。
5. scoped `deno fmt --check`: 14 files成功。
6. `git diff --check`: 成功。

初回検証ではTypeScript narrowing不足を修正した。その後の初回testで、末尾のlone high surrogateを
見逃す実装不具合と、整数風object keyの列挙順に依存したtest不具合を検出した。判定式とcanonical
文字列の直接比較を修正した。独立reviewではaccessor/non-enumerable propertyの受理、ownership
coverageの自己参照、required/type/literal test不足、fmt件数誤記を検出した。data property境界、
独立ownership manifest、直接回帰test、実測値を修正した。再reviewで配列の追加own propertyを
黙って捨てる経路を検出し、`length`と連続index以外のstring/symbol propertyを拒否するよう修正後、
上記の全検証を最初から再実行した。

## deviationとremaining risk

承認済み計画からのscope deviation、新規dependency、旧資産変更はない。

- Spike 0は文字列長、source size、配列件数、object depth、処理時間、memoryの上限を保証しない。
- number serializationは承認されたpinned V8の`JSON.stringify` primitive挙動へ依存する。
- `deno info --json`はDeno CLIのunstable outputであり、本結果はpinned Deno 2.9.4での観測である。
- parsed object APIではduplicate JSON propertyを観測できない。API自身はduplicate
  propertyを生成せず、 plain objectだけを受理する。
- ProxyなどactiveなJavaScript objectを信頼境界の入力にしない。Spike 0 APIはJSON parse済みの
  inertなplain object/arrayを前提とし、Proxyを識別する保証を持たない。
- Spike 0はsourceを実行も解析もしないため、accepted subset、runtime authority、Admission safetyを
  実証していない。

## retain / discard

retain候補はDefinitionContent v1 schema、ownership table、Revision View境界、JCS codec、golden
vector、 exact-base roundtrip testsである。Spike
0のコードはconcept-spike実装であり、独立reviewと次のHuman Gateを経ずにproductionまたはSpike
1へ昇格しない。
