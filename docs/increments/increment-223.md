# Increment 223: searchの用途別分割と除外契約

## 1. 状態・目的（2026-10-10）

利用者が指定したA37・A38と関連調査
[`docs/plans/search-tool-revision.md`](../plans/search-tool-revision.md)に基づく計画。
後続会話、依頼review、批判的reviewとその利用者判断を、以下の現行契約・作業手順へ一本化した。
旧案のGNU fallback廃止、ls省略、再帰ls廃止は実装指示として残さない。各toolの実装・focused
test・独立reviewと接続検証を進行中。

目的は、名前探索・本文検索・一覧・集計を選び分け、不要な対象を除外し、必要な結果へ到達できること。
通常のコード調査に必要な機能を残し、独自の互換処理・重複実装・不要な抽象を増やしすぎない。
機能数・test件数・返却byte削減自体は成功条件にしない。

### 利用者が指定した範囲

- `ls/find/grep/wc`の独立した4 tool。lsは通常の直下一覧とJSON treeを持つ。
- 各toolのschema・説明・factory・executorを全て外部定義する。
- 4 toolのfileアクセス範囲は現行searchと同じ。workspace外も含む既定allow `/`と、既存の
  common-denied経路を維持する。新たなアクセス制限を追加しない。
- 新規実行用の`search`は廃止する。旧名aliasやdual dispatchは設けない。
  保存済み履歴のtool名・引数・結果は変更せず、既存previewを保持する。
- grepの`!`除外を含むrg相当と、検索の`.gitignore`尊重を通常経路の基本とする。
- GNU grep/findへのfallbackを外す前提にしない。未対応機能のerrorやignore適用状況のJSON返却は
  第4節の契約に従う。
- hjhはrg/fdを同梱・自動取得しない。tool設定のPATHで見つかる導入済みcommandを優先し、 rg不在時はGNU
  grep、fd不在時はGNU findを使う。fdの導入は利用者が後で行う。
- Pi/OpenCode/Zotのpinned実装を参考にする。`run_typescript`からのtool呼出しAPIは後で検討する。
- findは指定した一致件数で探索を止める。grepは最後まで検索し、返す件数だけ制限する。
  この区別を親agentが提案し、利用者が「ではそうしよう」と採用した。grepを一致件数で途中停止しない。
- 未指定時の既定値は利用者の「デフォルト値も決めて」に基づき、下表で決める。
- findのglobとgrepの正規表現は、使用したfd／GNU find、rg／GNU grepの仕様に従う。
  結果JSONへbackend名を添え、コマンドの構文errorはtoolのerrorとして返す。
  backend間の意味差は独自に判定して拒否せず、共通構文だけに制限しない。
- Worker起動時にbackendを選び、モデルへ渡すtool説明に現在のbackend名を記載する。
  同じ選択をそのWorkerの実行にも使い、結果JSONのbackend名と揃える。

主要なproduct方針は確定。具体schemaのfield名や結果解析等は、以下の契約を守って実装側で決める。
A37・A38は今回採用し、原観測を本書末尾へ移した。
利用者はlocal実装・toolごとのtest/review・search削除・instruction挿入確認・4 tool
e2eと最小限の実provider利用を承認した。実config更新・常用配置・commit/pushは含まない。
構想・architecture・roadmapは未変更。必要な反映案は第7節に置く。

## 2. 根拠と参照実装

### 観測と現行source

- A37: モデルが`!`を除外として使用するが、現行globはliteral扱いで0件を返す。 保存されたsearch
  4回の返却26,797 bytesの約82%を2回が占め、大半が`.tools/`由来だった。
- A38: `mode: files`へ`pattern: README*`を渡す名前探索との取り違えが確認されている。
  改名だけで誤用改善を保証せず、用途別schemaと操作の意味を分ける。
- wcの根拠: 既存statsで34,770,332 bytesのJSONLを特定した観測がある。
- 利用者がbashを避けたい理由は、巨大返却・予期しない結果・空や失敗・連結による不明瞭さ等。
  専用toolの通常経路を整える根拠として扱い、新しいsandbox・approval機構へ広げない。
- 現行sourceの基準は`148aaae4`。指定調査文書は全文確認済み。
  過去の返却量は観測値であり、現在のfile集合との厳密比較baselineにはしない。

### pinned sourceの比較

commitとlicenseの所在は[`_refs/README.md`](../../_refs/README.md)。snapshotのrefresh・sourceのコピーはしていない。

| 参照                                                | 確認source                                                                                                                     | 同じ／参考になる点                                                                       | 今回と異なる点                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Pi `b30a6dd779340f7bc2f3ffa60f4c0a5f914ba9ae`       | `_refs/pi/packages/coding-agent/src/core/tools/{find,grep,ls}.ts`、`utils/tools-manager.ts`                                    | 名前探索と本文検索の分離、fd glob、rg regex/literal、専用ls、件数で停止しlimit増加を案内 | GNU fallbackなし。不在時backendを取得。findの実引数には`--type f`がない |
| OpenCode `ecc4916b5a9608c30e6dd58a67f2137b594407ca` | `_refs/opencode/packages/opencode/src/tool/{glob,grep}.ts`、`_refs/opencode/packages/core/src/ripgrep.ts`、`ripgrep/binary.ts` | 名前探索と本文検索の分離、rgのnative選別、件数でstream収集停止                           | GNU fallbackなし。専用lsはなくshellを利用。rgの`--json`は内部解析用     |
| Zot `d1e278ee2400cc686983c9b1f7949bd905501e39`      | `_refs/zot/packages/agent/tools/glob.go`、`_refs/zot/packages/ignore/gitignore.go`、`agent/build.go`                           | 自前glob／walk、階層ignore、一致件数で停止、部分結果の明示                               | rg/fd不使用。簡易ignore matcherを今回のnative相当仕様へコピーしない     |

`ignoreApplied`の返却とbackend能力のambient表示は、確認した参照sourceの先例とはしない。
独立reviewではsourceと少数の非破壊command probeを確認した。実providerは呼んでいない。

## 3. 現行の利用経路と変更対象

1. Core/HostがAgent JSONのtool名とconfig rootの`tools.json`を解決し、選択folderをWorkerへ渡す。
2. Worker loaderが外部factoryを呼び、同じToolのschema・説明・executorを宣言／dispatchする。
3. 現行`external-tools/search/index.ts`はentries/paths/files/content/count/statsの6 modeを持つ。
   entries以外はDenoでfileを列挙し、独自globでfilterする。slash無しはbasename、有りはworkspace相対。
   先頭`!`は除外にならず、hidden・ignored fileも列挙する。
4. 本文検索はDB/NUL binaryを除外後、既存process executor経由でrg、不在時grepへ渡す。
   rgには`--no-ignore --hidden`と明示file集合を渡す。regexpは変換せず、現行grepには`-E`がない。
5. 現行limitは取得済みrecordへのpage指定。stdout合計8 MiBを収集後にoffset/limitで返し、 resultは1
   MiB以内。captureを超えた後続は現在のpagingだけでは取得できない。
6. tool
   call/resultはsemantic履歴へ保存し、TUIがpreviewする。package/installが外部folderを配布・登録する。

この経路のtool契約を置き換える。新しい検索結果保存storeや能力registryを前提にしない。

## 4. 現行の機能・検索契約案

| Tool   | 役割と残す機能                                                                                                               | 返却案                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ls`   | 直下一覧、名前とentry種類、JSON tree。treeの深さ・件数を指定可能にする                                                       | entry配列／子entry、対象path、取得件数、打切り・省略情報                                      |
| `find` | 名前／pathのglob探索。`*`・`**`・`?`を基底に、除外・ignore対象の明示包含と結果件数上限を扱う                                 | 一致path、backend、ignore適用状況、取得件数、打切り情報                                       |
| `grep` | literal／通常のregex、大小文字、対象path・globと順序付き`!`、対称context、一致行／一致file一覧。検索は完走、返却件数のみ制限 | path・行番号・本文またはfile一覧、backend、ignore適用状況、正確な一致件数、返却件数、省略情報 |
| `wc`   | 明示単数／複数fileのlines/words/bytesと全指定fileの合計。既存streaming集計を利用                                             | file別集計と合計。返却pageの小計と全指定fileの合計を区別                                      |

size・日時・所有者などの一覧metadata、GNU findのexec action、圧縮検索、PCRE2/multiline等を
今回の必要機能として自動追加しない。本文count系は初回の案から外し、wcとは混同させない。
findのentry種類等は具体schemaで確定する。ls代替を目的とした種類／深さの追加は必須にしない。

### 未指定時の既定値

現行searchの既定100件を基準にする。同じ値でもfindの探索停止とgrepの返却制限を区別し、
各toolのschema・説明に記載する。数値を指定すれば変更でき、追加の固定最大件数は設けない。

| 項目                      | 既定値             | 意味                                                               |
| ------------------------- | ------------------ | ------------------------------------------------------------------ |
| findの`limit`             | 100                | 最終filter後の一致100件で探索を停止                                |
| grepの`limit`             | 100                | 最大100件を返す。全対象の検索と一致件数の集計は継続                |
| lsの`limit`               | 100                | 通常一覧／treeで返すentryの最大数。treeは全階層を通じた合計        |
| lsの`tree`                | false              | 直下一覧。trueで階層JSONを返す                                     |
| lsの`depth`               | 通常一覧1、tree時3 | 指定pathを深さ0とし、treeはその下の3階層まで探索                   |
| wcの返却`limit`／`offset` | 100／0             | 明示した全fileの集計は行い、file別の返却だけpage化。全体合計は維持 |
| ls/find/grepの`path`      | `.`                | workspaceを起点にする。指定により現行searchと同じ範囲を利用可能    |
| grepの`patternKind`       | regex              | literalを指定すると文字列そのものを検索                            |
| grepの大小文字            | 区別する           | 明示指定で大小文字を区別しない検索に変更可能                       |
| grepの結果選択            | 一致行             | 明示指定で一致file一覧へ変更可能                                   |
| grepの`context`           | 0                  | 周辺行を付けない。指定値を前後両方へ適用                           |
| 通常find/grepのignore解除 | false              | native経路はignoreを尊重する。fallbackは実際の適用状況をJSONで示す |
| dotfile                   | 含める             | 現行searchとPiの探索を基準にする。ignore対象の再包含とは別         |

grepの本文patternとwcの対象fileは指定必須とし、未指定で勝手に全fileを集計しない。
findのpatternの必須性等、表にない入力は具体schemaで決める。 結果JSONは既存の1
MiB予算を維持する。これによる省略も通知するが、grepの検索自体は停止しない。

### 名前・pathのglob

利用者の「fd/findもrg/grepの方式にならう」に従い、findも使用backendの解釈と構文チェックへ委ねる。

- fd経路は`--glob`を使う。GNU find経路は名前へ`-name`、pathへ`-path`を使う。
  slash無しはbasename、slash入りは検索directoryを起点とするpathの検索へ渡す。 fdのfull-pathとGNU
  findの探索起点付きpathに合わせた引数を組み立てる。 大小文字は区別する。
- コマンドが正常終了した場合は、そのbackendの検索結果を返す。0件も正常な検索結果とする。
  結果JSONへ必ず`backend: "fd"`または`backend: "find"`を添え、tool説明にもglobの解釈が
  backendに依存することを記載する。
- コマンドが構文errorを返した場合は、そのbackendと理由を示してtoolのerrorを返す。
  errorを0件成功へ変換せず、別backendで再検索しない。
- コマンドが受け付けたpatternは、そのbackendの意味で検索する。
  `*`・`**`・`?`だけの共通サブセットへの制限、意味差の独自判定、自前glob照合、
  共通の正規表現へ変換するhelperは実装しない。現行searchの自前glob判定の流用も前提にしない。
- fdのignoreを尊重する経路とGNU fallback時の適用状況通知は、以下の契約を維持する。
  件数上限はnative検索条件と既存アクセス範囲を満たす実際の返却対象へ作用し、候補数へかけない。

実コマンドで確認した`src/*.ts`、`src/**/*.ts`、`src/?.ts`等の意味差は許容し、各backendの結果を
backend名付きで返す。GNU findの`-path`で`*`が`/`へ一致することは
[公式仕様](https://www.gnu.org/software/findutils/manual/html_node/find_html/Full-Name-Patterns.html)を確認した。
fdのglob／basename／full-pathは[公式説明](https://github.com/sharkdp/fd#matching-the-full-path)を確認した。
共通変換の試作は採用しない。実装は第4節のnative backend方針に従う。

### grepの対象glob

- grepのrg経路はnative glob／ignore選別を維持する。順序付きglobでは後の一致を優先し、
  `["!*.ts", "*.ts"]`と逆順の意味を同じにしない。除外だけの指定も扱う。
- rgの正globはfileのignore規則を上書きできるが、除外directoryの扱いは別である。
  glob無しでignore済み候補を先に作ると、後段filterでは除外fileを復元できない。
  全toolへ同じignore済みfile集合を強制する構成にはしない。

### ignore・fallback

- 通常のrg/fd経路は`.gitignore`を尊重する。下位・親規則、Git境界、repo外の扱いはnative契約と
  実行経路で具体化する。hiddenの包含とignore解除を区別する。
- GNU fallbackは、独自ignore互換layerを前提にしない。ignore未適用でも実行し、
  検索全体の`ignoreApplied: false`とbackendをJSONで返す。個別fileのignored判定は含めない。
  未対応の`!`指定には明示errorを返す。ignore未適用のJSON表示と、検索構文の未対応errorを区別する。
- これは通常経路のignore尊重・`!`対応に対するfallback例外契約。
  metadataは未適用を説明するもので、fallbackで`.tools/`騒音を除去したと扱わない。
- `ignoreApplied`はbackend名から推測せず、実際の対象選択経路と解除指定から決める。 ignore
  fileが存在しなくても、機構を有効にして探索したかを表す。
- backendはWorker起動時に優先commandの不在に応じて選ぶ。 正常な0件・pattern
  error・cancelで別backendへ再検索しない。
  rg/fdは同梱・自動取得せず、外部tool設定のPATH／実行名を使う。

### 起動時のbackend選択とtool説明

外部toolの非同期factoryで、tool設定のPATH／実行名からbackendと実行fileを選ぶ。
grepはrgを優先し、不在時はGNU grep。findはfdを優先し、不在時はGNU findとする。
shell全体のPATHに存在するかではなく、そのtoolが実際に使う設定で判定する。

選択したbackend名をfactoryが生成する`description`へ入れる。
例えばgrepの説明に「現在のbackendはrg」、findの説明に「現在のbackendはfind」と記載し、
モデルがpatternを指定する前に使用backendを把握できるようにする。
executorは同じbackendと実行fileを保持し、そのWorker内のcallで使用する。
各結果JSONにも同じbackend名を返す。新しいWorkerの起動時には改めて選択する。

現行sourceで`ToolFactory`は`Tool | PromiseLike<Tool>`を返せること、Worker loaderがfactoryをawaitし、
生成された説明とexecutorを一緒に保持することを確認した。
`Registry.definitions()`はその説明をモデル用tool宣言へ渡す。
この経路を使い、説明生成・backend選択・executorは外部tool定義へ置く。

### 本文の正規表現

literalと通常のregexを残す。`.*`やanchorだけへ人工的に制限することや、本文を独自のwildcard構文へ
置き換えることは前提にしない。GNU側を`grep -E`とする案を維持する。

利用者が採用した契約は、正規表現の解釈と構文チェックを使用したbackendへ任せること。

- コマンドが正常終了した場合は、そのbackendの検索結果を返す。0件も正常な検索結果とする。
  結果JSONへ必ず`backend: "rg"`または`backend: "grep"`を添え、tool説明にも解釈がbackendに
  依存することを記載する。
- コマンドが構文errorを返した場合は、そのbackendと理由を示してtoolのerrorを返す。
  errorを0件成功へ変換せず、別backendで再検索しない。
- 同じpatternでもbackendによって結果が異なることを許容する。probeでは`\d+`がrgで`123`、 GNU grep
  `-E`で`ddd`へ一致した。両方が正常終了するこの例は、それぞれの結果をbackend名付きで返す。
- コマンドが受け付けた構文に対し、tool独自の「未対応」判定や意味差判定を追加しない。
  結果まで共通の構文だけに制限するparser、禁止構文リスト、正規表現の変換処理は実装しない。
- literal指定ではpatternを文字列として扱い、正規表現の構文チェックを行わない。

## 5. 件数上限・結果の省略

### findの件数上限

findで上限100件なら、glob等の最終選別後に一致した100件で収集を止めて返す。
候補file数に上限をかけて、一致を探す前に止めない。未指定時は100件とする。
byte予算も併用し、何で打ち切ったかを返す。正確な総件数を調べるため全探索を続けることは要求しない。

独立した「次の100件」取得は親agentの追加提案で、採用していない。必須機能へ加えない。
既存offset/pageの維持・廃止とwc等の返却pageは、具体schemaで別途定める。

### grepは検索完走・返却のみ制限

利用者が採用した方針は、grepの検索を一致件数で止めず、返す量だけ制限すること。
未指定時の返却は100件。一致行出力では一致行数、一致file出力では一致file数を全対象について集計し、
正常完了時の`total`と実際の返却件数を分けて返す。context行は一致件数へ含めない。
例えば273件一致した場合、100件を返し、total=273、返却100、173件省略と説明できるようにする。

backend stdoutを流れ読みし、全件を数えながら返却対象だけ保持する。件数・返却byte予算へ到達しても
backendを止めず、最後まで処理する。現行のstdout合計8 MiBでprocessを止める経路はgrepへ継承しない。
返却textやcontextがbyte予算で省略されても、一致件数の集計は維持する。
正確な総件数のため広い対象は検索完了まで時間を要するが、利用者が採用した検索完走の意味を優先する。
独立した続きを取得する機能は追加せず、必要なら返却limitを増やすか、対象path・patternを絞って再検索する。

### 省略を空・完了と区別する

- find: 返却件数・探索打切り状態・理由を返す。100件で停止した結果を全件数100とは表現しない。
  正確なtotalが不明なら不明として返す。
- grep: 検索完了と返却省略を区別する。正常完了なら全一致件数を示し、返却limit／byte予算による省略を
  別に通知する。返却省略を検索中断として表現しない。
- grep context:
  一致行と周辺行の区別を保持する。byte予算によるcontext省略も、全体の検索完了と混同しない。
- 長い本文:
  一致recordのtextを短縮する場合はその旨を返し、path・行番号からreadで原文へ到達可能にする。
- ls tree: JSONの`children`等で階層を返す。空directoryと、深さ指定・件数・byte予算で未探索／省略した
  directoryを区別する。深さ指定どおりの終了と、件数で途中停止した状態を分ける。
  名前・種類・子entryと省略状態を基底にし、field名は実装側で決める。既定深さは第4節の表に従う。

## 6. 置換・接続範囲

| 対象       | 必要な変更                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 外部tool   | `external-tools/search/`を4 folderへ置き換える。schema・説明・executorと共有helperを外部assetに置く                               |
| pathPolicy | `v0/agent/tools/tool_paths.ts`の4名の既定allowを現行searchと同じ`['/']`にする。既存denyを維持                                     |
| Agent      | 同梱default、genericの基底、`agents/reviewer.json`のtool名・instructionを4名へ変更する                                            |
| 案内       | `v0/agent/tools/bash_tool.ts`の旧search誘導、README英日、`external-tools/README.md`等を更新する                                   |
| 配布・登録 | `scripts/package_henji.ts`／`scripts/install_henji.sh`へ4 folderと共有assetを登録する。配布先だけでimportが解決することを確認する |
| TUI・履歴  | 4 toolの用途・glob・tree・省略がpreviewから読めるようにする。過去search previewとsemantic履歴は保持する                           |
| 確認       | 既存の本文検索、entries、wc、reviewer、配布、pathPolicy、TUI previewのうち変更された動作を更新する                                |

binaryにtool契約やexecutorを重複定義せず、既存`@henji/tool` factory・pathPolicy・process
executorを使う。
不要になったrepository内の旧実装は同じ置換対象とする。保存済み履歴や実configの旧folderの削除を
許可されたと扱わない。常用環境の登録切替・user scope instruction内の旧名は配置時の別対象。

backend名の起動時表示は、第4節の非同期factoryによるtool説明生成を採用する。 既存のWorker
loaderとモデル用tool宣言の経路で渡し、別のruntime_start hookや能力registryは追加しない。

## 7. Product正本への反映案

利用者は接続範囲を計画に含めることを了承した。以下は変更案であり、正本はまだ編集しない。
AGENTS.mdのProduct正本変更規則に従い、対象・理由・意味上の変更内容を提示して別途承認を得る。

- architectureの「検索・URL取得・process tool」: searchの6 modeから4 toolへ変更し、通常ignoreと GNU
  fallback例外、件数制御・JSON tree・省略の最終契約を記述する。Host/Workerの責務は変えない。
- roadmapのF02/F06および配布・設定・toolの状態記述: 実装確認後に4 tool化、search廃止、ls tree等の
  実装状態を反映する。新しいproduct構想や未承認機能を追加しない。

## 8. 実装順序と確認

1. 第4〜5節の意味上の選択と具体schemaを確定し、A37・A38の採用範囲を本書へ移す。
2. 確定した契約に基づいて4 toolを実装し、通常のignore／globとGNU fallbackの経路を接続する。
   findはfdのnative glob／GNU findのnative name・path検索へ渡し、backend名付きで結果を返す。
   find／grepの非同期factoryでbackendを選び、説明とexecutorへ同じ選択を渡す。
   lsは通常一覧とtree、wcは既存streaming集計を使う。新規実行用searchは廃止する。
3. 第6節の名前依存pathPolicy、Agent、案内、配布・共有asset、TUIを揃える。
   実configや稼働Coreは変更しない。
4. production Workerの宣言・dispatchで、README名前探索、本文検索、`!`除外、通常ignore、
   明示ignore解除、GNU fallbackと適用状況、workspace外の既存範囲、ls/tree、wcを確認する。
   現在のtool設定PATHではrgが見つかりfdは見つからないため、通常の実行でfindのGNU
   fallbackを確認する。
   実装作業ではfdのinstallを行わない。その他のbackend経路は、隔離tool設定のPATH／実行名で選んで確認する。
   起動時のtool説明に選択backendが入り、実行commandと結果JSONのbackend名が一致することを確認する。
   findの件数上限での停止と指定件数の変更、byte打切りとtreeの途中省略を確認する。
   findのglobは各backendの結果をそのまま返すことを実経路で確認する。確認済みの意味差をerrorにせず、
   backend名を返す。コマンドの構文errorはtoolのerrorになり、別backendへ再検索しない。
   grepは返却limitを超える一致も最後まで集計し、返却件数・正確なtotal・省略状態を分けることを確認する。
   返却byte予算を超えてもgrepを途中停止しないことを、変更された経路として確認する。
   regexでは各backendの結果とbackend名が返ることを確認する。確認済みの`\d+`の差はerrorにせず、
   rg／GNU
   grepそれぞれの結果を返す。コマンドの構文errorはtoolのerrorになり、別backendへ再検索しない。
   literalでは文字列検索できることを確認する。 正常な0件は成功として扱う。
5. 変更された動作に対応するfocused確認、関連type check、format、lint、`git diff --check`を行う。
   旧count廃止は旧契約を維持するtestの修正対象だが、GNU fallbackとls treeを廃止扱いしない。
   仮想variant・permission matrixやtest件数目標を追加しない。full gateは計画しない。
6. candidateをbuildし、隔離XDGのcompiled Core/TUIをtmuxで起動する。provider-freeの操作経路で、 4
   toolのcall・結果・preview・保存Session再表示を確認する。最後に最小限の実providerで4
   toolのe2eを行う。対象route・回数・隔離保存先を提示して実施する。
   操作・結果・未確認事項を本書へ記録する。
7. 第7節の正本変更案は別途承認後に反映する。実config切替・常用配置・commit/pushは別の指示に従う。

返却量を比較する場合は、同じworkspace snapshot・調査目的で行う。byte削減自体を成功条件にしない。
provider-free確認で宣言・dispatch・結果・表示・保存経路は確認できるが、modelの誤用率改善は断定せず、
通常利用の観測事項として残す。

## 9. 計画reviewと実装時の具体化

- ignore適用状況は`ignoreApplied`で返す。nativeのregex/glob解釈・構文errorはbackendへ委ねる。
- schema・結果解析・stream処理は各外部folderへ具体化済み。find探索停止、grep検索完走と返却limitを分けた。
- treeのempty/depth/limit/byte区別をJSONへ実装した。findのentry種類はtype=any/file/directoryで選ぶ。
- fdのGit境界はnative既定を維持し、repo外だけ`--no-require-git`を指定する。
- rg/fdは同梱・自動取得しない。起動時のtool説明にbackend名を入れる。実装確認結果は第11節。

利用者依頼の通常reviewと独立した批判的reviewを実施した。批判的reviewの具体指摘は、
旧案と実装手順の競合、新tool名により既定検索範囲がworkspace内へ狭まる接続漏れだった。
利用者は現行searchと同じ範囲、search廃止、接続変更の追加、旧案競合の修正を指示し、
本書で現行契約・作業手順を一本化した。
本文regexは後続の利用者判断で、backend名付きの結果を返し、コマンドの構文errorをerrorとして返す契約へ
更新した。共通構文parserや意味差の独自判定は計画から外した。
親agentと先のreviewはfindへの上限指示とgrepへの機能影響の質問を混同していたため訂正した。
その後、findは件数で探索停止、grepは検索を完走して返却だけ制限する提案を利用者が採用した。
未指定時の既定値も本書で決めた。独立継続取得は必須機能へ加えない。
最終reviewは「実装前の計画として進められる状態、新しい必須修正findingなし」と結論した。
残っていたrg/fdの同梱判断は、その後の利用者指示で同梱・自動取得なしに確定した。
この計画reviewは整合性と実現性を確認したもの。後続の実装・配布・Worker／TUI確認の結果は第11節に記録する。

## 10. A37・A38の採用元観測（2026-10-10移管）

以下は採用前の観測・比較案の記録であり、実装契約の正本は第4〜5節とする。

### A37 — searchのglobにおける`!`否定（除外）の扱い（採用元の記録）

- 利用者の観測（2026-10-08）: deepseek系modelがsearchのglobで`!`否定をよく使う。だんだん絞り込む
  意図での使用であり、rg等の書式の慣習だけでなく、実際の絞り込み要望の表れと見る。使用は複数
  セッションで利用者確認済み（coordinating側で確認できた6セッションには使用例なし）。
- 現行挙動の確認（2026-10-08、source・実測）:
  - `external-tools/search/index.ts`はglob中の`!`をliteralとして扱い、`!`始まりのglobはpathに一致せず
    **無言でtotal 0**になる（実測: `glob:"!**/docs/**"`で0件、対照`glob:"README*"`で1312件）。
    「該当なし」に見えるため、もっともらしい誤答（存在しないとの判断）に繋がる。
  - 「leading
    !は除外ではない」注意は既に3箇所にある（L85のglobパラメータ説明、L952・L960のtool説明）。
    文章による抑止だけでは止まっていないことが実証されている。
  - searchはhidden・gitignore済み・dependency fileも対象に含み、結果capture上限（8MiB、結果1MiB、
    100件page）がある。騒音源が既知で対象は広い絞り込みは、path指定や複数callでは表現しにくい。
  - 例: Session c5d830b5（2026-10-08、README比較）で`path:"."`＋`glob:"*.json"`の結果が`.tools/**`の
    artifact由来で約870KBになり、答えに寄与したのは後続の狭いqueryだった。広いsweepの正しい直し方
    は騒音dirの除外だった。
  - `stats` mode（wc相当: path/lines/words/bytes）も同じglob filterを使う。騒音源の事前把握に使える
    （実測: `.tools/tool-trend-0cd5c22e/detail.json`は9,250行で34,770,332 bytesの巨大行JSONL。
    c5d830b5の騒音の正体で、content searchの前に`stats`1回で特定できた）。
- 追加観測（2026-10-09、Session `7814247a-916e-4211-a2fd-e351b1bfb4cd`、Execution
  `287fd3fc-8777-410a-bf4e-d34927a500bb`、保存済みtool結果のUTF-8本文量）: search 4回で 26,797
  bytes。`files`＋`pattern:"README*"`は8,650 bytes・返却100パス中96件が`.tools/`、
  `content`＋`pattern:"openai-chat\\b"`＋`glob:"*.md"`は13,453 bytes・返却60一致行すべてが
  `.tools/`だった。この2回がsearch返却量の約82%を占め、長い測定用コピーのパスと一致本文が
  contextへ入った。残りは`entries`で2,314 bytes、`v0/**/*.ts`内の`files`で2,380 bytes。
- bashの`rg`／`ls`との比較からの改善観点（利用者の指示でメモ、採用・実装は未承認）:
  - 通常の`rg`はgitignore対象の`.tools/`等を除外する。searchの既定scopeと除外指定を検討する際は、
    過去の測定用コピーやdependencyが通常のrepository調査へ混ざる返却量を比較する。
  - `rg --files -g 'README*'`ならREADMEの名前だけを探せる。searchでは`mode:"paths"`＋
    `glob:"README*"`が対応する。本文検索との取り違えを避ける発見性はA38にも関係する。
  - `ls`の名前だけの一覧なら、`entries`が常に返す種類・bytes・更新日時等を省ける。
    調査目的に必要な情報量に合わせた返却形式を候補とする。
  - 一致行をplain textで返せば、JSONの項目名・括弧・文字列エスケープの分を減らせる。
    今回はJSONの付加量より検索範囲とmodeの選択による増加が大きかったため、両者を区別して比較する。
  - 同じ調査目的を適切な範囲・modeの`rg`／`ls`で行う場合、4回合計は数KB〜10KB程度と推定した。
    追加実行による実測ではない。同じ範囲・同じ一致件数を返す場合はbashでも本文量が残る。
- 議論の整理: 除外という能力はこのtool設計では有用で、騒音を含む世界を1 callで絞れる。`!`書式は
  人・modelに既知で習得コストが無いが、**単独指定の意味論**（全体からの除外か、includeとの組み合わせ
  か）を契約として決める必要がある。
- 候補（案A・案B併記）:
  - 案A（gitignore準拠）:
    `glob`をstringまたはstring配列とし、`!`前要素を除外とする。positiveが無ければ
    全体、有れば「positiveに合致かつnegativeに非合致」。modelの書いた形がそのまま動き、誤用が構造的に
    消える。literalの`!`始まりpathにマッチさせる手段は未定（実需要はほぼ無い見込み）。
  - 案B（明示param）: `exclude`パラメータを追加し、`!`始まりのglobは明示errorで`exclude`へ誘導する。
    契約は明快だが、modelにはerror往復が1回発生する。
  - どちらでも現状の無言のゼロは解消する（案Aは動く形で、案Bはerrorで）。
  - 除外はfiles/paths/content/count/entries/statsの全modeに共通のglob filterに乗るため、案A・案Bの
    どちらでも全modeに効く。現状の無言ゼロも同じ経路で全modeに発生し得る。
- I1相当の文言整理（案A・案Bのどちらでも併用）: descriptionは「除外できない」の否定だけでなく、
  「`path`を絞る・callを分ける・`exclude`を使う」等、正面の代替行動を書く形へ改める。
- 利用者の見込み（2026-10-08）:
  おそらくM2（除外の実装）とI1（description書き換え）の両方をやるだろう。 採用・実装は未承認。
- 未確認: `!`使用の実頻度・失敗率は利用者観測ベースで数値未取得。literalの`!`始まりglobの実需要。
  案Aの複数pattern時の順序・上書き規則の詳細。
- 再検討条件:
  利用者がsearchの除外機能を採用するとき。その時点で案A／案Bの契約を決めてincrement化する。
- 関連: A2、A11、`external-tools/search/index.ts`、Session c5d830b5（広いglobの騒音例。`!`未使用）。

### A38 — searchのmode命名と機能の発見性（採用元の記録）

- 利用者の疑問（2026-10-08）:
  searchという名前に対して機能が多く（entries/paths/files/content/count/stats）、
  イメージしにくくなっているのでは。wc相当の挙動も説明にあるはず。
- 現行確認（2026-10-08、source確認）: tool説明は冒頭で「List, find, search, and
  count」と複数用途を宣言し、 mode→慣習コマンド対応（ls-style／find or rg --files／rg -l／grep or
  rg／grep -c相当／wc-style）と具体例を 記載。statsの詳細は2段落目、prompt guidelinesにも「Use
  search instead of bash ls, find, grep, rg, or wc」 「do not pipe a listing into
  wc」の記載あり。説明文自体は発見性を補完済み。
- 追加観測（2026-10-09、Session `7814247a`、保存済みcall確認）: Agentが`mode:"files"`で
  `pattern:"README*"`と`pattern:"provider*"`を使った。現行の`files`は`rg -l`相当の本文一致ファイル
  一覧であり、ファイル名の探索には`paths`＋`glob`を使う。返却量の内訳と`rg`／`ls`との比較観点は
  A37を参照。名前が誤用の原因だったかは未確認だが、操作上の取り違えを再検討する材料とする。
- 推測（未確認、根拠限定的）: 観測された誤用（A37の`!`によるrg的除外、広いsweep前のstats未使用）は
  「search＝grep」という機能名アンカー＋rg
  priorsで説明がつく。ツール名よりも、**mode名が慣習コマンドの
  信号を持たない**（特に`stats`をwcとして見つけるには説明文の読解が必要）ことが本体の可能性。
  説明文への注意が薄いmodelほど名前に依存する。「名前のせいで失敗している」の直接証拠はまだ薄い。
- 対処案（3案、product契約の判断は利用者へ戻す）:
  1. 据え置き＋説明改善: 現状維持し、A37のI1相当（正面の代替行動の記載）で補う。
  2. mode名を慣習対応にする（`stats`→`wc`等、または慣習名の別名を受け付ける）: 発見性は上がるが
     tool契約の変更。旧名併存の扱いを含めて要決定。
  3. ツール分割（ls/find/grep/wc系）: 直感的だがtool数とschema tokenが増える。
- 命名候補（coordinating案、2026-10-08、採否は利用者）: 改名するなら **`fs_inspect`**。
  - 理由: `git_inspect`（repositoryをread-onlyで調べる）と同じfamilyで対象差だけになる／動詞名の
    機能名アンカー（search＝grep）を外せる／`web_search`との区別が「fs／Web」で明確になる／
    `fileAccess: 'read'`のinspectの語感（変更しない調査）と整合する。
  - 却下候補: `fs`（mode頼みがさらに強まる）、`find`（grep/wc/ls実態と不合で、今度はfindアンカー）、
    `query`／`scan`（他tool familyとの関係で信号が弱い）。
  - 最終形のイメージ: ドメイン名で束ねる＋mode名で慣習コマンドに接続する（`stats`→`wc`等の案2と
    組み合わせ）。名前だけではwc探索の問題は残るため、両者を合わせて効かせる。
  - 注: 改名はtool契約の変更。履歴上の過去recordのtool名は変更しない前提で確認する。
- 未確認: 名前の影響度の実測。別名受入の実需要。分割時のtoken増減の比較。
- 再検討条件:
  利用者がmode名・tool構成の見直しを指示するとき、または発見性起因の誤用を追加観測したとき。
- 関連: A37、A11、`external-tools/search/index.ts`。

## 11. 実装・確認結果（2026-10-10）

### 11.1 実装した動作と接続

4 toolのschema・説明・factory・executorを`external-tools/{ls,find,grep,wc}/`へ外部定義した。

| tool | 実装した経路                                                                              | 返却と上限                                                                                              |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ls   | 自前のdirectory一覧とJSON hierarchy。明示したdirectory aliasは開ける。子symlinkは辿らない | `entries`、`count`、`childrenOmitted`、`omitted`。通常depth1、tree既定depth3、全treeのlimit100          |
| find | 起動時にinstalled fdを優先、なければGNU find。native glob、hidden込み、fd native ignore   | `backend`、`ignoreApplied`、`records`。allowed一致のlimit100で停止。停止時はtotalを返さない             |
| grep | 起動時にinstalled rgを優先、なければGNU grep-E。native regex/literal/glob                 | 検索完走してexact `total`。一致返却limit100、context別件数。一致行をcontextより優先してbyte予算へ収める |
| wc   | 必須`files`配列をstream計数。directory展開なし                                            | LF/Unicode White_Space/raw bytes。全file `totals`、返却 `pageTotals`。offset0/limit100                  |

find/grepは外部async factoryで実行可能な絶対pathとbackendを一度選び、同じWorkerのtool description・
実行・結果JSONを揃える。自動registryやambient読込経路は追加していない。rg/fdを同梱・自動取得せず、
GNU fallbackでは`ignoreApplied:false`、未対応の除外指定はtool errorとする。

4名のdefault allowを`/`にし、既存common denyを引き継いだ。default Agent、reviewer Agent、bashの
選択案内、配布・installer、README英日と外部tool README、TUI previewを4 toolへ更新した。
新規実行用search folderと旧6mode専用test、旧search専用配布probeを削除した。新名aliasや旧modeの
compatibility経路は作っていない。保存済みsearch preview・semantic履歴は保持した。
A37・A38の原観測は第10節へ移管し、sed案A40は未採用候補のまま残した。

### 11.2 toolごとのtest・独立review

- find: GNU fallbackのnative path glob、allowed一致後の停止、workspace外、ignore未適用表示、
  installed fdのnative ignore・glob error・正常0件を確認。独立reviewで`--no-require-git`の一律指定が
  nested Git境界を越す問題を実証した。repo外だけ指定する修正とnested checkout回帰を加え、
  差分限定re-reviewで解消を確認した。focused 2 passed。
- ls: direct/tree・空directoryと未探索の区別・depth/limit/byte省略を確認。reviewでdepth省略fieldの
  byte計算漏れと明示directory alias拒否を実証した。修正し、2100directoryのbyte省略とalias回帰を
  加えた。差分限定re-reviewで解消を確認した。focused 3 passed。
- wc: UTF-8の64KiB境界、LF/Unicode whitespace/raw bytes、返却pageと全file totals、byte省略後の
  全file集計を確認。独立reviewで必須findingなし。focused 2 passed。
- grep: 実rg・GNU grepのignore、ordered !、native regex差とsyntax error、正常0件、contextとfiles、
  返却1MiB超過後も全2200一致を計数する経路を確認。reviewで下位scopeのdeny globとcwdの不一致、
  巨大contextが一致行を押し出す問題を実証した。cwdとnative JSON path解決をscopeへ揃えた。
  context修正の限定re-reviewでは格納済contextによる後続match省略も残存すると判定されたため、
  必要なcontextを省略して一致行を優先する修正を加えた。最終差分は親がbyte・件数・順序の更新を
  確認し、約1.04MB context＋約1KB/8KBの2matchが両方返る実rg回帰を確認した。focused 3 passed。

安定候補の4 tool focused testは10 passed。実Workerの共通deny・workspace外とhome/alias、
reviewer宣言とinstruction、wc production経路、配布・installer、既存history previewを含む
関連focused確認は46 passed。active tool guidelinesの挿入と重複なしは別のfocused 1 passed。 関連type
check、repository設定でのformat/lint、shell syntax、`git diff --check`も成功した。 full
gateは計画どおり実施していない。

確認出力は`.tools/increment-223-e2e/focused-tools.txt`、`focused-integration.txt`。

### 11.3 compiled Core/TUIと4 tool e2e

安定candidateを`.tools/increment-223-e2e/hjh`へbuildした。build IDは
`4555545be0e9a4803c314105da6a7022d719f02a2f19db1e44243ae1ab58e759`。 隔離HOME/XDGのcompiled
Coreを起動し、tmuxのproduction TUIから1turnをsubmitした。
名前・本文・tree・集計用fixtureだけを使い、実configや稼働Coreは変更していない。

- localhost protocol e2e: 4 toolを同じturnで各1回呼び、次requestで4結果を受け取り完了。
  modelに送ったtool declarationsが4名だけでsearchを含まず、find/grep説明に現在backendを含むこと、
  active tool guidelinesがsystem instructionへ挿入されることをrequestとsemantic readbackで確認した。
  安定candidateの確認先は`.tools/increment-223-e2e/localhost-20261010T031513/`。
  live画面の表示観測を5秒待って再確認した追加localhost runは`localhost-20261010T031710/`。
- 実provider e2e: OpenCode Go Chat／`deepseek-v4.1-flash`、1turn、HTTP model request **2回**。 最大4
  stepの設定内で、モデルがls/find/grep/wcを各1回呼び、結果に基づいて回答した。 保存済みrequest
  factのprovider/modelと実Session選択も一致した。
  保存先は`.tools/increment-223-e2e/real-20261010T031530/`。
- lsはtree/depth2で5entry、findはGNU findで3file・`ignoreApplied:false`（ignored.txt込み）。
  grepはrgで`.gitignore`を適用し、全体2一致・limit1で1件返却／1件省略。
  wcは指定2fileの全体を3行・6語・37bytesと計数した。4結果のsemantic保存とSession再表示を確認した。
- 確認scriptは`.tools/increment-223-e2e/run.py`。各runの`report.json`、`tool-results.json`、`physical-request-facts.json`、
  `observed-tool-contracts.json`、`context-system.txt`、TUI captureが証拠。 初回localhost
  runではprobe側のwc期待値を36bytesとして失敗したが、実fixtureは37bytesだった。
  probeの期待値を訂正し、後続の安定candidate runで全確認を通した。product変更は不要だった。

fdはdefault tool PATHには未導入で、e2eはGNU fallbackを確認した。fdの通常経路は別focused testで
既存の実行可能commandを隔離設定から指定して確認した。fdをinstall・同梱していない。
この1turnからmodelの誤用率改善までは断定しない。

### 11.4 今回とは別のTUI観測と承認境界

live画面では並列4callのうちlsだけ✓になり、find/grep/wcの完了記号が…のまま残った。
localhostでも完了後5秒待って再現した。保存結果は4件とも成功で、Core/TUIを開き直すと全件✓になる。
`conversation_flow.ts`のnormal-screen経路がtoolの初期状態を一度committed rowへ出し、tool entryを
mutable bandへ入れないことと整合する。tool処理・保存の失敗ではなくlive完了表示の問題である。
利用者はこの表示を既知の問題と認識し、「このままでいい」と現状維持を指示した。追加修正は行わず、通常利用メモへ加えたB13は未解決候補から外した。

localの4 tool実装、test/review、search削除、instruction挿入、4 tool e2eは完了。
実装・e2e時点では実config更新・常用配置・commit/pushは未実施だった。後続のcommit・配置指示は第12節。
構想・architecture・roadmap正本は未変更。反映案は第7節に保持し、別途明示承認を得る。

## 12. コミット・常用配置（2026-10-10）

利用者の「このままでいい　コミットして配置」により、今回のlocal変更のcommitと常用配置を承認した。
並列toolの完了表示は現状維持。push、構想・architecture・roadmap正本の変更はこの依頼に含めない。

実装を`c3a1e3a9`へcommitし、そのclean sourceからcandidateをbuildした。 E2E済みbinaryとembedded
runtime SHA-256が一致し、4外部toolのfile hashも実provider e2eのassetと一致した。
`dist/hjh`と常用`hjh`へatomicに配置し、両方のbinary hashを照合した。

- build ID: `348f17150051f9f43a7c5dba6e6fbc7645a4721afd83c33ad2728b450a479170`
- embedded runtime SHA-256: `07019cde231b9470833f0a02c913db9dbbea9d11cc4eea586c156134081ff86b`
- binary SHA-256: `f291aae0719bbf3a46a02e41d0e240554006dfcda38ab78c8a2181a5859a9d6a`
- build sourceDirty: `false`

4 tool folderを常用configへ配置・登録し、旧searchの登録を解除した。reviewer設定とuser scope
instructionの旧6mode案内も4 toolへ更新した。旧search sourceは削除せず保持し、旧binaryと関連設定は
`.tools/increment-223-deployment/`へ退避した。無関係のtool・設定・履歴・credentialは変更していない。

配置後はinstalled binaryと常用環境からコピーした4 tool source・user instructionを隔離XDGで起動した。
localhostの4 tool同時呼出し、startup tool説明のbackendとsystem instruction挿入、結果保存、 compiled
Core/TUI・保存Session再表示の確認に成功した。配置時の実provider追加利用は0。
既存の稼働Core/TUIは再起動していない。新しいCore起動から新binary・tool設定を使う。

配置・退避・照合の証拠は`.tools/increment-223-deployment/deployment.json`、
配置後確認は`.tools/increment-223-deployment/localhost-20261010T090742/report.json`とsemantic
readback/TUI capture。 並列toolのlive完了記号は利用者が選んだ現状を保持した。
