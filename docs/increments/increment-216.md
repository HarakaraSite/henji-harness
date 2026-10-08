# Increment 216 — 選択したCLIコマンドの入口を読み込む

作成日：2026-10-08。

状態:
利用者承認済み計画に基づくlocal実装・focused検証・一時compile/binary確認・独立reviewを完了（2026-10-08）。
source・計画書・検証記録は後続の利用者指示によりcommitし、origin/mainへpush。
常用binaryの更新・配置・実provider callは未実施。

利用者指定の`/tmp/henji-harness-cli-command-loading-instructions.md`をコピーし、現在のproduct経路、
実装・確認方針を詳細化した。本書を今回の要件・計画・結果の正本とする。

## 依頼と目的

`henji_cli.ts`でコマンドを分類した後、選択したコマンドの実装入口を読み込む構造へ整理してください。今回の範囲でlocal実装と必要な検証を行い、結果を報告してください。

目的は、コマンドの選択と実装の読み込みを対応させ、起動時に不要なコマンド実装を評価する依存を除くことです。CLIの利用方法、Core／Workerの起動方式、単一binaryの配布を保ってください。

今回もRSSの測定は必須ではありません。読み込み経路の整理が成立したことと、メモリ・起動時間・binaryサイズへの効果は分けて扱ってください。

## 対象と基準

- repository：<https://forge.harakara.site/littleisland/henji-harness>
- 調査commit：`1f790bb0c0ee6d235e466405b7c9a21e4f1563ab`（Increment 215）。
- 調査元はmacOS参照clone。実装先は利用者指定のLinux開発checkout
  `/home/agent/projects/henji-harness`。着手時HEADは調査commitと一致する。
- 着手時に対象repositoryの`AGENTS.md`と現在のsourceを確認し、以下の根拠が現在も成立するかを確認してください。他の作業の変更は保全してください。
- 背景：[構造・処理・責務・フットプリントの分析](/tmp/henji-harness-structure-footprint-analysis-2026-10-08.md)。分析はIncrement
  214までの再評価を含みます。そこで候補としているCore→Data実装の不要な依存は、Increment
  215で解消済みです。

本書が今回の作業範囲を定義します。背景資料内の他の改善候補は今回の実装対象に含めません。

## 確認済みの現状

`v0/agent/cli/henji_cli.ts`は、TUI、run、serve、Core管理、Session管理、履歴、診断、設定、内部process
runner、内部TypeScript実行の入口をstatic importしています。

`main`内には既にコマンド分類がありますが、その前に各入口のmoduleと静的な依存が評価される構造です。例えば`--help`や`--version`でも、入口の値importにはTUI・Core・保存履歴操作の実装が含まれます。

同じCLI入口は、通常起動のほか`runtime/core_discovery.ts`からの`--internal-core-bootstrap`にも使われています。通常の公開コマンドだけを変更して内部経路を残さないよう、現在の全分岐を確認してください。

## 今回の変更範囲

主対象は`v0/agent/cli/henji_cli.ts`の実装入口の読み込みです。直接関係する検証と、必要な場合だけbuild用の入力収集・同梱処理を対象にできます。具体的な分岐の書き方は実装側で決めてください。

コマンド分岐で文字列リテラルを使う`await import('./...')`が候補です。共通の軽いhelp・エラー表示などは、その用途に合うstatic
importを残して構いません。汎用loader、plugin登録機構、コマンド実装の全面的な移動は今回の目的から要求しません。

確認対象となる既存分岐は次のとおりです。

| 分岐                                         | 現在の担当入口                                  |
| -------------------------------------------- | ----------------------------------------------- |
| `run`                                        | `run_worker_client.ts`                          |
| `serve`、`--internal-core-bootstrap`         | `serve_cli.ts`                                  |
| `core`                                       | `core_cli.ts`                                   |
| `tui`、引数なし、先頭が通常のoptionの起動    | `tui_cli.ts`                                    |
| `sessions`、`history`                        | `session_cli.ts`、`history_cli.ts`              |
| `agent`、`tool`                              | `configuration_cli.ts`                          |
| `diagnostics runtime`、その他の`diagnostics` | CLI内のruntime診断、`failure_diagnostic_cli.ts` |
| `--internal-process-runner`                  | `runtime/process_runner.ts`                     |
| `--internal-run-typescript`                  | `tools/run_typescript_process_entry.ts`         |

`--help`、各既存のsubcommand
help、`--version`、未知のコマンド、未実装の`webui`の処理も保ってください。分岐の優先順位と内部引数の既存判定を変えないでください。

選択したコマンドが必要とする共有moduleや、TUI／runからCoreを起動する既存の経路は維持してください。「他コマンドでも使うmodule」を一律に読み込み禁止にする要求ではありません。

## 単一binaryとbuild入力

[Deno公式のcompile資料](https://docs.deno.com/runtime/reference/cli/compile/#dynamic-imports)では、`import('./module.ts')`のように静的に解析できるdynamic
importはcompile時に同梱されます。変数から組み立てたspecifierは自動同梱の対象にならず、必要なら`--include`で指定する方式です。確認日：2026-10-08。

現在の`scripts/build_henji.ts`は、Denoのmodule graphからlocal
sourceを収集し、stagingへコピーしてruntime
digestとbuild情報を作ります。Worker等の入口には既存の明示includeもあります。

遅延した入口とその依存が、staging・binary・build入力の一覧に引き続き含まれることを確認してください。起動時の依存比較でdynamic
importを除外することと、build入力からそのsourceを除外することは別です。読み込みを遅らせたsourceもbinaryに必要で、内容が変わればbuild情報へ反映される必要があります。

build処理の変更が必要な場合は、この動作を保つ最小限にしてください。runtimeの更新、compile方式の全面変更、Workerの同梱方式の変更は今回の目的から要求しません。

## 保つ利用者の動作

- help・versionの出力と終了コード。helpの表示にworkspace初期化、Core起動、保存操作を要しない既存の動作。
- 公開コマンドの引数の受渡し、stdout／stderr、JSON出力、成功・失敗の終了コード。
- 引数なし／通常optionでのTUI起動と、明示した`run`／`tui`の経路。
- Coreの内部bootstrap、process runner、TypeScript実行の引数・入出力・終了処理。
- 各コマンドの既存機能と、source実行・compiled binaryでの入口解決。

## 完了条件と検証

1. CLI入口の静的な値importから、選択前にコマンド実装を一括評価する依存が除かれていること。変更前後の静的依存と、各分岐で読む入口を示してください。
2. help・version等の共通処理はコマンド実装を必要とせず、選択した分岐から必要な入口を読み込めること。import構造の確認と、実際のCLI実行結果を対応させてください。
3. 公開・内部の分岐と既存の出力契約が保たれていること。
4. 遅延したsourceがbuild入力とstagingに含まれ、localで作った単一binaryからも解決できること。
5. repositoryの規約に従う必要な型チェック・format・lint・差分チェックが成功していること。

既存テストから、変更した経路に対応するものを選んでください。

- `increment_146_cli_test.ts`：環境・起動権限を必要としないhelp表示。
- `increment_183_cli_test.ts`：公開コマンドのエラー、subcommand help、runのJSON出力契約。
- `increment_140_cli_test.ts`：CLI入口から履歴取得へ進むlocalhost HTTP経路。
- `increment_145_launcher_test.ts`、`increment_179_cli_worker_test.ts`：Core起動とrunの入口を確認する候補。
- `increment_78_build_provenance_test.ts`：build入力と情報の扱いを確認する候補。

上記を全部実行すること自体を合格条件にしないでください。既存テストで確認できない変更がある場合だけ、該当する実経路の最小限の確認を追加してください。module評価の観測が必要な場合は一時probeで行えます。検証専用のloaderや常設ログをproductionへ追加する要求はありません。

単一binaryの入口解決を確認するため、localの一時出力へcompileし、help／versionと遅延した入口を通る必要な経路を確認してください。sourceだけの成功やhelpだけの成功を、全入口の同梱確認の代わりにしないでください。内部経路も、既存テストや隔離probeで現在の用途に対応する確認を選んでください。

既存のCLI起動・接続確認は隔離workspace／XDGとlocalhostで行ってください。TUIの表示・操作を変更する場合はrepositoryのSurface検証規約を適用します。実provider呼出は今回の読み込み整理の確認に必要ありません。

`deno info`等のgraph比較では、静的な値依存、dynamic
import、型だけの参照を区別してください。compileで同梱する全module数が減らなくても、起動時に評価する範囲が減る変更は成立し得ます。RSS・起動時間・binaryサイズの削減量は、実測していなければ未確認として報告してください。

## 対象外と実行範囲

provider
adapterの選択的読み込み、Core／Dataの責務変更、Worker配置、終了済みownerの保持、thinking更新、モデル入力コピーは対象外です。CLIの構文、機能、権限、入力制約を変更しないでください。

この指示はlocal変更、非破壊的な検証、検証用のlocal
compileを対象にします。稼働中のCoreや常用binaryを更新せず、commit・push・配置・公開・実provider呼出は利用者からの別の明示指示に従ってください。

局所的な読み込み変更で、製品要件や責務分担の変更が必要と判明した場合は、根拠と追加範囲を報告してください。

完了報告には、遅延した入口、残したstatic
importと理由、変更ファイル、依存比較、公開・内部の動作確認、build入力／binaryの確認結果、未確認事項を含めてください。

## 現行product経路と実装計画

利用者はsource／単一binaryのhenji入口へ引数を渡す。mainの内部引数判定、version/help判定、公開command判定、
暗黙TUI判定の順番が現在の入口契約。各commandが引数解析・表示・既存Host/Core/Dataの起動や読取りを担当する。
help/error/build情報はCLIの共通表示で、workspace・Session・Core等の状態を所有しない。

TUIは既存core_discoveryから同じCLIの内部bootstrapを起動し、serveがCoreとData/Agentのlifetimeを持つ。
runはrun_bootstrap Workerからheadless Host/Data/Agentへ進む。process
runnerとrun_typescriptの内部入口は 同じcompiled
binaryを再起動してtool処理を担う。今回、各owner・保存先・Worker起動方式は変えない。

### 選ぶ実装

henji_cli.tsの各既存分岐へ文字列リテラルのawait importを置き、呼出す関数をその場で取得する。
共有loaderやcommand mapは作らず、分岐の順序・内部引数条件・渡す引数・return/exitを維持する。
cli_error、cli_help、build_manifest、runtime_pathsは軽い共通処理としてstatic importを残す。
runtime_pathsはdiagnostics
runtimeだけで参照されるが、module評価でenvを読んだり状態を初期化したりしない。

現在のbuilderはdeno infoの全modulesを収集し、dynamic/type依存を除外していない。まずこの既存経路で
各遅延入口がbuildInputFiles/runtime files/stagingへ残ることを確認し、変更不要ならbuilderを変えない。
[Deno公式compile資料](https://docs.deno.com/runtime/reference/cli/compile/#dynamic-imports)を2026-10-08に再確認し、
文字列リテラルのdynamic importが自動同梱の対象であることを確認した。

### 確認する動作と手順

1. 変更前後のCLI graphを記録し、static code、dynamic code、typeを区別する。入口の直結依存と、 static
   codeだけで到達する範囲を示す。全build graphには遅延した全入口が残ることを確認する。
2. 146のhelp確認、183の公開エラー・subcommand help/run JSON、140のlocalhost history、179のrun
   Worker、 145のCore
   bootstrap/serve、78のbuild入力について、変更した入口に対応するfocused既存testを使う。
   表示・キー操作には変更を加えないため、Surface変更のtmux確認は本変更の必須確認にしない。
3. help/versionをsourceで実行し、全command実装を評価しない入口構造と照合する。公開分岐の引数と出力は
   既存testと一時probeで確認する。内部typescriptは返却値、process
   runnerはstdout/stderr/status/controlの
   実経路を確認する。内部bootstrapは起動した隔離Coreへ接続してread/stopする。
4. buildInputFilesと既存builderによる一時compileを使う。compile中の実stagingに遅延入口と依存が存在することを
   一時probeで記録し、終了後にbuilderがそのtemporaryをcleanupする既存動作を維持する。
   binaryはgit管理外`.tools/increment-216/`に置き、常用binaryや稼働Coreを更新しない。
5. 一時binaryはcheckout外の隔離workspace/XDGから起動する。共通help/versionだけでなく、
   全遅延入口に対応する公開・内部の必要経路を実行し、sourceに依存せず解決できることを確認する。
   provider-freeの設定／管理やlocalhost接続を使い、外部provider callはしない。
6. 関連type check、変更fileのformat/lint、git diff --checkを行う。full gateは要求しない。

新規の常設testは、既存testで確認できない具体的な変更動作がある場合だけ追加する。 module評価・compile
staging・binary smokeの証拠は一時probeに保存し、productionへ観測機構を加えない。

### 未確認事項と対象外

未確認は、literal dynamic importがDeno
2.9.7の実graphへどう表れるか、既存stagingとcompileで全入口が解決するか。
実行証拠で確認する。RSS・起動時間・binaryサイズの改善量は測定しない。 provider
adapter、Core/Data責務、Worker配置、保存形式、構想・architecture・roadmapは変更しない。
既存未追跡の`191-result.json`と`scripts/diagnostics/__pycache__/`を保全する。

## 結果

### 実装と読み込み境界

production変更は`v0/agent/cli/henji_cli.ts`のみ。10個のコマンド実装moduleのstatic importを除き、
既存の各分岐内で文字列リテラルのawait
importから関数を取得する。共通loaderや新規状態は追加していない。 内部TypeScript → 内部process runner
→ 内部Core bootstrap → version → help → 公開command → 暗黙TUI →
未知commandという判定順序、内部引数の長さ・空文字判定、渡すargs、return/exitを維持した。
webuiの未実装表示とdiagnostics runtimeのCLI内処理も維持する。

残したstatic importはcli_error、cli_help、build_manifest、runtime_paths。
エラー/help/versionとruntime診断に使う軽い共通moduleで、module評価だけではworkspace初期化・Core起動・保存操作・env読取りを行わない。

### 依存graphとbuild入力

変更前後のCLI入口へ`deno info --json --no-remote --frozen-lockfile --config deno.v0.json`を実行し、
static codeだけを入口から辿った。到達module数は159 → 7。7 moduleはCLI本体、上記4共通module、
build_manifestが読むjsr.jsonとhook_api。type依存とdynamic code依存はこの比較から除外した。

| 遅延入口                              | 選択する分岐                     |
| ------------------------------------- | -------------------------------- |
| run_worker_client.ts                  | run                              |
| serve_cli.ts                          | serve、--internal-core-bootstrap |
| core_cli.ts                           | core                             |
| tui_cli.ts                            | tui、引数なし、先頭が通常option  |
| session_cli.ts                        | sessions                         |
| history_cli.ts                        | history                          |
| configuration_cli.ts                  | agent、tool                      |
| failure_diagnostic_cli.ts             | diagnostics runtime以外          |
| runtime/process_runner.ts             | --internal-process-runner        |
| tools/run_typescript_process_entry.ts | --internal-run-typescript        |

全build graphには10個の遅延入口が残った。builderは全local modulesを収集する既存方式のまま。
既存`increment_78_build_provenance_test.ts`のbuild graph
testへ、10入口がbuildInputFilesに含まれる照合を追加した。 この確認は、同梱とruntime
digest/provenanceの対象から遅延した入口が外れないという具体的な動作に対応する。

既存builderで一時出力`.tools/increment-216/henji`へ一回compileし、成功した。
compile中の実stagingで10入口がすべて存在し、開発sourceと同じ内容であることをSHA-256で照合した。
stagingからのcompileで依存解決が成功し、終了後のtemporary cleanupも成功した。
builderの変更、追加include、新しいcompile方式は不要だった。

一時binaryはHenji 0.11.0、Deno 2.9.7、Linux x86_64、source `1f790bb0+dirty`。 build
IDは`671022b74fee5970e28efe7365f20fb2b8020b1c26e32ccfef2fb1d57bb37fa1`。
常用binaryは更新していない。

### sourceとbinaryの実経路確認

12 focused testが成功した。内訳は183の4、140の1、145の3、78の2、146のhelp filterの1、179の CLI
Worker typed configuration error
filterの1。変更したCLI分類／起動／build入力に対応する既存testである。
通常helpは環境・起動権限なしで成功し、localhost history、Core内部bootstrap、serve、run
JSON契約も維持された。

加えて、checkout外の隔離workspace/XDGからsourceと一時binaryをそれぞれ起動し、以下を照合した。
一時stagingは既に削除されており、binaryの入口は同梱sourceから解決した。

- 環境を渡さないroot/subcommand
  helpとversionが成功。未知listの案内、webuiの未実装表示・終了コードも維持。
- 明示tui、引数なし、通常optionの3入口がTUI terminal判定に到達し、非TTYで同じ案内・exit 1を返した。
  TUI表示・キー操作の変更はなく、今回のprobeでは実terminalの操作は行っていない。
- core listのJSON、sessions list、agent/tool list、diagnostics list/runtimeが成功。
- historyは別processのlocalhost HTTPに接続し、履歴本文とSession案内をstdout/stderrへ返した。
- runは未知引数のinvalid_inputと、stdinでtaskを渡した際のrun Worker
  configuration_rejectedをJSONで返し、 stderrを空に保ってWorker終了まで成功した。実model
  requestは発生させていない。
- serveと内部Core bootstrapで隔離Coreを実起動し、core statusで接続を確認してcore stopで終了した。
  内部bootstrapの指定epochをreadbackし、どちらもactive Sessionなし、停止後のprocess exit
  0を確認した。
- 内部run_typescriptはinput/result fileを使い、code
  Workerへ`return { value: input.value + 1 };`を渡し、 resultのvalue=216を確認した。acquisition
  Workerの起動も含むが、外部module import／provider通信は行っていない。
- 内部process
  runnerは既存LinuxProcessExecutorのcontrol/status経路を使い、stdout・stderrを別々に取得し、 command
  exitCode=7・signal=null・operation清算とowner終了を確認した。

初回の一時probeでは非TTY/null stdinに--taskも渡し、既存のinvalid_inputになった。
現行の入力契約をsourceで確認し、taskをstdinから渡すprobeへ修正してsource/binaryの確認を完了した。
このprobeの誤りに伴うproduction変更・再compileはない。

CLI本体と変更したbuild provenance testのtype check・lint、変更fileのformat、git diff
--checkが成功した。 full gateは実行していない。

### 独立review

2026-10-08の利用者指示により、read-only reviewerがCLIとbuild provenance testの差分、
直接consumer、build経路、計画と検証証拠を確認した。上限30分の通常correctness reviewとして実施した。

- 必須finding・任意修正コメントともなし。CLI全分岐の順序、内部引数条件、args、return/exitと、
  help/versionがコマンド実装を評価しない構造は維持されているとの評価。
- 依存graphを独立に再集計し、static code 159→7と全graphに10遅延入口が残ることを確認した。
  builderのruntimeFiles → staging/digest/buildInputFiles経路も照合した。
- 変更した78 build graph testと146 help testを各1件再実行し、成功した。
  隔離cwd・空envで一時binaryのversionを確認し、manifest/build IDが記録と一致した。 staging削除とgit
  diff --checkも成功確認した。
- 全入口のsource/binary smoke、内部Core read/stop、runnerのcontrol/清算、TypeScript結果216は
  保存した証拠と結果文書を照合した。追加修正はない。
- 全smokeの再実行、TUI実操作、実provider、性能測定、追加compile・配置はreviewでは行っていない。

### 記録先と残る未確認事項

一時probeと証拠はgit管理外の`.tools/increment-216/`へ保存した。
依存graphは`imports-before.json`、`imports-after.json`、`import-summary.json`、
compile/stagingは`compile.log`と`staging.json`、CLI実行は`cli-smoke.json`、process
runnerは`runner-smoke.jsonl`。 productionに観測用loaderやログは追加していない。

RSS・起動時間・binaryサイズの改善量は未測定。159→7は静的依存範囲の比較であり、binary全module数や
RSSが減ったという意味ではない。TUI実表示、実providerとのtask成功、常用配置は今回の確認範囲に含めない。
実config・credential・既存保存Session・稼働中Core・常用binaryは変更していない。

変更fileはCLI本体、既存build provenance test、本計画書、現在地を更新する`.handoff/handoff.md`。
構想・architecture・roadmapの正本変更はない。commit/pushは後続の利用者明示指示に基づき実施した。
配置・公開・追加の実provider callは利用者の明示指示に従う。
