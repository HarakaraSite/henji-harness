# Increment 220: CLI実行名をhjhへ変更

## 要件と範囲（2026-10-09）

利用者の別アプリの`henji`コマンドとの衝突を解消するため、このharnessの実行名を`hjh` （Henji
Harness）とする。利用者は「hjhにしよう」と採用した。
もう一方のアプリを将来`hjc`へ変更する案は、本incrementの対象に含めない。

必要な動作は、`hjh`で従来のCLI操作ができ、パッケージのインストールで別アプリの`henji`を
上書きしないことである。CLIのhelp・error・version・TUI内のコマンド案内と通常利用手順も揃える。
プロジェクト名、公開API契約、設定・履歴・credentialの保存先は変更しない。
旧コマンドのalias、データ移行、旧binaryの削除は行わない。

## 現行経路と計画

- `scripts/build_henji.ts`がstandalone CLIと動的Worker entryをcompileする。
  default出力を`dist/hjh`へ、Deno taskを`hjh:compile`へ変更する。
- `scripts/package_henji.ts` → 配布folder/archive → `install.sh`がbinaryを配置し、
  外部toolを配置したbinaryでactivateする。パッケージ名・同梱実行名・配置先を`hjh`へ揃え、
  taskを`hjh:package`へ変更する。
- CLI entryから各command、Core bootstrap、process runnerへ到達する。
  自己起動は`Deno.execPath()`を使うので、source module名はそのまま保持する。
- `resolveRuntimePaths()`が設定・data・stateの所有先を定義する。これを変更せず、
  既存の`henji-harness`配下を使う。JSR・tool/hook契約も保持する。
- production e2e launcherとprovider probeのdefault binary path、README日英・package手順を更新する。
  過去の測定・配置結果に含まれるコマンド名は当時の証跡として保持する。

## 確認

既存のCLI focused testで新しい案内を確認する。既存package/install testで`hjh`の同梱・配置と 同じbin
directoryにある別アプリの`henji`の保全を確認する。 type check・format・lint・diff
checkに続き、新しいstandalone binaryをbuildし、隔離HOME/XDGで
package/install、version/help、Coreの起動・一覧・停止とtmux TUI起動・終了を実経路で確認する。
実providerは使わず、常用配置・commit/pushは今回の実装には含めない。

構想・architecture・roadmapの正本変更は今回行わない。必要なコマンド表記の更新案は本書へ留める。

## 結果

local実装・検証済み。CLI案内とversion、compile/package task、default出力、配布binary、
installer、validation launcher、README日英とHTTP API操作手順を`hjh`へ揃えた。 内部source
module名とbuild identityのdomain、公開API契約、storage rootは保持した。

- focused test: CLI出力・TUI引数/help・command help/error・package/install・production e2eの
  offline確認22件と、headlessのmax-step error表記確認1件が成功。
  archiveに`hjh`を含み`henji`を含まないこと、インストール時に同じbin directoryにある
  別アプリの`henji`を保全することを既存配布testへ加えた。
- 変更TypeScriptのtype check・lint、format、shell syntax、Python syntax、diff checkに成功。 full
  gateは実施していない。
- `hjh:compile`のdefault出力`dist/hjh`をbuildし、`hjh:package`のdefault binary選択から
  配布archiveを作成した。product versionは0.11.0、sourceは`f911aa69+dirty`、build IDは
  `c4d5e6964d6328ef238516789230f79d87d7eec04dbb43b98df92184e94bbabe`。
- 配布installerを隔離HOME/XDGへ実行。配置binaryとpackage binaryのSHA-256一致、
  `hjh --version`、root/command/subcommand help、errorの新表記、別アプリの`henji`実行と保全を確認。
  `diagnostics runtime`のconfig/data/state rootは引き続き`henji-harness`配下だった。
- 外部DenoのないPATHで配置済み`hjh --no-session`をtmux起動し、同binaryのCore自己起動、
  `core list/status`、TUI ready・`/help`・Esc復帰・Ctrl-D detach、detach後のCore存続、
  `core stop`と一覧からの消失を確認した。`--no-session`は非保存Sessionであり、 Coreのactive Session
  IDは存在する。会話は投入していない。
  helperの初期確認では起動待ち条件とSession仮定が誤っていたため修正した。
  `/help`は最初のEnterで補完、次のEnterで実行する現行操作に合わせて確認した。
  これらの修正はgit管理外の確認helperのみで、product側の追加修正はない。
- 実provider requestは0。常用binaryの配置、旧binary削除、commit/pushは未実施。

git管理外証跡は`.tools/increment-220-hjh/`に保持する。`build.log`、`package-result.json`、
`version.txt`、`runtime-diagnostics.json`、`core-status.json`、`tui-ready.txt`、`tui-help.txt`と
`verification.json`を参照する。

## commit・push・常用配置（2026-10-09）

利用者の「コミットプッシュ配置して」により、変更を`59dcdd71`へcommitし、先行する未pushの
218・219等も含めてorigin/mainへpushした。そのclean sourceから公式`hjh:compile`で再buildし、
`dist/hjh`と常用`hjh`へ同じartifactをatomic配置した。build/sourceDirty=falseと配置先の
SHA-256一致を確認済み。旧`dist/hjh`はgit管理外へ退避し、既存`henji`はbyte一致で保持した。

配置した常用binary自体を隔離HOME/XDG・workspace・外部DenoのないPATHから起動し、
version/help/error、従来のstorage root、Core自己起動・一覧・status、tmux TUIのready・
`/help`・Esc復帰・Ctrl-D detachとCore存続、Core停止と解放を確認した。実provider requestは0。
既存の稼働Core/TUIは再起動せず、新規に`hjh`で起動するCore/TUIから適用する。
設定・DB・credential・外部tool/hookは変更していない。

build
identityと退避先・証跡は[配置記録](../operations/native-0.11.0-deployment.md#increment-220のhjh常用配置--2026-10-09)
と`.tools/increment-220-deployment/`を参照する。配置記録も続けてcommit/pushする。

## 常用DBによる起動失敗と復旧

常用配置後にschema1実DBで起動できないことを観測し、利用者の個別承認でschema3のコピーへ切り替えた。
元DBを保全し、切替前後の全保存tuple/hash一致と常用binaryでの既存Session再開・履歴閲覧を確認済み。
詳細は[復旧記録](../operations/native-0.11.0-deployment.md#increment-218の常用dbコピー変換と起動復旧--2026-10-09)と
[218第11.21節](increment-218.md#1121-常用dbの明示コピー変換と復旧2026-10-09)を参照する。

## 正本文書への反映案

architectureの現行操作・process図にある`henji`／`henji run`表記を`hjh`／`hjh run`へ変更する案を
保持する。意味上の変更はCLI実行名のみであり、責務・状態所有・API契約の変更はない。
構想・architecture・roadmapの正本への反映は、対象・理由・意味を示して別途承認した後に行う。
