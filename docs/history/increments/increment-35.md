# Increment 35 — TUI `/new` Session creation

ステータス: **完了**

基準commit: `d570ace0`

対象機能: F01、F04、F05、F10

## 利用者が必要とする動作

- Henji processを終了・再起動せず、production TUIの`/new`から現在のworkspaceに新しいpersistent
  Sessionを作成し、そのSessionへ切り替えられる。
- 新しいSessionではconversation、context checkpoint、title、turn countを空の状態から始める一方、現在選択中の
  exact Agent Definition revisionとroot provider/model/effortを引き継ぎ、意図しない実行条件の変更を起こさない。
- 切替前のcommitted Sessionは保存されたままで、`/sessions`から再開できる。
- `/new`自体をmodelへ送信せず、provider requestなしでSession作成と画面切替を完了する。

## 根拠と確認済みの現在地

- 通常利用メモには、同じworkspaceでprocessを維持したまま`/new`によりpersistent Sessionを作る要望があり、
  active turn、draft、model selectionの扱いが個別incrementの決定事項として残っていた。
- architecture正本では、Sessionがtranscript、context、turn commitを所有し、TUIのdraft、cursor、viewportは
  Host-local stateである。またroot provider/model/effortはHostが所有するsession-level runtime stateである。
- 現行production TUIは`/sessions`から、同じworkspace、Agent role、exact Definition revisionに一致する保存済み
  Sessionへ切り替えられる。Presentationの`session_binding_replaced`と`restored_log`は、Session handleをSurfaceへ
  露出せず、identity、model selection、conversationを更新できる。
- 現行Worker session factoryは新規起動時にSession handleを予約できるが、空Sessionは最初のdurable write前にclose
  するとstoreから消える。`/new`の「persistent Session」は、turnを送らず終了した場合もlist/reopenできる状態として
  明示的にmaterializeする必要がある。
- 現行busy時の`/rename`、`/provider`等はcommandをeditorに残してreadyを待ち、人間がready後に再度Enterして実行する。
  `/new`もこの操作規則へ揃えれば、active turnをcancel、steer、別Sessionへ移動させない。

## Product contract

### 1. Slash commandとadmission

- fixed built-in slash commandへ引数なしのexact `/new`を追加し、候補表示とhelp overlayにも掲載する。
  `/new anything`、case違い、未知commandは既存grammarどおり受け入れない。
- idleでEnterした場合だけ作成を開始する。active turn中は`busy; /new waits for ready`を表示し、`/new`をeditorへ
  残す。active turnをcancelせず、steeringまたはfollow-upにも変換せず、ready後の再Enterを待つ。
- command admission後はeditorの`/new`だけを消費する。実行時に別のvisible draftは存在しないため、他のtextを暗黙に
  新旧どちらのSessionへも移さない。process-local input historyとrecovery laneには既存のSession切替挙動を維持し、
  canonical Session stateへ混ぜない。
- `--no-session`ではpersistent navigation authorityがないため、`/new`をmodelへ送らず
  `new session unavailable`と表示し、現在のin-memory Sessionを維持する。

### 2. 新しいSessionの初期状態

- 現在のworkspace、Agent role、exact `DefinitionRevisionRef`を使って、新しいUUIDのSessionを一件作る。Definitionの
  `latest`再解決、別revision、built-inへのfallbackは行わない。
- root provider/model/effortはcommand admission時のcurrent Session selectionをcopyする。planner default、
  provider timeout、workspace instruction/Skill snapshotなどWorker generation側の既存規則は変更しない。
- transcriptは空、`nextTurn = 1`、committed turn/message countは0、checkpointとtitleはなしとする。旧Sessionの
  transcript、checkpoint、titleをcopyしない。
- 新しいempty Session recordを切替完了前にdurable storeへmaterializeする。`/new`直後にturnを送らず終了しても、
  次回起動のsession listingと`--session`から同じSessionを確認・再開できる。

### 3. Binding replacementと表示

- Host-owned navigation operationがtarget Sessionをallocate、Definition照合、Worker起動、empty recordのdurable化、
  current bindingのclose、target bindingのadoptという責務を持つ。TUIへstore/Worker handleを渡さない。
- 成功時はconversation logを空へ置換し、viewportをlatestへ戻す。footer/startup identityを新しいSession短縮ID、
  inherited provider/model/effort、turn 0へ更新し、`new session ready`を表示する。
- 切替前のcommitted Sessionは変更・削除せず、`/sessions`の一覧とresume経路をそのまま利用できる。
- targetのallocate、Definition照合、Worker起動、empty record durable化が失敗した場合はtargetをclose/cleanupし、
  current bindingと表示を維持して`new session failed; current session unchanged`を表示する。current bindingのclose後に
  継続不能なfailureが起きた場合は、既存navigation fatal経路でTUIを終了し、closed bindingを再利用しない。

### 4. Provider非介入とreadback

- `/new`はprovider/model request、tool call、execution artifact、provider evidenceを生成しない。credentialの有無は
  Session作成可否へ影響させない。
- 新旧Session ID、Definition ref、active model selection、空のtranscript/checkpoint/titleをSession storeと
  Presentation positionから確認できる。credential値やAuthorizationを表示・記録しない。

## 実装slice

### Slice A — Session作成とbinding replacement

1. Session navigation contractとWorker session factoryへ、現在のexact Definitionとroot selectionからdurableな
   empty Sessionを作るHost operationを追加する。
2. Presentation intent/adapterへdata-onlyなnew-session commandとbinding resultを接続し、成功時に空log、position、
   model selectionを一つのbinding replacementとして反映する。
3. target準備failureではcurrent Sessionを維持し、成功後は旧committed Sessionへ`/sessions`から戻れることを
   provider-free focused testで確認する。
4. empty Sessionの即時durability、exact Definition、provider/model/effort継承、title/checkpoint/transcript非継承、
   request count不変をfocused確認する。

### Slice B — TUI操作、文書、product確認

1. slash grammar、候補、help、idle dispatch、busy時のeditor保持、`--no-session` failure表示をproduction TUIへ接続する。
2. retained terminalで新Sessionの空log、Session ID、turn 0、inherited selection、ready statusを確認し、READMEへ
   `/new`の通常操作とbusy/no-session時の挙動を追記する。
3. relevant focused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を完了後、stable candidateへ一回だけ
   authoritative `v0:gate`を実行する。
4. standalone binaryをisolated XDG state/data rootのreal TTYで起動し、provider requestなしで`/new`、終了、Session
   list/reopenを確認する。

利用者の指定に従い、各sliceの実装・focused検証・checkpoint更新が完了した時点で停止する。

## Slice checkpoint

### Slice A — 完了（2026-09-12）

- Worker session navigationへnew-session operationを追加した。current Sessionのexact Definition revisionとroot
  provider/model/effortをcopyしてtarget Workerを準備し、schema v6のempty Session recordをturn 0でdurable化してから
  current bindingを置換する。
- target準備またはdurable化のfailureではtargetをclose/cleanupし、current bindingを維持する。current close後に安全に
  復帰できないfailureは既存のnavigation fatal分類へ接続した。
- Presentationへdata-onlyな`new_session` intentを追加した。成功時は`session_binding_replaced`に続けて空の
  `restored_log`を送り、adapterが新しいcore bindingを所有する。persistence authorityがなければ`unavailable`を返す。
- provider-free focused test 2件で、旧committed Sessionの保持、新しいempty Sessionの即時durability、process終了後の
  reopen、exact Definitionとcustom root selectionの継承、title/checkpoint/transcriptの非継承、request count不変、
  新Sessionから旧Sessionへのresume、target setup failure時のbinding維持を確認した。
- Worker foundation 39件とprovider switching 6件のfocused regressionが成功した。`v0:check`、`v0:fmt`、
  `v0:lint`、`git diff --check`も成功した。slash grammar、busy/no-sessionのTUI表示、README、standalone real-TTY、
  authoritative `v0:gate`は計画どおりSlice Bまで未実施である。

### Slice B — 完了（2026-09-12）

- fixed slash grammar、候補、help overlayにexact `/new`を追加し、idle時のnew-session intentへ接続した。
  busy時は`/new`をeditorに保持してready後の再Enterを待ち、persistent navigationがない場合は
  `new session unavailable`を表示する。
- retained terminalで、active turn完了後の作成、旧conversation logの消去、新Session ID、turn 0、
  inherited provider/model/effort、`new session ready`を確認した。準備failureでは旧Sessionと表示を
  維持する。READMEに通常操作とbusy/no-session時の挙動を追記した。
- focused確認はTUI/slash 38件とIncrement 35のHost/Presentation 2件が成功した。`v0:check`、
  `v0:fmt`、`v0:lint`、`git diff --check`に続き、stable candidateに対するauthoritative `v0:gate`を
  一回だけ実行し、全176 testが成功した。
- build ID `31632f3cb197f431211af7eca366e108e9e44d37e76044dd843e929673ad6819`のstandalone binaryを
  isolated XDG rootのreal TTYで起動した。`/new`は初期Session `7d3241c3`からnew Session `892bafdd`へ
  切り替え、provider credentialがない状態でも成功した。新Session
  `892bafdd-187f-4c1c-b7ca-d0409e391280`はschema v6、`nextTurn = 1`、空transcript、titleなし、
  exact built-in Definition digestとOpenRouter/deepseek/highの選択を保持し、終了後のlistとexact reopenに成功した。
  Session recordとlock以外のexecution artifact/provider evidenceは生成されていない。一時証拠は
  `/tmp/henji-increment-35-acceptance-a6qHOF`に保持している。

## Verification

- command behavior: exact `/new`だけをHost commandとして扱い、busy時はeditorへ保持し、`--no-session`では
  in-memory Sessionを変えない。
- persistence: turn 0の新Sessionが終了後もlist/reopenでき、旧committed Sessionも残る。
- binding: new ID、空conversation、turn 0、title/checkpointなし、同じworkspace/role/exact Definition、inherited
  provider/model/effortを確認する。
- no provider effect: command前後でprovider request count、execution artifact、provider evidenceが増えない。
- regression: `/sessions` resume、`/rename`、provider/model/effort selection、normal task submitの現行動作を維持する。

各確認は上記product動作または変更する既存経路の具体的regressionへ対応させる。実装中はfocused test、必要なtype
check、format、lint、`git diff --check`を使い、`v0:test`と`v0:gate`を繰り返さない。stable candidateだけに
authoritative `v0:gate`を一回実行する。real-TTY確認はlocal Session operationだけを行い、live provider requestを
発生させない。

## 完了条件

- production TUIのidle時に`/new`を一回実行すると、同じworkspaceで新しいpersistent Sessionへ切り替わる。
- 新Sessionがempty conversation/turn 0/titleなし/checkpointなしで始まり、current exact Definitionとroot
  provider/model/effortを引き継ぐ。
- 新Sessionはturnなしで終了してもlist/reopenでき、旧committed Sessionも`/sessions`から再開できる。
- busy時のactive turnとcommand draft、`--no-session`のin-memory Session、target準備failure時のcurrent bindingを
  失わない。
- `/new`がmodelへ送られず、provider request、execution artifact、provider evidenceを生成しない。
- focused確認、type check、format、lint、`git diff --check`、一回のauthoritative `v0:gate`、standalone
  real-TTYのprovider-free受入が完了する。

## 対象外

- active turnのcancelを伴う強制切替、busy中の自動切替、`/new`への引数やDefinition/model指定。
- transcript、checkpoint、title、pending taskを新Sessionへfork/copyする操作。
- workspace、Agent role、Definition revisionを変更するSession作成UI。
- Session delete/archive/merge、Session template、自動title生成、durable AgentInstance。
- 一般的なSurface load/replacement、`/reload`、slash command補完、Provider外部化、credential registry。
- architecture、roadmapの実装状態更新、installed binary置換、commit、push、tag、publish。

## Human Gateと停止条件

- この文書の利用者承認がIncrement 35の実装許可である。承認前にcode、test、README、build taskを変更しない。
- 計画承認後はSlice Aから開始し、各sliceの完了時に停止して結果を報告する。
- 利用者は2026-09-12にSlice Bまでの実装・検証結果を受け取り、次のincrementへ進むよう指示した。
  これをIncrement 35の完了確認とする。
- repository外のinstalled binary置換、commit、push、tag、publishは別の利用者指示を必要とする。
- exact Definition/model selection継承、empty Sessionの即時durability、旧Sessionの保持、provider非介入のいずれかを
  維持できない実証、またはarchitecture・roadmap、対象機能、外部contract、受入水準を変える必要が生じた場合は、
  実装を止めて観測結果と代案を利用者へ返す。
