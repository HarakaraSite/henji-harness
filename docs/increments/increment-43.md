# Increment 43 — human history view

ステータス: **完了**

基準commit: `f6ef75c5`

調査日: 2026-09-13

前提: Increment 40〜42が完了し、workspace-local SQLite schema v3にcanonical turn、active/settled
execution、live journal、tool effect、projection、context attribution、model request、provider evidence、
diagnostic、artifactが相関済みであること。この前提は2026-09-13に満たした。

対象機能: F01、F04、F05、F10、F26

## 利用者が必要とする動作

- 現在Sessionのcanonical turnと、cancelled/failed/interrupted等のsettled non-canonical executionを、
  execution単位を失わない一つの時系列として通常TUIから辿れる。
- task、steering、assistant output、tool call/result、lifecycle、outcome、canonical adoptionを確認し、必要な
  executionからcontext attribution、model request、provider evidence、diagnosticへread-onlyで辿れる。
- 長い履歴を一つの連続documentとして移動し、人間が覚えているliteral keywordから該当箇所へ移動できる。
  wrapping後のterminal rowとstorage側のpageを二つの別documentとして混在させない。
- 履歴閲覧、検索、detail展開、exportはSession revision、canonical adoption、model context projection、
  `/recall`選択、Worker generation、provider/tool実行を変更しない。
- 現行のcanonical-only Markdown `/history export`を維持し、それとは別に当該Sessionのdurable history全体を
  exactなstreaming exportとして保存できる。
- 大きなtool result、model request、provider evidenceや長期Sessionがあっても、全履歴を一度にRAMへ
  materializeせず、別Sessionのwriterを阻害せずに閲覧できる。

## planner再設計との境界

利用者は現行plannerを作り直す予定であり、Increment 43からplanner固有の表示と受入を外す。

- `planner`専用timeline、親子tree、planner resultの特別なrenderer、delegationの操作、再開、合流、cancel、
  planner固有検索は実装しない。
- schema v3に既に保存された`agent`、request `lane` / `purpose`、call IDは通常の保存済み属性である。
  genericなexecution/request detailは値をそのまま表示できるが、現在のplanner構造を将来contractとして
  固定したり、plannerだけの分岐を作らない。
- 現行planner実装や既存rowをIncrement 43で削除・変換しない。新plannerが独立Execution、親子関係、非同期・
  並行実行、結果合流を採用する場合は、そのexecution modelを決める別incrementでhistory relationと
  `HumanHistoryProjector`の入力を追加する。
- 通常利用メモA7の非同期・並行subagent候補は未採用のままであり、この計画からarchitecture/roadmapへの
  採用を推定しない。

## 根拠と確認済みの現在地

- architectureはhuman history viewをcanonical/non-canonical双方へ到達できるHost/Surfaceのread-only
  rendererとし、model context projectionと分離する。Markdown、tool summary/detail、status表示は保存内容や
  adoptionを変更しない表示責務である。
- 採用済みprogramはIncrement 43で、同一Session timeline、outcome/tool/context/projection/evidence navigation、
  keyword検索、`HumanHistoryProjector`と`ModelContextProjector`の分離、durable history全体のexportを要求する。
- schema v3にはSessionに属するexecutionを読む`executions_session_turn` index、execution順のevent、call ID別effect、
  canonical turn/message、`/recall` projection、context relation/request、provider evidence、diagnostic、artifactがある。
  human read modelに必要なidentityと内容は揃っており、schema v4やmigrationは必要ない。
- 現行`SessionHistoryPage`はcanonical transcriptの一turnをHost側の固定source-byte/row上限でpage化する。
  productionのPageUp/PageDownはTUIが実際にwrapしたretained conversation rowを別のpage単位で扱う。Increment 30の
  検索試行はこの二単位を混在させ、同じ履歴のpage数が操作により変わったため取り下げた。
- 現行TUIには`history_page` presentation seamとhistory overlayが残るが、通常操作から開く経路はない。
  PageUp/PageDownは現在のretained conversationを移動し、`/history export`はcanonical transcriptだけを
  Markdownへ書く。
- `diagnostics executions show/events/context/request`はexecution単位のexact JSONを返せるが、Session timeline、
  human projection、検索、相互navigationは持たない。workspace全executionを取得してSurface側でfilterするのではなく、
  Session keyset queryをstorage側へ追加する必要がある。
- Deno 2.9.4の`node:sqlite`はSQLite 3.53.2で、実機probeではFTS5を利用できた。ただしFTS token/query semanticsと
  human rendererのdocumentは同一ではない。Increment 43はschema/indexを増やさず、同じhuman projectionをbatch単位で
  生成してliteral検索する。長期履歴の速度が実測上問題なら、表示と同じsearch textを索引する後続最適化として扱う。

## 参照実装と採用範囲

- [Codex App Server](https://developers.openai.com/codex/app-server/)は保存済みthreadをresumeせず読む
  `thread/read`、turnのcursor pagination、itemの`notLoaded | summary | full` viewを分ける。Henjiはreadによって
  Workerを再開しないこと、summaryとexact detailを別readにすること、keyset/cursor paginationを参考にする。
  Codex固有item型、remote protocol、thread fork、subagent itemは持ち込まない。
- [OpenCode session API](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)
  はSession message一覧と個別messageを分け、messageをtyped partとともに返す。Henjiはtimeline summaryと
  item detailを分けるが、OpenCodeのmutable revert/share contractや全message hydrationを採用しない。
- [Prime Agent session format](https://github.com/PrimeIntellect-ai/prime-agent/blob/878410b3981f20c6d685faa210ad0e43426cf483/packages/coding-agent/docs/session-format.md)
  と[CLI](https://github.com/PrimeIntellect-ai/prime-agent/blob/878410b3981f20c6d685faa210ad0e43426cf483/packages/coding-agent/README.md)はappend-only entryの
  stable ID、interactive `/tree`、session選択、self-contained HTML exportを持つ。Henjiはstable entry identity、
  interactive navigationとexportの分離を参考にするが、branch/tree、fork、message削除、旧version migration、
  HTML rendererを要求しない。
- 参照実装の表示分類、paging、treeをHenjiのstorage authorityにしない。Henjiではschema v3のcanonical turnと
  execution journalが正本であり、human documentはそこから再生成できるprojectionである。

## Product contract

### 1. `HumanHistoryProjector`とread port

- `HumanHistoryProjector`をHost-ownedの純粋なprojectionとして追加し、SQLite row/event/context/evidenceから
  data-only `HumanHistoryDocumentV1`、summary block、detail block、search hitを作る。
  `ModelContextProjector`、Worker runtime、provider adapter、TUI rendererをimportしない。
- `HistoryPersistencePort`へhuman表示都合を混ぜず、read-only `HumanHistoryReadPort`を分ける。SQLite実装は
  Session IDとopaque cursorを受け、executionを`turn, created_at, execution_id`の安定順でkeyset paginationする。
  workspace全executionの読込とSurface側filter、OFFSET依存の全件scanを通常page pathに使わない。
- 各executionに、stable execution ID、turn、同一turn内のattempt ordinal、created/settled time、lifecycle、outcome、
  adoption、context/evidence/diagnostic captureを持たせる。同じturnの失敗attemptと後続canonical attemptを一件に
  上書きしない。
- canonical executionの会話本文は`canonical_turns` / `canonical_messages`をadoptionの正本とする。execution journalは
  progressと詳細へのlinkに使い、同じuser/assistant/tool内容をmain timelineへ重複表示しない。
- non-canonical/active executionはtask rowとHost-observed semantic journal eventから表示する。累積
  `assistant_progress`と`tool_progress`はmain timelineでは最新snapshotへfoldするが、raw eventはordinal付きdetailから
  到達可能にする。final messageを観測していなければ最新progressを`partial`として表示し、完成文を推定しない。
- tool call/result/effectはcall IDで相関し、main rowにはname、status、短い既存previewを、detailには保存済みarguments、
  result text、outcome、effect ordinal/statusを置く。片側がないcall、`outcome_unknown`、errorを成功扱いしない。
- `/recall`はsource/target executionとprojection kindをlinkとして表示する。projection本文をcanonical messageへ
  複製せず、閲覧から新しいrecallを予約しない。

### 2. 一つの連続documentとTUI操作

- idle時の`/history`で現在のpersistent Sessionの専用full-screen history viewerを開く。`--no-session`では
  `history unavailable with --no-session`を返す。PageUp/PageDownによる現在conversationのretained viewportは変更しない。
- viewerはtimeline blockとdetail blockを一つのlogical document/orderへ置き、terminal幅に応じてその場でwrapする。
  storage batchは画面pageではなくdocumentの前後を追加取得するだけとし、同じentry IDとscalar offsetをviewport anchorに
  使う。resize、detail展開、older batch load後も見ていたrowを維持する。
- initial viewportは最新execution末尾に置く。`Up`/`Down`または`k`/`j`でlogical row、PageUp/PageDownでvisual page、
  `g`/`G`で先頭/末尾へ移動する。`Enter`は選択rowのdetailまたはlink先を開き、`Backspace`/`Esc`は一階層戻り、
  top levelの`q`/`Esc`でviewerを閉じる。
- viewerを閉じると、開く前のdraft、conversation viewport anchor、pending recall、Session bindingをそのまま復元する。
  viewer内のprintable keyを通常task/steeringとして送らない。
- summaryはplain textの既存conversation/tool表現を再利用する。一般Markdown renderer、画像、mouse、横scroll、
  `$VISUAL`/`$EDITOR`起動は追加しない。exact JSON/text detailは既存terminal escapingを通し、保存内容を
  redact、truncate、正規化して別内容にしない。presentation上限を超えるdetailは同じcontent digest/identityの
  scalar-safe chunkとして前後へ移動できるようにし、末尾を捨てない。

### 3. literal keyword検索

- viewer内の`/`で検索inputを開き、Enterで確定、Escで元のviewerへ戻す。`n`は次、`N`は前のmatchへ移動し、
  document末尾/先頭を越えた場合は一回wrapする。queryとmatch数/現在位置をstatusに表示する。
- 検索はcase-sensitiveなUnicode文字列のliteral substringとし、regex、fuzzy、Boolean query、token stemmingを
  解釈しない。空queryは現在検索を解除する。
- search textはtask/steering/assistant text、tool name/arguments/result、execution status、context resourceの
  logical identity/source locator、request lane/purpose/model、evidence/diagnostic ID等、human timelineとそのdetailに
  実際に表示できるsemantic textから同じprojectorで作る。raw SSE frame、parser transition、provider response bytesを
  timeline検索へ重複投入しない。それらはevidence detailでexact readbackできる。
- 未load範囲の検索は同じkeyset batch projectionを順に走査し、match entry IDとscalar offsetを返す。
  全Session documentを一つのstring/arrayへ連結せず、matchへ到達するまでのbatchだけを保持する。
- matchは同じdocument row上でhighlightし、detail内のmatchならそのdetail pathを開いて該当chunkを表示する。
  wrapping前のsource offsetとentry IDを正本にし、terminal幅による位置ずれを検索identityにしない。

### 4. context、request、evidence detail

- execution detailにはmodel/build/Definition、base/committed revision、capture status、tool effect、projection、
  context stage別件数、model request summary、provider evidence/diagnostic/artifact linkを表示する。
- context linkはIncrement 42のimmutable snapshotとrelationを読み、discovered/resolved/loaded/observed/projected、
  logical identity、source locator、call/event/request ordinalを区別する。現在の`AGENTS.md`、`SKILL.md`、registryを
  再読込して過去内容の代替にしない。
- request linkはexecution-local ordinal、lane、purpose、model step/selection、ordered input/tool contract、source
  relationを表示する。`planner`を含むlane/purposeはgeneric labelとして扱い、専用rendererや親子treeを作らない。
- evidence/diagnostic/artifact linkは既存のexact codec/read pathを使う。summaryからdetailへ移動しても
  execution/session identityを維持し、別executionの同じrequest ordinalやcall IDを混同しない。
- invalid digest、row relation、codec、cursorはtyped `history_invalid`としてviewer/exportを失敗させる。
  mutable source、canonical-only transcript、旧storeへfallbackせず、正常rowだけの別履歴を擬制しない。

### 5. durable full-history export

- 現行`/history export`はcanonical-only Markdownとして挙動とformatを維持する。新しい
  `/history export all`は現在persistent Sessionのschema-versioned JSONL exportを新規fileへstreamする。
- export v1はheader/session、canonical turn/message、execution、event、effect、projection、context snapshot/relation/
  request、reachable content、provider evidence、diagnostic、artifactをstable kindとidentity付きrecordとして出力する。
  対象Sessionから到達できない他Sessionのrow/blobを含めない。同じcontent digestはexport内で一回だけ出力する。
- 一つのdeferred read transactionでSession state revisionと末尾execution keyをsnapshot境界としてheaderへ記録する。
  record順はheader、Session metadata、turn/execution order、そのexecutionのordinal/detail、最後にreachable contentの
  digest順へ固定し、finite JSONを一行一record、末尾LFで書く。receiptはpath、snapshot境界、execution count、
  byte length、SHA-256を返す。
- fileは既存history export directoryへunique `createNew`、mode 0600で作り、失敗時のpartial fileは削除する。
  export完了まで全recordをRAMへ保持しない。credential resolver、Authorization/cookie/header、credential fileを
  新たに収集しないが、正本に保存済みのtask/message/tool/provider body等は仮想的なprivate-data懸念で省略しない。
- JSONL exportはreadback/copy/外部解析用であり、SQLite backup、import、restore、migration、互換性保証、
  model context inputではない。exportを実行してもhistory DBへmarkerやreceiptを書かない。

### 6. read-only性、並行性、failure

- viewer、search、detail、exportはSQLiteのdeferred readだけを使い、`BEGIN IMMEDIATE`、UPDATE/INSERT/DELETE、
  reconciliation、Session reopen、Worker activationを行わない。TUIの同一Sessionはidle時だけ操作を受け付ける。
- WAL readerとして別Sessionのwriterと共存し、250 ms busy contractを変えない。大きなdetail/export中もlive DBの
  write lockを保持せず、別Session turnのadmission/event/settlementを阻害しない。
- history readがbusy/invalid/I/O failureならviewerは元画面へ戻れる明示status、exportは失敗結果を返す。
  draft、current Session binding、canonical stateを変更せず、provider requestやtool dispatchをfallbackとして使わない。
- schema v1/v2や未知schemaは引き続き`history_invalid`である。Increment 43はschema v3の破壊的cutover方針を
  変更せず、migration/compatibility readを追加しない。

## 実装slice

### Slice A — human read model

1. `HumanHistoryReadPort`、document/block/detail/search/export recordのdata-only V1 contractを追加する。
2. schema v3へSession-scoped keyset queryと、canonical/non-canonical executionを同じ順序で読むSQLite adapterを追加する。
3. canonical message、semantic journal、tool effect、projection、context/request/evidenceをstable blockへ写す
   `HumanHistoryProjector`を実装する。schemaは変更しない。

### Slice B — TUI viewerと検索

1. `/history`とhistory viewerのpresentation intent/result/stateを追加し、現在Sessionの末尾を開く。
2. 同一document上のwrap、viewport anchor、前後batch load、navigation、detail/link stack、close時復元を実装する。
3. `/` literal search、`n`/`N`、wrap、highlight、未load batch searchを同じprojectorへ接続する。

### Slice C — exact detailとfull export

1. tool/context/request/evidence/diagnostic/artifactのchunked exact detailをviewerへ接続する。
2. canonical-only `/history export`を維持し、`/history export all`のstreaming JSONL writerとreceiptを追加する。
3. read-only failure、`--no-session`、別Session writerとの並行性をproduction adapterへ接続する。

### Slice D — stable candidateとproduction受入

1. READMEにtimeline、read-only性、検索key、detail、二種類のexport、planner非依存境界を記載する。
2. focused test、変更した既存TUI/history/SQLite経路の関連regression、check/format/lint、`git diff --check`を完了する。
3. stable candidateのbounded第三者reviewを行い、採用findingを修正する。
4. stable candidateに対するauthoritative `v0:gate`を一回だけ実行する。
5. isolated state/workspace、standalone real TTY/providerでproduction Human Gateを行う。

利用者承認後はSlice A〜Dを継続し、下記Human Gateまたは停止条件でだけ利用者へ戻す。

## Verification

新しい`tests/v0/increment_43_human_history_view_test.ts`とfocused taskで、次のproduct動作を確認する。

- 一Sessionにcanonical completed、cancelled/failed/interrupted non-canonical、同じturnの複数attempt、`/recall`
  source/targetを作り、execution順、attempt、outcome/adoption、canonical message、partial assistantを重複や推定なしで
  一つのtimelineへ投影する。
- assistant/tool progressの累積snapshotはmain rowでfoldされ、exact raw event、tool arguments/result、effect
  `outcome_unknown`はdetailでordinal/call IDを保つ。大きなdetailは全chunkを前後移動でき、末尾を失わない。
- contextの各stage、loaded/observedの原因request、ordered request input、model selection、provider evidence、
  diagnostic/artifact linkが同じexecution identityから辿れる。mutable sourceを編集しても表示は保存済みsnapshotのままである。
- `/history`が最新末尾を開き、row/page/先頭末尾移動、detail stack、terminal resize、older batch追加後も同じanchorを
  保つ。閉じた後のdraft、retained conversation viewport、pending recall、Session bindingが不変である。
- literal検索がsummary、tool detail、context/request labelの既知nonceへ前後移動し、wrapしてhighlightする。
  regex風文字をliteralに扱い、no-match、空解除、detail内match、未load範囲を同じdocument identityで処理する。
- viewer/search/detail中のmodel/provider/tool request countが0で、Session revision、canonical turn/message、execution
  adoption/context rowがbyte/row単位で不変である。
- `/history export`の既存canonical Markdownがbyte contractを維持し、`/history export all` JSONLは対象Sessionの全executionと
  reachable detailを一回ずつ含み、別Sessionを含めず、record順、SHA-256、byte lengthがreadbackと一致する。
  export failureはpartial fileを残さない。
- 十分に長いSessionと現行上限のmessage/tool/contextを使い、initial view、older load、末尾までの検索、detail、exportの
  elapsed timeとpeak RSSを観測する。全履歴一括materializationをtest fixtureの都合で実装しない。
- viewerまたはfull exportが一Sessionを読んでいる間に別process/別Sessionでadmission、large context append、settlementを行い、
  writerが250 msを超えてblockせず、両Sessionのrowが完全である。
- `--no-session`、unknown Session/cursor、tampered event/context/blob、schema v1/v2が明示failureになり、旧store、
  mutable source、canonical-only viewへfallbackしない。
- 保存済みrequestの`lane=planner`等はgeneric request labelとして読めるが、planner専用tree/操作/result rendererを要求しない。

実装中はIncrement 43 focused testと、変更する具体的な経路に対応するTUI retained terminal/controller/presentation、
history export、Increment 38 recall、40 SQLite、41 journal、42 context attributionの関連testだけを必要時に実行する。
stable candidate前に`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を行う。reviewerはfull gateを実行せず、
coordinating ownerがauthoritative `v0:gate`を一回だけ実行する。

## Production Human Gate

- empty isolated XDG stateとstandalone candidateを使い、real TTY/providerで固有nonceを含むmulti-tool canonical
  execution、tool中cancelまたはprocess停止によるnon-canonical execution、そのsourceを`/recall`したcanonical
  executionを現在Sessionに作る。installed binaryは置換しない。
- `/history`を開き、canonical/non-canonical、同じturnのattempt、outcome、tool summaryを一つのtimelineで確認する。
  nonce検索の前後移動、tool detail、context stage、request input/model、provider evidence/diagnostic linkを実際のkeyで辿る。
- viewerを閉じ、事前に置いたdraftとconversation位置が保持されることを確認する。閲覧前後のSession revision、
  canonical message数、execution adoption、provider request数をreadbackし、閲覧によるwrite/requestが0件であることを確認する。
- `/history export`と`/history export all`を実行し、前者がcanonical-only Markdown、後者がnon-canonical、projection、
  context/request/evidenceを含むvalid JSONLで、receiptのbyte length/SHA-256と一致することを確認する。
- 同じworkspaceの別Sessionを第二processで通常実行しながらviewer/search/exportを操作し、双方がbusy timeoutや
  partial writeなしで完了することを確認する。
- credential値、Authorization/cookie/headerは表示しない。通常のtask/message/tool/provider bodyは正規の履歴内容として
  確認し、仮想的なprivate-data懸念による別sanitization受入へ置き換えない。

## 完了条件

- canonical/non-canonical executionを同じSessionの一つのhuman timelineとして識別して辿れる。
- task/assistant/tool/outcomeからcontext、request、projection、evidence/diagnosticへstable identityで移動できる。
- 閲覧とliteral検索が同じ連続document、wrap、viewport anchorを使い、長期履歴を一括materializeしない。
- viewer/search/detail/exportがread-onlyで、canonical state、model projection、Worker/provider/toolを変更しない。
- canonical-only Markdown exportを維持し、durable Session全体のexact streaming JSONL exportが成立する。
- planner固有の現行構造を新history contractへ固定せず、保存済みlane/purposeだけをgenericに表示する。
- focused/関連検証、check/format/lint、`git diff --check`、第三者review、一回のauthoritative `v0:gate`、
  standalone production Human Gateが完了する。

## 対象外

- plannerの削除、再設計、別process/Session化、非同期・並行subagent、親子Execution、fork/join、result合流UI。
- historyからの`/recall`実行、canonical/non-canonical変更、retry/resume/replay、execution削除、message編集。
- model向けhistory search/tool、model context projection、checkpoint/compaction、`/rebuild`、Agent context transition。
- SQLite schema v4、FTS index、migration、conversion、compatibility read、旧JSON/旧DB fallback、自動削除。
- general Markdown/HTML/image renderer、mouse、横scroll、branch/tree、diff view、cost/usage集計、cross-workspace検索。
- full exportのimport/restore、SQLite backup、portable Session transport、長期互換性保証、外部serviceへのshare。
- architecture、構想、roadmap、installed binary、commit、push、tag、publish、releaseの変更。

## 実装・検証結果

2026-09-13、承認済みSlice A〜Dを実装した。

- data-only `HumanHistoryReadPort` / `HumanHistoryProjector`を追加し、schema v3のcanonical messageと
  canonical/non-canonical execution、semantic event、tool effect、projection、context、model request、provider
  evidence、diagnostic、artifactをSession-scopedな安定順へ投影した。schema、migration、compatibility read、planner固有
  contractは追加していない。
- 通常TUIの`/history`に、一つの連続documentとして動くread-only viewerを接続した。logical row／visual page／先頭末尾
  navigation、stable entry/scalar anchor、adjacent storage batchの追加読込、exact detail stack、Unicode scalar-safe chunk、
  case-sensitive literal検索と同一entry内の複数occurrence navigationを実装した。viewerを閉じると既存conversation
  viewportへ戻り、履歴操作をtaskやsteeringとしてdispatchしない。
- 現行のcanonical-only Markdown `/history export`を維持し、`/history export all`へSession-scoped、schema-versioned、
  deterministic JSONL streaming exportを追加した。deferred read snapshot、stable record order、reachable contentのdigest単位
  deduplication、unique mode 0600 file、byte length／SHA-256 receipt、failure時partial cleanupを実装した。
- evidence、diagnostic、artifact detailは既存codecで検証してから表示し、tampered rowを`history_invalid`にする。
  READMEへ操作、二種類のexport、read-only性、planner非依存境界を記載した。architecture、構想、roadmap、installed
  binaryは変更していない。

Increment 43 focused test 2件、関連TUI test 46件、Increment 40 regression 14件、Increment 41 regression 12件、
Increment 42 regression 26件が成功した。`v0:check`、format、lint、`git diff --check`を完了し、最終candidateに対する
authoritative `v0:gate`は一回目で成功した。途中のfocused確認で`/tmp`容量不足を観測したため、再生成可能な旧build
artifact一件を削除し、別の既存artifact一件をchecksum照合付きで一時退避・復元してからfull gateを実行した。full gateの
再実行はしていない。

### Production Human Gate結果

source `671670c53beb7147570e12cff888d0ef4f43ee26+dirty`からbuild ID
`2c1a6f4e325e44bd85d8d134eabc944c68ffae160fad7bca420b1b493326865a`、SHA-256
`708e91c79200eb479739a8e7de0294f14d3389f239243075099bf4ce37970cb1`のstandalone candidateを作り、empty
isolated XDG state、独立workspace、real TTY、OpenRouter `deepseek/deepseek-v4.1-flash` highで確認した。

- Session `2cf873b1-761a-4e1b-8eec-7494da0884a3`に、multi-tool canonical execution、tool中Escでsettleした
  cancelled/non-canonical execution、そのexecutionを`/recall`したcanonical executionを作った。SQLite readbackでは
  turn 1 attempt 1がcompleted/canonical、turn 2 attempt 1がcancelled/non-canonical、turn 2 attempt 2が
  completed/canonicalで、recall projectionはsource executionへ`linked`だった。
- `/history`は上記3 executionを同じtimelineに表示し、cancelled task nonceの前後occurrenceへ移動できた。cancelled
  bash detailはcall ID、requested ordinal 245、completion/resultなし、effect status `observed_requested`を表示した。
  context、request、evidence、diagnostic、artifact、projectionの各linkも同じexecution identity上に表示された。
- canonical-only Markdownは2 canonical turnだけを出力した。full JSONLは1826 record、5,904,242 byte、SHA-256
  `08fee5bb4f14719cf3767ec23ccffd262b361b3047f30f7df4cc2707518edb6b`でreceiptと一致し、3 execution、4 model
  request、3 evidence、168 context relation、1 diagnostic、1 projectionとreachable contentを含んだ。
- 同じworkspace/stateの第二processで別Session `3de4cab9-2830-490e-90d4-731bf7d73c6d`を通常起動し、20秒の
  bash turnを実行中に第一processでviewerとfull exportを操作した。第二Sessionはcompleted/canonicalになり、第一Sessionの
  再exportも同じ1826 record／byte length／SHA-256で完了した。JSONLに第二Session IDはなく、双方にbusy timeout、
  partial write、provider/tool replayはなかった。
- DBはschema v3、第一Sessionはstate revision 3／canonical turn 2／canonical message 6／execution 3／model
  request 4、第二Sessionはrevision 2／canonical turn 1／message 4／execution 1だった。履歴操作による第一Sessionの
  revision、adoption、execution、request追加はなく、二つのJSONLとMarkdownはすべてmode 0600だった。credential値は
  読み出さず、TTYへAuthorization/cookie/headerは表示されなかった。installed binaryのSHA-256は既存の
  `5b32dce0c17f53ae321587de1aabcc0e3e7303cf87239e7d170948b74051bd11`のままで置換していない。

### Installed binaryでの通常利用確認

利用者の指示により、上記Human Gate済みcandidateで`dist/henji`と`~/.local/bin/henji`をatomicに置換した。
通常利用で作成したSession `44966747-ae25-4e81-9dc5-996ff21dbeb6`をCLIとSQLiteのread-only queryで照合し、
次を確認した。

- schema versionは3、`PRAGMA quick_check`は`ok`、foreign key違反は0だった。
- canonical turn 2件、message 8件、execution 2件が一致し、両executionともsettled／completed／canonicalだった。
  activeまたはnon-canonicalな余剰executionはなかった。
- model request 4件、tool effect 3件、execution evidence／artifact／complete context captureが保存され、tool effectは
  すべてsuccessだった。
- turn 1はOpenAI `gpt-5.6-sol` medium、turn 2と最終Session selectionはOpenRouter
  `deepseek/deepseek-v4.1-flash` highで、通常TUI上の会話と一致した。
- 最終turnのcommitted revision 5よりSession state revisionが6であるのは、turn完了後のSession metadata更新時刻と
  一致し、canonical turnやexecutionの追加ではなかった。

2026-09-13、利用者はこの通常利用確認を踏まえ、Increment 43の完了を確認した。

## 第三者review

2026-09-13、stable candidateのhuman document、paging、search、exact detail、export、TUI integrationを対象にbounded
read-only reviewを行った。Blockerはなく、次のfindingを採用した。

1. storage batch切替で既読documentを置換し、PageUpをvisual rowではなくstorage pageとして扱っていたため、P1として
   adjacent batchをstable entry順へmergeし、entry ID＋scalar offsetをanchorにしたvisual page移動へ修正した。
2. summary外detailの検索結果が開かれず、同一entry内の複数occurrenceを区別できなかったため、P1としてoccurrenceの
   scalar offsetをsearch identityへ加え、該当detail/chunkを開いて`n`/`N`で移動するよう修正した。
3. evidence/diagnostic/artifact detailが既存codec validationを迂回していたため、P2として各codecのexact read pathを通し、
   invalid rowを`history_invalid`にした。

focused regressionを追加後、一回のbounded re-reviewで3 findingの解消を確認した。新しいBlocker/P1はなかった。

## Human Gateと停止条件

- この初期計画は2026-09-13に利用者が承認した。
- 利用者承認後はSlice A〜Dを継続する。schema v3から要求されたsemantic historyを正確にprojectできない、
  schema変更/FTS永続indexが必要、planner再設計の未決contractを先に固定する必要がある、またはarchitecture、roadmap、
  対象機能、exportの意味、human操作、受入水準を変える必要が判明した場合は停止し、観測証拠と代案を利用者へ返す。
- repository外のinstalled binary置換、commit、push、tag、publish、releaseは別の利用者指示を必要とする。
