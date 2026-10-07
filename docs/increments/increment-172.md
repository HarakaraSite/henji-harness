# Increment 172 — Exa検索への置き換えとweb_fetchのダウンロード

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-10-06

ステータス: **local実装・focused検証・実Exa probe・常用配置・commit/push済み。公開は未実施。**

2026-10-03時点では人間によるproduction TUI受入は未確認だった。
A6の完了判断は2026-10-06に利用者承認済み。後続200の案内追加と保存履歴の通常利用観測を含めた
判断・旧候補の記録は末尾を参照する。

利用者の「2段階でやる」「exa websearchを実装 sonarは置き換える」「web fetchの機能追加」により、
第1段階を本incrementへ採用した。第2段階の共通credential登録は[Increment 173](increment-173.md)。
通常利用メモA17とA6のsearch/fetch分離に関する採用要件は本書へ移した。

## 利用者が必要とする動作

- 親modelが`web_search`でExa APIを使い、検索条件を指定してURL・title・本文・抜粋等を受け取る。 Sonar
  backendは置き換え、Sonarへのfallbackや旧result形式の互換readは追加しない。
- Exaは検索中心とし、親modelが取得資料から回答を作る。通常検索の既定は`auto`とhighlights取得。
  検索mode、件数、domain/path、公開日、category、objective、contents、deep query、構造化output等の
  現行API optionをtool argumentとして指定できる。公式の組合せ制約はguidelineで説明する。
  toolは完成したJSON結果を返すためtransport streamingは使わない。dynamic highlights／verbosityを
  指定した場合は公式の`Exa-Beta` headerを付ける。
- 既知URLは`web_fetch`で読む。任意の`save_to`を指定するとPDF・ZIP・画像等の元のバイト列を
  streamでファイル保存する。保存時には本文表示用の1 MiB制限を適用せず、成功結果には保存先、
  最終URL、HTTP status、Content-Type、保存byte数を返す。
- 保存先は`/tmp`またはSessionのworkspace内に限定する。相対pathはworkspace基準とし、`..`と
  symlinkを解決した実際の保存先・親を確認し、範囲外なら取得・作成前にエラーを返す。
- 第1段階は既存`authProfile`／credential file resolver／認証済みrequest seamを使い、
  `exa-api-key`からrequest時にキーを解決する。Definition、tool引数、会話、短いfactへキー値や
  Authorizationを含めない。TUIからの登録は173で実装する。

既存の保存先は上書きせずtoolがエラーを返す。AIはその結果を受けて別の`save_to`を選び、再実行する。
利用者の選択「エラーにし、別の保存先を選ぶ」に対応する。保存中断・失敗時のpartial
fileは自動削除しない。

toolのエラーメッセージは英語とする（利用者指定、2026-10-03）。

## 根拠・現行product経路

要件は2026-10-03の会話。A17の2026-09-27の選択もExa API直結であり、Exa MCPではない。
公式契約は[Exa Search](https://exa.ai/docs/reference/search)、
[Exa Contents](https://exa.ai/docs/reference/get-contents)を2026-10-03に確認した。 Exa
Searchは`POST /search`、Bearer認証にも対応し、`results`、任意の`output`等を返す。
通常resultは原文抽出と合成summary/outputを区別して保持する。`people`／`company`の
公開日・excludeDomains制約等は公式契約に従う。Contentsを使う新しいfetch経路は本incrementに含めない。

通常経路はTUI入力 → CoreのSession/Execution → 親Workerのmodel call → Registry → bundledまたはmanaged
tool Definition → `web_search`／`web_fetch` → tool result → 親model継続 →
Coreのsemantic履歴保存である。tool Definitionのexact revisionが実行へ帰属する。 SonarはWorker-local
request seam経由でOpenRouterの補助modelを呼び、回答＋citationを返していた。
Exaは非modelの検索requestなのでSonarのmodel selection・model request budgetを流用しない。
物理requestの順、provider、API、step、HTTP／error／解析項目は既存の短いfact経路へ記録する。
検索引数・結果の正本は既存のtool semantic履歴であり、Exaのraw requestを二重常設保存しない。

`web_fetch`は現在GETによるHTTP取得とHTML→text変換を行い、binaryはmetadataだけを返す。
保存機能は同じtool内に追加し、workspaceは既存Definition bindingから受け取る。

## 実装・確認計画

1. `web_search.ts`とbundled Definition、公開export、直接runtime、関係する既存fixtureをExa
   contractへ切り替える。 APIの結果をtoolへ返し、source
   URLで引用し、必要な既知URL取得には`web_fetch`を使うguidelineを定める。
2. `web_fetch`へ`save_to`とworkspace
   bindingを追加し、指定範囲へのbinary保存とmetadata返却を成立させる。
3. focused確認で、親→Exa検索→親の継続、option転送、credential非露出、HTTP／解析fact、cancel、
   binaryの完全保存、workspace／tmp path境界、既存本文取得を確認する。Sonar
   fixtureを外部仕様として残さない。
4. 変更対象のtype check、format、lint、`git diff --check`を行う。full gateは計画しない。
5. 実Exa確認は対象・回数・保存先を提示して別途明示承認を得る。未確認のままproduction受入完了としない。

local HTTPと隔離workspaceでのダウンロード確認、および実Exaへのauto/deep検索は確認済み。 production
TUIでの人間による利用結果は未確認。 関係のないprovider
bug、一般的hardening、追加input上限やfallbackは対象外。

## 正本への反映案

architectureのSonar固定backend記述とroadmapのSonar実装状態を、Exa検索・非model requestと web_fetch
downloadへ更新する必要がある。対象・理由・意味変更は本書に留め、別途承認前には反映しない。

## 結果

- `web_search`を`ExaWebSearchBackend`へ切り替え、bundled Definition、直接runtime、公開API、package
  includeを更新した。Sonar runtime実装と固定model selectionは除去した。
- `exa_search_schema.ts`で検索mode、domain/path、公開日、category、深い検索、objective、outputSchema、
  contentsのtext／highlights／summary／extras／freshness等をmodelへ提示する。 API
  result全体を完成したJSONとして返し、空resultsと任意outputも保持する。
- Exaは`exa-api-key`をrequest時に解決し、親modelのcredentialを使わない。物理request factに
  `provider=exa`／`api=exa-search`を記録し、modelId／effort／親modelのwire-context
  ordinalを付けない。 model request budgetをclaimせず、検索arguments/resultはtool履歴の経路を使う。
- `web_fetch`の任意`save_to`をbundled Definitionと直接runtimeのworkspace bindingへ接続した。
  元のresponse bytesをstream保存し、metadataを返す。既存fileはfetch前に英語のエラーを返し、
  AIへ別の保存先でretryするguidelineを与える。中断は成功扱いにせず、partial fileは残す。
- A17とA6の採用範囲を通常利用メモから移し、173の採用要件とhandoff pointerを用意した。
  構想・architecture・roadmapは変更していない。

### local確認

関連focused testはすべて成功した。件数は結果の記録であり受入条件ではない。

| 対象                                         | 結果・確認した動作                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Increment 7 search                           | 7成功。親→Exa→親、physical3/model2、options・beta header、空result、短いfailure fact、cancel                                          |
| Increment 14 multi-provider                  | 24成功。Exa独立credentialとOpenAI rootの既存経路                                                                                      |
| Increment 16 instruction                     | 4成功。検索toolとinstruction合成                                                                                                      |
| current_code                                 | 17成功。更新されたtool contractとactive guidelineの合成                                                                               |
| Increment 170 S1 producer                    | 1成功。検索中もtoolの帰属を保持し、Exa request factを保存・参照                                                                       |
| Increment 172 download / 70 fetch / 133 body | 合計17成功。完全binary保存、loopback HTTPとbundled Definition経路、workspace/tmp境界、許可内symlink、既存file保持、中断、既存本文取得 |
| Increment 70 tool declaration                | 2成功。外部toolとDefinition解決の既存経路                                                                                             |

変更source、公開entry、Worker bootstrap、変更test、live probeのtype check、対象fileのformat／lint、
`git diff --check`を実施した。full gate、実model call、常用binary配置は実施していない。
実Exa確認の結果は下記へ記録する。

### 実Exa確認の対象・承認・結果

[`scripts/probe_increment_172_exa.ts`](../../scripts/probe_increment_172_exa.ts)を用意した。
2026-10-03に実行済み。bundled `web_search` Definition、production physical I/O、既存credential
resolver、Registryを使い、 `docs.deno.com`のDeno公式文書を対象にauto検索1回（3 results、default
highlights）とdeep検索1回 （2
results、text/highlights、additionalQueries、objective、構造化output）を行う。 Exa APIへの最大2
requestで、親model call・再試行は行わない。

保存先は`/tmp/henji-increment-172-exa-<生成suffix>/`。`tool-results.json`へ検索引数とtool結果、
`request-facts.json`へ短いrequest記録を保存する。credential値・Authorizationとraw wire
bodyは保存しない。 キーは既存の`<XDG_CONFIG_HOME>/henji-harness/exa-api-key`（XDG未設定なら
`$HOME/.config/henji-harness/exa-api-key`）から読む。file形式・private
permissionは既存resolverに従う。 本probeはAPI契約の実確認であり、production
TUIで人間が検索目的を完了した確認とは区別する。

```sh
deno run --no-prompt --cached-only --allow-read --allow-write=/tmp --allow-net=api.exa.ai \
  --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME --allow-sys=uid \
  --config deno.v0.json scripts/probe_increment_172_exa.ts
```

2026-10-03、利用者の「僕がファイルにキーを登録する　一旦それで確認しよう」により、
提示済みのauto/deep各1回・最大2 request・tmpへの記録で実確認を承認。
同日の「登録した」を受けて、登録済みkeyを既存resolverから読んでprobeを実行した。
キー値を会話・記録へ出さない。追加のrequestや親modelを伴う確認は、このprobeの範囲に含めない。

実行時刻: 2026-10-03 10:53頃（JST）。probeのexit codeは0。

| 検索 | HTTP | 取得した結果                                                                                           | API申告costDollars.total |
| ---- | ---- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| auto | 200  | 指定の3 results。Deno公式文書のtitle・URLと各ページのhighlightsを取得                                  | $0.007                   |
| deep | 200  | 指定の2 results。各ページtext 1,500文字・highlights、output.content.summaryとgrounding/citationsを取得 | $0.012                   |

物理requestは2、model request budgetの消費はparent=0／aggregate=0、再試行なし。 短いfactにはordinal
1/2、provider=exa、api=exa-search、modelStep 1/2、HTTP 200/200が保存され、 parser
failureはなかった。親modelのwire-context ordinalは付いていない。
保存した2ファイルにcredential値がなく、request factにAuthorization
headerがないことをreadbackで確認した。
API申告の参考値は合計$0.019。利用者から1000回程度の無料枠があるとの連絡を受けた。

保存したprobe artifact:

- `/tmp/henji-increment-172-exa-6837343ee96af6c9/tool-results.json`
- `/tmp/henji-increment-172-exa-6837343ee96af6c9/request-facts.json`

本確認は実Exa APIとbundled tool経路の確認である。実modelによる親turn、production
TUIでの人間による受入、 常用配置は行っていない。173の実装も利用者指定で保留のまま。

### 後続の配置

2026-10-03、利用者の173配置指示により、本incrementのExa検索・web_fetch downloadを含む
binaryを常用先へ配置した。build・配置先起動確認の記録は
[Increment 173の常用配置](increment-173.md#常用配置2026-10-03)を参照する。
人間の通常利用による受入は利用者の確認待ち。

2026-10-03の利用者のcommit/push指示により、172〜176をまとめて`c9b5d9d6`へcommitし、
`origin/main`へpushした。記録は[Increment 176](increment-176.md#commitpush2026-10-03)を参照する。

### A6の通常利用観測・完了判断（2026-10-06）

利用者の「A6は終わりでいいんじゃない？」と、完了扱い・文書整理の説明に対する「更新して」により、
A6を完了とする。Exaへの置換、search/fetch分離、downloadは本incrementで実装・配置済み。
credential登録は[Increment 173](increment-173.md)の共通`/login`経路を使い、
取得量の案内は[Increment 200](increment-200.md)で追加した。通常利用メモのA6一覧・本文を本書へ移し、
未採用候補として残さない。これはA6の完了判断であり、公開の実施を意味しない。

移設した保存履歴の観測（2026-10-05 Session `2bc2699f`、2026-10-06にread-only分析）:

- `web_search` 5件のresult bytesは1,349・2,152・18,218・19,758・**148,977**。最大のものは
  `contents: {text: true}` + `numResults: 2`でghostty.orgのoption reference本文144,402 bytesを
  1回のresultへ展開していた。指定どおりの取得でtoolの不具合ではない。
- 同じexecution内の以降の2回は`contents: {highlights: {maxCharacters: 5000, query: …}}`へ
  切り替えて1,349・2,152 bytesに収まった。schemaは`contents.text.maxCharacters`も持つ。
  200でhighlights推奨、textの上限指定、長文の`web_fetch.save_to`とfile経由の読取を案内した。
- 同5件のExa費用（responseの`costDollars`）はいずれも`total 0.007`（USD、neural search）。
  この5件では`contents`指定によるExa課金差は見えず、149 KBの取得量はmodel context側の負担となる。
  旧メモの約3.5–4万tokenという値は概算であり、実token usageの測定値ではない。

旧A6にあった追加候補・再検討条件も記録として移設する。これらは未実装の必須作業として扱わず、
現backendの品質・費用・取得範囲やsearch/fetchの使い分けに具体的な問題が出た場合に改めて採否を決める。

- 取得内容とcitation/provider evidenceの相関、追加stepと経路の明示性を実taskで比較する。
  filesystem探索、複数endpoint試行、shell quoting、temporary file、別commandでの再読込が
  連なる発見・取得経路の品質・コストを観測する。
- OpenAI Responses API built-in Web searchやOpenRouter `openrouter:web_search`と現行Exaを比較する。
  必要なら`WebSearchBackend`境界への追加を検討し、同時公開するtoolには品質・費用・検索範囲等の
  選択理由を説明できるcontractを持たせる。
- Web searchを別Agent実行にする案は、conversation・prompt・model・tool利用を独立所有する必要が
  出た場合だけ比較する。
