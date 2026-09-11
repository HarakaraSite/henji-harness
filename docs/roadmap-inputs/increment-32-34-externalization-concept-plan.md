# Henji外部化の概念とIncrement 32〜34計画案

ステータス: **利用者判断と参照実装比較をarchitecture・roadmapへ反映済み・第三者review完了 — 個別Increment計画と実装は未承認**

作成日: 2026-09-11

照合基準commit: `fb8e04a0`

## この文書の目的

Henjiをstandalone executableにし、Agent Definitionを最初のmanaged resourceとして外部から改訂・登録できる
ようにする前に、Henji全体で「外部化」が何を意味するかを明確にする。Agent Definitionやtoolは例であり、
現行componentを外部化可能なresource、すでに外部にあるinput/state、binary内へ残すplatform authority、
外部化前に追加検討が必要な境界へ分類する。すべてのSurfaceを最初のIncrementで実装するのではなく、後続
Incrementを追加してもidentity、永続authority、binaryとの互換関係を作り直さずに済む境界を定める。

この文書は次をまとめたarchitecture・roadmap反映の入力兼、未承認の個別Increment計画資料である。

- Henji全体の外部化対象と、外部化しないplatform authority。
- managed resource外部化に共通する不変条件。
- 最初の対象であるAgent Definition外部化の具体的なcontract。
- binary、managed store、Session、workspaceの責務分離。
- Definition revisionとHenji binary更新の関係。
- revision喪失、旧revision利用、別PC移送を段階的に実装する方法。
- Increment 32、33および提案する後続Increment 34の範囲。

利用者の承認を受け、共通概念とIncrement 32〜34のroadmap境界はarchitecture・roadmap正本へ反映した。次に
採用内容を個別Increment文書へ分ける。最新差分の第三者reviewと一回の差分再reviewは完了している。個別Increment
計画と実装の承認は、今回の正本変更とは分けて扱う。

## 参照する正本とactive source

- [`../concepts/experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)
- [`../architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)
- [`../roadmap.md`](../roadmap.md)の「Self-revision Cycle 1前段 — 配布とDefinition revision基盤」
- [`../research/externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)
- [`increment-32-33-initial-plan-review.md`](increment-32-33-initial-plan-review.md)
- [`../../v0/agent/worker_agent_api.ts`](../../v0/agent/worker_agent_api.ts)
- [`../../v0/agent/worker/worker_bootstrap.ts`](../../v0/agent/worker/worker_bootstrap.ts)
- [`../../v0/agent/worker/worker_capsule.ts`](../../v0/agent/worker/worker_capsule.ts)
- [`../../v0/agent/session/session_store_contract.ts`](../../v0/agent/session/session_store_contract.ts)
- [`../../v0/agent/session/session_record_codec.ts`](../../v0/agent/session/session_record_codec.ts)
- [`../../v0/agent/worker/worker_execution_artifact.ts`](../../v0/agent/worker/worker_execution_artifact.ts)

## 外部化対象の全体像

### 「外部化可能」の意味

ここで外部化可能とは、Henji binaryを再buildせずに、内容をimmutable revisionとして登録し、人間が選択・
採用したexact revisionを後続のWorker generationから利用できる設計対象であることを指す。今すぐloaderや
Surfaceを実装することや、Agentが自動採用できることは意味しない。

Henjiのsourceを変更できることと、managed resourceとして外部化できることも区別する。platform coreはsourceを
改訂して新しいbinaryをbuildできるが、実行中Henjiが管理・置換するresourceにはしない。

### managed revisionとして外部化可能にする対象

| 対象 | 外部化する内容 | 現在地と初回実装 |
| --- | --- | --- |
| Agent Definition | compositionを構築するexecutable Definitionとlocal closure | Increment 33で最初に実装するresource kind |
| Instruction / policy component | role instruction、tool利用指針、仕事の進め方などのdataまたはmodule | 現在はbuilt-in `InstructionComponent`。独立revision、合成順、適用範囲を後続Incrementで定義する |
| Tool component | provider向けname・description・input schema、利用指針、Worker-local handler | 現在はexternal parent Definitionによるbuilt-in toolのsame-identity replacement。独立したtool revisionは後続Incrementで扱う |
| Skill package | instruction本文、metadata、必要な同梱resource | 現在のnative discoveryをzero-install互換経路として維持する。managed化はexact pin、transport、Definition bindingが必要な場合の追加経路とし、`SKILL.md`等のsource-nativeな表現をpayloadとして保持する |
| Model profile / catalog | provider/model ID、effort mapping、既定selectionなどのdata | credentialやtransport実装とは分け、data revisionとして外部化できる |
| Subagent Definition / delegation topology | child Definitionのexact refとdelegation構成 | 一つのDefinition closureへ埋める形から、exact managed dependencyとして分離できる |
| Prompt template / theme等のSurface data | 人間が編集・選択できるprompt断片、色・表示token等のdata | Host lifecycleを実行するcodeとは分け、data resourceとして外部化できる |
| Integration declaration | MCP server、HTTP connection、schedule、channel、outbox等の宣言と相互ref | native protocol・registry・configとの互換経路を置換しない。exact pinが必要な宣言だけを後続Incrementでmanaged化し、credential値とeffect実行を分離する |

この一覧は閉じたallowlistではない。新しい対象は、resourceのcontent、contract、dependency、activation、evidenceを
定義したうえで追加できる。

#### native discoveryとHenji独自instruction

`AGENTS.md`と`SKILL.md`は、所定のworkspaceまたは利用者scopeへ配置すれば起動時に検出・適用できるnative
discovery経路を維持する。Henji独自のinstallを通常利用の前提にしない。互換性には、元fileを読めることだけでなく、
配置、discovery、activationの操作が一致することも含める。

Henji独自の`InstructionComponent`は、nativeに発見した`AGENTS.md`やSkillとは別のresource kindとauthorityにする。
最終的に同じprovider instructionへ合成されても、少なくとも次を混同しない。

- `AGENTS.md`: workspaceが所有し、native discoveryで適用する現在入力。
- workspace/user Skill: source-nativeな`SKILL.md`と関連fileをnative discoveryで適用する入力。
- managed Skill revision: exact pin、transport、Definitionからのbindingを必要とするときに、人間が任意で採用する
  immutable snapshot。native Skillを利用するための必須operationではない。
- Henji Instruction revision: HenjiのAgent compositionが明示的に参照する、独自contractのmanaged component。

native inputをSessionやevidenceへ相関するためにsource、scope、content digestを記録しても、それをmanaged installや
active bindingとは呼ばない。native版とmanaged版が同時に見つかった場合の合成順、shadowing、重複identityは、Skill
またはInstructionを実装する個別Incrementで明示し、managed版がnative版を黙って置換しない。

#### Tool callに関する現在地

toolについては、次の四つを区別する。

1. toolのprovider向けdefinition: name、description、input schema。
2. tool利用指針: いつ、どのように使うかをsystem instructionへ合成するmetadata。
3. tool handler: tool callを解釈し、結果を返すWorker-local code。
4. tool call/result: 一回の実行recordとしてSession transcriptとevidenceへ残るdata。

1〜3は外部化可能なtool resourceの候補であり、4は外部化するmoduleではない。将来、4にはどのexact tool
revisionが処理したかを相関できるようにする。

現行`@henji/agent` APIでは、external parent Definitionが`createDefaultAgentComposition`を使う場合、固定された
built-in tool membershipを継承し、既存の`read`、`write`、`edit`、`bash`、`bash_output`、`web_search`と同じ
identityの`ToolComponent`実装だけをroot compositionで置換できる。新しいtool identityの追加や、planner rootでの
replacementには対応しない。Increment 33でreplacement codeをDefinitionのrelative closureへ同梱すれば、
Definition revisionの一部として固定できる。ただし独立tool revisionをinstall・共有する機能ではなく、これは
後続のtool resource外部化で扱う。

#### MCPに関する現在地

MCP 2026-07-28は、Henji側clientとserverの間でprotocol version、capability、tool、resource、prompt等をやり取りする
protocolを定める。serverの`server/discover`はversion、capability、任意の自然言語instructionsを返し、tool等は
`tools/list`、`resources/list`、`prompts/list`で実行時に列挙できる。公式MCP Registryは公開serverについて
`server.json`によるpackage/remote location、実行引数、環境変数等の配布metadataを定めるが、現在previewであり、
`AGENTS.md`のような全Host共通のlocal project配置・自動activation規約とは別である。

Henjiでは次を別authorityとして扱う。

| MCP要素 | Henjiでの分類 |
| --- | --- |
| MCP protocol client、version negotiation、transport adapter | 当初はbinary側platform capability。provider adapter等と同様、外部化には別architecture判断が必要 |
| server connection declaration | XDG configまたはworkspace input。互換性のあるregistry/config metadataはnative表現のまま利用し、接続にHenji managed installを必須にしない |
| credential、token、環境固有endpoint override | XDG Configまたは外部credential authority。portable artifactへ含めない |
| local server packageまたはremote server | Henji外で配布・稼働するprogram/service。MCP接続だけを理由にHenji managed storeへcodeを複製しない |
| serverが公開するtool、resource、prompt、instructions | MCP越しに発見するruntime projection/input。個々をHenji tool/Instruction revisionとして自動installしない |
| tool call/result、resource read、prompt取得、server/capability identity | Sessionとexecution evidenceへ残す実行record |

将来、MCP connection declarationやlocal server packageをexact revisionとして固定・transportする需要が確認された
場合は、Integration resourceの個別Incrementでmanaged pathを追加できる。その場合もMCP native connectionを置換せず、
MCP server revision、接続設定、実行時capability snapshot、credential、call/resultを一つのartifactへ混ぜない。
Increment 32〜34ではMCP clientやMCP resource kindを実装せず、共通identity envelopeがこの分離を妨げないところまでを
扱う。MCP client、transport、dispatchの物理配置はここでは固定せず、後続Integration Incrementで決める。

公式根拠:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [`server/discover`](https://modelcontextprotocol.io/specification/draft/server/discover)
- [Tools](https://modelcontextprotocol.io/specification/draft/server/tools)、
  [Resources](https://modelcontextprotocol.io/specification/draft/server/resources)、
  [Prompts](https://modelcontextprotocol.io/specification/draft/server/prompts)
- [MCP Registry](https://modelcontextprotocol.io/registry/about)

### すでにbinary外にあるがmanaged resourceとは異なるもの

| 対象 | 分類 | 理由 |
| --- | --- | --- |
| credentialと利用者config | XDG Config | secretやmutable preferenceであり、portable module artifactへ含めない |
| Session、canonical transcript、context checkpoint | XDG State | conversationのdurable truthであり、実行定義ではない |
| provider evidence、failure diagnostic、execution artifact | XDG State | 観測・診断recordであり、resource revisionではない |
| workspace file、`AGENTS.md` | workspace input | workspace所有の現在入力であり、install済みmoduleの正本ではない |
| 現行workspace skill | workspace input | 将来managed skillを追加しても、現在のworkspace版とは別のauthorityとして扱う |
| `AgentInstance` | durable Host state | 後続Phaseでactive Definition bindingを所有するが、実行可能resource自体ではない |
| active provider/model/effort selection | 現在はSessionのdurable state | managed model profileを導入してもactive bindingはrevision artifactではない。将来SessionとInstanceのどちらが所有するかは対象Incrementで決める |
| 評価後`AgentManifest` | runtime projection / evidence | compositionの説明であり、portable `ManagedResourceManifest`やadmission authorityではない |
| 個々のtool callとtool result | transcript / evidence | toolの一回の呼出しと結果であり、外部化するtool定義・実装そのものではない |
| resource instanceのmutable state | activation scopeに対応するdurableまたはephemeral state | toolのindex/cache、extension固有設定、長時間process状態等。immutable revision、active binding、Session transcriptのいずれとも同一視しない |
| `AgentComposition`、Worker generation、未commit turn、TUI draft | ephemeral state | process、Worker generation、turnのlifetimeに閉じる |

### managed externalizationの対象にしないplatform authority

次はHenjiがexternal resourceを解決・実行・記録するための基準なので、現在のarchitectureではmanaged resource
としてhot-loadまたはself-replaceしない。変更するときは新しいHenji binaryをbuild・導入する。

- Host coordinator、Worker lifecycle、admission、generation fencing。
- Worker bootstrap、capsule、Host / Worker protocol。
- canonical Session ownership、atomic turn commit semantics、永続schema codec。
- managed resourceのloader、canonical digest、manifest verifier、physical resolver。
- `@henji/agent`その他のembedded resource API facadeとcontract negotiation。
- credential resolverと、credentialをmodule codeへ渡さない物理binding。
- build manifest、`--version`、最低限のCLI・diagnostics・built-in recovery Definition。

この区分はplatform coreの自己改訂を禁止するものではない。coreの改訂単位をmanaged moduleではなくHenji binary
revisionとする、という配布・authority上の区別である。

### 外部化する前に追加のarchitecture判断が必要な対象

| 対象 | 先に決める境界 |
| --- | --- |
| Toolのphysical I/O backend | Worker-local handler、Host RPC、subprocessのどこでfilesystem・process・network effectを実行するか |
| Provider adapter / transport | credential binding、request/streaming、parser、evidence、model profileとの分離 |
| Context / compaction policy | canonical transcriptを変更せずprovider投影だけを変更する境界、checkpoint authority |
| Agent loop strategy | 外部化可能なstep/tool scheduling policyと、embeddedのcancel・commit・failure semanticsの境界 |
| Human Gate / enforcement policy | 外部instructionによる作業指針と、Hostが強制する採用・承認境界の区別。Agent自身がgateを無効化しないauthority |
| Surface extension code | slash command、keybinding、message/tool renderer、panel/widget等と、Host-side terminal/UI lifecycle、Session binding、置換時のlocal state引継ぎ |
| Storage backend | SQLite等のmechanismを交換してもcanonical ownership、schema、atomic commitを変えないinterface |
| remote registry / distribution | local install・export/importと、配布元identity、取得、更新通知の境界 |
| Trigger / integration runtime | MCP、HTTP connection、webhook、schedule、channel、outbox、background jobの宣言と、credential binding、delivery、retry、idempotency、durable stateの境界 |

これらを「外部化不能」とは決めない。ただしAgent Definitionと同じloaderへ載せるだけでは責務が決まらないため、
対象を採用する個別Incrementでarchitectureへ戻る。

### managed resourceに共通する不変条件

resource kindごとのloaderとruntime contractは異なってよいが、次は共通にする。

1. logical identityはmachine、source path、XDG root、binary配置pathに依存しない。
2. original sourceはinstall inputとprovenanceであり、install後のruntime authorityではない。
3. immutable revisionのinstallとactive selection・binding transitionは別operationにする。
4. managed resourceはkind固有のAPI contract identityと、実行に必要な自己完結contentを持つ。
5. 他のmanaged resourceへ依存する場合、manifestがkindに依存しないsemanticな`ResourceSlotIdentity`とexact
   `ManagedResourceRef`のbindingをpinし、そのdependency binding listもrevision identityへbindする。Agent
   composition内では`AgentResourceIdentity`を`ResourceSlotIdentity`のkind固有表現として使う。暗黙の`latest`へ
   解決しない。
6. activation authorityが選んだroot resource setから到達するtransitive graphを、そのgraphを使うWorker、Host、
   subprocess、client等のgenerationがactiveになる前に解決し、実行証拠からreadbackできる。Increment 33ではroot
   resource setが一つのAgent Definitionであり、Worker起動前に解決する。
7. resource欠損、破損、contract非互換時に別revisionまたはbuilt-inへ黙ってfallbackしない。
8. artifactの保管、別installationへのtransport、active adoption、rollbackを別のlifecycle operationとして扱う。
9. resource kind、content contract、activation authority、実行placementが異なるものへ、同一loaderや同一Human
   Gateを推測で強制しない。
10. `AGENTS.md`、`SKILL.md`等のnative discovery規約を持つ自然言語resourceは、所定の場所へ置くだけで検出・適用
    できるzero-install経路を維持し、相互運用可能なsource-native fileとdirectory layoutをproprietaryなHenji
    表現へ変換しない。managed化するkindでは元file setをrevision payloadとして保持し、digest、logical identity、
    dependency、custody、active bindingを外側のmanaged envelopeで管理する。

`AGENTS.md`は引き続きworkspace所有の現在入力であり、Henji managed storeへ自動installしない。Skill等を将来
managed resourceとして扱う場合もnative discoveryを通常経路として残し、他のharnessや人間が読める元fileを保持
する。Henji固有の採用状態やexact refを本文へ埋め込まずsidecar manifestへ置くため、managed custodyはformatと
discoveryの互換経路を置換しない。

Increment 32では、将来のresource kindを表現できるversioned logical identity envelope、logical refとphysical
descriptorの分離、XDG managed data namespace、build/API contract attributionまでを共通基盤として確定する。
ただし汎用plugin loaderを先に作らず、Increment 33でAgent Definitionだけを最初の実装済みresource kindにする。

将来の概念形は次のとおりである。

```text
ManagedResourceRef
  resourceKind
  resourceId
  revisionDigest

ManagedResourceManifest
  logicalRef
  resourceContractIdentity
  exactResourceBindings[]
    resourceSlotIdentity
    managedResourceRef
  kindSpecificContentIdentity
```

`ResourceSlotIdentity`は依存元contract内のsemanticな役割名、`ManagedResourceRef`はその役割を提供するexact
artifact revisionであり、同じものではない。Agent compositionでは現行の`AgentResourceIdentity`をkind固有表現に
使い、`tool:read`や`instruction:henji-common`を表す。他のkindは、例えばconnection、storage、Surface等に対応する
semantic slotを自身のcontractで定義する。初期Agent Definition revisionでは`exactResourceBindings`を空にできる。
後続で独立tool、instruction、skill、subagent等を参照するときは、能力名からexact refへのbindingをDefinition
revisionへ含める。これによりresource依存先を変更した場合はDefinitionも別revisionとなり、同じDefinition refが
異なるresource graphを実行しない。

ここで`ManagedResourceManifest`は、portableでimmutableなrevision artifactのidentity、contract、exact dependencyを
記録するinstall・resolution上のauthorityである。Definitionを評価して得る現行の`AgentManifest`は、実行時の
compositionを説明してSessionやevidenceへ残すprojectionであり、同じmanifestではない。また、一つのroot graph内で
dependency bindingの競合keyはconsumerのexact `ManagedResourceRef`と`ResourceSlotIdentity`の組とする。同じconsumer
slotへ複数のexact refが競合した場合は暗黙に優先順位を付けず、graph resolutionを失敗させる。異なるconsumerが
同じlocal slot名を使うことは競合ではない。root間で共有するactivation-level slotが必要になった場合は別namespaceを
定義する。

### 分類と直交して記録する属性

同じresource kindでも、どこから選ばれ、どこで動き、どの期間状態を持つかによって外部化contractは変わる。
4分類だけでloaderやactivation semanticsを決めず、個別resourceには少なくとも次を明示する。

| 属性 | 区別する値の例 |
| --- | --- |
| scope / activation owner | installation、workspace、AgentInstance、Session、turn |
| execution placement | Host、Worker、subprocess、client、remote service |
| lifecycle | install、select/bind、activate、reload、rollback、remove |
| durability | immutable revision、mutable config、resource instance state、ephemeral runtime |

source discovery時のglobal/workspace等の明示的なlayeringと、解決済みexact graph内のidentity競合も区別する。前者は
resource kind固有のselection ruleで一つのbindingへ正規化できるが、後者には暗黙の優先順位を適用しない。

## 1. 外部化の概念

### 1.1 外部化とは何か

Agent Definitionの外部化とは、Henji executableを再buildせずに、任意pathのAgent Definition sourceを一つの
immutableな`DefinitionModuleRevision`としてHenji管理下へ取り込み、そのexact revisionを選んで
実行できるようにすることである。

```text
任意pathのsource
  │ install input。由来であり、実行時の正本ではない
  ▼
DefinitionModuleRevision
  │ self-containedなclosureとmachine/path非依存のlogical identity
  ▼
managed store
  │ そのHenji installationにおけるlocal custody
  ▼
DefinitionRevisionRefをSessionまたはInstanceが選択
  ▼
Henji binary内のWorkerと@henji/agent APIで実行
```

external Definitionを取り込むことは、Henji executableへcodeを再埋込みすることではない。binaryと
external revisionは別々にversion管理される。

### 1.2 built-inとexternalの二層

- built-in default/planner Definitionは、Henjiが起動するためのbaselineとしてbinaryへ埋め込む。
- external Definitionはmanaged storeへ保存し、binaryへ再埋込みしない。
- external revisionのinstallは新しいartifactを登録するだけであり、実行中Worker、既存Session、将来の
  AgentInstance bindingを変更しない。
- external revisionのloadに失敗しても、黙ってbuilt-inへfallbackしない。選択したidentityと実際に
  実行したcodeが食い違うためである。
- 人間は新しいSessionをbuilt-inまたは特定のexternal exact revisionから明示的に開始できる。

### 1.3 authorityの分離

| 要素 | 正本として所有するもの | 正本にしないもの |
| --- | --- | --- |
| Henji binary | Host、Worker、core loop、built-in Definition、`@henji/agent` API実装、build identity | external revision、Session、credential |
| 元source path | install時の入力とprovenance | install後のmanaged execution |
| `DefinitionModuleRevision` | entry、許可されたlocal module closure、contract identity、root role、content identity | active selection、physical XDG root |
| managed store | 一つのinstallationでのrevision保管とmanifest | machineをまたぐglobal identity、active binding |
| Session | conversation state。AgentInstance導入前はSessionを開始したexact Definition refの選択。導入後は各turnで実行したrefのsnapshot | module source、physical load path、AgentInstance導入後のactive selection |
| AgentInstance | 後続Phaseで導入するactive Definition bindingの唯一のauthority | module source、Worker generation、過去のSession snapshot |
| workspace | `AGENTS.md`、skills、toolが読む・変更するfile | Definition revisionとSessionの代替 |
| execution evidence | 実際に使ったHenji buildとDefinition refの相関 | Definition sourceまたはSessionの正本 |

### 1.4 Definition revisionのidentity

external Definitionのcanonical revision digestは、少なくとも次を正規化して計算する。

```text
closure schema version
+ resource kind
+ declared root role
+ @henji/agent contract identity
+ entry relative path
+ sorted exact managed resource bindings
+ sorted(relative path + exact file bytes)
```

`module ID`は人間が選ぶnamespaceであり、content digestとは別にlogical refを構成する。

```text
DefinitionRevisionRef
  resourceKind: agent-definition
  moduleId: my-default
  revision: sha256:<full-digest>
```

provenance、登録日時、physical store path、Henji build identityはcontent digestへ含めない。同一module IDと
同一digestの再installは既存revisionを返し、identity manifestを書き換えない。source pathと登録日時は後述する
local custody metadataとして扱い、同一installationの最初のcustodyを黙って置き換えない。registration event
履歴は初期Incrementでは作らない。

digestはfieldの文字列表現を単純連結して作らない。Increment 33では、次のversioned canonical payloadを
実装前にcontractとして固定する。

- 先頭にdomain separator `henji-definition-revision-v1`を置く。
- resource kind、declared role、API contract identity、entry relative path、exact managed resource bindings、各fileの
  relative pathとexact bytesを、それぞれunsigned 64-bit big-endianのbyte長を前置したUTF-8またはraw bytesとして
  順にencodeする。
- resource bindingはsemantic `AgentResourceIdentity`、resource kind、canonical resource ID、full revision
  digestの順にencodeし、resource identityとlogical refのcanonical byte順でsortする。
- fileはcanonical relative pathのUTF-8 byte順でsortする。
- relative pathはmodule graphのURL解決後にmodule rootからのrelative URLとして表し、`/`をseparatorとし、
  dot segmentとabsolute machine pathを残さない。
- module IDは空でないwell-formed Unicode stringのexact UTF-8 bytesをcanonical表現とし、case foldingやUnicode
  normalizationを暗黙に行わない。

logical identityは`(resource kind, canonical module ID, revision digest)`の組である。canonical payloadと
logical refのschema versionをmanifestへ保存し、Increment 34のimport側も同じalgorithmで再計算する。

#### Identity manifestとlocal custody metadata

portable revisionのidentityと、一台のHenjiへ登録した事実を同じmutable metadataにしない。

- identity manifestは、logical ref、canonical payload、entry、role、API contract、exact managed resource
  bindings、closure file descriptorを保持する。revision digestで内容を照合し、machineをまたいで同じ意味を
  持つ。
- local custody metadataは、sourceからinstallしたpathと日時、またはartifactからimportした日時と由来を
  保持する。digest対象ではなく、そのinstallationだけのreadback情報である。
- 同じrevisionを再installまたは再importしても、既存のlocal custody metadataを黙って書き換えない。
- Increment 34のexportはoriginal source lineageをinformational metadataとして運べるが、import先はそれと
  local import日時・artifact由来を区別して保存・表示する。
- 初期Incrementでは全registration event chainを保存しないため、original lineageと現在installationの最初の
  custodyより詳しい移送履歴は保証しない。

### 1.5 revision artifactの自己完結性とportable identity

`DefinitionModuleRevision`は、初期import contractで実行に必要なlocal source closureをすべて含む。
元source pathとrelative dependencyを変更または削除しても、managed revisionだけからloadできなければ
ならない。

revisionのlogical identityは、次に依存しない。

- sourceを作成したmachine。
- `$XDG_DATA_HOME`の値。
- managed storeのabsolute path。
- Henji executableの配置path。

したがってrevision artifactは将来別machineへtransportできる。ただしmanaged storeのdirectory layoutを
公開transport contractにはしない。Increment 33ではlocal custodyを実装し、後続Increment 34で検証付き
export/import Surfaceを追加する。

### 1.6 Definition identity、execution code identity、実行証拠

external Definitionは`@henji/agent`を通じてbinary内のfactory、core、tool実装を利用できる。このため、
同じDefinition source revisionを異なるHenji buildで実行した結果が完全に同じになるとは限らない。

```text
Definition identity     = DefinitionRevisionRef
Resource graph identity = root DefinitionRevisionRef + transitively pinned exact resource refs
Execution code identity = Henji build identity + resolved resource graph identity
```

`DefinitionRevisionRef`が保証するのは、固定されたsource closure、declared root role、要求する
`@henji/agent` contract identity、pinしたmanaged resource bindingsが同じことである。Increment 33ではmanaged
resource binding listを空とし、tool replacement等をDefinition closure自身へ含める。Henji buildとresolved
resource graphの組が特定するのは実行に使ったcode層であり、完全な実行環境ではない。

実際の一turnで何が起きたかのauthorityは、canonical Session transcriptとexecution/provider evidenceである。
そこではSession/turn、effective manifestとmodel selection、Henji build、root Definition ref、解決済みの
transitive resource refs、provider requestを相関する。workspace content、instruction/skill snapshot、toolが
観測する外部状態など、採用済みのstable
identityがない入力まで再現可能であるとは主張しない。このIncrement群は完全なenvironment snapshotや
deterministic replayを実装しない。

### 1.7 binary更新とAPI contract

Henji binaryをv1.0からv1.1へ更新しても、managed external revision、Sessionのlogical ref、将来の
AgentInstance bindingを削除または書き換えない。

各binaryは、自身がsupportする`@henji/agent` contract identityをbuild manifestで示す。HostはWorker起動前に
external revisionが要求するcontractとの互換性を判定する。

- supportするcontractなら、現在binaryの対応するembedded API facadeで実行できる。
- supportしないcontractなら、bindingやrevisionを変更せず、必要contract、Henji build、exact revisionを
  示して起動を停止する。
- incompatible revisionを現在build向けに黙って再解釈しない。
- 初期実装では一binaryが一つのcontractだけをsupportしてよい。複数の旧facadeを同梱するかは、実際の
  version移行が必要になった時点で決める。

同じexternal revisionをv1.1で実行できても、それはv1.0と完全に同じbehaviorを保証しない。少なくとも同じ
code層へ戻すには、同じexternal revisionに加えてv1.0 binaryも必要である。それでもmutableなworkspace、
instruction/skills、model/provider、tool I/Oなどが異なれば、同じ結果の再現は保証しない。

### 1.8 revision喪失とrollbackの意味

次の事象を区別する。

1. 元source pathが失われた。
   - managed revisionが完全なら影響を受けずloadできる。
2. 選択したmanaged revisionが欠損または破損した。
   - exact refの解決を失敗させ、黙って別revisionやbuilt-inを実行しない。
3. 旧revisionがmanaged storeに残っている。
   - Increment 33では、人間が旧exact refを指定して新しいSessionを開始できる。
4. 既存AgentInstanceのactive bindingを旧revisionへ戻したい。
   - AgentInstanceとbinding transitionを導入する後続Phaseで、人間の明示的かつdurableなtransitionとして
     実装する。

初期managed storeはrevisionを自動削除せず、自動GCもしない。旧revisionの保持だけを「active bindingの
rollbackが実装済み」とは呼ばない。

### 1.9 別PCで再現するときの範囲

別PCへの移送単位は目的によって異なる。

- external Definition revisionの再利用: 対象revision artifact。
- 旧revisionへの選択肢も維持: 必要な旧revision artifact一式。
- Session再開: Definitionに加えてSession stateとcheckpoint。
- 同じworkspace入力: workspace files、`AGENTS.md`、skills等。
- 同じexecution code identity: 対応するHenji binary/build。
- credential: artifactへ含めず、移送先のconfigへ別途設定する。

Increment 34のexport packageは選択したrevisionのmanifestとsource closureを含め、移送先のimportがlogical
identity、全file digest、API contractを検証してmanaged storeへatomicにpublishする。built-in Definition、
credential、Session、workspaceはmodule export packageに含めない。

### 1.10 現開発版の旧永続schema

現時点のHenjiは開発中であり、利用者は既存の開発版Session、artifact、diagnosticについて破壊的変更を
許容し、移行を不要と判断した。

- Increment 32で新しいlogical refを持つschemaへ切り替える。
- schema v1〜v5のlegacy Session migration、旧artifact decoder、互換UI、互換testはIncrement 32/33へ
  含めない。
- 旧recordを現在buildのembedded revisionへ黙って対応させない。
- この一回の開発版cutoverと、将来release後のbinary/API compatibilityは別問題として扱う。
- 新schema以後も、decode不能またはAPI非互換のrecordを別identityとして黙って再解釈しない。

### 1.11 direct-path Definitionのcutover

現行`--definition <path>`はIncrement 32で廃止する。外部source pathはIncrement 33以降の`module install`にだけ渡し、
実行時authorityにはしない。

- unmanaged Definition refと、そのためのdurable Session schemaを新設しない。
- Definitionを編集して再installした場合は、変更後contentから新しいexact revisionを作る。元revisionはmanaged
  storeへ残り、同じ入力の再installは同じrevisionを返す。
- 現行direct-path Sessionは開発版schema cutoverの対象として移行せず、managed revisionへ自動importしない。
- Increment 32完了からIncrement 33完了まで、external Definitionの実行経路は一時的に存在せず、built-in
  Definitionだけを利用する。

## 2. Increment計画

### 2.1 Increment 32 — standalone executableとexternalization基盤

#### 利用者が必要とする動作

- repositoryと導入済みDenoに依存しない単一の`henji` executableを任意pathへ配置し、任意workspaceから
  現行TUI、非対話command、diagnosticsを利用できる。
- binary、config、managed data、runtime state、workspace inputの場所と役割を説明・readbackできる。
- binaryを移動しても、Sessionへ保存するDefinition identityがphysical import pathへ変化しない。
- 後続でresource kindを追加してもmachine/path非依存identity、installとactivationの分離、build attributionを
  作り直さずに済む共通境界を持つ。

#### 実装範囲

- TUI、`run`、`diagnostics`、`--version`を一つのcompiled CLI entryへ統合する。
- HostのXDG config/data/state resolverを設け、binary pathやsource checkoutからrootを導出しない。
- Worker bootstrap、built-in Definition、`@henji/agent` API、現行runtime sourceをcompile artifactへ含める。
- build revision、Deno version、target、embedded runtime digest、supported API contractを持つbuild manifestを
  埋め込む。
- built-in logical refを薄いentry fileだけでなくembedded runtime revisionへ結び付ける。
- versioned `ManagedResourceRef` envelopeと、その最初のspecializationであるDefinition refを定義する。
- 永続的なlogical refと、現在processだけが使うkind固有のphysical load descriptorを分離する。
- XDG data rootにresource kindごとのnamespaceを置けるmanaged data境界を定める。共通の汎用loader、activation、
  dependency resolverは先行実装しない。
- build manifestへHenji build、embedded resource digest、supportするresource API contract identityを記録する。
- Session、execution artifact、関連diagnostic/evidenceを新しいlogical ref schemaへ切り替える。
- 現開発版の旧永続schemaを移行しない。
- 現行`--definition <path>`を廃止し、永続schemaとCLIからunmanaged Definition refを除く。
- workspace `AGENTS.md`とworkspace Skillのnative discoveryを維持し、user-scope Skill discoveryを加える。互換locationと
  precedenceは個別計画で現行sourceとnative contractを照合して確定し、いずれもmanaged installを要求しない。
- OpenRouter/OpenAI credentialのXDG config path、build/install/run方法、`trusted-local · no hard sandbox`を
  READMEへ記載する。

#### 対象外

- external Definitionのmanaged install。
- release automation、tag、publish、複数platform配布matrix。
- security sandboxやpermission modelの新設。

#### product証拠

- disposable source checkoutでbinaryをbuildし、checkoutとPATH上のDenoへ依存せず、別path・isolated XDG
  root・任意workspaceから起動できる。
- built-in TUI turnと非対話turnが実providerで完了し、Sessionとevidenceからbuild identityとbuilt-in
  logical refをreadbackできる。
- diagnosticsと既存の現行Surfaceが同じcompiled entryから利用できる。
- workspace `AGENTS.md`、workspace Skill、user-scope Skillがcompiled binaryからzero-installで発見・適用される。
- Definition refがversioned managed resource envelopeとしてpath非依存にencodeされ、Host内でだけbuilt-inの
  physical descriptorへ解決される。
- `--definition <path>`が実行selectorとして残らず、Sessionへphysical Definition pathを新しいauthorityとして
  保存しない。
- legacy recordを現在buildの新しいlogical identityとして黙って再解釈しない。

### 2.2 Increment 33 — local managed Definition revision

#### 利用者が必要とする動作

- 任意pathのTypeScript DefinitionをHenji管理下へinstallできる。
- module ID、root role、exact revision、entry、closure、contract identity、origin lineage、local custodyを
  区別してlist/inspectできる。
- 元sourceを変更または削除しても、登録済みexact revisionから新しいSessionを開始できる。
- built-inとexternalでWorker、protocol、commit経路を分岐させず、通常taskを完了できる。
- 欠損、破損、API非互換時に別revisionへ黙ってfallbackせず、選択したidentityと失敗理由を確認できる。

#### CLI案

```text
henji module install ./my-agent.ts --id my-agent --role parent
henji module install ./planner.ts --id my-planner --role planner
henji module list
henji module inspect --id my-agent --revision sha256:<full-digest>

henji --definition-revision my-agent@sha256:<full-digest>
henji run --definition-revision my-agent@sha256:<full-digest> --task ...
```

`--role`未指定時は`parent`とする。実行selectorはfull digestだけを受け入れ、暗黙の`latest`は設けない。

#### import contract

- entryとdependencyは`.ts`。
- static relative import/exportとembedded APIの`@henji/agent`を許す。
- module rootはentryの親directoryを既定とし、必要なら`--root`で明示する。
- local closureはmodule root内へ限定する。
- remote URL、JSR、npm、computed dynamic importは初回対象外とする。
- pinしたmodule graph parser/libraryをbinaryへ組み込み、導入済みDeno CLIをsubprocess起動しない。
- 初期Definition revisionのmanaged resource binding listは空とする。relative tool replacement等はDefinition
  自身のclosureへ含める。

#### storeとload contract

- XDG data root配下へrevisionをstagingし、manifestとclosure全fileを確定後にatomic publishする。
- canonical digest、manifest、各file digestをinstall時に検証する。
- Hostはlogical ref解決時にmanifestとclosure全fileを照合する。
- Workerはimport直前に同じclosure descriptorを照合する。
- digest-bound identity manifestとdigest外のlocal custody metadataを分離する。
- duplicate installは既存immutable revisionを返し、既存のidentity manifestとlocal custody metadataを
  書き換えない。
- revisionは自動削除・自動GCしない。
- `@henji/agent` contract互換性をWorker起動前に判定する。
- manifestのexact managed resource bindingsをdigestへbindする。Increment 33では空listを検証し、後続resource
  kindが追加されても同じDefinition refから別resource graphを解決しない。

#### root role

- `parent`と`planner`の両root roleを扱う。
- declared roleをcanonical digestとrevision manifestへ含め、revision manifestをroleのauthorityとする。
- AgentInstance導入前のSessionにはroleをbindingのprojectionとして保存し、revision manifestと一致することを
  load時に検証する。Session側のroleを独立した選択authorityにしない。
- Workerが返すmanifest roleとdeclared roleが異なる場合は起動失敗として報告する。

#### 対象外

- AIから呼べるmodule-install tool。
- installしたrevisionの自動activation。
- 既存SessionまたはAgentInstanceのrevision切替、hot reload。
- module export/import。
- remove/GC。
- 独立したtool、instruction、skill、model、subagent resource revisionのinstall・参照。
- planner rootへsame-identity tool replacementを渡す`@henji/agent` API拡張。
- provider adapter、context/compaction、agent loop、Surface、storage backendの外部化。

#### product証拠

- 二file以上のrelative dependencyを持つparentとplanner Definitionを任意pathからinstallし、identity、role、
  entry、closure、contract、origin lineage、local custodyをreadbackできる。
- 同じclosureでentryだけが異なる二つのDefinitionが異なるrevisionになり、同じ入力は別XDG rootでも同じ
  canonical digestになる。
- Definitionを編集して再installすると新しいexact revisionになり、旧revisionも明示指定して実行できる。
- external parent Definitionのclosureへ同梱したsame-identity tool replacementがclosure digestに含まれ、
  独立tool revisionとは表示上区別される。planner Definitionは現行APIどおりreplacementを受け取らない。
- 元sourceとdependencyを変更または削除した後、同じmanaged revisionから新しいSessionを開始できる。
- process再起動後も同じrevisionを解決できる。
- revisionの一fileを変えた検証用copyでは、同じlogical refとして実行せず不一致を報告する。
- support対象外contractを要求する検証用revisionでは、bindingを変更せず互換性failureを報告する。
- 実providerの通常turnを完了し、Session、execution artifact、provider evidenceの相関からHenji buildとexact
  Definition refをreadbackできる。

### 2.3 提案Increment 34 — Definition revision transport

Increment 33で確定したmachine/path非依存identityを使い、別Henji installationへ同じartifactを運ぶSurfaceを
追加する。package envelopeはresource kindを識別できる形にするが、最初に実装するpackage contentとimport
contractはAgent Definitionだけである。portable identityをproductとして利用する後続Surfaceであり、local
install・実行を成立させるIncrement 33の実装完了条件にはしない。

#### 利用者が必要とする動作

- 指定したexact revisionを一つのtransport packageへexportできる。
- packageを別PCまたは別XDG data rootへimportし、元と同じlogical refとしてlist/inspectできる。移送先binaryが
  API contractをsupportする場合は、そのrevisionを実行できる。
- credential、Session、workspace、built-in Definitionをmodule packageへ混入させず、移送範囲を判断できる。

#### 実装範囲

```text
henji module export my-agent@sha256:<full-digest> --output <artifact>
henji module import <artifact>
```

- package schemaへrevision manifestとsource closureを含める。
- import時にresource kind、module ID、root role、API contract、closure全file、canonical digestを検証する。
- target managed storeへatomic publishする。
- targetに同一revisionがあればduplicate installとして既存revisionを返す。
- artifact formatはstore directory layoutから分離し、store layoutをpublic transport contractにしない。
- original source lineageはinformational metadataとして運び、import先で作るlocal custody metadataの
  import日時・artifact由来とは分けて保存・表示する。

#### 対象外

- Session、workspace、credential、Henji binaryをまとめる環境backup。
- remote registryやmodule配布service。
- AgentInstance active bindingの移送または切替。
- Agent Definition以外のresource kindのexport/import。

#### product証拠

- source machineと異なるisolated XDG data rootへartifactをimportし、logical refとdigestが一致する。
- 元sourceがなくてもimport済みrevisionで通常taskを完了できる。
- import後のexecution evidenceからtarget Henji buildと移送したDefinition refの組をreadbackできる。

### 2.4 後続Phase — AgentInstance binding rollback

AgentInstance導入後、現在のactive revisionから保持済みの旧revisionへ戻す操作を、通常のbinding transitionと
同じhuman gate、generation切替、durable commit semanticsで実装する。

- AgentInstance導入前はSession bindingが起動するexact refを所有する。導入後はAgentInstanceのactive refを
  唯一のselection authorityとし、Session/turnのrefとroleは実行時snapshotとして保持する。
- historical Sessionを選択するだけではAgentInstance bindingを変更しない。
- missing/incompatibleなactive refを黙って変更しない。
- 人間が旧exact refを選択した場合だけbindingを変更する。
- transition前後のrevisionとHenji buildをreadbackできる。
- Increment 33の「旧revisionから新Sessionを開始する」操作とは区別する。

### 2.5 後続Increment — resource kind別の外部化

Increment 33のlocal managed-resource基盤成立後、通常利用の経験と人間の選択に基づいて、一度に一つの
resource kindを外部化する。Increment 34のDefinition transportは必須の先行条件にせず、対象kindにtransportが
必要な場合だけpackage envelopeを再利用・拡張する。resource kindの実装順は現時点で固定しない。

各Incrementでは次を必ず決める。

- artifactへ含むcontentと、binaryまたはworkspaceへ残すbinding。
- kind固有のAPI contract identityとcanonical revision digest。
- 他resourceへのexact dependency、activation authorityが選ぶroot resource set、transitive graphの解決方法。
- install、選択、candidate、Human Gate、activation、rollbackのどこまでを扱うか。
- installation、workspace、AgentInstance、Session、turnのどのscopeへbindするか。
- Worker、Host、subprocess、client、remote serviceのどこで実行するか。
- mutableなresource instance stateを持つか、持つ場合のowner、scope、復元保証。
- Session、manifest、tool call/result、execution evidenceへ残すexact ref。
- built-in、workspace版、managed版が併存するときのselection authorityと優先順位。

toolを最初の対象に選ぶ場合も、provider definition、利用指針、handler、physical I/O backend、tool call/resultを
分けて境界を決める。Instruction、skill、model、subagent、context policy等でも同じ手順を使うが、同一の
loaderやactivation contractを前提にはしない。

## 3. architecture・roadmap正本への反映結果

利用者の承認を受け、次の意味上の変更をarchitecture・roadmap正本へ反映した。

1. `DefinitionModuleRevision`を、machine、source path、XDG data rootに依存しないportableなlogical
   artifactとして明記する。
2. managed storeを一つのHenji installationにおけるlocal custodyとし、store layoutをtransport
   contractにしない。
3. `DefinitionRevisionRef`が保証する範囲、Henji buildを含むexecution code identity、実際のturnのauthorityで
   あるSession/evidenceを区別する。
4. binary更新はexternal revisionとbindingを書き換えず、API contract非互換時はidentityを保持して明示的に
   起動失敗とする。
5. revision喪失時のfailure、旧revisionからの新Session開始、AgentInstance binding rollbackを別操作として
   定義する。
6. Definition transport Surfaceを、local managed revision成立後の後続Incrementとしてroadmapへ追加する。
7. 現開発版legacy schema migrationをIncrement 32/33の要件から外す。roadmapのF04/F05にある旧schema
   readback・次回write migrationの現状記述をcutover後の状態へ更新し、Phase 1の「既存schema-v1/v2の扱い」を
   新cutover後schema基準へ置き換える。
8. AgentInstance導入前後でactive selection authorityがSessionからInstanceへ移り、Session/turn refは
   historical snapshotになることを明記する。
9. digest-bound identity manifest、transport可能なorigin lineage、installation固有のlocal custody metadataを
   区別する。
10. Agent Definition以外について、managed revision候補、既存external input/state、binary platform authority、
    追加architecture判断が必要な対象の分類を明記する。
11. resource kind共通のlogical identity envelope、exact dependency graph、installとactivationの分離、evidence
    attributionを定める。ただしkind固有loaderと実行placementは個別Incrementで決める。
12. roadmapのF24を、一覧から対象を一つ選ぶだけでなく、選んだresource kindのcontent、contract、dependency、
    activation、execution placement、evidenceをarchitectureへ反映してから実装する流れとして具体化する。
13. roadmapの現行「Self-revision Cycle 1前段」を、Increment 32のstandalone/externalization基盤とIncrement 33の
    managed Agent Definitionへ分け、それぞれの利用者動作とproduct証拠を記載する。
14. generic graphのrootをAgent Definitionへ固定せず、activation authorityが選んだroot resource setとする。
    Increment 33だけは一つのAgent Definitionをrootとする。
15. 共通dependency keyを`AgentResourceIdentity`ではなくkind非依存の`ResourceSlotIdentity`とし、前者をAgent
    composition固有の表現へ限定する。
16. immutable revision、active binding、resource instanceのmutable state、tool call/resultを異なるauthorityと
    lifecycleとして明記する。
17. Surface data/code、integration declaration/runtime、capability backend、runtime interception/policyを候補一覧へ
    追加し、resource kindごとにscope、placement、lifecycle、durabilityを決める。
18. 現行`--definition <path>`をIncrement 32で廃止し、外部source pathをIncrement 33以降のinstall inputに限定する。
19. 自然言語resourceはsource-native fileとnative discovery/activationをzero-install互換経路として保持し、Henji
    固有のidentity、custody、bindingをsidecar envelopeへ置く。`AGENTS.md`はworkspace inputのまま自動installせず、
    managed SkillとHenji Instruction revisionをnative inputから分離する。
20. MCPはprotocol client、connection declaration、credential、server実体、runtime capability、実行recordを分離する。
    native MCP接続にHenji managed installを必須にせず、exact pin/transportが必要な要素だけを後続Integration
    resource候補とする。

## 4. 利用者判断

2026-09-11に次を採用し、architecture・roadmap正本へ反映した。個別Increment計画と実装の承認は、この概念判断と
正本変更とは分けて扱う。

1. Increment 34をDefinition revision transportとして採用する。
2. 初期managed Definitionでparentとplannerの両root roleを扱い、`--role`未指定時はparentとする。
3. unmanaged `--definition <path>`は残さず、Increment 32で廃止する。
4. identity manifestとlocal custody metadataを分け、同一revision再installでは最初のlocal custodyを保持する。
   registration event履歴は初期実装へ含めない。
5. 将来release後のSession/schema decoder互換期間はrelease policyを具体化するときに決める。それまでも、
   incompatible recordを別identityへ黙って再解釈しない。
6. Increment 34では、現在binaryがsupportしないAPI contractのartifactもcustody目的でimportできる。実行時は
   identityを保ったまま明示的に互換性failureとする。
7. 4分類を採用し、Agent Definition以外も将来managed externalization可能な対象としてarchitecture変更案へ
   含める。次に実装するresource kindはF24の利用経験まで固定しない。
8. Increment 33のtool replacementはexternal parent Definitionだけに限定し、planner対応は後続API変更へ送る。
9. Increment 34を後続resource-kind外部化の必須前提にせず、transportが必要なkindだけpackage envelopeを
   再利用・拡張する。
10. generic graphはactivation authorityが選んだroot resource setから解決し、Increment 33では一つのAgent
    Definition rootに限定する。
11. 共通binding identityへ`ResourceSlotIdentity`を導入し、`AgentResourceIdentity`をAgent composition固有の
    表現とする。
12. `AGENTS.md`や`SKILL.md`等の自然言語resourceはsource-native形式だけでなくnative discovery/activationも
    zero-installで維持する。managed SkillとHenji独自Instruction revisionは別authorityにする。
13. MCP native connectionにHenji managed installを必須にせず、connection、credential、server、runtime
    capability、実行recordを分離する。MCP managed resourceの採否は後続Integration Incrementで決める。

## 5. 検証とreviewの進め方

- 各Incrementの実装中はfocused test、必要なtype check、format、lint、`git diff --check`を使う。
- stable candidateごとに、承認済み計画が要求するauthoritative `v0:gate`をcoordinating ownerが一回だけ
  実行する。
- Increment 32ではstandalone binaryのproduction経路、Increment 33ではmanaged revisionのproduction経路、
  Increment 34では別XDG rootへのtransport経路を、それぞれ実providerを含めて確認する。
- 差分reviewは明示要件、実利用経路、永続identity、binary更新時の互換性、具体的regressionを確認する。
- security hardening、permission matrix、未観測provider variantは別途明示された場合だけ対象にする。

## 6. Definition中心案への第三者review結果

新しいread-only reviewerが、この資料を構想、architecture、roadmap、active sourceへ照合した。初回結果は
Blocker 0、P1 2、P2 3だった。

### 初回findingと反映

1. canonical digestがentry relative pathをbindせず、canonical encodingも一意でなかった。
   - entry path、domain separator、length prefix、encoding、file順、relative path、module ID表現を追加した。
2. `Henji build + DefinitionRevisionRef`を完全な実行環境と誤認できた。
   - `execution code identity`へ限定し、実turnのauthorityと再現しない入力を分けた。
3. Session、AgentInstance、root roleのselection authorityがPhase境界で重複していた。
   - AgentInstance導入前後のauthority移行と、role manifestを一意のauthorityとして定義した。
4. portableなorigin provenanceとinstallation固有のlocal custodyが混在していた。
   - identity manifest、origin lineage、local custody metadataを分けた。
5. legacy cutoverに伴って更新するroadmap正本の箇所が不足していた。
   - F04、F05、Phase 1を具体的な更新対象として追加した。

### 差分再review

同じreviewerが変更箇所と既存findingの解消を再確認した。結果はBlocker 0、P1 0、P2 0であり、新しい
Blocker/P1はなかった。Increment 32→33→34の分割と外部化の概念計画は、利用者の承認判断へ進める状態と
評価された。

reviewと再reviewはread-onlyで行い、build、test、provider E2E、full gateは実行していない。

このreview後、利用者の指摘により対象をAgent DefinitionだけからHenji全体のexternalization taxonomyへ拡張した。
拡張部分と、それを受けたIncrement 32以降の計画は別の第三者review対象とする。

## 7. Henji全体の外部化taxonomyへの第三者review結果

同じ会話履歴を継承しない新しいread-only reviewerが、4分類、共通resource envelope、Increment 32〜34の分割を、
構想、architecture、roadmap、active sourceへ照合した。初回結果はBlocker 0、P1 0、P2 4だった。

### 初回findingと反映

1. `AgentComposition`、評価後`AgentManifest`、`AgentInstance`、active model selectionの分類がなかった。
   - durable state、runtime projection、ephemeral stateを追加し、portable revision manifestと区別した。
2. tool replacementの説明がplannerや任意tool identityにも適用できるように読めた。
   - external parent Definition、既存六identityのsame-identity replacementだけが現行能力であると限定した。
3. 後続resource kindの外部化がIncrement 34のtransportを不必要に前提としていた。
   - Increment 33のlocal managed-resource基盤後に開始でき、transportは必要なkindだけ使う順序へ修正した。
4. roadmap正本変更案にIncrement 32と33の明示的な分割がなかった。
   - standalone/externalization共通基盤と、managed Agent Definitionの利用者動作を分ける変更案を追加した。

### 差分再review

同じreviewerが変更箇所と既存findingを再確認した。結果はBlocker 0、P1 0、P2 1だった。初回4件のうちtool
replacement、transport依存、roadmap分割は解消し、分類も追加されていた。`ManagedResourceManifest`と評価後
`AgentManifest`、semanticな`AgentResourceIdentity`とexactな`ManagedResourceRef`の区別にも矛盾はなかった。

残ったP2は、active provider/model/effort selectionを将来`AgentInstance`が所有すると未承認のまま先取りしていた
点である。reviewerが示した最小修正どおり、現行のSession所有だけを事実として記し、将来の所有先は対象
Incrementで決める記述へ修正した。このため未反映のreview findingはない。

reviewと再reviewはread-onlyで行い、build、test、provider E2E、full gateは実行していない。

## 8. 参照実装比較によるtaxonomy再評価

Pi、Zot、DeepSeek Harness、OpenComputer、Cloudflare Agents、Cloudflare Sandbox SDKの固定snapshotを
調査し、この資料の分類と照合した。調査対象、確認したsource、各実装の評価は
[`../research/externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)に
分離して保存した。

比較の結果、managed revision候補、external input/state、binary側platform authority、追加architecture判断が
必要な対象という4分類は維持できる。特にHenjiが計画するexact digest、managed custody、Session・evidenceへの
revision bindingは、調査対象の動的package/extension機構よりも、過去の実行identityを固定して再読する目的に
適している。

一方、参照実装が実際に分離している責務へ照らし、次をこの資料へ反映した。

1. 共通resource graphのrootをAgent Definitionへ固定せず、activation authorityが選んだroot resource setから
   解決する。Increment 33は、その一般形を一つのAgent Definition rootへ限定して使う最初の具体例とする。
2. 共通binding identityをkind非依存の`ResourceSlotIdentity`とし、`AgentResourceIdentity`はAgent composition内の
   semantic slotを表す固有型として扱う。
3. prompt template/theme、Surface extension code、integration declaration/runtime、capability backendを外部化対象の
   inventoryへ追加した。ただし、分類への追加は直ちにmanaged code実行を実装する決定を意味しない。
4. immutable revision、active binding、Sessionやtool記録に加え、resource instanceのindex、cache、設定、process、
   UI local stateのようなmutable stateを別の状態として明示した。
5. resource kindごとに分類だけでなく、scope/activation owner、execution placement、lifecycle、durabilityを直交属性
   として決める。また、global/workspace等のdiscovery precedenceと、exact resolved graph内のsemantic slot conflictを
   別の問題として扱う。

この節と上記の反映差分は、固定snapshotのsource調査に基づくが、節6・7の第三者reviewより後に追加した。利用者承認後に
architecture・roadmap正本へ反映し、その最新差分は次節の第三者review対象とした。個別Increment計画と実装は引き続き
未承認である。

## 9. architecture・roadmap反映差分の第三者review

新しいread-only reviewerが、architecture・roadmap・本資料の最新差分を構想、active source、公式MCP契約へ照合した。
初回結果はBlocker 0、P1 2、P2 2だった。

### 初回findingと反映

1. F03がworkspace/user scopeのnative discoveryを実装済みとしていたが、現行sourceにuser-scope Skill discoveryは
   なかった。
   - F03を部分実装へ訂正し、対象scopeをworkspace `AGENTS.md`とworkspace/user scope `SKILL.md`へ明確化した。
   - Increment 32の対象へF03を追加し、user-scope Skill discoveryとcompiled binaryからのnative discovery確認を
     実装範囲・product証拠へ追加した。具体的な互換locationとprecedenceは個別計画で公式または実装済みnative
     contractと照合して決める。
2. `DefinitionRevisionRef`と共通`ManagedResourceRef`の関係がarchitecture正本で未定義だった。
   - `DefinitionRevisionRef`を`resourceKind = agent-definition`のkind固有specializationと定義し、process-localな
     physical load descriptorを永続identityから分離した。
3. `ResourceSlotIdentity`のscopeとmulti-root graphでの競合単位が曖昧だった。
   - 競合keyをconsumer exact refとlocal slotの組とし、activation-level共有slotは将来の別namespaceへ分けた。
4. MCP clientの物理配置を、未決事項であるにもかかわらずHostへ固定していた。
   - `Henji側client`というplacement-neutralな表現へ変更し、client、transport、dispatchの配置を後続Integration
     Incrementで決めることを明記した。

### 差分再review

同じreviewerが上記4件の変更箇所と関連active sourceだけを再確認した。4件はすべて解消し、新しいBlocker/P1は
なかった。architecture・roadmapはIncrement 32の個別計画作成へ進める状態と判定された。

初回reviewと再reviewはread-onlyで行い、build、test、provider E2E、full gateは実行していない。
