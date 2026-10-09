# 常用binary 0.11.0配置 — 2026-10-07

利用者が211・212とヘッダー表示固定を受け入れ、push・v0.11.0のJSR公開・常用配置を指示した。
push済みsource `f75087fb6551b279270e551444f0be4f4c7c3118`から公式`henji:compile`でbuildし、
`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。

- version: `henji 0.11.0`
- sourceDirty: `false`
- build ID: `b68ee1a82b9d146eb9e6bf3bcced4e976092ebb443f5256a16bbb801fe9d8146`
- runtime SHA-256: `8864c9cf867efce5a080bac314ac2382407a3c3a5d8d5cc7697726f2e1ace3f0`
- binary SHA-256: `388a03800ae87e8145649e9a3614bd0cfe86f0bbe3bfd1699f2d5306d62bf152`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

公開候補のauthoritative `v0:gate`を1回実行し、682 pass／0 fail、type・format・lintもPASS。
配置先両方とcandidateのversion・SHA-256一致を確認した。 配置binaryのcompiled
Core/TUIを隔離HOME/XDG・workspace・外部DenoのないPATH・tmuxで起動した。 Core
APIのsource一致・clean・0.11.0、TUIの`Henji Harness v0.11.0`・ready表示、normal screen／mouse off、
複数行editorのUp/Home編集、F4 picker・Escでdraft保持、Ctrl-QのTUI終了とCore exit 0を確認した。
task投入・実provider requestは0回。通知の配色は変えず、S38へ要望を記録した。

旧0.10.0 binary（source `afc75e0b`、SHA-256
`99d2b87b3ba113ac4a6100bae038c6f5b57e77f24723e5afdf335c688d9d512a`）は
`henji.previous`と`.tools/native-0.11.0-deployment/henji.local.previous`へ保存した。
旧distは`henji.dist.previous`、元の`henji.previous`は`henji.local.previous.pre0.11.0`へ保存した。
同directoryの`build.log`、`deployment.json`、`smoke.json`、`smoke-tui.txt`等へ確認結果を保存した。

既存の稼働Core/TUIは停止・再起動していない。新しいCore/TUIの起動から0.11.0が適用される。
JSR公開は[公開記録](jsr-publish.md#0110-publication--2026-10-07-jst)を参照する。

## 公開後のTUI修正配置 — 2026-10-07

利用者の「コミット、配置」の指示により、source `b7a904ca57a39d0be344a22f3841723b3f9be66d`を
公式`henji:compile`でbuildし、`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。
終了時の画面clear、F4の標準色、未観測の本文置き換え対応の削除、tool行・本文ラベルの再出力抑止、
system／thinking／tool／入力欄の配色と、折り返しを含む複数行入力の上下移動を含む。
要件・実装・focused検証は[Increment 212](../increments/increment-212.md)を参照する。

- version: `henji 0.11.0`、sourceDirty: `false`
- build ID: `316f06be431b4613e83196c2f151b5caafff776afd08c990c9dc55cbc0e02ed7`
- runtime SHA-256: `effdba4322970871f73c4d7b08478354e82fee85e85e534468dae31db5fa6d69`
- binary SHA-256: `15300e787673769daec7e550f86462f1625f5241f2722b5ca4e27820fe571735`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

candidateと両配置先のversion・SHA-256一致を確認した。直前のsource `f75087fb`のbinaryは
`henji.previous`と`.tools/tui-post011-deployment/henji.local.previous`へ保持した。
旧distと、更新前の`henji.previous`も同directoryで保持し、以前のbackupは変更していない。

配置binaryのcompiled Core/TUIを隔離HOME/XDG・workspace・外部DenoのないPATH・tmuxで操作した。 Core
APIでsource `b7a904ca`・clean・0.11.0を確認し、normal screen／mouse off、F4の標準色を確認した。
localhost chat SSEの80行thinking・80行本文が重複なく表示され、resize後もthinking／assistantの
ラベルは1回だった。thinking全体の標準色Dim、tool prefixの黄色Dim、入力背景gray
237を実SGRで確認した。 改行なしで11行に折り返されたdraftをUp／Downで隠れた行まで移動して編集できた。
local bashのtool行は開始時の`…`付き1行だけを残し、保存Session再表示では`✓`付き1行になる。 F1でlocal
streamをcancelし、systemのCANCELLEDは紫Dimだった。 Ctrl-Q後はshell
promptが最上行左端に戻り、その下は空行。開始前の80行markerと会話はscrollbackに残った。 localhost
requestは4回、外部provider requestは0回、Core exit 0。full gateは繰り返していない。

記録（git対象外）: `.tools/tui-post011-deployment/build.log`、`deployment.json`、`result.json`、
`deploy_smoke.py`、`styled.txt`、`editor-top.txt`、`editor-edited-bottom.txt`、
`after-exit-screen.txt`、`after-exit-history.txt`。

既存の稼働Core/TUIは停止・再起動していない。新しいTUI起動から表示変更が適用される。
今回のsourceと配置記録は、通常利用での利用者受入後に明示指示を受けてorigin/mainへpushした。
JSR追加公開は実施していない。

## Increment 213の配置 — 2026-10-07

利用者の「配置して」により、検証済みの213（tool共通path policyとGit allow修正）を
公式henji:compileでbuildし、dist/henjiと/home/agent/.local/bin/henjiへatomic配置した。
commitは今回指示されていないため、現在のlocal差分を含めたbuildである。

- version: henji 0.11.0
- source: `6a6fcf5f0c9ad0044bf0960374bc29f860a509e9`、sourceDirty: `true`
- build ID: `5b98f4f334b2c131aca6528a27cec953519872fde1b4281196aae4e48842116f`
- runtime SHA-256: `637c0579294146fdd213e8dc314dff2247dc8e3e6b60029f89912d3649ba456b`
- binary SHA-256: `5b3ff5a10991824f066dab0de27576a53c45e4f4851ed921718db6bca7733ac8`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

常用config配下のsearch/index.ts、git_inspect/index.ts、web_fetch/main.tsとweb_download.tsを更新した。
web_search/main.tsには必須fileAccess宣言だけを加え、既存のローカルguideline調整を保持した。
tools.jsonの登録・settings・providers・hooks・実tool-paths.json・実credential/DBは変更していない。
旧binary2個と変更前tool5moduleを.tools/increment-213-deploymentへ保持し、更新後のversionとSHA-256を確認した。

配置binaryで隔離HOME/XDG/workspaceと外部DenoのないPATHを使い、compiled Core/Workerを起動した。
常用外部tool fileをそのまま読み込ませ、8toolがmodel contractへ届くこと、workspace外read、 credential
rootのcommon deny、config write/edit/run_typescript readを確認した。 子workspaceの既定Git
allowとsubtreeへのallow置換でstatus/diff/log/showの範囲、
明示した許可内path、外部search、stage済み削除のstatus表示を確認した。 Core APIのbuild
manifestはcandidateと一致し、確認用Coreはexit 0で清算した。 localhostのfixture
requestは46回、外部provider requestは0回。

記録（git対象外）: .tools/increment-213-deployment/build.log、deployment.json、
source.patch、tool_paths.source.ts、smoke.py、smoke.json、smoke.log、core-0.log、core-1.log。
既存の稼働Core/TUIは停止・再起動していない。新しいCoreの起動から適用する。
push、JSR公開、releaseは実施していない。

## searchの既定allow変更と再配置 — 2026-10-07

利用者が/var等を検索できるようsearchもallow=/にするよう指示した。
既存の常用配置承認の範囲で、公式henji:compileによるbuildとdist/henji・
/home/agent/.local/bin/henji、常用search/index.tsへのatomic配置を完了した。

- version: henji 0.11.0
- source: `6a6fcf5f0c9ad0044bf0960374bc29f860a509e9`、sourceDirty: `true`
- build ID: `345a22c9fdbe5050acd013d48cefa63860e22ab25def3fd693b0eed2e7cc4815`
- runtime SHA-256: `0f984cae81330dd4a6f440f0624b82fb3f66eaaeaee1e561239e165acb2e2a24`
- binary SHA-256: `898fdee44228eb1ba9994c535a51eb3c906a7720e7183f0dfe873a6e2fbc1201`

最初のbuildはdisk空き容量不足で失敗したため、/tmpの一時領域で再buildした。
同一内容・modeの旧配置backup2個はhardlinkで容量を共有し、元のpathと内容を保持した。
新しいbinaryの配置先2個と今回のcandidateも容量を共有する。
変更前binaryは.tools/increment-213-deployment/henji.candidateに保持されていることを
SHA-256で照合した。変更前search moduleは今回のsearch.previous.tsに保存した。

配置binaryのCore/Workerと常用外部search moduleで、workspace外のconfig rootの一覧・
内容検索、deny配下の探索除外、denyを指すsymlink除外、credential rootへの直接指定の拒否を確認した。
隔離HOME/XDG/workspace、外部DenoのないPATHとlocalhostのfixtureを使用した。 fixture
requestは10回、実provider callは0回。確認用Coreはexit 0で終了した。

記録（git対象外）: .tools/increment-213-search-deployment/build.log、build-retry.log、
candidate-runtime.json、deployment.json、tool_paths.source.ts、search.previous.ts、
smoke.py、smoke.log、smoke.json、core.log。 実tool-paths.json・credential・DB設定は変更していない。
既存の稼働Core/TUIは停止・再起動していない。新しいCoreの起動から適用する。
commit、push、JSR公開、releaseは実施していない。

## Increment 214〜217の完了と配置 — 2026-10-08

利用者が「これまでのインクリメントを完了とします」と判断し、「配置もしてください」と指示した。
217までの既存incrementを完了とし、214〜217を反映したsource
`6315beed73cb4c68ec46189c30e08487a83d0028`
のbinaryを`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。

メモリ観測時に公式builderで作成し、各3回のproduction Core/TUI測定に使ったclean binaryを再利用した。
配置直前にHEAD/sourceDirty/versionとbinary
SHA-256を照合した。build入力の追加変更はなく、再compileは不要だった。
メモリ測定結果は[Increment 217](../increments/increment-217.md)を参照する。

- version: `henji 0.11.0`、sourceDirty: `false`
- source: `6315beed73cb4c68ec46189c30e08487a83d0028`
- build ID: `199c39379d87466f05f25923df13cdd5fd76f0ab774ad98d0022febfb54e14fc`
- runtime SHA-256: `8204780530362bb332010dd61eec49e00dcf6a87dfacdabfb0b0d93816112449`
- binary SHA-256: `930ea6a03fb2034df05a32f84f1ddae25ebfb0f323e58f99bd60d10f04e53736`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

配置先両方のversion/SHA-256がcandidateと一致した。旧dist・常用binary・更新前`henji.previous`は
git管理外`.tools/increment-217-deployment/henji.{dist,local,previous}.previous`へ保持した。
`/home/agent/.local/bin/henji.previous`には今回置き換えた常用binaryをatomic配置し、元のSHA-256と照合した。
既存の外部tool/hooks、provider/settings/tool-paths/credential/DBは変更していない。

配置先の常用binaryから、隔離workspace/HOME/XDGと外部DenoのないPATHでproduction
Core/Agent/Dataを起動した。
localhost宣言providerを使い、同じSessionでChat→Responses→Chatの3turn、Core停止・再起動後の保存Session再開と
Chatの4turn目が成功した。各turnのcompleted outcome、requestCount=1、provider/model、canonical
historyを確認した。

別の隔離tmuxでcompiled Core/TUIを起動し、Core APIのsource/clean/build ID一致、0.11.0のready表示、
normal screen/mouse off、複数行editorのUp/Home編集、F4 pickerとEscのdraft保持、Ctrl-QによるTUI終了と
Core exit 0を確認した。TUI smokeのprovider requestは0回、Worker smokeはlocalhost request 4回。
外部provider requestは0回。full gateは繰り返していない。

記録（git管理外）:
`.tools/increment-217-deployment/deployment.json`、`install.py`、`worker_smoke.py`、
`worker-smoke.json`、`tui_smoke.py`、`smoke.json`、`smoke-core.log`、`smoke-tui.txt`等。
build記録は`.tools/memory-after-217/compile-after.log`／`builds.json`。

既存の稼働Core/TUIは停止・再起動していない。新しいCore/TUI起動から反映する。
今回の完了・観測・配置記録のcommit/pushは未実施。JSR追加公開・releaseも実施していない。

## Increment 220のhjh常用配置 — 2026-10-09

利用者の「コミットプッシュ配置して」により、[Increment 220](../increments/increment-220.md)の
CLI改名を`59dcdd714639e70cf28ea978b8d7c8877ecb3796`へcommitし、origin/mainへpushした。
先行する218の保持量最適化・219の5分周期trim・catalog停止修正と記録も同時にpushされた。 同clean
sourceから公式`hjh:compile`でbuildしたartifactを、`dist/hjh`と
`/home/agent/.local/bin/hjh`へatomic配置した。

- version: `hjh 0.11.0`、sourceDirty: `false`
- source: `59dcdd714639e70cf28ea978b8d7c8877ecb3796`
- build ID: `10c9d4a0c6de145dad8e8ff08f2d28c84db74b153a572a2774ce4be1e8cd15a0`
- runtime SHA-256: `2aac9eea2e91eb16393da0851407f7f6f3a987033f1a21dd36a92a19a52626d5`
- binary SHA-256: `e8e152d401bc46258a8bd10bb25c663d6395fa3442176ea92b20a817f548cf54`
- Deno: `2.9.7`、target: `x86_64-unknown-linux-gnu`

配置前のdirtyな`dist/hjh`は`.tools/increment-220-deployment/hjh.dist.previous`へ保持した。
常用`hjh`は今回新規配置。旧`dist/henji`と`/home/agent/.local/bin/henji`は変更せず、配置前後の
SHA-256一致で保全を確認した。既存の設定・DB・credential・外部tool/hookは変更していない。

配置先の`/home/agent/.local/bin/hjh`自体を、隔離HOME/XDG・workspaceと外部DenoのないPATHで
tmux起動した。version/help/error、storage root、Core自己起動・一覧・status、TUI ready、
`/help`表示・Esc復帰・Ctrl-D detach、detach後のCore存続、`core stop`と解放を確認した。 Coreのbuild
ID/source/cleanは配置binaryと一致した。実provider requestは0、会話は投入していない。 focused
test等は220の実装時に成功済みで、full gateは繰り返していない。

配置証跡（git管理外）は`.tools/increment-220-deployment/`の`compile.log`、`deployment.json`、
`version.txt`、`runtime-diagnostics.json`、`core-status.json`、`tui-ready.txt`、`tui-help.txt`、
`verification.json`、`deploy.py`、`verify-installed.py`を参照する。

現在のPATHで`hjh`が常用配置先へ解決されることを確認済み。既存の稼働Core/TUIは停止・再起動せず、
新規に`hjh`で起動するCore/TUIから反映する。JSR追加公開・releaseは実施していない。

## Increment 218の常用DBコピー変換と起動復旧 — 2026-10-09

配置後、利用者がrepository workspaceで`hjh`を起動すると
`Core startup failed: startup_failed`となった。foregroundの`hjh serve --json`で
`unsupported history schema version: 1`を確認した。配置binaryはschema3を使うが、既存の常用DBは
schema1だった。配置時の隔離新規DBでの確認だけでは既存DBとの接続を保証できず、実DBとの確認が不足した。

利用者が「元DBを保全し、変換コピーの履歴一致を確認してから切り替える」操作を明示承認した。
対象は`/home/agent/projects/henji-harness`のworkspace DBだけで、他workspaceのDBは変更していない。
通常runtimeへのmigration追加は行わず、既存の`scripts/copy_increment_218_history.ts`を使用した。

- 元DB:
  `/home/agent/.local/state/henji-harness/v1/96e1aca163459f35e2878b7efe3fb4e46719bd09c427a91bd492227958d9c3cd/history.sqlite3`
- 元DBサイズ: 620,830,720 byte、schema1。
- 保全先: 同directoryの`history-schema1-before-218-20261009T050440Z/`。 元DB本体と既存の`-wal`（0
  byte）・`-shm`を移動して保持した。
- 元DB SHA-256: `735c255ae444839ce08650bdb24cfb846113e7dd86227811ebfe7a39021cdd2b`。
  変換前後・切替後とも元DB本体のbyte不変を確認した。

開始前と切替直前に、対象workspaceの稼働Coreが0、元DBを開くprocessが0であることを確認した。 SQLite
backupによる一貫したコピーをschema3へ変換し、独立したread-only照合で元の15テーブルの
全行・全既存columnの型/値/hash一致を確認した。変更するmetadataのschema_versionだけは比較から除外した。
元の40 Session、236 Execution、5,784 message、12,019 content、122,031 semantic recordを保持し、
schema3のexecution表示位置236件とSQLite quick_check=okを確認した。

コピーに対して常用`hjh`のSession一覧と既存Sessionのsession/canonical/detailの全履歴出力を確認した後、
元DBとsidecarを上記保全先へ移動し、変換コピーを元の`history.sqlite3`へrenameして切り替えた。

切替後、実HOME/config/state・元workspaceから常用`hjh`をtmux起動し、Coreの自己起動とTUI
readyを確認した。 既存Session
`6bb28c60-46a4-4901-8222-26b74287ea46`の再開は`hjh --session ID`のproduction経路で確認し、 135
message・18 committed turnと会話page28 entityを読み出した。3種類のhistory出力のbyte量/hashは
切替前のコピーの出力と完全一致した。確認用TUIはdetachし、Coreは正常停止した。
切替・起動・停止の後にも元の15テーブル全行の一致を再確認し、40 Session・236 Execution・5,784
messageを維持した。 会話は投入せず、実provider requestは0。

初回の確認helperはコピー用directoryを0755で作り、既存runtimeが要求する0700に合わせて修正した。
別HTTP
clientでSessionを切り替えた後のTUI表示追随も仮定していたため、CLIの明示Session再開で確認し直した。
いずれもgit管理外helperの訂正で、production source・設定・credential・binaryの追加変更はない。

証跡はgit管理外`.tools/increment-220-db-switch/`の`preflight.json`、`conversion.log`、
`conversion-time.json`、`copy-verification.json`、`copy-readback.json`、`switch.json`、
`production-verification.json`、`post-switch-verification.json`と実行helperを参照する。
全件hash照合結果だけを記録し、会話本文やcredential値はtool出力へ出していない。
