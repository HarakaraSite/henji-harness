# 通常利用 increment 4 — conversation識別、history export、read継続読込み

ステータス: 完了。2026-09-07にscopeと計画をユーザーが承認し、local実装、機械確認、独立review、
production TUIのhuman gate、ユーザー受入を完了。

## この文書の位置付け

この文書は通常利用increment 4の対象、決定、実装順、確認方法の正本である。実装後の事実は
`docs/increments/increment-4-results.md`へ記録する。現在地と次の行動は`.handoff/handoff.md`だけに置く。

ユーザーは通常利用increment 3の受入後、次の四項目をincrement 4のscopeとして確定した。

1. conversationの`user>`と`assistant>`のlabelだけを色分けする。
2. 現在Sessionのcommit済みcanonical transcriptを、その時点のMarkdown snapshotとして保存する
   `/history export`を追加する。
3. 現在のplain text表示を変えず、assistant本文rendererをHost TUI内のcomponentへ抽出する。
4. `read`へline単位の`offset`・`limit`と継続案内を追加し、有効な`read` toolの選択指針を
   AgentCompositionのsystem instructionへ合成する。

対応するroadmap機能はF01、F02、F05、F06、F10である。

## 根拠となる要件と現行source

- 通常利用ではturn間の空行が識別を助ける一方、長い履歴で話者をさらに早く見分ける必要がある。
  `v0/tui/layout.ts`は現在`label + text`をplainな`LayoutRow.text`へ投影し、`v0/tui/render.ts`が
  terminal frameを作る。canonical transcriptやPresentation eventへ色を入れる必要はない。
- assistantのfinal textとstreaming textは`UiLogEntry`へ直接入り、独立した本文rendererがない。
  将来のMarkdown検討を現在の表示変更と結び付けず、まずHost TUI内に差し替え境界を作る。
- 現行TUIには保存済みhistory pageの内部projectionがあるが、一turnずつ、表示行数とbyte数を制限した
  modal用のviewである。現在Session全体のsnapshot sourceには使えない。
- `Session.transcriptSnapshot()`と`WorkerHostSession.transcriptSnapshot()`は、成功してcommit済みの
  message列のdefensive copyをHost側で既に返す。`session_history.ts`はcanonicalなturn rangeを導ける。
- production launcherは既にworkspace別のstate rootを選び、そのrootへのread/write permissionをTUIへ
  与える。exportのためにworkspace repositoryやSession recordを変更する必要はない。
- 現行`read`は`path`だけを受け、64 KiBを超えるUTF-8 fileを拒否する。`readTarget()`は`edit`にも
  共有されるため、pagingをその関数へ入れると`edit`の既存64 KiB契約まで変わる。
- `Tool`はname、description、schema、executorを持ち、`Registry`は有効toolを保持する。
  `createDefaultAgentComposition()`と`createPlannerAgentComposition()`はregistryをmaterializeした後も、
  registry由来のguidelineをsystem instructionへ合成していない。

根拠の正本は、ユーザーが確定したscope、`docs/experience/normal-use-inbox.md`、上記の現行source、
`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`である。外部service仕様はこのincrementの
動作根拠に使わない。

## このincrementで成立させるproduct動作

### 1. role labelとassistant renderer

1. production retained TUIのconversation logで、`user>` labelをANSI blue、settledした
   `assistant>` labelをANSI yellow（terminal theme上のamber相当）で表示する。
2. 色はlabel文字だけへ適用し、label直後にSGR resetする。本文、空白、`tool>`、`steer>`、
   `assistant~`、`system>`、warning、footer、inputは着色しない。
3. layoutが返す`LayoutRow.text`はplain textのままとする。ANSI sequenceはterminal frame生成時だけ加え、
   cell幅、wrap位置、source anchor、cursor位置、canonical transcriptを変えない。
4. 狭い画面でlabel自体が複数rowに分かれる場合も、そのrowに含まれるlabel断片だけを着色する。
5. ANSI sequenceのbyte数も既存の128 KiB frame上限へ含め、途中でSGRが閉じないframeを生成しない。
6. assistant本文は新しいHost TUI内componentを必ず通す。increment 4のdefault componentは入力textを
   そのままplain textとして返し、finalとstreamingの表示内容、escaping、改行、wrapを変えない。
7. componentの選択はTUI rendererの構築時に閉じる。Worker、provider、canonical Message、
   Presentation contractへrenderer名やterminal styleを追加しない。

### 2. `/history export`

1. idle時のexact slash command `/history export`を追加する。`/history`、追加引数、大文字小文字違いは
   従来どおりunknown commandとし、modelへ送らない。
2. commandは表示中viewportやbounded history pageではなく、現在bindingのHost側
   `transcriptSnapshot()`をsourceとする。成功してcommit済みの全turnだけを先頭から含め、active response、
   steering draft、follow-up draft、input履歴、TUI-local noticeは含めない。
3. turn 1完了後の実行はturn 1だけ、turn 2完了後の実行はturn 1とturn 2を含む。各実行は、その時点の
   complete snapshotを新しいfileへ保存し、以前のexportを上書きしない。
4. busy中にexact `/history export`をEnterしてもsteeringとしてmodelへ送らない。command textをinput欄へ
   保ったまま、idle後に再度Enterするようstatusへ示す。自動queueやactive turn完了後の暗黙実行はしない。
5. idleでcommandをadmitした時点で、adapterは最初の非同期I/Oより前に現在のcore binding、position、
   commit済みtranscript snapshot、起動時に確定したsession modeを同期的に取得する。その後のfile I/O中に
   mutableなcurrent bindingを再参照しない。
6. controllerは一つのHost-local `history-exporting` operationをsettlementまで追跡する。実行中もdraft編集と
   描画は続けるが、通常task、Session切替、二回目のexportをadmitせず、入力内容を保持して完了後の再実行を
   statusで案内する。Workerのbusy/steering stateとは混同しない。
7. `/exit`、Ctrl-D、signal、その他のshutdownがexport中に要求された場合は、exit intentを保持してexportの
   write・flush・close settlementを待ち、その後にterminalとSessionを閉じる。renderer close後にreceiptや
   statusを送らず、export失敗でもsettlement後のexitを妨げない。
8. export完了時は、追跡中のoperationと開始時のbinding identityが一致し、shutdownへ移る前の場合だけ
   receiptをconversation logとstatusへ反映する。古いoperationや別bindingへreceiptを帰属させない。
9. export先は既存のworkspace別state rootにある
   `<state-root>/<workspace-digest>/history-exports/`とする。repository内へfileや`.gitignore`変更を作らない。
10. filenameは、durable Session modeでは現在bindingのSession ID、`--no-session`では`no-session`、snapshotの
    最終turn、UUIDを含む`.md`とする。UUIDとexclusive createにより、同じturnを繰り返しexportしても別fileに
    する。
11. `--no-session`の判定に`currentPosition().sessionId`の有無を使わない。no-sessionでもHost内部の
   `MemoryWorkerHandle`がcorrelation用UUIDを持つため、startupで確定した`sessionMode.kind`をexporter bindingへ
   明示的に渡し、そのUUIDをfilenameやMarkdown metadataへ出さない。
12. export fileは明示的に削除するまで保持する。`$VISUAL`、`$EDITOR`、その他の外部processは起動しない。
13. 成功時はconversation logへ、最終turnと絶対pathを省略しない一つのHost-local noticeとして追加する。
   footer statusにも成功を示す。失敗時はfileを成功扱いせず、既存のrecoverableなTUI statusで再試行可能に
   する。
14. 0 turnのSessionも有効なsnapshotとしてmetadataだけのfileを作り、最終turn 0を報告する。
15. `/history export`のtyped intentと、`path`・`throughTurn`だけのbounded resultをdata-only
    Presentation contractへ追加する。transcript、store handle、runtime objectはcontractを越えさせず、
    Worker protocolとSession schemaは変更しない。

### 3. Markdown snapshot

1. file先頭へtitle、durable Session IDまたは`no-session`、agent、physical workspace、最終turnを記録する。
2. canonical turnごとに`## Turn N`を置き、message順を維持して次を出力する。
   - 最初のuser messageは`user>`、turn内の追加user messageは`steer>`。
   - text assistant messageは`assistant>`。
   - assistant tool callは`tool> <name>`と整形したJSON arguments。
   - tool resultは`tool< <name> · <success|error>`とresult text。
3. user/assistant/tool textは内容を削除・要約せず、Markdown上で本文とheadingを混同しないcode fenceへ
   入れる。本文中のbacktick列より長いfenceを選び、canonical textを改変しない。
4. tool argumentsはcanonical JSON valueを人間が読めるindent付きJSONにする。call/resultの対応に必要な
   name、順序、outcomeを残す。
5. 全commit済みturnを出すためのcontent truncationは設けない。message単位で順にwriteし、全snapshotを
   一つの巨大stringへ複製することは避ける。write、flush、closeが完了した後だけ成功receiptを返す。
6. transcriptがcanonicalなcompleted-turn列としてindexできない場合はexportを失敗させ、部分的なfileを
   成功結果として残さない。

### 4. `read`のline window

1. `read` input schemaを`path`必須、`offset`と`limit`任意へ拡張する。`offset`は1-basedの正の整数、
   `limit`は返すline数を指定する正の整数とする。
2. 既存の`{"path":"..."}`は`offset=1`、明示line上限なしとして互換に保つ。64 KiB以内の小さいfileは
   現在と同じtextだけを返し、不要なmetadata行を追加しない。
3. result全体は既存と同じ64 KiB以内とし、UTF-8 scalarとlineの途中で切らない。`limit`またはbyte上限より
   後にlineがある場合は、返した最後のlineの後へ
   `Use offset=<next-line> to continue.`を含む「続きあり」の案内を付ける。
4. line数とbyte上限のうち先に到達した方でwindowを終える。案内自体も64 KiBへ含める。
5. file全体をbounded memoryでstream走査し、total line数と続きの有無を確認する。既存どおりregular file、
   workspace内path、symlink拒否、valid UTF-8、NUL拒否を維持し、走査中もcancelを反映する。
6. `offset`がEOF後なら空textを返す。選択した一lineだけでcontent budgetを超える場合は、そのlineを
   silent truncationせず、line番号を含む明示的なread errorを返す。
7. paging用readerは`readTarget()`と分離する。`edit`が対象全体のsnapshotを読む既存64 KiB契約、`write`と
   `edit`のinput上限、atomic replaceは変更しない。
8. tool descriptionにも1-based `offset`、`limit`、継続案内を明記し、modelがresultだけから次callを
   組み立てられるようにする。

### 5. active tool guideline

1. `Tool`へ任意のimmutableな`promptGuidelines` metadataを追加し、`read`へ次の一項だけを置く。
   「file調査では`cat`や`sed`をbashで実行するより`read`を優先し、続きは`offset`・`limit`で読む。」
2. `Registry`は現在有効なtoolだけから、tool name順、各tool内の宣言順でguidelineを返す。providerへ渡す
   `ToolDefinition`にはguideline metadataを混ぜない。
3. AgentCompositionを作る時点で、registryのguidelineを見出し付きの一つのsystem instruction componentへ
   整形し、既存のworkspace instruction、skill manifest、planner policyの後へ合成する。
4. default parent、delegated planner、直接作るplanner compositionへ同じ規則を適用する。`read`を持たない
   registryではcomponentを作らず、空headingも追加しない。
5. compositionが返す`systemInstruction`と`resolved.systemInstruction`は同じ合成済みtextを示す。
   tool resource identityは既存の`tool:read`を使い、Manifest schema、Definition revision、dependency
   lineage、任意tool authoring APIはこのincrementで拡張しない。

## 決定済みの実装境界

- `v0/tui/conversation_renderer.ts`をHost TUIの新しいcomponent境界とし、plain assistant rendererと
  conversation entryのplain projectionを置く。`layoutUi()`はdefault componentを持ち、`TuiRenderer`は
  constructorで別componentを注入できる形にする。
- `LayoutRow.text`はterminal control sequenceを含まない。label toneと各wrapped rowに属するlabel断片長を
  表示metadataとして持ち、`renderFrame()`の専用row rendererだけがSGRを加える。
- ANSI blueはstandard SGR 34、amber相当はstandard SGR 33を使う。256-color固定やtheme設定は追加しない。
- history Markdown projectionとfile保存は`v0/agent/history_export.ts`へ分離する。pureなmessage projectionと
  Deno state-store writerを分け、TUI controllerへfilesystem objectを渡さない。
- production `tui_cli.ts`が既存state rootとphysical workspaceからhistory export storeを一度構築し、
  startupの`sessionMode.kind`から導いたdurable/no-session identityとともに`TuiPresentationAdapter`へ注入する。
  no-sessionをoptional Session IDから推定しない。
- adapterはintentを受けた同期区間で現在binding、position、Host側transcript snapshot、session identityを
  captureし、そのimmutableな値だけを非同期writerへ渡す。Session resume後もcommandをadmitした時点の
  選択中Sessionがsourceになる。
- `TuiController`はexport Promiseを一つだけHost-local operationとして所有する。export中のtask、resume、
  重複exportを直列化し、すべてのshutdown pathはoperation settlement後にrendererとSessionを閉じる。
  adapterは非同期完了時に直接rendererへeventを送らず、controllerが現operationを確認してreceiptを表示する。
- `presentation/contract.ts`はslash actionとbounded receiptだけを運ぶ。`session_history.ts`のbounded modal、
  `session_store.ts`のcanonical record、`worker_protocol.ts`はexport transportに使わない。
- history export directoryは`sessionPaths()`が返すworkspace別pathへ追加する。launcherの既存state-root
  permission内なので、launcherのpermission範囲を広げない。
- `read`のpaging readerだけがlarge fileをstream処理する。shared `readTarget()`は`edit`用の全体snapshot
  contractを保つ。
- tool guidelineはtool componentのmetadata、選択と整形はRegistry、system instructionへの結合は
  AgentCompositionの責務とする。F24の一般的なinstruction component/revision設計には拡張しない。

## 実装範囲

### 1. TUI componentと着色

- `v0/tui/conversation_renderer.ts`を追加し、plain assistant body renderer、entry projection、label toneを
  定義する。
- `v0/tui/layout.ts`へplain row metadataを追加し、wrap後もlabel断片の範囲を保持する。
- `v0/tui/render.ts`へstyled rowのterminal projectionを一か所だけ追加し、frame byte admissionを
  ANSI込みで行う。
- `v0/tui/terminal.ts`には必要なstandard SGR constantだけを置き、terminal lifecycleのreset契約を保つ。

### 2. history export

- `v0/agent/history_export.ts`へMarkdown projection、exclusive filename生成、state-root writer、receiptを
  実装する。
- `v0/agent/session_store.ts`のworkspace別pathsへ`historyExports` directoryを加える。
- `v0/presentation/contract.ts`へ`history_export` intent/resultのdata-only validationを加える。
- `v0/agent/tui_presentation_adapter.ts`で最初のawaitより前に現在binding、commit済みsnapshot、position、
  明示的なsession identityをcaptureし、exporterへ渡す。完了receiptはcontrollerへ返し、adapterから遅延した
  renderer eventを発火しない。
- `v0/tui/controller.ts`でexact slash parse、idle dispatch、busy時の非steering化、`history-exporting` operation、
  task/resume/重複exportの直列化、shutdown settlement、success/error statusとnoticeを接続する。
- `v0/agent/tui_cli.ts`でproduction exporterを既存state rootへbindし、startupのsession modeをdurableか
  no-sessionかの明示identityとして渡す。provider-free test用にも同じidentityとwriterの注入seamを用意する。

### 3. readとguideline

- `v0/agent/work_tools.ts`でread schema/validation/descriptionを拡張し、line-window readerとcontinuation
  resultを実装する。write/editのvalidationとshared snapshot readerは維持する。
- `v0/agent/tools.ts`へ`promptGuidelines`とRegistryのactive guideline projectionを追加する。
- `v0/agent/worker_agent_api.ts`でdefault parent、planner handler、direct plannerのsystem instructionを
  registry materialization後に確定する。
- 必要なら`v0/agent/agent_instructions.ts`へtool guideline blockのpure formatterを置き、既存の
  `composeSystemInstruction()`を再利用する。

### 4. 文書と結果

- 実装が安定した時点で、architectureの現在のTUIとAgentCompositionへ、実装済みのlabel style、plain
  assistant component、history export、active tool guidelineの境界を追記する。
- roadmapのF01、F02、F05、F06、F10は、実装で現在形が変わった箇所だけ更新する。
- 実装内容、機械確認、未実施のhuman checkを`docs/increments/increment-4-results.md`へ記録する。
- increment 4へ採用した記述は`docs/experience/normal-use-inbox.md`の未採用候補から除き、vi mode、mouse、
  external editor、`/reload`、Markdown、bash readback、F24等を残す。

## 実装順序

1. plain assistant componentとplain `LayoutRow` metadataを追加し、現行表示とwrapが不変であることを
   focused testで固定する。
2. `user>`/`assistant>` labelのterminal着色を接続し、frame byte boundとSGR resetを確認する。
3. canonical transcriptからMarkdownを作るpure projectionと、workspace別state rootへ別fileを作るwriterを
   実装する。
4. TUI CLIから明示的なdurable/no-session identityを渡し、typed presentation intentとadapterの同期snapshot
   captureを接続する。
5. controllerの単一`history-exporting` operation、task/resume/再exportの直列化、全shutdown pathのsettlement、
   current receipt表示を成立させる。
6. `read`のline windowとcontinuation resultをshared edit readerから分離して実装する。
7. `promptGuidelines` metadata、Registry集約、default/planner AgentComposition合成を接続する。
8. 変更したproduct動作に対応するfocused test、type check、format、lint、`git diff --check`を実行する。
9. stable candidateに対してcoordinating ownerがauthoritative `v0:gate`を一回だけ実行する。
10. 結果文書と現在形が変わるarchitecture/roadmapを更新し、production TUIのhuman gateへ渡す。

## 検証

各確認は、このincrementで変更する具体的なproduct動作へ対応させる。

- plain component: final/streaming assistant、ASCII、日本語、改行、control文字のplain projection、wrap、
  cursor、source anchorが変更前と一致する。
- label color: layout textにESCがなく、frameでは`user>`だけがSGR 34、`assistant>`だけがSGR 33で囲まれ、
  各label直後にresetされる。狭幅wrapとframe上限でも色漏れしない。
- export source: viewport位置やmodal pageに依存せず、turn 1時点とturn 2時点で別pathを作り、後者だけが
  両turnを含む。uncommitted active turnとTUI-local entryは含まない。
- export fidelity: user、steer、assistant、tool arguments、tool result、outcome、Unicode、Markdown fenceを
  canonical順で欠落なく読める。0 turnと`--no-session`もreceiptを返す。
- slash behavior: exact commandだけをidleで実行する。busy中はinputを保持してprovider steeringを増やさず、
  unknown slash、`/help`、`/sessions`、`/exit`は既存semanticsを保つ。
- export lifecycle: writerを意図的にpendingにした状態で直後のtask、Session resume、二回目のexportをadmitせず、
  draftと開始時bindingを保持する。`/exit`、Ctrl-D、signalはwrite・flush・close settlement後に終了し、renderer
  close後のnotice、旧binding receiptの新bindingへの表示、部分fileの成功報告がない。
- export capture: command開始後にcurrent bindingの参照を差し替えても、writerへ渡るpositionとtranscriptは
  最初のawait前にcaptureした同じbindingの値である。
- export storage: pathがabsoluteかつworkspace別state root配下で、同じturnの二回実行が異なるfileになり、
  success noticeにpathと最終turnが表示される。
- no-session identity: `--no-session`の内部`MemoryWorkerHandle`がUUIDを返しても、filenameとMarkdown metadataは
  `no-session`となり、durable Session modeでは現在bindingのSession IDとなる。
- read compatibility: 64 KiB以内の既存path-only callは同じtextを返し、workspace/path/symlink/UTF-8/NUL規則と
  edit/writeの64 KiB契約を維持する。
- read paging: `offset`、`limit`、line上限、byte上限、EOF後、最終newlineなし、multibyte text、単一巨大lineで
  complete-line semanticsと次offsetが正しい。
- guideline: readありのdefault/planner requestだけにguidelineが一回入り、readなしでは入らない。
  provider向けtool definition、Manifest resource、既存workspace instruction/skill/planner policyを変えない。

focused verification用に、既存TUI testへ表示・controller regressionを追加し、history exportとwork toolの
filesystem動作は`/tmp`だけを許可する独立test taskへ分ける。`deno.v0.json`の`v0:test`からそれらを実行し、
最終的な正本commandは次とする。

```sh
deno task --config deno.v0.json v0:gate
```

実装中は変更箇所のfocused testと該当する`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`だけを使う。
stable candidateでだけauthoritative `v0:gate`を一回実行する。provider request、credential read、network、
real-TTY E2Eはlocal verificationに含めない。

機械確認後のhuman gateでは、production TUIでlabelの見分けやすさ、二turn後の二回のexportと表示pathから
Markdownを開けること、Henji自身がlarge fileを`read`の継続案内に従って読めることを確認する。
providerを使う確認はその時点のユーザー指示に従い、この計画の承認だけでは自動実行しない。

## 対象外

- `/history` modalの新しい入口、vi風read-only mode、mouse wheel、terminal mouse tracking
- `$VISUAL`または`$EDITOR`の起動、export fileの自動削除、既存exportの上書き
- Markdown/Mermaid renderer、assistant content kindやWorker/presentation output contractの変更
- `tool>`等の追加色、色theme設定、256-color固定、色の自動無効化、legacy/non-retained表示の着色
- `/reload`、input command historyのkey semantics変更
- `bash`全出力readback、bash tool guideline、read以外の新しいguideline
- 任意tool component authoring API、tool dependency lineage、Manifest schema、Definition revision、F24
- Session schema、canonical transcript、Worker protocol、provider/model loopの変更
- credential、provider、network、production TUIの自動実行
- dependency/lockfile、`_refs/*`、sibling repositoryの変更
- commit、push、tag、publish、release

## 停止条件と承認

次の場合は計画内の実装詳細として補わず、ユーザー判断へ戻す。

- commit済み全transcriptをHost側snapshotから取得できず、Worker protocolまたはSession schemaの変更が必要に
  なる。
- exportをworkspace別state rootへ保存するためにlauncher permissionを現在のstate root外へ広げる必要が
  ある。
- plain assistant componentの抽出に、MessageまたはPresentation contractへ新しいcontent kindを追加する
  必要がある。
- complete-line pagingと64 KiB resultを両立するために、edit/write contractまたはbash readbackまで同時に
  変更する必要がある。
- active toolだけのguideline合成に、Manifest schema、Definition revision、一般tool authoring APIの変更が
  必要になる。
- Markdown renderer、external editor、vi mode、mouse、`/reload`、bash readbackのいずれかを同時実装しなければ
  四つのproduct動作を達成できない。

ユーザーは2026-09-07に上記scopeと計画を承認した。local実装、focused verification、authoritative gate、
結果文書更新、独立reviewは完了した。production/providerを使うhuman gate、commit、pushは別の明示指示を
必要とする。
