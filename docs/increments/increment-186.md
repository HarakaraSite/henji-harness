# Increment 186 — A15 外部searchとweb toolのpackage配布

状態: 実装・検証・独立review・正本反映・常用配置済み。sourceは未commit。

## 必要な動作と根拠

2026-10-04の利用者指示によりA15を採用した。利用者はbashでgrep/rgを使う場合の利点を検討し、 「まずは
rg grepだけでよさそう」「外部定義として作りたい」とした。
rg不在時にgrepへfallbackし、共通の対象列挙で両backendの検索範囲を揃えることを明示選択した。
配布について、repositoryでsourceを管理し、binaryと外部tool folderをpackageで配布し、
利用環境のconfig配下へ配置する案を提示した。 追加指示「ではそうしよう web
searchとfetchもその方式にしたい」により、三toolを同じ方式にする。

- `external-tools/search/`でfile名探索、本文が一致するfileの探索、一致行の検索を提供する。
  rgを優先し、rgが見つからない場合だけgrepを使う。find/fdは追加しない。
- Denoで共通に対象fileを列挙し、path/glob等の指定を適用して明示file引数をbackendへ渡す。
  backendの暗黙のignore規則で検索範囲を変えない。結果はfile/行番号/本文またはfile一覧とし、
  完全なrecord単位のoffset/limit/続き情報を持つ。regexpの方言はbackendの説明を維持する。
- `web_search`と`web_fetch`の実装をrepositoryの外部folderへ移す。Exaの既存request/schema/result、
  credential解決、短いrequest fact、fetchのtext/HTML/meta/downloadを維持する。 実tool
  sourceとlocal依存はfolderへ揃え、repositoryや別Denoのない環境でもcompiled binaryが読み込める。
- packageにはbinary、三tool folder、install手順、manifestを含める。default/generic
  Agentは三toolを宣言し、 installerがconfig配下へ配置して既存のtool選択CLIでfolderを登録する。
  実行中Workerのfunctionや過去のconfiguration snapshotを変更しない。
- 外部toolを編集して利用できる目的に合わせ、installerは既存tool folderを維持し、
  `--replace-tools`指定時はpackageのfileをコピーする。他toolのmappingや既存Agent・credential・履歴を維持する。

本採用はlocal source変更・非破壊検証とpackage作成を許可する。公開/release、commit、常用配置、
実provider callは含めない。構想・architecture・roadmapは別途の正本変更承認前に変更しない。

## 現行product経路と変更範囲

task受付 → Hostのconfiguration resolver → Workerのtool loader/factory → model提示/Registry dispatch
→ semanticなcall/resultとruntime outcomeの保存、という現行経路を使う。 現在のweb
toolはloaderにstatic importされてbinaryへ同梱され、default Agentから選択される。 この実装とlocal
schema/download依存を外部folderへ移し、同じ外部import経路から提示・実行する。
外部folderの選択は既存`tools.json`を所有し、factoryにprocess executor、workspace、credential値を
含まないrequestProvider等が注入される。file名・本文検索の結果も既存semantic履歴へ流れる。

buildは`scripts/build_henji.ts`の公式entryを維持する。package工程とinstallerを追加し、
配布artifactに外部folderを含める。旧web toolの実装・static参照と配布参照を同じ変更で整理する。
外部toolの不在を旧同梱実装へ代替しない。

## 実装・確認計画

1. searchを外部ToolFactoryとして作り、実fileと実rg/grepで三操作・同じ検索範囲・続き取得を確認する。
   provider-freeの実Worker–Host–Data経路を使い、processのcancel/終了も確認する。
2. web
   source/local依存を外部folderへ移し、同梱loaderを撤去する。既存のExa、fetch、download、認証・factの
   focused確認を外部factory/loaderへ対応させる。実service contract自体は変更しない。
3. 公式binaryをbuildし、packageを作る。隔離HOME/XDGへpackageをinstallし、repositoryの外に配置した
   binaryから三つの外部toolがload/dispatchされることを確認する。modelとExaのtransportはlocalhostの
   確認用serviceで代替し、実rg/grep、HTTP fetch/download、semantic履歴readbackを確認する。
   local確認用のcredentialだけを用い、値やAuthorizationは証拠に記録しない。
4. 変更source/testのtype check、format、lint、`git diff --check`を確認する。
   focused確認後、authと外部package/importの変更経路を独立reviewへ渡し、最終判断はdefaultが行う。
   full gateは途中確認やreviewで使わない。安定候補の必要なgateは最終候補確定時に一回とする。

通常利用でのmodelの検索操作選択や、実Exa/providerへの到達は未確認のまま区別する。
Surfaceの表示・操作は変えない。旧DBの削除・migration、hot reload、find/fdの条件探索は対象外。

## 正本変更（個別承認・反映済み）

2026-10-04、architecture/roadmapの変更対象・理由・意味上の変更を提示し、利用者の「反映して」により
個別承認を得た。[提示した差分](increment-186-authority-proposal.patch)を両正本へ反映した。

- architectureのtool供給とstandalone配布節:
  web/searchは実装sourceをbinaryへ埋め込まず、packageに同封する
  外部folderをconfigへ配置して既存factoryで読み込むこと、default/genericの三tool選択を明記する。
- roadmapのF02/F06と配布行: A15の三操作とrg→grep、web
  toolの外部供給とpackage/install状態を記録する。
- 構想のWhyや人間による採用境界は変えない。

## 採用元の記録

A15の2026-09-25指示はsearch tool
callを実装し、findとgrepを兼ね備えるかを実装時に検討する、というもの。 当時のtool
setはread/write/edit/bash等で検索専用callがなかった。
今回、file名探索もrgで行えることを確認し、find/fdの追加ではなく三操作を持つ外部searchとして採用した。

## 結果

### 実装と独立review

- `external-tools/search/`は共通列挙・basename/path glob・三操作とrecordページングを持つ。
  実rgとgrepを実Workerへ注入されたmanaged process executorから実行した。no-matchでbackendを
  切り替えず、改行/コロンを持つpathもNUL区切りから解析する。process取消と清算を確認した。
- web sourceとExa schema/download依存を各folderへ移し、旧source・static loader case・ web専用backend
  injectionを撤去した。requestProvider、ToolContext、Exaのrequest/result/fact、
  fetch/downloadを維持した。独立reviewでweb_search第二guidelineの移行漏れを確認し、旧文言を復元した。
  reviewerによる復元確認を含め、対応必須の指摘は残っていない。
- tool list/inspectとresolverは、search/webを同梱と表示せず、tools.json未設定時は理由を返す。
  default/genericは三toolを宣言し、installerが現在folderを登録する。旧同梱webへのfallbackはない。
- package task、tar.gz、manifest、installer、英日READMEと配布手順を追加した。
  A15は通常利用メモから本incrementへ移した。architecture/roadmapへの具体差分を提示し、
  利用者の個別承認後に正本へ反映した。

### 確認

search focused実Worker確認、webの23件とconfiguration/Worker/Coreの16件が通過した。
公式compile後のprovider-free fixtureのlint修正（async without await）によりruntime
inputが変わったため、 最終candidateを再buildした。buildはDeno 2.9.7、version 0.8.0、 source
`e3333fd1eea50fc5cdf14b2074b63f5d91f14cf1`＋dirtyである。local変更未commitのcandidateであり、
常用配置は下記の追加承認に従う。公開/releaseは行っていない。

- build ID: `12d0e87a49d10c39959e85a69973250055bb22fd988a28f0a906332d39e6df7f`
- embedded runtime SHA-256: `37b1afc42c29fd5d2d7846e7c07b25102b56584a61b793b5e957f98a72a8042d`
- binary SHA-256: `deccb343e1bbad794b105409d311b41d590c3858f125d78439f3252c79bd3d95`
- binary: `.tools/increment-186/deployment/henji-verified`
- package: `.tools/increment-186/packages/henji-0.8.0-x86_64-unknown-linux-gnu-7b16c76a.tar.gz`
- 配布file hashの照合: `.tools/increment-186/verification/verified-distribution-path.json`
- 最終外部実行証拠:
  `.tools/increment-186/verification/package-evidence.json`、`package-history.ndjson`

最終archiveをrepository外の`/tmp/henji-i186-verified-51hgw0yt`へ展開し、隔離HOME/XDGへinstallした。
CoreのPATHには隔離binary directoryだけを渡し、別Denoのない経路でproduction serve/APIを実行した。
synthetic modelの9 requestとlocal Exaの1 requestで、三toolの提示・dispatch、hidden/ignored scope、
rgのrecord続き、HTML取得、元byte列の保存、semantic履歴とExa request factを確認した。
保存履歴に確認用credential値は含まれない。実provider/service callは行っていない。

再installで既存toolの編集と他mappingが保持され、明示replace時は配布fileに戻ることを確認した。
その後、配置済searchのsettingsをgrepだけのPATHへ変更し、新SessionのWorkerが更新folderを読み、
実grepでrgと同じ件数を返した。tool source編集→新Workerの反映経路も成立した。

authoritative gateは最初に一件のimport整形で停止した。整形後の実行で、外部toolを登録していない
旧test configによりguideline確認が失敗し、child fetch待ちが進まなくなることを確認した。
該当二fixtureへ外部folderを明示登録し、guidelineとchild HTTP経路のfocused確認4件が通過した。
その後のgateは619件が通過し、既存CLI testの3件だけがtest runnerのDENO_DIR参照権限不足で
停止した。v0:test taskへ既存fixtureに必要なenv参照を追加し、該当CLIのfocused確認4件が通過した。
これは検証taskの修正であり、product runtimeのpermission変更ではない。deno.v0.jsonがbuild inputの
ため、この修正を含む最終binary/packageを再作成した。

具体的なfixture/task修正を理由とした最後のauthoritative `v0:gate`はtype check・format・lintと **622
passed / 0 failed**で通過した（`.tools/increment-186/verification/gate-accepted.log`）。
最後のbinary/packageをrepository外で再確認し、上述の実経路がすべて成立した。

通常利用modelの検索選択、実Exa/providerへの到達は未確認。runtime Surfaceは変更していない。
architecture/roadmapの承認済み差分は反映した。構想は変更していない。
commit・公開/releaseは未実施。常用配置は下記の追加承認に従う。

## 常用配置の承認と結果（2026-10-04）

利用者の「常用配置して」により、検証済みpackageの常用binary・三tool folderの配置と登録を承認された。
source commit、公開/release、実provider callは含まない。検証済みcandidateをそのまま使用し、 build
manifestのsourceDirty=trueを維持する。稼働中のCore/TUIは維持し、新Coreから新binaryを使う。

検証済みpackageのbinaryと全tool fileのSHA-256をmanifestと照合した。旧binaryと、存在する場合の
旧tools.jsonを配置証拠directoryへ保存した。packageのinstallerを使い、常用binaryと外部toolを配置・登録し、
`dist/henji`も同じbinaryへatomic配置した。

- 常用binary: `/home/agent/.local/bin/henji`
- repository binary: `dist/henji`
- tool folder: `/home/agent/.config/henji-harness/tools/{search,web_search,web_fetch}`
- 登録: `/home/agent/.config/henji-harness/tools.json`
- build ID: `12d0e87a49d10c39959e85a69973250055bb22fd988a28f0a906332d39e6df7f`
- binary SHA-256: `deccb343e1bbad794b105409d311b41d590c3858f125d78439f3252c79bd3d95`
- 旧binary・配置・確認証拠: `.tools/increment-186/deployment/installation-ku45so4x/`

二つの配置binaryのSHA-256が検証済みartifactと一致し、全tool fileもpackageと一致した。
常用設定で`tool inspect`が三toolをexternalとして返し、defaultとgenericがsearchを含む三toolを宣言し、
rejectionsが空であることを確認した。配置前後で稼働中Core `84ea2512`／PID `443496`のID、build、
active Sessionが同じであることを確認した。このCoreはsource `442d4cfb`の旧runtimeを維持している。
新Coreへ切り替えてからsearchを使う必要がある。Core再起動と実provider callは行っていない。
