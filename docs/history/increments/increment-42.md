# Increment 42 — exact context attribution

ステータス: **完了（実装・検証・production Human Gate・第三者review完了）**

基準commit: `abdb9f4e`

前提: Increment 41の実装・検証・受入が完了し、schema v2のactive execution、live journal、
restart reconciliationが利用できること。この前提は2026-09-13に満たされ、実装開始時に完成した
schema/API名を再照合する。

対象機能: F03、F04、F06、F08、F26

## 利用者が必要とする動作

- 各executionが使用したinstruction、skill catalog、実際に読み込んだskill、modelへ提示したtool
  contract、Henjiが供給したruntime fact、toolで観測した出力を、当時の内容でreadbackできる。
- resourceがdiscoveryで発見されたこと、compositionへresolved/selectedされたこと、skillがtoolで
  loadedされたこと、tool outputがobservedされたこと、特定のmodel requestへprojectedされたことを
  別の事実として扱う。
- parent、delegated planner、web search等の補助model callを含む各model requestをexecution-local identityで
  相関し、provider-neutralな実際のinputと、providerへ送ったcredential-freeのwire bodyを区別して追える。
- current canonical revision、semantic checkpoint、`/recall`、現在executionのmessage/tool result/steeringが、
  どのmodel requestのどの位置へ投影されたかを実際のordered inputと結び付ける。
- instructionやskill fileを後で編集・削除しても過去snapshotは変わらず、mutable pathの現在内容を
  過去executionの内容として読み直さない。
- active/interrupted executionはHostが観測・保存できたcontextだけをpartialとして返す。settled
  executionは最終manifestとlive journalを照合し、完了したmodel requestを欠落させない。
- この閲覧はread-onlyであり、canonical adoption、model projection、active resource、Worker generationを
  変更しない。

## 根拠と確認済みの現在地

- architectureは、各executionをAgent側の基底設定、base canonical Session revision、明示projection、
  実行中に読み込んだresourceや観測情報と相関させる。存在、discovered、loaded、projectedは同じ
  事実ではなく、mutable pathだけで当時の内容を表さない。
- 採用済みprogramはIncrement 42でinstruction、skill catalog/loaded skill、tool contract、runtime factを
  content-addressed snapshotとし、executionと各model requestへ相関する。`AgentContextGeneration`や完全再現は
  このincrementの要件ではない。
- 現行Workerはgeneration起動時にworkspace-root `AGENTS.md`とworkspace/user scopeのaccepted skillを一回読み、
  immutableなinstruction snapshot/skill catalogをmemory上に保持する。Hostへの`ready.startupSnapshot`は
  instruction source名とskill名しか持たず、本文、description、source directory、manifestを永続化しない。
- built-in instructionはHenji common、role、active tool guideline、workspace instruction、skill manifest、runtime
  facts（現在はcwd）のnamed componentを連結する。resolverはcomponentを知っているが、
  `WorkerAgentComposition`は最終`systemInstruction`だけを保持し、component境界はHost/historyへ渡らない。
- `skill` toolはaccepted catalog内のexact `toolResult`を返し、そのtool resultは次のmodel stepからtranscriptに
  含まれる。現行historyはtool call/resultを追えるが、対応するskill snapshotに`loaded`としてlinkしない。
- `Registry.definitions()`がname、description、input schemaのexact provider-neutral tool contractを各stepに
  渡す。現行manifestはtool resource identityを持つが、実際にmodelへ渡したcontract内容を保存しない。
- `runAgent`/`runAgentTurn`はcanonical suffix、current task/message、tool result、checkpoint、`/recall`投影を
  適用した後の`ModelRequest { systemInstruction, transcript, tools }`を`model.generate`へ渡す。この境界に
  共通のrequest observerはない。
- Increment 40の`model_requests`はprovider evidence requestのordinal/lane/phase/model stepをindexするだけで、
  provider-neutral request、system instruction、ordered messages、tool definitions、source attributionを持たない。
  provider evidenceの`requestBody`はprovider adapterが生成したexact bodyを保持するが、論理model requestとの
  安定したidentityはない。
- web searchはAgent loopの中で追加model budgetをclaimし、tool callのqueryから独自のprovider request bodyを
  生成する。parent/plannerの`ModelRequest`とは異なるが、同じexecution/provider evidenceに所属する。
- 現行production Workerは自動context compactionを行わない。semantic checkpointはmodel projectionとして存在するが、
  Increment 42は存在しないcompaction requestを擬制せず、実際に各executionで起動したrequestだけを記録する。
- 現行上限はserialized model messages 5 MiB、complete request 6 MiBである。導入済みDeno 2.9.4 /
  SQLite 3.53.2と現VM filesystemの一時DBで、1 MiB / 6 MiB blobのSHA-256は10回平均
  0.75 / 2.75 ms、WAL + `synchronous=FULL`の新規blob commitは2.47 / 9.69 msだった。これは
  `/tmp/henji-i42-probe-abd0f8033a33ce68`のVM-local観測であり、production diskの一般性能を推定しない。
  現行最大入力をcontent-addressingする計画を拒む観測値ではないが、実装後のprotocol copyと
  end-to-end latencyは別に測定する。

## 参照仕様・実装と採用範囲

- [OCI Image Specification v1.1.1 のContent Descriptor](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md)
  はcontentをmedia type、digest、raw byte sizeで参照し、digestをbytesから再計算して検証する。Henjiは
  `sha256:<lowercase hex>`、byte length、media typeのdescriptorを参考にするが、OCI layout、manifest、registry、
  signature、transportは導入しない。
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
  はsystem instructions、ordered input messages、tool definitionsを別のstructured inputとしてgenerationへ相関する。
  Henjiはこの分離とordered inputを参考にするが、OpenTelemetry依存、external exporter、sampling、
  truncation、content opt-inは採用しない。
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/)はTask/Agent/Turnの下に
  generationとfunction callを相関し、generationにinput/model/config/outputを持てる。Henjiはexecution内の
  request identityとtool callとの相関を参考にするが、SDK、span lifecycle、remote trace exportは持ち込まない。
- [Model Context Protocol 2025-06-18 tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  のname、description、`inputSchema`をmodel-facing contractの比較対象とする。Henjiの現行toolはMCPに限定
  されないため、MCP protocol、server discovery、output schemaは要件にしない。

## Product contract

### 1. 破壊的schema v3 cutover

- Increment 41のschema v2から`history.sqlite3`の`PRAGMA user_version`と
  `store_metadata.schema_version`を3に更新する。v2からのmigration、ALTER、copy、compatibility read、
  dual-read/write、fallbackは実装しない。v1/v2 DBは`history_invalid`として明示的に拒否する。
- 旧DBとWAL/SHMを自動削除・置換しない。production受入はempty isolated XDG stateで行い、
  実dataの削除やstate root切替は利用者の別指示とする。
- schema v3はIncrement 41のexecution/event/effect schemaに、`context_blobs`、
  `execution_context_relations`、再定義した`model_requests`、`model_request_items`を加える。
  `ExecutionContextAttributionV1`、`ProviderEvidenceV5`、`WorkerExecutionArtifactV5`のpost-cutover
  codecだけを生成・読込する。
- `executions.context_capture`は`none | partial | complete | failed`を持つ。active/reconciled executionは
  Hostが保存した範囲だけをpartialとし、normal settlementはWorkerの最終manifestとjournal/rowsの一致を
  確認してcompleteにする。model request数0は欠落ではなく、basisが完全で実行がrequest前に終了した
  ことが確定していればcompleteにできる。

### 2. content descriptorとblob

- `context_blobs`は`digest` primary key、`byte_length`、raw `BLOB`を持つ。digestはraw bytesの
  SHA-256を`sha256:<64 lowercase hex>`で表す。insert/read時にbyte lengthとdigestを再計算し、同じ
  digestに異なるbytesを許可しない。
- textは実際にWorker/model境界で使ったUTF-8 bytes、structured valueは配列順序を保持し、object keyを
  再帰的に字句順へ並べたfinite JSONのUTF-8 bytesをcontentとする。現行`JsonValue`/message/tool
  contractを使い、新しい値・文字数制限は加えない。
- media type、encoding、semantic kindはblob identityに混ぜずrelation/request itemに保持する。同じbytesは
  instruction、message、tool result等の用途が違っても一つのblobを参照できる。
- message、tool contract、skill本文等を個別blobにし、model requestはordered descriptorでそれらを参照
  する。各stepの全transcriptを別blobとして重複保存せず、descriptorから元の`ModelRequest`と構造上
  同一な値を再構成できるようにする。provider wire bodyは既存evidenceのexact string/bytesを正本とする。

### 3. generation basisとexecution相関

- Workerの`ready` context snapshotを拡張し、generationが保持するworkspace instructionのsource/text/
  formatted text、skill catalog manifest、accepted skillごとのname/description/source directory/body/tool result、
  root compositionのfinal system instruction/tool definitions、利用可能なnamed instruction componentをdata-onlyでHostへ渡す。
- `beginExecution`はgeneration basisのdescriptor/blobとexecution relationをactive executionと同じtransactionに
  保存する。basis保存が失敗したときはIncrement 41のbegin-before-dispatchに従いWorker turnを送らない。
- `execution_context_relations`はexecution-local ordinal、stage
  `discovered | resolved | loaded | observed | projected`、resource kind、nullable logical identity、source locator、
  content digest、lane/model step/call ID/request ordinal/source event ordinalの必要な相関を持つ。同じcontentに
  複数stageがあっても一件に潰さない。
- accepted skill全件を`discovered`としてsnapshotするが、`skill` toolの対応call/resultが成立した
  skillだけを`loaded`とする。catalogにあるだけでloaded/projectedとみなさない。
- `resolved`は、discovery後に実際のgeneration/compositionへ選択されたresourceだけに付ける。named
  instruction componentはfinal system instructionへ含まれたもの、toolはmaterialized registryがmodelへ提示可能に
  したcontract、skill群は個別bodyではなくaccepted entryから構成したcatalog manifestをresolvedとする。個々の
  skill bodyはcatalogに存在するだけではresolvedにせず、成功した`skill` callで`loaded`とする。external
  Definitionは実際のfinal instruction/tool contractをopaqueな`definition_output`としてresolvedにし、提供されない
  component境界を推定しない。
- built-in compositionはcomponent identity/order/textと連結後system instructionの一致をvalidateする。external
  Definitionがcomponent内訳を提供しない場合は、任意の境界を推定せずfinal system instructionを
  `definition_output`のopaque snapshotとして保存する。それだけを理由に正常なexternal Definitionを拒否しない。
- Agent Definition revision/closure、build、model/effort、manifestはIncrement 40/41のexecution attributionを
  参照し、同じmodule bytesをcontext blobへ重複させない。`AgentContextGeneration` identityは作らない。
- runtime factはHenjiがmodelへ供給した値だけをsnapshotする。現在はcwd componentが対象であり、
  environment全体、OS、filesystem、時刻、credential storeを推測・走査しない。

### 4. exact model request observation

- parent/plannerの共通loopに、projectionと`prepareModelContext`の後、request budget claim成功後、
  `model.generate`前にexact `ModelRequest`を受け取るrequest observerを一つ追加する。observerは
  execution-local `request_ordinal`を発行し、lane、purpose、model step、root/planner model selection、
  provider-neutral request descriptorとsource relationsをWorker protocolへ送る。
- `model_requests`はprovider evidenceの存在と独立した論理request rowとする。credential解決やfetch前の
  failure、provider-free modelでも、実際に`model.generate`境界へ入ったrequestはreadbackできる。
- `model_request_items`はcomposed system instruction、ordered transcript message、ordered tool contractをそれぞれ
  原順のitem ordinalとdigestで参照する。messageはcanonical Session turn/message、semantic checkpoint、
  recall source/projection、current task、current executionのassistant/tool/steeringのうち、実際のsourceを特定できる
  relationを保持する。特定できないものは内容自体を保存し、sourceを推定しない。
- transcript messageと同じ順序で動くprovenance sidecarをrequest構築中から保持する。canonical suffixの選択、
  checkpoint置換、`/recall`挿入、current task追加、assistant/tool/steering追加の各変換はmessageとsource descriptorを
  同じoperationで追加・除去・並べ替え、observerへ最終messageと対応sourceを渡す。canonical sourceは少なくとも
  Session/base revisionとturn/messageのcausal position、recallはsource/target projection identity、current execution
  contentはjournal event/call identityへ結ぶ。observerでitem ordinalとcontent digestを照合するが、同一bytesから
  source identityを逆算しない。同じ内容が複数sourceに存在しても各occurrenceの実sourceを維持する。
- tool contractはそのrequestの`Registry.definitions()`が返したname/description/input schemaのexact valueを
  orderedに保存する。manifest identityと実際のtool nameを一意に対応できるときだけlinkし、
  external toolの名称やschemaへ新しい制限を追加しない。tool implementation/source/dependencyは擬制しない。
- Workerのcontext observationはIncrement 41のjournalに受信順でappendし、同じ短いtransactionで
  blob/request/item/relation projectionを書く。per-request durable acknowledgement barrierは追加せず、Hostがまだ
  受信していないWorker memoryのcontextをdurableと主張しない。journal write failureはIncrement 41の
  active execution failure/cancel/canonical rejectionに従う。
- Workerはnormal settlementのproposalにrequest count、ordered descriptor digest、relationの最終manifestを含める。
  Hostはjournal/relational projectionと件数・identity・digest・順序を照合し、canonical/non-canonical settlementと
  `context_capture=complete`を同じtransactionで確定する。不正・欠落はWorker proposal contract failureとして
  canonical commitしない。このfailureには専用のnormal settlement経路を使い、保存済みlive rowを維持したまま、
  不正なfinal manifestを再利用せず、Hostが生成した実在する`contract_failure` outcome/diagnosticにより
  `settled/failed/non_canonical`と`context_capture=failed`を一transactionで確定する。独立にvalidateできたevidenceは
  保持するがcontextをcompleteとせず、activeのまま残して次回`interrupted/unknown`へ誤分類しない。

### 5. provider requestと補助model call

- `ProviderEvidenceV5` requestに`contextRequestOrdinal`を必須で付与し、root/planner modelの論理requestと
  provider request bodyを同じexecutionで相関する。provider-neutral snapshotとwire bodyは異なる正本であり、
  provider adapterの変換後bodyをprovider-neutral inputで上書きしない。
- web searchはtool call IDとquery、Sonar向けの実際のrequest bodyを`purpose=web_search`のcontext
  requestとして、`model budget claim → actual body構築 → context request観測 → credential解決 → provider
  evidence開始/fetch`の順で扱う。credential解決失敗でも消費済みのlogical request/body descriptorを残す。
  Agentの`ModelRequest`shapeを擬制せず、provider body descriptorとsource tool callのrelationを保持する。
- 一つのexecution内のparent、planner、web searchはrequest ordinalで一本に並び、lane/purpose/model
  step/call IDで役割を区別する。model選択はrequestごとに保存し、rootのSession selectionとplanner/
  web searchの固定selectionを混同しない。
- credential resolverの値、Authorization/cookie等のrequest header、credential fileはcontext observerの型に含めない。
  system instruction、message、tool result、request bodyは現行の正規の完全な内容を保存し、仮想的な
  private-data懸念で省略・sanitizeしない。
- Henjiが証明できるのはWorkerがmodel adapterに渡したprovider-neutral inputとprovider transportが
  送信したbodyまでである。provider内部のhidden instruction、内部状態、実際のattention/cache、
  external search stateを観測・再現したとは扱わない。

### 6. loaded skill、tool observation、projection

- `skill` callのaccepted call argumentsとresultをcatalog snapshotのname/tool-result digestと照合し、対応する
  `loaded` relationをcall ID、lane、model step、journal event ordinalとともに追記する。不存在/不正引数の
  error resultをloaded成功と扱わない。
- accepted tool resultはname/call ID/outcome/exact contentの`observed`なcontext relationとして記録する。
  これは「Henjiがtool outputを観測した」ことを示し、その内容が現実環境を正しく表すことや
  effectの成功を追加で保証しない。
- observed/loaded contentが後続model requestのordered transcriptに実際に現れた場合だけ、そのrequestの
  `projected` relationを作る。turn最後で後続requestがないtool resultをprojectedと推定しない。
- canonical message、semantic checkpoint、`/recall` projectionは既存のidentity/relationをsourceにし、
  実際のrequest item digestと一致した場合だけprojectedとする。sourceのcanonical/non-canonicalな状態を
  変更しない。

### 7. restartとsettlement

- normal canonical commit/non-canonical settlementは、最終context manifestの照合とcontext row/blobの保存を
  Increment 41の同じsettlement transactionに含める。canonical turnとexact attributionのどちらかだけを
  commitしない。
- crash/restart reconciliationは、durable journalにあるgeneration basis/context observation/model request/tool relationだけを
  `context_capture=partial`として保持する。未配送のWorker memory、予定された次request、未観測のtool
  resultを補完しない。
- final manifestの完了を観測せずexecutionがinterrupted/unknownにreconcileされた場合は、
  現存rowが内部整合していてもcompleteと推定しない。no replay/canonical conversation不変はIncrement 41を維持する。

### 8. diagnostics readback

- `henji diagnostics executions context --id <execution-id>`を追加し、execution attribution、capture status、
  generation basis、discovered/resolved/loaded/observed relation、model request summaryをJSONでreadbackする。
- `henji diagnostics executions request --id <execution-id> --ordinal <n>`を追加し、元の
  provider-neutral `ModelRequest`（またはweb-search provider body）、ordered item、source relation、model selection、
  linked provider evidence request/bodyをreadbackする。各blobはread時にdigest/sizeを再検証する。
- active/partial/complete/failedを出力で区別し、欠落したrelationを推測しない。現在のmutable fileや
  current registryを読み、過去snapshotの代替にしない。
- Increment 43のhuman-friendly timeline、keyword検索、history renderer、full-history exportは追加しない。
  Increment 42のSurfaceはexact JSON diagnosticsであり、model projectionを変更しない。

## 実装slice

### Slice A — schema v3とcontent store

1. schema v3、content digest/descriptor codec、`context_blobs`、`execution_context_relations`、
   `model_requests`、`model_request_items`、context capture statusを実装する。v1/v2は移行せず拒否する。
2. raw UTF-8/finite canonical JSONのcontent descriptorと、ordered descriptorから`ModelRequest`を再構成する
   read/write portを追加する。
3. Increment 41のbegin/append/settlement/reconciliation transactionへcontext basis、live relation、最終manifestの
   atomic validationを接続する。

### Slice B — Worker context observation

1. instruction/skill discoveryとcompositionを、exact contentつきdata-only generation snapshotとしてWorker `ready`へ追加する。
2. common loopの各message projection変換と同じoperationでprovenance sidecarを維持し、最終projection後に
   request observerを追加して、parent/planner requestとordered source relationをlive protocol/final manifestへ渡す。
3. skill loaded、tool output observed、後続request projectedのrelationをcall ID/model step/request ordinalで相関する。
4. web-search requestにcontext request identityとsource tool callを付与し、provider evidenceへ同じidentityを渡す。

### Slice C — settlement、partial capture、diagnostics

1. `ProviderEvidenceV5`、context attribution codec、execution artifactのcapture summaryを実装し、final manifestと
   live rowsをnormal settlementで照合する。
2. interrupted/unknown reconciliationで現存contextをpartialのまま固定し、未観測inputを作らない。invalid/missing
   final manifestは専用normal failure settlementでcontext failedへ固定し、reconciliationへ持ち越さない。
3. diagnostics `executions context/request`のexact JSON read model/CLIを接続する。

### Slice D — stable candidateとproduction受入

1. READMEにexact attribution、stageの区別、partial/complete、diagnostics、破壊的schema v3を記載する。
2. focused test、変更する実経路の関連regression、`v0:check`、`v0:fmt`、`v0:lint`、
   `git diff --check`を完了する。
3. stable candidateに対するauthoritative `v0:gate`を一回だけ実行する。
4. isolated XDG/workspaceとstandalone real TTY/providerで、skill load、tool observation、multi-step request、
   mutable file変更後のold snapshot readback、crash partial captureを確認する。

利用者承認後はSlice A〜Dを継続し、下記Human Gateまたは停止条件でだけ利用者へ戻す。

## Verification

新しい`tests/v0/increment_42_context_attribution_test.ts`とfocused taskで、次のproduct動作を確認する。

- generation startup fixtureのworkspace instruction、user/workspace scopeの複数skill、catalog manifest、named
  instruction component、cwd factがexact bytes/digest/sizeでbegin transactionに入る。begin失敗でWorker turn/
  provider/tool dispatchが0のままである。
- catalogの二skillのうち一つだけを`skill` toolで読み、個別skillは一方がdiscovered+loaded+projected、もう
  一方がdiscovered onlyになり、catalog manifest、final instruction component、materialized tool contractは
  resolvedになる。skill resultが現れる前のrequestをloaded/projectedとしない。
- parent multi-step、planner delegation、web searchを発生させ、全requestの一意なordinal、lane/purpose/
  model step/call ID/model selection、provider evidence requestのcontext identityが一致する。provider-freeや
  credential解決失敗でprovider evidence requestがない論理model requestも残る。
- semantic checkpointと`/recall`があるparent requestを実際の投影順でcaptureし、canonical message、
  checkpoint、source execution/projection、current task、assistant/tool/steeringのsource relationがexact itemと一致する。
  recall本文をcanonical messageへ複製しない。同じbytesのcanonical message、current task、recall/tool resultを
  同一requestへ複数配置しても、digest一致から推定せず各item occurrenceが元のsource identityを保持する。
- tool名、description、input schemaがrequestごとにexactで、same-identity external replacementも実際に
  modelへ提示されたcontractを返す。implementation/sourceをcontractから推定しない。
- model request diagnosticsから再構成した`ModelRequest`がobserver入力とdeep-equalで、OpenRouter/OpenAIの
  linked evidenceはそれぞれのexact provider wire bodyを維持する。credential/Authorization/headerは新snapshot
  schemaに存在しない。
- 現行上限内の5 MiB messages / 6 MiB requestでdigest、Worker protocol、SQLite append、settlement、
  diagnostics readbackまで完了し、captureを通さない同じprovider-free経路との追加latency/memoryを
  観測する。testのために現行product上限を狭めず、通常利用を阻害する実測があれば構造を見直す。
- 同じmessage/instruction/tool contract bytesを複数request/executionが参照してもblobは一件で、ordered
  itemの重複occurrenceは潰れない。blob tamper/digest不一致は`history_invalid`となりmutable sourceへfallbackしない。
- normal canonical/non-canonical settlementは最終manifestとrowsが一致した場合だけ
  `context_capture=complete`を同じtransactionでcommitする。不一致/欠落でcanonical turnだけを残さず、専用の
  contract-failure経路が`settled/failed/non_canonical`、context failed、diagnosticを確定する。再起動しても
  interrupted/unknownへ再分類せず、diagnosticsでもfailed captureをreadbackできる。
- 別processの強制終了後、Increment 41のreconciliationはHostが観測済みのrequest/context/tool relationだけを
  partialで残す。未観測requestの補完、provider/tool自動replay、canonical revision/message変更は0件である。
- `diagnostics executions context/request`がactive、partial、completeのexact snapshotをreadbackでき、
  元の`AGENTS.md`/`SKILL.md`編集・削除後もold digest/contentが不変である。次の新Worker
  generation/executionは変更後contentの別digestを参照するが、old attributionを書き換えない。
- persistent Sessionと`--no-session`の両方でexecution/request attributionが同じschemaに入り、異なる
  Sessionの並行性と250 ms busy/no-partial-write contractを維持する。
- schema v1/v2 DBが`history_invalid`となり、migration、copy、自動削除、旧store fallbackが発生しない。

実装中はIncrement 42 focused testと、変更する具体的な経路に対応するIncrement 16 instruction、
Worker foundation、provider stream/OpenAI、Increment 33 external Definition、38 recall、40 SQLite、41 live
journalの関連testだけを必要時に実行する。stable candidate前に`v0:check`、`v0:fmt`、`v0:lint`、
`git diff --check`を行い、authoritative `v0:gate`は一回だけ実行する。

## Production Human Gate

- empty isolated XDG stateとtemp workspaceに固有内容の`AGENTS.md`、call対象skill、未使用skillを置き、
  candidate standaloneのreal TTY/provider turnでskill loadとread/bash等のtool observationを含むmulti-step
  executionを完了する。
- `diagnostics executions context/request`でinstruction component/catalog、一skillのloaded/projected、未使用skillの
  discovered only、exact tool contract、ordered request input、model selection、provider wire bodyへのlinkをreadbackする。
- Worker/Sessionを閉じてtemp `AGENTS.md`/`SKILL.md`を編集または削除し、過去executionの
  diagnosticsがold bytes/digestを返し続けることを確認する。新しいSession/Worker executionは新contentを
  参照し、old row/blobを変更しない。これは`/rebuild`操作の受入ではない。
- 別のlong-running turnを起動し、request/contextがactive diagnosticsに現れた後にprocessを強制終了する。
  exact reopen後にexecutionがinterrupted/unknownとcontext partialで固定され、未観測requestの生成、自動replay、
  canonical変更がないことを確認する。
- v2 DB copyの拒否とbyte不変を確認する。受入は一時binary/state/workspaceだけを使い、installed binaryを
  置換しない。credential値とAuthorization/request headerは表示・記録しない。

## 完了条件

- executionが使ったinstruction、skill catalog/loaded skill、tool contract、runtime fact/tool observationを
  content-addressed snapshotでreadbackでき、discovered/resolved/loaded/observed/projectedを区別できる。
- parent/planner/web-searchの実model requestがexecution-local identityと、exact ordered input、model selection、
  provider wire evidenceへ相関する。provider-free/request前failureでもlogical requestの事実が残る。
- canonical/checkpoint/recall/current-execution contentの実projectionがrequest itemに対応し、閲覧が
  canonical adoption、source execution、model projectionを変更しない。
- normal settlementはcontext completeを同じtransactionで確定し、crash reconciliationはHost-observed contentだけを
  partialで残す。自動replayや未観測contentの推定は行わない。
- mutable sourceの変更後も過去snapshotが不変で、digest/size不一致は現在sourceへfallbackせず
  typed history failureになる。
- schema v1/v2を移行・変換・削除せず明示的に拒否する。
- focused/関連検証、check/format/lint、`git diff --check`、一回のauthoritative `v0:gate`、standalone
  production Human Gate、最終差分reviewが完了する。

## 対象外

- schema v1/v2 DB、旧JSON、過去Session/execution/evidenceのmigration、conversion、compatibility read、fallback、自動削除。
- `AgentContextGeneration` identity、`/rebuild`、resourceの再解決/有効化、Worker replacement、context transition。
- instruction、skill、tool contract/implementationの編集、candidate生成、revision promotion、active binding変更。
- tool implementation/source/dependency、past Worker/module graph、OS/filesystem/environment全体、provider内部状態、
  external service、tool effectの完全snapshot/再現。
- per-model/provider/tool effectのdurable acknowledgement barrier、provider/toolのretry、replay、rollback、冪等性制御。
- 存在するがHenjiがdiscoveryでacceptedしなかったresourceの走査・snapshot。
- automatic context compactionの復活、存在しないmodel requestの擬制、checkpoint仕様の変更。
- Increment 43のhuman history timeline、keyword検索、renderer、durable history全体export。
- architecture、構想、roadmap、installed binary、commit、push、tag、publish、releaseの変更。

## 実装・検証結果

2026-09-13、承認済みSlice A〜Dを実装した。

- historyを破壊的schema v3へ更新し、content-addressed `context_blobs`、stage別の
  `execution_context_relations`、論理`model_requests`、ordered `model_request_items`を追加した。
  v1/v2のmigration、conversion、compatibility read、fallback、自動削除は追加していない。
- Worker generation basisからinstruction component、workspace instruction、skill catalogと個別skill、
  materialized tool contract、runtime factをHostへ渡し、execution開始と同じtransactionでsnapshotする。
  skillのdiscovered/loaded/projected、tool outputのobserved/projectedは別relationとして保存し、loadedと
  observedには原因となったmodel request ordinalを保持する。
- parent、delegated planner、web searchの論理requestをexecution-local ordinalで一列にし、exact model
  selection、provider-neutral inputまたはweb-search body、ordered message/tool contract、source attributionを
  保存する。`ProviderEvidenceV5`と`WorkerExecutionArtifactV5`は同じcontext request ordinalを持ち、provider
  wire bodyと論理requestを上書きせず相互参照する。
- normal settlementは最終context manifestとlive journal/projectionを検証してcanonical stateと
  `context_capture=complete`を同じtransactionで確定する。不正なmanifestはnormal contract-failureとして
  failed/non-canonicalへsettleし、restart reconciliationはHostが観測したrowだけをpartialとして保持する。
- `diagnostics executions context/request`を追加し、active/partial/complete/failedのsnapshotとrequest input、
  source relation、provider evidence linkをread-onlyで返す。active readはWALのdeferred read transactionから
  一貫したrowをin-memory SQLiteへcopyして直ちにlive transactionを閉じ、その後のprojectionをmemory上で行う。
  これにより一貫したdiagnosticsと、並行するSession writerの250 ms contractを両立した。
- READMEとCLI contractをschema v3およびexact context diagnosticsへ更新した。architecture、構想、roadmap、
  installed binaryは変更していない。

Increment 42 focused testは26件、Increment 41 live journal regressionは12件、Worker foundationは39件、
provider関連は20件が成功した。最終candidateに対する`v0:check`、format、lint、`git diff --check`を完了し、
authoritative `v0:gate`は全243 test成功した。最初のgate試行はrepository外の`/tmp`空き容量が14〜17 MiBしかなく、
5 MiB contextのSQLite testで`history_io_failure`となった。同じtestはrepository-local tempで10回連続成功したため、
既存のIncrement 40一時artifactをchecksum確認付きで一時退避して空きを確保し、gate成功後に元pathへ戻した。
退避前後のSHA-256はともに
`f9003685c353104ab1df8e017962c44db458882e6d0fef0ef3d5065385fd21b2`である。

### Production Human Gate結果

source `abdb9f4e+dirty`からbuild ID
`55ce1de916a41f817b832414ceab772785508484d0f3da461a71b2b750799fd7`のstandalone candidateを作り、empty isolated
XDG state、独立workspace、real TTY、OpenRouter `deepseek/deepseek-v4.1-flash` highで確認した。

- Session `4c1a2981-ad07-4377-800e-b5791d53f719`、execution
  `cee626bf-8a6e-4418-a5eb-4cc0d63e2cad`は2 model requestでcanonical/completeになった。対象skillは
  request 1でdiscovered/loaded、request 2でprojectedされ、未使用skillはdiscovered onlyだった。skill/read/bashの
  tool resultはrequest 1にobservedとして相関し、request diagnosticsはordered input、全9 tool contract、model
  selection、各request ordinalと一致するprovider evidence linkを返した。
- 元のworkspace/skill sourceを編集後も上記executionは旧marker
  `I42_AGENTS_REVISED_90bca1` / `I42_SKILL_REVISED_61c3ab02`と旧digestを返した。新Session
  `64099e6f-cb0d-4b72-a291-55ee61c6ac24`、execution
  `04ef3cc4-4f74-4224-adfe-a7eb67297be9`は新marker
  `I42_AGENTS_FINAL_REV_71d5e0` / `I42_SKILL_FINAL_REV_e19b43`と別digestを参照し、旧snapshotは不変だった。
- 同じ最初のSessionでlong-running execution `8600c60f-4e43-4433-84c8-bc6d7bb3aab9`を開始した。tool実行中の
  active diagnosticsはrequest 1、15 item、51 relationをpartialとして返した。対象TUI/bash/sleep processだけを停止し、
  exact Sessionを再開するとsettled/interrupted/non-canonical、context partial、request 1、relation 51へreconcileされ、
  canonical turn/message追加とprovider/tool replayは0件だった。
- 明示的に作ったschema v2 DBは`history_invalid`で拒否され、前後のSHA-256はともに
  `a9dc0c19b256e2e7148523987c1594d0d22cac57b87c6bec77437f05e60de418`だった。migration、copy、削除、書換えは
  発生しなかった。
- DBとdiagnostics出力に対するcredential marker確認では`Authorization` / `Bearer `は存在しなかった。
  credential値自体は読み出していない。installed binary
  `f8fb18486d0d54e45e936329c1a58de509a07d794324d23e46d19c894bc9ddc8`は置換していない。

## 第三者review

2026-09-13、現行source、Increment 41計画、content identity、model request観測点、parent/planner/web-search相関、
projection source、skill stage、settlement/reconciliation、diagnostics、破壊的schema v3、production Human Gateを
対象にbounded read-only reviewを行った。Blockerはなく、次のP1 4件を採用して計画へ反映した。

1. 同一contentからsourceを逆算できないため、messageとともにprojection変換されるprovenance sidecarを追加した。
2. `resolved`を実際のinstruction composition、catalog manifest、materialized tool contract、external opaque
   Definition outputから生成する規則を追加した。
3. web-searchをbudget claim、body構築、context観測、credential解決、evidence/fetchの順に固定した。
4. invalid/missing final manifestをactive/reconciliationへ残さず、context failedのnormal contract-failureとして
   non-canonical settlementする経路を追加した。

一回のbounded re-reviewで上記4件の解消を確認し、新しいBlocker/P1はなかった。非blockingな明確化として、
diagnosticsのcapture statusに`failed`を明記し、contract-failure verificationでそのreadbackも確認するよう反映した。
Increment 41完成形とのschema/API再照合後、実装へ進んだ。

実装中のbounded read-only reviewでは、skill relationのrequestごとの重複、loaded/observed relationに原因request
ordinalがないこと、active diagnosticsがまだcontext projectionへ反映されていないdurable journal rowを表示しないこと、
その修正案がlive DBへ`BEGIN IMMEDIATE`を保持して大きなdiagnostics中にwriterを250 ms超blockし得ることをP1として
報告した。各findingを順に修正し、最後の問題はlive WAL snapshotをin-memory SQLiteへcopyする方式へ置き換えた。
最終bounded reviewは対象sourceと回帰testを確認し、既存findingの解消、新しいBlocker/P1なしと結論した。

## Human Gateと停止条件

- この個別計画の実装には利用者の明示承認を必要とする。Increment 41の実装・受入が未完了なら
  Increment 42の実装は開始しない。
- 承認後はSlice A〜Dを継続し、Increment 41実装後の実際schema/APIが本計画の不変条件を満たせない、
  per-request durable ackが必須と判明する、またはarchitecture、roadmap、対象機能、外部contract、受入水準を
  変える必要が判明した場合に停止し、証拠と代案を利用者へ返す。
- production Human Gateでreal-provider credentialを利用できなければ、credential値を読まずavailabilityだけを
  報告し、provider-free fixtureで完了扱いに置き換えない。
- repository外のinstalled binary置換、commit、push、tag、publish、releaseは別の利用者指示を必要とする。
