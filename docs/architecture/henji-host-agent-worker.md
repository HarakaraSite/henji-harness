# Henji Host / Agent Worker アーキテクチャ

ステータス: 承認済みアーキテクチャ。roadmap、実装計画、Human Gate、実装認可ではない

対応するプロダクト構想は
[`docs/concepts/experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)
である。この文書は構想の目的を再定義せず、その実行基盤の構造を定める。

この文書は、Henji HostとヘッドレスなDeno Agent Workerの責務、状態、lifetime、commit境界を定める。

配置の現行source照合: commit
`7dc4f501`（2026-10-03）。利用者の「architecture/roadmap反映はやろう」により、 Increment
179のAPI/CLI Worker分離と、関連するIncrement 170のData Worker配置を反映した。
それ以外の領域はIncrement 168時点の照合記録を基礎とし、個別incrementの結果も参照する。

複数providerを同一SessionとWorker内で扱うroute、認証profile、model一覧、account binding、provider stateとevidenceの境界は、
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
  bundled executableは`default`と`generic`のDefinitionを持つ。rootのbundled defaultは`agent:default` bindingで
  置換できる。組み込み`agent:generic`は外部bindingなしで常時async child catalogへ解決される。
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
- UIは交換可能なHost-side Surfaceである。現行Hostは独立Core、Core所有のAPI/Data Worker、HTTP/SSEで
  接続するTUIに分かれる。Core mainは操作判断・実行制御・採用判断・公開revisionと購読を所有し、 Data
  Workerはcanonical Session・会話state・履歴と公開会話payloadの生成を所有する。 API
  WorkerはHTTP/SSE、TUIはterminal/draft/viewportを所有する。非対話`run`ではheadless Hostが
  CLI/Data/Agent Workerを所有し、CLI Workerが引数・stdio・出力drainを担う。 Agent
  Workerはheadlessであり、HostへのcontrolとDataへのdata channelで通信する。
- 自己改訂を支える基盤は、Agent自身による実行・実効構成・履歴の観測と、model選択、generic child起動、
  resourceからのrebuild等の構成操作である。Hostが観測のreadbackと状態適用を所有し、Workerが観測材料を
  選び、意味を解釈して操作を要求する。現在の実装状態はroadmapで分けて管理する。
- 現行の継続性は、Hostが保存・再開するSessionとexecution履歴を基盤とする。durable `AgentInstance`は
  複数Sessionをstable identityとactive bindingで束ねる追加機能であり、自己改訂の開始条件ではない。
  採用する場合、そのlifecycle ownerはHostとし、ephemeralまたは再起動されたWorker generationより長く存続する。
- durable Instanceを採用する場合、Hostの `AgentInstance` metadata は、その Instance が現在使用する
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
- durable historyのsemantic authorityを、messageとtool call/result、短いrequest fact、当時のruntime interpretation、
  Host decision／canonical state、Agent／build／resource attributionへ分ける。人間向け表示、model context、summary、
  後日のreinterpretationはderived projectionであり、元authorityを上書きしない。
- provider、model、API、論理stepと物理request順番、HTTP／error、解析失敗の項目と値の形を短いfactとして保存する。
  raw request／response、SSE断片、parser内部遷移全文は通常実行で収集せず、必要時の別probeで取得する。
  credential値とAuthorizationは記録しない。
- historyのlogical record identityをphysical locatorから独立させる。contentのcodec／配置を変更しても、
  occurrence、causal relation、canonical decisionのidentityを変えない。
- semantic appendとcanonical adoptionは別operationである。durable appendの確認はatomic commit後だけ返す。
  現行history v7（schema 11）は新規delta、連続ordinal、terminal、mandatory referenceを増分処理し、canonical turnとSession
  revisionを一transactionで保存する。ordered hash root、segment／directory／anchorを通常commitの必須条件にしない。
- 生成中のassistant本文はHostが同じhistory DB内でrequest単位の最新durable stateとして所有する。
  表示更新ごとの全文をsemantic occurrenceへ追記しない。完了時はmodel resultを本文のauthorityとし、
  未完了停止時は最後のcommit済み本文をsemantic履歴へ移す。本文stateとsemantic factの更新はatomicに保存する。
- 人間向けhistory viewの`session`は、canonicalとnon-canonicalのexecutionを時系列に並べ、後者の
  outcomeと未完了境界を明示する。`canonical`は採用済みconversationだけを表示し、`detail`はJSONLで
  原記録を参照できる。modelが過去executionから既定で引き継ぐconversationはcanonicalに限定し、
  現在execution内の文脈と、人間またはAgentが目的に沿って明示的に選んだ観測材料は別の入力として扱う。
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
| `AgentComposition` | 1 つの Worker 内で Definition が構築する、実行中の provider/model/effort/loop/tools/context コンポーネント。標準 Henji component は default であり、閉じた capability list ではない。 | 1 回の live composition evaluation は 1 つの Worker generation 内に閉じる。現行はgeneration内で構築し、idle時のSession selection変更をroot modelへ適用する。Agent起点のrebuild単位は未決である。 |
| `AgentManifest` | Definition または composition の、評価後の data-only な説明および identity の projection。何が選択されたかを説明するが、`DefinitionRevisionRef` とは別の authority であり、admission/permission authority ではない。 | revision/identity metadata。実行状態ではない。 |
| `AgentInstance` | 採用時に複数Sessionを束ねる安定したagent identity、そのdurable metadata、およびactiveな`DefinitionRevisionRef`のbinding。現行Sessionや自己改訂の前提ではない。 | Worker generationより長く存続し、置き換えられたWorkerで再開できる追加機能。 |
| `AgentWorkerGeneration` | 1つのDefinition revisionを実行する1回のephemeralな実行。保存Sessionから停止・再起動・置換できる。durable Instanceを採用する場合は、そのidentityも維持する。 | process/thread/isolateの存続期間。 |
| `Task` | 人間またはHostが一回の依頼としてadmitする入力。`/recall`等の次回限定projectionはこの境界で消費する。 | 一つのexecutionを開始する入力単位。再送やretryは新しいexecutionとして識別する。 |
| `Execution` | 一つのtaskを、あるbase Session revisionとAgent側の基底設定から実行する独立したattempt。進捗、model request、tool activity、outcome、canonical採用状態を相関する。 | activeからsettledまで。canonical/non-canonicalにかかわらずevidenceをdurableに保持できる。 |
| `Turn` | executionが正常完了し、Hostがconversationへ一括採用するuser/assistant interactionのsemanticな単位。 | canonical Session state内で順序を持つ。回答の正しさや利用者の満足を意味しない。 |
| `ModelRequest` | 一つのexecution内でprovider/modelへ行う一回のrequest。tool loopにより一execution内に複数存在できる。 | request/response evidenceとexecutionを相関する。 |
| `HistoryLogicalRecord` | message、tool call/result、短いrequest fact、runtime interpretation、Host decision、attributionの一つのsemantic fact。stable ID、execution内順序、causal ref、semantic content refを持ち、physical locatorをidentityにしない。 | Hostが観測しcommitしたsemantic authorityとして永続化する。 |
| `HistoryProjection` | authorityから導出するhuman view、search document、flattened request、model working context、summary、later reinterpretation。 | rebuild可能であり、watermark遅延をauthority欠落とみなさない。 |
| `AgentContextGeneration` | `/rebuild`相当の操作を採用する場合に、対象resourceから解決し有効化したAgent側の基底設定を表す概念。model input全体や`AgentWorkerGeneration`と同義ではない。 | 後続実行が参照する。具体的identity、対象resource、Worker lifecycleとの対応は未決である。 |
| `Surface` | TUI、CLI、JSON、Web、その他の channel など、Host 側で交換可能な interaction adapter。 | Agent Worker generationとは独立して所有・置換される。現行runのCLI adapterはHost所有のCLI Worker内で動く。 |
| `HenjiHost` | CoreのSession・Worker・process・storage所有と、Host-side Surfaceのterminal／UI-local state・operation変換からなる責務。 | 現行HTTP CoreはTUI detach後も稼働する。Core processのepochはdurable AgentInstance identityではない。 |
| `Core` | 一つのworkspaceと稼働Session slot、application operations、公開revision・購読、API/Data/Agent Workerとprocessを所有するHost process。 | 通常起動ごとに作る。ID/URLで再接続し、明示shutdownで終了する。 |
| `Data Worker` | Host所有のSession data service。canonical model data、会話state、semantic履歴・SQLite、公開会話payloadの生成とencodeを担う。 | Coreまたは独立headless Hostにつき一つ。Agent generationの置換でも正本を維持する。 |
| `API Worker` | Core mainへの非同期operation portを使うHTTP route・request/response・SSE adapter。 | Coreにつき一つ、同processのDeno Web Worker。Core mainが起動・終了を所有する。 |
| `CLI Worker` | `henji run`の引数・stdin・text/NDJSON/stream・stdout/stderr・drainを担うadapter。 | run invocationにつき一つ、同processのDeno Web Worker。headless Host mainが起動・終了を所有する。 |

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

現行の配置と所有関係は次のとおりである。

```text
TUI / 外部HTTP client（Surface）
        │ HTTP operation / Session snapshot・update（SSE）
        ▼
API Worker ── data-only operation・購読 ── Core main（Host）
                                            │ control・採用判断・process/child
                  Data Worker ◀── data ──▶ AgentWorkerGeneration
                     ▲   │                  Definition → Composition → turn
     Core mainからcommand│                  provider・tool semantics・context
                         ▼
              workspace共通SQLite（Host-owned semantic authority）

henji runのprocess
CLI Worker ── data-only 選択・実行要求 / event・結果 ── headless Host main
                                                       ├ Data Worker
                                                       └ AgentWorkerGeneration
                                                         ↔ Data直接channel
```

API/Data/CLI WorkerはHost側の実行場所であり、Agent Workerとは責務を区別する。
`henji run`は独立したheadless Hostから同じData/Agent経路と共有履歴DBを使い、HTTP Coreへ接続しない。

この図が示すのは所有関係であり、wire schemaではない。Host–Agentのcontrol contractは
`slice1-data-only-v1`、Host–DataとAPI/CLI adapterのportはそれぞれの内部message schemaを使う。
protocol versionのnegotiationはなく、
現在のmessage schemaを恒久的な契約として固定しない。将来拡張時のmessage、handshake、error互換性、
version migrationは未設計である。

### 現行Coreの状態所有と接続

一Coreは一つのcanonical workspaceと稼働Session slotを持つ。複数Coreは同じworkspace・XDGで別Sessionを
並行実行でき、保存先は`${stateRoot}/<workspaceDigest>/history-v7.sqlite3`を共有する。
Session writer lockは同一Sessionの二重writerを防ぐ。DB初期化はworkspace単位で同期し、write接続は
busy timeoutで待機する。restart reconciliationはSession／execution lockを取得できたactive記録だけを
対象とし、別Coreの生存実行をinterruptedへ変更しない。

Coreのepoch、endpoint、startup／instance lockとboot結果は
`${stateRoot}/cores/<workspaceDigest>/<coreEpoch>/`へ置く。epochはprocessの識別であり、Core終了後に
同じidentityで自動再起動するdurable Instanceではない。config、credential、managed resourceは従来の共有XDG
scopeを使い、Core数を保存先の分割や設定の自動同期へ置き換えない。

`henji core list/status`でCoreを発見・照会し、`core stop --core ID`で一Coreだけを停止する。
各Coreは自分のWorker／child／tool groupを所有する。親cancelは対象親子、Core shutdownはそのCoreだけを
清算し、他Coreを停止しない。同Coreへ複数TUIを接続でき、draftとviewportはclientごとに独立する。
予約follow-upは稼働Coreのpending stateであり、Core再起動後のmailbox復元は提供しない。

`v0/agent/host/core_service.ts`と`application_service.ts`が共通read modelとoperationを提供し、
Dataのencoded会話payloadを小さいcontrol stateと合成する。 `v0/agent/http/api_worker_client.ts`がCore
mainへのportを接続し、API Worker内の
`api_bootstrap.ts`・`server.ts`、`v0/api/`を介してTUIへsnapshot/updateを返す。operation結果の受付とexecutionの
完了は別で、接続が切れた場合も受付済みexecutionは継続する。実装結果と確認は
[Increment 139〜146](../increments/increment-146.md)および
[複数Coreの完了結果](../increments/increment-153.md)を参照する。

### Data Workerの状態所有と保存・公開

Data WorkerはSessionごとのcanonical model data、record組立て・検証、admission/terminal transaction、
semantic履歴、request単位の最新本文stateと共通ConversationStateの唯一のwriterである。 Core
mainは小さいSession/execution/generation index、実行予約、cancel/steering/follow-up、
採用許可とprocess/child制御を持つ。会話stateのCore側複製や別の表示用DBは作らない。

Agent–Dataの直接channelでcontext・semantic data・全文proposalを渡し、Core–Agentのcontrol channelでは
開始・cancel・process/child要求と小さいcorrelation/tokenを渡す。Dataはproposalの最終sequenceまで保存し、
recordを組み立ててprepare tokenを返す。Core/headless Hostは取消状態とchild/process清算を照合して
採用を許可し、Dataが対応するtransactionをCOMMITする。保存完了後にだけcommittedとして公開する。

保存factsの初回再生とliveの保存batchは同じnormalizer/applyFactを使う。
DataはCOMMIT後に会話stateへ一度applyし、変更entityとencoded snapshot/deltaを返す。
Coreはdata/controlの更新へ単一public revisionを付けて合成し、API Workerへ渡す。
Dataの保存版と公開cursorは区別し、通常の更新で過去全履歴の再読取・全会話のparse/再encodeを行わない。
offline `henji history`はread-only DB adapterと同じ更新器で参照する。
配置・保存と公開の契約は[Increment 170](../increments/increment-170.md)を参照する。

### API/CLI adapterのportとlifetime

API Workerはlisten、route、request decode、response、SSE framing・接続終了を所有する。 Core
mainがlisten成功のURLを受けてendpoint/readyを公開し、Core epoch/PIDはprocess identityを維持する。
操作は非同期request/replyで個別にdispatchし、重いreadのreply待ちでcancel等を直列化しない。
購読identityをsnapshot要求前に登録し、先着update/endを保持してsnapshot→updateの順に渡す。
HTTP切断は該当購読の解除であり、受付済みexecutionやfollow-upをcancelしない。 単独encoded
replyは利用を終えたbufferをtransferし、複数購読で共有するupdateはcloneして元bufferを保つ。
callback、CoreService object、DB handleはWorker境界を渡さず、公開errorもdataで対応させる。

CoreのHTTP shutdown・CLI stop・SIGINT/SIGTERMは共通の終了ownerへ接続する。
新規受付を止め、稼働executionへcancel、購読へ終了通知を出してSSEを閉じる。
SSE終了は保存完了の通知ではない。HTTP shutdownはaccepted responseを返す段階をmainへ通知し、 client
ACKを待たない。API handler/RPCのdrain後、Coreの実行・Data保存とclose、endpoint/所有lockの
清算を終え、listenerをgraceful shutdownしてAPI Workerとmainを終了する。
listener/Workerの予期しない終了もCore closeへ接続し、保存をterminateで省略しない。

runではmainがCLI Workerを起動し、CLIが引数を解釈してHostへDefinition選択を要求する。
Hostはstdin読取前にDefinitionを一度解決して実行可能objectを保持し、CLIへはdata-onlyなref/errorを返す。
CLIがstdin/`--task`と実行optionを渡し、Hostが同じ選択で`runHeadlessWorker`を実行する。
同じportのevent→Host清算後result→CLI出力drain後doneの順を維持し、mainがWorkerを終了してexit
codeを適用する。 CLI Workerは物理stdioを直接扱い、mainにstdio relayを作らない。
runのprocess宛signalに新しいgraceful保存保証は追加しない。
実装・受入と追加配送の測定は[Increment 179](../increments/increment-179.md)を参照する。

### HenjiHost が所有するもの

- Worker generation の起動、停止、監視、置換。
- 物理terminalとSurface I/OはTUI、API Worker、run CLI Worker等のHost-side adapterが所有する。 Core
  mainはapplication operations・公開revision・購読、Data
  Workerは会話state・保存・公開会話payloadを所有する。
- process実行の物理ownerと共通process executor。Worker-local proxyからのdata-only requestを受け、
  commandの制御端末分離、process groupの所有、cancel／forced termination／generation置換／close時の清算を担う。
- Surface実装のloadと置換の境界。現行SurfaceはactionをCore operationへ変換し、Coreが必要な
  Worker command/messageへ変換する。一般的なSurface loaderは未実装である。
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
  持たず、childは別Worker・別ExecutionとしてHostが扱う。
- toolのsemanticな実行とresult、Registryの出力store。processの物理実行はWorker-local proxyからHostの
  process executorへ要求し、Registry終了時に出力storeを明示closeする。
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
登録だけでは実行中のWorker generation、既存Session、採用時の`AgentInstance`のactive bindingを変更しない。
登録、list / inspect相当のreadback、新しいSessionへのexact revision指定は実装済みである。既存Instanceのdurableな
binding transitionとmanaged candidateのpromotionは、その機能を採用するときに決める。turn途中でDefinitionを置換せず、
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

Increment 131のgeneric childは、用途やmodelごとに名前付きDefinitionを準備せず、Agentがtaskとmodel、
tool構成を選んで別Executionを作る手段である。固定roleのvariantを増やすことを自己改訂の中心にせず、
観測・調査・実装等の依頼に応じて構成を選ぶ。内部にはbundled generic Definitionがあり、childの実行結果と
構成のattributionを保持する。これ自体を経験解釈や改訂cycle全体の実証とはみなさない。

childのspawn成功はchild executionのdurable admission後、collect成功はdurable terminal settlement後にだけ返す。
statusは子のlifecycleに加えて最新のmodel/tool作業状況と更新時刻を返す。Hostは子Workerの既存観測を
進捗snapshotと短いrequest factへ投影し、子Executionへ保存する。途中観測と最終collect結果は別authorityである。
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
削除した。core-owned tool（`skill`／`submit_json_result`と`spawn_subagent`／`subagent_status`／
`collect_subagent`／`cancel_subagent`）はDefinition化しない。同期`delegate_to_<name>`は廃止済みである。
tool Definition transportと任意kindの共通frameworkは後続incrementで扱う。

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

Provider routeはdata-only declarationのprovider ID、API protocol、endpoint、auth profileで表す。
binary同梱は`openrouter-chat`、`openrouter-responses`、`openai-chat`、`openai-responses`、`openai-chatgpt`の
五routeである。external `providers/*.json`は新しいprovider IDを追加し、built-in同名宣言はrouteを維持して
catalog/defaultsをoverrideする。既定はHost configの`default-selection.json`から選び、未設定時は
`openrouter-chat`を使う。

model一覧取得とお気に入りはCoreの`LiveModelCatalog`が所有する。通常はproviderのmodel一覧と公開effort
metadataを取得し、一覧掲載とお気に入り登録を選択可否から分ける。provider別JSONをconfigの
`model-catalogs/`へ保存し、お気に入り解除後もmodel別の記憶effortを保つ。metadata取得失敗時は保存候補を
使い、情報源を示す。external宣言の`modelListSource: catalog`は明示された固定一覧を使う経路であり、
OpenCode Goの暫定運用もこれを使う。ChatGPT一覧は選択accountに対応し、account別のcatalogと相関する。

非secret selectionはprovider/API/auth profile/model/effortとしてSessionとexecutionへ保存する。
rootはidle時に変更しturn内で固定する。childはspawn時の明示modelまたは親Sessionの現在selectionを使い、
Agent名別の同梱model既定は持たない。API keyはrequest時に固定config fileから解決する。ChatGPTは専用の
OAuth登録・選択と共有認証moduleで解決・更新し、root turn／child起動時のregistration参照を固定する。
credential値・Authorization・tokenはselection、Definition、Session、通常履歴へ含めない。

protocol adapterはbinary-ownedである。ChatGPTは共通Responses adapterへ認証、namespace形式のtool宣言、
account別replay identityを接続する。Responsesは同provider/model、ChatGPTはさらに同registrationのreplayだけを
再送する。effortを指定するResponses requestは`summary: auto`も要求し、読めるreasoning summaryをthinking
表示・履歴へ供給する。未指定effortの`auto`でreasoning設定を強制しない。

新provider宣言のoptional headers（`{credential}`／`{sessionId}`）とrequest時の置換、認証の保存・refresh・
account bindingの詳細は[`multi-provider-routing-and-auth.md`](multi-provider-routing-and-auth.md)を正本とする。
追加protocolやmodel生成HTTPのplacement変更は採用時に決める。

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
それぞれのtoolを宣言したAgentへ合成する。

現在のdeclarative registry経路では、`read`、`write`、`edit`、`bash`、`bash_output`、`web_search`、`web_fetch`を
managed tool Definitionからmaterializeする。bundled tool Definitionは既存tool factoryをruntime bindingへ結び付ける
薄いmoduleである。tool identityの宣言は各Agent Definitionがownerで、`additionalTools`で追加identityを宣言でき、
`tools.json`のexternal tool Definition bindingが同名identityを差し替える。Host提供の`toolDefinitions`はroot
Definitionへ渡り、宣言したidentityだけをmaterializeする。catalog外の新しいidentityはbindingが
無ければ起動時にtyped failureとなる。managed tool Definitionの独立したexact revisionとexecution attributionは
成立している。Definition manifestへのtransitive dependency binding／lineage固定、plugin探索、hot reloadは未実装である。

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
Registry終了時にstoreを明示closeする。processの物理ownerはHostにあり、Workerのbash Toolは共通process executorの
proxyを使う。foreground callの終了と、正常return後に残るbackground process groupのlifetimeを分け、groupは
Worker generationのHost側ownerが所有する。tool commandへHostの制御端末を継承させず、cancel、forced termination、
generation置換、closeは所有processの清算へjoinする（Increment 133）。

Worker は terminal、TUI layout、その他の Surface を所有しない。turn を実行するために特定の
UI を要求してはならない。

### Surfaceと現在のTUI

Surfaceは、人間のactionをCoreのapplication operationへ変換し、Session snapshotとupdateから会話、
作業状況、結果を提示するadapterである。現在のTUIはCoreと別processのHTTP/SSE clientであり、
terminal、draft、cursor、viewport、入力履歴、picker、表示用cacheを所有する。Core mainは実行受付、
selection操作、Worker lifecycleと公開revision・購読、Data WorkerはSession・semantic履歴と会話read
model、 API WorkerはHTTP/SSEを所有する。UI-local stateをAgent Worker protocolやcanonical Session
stateへ混入させない。

通常の`henji`／`henji tui`は新Core・新Sessionを作る。`--core ID`または`--connect URL`は生存Coreへの
明示再接続で、`--session ID`は新Coreで保存Sessionを再開する。TUIの`/detach`／Ctrl-Dは接続だけを
閉じ、Coreと受付済み実行を維持する。`/quit`／Ctrl-Qは接続先Coreを停止し、そのWorker・child・
tool processを清算する。Core選択とSession選択は別operationである。

非対話`henji run`はHTTP Core discoveryへ合流せず、同じWorker session factory、Definition評価、
composition、proposal／commit／acknowledgementを使う一turnのheadless Host経路である。canonical
Sessionは保存しないが、productionではData Workerがnon-canonical executionとsemantic履歴を共有history
DBへ保存する。 CLI Workerが入力・出力を扱い、headless Host mainが選択解決・実行・清算を扱う。
既定はfinal-only stdoutまたはfailure JSON、`--json`はcurated NDJSON、`--stream`はlive assistant
textを 出す。出力はHost-owned projectionであり、provider-private
replayや内部protocolをそのまま公開しない。

現在の対話画面はconversation log、複数行editor、三行footerで構成する。

| 行 | 現在の役割 |
| --- | --- |
| 1 | 入力・slash picker・履歴に応じた操作案内 |
| 2 | ready／working／cancelling、経過時間、接続・閲覧状態、workspace、Core／Session identity、title |
| 3 | provider、model、effort。項目間は`│`で区切り、provider:/model:ラベルは付けない |

経過時間はexecution.createdAtを起点とし、同じ実行への再接続やsnapshot反復で起点を変えない。
workingは送信・準備からsettlementと後処理まで、Coreが新規入力を受け付けられる状態へ戻るまで続く。
credentialの有無は`/login`の一覧で確認し、footerへ常設しない。操作失敗・認証保存・recall準備・
接続断等は本文の`system>`へ表示する。実行結果はCoreの記録、予約は稼働Coreのpending record、
local操作通知はSessionに対応づけたTUI-local stateから表示し、全通知をDBへ保存するものではない。
通知は対象executionの位置へ置き、snapshot反復で重複追加しない。

conversation logは、user入力、thinking、assistant本文、tool、結果の順序とturn境界を表示する。
Responsesの本文とtool callの併存時も本文をtoolより前に保持する。生成中の本文・thinkingはsnapshotで
更新し、thinkingはstepごとに一つに確定する。保存Sessionの表示でも途中本文、tool、step、終了結果を
相関し、stepを作り直すたびにthinkingを重複挿入しない。`spawn_subagent`行には対象agent名を示す。

assistant本文はHost Surface内のMarkdown rendererで見出し、list、table、quote、bold、emphasis、code等を
plain textと表示spanへ投影する。Increment 168時点ではuserラベルはblue、assistantはyellow、toolはcyan、
通常system通知は通常文字色、失敗語はred、Markdown見出しはgreen、list marker・emphasis・readyはcyanで
ある。terminal styleは最終frameにだけ加え、保存本文・API・model contextへANSIを混入させない。
rendererはgrapheme幅、変更entryの再利用、更新の合流、行差分とsynchronized outputを使う。
長時間通常利用の入力遅延やGhosttyのちらつき等の未再現観測は、これらの実装だけで解消済みとしない。

通常文のEnterはidle時にtaskを送信し、working中はdraftを保持する。F2は成功後の次task予約、F3は現在の
executionへの一回のsteeringである。受付可否はCore operationsから導く。Ctrl-Cは通常入力のclear、
Alt-Enterは改行、区別可能なShift／Ctrl-Enterも改行として扱う。
PageUp／PageDownは実行中も履歴を移動する。履歴中のEscはlatestへ戻り、latestで実行中のEscだけがcancelを
要求する。pickerのEscはその画面を閉じ、cancelへ流さない。入力と過去表示位置はsnapshot更新で保持する。

F1または`/sessions`はSession一覧を開く。Enterは閲覧、R／rは再開、D／dは個別削除確認、
y／Yは削除、n／NまたはEscは取消である。削除はSessionと関連execution・semantic履歴・recall参照を一体で
扱う。`/view ID`は閲覧のみでWorkerを起動せず、`/resume [ID|latest]`は現在のDefinitionで継続する。
`/context`はCoreが保持するcontextを読み取り専用で表示する。

editor先頭の`/`は英語説明・usage・対応keyを持つcommand pickerを開く。↑／↓で選び、EnterまたはTabで
command名を補完し、必要な引数を入力して再度Enterで実行する。workspace pathのTab補完は持たない。
`/help`はcommandとshortcutの対比を表示する。command一覧は`v0/tui/slash_command.ts`を正本とし、
`/login`、`/new`、`/sessions`、`/view`、`/resume`、`/context`、`/rename`、`/provider`、`/model`、
`/effort`、`/recall`、`/detach`、`/quit`を含む。

`/login`はAPI key登録とSign in with ChatGPTを認証方式で分ける。API keyは伏字入力から固定fileへ保存する。
ChatGPTはURL案内・非表示callback入力・account登録／選択／再認証を専用Core操作へ渡す。
account選択のEnterはpickerを閉じ、通常入力へ戻る。認証操作だけで親のprovider/modelは変更しない。
`/model`はCoreが取得した一覧と検索・お気に入りを使い、`/effort`はmodel別のmetadataまたは明示catalogを使う。
selectionはidle時にHostが保存し、admit済みroot turn内で固定する。詳細なroute・account・replay境界は
[`multi-provider-routing-and-auth.md`](multi-provider-routing-and-auth.md)を参照する。

`henji history`はCore/TUIと別のread-only CLIで、同じDBの単一read transactionから`session`／`canonical`／
`detail`をstdoutへ出す。TUIはHTTPのhistory/context read modelを使う。人間向けrendererとAgent向けmodel
projectionを分け、`/recall`は選んだnon-canonical executionを次の一taskにだけ明示投影する。

production TUIと`henji run`の`--provider-timeout-ms`はinvocation stateで、未指定時300,000 msをroot、child、
compaction、補助provider requestへ適用する。`provider_timeout`をresponse解析失敗と区別する。
terminalはalternate screenへ隔離し、detach／quit／signal／出力失敗時にHost側Surfaceが復元する。
terminal終了とCore終了は同じlifetimeではない。

具体的なkey、layout、表示量は通常利用に応じて改訂する。WebUI本体と一般的なSurface load／selection／
replacementは未実装であり、HTTP read modelの存在だけで成立済みとしない。

物理process実行はHost共通executor、provider HTTPはWorkerを基本placementとする。Coreのmodel一覧取得・
認証操作はCore側で実行する。境界を渡るのはdata-only messageであり、DefinitionはWorker内で評価する。
Deno Web Workerはlifecycle/data境界であり、別trust tierやsubprocessを含むhard sandboxではない。
根拠となるAPIとlocal probeは
[`host-worker-reference-comparison.md`](../research/host-worker-reference-comparison.md)に記録する。

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
semantic prefixと最新本文を残す。credential値とAuthorizationは記録しない。semantic authority自体のdurable write失敗は
canonical adoptionを禁止する。async childのcollect結果はstop reason、実request count、diagnostic id／code
などの短い状態を返す。

生成中のassistant本文はexecution・lane・model step・physical requestをkeyとするData
WorkerのHost-owned stateであり、 derived cacheではない。最新eventの本文・観測時刻・Worker
sequenceと初回のevent位置を保持する。 既存journalのflushでstateを置換し、同じrequestのmodel
result保存とstate終了を一transactionで行う。 cancel、failure、forced interruption、restart
reconciliationでは、最後の本文のsemantic追記、state終了、
terminal／outcomeを一transactionで保存する。read-only
detailはstateとsemantic履歴を同じsnapshotから読み、
生成中本文を確定messageやappend済みoccurrenceとして扱わない。停止本文のreadbackは元の観測位置に並べ、
`/recall`へは一request一本文を投影する。未完了本文をcanonical conversationへ自動採用しない。

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
- semantic occurrenceのordinal／countと、Worker eventの保存進捗は区別する。本文stateだけのbatchも、
  state更新とevent countを同じtransactionへ保存し、semantic occurrenceを増やさない。
- normal append／settlement／adoptionは過去payloadをapplication levelで全scan／decode／rehash／rewriteしない。
  同量の新規factを追加する処理量は既存Session payloadや当該executionの過去event数を乗数に持たない。
- `settled`はlogical completeness、terminal、mandatory referenceの解決を意味し、全過去payloadをsettlement時に
  再scrubしたことを意味しない。materializeするimmutable contentはread時に検証し、全体検証はexplicit auditとして
  通常pathから分離する。
- crash後に見えるexecution evidenceは最後にatomic commit済みのsemantic ordinal prefixと最新本文stateである。
  受信済みでも未commitの本文を保存済みとして返さない。writable起動時は未完了本文をsemantic履歴へ移して
  既存reconciliationを行い、read-only参照はactive状態を変更しない。

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
渡すことができ、人間またはAgentが明示的に選んだreferenceも目的と期間を限定して追加できる。
Agent自身の履歴参照を採用するときも、観測材料の選択とcanonical conversationへの採用は別operationとする。

Increment 38の`/recall`は、settled non-canonical executionを人間が選び、保存済み内容を次の一つのtaskへ
data-only contextとして投影するHost operationである。sourceをcanonical化、resume、自動retryせず、source identity、
実際のprojection、target executionを相関する。projectionの選択は次taskのadmissionで消費し、そのtask内の各model
requestで利用できる。targetがcanonical採用されてもsourceはnon-canonicalのままであり、targetが生成した内容は通常の
canonical conversationとして後続へ残り得る。現行はprojection本文をcanonical turnへ複製せず、source／target relationと
実際のprojectionをsemantic履歴とcontext attributionへ記録する。canonical表現を変更する場合は別途判断する。

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

### Agent自身の観測と構成操作

人間向けTUI/historyの充実を、Agent自身の観測操作が成立したことと同一視しない。Agentが現在の自分の
executionと実効構成を発見し、目的に必要な履歴・attribution・短いrequest factを選んで読む経路を整える。
Hostは既存のsemantic authorityをreadbackし、Workerは観測を解釈して次の調査や変更候補の形成へ使う。
新しいInstanceやexperience専用store、raw常設収集を、この観測の前提として追加しない。

`/model`や`/rebuild`相当の状態操作は、Hostが所有するoperationへ人間のSurfaceとAgentのtoolから要求する方向とする。
Workerが選択・要求を行い、Hostが適用対象と結果を確定して履歴へ相関する。TUIのslash文字列をAgentが擬似入力する
経路を前提にしない。人間が定めた目的・改訂範囲・採用境界の中での操作と、その境界を変える判断を区別する。
操作ごとの承認を一律に要求せず、候補の採用判断をAgentへ自動的に移すこともしない。

現行root selectionはidle時に人間が変更し、admit済みturnで固定する。Agentからのroot model変更要求とrebuildは
未実装であり、適用するmodel step／execution／generation境界と保存scopeは採用incrementで定める。
進行中のprovider requestが使用した構成や、過去executionのattributionを書き換えない。

`AgentContextGeneration`を採用する場合、それは`/rebuild`によって構築・有効化したAgent側の基底設定を表す。
canonical conversationはturnごとに進み、skill本文やtool result等はexecution中にも追加されるため、generation ID
だけで実際のmodel input全体を表さない。process/isolateのlifetimeを表す`AgentWorkerGeneration`と同じidentityに
するかも未決である。

### Context rebuild候補

人間とAgentが要求できるHost operationの候補である`/rebuild`は、再解決の対象として定めたresourceから新しいAgentの実効状態を
構築し、後続実行へ適用する。単なるfile rereadではなく、改訂されたresourceを次のAgent側基底設定へ反映する
activation境界として扱う。

この操作をHenji executableの再compile・配置・再起動と同一の操作とは決めない。binary platform authorityの
変更は新しいbuildとして追い、resourceのrevisionとその実行時の内容・selectionはそれぞれ相関する。

対象resourceと更新可能範囲は未決である。workspace instructionとskillに加え、Agent Definition、tool contract、
tool implementationも候補に含む。toolを対象にする場合は、modelへ提示するcontractと実際にdispatchするimplementation
の対応を定める。native resourceの現在内容を再解決する操作と、managed candidateの人間承認、immutable revisionへの
promotion、active binding transitionを同じoperationにするとは決めない。

Agentが実行中に要求する場合も、進行中requestの基底設定を上書きせず、新しい設定の構築成功後に適用する
境界を定める。要求元taskの続きへ適用するか、次executionへ適用するかとgenerationの引継ぎは採用incrementで
具体化する。canonical conversation、未送信draft、過去executionとそのattributionは書き換えない。
構築失敗時に旧generationを維持すること、context transitionをHost-owned evidenceとして記録することの具体的な
identity、commit順序、failure semanticsは個別incrementで定める。

cancel/failed executionのtool effectとしてresource fileが変更された場合、その変更自体は既に外部副作用として
存在し得る。`/rebuild`は、対象resourceの現在内容を新しいAgent状態へ取り込む境界であり、source executionの
canonical化、既に生じた副作用の承認または取消しを意味しない。

### Definition revision と generation の fencing

この境界での admission と commit は、次の revision binding 不変条件に従う。これは具体的な
field や schema を定めるものではない。

- Worker generationはSession/execution identity、Definition revision、generation identity、base Session state
  revisionと相関する。durable Instanceを採用する場合はInstance identityと、所有するstateのrevisionも相関させる。
- Host は、現在 admit されている generation から、かつ一致する Definition revision と base
  session state revision から来た proposal だけを受理する。この不変条件は live generation に適用し、
  保存履歴の閲覧には適用しない。
- 同じ revision の Worker restart と新しい revision への切り替えは別の事象である。revision の
  変更は明示的で durable な transition とし、記録する。継続時の保存 ref との不一致は transition の
  契機であって失敗条件ではない。

## セッションの永続性とコミット

Host/Worker 分割によって、実行中の Worker が durable truth の source になってはならない。

### AgentInstance と Session の関係

現行の継続性は、Hostが保存・再開するSessionとexecution履歴にある。Sessionはtranscript、context、turn commit等の
conversation semantic stateを所有し、SessionのwriterとgenerationをHostが管理する。独立したdurable Instanceを
Sessionの必須所属先にしない。

durable Instanceを採用する場合は、次の関係とcanonical domainを追加する。

- その機能の対象Sessionは1つの`AgentInstance`に属し、1つの`AgentInstance`は0個以上のSessionを持てる。
- Session は transcript、context、turn commit などの conversation semantic state を所有する。
  `AgentInstance` は stable identity と active な Definition revision binding を所有する。
- 同じ `AgentInstance` に admit される writer Worker generation は、一度に 1 つだけとする。
  Host は admit した input を serialize して、その Instance の generation へ渡す。
- mutable datum は Session または Instance のいずれか 1 つの canonical domain に属する。将来
  Instance-wide mutable state を導入する場合、Host は Instance 単位の revision、lock、persistence
  も所有し、session state と二重の正本にしない。

| 責務 | HenjiHost | Agent Worker |
| --- | --- | --- |
| Session identity | session IDを所有し、durable Instanceを採用する場合はそのassociationも所有する。 | 現在の実行でそのidentityを使用する。 |
| Concurrency | lock と session の serialized admission を所有する。 | ephemeral な turn 中 state だけを持つ。 |
| Persistence | load/store、storage revision、atomic replacement、recovery を所有する。 | commit を提案する。durable state の canonical source にはしない。 |
| Conversation の意味 | 受け入れた canonical state を保存する。 | 実行中の transcript/context semantics と compaction decision を所有する。 |
| Turn の settlement | proposed commit を受け入れ、committed と報告する前に durable に保存する。 | 境界を通じて outcome と proposed state/effect を報告する。 |
| Execution evidence | canonical採用とは独立して、assistant本文の最新state、semantic fact、effect、outcome、context attributionを相関・保存する。 | 実行中の本文snapshot、semantic eventとsettlementをprotocol経由で返す。 |

概念上の turn の流れは次のとおりである。

1. Host が canonical session state を load し、Worker generation への command を受け入れる。
2. Worker が snapshot を解釈して composition を実行し、turn 中の output と commit proposal を
   生成する。
3. HostのData Workerは観測済みsemantic
   deltaのappendと最新本文stateの更新・終了をatomicに保存する。executionのsettlementは
   未完了本文をsemantic履歴へ引き継ぎ、連続ordinal、count、terminal、mandatory
   referenceを増分処理する。 過去payload全体を再検証しない。
4. canonical採用時、Core/headless Host mainがDataのprepare
   tokenとexecutionの成立条件を照合して許可し、 Data Workerがterminal／settlement、canonical
   turn、Session revisionを一transactionで保存する。 ordered hash rootを成立条件にしない。
5. durable canonical adoptionが成功した後にのみ、HostはSurfaceまたは採用済みoutput
   consumerへturnをcommittedと報告する。

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

## 経験から変更と通常利用へ進む改訂ループ

人間主導でHenji自身が一部incrementの実装を担う運用は始まっている。Agent自身の観測・振り返り・改善案の
形成を強めるため、次の関係を狭いincrementでつなぐ。専用candidate管理やdurable Instanceを先に完成させる
固定工程にはしない。

1. Hostが保存したSession、semantic履歴、実効構成のattribution等を、人間とAgentが目的に沿って観測する。
2. 人間のアクションまたは指示を契機に、Worker内AIが経験を解釈し、対象機能の変更候補を作る。
3. 対象に応じたsource・diff・dataと由来を確認できる形で残し、人間が採用アクションまたは明示的承認を行う。
4. 人間が定めた範囲で、人間またはAgentが変更を後続実行へ反映する操作を要求し、Hostが実効状態を確定する。
5. 改訂後のHenjiを通常利用し、観測された変化を次の経験にする。観測・構成選択・反映の手段も改訂対象にできる。

対象はDefinitionに限定しない。native instruction、skill、tool実装、modelの選択と使い方、loop、runtime、
Host/Worker連携、Surface等から、実際の経験に必要な対象を選ぶ。経験、candidate、active resource、実効状態、
後続実行への適用は区別し、そのtargetの保存・採用・適用方式を個別incrementで具体化する。
変更前後の統制実験、改善の定量測定、全実効状態を表す統一revisionは要求しない。

### managed Definitionを改訂する場合

managed Definitionはこのループを実現する一つの対象である。採用されたsource closureをimmutableな
`DefinitionModuleRevision`として確定し、Session継続時の選択・切替を記録する経路を使える。
専用candidate保存・promotionを採用する場合は、現在使用中のrevisionと候補を区別する。durable Instanceも
採用する場合は、そのactive bindingのtransitionを追加する。これらを他resourceの必須方式にはしない。

native resourceの現在内容を再解決するrebuildと、managed candidateの採用・promotion・binding transitionは
同一operationと決めない。人間の改訂採用境界を維持しつつ、その範囲内でAgentが要求できる操作と適用結果を
明示する。root model選択やgeneric child起動ができることだけで、自己改訂の一巡を実証済みとはしない。

## AgentInstanceの継続性とHostの追加機能

durable `AgentInstance`を追加機能として採用する場合、その継続性はWorker generationを置き換えてもidentity、durable metadata、activeな
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
| Agent自身が参照するexecution・実効構成とreadbackの入口 | 人間向けhistoryと間接参照はあるが、現在の自分を発見して必要な材料を選ぶ操作は未整備である | 自身の観測・振り返りの最初のincrementを採用するとき |
| Agentからのroot model変更要求の適用時点と保存scope | 現行はidle時の人間操作でturn内固定。Agentの要求をどの後続step/executionへ適用するか未決である | root model操作の最初のincrementを採用するとき |
| `AgentContextGeneration`のidentity、所有する基底設定、`AgentWorkerGeneration`との対応 | `/rebuild`対象resourceとcomposition再構築のlifetimeが未決であり、execution単位の動的inputまでgenerationへ固定しない | `/rebuild`または同等のcontext再構築をroadmapで採用するとき |
| `/rebuild`対象resource、selection/activation authority、transitionのcommit/failure semantics | native instruction、skill、Agent Definition、toolでは更新方法とauthorityが異なる | 最初の`/rebuild` incrementで対象resourceを選ぶとき |
| `/recall`のcanonical表現を変更するか | 現行はprojection本文をcanonical turnへ複製せず、semantic履歴とcontext attributionへ相関する。表現を変更する要件は未採用である | canonical turnのprojection表現を変更するschemaまたは機能を採用するとき |
| process以外のprovider/tool物理I/Oのplacement変更 | process実行はHost所有として成立した。provider HTTP等はWorker内にあり、将来の配置変更は実際の利用契約から決める | roadmapが配置変更を必要とするprovider/tool利用経路を選んだとき |
| Worker protocolのmessage、handshake、error、versioning | 必要なmessageとfailure semanticsは、境界を使うproduct機能から決まる | 新しいHost / Worker間機能を実装するとき |
| Compositionをどの単位で再構築・適用するか | Agentからのrebuild要求を含む方向は決まったが、最初の対象resourceとtaskの引継ぎは未決である | roadmapが具体的なrebuild動作を選んだとき |
| Definition moduleで許すremote、JSR、npm dependencyの固定方法、revisionの更新・削除・GC | local module closureを保持する初期managed revisionと、新しいSessionへのexact revision指定には不要であり、実際の利用経路ごとに必要なsemanticsが異なる | 対象dependencyまたはrevision管理operationをproduct機能として選んだとき |
| MCP connection discovery/config format、tool name mapping、capability変更時のgeneration更新、server packageのmanaged化 | MCP protocol compatibilityとHenji固有のselection・durabilityは別contractであり、具体的な利用経路をまだ採用していない | roadmapがMCP integrationを採用したとき |
| Worker restart、cancel、concurrency、lease、backpressure | inputの並行性、streaming、effectの有無により必要なsemanticsが変わる | 複数入力、長時間turn、強制停止のいずれかを扱うとき |
| Surface identity、load / selection / replacement、置換時のUI-local state引継ぎ | CoreのHTTP/SSEと接続TUIは成立したが、WebUI本体と一般Surface loaderは未実装である | 新Surfaceまたは一般的な置換operationを採用したとき |
| mailbox、非同期または複数Surface間のrouting、schedule、Instance-wide state、cross-session memoryの永続化 | それぞれ独立したproduct機能であり、AgentInstanceの継続性やHost / Worker分割だけからは必要にならない | roadmapが対象機能を採用したとき |
| effectのidempotency、deduplication、recovery | effect先の契約なしに共通のretryまたはexactly-once semanticsを決められない | recovery対象となる実tool effectを選んだとき |
| deployment profile、service supervision、migration | 実行先、可用性、移行元と移行先が決まらなければ必要なmechanismを選べない | 常時address可能なHost serviceの運用先または移行対象を決めたとき |
