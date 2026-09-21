# Increment 94 — 目的別history authorityの再設計（history v7）

ステータス: **計画承認済み・Slice A〜F Go・Human Gate 3承認待ち**

計画日: 2026-09-21

関連: Increment 40〜43（durable history）、Increment
86〜93（journal、v6、停止原因と修正）、Increment 90 （history v6）、構想
[`experience-driven-self-revision.md`](../concepts/experience-driven-self-revision.md)、architecture
[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、roadmap
[`roadmap.md`](../roadmap.md)、 通常利用メモ
[`normal-use-inbox.md`](../experience/normal-use-inbox.md)。

第三者review: 2026-09-21、独立した通常reviewと批判的review（計画の妥当性のみ）を実施し、双方とも
`Conditional Go`だった。指摘されたcutover前acceptance、`/recall`／export移行、diagnostic正方向の受入条件、自己改訂の
実装境界を本計画へ反映した。

計画承認: 2026-09-21。利用者は各sliceのGo／No-Go判断をcoordinating
ownerへ委ね、Increment完了判断は利用者が行う。

## 結論

本incrementは`history v7`として計画する。

これはv6のdigest削減やtable整理ではない。履歴を次の三目的に分け、通常実行の成立条件、保存authority、診断添付、
表示projectionの境界を破壊的に切り直す変更である。

1. **通常利用の履歴** — 人間が見た会話、tool利用、結果と、それらを説明するために必要な背景。
2. **障害診断** — provider wire、SSE frame、parser transition、Worker
   stage、SQLite内部状態など、実装障害を特定する証拠。
3. **自己改訂の経験** —
   何が良かったか、悪かったか、何を変更候補とし、何を人間が採否したかを考える材料。

SQLiteは引き続き採用候補とする。問題はSQLiteそのものではなく、v6で意味上のauthority、診断証拠、derived
document、 storage integrity機構が一つの成功条件へ寄り過ぎたことである。Slice
BのprototypeでSQLite固有の阻害が実測された場合だけ、 別storage案を利用者へ戻す。

## 利用者判断

- Henjiの根本価値は、過去の観測を人間とHenjiが後から読み、自己改訂へ利用できる追跡可能な履歴である。
- 「追跡可能性」は、実装bugを完全再現するための全物理観測を常時保存することと同義ではない。
- 通常履歴は、人間の目に入る情報だけでなく、その意味を説明するための適切な背景を持つ。
- 自己改訂に最適な情報量は先に固定できない。利用しながら、実際に役立った情報、足りなかった情報、不要だった情報を
  観測し、通常履歴と診断履歴の境界も改訂できるようにする。
- 「適切」の具現化を曖昧さとして利用者へ差し戻さず、本計画では保存規則、schema、read
  path、受入条件へ落とす。
- 開発中のためv6履歴のmigration、converter、compatibility
  read、dual-read/write、fallbackは作らない。
- 旧`history-v6.sqlite3`と`locks-v6`は自動削除しない。v7は新filenameへ切り替える。
- 構想、architecture、roadmapの意味変更は、本計画の承認とは別のHuman
  Gateで具体的diffを提示して承認を得る。
- commit、push、release、binary配置、既存DB削除は本計画の対象外とする。

## 事象と構造上の原因

### 1. 診断証拠が通常実行を止め得る

v6の`IsolatedV6HistoryPipeline.#matchRequestStart`はprovider request startとexact
captureの対応を必須にする。 Increment 92で補助requestのexact
captureが欠落した際は、semanticなrequest自体は実行可能だったにもかかわらず、history append
failureがWorker terminateへ伝播し、tool／turn結果を利用者へ返せなかった。

これは「通常履歴を保存できなければcanonical adoptionしない」という必要な境界と、「exact
transport診断を完全保存 できなければ実行を失敗させる」という不要な境界が同じfailure
pathに置かれたためである。

### 2. 人間が必要なnon-canonical内容が失われ得る

v6 production storeのbounded event payloadはcommit proposal
transcriptを空配列へ置換する。通常利用メモB5で観測した rejected
turnでは、5分41秒を費やした結果であるにもかかわらず、人間が後から提案内容とvalidator理由を十分に読めなかった。
診断用の大量観測を持ちながら通常履歴として重要な意味内容を失う、目的の逆転がある。

### 3. 同じ意味が複数の形でauthorityに近い扱いを受ける

semantic record、provider evidence document、context manifest、artifact、human history/search
documentが、元fact、表示用文書、
readback用copyの境界を明示しないまま併存する。documentだけが持つfieldがあるため単純に削除できず、保存・settlement・
readbackで同じexecutionを繰り返しmaterializeする。

### 4. integrity機構が通常pathへ入り過ぎる

v6はexact object、byte stream、segment、record anchor、ordered
rootへ複数段のdigestを持つ。個々には説明可能でも、通常turn、 settlement、document
capture、readback、auditの責務が分かれず、同じbytesのhash／decodeや同じexecution
eventのreadが重なる。
digestの個数ではなく、「どの問いに答えるための検証か」と「通常pathで同期必須か」が不明確なのが根因である。

### 5. v6の複雑さの全てが診断由来ではない

atomic canonical adoption、crash後のdurable
prefix、attribution、Session長に依存しないappend、圧縮、index、projectionにも固有の
複雑さがある。したがって「診断を分ければv6機構を一括削除できる」とは扱わず、各機構を回答すべき問いへ対応付け、説明できる
ものだけをv7へ残す。

## Henjiが履歴から答える問い

### 通常利用

- 人間とAgentは何を伝え、何を見たか。
- どのtool／subagent／providerを、どの入力で使い、どの意味結果またはeffectを得たか。
- executionは成功、失敗、cancel、rejectのどれで、結果はSessionへ採用されたか。
- その判断時にAgentへ渡された会話、Definition、instruction、skill、tool、modelのrevisionと順序は何か。
- 表示された事象の直接原因を辿ると、どの人間入力、Agent入力、外部意味結果、Host判断、または未観測境界へ到達するか。

### 障害診断

- 実際に送受信したtransport bytes、frame、parser transition、Worker stage、persistence stageは何か。
- semantic occurrenceと物理観測のどこで欠落、不一致、遅延、破損が起きたか。

この問いは通常履歴の必須成立条件ではない。診断captureを要求したexecutionについてのみ、得られた範囲を添付する。

### 自己改訂

- どの過去のexperienceを、どのrevision候補の根拠として参照したか。
- 候補は何を改善しようとし、どの観測を良い／悪い／不足／無関係と評価したか。
- 人間は何を採用、拒否、保留し、その理由または判断をどの粒度で残したか。
- 改訂後の利用で何が変化し、以前の判断を維持または見直す材料になったか。

自己改訂用の固定capture
whitelistは作らない。将来の自己改訂loopでは、改訂時に**実際に使った情報、必要だが無かった情報、
読んだが使わなかった情報**を新しいfactとして記録し、後続revisionでcapture
profileを変更できるようにする。本incrementは そのloop自体を実装せず、既存history
factを安定して参照でき、capture profile変更後も参照先を失わない境界までを作る。

## 「適切な背景」の操作的定義

通常履歴は、表示eventから直接原因を辿り、次のいずれかへ達するまでの**最小説明閉包**を持つ。

- 人間の入力または明示判断。
- Agentへ実際に渡したcontent、またはそのimmutable revision参照。
- tool／subagent／providerから得た意味上の結果。
- Hostのadmission、outcome、canonical adoption、cancel等の決定。
- 取得していない、または観測不能だったことを示す明示的な境界。

function名、chunk、SSE frame、parser内部遷移、Worker stage、SQLite
page／segment位置は、上の説明に不可欠な意味factではなく 原則として診断情報とする。逆に、非canonical
transcript、toolの意味結果、reject理由、採用されなかった提案は、人間の画面から
消えても通常履歴に残す。

## v7 authority model

### A. Semantic authority

一つの意味factを一つのoccurrenceとして保存する。execution全体を巨大なdocumentへ再materializeしてauthorityにしない。

- Session、canonical message、turn、execution admission／lifecycle／outcome／adoption。
- user／assistantのsemantic
  message。canonical、intermediate、rejected、failed、cancelledを区別する。
- tool／subagentのcall、result、effectと、利用者へ意味のあるfailure reason。
- model requestごとに、Agentへ見せたsemantic context itemの順序とimmutable content／revision参照。
- provider／modelから得たsemantic result。transport serializationとは分ける。
- 選択、load、projectionされたAgent Definition、instruction、skill、tool
  definition、model、buildのrevision参照。
- 直接のcause／source
  relation。execution、request等のscopeで一度持てるattributionを各recordへ反復しない。
- settled non-canonical executionを次taskへ一回だけ投影する`/recall`のsource／target
  relation。sourceをcanonical化せず、 recall先のmodel-visible
  contextから元executionへ辿れるようにする。

factのownerはexecution documentではなく、claim／commit境界で決める。Session
stateはHost、model-visible contextはrequest、 tool resultはtool occurrence、canonical adoptionはHost
transactionをownerとする。

### B. Diagnostic attachment

診断はsemantic authorityへlinkする任意の添付として保存する。

- exact outbound／inbound bytes、response header等のtransport metadata。
- chunk／SSE frame、parser transition、Worker／Host protocol stage、persistence stage。
- attachmentは`not_requested`、`captured`、`partial`、`invalid`のcoverageを持つ。
- capture profile revisionをexecution
  admission時に固定する。初期profileは`normal-v1`と`diagnostic-v1`とする。
- `normal-v1`はsemantic authorityを保存し、exact transportや内部stageを要求しない。
- `diagnostic-v1`は現行v6相当の原因特定証拠を、取得できた範囲で添付する。
- diagnostic attachmentの欠落、不一致、保存失敗だけを理由にsemantic executionやcanonical
  adoptionを失敗させない。
- semantic authority自体の永続化失敗は従来どおりcanonical adoptionを禁止し、明示したnon-canonical
  outcomeへする。
- 本incrementでは自動TTL、削除、sanitizationを導入しない。credential値とAuthorizationだけは現行どおり記録しない。

### C. Derived projection

human history、search、provider evidence document、context
manifest、artifact表示、exportはauthorityではなくversioned projection
とする。各projectionは`kind`、`version`、source watermark／root、生成状態、stale理由を持つ。

- list／page／searchはauthority payloadを走査せず、entry単位の小さなread modelを使う。
- detailはentry locatorから必要なsemantic factだけをmaterializeする。
- projection update失敗はsemantic commitを取り消さない。同transactionでdurable outbox／dirty
  markerだけを追加し、commit後 またはrestart後にbounded、idempotentに生成する。
- projectionが未生成／staleなら状態を表示し、通常readの裏で全authority scanへfallbackしない。
- 現行documentにしか存在しないfieldは、field-owner matrixでsemantic authorityまたはdiagnostic
  attachmentへ移してから documentをprojection化する。

### D. Self-revision compatibility boundary

本incrementは自己改訂experienceのdomain modelやproduct
flowを実装しない。将来F19〜F24が通常履歴を全量複製せず利用できるよう、
次の互換境界だけをv7で保証する。

- semantic occurrence、history
  entry、execution、query／rangeを、後続schemaから安定して参照できるidentityを持つ。
- 各executionのcapture profile revisionとcoverageを保持し、profile変更前後の履歴を区別できる。
- 新しいexperience fact kindとrelationを、既存history factのidentityや意味を変更せず追加できる。
- projectionや診断attachmentが削除・再生成されても、semantic authorityへの参照は維持される。

experience selection、useful／harmful／missing／unused assessment、revision proposal、human
judgment、follow-up observationの語彙、 append owner、UI／Agent read
pathはF19〜F24側で利用しながら定める。本incrementはそれらを保存・readbackできると主張しない。

## v7 storage・integrity方針

### 保存機構

- production filenameは`history-v7.sqlite3`、lock namespaceは`locks-v7`、schema versionは7とする。
- SQL table名はSlice Bでfield-owner matrixとaccess
  patternを固定した後に決める。先に現行tableを一対一移植しない。
- semantic occurrenceはappend主体のnormalized row／bounded
  payloadとし、execution全体の累積BLOBを更新しない。
- immutable contentはcontent
  tableへ一度保存し、occurrenceから参照する。別の発生事実はbytesが同じでも別occurrenceである。
- contextはrequestごとのordered item referenceとして保存する。provider wire bodyをmodel-visible
  context authorityにしない。
- projectionはentry単位で追加・対象更新し、Session／execution全体のdocumentを書き直さない。

### digestを置く条件

各digestは次の問いの一つに答える場合だけ持つ。

1. immutable contentを同定・共有するcontent digest。
2. 保存したcompressed／encoded representationの破損を区別するrepresentation digest。
3. `diagnostic-v1`でexact byte streamが同一であることを確認するstream digest。

単なるrow、locator、projection、同一transaction内の順序に習慣的なdigestを付けない。execution
settlementのためだけに全recordを 再hashするordered rootはtargetから外し、SQLite
transaction、execution内unique ordinal、terminal marker、mandatory reference counter、Session base
revision fenceで成立させる。Slice Bでcrash prefixとcorruption
reportingを満たせない証拠が出た場合だけ、 対象を限定したincremental rootを再提案する。

### 通常pathと明示audit

- appendは新しいsemantic
  deltaと必要なindex／outboxだけを処理し、過去payloadをscan、decode、rehash、rewriteしない。
- settlementはexecution metadata、terminal、mandatory unresolved reference、base
  revisionだけを確認する。
- detail readは返すpayloadとそのimmutable contentだけを検証する。
- full integrity、全diagnostic stream検証、projection
  rebuild、backup、VACUUMは明示operationとし、通常turnへ混ぜない。
- append一回で同じpayloadのserialize／hash／compressを反復せず、operation内で結果を再利用する。

## 処理量契約

同じ量の新規semantic factとdiagnostic
captureを追加する限り、Sessionが長くなってもhistory処理量を増やさない。

通常pathは次に比例させる。

- 新規semantic payload bytesとoccurrence／relation数。
- 新規immutable content lookup／insertの`log N`。
- 当該requestのcontext item参照数。
- 当該turnで生成するprojection entry数。
- 選択profileで新たに取得したdiagnostic bytes／event数。

既存Session payload bytes、過去turn数、過去request数、当該executionの過去tool
event数を乗数にしない。特にsettlementで同一 execution eventをcontext、effects、history
documentのために複数回readしない。

計測counterはWorker validation、semantic append、settlement、projection drain、diagnostic
captureを別々に持ち、serialize、hash、 compress、decode、authority
read／rewriteのbytesとcall数を実処理箇所で数える。core appendだけを計測してfacade処理を除外しない。

## 対象範囲

- 三目的と最小説明閉包に基づくfield-owner matrix。
- v7 logical schema、SQLite physical schema、semantic write／settlement／adoption。
- `normal-v1`／`diagnostic-v1` capture profileとcoverage。
- human history page／search／detail、provider evidence、context manifest、artifactのprojection化。
- `/recall`、durable history export、v7 readback、explicit diagnostic detail／audit、projection
  recovery。
- 将来の自己改訂factが既存semantic authorityを安定参照できるidentity／relation拡張境界。
- productionの破壊的v7 cutoverとv6 module graphの除去。
- end-to-end処理量と容量の計測。

## 対象外

- v6 data migration、converter、dual-read/write、compatibility fallback。
- 旧DBの削除。
- F19〜F24のexperience selection／assessment／human
  judgment、自己改訂Agent、候補生成、評価、自動適用のproduct flow。
- retention／TTL／自動削除、一般的なprivacy hardening。
- SQLiteでGo条件を満たす前の外部pack／別DB実装。
- commit、push、release、binary配置。

## 未確認事項

- 現行captured documentだけが所有するfieldの全一覧と、その新owner。
- normal profileでprovider semantic resultをどのadapter boundaryから取得するのが最小か。
- ordered rootを廃止した場合のcrash後prefix判定と局所的corruption reportingの具体形。
- projection outboxを同DBに置いた場合のwrite amplificationとforeground latency。
- capture profile選択を既存CLI／configのどの入口に露出するか。初期案はexecution admission時のHost
  optionで、defaultは `normal-v1`、明示指定時だけ`diagnostic-v1`とする。
- v7実測でSQLite page／WAL／checkpointが通常利用を支配するか。

これらは仮想variantを仕様化せず、Slice A／Bのcurrent source inventoryとprototypeで確定する。

## 実装計画

各sliceは前sliceのexit条件を満たしてから進む。Go／No-Goは証拠に基づきcoordinating
ownerが判断するが、明記したHuman Gate では停止する。本計画は2026-09-21に承認済みであり、各Human
Gateに指定した追加判断だけ利用者へ戻す。

### Slice A — authority inventoryと正本変更案（read-only設計）

1. v6のevent、table、document field、read／settlement pathを、semantic authority、diagnostic
   attachment、derived projection、 storage mechanismへ一項目ずつ分類する。
2. 各fieldについて「Henjiが答える問い」「唯一のowner」「必要なrelation」「通常profileでの保存有無」を持つfield-owner
   matrixを作る。documentだけが所有するfieldと、同じ内容の重複ownerを明示する。
3. digest、hash、encode、compress、decode、execution materializationのcall
   siteを一覧化し、残す理由、移動先、削除候補を 対応する問いへ結ぶ。
4. 構想へ三目的と進化可能な境界、architectureへv7 authority／capture
   profile／projection、roadmapへF04／F05／F19〜F24の
   変更が必要かを、具体的diff案として本incrementへ記録する。
5. concept、architecture、roadmapは変更せずHuman Gate 1で停止する。

Exit:

- current
  v6の全fieldとdigestが分類され、説明不能なowner／verificationは削除候補として特定されている。
- 通常履歴だけで最小説明閉包を構成でき、診断attachmentなしでも正常turnをreadbackできるlogical
  exampleがある。
- 正本文書の意味変更が具体的diffとして提示されている。

No-Go:

- 通常履歴と診断の分離により、人間が見たsemantic content、outcome、canonical adoption、model-visible
  contextを失う場合。
- ownerを決められず同じclaimを複数documentへauthorityとして残す必要がある場合。

### Human Gate 1 — product正本

利用者が構想、architecture、roadmapの変更対象と意味を確認し、個別に承認した場合だけ正本へ反映してSlice
Bへ進む。 承認されない文書は変更せず、v7計画をその方針へ修正する。

### Slice B — pure logical modelとSQLite prototype（production無変更）

1. field-owner matrixからsemantic occurrence、relation、immutable content、capture
   profile、diagnostic attachment、projection outboxのpure型とcodecを作る。将来のself-revision
   fact用には、既存factを安定参照できるidentityとrelation拡張だけを定義する。
2. terminal／ordinal／mandatory reference／base revisionだけでcrash prefix、settlement、canonical
   adoptionを成立させるprototypeを 作り、ordered rootなしで満たせるか確認する。
3. content／representation／stream
   digestを一回ずつ計算し、対象外のrow／projectionへdigestを持たせないprototypeを作る。
4. entry単位projectionとdurable outboxを実装前比較し、semantic commit、projection failure、restart
   drain、stale readを確認する。
5. short／long Sessionへ同じdeltaを追加し、処理counterが既存payload量で増えないschemaとquery
   planを選ぶ。
6. prototype結果からSQL schema、index、transaction boundary、capture profile selectorを凍結する。

Exit:

- semantic executionはdiagnostic attachment 0件でもsettle／adopt／readbackできる。
- non-canonical transcriptとreject／failure reasonをsemantic authorityから読める。
- crash後に最後のcommitted semantic prefixをpayload scanなしで判定できる。
- projection failureがsemantic authorityを失敗させず、restart後にboundedに回復できる。
- 同じdeltaのcounterはSession長で不変、DB lookupだけが`log N`範囲である。

Stop:

- ordered
  rootなしでは必要なatomicity／prefixを満たせない場合、rootの対象と必要性を限定して再計画する。
- SQLiteのpage／WAL／query挙動がこの段階で処理量契約を破る場合、production実装へ進まずstorage案を利用者へ戻す。

### Slice C — isolated v7 semantic store（productionから未到達）

1. `history-v7.sqlite3` schemaをisolated storeとして実装する。v6
   import、migration、fallbackを持たせない。
2. Session、execution、semantic occurrence、relation、content、context order、resource
   attribution、terminal、canonical adoptionを 実装する。
3. semantic append、non-canonical settlement、canonical adoption、restart
   reconciliationをtransaction境界ごとに実装する。
4. crash injectionでpartial occurrence、dangling mandatory reference、terminal後append、base
   revision raceがcomplete／canonicalに 見えないことを確認する。
5. normal history page／detailに必要なsource
   locatorまでを実装し、diagnostic／projectionはまだ接続しない。

Exit:

- success、failure、cancel、reject、intermediate tool loopをsemantic
  authorityだけで保存・説明できる。
- semantic persistence failureはcanonical adoptionを防ぎ、diagnostic欠落という概念に依存しない。
- production runtimeとv6 DBは不変。

### Slice D — diagnostic profileとderived projection（isolated）

1. `normal-v1`／`diagnostic-v1`をexecution admissionへ接続し、exact transport、frame、parser／Worker
   stageをattachmentとして semantic occurrenceへlinkする。
2. captureの`not_requested`／`captured`／`partial`／`invalid`をreadbackし、欠落／mismatchをdiagnostic
   statusとして扱う。
3. human page／search／detail、provider evidence、context manifest、artifactをversioned
   projectionへ置き換える。
4. outbox enqueue、bounded drain、idempotent retry、stale表示、explicit rebuildを実装する。
5. normal profileとdiagnostic
   profileの保存量・hash・latencyを別計測し、通常利用へ診断costが混入しないことを確認する。

Exit:

- Increment 92型のexact capture欠落／mismatchでもsemantic
  executionは完了し、診断coverageだけがpartial／invalidになる。
- `diagnostic-v1`で代表executionを一つcaptureし、要求したtransport、frame、parser
  transition、Worker／persistence stageを semantic
  occurrenceへ相関してreadbackできる。意図的な欠落／不一致はdetailから発生境界を特定できる。
- rejected proposalのtranscriptと理由、cancel前のtool結果をnormal historyから読める。
- projectionを意図的に失敗させてもsemantic authorityはcommitされ、read
  UIはstaleを示して後から回復する。
- documentにsole-owner fieldが残らない。

### Slice E — production facade接続とcutover前回帰

1. v7 production
   facadeと`HistoryPersistencePort`をsemantic、diagnostic、projection責務へ分けて接続する。
2. provider／Worker／Hostから、semantic factを最短経路で一回だけv7へ渡す。v6 `historyEvent`
   documentを中間authorityとして 経由しない。
3. human history、search、detail、session resume、canonical transcript、CLI readback、durable
   history exportをv7 isolated production pathへ接続する。
4. `/recall`をv7 semantic authorityへ接続し、settled non-canonical
   sourceをcanonical化せず次taskへ一回だけ投影し、 source／target attributionを保持する。
5. v6で同じexecution eventを複数回読むsettlement／index／capture pathをv7 module
   graphへ持ち込まない。
6. production selectorはまだv6のままとし、v7 pathを明示したtest／isolated XDGからだけ到達させる。

Exit:

- canonical turn、non-canonical failure／cancel／reject、tool
  loop、resume、exportをv7だけでproduction facadeから完了できる。
- `/recall`はv7のnon-canonical sourceを次taskへ一回だけ投影し、source／target
  attributionをreadbackできる。
- history page／searchはauthority payload decode 0、detailは対象factだけを読む。
- settlementで当該executionの過去event再走査が0。
- credential／Authorization以外の観測証拠を意図せず捨てていない。

### Human Gate 2 — 実provider利用（必要時のみ）

Slice Fのcutover前acceptanceで実providerが必要な場合は、credentialを表示せずisolated
XDGで実行する対象、回数、保存先を 提示して利用者の明示許可を得る。許可前はfake
providerによるproduction facade確認までに留める。このgateはproduction cutoverの後へ送らない。

### Slice F — scale・capacity・isolated product acceptance（cutover前）

1. production selectorをv6のまま、v7 pathへ明示的に到達するisolated XDGで、short、long、100M
   cumulative token相当の 反復app-development workloadへ同じsemantic deltaを追加し、全end-to-end
   counter、DB＋WAL＋SHM、projection backlog、 latencyを計測する。
2. tool／SSE
   eventが多い単一executionで、appendは新eventだけ、settlementはmetadataだけを処理することを確認する。
3. normal／diagnostic profileを同一semantic
   workloadで比較し、診断詳細の容量と待ち時間を通常履歴から分離して報告する。
4. `diagnostic-v1`の代表executionでtransport、frame、parser transition、Worker／persistence
   stageを取得し、semantic occurrenceとの
   相関と、意図的な欠落／不一致の発生境界をdetailから特定できることを確認する。
5. isolated XDGの実product経路で、normal history page／search／detail、non-canonical
   result、cancel、restart、resume、 durable
   export、`/recall`を人間が利用可能な形で確認する。必要な実provider確認はHuman Gate
   2の承認範囲で実行する。
6. increment文書へ実測値、未確認範囲、Slice A〜FのGo／No-Goを反映し、Human Gate 3の判断材料にする。

Go条件:

- 同じsemantic deltaを追加したとき、既存Session payloadのread／decode／hash／rewriteが0。
- 同じexecutionへ同量のtool／provider eventを追加したとき、過去eventの再走査が0。
- normal profileでsemantic historyに必要な情報が読め、diagnostic bytes／event処理が0。
- diagnostic profileのcostが新規diagnostic bytes／eventに線形で、semantic
  settlementの成立条件にならない。
- diagnostic profileで要求した証拠をsemantic
  occurrenceへ相関してreadbackでき、欠落／不一致の発生境界を特定できる。
- projection backlogを次turnへ全量同期処理せず、状態を明示してboundedに追いつける。
- 通常履歴から人間が会話、tool利用、結果、failure／reject理由、outcome、adoption、model-visible背景を辿れる。
- durable exportがv7 authorityから生成され、`/recall`がnon-canonical
  sourceをcanonical化せず次taskへ一回だけ投影する。

Stop条件:

- semantic historyを成立させるためにexact
  transport／parser内部状態を常時必須にする必要が判明した場合。
- normal historyが人間の見たsemantic contentや直接原因を失う場合。
- SQLite固有のpage／WAL／checkpoint／projection挙動が通常利用の待ち時間を支配する場合。
- Session長またはexecution既存event数が新規delta処理量の乗数になる場合。

Stop時は自動的にv6へfallback、外部packへ移行、証拠を削減せず、実測と選択肢を利用者へ戻す。

### Human Gate 3 — production破壊的cutover

Slice
A〜Fのschema、処理counter、scale／capacity、診断可能性、実product動作、失敗時挙動、正本反映結果を提示する。
利用者がcutoverを承認した場合だけSlice Gへ進む。承認前はproduction v6
selector、通常XDG、配置済みbinaryを変更しない。

### Slice G — productionの破壊的v7 cutoverとsmoke確認

1. production historyを`history-v7.sqlite3`／`locks-v7`へ一括切替する。
2. v6 migration、dual-read/write、fallbackを追加せず、production module graphからv6
   store／pipelineを外す。
3. 旧v6 DBとlock directoryは削除・変更しない。
4. focused testでsemantic durability、diagnostic non-gating／readback、projection
   recovery、canonical adoption、`/recall`、exportを 確認する。
5. stable candidateでrepository定義のcheck／format／lint／`git diff --check`とauthoritative
   `v0:gate`を一回実行する。
6. 新selectorのisolated XDGで短いsmokeを行い、新規Session／executionのwrite、restart、history
   read、resumeを確認する。
7. increment文書へcutover結果と確認済み範囲を記録する。

Exit:

- productionの新規Session／executionがv7だけへwriteされ、restart後もread／resumeできる。
- v6へ新しいwrite、read fallback、migrationがない。
- normal profileで診断capture欠落を理由とするuser-visible failureがない。
- `/recall`とdurable exportを含む既存history surfaceがv7から動作する。
- unrelated working tree差分と旧DBを変更していない。

## product動作と検証の対応

| product動作                                     | 確認方法                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 通常turnを後から意味内容と直接原因まで読める    | canonical turnを保存し、page→detail→context／resource refをreadbackする                  |
| reject／failure／cancelも自己改訂材料として残る | non-canonical transcript、tool結果、reason、outcomeをreadbackする                        |
| 診断欠落が通常実行を止めない                    | exact captureなし／mismatchを注入し、semantic settlementとcoverage statusを確認する      |
| 要求した診断証拠で障害境界を特定できる          | diagnostic-v1でtransportからpersistenceまでを相関し、欠落／不一致の境界をdetailから読む  |
| semantic履歴欠落はcanonical化しない             | semantic append failureを注入し、adoption禁止と明示outcomeを確認する                     |
| projectionはauthorityではない                   | projection failure／削除後もsemantic authorityを保持し、stale→rebuildを確認する          |
| 長期Sessionで処理量が増えない                   | 同一deltaを異なるSession長へ追加し、end-to-end counterとquery planを比較する             |
| tool eventが多くてもsettlementが再走査しない    | event数を変え、settlement counterがmetadata定数範囲であることを確認する                  |
| non-canonical経験を次taskで利用できる           | `/recall`の一回限りの投影とsource／target attribution、sourceの非canonical状態を確認する |
| 既存historyを外部で利用できる                   | durable exportをv7 authorityから生成し、内容とattributionをreadbackする                  |
| 将来の自己改訂が既存factを参照できる            | capture profileを変更しても既存semantic identity／relationが不変であることを確認する     |

test件数は完了条件にしない。各testは上表のproduct動作または確認済みregressionへ対応させる。

## 完了条件

- v7が通常履歴と障害診断を別責務として実装し、semantic authorityの唯一ownerがfield-owner
  matrixと一致する。
- 将来の自己改訂loopが既存semantic factを安定参照し、新しいexperience
  fact／relationを追加できる境界を持つ。
- 通常履歴が最小説明閉包を満たし、canonical／non-canonical双方の人間に意味のある内容を保持する。
- 診断attachmentの完全性が通常execution／canonical adoptionをgateしない。
- `diagnostic-v1`で要求したtransport、frame、parser、Worker／persistence証拠を相関してreadbackし、障害境界を特定できる。
- semantic persistence failureだけはcanonical adoptionを禁止する。
- projectionは再生成可能で、sole-owner fieldを持たず、失敗時もsemantic authorityを失わない。
- digestと検証箇所が三つの明示目的へ対応し、説明不能な照合がproduction pathに残らない。
- 同じ新規deltaに対するend-to-end history処理量がSession長／過去event数で増えない。
- `/recall`とdurable history exportを含む既存history surfaceがv7 authorityから動作する。
- v7 production cutover後、v6 migration、dual path、fallbackがなく、旧DBは保持される。
- repository定義のverificationと実product確認結果を本incrementへ記録する。
- Increment完了の最終判断は利用者が行う。

## Human Gates

- **初期計画承認（完了）** — 本文の目的、authority model、対象範囲、slice、破壊的v7方針は承認済み。
- **Human Gate 1: 正本文書変更（完了）** — 利用者承認後、構想、architecture、roadmapへ
  Slice Aの意味変更を反映した。
- **Human Gate 2: 実provider利用（未発動）** — provider contract自体を変更しておらず、actual Workerの
  provider-free経路とprovider-shaped diagnostic eventでcutover前条件を確認できたため、実provider callは
  必要と判断しなかった。実providerでのv7 diagnostic captureは未確認である。
- **Human Gate 3: production cutover（完了）** — Slice A〜Fのscale、診断、実product証拠を確認し、
  利用者がv7へのproduction切替を承認した。
- **Human Gate 4: Increment完了（現在地）** — 実装・検証・配置後、利用者が完了を判断する。

Slice A〜GをGoとし、production selectorをv7へ切り替えた。Increment完了判断はHuman Gate 4に残す。

## Slice A実施結果（2026-09-21）

### 確認範囲

次をread-onlyで照合した。

- `sqlite_history_v6_store.ts`のschema 6、append、settlement、adoption、read、audit。
- `sqlite_history_v6_production_store.ts`のSession／execution facade、captured document、human
  history、export、adapter。
- `v6_history_pipeline.ts`のprovider、context、runtime／tool eventからlogical recordへの変換。
- `history_store_contract.ts`のevent taxonomyとproduction persistence port。
- exact byte、logical record、segment、persistent sequenceのcodec／digest実装。
- 構想、architecture、roadmap F04／F05／F19／F26。

production code、v6 DB、構想、architecture、roadmapは変更していない。

### v6 eventの意味分類

`StoredExecutionEvent`のenvelope全体を一つのauthorityとしてv7へ移さず、payload内のclaimを次のownerへ分ける。

| v6 event family            | v6 kind／内容                                                                                                                                          | v7の唯一ownerと扱い                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution admission        | `execution_admitted`のtask、Session、turn、execution identity                                                                                          | Host semantic authority。task inputとadmissionを一度だけ保存する                                                                                                                |
| dispatch／ack protocol     | `turn_dispatch_requested`、`turn_dispatch_sent`、`turn_dispatch_failed`、`acknowledgement_requested`、`acknowledgement_sent`、`acknowledgement_failed` | task内容はadmission ownerを参照する。requested／sent／failed envelopeとack transportはdiagnostic attachment。利用者へ返す最終failure／commit結果だけHost semantic outcomeへ置く |
| user control               | `steer_requested`、`steer_sent`、`steer_failed`、`cancel_requested`、`cancel_sent`、`cancel_failed`、`cancel_received`、`cancel_escalated`             | 人間のsteer／cancel入力と最終cancel outcomeはsemantic authority。送達stage、received、escalationの内部時系列はdiagnostic attachment                                             |
| Worker内部stage            | `worker_stage_snapshot`                                                                                                                                | diagnostic attachment。normal profileでは取得しない                                                                                                                             |
| runtime result             | `runtime_event`内のassistant output、commit proposal、turn failure、worker error、tool call／result                                                    | assistant／tool／proposal transcriptと人間に意味のあるreasonはsemantic authority。protocol envelope、stack、内部stageはdiagnostic attachmentへ分割する                          |
| tool effect                | `effect_observation`                                                                                                                                   | call、requested／progress／completed、result outcome、effect unknownはsemantic authority。transport stageだけdiagnostic attachment                                              |
| provider request           | `provider_request_start`                                                                                                                               | request identity、model、semantic context relationはrequest semantic authority。serializer、endpoint、exact body correlationはdiagnostic attachment                             |
| provider transport／parser | `provider_response_start`、`provider_response_bytes`、`provider_sse_event`、`provider_parser_transition`                                               | diagnostic attachment。Agentが受け取ったsemantic model resultはruntime result ownerへ置き、raw transportを通常履歴の代用にしない                                                |
| model-visible context      | `context_observation`のrequest ordinal、lane、purpose、ordered occurrence、content／resource ref                                                       | request semantic authority。delta encoding、persistent sequence node、byte rangeはstorage mechanismまたはdiagnostic attachment                                                  |
| terminal decision          | `execution_settled`、`execution_reconciled`                                                                                                            | Host semantic authority。outcome、adoption、terminal時刻、reconciliation理由を所有する                                                                                          |

この分類では、現在`historyEvent` envelopeに埋め込まれているdirection、source、worker
sequence、observed timeのうち、 意味上必要な時刻とsourceだけをsemantic
occurrenceへ残す。protocol順序やWorker sequenceはdiagnostic profileのscopeで保持する。

### v6 schema field-owner matrix

現行22 tableの全column
groupを分類した。`維持`はcolumn名の維持ではなく、その意味をv7のownerへ残すことを表す。

| v6 table                  | current field group                                                                                                                                                                                              | v7分類／唯一owner                                                     | v7 action                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store_metadata`          | `singleton`, `schema_version`, `created_at`                                                                                                                                                                      | storage mechanism                                                     | schema 7 metadataとして維持。履歴factにはしない                                                                                                                            |
| `sessions`                | `session_id`, `state_revision`, `canonical_execution_id`, `workspace_root`, `updated_at`, `agent`, `created_at_session`, `title`, `next_turn`, `definition_json`, `active_model_json`                            | Host semantic／canonical state                                        | Session ownerへ維持し、Definition／modelはimmutable revision refへ正規化する                                                                                               |
| `sessions`                | `record_bytes`, `checkpoint_bytes`                                                                                                                                                                               | legacy materialized copy                                              | v7へ移植しない。必要なcheckpointは別のsemantic fact／projection ownerを決めてから追加する                                                                                  |
| `sessions`                | `message_count`, `model_change_count`, `turn_count`                                                                                                                                                              | storage fence／index metadata                                         | transaction内の増分counterとして維持可能。自己改訂factにはしない                                                                                                           |
| `session_model_changes`   | `session_id`, `change_ordinal`, `effective_from_turn`, `changed_at`, `selection_json`                                                                                                                            | Session semantic attribution                                          | model selection change occurrenceとして維持する                                                                                                                            |
| `session_turns`           | `session_id`, `turn_ordinal`, `turn`, `execution_id`                                                                                                                                                             | Host canonical adoption                                               | `canonical_turns`と重複しない一つのturn/adoption ownerへ統合する                                                                                                           |
| `session_turns`           | `model_json`, `build_json`, `definition_json`                                                                                                                                                                    | execution／turn attribution                                           | immutable revision refsとしてturnまたはexecution scopeに一度保存する                                                                                                       |
| `session_messages`        | `session_id`, `message_ordinal`, `turn`, `encoded_bytes`                                                                                                                                                         | canonical message semantic authority                                  | message occurrenceとimmutable contentへ分けて維持する                                                                                                                      |
| `session_messages`        | `logical_digest`, `representation_digest`                                                                                                                                                                        | content identity／storage integrity                                   | content digestはimmutable content側へ一度だけ置く。representation digestは圧縮表現を保存する場合だけcontent storageへ置き、message occurrenceへ反復しない                  |
| `executions`              | `execution_id`, `session_id`, `history_session_id`, `turn_number`, `lifecycle`, `outcome`, `adoption`, `base_session_revision`, `generation`, `created_at`, `settled_at`                                         | Host semantic authority                                               | admission、lifecycle、outcome、adoption、revision fenceへ分けて維持する                                                                                                    |
| `executions`              | `metadata_json`                                                                                                                                                                                                  | task／Agent／model／build／Definition等が混在するsemantic attribution | Slice Bでtyped field／refへ分解し、opaque authority documentにしない                                                                                                       |
| `executions`              | `outcome_json`                                                                                                                                                                                                   | semantic execution result                                             | normalized outcomeとnon-canonical message／reason ownerへ分けて維持する                                                                                                    |
| `executions`              | `latest_ordinal`, `record_count`, `terminal_record_id`, `unresolved_reference_count`, `base_message_count`                                                                                                       | storage fence／incremental completeness                               | payload scanなしのsettlementに必要なmetadataとして維持する。semantic contentには数えない                                                                                   |
| `executions`              | `ordered_root`                                                                                                                                                                                                   | storage integrity                                                     | v7 targetから除外。Slice Bでordinal／terminal／mandatory reference／transactionだけでは不足すると実証された場合だけ限定rootを再提案する                                    |
| `executions`              | `evidence_id`, `diagnostic_id`, `artifact_id`                                                                                                                                                                    | diagnostic／projection locator                                        | semantic execution rowから意味fieldを移した後、typed attachment／projection relationへ分離する                                                                             |
| `execution_messages`      | `execution_id`, `message_ordinal`, `turn`, `encoded_bytes`                                                                                                                                                       | non-canonical message semantic authority                              | rejected／failed／cancelled executionのmessage occurrenceとimmutable contentとして維持する                                                                                 |
| `execution_messages`      | `logical_digest`, `representation_digest`                                                                                                                                                                        | content identity／storage integrity                                   | `session_messages`と同じくcontent ownerへ一度だけ置く                                                                                                                      |
| `exact_objects`           | `logical_digest`, `byte_length`, `encoded_bytes`                                                                                                                                                                 | immutable semantic contentまたはdiagnostic exact object               | normal contentとdiagnostic objectをrole別に参照し、同じimmutable bytesは一度保存する                                                                                       |
| `exact_objects`           | `representation_codec`, `representation_digest`, `encoded_length`                                                                                                                                                | storage integrity                                                     | compressed representationを持つobjectだけに維持する                                                                                                                        |
| `byte_streams`            | `stream_id`, `execution_id`, `capture_boundary`, `serializer_version`, `content_encoding`, `byte_length`, `whole_digest`                                                                                         | diagnostic attachment                                                 | `diagnostic-v1`だけでexact stream ownerとして維持する                                                                                                                      |
| `byte_streams`            | `manifest_digest`, `manifest_bytes`                                                                                                                                                                              | diagnostic storage mechanism                                          | fragmentを正規化するならmanifest copyとdigestを削除する。BLOBを残す場合もwhole stream digestと別目的を説明できるときだけ保持する                                           |
| `byte_stream_object_refs` | `stream_id`, `fragment_ordinal`, `object_digest`                                                                                                                                                                 | diagnostic attachment relation                                        | diagnostic streamのordered fragment relationとして維持する                                                                                                                 |
| `sequence_nodes`          | `digest`, `node_kind`, `item_count`, `height`, `value`, `left_digest`, `right_digest`                                                                                                                            | context orderingのstorage mechanism                                   | semantic ownerはrequestのordered context item。AVL nodeとdigestはv7へ既定移植せず、Slice Bの処理量prototypeで必要なら内部実装として採用する                                |
| `sequence_revisions`      | `execution_id`, `revision_id`, `root_digest`, `parent_root_digest`, `item_count`                                                                                                                                 | request context revision＋storage mechanismが混在                     | request identity／item orderはsemantic authorityへ移す。root／parent rootはphysical sequence実装を採る場合だけ内部metadataとして残す                                       |
| `history_segments`        | `segment_id`, `execution_id`, `first_ordinal`, `last_ordinal`, `record_count`, `kind_summary_json`, `codec`, `uncompressed_length`, `encoded_length`, `logical_digest`, `representation_digest`, `encoded_bytes` | storage mechanism                                                     | normalized occurrenceを既定targetとしv7へ移植しない。segmentを再採用する場合もsemantic identityから独立させ、logical／representation digestはsegment read／auditに限定する |
| `record_anchors`          | `record_id`, `execution_id`, `ordinal`, `authority`, `record_kind`, `observed_at`                                                                                                                                | semanticまたはdiagnostic occurrence identity                          | classification後の各occurrence ownerへ維持する                                                                                                                             |
| `record_anchors`          | `segment_id`, `segment_record_index`, `encoded_record_digest`                                                                                                                                                    | storage locator／integrity                                            | normalized v7 rowでは削除する。semantic identityにphysical locatorを含めない                                                                                               |
| `record_object_refs`      | `record_id`, `ref_ordinal`, `object_digest`                                                                                                                                                                      | semantic content relationまたはdiagnostic object relation             | owner種別を分けたtyped relationへ移し、曖昧な共通ref tableをauthorityにしない                                                                                              |
| `record_byte_ranges`      | `record_id`, `range_ordinal`, `stream_id`, `start_offset`, `end_offset`                                                                                                                                          | diagnostic attachment relation                                        | exact transportとの相関を要求したprofileだけで維持する                                                                                                                     |
| `record_causes`           | `record_id`, `cause_ordinal`, `execution_id`, `relation`, `cause_record_id`, `resolved`                                                                                                                          | direct semantic causeまたはderived relation                           | 最小説明閉包に必要で他ownerから導けないcauseだけsemantic relationとして維持する。scope／ordinalから導ける反復edgeは生成しない                                              |
| `projections`             | `execution_id`, `projection_kind`, `projection_key`, `source_through_ordinal`, `projected_text`                                                                                                                  | derived projection                                                    | version、source watermark／root、status、stale reasonを加えたentry単位read modelへ置換する                                                                                 |
| `record_search`           | `record_id`, `execution_id`, `search_text`                                                                                                                                                                       | derived projection                                                    | semantic authorityから再構築可能なversioned search indexとして維持する                                                                                                     |
| `human_history_search`    | `entry_id`, `execution_id`, `session_id`, `search_text`                                                                                                                                                          | derived projection                                                    | entry locatorとprojection version／watermarkに結び、authority payload scanへfallbackしない                                                                                 |
| `canonical_turns`         | `session_id`, `turn`, `execution_id`, `session_revision`                                                                                                                                                         | Host canonical adoption authority                                     | `session_turns`との二重ownerを解消した一つのatomic adoption ownerとして維持する                                                                                            |
| `captured_documents`      | `document_kind`, `document_id`, `execution_id`, `document_bytes`                                                                                                                                                 | kindごとにsemantic、diagnostic、projectionが混在                      | 共通document authorityを廃止し、下のkind matrixに従って移動する                                                                                                            |

### captured document field-owner matrix

| document kind              | current sole-owner／重複内容                                                                                     | v7 owner                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `context_manifest`         | final external relation、snapshot照合結果、context presentation。context observation／sequenceと一部重複         | model-visible item order、resource ref、external relationの唯一ownerをrequest semantic authorityへ移す。manifestはversioned projection                 |
| `provider_evidence`        | request metadata、raw response、SSE／parser、provider correlationを一文書へ再materializeしlogical recordとも重複 | request／semantic model resultはsemantic authority。exact request／response、SSE、parserはdiagnostic attachment。evidence documentはprojection／export |
| `diagnostic`               | failure summary、stage、関連evidence                                                                             | 人間向けfailure reasonはsemantic outcome。内部stage／raw detailはdiagnostic attachment。表示文書はprojection                                           |
| `diagnostic_evidence_link` | diagnostic IDからprovider evidence IDへのdocument link                                                           | typed diagnostic attachment relation。単独documentにはしない                                                                                           |
| `artifact`                 | Agent manifest、protocol trace、ack、outcome、effect summary、capture statusを一文書に保持                       | Agent／outcome／effectのsole-owner fieldをsemantic authorityへ、protocol／capture detailをdiagnostic attachmentへ移す。artifactはversioned projection  |

captured
documentにだけ残るfieldを先に上記ownerへ移すため、documentをprojection化しても情報を失わない。`providerEvidence`、
artifact、diagnosticの既存adapter surfaceはprojection／attachment readerとして維持できるが、document
BLOB自体を正本にしない。

### digest、codec、照合経路の棚卸し

| current mechanism                           | 現在答える問いと処理                                                                  | v7判断                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Session／execution message `logical_digest` | JSON message raw bytesが同じか。各rowで計算し、read時に再計算する                     | immutable content digestへ一度だけ集約する                                                                       |
| message `representation_digest`             | Brotli圧縮BLOBが壊れていないか。read時にencodedとrawを両方hashする                    | compressed content representationを持つ場合だけ一つ保持する。occurrenceごとには置かない                          |
| exact object logical digest                 | exact bytes identity。ingestまたはvalidated refで確立し、read時にもrawをhashする      | semantic immutable contentまたはdiagnostic exact objectに維持する。operation内で一回計算した結果を再利用する     |
| exact object representation digest          | Brotli BLOBの破損検出                                                                 | compressed objectに維持し、explicit detail／auditで検証する                                                      |
| exact stream whole digest                   | adapterが送ったordered bytesの一致                                                    | `diagnostic-v1`だけに維持する。normal settlementでは計算・検証しない                                             |
| exact stream manifest digest                | manifest JSON BLOBの一致                                                              | normalized fragmentなら削除。BLOB維持時もwhole digestと別のfailureを説明する場合だけ残す                         |
| persistent sequence node／root digest       | content-addressed AVL nodeとrequest context root                                      | semantic context orderとは分離する。Session長非依存に必要とSlice Bで実証された場合だけstorage内部へ残す          |
| segment logical／representation digest      | framed recordsとgzip BLOBの一致                                                       | normalized row targetでは削除。segment再採用時だけexplicit read／audit用に残す                                   |
| `encoded_record_digest`                     | segment内で選んだrecord bytesの一致                                                   | segmentとrecordを再hashする第三層でありv7 targetから削除する                                                     |
| execution `ordered_root`                    | seedから全encoded record identityを順序hashし、settlement／auditで照合                | settlement gateから削除する。ordinal、terminal、mandatory ref、transactionで不足する場合だけ限定rootを再提案する |
| resource／context content digest            | Definition、instruction、skill、tool contract、message等のimmutable revision identity | semantic attributionとして維持し、scopeで一度だけ参照する                                                        |
| captured document Brotli BLOB               | digestを持たずdocument単位で圧縮                                                      | authorityから外し、entry projectionまたはdiagnostic attachmentへ分割する                                         |

現行read pathでは、`readRecord`が一recordのために所属segment全体をdecompressし、segment
representation／logical digestと record digestを検証する。exact stream detailはobject
resolverでlogical digestを検証し、fragment materializationで再びobject digest、最後にwhole stream
digestを検証する。explicit auditはさらに全segment、object、stream、sequence、execution rootを
再走査する。auditでの重複検証自体は許容するが、同じ処理をnormal
settlement／projection生成へ入れない。

### write／read処理のowner重複

- `v6_history_pipeline`はsemantic payloadの中へ元の`historyEvent` envelopeを埋め、同じ発生をlogical
  occurrenceと protocol eventの二形態で保持する。
- settlement時の`#capture`はcontext manifest、provider evidence、diagnostic、artifactをBrotli
  documentとして再保存した後、 `#indexExecutionHistory`を同期実行する。
- human
  historyの`#entries`は一executionについて`#contextSummary`、`listExecutionEvents`、`#executionEffects`から同じevent列を
  複数回読む。`#contextSummary`と`#executionEffects`も内部で`listExecutionEvents`を呼ぶ。
- `#historyEvents`は各anchorごとに`readRecord`を呼び、同じsegmentに複数recordがあってもrecordごとにsegment全体をdecode／hashする。
- human detailとsearchは保存済みentry
  projectionを読むのではなく`#entries`を再materializeする。search candidateごとにも再実行する。
- logical cost counterはcore appendを中心に数え、settlement capture、human projection、Worker
  validation等のfacade処理を含まない。

v7ではsemantic append、diagnostic capture、projection outbox／drain、settlement、read
detailを別counterにし、一つのsemantic occurrenceを 一度だけdecodeする。projection作成は新しいentry
deltaだけを受け取り、settlementからexecution全体を再読しない。

### normal profileだけで成立する最小説明閉包の例

rejected tool turnを次のsemantic occurrenceで表せる。

1. 人間のtask inputとHost admission。
2. 各model requestで実際に渡したordered message／instruction／tool contractのimmutable ref。
3. assistantのtool call、tool引数、tool result／effect outcome。
4. assistantが提案したnon-canonical transcript。
5. Host validatorのreject reasonとexecution outcome `failed/non_canonical`。
6. 上記の直接source relationとAgent／model／Definition revision。

これだけで「何を依頼し、Agentは何を見て、何を行い、何を得て、何を提案し、なぜ採用されなかったか」を辿れる。
exact HTTP body、response chunk、SSE frame、parser transition、Worker
stageが0件でも通常履歴は成立する。`diagnostic-v1`を選んだ場合は request／tool／outcome
occurrenceへexact streamと内部stageを添付し、semantic factを置き換えない。

### product正本の具体的変更案

以下はHuman Gate 1で承認され、product正本へ適用した意味変更である。

#### 構想 `docs/concepts/experience-driven-self-revision.md`

`Durable history`とexperience loopの間へ、次の意味を追加する。

- 履歴の目的を、通常利用の履歴、障害診断、自己改訂の経験に分ける。
- 通常履歴は、人間が見たsemanticな出来事と、その直接原因を人間入力、Agentへ渡したcontent／revision、tool／providerの
  semantic result、Host判断、明示的unknownまで辿る最小説明閉包を持つ。
- exact
  transport、chunk、parser／Worker／storage内部stageは診断attachmentであり、通常履歴やcanonical
  adoptionの成功条件ではない。
- 自己改訂に最適な情報は固定せず、実利用で使った／不足した／使わなかった情報を後続loopが記録し、capture境界を改訂できる。
- 詳細情報の量そのものを追跡可能性または自己改訂可能性と同一視しない。

これは「historyは完全replay
snapshotではない」「何をretain／read／interpretするかも改訂対象」という現構想を具体化し、
人間だけがcandidateを採用する境界は変更しない。

#### architecture `docs/architecture/henji-host-agent-worker.md`

`Durable history`節のauthorityとstorage不変条件を次へ置換・追記する。

- authorityをsemantic authority、diagnostic attachment、derived projection、storage
  mechanismへ分け、一claim一ownerとする。
- semantic authorityにcanonical／non-canonical message、tool call／result／effect、model-visible
  context order、Host outcome／adoption、 resource revision、`/recall` source／target
  relationを置く。
- capture profile revisionと`not_requested/captured/partial/invalid` coverageをexecution
  admission時に固定する。
- diagnostic欠落／不一致はsemantic executionを失敗させず、semantic durability failureだけcanonical
  adoptionを禁止する。
- human history、search、provider evidence document、context manifest、artifact、exportはversioned
  projection／exportとし、 sole-owner fieldを持たせない。projection failureはsemantic
  commitを取り消さずoutbox／stale状態で回復する。
- normal append／settlementは既存payloadをscan／decode／rehash／rewriteしない。ordered
  rootを必須不変条件から外し、transaction、 ordinal、terminal、mandatory ref、base
  revisionを基本fenceとする。
- exact bytesとoriginal parser
  interpretationの常時保存要件を`diagnostic-v1`で保存・readback可能な契約へ変更する。
- self-revisionはv7のstable semantic identityを参照できるが、experience
  domain、assessment、candidate flowはF19〜F24で定める。

既存のcanonical/non-canonical区別、atomic adoption、effect
state、`/recall`一回限りprojection、physical locatorから独立したsemantic identityは維持する。

#### roadmap `docs/roadmap.md`

機能要件と現コード状態を分け、次を反映する。

- F04の要件へ「通常semantic historyと選択的diagnostic
  attachmentを区別し、diagnostic不完全性をcanonical adoptionのgateに
  しない」を追加する。現コード状態にはv6がexact transport／logical record／captured
  documentを一つのsettlement pathへ結合して いることと、Increment
  94でv7を実装予定であることを記す。v7 cutoverまでは`実装済み`判定を変更しない。
- F05の要件へ、通常page／search／detailはsemantic authorityのprojectionを使い、diagnostic
  detailはcapture coverageを明示することを 追加する。`/recall`とdurable
  exportをv7切替でも維持する受入契約を明記する。
- F19の現コード状態へ、Increment 94はstable semantic identityとcapture profile
  revisionまでを提供予定だが、cross-session experience、
  利用者判断・目的・理由、used／missing／unused assessmentは未実装のままであると記す。
- Phase 2の入力境界へ、通常履歴の最小説明閉包とdiagnostic attachmentを区別し、experience側はsemantic
  authorityを参照して raw診断文書を既定複製しないことを加える。

新しいF番号は追加しない。F20〜F24をIncrement 94で実装済みに変更しない。

### Slice A Go／No-Go判断

**Go**とする。

- v6の22 table、5 document kind、全event familyをsemantic authority、diagnostic attachment、derived
  projection、storage mechanismへ 対応付けた。
- 同じclaimを複数authorityへ残す必要はなかった。captured
  documentだけが持つfieldも移動先を決められる。
- normal profileだけでrejected tool turnの最小説明閉包を構成でき、diagnostic attachment
  0件でも通常履歴を成立させられる。
- digest／codecの各照合に、維持、条件付き維持、削除候補の理由を付けた。
- 構想、architecture、roadmapの意味変更案を具体化した。

Slice AのNo-Go条件は発生していない。Human Gate 1で利用者承認を得て、上記三つのproduct正本へ
意味変更を反映した。

## Slice B〜D実施結果（2026-09-21）

### logical modelとisolated store

history schema 7として、execution、admission、semantic occurrence、typed relation、immutable content、
diagnostic attachment、projection outbox、canonical adoption、normalized Session stateを実装した。
production filenameは`history-v7.sqlite3`、lock namespaceは`locks-v7`であり、v6 migration、fallback、
dual-read/writeを持たない。

- semantic appendは新規occurrenceとrelationだけをtransactionで追加し、連続ordinal、terminal、mandatory
  referenceを増分更新する。
- settlementはmetadata、terminal、unresolved mandatory referenceだけを照合し、ordered rootと過去payloadの
  再走査を行わない。
- canonical adoptionはsettled executionとSession base revisionを一transactionでfenceする。
- immutable contentだけにcontent digestを置き、ordered root、segment digest、per-record digest、projection
  digestをschemaへ持ち込んでいない。
- `normal-v1`ではdiagnostic attachmentを作らず、`diagnostic-v1`ではexact request／response、SSE raw frame、
  parser／runtime／stage eventを任意attachmentとしてsemantic occurrenceへ相関する。
- projection失敗はsemantic commitを取り消さず、durable outboxをboundedにdrain／retry／rebuildできる。

crash prefix、dangling mandatory reference、terminal後append、base revision race、reopen、diagnostic invalidity、
projection failure／rebuildをfocused testで確認した。Slice B〜DのExitとGo条件を満たし、No-Go／Stop条件は
発生していないため、各Sliceを**Go**とした。

## Slice E実施結果（2026-09-21）

`SqliteHistoryV7ProductionStore`をproduction portと同じfacadeとして実装し、`createWorkerSession`へ
明示指定`historyVersion: 'v7-isolated'`だけで到達するseamを追加した。指定なしのproduction selectorは
引き続きv6である。

- Hostのstructured clone前にcommit／failure transcriptを当該executionのdeltaへbounded化し、永続化側でも
  direct callerに対して同じ境界を適用する。Session全transcriptをexecutionごとに複製しない。
- canonical turnのSession更新とadoption、settled non-canonical transcript／reason、tool call／result、effect、
  context manifest、resource／build attributionをv7へ保存する。
- human page／search／detailはprojection tableを読み、page／searchでauthority payloadをmaterializeしない。
- durable exportはnormalized Session rowとsemantic／diagnostic rowをgeneratorで逐次出力し、Session全体を
  一つのdocumentへ再構築しない。
- `/recall`はnon-canonical sourceを変更せず、次taskのtarget executionとのrelationをsettlement時に保存する。
- restart時はactive executionをpayload scanなしに`interrupted/non_canonical`へreconcileする。

actual Workerのprovider-free isolated経路で、canonical turn、再起動後resume、history projection／search／detail、
durable export、non-canonical source、`/recall`一回限りprojectionとsource／target relationを確認した。
さらに実際のslow turnをcancelし、v7上で`cancelled/non_canonical`となりSession turnが進まないことを確認した。
Slice Eを**Go**とした。

## Slice F実施結果（2026-09-21）

### 100M cumulative token相当

276 turn、累積100,086,984 token、新規semantic payload 2,760,000 bytesを追加した。

| 指標 | 実測 |
| --- | ---: |
| serialized bytes | 2,775,732 bytes |
| semantic occurrence／outbox row | 各552 |
| 既存payload read／rewrite | 0／0 bytes |
| append first p50／last p50 | 0.130582 ms／0.083708 ms |
| last／first p50比 | 0.6410 |
| settlement p50／p95 | 0.056874 ms／0.076583 ms |
| projection backlog drain | 552件を15.747 msで明示drain |
| DB／WAL／SHM | 6,021,120／4,144,752／32,768 bytes |
| active file合計 | 10,198,640 bytes（約9.73 MiB） |
| cumulative token当たり | 約0.102 bytes/token（DB単体は約0.060） |

Increment 90の比較可能なv6計測0.38654 bytes/tokenに対して約3.8分の1、元の問題事象で観測した
40.25 bytes/tokenに対して約395分の1であり、100分の1以下という容量目標を満たした。

### 多event executionとcapture profile

単一executionへ10,000 eventとterminalを追加した結果、serialized payloadは1,947,835 bytes、既存payloadの
read／rewriteは0、settlement counterは全て0、settlementは0.022167 msだった。append first／last p50は
0.048708／0.048083 ms（比0.9872）、active file合計は8,982,320 bytesだった。

同一semantic workload 100 turnでprofileを比較した。

| profile | semantic append | diagnostic bytes／処理 | DB | DB＋WAL＋SHM |
| --- | ---: | ---: | ---: | ---: |
| normal-v1 | 7.389 ms | 0 bytes／0 ms | 323,584 bytes | 4,484,624 bytes |
| diagnostic-v1 | 7.250 ms | 3,276,792 bytes／7.390 ms | 3,723,264 bytes | 7,900,784 bytes |

diagnostic costは新規diagnostic bytesに分離され、semantic append時間とsettlement条件へ混入しなかった。
provider-shaped diagnostic facadeではexact request bytesを一度だけimmutable contentへ保存し、request-start
occurrenceとの相関、response bytes／SSE frameのreadback、欠落／不一致時のcoverageを確認した。

### 検証と未確認範囲

cutover前に`agent:increment-94-history-v7:test`は16 testすべて成功し、変更対象のformat、lint、type check、
`git diff --check`も成功した。production cutover後のauthoritative `v0:gate`結果はSlice Gに記録する。

実provider callは実行していない。provider protocol／adapter contract自体は変更しておらず、actual Workerの
provider-free product flowとprovider-shaped diagnostic facadeでcutover判断に必要なstore／Host境界を確認できたため、
Human Gate 2は発動しなかった。従って実providerから到来するdiagnostic attachmentのE2Eは未確認として残す。

同じclaimについてcanonical Session state、semantic occurrence、human projectionに異なる役割の表現は残るが、
累積transcriptの反復保存とdocumentのsole-owner fieldは除去した。projectionのsearch text／previewは再生成可能な
derived copyでありauthorityではない。

処理量、容量、actual isolated product動作、診断分離のGo条件を満たし、SQLite固有の待ち時間支配やSession長／
execution既存event数を乗数とする処理は観測されなかったため、Slice Fを**Go**とした。

## Slice G実施結果（2026-09-21）

利用者のHuman Gate 3承認を受け、production historyを`history-v7.sqlite3`／`locks-v7`へ一括切替した。
`createWorkerSession`のversion selectorを廃止し、Session CLI、diagnostic CLI、production E2E layoutもv7だけを開く。
production entrypointのmodule graphにv6 store／pipelineは残っていない。migration、dual-read/write、fallbackは追加せず、
既存のv6 DB／lock directoryは削除・変更していない。

cutover回帰で次のproduction correctness問題を検出し、v7側で修正した。

- model selection等のHost-owned Session更新時にも`session_heads.revision`を同期し、次execution admissionのbase
  revisionと一致させた。
- context deltaで同じcontent bytesが再登場してbytes本体を省略した場合、digestで先行bytesを参照して重複messageを
  欠落なくreadbackする。
- semantic settlement後とrestart時にprojection outboxを最大64 sourceずつbest-effort drainし、projection失敗を
  semantic commitのgateにせず通常historyを回復する。
- normal profileのsemantic eventからprovider evidenceと内部transport stageを除外し、diagnostic-v1だけのattachment
  とした。document型CLI adapterはderived projection／diagnostic attachmentのreaderとしてv7上へ載せ替えた。

focused regressionではcanonical adoption、model switching、cancel／interrupt、context attribution、human history、
`/recall`、durable export、diagnostic attachment、Session delete、restart resumeを確認した。productionの新規writeが
v7だけへ向かい、v6 DBを作らないことも確認した。実provider diagnostic E2EはHuman Gate 2を発動していないため、
引き続き未確認である。

authoritative `v0:gate`はcheck、format、lint、全offline testを含めてexit 0となった。Deno 2.9.6で
`dist/henji`をbuildし、`~/.local/bin/henji`へ原子的に配置した。配置結果はHenji 0.3.0、build
`80d10b8e731bb7e76ae82353b690634863acf2d3c22c198449d77cf125422b89`、file SHA-256
`69d8b7067b8c9381c335555b008a80e8d15ee562c3ad9f7a7e01f066e972222b`で、sourceと配置先のhashは一致した。
installed binaryのisolated XDG smokeでは`henji sessions list`が成功し、`history-v7.sqlite3`だけを作成して
`history-v6.sqlite3`を作成しなかった。実provider callは実行していない。

Slice GのExitを満たしたため**Go**とする。Human Gate 4で利用者のIncrement完了判断を待つ。

## Human Gate 4前のproduction実利用追試と修正（2026-09-21）

配置済みbinaryで作成したSession `db175b53-6452-454f-9020-300d1bca4989`をread-onlyで確認した。2 turn／
2 canonical execution、26 canonical message、projection backlog 0、diagnostic attachment 0、v6への誤書込み
なしであり、cutoverと通常履歴readbackは成立していた。一方、synthetic scale testが通過していたにもかかわらず、
production facadeに次の保存増幅が残っていた。

- `context_observation`がcontent bytesを含む旧event envelopeをsemantic payloadへinline保存していた。第1 turn
  最初のrequestは12 occurrence／約37 KB、第2 turnは既存文脈を含む30 occurrence／約390 KBで、Session長に伴い
  request payload bytesが増えていた。`immutable_contents`はsemantic contextに使われていなかった。
- `commit_proposal`は同じturn transcriptをtop-levelと`outcome.transcript`へ二重保存していた。
- `normal-v1`でもHostが全protocol eventをtraceへ追加し、artifact 2件の10,954 entryが約4.08 MBを占めていた。
- productionの`history_projection_entries`はsemantic payload JSON全体を複写していたが、通常page／search／detailは
  `human_history_entries`だけを利用しており、実read pathを持たない重複projectionだった。

この追試を受け、production pathを次のように修正した。

- context itemを独立した`context_item` semantic occurrenceとimmutable contentへ分離した。model request occurrenceは
  item identityだけを保持し、mandatory `context_item` relationで同transaction内のownerへ結ぶ。同じdigestが既に
  存在する場合はDB lookupだけでvalidated refを作り、bytesを再hash・再保存しない。readback時だけcontentを検証して
  従来の`ContextModelRequestDelta`へhydrateする。
- durable exportへdigestごと一度の`immutable_content` recordを追加し、normalized storageへ移したcontext bytesを
  exportから欠落させない。
- `commit_proposal`はturn transcriptをtop-levelへ一度だけ保存し、`outcome.transcript`は空にする。互換read APIでは
  readback時に復元する。
- `normal-v1`はHostのprotocol trace収集自体を停止する。互換artifactは空traceで生成し、`diagnostic-v1`だけがtraceを
  収集する。
- production projection drainは不要な`history_projection_entries`複写を作らず、実際にpage／search／detailが読む
  entryだけを更新する。`context_item`はhuman projection outboxへ入れない。

focused testは16件から18件へ増え、immutable contentのcross-execution再利用、hash 0、context item relation、inline
`bytesBase64`不在、readback hydrate、export content、single-copy transcript、normal trace 0、diagnostic trace有効を確認した。
actual Workerのisolated product flowでは4 executionを含むDBが421,888 bytes、artifactは各6,994〜8,180 bytes、
40 context occurrenceが16 immutable contentへ共有され、model request payload最大は3,792 bytes、
`history_projection_entries`は0件だった。変更後のfocused test、context attribution 28件、cancellation 4件、Worker
liveness 10件、provider compatibility 20件、Worker stage 11件、repository check／format／lintはすべて成功した。
authoritative `v0:gate`の初回はnormal artifactへprotocol traceを要求する旧test 1件だけが失敗した。semantic
acknowledgement fieldは維持されており新しいprofile契約とtestが競合していたため期待をtrace 0へ更新し、該当focused
testとgate全体を再実行してexit 0を確認した。

この修正を含むbinaryのbuild／配置と、配置後の実provider Session再確認はまだ行っていない。Human Gate 4のIncrement
完了判断は引き続き利用者に残す。

## Human Gate 4前の通常code／test review修正（2026-09-21）

独立した通常reviewで、追試修正後のv7に4件のcorrectness問題を確認した。

- terminal occurrenceのappendとexecution lifecycle／canonical adoptionが別transactionであり、その間で停止すると
  `active`かつterminal済みのprefixが残った。restart reconciliationは2個目のterminalをappendしようとしてfenceに
  拒否され、workspaceのv7 storeをopenできなかった。
- human projectionはcontext、request、diagnostic／artifact locatorを常に空で渡し、authorityが存在しても
  `/history`から背景へ辿れなかった。bounded drainのpending状態もread surfaceへ出していなかった。
- projection outbox sourceごとにhydrated `readExecution()`を呼び、同じ累積Session transcriptを反復readしていた。
  mandatory relationの未解決数もappendごとに当該executionの既存relation全体から再集計していた。
- durable exportが`semantic_relations`、`execution_context_manifests`、`recall_relations`を出力せず、v7 authorityと
  attributionをexportだけから回収できなかった。

次のように修正した。

- terminal semantic occurrence、lifecycle／outcome／adoption、canonical Session更新、execution message保存を一つの
  `BEGIN IMMEDIATE` transactionへ統合した。commit直前faultではterminalを含む全更新がrollbackされ、restart時は
  active prefixを`interrupted/non_canonical`へreconcileする。旧実装型のterminal-only active prefixも、新しい
  reconciliation factを同transactionで追記して閉じる。
- human projectionのterminal sourceから、そのexecutionのcontext item provenance、request metadata、effect、evidence、
  diagnostic、artifact locatorを投影する。通常pageはSession単位のpending source数を`current`／`stale`として返し、
  TUIは`history updating (N pending)`を表示する。
- projection drainはtranscriptをhydrateしないexecution metadataをexecutionごと一度だけ読み、同じbatch内で共有する。
  mandatory relation counterは、新規未解決relationと今回解決したrelationだけで増減し、既存relation全体をcount
  し直さない。
- durable JSONL exportへ`semantic_relation`、`execution_context_manifest`、`recall_relation` recordを追加した。

focused testは21件となり、atomic settlement fault、terminal-only prefix再open、96 semantic sourceのbounded drain、
stale／current表示、projection中のhydrated execution read 0、human pageのcontext／request／diagnostic entry、relation／
manifest／recall exportを確認した。関連するcontext attribution 28件、cancellation 4件、Worker liveness 10件、Worker
stage 11件、provider compatibility 20件、history authority／production 23件、human history 3件、TUI 41件も成功した。

authoritative `v0:gate`初回は追加test fixtureのWorker runtime eventに必須の`correlation`／`sequence`が無くtype checkで
停止した。fixtureを実contractどおり補正してtype checkを確認後、gate全体を再実行しexit 0となった。

利用者の指示により実装を`7383daef`としてcommitし、Deno 2.9.6の公式release artifactをchecksum検証してclean commitから
standalone binaryをbuildした。`dist/henji`と`~/.local/bin/henji`を同一artifactへ原子的に配置し、両方のSHA-256は
`47335a0b71ed70730c996d79e02a3ac0c3840f65cf31150fff6234899d7da120`で一致した。build IDは
`0c0f1f717b3c9ef21263960a857872b74336d159c894f3748aa21b377e596be5`、embedded sourceは`7383daef`、runtimeは
`2a20a3cfe4c26f97729508f28af7c6e492159998042829c083b8d19aeb0d36d5`である。installed binaryは隔離XDG／空workspaceで
`sessions list`を完了した。VMの既定Deno 2.9.7は変更していない。実provider callと既存の実利用Sessionによる再確認は
行っていない。Human Gate 4のIncrement完了判断は引き続き利用者に残す。
