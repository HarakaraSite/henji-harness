# A23 — ファイル操作を含むrun_typescriptの検討・調査

調査日: 2026-09-29

状態: 未採用候補の検討・調査記録。製品採用、実装計画、実装、provider A/Bの承認ではない。

入口:
[通常利用メモ A23](../experience/normal-use-inbox.md#a23--run_typescriptでファイル操作を含む小処理をhenji内で実行f06未採用)

旧資料:
[2026-09-27の統合評価](2026-09-27-run-typescript-assessment.md)。旧資料は当時の報告として保持する。

## 利用者の意図と検討範囲

利用者は検討だけを指示し、Codexの過去履歴をサンプリングしてPythonの利用傾向から有用性を考えること、
技術成立性の確認、gpt-6-astra / xhighによるBlocker限定・10分上限の批判的評価、
公開実装例の調査と結果の記録を指示した。

中心となる利点は次の二つである。

1. Henji自身がDeno実行環境を持つため、小さな使い捨て処理に外部PythonやDeno CLIを別途要求せず、
   TypeScriptの実行を配布と一体で提供できる可能性がある。
2. AIが書いた処理の副作用をAIへの指示だけに委ねず、Henjiが決めた実行条件とDenoのpermission機構で
   一部を機械的に制御できる。

利用者は完全な隔離ができないことを理解している。強いsandbox、完全なfilesystem tree境界、 memory
isolation、AIの誤りの全面防止は、今回の明示要件ではない。

`run_typescript`自身によるファイル読み込みを含めて検討する。旧資料の「最初はpure」は暫定的な実験案で、
製品要件として固定しない。JSONだけを受け取るpure処理は用途の一つである。
code形式、JSON引数、profile、許可場所、timeout、入出力上限、library、executor backendは未決である。
既存bash/Pythonを禁止・全面代替する判断もない。

## Codex履歴のサンプリング

### 方法と偏り

- 調査対象はこのVMの`~/.codex/sessions/2026/09/23`〜`29`に存在した116 JSONLログ。
  全履歴本文を読む代わりに、path一覧を日ごとに分け、各日4ログ、計28ログをランダム抽出した。
- 最初の抽出は、sort済みpath一覧に対するPython `random.Random(230929)`。 28ログの内訳はroot
  13、subagent 15。cwdは27ログがHenji repository、1ログがhome directoryだった。
- `response_item`のtool call入力から`python3`を含むshell command候補を抽出した。
  説明文中の言及を一部除外し、568 command候補から`random.Random(230923)`で80件を抽出した。
  詳細対象80件は実行用途を確認し、対応するtool出力も確認した。
- 分類単位はshell command一件の主用途。複数の操作を含むcommandも主用途一つへ分類した。
- 日ごとのログ数は均等に抽出し、次の段階ではcommandを均等に抽出した。
  長い開発Sessionと繰り返しの診断・review準備が多く含まれる。
  分類結果はこのサンプルの傾向であり、全Codex利用の用途比率や独立task数ではない。
- 抽出path、record行番号、call ID、分類等のmetadataは
  [サンプル一覧](a23-python-history-sample-2026-09-29.json)に保存した。
  raw履歴、script本文、tool出力、credential値はrepositoryへ複製していない。

### 結果

| 主用途                             | 件数 |
| ---------------------------------- | ---: |
| SQLiteの履歴・状態・schema診断     |   22 |
| JSON・ログの抽出、集計、結果照合   |   18 |
| 文書・設定・scriptの生成、書き換え |   10 |
| review資料作成、hash・リンク確認   |   12 |
| process・TUI・CLI操作、配置        |   15 |
| HTTP取得、外部情報との照合         |    3 |
| 合計                               |   80 |

本文を抽出できたinline script 78件のうち68件が20行以下で、中央値は8.5行だった。
このサンプルのimportにはNumPy/pandasがなく、Python標準libraryによる短い処理が多かった。
JSON・ログ処理18件のうち6件はpipe/stdin入力、12件はfile入力だった。一部は結果のfile保存も含む。
tool出力には存在しない項目を参照した`KeyError: 'transition'`が一件あった。
TypeScriptへの変更でエラーが減ることや、shell
quotingが主要な失敗原因であることを示す証拠は得ていない。

具体例はサンプル一覧の`candidate_index`で参照できる。

- 133: pipe入力の履歴JSONLからevent・request項目を抽出する11行のscript。
- 169: roadmap本文を文字列置換して保存する12行のscript。
- 327: SQLiteの実行履歴を取得しJSONを解析する6行のscript。
- 474: 複数の実行結果JSONを読み、tool eventと最終API表示を照合する10行のscript。
- 538: baseline/candidateの測定JSONからTUI結果を比較表示する4行のscript。

### A23への解釈

当初、JSON-only pureを前提にすると、fileやpipeの内容をモデルが受け取り、Tool引数へ写し直すため、
token消費、転記、escaping、処理の分割が増える可能性を指摘した。
利用者の指摘を受け、この評価はA23全体を狭く捉えすぎたものとして訂正した。

`run_typescript`がfileを直接読むなら、モデルはcodeと対象pathを渡し、runtime側で取得・加工し、
必要な結果だけ返せる。モデルによるデータ転記の懸念は、この経路にはそのまま当てはまらない。
短い処理とfile操作の組み合わせが多い観測は、この方向の用途候補を支持する。

SQLite利用には対応するSQLite実装、TUI操作にはprocess/terminal操作が必要である。
これらは個別用途への対応範囲として別に検討する。全80件をそのまま移植できるとは確認していない。
実利用でのcorrectness、手間、token消費、自然なTool選択、保守負担の優位性も未測定である。

## Linuxでの最小技術確認

環境はDeno 2.9.7、`x86_64-unknown-linux-gnu`。
stdinから実行した親programが`application/typescript`のBlob URLを生成し、型構文付きcodeをmodule
Workerで 実行した。外部provider call、製品コードの変更、一時`.ts` fileの作成は行っていない。

親には対象read/write、probe用の非secret
env名、`/bin/bash`起動、指定loopback宛通信のpermissionを与え、
`--no-prompt`を指定した。Workerには次のpermission objectを与えた。

```ts
{
  read: [absoluteReadmePath],
  write: false,
  net: false,
  env: false,
  run: false,
  sys: false,
  ffi: false,
}
```

| 動作                                 | 最終確認の観測                   |
| ------------------------------------ | -------------------------------- |
| 型構文付きTSで`[10, 20, 12]`を集計   | `42`を返した                     |
| 指定したREADMEを読む                 | 成功。内容は出力せず非空だけ確認 |
| 指定外のAGENTS.mdを読む              | `NotCapable`                     |
| READMEをwrite用にopenする            | `NotCapable`                     |
| 非secret probe環境変数を読む         | `NotCapable`                     |
| `/bin/bash -c ':'`を起動する         | `NotCapable`                     |
| `http://127.0.0.1:49199/`へfetchする | `NotCapable`                     |

write確認は既存fileを`write: true`でopenする要求だけで、作成・truncate・内容のwriteは含めなかった。
要求は拒否された。既存fileの内容を変更していない。

最初の診断ではport 9へのfetchが`TypeError`となり、permission拒否の証拠には使えなかったため、
上表のportで確認し直した。また、writeのpermission queryは`prompt`を返したため、
query値だけから拒否を判断せず、`--no-prompt`下の実際のopen要求で確認した。

確認できたのは、選択したDeno API操作について、file読み込みと他のpermission縮小を両立できること。
compiled Linux Henji内の実行、default-export functionを呼ぶTool
wrapper、timeout/cancel、import経路、 SQLite、TUI操作、全platformでの動作を確認したものではない。

## 機械的制限の意味と現行統合経路

制御を提供するのはTypeScript言語自体ではなく、Henji-owned executorとDenoのpermission機構である。
AIが処理内容を書く一方、hostが許可する操作を決められる。fileを直接読みながらwrite/net/env/run等を
制限する方向は、[公式Worker仕様](https://docs.deno.com/api/web/workers/#WorkerOptions)と整合する。

許可された場所への誤った書込み内容までruntimeが判断するものではない。
許可directory内のsymlinkからroot外へreadできる場合もある。
後者は旧資料の報告と[公式仕様](https://docs.deno.com/runtime/reference/permissions/#symbolic-links)で確認した。
旧資料はWorker OOMがprocess全体を終了させたことも報告しているが、今回再実行していない。

制御対象は`run_typescript`を通る実行である。bash等を使えるAgent全体の副作用を制限する保証ではない。
全Toolを横断した制限は今回の明示目的には含まれていない。

現行sourceでは、[Tool Definition / Registry](../../v0/agent/tools/registries.ts)、
[Tool interface](../../v0/agent/tools/tools.ts)、
[Tool Component](../../v0/agent/tools/tool_components.ts)に通常の登録・実行・guideline・result経路がある。
[Worker wrapper](../../v0/agent/worker/worker_capsule.ts)のpermission型は`inherit`/`none`だけで、
今回のscoped permission objectはまだ統合されていない。
[build script](../../scripts/build_henji.ts)は`--unstable-worker-options`、`--no-prompt`を使う。
統合を原理的に妨げる条件は見つかっていないが、具体的な実装方式は未採用である。

旧資料のmacOS compiled executable内での動的TS成功は原資料の報告として区別する。
その詳細spike資料はrepositoryに存在せず、今回のLinux直接実行をcompiled Henjiの成功へ読み替えない。

## gpt-6-astra / xhighの批判的評価

利用者指示による独立評価を実施した。指定表記`gpt-6-astro`は利用可能名`gpt-6-astra`と解釈して伝え、
xhigh、Blocker限定、10分wall time上限で依頼した。会話全体は継承せず、必要contextとsource
pointerを渡した。 上限内に評価を完了した。

暫定基準は、現在の目的を成立させない具体的な矛盾・技術障害、または中心的な利点を否定する事実で、
根拠と利用者影響があるもの。未実装、未測定の採用価値、未確認platform、通常の設計課題、
すでに理解された不完全な隔離だけを独立したBlockerにはしない。

結果は**Blocker 0件**。

- file readと他のpermission縮小の両立は公式契約と整合する。
- Tool登録・compile経路に原理的な統合障害は見つからない。
- Tool単位の制御とAgent全体の制御を区別すれば、既存bashの存在だけで利益は否定されない。

評価は構想の検討継続を妨げるBlockerがないという意味であり、実装準備完了、採用価値、
実装完了または採用承認を示さない。reviewerは既報macOS実験と今回のLinux診断を再実行していない。

## 公開実装例

公開READMEと該当sourceを確認した。下記実装の動作再現、導入、品質評価は行っていない。

| 実装                                                            | 確認した構成                                                                                                               | A23への参考と相違                                                                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Belgie](https://github.com/mplemay/belgie)                     | Pythonから埋め込みDenoでJS/TSを実行。Pydantic AIに`run_typescript`を登録しJSON resultを返す。host構成のruntimeが権限を持つ | 実行環境同梱とTool contractの近い例。既定Agent sessionは一時workspaceのreadを許可し、caller構成runtimeの注入も可能。HenjiのDeno compile方式そのものではない          |
| [Deno公式Worker例](https://docs.deno.com/examples/web_workers/) | Worker内で`Deno.readTextFile`を実行。親がread対象fileを列挙し、対象外readのpermission errorを示す                          | file読み込みと権限縮小を両立する最小例。AI Tool、動的code生成、単一executable配布の例ではない                                                                        |
| [Codecall](https://github.com/zeke-john/codecall)               | Node hostが生成TSを一時fileへ保存し、外部Deno processで実行。`tools` ProxyからIPCでhostのToolRegistryを呼ぶ                | データ取得と加工をcode内でつなぐ例。実行codeの直接readは一時scriptに限定。外部Deno CLI、一時file、既存Tool bridgeを使い、今回の直接file read/同梱runtime案とは異なる |

確認したsource revisionと入口:

- Belgie `4d6c8e7c23fefebde48a93ae461ae2259ea77599`:
  [Tool登録・JSON result](https://github.com/mplemay/belgie/blob/4d6c8e7c23fefebde48a93ae461ae2259ea77599/src/belgie/pydantic_ai/_toolset.py)、
  [Agent sessionとpermission構成](https://github.com/mplemay/belgie/blob/4d6c8e7c23fefebde48a93ae461ae2259ea77599/src/belgie/pydantic_ai/_session.py)、
  [runtime permission](https://github.com/mplemay/belgie/blob/4d6c8e7c23fefebde48a93ae461ae2259ea77599/crates/belgie/src/options/runtime_options.rs)、
  [埋め込みruntime](https://github.com/mplemay/belgie/blob/4d6c8e7c23fefebde48a93ae461ae2259ea77599/crates/belgie/src/embed/runtime.rs)。
- Codecall `af9ed4582e15f14041f4ca64a5b5171eedc3e3b2`:
  [実行・permission flag・IPC wrapper](https://github.com/zeke-john/codecall/blob/af9ed4582e15f14041f4ca64a5b5171eedc3e3b2/src/core/sandbox.ts)。
- 簡単なMCP例としてTimtech4u/deno-mcp-serverも確認した。
  [実行source](https://github.com/Timtech4u/deno-mcp-server/blob/9929353d75067b09df14aac269ab0d35c6feb51b/src/index.ts)は
  codeと`permissions`をTool引数で受け、一時fileと外部Deno CLIを使う。
  permission要求をそのまま`--allow-*`へ変換しており、hostが別に許可上限を決める設計例としては扱わない。

調査の参考としては、BelgieのTool入出力・host側permission構成と、公式Worker例の実行方式が直接的である。
既存Toolの結果をcode内で加工する方式を検討する場合はCodecallも参考になる。
これらをそのまま導入する判断はしていない。

## 残る検討事項

- どの具体的な通常利用taskを対象にし、file read/writeと既存Toolをどう使い分けるか。
- hostが決める実行条件とAIが要求できる項目、libraryとimport、SQLite等の対応範囲。
- 現行compiled Linux Henjiの配布・起動・cancel・履歴経路で実際に成立するか。
- 外部runtimeへの依存、手間、correctness、token消費、自然なTool選択、保守負担が実利用で改善するか。

今回記録したのは観測と未採用候補の検討結果である。構想・architecture・roadmapの正本は変更していない。
