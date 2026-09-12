# Increment 38 — stopped execution recall

ステータス: **完了（2026-09-12）**

基準commit: `e789b75c`

対象機能: F02、F05、F10、F13、F15

## 利用者が必要とする動作

- 長いassistant出力やtool実行を含むturnをcancelするか、turnがfailureで停止した後、そのexecutionで既に
  得られた情報について次のAIへ質問・指示できる。
- production TUIで`/recall`を実行すると、現在Sessionで直近の`uncommitted` executionを選び、次に送る
  通常taskだけへそのcontextを渡せる。`/recall <id>`ではcurrent Session内の特定executionを選べる。
- AIへ渡すcontextは、元の指示、完了したassistant step、tool
  call/result、未完了箇所、停止理由を区別し、 未完了toolが成功したとも失敗したとも推定しない。
- recallは停止turnを遡ってcommitせず、toolを自動再実行しない。recallを使った新turnが成功した場合だけ、
  その新turnを既存経路でatomic commitする。
- 人間は、どのexecutionが次taskへ使われるかと、実際に投影されたcontextをexecution
  readbackから確認できる。

## 根拠と確認済みの現在地

- 2026-09-12の通常利用後、長いtool
  callやassistant進捗の途中でcancelまたはfailureによりturnが停止し、
  その直後に停止turnについて質問する利用形態を検討した。現行Henjiは`uncommitted` turnを次のmodel
  contextへ含めないため、TUIに途中経過が見えていてもAIはそれを会話記憶として参照できない。
- 現行のHost-owned execution artifact v2は、execution
  ID、元task、Session/turn/build/Definition相関、
  settlement、停止理由、tool件数を保存するが、個々のassistant step、tool
  call/result、progress本文は持たない。
- provider evidence v2は、完了したprovider-neutral `model_result`、`tool_call`、`tool_result`と、raw
  request、 response、SSE、parser
  transitionを停止turnでもsettlement時に保存する。現在の`assistant_progress`と
  `tool_progress`はTUIへ配送するだけで、provider-neutral runtime eventとしては保存しない。
- execution artifactからprovider evidence IDを引けるため、gracefulなcancel、provider
  failure、contract failure、max step停止については、二つを相関してrecalled
  contextを組み立てられる。Workerまたはprocessが
  settlement前に突然失われる場合は、現行artifact/evidence自体が残らないことがあり、別の逐次journalが必要である。
- 現行TUIの`/recover`は、未commitの元task、steering、follow-upをeditorへ戻すHost-local入力操作である。
  execution
  contextをmodelへ渡す機能ではないため、意味と既存操作を保ったまま新commandを`/recall`とする。

## 参照実装から採用する境界

- Zotの`rescue turn`はprovider
  failure後に人間が別modelを選び、元promptを再実行する近いSurfaceを持つが、 completed tool
  resultの選択的な採用ではない。Henjiはprompt再実行ではなく、新taskへのcontext投影とする。
- OpenCode V2はcompleted local toolをdurableに投影し、残ったrunning
  toolを`interrupted`として確定し、 explicit runからprojected historyを続行する。一方、post-crash
  continuationは未実装と明記している。
- Pi durable harnessはunsafeなorphaned toolをpartial output付きsynthetic interruption
  resultとして確定するが、 user commandではなくruntime recoveryである。
- Henjiではこれらをそのまま導入せず、人間の明示的なselection、no automatic replay、atomic canonical
  transcriptという現行境界へ合わせる。

## 実際のproduct経路

```text
stopped Worker turn
  → Host settlement
  → provider evidence + execution artifact
  → TUI /recall [id]
  → Host resolves one current-Session uncommitted execution
  → staged recalled context
  → next ordinary task admission
  → data-only Worker turn command
  → recalled context is projected before the current user task
  → provider request
  → success: ordinary atomic Session commit
  → target execution artifact records source ID and exact projection
```

Source execution、provider evidence、failure
diagnosticは変更しない。TUIはstoreを直接読まず、Host-owned session/application
operationをPresentation intent経由で呼ぶ。Workerはfilesystem上のartifact storeを読まず、
admit済みのdata-only recalled contextだけをmodel requestへ投影する。

## Product contract

### 1. Recall対象と選択

- recall対象はcurrent workspaceかつcurrent persistent
  Sessionに属し、`settlement = uncommitted`で確定した Worker
  executionとする。`committed`と`committed_generation_unavailable`は既にcanonical transcriptへ
  commit済みなので対象にしない。
- `/recall`は`settledAt`が最新の対象を一件選ぶ。`/recall <id>`はfull UUIDまたは一意な8文字以上の
  execution ID prefixをcurrent Session内で解決する。該当なしと複数一致を区別して表示する。
- execution artifactだけが読め、provider evidenceがない場合も、元task、停止理由、件数、evidence
  unavailableを
  含む限定contextとして選べる。存在しない内容を補完せず、利用できる情報が限定的であることを人間とmodelへ示す。
- selectionはTUI/Host process内のcurrent Sessionにscopeされた一件のpending
  recallとする。二回目の`/recall`は selectionを置換する。Session
  switch、`/new`、shutdownで破棄し、durable Session stateには書かない。

### 2. Modelへ投影する内容

- provider-neutralな`RecalledExecutionContextV1`を導入し、source execution
  ID、Session、turn、settlement、 stop reason、元task、停止error、時系列のcompleted assistant
  text、tool call arguments、tool results、 incomplete assistant/tool progressを区別して持つ。
- evidence v2からは既存のcompleted
  `model_result`、`tool_call`、`tool_result`を使う。実装後のevidenceには、
  TUIへ実際に受理された最新の`assistant_progress`と各toolの最新`tool_progress`もprovider-neutral
  eventとして 保存し、settlement時点で未完了なら明示的なpartial observationとして使う。
- tool call/resultは`callId`、name、model
  step、観測順で対応付ける。resultのないcallはincomplete、resultを
  受け取ったcallだけcompletedとする。toolの外部effectとSession
  commitはtransactionalではないことも示す。
- Hostはtool resultやvisible progressを要約・推測・書換えず、保存済み本文をexactに投影する。raw HTTP
  header、raw SSE framing、parser内部event、provider-native reasoning/replay stateは診断・provider
  continuation用の evidenceに留め、recalled contextへは混ぜない。
- current user taskのcanonical textは変更しない。Workerは各model requestを作るときだけ、current
  turnのuser message直前に明示的なreference contextとして投影する。system instructionへtool
  outputを埋め込まず、 current turnのprovider-neutral user contextとしてlowerする。
- 投影には「referenceであり新しいtool resultではない」「incomplete
  itemのoutcomeは不明」「同じtoolを自動的に 再実行しない」を明示する。再実行するかは、recalled
  contextと新しいuser taskを受けたmodelの通常判断に委ねる。

### 3. Atomic historyとreadback

- source failed turnは`uncommitted`のまま保持し、canonical transcriptへmessageまたはtool
  pairを追加しない。
- pending recallは次のordinary task admissionで一回だけ消費する。slash command自体はmodel
  request、execution artifact、provider evidenceを生成しない。
- recalled contextはmodel request用のturn-local projectionであり、synthetic messageとしてcanonical
  transcriptへ 保存しない。新turnが成功した場合、現在のuser taskと実際のassistant/tool
  transcriptだけを一括commitする。
- recalled contextを使った新executionのartifactは、source execution IDとmodelへ渡したexact
  projectionを保持する。 source/target、Session、turn、build、Definition、provider
  evidenceをdiagnosticsから相関できるようにする。
- Worker execution artifactは新versionでrecall attributionを表し、既存v2
  artifactを引き続きlist/show/recall sourceとして読める。provider evidenceもprogress
  eventを表す新versionと既存v2のreadbackを両立させる。
- `automaticReplay: false`と`effectCommitRelation: not_transactional`を維持する。recall
  selectionまたは次taskの admissionだけでsource toolをdispatchしない。

### 4. TUI操作

- fixed slash
  grammar、候補、helpへ`/recall`と引数付きgrammarを追加する。既存`/recover`の意味、入力lane、
  表示、再送動作は変更しない。
- idleでだけrecallを解決する。busy中はcommand
  textをeditorへ残し、`busy; /recall waits for ready`を表示する。 persistent Session/evidence
  authorityがない`--no-session`ではmodelへ送らず`recall unavailable`と表示する。
- selection成功時は`recall <short-id> ready · next task only`をfooter/statusへ表示し、次のordinary
  taskが 消費するまで人間が確認できるようにする。idle Ctrl-Cはeditor textとpending
  recallをclearする。
- invalid、not found、ambiguous、artifact/evidence read failureでは現在のSession、editor、canonical
  transcript、 既存pending inputを変えず、短いreasonを表示する。

## 実装slice

### Slice A — durable evidenceとrecalled context projection

1. provider evidenceへaccepted assistant/tool progressのprovider-neutral
   snapshotを追加し、新旧evidenceを readbackできるversioned codec/storeへ更新する。raw provider
   captureとcredential/Authorization非保持は維持する。
2. execution artifactとprovider evidenceをcurrent Sessionで相関し、時系列のcompleted/incomplete
   itemから `RecalledExecutionContextV1`とexact projection textを作るHost-owned
   operationを追加する。
3. Worker turn protocolへoptionalなdata-only recall contextを加え、run loopのscratch
   transcriptとcanonical proposalを変えず、model request上のcurrent user message直前だけへ投影する。
4. target execution artifactの新versionへsource IDとexact projectionを保存し、既存v2
   artifactのlist/showと source利用を維持する。
5. provider-free focused testで、cancel/failure前のcompleted tool resultとpartial
   progressの区別、次requestへの 一回だけの投影、source transcript非commit、tool
   dispatch非発生、target attributionを確認する。
6. focused test、対象type check、format、lint、`git diff --check`を実行し、Slice
   Aの区切りで停止する。

### Slice B — `/recall` TUI Surfaceと文書

1. Presentation intent/session application operationへcurrent-Session recall
   selectionを接続し、TUIがstoreや Worker handleを直接所有しない構成を維持する。
2. slash parser、候補、help、idle dispatch、busy待機、ID prefix、pending表示、Ctrl-C clear、Session
   binding replacement時のclear、`--no-session`表示を実装する。既存`/recover`は独立したinput
   recoveryとして維持する。
3. READMEへ`/recover`と`/recall`の違い、latest/ID selection、next-task-only、no automatic
   replayを記載する。
4. focused product testで、直近selection、明示ID selection、次task一回だけの消費、既存recoverable
   inputとの 非混同を確認する。実装した実利用経路に対応しない状態matrixは追加しない。
5. `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`と差分reviewを完了後、stable candidateへ
   authoritative `v0:gate`を一回だけ実行し、Slice Bの区切りで停止する。

### Slice C — production retained-TUI Human Gate

1. clean buildのstandalone binaryをisolated XDG state/data rootのreal TTYで起動する。
2. real providerへread-only workspace調査taskを送り、一件以上のtool resultまたはvisible
   progressを確認してから turnをcancelする。source execution、provider evidence、failure
   diagnosticをreadbackする。
3. `/recall`を実行し、source short
   IDとnext-task-only表示を確認する。続けて「直前の調査で何が完了し、何が
   未完了か」を質問し、AIが保存済み事実と停止状態を区別して答えられることを人間が確認する。
4. source executionがuncommittedのまま、source
   toolがrecall操作だけでは再実行されず、成功した新turnだけが canonical
   transcriptへcommitされたことをSession、execution artifact、provider evidenceから確認する。

利用者の既存指定に従い、各sliceの実装・focused検証・checkpoint更新が完了した時点で停止する。

## Slice checkpoint

### Slice A — 完了（2026-09-12）

- provider evidenceをschema v3へ更新し、TUI配送に成功したassistant/tool progressの最新snapshotとlaneを
  provider-neutral runtime eventとして保存する。既存schema v2はlist/read/recall sourceとして維持した。
- Host-owned `resolveRecalledExecutionContext`がcurrent Sessionのuncommitted execution artifactとevidenceを
  ID、turn、build、Definitionで相関し、completed assistant/tool result、incomplete tool/progress、停止理由を
  `RecalledExecutionContextV1`へ変換する。evidence不在時はartifactだけの限定contextを明示する。
- Worker turn protocolへoptionalなdata-only contextを追加した。recall projectionは各model requestでcurrent taskの
  直前へ置き、semantic checkpointとの併用でも位置を維持する一方、scratch/canonical transcriptには追加しない。
- Worker execution artifactをschema v3へ更新し、target executionにsource execution IDとexact projection textを
  保存する。schema v2 artifactのcodec/store/readbackは維持し、`automaticReplay: false`と
  `effectCommitRelation: not_transactional`は変更していない。
- Increment 38 focused test 5件、Worker foundation 39件、provider stream compatibility 20件、production CLI E2E
  contract 5件が成功した。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功した。
- `/recall`のlatest/ID selection、pending state、slash/TUI Surface、README、authoritative `v0:gate`、production
  Human Gateは、このSlice A checkpoint時点では計画どおり未実施だった。

### Slice B — 完了（2026-09-12）

- `WorkerHostSession`へcurrent Sessionのsettled `uncommitted` executionをlatestまたは一意なID prefixで選ぶ
  pending recallを追加した。selection解決が失敗した場合は既存selectionを保ち、次のordinary task admissionで一回だけ
  消費する。idle Ctrl-C、Session replacement、shutdownでは破棄する。
- Presentation intent経由でHost operationをTUIへ接続し、`/recall`、`/recall <execution-id>`、候補、help、
  `recall <short-id> ready · next task only`表示を追加した。busy中はeditorへ残し、`--no-session`ではproviderへ送らず
  unavailableを表示する。`/recover`は入力回復操作のまま変更していない。
- READMEへ`/recover`との違い、latest/ID selection、next-task-only、source非commit、no automatic replayを記載した。
- Increment 38 focused test 6件、retained TUIとslash parser 41件、Increment 35 regression 2件が成功した。
  `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功した。
- stable candidateに対するauthoritative `v0:gate`を計画どおり一回だけ実行し、全187 testが成功した。

### Slice C — 完了（2026-09-12）

- 未commit差分からbuild ID
  `3e9d3f562cb4a3fe7dfb7f70ee1e03741dde7153b1520a4ad693717b472a4acc`のstandalone binaryを作り、isolated
  XDG state/data rootのreal TTYでOpenRouter `deepseek/deepseek-v4.1-flash`を使用した。installed binaryは置換していない。
- read-only調査turnは4件のtool call/resultを保存した後、利用者cancelを契機に
  `contract_failure: cancellation cleanup failed`で停止した。source execution
  `461ac88c-be05-4ed8-b2aa-464511d77091`は`uncommitted`、provider request 3件のまま保持され、failure diagnostic
  `e08a9e5b-a4ef-4177-9bc6-5dd3d68d968d`をCLIからreadbackできた。
- `/recall`は`recall 461ac88c ready · next task only`を表示した。selection操作だけでは新しいexecutionやprovider requestを
  生じず、次taskを受けたAIは保存済みのread結果、失敗したsource探索、未完成の最終結論、停止理由を区別して回答した。
- target execution `52055334-206a-495a-abf5-c5606ba287ec`だけが`committed`になり、source IDとexact projectionをartifactへ
  保持した。target provider requestは1件で同じprojectionを含み、tool call/resultは0件だったためsource toolの自動再実行は
  なかった。canonical transcriptはtarget user/assistantの2 messageだけで、source user turnとsynthetic recall messageを
  採用していない。
- Human Gateの`/recall`動作、保存情報の区別、source非commit、no replay、targetだけのatomic commitは成功した。
  cancel自体が`cancelled`ではなくcleanup failureになった事象はIncrement 38の機能不良と混同せず、後続の
  Increment 39で修正・受入した。

## Review結果

- product contract、production経路、変更差分を照合し、Increment 38にBlockerまたはcorrectness findingは見つからなかった。
- source artifact/evidenceは不変、recall projectionはturn-local、target attributionはexactであり、現行のatomic canonical
  transcriptと`automaticReplay: false`を維持している。
- schema v2 artifact/evidenceのreadback、checkpoint併用時のprojection位置、`/recover`、`/new`、Session navigation、
  `--no-session`、busy操作の具体的regressionはfocused testと一回のauthoritative gateで確認した。

## Verification

- recall source: current Sessionのuncommitted executionだけをlatestまたは一意ID prefixで選べる。
- content: completed assistant/tool item、partial progress、incomplete call、stop
  reasonを保存済み証拠どおり区別する。
- projection: 次のordinary taskのmodel requestに一回だけ入り、provider request evidenceとtarget
  execution artifactから exact内容をreadbackできる。
- atomicity: source turnを変更せず、recall操作だけではtool/provider/Session
  commitを発生させず、新turn成功時だけ canonical transcriptを一括commitする。
- regression: `/recover`、cancel settlement、ordinary turn、Session switch/new、evidence/execution
  diagnostics、 both provider request loweringを維持する。
- production: retained TUIで実際にtool/progressを持つcancel要求後のuncommitted turnをrecallし、次のAIがその内容へ
  回答できる。今回のsource settlementは別途記録したcleanup failureだった。

実装中は変更箇所のfocused test、必要なtype
check、format、lint、`git diff --check`だけを使い、`v0:test`と `v0:gate`を繰り返さない。stable
candidateに対するauthoritative `v0:gate`はSlice Bで一回だけ実行する。 production Human Gateはoffline
gateへ接続せず、Slice Cで利用者の続行指示後に一回実行する。

## 完了条件

- production TUIの`/recall`または`/recall <id>`でcurrent Sessionのsettled uncommitted
  executionを選べる。
- 次のtaskを受けたAIが、sourceの元指示、完了済みtool result、partial/incomplete
  item、停止理由を区別して参照できる。
- recallがsource failed
  turnをcommitまたは変更せず、toolを自動再実行せず、次task以外へ暗黙に残らない。
- successful target turnだけが既存のatomic commitを通り、source execution IDとexact
  projectionをreadbackできる。
- existing artifact/evidence、`/recover`、Session navigation、両provider、standalone
  production経路の具体的regressionがない。
- focused確認、type check、format、lint、`git diff --check`、一回のauthoritative
  `v0:gate`、production retained-TUI Human Gateが完了する。

## 対象外

- settlement前のprocess crash、power loss、Host killを復元するappend-only execution
  journalとrecord-before-effect。
- stopped turnの遡及的なpartial commit、同一turn continuation、automatic retry、tool replay、effect
  rollback。
- committed
  turnの再注入、別workspace/別Sessionからのrecall、複数executionの同時合成、recall履歴picker。
- raw provider reasoning state、encrypted/replay item、raw SSE、HTTP payloadをmodel
  contextへ再注入すること。
- canonical transcriptのSQLite化、一般的なevent sourcing、tool並列化、Context Strategy外部化。
- architecture、roadmap、構想の変更、installed binary置換、commit、push、tag、publish、release。

## Human Gateと停止条件

- この初期計画に対する利用者の明示承認前は、code、test、README、build taskを変更しない。
- 利用者は2026-09-12に初期計画を承認し、その後、使用量回復時にSlice B、Slice C、test、reviewまでの続行を指示した。
- Slice A〜C、focused verification、一回のauthoritative `v0:gate`、production Human Gate、差分reviewは完了した。
- production provider callとreal-TTY操作はSlice
  Cの続行指示後だけ行い、credential値とAuthorizationを表示・記録しない。
- settled uncommitted executionの保存済み証拠からproduct動作を成立させられないこと、canonical
  transcriptの atomicityまたはno-replayを維持できないこと、process-crash
  journal、architecture、roadmap、外部contract、
  受入水準の変更が必要になった場合は実装を止め、観測証拠と修正案を利用者へ返す。
