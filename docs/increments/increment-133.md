# Increment 133 — ツール資源の所有と終了処理、端末入力の競合防止

状態: 計画レビュー対応後、利用者がスライス単位の実装を指示（2026-09-26）。slice 1〜5のlocal実装・自動検証を実施済み。
共通executorのHost/Worker接続、bundled bashの移行、HTTP body終了、source/binaryのproduction TUI確認まで実施。
利用者は簡単には再現できないため、常用利用で確認する方針を指定した（2026-09-26）。
入力欠落の解消については、この方針で継続観測する。
採用の根拠はSession `3266ce70`の入力欠落と、正常終了を含む終了経路の診断。
実装は上記利用者指示の範囲で進める。architecture・roadmap正本への反映の承認を兼ねない。

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
  所有する残存groupを停止する。同一Instanceのgeneration置換では、新generation開始前に清算を待つ。
  別Sessionへのnavigationでは、旧Sessionの清算を待ってから切替先bindingを採用し、navigationを完了する。
  Host終了も所有資源の清算後とする。
- `/new`は切替先の準備・Worker起動を先に行い、成功後に旧Sessionを清算して切替先を採用する。
  切替先の準備・起動が失敗した場合は切替先だけを清算し、旧Sessionのbinding・generation・背景処理を
  維持する。別Sessionの準備用Workerに、同一Instanceのgeneration置換の起動前barrierを適用しない。
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

runnerの実行方式は、利用者command自身のexitCodeとsignalを区別して取得できるものを選ぶ。
bash wrapperの`wait`の`$?`だけでは、明示的な`exit 143`とSIGTERM終了を区別できないため、
その値からsignalを推定して現行契約を置き換えない。runner自身の終了statusもcommandのstatusに代用しない。
runnerの言語・起動方法とstatus取得方法は、実装slice 1でsourceとcompiled binaryの実行証拠から決める。

TERMは同じgroup内のrunnerにも届く。runnerをgroup identityのanchorとして使う場合は、
TERMへの応答と必要時KILLまでの停止手順を一緒に設計し、停止・清算が終わるまで所有対象のidentityを
保持する。runnerの終了だけで清算済みと判定せず、残存処理の終了と直接handleの回収を確認してowner記録を
解放する。具体的なanchor保持方法は同じsliceで確認し、終了済みrunnerのPIDだけに依存しない。

callのcapture/progressと、背景処理が書き込む物理stdout/stderr pipeの寿命は分ける。
正常結果後に背景処理がpipeを保持している場合は、Host executorが読み取りを続けて以後の出力を破棄する。
callのcaptureを終了するために物理pipeを閉じたり、読み取りを止めて背景writerを詰まらせたりしない。
結果返却後の出力はprogress、bash_output、journalへ追加せず、raw履歴として保存しない。
pipeはEOFまたはgeneration清算時に終了し、背景処理の自然終了後はrunnerとowner記録も解放する。

実現性probeで、DenoのNode spawnは`NODE_V8_COVERAGE`へのenv read許可を必要とした。
また`process.kill(-pgid)`は現行`--allow-run=/bin/bash`だけでは許可されなかった。
group signalは既に許可された`/bin/bash`のbuiltin killから、ownerが持つgroupだけに送る案とする
（同じ制限下でTERM送信を確認済み）。dev taskとcompiled binaryへ必要なenv readをそろえ、
group signalのためだけに`--allow-run`を無制限へ拡張しない。変数の値をdiagnosticへ保存しない。

worker unavailable等の同期通知ではgenerationを終了状態にして清算を開始し、
その清算PromiseをHostが保持する。結果settlement、同一Instanceの新generation admission、closeのawait地点へ
接続する。別Sessionへのnavigationは切替先の準備後、旧Sessionのcloseをawaitしてbindingを採用する。
Workerのfinallyが走ることを清算条件にしない。

現行の`worker_tui_session.ts`の`createNew`は、`openHost(targetHandle)`を先にawaitし、次に
`currentHost.close()`、最後に切替先bindingの採用を行う。この順序と、準備失敗時に旧Sessionを維持する
[Increment 35の契約](increment-35.md#3-binding-replacementと表示)を保つ。
`switchTo`は保存Sessionをlazy bindingとして準備し、旧Sessionのclose後に採用する現行経路へ清算を接続する。

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
| 背景処理が保持する物理stdout/stderr pipe | Host executor。callのcapture終了後もdrainして破棄し、EOFまたはgeneration清算で終了 |
| bash output spool | Registry/generation。後続bash_outputで参照でき、generation終了でclose |
| web_fetch Response/body | call。成功・HTTP error・取消の結果返却前に終了 |
| file read/temp write | 各file operation。既存finallyのclose/cleanupをawait |
| async child Worker | ChildRunRegistry。既存清算からSupervisor/process ownerの終了をawait |

## 実装の進め方と変更候補

利用者指示により、以下をslice 1〜5として区切る。各sliceの実装・focused確認・結果記録を済ませてから
次のsliceへ進む。現在の次の一手と承認境界はhandoff、本書は計画と各sliceの結果を保持する。

1. **共通executorとrunnerの実経路を成立させる。**
   `v0/agent/runtime/`にprocess実行のcontract/backendを追加し、制御端末の分離、command status、
   group停止、背景groupの所有と自然終了時のrunner解放を隔離PTYで確認する。
   runnerは同梱する小さな実装で、外部toolを追加しない。
   Host/Workerへ接続する前に、commandのexitCode/signal取得、TERMから清算までのidentity保持、
   capture終了後の背景出力drainを成立させる。runner方式をsourceとcompiled binaryで確認し、
   成立しない場合は証拠と起動方式の見直し案を本書へ記録する。
2. **Host/Workerと親子Workerへ接続する。**
   `worker_protocol.ts`、`worker_bootstrap.ts`、`worker_host_supervisor.ts`、
   `worker_host_coordinator.ts`、`worker_host_children.ts`、`worker_tui_session.ts`、`worker_agent_api.ts`が候補。
   起動をHostが所有し、forced termination/replace/closeから清算barrierへ到達させる。
   `/new`のtarget準備・旧Session close・binding採用を追い、準備失敗時に旧Sessionを清算しないことと、
   成功時に旧Session清算を待ってから採用することを確認する。`switchTo`のlazy起動も維持する。
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
| `/new`の準備失敗から現在のSessionで継続でき、成功時は旧資源の清算後に切り替わる | Increment 35の準備失敗時のbinding維持契約と現行createNewの順序を根拠に、旧generation・背景処理の維持、成功時の清算と採用の順序を確認 |
| 正常結果後の背景処理を不用意に止めない | 同じgeneration内で短い背景処理を次コールから参照できることと、generation closeで終了することを実測。背景writerがcapture終了後も完了し、その出力がprogress/readbackへ追加されないことも確認 |
| bash出力と後続bash_outputが読める | stdout/stderr分離、非ゼロexit、既存の切り詰め出力読戻しを共通backend経由で確認。Aの現行status維持要件に対応し、明示exitとsignal終了を区別できることを確認 |
| HTTP error後も本文を受け続けない | ローカル503の継続bodyで、tool error前にbody cancelが行われ、終了後の継続送信が止まることを確認 |

対象test候補は新しい`tests/v0/increment_133_tool_lifecycle_test.ts`と既存のIncrement 5・35・39・70、
Worker replacement、async child cleanup関連。変更した経路に対応する既存testを選んでfocused実行する。
test件数や終了状態の全組合せを目標にしない。file/skill等へ未観測failureのmatrixを追加しない。

実装中はfocused test、必要なtype check、format、lint、`git diff --check`を使う。
安定候補でHost/Worker protocolとbuild経路の整合を確認するため、coordinating ownerが
authoritative `v0:gate`を一回実行する。失敗はfocused確認で原因を特定し、再実行理由を記録する。

### 人間がproduction経路で確認する受入

- 隔離XDG、ローカル模擬provider、production TUIをtmux上で動かし、正常終了・cancel・recall・
  Session切替と入力/貼り付けを確認する。実configへselection等を書かない。
- 利用者の2026-09-26の指示により、修正候補の常用利用で入力欠落の解消を確認する。
  簡単には再現できないため、直接操作の再現試験を先行必須条件にはしない。
  同じHenjiプロセスで正常終了、取消、recall、Session切替後の入力を使い続けた観測を記録する。
  保存Sessionの再起動だけを、同一プロセスでの入力欠落解消の受入証拠にしない。
- 原因機構の実測と人間の実操作を両方そろえる。修正後に再現しないという観測だけで、
  Increment 132要件Cを含むすべての応答性能問題が解消したと断定しない。
- 実providerを使う確認は、対象・回数・保存先を提示して別途明示承認を得る。
  ローカル模擬providerによる確認は実provider課金を伴わない。
- 現在SIGSTOPしているGit readerは旧binary由来の既存資源。新binaryの起動だけでは回収できない。
  検証対象の修正と、この旧chainの終了・既存Henjiの切替は分け、利用者の指示範囲で実施する。

## 未確認事項と実装時の判断境界

- detached spawn・専用FDとrunner単体のcompiled経路はslice 1で確認済み。
  production形式Henjiの内部runner entry・build closureはslice 2で確認済み。
  bundled bashを通るproduction全経路の受入はslice 5で確認する。
  成立しなければ、実行証拠を添えて起動方式を見直す。
- runnerによるcommand自身のexitCode/signal取得、停止中のgroup identity保持、結果返却後の背景出力drainは
  slice 1の共通backendで確認した。production binaryの内部entryとHost/Worker接続はslice 2で確認済みであり、
  この局所確認だけをproduction受入の代替にしない。
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

### Slice 1 — 共通executorとrunner（2026-09-26）

- `process_contract.ts`、`process_executor.ts`、`process_runner.ts`を追加した。
  `LinuxProcessExecutor`がspawn前に所有slotを登録し、detached runnerのSID/PGIDを保持する。
  tool結果、semantic履歴、spoolの責務はこのbackendへ移していない。
- runnerは同じDeno runtimeで動く同梱TypeScript。許可済み`/bin/bash`のbuiltin execからruntimeを起動し、
  runnerがcommandのNode child handleでexitCode/signalを取得して専用FD 3へ通知する。
  DenoのNode spawnではstdio指定だけでcommandのFD 3が閉じなかったため、command起動時にも
  bashのbuiltinでFD 3を閉じてからexecする。利用者commandは制御FDを持たない。
- TERM中はrunnerのsignal handlerでanchorを保持する。KILLが必要な場合は、まずrunnerへ直接commandの
  KILL・reap・status通知を要求し、そのstatusを受信してからgroup全体へKILLを送る。
  runnerの終了だけで子孫の清算済みとは判定せず、groupの生存処理と直接handleの終了を待つ。
- command終了後の背景処理は保持し、captureのcancelは物理pipeを閉じずに読み取り・破棄へ切り替える。
  背景writerの自然終了と空runnerの解放、owner closeによる背景group終了を確認した。
- Deno 2.9.7では`--allow-read`を付けても`/proc`列挙が`NotCapable`となった。
  group metadataは許可済みbashのbuiltinで取得し、PID・state・groupだけを短い一時結果として扱う。
  `--allow-all`や無制限`--allow-run`をruntimeへ追加していない。
- focused test: `tests/v0/increment_133_process_executor_test.ts`の4件がsourceとcompiled runnerで通過。
  端末/control FD分離、stdout/stderr分離、明示`exit 143`とSIGTERMの区別、背景writerの1 MiB出力と完了、
  TERM耐性commandへのKILLとstatus保持、owner closeの背景group清算を実測した。
  taskは`deno task --config deno.v0.json agent:increment-133-process:test`。
- source・compiledの両方で、親に制御端末を持たせた隔離PTYから同focused確認を実行し、exit 0。
  証拠: `/tmp/henji-i133-slice1/{source-pty.log,compiled-pty.log,pty-results.json,process-runner}`。
  compiled artifactはrunner単体の検証用であり、production Henji binaryではない。
- type check、対象TS/JSONのformat、lint、`git diff --check`通過。途中のfull gateは実行していない。

slice 1完了時点ではslice 2以降は未着手だった。Host/Worker接続とbinary内部entryの結果は以下に記録する。
実provider call、稼働中の旧Git chainへの操作、binary配置・push・releaseは行っていない。

## 計画レビュー対応（2026-09-26）

- defaultの採用指摘P2: 「新generation開始前」の清算barrierを別Sessionの`/new`にも適用すると、
  target起動失敗時にcurrent Sessionを維持するIncrement 35の契約と衝突する。
  B・設計案・変更候補・検証を修正し、同一Instanceのgeneration置換と別Sessionの準備・採用を区別した。
- サブエージェントの批判的レビューでは、担当したrunner・Host/Worker清算接続に追加の確定findingはなかった。
  command status取得、停止中のgroup identity、capture終了後の物理pipe処理の三点は、
  設計案とslice 1の確認事項へ反映した。runnerを含む経路の実現性は実装時に確認する。
- 今回の対応は計画書の修正。実装、architecture・roadmap正本への反映、実provider確認、配置等の承認を
  兼ねない。


## slice 2の実装結果（2026-09-26）

- Supervisorにgeneration単位のprocess ownerを接続した。Worker-local proxyはstart/read/detach/stop/
  releaseをdata-only transportで要求し、Hostが物理起動・status・group清算を所有する。
  readはstreamの需要に従い一chunkずつ配送し、process要求・出力・eventはsemantic journal／traceへ渡さない。
- `PhysicalIoBindings`と`ToolComponentBindings`から共通executorを利用できる。
  `release()`はコールの正常返却を通知し、背景groupをgeneration所有へ残す。
  execution ID・call ID・operation IDを保持し、後続コールの取消では正常返却済みgroupを止めない。
  captureもgroupも終了した正常コールのtransport所有slotは解放する。
- root／childのturnへexecution IDを渡した。取消、forced termination、transport unavailable、
  close、同Instanceのgeneration replacementを清算barrierへ接続した。
  子Workerのcollect／terminal statusと親の清算は、Supervisorの物理清算完了を待つ。
- `/new`のtarget準備→旧Host close→binding採用の順序を保った。
  実Worker・managed Definitionで成功時の旧process終了と、target準備失敗時の旧binding／背景process保持を確認した。
  保存Sessionのlazy起動も既存のfocused確認が通過した。
- Henji CLIへ内部runner entryを追加し、同じcompiled executableをrunnerとして起動できる。
  build closureにrunnerが含まれ、source task／compile設定にNode spawnが必要とする
  `NODE_V8_COVERAGE`のenv許可を追加した。runtimeのrun許可は引き続き`/bin/bash`に限定される。
- focused確認: `agent:increment-133-worker-process:test`の5件が通過。
  実Workerの背景処理保持とSession close、強制取消からの清算・世代交代、子collectの清算、
  同generationの後続取消と正常背景処理の寿命、`/new`の成功／準備失敗を確認した。
  共通backendの4件もsourceとproduction形式binaryの内部runnerで通過した。
- regression確認: increment 35（3件）、76（4件）、91（10件）、110（13件）、111（4件）が通過。
  対象TSのtype check／format／lint、`git diff --check`が通過。full gateはまだ実行していない。
- 検証用binary: `/tmp/henji-i133-slice2/henji`、build `fee3fecbbc256b1a55f7e63f9703a7b2d8690a9bd950796be52ca755cdfef38a`。
  初回build後にtransport所有slotの解放と取消barrierの接続を調整したため、安定候補を再buildした。
  内部entry／closureの確認であり、bundled bashを使うproduction全経路の受入はslice 5へ残る。

次はslice 3。bundled bashの直接Deno.Commandを共通executorへ置き換え、Registryのbash output storeを
generation終了へ接続する。HTTP body終了はslice 4、production TUIの受入と最終gateはslice 5で行う。
実provider call、旧Git chainへの操作、binary配置・push・releaseは行っていない。


## slice 3の実装結果（2026-09-26）

- bundled bashをHost所有の共通process executorへ移した。tool内の直接`Deno.Command`／child killを
  取り除き、timeout・取消・例外では`stop()`でgroup／runnerの清算を待つ。正常返却前には
  captureとspool書込みをsettleし、`release()`で背景処理をgeneration lifetimeへ残す。
- fresh shell、workspace cwd、PATH/LANG/LC_ALLだけの起動環境、stdout/stderr、非ゼロexit、
  signal、timedOut、progressと既存の切り詰めJSONを維持した。後続ターンの`bash_output`も読戻せる。
- Registryが共有bash output storeを保持し、`Registry.close()`→既存store.closeを接続した。
  cooperative Worker closeは取消・process清算・generation／Registry closeの後にclosedを返す。
  強制Worker終了時のFD解放とは別の明示close経路である。
  bash／work-tools単体がstoreを暗黙生成する経路も取り除き、executorとstoreを必須注入にした。
- offline direct runtimeとwork-tools sentinelにも同じbackendを明示供給し、終了時のowner／Registry closeを
  接続した。sentinel launcherと該当test taskへNode spawnに必要な`NODE_V8_COVERAGE`のenv許可を反映した。
- `agent:increment-133-bash-lifetime:test`の4件が通過。実Workerのbundled toolで、fresh shell／終了status／
  後続ターンのreadback、正常背景writerの1 MiB出力drainとprogress停止、TERM耐性command・子孫の
  timeout清算、取消後のgroup終了とcancelled結果を確認した。
- increment 5の11件が通過。共有storeの確認は手動store.closeをRegistry.closeへ置き換え、
  Denoのresource検査込みでFD終了を確認した。work-tools sentinelの2件、slice 2の5件も通過。
  component注入APIを更新したcurrent_code（17件）、increment 16（4件）、7（6件）の確認も通過。
  SDK型参照のcache miss後はcached-onlyを外して検証し、increment 16のprovider wire確認は
  SDKが読む`OPENAI_LOG,OPENAI_CUSTOM_HEADERS`のenv許可を付けて対象1件を再実行した。
- 対象のtype check／format／lint、`git diff --check`通過。最終の明示store注入変更後は、
  影響するRegistry／sentinel経路をfocused再確認した。full gate、build／配置、実provider callは未実施。

次はslice 4の`web_fetch` Response/body終了処理。compiled binaryとproduction TUIの全経路受入、
最終gateはslice 5へ残す。旧Git chain、構想／architecture／roadmapの正本は変更していない。


## slice 4の実装結果（2026-09-26）

- `web_fetch`はResponse取得直後にbody readerを取得し、HTTP status判定・有界読取り・decode・
  結果生成を同じ`try/finally`で囲む。全出口でreader.cancelをawaitし、reader lockを解放する。
  非2xxでbody終了処理を通らずにthrowしていた経路を解消した。
- HTTP errorの文言、HTML変換、非テキスト応答のmetadata、1 MiBの切り詰めと既存結果形式を維持した。
  取消の判定は既存Agent loopの責務のままとし、body終了後のcancelled turnを実経路で確認した。
- `agent:increment-133-web-fetch-body:test`の3件が通過。
  非2xxのtool errorが非同期body cancel完了を待つこと、実ローカルHTTP 503の継続bodyが
  cancel／unlockされて送信停止すること、実200 bodyの読取り中の取消からcancelled turnまでを確認した。
  network許可は`127.0.0.1`に限定し、実providerへは接続していない。
- increment 70の6件が通過。切り詰め確認を継続streamに置き換えて、結果返却前のbody cancel／unlockも
  確認した。完全／切り詰め結果のcanonical保存・読戻しを含む既存動作を確認した。
- 対象のtype check／format／lint、`git diff --check`通過。full gate・build／配置は未実施。

次はslice 5。source／compiled binaryのproduction経路、隔離XDGとローカル模擬providerのTUI操作、
安定候補に対する最終gateを確認する。人間のGhostty／SSH直接操作と実provider確認は本書の受入・
承認境界に従う。旧Git chain、構想／architecture／roadmapの正本は変更していない。


## Slice 5結果 — production経路と最終gate（2026-09-26）

### 実TUIで確認した動作

隔離XDGとローカル模擬provider（127.0.0.1:8893）、tmux 110x45で、source CLIと
compiled Henjiの双方を起動した。それぞれ同じHenjiプロセス内で以下を確認した。
実provider callと実configへの書込みは行っていない。

- bundled bashから`/dev/tty`を開けないこと、commandのFD 3が閉じていること、stdinがEOFであること。
  stdoutには`NO_CTTY`、`FD3_CLOSED`、`STDIN_EOF`、`BASH_OK`を観測した。
- bashの正常結果からassistant finalへ進んだ後の`lll`入力が全て届くこと。
  bracketed pasteの`PASTE_lll_日本語`が欠けずに入力・送信されること。
- bash実行後のterminal tool（`submit_json_result`）でターンが終わり、次の入力が全て届くこと。
- TERMを無視する前景bashと子sleepをtimeoutで清算し、`signal: SIGKILL`、`timedOut: true`を返すこと。
- 同じ前景処理をEscapeで取り消し、両PIDの終了後に`cancelled`へ進み、次の入力が全て届くこと。
- cancelled executionの短縮IDを`/recall`へ指定でき、その後の入力が全て届くこと。
- 正常結果後の背景処理が同generation中は生存し、`/new`で旧資源を清算して新Sessionへ進み、
  その後の入力が全て届くこと。sourceでは旧group内の6 PID、binaryでは正常finalとterminal toolの
  両方で作った背景PIDの終了を確認した。

保存されたsemantic履歴もreadbackし、正常final、terminal tool、timeout、cancelled、
recall後・新Session後の入力を確認した。binaryの初回失敗と診断用buildの履歴も残っており、
最終候補と区別できるようreadback artifactに各executionのbuild identityを含めた。

### production binaryで見つけた起動不具合と修正

初回binaryのTUIではrunnerが通常TUIの入口へ入り、`invalid HOME`で終了した。
一方、source親から同binaryの内部runnerを起動するfocused testは通過していた。
親自身が同じcompiled executableを起動する実経路で初めて発生した問題である。

Deno 2.9.7のNode互換layerは、別processのargv中にも自分の`Deno.execPath()`を探し、
後続引数をNode/Deno CLI向けに変換する。standalone経路にもこの間接起動の変換が適用され、
内部entry用の引数が保持されなかった。
根拠: 実TUIのlaunch/stderr probe、および
[Deno 2.9.7 buildCommand](https://github.com/denoland/deno/blob/v2.9.7/ext/node/polyfills/internal/child_process.ts#L1816-L1846)。

`runtimeProcessRunnerLaunch`でruntimeのpathをshell program内の引用済みliteralへ移し、
application argvがそのまま届く起動形式に修正した。実行許可は引き続き`/bin/bash`だけを使う。
診断用のconsole出力は除去した。修正後のcompiled TUIで上記一連の操作が成立した。

### 検証結果とartifact

- 新しい4種のIncrement 133 focused taskを`v0:test`へ組込み、fixtureを`v0:check`の対象へ追加した。
- 起動形式の修正後、共通backendの4件をsource runnerとproduction binaryの内部runnerで再確認し、通過。
  背景writerの1 MiB drain、commandの明示exit/signal、group停止とowner closeを含む。
- authoritative `v0:gate`はexit 0。初回gateの後に実TUIで上記不具合を発見・修正したため、
  最終候補のgateを一回取り直した。最終gateもexit 0。fmt、type check、lint、既存regression、
  Increment 133のprocess/Worker/bash/body確認を含む。`git diff --check`も通過。
- 最終候補: `/tmp/henji-i133-slice5/henji`、build
  `a262ea3255186eb00bdd46f06dc981316453ce14ac9aa8b99ba179ceddcba470`。
  file SHA-256: `7f8a3824cca7ed89914d7e3f63faddb36f2d5da4fc5a3ff8e0a3542a7ef714bb`。
- artifact: `/tmp/henji-i133-slice5/results.json`、各`source/compiled/semantic-readback.json`、
  `source/compiled/pane.txt`、`compiled-backend.log`、`gate.log`、`gate-final.log`、`build-final.log`。
  模擬providerのrequest headerやAuthorizationを記録していない。
- 自分が起動したtmux検証用Henjiと模擬providerは確認後に終了した。
  既存Henji PID 200048とSIGSTOP中のGit reader PID 202890には操作していない。

### 残る受入と承認境界

利用者は「簡単に再現できないので常用利用で確かめる」と指定した（2026-09-26）。
直接操作の再現試験を先行必須条件にはせず、修正候補の常用利用で同一プロセスの入力を継続観測する。
現時点ではその観測を得ていない。保存Sessionの再起動や今回の自動操作だけで入力欠落の解消を
受入済みとはしない。Increment 132 C全体の応答性能問題の解消も断定しない。

直接確認の起動用に`/tmp/henji-i133-slice5/direct-check.sh`を準備した。隔離XDG、専用workspace、
専用ローカル模擬provider（127.0.0.1:8894）で最終候補を起動し、終了時にその模擬providerを止める。
このscriptは任意の局所確認用として残す。Ghostty/SSHの端末から起動し、`normal`→`lll`、`terminal`→`lll`、
`cancel`→Escape→表示されたIDの`/recall`→`lll`、`/new`→`lll`と貼り付けを確認し、
確認中とその後の利用を同じHenjiプロセスで続ける。実providerの利用はこのscriptに含めていない。

architecture変更案1〜3、roadmap反映、実provider確認、旧Git chainの恒久終了、
既存Henjiの切替・binary配置・push・releaseは別途明示承認の境界を維持する。


## コード・testの第三者reviewと対応（2026-09-26）

利用者は、入力欠落は簡単には再現できないため常用利用で確かめる方針を指定し、
コードとtestの第三者reviewを依頼した。実装者から独立したread-only reviewerに、
38 fileの変更と新規fileを確認してもらった。初回は30分以内、再確認は修正5 fileと
既存findingの解消だけを15分以内とした。一般的hardeningや仮想matrixは対象へ追加していない。

### 採用した指摘と修正

1. **P1: 起動直後の取消でSessionがbusyのまま残る。**
   実Workerのprocess start request直後に取消すると、OS spawn後・runner準備前にTERMが届き、
   status取得前にrunnerが終了した。清算Promiseのrejectによりcoordinatorのactive解除にも
   到達せず、次submitが`agent session is busy`になった。
   runnerの既存`started`通知を停止の準備完了barrierとして使い、TERM前に待つよう修正した。
   coordinatorの清算待機をnested try/finallyへ移し、reject時もactive/correlationを解除する。
2. **P2: 取消後のHost資源記録が蓄積する。**
   OS清算とdrainは完了しても、bashの取消・例外出口がreleaseを通知せず、Hostの終了済み記録が
   1→2→3件と増えた。正常と例外清算後のreleaseを共通化し、一コールで重複通知しない形へ修正した。
   正常結果後の背景処理は引き続き同generationで保持する。

いずれも明示要件、current sourceから利用者影響までの経路、実行再現を確認して採用した。
初回reviewでは上記以外の採用可能なfindingと、fixtureがproduct契約を狭める変更は見つからなかった。
修正後の第三者再確認では、reviewer自身が元の2つのprobeを再実行して解消を確認し、
修正箇所と既存findingについて残るfindingなしとの結果を得た。

### 修正の確認

- 元のP1 probe: 起動直後の取消が`cancelled`として終了し、先行する正常背景処理を保ったまま
  次submitが成功した。元のP2 probe: 3回の取消後のHost記録が各回0件となった。
- 既存bash lifetime testへ、起動直後の取消→次操作、正常背景処理を維持した取消記録の解放、
  観測された清算reject後のbusy解除の3件を追加した。test専用production APIは増やしていない。
- focused確認: bash lifetime 7件、共通process 4件、Worker process 5件、Increment 39取消清算4件、
  Increment 5 bash出力11件が通過。対象type check、format、lint、`git diff --check`も通過。
- 修正後binaryをbuildし、内部runnerの共通process 4件と、起動直後のstop probeを確認した。
  後者はcommandの`SIGTERM`終了を取得し、activeOperationsが0になった。
- full gateはslice 5候補で通過済み。今回のreview修正後は上記focused確認を実施し、
  full gateとproduction TUI操作を繰り返していない。常用利用での継続観測は未取得のまま。

再現と修正後のartifactは`/tmp/henji-i133-code-review/`に保存した。
`probe_start_cancel.ts`、`probe_cancel_retention.ts`、`start-cancel.log`、`cancel-retention.log`が初回の再現、
`start-cancel-fixed.log`、`cancel-retention-fixed.log`が親の修正後確認。
`bash-lifetime-final.log`、`process-fixed.log`、`worker-process-fixed.log`、
`cancellation-settlement-fixed.log`、`bash-output-fixed.log`、`compiled-process-fixed.log`、
`compiled-immediate-stop.log`が今回のfocused結果である。

review修正を含む現在の検証候補は`/tmp/henji-i133-code-review/henji`、build
`0b46b0c1f1a189132186bde356fc0cc6ad0d044923b7e00a3a52544593e227b6`。
任意の`/tmp/henji-i133-slice5/direct-check.sh`もこの候補を起動するよう更新した。
常用binaryへの配置・既存Henji切替・commit/push/releaseは行っていない。
常用利用の観測方針と、architecture/roadmap等の別途承認境界を維持する。


## Release準備（2026-09-26）

利用者がcommit・push・常用binary配置・JSR publishを明示承認した。
JSRの0.6.0は公開済みのため、process契約の公開API変更を含む次版を`@henji/harness@0.7.0`とする。
README/mod.tsのexact import例を更新し、公開closureに必要なprocess contract/protocolをpackageへ含める。
review修正とrelease設定を含む候補のauthoritative gateを一回実行し、cleanなpush済みcommitから
binaryをbuild・配置し、同commitのclean worktreeでJSRのdry-run・publish・exact importを確認する。
常用利用での入力欠落の継続観測は、この公開処理で受入済みとは扱わない。


### Release候補の検証

review修正と0.7.0設定を含むauthoritative `v0:gate`はexit 0。
artifact: `/tmp/henji-i133-code-review/release-gate.log`。
公開graphの確認で`tool_filter.ts`のinclude不足も見つかったため、必要なprocess contract/protocolと
`tool_filter.ts`、public build manifestから参照する`jsr.json`を明示includeへ追加した。
これはpackage closureの修正であり、gate後にruntime/testを変更していない。
公開候補のdry-runは`@henji/harness@0.7.0`、通常の型検証を含めて成功した。
artifact: `/tmp/henji-i133-code-review/precommit-dry-run.log`。実publishはpush済みclean worktreeから行う。


### Commit・push・常用binary配置

実装と0.7.0準備をcommit `f10893ba324500c1f88f08be96d742ed3f02d2d2`へまとめ、
`origin/main`へpushした。fetch後のlocal/remote commit一致を確認した。
cleanな同commitからDeno 2.9.7で`dist/henji`をbuildし、`~/.local/bin/henji`へ原子的に配置した。
配置後のbinary表示は`henji 0.7.0`、source `f10893ba…`（dirtyなし）、build
`36e27ab63721a4095ec534fde35e3b0cc9e11504bab6a1cd9c8541f12f5eb71c`。
SHA-256: `4aaf9627a2b96ec1596d04f4cb0c4418438e4dd22ac374f96e28abd281a0b2e2`。
同梱runnerのfocused 4件も配置対象binaryで通過した。
既存Henji/旧Git readerへは操作していない。常用binaryの更新は次回起動から利用できる。
artifact: `/tmp/henji-i133-code-review/release-build.log`、`release-binary-process.log`、`deployment.json`。

JSRはpush済みcommitのclean worktreeでdry-run成功後、publishを起動し、利用者のブラウザー認証を経て公開した。
`deno info/publish --config jsr.json`のlockfile自動更新で開発用dependencyを落とさないよう、
公開検証・publishは`--no-lock`を指定した。公開する型/graphの検証を省略するflagは使っていない。
公開結果とregistryからのexact import確認は以下の通り。


### JSR公開結果

利用者によるブラウザー承認後、Denoが`Successfully published @henji/harness@0.7.0`を返した。
公開先: [@henji/harness@0.7.0](https://jsr.io/@henji/harness@0.7.0)。
registry metadataの`latest`が0.7.0となり、同versionのcreatedAt
`2026-09-26T12:10:32.934021Z`を確認した。
release worktreeからではなくregistryのexact versionをimportし、公開exportが読み込めることを確認した
（`deno eval --no-config --no-lock --minimum-dependency-age=0 --reload=jsr:@henji/harness`、exit 0）。
確認後、記録した一時release worktreeだけを削除した。
artifact: `/tmp/henji-i133-code-review/published-meta.json`、`published-import.log`、`publish-result.json`。

commit・push・常用binary配置・JSR publishの利用者依頼は完了。
今後の入力欠落の解消は、利用者指定通り常用利用で継続観測する。
architecture/roadmap正本の反映、実provider probe、旧Git chainの恒久終了は今回の公開に含めていない。
