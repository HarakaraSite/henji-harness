# Increment 90 — 追跡可能な履歴authorityとsegment storeの再設計

ステータス: **完了（2026-09-20、利用者受入）**

基準commit: `01b3e773`

計画日: 2026-09-20

関連: Increment 40〜43（durable history）、Increment 50（normalized history）、Increment 86〜89
（journal batching、index、原因調査、context revision）、構想
[`experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)、architecture
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

第三者review: 2026-09-20、`gpt-6-astra`／reasoning `xhigh`による通常reviewと批判reviewを実施。
両reviewは「SQLiteを維持しつつhistory authorityとschemaを根本再設計する」と判定した。追加条件
「同等のlogical deltaならSession長を履歴処理量の乗数にしない」も同じ二reviewerがfocused re-reviewし、
cost model、exact request capture、settlementとintegrity auditの分離、maintenance debtを本文へ反映した。

## 利用者が必要とする動作

- 一workspaceで100M cumulative token級のSessionが繰り返されても、履歴の総物理量が累積request snapshot、
  JSON projection、row／index overheadの重複によって数GB単位へ増幅しない。
- canonical／non-canonical execution、provider request／response、当時のparser／runtime解釈、tool activity、outcome、
  canonical adoption、Agent／build／resource attributionを、後続のHenjiと人間が因果関係を保って追跡できる。
- model用summary／compaction、人間向け表示、検索文書、後日のreinterpretationはdurable authorityを上書きしない。
- 通常turnで同等のversioned logical deltaを追加する限り、既存Sessionのpayload bytes、過去request数、
  revision-chain長を履歴処理量の乗数にせず、Sessionが長くなるほど非線形に待たされる経路を持たない。
- exact evidence、crash後のdurable prefix、canonical adoptionのatomicityを、容量または処理量のために省略しない。

## 利用者判断とcutover方針

- 開発中の現段階では既存履歴の継承を要求しない。新schemaは破壊的cutoverとし、v5 migration、converter、
  compatibility read、dual-read/write、fallbackを作らない。
- 旧`history-v5.sqlite3`と`locks-v5`は自動削除・上書きしない。production切替時は新filename／schema versionを
  単一authorityにし、旧runtime dataを新runtimeから参照しない。
- 初期targetはSQLite-onlyとする。compressed object／observation frameもSQLite BLOBに置き、外部flat-file packは
  SQLite固有の容量、WAL、page cache、checkpoint、backup問題がprototypeで確認された場合だけ別計画で判断する。
- conceptの意味は変更しない。architectureのauthority分類、capture boundary、logical recordとphysical segmentの
  分離、durable prefixの不変条件は、2026-09-20に具体的な変更案への別承認を得て正本へ反映した。roadmapは変更していない。
- commit、push、release、binary配置、旧DB削除は本計画の対象外とする。

## 観測証拠

### Henji v5

- Session `449f734d-4415-46d0-b286-b52af39cee54`、execution
  `f17711e5-ad6e-4ad9-89f9-b31af2d199c6`は、505,099 cumulative provider tokens、1 Session、
  1 execution、8,276 execution observationsで20,332,544 bytesのSQLite DBになった。
- 現行比は40.25 bytes／cumulative tokenで、同じ構成を100M tokensへ単純外挿すると約4.03GBになる。
- `dbstat`上の主な物理量は、`provider_observation_facts` 8.87MB、`execution_observations` 3.78MB、
  `worker_protocol_observations` 2.28MB、`context_blobs` 0.93MBで、残りにindex／traceがある。
- 主要payload 11.96MBは一streamのBrotli診断で0.312MB、全tableの論理row再符号化では約0.985MBだった。
  production formatの見積りではないが、内容より重複projection、反復metadata、row／index表現が大きいことを示す。
- 10 provider request bodyは合計1.728MB。input／message itemは139 occurrence、39 exact unique itemで、
  occurrence bytes 1.587MBに対しunique bytesは0.417MBだった。instructionsとtool definitionsは各7回反復した。

### 参照実装から採る点と採らない点

- Clineのcanonical semantic historyとworking compaction stateの分離は採る。通常のraw transportを完全保存しない
  retention contractは採らない。
- OpenCodeのsemantic message／partとcontext compactionは参考にするが、local DBではevent 730.6MB、うち
  `message.updated` snapshot 652.8MBであり、semantic eventでもsnapshot反復が増幅を生む証拠として扱う。
- Aider／Claude Codeのsummary／tool-result clearingはmodel working contextの手法であり、durable authorityを
  置き換える手法にはしない。
- local OpenCode集計の0.417 bytes／cumulative tokenは100M tokensあたり約41.7MBに相当するが、Henjiと保存契約が
  異なるため下限とはみなさず、反復の多いapp-development benchmarkの参考値に限定する。

## Authority model

物理schemaを先に決めず、履歴の意味上のauthorityを次に分ける。

### 1. Transport observation authority

- outboundはprovider adapterがHTTP clientへ渡したexact body bytes、endpoint、method、credential／Authorizationを
  含まないrequest metadataを保存する。
- inboundはruntimeがresponse bodyとして受け取ったexact bytes、受信順、status、保存対象response metadataを持つ。
- TCP／TLS／HTTP framing全体を観測した「network wire」とは呼ばない。各provider adapterのcapture boundaryを
  versioned contractで明示する。
- exact byte streamはordered fragment／chunk refとliteral、total length、whole digest、encoding、serializer／adapter
  attributionを持つmanifestで表せる。semantic objectの再serializeをexactnessの根拠にしない。

### 2. Contemporaneous interpretation authority

- 当時実際にemitされたSSE event、parser transition、assistant／model result、runtime／tool／effect factを
  immutable logical recordとして保存する。
- raw bytesから後日再parseできることを理由にoriginal interpretationを省略しない。recordは対応するraw byte range、
  request、parser／adapter／build revisionへlinkする。
- 後日のreinterpretationは元recordとraw evidenceを参照する新recordとして追加し、original interpretationを
  上書きしない。

### 3. Host decisionとcanonical state authority

- execution admission、outcome、settlement、effect状態、canonical／non-canonical adoption、canonical turn、Session
  revisionをHost-owned authorityとして保持する。
- evidenceのdurable appendとcanonical adoptionを別operationにし、adoption時はexecution terminal/rootとSession
  revisionを同じSQLite transactionで確定する。

### 4. Attribution authority

- logical record、request、executionを、判断に関与したAgent Definition、instruction、skill、tool contract、model、
  build、parser／adapter revision、canonical message、recall／checkpoint sourceへ結ぶ。
- exact content identityと発生事実を分離する。同じbytesでも別execution／source／occurrenceなら別factである。

### 5. Derived projection

- human history、検索文書、flattened request、canonical conversationの表示、model working context、summary／compaction、
  aggregateはauthorityから作るprojectionとして扱う。
- canonical Session stateそのものはHost authorityであり、表示projectionと混同しない。
- rebuild可能なprojectionはauthorityと同じpayloadを複製しない。同期更新が必要なprojectionにはwatermarkを持たせ、
  未反映をauthority欠落として扱わない。

## Logical cost contract

### Versioned logical delta

「同じ量の新規fact」をfact件数だけで定義しない。storage batching前のversioned schemaが次のcost inputを定める。

| 記号 | 内容 |
| --- | --- |
| `B_k` | validated immutable refを持たず、operation `k`でbytesとしてhistory captureへ入力されたrecord／payload bytes |
| `R_k` | 新規typed logical record／observation／occurrence数 |
| `F_k` | 検証済みexact object／fragment ref数 |
| `E_k` | causal／reference edge、sequence edit、root update数 |
| `I_k` | B-tree／search indexのlookup・insert・update数とkey bytes |
| `S_k` | 今回commitするimmutable microsegment数 |
| `N` | operation開始前のmetadata／index entry数 |

通常turnに伴うhistory persistence、history-owned settlement、canonical adoption、同期read／search-index更新は、
operation開始前にcommit済みのauthority payloadまたはsegmentをapplication levelで順次scan、decode、rehash、
re-encode、rewriteしない。logical workを次に保つ。

`O(B_k + R_k + S_k + (F_k + E_k + I_k) log(N + 1))`

既存Sessionのpayload bytes、execution数、過去request数、revision-chain長を乗数に持たせない。recordを一つへbundle、
または多数へsplitしても`B/R/F/E/I/S`のどれかへ現れる固定schemaにする。

### Exact requestの不可避な処理

- provider serializerが実際に出力するbody bytesを`B_wire`として別計上する。serialization、transport、inline evidence
  captureは`O(B_wire)`であり、history module外に置いたことを理由に計測から除外しない。
- 同じbodyに対する二回目のfull-body parse、chunk、hash、copyを行わない。serializerはstorage-neutralな
  exact-byte plan／evidence sinkを介し、HTTP sinkへ出すbytesと同じordered fragmentを一回だけ観測させる。
- validated refを渡されたfragmentはpayloadを再hashしない。refなしのbytesは、結果的にduplicateでも一回hashする。
- transportがcontiguous bodyを要求する場合のjoin／送信はprovider processingとして別計測するが、history capture専用の
  二回目のjoin／cloneを作らない。

### 通常path外のoperation

明示的なexact full detail／export、crash recovery、full integrity audit、backup／restore、repack、GC、VACUUM、full reindex、
codec／schema migration、later reinterpretationは通常turnのlogical bound外とし、別に処理量を測る。ただし通常turn中に
実際に発生するforeign-key／index maintenance、WAL write、checkpoint、FTS merge、fsyncを結果から除外せず、logical
counterとは別のphysical I/O／latencyとして記録する。

maintenanceをforegroundから外すだけで無期限に先送りしない。backlog bytes／count、no-maintenanceとpost-maintenanceの
総物理量をcapacity受入へ含め、次の通常turnやreadへ暗黙に全maintenanceを押し付けない。

## Target physical model

実装前のpure prototypeでrecord codec、byte fragment plan、persistent sequence、segment policyを確定する。現時点の
targetは次であり、table名やencoding詳細を成功条件にしない。

- SQLite metadata:
  - Session／Execution／canonical adoption／outcome。
  - stable logical record identity、causal edge、execution durable ledger。
  - segment directory、record anchor／locator、request／call／turn／search index。
- exact-byte objects:
  - uncompressed exact bytesのalgorithm／version付きlogical digest。
  - codec／encoded representationとそのdigestをlogical identityから分離する。
  - media type、semantic role、sourceはobject rowではなくoccurrence／record metadataに置く。
- observation frames:
  - execution／stream単位のordered typed recordをnatural append batchごとのimmutable compressed microsegmentへ入れる。
  - stable logical record IDを`segment + offset`そのものにせず、repack／codec変更でidentityを変えない。
  - execution、ordinal／time range、record count、kind summary、codec／record schema、compressed／uncompressed length、
    logical／representation digestをdirectoryへ持つ。
- byte stream／request manifest:
  - ordered exact fragment ref／literal、byte range、total length、whole digest、capture boundaryを持つ。
  - semantic context rootとexact provider body rootを別authorityとして相関する。
- sequence root:
  - Increment 89のcontent／occurrence／edit／request分離は維持するが、materializationにgenesisからのedit chain replayを
    要求しないpersistent sequence rootを持つ。
  - parent revision linkは来歴として残せるが、editはpath-copy等で`O(E log M)`、materializationはreturned item／bytesに
    比例させる。
- projection:
  - list／pageはpayload decodeなし、indexed searchはquery／match／output量、single detailは直接reachableなmetadata、
    object、returned payload量に比例させる。

## Atomic append、settlement、integrity

### Atomic append

- natural append batchをbounded microsegmentとしてencodeする。新object、segment BLOB、directory、record anchor、
  execution root／count／durable ordinal、projection updateを必要な範囲で同じSQLite transactionへ入れる。
- commit前segmentはread／settlementから不可視にし、durable acknowledgementはcommit後だけ返す。
- segmentを満たすためにHostが観測済みevidenceのdurabilityを無期限に遅らせない。max bytes、record count、flush latencyは
  prototypeのPareto測定で決め、任意値を先に契約化しない。

### Settlementとadoption

- append時にcurrent deltaのschema、ordinal、causal reference、新規bytes digest、frame digestを検証する。
- execution ledgerはordered root、record／request count、latest durable ordinal、terminal fact、unresolved reference count、
  generation／base revision fenceを増分更新する。
- settlementはWorker final stateとdurable ledgerを照合し、unresolved mandatory referenceが0でないexecutionをcomplete／
  canonicalとして受け入れない。過去payloadをdecode／rehashしない。
- canonical adoptionはsettled execution root／terminalとSession base revisionを照合し、一transactionでSession revisionと
  canonical turnを更新する。

### Integrityの分離

- `settled`／`complete`はlogical completenessとappend時検証済みのdurable rootへの一致を意味し、全過去payloadを
  settlement時点で再scrubしたことを意味しない。
- detail／exportでmaterializeするsegment／objectはlogical／representation digestをread時に検証する。
- explicit auditは全または選択範囲のpayload、root、reference、SQLite integrityを検証し、実行時刻／結果を別状態として
  記録できる。audit失敗はoriginal evidenceを削除せず、影響execution／ordinal範囲をdirectoryから特定する。

## 実装計画

各sliceは前sliceのexit条件を満たしてから進む。Slice A〜Cはproduction v5 read／write authorityを変更しない。
Slice Fのstop／go判定前にproduction cutoverを行わない。

### Slice A — authority contractと計測baseline（production無変更）

1. 現行event／table／read pathを、transport、original interpretation、Host decision／canonical state、attribution、
   derived projectionへ分類し、同一内容の複数ownerと廃止可能なmaterialized copyを一覧化する。
2. versioned logical record taxonomyと`B/R/F/E/I/S/B_wire` counterのpure contractを定義する。
3. 現行v5 storeをread-onlyで計測するCLI／helperを追加し、DB＋WAL＋SHM、table／index、logical payload、request body、
   event kind、operation counterのbaselineをcredential／Authorizationなしで取得できるようにする。
4. session `449f734d`の確認済み集計と、同じprefixを繰り返すapp-development storage workloadを固定benchmark入力として
   再現可能にする。actual private payloadをfixtureとしてcommitしない。
5. architecture正本へ必要な意味変更案を具体的diffとして提示し、別承認を得る。承認前はarchitectureを変更せず、
   Slice Bのpure prototypeを越えてproduction implementationへ進まない。

Exit:

- 全現行factが一つ以上のauthority／projection分類を持ち、同じ意味のauthority ownerが重複していない。
- benchmarkがempty-store baseline、steady physical bytes、WAL peak、logical cost vectorを再現可能に報告する。
- current production behaviorとDBは変更されない。

### Slice B — exact-byte plan、record codec、persistent sequenceのpure prototype（production無変更）

1. storage-neutralなexact-byte evidence interfaceを定義し、ordered validated ref／literal、capture boundary、serializer version、
   total length、whole digestからexact bodyを再構築するpure codecを作る。
2. provider serializerが出力したbytesとmanifest再構築結果のbyte-for-byte一致、capture pass一回、post-hoc full-body pass
   0を検証する。monolithic bodyしか生成できないprovider経路は`O(B_wire)` fallbackとして明示する。
3. typed observation record codecを作り、original parser／runtime interpretation、raw byte range、causal reference、resource
   attributionをlossless roundtripする。
4. persistent sequence候補を比較し、edit時にgenesis chainを再生せず、rootからordered contextをexactにmaterializeできる
   最小構造を選ぶ。parent revision lineageとphysical traversalを分離する。
5. compression codec、microsegment max bytes／record count／flush latency候補を同じtraceでsweepし、capacity、durable ack、
   builder memory、detail decode量のPareto結果を記録する。

Exit:

- exact body、typed record、persistent sequenceがpure roundtripとdigest一致を満たす。
- 同一logical inputに対するcodec／segment候補の比較証拠があり、閾値を任意に選んでいない。
- production module graph、v5 schema、production DBへのwriteは不変。

Stop:

- exact requestを二回目のfull-body処理なしに保持できない、またはoriginal interpretationをlosslessに表せない場合は、
  schema実装へ進まずcapture boundary／provider contractを再計画する。

### Slice C — isolated SQLite v6 store（productionから未到達）

1. 新filename／schema v6相当のisolated storeへ、object、byte stream／request manifest、observation frame、directory／anchor、
   execution ledger、persistent sequence、projection／search indexを実装する。
2. object／frameのlogical digestとencoded representation digestを分離し、同一bytesのmedia type／semantic roleをrecord側で
   区別する。cross-sessionで共有するのはimmutable bytes／nodeだけとし、occurrence／decision identityは共有しない。
3. object＋frame＋directory＋anchor＋ledger updateを一transactionでcommitし、commit後だけacknowledgementを返す。
4. transaction前、object／frame insert中、catalog publish中、commit直前／直後へcrash injectionし、最後にcommit済みの
   連続ordinal prefix以外が見えないことを確認する。
5. v5 migration、dual-write、compatibility readを作らず、test／benchmarkから明示的に生成したv6 storeだけを扱う。

Exit:

- dangling locator／reference、partial frame、root／count不一致をcompleteとしてreadできない。
- crash後にcommitted prefixをpayload全scanなしで特定できる。
- production runtimeは引き続きv5だけを使う。

### Slice D — isolated write pipelineとincremental ledger

1. provider serializer／transportにexact-byte evidence seamを接続し、`B_wire`、literal bytes、validated fragment refを別counterで
   記録する。SQLite型をprovider interfaceへ露出しない。
2. Worker／Host observationをversioned logical recordへ変換し、natural append batchをimmutable frameとしてv6 storeへ
   commitするisolated execution pathを作る。
3. Increment 89のcontext delta producerをpersistent sequence rootへ接続し、完全request／source sidecarの履歴専用clone、
   genesis revision replay、過去fragmentの再hashを持たせない。
4. ordered execution root、counts、durable ordinal、terminal、unresolved reference、generation／base revision fenceをappendごとに
   更新する。
5. provider response、SSE、parser transition、runtime／tool／effectのoriginal interpretationを別logical recordとして保持し、
   rawFrame／data／parsed／transition間で同じpayloadをauthorityとして複製しない。

Exit:

- 同じlogical deltaを異なるSession長へ追加したとき、preexisting authority payloadのdecode／rehash／re-encode／rewriteが0。
- exact request captureに二回目のfull-body passがなく、transport bytesとreadback bytesが一致する。
- isolated v6 executionのactive／failure／cancel／success evidenceがcommitted prefixまでreadbackできる。

### Slice E — read、settlement、canonical adoption、projection

1. metadata list／page、indexed search、single request／event detail、normalized streaming export、明示的exact full exportを、
   segment directory／record anchor／object manifestへ接続する。
2. list／page／search projectionはauthority payloadをdecodeせず、single detailは直接reachableなmetadata／objectとreturned
   payloadだけをmaterializeする。request sequenceをgenesisから再生しない。
3. settlement／failure settlement／restart reconciliationをexecution ledger照合へ切り替え、過去payload、全request、
   全journalをscan／rehashしない。
4. canonical adoptionをexecution root／terminalとSession base revisionのatomic transactionにする。
5. read時digest validation、corrupt segmentの影響範囲特定、explicit audit、online backup／restore verificationを実装・確認する。
6. human history、search、canonical transcript、model working context、later reinterpretationをauthority recordと区別し、
   original interpretationを変更しないことを確認する。

Exit:

- Increment 40／41／42／43／50／89のproduct contractをv6 authorityから満たす。
- list／searchのauthority payload decodeは0。single detail／exact full exportはoutput-sensitiveで、無関係なSession／execution
  payloadを読まない。
- settlement／adoptionのpayload decode／rehashが0で、mandatory unresolved referenceを持つexecutionをcompleteにしない。

### Slice F — scale、capacity、SQLite stop／go（production cutover前）

1. empty store、session `449f734d`相当の固定trace、100M cumulative token相当の反復context workload、large unique／
   incompressible payloadを同じproduction codec／segment policyで測る。
2. DB＋WAL＋SHM、peak／steady physical bytes、encoded authority baseline、storage amplification、bytes／cumulative token、
   segment／catalog／index overhead、maintenance backlogを記録する。
3. 同じlogical delta `D`をSession長`N`、`10N`、`100N`へ追加し、logical counterの不変性とB-tree operationだけの
   `log N`増加を確認する。wall-clockはp50／p95／maxとcheckpoint／page split／fsyncを分けて報告する。
4. natural minimum batchとproduction batch分布でmicrosegment policyを再確認し、compressionだけのためにdurability ackを
   遅らせていないことを確認する。
5. no-maintenance／post-maintenance双方のcapacity、maintenance中断／再開、次turnへbacklog全処理を押し付けないことを
   確認する。

Go条件:

- 反復workloadのempty-store差引後steady physical増分が`0.5 bytes／cumulative token`以下。
- production codecでauthorityを一度ずつencodeした固定corpus `C`に対し、総物理増分`P/C <= 2`。
- unique／incompressible payloadの物理増分が入力bytesへ線形で、token比のためにevidenceを省略しない。
- logical counter、read、settlement、crash、backupの成功条件を満たし、SQLite固有の通常利用阻害を観測しない。

Stop条件:

- SQLite page／WAL／checkpoint／backup挙動が容量または通常利用を支配する、あるいは上記Go条件を満たさない場合は
  production cutoverを行わない。外部packまたは別storeへ自動的に進まず、実測証拠と新しい設計案を利用者へ戻す。

### Slice G — productionの破壊的v6 cutover

1. Slice FがGoで、architecture正本の別承認・反映が完了している場合だけ、production history authorityを新filename、
   schema、locksへ一括切替する。
2. v5 migration、dual read/write、runtime fallbackを追加しない。旧v5 fileは削除しない。
3. provider／Worker／Host write、settlement、canonical adoption、human history、search、detail、export、recallをv6へ接続し、
   production module graphからv5 write/read pathを外す。
4. focused test中は変更箇所のcheck／format／lint／`git diff --check`だけを使い、stable candidateでauthoritative
   `v0:gate`を一回実行する。

Exit:

- productionから履歴を作成、途中観測、settlement、canonical adoption、再起動後readbackできる。
- v5 DBへ新しいwriteがなく、新runtimeがv5へfallbackしない。
- unrelated working tree差分と旧DB fileを変更しない。

### Slice H — 実product検証と結果記録

1. isolated XDG＋実provider＋tmuxで、長いtool loop／provider observation burstを実行し、spinner／elapsed表示を含む
   通常利用が止まらず、finalまたは観測されたfailureまでsettlementすることを確認する。
2. stepごとのhistory logical counter、segment commit、context/request capture、settlement、read detail latencyがSession／step
   進行で過去payload量に比例して増えないことを確認する。
3. exact request body、raw response、original parser/runtime/tool interpretation、outcome、canonical adoption、Agent／build／
   resource attributionをreadbackし、later projectionと混同していないことを確認する。
4. actual DB＋WAL＋SHM、encoded authority、amplification、bytes/token、maintenance backlogを計測し、Slice Fの結果と差が
   あれば原因を記録する。
5. increment文書へ実装結果と確認済み範囲を反映する。commit、push、release、binary配置は利用者の別指示を待つ。

## Slice A／B実装結果（2026-09-20）

### Slice A — Go

- `history_authority.ts`にversioned logical record taxonomy、`B/R/F/E/I/S/B_wire`と既存payload処理量のcounter、
  v5全33 application tableの単一owner分類を追加した。実v5 schemaからtable一覧を読み、分類の過不足をtestで照合する。
- `v5_history_metrics.ts`と`measure_history_v5.ts`に、payloadを出力しないread-only集計を追加した。DB／WAL／SHM、
  table／indexの物理量、TEXT／BLOB logical bytes、request／response bytes、event kind、stored delta proxyを取得する。
  workload callback中のDB／WAL／SHM peakとbefore／after steady deltaも同じhelperでsamplingできる。
- 空のproduction v5 storeは352,256 bytesだった。session `449f734d`を再計測するとDB＋WAL＋SHMは20,365,312 bytes、
  request body 1,727,882 bytes、response body 1,130,826 bytes、8,276 logical observationだった。最大tableは
  `provider_observation_facts` 8,871,936 bytes、`execution_observations` 3,780,608 bytes、
  `worker_protocol_observations` 2,277,376 bytesで、既報と一致した。
- private payloadを使わない反復prefix workload generatorを追加した。workloadはshared prefixの初回bytes、turnごとの
  new fact、各requestで不可避な`B_wire`、validated ref、record／edge数を別counterとして再現する。
- production v5 module graph、schema、runtime DBへのwriteは変更していないためSlice AをGoとした。

### Slice B — Go

- adapterが送信するfragmentをその場で一回観測する`ExactBytePlanBuilder`を追加した。validated refはobjectとして再hashせず、
  literal／refの順序、capture boundary、serializer version、encoding、total length、whole digestを保持する。manifest codecと
  read時のobject／whole digest検証によりexact bodyをbyte-for-byte再構築する。capture counterは一回、history専用の
  post-hoc full-body passは0である。
- original interpretation用のtyped logical record codecを追加した。authority、stable record ID、execution ordinal、
  raw byte range、causal ref、resource attribution、JSON payloadをcanonical encodingでlossless roundtripする。
- sequenceはcontent-addressed immutable AVL ropeを選んだ。rootから直接materializeし、parent rootはlineageだけに使う。
  16,384 itemの中央spliceで新規nodeは200未満、tree heightは32未満だった。さらに500回の決定的な任意spliceを通常arrayと
  照合し、genesis chainを再生せず同じ順序を得た。
- logical frameとencoded representationに別digestを持つlength-prefixed immutable segment codecを追加した。
  identity／gzip level 1／6／9、4／16／64／256 KiB、8／32／128／512 recordsを同じ2,000-record traceで比較した。
  gzip-6のencoded bytesは16 KiB候補78,747、64 KiB候補47,468、256 KiB候補39,428だった。64 KiBから256 KiBはdetail
  decode／builder memoryを4倍にして改善が約17%に留まるため、Slice Cの暫定候補をgzip-6、64 KiB、128 recordsとする。
  同じ64 KiB候補を30回encodeしたp50はgzip-1 1.62 ms、gzip-6 2.52 ms、gzip-9 10.71 msだった。gzip-9はgzip-6から
  約6.7%しか縮小せずp50が約4.3倍なので選ばず、gzip-6はgzip-1から約31%縮小してp50差が約0.9 msなので暫定採用した。
  flush latency 25 msはdurability ackを遅らせないことをSlice C／Dのtransaction実測で再判定する。
- focused test 7件、対象moduleのtype check／format／lint、`git diff --check`がpassした。production serializerへ未接続の
  ため、exact capture seamを成立させられないStop条件は現時点では発生していない。Slice BをGoとするが、production
  接続可否はSlice Dで再判定する。

### Slice C — Go

- productionからimportされない`SqliteHistoryV6Store`を追加し、新規`history-v6.sqlite3`だけをschema version 6で作る。
  version 5等の既存DBは拒否し、migration、dual read／write、fallbackを持たせていない。
- immutable exact object、byte-stream manifest、persistent sequence node／revision、compressed history segment、record anchor、
  object／range／causal edge、explicit projection／search document、execution ledger、canonical turnを一つのSQLite authorityへ
  配置した。exact objectとsegmentはlogical digestとencoded representation digestを分離した。
- object、manifest、sequence、segment、anchor、edge、projection、execution root／count／durable ordinalを一transactionで
  appendする。transaction前、object後、segment後、catalog後、commit直前、commit直後のfault injectionで、再open後に
  最後のcommitted ordinal prefixだけが見えることを確認した。
- unresolved causal refはledger counterへ増分反映し、後続recordで解決する。terminal後のappend、unresolved refを持つ
  settlement、base revision不一致のcanonical adoptionを拒否する。settlementとadoptionはpayload全scanを行わない。
- schema version拒否、cross-session exact object共有、exact request readback、sequence readback、明示的search projection、
  settlement／adoptionをfocused testで確認した。production CLI module graphからv6 moduleへの到達はなく、v5 DBへのwriteも
  ないためSlice CをGoとした。

### Slice D — Go

- `ModelGenerateOptions`へSQLite型を含まないstorage-neutralなexact request observerを追加した。OpenRouter ChatとOpenAI
  Responsesはobserver有効時、同じ`Uint8Array` instanceをfake fetchへ渡す。observer未指定時の既存string body／v5 evidence
  経路は維持する。
- exact observer有効時の`ProviderEvidenceRecorder`はrequestをmetadata-onlyで開始し、旧`requestBody: string`へのdecode、
  再encode、本文複製を行わない。exact bodyは一回content identityを確立してobject＋single-ref manifestへ保存し、logical
  request recordにはlength、digest、capture boundary、serializer、credentialを含まないmetadataだけを置く。
- `IsolatedV6HistoryPipeline`はprovider response bytes、SSE event、parser transition、runtime／tool event、turn outcomeを、
  transport observation、当時のinterpretation、Host decisionに分けてcurrent batchだけappendする。success、failure、cancelの
  outcomeはterminal recordとしてcommitされ、その後のappend fenceに使われる。
- Increment 89の`ContextModelRequestDelta`をpersistent sequence rootへ直接適用する。初回256 occurrenceの後へ1 occurrenceを
  追加するtestで、base sequenceを再exportせずpath-copyされた64未満のindex operation増分だけを保存し、257 occurrenceの
  順序をrootからreadbackした。context recordは`bytesBase64`をpayloadへ複製しない。
- fake providerを通したexact transport bytesとv6 readback bytesは一致した。`postHocFullBodyPasses`、既存payloadの
  decode／rehash／re-encode、old segment rewriteはいずれも0だった。Increment 90 focused testは15件、既存provider stream
  20件、provider switching 6件、instruction component 4件がpassし、production CLI graphはv6 store／pipelineへ未到達である。
  Slice Dのexit条件を満たすためGoとした。

### Slice E — Go

- record anchorだけを読むcursor pageを追加し、unfiltered、authority、kind、authority＋kind用indexを分けた。FTS5の
  execution-scoped search、watermark付きprojection readはauthority segmentをdecodeしない。segment BLOBを意図的に破損した
  後もmetadata pageとsearchは成功し、single detailだけがdigest不一致で失敗することを確認した。
- single record detailはanchorからbounded segment一つと、そのrecordが直接参照するexact object／byte streamだけを検証して
  materializeする。normalized JSON record exportと、logical record、deduplicated object、byte streamを順次返す明示的exact
  execution exportを追加した。persistent sequence readはrevision rootから直接materializeし、parent chainを辿らない。
- success、failure、cancel、restart reconciliationのterminal factをincremental ledgerへcommitし、completed／failed／
  cancelled／interrupted settlementをledgerのordinal、count、root、terminal、unresolved countだけで確定する。破損segmentが
  あってもnormal settlement／canonical adoptionは過去payloadをscanせず成功し、明示auditだけが破損を検出した。
- explicit auditはSQLite integrity／foreign key、全segment／object／stream digest、sequence root、execution ordered root／count／
  terminal／unresolved countを検証する。segment directoryから破損影響executionとordinal範囲を返す。SQLite online backupと
  backup側schema／integrity／count readbackも確認した。
- human projectionは別table／watermarkに留まり、original logical recordを変更しない。focused testは17件、対象format／lint／
  type check／`git diff --check`がpassし、production CLI graphは引き続きv6へ未到達である。Slice Eのexit条件を満たすためGoと
  した。

### Slice F — Go

- 100M-token相当benchmarkは、固定prefix 65,536 bytesへturnごとに10,000 bytesのapp-development factを追加し、271
  request、402,881,879 exact wire bytes、100,720,469 token proxy（4 bytes/token）を実際にencode／appendした。private
  payloadや外挿だけの値は使っていない。
- exact objectをgzip-6にした初回実走はsteady 60,837,888 bytes、0.6040 bytes/tokenで容量gateを超えた。dbstatでは
  exact object表だけが59.83MBでSQLite overheadは約1.05MBだった。同じ400MB corpusのcodec比較でBrotli quality 5は
  37,690,916 bytes、quality 6は37,329,588 bytesだったため、segmentのgzip-6は維持し、exact objectだけをBrotli-5へ
  変更した。
- 最終実走はempty store 221,184 bytes、checkpoint前DB＋WAL＋SHM 42,136,544 bytes、checkpoint後39,153,664 bytes、
  empty差引steady 38,932,480 bytes、`0.38654 bytes／cumulative token`だった。production codecで一度encodeしたauthority
  37,973,327 bytesに対する`P/C`は1.02526。WALを含むpeakは42.14MB、checkpointで解消したbacklogは2.98MBで、271
  requestの間に無制限増加しなかった。
- monolithic exact request append latencyはp50 12.44ms、p95 25.09ms、max 28.24msだった。これはbodyが最大約2.8MBへ
  増える`B_wire`／compressionを含む。history logical counterでは既存payload decode／rehash／re-encode、old segment
  rewrite、post-hoc full-body passはいずれも0だった。
- 同じ351-byte logical deltaを1k／10k／100k recordから25回ずつ追加した初回測定は、p50 0.20／1.55／15.73msと
  Session長へほぼ線形だった。`EXPLAIN QUERY PLAN`で、unresolved cause解消SQLが新規causeの有無にかかわらず全
  `record_anchors`をLIST subqueryへ展開すると特定した。新規record IDだけを`record_causes_unresolved` indexで更新する
  形へ変更後、p50は0.0855／0.0888／0.1024ms、p95は0.1049／0.1321／0.1657msとなった。logical cost vectorは三条件で
  完全一致した。
- 1／4／16MiBの決定的incompressible payloadは、steady physical/input比1.0000／1.0010／1.0029、append 3.14／13.24／
  67.77msで入力bytesへ線形だった。evidenceをtoken比のために省略していない。
- 容量2条件、unique payload線形性、session-length-independent logical work、read／settlement／crash／backup条件を満たし、
  SQLite page／WAL／checkpointが通常利用を支配する証拠はなかったためSlice FをGoとする。production cutoverは計画どおり
  Slice Gでのみ行う。

### Slice G — Go

- productionのSession、history persistence、human history、diagnostic／artifact／provider evidence、CLI readbackを
  `history-v6.sqlite3`／`locks-v6`の単一facadeへ切り替えた。production module graphはv6 storeだけを含み、v5 storeへの
  import、migration、dual read/write、fallbackはない。既存`history-v5.sqlite3`は削除・変更しない。
- exact provider request bytesをWorkerからHostへ一回だけ渡すprotocol factを追加し、transportへ渡した同じbyte instanceを
  v6 exact object／byte streamへ保存する。response bytes、SSE、parser transition、runtime／tool event、context delta、Host
  settlementをtyped logical recordとして相関する。
- Session canonical stateは累積record BLOBを廃止し、message、model change、turn attributionをappend-only rowへ正規化した。
  Session rowの増分counterとexecution admission時のbase message fenceを使うため、通常writeに過去rowの`count(*)` scan、
  transcript全体のencode／hash／rewriteはない。canonical outcomeとterminal protocol projectionは累積transcriptを保存せず、
  explicit execution detailだけがSession prefix＋execution deltaから再構築する。
- human list／pageはSession／turn indexとcursorで`O(log N + page size)`、single detailはdetail IDから対象executionへ直接到達する。
  3文字以上のsearchはcase-sensitive trigram FTS projectionから候補executionだけをmaterializeし、authority全scanを行わない。
  Increment 43の任意長literal契約を維持する1〜2文字queryだけはderived search projectionを走査する。search projection作成は
  当該executionのmessage／event／context metadataだけを読み、過去Sessionのexact context objectをdecodeしない。
- production作成、途中観測、success／failure／cancel／restart settlement、atomic canonical adoption、再起動readback、rollback、
  exact request相関、human page／detail／search、CLI offline E2Eをfocused testで確認した。4 turnのproduction回帰では
  `sessions.record_bytes`がNULL、execution outcome／terminal protocolの保存transcriptが空、`session_messages`が実message数と
  一致し、explicit execution readだけが各turn時点のtranscriptを復元した。
- `deno info`のproduction CLI graphには`sqlite_history_v6_production_store.ts`だけが現れた。stable candidateのauthoritative
  `v0:gate`は、初回にrepository configなしでfocused formatした6ファイルのstyle差だけで停止した。対象だけを正規formatterで
  修正後、具体的理由に基づく再実行でcheck／format／lint／全testがpassした。Slice Gのexit条件を満たすためGoとし、Slice Hの
  実product検証へ進む。

### Slice H — Go

- current sourceをisolated `XDG_STATE_HOME`／`XDG_DATA_HOME`とtmux上で3回起動し、実OpenRouter providerに対して8回の
  `bash` tool callを必ず逐次実行するturnを検証した。spinnerとelapsedは応答待ち・tool loop中も更新され、各runで8/8 callと
  `I90_LIVE_OK`まで表示された後に`ready`へ戻った。最終runは1 Session、1 canonical turn、18 messages、9 physical requestで
  `settled/completed/canonical`になった。既存v5 DB、配置済みbinary、通常XDG stateは変更していない。
- 最初のlive計測は509 recordsにもかかわらずcheckpoint後4,374,528 bytesだった。原因はprovider observationをtyped recordと
  `historyEvent`へ二重格納し、さらにsettlement前の`commit_proposal`へcompleted provider evidence全体を累積snapshotとして
  再格納していたことだった。これはauthority modelに反するためSlice Hを一旦No-Goとし、provider eventを小さなenvelope＋
  typed payload＋exact objectからread時に復元し、natural observation batchを一segmentとしてflushし、terminal eventから
  重複provider evidenceを除いた。provider evidenceの正本は個別logical recordsとsettlement時のBrotli documentに残る。
- 修正後の最終runは587 logical records、539 segments、267 exact objects、9 byte streams、9 context revisionsだった。
  request bodyは合計195,957 bytesで全streamのlength／digestが一致し、9 responseのordered byte chunksは保存済みevidenceの
  raw bodyと一致した。158 SSE raw framesをexact objectから復元でき、159 parser transitions、52 runtime facts、24 tool facts、
  586 causal edges、619 attribution edgesをoriginal interpretationとしてreadbackした。ledger terminalは存在し、unresolved
  referenceは0、stored outcome transcriptは0件、explicit execution detailだけが18 messagesを再構築した。human page／trigram
  search、provider evidence、artifact、context、full auditも成功した。
- 最終runのcheckpoint前はDB 2,891,776＋WAL 4,227,152＋SHM 32,768＝7,151,696 bytes、passive checkpoint後はDB
  3,239,936 bytes、WAL／SHM 0だった。empty store 266,240 bytesを引いたsteady増分`P`は2,973,696 bytes。segment、exact
  object、manifest、captured document、Session message、sequence、execution JSONをproduction codecで一度ずつ数えた`C`は
  1,509,690 bytesで、`P/C=1.970`となりcapacity gate `<=2`を満たした。checkpoint backlogは次turnへ持ち越されず解消した。
- この短いobservation-heavy traceのrequest-body 4 bytes/token proxyに対するempty差引物理量は60.70 bytes/tokenで、Slice Fの
  100M-token反復context workloadの0.38654 bytes/tokenとは大きく異なる。前者は約49k token proxyしかない一方、587件の
  original SSE／parser／runtime／tool factと固定schema／index costを全保存するためであり、100M-token capacityの外挿値には
  使わない。primary gateであるauthority amplification、Slice Fの100M実走、1k／10k／100k prehistoryで同一だったlogical
  counter、productionのSession delta row／counterを合わせ、Session長をforeground history workの乗数にする経路はないと
  判定した。
- 修正後のIncrement 90 focused testは21件passした。provider response byte／SSE frameのevent再構築、5件のnatural batchが
  1 segmentになること、terminal eventにcompleted provider evidence snapshotを再格納しないことを回帰確認へ追加した。
  またtrigram tokenizerが返せない1〜2文字queryはderived search projectionのcase-sensitive literal scanへ分け、Increment 43の
  任意長検索を維持した。この明示的short-query readはauthority payloadをdecodeせず、通常turnのforeground costには入らない。
  Slice HをGoとする。increment全体の完了判断、commit、push、releaseは利用者判断のままである。current sourceの
  binary配置は下記の利用者別指示により実施した。

## 完了判断

- 2026-09-20、利用者は通常利用Session `e1a40039-55c0-4cbd-a921-802ce7aa0823`のread-only確認結果を受け、
  本incrementを完了と判断した。
- 同Sessionのturn 1はexecution `bcd5d07c-3860-464c-9df8-99720ce761a7`として
  `settled`／`completed`／`canonical`になり、1,909 logical recordsはordinal 1〜1,909の連続prefix、terminal一致、
  unresolved causal reference 0だった。SQLite integrity／foreign key、ledger root、segment／exact object／byte stream／
  persistent sequenceをread-onlyで検証し、すべてpassした。
- 5 outbound exact request（合計127,340 bytes）をlength／digest込みで復元した。5 inbound responseは477 ordered chunks、
  合計431,270 bytesで、settlement時provider evidenceのraw bodyとrequestごとにbyte-for-byte一致した。SSE、parser、runtime、
  4 tool call／result、Host decision、resource attributionも個別authorityからreadbackできた。
- context revisionは初回12 itemsの後、各requestで新規2 occurrencesだけを追加し、12→14→16→18→20 itemsとなった。
  `sessions.record_bytes`はNULL、execution outcomeの保存transcriptは0件、canonical conversationは10 `session_messages` rowで
  保持され、累積Session snapshotを通常writeへ戻していない。
- context observationからexact request記録までは各1〜4ms、最終parser resultからsettlementまでは約6msで、この実利用turnに
  履歴処理由来の非線形な待ちは観測されなかった。長期Sessionに対する条件はSlice Fの100M-token実走と
  1k／10k／100k prehistory benchmarkを完了根拠として維持する。
- 別Session `362499de`で観測された`web_search`停止とcancel未settleは通常利用メモB7へ分離し、本incrementの
  history authority／segment store完了判断へ混在させない。

### Binary配置（利用者の別指示）

- 2026-09-20、利用者の明示指示により現working treeから`henji:compile`を実行し、`dist/henji`と
  `/home/masat.guest/.local/bin/henji`を同一artifactへ原子的に配置した。
- build IDは`8441c9f6c8ad21c9614a766ce0a635cc138728f0a28407c87044e573feb4021d`、binary SHA-256は
  `841d527abf280d80ade2dee92796dc669da844ed2d56951aa5922122df74af82`。両配置先の`--version`とhashは一致した。
- versionは`0.3.0`、sourceは`01b3e77381ea4a696ecbe514cb1a6fdbe96a183b+dirty`。Slice A／B moduleはproduction
  history経路へ未接続であり、この配置は開発buildのidentity/readbackを更新するがv5 runtime動作を切り替えない。
- 2026-09-20、Slice H Go後の利用者指示によりcurrent working treeから再buildし、`dist/henji`と
  `/home/masat.guest/.local/bin/henji`へ同一artifactを原子的に配置した。build IDは
  `06cd86c981ab7865fd7294ebca35eab959a28f0ba15c87cbe3ad0e2ea344b033`、binary SHA-256は
  `283a71625e4816e641d9fb7c4fee584ccbcd19909f89446ff77e33722ec523c2`、embedded runtime SHA-256は
  `2ac0c4102995bb0fe1d5118f20d3b7571298562c49e6a3752c940a900b740eff`。両pathのhash、size、mode、`--version`は
  一致した。この配置が上記Slice A／B時点のbinaryを置き換え、production v6 cutoverとSlice H修正を含む。

## Architecture正本変更 — Human Gate 2（承認・反映済み）

conceptの目的を変えずに次の意味を追加する案を2026-09-20に利用者が承認し、
`docs/architecture/henji-host-agent-worker.md`へ反映した。

### 「プロダクト上の決定」への追加

- durable historyのauthorityを、transport observation、当時のparser／runtime／tool interpretation、Host decision／
  canonical state、Agent／build／resource attributionへ分ける。人間向け表示、検索文書、model context、summary、後日の
  reinterpretationはderived projectionであり、元authorityを上書きしない。
- outbound transport authorityはprovider adapterがHTTP clientへ渡したexact body bytes、inboundはruntimeがresponse body
  として受け取ったexact bytesを境界とする。TCP／TLS／HTTP framing全体の観測とは呼ばず、credential値とAuthorizationを
  保存しない。
- logical record identityをphysical segment／offsetから独立させる。immutable exact-byte objectとobservation segmentの
  codec／配置を変更しても、occurrence、causal relation、canonical decisionのidentityを変えない。
- evidence appendとcanonical adoptionは別operationである。append acknowledgementはobject、segment、directory、anchor、
  execution ledgerのatomic commit後だけ返し、adoptionはsettled execution root／terminalとSession base revisionを
  一transactionで照合・更新する。

### 「用語」への追加

| 用語 | この概念での意味 | 存続期間 / 管轄 |
| --- | --- | --- |
| `HistoryLogicalRecord` | transport、original interpretation、Host decision、attributionの一つのimmutable fact。stable ID、execution内順序、causal ref、raw byte rangeまたはexact object refを持ち、physical locatorをidentityにしない。 | Hostが観測しcommitしたexecution evidenceとして永続化する。 |
| `HistorySegment` | 一つ以上のlogical recordをnatural append batchでまとめたbounded immutable encoding。directoryとanchorから到達し、logical digestとencoded representation digestを区別する。 | storage mechanismが所有し、repack／codec変更でlogical identityを変えない。 |
| `HistoryProjection` | authorityから導出するhuman view、search document、flattened request、model working context、summary、later reinterpretation。 | rebuild可能であり、watermark遅延をauthority欠落とみなさない。 |

### 「Durable history、canonical conversation、context projection」の冒頭置換

現行のdurable history説明2段落を、次の内容へ置き換える。

> durable historyは、Hostが取得・記録できた各executionについて、transport observation、当時実際にemitされた
> parser／runtime／tool interpretation、Host decision／canonical state、Agent／build／resource attributionを、別の
> authorityとして相関可能に保持する。outboundはprovider adapterがHTTP clientへ渡したexact body bytes、inboundは
> runtimeがresponse bodyとして受け取ったexact bytesをcapture boundaryとする。credential値、Authorization、Hostが
> 観測できなかった事象、TCP／TLS／HTTP framing全体を記録したことにはしない。
>
> original interpretationはraw bytesから後日再parseできることを理由に省略しない。human history、検索、model working
> context、summary／compaction、later reinterpretationはderived projectionであり、元のtransport、interpretation、decision、
> attribution authorityを上書きしない。projectionの同期遅延または再構築可能性をauthority欠落と混同しない。
>
> canonical conversationは、Hostが正常完了と会話への採用を確定したturnを順序付きで保持するSessionの正本である。
> 正常完了は回答内容の正しさや人間の満足を意味しない。canonical採用はturn全体を単位とし、途中のassistant outputや
> tool interactionだけを部分的に採用しない。turnへ含める具体的なmessageとprojectionは個別schemaで定める。

### 同節への「History storage不変条件」追加

- logical record／occurrence／decisionのidentityはsegment、offset、page、codec等のphysical locatorから独立する。
- exact bytesはalgorithm／version付きlogical digestを持ち、encoded representationとそのdigestを分離する。同じbytesでも
  別execution／source／occurrenceなら発生factを統合しない。
- append時にcurrent deltaのschema、ordinal、causal ref、新規bytes／frame digestを検証し、execution ledgerのroot、count、
  latest durable ordinal、terminal、unresolved referenceを増分更新する。normal settlement／adoptionは過去payloadを
  application levelで全scan／decode／rehashしない。
- `settled`はlogical completenessとappend時検証済みdurable rootへの一致を意味し、全過去payloadをsettlement時に再scrub
  したことを意味しない。materializeするpayloadはread時に検証し、全体検証はexplicit auditとして別に記録する。
- crash後に見えるexecution evidenceは最後にatomic commit済みの連続ordinal prefixに限る。未commit segment／locator／rootを
  completeとして返さない。

### 「セッションの永続性とコミット」のturn flow変更

現行step 3〜4を次へ置き換える。

3. Hostは観測済みevidenceをbounded appendとしてatomicに保存し、commit後だけdurable acknowledgementを返す。executionの
   settlementはincremental ledgerのroot、count、terminal、unresolved referenceを照合し、過去payload全体を再検証しない。
4. canonical採用時、Hostはsettled execution root／terminalと適用対象Session revisionを照合し、canonical turnとSession
   revisionを一transactionで保存する。
5. durable canonical adoptionが成功した後にのみ、HostはSurfaceまたは採用済みoutput consumerへturnをcommittedと報告する。

## Acceptance criteria

### Traceability

- exact outbound bodyとinbound bytesをcapture boundary、length、digest、ordered fragmentからbyte-for-byte readbackできる。
- original SSE／parser／runtime／tool interpretationをraw streamの再parseなしでreadbackできる。
- later reinterpretationまたはprojectionがoriginal evidence／interpretationを上書きしない。
- canonical／non-canonical、outcome、effect、Agent／build／resource attribution、causal sourceを区別して辿れる。
- duplicate bytesでも別発生事実をcontent digestだけで統合しない。

### Session-length-independent foreground history work

- `preexisting_authority_payload_bytes_decoded = 0`。
- `preexisting_authority_payload_bytes_rehashed = 0`。
- `preexisting_authority_payload_bytes_reencoded = 0`。
- `application_old_segment_logical_rewrites = 0`。
- `unreferenced_input_bytes_hashed = B_k`の一回走査であり、validated refのpayload fetch／hashは0。
- record encode、reference／edit、index operation、segment commitが`R/F/E/I/S`と対応し、table／revision-chain scanを持たない。
- normal settlement／adoptionのauthority payload decode／rehashは0で、current execution ledger、terminal、root、count、
  unresolved stateだけを検証する。
- provider serialization＋inline evidence captureの`O(B_wire)`を別計上し、post-hoc full body passは0。

### Read and integrity

- list／pageは`O(log N + page size)`でauthority payload decode 0。
- indexed searchはquery、match、returned outputに比例し、全history payloadをscanしない。
- single detailは`O(log N + directly reachable metadata／payload + returned output)`で、無関係なexecution payload decode 0。
- exact full detail／exportは明示operationでoutput-sensitiveとし、通常turnのboundへ含めない。
- append transactionの全要素がall-or-nothingで、crash後は最後にcommit済みの連続ordinal prefixだけを返す。
- read時検証とexplicit auditを持ち、settlementが全過去payloadを再scrubしたと誤って表現しない。

### Capacity and lifecycle

- physical totalはDBだけでなくWAL、SHM、将来の外部file、catalog／index、maintenance backlogを含む。
- 100M-token反復benchmarkの目標は40〜50MB級とし、primary gateはfixed authority corpusへのamplificationとする。
- segment policyはcapacity、durable ack、builder memory、detail read amplificationの測定から選ぶ。
- foregroundから外したrepack／GC／checkpoint等が無期限に蓄積し、次turnへ一括転嫁されない。

## Human Gates

1. **初期計画承認**: 本文のauthority model、複数slice、Go／Stop条件、破壊的cutover範囲に対する利用者承認。
2. **architecture正本変更承認（2026-09-20承認・反映済み）**: Slice Aで具体化したarchitecture差分を、increment計画承認とは
   別に利用者が承認した。
3. Slice FがStopの場合は作業を停止し、外部pack／非SQLiteを新しい計画として利用者判断へ戻す。Goの場合は、既に承認された
   destructive cutover範囲内としてSlice Gへ進み、同じ承認を繰り返さない。

## 対象外

- v5履歴のmigration、converter、compatibility read、dual-read/write、fallback、自動削除。
- providerへ送るmodel contextそのものの削減、provider prompt cache、Session compaction方針の変更。
- external flat-file pack、non-SQLite store、remote／shared history service。
- credential／Authorizationを含む新しいcapture。
- full network packet／TLS／HTTP framing capture、過去OS／filesystem／外部serviceの再現。
- commit、push、release、version更新、binary配置。
