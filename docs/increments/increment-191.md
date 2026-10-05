# Increment 191 — 標準run_typescriptと実行時std import

状態: 完了（2026-10-05、利用者による通常利用確認・完了承認済み）。
製品実装と追加承認scope（既存3件失敗・91停止修正、std限定import）、各スライス確認・review、 compiled
TUIと実provider総合E2E、645 testの全体gate、source commit・常用配置・配置後確認を完了。
正本変更案反映は未実施。
本書は今回の要件・計画・結果の正本とする。採用前の観測は末尾へ移設し、実験の詳細はresearchを参照する。

## 利用者が必要とする動作

Agentが生成したTypeScriptをtool callで実行し、workspaceや`/tmp`のfile、ネットワークから取得した
dataを処理して、必要な結果を返す。JSON/JSONL/CSVの集計・変換、文字列処理、小さな計算・照合を、
外部Deno CLIやPythonの導入を要求せずcompiled Henji内で行えるようにする。

利用者は実AIがcodeを生成して実行できることと、stdを事前同梱せずimportできることをスパイクで確認した。
当初は計画継続のみの指示だったが、その後スライスごとのlocal実装・テスト・レビューと実provider総合E2E、
取消要件を維持する別process実行が明示承認された。その後source
commit・常用配置も追加承認され、完了した。

## 会話で確定した要件

| 項目         | 決定内容                                                                  |
| ------------ | ------------------------------------------------------------------------- |
| 供給         | `run_typescript`を本体組込みの6番目の標準work toolにする                  |
| code形式     | async関数の本文。`await`、型構文、`return`、`await import(...)`を使用する |
| file権限     | workspaceと`/tmp`のread/writeを許可する                                   |
| network      | 生成code自身の通信も許可する（2026-10-05の追加回答）                      |
| library      | Deno・JavaScript標準API。外部moduleのimportはDeno stdだけに限定する       |
| std供給      | 実行時に取得する。std事前同梱を要件にしない                               |
| その他の権限 | スパイクからnetだけを変更し、env/run/sys/ffiは無効とする                  |
| VM           | VM作成・VM内Agent実行は将来案であり今回の対象外                           |

「6番目」はread/write/edit/bash/bash_outputに加える標準work toolという意味であり、Registry全体の
tool数を6へ制限したり、表示順を6番目へ固定したりする要件ではない。 明示toolsのnamed
Agentは必要なtool名を宣言し、既存のtools filterと空配列の意味を維持する。

## 根拠と確認済み状態

- [実Agent・compiled実行の記録](../research/a23-agent-generated-code-probe-2026-10-05.md):
  実modelが生成した61行のTypeScriptを常用compiled Henji/Deno
  2.9.7で実行し、JSONL二fileの集計・保存を
  照合した。外部Denoを起動せず、生成codeをsemantic履歴からreadbackした。
- 同記録のstdスパイク: Deno 2.9.7のcompiled executableで、公式resolve hookと取得Workerにより csv
  1.0.6と依存streams 1.2.0の9 sourceを実行時に取得した。ビルトイン・外部定義の両経路でCSV解析・
  stream解析・file保存が成立し、hooksなしでは両方ともmodule未発見だった。
- [Deno std公式](https://docs.deno.com/runtime/reference/std/): stdはJSR上の独立packageである。
- [Deno compile公式](https://docs.deno.com/runtime/reference/cli/compile/#dynamic-imports):
  build時に静的に追える依存と、実行時に生成されるcodeの依存を区別する。
- [Deno loader hooks公式](https://docs.deno.com/runtime/reference/loader_hooks/):
  `node:module`の同期`registerHooks()`を使う。非同期`register()`へ置き換えない。

stdスパイクは小さなcompiled harnessであり、製品のfull serve/TUI経路への組込み成功とは区別する。
今回のnetwork許可はその後の決定であり、先行スパイクのcode Workerはnet=falseだった。

## 現行のproduct経路と状態所有

通常利用はTUI/API/CLIのtask受付 → CoreによるExecution開始 → 現在Agent JSON/tool設定の選択 → Agent
Workerの`loadWorkerTools` → 共通Registryのmodel宣言・dispatch → tool resultを次のmodel stepへ 渡す →
Worker proposalをDataへ保存 → Coreが採用・公開、という経路である。

ビルトイン名は`v0/agent/configuration/configuration_resolver.ts`、同梱default/genericの選択は
`v0/agent/configuration/default-agent.json`、実装factoryは
`v0/agent/worker/worker_tool_loader.ts`で構成する。外部folderの明示指定は既存の選択規則に従う。

`run_typescript`も同じRegistryへ登録する。Core/model loop/Dataへ専用の実行・保存経路を増やさない。
tool callのcode・inputとtool resultは既存semantic履歴へ保存する。provider
requestのfactも既存経路を使い、 raw request/response、SSE断片、JSR
response全文の常設収集は増やさない。

呼出しごとのcode Workerと取得Workerはtool実装が所有する。Agent Workerのmodel・credential・DBの
functionやobjectをcode Workerへ渡さず、workspace、JSON input、module取得の通信口をdataとして渡す。
code Workerと取得Workerは、呼出し専用のHenji子process内の別thread/JavaScript環境で動く。
物理processは既存Host ProcessExecutorが所有する。VM backendは作らない。

## tool contract案と実行方式

スパイクと同じ最小contractを計画上の実装選択とする。

```json
{
  "code": "const csv = await import('jsr:@std/csv'); return csv.parse(input, { skipFirstRow: true });",
  "input": "name,value\na,42\n"
}
```

`code`は必須string、`input`は任意JSONで省略時null。`workspace`は絶対workspace rootを示す変数として
利用できる。fileの対象はこのrootや`/tmp`から明示pathで組み立てる。 returnはJSONで既存tool
resultへ返し、returnがない場合はnullとする。
async関数本文であることと、stdは`await import()`で読むことをdescriptionと利用例で示す。

JavaScript driverのBlobからmodule Workerを起動し、code本文はstringとして保持する。hookを設置後、
async関数に包んだ本文をDeno内蔵`stripTypeScriptTypes`の`mode: transform`で変換し、
Worker内で関数として実行する。source実行で本文のliteral importが先行graphへ露出し、repositoryの
vendor/lockへstdを保存する問題もこの方式で解消する。毎回type checkする機能は追加せず、 tool
callごとに新しいcode実行環境を作る。 Workerのpermissionはread/write=[workspace,
`/tmp`]、net=true、env/run/sys/ffi=falseとする。 API credentialとAuthorizationをworker
inputや記録へコピーしない。

構文・実行・取得・結果のJSON化のerrorは既存Registryのtool errorとして返し、Agentがcodeを修正できる
経路へ接続する。取消は既存`context.signal`へ接続し、既存Host process ownerで呼出し専用のprocess
groupを停止・清算し、両WorkerがOSに回収されてから`TurnCancelledError`を既存loopへ返す。別のtimeout、code/output上限、permission
profile選択、拒否matrixを推測で追加しない。

## 実行時module取得

resolve hook → 取得Worker → local file URL → load hookのDeno内蔵TypeScript変換の経路を使う。
source実行では標準loadの先行graph解析が未取得relative依存で失敗するため、load hookで取得済みsourceを
`node:module.stripTypeScriptTypes`の`mode: transform`で変換して返し、各依存もresolve hookへ通す。
新しいcompiler依存やstd同梱を追加しない。JSR
metadataでversionとexportsを解決し、sourceのdirectory構造を保って`/tmp`へ保存する。 relative
importと別std JSR packageの依存も同じ接続で取得する。生成code本文の事前走査やimport書換えはしない。
stdのHTTPS sourceを読む経路も同じloaderへ接続する。
追加指示により`jsr:@std/...`と`https://jsr.io/@std/<package>/<version>/<source>`だけを認め、
そのrelative依存もstd sourceに留まることを取得前に確認する。Node/npm/local/data/blob等のmodule
importは
拒否する。別sourceへのredirectも実行しない。hookを解除する内部bindingは生成関数へ公開しない。
hookがthread単位であるため追加Workerの作成は不可とし、生成codeのimportを同じloaderへ通す。
利用者回答に従い通常fetchとevalは維持する。取得textのevalを禁止する要件は採用していない。

同期hookはMessagePort/SharedArrayBufferで取得Workerと通信する。code Workerのnetwork許可は通常の
`fetch()`等へ使い、JSRのversion/exports解決は取得側へまとめる。親の認証情報やprovider用fetchを流用しない。

スパイクの簡易semver処理を製品の対応範囲へ固定しない。version range選択には既存のsemver実装を使う。
候補は[node-semverのmaxSatisfying](https://github.com/npm/node-semver)であり、利用するversionをlockへ
記録し、compiled経路での利用を確認する。これはloaderの実装依存で、生成codeのnpm対応を採用する意味ではない。
std本体・依存stdはbuildへ入れず、Agentが使ったものをruntimeで取得する。

呼出し内ではmetadataと取得sourceを再利用する。新しいXDG store、跨呼出しの永続cache管理、TTLや
cache自動削除policyは今回追加しない。内部module取得用の一時directoryは`/tmp`へ置く。

## 対象変更箇所と実装順序

1. `v0/agent/tools/`へcode executor、resolve hook、取得Workerを追加する。
   まず標準API・input/return・file処理・通常networkを動かし、次にstdと依存moduleを接続する。
2. `configuration_resolver.ts`のビルトイン名、`worker_tool_loader.ts`のfactory、`default-agent.json`の
   toolsへ`run_typescript`を追加する。既存Registry、明示named tools、filter、外部指定の規則を使う。
   CLIのtool list/inspectは既存のビルトイン一覧から見えることを確認する。
3. `scripts/build_henji.ts`のruntime roots/includesとbuild
   digestに両Worker・hookの必要sourceを含める。
   Blob内からimportするsourceは静的graphへ自動で入らないため、明示root/includeで埋め込む。
   packageは新しいbinaryを供給し、std sourceの配布bundleや外部Deno依存を追加しない。
4. toolのdescription・guidelineとREADME日英の標準work tool説明に利用例を加える。
   TUIは既存の未知tool用表示で利用する。今回専用previewや新しいSurface操作は計画しない。
5. 下記の実経路確認を行い、結果を本書へ記録する。常用配置・commit・公開は別指示で行う。

## 確認するproduct動作

機能実装後、変更箇所のfocused testと必要なtype check・format・lint・`git diff --check`を使う。
testsは次の動作へ対応させ、未観測variantの網羅や件数を完了条件にしない。

| 動作                           | 確認方法・根拠                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| 標準Agentがtoolを使える        | 同梱default/genericとCLI list/inspectの宣言・dispatchを確認。ビルトイン化の明示要件                |
| 型構文付きcodeがfileを処理する | input/return、workspaceと`/tmp`の保存/readbackを実Workerで確認。前回の実AI用途を再現               |
| code自身が通信する             | 確認用HTTP serverへcodeからfetchし、取得dataを処理。今回追加のnetwork許可                          |
| stdを未同梱で使える            | 新しい取得directoryからcsvと依存streamsをJSRより取得し、CSV処理・保存を照合。成功したspikeの実用途 |
| error後に修正できる            | 実行errorが既存tool resultへ返り、修正codeを次のcallで実行できることを確認                         |
| 取消後に利用を継続できる       | 実行中のcodeを既存取消操作で止め、両Worker終了と次task実行を確認。現行turn取消contract             |
| 履歴から振り返れる             | code引数・tool結果・runtime outcomeを既存history CLI/APIでreadback。projectのsemantic履歴要件      |

安定candidateのauthoritative `v0:gate`をcoordinating
ownerが一回行う。失敗時はfocused確認で原因を特定し、 再実行には修正等の具体的理由を記録する。

公式build scriptで`.tools/increment-191/henji`を作り、隔離HOME/XDG/workspaceでproduction serve/TUIを
tmuxから利用する。生成codeの入力fileをLLMへ転記せずstdで集計・保存する一つの実taskを行い、保存内容と
semantic履歴を照合する。TUIでtool activity・結果・取消後の継続を確認し、実configは使わない。

実provider確認案は`opencode-go-chat / deepseek-v4.1-flash / max`、1 task・1 turn、maxSteps=4、
保存先`.tools/increment-191/live/`である。物理request数・step順・HTTP/errorを記録する。
必要最小限の実provider利用という既存許可に従い、実行前に対象・回数・保存先を改めて提示する。
旧実AIの成功を新しいビルトイン/loader実装のacceptanceへ流用しない。

成功条件は、利用者が通常のproduction入口から標準toolを使って、codeの生成・実行・stdによるfile処理・
保存・結果確認を完了できることである。スパイク成功やgate通過だけで完了にはしない。

## 対象外と残る未確認事項

VM作成・remote Agent、強いsandbox、新たな独立process
owner、npmの任意package対応、codeからの既存tool呼出し、 Python全面代替、provider
A/B、生成codeの自動type check、永続module cacheは今回の対象外である。

全std packageと他platformを実測したとは扱わない。今回の受入はLinuxの実利用経路で行う。
std依存の解決に実装判断を変える未確認の公式契約が出た場合は、事実と必要な変更を提示し、機能を狭める
推測で閉じない。計画外のproduct bugは証拠・利用者影響・修正案を返し、独断で修正しない。

## 正本変更と承認境界

構想の目的・Whyは今回変えない。architectureは標準tool一覧とWorkerのcode実行責務、roadmapはF06の
追加採用範囲に追記が必要になる。これらは本計画とは分けて明示承認を得る。
変更対象・理由・意味上の変更は、未適用の
[正本変更案](increment-191-authority-proposal.patch)で確認できる。正本はまだ変更していない。

2026-10-05の追加指示により、本計画のlocal製品実装、スライスごとのテスト・レビュー、必要最小限の
実provider利用、最後の総合E2Eが承認された。正本patch反映、commit・常用配置・公開/release、既存dataの
削除は承認範囲に含めない。構想・architecture・roadmapは変更しない。

## 実装スライスと確認順序（2026-10-05承認）

| スライス | 成立させる動作                               | 実装と確認                                                                                                                                | 状態 |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1        | TypeScript本文を実行して結果を返す           | tool executor、input/return、型構文、workspaceと/tmpのfile、通常network、error後の修正、取消と次call。実Worker focused testと通常レビュー | 完了 |
| 2        | 未同梱stdを実行時にimportする                | 同期resolve hook、取得Worker、JSR version/exportsとrelative/HTTPS依存、既存semver、両Worker取消。CSV/streamsの実取得・保存と通常レビュー  | 完了 |
| 3        | 通常Agentとcompiled Henjiから使う            | 組込み登録、default/generic・明示tools・CLI、build roots/digest、README。設定focused test、公式compiled版のproduction確認と通常レビュー   | 完了 |
| 4        | 人間のproduction入口から今回の機能を完了する | 安定candidateのv0:gate一回、隔離tmux TUIとAPI/履歴、実provider総合E2E、結果レビュー                                                       | 完了 |

各スライスは実装後にfocused test、必要なtype check、format/lint、git diff
--checkを行い、通常レビューの 採用findingを解消してから次へ進む。full
gateは最後の安定candidateだけで一回行う。
テストの親processがlocalhost限定の場合は、net=trueの実Workerを適切な権限のDeno subprocessで確認し、
製品network許可をtest都合で狭めない。取消setup中にawaitがある場合は、listener登録と再確認を組み合わせ、
既に起きた取消も取り逃さず、所有するWorkerを終了する。

総合E2Eはopencode-go-chat / deepseek-v4.1-flash / max、基本1 task・1 turn、maxSteps=4で開始し、
保存先を.tools/increment-191/live/とする。実行前に対象・回数・保存先を提示する。
実AIにCSVのstd処理・保存、code自身のnetwork、workspaceと/tmpの利用を一つのtaskで依頼し、
期待値を別計算して保存内容、tool引数・結果、provider request fact、runtime outcomeをreadbackする。
取消・error後の修正はcompiled production経路の確認用localhost
providerで行い、実providerを浪費しない。
実configと実DBは使わず、credential/Authorizationを記録しない。追加実provider試行が必要なら、具体的理由と
対象・回数・保存先を提示し、必要最小限という承認範囲で行う。

## 計画レビュー結果（2026-10-05）

通常レビューと批判的レビューを独立したreviewerが実施し、Blocker/P1/P2の必須計画修正はなし。
登録・Registry・履歴・取消・buildへの接続と、Agent Workerからcode/取得Workerを起動するスパイクの
成立性を確認した。再スパイクは不要。取消setupの取り逃しとtest親permissionは、上記の実装・確認事項へ
反映する。node-semverのNODE_DEBUG参照はDeno 2.9.7の許可例外に該当し、権限衝突という懸念は棄却した。

## 同期計算中の取消 — 観測と方式変更（2026-10-05、採用承認済み）

スライス1の実Worker確認で、同期の`while (true) {}`はDeno 2.9.7の`Worker.terminate()`後も実行threadを
保持し、呼出元Deno processが自然終了しないことを単独APIでも再現した。未完了await中は自然終了する。
Denoの終了要求はsignal・port切断・event loop wakeであり、V8中断はevent loopへ戻った後に行われる。
通常レビューの初期所見に続く批判的確認では、「両Worker終了」への具体的不一致としてP1を採用した。
非同期取消成功と次task成功だけでこの未達を完了扱いしない。

利用者は「同期計算中も停止できる方式を検討し、取消要件を維持する」を選択した。
元の同一process内WebWorkerだけの方式は、この取消要件を満たせないことが分かった。
取消保証を下げたり生成codeを制限したりせず、次の方式変更を提案し、利用者の「『別processでの実行』を承認します」により採用・local実装継続が承認された。実装確認は以下のスライス結果へ記録する。

- tool呼出しごとに、同じcompiled Henjiを内部code-executor入口で子processとして起動する。 外部Deno
  CLI、別binary配布、VMを要求しない。source開発時は既存source runnerと同様に現在のDenoを使う。
- 物理processは既存Host-owned ProcessExecutor/WorkerProcessOwnerへ接続し、toolが新たな独立process
  ownerを作らない。既存group stop/closedの経路で同期計算中もOSによる停止・清算を待つ。
- 子process内で現在のcode Worker・取得Workerを使う。codeのworkspace/tmp/netとenv/run/sys/ffi=false、
  async本文・JSON
  input/return、std実行時取得は維持する。取消時はprocess全体を終了して両Workerを回収する。
- code/inputとJSON結果は呼出し専用の/tmp fileで内部入口と受け渡す。model/credential/DB objectや
  Authorizationは渡さない。stdout/stderrをJSON
  protocolへ混ぜず、生成codeのconsole出力と結果を分離する。
- 変更はexecutor分離、内部CLI入口、既存factoryへのProcessExecutor接続、build graph、対応testに限る。
  Core/model loop/Dataの新しい実行・保存経路、追加timeout/上限/拒否profile、永続cacheは増やさない。

既存ProcessExecutor → process runner → 同期無限loopのcode Workerという隔離probeで、group stop後の
physical close、child PIDの非生存、残存operation
0を確認した。これは方式の根拠であり、Henjiへの新入口の
製品実装・総合E2Eの代替ではない。証拠は.tools/increment-191/cancel-process-probe.tsと
cancel-process-verification.json。

既存計画は別process
executorを対象外としていたため、この方式変更の採用とlocal実装継続に対する明示承認を得た。
architecture/roadmapの変更案もこの方式に合わせて更新するが、正本反映は引き続き別承認対象。

## 初回スライス実行結果（2026-10-05、追加承認前）

未同梱stdをcompiled製品経路で確認するため、スライス2と3のfactory/build接続は一部並行して実装した。
確認・reviewは責務ごとの範囲で行い、採用findingの解消と安定candidateの総合E2Eをもって今回機能を受け入れた。

- スライス1: TypeScript本文・input省略時null・JSON return、workspace/tmp保存・readback、fetch、
  構文/runtime/JSON error後の次call、setup中取消、同期無限loop取消をfocused testで確認した。
  通常reviewでsource子processのwriteが/tmpだけというP2を採用し、Host側writeを修正した。 generated
  Workerのworkspace/tmp権限は維持し、HOME配下workspaceへの保存・readbackを追加実行した。
  reviewerの解消確認は必須追加指摘なし、次へ進行可能。同期取消P1もprocess停止・清算へ接続し解消。
  証拠: `.tools/increment-191/source-workspace-verification.json`。
- スライス2: source実行でstd CSVの`^1.0.6`と`~1.0.6`、parse/CsvParseStreamと依存streams、 HTTPS
  import、workspace/tmp保存・readback、存在しない版のtool errorと次call成功を確認した。
  sourceの先行graph差はDeno内蔵TS transformを使うload hookで修正した。 追加のliteral
  import確認でvendor/lockへのstd保存を観測し、本文をJS driver内のstringとして保持して
  hook設置後にWorker内でDenoの内蔵変換・関数実行を行う方式へ修正した。literal import成功と
  vendor/lock不変を確認し、限定再reviewは必須指摘なし。 証拠:
  `.tools/increment-191/std-verification.json`。
- スライス3: builtin/default/generic、明示toolsと空配列・filter、設定CLI経路のfocused testは通過。
  実行時にのみ参照するhook/取得Workerをbuild roots/include/digestへ接続し、公式build scriptで
  compiled
  candidateを生成した。READMEへcontractと例を記載した。通常reviewは必須指摘なし。最終candidateでcompiled
  TUIの再確認も通過。
- compiled localhost providerのTUI/API/履歴確認: 3 task、provider request 6回（実AI request 0）。
  構文errorを履歴へ残した後にcodeを修正し、std CSV/stream、file/tmp、fetch、保存期待値一致を確認。
  TUI Escで同期無限loopを取消し、child PID非生存・processSettlement completeと次task完了を確認。
  Core shutdownはexit 0、隔離TUIは終了。初回確認の証拠は `.tools/increment-191/local/`。 source
  loader修正後の安定candidateへ再buildし、同じ製品経路を最終確認する。

### スライス4 — 最終compiled／実provider受入と全体検証

最終candidateは公式build scriptで生成した同じHenji binaryであり、外部DenoのないPATHでTUI/APIから
標準toolを使用した。build IDは`3ee917fd7285582c8f8d34005ee467bee368b616618e191fee7f9d6695d12977`、
Deno 2.9.7 / x86_64 Linux。build inputはlocal変更を含むためsourceDirty=trueである。 証拠は
`.tools/increment-191/build-version.txt` と `build.log`。

- compiled localhost確認: 構文error→修正、std CSV
  parse/CsvParseStreamと依存streams、workspace/tmp保存・
  readback、code自身のfetch、JSON結果が成功した。同期無限loopをTUI Escで取消し、child PID非生存と
  processSettlement complete、その後の次task完了を確認した。最終版結果は `local/verification.json`。
- 実provider初回: opencode-go-chat / deepseek-v4.1-flash / max、1 task、4 request。
  AIは最初にbashでfile情報を確認し、その後生成したcodeでCsvParseStreamへbyte streamを直接渡したため
  parseとの比較で失敗し、診断callのままmax_stepsに到達した。std APIは文字列streamが入力であり、
  Henjiのloader/executor failureではない。生成code・tool結果・短いrequest fact・失敗outcomeを
  `live/`へ保存し、成功として扱わない。
- 実provider再試行: 同じprovider/model/effort、1 task・1 turn、実request 2回、run_typescript 1
  call、 code修正0回でcompleted/canonical/processSettlement
  complete。taskにTextDecoderStreamでの復号という
  公式入力形式を補足した。CSV本文をread等でLLMへ転記せず、生成codeが直接読んだ。 std
  parseとstreamの一致、205件・売上1,098,095円、multiplier 2、adjustedYen 2,196,190円、
  大阪370,262円で最大という結果を独立集計と照合した。保存file、JSON tool result、/tmp実fileの
  readback、最終回答が一致し、provider/model/effortも短いrequest factから確認した。 実AI
  requestは初回を含め合計6回。追加AIcallは行っていない。
- /tmp確認scriptの当初判定は、taskで指定していないexact2field schemaを要求し、正しい追加項目を含む
  保存内容を拒否していた。必須groups/overallと返却されたreport項目の実値比較へ直し、保存済み実fileと
  canonical履歴から再確認した。初回判定は `live-retry/verification-initial-check.json` に残し、
  独立reviewerも実file・入力CSV・tool
  resultを再計算して妥当と確認した。fixture形式を製品要件にしない。
- 成功証拠は `live-retry/verification.json`、`expected.json`、`report.json`、`tmp-readback.json`、
  `tool-calls.json`、`tool-results.json`、`request-facts.json`、`history.ndjson`、`final-answer.txt`。
  canonical user→code→成功結果→最終回答をreadbackできる。credential/Authorizationは記録せず、
  実credential値が保存artifact・decoded semantic contentにないことを確認した。隔離credential copyは
  確認後に除去し、Core shutdown exit 0、確認TUIも終了した。実config/DBは変更していない。
- スライス4の通常reviewは、今回191のproduct受入可、必須correctness findingなし。

### 全体gateの既存未通過事項

authoritative `v0:gate`は一回実行し、今回未変更だった92/173 fixtureの型エラー2件でcheck停止した。
利用者が未適用の2行修正案を明示承認したため、現行APIのproviderEvidenceへ合わせた。修正後の focused
10件と全体type checkは通過。fmt/lint、git diff --checkも通過した。 最初のfull testは91のpost-commit
settlement fixtureで数分進行せず、所有testを停止した。
修正後と未実行tailの確認として、91ファイルだけ除外し、fake binaryを実行できる権限でsuiteを
一回再確認した結果は632 passed / 3 failed。全体gate成功とは扱わない。

- 110 child startup取消: cleanup後error文字列の期待差。
- 170 child control: 現行ACK requested/sentの2eventが期待値に含まれていない。
- 170 S3 commit waiter: 5秒timeout。停止した待機段階は未特定で、fixture/API不一致とは断定しない。
- 上記3失敗は変更前HEAD `50049024984699658be45c286af95a10759f60a3`
  の隔離checkoutでも同一に再現した。
  91の意図的にsettledを通知しないfakeもHEADで診断上限20秒まで完了せず、191による回帰ではない。
  91は初回8件が通過、第9件が停止、第10件は未確認で、再確認からファイル全体を除外した。
- 189 distribution fixtureはgateのallow-run whitelistにfake binaryがなく失敗するが、対象binaryを実行
  できる権限ではfocused/suiteとも成功した。製品実装とgate taskの権限不足を区別する。

証拠は `gate.log`、`check-after-fixture-fix.log`、`fmt.log`、`lint.log`、
`legacy-fixture-focused.log`、`tests.log`、`tests-after-fixture-fix.log`、
`head-baseline-focused-confirmed.log`、`head-baseline-hang.log`、`distribution-focused.log`。
通常reviewerの限定診断も191の必須regression findingなし。2行以外の既存fixture・test task・productの
修正は今回の承認範囲へ追加していない。

### 完了範囲と承認境界

今回の標準tool機能と取消保証は、focused test、各スライスreview、compiled TUI、実providerによる
保存・履歴の実経路で確認できた。全体gateの既存未通過事項は残る。
構想・architecture・roadmapの正本、常用190 binary、実config/DBは変更していない。 更新した
`increment-191-authority-proposal.patch` は反映前の変更案であり、apply --checkのみ確認した。
正本反映、commit、常用配置、公開/release、既存data削除は別承認対象である。

## 追加承認範囲（2026-10-05）

利用者は既存3件の失敗、91の停止、std以外のimport拒否を明示承認した。
追加スライスAは現行終了・ACK・Data契約に追従する既存fixture修正、追加スライスBはstd限定loader、
各focused確認と通常review後にcompiled総合E2Eと安定候補の全体gateを行う。
実providerは必要最小限の既存承認を使う。

### 追加スライスA — 既存testの現行contractへの追従

- 110はstartup取消後の実errorを期待値へ反映し、未admission/未dispatch、取消durability、run解放の確認を維持した。
- 170 child controlは取消terminalのACK requested/sentを反映し、cleanup完了の参照位置を修正した。
- 170 commit waiterはproposal拒否後のfailure_readyに対するData清算後ACKが欠けていた。
  実Core同様の2回目ACKを返し、turn_settledと次taskの確認を維持した。待機timeoutは増やしていない。
- 91は170以降の終了契約で使われないsettlement timeoutを待つ無通知fixtureだった。 commit
  ACK後の実Worker error通知と同じ経路に修正し、canonical commit・request countの保持、
  旧Worker終了、generation交換、次taskと履歴readbackを確認した。production timeoutは追加していない。
- 189 distributionが一時fake binaryとtarを直接実行するため、v0:testのallow-runを既存distribution
  taskと揃えた。 変更は検証taskの権限だけで、code Workerの権限には影響しない。

通常reviewerは変更後の現行契約・実経路・元の利用者動作維持を確認し、必須findingなし。
focusedは110が13件、170 control/waiter各1件、91が10件、合計25件成功。 4fileのtype
check/fmt/lint、git diff --checkも成功した。 証拠は`.tools/increment-191/legacy-followup-*.log`。

### 追加スライスB — std限定import

resolveと取得Worker双方にstd scopeの検査を置いた。生成codeのnon-std importを実際のRegistry経路で
確認し、Node既読込みmodule、npm、bare built-in、local file、data/blob、外部HTTPSはtool
errorになった。
追加Worker作成不可、通常fetch/eval、内部hook解除binding非公開、error後の次callも確認した。

批判的reviewerから取得返信の読込みAPI差替えによるURL検査漏れの指摘があり、trusted
read関数のcapture、 reply URL検査、load時のmirror外拒否で修正した。再reviewは必須findingなし。
sourceと最終compiledのprobeで、std CSV・streams・version range・std HTTPS sourceを実取得し、
読込みAPIをcodeが差し替えてもtrusted loaderがstdを読むことを確認した。

最終compiled build IDは`c4efbdb186d48e34a1a62d508bdaf6defdcd11d14f5be4bfbd1966939b5df8a5`、 runtime
digestは`3fd8620900a9f40ea10b9838b17179ac440ea34fdd146f0e7b257eddb446d849`。 隔離XDG/tmuxのlocal
TUIでnon-std import拒否→Agentのcode修正→std CSV/stream解析→fetch→workspace/tmp保存・
readbackを確認した。同期無限loopの取消は同じcompiled binaryの子PIDが消え、次taskが成功した。
semantic履歴のtool引数・error/resultとcanonical数値も照合した。

証拠は`.tools/increment-191/`の`std-and-distribution-focused.log`、`std-only-source-probe-final.log`、
`std-verification.json`、`compiled-std-policy.json`、`local-std-only-final/verification.json`、
`build-std-only-final.log`。

### 最終全体gate

追加承認scopeの修正とreviewが揃った安定候補で、authoritative `v0:gate`を一回実行した。
check/fmt/lint、全645 testが成功（645 passed / 0 failed、1m41s）。91の停止を含む除外fileはない。
結果は`gate-std-only-final.log`。

### 最終実provider総合E2E

opencode-go-chat / deepseek-v4.1-flash / max、隔離XDG/tmuxの最終compiled TUIで確認した。
初回はcode実行前のprovider応答90秒timeout（1 request）。応答待ち180秒の再試行はCSV APIの誤使用を
Agentが修正し、2回の成功codeで全数値・file/tmp readbackは一致したが、3
requestのstep上限までに最終回答が なかったためturn失敗として記録した。これらを成功E2Eには数えない。

実行で確認済みのCSV API使用例（文字列stream→CsvParseStream、skipFirstRowのobject row）をtaskに示した
最終試行は、1 task / 1 turn / 2 request、run_typescript
1回、code修正0回でcompleted/canonicalになった。 入力CSVをread
toolでLLMへ転記せずcode自身で読み、stdのparseとCsvParseStreamが一致した。
通常fetch、workspace/report.jsonと/tmpの保存・再読込み、205件・売上1,098,095円・乗算2,196,190円・
最大地域大阪370,262円を独立期待値と照合し、tool引数/result/最終回答とrequest
factを履歴からreadbackした。
Coreは正常終了し、隔離credentialの自身が作ったcopyは除去済み、artifact/decoded
semantic内容のcredential値 不在も確認した。実config/DBは変更していない。

追加scopeの実provider利用は合計6 request（1失敗＋3未完了＋2成功）。追加承認前の6 requestと合わせた
191の製品受入確認は計12 requestである。spike/採用前調査の利用回数とは分ける。
証拠は`live-std-only-final/`、`live-std-only-retry/`、`live-std-only-confirmed-api/`のverificationと各log。
最終成功のtool-call/result、report/tmp readback、request-facts、history、TUI captureを保存した。

追加承認scopeは完了。正本変更案はapply --checkのみで未適用、commit・常用配置・公開は別承認対象。

## Commit・常用配置の承認（2026-10-05）

利用者の「コミットと配置して」により、191と追加承認scopeのlocal
commit・常用配置・配置後確認を承認された。 実装・検証記録をsource commitへ保存し、公式build
scriptでsourceDirty=falseのbinaryを作成する。 検証済み版とembedded runtime
digestの一致を確認し、旧binaryを保存してdist/henjiと常用henjiへatomic配置する。 配置版のproduction
Core/TUIを隔離HOME/XDG/workspaceで確認する。実providerの追加呼出は必要ない。
既存Coreは再起動せず、新しいCoreから191を使用する。構想・architecture・roadmapへの正本patch反映、
公開/release・push、旧実データ削除は今回の指示に含めない。

## 常用配置結果（2026-10-05）

- 191の実装・追加承認修正・関連文書をsource commit `e53a2436427d275ff587bce6cff1a98bc5f421c5`
  （`feat: add cancellable run_typescript with std-only imports`）へ保存した。
- 公式build scriptでsourceDirty=falseのbinaryを作成した。build IDは
  `138c9fb339fb94f6d45f4ef446a8d78d3dc6940cbc124f98b2b157c2d58e1d7a`、embedded runtime SHA-256は
  `3fd8620900a9f40ea10b9838b17179ac440ea34fdd146f0e7b257eddb446d849`で、受入確認済み版と一致した。
- 旧190
  binaryを`.tools/increment-191/deployment/henji.dist.previous`と`henji.local.previous`へ保存し、
  staging fileから`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。
  両配置先のversion・manifest・binary SHA-256が一致した。 binary
  SHA-256は`5807077d853e2b247c3b69d663189a4d27c63570b33ab0583e1c443064a31675`。
- 配置した常用binaryのproduction Core/TUIを隔離HOME/XDG/workspaceのtmuxで起動し、
  std以外のimport拒否→code修正→CSV/streams std
  import→通常fetch→workspace/tmp保存・readbackを確認した。 同期無限loopのcode
  processが常用binary自身であること、取消後PIDが消えること、次task継続も通過した。
  semantic履歴と独立数値の照合も成功。local fixture providerは6 request、実provider追加呼出0回。
  確認用Coreはshutdown accepted、exit 0で終了した。
- 実configの非credential 30fileは配置前後でhash一致し、repository workspaceの既存Core一覧も一致した
  （配置前後とも0件）。既存Coreを再起動する操作は行っていない。新しく起動するCoreから191が有効になる。
- 既存の645 test成功と受入版runtime一致を採用し、full gateは繰り返していない。
  証拠は`.tools/increment-191/deployment/`の`build.log`、`deployment.json`、`local-runtime.json`、
  `dist-runtime.json`、`state-check.json`と`tui-check/`の履歴・TUI capture・verification。

配置と結果記録を完了した。正本patchは未適用のままで、公開/release・pushは行っていない。

## 利用者確認・完了承認（2026-10-05）

利用者は常用配置版の通常TUI（openai-chat / gpt-5.6-sol / none、Session表示350eddb0）で、
run_typescript 1回による/tmpへのCSV保存・再読込み、jsr:@std/csvでの集計、workspaceへの結果保存・
再読込み確認を指示した。利用者が示した表示ではtool成功と、りんご170・みかん80・合計250の回答が
確認され、「思ったより動作早い」と報告された。速度の計測値としては扱わない。

続く「インクリメントは完了とする」によりIncrement 191を利用者確認済みの完了とする。
公開/release・push、構想・architecture・roadmap正本変更の追加承認は含まない。

## 採用前A23の原記録

以下は採用前の観測・候補を通常利用メモから移したもの。未決との記載は当時の状態であり、
今回確定した事項は本書上部の要件に従う。

### A23 — `run_typescript`でファイル操作を含む小処理をHenji内で実行（F06、未採用）

- 利用者指示（2026-09-27／29）: 統合評価を未採用候補として記録し、9月29日に検討を再開した。
  Codex履歴のサンプリング、技術確認、gpt-6-astra / xhighによるBlocker限定・10分上限の批判的評価、
  公開実装例の調査と記録を指示した。検討だけであり、採用・実装認可は意味しない。
- 目的・対象: Agentが一時的に行うJSON/JSON Lines/CSVの集計・変換、文字列処理、小さな計算・検証、
  複数Tool Resultの突き合わせを、ファイル読み込みを含めてHenji自身のcode execution Toolで扱う。
  HenjiにDenoを同梱するポータビリティと、AIが書いた処理の副作用の一部をhost/runtimeで機械的に
  制限できる点が中心の利点である。Python固有library・既存資産や適した専用Toolは引き続き使う。
- 候補経路: AgentがTypeScript codeを渡し、Henji側が決めた実行条件でfile取得・加工等を行い、
  必要なresultを返す。当初の`pure`は暫定実験案であり、A23全体をJSON-onlyへ限定しない。
  code形式、JSON input、profile、permission、timeout、入出力上限、library、backendは未決。
  原資料の各64 KiB等は確定仕様ではなく、型構文の除去はtype checkとは区別する。
- 現在の観測（2026-09-29）: Codexの28ログから抽出したPython実行80件では、短い処理とfile操作の
  組み合わせが多かった。Linux／Deno 2.9.7の直接実行で、動的TS Workerのfile readとwrite/net/env/run
  拒否を確認した。批判的評価はBlocker
  0。Belgieの埋め込みDeno＋`run_typescript`等の公開sourceも確認した。
  サンプルはHenji開発作業に偏り、compiled Linux Henjiと実利用の優位性は未確認。
  詳細・証拠・評価範囲は[9月29日の調査記録](../research/a23-run-typescript-investigation-2026-09-29.md)を参照する。
- 追加確認（2026-10-05、利用者指示による実験）: 隔離configの外部`run_typescript`と常用compiled Linux
  Henjiを使い、実Agent（`opencode-go-chat / deepseek-v4.1-flash / max`）が生成した61行のTypeScriptを
  初回で実行できた。JSONL二fileの突き合わせ・地域別集計・保存結果は期待値と一致し、生成codeと結果を
  semantic履歴からreadbackした。1 turn・実request 4回・code修正0回。
  最終回答の数値は正しいが売上順位の補足説明に誤りがあった。taskでtoolを指定し、Agentは先にfile本文を
  `read`で取得したため、自然な選択やcontext/token削減は未実証。標準tool採用・常用配置は未実施。
  [実Agent確認記録](../research/a23-agent-generated-code-probe-2026-10-05.md)を参照する。
- 追加の技術観測（同日、利用者指示によるspike）: 公式loader hooksと実行時source取得を組み合わせ、
  stdを同梱しないcompiled Deno
  2.9.7で`jsr:@std/csv`と依存streamsのimport・CSV処理・file保存が成立した。
  ビルトインと外部定義の両経路で結果が一致し、hooksなしでは両方ともmodule未発見だった。
  全std・全module形式を扱う製品loaderや常用配置は未実施。詳細は上記確認記録を参照する。
- 参照実装（2026-10-01、Pi snapshot `b35af04f465d60c2f15d124ed074476b8986deb4`）:
  Piの内蔵`codemode`は、モデル生成JavaScriptをQuickJS（WebAssembly）上で実行し、
  `tools.<name>(args)`から既存ツールを呼び出す。スクリプト内で複数ツールを
  `Promise.all`／`Promise.allSettled`で並列実行し、結果の突き合わせ・加工をまとめて行える。
  途中のツール結果はそのままLLM contextへ入れず、スクリプトが出力・returnした内容をモデルへ返す。
  A23の小処理に加え、コードからのツール呼び出し・並列実行・必要な結果だけの返却を比較点とする。
  Piではファイル操作も注入されたツール経由であり、A23のDenoによる直接file操作案とは実行経路が異なる。
  参照: [codemode README](../../_refs/pi/packages/codemode/README.md)、
  [内蔵tool実装](../../_refs/pi/packages/coding-agent/src/extensions/codemode/tool.ts)。
  参照追加であり、QuickJSの採用やHenjiへの実装を決めるものではない。
- 技術観測（原資料の報告）: Deno 2.9.7／macOS arm64で、compile済み単一実行ファイル内の動的TypeScript
  Workerが外部Deno CLI・一時`.ts` fileなしで動作し、permission縮小・JSON入出力・timeout・error分類を
  確認した。macOS x86_64はRosetta実行を確認し、Linux／Windowsはartifact生成のみで実機動作は未確認。
- 確認された限界: Worker内OOMはHenji本体を含むprocess全体を終了させた。workspace
  permissionは既存symlink 経由のroot外readを防げず、hostname
  permissionはDNS解決後IPを固定しない。同一process Workerを強いsandbox
  と扱わず、本体の生存が必要なら別process、より強い境界が必要ならbroker／OS・container・VM backendを
  別途検討する。完全な隔離は今回の目的ではなく、これらの強化を利用価値検討の前提にはしない。
  制限対象は`run_typescript`を通る実行であり、bash等も使えるAgent全体の制限を保証しない。
- 未確認・採用判断: Agentが自然に選ぶか、shell/Python比でcorrectness・tool
  call数・修正回数が悪化しないか、 quoting・一時fileが減るか、structured
  resultが後続推論に役立つか、保守負担に見合うかを比較する。現行Tool登録・compile経路に原理的な
  統合障害は見つかっていない。上記実験では外部tool経由のcompiled実行が成立したが、標準採用時の
  contract・実行条件は未確定である。
- 次に具体化するとき: 利用者が対象用途・実行条件の具体化や利用価値検証を指示した時点で、
  現行sourceと調査・実Agent確認記録を使う。実験toolによる成立確認は実施済みだが、標準toolの採用計画・
  製品実装・provider A/Bは未指示であり、利用価値が小さければ標準Toolへ採用しない。
- 関連: R3（tool実行profile・isolation）。本候補は小処理の利用価値、R3は実行境界を扱う。
- 原資料:
  [`2026-09-27-run-typescript-assessment.md`](../research/2026-09-27-run-typescript-assessment.md)。
  同資料のspike・planner
  input参照先はこのrepositoryにはなく、詳細証拠・保留中の検証案は未照合である。
