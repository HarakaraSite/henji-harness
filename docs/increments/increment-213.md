# Increment 213 — tool共通のファイルアクセス設定

## 状態

2026-10-07、利用者が以下の方向でlocal実装を指示。local実装・検証を完了した。
後続の利用者指示で公式build・常用配置を承認され、配置と配置binaryの隔離smokeまで完了した。

## 必要な動作と根拠

A31の相談で利用者が承認した動作を実装する。readは場所制限なしで読む。
write/editはworkspace、/tmp、config rootで操作に必要な読取と書込を行う。
run_typescriptは同じ範囲を読み書きする。共通denyでHenjiのcredential rootへのアクセスを除外し、
追加のcredential保存先は人間が設定する。未知のcredentialを自動識別しない。
run_typescriptのdenyは既存のコード本文照合を維持し、動的な組立てを判定できないことは利用者了承済み。
bashはパス判定できないためunmanagedとして対象外。read/write/editのsymlink拒否は維持する。

## 実経路と責務

CoreがSessionを開きWorker起動時にtool loaderが現在configを読み込む。 組込みfile
toolはcheckedPath/readWindow/readTarget/atomicReplaceを使い、run_typescriptは 管理process内のDeno
Worker permissionを使う。外部search/git_inspect/web_fetchはToolFactoryInputから
共通パス判定APIを受け取り実際の対象・検索・保存操作へ適用する。web_searchのprovider認証や
Hostの履歴保存はtoolの処理対象ファイルではない。

## contractと計画

- 共通設定はconfig rootのtool-paths.json、schemaVersion: 1、deny配列とtoolsオブジェクト。
  tools.<tool名>.allowが各toolの許可範囲。設定済みallowは既定へ追加ではなく置換する。
- workspace、config、credentialsというsymbolic entryを現在実行のrootへ解決する。
  絶対pathと~も使用できる。相対tool引数はworkspace基準。
- 既定allow: read=/、write/edit/run_typescript=workspace+/tmp+config、
  search=/、git_inspect=workspace、web_fetch=workspace+/tmp。新規file toolの未指定allowはworkspace。
  共通denyは実際のHenji credential rootを既定とし、設定denyは追加する。
- Tool.fileAccessにnone/read/read-write/unmanagedを持たせる。外部toolも同じ宣言と共通APIを使用する。
  宣言自体は任意コードへのOS
  sandboxではない。run_typescriptはallowをDenoへ渡しdenyを本文照合する。std取得用のcall専用cacheは内部処理としてreadに加え、/tmp全体を再許可しない。
- 旧run-typescript.jsonは読まない。migration/dual-readは作らず、実fileを削除しない。
- tool設定・分類はWorker起動snapshotへ残す。model向けtool schemaへ構造fieldは追加せず、
  既存descriptionに展開済みallow/denyを記載する。
- A31を本incrementへ移す。構想/architecture/roadmapは変更せず、必要な意味の変更案はここへ留める。

## 確認

新しいrootでのread/write/edit、共通deny、symlink拒否維持、設定snapshot、外部toolの検索・保存・git対象、
run_typescriptのconfig読み書きとdeny本文照合をfocused
testとprovider-freeの本番Worker経路で確認する。 type check/format/lint/git diff
--checkを実行する。TUI Surfaceは変更しない。実provider callは行わない。

## 承認境界

当初はlocalコード・文書変更と非破壊的検証のみ。後続の「配置して」でbuild・常用binaryと該当外部toolの更新を承認された。実credential・保存DB・設定値の変更、公開は含めない。

## 未確認・制限

外部toolの任意コードがAPIを使わず直接アクセスする場合の強制sandboxは対象外。
run_typescriptの動的path deny限界とbash対象外は了承済み。

## 実装・確認の記録

- 共通設定・policy・Tool.fileAccessを実装し、Loaderから組込み/外部toolへtool別policyを渡す。実際の
  Workerでworkspace外read、config/tmp write、config edit、共通deny、symlink拒否、
  run_typescriptのconfig読み書き、allow置換、新Worker反映、起動snapshotを確認した。
- 独立reviewで3件のP2を採用: searchが~展開結果を実I/Oに使わない、gitのdeny alias実参照先が
  pathspecへ届かない、run_typescriptのallow置換がstd import内部cacheの読取も拒否する。
  いずれもsourceから利用者影響と実code再現が揃ったcorrectness問題として採用した。
- std importの回帰は実際のWorker、allow=[config]、jsr:@std/csv importで
  /tmp/henji-typescript-*/reply-1.jsonのNotCapableを再現した。修正ではcall専用cacheのreadだけを加え、同じ
  Worker probeでstd import成功と、allow外の通常fileが引き続きNotCapableになることを確認した。
- 独立reviewの3件は単一の再reviewで解消確認済み。deny aliasの同じ問題は
  read/write/editのsymlink拒否経路でも再現し、共通APIのcanonical
  deny判定を揃えて実Workerで3toolの拒否を確認した。
- 最終focused確認は新213の5件と既存191/204 executorの2件が成功。最後のdeny
  alias修正後に新213の5件を再確認した。
  既存の起動configuration・file操作・外部search/git/webのfocused確認も成功した。
  v0:check、最終変更のtype check、変更fileのformat/lint、git diff --checkが成功した。 実provider
  call、実credential/config/DB操作、常用配置は行っていない。std
  import確認だけは公式JSRからmoduleを取得した。
- READMEと外部tool開発文書を新設定・必須fileAccess・共通APIへ更新し、A31を通常利用メモから本incrementへ移した。
  構想・architecture・roadmapの正本は今回変更していない。

## 批判的review後のGit allow修正

2026-10-07、利用者がコードとtestの批判的reviewを指示した。独立reviewで、
git_inspectがallowを実際のGit対象へ適用していないP2を採用した。
実factoryと実Gitでworkspace=repo/appでもrepo/outside.txtと外だけを変更したcommitが返り、
workspace=repoかつallow=[repo/app]では許可内pathsまで起動root判定で拒否された。 既存213
testはworkspace=repository rootだったため検出できなかった。利用者が修正を承認した。

repository検出の内部metadata操作と対象fileの許可を分離し、allow内だけをGitのpositive
pathspecへ渡す。 pathsを指定した場合はGit自身でglobを照合し、候補名と共通policyの共通範囲をliteral
pathspecへ変換する。
候補はindex/tree/historyの名前から取得し、許可外worktreeの内容をdiffして選ぶ処理は加えない。
共通denyの字面と実参照先による除外は維持した。allowがrepository全体を含む場合も通常のGit対象を保持する。

実Workerで子workspaceの既定allowとsubtreeへのallow置換を確認した。
status/diff/log/show、共通deny、指定file/glob、許可外だけを指定した空結果、削除済みfileのshow/revision
diff、 staged
diffを確認する回帰testを追加した。既存201の通常Git操作・paging・未導入Git/非repository確認も成功した。

単一の15分以内の再reviewで元P2の解消と通常Git操作を確認した。
再reviewで見つかったpaths指定付きstatusのstaged deletion消失も採用し、 indexから消えた名前をcached
diffから候補へ追加した。親が同じ実Git probeで通常Gitと表示の一致を確認し、
実Worker回帰testでもstage済み削除の表示を確認した。

最終focusedは213外部5件＋既存201の2件が成功。局所type check、format/lint、git diff
--checkも成功した。 実config/credential/DBの変更、実provider call、build・常用配置は行っていない。

## 常用配置

利用者の「配置して」により公式buildと常用配置を完了した。 詳細とbuild
identityは[配置記録](../operations/native-0.11.0-deployment.md#increment-213の配置--2026-10-07)を参照する。
配置binaryのCore/Worker、常用外部toolのロード、共通deny、config IO、Gitの既定/subtree allowと
stage済み削除の表示を隔離環境で確認した。外部provider requestは0回。
既存の稼働Coreは再起動していない。新しいCoreから適用する。

## searchの既定allow変更

2026-10-07、利用者が/var等のworkspace外も検索できるよう、searchの既定allowをreadと同じ/へ
変更するよう指示した。searchはfile書込を行わない。共通denyは維持し、探索中のdeny配下は列挙から
除外する。denyを直接指定した場合の拒否と実参照先の判定も既存処理を維持する。

実経路はWorker起動時の共通policy読込から外部searchのfile列挙、rg/grepへの許可file引渡しまで。
既定allowとmodel向けdescription/guidelineを更新し、実Workerでconfig rootの一覧・内容検索と
credential rootを指すaliasの除外を確認する。既存の常用配置指示の範囲で公式build・再配置し、
配置binaryでも隔離config rootの検索とdeny除外を確認する。実provider callは行わない。

実Workerのfocused testは成功し、test経由のtype checkと変更sourceのformat/lint、git diff
--checkも成功した。 配置binaryのcompiled Core/Workerと常用search moduleでconfig
rootの一覧・内容検索、deny配下の 探索除外、denyを指すsymlink除外、credential
root直接指定の拒否を確認した。 localhostのfixture requestは10回、実provider
callは0回。確認用Coreはexit 0で終了した。
buildは`345a22c9fdbe5050acd013d48cefa63860e22ab25def3fd693b0eed2e7cc4815`、常用Coreは再起動していない。
詳細は[追加配置記録](../operations/native-0.11.0-deployment.md#searchの既定allow変更と再配置--2026-10-07)を参照する。
