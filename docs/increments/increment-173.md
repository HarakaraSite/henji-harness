# Increment 173 — 外部toolを含む共通APIキー登録

更新日: 2026-10-03

ステータス: **完了（2026-10-03、利用者承認）。常用配置・配置先production
TUI確認済み、キー登録は利用者確認済み。commit/pushは未実施。**

利用者の「その次にapiキー登録機構の機能追加」により、Exa検索・web_fetch downloadの
[Increment 172](increment-172.md)の後に進める第2段階として採用した。

## 採用要件

- 人間は既存TUIの`/login`からAI providerと外部tool用serviceのAPIキーを登録・更新できる。
- credential登録・保存・解決は共通化し、model catalog/selectionとservice固有の動作は分ける。
- 外部toolはcredentialの非secret ID・表示名・用途・認証方式を宣言し、登録一覧へ供給する。
  Exa専用の登録画面や保存機構にはしない。
- 外部toolはキー値を受け取らず、共通request機構がrequest時にcredentialを解決・挿入する。
- ExaのBearerと、Braveの`X-Subscription-Token`等の認証header差を宣言で表せる。
  共通request機構のBearer固定部分を必要な範囲で汎用化する。
- 外部toolとしてBrave等を後から追加しても、専用のキー登録・保存処理を追加する必要がない構成にする。
  Brave検索backend自体の実装は本段階の必須要件ではない。
- credential値とAuthorization等の認証headerは、Definition、selection、manifest、会話履歴、通常factへ記録しない。

## 現行経路・後続計画の入力

既存resolverは任意authProfileを`<XDG_CONFIG_HOME>/henji-harness/<authProfile>`へ対応させる。
登録catalogは現在model provider宣言から生成され、tool向けのrequest seamはBearer固定である。
172ではExa APIがBearerも受け入れる契約を使い、キーfileを直接用意する。
本段階はその保存形式・resolverへ合流する。

宣言の正本・読取り時点・active toolと登録一覧の対応・共通HTTP request契約・TUIの表示と操作は、
172後の現行product経路に照らして以下の実装・確認計画へ定めた。
TUI確認は隔離XDGとtmuxのproduction経路で行う。実provider確認は別途対象・回数・保存先の承認を必要とする。

構想・architecture・roadmapの変更案は本書へ留め、別途承認前には正本へ反映しない。

## 実装・確認計画

現行の人間の操作は`/login` → remote catalog UI → Coreのcredential catalog →
`credentialRegistrationTargets` → 専用のkey入力 → Coreの登録 → 既存credential fileへの保存、
request時はWorker-local resolver → HTTP adapterへの挿入、という経路である。 model
providerの宣言が登録一覧の唯一の入力になっていたため、同じ経路へtool/service用の
非secret宣言を加える。新しいkey保存先やkey値をWorkerへ返す経路は作らない。

- 非secret宣言は`<configRoot>/credentials/*.json`へ置く。Exaを同梱の宣言として供給し、
  外部toolは同じ形式でauthProfile、label、purpose、method、consumer identityを定義できる。
  executable tool
  DefinitionをCoreで評価して一覧を作る必要はない。宣言の変更はCore再起動から反映する。
- 一覧はauthProfile単位でproviderとtool/serviceの利用先をまとめ、既存TUI入力・保存・presence確認へ合流する。
  model catalog/selectionへserviceを加えない。共通の登録方式はapi-key、既存ChatGPT
  OAuthは既存経路を使う。
- HTTP認証headerはtool Definition側の非secret request contractでBearerまたは指定headerを選べる。
  credential profileと認証headerを分けるため、同じkeyを使う複数routeでもheader方式を固定しない。
  値の挿入は共通dispatcherだけで行う。BraveのGETとX-Subscription-Tokenを同じ経路で利用できる。
- エラーメッセージは英語とし、credential値・認証headerを含めない。
- focused確認はExa／外部Brave宣言の共通登録・更新・resolver readback、model一覧への非混入、
  header方式を指定したGETのcredential挿入と非露出、既存provider登録・OAuth経路の保持を対象にする。
- TUIは隔離XDGのtmuxでproduction経路を起動し、`/login`のservice表示、dummy
  key保存、presence更新を確認する。 実keyを入力せず、実provider callは行わない。full
  gateは計画しない。

利用者の「僕がファイルにキーを登録する　一旦それで確認しよう」により、173の実装を保留した。
2026-10-03の「登録した」を受け、172の実Exa probeはauto/deep各1回で成功した。
結果の正本は172。2026-10-03の「次のインクリメントに進んで」で173を再開した。

登録一覧は各Sessionのactive toolに絞らず、provider宣言と同じく利用可能な非secret宣言から作る。
外部tool側はキー値を含まない宣言を`credentials/*.json`へ供給する。Coreはstartup時に読む。
HTTP認証方式は登録方法（API key入力／ChatGPT OAuth）とは別のrequest-level情報として扱い、
共通dispatcherがBearerまたは指定headerへ値を挿入する。外部serviceのAPI名を短いrequest factへ
保存できるようmetadataのAPI識別子をstringとして扱う。保存fileとresolver、model
catalogの責務は増やさない。

根拠: [Brave認証](https://api-dashboard.search.brave.com/documentation/guides/authentication)は
GETと`X-Subscription-Token`、[Exa Search](https://exa.ai/docs/reference/search)はBearerにも対応する。
172の実行証拠はBearerでHTTP 200。これらの経路を2026-10-03に確認した。

実provider call・常用配置・commit/pushは本incrementのlocal実装には含めない。

## 実装結果（2026-10-03）

- `CredentialDeclarationV1`を追加し、非secretのschemaVersion、authProfile、label、purpose、
  method、consumersを定義した。Exaの宣言は同梱し、外部宣言はconfigの`credentials/*.json`から Core
  startup時に読む。READMEへBraveの宣言例とrequestの認証指定を記載した。
- credential登録catalogはproviderとserviceをauthProfile単位で集約する。共有profileは一つの行と
  保存fileへ合流し、consumerと用途をまとめる。serviceはmodel provider/catalogへ追加しない。
- Core APIのcatalog／presenceとremote TUIへconsumer／用途のmetadataを通した。`/login`の
  service行は表示名・用途・presenceを示し、既存の伏字入力、保存、更新、presence再読取りを使う。
  provider行とChatGPT OAuthの登録方法は既存のままである。
- `physicalIo.requestProvider`へBearer／指定headerの非secret authenticationを追加した。
  credential値の解決・挿入は既存Worker-local dispatcherで行う。GETはbody未指定のまま送信できる。
  外部serviceのAPI識別子とHTTP methodを短いfactへ保存・readbackできる。
- 既存credential file writer／resolverの保存形式は変更していない。実Exa keyのfileには書き込まず、
  検証はtmp配下のdummy keyだけで実施した。

## 検証結果

Rootのfocused確認は20件成功。対象は新173のauxiliary/declaration 3件、registration/Core API
3件、既存135のcredential登録5件、144のremote TUI 2件、Exa web_search 7件である。
新しいtestは共通登録・更新・resolver readback、shared profile、model一覧への非混入、named header
GETとdefault Bearer、factの非露出、TUIの選択・伏字入力・presenceに対応する。
source/testのtypecheck、対象format/lint、`git diff --check`も成功した。SDKの型探索があるため
typecheckは`--cached-only`を外し、runtime focused
testは別typecheck後に`--cached-only --no-check`で実施した。 full gateと実provider/model
callは実施していない。

### 隔離production TUI

確認資料: `/tmp/henji-increment-173-tui-3ll6yei5/evidence/`。CoreとTUIはsource版の通常CLI経路を
tmux上の100×32 terminalで起動し、XDG config/data/stateを同tmp配下へ分離した。 network
permissionは127.0.0.1だけとし、実provider/model requestを行っていない。

1. `/login`へOpenRouter、OpenAI、ChatGPT、同梱Exa、外部JSONのBraveが表示された。
   serviceは`Exa — API key · Web search · missing`形式で表示され、空provider区切りは出なかった。
2. Exaのdummy key入力が伏字になることを確認して保存し、成功noticeと`present`への更新を確認した。
   再び同じ行から別dummy keyへ更新し、既存の保存fileをreadbackして更新値との一致を確認した。
3. Braveも同じ専用入力・保存経路で登録し、再度開いた一覧でExaとBraveが両方`present`となった。
4. 確認資料と隔離data/stateの保存内容に三つのdummy key値が含まれないことを確認した。
   TUIを終了し、この検証で起動したCoreを通常`core stop --connect`経路で停止した。

追加の`/provider`確認は、ChatGPT account未登録のため一覧APIがHTTP 500となった。
`catalogRead`が全providerのdefaultEffortを要求し、ChatGPTの登録IDなしで例外となる既存の
[B6（後続のIncrement 174へ採用）](increment-174.md#採用要件と実行証拠)
と同一である。173の変更前から存在し、修正は未採用。model一覧へのservice非混入は、ChatGPTを
対象外にしたfocused Core APIでprovider集合が宣言集合と一致することを確認した。

local確認時点では常用配置・commit/push・利用者自身の通常利用による受入は未実施だった。
その後の配置結果は下記を参照する。

## 常用配置（2026-10-03）

利用者の「まず173の配置をして　僕が確認する」により、172を含む173を常用binaryへ配置した。
「それがうまくいったらB6を修正しよう」に従い、B6の修正は利用者の確認成功後に進める。

公式`henji:compile`で未commitの172／173を含むsource `49e8195b…+dirty`からbuildした。 build
IDは`f76acf2c67d3b4b7d3fcf40d1417f1284abab3c10440e22a14cc5e5c2c9be41c`。
成果物を`/home/agent/.local/bin/henji`と`dist/henji`へ配置し、両配置先とbuild成果物のSHA-256
`4ee5f311d3574edb53c6236fb2ca70e19d7def0a31aa1c9ddcc3beb2d6f887a2`が一致した。
旧binaryは`.tools/increment-173/henji.previous`へ保存した。稼働中のCoreは停止せず、
新しく起動するCore/TUIから適用される。

配置先binaryを隔離XDGの100×32 tmuxで通常`henji`として起動し、ready表示、Coreのbuild ID一致、
`/login`のExa行、dummy keyの伏字入力・保存・再表示で`present`となることを確認した。
確認資料と隔離data/stateに入力値がないことも確認し、この検証用Coreだけを通常stop経路で停止した。
実provider/model callは行っていない。実config・登録済みExa keyへの書込みはない。

配置記録は`.tools/increment-173/deployment.json`、配置先TUIの確認資料は
`.tools/increment-173/deployed-tui/`。配置確認時点ではcommit/push・利用者による受入は未実施だった。

### 利用者確認

2026-10-03、利用者の「キーの登録はできた」により、配置版でキー登録の成功を確認した。
同時に報告された追加指示の取りこぼしは173の登録機能とは別のB7として通常利用メモへ記録し、
利用者指定の順番でB6修正後に対応する。

同日の「現在のインクリメントは完了とする」により、本incrementの完了承認を受けた。
B8の失敗分類と失敗情報保存の拡充候補は通常利用メモへ記録し、B8対応時に詳しく検討する。
B6／B7／B8は本incrementの残作業とせず、後続の対応として扱う。commit/pushは未実施。
