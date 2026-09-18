# Increment 70 — tool宣言のDefinition統一とweb_fetch

ステータス: **実装完了（宣言・解決の一般化＋web_fetch。実provider probe未実施）**

基準commit: `1ca21bcb`

計画日: 2026-09-18

実装日: 2026-09-18

対象: Increment 69で導入したmanaged tool Definitionを、宣言・解決の両面で一般化する。tool identityの宣言は
**各Agent Definitionがowner**とし、Henji helperがDefinition由来の追加tool宣言とHost解決済みcomponentを扱える
ようにする。`tools.json`はbinding（どのexact revisionを使うか）だけを持ち、宣言は持たない。最初の追加identity
候補として`web_fetch`のmodel向けcontract要件を定める（物理挙動は実装時に別途）。

## 決定済みの要件（2026-09-18）

- **宣言のowner**: toolの可視性は各Agent Definitionのcapability宣言で決まる。root parentとsubagent（plannerを
  含む）を区別せず、各Definitionが自分が持つ`tool:<name>`を宣言する。plannerは`subagent:planner`という一つの
  subagentであり、特別扱いしない。web_searchがplannerに出ないのはbundled planner Definitionが宣言していない
  からであり、root/plannerという規則ではない。
- **Host configの責務**: `$XDG_CONFIG_HOME/henji-harness/tools.json`はtool identity → exact managed tool
  Definition revisionのbindingのみを持つ。default parentの宣言tool集合をconfigで拡張する要件は持たない。
- **人間が追加toolを使う方法**: 追加toolを宣言したAgent Definitionをauthoring/installしてrootに選ぶ。tool
  実装はmanaged tool Definition（bundledまたはexternal）としてinstall/bindする。
- **web_fetchのmodel向けcontract**: inputは`url`（必須）。outputは取得本文（text。markdown等の正規化は実装で
  定める）＋final URL＋HTTP status＋content-type＋切り詰め有無。抽出モード指定は初期要件に含めない。
- **web_fetchの物理挙動**: 要件のみ確定し、実装（redirect追跡、body上限、content-type別の抽出、許可host等）は
  実装時に別途計画する。

## 利用者が必要とする動作

- 人間は、追加tool identity（例: `tool:web_fetch`）を宣言したAgent Definitionをinstallしてrootに選ぶことで、
  bundled default parentをコード変更せずに拡張できる。
- Henji helper（`createDefaultAgentComposition`）を使うDefinitionが、bundledの固定tool一覧に加えて自分の
  追加`tool:<name>`を宣言し、Hostが解決したtool Definition componentをregistryへ合成できる。
- Hostはroot Definitionが宣言する`tool:<name>`ごとに、`tools.json` binding > bundled tool Definitionの順で
  exact revisionを解決し、Worker start commandへ渡す。binding解決失敗はtyped failureとし、bundledへ暗黙
  fallbackしない。宣言されているが解決できないidentityは起動前に失敗する。
- 追加toolはIncrement 69と同じattribution（manifest／execution artifactの`tools` exact ref、provider evidence）
  を持つ。
- 既存の`web_search`とbundled default parentの動作は退行しない。

## 計画（未承認）

### helperと宣言の一般化

- `ExecutableAgentDefinitionInput`／`AgentCompositionOptions`へ、Definition由来の追加tool identityと、Host解決
  済みのtool Definition componentを受け取るseamを追加する。helperはそれを`createDeclaredRegistry`の宣言と
  `toolDefinitions`へ反映し、bundledの固定tool一覧と合成する。
- `defaultAgentDefinition`の固定一覧はbundled default parentの宣言として維持し、Definitionが追加宣言した
  identityだけを上に足す。Declarationはdata-only resource identityとしてmanifestへ記録する。
- registryの宣言整合（`tool:<name>`宣言とDefinition/componentの対応、未解決identityの拒否）を一般化する。

### Host解決の一般化

- `resolveToolDefinitions`を`tool:web_search`固定から、root Definitionが宣言する`tool:*`一般へ広げる。ただし
  Hostはroot Definitionを評価しないため、bundled tool Definition manifestの一覧から宣言identityを解決する。
  実装時は「bundled tool Definition一覧」と「`tools.json` binding一覧」のどちらをHostが先に知るかを、root
  Definition評価順とstart command構築の順序に合わせて決める。
- 新identityのbundled moduleが無い場合はexternal bindingを要求し、無ければtyped failureにする。

### web_fetch 物理挙動（計画）

- **取得**: 素のHTTP GET（credentialなし）。`redirect: 'follow'`。任意のpublic URLが対象。
- **request**: `GET <url>`、`Accept: text/*, application/json, application/xml;q=0.9, */*;q=0.1`、
  User-Agent `henji/<version>`。timeoutは既存provider deadline（`providerTimeoutMs`）または専用の固定値を用いる。
- **response**: HTTP status、final URL（redirect後）、content-type、本文bytesを得る。本文は1 MiB上限で読み、
  超過時は打ち切って**切り詰め有無**を返す（tool errorにしない）。
- **content-type**: `text/*`、`application/json`、`application/xml`、`+json`／`+xml`はUTF-8としてdecodeする。
  それ以外（binary）は本文を返さず、status・content-type・final URLのみをメタとして返す。
- **model向けoutput**: 先頭に`URL`／`Status`／`Content-Type`／`truncated`のメタ、続けて本文（text-ishの場合）。
- **error**: 非2xxはstatusを含むtool error、network失敗・timeout・invalid URLはtool error。本文を返さない。
- **net権限**: 任意hostへのfetchにはDenoのnet許可が必要。compiled binaryとdev taskの`--allow-net`を拡張する
  （無制限、または許可host宣言）。この権限はweb_fetchの目的そのものであり、hard sandbox（R3）とは別。
- **対象外（初期）**: HTML→Markdown等の本文抽出、JavaScript実行、robots遵守、caching、認証付き取得、
  private/localhost/内部IPの拒否（SSRF hardening。明示要求があるまで追加しない）。
- **配置**: bundled tool Definition `worker_builtin_web_fetch_tool.ts`（identity `tool:web_fetch`）として実装し、
  bundled default parentが宣言するか、external root Definitionが宣言するかはHuman Gateで決める。


### web_fetch contract（確定）

- input `{ url: string }`。outputは本文＋final URL＋status＋content-type＋切り詰め有無。
- 振る舞い（HTTP取得、抽出、エラー表現）は**tool DefinitionのTS module**に置く。`henji-resource.json`は
  identity／contract／entry／digestのみを持ち、振る舞いや新しいstate・kind semanticsをJSONで表現しない。
- 実装は本incrementの後半または後続incrementに分けてよい。

### 責務の切り分け（TS Definitionの境界）

- TS tool Definitionがcustomizeできるのは、Worker内で完結する**振る舞い・composition**である。使えるAPIは
  `@henji/agent`とWorker permissionの範囲に限られ、credential値とHost-owned durable stateには到達しない。
- **durable state**（restart／Session再開をまたぐ記憶、cache、instance単位の可変state）と**新しいresource kindの
  semantics**（identity、selection authority、execution placement、lifecycle、durability、evidenceの規則）は、
  Henji本体とarchitectureがownerである。Definitionのclosureはgeneration単位で評価され捨てられるため、
  Definition自身はこれらを追加できない。必要になった場合は別途incrementで本体・architectureを拡張する。

## 対象外

- Host configによる宣言の拡張（`tools.json`はbindingのみ）。
- `bash`／`read`／`write`／`edit`／`bash_output`のtool Definition化（後続）。
- tool Definition transport（export/import）、remote registry、hot reload、remove/GCの高度化。
- `web_fetch`以外の新identityの同時実装。
- generic model層のannotation/citation対応、provider-native server tool。
- workspace scope binding、manifest dependency bindingとactivation bindingの優先規則。

## Verification

- focused test: helperがDefinition由来の追加tool宣言＋Host解決済みcomponentを合成すること、`tools.json` binding
  経由でexternal tool Definitionが追加identityへmaterializeされること、宣言されているが未解決のidentityが
  typed failureになること、bundled defaultの退行がないこと、manifest／artifactの`tools` attribution。
- web_fetch実装時: url→本文＋メタのcontract、redirect／body上限／content-typeの扱い、error表現。
- 既存回帰: Increment 69のweb_search、subagent slot binding、artifact schema、history。
- type check、format、lint、`git diff --check`。authoritative `v0:gate`は安定候補で1回。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. 宣言tool集合のownerを各Agent Definitionに統一し、`tools.json`はbindingのみとする。
2. Henji helperがDefinition由来の追加tool宣言＋Host解決済みcomponentを合成できるよう一般化する。
3. Hostは宣言された`tool:*`をbinding > bundled moduleの順で解決し、未解決はtyped failureとする。
4. `web_fetch`のcontract（url→本文＋メタ）を採用し、物理挙動は実装時に別途計画する。
5. roadmapのIncrement 70記載を本計画へ合わせて更新する。

## 結果（2026-09-18: 一般化まで）

- tool宣言のownerを各Agent Definitionへ統一した。`defaultAgentDefinition`の固定一覧はbundled default parentの
  宣言として維持し、Henji helper（`createDefaultAgentComposition`）が`AgentCompositionOptions.additionalTools`で
  Definition由来の追加`tool:<name>`を宣言できるようにした。helperは宣言identityをcapabilityと
  resourceSelection（sort・dedupe）とmanifest resourcesへ反映し、Host解決済みの`input.toolDefinitions`
  componentをregistryへ合成する。
- Host解決を一般化した。`resolveToolDefinitions`はbundled tool Definition一覧（現在`tool:web_search`）と
  `tools.json` binding一覧を解決し、bundled identityはbinding > bundled module、非bundled identityはbindingの
  exact revisionを`WorkerToolDefinitionLoadRequest`として渡す。registryはDefinitionが宣言したidentityだけを
  materializeし、`tools.json`はbindingのみを持つ。
- `worker_definition_revision.ts`のbundled tool Definitionを一覧化し、`bundledToolDefinitionLoadRequest(identity)`
  を追加した。
- 検証: 新規`tests/v0/increment_70_tool_declaration_test.ts`（2件）を`v0:test`へ追加。additionalTools宣言の
  合成とmanifest／capability反映、非bundled identityのbinding解決を確認。authoritative `v0:gate` exit 0。
- 未着手: `web_fetch` tool Definition本体（物理挙動は別途計画）。他work toolのDefinition化とtransport。

## 結果（2026-09-18: web_fetchまで）

- bundled tool Definition `worker_builtin_web_fetch_tool.ts`（identity `tool:web_fetch`、resourceId
  `builtin/web-fetch`）を追加し、bundled default parentの宣言一覧へ`tool:web_fetch`を加えた。HostはIncrement 69の
  一般化済み解決でbundled moduleを渡す。
- 実装: `v0/agent/tools/web_fetch.ts`の`createWebFetchTool(fetcher?)`。素のHTTP GET（`redirect: follow`、
  timeout 30s）、1 MiB上限で本文を読み切り詰めを表示、`text/*`・`application/json`・`application/xml`・
  `+json`／`+xml`はUTF-8 decode、HTMLはscript/style/comment除去＋tag除去＋空白正規化の最小text抽出、非
  textualはメタのみ。非2xx・network失敗・invalid URLはtool error。
- net権限: compiled binaryと`agent:run`／`agent:tui`／`agent:sessions`の`--allow-net`を無制限へ変更。
- 検証: 新規`tests/v0/increment_70_web_fetch_test.ts`（4件）。default tool一覧・active guideline・
  fresh-runtime comparison identity・compile権限の既存test期待を更新。authoritative `v0:gate` exit 0。
- 実provider probe（利用者許可、2026-09-18): isolated XDGの`henji run`で、modelが`web_fetch`を呼び
  `https://example.com/`を取得。status 200、`text/html`、本文「Example Domain …」抽出、`truncated:false`を返し、
  `I70_PROBE_OK`を出力してexit 0。web_searchは不要のため未使用。
- 未着手: 他work toolのDefinition化とtool Definition transport。

