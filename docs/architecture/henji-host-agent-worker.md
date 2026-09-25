# Henji Host / Agent Worker アーキテクチャ

ステータス: 承認済みアーキテクチャ。roadmap、実装計画、Human Gate、実装認可ではない

対応するプロダクト構想は
[`docs/concepts/experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)
である。この文書は構想の目的を再定義せず、その実行基盤の構造を定める。

この文書は、Henji HostとヘッドレスなDeno Agent Workerの責務、状態、lifetime、commit境界を定める。

複数providerを同一SessionとWorker内で扱うroute、認証profile、provider state、evidence、Increment 14〜17の境界は、
専門設計
[`docs/architecture/multi-provider-routing-and-auth.md`](multi-provider-routing-and-auth.md)
を正本とする。

## プロダクト上の決定

- HenjiはDenoベースのagent harnessである。`AgentDefinition`はHenji内部の実行構成を表す、信頼された
  executable TypeScript関数である。
- このarchitectureでいう実行 primitive は Deno Web Worker（`new Worker`）である。これは Cloudflare の
  デプロイ単位としての Worker とは別のものである。`AgentWorkerGeneration` は、この Deno Web
  Worker による一時的な実行を表す概念名として引き続き用いる。
- `AgentDefinition` は、信頼された実行可能な TypeScript の合成コードである。外部の
  TypeScript 関数や plugin も Henji core と同じ trusted-local 実行境界に置かれる。それらの
  出所とレビューはtrusted-local codeを採用する人間の関心事であり、信頼された Definitionと信頼されて
  いない Definition に別々の実行経路を作るものではない。一方、採用済みDefinition moduleの登録、
  immutable revision、保存、解決、readbackはHenji Hostが所有するproduct runtime上の関心事である。
- Agent Definitionは最初に実装するmanaged resource kindであり、managed externalization全体をDefinition専用の
  modelにはしない。共通層はresource kindに依存しないlogical identity、exact dependency binding、local custody、
  activation前のgraph resolution、execution evidenceへのattributionだけを定める。kind固有のcontent contract、
  discovery、execution placement、lifecycle、mutable instance stateは、そのkindを採用するincrementで決める。
- Henji Instructionは、binaryに埋め込む最小core（役割identityとcredential/Authorization境界）と、user scopeの
  `$XDG_CONFIG_HOME/henji-harness/instruction.md`を直接読み込む外部contentからなる。外部ファイルはinstallや
  activation bindingを必要とせず、存在すればbuilt-in coreを置き換え、無ければ最小coreを使う。semantic slotは
  `instruction:henji-base`の一つ。native `AGENTS.md`とSkillを置換しない。
- 各 Worker generation の起動前に、選択された Definition code/source revision を参照する
  immutable な `DefinitionRevisionRef` を確定する。外部Definitionではentry fileだけでなく、許可された
  import contractに従う実行可能なlocal module closureまたは同等の自己完結bundleを一つのrevisionとして
  固定する。評価後の data-only な `AgentManifest` はこの参照とは別の authority であり、
  選択内容を説明するが、admission/permission authority にはならない。
- Definitionは固定roleを持たず、すべてroot-runnableである。activation-level slotはroot `agent:default`だけを持ち、
  これはroot Definition revisionをbindする。child／subagentはDefinitionの固定roleではなく、Execution間の親子関係
  として扱う。同期delegated subagent（親Worker内でのchild `runAgent()`）と`subagent:<name>` slotは廃止した。
  bundled executableは`default` Definitionだけを持つ。`agent:default` bindingでこれを置換できる。
  reviewerやplannerを含む名前付きchildは`agent:<name>`へ外部Definitionをbindして使う。
- 配布されるHenji executableはimmutableなcore/runtime artifactとして扱い、Hostが書き換えるstate、config、
  Definition module revision storeとは配置とlifecycleを分離する。executableの配置先やbinary隣接pathを
  writable storageの正本にしない。
- `AGENTS.md`と`SKILL.md`等、他のagent harnessと共有するnative discovery規約を持つresourceは、所定scopeへ
  配置するだけで検出・適用できるzero-install経路を維持する。Henji独自のmanaged revisionはこの経路を
  置換せず、exact pin、transport、Definition bindingが必要な場合だけ追加する。
- Deno Web Worker は、組み込み Definition と外部 Definition の双方に共通する単一の実行カプセル
  とする。Worker はライフサイクル境界であり、別の trust tier ではない。
- Definitionは、provider、model、effort、loop、tools、contextをWorker内の一つの
  `AgentComposition`へ合成する。Definitionを目的別variantの固定集合や閉じたcapability schemaには
  しない。
- UI は交換可能なままだが、Henji Host に属する。Agent Worker はヘッドレスであり、Host / Worker
  interface/protocol を通じてのみ Host と通信する。
- 永続的なagentを採用する場合は常駐Hostが必要であり、durableな`AgentInstance`はephemeralまたは
  再起動されたWorker generationより長く存続しなければならない。
- Host の durable な `AgentInstance` metadata は、その Instance が現在使用する
  `DefinitionRevisionRef` を bind する。Definition revision の変更は、同じ revision の Worker
  restart とは区別され、明示的で durable な transition でなければならない。
- 保存された Session の履歴を**閲覧のみ**で開くことは Worker generation を起動せず、
  `DefinitionRevisionRef` の照合を要しない。閲覧は generation/admission の対象外である。
- 現行の解決済み Definition で Session を**継続**する場合、保存 ref との一致を要求しない。Host は
  切替を durable に記録し、過去 turn の attribution を変更しない。保存 ref が現行 binary に存在しない
  場合（例: builtin の過去 revision）も同様とし、一致を理由に失敗させない。
- 常駐 Host とは、durable な lifecycle owner/service を指す。durable な各 `AgentInstance` に
  永久常駐の thread や Worker を 1 つずつ置くことを意味しない。Instance には active な Worker
  generation が 0 個または 1 個存在でき、lazy activation や idle teardown を後続設計で採用できる。
- Hostが観測できたexecution evidenceのdurableな保存と、turnのcanonical conversationへの採用は別の
  operationである。cancel、failure、途中のtool result等を保存することは、そのexecutionをcanonicalへ
  採用することを意味しない。
- durable historyのauthorityを、transport observation、当時のparser／runtime／tool interpretation、Host decision／
  canonical state、Agent／build／resource attributionへ分ける。人間向け表示、検索文書、model context、summary、後日の
  reinterpretationはderived projectionであり、元authorityを上書きしない。
- outbound transport authorityはprovider adapterがHTTP clientへ渡したexact body bytes、inboundはruntimeがresponse body
  として受け取ったexact bytesを境界とする。TCP／TLS／HTTP framing全体の観測とは呼ばず、credential値とAuthorizationを
  保存しない。
- historyのlogical record identityをphysical segment／offsetから独立させる。immutable exact-byte objectとobservation
  segmentのcodec／配置を変更しても、occurrence、causal relation、canonical decisionのidentityを変えない。
- evidence appendとcanonical adoptionは別operationである。append acknowledgementはobject、segment、directory、anchor、
  execution ledgerのatomic commit後だけ返し、adoptionはsettled execution root／terminalとSession base revisionを
  一transactionで照合・更新する。
- 人間向けhistory viewの`session`は、canonicalとnon-canonicalのexecutionを時系列に並べ、後者の
  outcomeと未完了境界を明示する。`canonical`は採用済みconversationだけを表示し、`detail`はJSONLで
  原記録を参照できる。modelが過去executionから既定で引き継ぐconversationはcanonicalに限定し、
  現在execution内の文脈と人間が明示したprojectionは別の入力として扱う。
  Surface上のrendererとmodel context projectionは別責務である。
- executionは、その判断に関与したAgent側の基底設定と相関できなければならない。このattributionは
  過去Worker、外部状態、tool effect、model内部状態の再現またはreplayを保証しない。

## 用語

| 用語 | この概念での意味 | 存続期間 / 管轄 |
| --- | --- | --- |
| `AgentDefinition` | 信頼された実行可能な TypeScript 合成関数。Host が所有する UI や session object ではなく、agent をどのように組み立てるかを記述する。 | 1 つの Definition revision。Worker generation 内で評価される。 |
| `ManagedResourceRef` | resource kind、logical resource ID、contentで固定したrevision digestからなるmachine/path非依存のexact ref。 | immutable revisionを識別し、Sessionやevidenceからreadbackできる。 |
| `DefinitionRevisionRef` | `resourceKind = agent-definition`である`ManagedResourceRef`のkind固有specialization。別のidentity authorityではなく、built-in/external Definitionを同じlogical IDとexact revisionで表す。 | Session、Instance binding、evidenceへ永続化する。physical module specifierやstore pathを含めない。 |
| `HenjiInstructionRevision` | `resourceKind = henji-instruction`、`slot = instruction:henji-base`であるbase instruction content。built-in coreはbinary、externalは`$XDG_CONFIG_HOME/henji-harness/instruction.md`の直接読み込み。source identity、content digest、byte-equivalent textを持つ。 | 選択結果はWorker generationとexecution attributionへ固定する。 |
| `ManagedResourceManifest` | resource contract、content identity、`ResourceSlotIdentity`からexact `ManagedResourceRef`へのdependency bindingを記録するportable authority。評価後の`AgentManifest`とは異なる。 | managed revision artifactの一部。local store pathやactive bindingを含めない。 |
| `ResourceSlotIdentity` | dependency元resourceのcontract内でresourceが果たすsemanticな役割を表すkind非依存のlocal key。dependencyの競合keyはconsumerのexact refとこのkeyの組である。`AgentResourceIdentity`はAgent composition内で使うkind固有表現である。 | exact refそのものではなく、一つのconsumer manifest内で一つのbindingへ対応する。activation全体の共有slotとは別namespaceである。 |
| `AgentSlotBinding` | Hostのinstallation/user scope configで、activation-level root slot `agent:default`をexact managed `DefinitionRevisionRef`へ結ぶauthority。解決時にrevisionがroot-runnableであることを検証する。`subagent:<name>` slotは廃止済み。 | `ResourceSlotIdentity`（manifest内dependency bindingのlocal key）とは別namespace・別authority。変更は次のWorker generationから効く。 |
| `DefinitionModuleRevision` | Agent Definitionのentryと、初期import contractでその実行に必要となるlocal module closureまたは同等の自己完結bundle、およびそのidentity・lineage metadata。評価後の`AgentManifest`とは別のrevision authorityである。 | Host-owned managed storeへimmutableに保存され、元source pathより長く存続できる。 |
| `AgentComposition` | 1 つの Worker 内で Definition が構築する、実行中の provider/model/effort/loop/tools/context コンポーネント。標準 Henji component は default であり、閉じた capability list ではない。 | 1 回の live composition evaluation は 1 つの Worker generation 内に閉じる。generation 内で一度だけ構築するか、turn ごとに再構築するかは未決定である。 |
| `AgentManifest` | Definition または composition の、評価後の data-only な説明および identity の projection。何が選択されたかを説明するが、`DefinitionRevisionRef` とは別の authority であり、admission/permission authority ではない。 | revision/identity metadata。実行状態ではない。 |
| `AgentInstance` | 安定した agent identity、その durable metadata、および active な `DefinitionRevisionRef` の binding。 | Worker generation より長く存続し、置き換えられた Worker で再開できる。 |
| `AgentWorkerGeneration` | 1 つの Definition revision を実行する 1 回の ephemeral な実行。Instance identity を変えずに停止、再起動、置換できる。 | process/thread/isolate の存続期間。 |
| `Task` | 人間またはHostが一回の依頼としてadmitする入力。`/recall`等の次回限定projectionはこの境界で消費する。 | 一つのexecutionを開始する入力単位。再送やretryは新しいexecutionとして識別する。 |
| `Execution` | 一つのtaskを、あるbase Session revisionとAgent側の基底設定から実行する独立したattempt。進捗、model request、tool activity、outcome、canonical採用状態を相関する。 | activeからsettledまで。canonical/non-canonicalにかかわらずevidenceをdurableに保持できる。 |
| `Turn` | executionが正常完了し、Hostがconversationへ一括採用するuser/assistant interactionのsemanticな単位。 | canonical Session state内で順序を持つ。回答の正しさや利用者の満足を意味しない。 |
| `ModelRequest` | 一つのexecution内でprovider/modelへ行う一回のrequest。tool loopにより一execution内に複数存在できる。 | request/response evidenceとexecutionを相関する。 |
| `HistoryLogicalRecord` | transport、original interpretation、Host decision、attributionの一つのimmutable fact。stable ID、execution内順序、causal ref、semantic content refを持ち、physical locatorをidentityにしない。 | Hostが観測しcommitしたexecution evidenceとして永続化する。 |
| `HistorySegment` | 一つ以上のlogical recordをnatural append batchでまとめたbounded immutable encoding。directoryとanchorから到達し、logical digestとencoded representation digestを区別する。 | storage mechanismが所有し、repack／codec変更でlogical identityを変えない。 |
| `HistoryProjection` | authorityから導出するhuman view、search document、flattened request、model working context、summary、later reinterpretation。 | rebuild可能であり、watermark遅延をauthority欠落とみなさない。 |
| `AgentContextGeneration` | `/rebuild`相当の操作を採用する場合に、対象resourceから解決し有効化したAgent側の基底設定を表す概念。model input全体や`AgentWorkerGeneration`と同義ではない。 | 後続executionが参照する。具体的identity、対象resource、Worker lifecycleとの対応は未決である。 |
| `Surface` | TUI、CLI、JSON、Web、その他の channel など、Host 側で交換可能な interaction adapter。 | Worker とは独立して所有・置換される。 |
| `HenjiHost` | Worker lifecycle、物理 terminal / Surface I/O、Surface の load、UI から command への変換、storage mechanism を所有する coordinator。 | Worker generation の lifecycle owner。常時稼働serviceにするかは未決である。 |

`AgentManifest` と `AgentComposition` を区別するのは意図的である。manifest は、実行可能な
Definition が合成できるものを制限する仕組みになることなく、読み取り、比較、または revision
との関連付けができる。

## externalization taxonomy

外部化できることを、すべて同じloaderへ載せることとはみなさない。Henjiのresourceとstateを次の四つへ分類する。

| 分類 | 対象 | architecture上の扱い |
| --- | --- | --- |
| managed revision候補 | Agent Definition、tool Definition、任意のmanaged Skill、model profile、Surface data、integration declaration等 | content、contract、dependency、activation、scope、placement、lifecycle、durability、evidenceをkindごとに決め、immutable revisionとして扱う。Agent Definitionを最初に実装する |
| external input/state | credential/config、Sessionとcanonical transcript、provider evidence、workspace file、native `AGENTS.md`/Skill、user base instruction（`instruction.md`）、active binding、runtime projection、resource instance state、tool call/result | 実行定義artifactへ混ぜず、それぞれの所有者と保存先を維持する。native discovery resourceやuser base instructionへmanaged installを要求しない |
| binary platform authority | Host coordinator、Worker lifecycle/protocol、canonical Session ownership、atomic turn commit、managed loader/verifier、credential resolver、build manifest、最低限のCLI/diagnostics Definition | managed hot-loadまたはself-replacementの対象にせず、変更時は新しいHenji binaryとして配布する |
| 追加architecture判断が必要 | tool/providerのphysical I/O、context/compaction、agent loop strategy、Human Gate、Surface code、storage backend、MCP/integration runtime、remote distribution | 技術的に外部化不能とは決めないが、実行placementとauthorityを個別機能の採用時に決める |

この分類は閉じたallowlistではない。F24で新しいkindを選ぶときは、共通managed envelopeへ載せられるという理由だけで
採用せず、native ecosystem contractとplatform authorityを維持したうえでkind固有の境界をarchitectureへ追加する。

## Host / Worker 境界

意図する方向性は次のとおりである。

```text
Surface (Host 側)
        │ ユーザー意図 / 描画出力
        ▼
HenjiHost ───── interface / protocol ───── AgentWorkerGeneration
   │                                           │
   │ ライフサイクル、terminal / Surface I/O、ストレージ │ Definition → AgentComposition → turn
   │                                           │ provider、tools、context
   └────────────── 永続化状態 ────────────────┘
```

この図が示すのは所有関係であり、wire schema ではない。現行sliceでは、`slice1-data-only-v1`と名付けた
Host–Worker間のdata-only message contractを実装している。ただしprotocol versionのnegotiationはなく、
現在のmessage schemaを恒久的な契約として固定しない。将来拡張時のmessage、handshake、error互換性、
version migrationは未設計である。

### HenjiHost が所有するもの

- Worker generation の起動、停止、監視、置換。
- 物理 terminal とその他の Surface I/O。
- Surface 実装の load と置換、および Surface action の Worker 向け command または message
  への変換。
- 以下で説明する durable session 境界を含む storage mechanism。
- canonical/non-canonical双方のexecution identity、Hostが受け取ったevidence、outcome、canonical採用、
  context attribution、明示projectionとcontext transitionを相関して保存・readbackするmechanism。
- Agent Definition sourceの取込、実行可能なmodule closureの固定、immutable revisionの保存、selectorから
  `DefinitionRevisionRef`への解決、revision metadataとsource lineageのreadback。
- Henji base instructionの解決。Worker generation開始前に`$XDG_CONFIG_HOME/henji-harness/instruction.md`を
  一度読み、存在すればbuilt-in coreを置き換え、無ければ最小coreを使う。content digestとexact bytesを固定し、
  read failureやinvalid contentではbuilt-inへ暗黙fallbackせずWorker開始前に失敗させる。
- managed resourceのlogical ref、identity manifest、origin lineage、installation固有のlocal custody metadataの
  分離。activation authorityが選んだroot resource setからexact dependency graphを解決し、そのgraphを使う
  Worker、Host、subprocess、client等のgenerationがactiveになる前に固定する。

Host は、Definition code が外部にあるというだけで、別の Definition 実行経路を選択しない。
組み込み Definition と外部の信頼された Definition は、同じ Worker capsule と同じ概念上の
境界を使用する。

### Agent Worker が所有するもの

- Hostが確定した`DefinitionRevisionRef`に対応するexact `AgentDefinition` revisionの評価。外部Definitionでは
  managed store内の確定closureを使い、元source pathを再解決せず、そのclosureの外側を実行時の正本にしない。
- provider/model、effort、loop、tools、context component を含む、その
  `AgentComposition` の構築と実行。
- Hostが解決したroot Definition refに対応するDefinitionだけを評価する。Worker内でchild agentを同期実行する経路は
  持たず、childは（採用時には）別Worker・別ExecutionとしてHostが扱う。
- transcript と context の意味、turn 中の作業状態、compaction policy、agent policy。
- Hostが確定した基底設定、canonical conversation、明示projection、現在execution内のtool result等から、
  各model requestへ渡す実効contextを構成する意味。
- HostがDefinition評価結果とは独立して渡したselected `instruction:henji-base`を、mandatory finalizerで
  Definition-owned instruction contributionの先頭へ一度だけ合成する。rootとasync childは同じselected
  exact revisionとfinalizerを使い、Definitionがcore-owned base slotをnamed componentとして返した場合は実行前に
  composition failureとする。
- interface を通じたヘッドレスの進捗、結果、effect、commit proposal の返却。

### 配布artifactとmanaged resource

Henjiは、Deno runtimeと現在のproduction entryを含むstandalone executableとして配布できる。executableは
任意のpathから任意のworkspaceを対象に起動でき、repository checkoutまたは別途導入されたDenoをruntime
dependencyにしない。Deno compile時に固定するpermissionとembedded resourceは、現行production経路と、
Hostが解決したDefinition module revisionをWorkerが読むために必要な範囲を個別計画で確定する。

Hostのwritableな場所はXDGの役割に分ける。credentialとmutable preferenceはconfig、managed revisionのlocal
custodyはdata、Session、canonical transcript、provider evidence、failure diagnostic、execution artifactはstateに
置く。workspace fileとworkspace native discovery resourceはworkspace、user-scope native resourceは利用者の
該当scopeが所有する。binary path、source checkout、XDG rootのいずれもportable logical identityへ含めない。

managed resourceの共通表現は、`ManagedResourceRef`と`ManagedResourceManifest`である。`DefinitionRevisionRef`は
`resourceKind = agent-definition`である共通refのkind固有specializationであり、別の永続identity schemaではない。
manifestが他resourceへ依存する場合は、`ResourceSlotIdentity`とexact `ManagedResourceRef`のbinding listをrevision
digestへ含める。各bindingの競合keyはconsumerのexact `ManagedResourceRef`と`ResourceSlotIdentity`の組であり、
異なるconsumer contractが同じlocal slot名を使うことは競合ではない。activation authorityが選んだroot resource
setから到達するtransitive graphを実行前に解決し、同じ競合keyへ複数revisionが残る場合は暗黙の優先順位を付けない。
root間で共有するactivation-level slotは、Increment 65で`AgentSlotBinding`として採用した。このslot authorityは
上記のlocal keyを流用せず、`ResourceSlotIdentity`とは別namespace・別authorityとする。Definition-manifest
dependency bindingとactivation-level slot bindingの優先・競合規則は後続incrementで決め、現時点では未確定である。
global/workspace等のsource discovery precedenceは、resolved graph conflictとは別のkind固有selection ruleである。

logical refを実行可能contentへ解決した後、Hostはbuilt-in module descriptorやmanaged store内path等のkind固有な
physical load descriptorを現在process内で構築できる。このdescriptorは`DefinitionRevisionRef`の一部ではなく、
Session、artifact、evidenceへportable identityとして永続化しない。physical `canonicalSpecifier`を含む旧
`DefinitionRevisionRef` schemaは、Increment 32でこのlogical/physical分離へ置き換え済みである。

immutable revision、active binding、resource instanceのmutable state、Session/tool call/resultは別authorityである。
managed resource kindごとにscope/activation owner、execution placement、install・select・activate・reload・rollback・
removeのlifecycle、durabilityを決める。

#### Agent Definition revision

Hostは外部Agent Definitionを次の境界で扱う。

1. 人間が指定した任意pathのsourceをimport inputとして読み、初期incrementで許可するimport contractに従って
   entryと実行に必要なlocal module closure、または同等の自己完結bundleを確定する。
2. 元source pathとは独立した`DefinitionModuleRevision`としてmanaged storeへimmutableに保存し、module
   identity、revision、entry、dependency lineage、由来をreadback可能にする。
3. 新しいSessionまたは後続のInstance bindingが指定したmodule identityとrevisionを
   `DefinitionRevisionRef`へ解決してからWorker generationを起動する。
4. Workerはbuilt-inとexternalのどちらも同じcapsule、protocol、commit境界で評価する。

built-in Definition/tool resourceも同じ`DefinitionRevisionRef`/`ToolDefinitionRevisionRef`で表し、そのrevisionは
resourceのentryとlocal module closure、declared role/name、api contractから算出する。external Definitionと同様に
`@henji/agent`（`worker_agent_api.ts`）をcontract境界として扱い、その先へは辿らない。type-only importは実行時
edgeではないためclosureに含めない。binary同梱ランタイム全体のhashはbuild identity
（`BuildManifestV1.embeddedRuntimeSha256`、`turnExecutions.build`）として残し、built-in resource revisionには
使わない。compiled binaryは各built-in resourceのclosure digestをbuild manifest
（`BuildManifestV1.builtinResources`）へ埋め込み、無関係なruntime修正がbuilt-in revisionを変えないようにする。

現行`--definition <path>`はstandalone/externalization schema cutoverで廃止する。外部source pathはmanaged installの
inputに限り、実行時authority、durable Session ref、暗黙のdevelopment fallbackにはしない。編集後のsourceを
再installすると新しいexact revisionになり、同じcontentの再installは同じrevisionを返す。開発版の既存
direct-path Sessionは新schemaへ移行または自動importしない。

同じrevisionは、登録後に元sourceとrelative dependencyが変更または削除されても起動・再開できなければ
ならない。remote、JSR、npm dependencyを初期import contractに含めるか、その固定方法は個別計画で決める。

Definition moduleの`install`または登録と、実行対象への`activate`またはbinding transitionは別のoperationである。
登録だけでは実行中のWorker generation、既存Session、`AgentInstance`のactive bindingを変更しない。Cycle 1前段は
登録、list / inspect相当のreadback、新しいSessionへのexact revision指定までを扱う。既存Instanceのdurableな
binding transitionとcandidate promotionは、人間の採用を扱う後続機能で決める。turn途中でDefinitionを置換せず、
新revisionを使う場合はHostが後続のWorker generationを起動する。

standalone cutoverではversioned envelope、logical/physical ref分離、XDG data namespace、build/API contract
attributionを共通境界として導入するが、汎用plugin loaderを先行実装しない。最初に実装するkind固有loaderとstoreは
Agent Definition用である。instruction、tool、provider等が同じloader、dependency、promotion、activation semanticsを
使うとは決めず、それぞれを改訂対象に選んだloopでarchitectureへ戻る。

#### activation-level root slot

managed Definition revisionを実行構成へ結ぶslotには、manifest内のdependency bindingとは別に、Hostのinstallation/user
scope config `$XDG_CONFIG_HOME/henji-harness/agents.json`で表すactivation-level slotがある。slotはroot `agent:default`
とasync agent catalog `agent:<name>`の二種で、値は通常managed selector `moduleId@sha256:<digest>`である。組み込み
`agent:generic`は例外で、bundled exact ref `builtin/generic`を値に持つ。HostはWorker
generation開始前にroot slotをexact `DefinitionRevisionRef`へ解決し、revisionがroot-runnableであることを検証する。
`agent:<name>`はHostが解決する利用可能なasync child agent nameのcatalogであり、Hostは親generation開始前に
name→exact refへ解決し、data-only catalogとして親Workerへ渡す。catalogは親Definitionが宣言した名前に加え、組み込み
`agent:generic`（bundled ref `builtin/generic`）を常時含め、`agents.json`が空でも`agent:generic`をspawnできる。
`agents.json`の`agent:generic`同名bindingは予約slotとしてtyped failureとする。modelが渡せるのはagent名catalogの
名前だけで、任意pathや未解決selectorは渡さない。spawn入力の`model`指定はagent名catalogとは別のmodel catalogで
検証済みのprovider/modelId/effortだけを渡せる（こちらも任意pathは渡さない）。組み込みdefaultはHostが渡す
解決済みcatalogの名前を宣言する。親generationは`agent:generic`を
常に含むcatalogを持つが、child generationはcatalogを受け取らずasync child toolを持たない（recursive spawnはV1で
対象外のまま）。
`agent:planner`を設定する場合も通常の外部Definitionとして扱う。未知slot、malformed、missing revision、role不一致はtyped
failureとし、built-inへ暗黙fallbackしない。`subagent:<name>` slotは廃止済みであり、`agents.json`に残っている場合は
「このslotは廃止された」と分かるtyped diagnosticで失敗させる。現在のbinding scopeはinstallation/userに限り、workspace
scopeは対象外である。binding変更は実行中generationへhot適用せず、次のgenerationから効く。

Hostは解決したroot Definition refとprocess-local physical load descriptorをWorker start commandで渡す。Workerは
**選択されたroot Definition**を評価する。parent/subagentをpeerとして別々に評価する経路や、Host提供subagent moduleを
合成する経路は作らない。child／subagentはDefinitionの固定roleではなく、Execution間の親子関係として扱う。V1では、
modelが`spawn_subagent(agent, task, model?, tools?)`を呼び、Hostが別Deno Worker・
別Executionとしてchildを起動する。`model`は`{provider, modelId, effort?}`の起動時model指定（省略時は親Sessionの
現在selection）、`tools`は起動時tool指定（宣言済みtoolの部分集合への絞り込み。追加不可）。childは空transcriptと自身のDefinition／selectionから開始し、親のconversation・
checkpoint・recallを暗黙継承しない。`subagent_status`／`collect_subagent`／`cancel_subagent`で操作し、child結果は
collectのtool resultとして返された時だけ親contextへ入る。child executionはcanonical proposalを生成せず、canonical
Sessionへ採用されずにnoncanonical execution evidenceとして残る。parent cancel／failure／settle／closeは未完了childを
cancelする。V1はparent-execution-scoped one-shot fork/joinとし、mailbox、restart reattach、follow-up、recursive
spawn、swarm UIは対象外とする。

childのspawn成功はchild executionのdurable admission後、collect成功はdurable terminal settlement後にだけ返す。
status／collect／cancelのaddressabilityはspawn元parent executionに限定し、後続turnから過去runをmailboxとして
参照させない。child Definitionのmodule、execution evidenceはcatalogで選択したexact refのprovenanceから
一貫して決め、同じagent名を理由にbundled Definitionへ差し替えない。childのmodel selectionはspawn入力の
`model`（catalog検証済みprovider/modelId/effort）または親Sessionの現在selectionから決まり、tool compositionは
spawn入力の`tools`で絞り込む（宣言済みtoolの部分集合。`tool:skill`／`tool:submit_json_result`は絞り込み対象外）。
有効tool集合、model selection、`definitionRef`はchild execution evidenceへ記録する。tool filterの値不正
（未宣言tool名、絞り込み結果ゼロ）は子側検証で起動直後の失敗runとなり、model指定の不正はspawn失敗（runIdなし）に
なる。childのtool compositionにはHostが解決済みの
exact tool Definition load descriptorを渡し、child側でbundled bindingへ暗黙fallbackしない。

parentの正常settle、failure、cancel、forced interruption、close、Worker generation replacementでは、対象parentの
childをmodel-visible操作から閉じ、terminal確定、durable settlement、Worker terminationまで同じawait可能なcleanupへ
joinする。parent canonical proposalがある場合はcleanup後にparent execution／correlation／generation fenceを再検証する。
child cleanup failureはparent execution artifactからreadback可能にするが、それだけを理由に有効なparent canonical
commitをrollbackまたはnoncanonical化しない。

root Definitionの選択は、明示selector、`agent:default` binding、bundled defaultの順に優先する。再開・継続する
Sessionの保存済みexact refは選択候補にせず、過去turnのattributionとして保持する。binding解決失敗はtyped
failureとし、bundledへ暗黙fallbackしない。継続時に保存済みrefと現行の解決済みrefが異なる場合は、現行refへの
transitionとして次のturnへ記録し、過去turnのattributionを変更しない。閲覧だけの場合は保存済みrefも現行refも
解決せず、Worker generationを起動しない。

resolvedなroot exact refはDefinition resource graphとexecution artifactへ記録し、context attributionへは
入れず、二重authorityを作らない。start command、ready message、execution artifactのcontractはversionを持ち、
旧版は解釈しない。

#### tool Definition

toolは、Agent Definitionが宣言する`tool:<name>` identityに対して、managed resource kind `tool-definition`の
exact revisionから供給できる。authoring packageは`henji-resource.json`とentry TypeScript module＋local closureからなり、
manifestは`apiContract: henji-tool-definition-v1`、`toolIdentity`、entry、closure digestを持つ。Agent Definitionは
tool identityだけを宣言し、toolのcontract・executor・backendの実装はtool Definitionが所有する。installはXDG dataの
`managed/tool-definition/v1`へexact revisionをpublishするだけでactive selectionを変えない。activation-level bindingは
`$XDG_CONFIG_HOME/henji-harness/tools.json`（`schemaVersion:1`＋`bindings: { "<toolIdentity>": "<selector>" }`）で表す。
bindingは「どのexact tool Definition revisionを使うか」だけを表し、tool identityの宣言は持たない。toolの可視性は
**各Agent Definitionのcapability宣言**がownerである。
bundled default parentの宣言一覧は固定で、Definitionは`additionalTools`として自分の追加`tool:<name>`を宣言できる。
Hostはbundled tool Definition一覧と`tools.json` binding一覧を解決してWorker start commandへ渡し、Workerのregistryは
Definitionが宣言したidentityだけをmaterializeする。bundled moduleが無いidentityはexternal bindingを要求する。
binding解決失敗はtyped failureとし、bundledへ暗黙fallbackしない。binding変更は次のWorker generationから効く。

Hostは解決したtool Definitionのexact refとprocess-local physical load descriptorをWorker start commandへ渡す。Workerは
definition moduleのclosureを検証・importし、default export（`ExecutableToolDefinition`）をworkspace・skill catalog・
Worker-local physical I/Oで評価して`ToolComponent`を得て、registryへmaterializeする。実行に必要なprovider requestは、
credential値やAuthorizationを渡さず、auth profileを指定してrequest時にcredentialを解決するWorker-local seam
（`ProviderHttpRequest`／`ProviderHttpResponse`）を通す。tool Definitionは自分が使うmodel・backend・annotation解析を
所有し、Henji-owned contract（例: `WebSearchBackend`）の実装を提供する。

合成したtool Definitionのexact refはmanifestとexecution artifactへ記録し、context attributionへは入れない。
`bash`／`bash_output`／`edit`／`read`／`write`も`web_search`／`web_fetch`と同じbundled tool Definitionとして供給し、
固定`ToolComponentCatalog`／`workToolNames`と`AgentCompositionOptions.toolComponents`の同一identity置換seamは
削除した。core-owned tool（`skill`／`delegate_to_<name>`／`submit_json_result`）はDefinition化しない。tool
Definition transportと任意kindの共通frameworkは後続incrementで扱う。

#### native discoveryとHenji Instruction

workspaceの`AGENTS.md`とworkspace/user scopeの`SKILL.md`は、source-nativeなfile/directory layoutを保ったまま
起動時に自動発見する。利用にmanaged installを要求せず、Henji固有のidentity、custody、bindingを本文へ埋め込まない。
source、scope、content digestをSession/evidenceへ記録しても、それはnative inputのsnapshot attributionであり、
managed revisionのinstallまたはactivationではない。

managed Skill revisionはnative Skillの代替ではなく、exact pin、transport、Definitionからのbindingが必要な場合の
追加authorityである。Henji独自のbase instructionはmanaged revisionではなく、user scopeの`instruction.md`を
直接読み込む別authorityであり、workspace `AGENTS.md`、native Skill、managed Skillと合成順・provenanceを区別する。
最終的に同じprovider instructionへ合成されても、identity、selection authority、合成順、provenanceを失わない。

Henji共通baseは、binaryに埋め込む最小core（役割identityとcredential/Authorization境界）と、user scopeの
`$XDG_CONFIG_HOME/henji-harness/instruction.md`を直接読み込む外部contentからなる。外部ファイルは
`henji-resource.json`、install、activation binding、XDG data storeを必要としない。Hostはgeneration開始前に
ファイルを一度読み、存在すればbuilt-in coreを置き換え、存在しなければ最小coreを使う。contentはvalidation後も
trim、改行変換、Unicode normalizationを行わずbyte-equivalentに投影し、source identity `user/instruction.md`と
content digestをattributionへ固定する。read failureやinvalid contentはbuilt-inへ暗黙fallbackせず、turn開始前に
失敗する。workspace scope、transport、`/rebuild`はこのkindに含めない。

Hostはgeneration開始前にselected built-in/external baseのexact ref、content digest、exact bytesとbyte-equivalent textを
解決し、Definition評価結果とは独立したdata-only Worker-core入力へ固定する。Definitionはrole、active tool guideline、
workspace instruction、Skill manifest、runtime facts等のbaseを除くinstruction contributionを返す。Workerのmandatory
finalizerはselected baseを先頭に置き、Henji-ownedな二つのLFだけをcomponent境界として後続contributionへ連結する。
async childも同じselected baseを再解決せず使う。resolved exact ref/content、final system instruction内のprojection、
provider requestとの関係はexecution context attributionへ保存し、完成payloadの別authorityを追加しない。

#### MCP integration

MCPは一つのHenji toolまたはmanaged moduleではなく、外部serverが提供するtool、resource、prompt等をHenji側clientが
発見・利用するprotocol境界である。HenjiはMCP protocol client/version/transport adapter、server connection
declaration、credential、local server packageまたはremote service、実行時に発見したcapability projection、
call/result evidenceを別authorityとして扱う。

native MCP connectionにHenji managed installを必須にしない。接続後に発見した個々のMCP toolは、connection identityと
server内tool nameを対応付けたWorker向けtool projectionとして提示し、MCP `tools/call`へdispatchする。resource、prompt、
server instructionsはtool revisionへ変換せず、それぞれのMCP protocol operationから得るruntime inputとする。
connection declarationやserver artifactのexact pin/transportが必要になった場合だけ、後続Integration resourceとして
managed pathを追加する。credentialはportable artifactへ含めず、capability snapshotとcall/resultはSession/evidenceへ
相関する。client、transport、dispatchをHost、Worker、subprocessまたは別processのどこへ置くかはここでは固定せず、
後続Integration Incrementで実利用経路とauthorityに合わせて決める。

#### Provider設定の外部化

Providerのroute（provider ID、API protocol、auth profile）とmodel catalogはdata-only declarationで表す。
`openrouter-chat`、`openrouter-responses`、`openai-chat`、`openai-responses`はbinaryに同梱する既定宣言であり、
`$XDG_CONFIG_HOME/henji-harness/providers/*.json`のexternal宣言はbinary更新なしで新しいprovider IDを追加できる。
同じIDのbuilt-in overrideはprotocol、endpoint、auth profileを変えず、catalogとdefaultsだけを置き換える。
OpenRouter Chat CompletionsとResponsesは別routeとして併設し、既定は`openrouter-chat`である。

一般化したprovider identityは`providerId` + `protocol` + `authProfile`であり、`openai-chat-completions`と
`openai-responses`のprotocol adapterはbinaryが所有する。declarationはdata-onlyで、endpoint、固定model catalog、
defaults、新しいprovider IDに限るoptional `headers`を持つ。`authProfile`はpattern検証する非secretのidentityで、
credentialは`<XDG_CONFIG_HOME>/henji-harness/<authProfile>`の固定fileからrequest時に解決する。effective model
selectionは`provider`（providerId）／`api`（protocolまたはbuilt-in surface）／`authProfile`／`modelId`／`effort`
としてSessionとevidenceへ保存し、endpointやcatalog sourceはidentityへ含めない。Responses replay stateは生成元
provider IDとmodel IDが一致する場合だけ再利用する。

Host configの`default-selection.json`がrootの既定selectionを選び、未設定時は同梱`openrouter-chat`既定を使う。
外部Agentのchild executionのmodel選択機構は通常のroot selection経路を使う。selectionの値はspawn入力の`model`
指定または親Sessionの現在selectionから決まり、Agent名別の同梱model既定は持たない。
credential値、Authorization、tokenはdeclaration、managed revision、Session、evidence、transcript、Definitionへ
含めない。provider固有adapterのphysical placement、dynamic model取得、追加protocolは未決であり、採用時に
architectureへ戻る。詳細は[`multi-provider-routing-and-auth.md`](multi-provider-routing-and-auth.md)を正本とする。

#### managed revision transport

local custodyとinstallation間transportは別contractである。export packageはstore directory layoutを公開形式にせず、
選択したexact revisionのmanifestとcontent closureを含める。import先はlogical identity、contract、content digestを
検証して自身のmanaged storeへatomicにpublishする。credential、Session、workspace、Henji binary、built-in resourceは
Definition transport packageへ含めない。初期transportはAgent Definitionだけを扱うが、transportを必要とする後続
resource kindはkindを識別できるpackage envelopeを拡張できる。transport実装は、他resource kindのlocal managed化の
必須前提ではない。

有効toolが利用指針を持つ場合、tool metadataはprovider向けtool definitionとは分離して保持し、Definitionが
registryをmaterializeした後にAgentCompositionのsystem instructionへ合成する。現在は`read`の選択と
`offset`・`limit`による継続読込みの指針を`read`を宣言したAgentへ、切り捨てられた`bash`出力を
`bash_output`の`outputId`と`nextOffset`で継続取得する指針と、currentまたは外部情報に`web_search`を使って
具体的なquestionを渡し、返されたsource URLを対応する主張の近くへ引用し、不足と推論を明示する指針を、
それぞれのtoolを持つdefault parentだけへ合成する。

現在のdeclarative registry経路では、`read`、`write`、`edit`、`bash`、`bash_output`、`web_search`、`web_fetch`を
managed tool Definitionからmaterializeする。bundled tool Definitionは既存tool factoryをruntime bindingへ結び付ける
薄いmoduleである。tool identityの宣言は各Agent Definitionがownerで、`additionalTools`で追加identityを宣言でき、
`tools.json`のexternal tool Definition bindingが同名identityを差し替える。Host提供の`toolDefinitions`はroot
Definitionへ渡り、宣言したidentityだけをmaterializeする。catalog外の新しいidentityはbindingが
無ければ起動時にtyped failureとなり、plugin探索、hot reload、componentの独立revision・import dependency lineageは
まだない。

default parentの`web_search`は、前節のmanaged resource kind `tool-definition`として供給されるbundled tool
Definitionが、provider-neutralなHenji-owned tool contract（`WebSearchBackend`）を実装する。bundled実装は既存
OpenRouter credentialをcredential解決済みprovider request seam経由で使い`perplexity/sonar`を一回呼び、回答本文と
順序付きURL citationを受け取る。model-visibleなtool resultではSonar answer内の有効な`[n]`を同じresponseの
annotationに対応する直接Markdown linkへ変換し、source一覧も番号なしのlinkとして返す。Sonarには具体的な
user questionと、検索結果に限定して不足・near miss・推論を明示するsystem messageを渡し、通常検索のcontext
sizeは`medium`とする。
Sonar requestは親turnのmodel request budgetを一件消費し、main modelと同じcounted fetch、AbortSignal、
短いrequest factを共有する。tool call元のmodel stepを
request recordへ関連付け、HTTP statusと解析失敗の項目・値の形をreadback可能にする。外部Agentが
`web_search`を使うかどうかは自身のtool宣言で決める。`tools.json`のactivation bindingでexternal tool Definitionをbindした場合は、そのDefinitionが
model・backend・annotation解析を所有する。OpenRouter `openrouter:web_search` server toolは現在使わず、
同じbackend境界への将来候補とする。

default parentの`web_fetch`も同じmanaged tool Definition経路で供給される。bundled実装は素のHTTP GETで
http/https URLを取得し、HTTP status、final URL、content-type、本文（1 MiB上限・切り詰め表示）を返す。
`text/*`・JSON・XMLはUTF-8としてdecodeし、HTMLは最小のtext抽出を行う。非textualはメタのみを返し、非2xx・
network失敗・invalid URLはtool errorとする。この取得は任意hostへのnet権限を必要とし、compiled binaryとdev taskの
`--allow-net`を無制限にしている。hard sandbox（R3）とは別のplatform権限である。

default parentの`bash`と`bash_output`は、一つのRegistry lifetimeで一つのtemporary output storeを共有する。
4 KiBを超えたstdout/stderrはprocess-localなopaque identityへ保存し、UTF-8 byte offsetのbounded windowで
後続callから取得できる。storeは`/tmp`で一つのfile handleを開いて直ちにunlinkし、1 command 32 MiB、
1 Registry 128 MiB、retained stream 4,096件を固定上限とする。上限到達時は実行commandを停止してpartial
readbackを残し、未commitのcancelled outputは同じhandle上でextentを詰めて容量を回収する。process再起動、
Session resume、別Worker generationをまたぐdurabilityは持たない。

Worker は terminal、TUI layout、その他の Surface を所有しない。turn を実行するために特定の
UI を要求してはならない。

### Surfaceと現在のTUI

Surfaceは、人間のactionをHost commandまたはWorker向けprotocol messageへ変換し、Workerから返る意味上の
進捗、tool activity、assistant output、turn settlementを人間へ提示するHost adapterである。Surface固有の
key binding、layout、draft、cursor、viewportはWorker protocolやcanonical Session stateへ混入させない。

現在の非対話CLIもHost側のheadless Surfaceであり、TUIと同じWorker session factory、Definition評価、
composition、proposal / commit / acknowledgement、close経路を一turnだけ使う。Session transcriptは永続化しない。
Surface contractは、既定のfinal-only stdout（成功）／failure JSON（失敗）／exit codeに加え、`--json`のcurated
NDJSON event streamと`--stream`のlive assistant textを持つ。外部へ出すのはHost-owned projectionであり、
Worker内部`AgentEvent`やprovider-private replay state、Host内部durability/evidence IDは露出しない。

現在の対話SurfaceであるTUIは、通常利用の画面を次の領域として構成する。

- 人間の依頼、assistantの応答、短いtool activity、結果を追えるconversation log。
- draftを保持し、複数行を編集できる入力欄。
- ready / busy / failure、過去表示中の位置と復帰操作、pending input、操作結果など、その時点の判断に必要な
  一時status行。
- 対象physical workspace、現在のSession短縮ID、Session titleを常時示すsession行。
- 選択中root provider、model、effortを常時示すmodel行。

conversation logのturn境界、user入力と最初のtoolまたはassistant出力の境界、logと入力欄およびfooterの
境界は、Host側layoutが表示専用の空行として導く。canonical transcriptやWorker eventへ空messageを
追加しない。現在SessionのviewportはHost-localな`followLatest` / `anchored` stateで管理し、過去表示中は
位置と`Esc latest`を示す。PageDownで末尾へ到達した場合、idleのEsc、または通常taskのadmission成功時に
最新追尾へ戻る。

conversationの`user>`、settledした`assistant>`、`tool>`、`system>`のlabel styleもHost側の表示metadataで
あり、現在はそれぞれblue、yellow、green、magentaで識別する。ANSI sequenceは最終的なterminal frame生成時
だけ加え、layout、canonical transcript、Presentation eventはplain textのままとする。assistant本文はHost
TUI内の差し替え可能なrenderer componentを通すが、現在のdefault rendererは入力textをそのまま返すため、
streamingとsettled outputの内容を変更しない。

`henji history`は別プロセスのread-only viewerである。現行storeをread-onlyで開き（schema作成・reconcile・lockを
行わない）、単一read transactionで対象Sessionのcanonical transcriptまたはdurable historyを読み、`session`／
`canonical`／`detail`の3種類をstdoutへ出力する。`session`の通常表示は意味上の実行記録を読む。
TUIプロセスとは独立でcredentialを要さず、ファイル化はshell
redirectに任せる。TUI内のhistory overlayと`/history export`は持たない。

同一Session内のOpenRouter model/effort選択もHostが所有するsession-level runtime stateであり、Definition
revisionではない。idle時の選択をHostが先に永続化し、Workerは次のroot turnから使用する。一turnのtool loop中は
選択を固定する。Session schema v6はactive選択、
変更履歴、commit済みturnごとのmodel attributionを保持する。同じOpenRouter provider内の切替後もcontext
checkpointを再利用し、そのsource profileは生成時のprovenanceとして保持する。

production TUIと`henji run`は、Host admission済みの`--provider-timeout-ms`をstart commandでWorker generationへ
渡す。Workerは同じ値をroot、async child、context compaction、補助provider requestへ適用する。
このrequest単位deadlineはSession stateではなくinvocation stateであり、TUIのSession切替では変わらない。
未指定時は300,000 msを使う。deadline到達は`provider_timeout`としてdiagnosticとPresentationへ運び、response
shape不正と区別する。cleanup中にもtimeout分類を保持し、利用者cancelが同時に確定した場合はcancelを優先する。

通常logは、人間が作業の流れと結論を追えるsemanticな表示とする。tool call／resultは意味上の履歴へ残し、
provider requestごとの短い失敗factも明示的にreadbackできる。raw provider responseやSSE断片は通常実行で
収集せず、必要な場合は別probeで取得する。

Terminal TUIの起動中は現在のSessionの画面をalternate screenへ隔離し、streamingやprogressの再描画で
terminal scrollbackへ途中frameを蓄積しない。正常終了、cancel、signal、出力失敗では、input、terminal
mode、起動前画面、cursorをHostが復元する。未送信draft、viewport、入力履歴などのUI-local stateと、
Host storageに保存するcanonical transcriptやSession identityは区別する。

recoverable settlementで未commitのactive taskが残る場合、Hostはeditorを変更せず停止理由をstatusへ示し、
人間の再送を待つ。未commitのtaskはrecovery専用laneへ退避せず、再送は入力履歴（Up）に任せる。これらのeditor
操作はcanonical Sessionへcommitしない。idle Ctrl-Cはeditorとinput-history navigationだけをclearし、exitは
空editorのCtrl-Dまたは`/exit`で明示する。busy cancelと外部signalの遷移は別に保つ。

具体的なkey binding、slash command、表示量、editor機能はarchitectureの固定事項にしない。人間の通常利用で
観測した必要に応じ、roadmap上のTUI incrementとして変更できる。第二Surfaceまたは一般的なSurface load /
selection / replacementを採用するときも、WorkerをSurface依存にせず同じ境界を使う。

物理的な terminal と Surface I/O は Host が所有する。一方、provider/tool effect の物理 I/O を
Worker が直接実行するのか、Host の RPC/capability 経由にするのか、subprocess 境界に置くのかは
重要な未決定事項である。現行または将来の個別実装上のplacementを、別途architectureで決定せずに
確定事項とみなしてはならない。

この境界を通るのはdataとprotocol messageである。JavaScript関数そのものは境界を越えない。
Deno Web Workerのstructured cloneでは関数を送れないため、DefinitionはHostからcallable valueとして
渡さず、Worker内で評価する。根拠となるAPIとlocal probeは
[`docs/research/host-worker-reference-comparison.md`](../research/host-worker-reference-comparison.md)
に記録する。

Deno Worker permissionだけでは、`--allow-run`で起動したsubprocessとそのdescendantを隔離できない。
したがって、このWorker境界はlifecycleとdataの境界であり、完全なsandboxや別のtrust tierとは扱わない。

### Durable history、canonical conversation、context projection

Henjiの履歴全体と、以後の通常会話へ既定で引き継ぐconversationを同じ状態として扱わない。

durable historyは、一つのclaimへ一つのownerを置き、次の三層を区別する。

- semantic authority: canonical／non-canonical message、tool call／result／effect、model-visible
  context order、providerから読めたthinkingの実行・model step付き観測（完了／未完了を区別）、Hostの
  admission／outcome／canonical decision、使用したAgent／build／resource revision、`/recall`の
  source／target relation、provider・model・API経路・論理step・物理request順番・HTTP／error・解析失敗の
  項目と値の形を表す短いrequest fact。
- derived projection: 人間向けhistory view、context manifest、artifact表示、
  summary／compaction、export、later reinterpretation。
- storage mechanism: codec、physical locator、representation digest、index、audit metadata。

通常履歴はsemanticな出来事から、人間入力、Agentへ実際に渡したcontent／revision、tool／providerのsemantic
result、Host判断、明示的な未観測境界へ至る最小説明閉包を持つ。rootとasync childの双方で、観測済みの
request factとfailure diagnosticを各executionへ相関して保存する。途中のcancelや失敗では確定保存済みの
prefixを残す。credential値とAuthorizationは記録しない。semantic authority自体のdurable write失敗は
canonical adoptionを禁止する。async childのcollect結果はstop reason、実request count、diagnostic id／code
などの短い状態を返す。

derived projectionはsemantic authorityにsourceを持ち、sole-owner fieldを
持たない。現行の`henji history`は必要時にsourceから直接view／exportを作り、永続化されたhuman history行や
更新outboxを使わない。derived documentの生成失敗はsemantic commitを取り消さない。

canonical conversationは、Hostが正常完了と会話への採用を確定したturnを順序付きで保持するSessionの正本で
ある。正常完了は回答内容の正しさや人間の満足を意味しない。canonical採用はturn全体を単位とし、途中の
assistant outputやtool interactionだけを部分的に採用しない。turnへ含める具体的なmessageとprojectionは個別schemaで
定める。

executionの状態は少なくとも次の独立した軸で扱う。

- lifecycle: active / settled
- outcome: completed / cancelled / failed / interrupted / unknown等
- conversation adoption: canonical / non-canonical
- effect observation: requested / started / completed / failed / outcome unknown等

non-canonical executionも、観測済みevidenceをstorageへ物理的にcommitしてreadbackできる。storageへのdurable
writeとcanonical conversationへの意味上の採用は別operationであり、`uncommitted`という語は後者だけを指す
場面でも誤解を招くため、通常は`non-canonical`を使う。

実行中のHostがforced interruptionを観測してterminalへ収束させたexecutionは、実際の`interrupted` outcomeを持つ
通常のsettlementとして保存する。restart時にactive prefixを発見し、実際のterminal outcomeを観測できない場合の
reconciliationとは区別し、後者のartifactへ実outcomeを捏造しない。

#### History storage不変条件

- logical record／occurrence／decisionのidentityはsegment、offset、page、codec等のphysical locatorから独立する。
- immutable contentはalgorithm／version付きcontent digestを持つ。compressed representationを保存する場合だけ
  content identityとrepresentation digestを分離する。
  同じbytesでも別execution／source／occurrenceなら発生factを統合しない。
- append時にcurrent semantic deltaのschema、execution内ordinal、mandatory referenceを検証し、count、
  latest durable ordinal、terminal、unresolved referenceを増分更新する。ordered hash rootはsettlementの
  必須条件にしない。
- normal append／settlement／adoptionは過去payloadをapplication levelで全scan／decode／rehash／rewriteしない。
  同量の新規factを追加する処理量は既存Session payloadや当該executionの過去event数を乗数に持たない。
- `settled`はlogical completeness、terminal、mandatory referenceの解決を意味し、全過去payloadをsettlement時に
  再scrubしたことを意味しない。materializeするimmutable contentはread時に検証し、全体検証はexplicit auditとして
  通常pathから分離する。
- crash後に見えるexecution evidenceは最後にatomic commit済みの連続ordinal prefixに限る。未commit
  segment／locator／rootをcompleteとして返さない。

将来の自己改訂experienceはstableなsemantic occurrence、history entry、execution、query／rangeを参照する。
projection再構築によって参照先のsemantic identityを
書き換えない。experience selection、assessment、candidate、human judgmentのdomainとappend ownerは
F19〜F24で定め、history storageが先に固定しない。

人間向けhistory viewは、canonical turnとnon-canonical executionの双方を識別して辿れるようにする。
Markdown、tool summary/detail、status等のrendererはHost/Surfaceの表示責務であり、保存内容、採用状態、
model contextを変更しない。
読めるthinking本文と要約は作業単位にまとめて表示し、要約はその旨を明示する。暗号化itemから本文を
作らず、stream断片を一件ずつ通常履歴へ永続化しない。表示するthinkingはprovider-private replay stateや
modelへ渡すsemantic conversationへ混入させない。

model context projectionはhistory viewとは別責務である。過去executionから既定で引き継ぐconversationは
canonicalに限定する。一方、現在execution内で得たassistant stepやtool resultはそのexecutionの後続model requestへ
渡すことができ、人間が明示的に選んだreferenceも目的と期間を限定して追加できる。

Increment 38の`/recall`は、settled non-canonical executionを人間が選び、保存済み内容を次の一つのtaskへ
data-only contextとして投影するHost operationである。sourceをcanonical化、resume、自動retryせず、source identity、
実際のprojection、target executionを相関する。projectionの選択は次taskのadmissionで消費し、そのtask内の各model
requestで利用できる。targetがcanonical採用されてもsourceはnon-canonicalのままであり、targetが生成した内容は通常の
canonical conversationとして後続へ残り得る。projection本文をcanonical turnへ含める具体的範囲は未決である。

### Execution context attribution

各executionは、使用したAgent側の基底設定、base canonical Session revision、明示projection、実行中に読み込んだ
resourceや観測情報と相関できるようにする。存在していたresource、discoveryで発見したresource、実際に読み込んだ
resource、modelへ渡した内容を同じ事実として扱わない。

振り返りの対象候補は、Henji共通instruction、agent role、workspace `AGENTS.md`、skill catalogと実際に読み込んだ
skill、Henjiが所有または観測できるsystem instruction、Agent Definition、modelへ提示したtool contract、modelへ
供給したruntime facts、toolで観測した環境情報である。現在のmutable fileへのpathだけでは当時の内容を振り返れない
resourceは、Henjiが観測した内容または同等のattributionをevidenceへ残す。

`instruction:henji-base`では、実行時にselectedだったbuilt-in/external exact ref、slot、selection source、content digest、
exact contentを記録し、同じexecutionのfinal system instructionと各provider requestへ投影されたbyte rangeを相関する。
authoring source、managed custody、active binding、execution attributionは別authorityであり、現在のbinding変更で過去の
attributionを書き換えない。

このattributionは完全再現性を目的にしない。過去Worker、model内部状態、dependency、binary、OS、filesystem、
外部service、tool effectをsnapshotまたは再構築する保証にはしない。

`AgentContextGeneration`を採用する場合、それは`/rebuild`によって構築・有効化したAgent側の基底設定を表す。
canonical conversationはturnごとに進み、skill本文やtool result等はexecution中にも追加されるため、generation ID
だけで実際のmodel input全体を表さない。process/isolateのlifetimeを表す`AgentWorkerGeneration`と同じidentityに
するかも未決である。

### Context rebuild候補

人間向けHost operationの候補である`/rebuild`は、再解決の対象として定めたresourceから新しいAgentの実効状態を
構築し、後続executionへ適用する。単なるfile rereadではなく、改訂されたresourceを次のAgent側基底設定へ反映する
activation境界として扱う。

対象resourceと更新可能範囲は未決である。workspace instructionとskillに加え、Agent Definition、tool contract、
tool implementationも候補に含む。toolを対象にする場合は、modelへ提示するcontractと実際にdispatchするimplementation
の対応を定める。native resourceの現在内容を再解決する操作と、managed candidateの人間承認、immutable revisionへの
promotion、active binding transitionを同じoperationにするとは決めない。

採用時には、active executionの途中で基底設定を切り替えず、新しい設定の構築成功後だけ後続executionのactive
generationを変更する方向を保つ。canonical conversation、未送信draft、過去executionとそのattributionは書き換えない。
構築失敗時に旧generationを維持すること、context transitionをHost-owned evidenceとして記録することの具体的な
identity、commit順序、failure semanticsは個別incrementで定める。

cancel/failed executionのtool effectとしてresource fileが変更された場合、その変更自体は既に外部副作用として
存在し得る。`/rebuild`は、対象resourceの現在内容を新しいAgent状態へ取り込む境界であり、source executionの
canonical化、既に生じた副作用の承認または取消しを意味しない。

### Definition revision と generation の fencing

この境界での admission と commit は、次の revision binding 不変条件に従う。これは具体的な
field や schema を定めるものではない。

- Worker generation は、少なくとも `AgentInstance` identity、Definition revision、
  generation/lease identity、base session state revision と相関する。Instance-wide state が存在する
  場合は、その state の revision も相関させる。
- Host は、現在 admit されている generation から、かつ一致する Definition revision と base
  session state revision から来た proposal だけを受理する。この不変条件は live generation に適用し、
  保存履歴の閲覧には適用しない。
- 同じ revision の Worker restart と新しい revision への切り替えは別の事象である。revision の
  変更は明示的で durable な transition とし、記録する。継続時の保存 ref との不一致は transition の
  契機であって失敗条件ではない。

## セッションの永続性とコミット

Host/Worker 分割によって、実行中の Worker が durable truth の source になってはならない。

### AgentInstance と Session の関係

次の関係と canonical domain を維持する。

- 1 つの Session は必ず 1 つの `AgentInstance` に属し、1 つの `AgentInstance` は 0 個以上の
  Session を持てる。
- Session は transcript、context、turn commit などの conversation semantic state を所有する。
  `AgentInstance` は stable identity と active な Definition revision binding を所有する。
- 同じ `AgentInstance` に admit される writer Worker generation は、一度に 1 つだけとする。
  Host は admit した input を serialize して、その Instance の generation へ渡す。
- mutable datum は Session または Instance のいずれか 1 つの canonical domain に属する。将来
  Instance-wide mutable state を導入する場合、Host は Instance 単位の revision、lock、persistence
  も所有し、session state と二重の正本にしない。

| 責務 | HenjiHost | Agent Worker |
| --- | --- | --- |
| Session identity | session ID と `AgentInstance` との association を所有する。 | 現在の実行でその identity を使用する。 |
| Concurrency | lock と session の serialized admission を所有する。 | ephemeral な turn 中 state だけを持つ。 |
| Persistence | load/store、storage revision、atomic replacement、recovery を所有する。 | commit を提案する。durable state の canonical source にはしない。 |
| Conversation の意味 | 受け入れた canonical state を保存する。 | 実行中の transcript/context semantics と compaction decision を所有する。 |
| Turn の settlement | proposed commit を受け入れ、committed と報告する前に durable に保存する。 | 境界を通じて outcome と proposed state/effect を報告する。 |
| Execution evidence | canonical採用とは独立して、観測済みprogress、effect、outcome、context attributionを相関・保存する。 | 実行中のsemantic eventとsettlementをprotocol経由で返す。 |

概念上の turn の流れは次のとおりである。

1. Host が canonical session state を load し、Worker generation への command を受け入れる。
2. Worker が snapshot を解釈して composition を実行し、turn 中の output と commit proposal を
   生成する。
3. Hostは観測済みevidenceをbounded appendとしてatomicに保存し、commit後だけdurable acknowledgementを返す。executionの
   settlementはincremental ledgerのroot、count、terminal、unresolved referenceを照合し、過去payload全体を再検証しない。
4. canonical採用時、Hostはsettled execution root／terminalと適用対象Session revisionを照合し、canonical turnとSession
   revisionを一transactionで保存する。
5. durable canonical adoptionが成功した後にのみ、HostはSurfaceまたは採用済みoutput consumerへturnをcommittedと報告する。

### Effect と commit proposal

Worker から返るものは、概念上、`effect request`、`effect started/completed/unknown evidence`、
`state commit proposal` として区別する。ここではそれらの field や schema を定めない。
durable commit が存在しないことだけでは、effect が発生していないことや、安全に replay できる
ことの証拠にはならない。したがって、effect が開始された可能性のある turn/event は、明示的な
idempotency/deduplication 契約、または effect が開始されていないことの証拠がない限り、transparent
に再実行しない。これは product correctness の不変条件である。

Persisted Host state が durable truth であり、その中でcanonical conversationとnon-canonical execution evidenceを
区別する。Worker state は ephemeral である。Worker の crashまたは置換によって、まだHostが受け取ってdurableに
保存していない作業状態が破棄される可能性がある。turn または canonical commit
が失敗した場合に tool effect が rollback されるとは限らない。local filesystem、subprocess、
network、その他の effect には、それぞれ将来の semantics が必要である。この文書はそれらの
semantics を定義しない。

## 経験からDefinitionへ進む改訂ループ

このarchitectureがDefinitionについて定める改訂ループは、次の関係である。

1. Hostのstorage mechanismが、通常利用で観測された経験を、必要ならSessionをまたいで後のWorker
   generationから読める形で継続的に保存する。
2. 人間の明示的なアクションまたは指示を受けて、Worker内のAIが保存された経験を読み、その意味を解釈
   して、Definitionの改訂候補をsource、diff、またはdataとして生成し、interfaceを通じてHostへ返す。
3. Hostは改訂候補を現在使用中の`DefinitionRevisionRef`と区別して保存し、生成されただけでは実行対象に
   しない。
4. 人間が採用アクションを行うか、提示された候補を明示的に承認した場合だけ、その候補をimmutableな
   `DefinitionModuleRevision`として確定し、Hostが`AgentInstance`のbindingを明示的かつdurableに切り替える。
5. 改訂後も通常利用を続け、そこで観測された変化を次の経験として保存する。

このループは、変更前後の比較実験、改善の定量測定、Henji全体の構成追跡を要求しない。何を経験として
残すか、AIがどの経験を読むか、人間のアクション、指示、承認をどのSurfaceとprotocolで表現するかは、
このarchitectureでは固定しない。Workerが人間の契機なしに改訂候補を自発的に生成することや、Hostが
候補を自動採用することはない。

Definition以外のinstruction、skill、tool等を改訂対象にする場合も、経験、candidate、active resource、
後続executionへの適用を区別する。`/rebuild`を採用しても、candidate生成や人間の採用判断を自動化したことには
ならない。native resourceの現在内容を再解決するflowと、managed candidateをimmutable revisionへpromotionするflowの
対応は、対象kindを選んだroadmap incrementで定める。

## AgentInstanceの継続性とHostの追加機能

`AgentInstance`の継続性は、Worker generationを置き換えてもidentity、durable metadata、activeな
Definition revision bindingをHostが維持することで成立する。同じInstanceに対するwriter generationは
一度に1つだけとし、Hostがinputをserializeする。この構造だけでは、mailbox、複数Surface間のrouting、
scheduleをproduct機能として採用したことにはならない。

roadmapが各機能を個別に採用した場合は、次の責務分離に従う。

| 追加機能 | Host の責務 | Worker の責務 |
| --- | --- | --- |
| Mailbox | Worker が不在または置換中である間も含め、`AgentInstance` の input queue を永続化する。 | dequeue した event を解釈し、agent の response または次の intent を決める。 |
| 非同期または複数Surface間のRouting | inbound message を `AgentInstance` と Session に対応付け、正しい Surface に output を返す。これは tool-name dispatch ではなく、message/Instance routing である。 | 現在の execution context が宛先となる output を生成する。物理channelの選択は所有しない。 |
| Schedule | wake-up intent、time、delivery mechanics を永続化し、通常の mailbox event を enqueue する。 | schedule intent の意味を所有し、結果の event を通常の agent input として処理する。 |

常にaddress可能なagentをproduct機能として採用する場合は、ephemeral Workerだけでは成立せず、
常時稼働するHost、durable storage、service supervisorまたは同等のlifecycle ownerを必要とする。
その場合もWorker自体を常駐させる必要はなく、mailbox、routing、scheduleの採否はそれぞれ別に決める。

## 外部比較の位置付け

Deno、Cloudflare、Pi、Zot、OpenComputer、OpenClawとの詳細な比較は
[`docs/research/host-worker-reference-comparison.md`](../research/host-worker-reference-comparison.md)
に背景調査として分離する。このarchitectureが採用する結論は次に限る。

- Henjiの実行primitiveはDeno Web Workerであり、Cloudflareのデプロイ単位としてのWorkerではない。
- `AgentWorkerGeneration`はephemeralなexecutorであり、durable stateの正本ではない。
- HenjiHostは、採用したlifecycle、routing、storage、supervisionを自身の責務として実装する。
- 外部実装との類似は、Henjiのprotocol、managed semantics、機能優先順位を決めない。

managed externalization、native discovery、MCP境界の比較根拠は
[`docs/research/externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)に分離する。
参照実装や外部protocolはHenjiの仕様そのものではなく、この文書に明記したtaxonomy、identity、authority、
compatibility境界だけを採用する。

## 未決のアーキテクチャ判断

確定した制約は、それぞれの責務と境界を定める本文に置く。ここには選択肢が残る判断だけを、その理由と
判断する契機とともに記録する。roadmapは契機となるproduct機能を採用するかを決め、個別計画は採用された
機能に必要な判断を具体化する。

| 未決の判断 | 今決めない理由 | 判断する契機 |
| --- | --- | --- |
| `AgentContextGeneration`のidentity、所有する基底設定、`AgentWorkerGeneration`との対応 | `/rebuild`対象resourceとcomposition再構築のlifetimeが未決であり、execution単位の動的inputまでgenerationへ固定しない | `/rebuild`または同等のcontext再構築をroadmapで採用するとき |
| `/rebuild`対象resource、selection/activation authority、transitionのcommit/failure semantics | native instruction、skill、Agent Definition、toolでは更新方法とauthorityが異なる | 最初の`/rebuild` incrementで対象resourceを選ぶとき |
| `/recall` projection本文をcanonical turnへ含める範囲 | source/target identityと一回限りのmodel projectionは成立したが、canonical turnのprojection表現は未決である | canonical turnのprojection表現を変更するschemaまたは機能を採用するとき |
| provider/toolの物理I/OをWorker、Host RPC/capability、subprocessのどこに置くか | effect、latency、streaming、credential、利用するtoolの契約によって適切な境界が変わる | roadmapが具体的なprovider/tool利用経路を選んだとき |
| Worker protocolのmessage、handshake、error、versioning | 必要なmessageとfailure semanticsは、境界を使うproduct機能から決まる | 新しいHost / Worker間機能を実装するとき |
| Compositionをgeneration単位またはturn単位のどちらで構築するか | dynamicな再構成を必要とする利用者動作が確定していない | roadmapが実行中の構成変更を必要とする機能を選んだとき |
| Definition moduleで許すremote、JSR、npm dependencyの固定方法、revisionの更新・削除・GC | local module closureを保持する初期managed revisionと、新しいSessionへのexact revision指定には不要であり、実際の利用経路ごとに必要なsemanticsが異なる | 対象dependencyまたはrevision管理operationをproduct機能として選んだとき |
| MCP connection discovery/config format、tool name mapping、capability変更時のgeneration更新、server packageのmanaged化 | MCP protocol compatibilityとHenji固有のselection・durabilityは別contractであり、具体的な利用経路をまだ採用していない | roadmapがMCP integrationを採用したとき |
| Worker restart、cancel、concurrency、lease、backpressure | inputの並行性、streaming、effectの有無により必要なsemanticsが変わる | 複数入力、長時間turn、強制停止のいずれかを扱うとき |
| Surface identity、load / selection / replacement、置換時のUI-local state引継ぎ | 現在はTUIとnon-interactive commandで通常利用でき、一般化に必要な第二Surfaceの契約がない | 第二Surface、現Surfaceの置換、またはself-revision操作をTUI固有実装へ閉じない必要をroadmapが採用したとき |
| mailbox、非同期または複数Surface間のrouting、schedule、Instance-wide state、cross-session memoryの永続化 | それぞれ独立したproduct機能であり、AgentInstanceの継続性やHost / Worker分割だけからは必要にならない | roadmapが対象機能を採用したとき |
| effectのidempotency、deduplication、recovery | effect先の契約なしに共通のretryまたはexactly-once semanticsを決められない | recovery対象となる実tool effectを選んだとき |
| deployment profile、service supervision、migration | 実行先、可用性、移行元と移行先が決まらなければ必要なmechanismを選べない | 常時address可能なHost serviceの運用先または移行対象を決めたとき |
