# Increment 203 — B12: binary更新後のprocess runner起動と早期終了の原因表示

状態: local実装・focused/compiled確認・独立review完了（2026-10-06）。
利用者の「続いてb13対応」「ごめんb12だ」でB12を採用した。
後続指示「コミット配置してください」によりsource commit・公式build・常用配置を承認され、実施中。

## 必要なproduct動作・根拠

稼働中Coreのbinaryをatomic置換した後も、既存Agent・新しい子Agent・置換後のWorker世代が
bash/search/run_typescriptなどのprocess toolを実行できること。process runnerがcommand statusを
返す前に終了した場合は、実際のrunner exit code・signal・command開始の有無を既存tool結果へ残す。
同じ失敗を大量に試行する原因を修正し、再発時に短いfactで次の調査ができるようにする。

## 現行経路と調査結果

- CoreのWorkerSupervisorがgenerationごとにWorkerProcessOwnerを作り、LinuxProcessExecutorの runner
  launchを決める。各process callは新しいrunner processを作る。runnerを共有・再利用する
  経路ではなく、死んだrunnerの再生成を追加する必要はない。
- Worker tool → WorkerProcessExecutor → Hostのprocess owner → runner → command → FD 3のstatus → Host
  reply → Worker → Registryのerror文字列 → semantic履歴、が現行経路である。
- standaloneの新しいownerは`Deno.execPath()`を実行ファイルの参照に使っていた。
  稼働中のbinaryをatomic置換するとLinux上のDeno 2.9.7は末尾`(deleted)`付きpathを返す。
  新しいownerは存在しないpathからrunnerを起動してexit 127となり、FD 3がstatus前に閉じる。
  更新前に作られたownerは元のpathnameを保持しており、更新後も起動できる。
- 隔離compiled probeで、更新前・更新後の既存ownerは成功、更新後に作ったownerだけが
  `process runner ended before command status`になることを再現した。実runner stderrは
  `henji (deleted): No such file or directory`だった。artifact: `/tmp/henji-b12-probe/`。
- 当時の配置metadataは2026-10-05T04:20:02Zにbinaryをatomic置換したと記録している。
  保存executionのbuildは旧版`4312d81e`のままで、04:58以降の失敗に先行する。
  保存履歴の親bash成功・新しいreviewer失敗と再現結果が一致する。当時のrunner stderr自体は
  保存されていないため、原失敗のexit 127を直接readbackできたわけではない。
- detail.jsonをJSONLとして再集計すると、実bash errorは5つのreviewer executionで156件。 原メモの6
  executionには、親collect_subagent結果が同文言を含む1 executionも含まれていた。

## 採用設計・対象範囲

1. current runtimeからの起動に、Linuxの`/proc/<呼出し元PID>/exe`を共通helperで使う。
   稼働中processの実行ファイルを参照し、binaryのunlink/renameで失われない。
   新しいpathname上の別buildへすり替わらず、Coreと同じ実行中runtimeから内部entryを起動する。
   既存bash wrapper・permission・command environmentは維持する。
2. WorkerProcessOwnerとsource runner、同じ起動helperを使うrun_typescript processもこの参照へ揃える。
   独自のruntime探索、copy保存、fallback、再試行、新しい永続状態を追加しない。
3. FD 3の早期EOFではrunner終了を観測し、exit code・signal・command開始の有無をerrorへ含める。
   通常のcommand statusは維持する。raw stderr、command引数、env、credentialは追加記録しない。
4. B12の原観測・採用要件・結果は本書へ移す。202の完了承認を記録済み。

対象source: `v0/agent/runtime/process_executor.ts`、`worker/worker_process_owner.ts`、
`tools/run_typescript_process.ts`。全toolへ独自のspawn/復旧処理を追加しない。

対象外: modelの自動再試行方針、reviewer tool構成、TUI表示追加、実provider call、常用配置、
commit/push・公開、構想/architecture/roadmapの正本変更、既存dataの削除。

## 計画・確認するproduct動作

- source実行で既存process executor・bash・Worker
  proxyの正常status、背景process寿命、取消・closeを確認する。
- 観測済みのrunner exit 127で、errorにexit
  codeとcommand未開始が残り、所有processが終了することを確認する。
- compiled
  probeで同一processのbinary置換後に既存ownerと新しいownerからcommandが成功することを確認する。
- 隔離compiled production経路で、新しい子Agentのprocess
  callとrun_typescriptをbinary更新前後に確認する。
  実providerは使わず、実config・常用binary・既存Sessionは変更しない。
- 対象focused test、type check、format、lint、git diff --check。full gateは要求しない。
- process identity・終了順序に具体的な独立確認の価値があるため、安定候補を限定reviewする。

## 原観測（通常利用メモから移設）

### B12 — `process runner ended before command status`でbashが全件失敗し、原因も復旧も残らない

- 原観測（2026-10-05、Session `2bc2699f`の保存履歴分析、2026-10-06にread-onlyで集計）:
  2026-10-05T04:58:31Z–06:16:31Zの間に6
  executionで`process runner ended before command
  status`のtool
  resultが生じた。失敗したcommandはgit status/diff・find・rg・grep・ls・echoで、
  対象executionでは**bash callが全件失敗**した（例: execution `99fae222`は130件すべて失敗）。
- 利用者影響: review子Agentが差分・gitを取得できないまま終了し、親はreviewを計6 execution
  spawnし直した。`99fae222`は同一`ls .tools/increment-193/apply-palette/`を125回再試行し、 128 model
  step limitで停止した（診断`model_step_limit`、requestCount 128）。review未完の判定と
  再実行のstep・時間を浪費した。
- 現行source: `v0/agent/runtime/process_executor.ts`はrunner childのcontrol fd（stdio[3]）が
  `status`messageを返す前に`end`した場合にこのエラーを返す。runner自身の終了理由（exit code・
  signal・crash出力）はtool結果に含まれず、`diagnostic`recordにも残らない（同時期の診断はprovider系と
  model_step_limitのみ）。runner死亡後の再生成・復旧経路も確認していない。
- 未確認: runner childが早期終了した原因（生成失敗・crash・外部要因等）。1.5時間と新しいWorker世代を
  またいで継続したため環境要因の疑いがあるが、再現probeは未実施。
- 対応候補（未採用）: runner早期終了時にexit code・signal・短いcrash出力等を短いfactとして残す。
  runner死亡後の復旧（再生成）の是非は、原因確認後に採用判断する。修正・実装は未指示。
- 利用者判断（2026-10-06）: 別途調査とする。本項は通常利用メモに残し、原因究明・再現・対応の実施は
  別途の調査・指示で行う（この分析では追加probe・修正をしていない）。
- 再検討条件:
  同エラーが通常利用で再観測されたとき、またはrunner診断・復旧を個別incrementへ採用するとき。
- 証拠:
  `.tools/tool-trend-2bc2699f/`（detail.jsonと集計）、分析scriptは`.tools/tool-trend/analyze.ts`。
- 関連: [Increment 133](../increments/increment-133.md)（managed process runner）、
  [Increment 176](../increments/increment-176.md)（失敗分類・短い診断）、
  `v0/agent/runtime/process_executor.ts`、`v0/agent/runtime/process_runner.ts`。

## 結果

### 実装

- `currentRuntimeProcessRunnerLaunch`を既存executor moduleへ追加し、Worker owner・source runner・
  run_typescript processで同じ実行中runtime参照を使うようにした。Linuxの既存proc参照を使い、
  新しいfile保存・runtime探索・permission・再試行・永続状態は追加していない。
- control pipeの早期EOFではrunnerのexit eventを待ち、例えば
  `process runner ended before command status (exitCode=127, signal=none, commandStarted=false)`
  と返す。既存の正常command statusと通常の非zero command exitは維持した。
- API credential、Authorization、command引数・env、raw stderrの追加記録はない。 error
  textと既存failure detailsを通じてsemantic履歴・modelの次requestへ伝える。 TUI
  Surfaceは変更していない。

### 検証

- executor・Worker proxy・bash lifetime・run_typescript executorのfocused確認は18 pass / 0 fail
  （11秒）。正常status、commandのsignal、背景writerの自然終了、TERM→KILL、取消・close、 子Agent
  cleanup、runner exit 127の短いfact・所有operation解放を確認した。
- `increment_203_binary_update_test.ts`は1 pass / 0 fail（2秒）。productionと同じpermissionで
  compiled fixtureを起動し、実WorkerHostSessionとChildRunRegistryを通して確認した。 binary
  pathnameを**exit 88の別実行体へatomic置換**し、`Deno.execPath()`がdeleted表示でも、
  既存親のbash/run_typescriptと、新しくspawnした子のbash/run_typescriptが実際の期待値を返した。
  置換先を誤って起動した場合には通らない確認である。実config・常用binary・既存Sessionは変更していない。
- 共通launcher変更後のsearch focused確認は1 pass / 0 fail（4秒）。実Worker上のrg/grep、
  通常page/count、DB/blob除外、上限停止と後続実行が成立した。
- 実LinuxProcessExecutor → createBashTool → Registryの追加probeでは、runner exit 127のfactが
  `tool_result.outcome:error`の本文と既存`failure.message`まで伝わることを確認した。
  artifactは`/tmp/henji-b12-probe/tool-failure.json`。credentialや引数の追加記録はない。
- 変更TSのtype check・format・lintと`git diff --check`を確認。full gateは実施していない。
- compiled確認用fixtureの初回は、productionより狭いnetwork permissionによりrun_typescriptの
  Workerが起動できなかった。公式buildと同じpermissionへ訂正した。次の試行では、probeの親admissionに
  startup時の古いstateRevisionを渡して失敗したため、既存Data
  APIで現在revisionを取得するよう訂正した。 いずれも確認fixtureの不備であり、製品のpermissionやData
  admissionを変更していない。

### 独立review

初回20分上限で、実行中runtimeのidentity、control EOF/exit順序、通常status・取消・背景processと
短いfactの伝達をread-only reviewした。指摘なし。reviewerの実process probeでも、command開始前/後の
SIGTERMで`exitCode:null / signal:SIGTERM / commandStarted:false/true`が正しく返り、
保有operationは0件だった。probe artifactは保存せずtool transcriptで結果を受領した。

compiled wrapperとfixtureのrevision訂正についてのみ15分上限で限定re-reviewを行い、指摘なし。
compiled testの成功により、初回review時に未確認だった新しいownerの起動も確認済みとした。

### 状態・残る範囲

今回再現したbinary置換後の起動不具合と短い終了factの追加はlocal確認済み。 原失敗当時のrunner
stderrがないため、当時の個々の失敗がすべてexit 127だったと直接断定することは
できない。配置時系列と親/子の失敗傾向・再現機構は一致する。

常用binaryは未更新、commit/push・公開は未実施。実provider callは0回。
TUI表示・操作の変更は含まないためtmuxのSurface確認は対象外。
構想・architecture・roadmapの正本は変更していない。202は利用者による完了承認を別途記録した。

## 承認境界

B12のlocal対応と非破壊的確認は今回の指示で承認済み。後続指示「コミット配置してください」により
source commit・公式build・常用配置も承認された。202の未配置修正もこのbuildとsearch
folder更新へ含める。 実provider
call、push、公開、Product正本の変更、実dataの削除は今回の対応・commit・配置許可に含めない。
