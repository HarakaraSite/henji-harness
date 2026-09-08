# Henji Host / Agent Worker アーキテクチャ

ステータス: 承認済みアーキテクチャ。roadmap、実装計画、Human Gate、実装認可ではない

対応するプロダクト構想は
[`docs/concepts/experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)
である。この文書は構想の目的を再定義せず、その実行基盤の構造を定める。

この文書は、Henji HostとヘッドレスなDeno Agent Workerの責務、状態、lifetime、commit境界を定める。

## プロダクト上の決定

- HenjiはDenoベースのagent harnessである。`AgentDefinition`はHenji内部の実行構成を表す、信頼された
  executable TypeScript関数である。
- このarchitectureでいう実行 primitive は Deno Web Worker（`new Worker`）である。これは Cloudflare の
  デプロイ単位としての Worker とは別のものである。`AgentWorkerGeneration` は、この Deno Web
  Worker による一時的な実行を表す概念名として引き続き用いる。
- `AgentDefinition` は、信頼された実行可能な TypeScript の合成コードである。外部の
  TypeScript 関数や plugin も Henji core と同じ trusted-local 実行境界に置かれる。それらの
  出所、レビュー、リビジョン、配布は開発プロセス上の関心事であり、信頼された Definition
  と信頼されていない Definition に別々の実行経路を作るものではない。
- 各 Worker generation の起動前に、選択された Definition code/source revision を参照する
  immutable な `DefinitionRevisionRef` を確定する。hash 形式、loader、promotion 方式はこの概念
  では定めない。評価後の data-only な `AgentManifest` はこの参照とは別の authority であり、
  選択内容を説明するが、admission/permission authority にはならない。
- Deno Web Worker は、組み込み Definition と外部 Definition の双方に共通する単一の実行カプセル
  とする。Worker はライフサイクル境界であり、別の trust tier ではない。
- Definitionは、provider、model、effort、loop、tools、subagents、contextをWorker内の一つの
  `AgentComposition`へ合成する。Definitionを目的別variantの固定集合や閉じたcapability schemaには
  しない。
- UI は交換可能なままだが、Henji Host に属する。Agent Worker はヘッドレスであり、Host / Worker
  interface/protocol を通じてのみ Host と通信する。
- 永続的なagentを採用する場合は常駐Hostが必要であり、durableな`AgentInstance`はephemeralまたは
  再起動されたWorker generationより長く存続しなければならない。
- Host の durable な `AgentInstance` metadata は、その Instance が現在使用する
  `DefinitionRevisionRef` を bind する。Definition revision の変更は、同じ revision の Worker
  restart とは区別され、明示的で durable な transition でなければならない。
- 常駐 Host とは、durable な lifecycle owner/service を指す。durable な各 `AgentInstance` に
  永久常駐の thread や Worker を 1 つずつ置くことを意味しない。Instance には active な Worker
  generation が 0 個または 1 個存在でき、lazy activation や idle teardown を後続設計で採用できる。

## 用語

| 用語 | この概念での意味 | 存続期間 / 管轄 |
| --- | --- | --- |
| `AgentDefinition` | 信頼された実行可能な TypeScript 合成関数。Host が所有する UI や session object ではなく、agent をどのように組み立てるかを記述する。 | 1 つの Definition revision。Worker generation 内で評価される。 |
| `AgentComposition` | 1 つの Worker 内で Definition が構築する、実行中の provider/model/effort/loop/tools/subagent/context コンポーネント。標準 Henji component は default であり、閉じた capability list ではない。 | 1 回の live composition evaluation は 1 つの Worker generation 内に閉じる。generation 内で一度だけ構築するか、turn ごとに再構築するかは未決定である。 |
| `AgentManifest` | Definition または composition の、評価後の data-only な説明および identity の projection。何が選択されたかを説明するが、`DefinitionRevisionRef` とは別の authority であり、admission/permission authority ではない。 | revision/identity metadata。実行状態ではない。 |
| `AgentInstance` | 安定した agent identity、その durable metadata、および active な `DefinitionRevisionRef` の binding。 | Worker generation より長く存続し、置き換えられた Worker で再開できる。 |
| `AgentWorkerGeneration` | 1 つの Definition revision を実行する 1 回の ephemeral な実行。Instance identity を変えずに停止、再起動、置換できる。 | process/thread/isolate の存続期間。 |
| `Surface` | TUI、CLI、JSON、Web、その他の channel など、Host 側で交換可能な interaction adapter。 | Worker とは独立して所有・置換される。 |
| `HenjiHost` | Worker lifecycle、物理 terminal / Surface I/O、Surface の load、UI から command への変換、storage mechanism を所有する coordinator。 | Worker generation の lifecycle owner。常時稼働serviceにするかは未決である。 |

`AgentManifest` と `AgentComposition` を区別するのは意図的である。manifest は、実行可能な
Definition が合成できるものを制限する仕組みになることなく、読み取り、比較、または revision
との関連付けができる。

## Host / Worker 境界

意図する方向性は次のとおりである。

```text
Surface (Host 側)
        │ ユーザー意図 / 描画出力
        ▼
HenjiHost ───── interface / protocol ───── AgentWorkerGeneration
   │                                           │
   │ ライフサイクル、terminal / Surface I/O、ストレージ │ Definition → AgentComposition → turn
   │                                           │ provider、tools、subagents、context
   └────────────── 永続化状態 ────────────────┘
```

この図が示すのは所有関係であり、wire schema ではない。現行sliceにはversion付きのdata-only protocolが
実装されているが、この文書はそのwire schemaを固定しない。将来機能のmessage、handshake、error、version
migrationは未決のままである。

### HenjiHost が所有するもの

- Worker generation の起動、停止、監視、置換。
- 物理 terminal とその他の Surface I/O。
- Surface 実装の load と置換、および Surface action の Worker 向け command または message
  への変換。
- 以下で説明する durable session 境界を含む storage mechanism。

Host は、Definition code が外部にあるというだけで、別の Definition 実行経路を選択しない。
組み込み Definition と外部の信頼された Definition は、同じ Worker capsule と同じ概念上の
境界を使用する。

### Agent Worker が所有するもの

- 選択された `AgentDefinition` revision の評価。
- provider/model、effort、loop、tools、subagents、context component を含む、その
  `AgentComposition` の構築と実行。
- transcript と context の意味、turn 中の作業状態、compaction policy、agent policy。
- interface を通じたヘッドレスの進捗、結果、effect、commit proposal の返却。

有効toolが利用指針を持つ場合、tool metadataはprovider向けtool definitionとは分離して保持し、Definitionが
registryをmaterializeした後にAgentCompositionのsystem instructionへ合成する。現在は`read`の選択と
`offset`・`limit`による継続読込みの指針をdefault parentとplannerへ、切り捨てられた`bash`出力を
`bash_output`の`outputId`と`nextOffset`で継続取得する指針と、currentまたは外部情報に`web_search`を使って
具体的なquestionを渡し、返されたsource URLを対応する主張の近くへ引用し、不足と推論を明示する指針を、
それぞれのtoolを持つdefault parentだけへ合成する。

現在のdeclarative registry経路では、`read`、`write`、`edit`、`bash`、`bash_output`、`web_search`をWorker-local
`ToolComponentCatalog`からmaterializeする。built-in componentは既存tool factoryをruntime bindingへ結び付ける
薄いfactoryである。Executable Definitionはroot compositionで選択済みの同一`tool:*` identity・tool nameの
componentを明示置換し、model向けcontract、guideline、executorを差し替えられる。置換はdelegated
plannerへ暗黙に伝播せず、manifestには従来どおりdata-only resource identityだけを記録する。external
Definitionがcatalog外の新しいtool identityを追加する一般seam、plugin探索、hot reload、componentの独立revision・
import dependency lineageはまだない。

default parentの`web_search`は、provider-neutralなHenji-owned tool contractと交換可能な`WebSearchBackend`を
分ける。初期production backendは既存OpenRouter credentialで`perplexity/sonar`を一回呼び、回答本文と
順序付きURL citationを受け取る。model-visibleなtool resultではSonar answer内の有効な`[n]`を同じresponseの
annotationに対応する直接Markdown linkへ変換し、source一覧も番号なしのlinkとして返す。Sonarには具体的な
user questionと、検索結果に限定して不足・near miss・推論を明示するsystem messageを渡し、通常検索のcontext
sizeは`medium`とする。
Sonar requestは親turnのmodel request budgetを一件消費し、main modelと同じcounted fetch、AbortSignal、
provider evidenceを共有する。tool call元のmodel stepを
request recordへ関連付け、raw responseとparser transitionをreadback可能にする。plannerには`web_search`を
追加しない。OpenRouter `openrouter:web_search` server toolは現在使わず、同じbackend境界への将来候補とする。

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
composition、proposal / commit / acknowledgement、close経路を一turnだけ使う。Session transcriptは永続化せず、
final-only stdout、failure JSON、exit codeだけをSurface contractとして持つ。

現在の対話SurfaceであるTUIは、通常利用の画面を次の領域として構成する。

- 人間の依頼、assistantの応答、短いtool activity、結果を追えるconversation log。
- draftを保持し、複数行を編集できる入力欄。
- ready / busy、Session、committed turn、過去表示中の位置と復帰操作など、次の操作判断に必要なstatus行。
- 対象physical workspaceを独立して示すcwd行。

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

`/history export`は現在bindingのcommit済みcanonical transcriptをHost側で同期的にsnapshotし、既存の
workspace別state root配下へMarkdownを新規保存するHost-local operationである。表示中のbounded viewport、
active response、draft、TUI-local noticeはsourceにしない。export中は通常task、Session切替、重複exportを
直列化し、shutdownはwrite settlementを待つ。typed Presentation intent/resultはcommandとbounded receiptだけを
運び、transcriptやstorage handleをWorker protocolへ追加しない。

通常logは、人間が作業の流れと結論を追えるsemanticな表示とする。raw provider response、tool result全文、
request/evidence metadataを通常logへ常時展開することは要求しない。一方、原因特定に必要なraw response、
tool event、diagnostic、evidenceは通常表示から失われるのではなく、保存して明示的にreadbackできる経路を
維持する。

Terminal TUIの起動中は現在のSessionの画面をalternate screenへ隔離し、streamingやprogressの再描画で
terminal scrollbackへ途中frameを蓄積しない。正常終了、cancel、signal、出力失敗では、input、terminal
mode、起動前画面、cursorをHostが復元する。未送信draft、viewport、入力履歴などのUI-local stateと、
Host storageに保存するcanonical transcriptやSession identityは区別する。

recoverable settlementで未commitのactive taskが残る場合、Hostは空のeditorへそのtextを一回戻し、
人間の明示的な編集・再送を待つ。別draftがある場合はrecovery laneに保持し、Host-local `/recover`で
一件ずつ取り出す。これらのeditor操作はcanonical Sessionへcommitしない。idle Ctrl-Cはeditorと
input-history navigationだけをclearし、exitは空editorのCtrl-Dまたは`/exit`で明示する。busy cancelと
外部signalの遷移は別に保つ。

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

### Definition revision と generation の fencing

この境界での admission と commit は、次の revision binding 不変条件に従う。これは具体的な
field や schema を定めるものではない。

- Worker generation は、少なくとも `AgentInstance` identity、Definition revision、
  generation/lease identity、base session state revision と相関する。Instance-wide state が存在する
  場合は、その state の revision も相関させる。
- Host は、現在 admit されている generation から、かつ一致する Definition revision と base
  session state revision から来た proposal だけを受理する。
- 同じ revision の Worker restart と新しい revision への切り替えは別の事象である。revision の
  変更は明示的で durable な transition とする。

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

概念上の turn の流れは次のとおりである。

1. Host が canonical session state を load し、Worker generation への command を受け入れる。
2. Worker が snapshot を解釈して composition を実行し、turn 中の output と commit proposal を
   生成する。
3. Host が適用対象の session revision を検証し、受け入れた proposal を atomic に保存する。
4. durable storage が成功した後にのみ、Host が Surface または採用済みの output consumer に turn
   を committed と報告する。

### Effect と commit proposal

Worker から返るものは、概念上、`effect request`、`effect started/completed/unknown evidence`、
`state commit proposal` として区別する。ここではそれらの field や schema を定めない。
durable commit が存在しないことだけでは、effect が発生していないことや、安全に replay できる
ことの証拠にはならない。したがって、effect が開始された可能性のある turn/event は、明示的な
idempotency/deduplication 契約、または effect が開始されていないことの証拠がない限り、transparent
に再実行しない。これは product correctness の不変条件である。

Persisted Host state が canonical であり、Worker state は ephemeral である。Worker の crash
または置換によって、commit されていない作業状態が破棄される可能性がある。turn または commit
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
   Definition revisionとして確定し、Hostが`AgentInstance`のbindingを明示的かつdurableに切り替える。
5. 改訂後も通常利用を続け、そこで観測された変化を次の経験として保存する。

このループは、変更前後の比較実験、改善の定量測定、Henji全体の構成追跡を要求しない。何を経験として
残すか、AIがどの経験を読むか、人間のアクション、指示、承認をどのSurfaceとprotocolで表現するかは、
このarchitectureでは固定しない。Workerが人間の契機なしに改訂候補を自発的に生成することや、Hostが
候補を自動採用することはない。

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

## 未決のアーキテクチャ判断

確定した制約は、それぞれの責務と境界を定める本文に置く。ここには選択肢が残る判断だけを、その理由と
判断する契機とともに記録する。roadmapは契機となるproduct機能を採用するかを決め、個別計画は採用された
機能に必要な判断を具体化する。

| 未決の判断 | 今決めない理由 | 判断する契機 |
| --- | --- | --- |
| provider/toolの物理I/OをWorker、Host RPC/capability、subprocessのどこに置くか | effect、latency、streaming、credential、利用するtoolの契約によって適切な境界が変わる | roadmapが具体的なprovider/tool利用経路を選んだとき |
| Worker protocolのmessage、handshake、error、versioning | 必要なmessageとfailure semanticsは、境界を使うproduct機能から決まる | 新しいHost / Worker間機能を実装するとき |
| Compositionをgeneration単位またはturn単位のどちらで構築するか | dynamicな再構成を必要とする利用者動作が確定していない | roadmapが実行中の構成変更を必要とする機能を選んだとき |
| Definition moduleのidentity、dependency lineage、load、rollout | external moduleやrevision transitionで保証すべき再現性が、対象機能によって異なる | executable revisionの切替または配布をproduct機能として選んだとき |
| Worker restart、cancel、concurrency、lease、backpressure | inputの並行性、streaming、effectの有無により必要なsemanticsが変わる | 複数入力、長時間turn、強制停止のいずれかを扱うとき |
| Surface identity、load / selection / replacement、置換時のUI-local state引継ぎ | 現在はTUIとnon-interactive commandで通常利用でき、一般化に必要な第二Surfaceの契約がない | 第二Surface、現Surfaceの置換、またはself-revision操作をTUI固有実装へ閉じない必要をroadmapが採用したとき |
| mailbox、非同期または複数Surface間のrouting、schedule、Instance-wide state、cross-session memoryの永続化 | それぞれ独立したproduct機能であり、AgentInstanceの継続性やHost / Worker分割だけからは必要にならない | roadmapが対象機能を採用したとき |
| effectのidempotency、deduplication、recovery | effect先の契約なしに共通のretryまたはexactly-once semanticsを決められない | recovery対象となる実tool effectを選んだとき |
| deployment profile、service supervision、migration | 実行先、可用性、移行元と移行先が決まらなければ必要なmechanismを選べない | 常時address可能なHost serviceの運用先または移行対象を決めたとき |
