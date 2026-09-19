# Increment 89 — context履歴の増分revision化

ステータス: **実装・検証完了**

基準commit: `26c423e1`

計画日: 2026-09-19

実装・検証日: 2026-09-20

第三者review: 2026-09-19（`gpt-6-astra`、reasoning `xhigh`。初回判定「要修正」、Blockerなし、
P1 2件・P2 1件を本文へ反映。focused re-reviewの残P2 2件と、批判reviewの条件付き承認P2 2件も反映し、
変更箇所のfocused re-reviewでBlocker／P1／P2なし）

関連: 通常利用メモB6、Increment 42（exact context attribution）、Increment 50（normalized history）、
Increment 86（journal batching）、Increment 87（journal index）、Increment 88（B6原因調査）。

## 利用者が必要とする動作

- 長いSessionや、一turn内でmodel step・provider observationが増える実利用でも、Henjiのcontext履歴保存に
  過去context量を繰り返し掛け合わせる非線形な待ち時間が発生しない。
- 各model requestで実際に使用したsystem instruction、ordered transcript、tool contract、補助provider bodyと、
  それぞれの発生元・projection・provider evidenceを、settlement後もexactに追跡・readbackできる。
- 同じbytesを持つ別のmessage/source occurrenceを内容一致だけで同一視しない。contentの重複排除と、発生事実・
  source identity・requestへの投影を別の事実として保持する。
- active/interrupted executionはHostがdurableに観測した範囲だけをpartialとして返し、normal settlementはWorkerの
  final manifestと保存済みrevisionを照合してcompleteにする。追跡可能性を性能改善のためにcoalesceまたは省略しない。

## 利用者判断とcutover方針

- 2026-09-19、利用者は、Henjiが開発中である現在は既存履歴の継承を要求せず、安定・常用可能になる前に
  抜本的なschema／protocol／code変更を行う方針を示した。
- schema v4からのmigration、converter、compatibility read、dual-read/write、fallbackは実装しない。
- production historyの正本を新しいDB filenameとschema versionへ切り替える。旧DB fileを自動削除・上書きしないが、
  新runtimeからは参照しない。既存dataを物理削除する操作は本incrementに含めない。
- architecture／roadmap正本は本計画の承認対象に含めず変更しない。意味上の更新が必要と判明した場合は、対象・理由・
  変更内容を別途利用者へ提示する。

## 根拠となる実行証拠とcurrent source

- Increment 88で、単一`context_observation`を処理するHostの`ctx` phase全体が最大17,343ms、`store.tx` bodyが
  最大29秒、`busy.tick-gap`が最大52.5秒と測定された。このphaseにはcurrent request item処理、source journal探索、
  context marker hydrateが含まれるが、decode、digest、blob照合等を含む内部subpath別の時間寄与は未測定である。
- request全itemのbase64再送、全item validation、current requestの累積item処理はcurrent sourceで確認できる増幅経路
  であり、上記測定だけから単独の支配要因とは断定しない。
- `ContextModelRequestRecord`はprotocol transport、storage materialization、diagnostics readbackを兼用し、完全な
  `request`／`providerBody`と、各itemの`bytesBase64`を同時に持つ。
- `validateContextModelRequestRecord`は全itemをbase64 decodeし、このvalidationはbuffer投入時とSQLite append時に
  重複する。
- `writeContextObservationsTx`はexecutionの全context observationを毎回列挙して既存materializationを判定する。
  materialize済みrequestのitem処理はskipするが、current requestでは累積した全itemを処理する。
- `sourceEventOrdinalFor`はsource relationごとにcurrent executionのjournal全体を走査し、途中のnormalized
  `context_observation`を`eventPayloadTx`でhydrateすると全request contextを再構築する。この経路はmodel step数、
  source relation数、journal event数を掛け合わせる。
- normal settlement／reconciliationの`writeToolContextRelationsTx`とprovider evidence照合もjournal eventを走査し、
  context markerを`eventPayloadTx`でhydrateする。このためlive appendだけを増分化しても、turn完了時に過去requestを
  累積再展開する経路が残る。
- committed transcriptのsource構築はmessageごとに`indexSessionHistory(this.committedTranscript)`を呼び、全履歴を
  parse・cloneする。長い既存Sessionではexecution初期化だけでmessage数×履歴bytesの処理になる。
- Workerの`ModelExecutionContext.observeModelRequest`呼出では、各requestで`preparedRequest`とsource transcript
  sidecarをcloneする。Host transportをdelta化しても、この履歴観測専用cloneを残せば累積context bytesを各stepで
  再処理する経路が残る。
- human historyのlist／searchとJSONL exportは、現行の`humanProjectionInputTx`やcontext marker hydrateを介して
  execution内の全requestを展開し得る。一requestのdetailだけを読む操作も、全request hydrateと分離されていない。
- provider fact照合には、相互`Array.some`やfactごとの`findIndex`による二乗比較になり得る経路がある。
- 現行のprovider-neutral model request上限はserialized messages 5 MiB、complete request 6 MiB。requestを外部providerへ
  渡すための実サイズに比例する処理は必要だが、history保存が過去request全体を追加で再処理する必要はない。

## Product contract

### 1. content、occurrence、sequence revision、requestを分離する

history schemaは次の四層を別authorityとして持つ。

1. `context_blobs`: raw bytesをdigestで一度だけ保存するcontent-addressed store。
2. `context_occurrences`: contentが、system、message、tool contract、provider body等のどの発生事実として現れたかを
   保存する。同じdigestでもsource identityが異なれば別occurrenceにする。
3. `context_sequence_revisions`: ordered occurrence列を、base revisionに対する一つ以上のsplice
   （start、delete count、ordered insertions）として保存する。
4. `model_requests`: request metadataと、実際に使用したsystem／transcript／tool／provider bodyのrevisionまたは
   occurrence参照だけを保存する。

request itemの`projected`は、対象requestが参照するsequence revisionにoccurrenceが含まれることで表す。
target requestのlane、model step、request ordinalを同じsource relationへrequestごとに複製しない。

revision digestは完全snapshotを展開・再hashして作らない。次のcanonical tupleをdigest対象とする。

- schema version、lane、sequence kind、base revision digest（初期revisionでは`null`）。
- ordered splice（start index、delete count、挿入順）。
- 挿入occurrenceのidentityと、content descriptor・normalized source・causal referenceを結ぶoccurrence record digest。
- splice適用後のitem count。

Hostは保存済みbase revisionとoccurrence rowから同じdigestを増分再計算する。異なるedit chainが同じflattened sequenceに
到達しても同一revisionと推定せず、それぞれの観測されたrevision identityを維持する。

### 2. 増分Worker observation

- Workerはexecution内でsystem instruction、tool contracts、既存transcript occurrenceを一度だけ構築する。
- committed transcriptはexecution開始時に一回だけ走査し、canonical message positionからturn／turn内message位置への
  indexを作る。messageごとのsource生成、checkpoint境界、request projectionはこのindexを再利用し、
  `indexSessionHistory`や全transcript cloneをmessageごとに繰り返さない。
- assistant、tool result、steering、checkpoint、recall等は、それぞれが発生・投影された時点で新しいoccurrenceを
  作る。duplicate bytesからsource identityを逆算しない。
- model request observationは、前の適切なrevision identity、今回のsplice、新しいoccurrence、新しいblob、request
  metadataを送る。過去itemのbytes、完全な`ModelRequest`、同じsource relationを再送しない。
- `ModelExecutionContext.observeModelRequest`を含む履歴観測seamは、request projectionと同じoperationが生成した
  immutableなoccurrence／revision deltaまたはその参照を受け取る。履歴保存のためだけに、完全な`preparedRequest`や
  source transcript sidecarをclone、serialize、digestし直さない。
- parentとdelegated plannerは独立したrevision系列を持つ。web search等の補助requestはprovider body occurrenceを
  参照し、Agent transcriptを擬制しない。
- Workerはreadback用の完全snapshotをprotocol messageへ戻さない。完全な`ContextModelRequestRecord`はHostが保存済み
  revisionから必要時に構築するread modelとする。

### 3. direct causal event correlation

- Worker protocol上の`worker_sequence`と、Host storage上の`source_event_ordinal`を別type／fieldとして扱う。
  WorkerがHost journal ordinalを生成・推定しない。
- Hostは`execution_observations(execution_id, worker_sequence)`のindex lookupで`source_event_ordinal`へ解決する。
  logical identity、call ID、payload内容からjournalを後走査して推測しない。
- source種類ごとのcause、sequence取得元、occurrenceとの結合時点を次の契約とする。

| source | durable cause | Worker sequence取得・結合時点 |
| --- | --- | --- |
| parent task | `runtime_event`の`user_message` | event postで返されたsequenceをpending task occurrenceへ結合してから最初のrequest revisionを確定する |
| steering | `runtime_event`の`steering_message` | event postで返されたsequenceを対応するpending steering occurrenceへ結合してから次request revisionを確定する |
| `providerObservation` portを持つ経路のassistant／tool call／tool result | provider evidenceの対応fact | `ProviderEvidenceRecorder`からprovider observationをpostした時に返るsequenceを、lane＋call／message occurrenceへ結合する。provider-free modelでもportがあればこの経路を使う |
| `providerObservation` portを持たずruntime／effectを直接発行する経路のassistant／tool | 実際にpostされるruntime／effect fact | 該当portが返すsequenceを、同じlaneのoccurrenceへ結合する |
| delegated planner task | 親laneのdelegation tool call | planner内に存在しない`user_message`を擬制せず、planner admission元のparent tool-call occurrence／sequenceへ結ぶ |
| canonical Session message | 保存済みcanonical message identity | current worker sequenceを持たず、source Session／turn／messageへ直接linkする |
| checkpoint／recall source | 保存済みcheckpoint／projection／source execution identity | current worker sequenceを持たず、対応するdurable sourceへ直接linkする |

- provider、effect、runtime eventの各portは、実際に割り当てたWorker sequenceを呼出側へ返せるcontractにする。
  source生成がevent送信より先になるparent task／steeringはpending occurrenceとして保持し、post後に確定する。
- current-execution由来でdirect sequenceが必要なのに欠落・不整合がある場合は、relationを黙って省略せず
  `history_invalid`としてnormal settlementを受け入れない。

### 4. bounded write path

一つのcontext observationをappendするtransactionは、次だけを処理する。

- 今回初出で、Host storeに存在しないblobのdecode・digest検証・insert。
- 今回初出のoccurrenceとsource factのinsert。
- 今回のsequence spliceとrequest metadataのvalidate・insert。
- direct worker sequenceからsource journal ordinalへのindex lookup。

live writeでは次を行わない。

- executionの過去context observation、model request、journal全体のscan。
- 過去requestのhydrate、`readExecutionContextTx`、`eventPayloadTx`経由の再構築。
- 保存済みblobのbase64 decode、再digest、byte比較。
- relation／itemごとの`max(ordinal)`。transaction開始時に必要なcounterを一度だけ取得し、局所連番を使う。

normal settlement、normal failure settlement、reconciliationでは、request件数・順序・欠落とmanifestを確認するため、
request metadataと到達可能な共有revision／occurrence／blobを一回ずつ列挙できる。ただしrequestごとの過去context展開、
context markerのhydrate、同じ共有factの反復検証、journal全体のpayload scanは行わない。

request `k`の新規blob bytesを`B_k`、新規occurrenceを`O_k`、sequence editを`D_k`、新規journal eventを`P_k`
としたとき、history writeの仕事量は`B_k + O_k + D_k + P_k`に比例させる。過去request item数またはjournal event数を
掛けた項を持たせない。

toolのobserved／loaded factはtool event受信時に増分materializeする。terminal toolやfailure後に次requestが無い場合も
factを保持し、settlement時にjournalを再走査して補完しない。provider evidence照合はnormalized provider factとrequest
revision参照を直接読み、context observation payloadをhydrateしない。provider fact identityのindex／mapを一回構築し、
相互`Array.some`やfactごとの`findIndex`で同じ集合を反復走査しない。

### 5. exact readbackとsettlement

- list／searchはrequest／execution metadataと検索用normalized factだけを読み、完全requestやrevision chainを
  hydrateしない。一requestのdiagnostics detailは指定されたrequestのrevision chainと共有baseを一度だけ展開し、
  同じexecutionの他requestをhydrateしない。
- normalized JSONL exportはrevision、occurrence、blob、relationをそれぞれ一度だけ出力し、完全snapshotをrequestごとに
  再構築しない。従来同等のhydrated full exportを残す場合は明示的に別操作とし、出力量に比例する処理として扱う。
- 一requestのdiagnostics detailまたは明示的なhydrated full exportでは、revisionから従来と同じ完全なprovider-neutral
  `ModelRequest`／provider body、ordered item、source attributionを構築する。
- final manifestはordered request metadataと各requestのrevision digestを持つ。Hostはbase revision、splice、leaf
  occurrence、blob digest、external observed/loaded relation、provider evidence linkを保存済みrowから照合する。
- settlementは到達可能な共有revision／occurrence／blobを一度ずつ検証し、requestごとにflattenして同じbaseを
  再検証しない。provider evidenceとtool factの照合もnormalized fact／direct referenceだけで行う。
- 同一bytesのduplicate occurrence、同じcall IDを持ち得る別lane、同じmessageの複数projectionを区別する。
- active／restart reconciliationはdurable revisionまでをpartialとして返し、未配送のWorker memoryを補完しない。
- いずれのhuman history read／export操作も、canonical state、Worker generation、request projectionを変更しない。

## 実装計画

### Slice A — schema v5とpure codecs

1. production DBを新filename・schema v5へ切り替え、v4 migration／fallbackを持たないDDLを定義する。
2. `context_blobs`、stable occurrence/source、sequence revision/splice/insertions、request root参照のtableとindexを定義する。
3. transport observation、stored revision、hydrated read modelを別type／validatorへ分離する。
4. Worker sequenceとHost journal ordinalを別typeにし、producer portが割当済みsequenceを返すprotocolを定義する。
5. pureなsplice適用、base digest＋splice＋occurrence record digestによる増分revision digest、request hydrate、
   manifest構築・validationを実装する。完全snapshotの再hashは使わない。

### Slice B — Worker-owned incremental projection

1. request projectionと同じoperationでoccurrence identity・content descriptor・source sidecarを維持する。
2. committed transcriptを一回走査してcanonical position indexを作り、generation basis、system、tool contractsとともに
   一度だけoccurrence化する。source生成とcheckpoint境界は同じindexを再利用する。
3. parent／planner laneごとのcurrent revisionを保持し、assistant、tool result、steering、checkpoint、recall、web searchで
   deltaを生成する。
4. source producer対応表に従い、runtime／effect／provider portが返すsequenceをpending occurrenceへ結合する。
   planner taskは親delegation tool callへ結び、存在しないplanner `user_message`を作らない。
5. `ModelExecutionContext.observeModelRequest`とそのcallerをdelta／reference入力へ切り替え、履歴観測専用の
   `preparedRequest`／source sidecar全体cloneを削除する。
6. final manifestを完全snapshot配列ではなくrequest revision identityから構築する。

### Slice C — Host journal materializationとreadback

1. `context_observation`受信時にcurrent deltaだけを一transactionでmaterializeする。
2. `writeContextObservationsTx`の全row loopと`sourceEventOrdinalFor`のjournal scanを削除する。
3. tool observed／loaded factをevent append時に増分materializeし、`writeToolContextRelationsTx`のsettlement scanを削除する。
4. provider evidence照合をnormalized factとrequest revision参照へ切り替え、context markerのhydrateを削除する。
5. provider fact照合をidentity index／mapへ切り替え、相互`Array.some`と反復`findIndex`を削除する。
6. direct sequence lookup、unknown base／occurrence／blob、invalid splice、duplicate requestをtypedに拒否する。
7. human historyをmetadata list／search、single-request detail、normalized JSONL、明示的なhydrated full exportへ分離し、
   list／search／single detailがexecution内の全requestをhydrateしないrevision read modelへ接続する。
8. settlement、normal failure settlement、reconciliationを、共有revision／occurrenceを一度ずつ検証するmanifest照合へ
   切り替える。

### Slice D — product verification

1. fixed long contextを複数requestで再利用したとき、二回目以降のblob transfer／insertが0で、request rowとdelta以外が
   context全量に比例して増えないことをDB row countとtransport byte countで確認する。
2. 長いcommitted Sessionの初期化で、canonical position index、clone、occurrence構築がmessage数と履歴bytesに対して
   一回の走査であり、messageごとの全履歴再index／cloneが無いことをoperation countで確認する。
3. 各stepでassistant/tool messageを追加するturnで、context保存row数とmaterialization operation数が追加occurrence数に
   比例し、request数×累積item数にならないことを確認する。request projection開始からHost transaction完了までの
   履歴保存専用clone／serialize／digest bytesを計測し、二回目以降のrequestで過去context bytesが再計上されないことを
   確認する。
4. source producer対応表の各経路で、Worker sequenceが正しいdurable factへ結ばれ、planner task／canonical／recallに
   存在しないcurrent eventを擬制しないことを確認する。
5. duplicate content、checkpoint、recall、parent/planner、web search、steering、provider retry、active partial、restart、
   malformed delta／manifestについてexact readbackと拒否契約を確認する。
6. live appendだけでなくnormal settlement、normal failure settlement、reconciliationについて、context marker hydrate、
   全request flatten、journal全走査が無く、処理量が新規fact／reachable revision数に比例することを確認する。
7. provider fact照合でidentity indexを一回構築し、照合operation数がfact数の積にならないことを確認する。
8. 長いexecutionでmetadata list／searchがrequest payloadをhydrateせず、single-request detailが指定requestのreachable
   revisionだけを展開し、normalized JSONLがrevision／occurrence／blobを各一回だけ出力することをoperation countで確認する。
9. Increment 40／41／42／43／50／86／87に対応するproduct動作を新schema契約へ更新してfocused確認する。
10. `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。安定候補でauthoritative `v0:gate`を一回実行する。
11. isolated XDG＋実provider＋tmuxで、長いtool loop／provider observation burstの各context materialization時間がstep進行で
   増大せず、turnが正常settlementし、exact request/historyをreadbackできることを確認する。

## 成功条件

- execution初期化とlive context writeに、messageごとの全Session再index、過去request、過去request item、過去journal
  eventに比例するscan／hydrateが存在しない。
- normal／failure settlementとreconciliationはrequest metadataと到達可能な共有factを一回ずつ照合するが、
  requestごとのcontext展開、context marker hydrate、同じfactの反復検証を行わない。
- unchanged contextを再利用するrequestは、過去blob bytesとsource occurrenceを再送・再decode・再insertしない。
- request projectionからHost transactionまで、履歴保存専用に完全request／source sidecarをclone、serialize、digestせず、
  過去context bytesをrequestごとに再処理しない。
- growing contextの保存operation数が新規／変更occurrenceとspliceに比例することを、wall-clock閾値ではなくcounter・row・
  transport byteの証拠で確認できる。
- revision digestはbase digest、splice、occurrenceのcontent／sourceを増分に結び、完全snapshotを展開・再hashしない。
- direct causal relationはsource producer対応表どおりの実在factへ結ばれ、Worker sequenceとHost ordinalを混同しない。
- settled requestの完全な内容・順序・source attribution・provider correlationをrevisionからexactにreadbackできる。
- metadata list／searchはrequest payloadをhydrateせず、single-request detailは他requestを展開せず、normalized JSONLは
  revision／occurrence／blobを各一回だけ出力する。hydrated full exportは明示的な別操作として出力量にだけ比例する。
- provider fact照合はidentity index／mapによる一回の集合走査であり、fact数の積に比例する比較を行わない。
- malformed／欠落deltaまたはmanifestをcompleteとして受け入れず、保存済みpartial evidenceは維持する。
- 実provider経路でB6の非線形stallが再現せず、`ok=1 stop=final`まで完了する。

## 実装結果

- production authorityをschema v5・`history-v5.sqlite3`・`locks-v5`へ破壊的に切り替えた。v4 migration、
  compatibility read、dual read/write、fallback、旧DB削除は追加していない。
- Worker→Hostの完全request transportを`ContextModelRequestDelta`へ置き換えた。execution内の初出blobだけがbytesを
  持ち、同じcontentの別occurrenceは別identityのままdigest参照する。parent／plannerは別revision系列を持ち、
  auxiliary provider bodyも独立occurrence／revisionとして保存する。
- ordered contextをbase revision＋splice＋occurrence insertionで保存し、request rowはrevision rootだけを参照する。
  hydrated `ContextModelRequestRecord`は指定requestのrevision chainを必要時に展開するread modelへ限定した。
- committed transcriptの履歴indexをexecution開始時に一回だけ構築し、model stepごとの完全request／source sidecarの
  履歴専用cloneを削除した。
- runtime／effect／provider portが割り当てたWorker sequenceを返し、Hostが
  `execution_observations(execution_id, worker_sequence)`でsource event ordinalへ解決するようにした。planner taskは親の
  delegation tool callへ結び、planner laneの架空`user_message`は生成しない。
- occurrence sourceを`context_occurrence_sources`へ正規化し、settlementも同tableからWorker側因果列を再構成して
  occurrence digestを検証する。複製JSONをauthorityにせず、正規化行の改ざんは`history_invalid`になる。
- tool observed／loaded factをevent append時に増分materializeし、context observation／journalのsettlement再走査を
  削除した。provider evidence照合とpartial reconciliationはnormalized factのmap／indexを一回構築して行う。
- human history list／searchはmetadataとnormalized factだけを読み、single-request detailとdiagnostics CLIは対象requestと
  それが参照するprovider evidenceだけを直接読む。normalized JSONLはrevision、occurrence、source、blobを一度ずつ出力する。

## Verification結果

- 新規`increment_89_context_revision_test.ts`で、約539 KiBの重複した長いcommitted contextを3 requestで再利用し、
  初回だけblob bytesを送り、2回目以降は追加messageのsuffix spliceだけを送ること、occurrence identityは重複しないこと、
  current-execution sourceがdirect Worker sequenceを持つことを確認した。
- Increment 42の5 MiB context exact readback、duplicate content、checkpoint／recall、planner、web search、provider retry、
  active partial、malformed manifest、normalized source改ざん拒否を新schemaで確認した。Increment 40／41／43／50／86／87の
  対応product動作もfocused testおよびfull gateで確認した。
- metadata list／normalized exportは、参照先に壊れたblobがあってもpayloadをhydrateせず成功し、指定request detailだけが
  そのblobを検証して拒否することを確認した。
- production CLI固定E2E（実provider、隔離XDG）は2 provider request、`read` tool、normal settlement、schema v5 evidence保存を
  `ok=true`で完了した。retained run rootは`/tmp/henji-production-e2e-3d474576b1cd4fa3`。
- tmux 3.5a内のproduction TUI（実provider、隔離XDG）で、read 8回を一stepずつ実行する9 request turnが
  `INCREMENT89_OK`で正常settlementした。execution `923e196a-1350-4cee-91bb-eca50a12ed97`は377 observation
  （provider fact 326）、9 request／9 revision／9 splice／28 occurrenceを保存した。各context observationから次の
  provider request startまでのgapは`11, 0, 1, 1, 1, 1, 2, 1, 2 ms`で、step進行による増大は観測されなかった。
  最終requestは17 transcript message、10 tool contract、28 ordered itemと対応provider evidenceをexactにreadbackできた。
- `v0:check`、project format／lint、`git diff --check`、authoritative `v0:gate`はexit 0。concept、architecture、roadmapは
  変更していない。

## 対象外

- schema v4履歴のmigration、converter、compatibility read、dual-read/write、旧DB削除。
- model/provider側へ送る実conversation sizeそのものの削減、provider prompt caching、Session compaction方針の変更。
- provider observationのcoalesce、traceability粒度の削減、credential／Authorizationを含む新しい記録。
- History Workerへのthread分離だけで性能問題を隠す対応。必要なら増分化後の別incrementで扱う。
- architecture、roadmap、conceptの正本変更、binary配置、commit、push、release。

## Human Gate

- 既存履歴を引き継がない破壊的schema cutover、migration／compatibilityなし、大規模なprotocol・schema・code変更は
  利用者方針として確認済み。
- 第三者reviewで指摘されたsettlement／reconciliationのhydrate除去、長いcommitted Sessionの一回index化、
  source producer別sequence契約、原因記述の訂正、増分revision digest契約、settlementの一回照合境界に加え、批判reviewの
  履歴観測clone除去、metadata／detail／export read path分離、provider fact照合の一回index化を本文へ反映済み。
- 批判review指摘への変更箇所は同じreviewerがfocused re-reviewし、Blocker／P1／P2なしで承認可能と判定した。
- 2026-09-20、利用者が本文のrevision／occurrence設計、実装slice、成功条件を初期実装計画として承認した。
