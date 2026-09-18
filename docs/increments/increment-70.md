# Increment 70 — tool宣言のDefinition統一とweb_fetch

ステータス: **計画中（要件確定、実装未承認）**

基準commit: `1ca21bcb`

計画日: 2026-09-18

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

### web_fetch（最初の追加identity、要件のみ）

- input `{ url: string }`。outputは本文＋final URL＋status＋content-type＋切り詰め有無。
- 振る舞い（HTTP取得、抽出、エラー表現）は**tool DefinitionのTS module**に置く。`henji-resource.json`は
  identity／contract／entry／digestのみを持ち、振る舞いや新しいstate・kind semanticsをJSONで表現しない。
- 物理挙動（redirect、body上限、content-type別抽出、error表現、許可host等）は実装時に別途計画する。
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
