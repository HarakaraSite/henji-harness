# Increment 50 — normalized history authority and active Session projection

ステータス: **完了（計画承認、実装、検証、production受入完了）**

基準commit: `cf6180ee`

計画日: 2026-09-13

対象候補: A4

## 利用者が必要とする動作

- 長期利用しても、同じtranscript、provider exchange、progress、execution outcomeをlive journal、Session record、
  evidence、artifactへ完成payloadとして重ねて保存しない。
- canonical/non-canonical execution、raw response bytes、SSE event、parser transition、model request、tool effect、
  context attribution、failure diagnosticを、現在と同じ意味とidentityでrestart後もreadbackできる。
- 現在activeな一つのSessionについて、canonical conversation、model context用の状態、human history用の状態を
  memory上の完成済みprojectionとして使い、通常turnのたびに全履歴を再読込・再構成しない。
- memory projectionを失ってもdisk上のfactだけから再構築でき、memoryをflushまたはbackupすべき正本にしない。
- `/new`または`/sessions`による切替時は切替先をdiskから候補として構築し、切替成功後に旧projectionを破棄する。
  定常状態で複数Sessionのprojectionをcacheしない。
- 現行SQLite schema v3とそのsidecarを変更・削除せず、新しいschema v4 authorityを空から開始する。

利用者が承認した方針は、次の一文をこのIncrementの判断基準とする。

> disk上では事実を一度だけ正規化して保存し、現在の一つのSessionについてのみ、利用に適した完成状態を
> memoryへ投影する。

## 根拠と確認済み状態

- Increment 49の通常利用dataでは、3 executionでdatabaseが約15.6 MBとなり、約89%を
  `execution_events`、`provider_evidence`、`execution_artifacts`が占めた。
- `commit_proposal` 3件が約2.95 MBの累積transcript、`assistant_progress` 1,152件が約1.53 MBの累積snapshotを
  保持していた。raw response、SSE、parser transitionもlive journalと完成evidenceの両方に残る。
- schema v3の`record_json`はcanonical transcriptを含む一方、`canonical_messages`にも同じmessageを保存する。
  `outcome_json`もtranscriptを含み、artifact/evidenceはexecution、request、journalにある値を完成JSONへ再収録する。
- 現行`WorkerHostSession`はactive Sessionのtranscript、revision、checkpoint等を既にmemoryへ保持する。
  `/new`とSession切替は切替先Hostを開いた後に旧Hostをcloseするため、最初の改善にprocess-wide LRUは不要である。
- 現行storeは`history.sqlite3`の`PRAGMA user_version`が期待値と異なると`history_invalid`にする。同じpathで
  schema versionだけを4へ変えると、既存v3を残したままproductionを開始できない。
- 事前の独立reviewは、正規化したdisk factと破棄可能なmemory projectionの分離にBlockerなしと判断した。
  `/rebuild`を後で実装する場合も、generation ID、exact resource snapshot/ref、active transitionはdisk fact、
  解決済みの実効contextはmemory projectionとする境界が適合する。

## Product contract

### 1. schema v4への空のcutover

- workspace-local v4 authorityは既存`history.sqlite3`とは別の`history-v4.sqlite3`を使用し、lockも既存`locks/`とは
  別の`locks-v4/` namespaceを使用する。schema、index、Session、detached executionを含むすべてのv4 lockをここに置き、
  `PRAGMA user_version = 4`とschema metadataの両方を検証する。WAL、`synchronous=FULL`、foreign key、busy timeout、
  Session単位writer lock、異なるSessionの並行writeは現行契約を維持する。
- v3のmain DB、`-wal`、`-shm`、lockをscan、open、checkpoint、copy、rename、import、変換、削除しない。
  v4 binaryからのSession list/open、diagnostics、`/recall`、history/detail/exportはv4だけを参照する。
- v3とv4のdual-read/write、fallback、migration marker、synthetic provenanceを追加しない。旧binaryを同じworkspaceで
  同時利用できるという新しい互換契約も設けない。
- SQLite schema versionと、`SessionRecordV6`、`ProviderEvidenceV5`、`WorkerExecutionArtifactV5`等のread model versionを
  区別する。既存read portを維持する必要がある箇所では、v4 factからread modelを生成し、完成JSONを保存しない。

### 2. 一度だけ保存するfact authority

schema v4では一つの観測順を`execution_observations`で保持し、本文はkind別の正規化tableへ一度だけ保存する。
observation rowはexecution ID、ordinal、時刻、direction、source、worker sequence、fact kindと参照先だけを持ち、
別tableの完成payloadを再収録しない。

| fact | disk上のauthority | そこから作るprojection |
| --- | --- | --- |
| Session identity、active model、revision | `sessions`、`session_model_changes` | current Session metadata / record |
| semantic checkpoint | Session IDに属する単一の`semantic_checkpoints` row | model contextのsummary + canonical suffix |
| Worker generationとbootstrap trace | `worker_generations`と小さいprotocol observation | execution artifactのgeneration/protocol trace |
| task、steering、cancel、ack、dispatch | `execution_inputs`、小さいprotocol observation | protocol trace、task history |
| executionが新たに生成したmessage | unique content factを参照する`execution_messages` | canonical conversation、outcome transcript、model context、human history |
| lifecycle、outcome、adoption、capture状態 | `executions`、`canonical_turns` | Loop outcome、artifact、timeline summary |
| provider requestとresponse metadata | `model_requests`とprovider response metadata | provider evidence request record |
| raw response bytes | request順・chunk順のBLOB | exact response body / base64 readback |
| SSE event、parser transition | request順・ordinal順のtyped row | provider evidence detail |
| model result、assistant/tool progress、tool call/result | identityを完備した一つの`runtime_occurrences` | Surface event、provider runtime event、message content |
| assistant/tool progress text | occurrenceに属する`execution_progress_deltas` | 各時点のexact progress snapshot、最新progress |
| tool effect | call IDで相関したeffect row | tool detail、artifact summary |
| context attribution | content-addressed blob、relation、request item | context detail、model request projection |
| failure diagnostic | diagnostic rowとevidence relation | diagnostic read model |

- `sessions.record_json`、`executions.outcome_json`、`provider_evidence.evidence_json`、
  `execution_artifacts.artifact_json`のように他のauthorityを束ね直した完成JSONをv4には置かない。
- initial taskをadmission event payloadやdispatch event payloadへ再収録せず、task factを参照する。canonical turnは
  executionを参照し、canonical messageをSession用tableへcopyせず、そのexecutionのmessage列を採用する。
  `execution_messages`はtaskまたはruntime occurrenceのidentityと順序を保持し、同じruntime payloadをcopyしない。
- Workerの`commit_proposal`と`turn_failed`はprotocol markerと、そのexecutionで新たに生じたmessage/outcome factへ
  分解してdurableにする。過去のcanonical transcriptを含むproposal envelope全体は保存しない。proposalの検証と
  current-turn message抽出に失敗した場合は現行どおりcanonical採用せず、観測済みfactをnon-canonical settlementへ残す。
- provider evidenceとexecution artifactのstore/list/get APIは、正規化factから既存の意味を持つdata-only read modelを
  組み立てるadapterとする。ID、request順、event順、capture状態、outcome、attributionを推定せず復元できなければ
  `history_invalid`とし、別の完成copyへfallbackしない。
- execution artifactのbootstrap protocol traceは各executionへcopyせず、Worker generationの一度だけのfactと
  execution-local observationを順に投影する。provider evidenceの`runtimeEvents`、human detail、Surface eventも
  同じ`runtime_occurrences`から投影する。
- full-history JSONL exportはschema v4のauthority rowを一度ずつstreamし、同じ完成evidence/artifact JSONを追加出力
  しない。人間向けhistory/detailは現行のsemantic contentとnavigationを維持し、保存構造をそのままUIへ露出しない。
- observation rowと参照先のtyped fact rowは一つのtransactionでinsertし、payloadのないobservationまたは順序のない
  factをdurableにしない。

### 3. progressのdelta表現

- Worker protocolは、現在別messageとして送っているSurface向け`AgentEvent`とprovider evidence向けruntime eventを
  一つのenriched runtime observationへ統合する。assistant progressにはturn、lane、model step、physical request
  ordinalを、tool occurrenceにはcall IDと同じattributionを、Hostが保存する前から含める。
- Hostはこの一つのobservationをdurableにした後、Surface向け`AgentEvent`とprovider evidence read modelへ投影する。
  同じprogress/tool payloadを持つ第二のprovider runtime observationを送信・保存せず、本文一致による後付け相関をしない。
- `assistant_progress`と`tool_progress`の受信値が直前の同一stream snapshotをprefixとして持つ場合、追加部分だけを
  `append` deltaとして保存する。prefixでない訂正・置換は`replace`としてその時点のexact textを保存する。
- stream identityは少なくともexecution、lane、model step、physical request ordinalとし、tool progressはcall IDも
  含める。異なるstream間の同じ文字列から関係を推定しない。
- 各observation ordinalのsnapshotは先行deltaからexactに再構築できる。restart reconciliation、provider evidence、
  event detail、full-history exportから観測順と各時点の内容へ到達できる状態を保つ。
- current active streamの復元済み最新textはmemory projectionに保持する。memory値をdurableと主張せず、次のdeltaを
  publishする前にそのdeltaのdisk commitを完了する。

### 4. active Session projection

- `ActiveSessionProjection`はcurrent Sessionのidentity、state revision、next turn、canonical transcript、model changes、
  semantic checkpoint、および現在executionの最新progress等を持つHost-ownedな派生状態とする。human history全体を
  memoryへmaterializeせず、viewerのcursor/viewportとload済みbatchだけをSurface-local stateとして保持する。
- semantic checkpointは一般cacheではなく、modelが生成したsummaryを含みcanonical messageから同一内容を再生成できない
  durable derived projectionである。Session ID、covered/retained turn、source profile、created time、exact summaryを
  `semantic_checkpoints`の単一authorityへ保存し、独立transactionの成功後にWorkerへacknowledgeする。Session openでは
  このrowとcanonical suffixからmodel contextを復元する。
- Session open時にv4 factから一度構築し、canonical/non-canonical settlementのdurable commit成功後だけ対応revisionへ
  更新する。write失敗時にmemoryだけを先へ進めず、Surfaceへ新しいcanonical状態を公開しない。
- projectionは少なくともSession ID、state revision、および将来の`AgentContextGeneration ID`をcache identityに含める。
  このIncrementではgeneration identityや`/rebuild` operation自体を導入しない。
- `/new`と`/sessions`切替では現行どおり切替先をcandidateとして構築できてから旧Hostをcloseし、成功後にcandidateを
  activeへ昇格して旧projectionを破棄する。切替中だけ旧activeと一つのbounded candidateの共存を許し、失敗時はcandidateを
  破棄して旧activeを維持する。process-wide cache、複数Session LRU、idle timer、SQLite `:memory:` database、
  serialize/backup flushを追加しない。
- `HumanHistoryProjector`とmodel context projectionは意味上の別責務を維持する。ただし同じnormalized factとcurrent
  Session projectionを入力にし、それぞれの完成document/contextをdiskへ新しいauthorityとして保存しない。

### 5. active、settled、restartの一つのread経路

- active executionの各factを受信順にdurable commitしてからSurfaceへ配送する現行境界を維持する。provider/tool
  dispatch前の記録、journal failure時のcancel/termination、canonical rejectionを弱めない。
- settlementは`executions`、canonical adoption、capture relation、terminal observationを一transactionで確定する。
  evidence/artifact用の完成payloadを生成して再保存せず、active中に保存したfactを同じID/ordinalでsettled readへ使う。
- restart reconciliationは同じnormalized factを読み、dispatch済みかに応じて`interrupted`または`unknown`へsettleする。
  未観測のresponse、tool result、messageを補完せず、自動replayまたはcanonical採用を行わない。
- v4 settlement後に重複journalを消すcleanupは設けない。削除を必要とせず、最初から一つのfactへ書く構造で
  storage amplificationを解消する。

## 実装順序

1. 変更前のschema v3で、累積progress、複数model request、tool call/result、canonical/non-canonical settlementを含む
   deterministic workloadのDB byte量、payload byte量、Session open、model context構築、history/detail/export時間を
   baselineとして記録する。provider network時間は含めない。
2. `history-v4.sqlite3`、`locks-v4/`のschema、version/path検証、typed row codecを追加し、v3 DB/lock sentinelを一切
   開かずv4だけを使うproduction compositionへ切り替える。
3. WorkerのSurface/provider向けruntime eventをidentityが揃った一つのobservationへ統合する。admission、Host protocol、
   Worker runtime/provider/context/tool observationをnormalized fact writerへ接続し、progress deltaを実装する。
4. proposalに含まれるprior transcript prefixをactive canonical projectionとidentity・順序・内容までexactに照合し、
   current-turn suffixだけをmessage factへ保存する。内容一致だけによるsource推定やprefix省略を許さない。
5. Session、checkpoint、outcome、provider evidence、artifact、diagnostic、human history、full-history exportのread adapterをv4 factから
   構築し、完成JSON storeを除く。
6. 現行`WorkerHostSession`のcurrent stateを明示的な`ActiveSessionProjection`として整理し、open、checkpoint install、
   durable commit後の更新、title/model selection、`/new`、Session切替、closeのactive/candidate lifecycleを接続する。
7. focused verificationと同じdeterministic workloadの比較を行い、通常production turnを一度受入確認する。
   安定候補にだけauthoritative `v0:gate`を一回実行する。

## Verificationと成功条件

- v3 sentinelのmain DB、存在するsidecar、schema/index/Session/execution lockのhash/byteが実行前後で同一であり、
  v4のlist/open/export/reconciliationから到達不能である。v3 lockの存在・保持はv4のcapacity/busy判定へ影響しない。
- 新規Sessionのcanonical turnをcommitして再起動後に続行でき、`/new`と`/sessions`往復では切替先だけをmemoryへ
  構築する。切替失敗時は現行Sessionとprojectionを維持する。
- completed、cancelled、failed、restart-reconciled executionについて、timeline、literal検索、detail、`/recall`、
  provider evidence、diagnostic、artifact、canonical-only export、full-history exportが保存済みfactと一致する。
- raw response bytes、SSE frame/parsed value、parser transition、request body、tool arguments/result、context blob/relationを
  変更・省略せずreadbackできる。credential値とAuthorizationを保存しない現行契約は維持する。
- semantic checkpointをinstallしてprocessを再起動した後も、exact summaryとcanonical suffixをmodel contextへ使う。
  model selection変更後も同じcheckpoint identity/contentを再利用し、install失敗時は直前checkpointを維持する。
- assistant/tool occurrenceはWorkerから一度だけ送られ、一transactionでfact/orderを保存した後にSurfaceへ即時配送される。
  同じfactからprovider evidence/detailを再構築して、worker sequence、request attribution、表示順が一致する。
- 同一executionの過去canonical transcriptがproposal/outcome/Session JSONとして再保存されず、完成evidence/artifact
  payloadがlive observationと併存しないことをschemaとDB queryで確認する。
- 累積progress workloadでは、通常のprefix増加が最終textとdelta metadataに概ね比例し、全snapshot本文の総和に
  比例しない。`replace`を含む各時点のsnapshotもexactに復元できる。
- Increment 49と同種のworkloadについてv3/v4のDB増加量とpayload内訳を比較し、削減量をIncrement結果へ記録する。
  未計測のquotaや削減率を合否閾値にしない。
- Session open、model context構築、history/detail/exportのlocal所要時間を同じworkloadで比較する。provider latencyを
  改善値へ混ぜず、応答性が改善しない経路も結果として記録する。
- title変更とmodel selection変更はdurable commit成功後だけactive projectionへ反映し、失敗時はdisk/memory/Surfaceの
  既存状態を維持する。
- 変更箇所のfocused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行し、安定候補に対する
  authoritative `v0:gate`を一回だけ実行する。

## 対象外

- v3 dataのmigration、converter、compatibility read、dual-read/write、fallback、削除
- retention期限、quota、自動削除、圧縮、VACUUM、FTS
- 複数Session LRU cache、idle eviction、process間memory cache同期
- SQLite in-memory authority、定期serialize/backup、遅延durable flush
- `/rebuild`、`AgentContextGeneration`の導入、resource selection/activation
- provider/model/tool/instructionの機能変更、一般的なhardening
- architecture、roadmap、構想の正本変更
- commit、push、tag、publish、release、導入済みbinaryの置換

## 規模見積り

schema、Worker observation protocol、全read/write adapterを一度に切り替えるため、小規模な行修正ではない。
実装、focused verification、production受入、結果記録までを **10〜15開発日相当** と見積もる。複数Session LRUと
`/rebuild`を分離することで、このIncrement内の状態組合せと運用境界は増やさない。

## 第三者review

初回reviewはBlockerなし、P1 3件、P2 1件だった。すべて採用し、次を計画へ反映した。

- v4 DBだけでなくschema/index/Session/execution lockも`locks-v4/`へ分離し、v3 lockをscan/openしない。
- semantic checkpointをexact summaryを持つ独立したdurable authorityとして明記し、install/reopen/context利用を検証する。
- Surface向けとprovider evidence向けに二重送信しているprogress/tool occurrenceを、attributionが揃った一つのWorker
  observationへ統合し、disk commit後に双方へ投影する。
- 定常時は一つのactive projectionとしつつ、failure-safeなSession切替中だけ一つのcandidateとの共存を許す。
- observation/factのatomic insert、proposal prefixのexact照合、title/model selectionのrollback確認を加えた。

変更後の計画は同じreviewerがbounded再reviewし、既存4 findingはすべて解消、新しいBlocker/P1はないと確認した。

## 実装結果

- production history authorityを`history-v4.sqlite3`と`locks-v4/`へ切り替えた。v3 main DB、sidecar、lockを
  開かず、変更しないsentinel testを追加した。migration、dual-read/write、fallbackは追加していない。
- Session、checkpoint、outcome、provider evidence、artifactの完成JSON列を除去し、task、message content、Worker
  generation/protocol trace、runtime/provider observation、progress delta、context blob/relationを正規化した。
  initial task、proposalのprior transcript、context observation envelope、provider response、artifact/evidenceの完成copyを
  journalへ重ねて保存せず、既存read modelはfactから再構成する。
- Workerから二重送信していたSurface eventとprovider runtime occurrenceを、turn/request attributionを持つ一つの
  provider observationへ統合した。Hostはdurable commit後に同じfactからSurface eventを投影する。
- `WorkerHostSession`のcurrent Session stateを明示的な`ActiveSessionProjection`へまとめた。diskを正本とし、memoryは
  current Sessionだけの破棄可能な完成状態であり、複数Session LRUやin-memory SQLite、遅延flushは導入していない。
- production CLI E2Eの保持先もv4 authorityへ合わせた。

## 容量と応答性の観測

1,152回、1 byteずつ増えるdeterministicなassistant progressでは、旧snapshot方式の本文総和が664,128 bytesであるのに
対し、v4のdelta本文は1,152 bytesだった。observation marker 269,814 bytesとruntime fact 101,376 bytesを含むDB fileは
1,171,456 bytesで、各ordinalの完全なsnapshotを再構成できた。このprobeはprogress経路だけの比較であり、Increment 49の
実data全体に同じ削減率を外挿しない。

最大context probeでは、model request 6,290,538 bytes、message portion 5,242,298 bytesをexact readbackしつつ、v4 DBは
3,072,000 bytes、unique content blobは2,795,879 bytesだった。`model_requests.request_json`と`provider_body`への完成copyは
0 bytesであり、context observationも小さいmarkerだけを保持した。local captureは約351〜392 ms、RSS増分は
約287〜479 MBのrun間変動があり、provider-free controlは約5.6〜6.5 msだった。disk重複は減ったが、最大payloadを
完成read modelへ展開するmemory cost自体は残る。

Increment 49の通常利用v3 dataは3 execution / 3,800 eventで15,613,952 bytesだった。今回のprobeは同じ実dataのmigrationや
replayではないため、v4全体の削減率として直接比較しない。v4は空から開始するという利用者判断に従い、既存v3 dataは
比較用のread-only evidenceとしてそのまま残す。

## Verification

- 新しい`tests/v0/increment_50_normalized_history_test.ts` 5件で、v3 byte不変、v4 version/path、完成aggregate列の不存在、
  proposal suffix、runtime occurrenceを参照するcanonical messageの再open、fallback content blob、progress append/replace、
  partial evidenceのlatest-only projectionと容量比例を確認した。
- Increment 40 14件、Increment 41 12件、Increment 42 27件、Increment 43 2件、Worker foundation 26件、provider stream
  compatibility 20件、production CLI E2E 5件の関連testが成功した。
- authoritative `v0:gate`は安定候補に一回だけ実行しexit 0だった。その後の最終的なcontext/message fact正規化について、
  上記focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を再確認し、すべて成功した。gateは再実行していない。
- 一時standalone binary（build `4418ebb5dcd49ee22c5a34b1c8d0217589828cc78f6cfbcc1d12dd8e4df0b66f`）とisolated
  workspace/stateでreal-providerの通常turnを一回実行し、`increment-50-ok`を得た。v4 DBの
  `integrity_check=ok`、foreign-key violation 0、execution/outcome/evidence/artifact各1件、runtime occurrence 7件、
  provider fact 37件をread-only確認した。この受入後に行った最終正規化は上記focused testで確認し、外部callは繰り返していない。
- 実装review修正後の最終working treeから一時standalone binary build
  `fd74909d1c414a03e70bb0c8f4f949a71c349125de942c83716f8c154b0735ef`を生成し、version/build identityを確認した。

## 実装review

初回の独立実装reviewでBlockerなし、P1 4件、P2 1件を採用し、次を修正した。

- completed transcriptのassistant/tool messageは`runtime_occurrences`のobservation ordinalを参照し、該当runtime factが
  ないmessageだけをcontent-addressed blobへ保存する。canonical Sessionの再openを含む全read経路で同じmessageを復元する。
- unified `provider_observation`をhuman timeline/search/detailでhydrateし、`model_result`、assistant/tool progress、
  tool call/resultのsemantic contentをmarkerやdigestだけでなく人間が読める形で返す。
- full-history exportへstore metadata、Session model change、semantic checkpoint、fallback message blob、artifact traceを含め、
  Sessionに属するv4 authorityの参照を閉じる。
- active context用に残っていたSQLite `:memory:` copyを削除し、active/settledともdisk上のnormalized factを直接読む。
- restart時のpartial provider evidenceはRecorderと同じstream identityでassistant/tool progressをlatest-onlyへ投影し、
  journalとevent detailには各snapshotを観測順どおり残す。

同じreviewerによる15分上限のread-only再reviewは、既存findingがすべて解消され、新しいBlocker/P1/P2はないと確認した。
reviewerはfull gate、外部provider再実行、file変更を行っていない。real-provider受入は修正前に一回成功済みであり、
今回の修正はnormalized factのlocal write/read/projectionに限定されるため、focused regressionとstandalone buildで確認し、
review直後には追加の外部callを行っていなかった。

その後、利用者の明示承認によりreview修正後build `fd74909d1c414a03e70bb0c8f4f949a71c349125de942c83716f8c154b0735ef`
でproduction CLI E2Eを一回実行した。fixed read tool scenarioはchild exit 0、provider request 2件、retry 0、tool 1回、
最終応答のexact一致、artifact/evidence各1件、SQLite `integrity_check=ok`、foreign-key violation 0となった。4 messageの
うちtask以外の3件はすべてruntime occurrence参照でcontent blobを重複保存していなかった。

最初のE2E評価は、evaluatorが統合前の`effect_observation`と、`contextRequestOrdinal`・request metadataの`effort`を
含まない旧key集合を期待していたため失敗した。evaluatorとoffline fixtureを現行contractへ合わせ、offline E2E 5件を
通した後、保持済みの同じ実provider dataを補正なしで再評価して`passed`を確認した。再評価によるprovider requestは0件である。

実装差分は未commitであり、v3 dataは変更していない。その後の利用者の明示指示により、現在のworking treeから
build `fd74909d1c414a03e70bb0c8f4f949a71c349125de942c83716f8c154b0735ef`を生成し、`dist/henji`と
`~/.local/bin/henji`へ同一artifactを配置した。両方のSHA-256は
`7810f2c87a75d4581d301ca400b607e725ef56f15c6f56db020e5570964a9c8f`である。

配置後の通常利用で、main model requestから`web_search`のauxiliary requestへ切り替わったprovider
request ordinalをHostがtool resultのcontext attributionとして使い、Worker manifestが保持する元のmain
model request ordinalと一致せずcanonical commitを拒否する不具合を観測した。Hostはprovider
`request_start`からphysical/logical requestの対応を復元し、`model_result`が生成したcall IDごとに元の
logical requestをtool effectへ引き継ぐよう修正した。main provider 2 requestと同一model step内の
`web_search` 3件を通るnetwork-free production相当経路で、修正前の`durable session commit failed`と修正後の
canonical adoption / complete context captureを確認した。Increment 42の27件、Increment 50の5件、変更対象の
type check、format、lint、`git diff --check`は成功した。利用者の明示指示により、follow-up修正を含む
clean commitからstandalone binaryを再buildし、`dist/henji`と`~/.local/bin/henji`へ同一artifactを配置した。
