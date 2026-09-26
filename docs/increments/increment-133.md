# Increment 133 — ツール資源の所有と終了処理、端末入力の競合防止

状態: 利用者が次のincrementとして採用し、計画を作成（2026-09-26）。実装未着手。
採用の根拠はSession `3266ce70`の入力欠落と、正常終了を含む終了経路の診断。
本書は実装計画案であり、architecture・roadmap正本への反映や実装の承認を兼ねない。

## 必要なproduct動作と根拠

- 利用者目的: 同じHenjiプロセスで通常利用を続け、ターンの正常終了、キャンセル、`/recall`、
  Session切替の後も、キー入力と貼り付けを欠落させずに次の操作へ進める。
- 利用者指示: 「正常にターンが終了したケースでも発生」「他の終了処理も確認が必要
  （ツールコール全般）」。bashのタイムアウトだけを修正対象にしない。
- 再発防止: 資源を作る各ツールが独自にspawn・停止処理を持つ構造を、物理資源の種類ごとの
  共通基盤と明示した所有・寿命へ改める。Tool全体に一律のkillやdisposeを課すことを目的にしない。
- 実利用環境: VM201上のLinux、Deno 2.9.7、macOSのGhosttyからSSHで直接接続。利用者の再現時は
  tmuxを使用していない。SSH接続や端末設定を変更して成立させる修正にはしない。
- Credential値とAuthorizationを診断、資源台帳、追加の永続履歴へ記録しない。

### 確認済みの実行証拠

1. Session `3266ce70-81f4-46c4-962d-83acbab44d12`、Henji PID `200048`。
   タイムアウトしたgit pushの子孫`202890`が`/dev/tty`のFD 5でreadしていた。
   SSHはPTYへ1 byteを3回渡したが、Henjiは1 byteだけを受信し、利用者には`lll`が`l`と表示された。
   このGit readerだけを承認済みSIGSTOPで止めると、同じHenji・同じraw tty設定で3文字入った。
   この生存個体の原因は、Henjiが起動したGit readerとの端末入力競合と因果確認できた。
2. 実際の`createBashTool`、`Registry`、`runAgentTurn`を隔離PTYで実行した。
   exit 0→通常final、exit 0→`submit_json_result`、exit 7、timeout、cancelの各観測経路で、
   終了後にreaderが残り、そのreaderが固定入力`lll`の3 byteを読んだ。
3. 実Deno Worker内でbashを実行し、Workerをterminateした後もOS側のreaderが残って入力を読んだ。
   Worker終了はOS子プロセス終了の代替にならない。
4. `web_fetch`をローカルHTTP 503の継続本文へ接続した。tool errorを約8 msで返した後も、
   約400 msの間に19 chunkが送信され、body cancelは呼ばれなかった。
   これは別の資源終了漏れであり、入力欠落の原因だとは確認していない。
5. 計画の実現性probe: 同じDeno 2.9.7の`node:child_process.spawn`は、`detached:true`で
   新しいSID・PGIDを作り、コマンドから`/dev/tty`を開けなくした（errno 6）。
   stdin ignoreだけの起動では制御端末を共有した。追加FD 3によるstdoutと制御情報の分離も動作した。

利用者が以前経験した別の正常終了ケースまで、同じ原因と確定したわけではない。
Increment 132要件Cの「同一プロセス長時間での入力応答」全体を本診断だけで完了扱いにしない。
本incrementは、今回再現・因果確認した入力欠落の機構と資源終了漏れを扱う。

## 現行の利用者操作から結果までの経路

1. TUIが入力をreadし、Hostのsubmit/cancel/recall/navigationへ配送する。
   物理terminalとSurfaceはHostが所有する。
2. `WorkerRuntime`→core loop→`Registry.dispatch`→bundled ToolComponentの`execute`が実行される。
   共通層はexecuteをawaitし、結果をsemantic履歴へ載せる。所有資源の登録・終了は行わない。
3. bashはWorker内の`Deno.Command('/bin/bash')`で直接起動する。stdin null、stdout/stderr pipeだが、
   制御端末とプロセス群はTUIから継承する。timeout/cancelは直接shellへだけsignalを送る。
   正常結果はshell statusと出力captureが済めば返る。
4. bashの出力spoolはRegistry lifetimeに属し、後続`bash_output`から参照する。正常なターン終了時に
   閉じる資源ではない。`BashOutputStore.close`はあるが、通常組立経路で明示的な呼出しがない。
5. `web_fetch`の2xx本文はfinallyでreader.cancelをawaitするが、非2xxはbodyを終了せずthrowする。
   `web_search`は本文EOFまで取得してから結果を解析し、取消signalはfetchへ伝える。
6. read/write/editはファイルclose・一時ファイル終了処理をawaitする。
   skill/terminal JSON toolはコールでOS資源を生成しない。
7. 親ターン終了時には`ChildRunRegistry.cleanupParent`が子agentを清算し、子Workerをterminateする。
   generation置換、通信失敗、Session切替、Host closeもWorker停止へ到達するが、OS子孫の回収はない。
8. 資源状態は永続Sessionではなく実行中のメモリにある。tool引数・結果とturn outcomeの正本は
   既存semantic履歴であり、資源管理のためにraw I/Oを別の履歴へ常設保存しない。

## 対象範囲と受入要件

### A — TUI端末を継承しない共通プロセス実行

- Linuxのtool commandをTUIとは別のOS session・process groupで起動する。
  利用者commandのstdinは非対話のままとし、制御端末を共有しない。
- bundled bashと、新たなprocess toolが利用できる一つの実行基盤を提供する。
  commandの実行・signal・OS handleの所有をtool本体へ重複実装しない。
- bashのfresh shell、cwd、PATH/LANG/LC_ALL、stdout/stderr分離、exitCode/signal/timedOut、
  progress、切り詰め出力と`bash_output`の読戻しを成立させる。
  非ゼロexitをJSON結果に載せる現行契約を、この資源修正と混ぜて変更しない。

### B — Worker停止を越えて成立する所有と清算

- プロセスの物理ownerはHost側に置き、起動前からownerへ登録する。
  Worker内でspawnした後にPIDだけ通知する方式にはしない。途中でWorkerが止まっても
  「spawn済み・Host未登録」の窓を作らないためである。
- timeout/cancelは当該コールの管理するprocess groupへTERM→必要時KILLを送り、
  出力・直接handle・管理runnerの清算をawaitしてから結果・cancelledを返す。
  生きた子孫がpipeを保持するために、取消がEOFを無期限に待つ構造を解消する。
- 正常に終了したコールの背景処理は、端末を分離したまま当該Worker generationのownerに保持する。
  `command &`等をコール終了や通常finalだけで一律停止する仕様は追加しない。
- 背景処理がない、または自然終了したgroupのrunnerとowner記録はそこで終了する。
  空のrunnerをコール数だけgeneration終了まで蓄積させない。
- ターン取消は当該executionの実行中コールを停止する。先に正常結果を返したコールの背景処理は
  generation所有のままとする。以前のターンの背景処理を次のターン取消に巻き込まない。
- generationの強制終了・置換・通信失敗・子agent清算・Session/Host closeでは、そのgenerationが
  所有する残存groupを停止する。新generation開始、navigation完了、Host終了へ進む前に清算を待つ。
- ターン終了時に残るものは「閉じ忘れ」ではなく、明示したgeneration lifetimeの資源として扱う。
  ownershipはPIDの親子関係だけに依存しない。所有していないTUI/SSH/他コールへsignalを送らない。

### C — コール限りのHTTP資源とRegistry出力資源

- `web_fetch`はResponseを取得した時点でbodyの終了処理を所有し、非2xxでも本文をcancelしてから
  tool errorを返す。通常・切り詰め・取消も同じ取得/終了境界にまとめる。
- `bash_output`のspoolはRegistry/generation lifetimeとして明示する。後続コールの読戻しを保ち、
  cooperative generation closeで既存store.closeを呼ぶ。強制Worker終了時のFD解放と区別する。
- read/write/edit、skill、JSON、web_search、async agentの確認済み終了経路は、所有と寿命の一覧へ
  記録する。確認済みの問題がないtoolへ新しいcleanupを機械的に追加しない。

### 対象外

- S17の描画合流/差分描画、Ghostty/SSH設定、入力polling間隔の変更。
- sandbox、permission policy、一般的hardening、MCP、汎用background job UI、新しいprovider variant。
- 全Toolへのdispose義務化、Effect libraryの導入、OS/permission permutationの網羅試験。
- 既存Sessionや実データの削除、旧protocolへのdual-read/write、実利用中のGit chainの恒久終了。
- 本incrementでのbinary配置・push・release・公開。必要時は別途指示を受ける。

## 設計案

### 1. Hostのprocess executorとWorker-local proxy

`WorkerSupervisor`にgeneration単位のprocess ownerを結び付ける。
ownerは既存のSession authority、semantic履歴、ChildRunRegistryを複製せず、OS資源だけを持つ。
process operationの識別は既存のsession/instanceCorrelation/workerGenerationにexecution・callIdと
process operation IDを関連付ける。PIDを永続的なproduct identityにしない。

Worker-local proxyを`PhysicalIoBindings`とToolComponent bindingsから渡し、bashはそのexecutorを呼ぶ。
data-only protocolでcommand/cwd/環境、start、stdout/stderr chunk、command status、cancelを配送する。
関数やHost objectはpostMessageで渡さない。正常・失敗・取消の結果変換とモデルへ返す形式はToolが所有する。
低水準I/O messageはtransport内だけに置き、journalへraw chunkを追加しない。

子Workerも同じSupervisor/process ownerを利用し、async agent専用の別process清算系は作らない。
direct tool検証も同じ実行基盤を検証用ownerから呼び、旧Worker内直接spawn経路をfallbackとして残さない。

### 2. OS sessionとgroup lifetimeの保持

現在のLinux/Denoで確認した`node:child_process.spawn`のdetached起動を用いる。
正常結果後も背景処理を保持するgroupには、generation所有の小さなmanaged runnerを残して
生存中のgroup identityを保持する。単に終了済みshellのPIDだけを長時間台帳へ残す方式は採らない。
command終了時と背景処理の所有中は、Linuxのprocess/group metadataで同じgroupの残存処理を確認する。
group内にrunner以外の処理がなくなったらrunnerを終了してowner記録を解放する。
この確認はOS資源の寿命管理であり、TUI入力のread方式やpolling間隔を変えるものではない。

runner内の利用者commandは現行と同じfresh `/bin/bash --noprofile --norc -c`で実行する。
利用者commandの終了とrunnerの終了を分け、専用FDの制御情報でcommand statusを通知する。
利用者stdinはnull、制御FDは利用者commandへ継承させず、stdout/stderrへstatus文字列を混ぜない。
出力captureは既存のgrace・上限・readback契約へ接続し、runnerを待つことと結果返却を混同しない。

実現性probeで、DenoのNode spawnは`NODE_V8_COVERAGE`へのenv read許可を必要とした。
また`process.kill(-pgid)`は現行`--allow-run=/bin/bash`だけでは許可されなかった。
group signalは既に許可された`/bin/bash`のbuiltin killから、ownerが持つgroupだけに送る案とする
（同じ制限下でTERM送信を確認済み）。dev taskとcompiled binaryへ必要なenv readをそろえ、
group signalのためだけに`--allow-run`を無制限へ拡張しない。変数の値をdiagnosticへ保存しない。

worker unavailable等の同期通知ではgenerationを終了状態にして清算を開始し、
その清算PromiseをHostが保持する。結果settlement、新generation admission、closeのawait地点へ接続する。
Workerのfinallyが走ることを清算条件にしない。

### 3. 資源の取得と終了を同じ実装境界へ置く

processは上記executor、HTTP Response/bodyはweb_fetchの取得境界、出力spoolはRegistryのownerに置く。
正常returnだけにcleanupを書かず、例外・cancelにも同じ終了手続きを通す。
汎用resource frameworkを先行して作らず、このincrementで実在する三種類の責務を接続する。
Tool.executeという結果生成interface自体に資源ごとの詳細を集めない。

### 寿命の一覧

| 資源 | ownerと終了条件 |
| --- | --- |
| TUIのstdin/raw tty | Host Surface。tool commandへ継承させない |
| 実行中command/group | Host process owner。callのtimeout/cancelまたはgeneration終了で停止・清算 |
| 正常結果後の背景group/runner | 同じgenerationのHost owner。通常finalでは保持、generation終了で停止 |
| stdout/stderr capture・progress | call。結果返却前にcaptureをsettleし、その後のprogressを止める |
| bash output spool | Registry/generation。後続bash_outputで参照でき、generation終了でclose |
| web_fetch Response/body | call。成功・HTTP error・取消の結果返却前に終了 |
| file read/temp write | 各file operation。既存finallyのclose/cleanupをawait |
| async child Worker | ChildRunRegistry。既存清算からSupervisor/process ownerの終了をawait |

## 実装の進め方と変更候補

1. **共通executorとrunnerの実経路を成立させる。**
   `v0/agent/runtime/`にprocess実行のcontract/backendを追加し、制御端末の分離、command status、
   group停止、背景groupの所有と自然終了時のrunner解放を隔離PTYで確認する。
   runnerは同梱する小さな実装で、外部toolを追加しない。
2. **Host/Workerと親子Workerへ接続する。**
   `worker_protocol.ts`、`worker_bootstrap.ts`、`worker_host_supervisor.ts`、
   `worker_host_coordinator.ts`、`worker_host_children.ts`、`worker_agent_api.ts`が候補。
   起動をHostが所有し、forced termination/replace/closeから清算barrierへ到達させる。
   protocolの切替は同じsource/build内で行い、旧形式の互換transportを追加しない。
3. **bashとRegistry資源を移す。**
   `bash_tool.ts`、`tool_components.ts`、`registries.ts`、`worker_builtin_bash_tool.ts`、
   `work_tool_contract.ts`が候補。旧Deno.Command・直接child killを置換対象に含める。
   `bash_output.ts`の既存closeをRegistry/generation終了へ接続する。
4. **HTTP body終了を修正する。**
   `web_fetch.ts`のResponse取得から全出口までのownershipを統一する。
   HTTP errorの表示内容は現行契約に従い、bodyを終えるために正常応答を拒否しない。
5. **通常利用経路で確認し、結果を本書へ記録する。**
   `deno.v0.json`、`scripts/build_henji.ts`の実行設定・同梱closureも変更候補。
   sourceと単体binaryの両方で共通backendを使うことを確認する。

自分で計画・実装・確認を担う。役割の段階だけを理由に別agentを起動しない。
独立reviewが必要と判断した場合は、具体的な利点と限定範囲を示す。

## 検証と受入

### 観測済みのregressionに対応するfocused確認

| 確認するproduct動作 | 根拠・確認方法 |
| --- | --- |
| 正常final/terminal tool後も入力が欠落しない | 隔離PTYの実bash/Registry/loopでreaderを起動。command側にTUI制御端末がなく、TUIへlllが全て届くことを確認 |
| timeout/cancelでreaderやpipe保持により入力・取消が止まらない | 今回のreaderと長い前景sleepの観測を使い、group停止・capture終了・cancelledまでを実測 |
| Worker停止/置換と子agent清算後も資源が残らない | 実Worker内のbashを起動して強制停止。Host ownerから実groupが清算され、新generation/次入力へ進めることを確認 |
| 正常結果後の背景処理を不用意に止めない | 同じgeneration内で短い背景処理を次コールから参照できることと、generation closeで終了することを実測 |
| bash出力と後続bash_outputが読める | stdout/stderr分離、非ゼロexit、既存の切り詰め出力読戻しを共通backend経由で確認 |
| HTTP error後も本文を受け続けない | ローカル503の継続bodyで、tool error前にbody cancelが行われ、終了後の継続送信が止まることを確認 |

対象test候補は新しい`tests/v0/increment_133_tool_lifecycle_test.ts`と既存のIncrement 5・39・70、
Worker replacement、async child cleanup関連。変更した経路に対応する既存testを選んでfocused実行する。
test件数や終了状態の全組合せを目標にしない。file/skill等へ未観測failureのmatrixを追加しない。

実装中はfocused test、必要なtype check、format、lint、`git diff --check`を使う。
安定候補でHost/Worker protocolとbuild経路の整合を確認するため、coordinating ownerが
authoritative `v0:gate`を一回実行する。失敗はfocused確認で原因を特定し、再実行理由を記録する。

### 人間がproduction経路で確認する受入

- 隔離XDG、ローカル模擬provider、production TUIをtmux上で動かし、正常終了・cancel・recall・
  Session切替と入力/貼り付けを確認する。実configへselection等を書かない。
- その後、修正候補の同じHenjiプロセスへ利用者がGhostty/SSHで直接接続し、tmuxを使わずに
  正常終了と取消・recall後の入力を確認する。同じプロセスで通常利用を続けた観測を記録する。
  保存Sessionの再起動だけを、同一プロセスでの入力欠落解消の受入証拠にしない。
- 原因機構の実測と人間の実操作を両方そろえる。修正後に再現しないという観測だけで、
  Increment 132要件Cを含むすべての応答性能問題が解消したと断定しない。
- 実providerを使う確認は、対象・回数・保存先を提示して別途明示承認を得る。
  ローカル模擬providerによる確認は実provider課金を伴わない。
- 現在SIGSTOPしているGit readerは旧binary由来の既存資源。新binaryの起動だけでは回収できない。
  検証対象の修正と、この旧chainの終了・既存Henjiの切替は分け、利用者の指示範囲で実施する。

## 未確認事項と実装時の判断境界

- detached spawnと専用FDは実Denoで確認済みだが、managed runnerを含むcompiled binary経路は未確認。
  buildへ含めた候補で確認する。成立しなければ、実行証拠を添えて起動方式を見直す。
- backgroundをgenerationまで保持する寿命は本計画案の判断。既存の利用者commandを不用意に
  止めないために選んだ。長寿命のjob管理機能を新設する決定ではない。
- lifetimeを外れる独自sessionのdaemonや、任意外部toolが直接行うspawnまでをsandboxで強制管理する
  計画ではない。追加process toolには共通executorを渡す設計と利用規約を示す。
- 将来の非Linux runtimeの全platform対応は本incrementの受入条件に追加しない。
  今回の実利用Linux経路の成立を先に確認し、必要な他platformは実要件に従って別途判断する。
- 手動fg時にraw ttyが戻らなかった観測は診断中のsuspend/resumeで生じた別事象。
  今回のGit readerとの入力競合と混同して修正対象を広げない。

## Product正本の変更案と承認境界

以下は**別途明示承認を要する案**であり、まだ正本へ反映していない。

1. `docs/architecture/henji-host-agent-worker.md`のphysical I/O placement:
   未決定の全tool配置を一括確定せず、**process実行に限りHostが物理ownerとなり、WorkerのToolは
   Worker-local proxyを介して利用する**責務を追記する。Worker停止だけでOS子孫を回収できない
   実行証拠を解消するための意味変更。
2. 同architectureのterminalとlifetime:
   tool commandへHostの制御端末を継承させないこと、callの終了と背景groupのgeneration lifetime、
   強制停止/置換時の清算barrierを明記する。既存の「terminalはHost所有」を実行方式へ接続する。
3. 同architectureのtool bindings・出力store:
   共通process executorとdata-only transport、Registry出力storeの明示closeを反映する。
   toolのsemantic意味・履歴所有はWorkerに保つ。汎用I/O配置やsandboxの採用へ広げない。
4. `docs/roadmap.md`:
   実装・受入結果がそろった後、F01の通常入力とtool実行の該当記述へIncrement 133の成立範囲を
   反映する。計画作成だけで実装済みにしない。S17やIncrement 132 C全体の完了へ読み替えない。

構想変更は必要と判断していない。計画承認と上記architecture変更案1〜3の承認は分けて記録する。
roadmap結果反映、実provider確認、配置・push・releaseも個別の明示指示に従う。

## 参照と診断artifact

- Henji source調査時HEAD: `8aca98f326ae2fd92561546d1d20111976deec9d`。
  生存binary source: `6d7a5d39f39f94b421d98065b6ec2433e7f45991`。対象bashの終了処理は同じ。
- Pi: `earendil-works/pi` commit `08dc60bc52d89d6823a9738cc90b1916e5e446e5`の
  [shell実行](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/core/tools/bash.ts)と
  [harness実行基盤](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/agent/src/harness/env/nodejs.ts)。
- Zot: `patriceckhart/zot` commit `f60e492e551892e737d24a7eaf7730f1f60b75af`の
  [shell共通処理](https://github.com/patriceckhart/zot/blob/f60e492e551892e737d24a7eaf7730f1f60b75af/packages/agent/tools/bash.go)と
  [group停止](https://github.com/patriceckhart/zot/blob/f60e492e551892e737d24a7eaf7730f1f60b75af/packages/agent/tools/bash_unix.go)。
- OpenCode: `anomalyco/opencode` commit `696f41bc8e7586657375d53390925fc54c25d34c`の
  [共通process service](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/core/src/process.ts)と
  [資源取得/終了](https://github.com/anomalyco/opencode/blob/696f41bc8e7586657375d53390925fc54c25d34c/packages/core/src/cross-spawn-spawner.ts)。
- [Node.js detached仕様](https://nodejs.org/api/child_process.html#optionsdetached)。
  参照実装のscopeやgroup停止も、正常終了後の全子孫を必ず停止するという保証ではない。
- 一時診断保存先: `/tmp/henji-3266ce70-psmdpbkc/`。
  `tool-lifecycle-report.md`、`tool-lifecycle-probe/{results,cancel-results,worker-results}.json`、
  `web-fetch-cleanup-results.json`、`reference-lifecycle/comparison.md`、`planning-probe/`。
  raw利用者入力・credential・Authorizationは保存していない。主要な結論は本書へ記載済み。

## 実装・受入結果

未着手。結果は実装後に本節へ記録する。
