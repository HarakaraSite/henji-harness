# A23 — Agentが生成したTypeScriptのcompiled Henji実行確認

確認日: 2026-10-05（JST）。状態:
利用者が指定した実験を完了。標準toolへの採用・常用配置は未実施。

## 目的と確認経路

利用者の「agentがコードを実際に組み立て、それが実行できるか確認したい」に従い、
実modelが生成したコードをHenjiのtool call引数から実行し、結果を照合した。
集計コード・アルゴリズム・期待値はmodelへ渡していない。依頼本文には対象file、集計条件、保存形式を指定した。

常用compiled binaryを隔離HOME/XDG/workspaceで起動し、外部tool
factoryの既存経路へ実験用
`run_typescript`を登録した。Agent設定のtoolsは`read`と`run_typescript`、agentsとhooksは空。
production serve/APIでtaskを受け付け、既存Dataのsemantic履歴をcompiled history
CLIからreadbackした。 本体source、実config、既存Core/TUIを変更していない。

実験toolはcodeをasync functionの本文として受け、`workspace`と任意のJSON
`input`を供給する。 型注釈を含むcodeを`application/typescript`のBlob
URLからmodule Workerへ渡し、return値をJSONのtool結果にする。
実行Workerはworkspaceのread/writeを許可し、net/env/run/sys/ffiは無効にした。
これは今回の実験条件であり、採用済みのtool contractやpermission
profileではない。
Workerのpermission設定は[Deno公式仕様](https://docs.deno.com/api/web/workers/#WorkerOptions)を確認した。
強い隔離やOOM耐性は今回確認していない。

## 実Agentの操作と結果

- provider: `opencode-go-chat`、API: `openai-chat-completions`。
- model: `deepseek-v4.1-flash`、effort: `max`。
- 1 turn、物理request 4回。追加の実provider試行は行っていない。
- 実行時刻: 2026-10-05 00:46:54.767–00:47:41.905 JST（約47秒）。
- Session: `e661eaed-18d2-4636-88b3-ebcac639e157`。
- Execution: `cdc0f950-95a4-416f-8777-a6b0f6f96932`。
- runtime source: `def02bb2659cc70d84ae7779245fa5af35b7c915`、dirty false、Deno
  2.9.7。
- build ID: `33bf9e59e3937a228d734d64c4f96d8f916bfe4e38d9d1ebcf7cb2cd9dc3a00d`。

依頼は、注文240件と返金27件のJSONLを突き合わせ、completed注文の地域別売上・返金・差引額を集計し、
`report.json`へ保存して報告することだった。cancelled/pending注文とその返金は対象外と指定した。
期待値はmodelが読めない証拠directoryへ置き、runnerの計算を別のPython集計でも照合した。

実際の操作は次の順だった。

1. `read`で`data/orders.jsonl`と`data/refunds.jsonl`を読む（2 call、同じmodel
   step）。
2. Agentが61行のTypeScriptを生成し、`run_typescript`へ渡す。
3. codeが両fileを直接読み、注文IDのMapで返金を突き合わせ、地域別集計を作り、fileへ保存する。
4. `read`で`report.json`を読み、最終回答を返す。

生成codeには`text: string`、型assertion、`Map<string, ...>`、`interface Row`が含まれる。
初回のcode実行は成功し、code修正・再実行は0回。すべてのtool
resultがsuccessだった。
Workerでの型構文の実行成立を確認したもので、生成codeを別途type
checkした証拠ではない。

| 地域 | completed件数 |    売上円 | 返金円 |  差引円 |
| ---- | ------------: | --------: | -----: | ------: |
| 京都 |            63 |   340,374 |      0 | 340,374 |
| 東京 |            62 |   333,681 |      0 | 333,681 |
| 大阪 |            62 |   334,373 | 36,237 | 298,136 |
| 全体 |           187 | 1,008,428 | 36,237 | 972,191 |

保存されたJSONは地域の順序・件数・各金額・全体集計を含めて期待値と一致した。
toolのreturn値も同じ集計で、返金27件のうちcompleted注文に対応する21件を算入していた。
Executionはcompleted、adoptionはcanonical、processSettlementはcompleteになった。
生成code・tool result・最終回答を保存履歴からreadbackできた。

最終回答の数値と首位の京都は正しい。ただし「売上額では大阪(334,373円)がわずかに上回る」という
補足説明は誤りである。京都の売上も340,374円で大阪より大きい。
これはmodelの付随説明の誤りとして記録し、code実行と集計の成功から区別する。

## 配布・実行条件の確認と限界

Henji側のPATHは空の隔離bin directoryだけで、外部Deno/Pythonを起動していない。
生成codeを一時`.ts` fileへ保存する処理はなく、確認workspaceにも`.ts`
fileはなかった。 実験用外部tool自体のTypeScript
sourceは既存loaderで読み込んでいる。 credentialは隔離configへmode
0600で一時コピーし、実行後にそのコピーを削除した。 保存artifactと履歴のimmutable
contentにcredential値がないことを確認した。 Authorizationやraw
request/responseは取得・記録していない。

事前のlocalhost確認は実Agentの生成能力の証拠ではなく、compiled実行経路の確認である。
型注釈付きの手書きcodeで240行のfile読込み、合計42の計算、file保存・再読込みが成功した。
最初のlocalhost応答はstreaming requestにJSON
responseを返し、次の応答はusageをterminal前に置いたため
失敗した。確認用serverをSSEの現行契約に合わせて修正し、成功した確認は2
requestだった。 product sourceをfixtureに合わせて変更していない。

今回は1 model・1
taskの成立確認である。`run_typescript`をtaskで指定しており、自然なtool選択の比較ではない。
Agentは先に両fileを`read`で取得したので、入力をLLM
contextへ入れず処理できる利点を実証したとはしない。 shell/Pythonとの比較、tool
call数・token削減、SQLite/library/import、コードからの既存tool呼出し、
取消の実操作、他platformは未確認。

## 証拠

ローカルのgit管理外artifactは[`.tools/a23-agent-code-probe/`](../../.tools/a23-agent-code-probe/)に保持する。

- [実験tool](../../.tools/a23-agent-code-probe/tool/index.ts)と[runner](../../.tools/a23-agent-code-probe/probe.ts)。
- [Agentへ渡した依頼](../../.tools/a23-agent-code-probe/live/task.txt)。
- [生成code原文](../../.tools/a23-agent-code-probe/live/agent-code-1.ts)（async
  function本文）。
- [tool calls](../../.tools/a23-agent-code-probe/live/tool-calls.json)と[tool結果](../../.tools/a23-agent-code-probe/live/tool-results.json)。
- [保存された集計](../../.tools/a23-agent-code-probe/live/report.json)と[期待値](../../.tools/a23-agent-code-probe/live/expected.json)。
- [最終回答原文](../../.tools/a23-agent-code-probe/live/final-answer.txt)。
- [semantic履歴](../../.tools/a23-agent-code-probe/live/history.ndjson)、[Execution readback](../../.tools/a23-agent-code-probe/live/execution.json)。
- [照合結果](../../.tools/a23-agent-code-probe/live/verification.json)、[runtime情報](../../.tools/a23-agent-code-probe/live/runtime.json)。
- [localhost確認結果](../../.tools/a23-agent-code-probe/local/verification.json)。

実験runtimeとDBは`/tmp/henji-a23-live-87d52932a1451d2c/`に残し、起動した確認用Coreは終了した。
標準tool採用、product正本の変更、常用配置、公開は今回行っていない。

## 追加確認 — 生成codeからのstd import（2026-10-05）

利用者は読書き対象をworkspaceと`/tmp`、tool供給を本体組み込みの6番目の標準work
toolと指定した。 libraryはDeno・JavaScript標準APIとDeno
stdとし、stdはAgentが作ったscriptからimport可能にするという
意味であると明確化した。stdのバイナリ同梱は今回の要件に含めない。
この指定をstd事前同梱の承認へ読み替えない。製品実装はまだ行っていない。

現在のcompiled Henji・同じ実験toolで、localhostの確認用modelから次のcodeをtool
callとして渡した。
これはmodule読込みの技術確認であり、実Agentによるcode生成の追加確認ではない。

```ts
const library = await import(specifier);
const result = library.parse("name,value\na,42", { skipFirstRow: true });
```

| specifier                                  | 観測                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `jsr:@std/csv`                             | `TypeError: Module not found: jsr:@std/csv`                             |
| `https://deno.land/std@0.224.0/csv/mod.ts` | `TypeError: Module not found: https://deno.land/std@0.224.0/csv/mod.ts` |

例外をcode内で捕捉して記録したため、確認用Execution自体はcompletedだがstd
importは成功していない。 実provider requestは0回、localhost model requestは2回。
前回のJSONL処理成功をstd import成功の証拠にしない。

これは現行のcompiled module読込み経路では指定moduleを解決できない観測である。
stdを同梱せず使うには、実行時のmodule取得・解決経路を別途実装して確認する必要がある。
その実装方式・動作成立は今回まだ確認していない。

証拠:
[std import結果](../../.tools/a23-agent-code-probe/std-import/smoke.json)、
[semantic履歴](../../.tools/a23-agent-code-probe/std-import/history.ndjson)、
[確認runner](../../.tools/a23-agent-code-probe/std_probe.ts)。

### 普通のDenoとの区別とpermissionの切り分け

同じDeno
2.9.7の通常CLIで`await import(specifier)`（`specifier = 'jsr:@std/csv'`）を実行すると、
csv 1.0.6と依存するstreams
1.2.0が実行時に取得され、CSV解析は`[{ name: 'a', value: '42' }]`で成功した。
一方、compiled Henjiの確認用code
Workerを`permissions: 'inherit'`に変えても、上記二specifierは
同じ`Module not found`になった。net等のpermission縮小だけが原因という説明は採用しない。
この追加確認も実provider requestは0回である。

[Deno v2.9.7のstandalone loader source](https://github.com/denoland/deno/blob/v2.9.7/cli/rt/run.rs)
を確認した。JSR解決はembedded modulesにあるspecifierへ接続し、embedded
moduleがない場合は file schemeのdisk読込みへ進むが、未同梱remote
moduleを取得する通常CLIの経路には進まない。 これは現行compiled
Henjiでの観測と一致する。

したがって「普通のDenoでは実行時std importが成功する」と「compiled
Henjiで未同梱stdをそのまま
importできる」は別であり、後者は現行経路では成立しない。
Henji側でmodule取得・解決を追加する案はまだ未実証で、通常Denoの成功から成立を推定しない。
追加loaderの実装方式・可否を確認する前に実装済みまたは成立確実と報告しない。

証拠:
[permission継承時の結果](../../.tools/a23-agent-code-probe/std-import-inherit/smoke.json)、
[確認runner](../../.tools/a23-agent-code-probe/std_inherit_probe.ts)。

## 公式loader hooksの調査とstd実行時importスパイク（2026-10-05）

利用者はDeno公式情報の調査後、ビルトインと外部定義の差、およびstd
importをスパイクで確認するよう
指示した。これは製品採用の実装ではない。本体source・実config・常用binary・product正本を変更していない。

### 公式仕様と採用した実験経路

- [std公式](https://docs.deno.com/runtime/reference/std/):
  stdはJSRの独立version付きpackageであり、
  `jsr:@std/...`で直接importできる。runtime内蔵のAPIではない。
- [compile公式](https://docs.deno.com/runtime/reference/cli/compile/#dynamic-imports):
  静的に解析可能な
  importはcompile時に取り込まれる。生成codeの依存はその段階では解析されない。
- [loader hooks公式](https://docs.deno.com/runtime/reference/loader_hooks/):
  同期APIの
  `node:module`の`registerHooks()`でresolve/loadを拡張できる。非同期の`register()`は未実装であり、
  両者を混同しない。hook生成sourceにだけ現れる外部依存が自動解決されるとは限らない。
- [v2.9.7公式compile test](https://github.com/denoland/deno/blob/v2.9.7/tests/specs/compile/module_register_hooks/main.mjs)
  はcompiled executableでのresolve/load
  hooksを使っている。公式sourceにはWorkerごとのhook registryと、
  runtimeに読むlocal `.ts`を変換する経路がある。

スパイクは`resolve`
hookだけを使う。hookから取得用WorkerへMessagePortで依頼し、そのWorkerがJSR
metadataのversion・exportsを解決してsourceを`/tmp`へ保存する。hookはSharedArrayBufferと
`Atomics.wait/notify`で取得完了を待ち、local file URLを返す。compiled
Deno自身がfileを読み、TypeScript 変換を行う。hookから未変換TypeScript
sourceを直接返す方式ではない。

packageのdirectory構造を保ったmirrorを作り、relative importと別JSR
packageのimportもhookで接続した。
取得はscriptのimportが実行された時点で行い、script本文の事前走査やimport書換えはしていない。
code実行Workerはread/writeをworkspaceと`/tmp`へ許可し、net/env/run/sys/ffiはfalseである。
通信は別の取得Workerが担当する。親スパイクexecutableは`-A`でcompileしている。

### ビルトインと外部定義の比較方法

実Henjiの`worker_tool_loader.ts`のコピーへ、`run_typescript`のビルトイン分岐を加え、実際のRegistryから
dispatchする小さなexecutableをDeno 2.9.7でcompileした。full Henji
serve/APIの新機能実装ではない。

ビルトインはfactoryをstatic
importし、外部定義はruntimeに作った`/tmp/.../external/tool.ts`をdynamic
importする。同じfileがembedded
moduleとして読まれる比較を避け、外部fileだけにdescription markerを
付けて、読まれたToolのdeclarationから確認した。外部のhooks/取得Worker
sourceも同directoryから読む。

stdはcompile入力に入れていない。保存したmodule graphの36
moduleはすべてlocalであり、compile logの embedded
filesにもstdはない。実行PATHは空directory、`DENO_DIR`は新しい隔離pathである。
code Workerの`Deno.execPath()`は今回のcompiled spikeを指し、Deno
versionは2.9.7である。 外部Deno CLIやsubprocessによるcode実行は行っていない。

### 観測結果

| 操作                         | ビルトイン                       | 外部定義                        |
| ---------------------------- | -------------------------------- | ------------------------------- |
| 前回の実AI生成61行を再実行   | success、保存結果が期待値と一致  | success、保存結果が期待値と一致 |
| hooksなしで未同梱stdをimport | `Module not found: jsr:@std/csv` | 同じerror                       |
| hooksありで未同梱stdをimport | success                          | success                         |

std確認codeはスパイク用に人間側agentが作成したもので、実modelによるstd
code生成の追加確認ではない。
`['jsr:', '@std/', 'csv'].join('')`でspecifierを実行時に組み立ててimportし、CSV二行を解析・集計した。
`CsvParseStream`による解析と、`https://jsr.io/@std/csv/1.0.6/parse.ts`の直接importも同じ二行になった。
合計42、workspaceへの保存、`/tmp`での作成・保存・readbackを照合した。

両経路とも実行時にcsv 1.0.6の7 sourceとstreams 1.2.0の2 source、合計9 `.ts`
fileをHTTP 200で取得した。
streamsの取得はcsvの`jsr:@std/streams@^1.0.9/text-delimiter-stream`依存から生じた。
外部file markerはビルトインでfalse、外部定義でtrueだった。実provider
requestは0回である。

外部fileの読み込みをmarkerで確かめるためdeclarationを結果へ追加し、stable
candidateを再compileして 上記比較を保存した。実験実装のtype
check・lint・format確認を実施した。

この結果は、公式hooksと実行時file取得を組み合わせれば、未同梱stdをcompiled
runtime内の生成codeから
使えることを示す。ビルトイン化そのものが未同梱stdを読めるようにするわけではなく、今回の同じ
実行backendでは両供給経路の結果が一致した。

### 確認範囲と証拠

resolverは今回使ったlatest・exact・caretのversion形式とJSR
exportsを扱う実験実装である。全semver、 import
map、npm、lockfile、永続cacheの再利用や全std
packageを扱える製品loaderとはまだしていない。 初回の実AI
code生成成功と、今回の保存code再実行・std技術確認を区別する。

- [比較runner](../../.tools/a23-module-spike/run.py)、[compiled入口](../../.tools/a23-module-spike/main.ts)。
- [tool実装](../../.tools/a23-module-spike/tool.ts)、[resolve hook](../../.tools/a23-module-spike/hooks.ts)、
  [取得Worker](../../.tools/a23-module-spike/fetch_worker.ts)。
- [std確認code](../../.tools/a23-module-spike/std_code.ts)。
- [全結果](../../.tools/a23-module-spike/evidence/summary.json)。
- [ビルトインの取得file](../../.tools/a23-module-spike/evidence/bundled-std-hooks-downloads.json)、
  [外部定義の取得file](../../.tools/a23-module-spike/evidence/external-std-hooks-downloads.json)。
- [compile module graph](../../.tools/a23-module-spike/compile-graph.json)、
  [compile log](../../.tools/a23-module-spike/compile.stderr.log)。

runtime
rootは各実行のsummaryに記録し、確認processは終了している。標準toolへの採用・常用配置は未実施。
