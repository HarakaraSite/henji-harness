# Increment 206 — A36・A37: file集計と専用toolの選択案内

状態: 利用者の「A36、37をやろう」（2026-10-06）により採用。local実装・focused検証・常用外部toolと
instructionへの反映を完了。実modelの自発的なtool選択は通常利用での観測待ち。

## 利用者が必要とする動作と根拠

- fileの行数・単語数・バイト数を、bashの`wc`を使わず専用toolで確認する。特に行数は読取範囲・
  分割方法や編集前後の規模確認に使う。
- 一覧・検索・件数確認で`search`を、対応するGit差分・状態・履歴の確認で`git_inspect`を選びやすくする。
  根拠は利用者の通常利用の観測とA36・A37の明示採用である。
- 説明文がtool選択の原因だったか、改善後にmodelが従うかは未確認。機能確認と説明の到達確認を行い、
  実modelの選択改善は通常利用で観測する。

## 現行product経路と変更範囲

外部toolの`tool.json`・`index.ts`・`settings.ts`をconfig bindingからWorkerが読み込む。
`search`の既存file列挙→glob絞込→検索→JSON page経路に`stats`を加える。集計はtool内で完結し、
返り値は既存tool result・semantic履歴経路に流れる。新しい状態所有者・保存先・Core/Data
APIは増やさない。 `promptGuidelines`はregistryから共通instructionのActive tool
guidelinesへ合成されるため、 親とreviewerの両方へ実際に渡ることをprovider-free Workerで確認する。

## 採用契約と実装方針

### A36: `search`の`stats`

- `mode: "stats"`は`pattern`不要。既存の`path`（fileまたはdirectory）・`glob`・`offset`・`limit`を使う。
  directoryは既存の再帰file列挙と同じ範囲・順序を使う。
- `records`は`{path, lines, words, bytes}`。既存の`total`・`hasMore`・`nextOffset`等のpage形式を使い、
  `total`は選択されたfile数である。
- `lines`はLF byteの数。末尾の改行がない部分は数えない（`wc -l`と同じ）。
  [GNU wcの公式仕様](https://www.gnu.org/software/coreutils/manual/html_node/wc-invocation.html)を確認した。
- `words`はUTF-8文字列をUnicode `White_Space`で区切った非空列の数。localeに依存しない。 GNU
  wcのlocale依存規則や追加の空白扱いを完全再現するcontractにはしない。
  不正UTF-8はTextDecoderの置換文字で読む。`bytes`は実際に読んだ全byte数。
- fileを64 KiB bufferで逐次読み、UTF-8文字と単語がread境界を跨いでも継続して数える。
  file全量をmemoryへ載せず、既存のcancel signalへ従う。新しい入力・出力上限は設けない。
- `stats`は検索用のDB/blob除外を通さず、選択されたfileを集計する。
  既存の`count`（検索語の出現回数）と`entries`（metadata）は維持する。

### A37: 説明・guideline・user instruction

- `search`のdescription先頭とmode schemaへ操作の対応を置く:
  `ls`→`entries`、`find`/`rg --files`→`paths`、`rg -l`→`files`、`grep`/`rg`→`content`、
  出現回数→`count`、`wc`相当→`stats`。
- `paths.total`はfile数、`files.total`は一致file数、`count.matchCount`は出現回数と明示する。
  詳細仕様はdescription後半へ置き、既存のglob・truncation案内を保持する。
- `git_inspect`のdescription先頭へ`status`・通常diff・cached
  diff・diffstat・path絞込・log・showの例を置く。 guidelineでは対応するworkspace
  Git操作に同toolを使い、bashで実行しないと明示する。
- user-owned
  `instruction.md`の既存operation別tool選択段落に一覧・件数・file集計と具体的modeを明示する。
  その他の既存指示は維持する。
- 外部tool revisionは`search: local-5`、`git_inspect: 2`。

## 確認するproduct動作

- production Worker経路で単一file・directory/glob・pageを集計できること。
  実fileに対する`wc -l -w -c`を独立した参照にし、空file、最終部分行、日本語と空白、
  UTF-8/単語のread境界を含む実読取で確認する。
- 親・reviewerのmodel可視instructionへ新しい案内が渡ること（実provider request 0回）。
- 既存search（rg/grep、count）とgit inspection・entriesのfocused testで回帰を確認する。
- 変更fileのtype check・fmt・lint・`git diff --check`を行う。full gateは計画しない。
  TUI表示処理の変更はなく、Surfaceのtmux確認対象にはしない。

## 実装・確認結果

- `external-tools/search/index.ts`へ`stats`を実装し、descriptionとschemaのmode案内を更新。
  `promptGuidelines`へcommandとの対応と件数の読み方を追加した。
- `external-tools/git_inspect/index.ts`のdescriptionとguidelineへGit操作の例と専用tool使用指示を追加。
  各`tool.json`のrevisionを`search: local-5`・`git_inspect: 2`へ更新。
- `external-tools/README.md`へ操作対応表、statsの返り値・集計定義とdiff例を追記。
- `tests/v0/increment_206_file_stats_test.ts`で、production Workerの宣言・dispatch・tool
  result経路を
  通して単一file、directory/glob、paging、UTF-8/単語のread境界、model可視guidelineを確認した。
  実fileの結果は`wc -l -w -c`（`LC_ALL=C.UTF-8`）と比較して一致した。
- focused結果: 206・186（search rg/grep/count）・201（git inspection/entries）の3fileで **4 passed /
  0 failed**。変更TypeScriptの`deno check`・`deno lint`、変更fileの`deno fmt --check`、
  `git diff --check`がpass。full suite/gateは実行していない。
- 常用configへの反映: toolの`index.ts`・`tool.json`とuser-owned
  instructionのtool選択段落を更新した。 反映前のtool
  sourceがrepositoryの変更前sourceと一致することを確認し、編集可能な`settings.ts`と
  既存bindingは維持した。backupは`.tools/increment-206/config-backup/`。
- 常用configのproduction Worker経路で、親・reviewerとも新しいsearch/git_inspect guidelineと user
  instructionのmode案内がmodel可視instructionに到達した。 配置したstatsはsample
  fileで`lines: 2, words: 5, bytes: 32`を返し、実wcと一致。 配置したgit_inspectのscoped
  diffも成功し、常用compiled binaryの`tool inspect`は
  新revisionを認識した。証拠は`.tools/increment-206/acceptance.json`と同directoryのguideline
  readback。
- 確認用scriptの最初の呼び出しでは、bundled defaultをnamed Agentとして指定してstartupで失敗した。
  既存のdefault選択（空のagentChoice）に直して確認した。product sourceの問題ではなく、
  確認scriptの指定誤りである。
- 実provider requestは全確認で**0回**。実modelの自発的なtool選択は未確認で、通常利用で観測する。
  外部source・instructionはWorker起動時に読み込むため、新しいWorker generationから有効となる。
  binary/APIの変更はなく、再buildや起動中Core/TUIの停止・再起動は行っていない。

### 反映したuser-owned instructionの段落

```text
Choose tools by operation: use read for workspace file inspection and write or edit for workspace file changes. Use search for directory listings (entries), recursive file discovery and file counts (paths), matching files and their count (files), matching lines (content), pattern occurrences (count), and file line/word/byte counts (stats). Use git_inspect for supported workspace Git status, diff, log, and show, including staged diffs and diffstat; use its paths and offset/limit instead of shell filters. Use run_typescript for other aggregations, transformations, and file operations in its permitted paths.
```

## 承認境界

A36・A37のlocal実装と非破壊的検証は利用者の明示指示で承認済み。
この範囲として常用外部toolとuser-owned instructionのlocal変更を反映した。
利用者の「コミットプッシュ配置して」（2026-10-06）により、commit・公式build・常用配置・pushを承認済み。
公開/release・実provider callは今回の対象外とする。 構想・architecture・roadmapの正本は変更しない。

## 通常利用メモから移設した原記録

以下は採用前の記録であり、現在の状態は上記の契約・結果を正本とする。

### A36 — `search`に`wc`相当のfile集計を追加（未採用、メモのみ）

- 利用者の希望（2026-10-06）: `search`の`count`が検索語の出現回数であり、`wc`相当の機能は
  ないことを確認した。追加する価値を相談した後、「メモして」と指示した。
- 現行境界: `count`は検索語の出現回数を返す。`entries`はfileのバイト数を返すが、行数・単語数は
  返さない。行数・単語数は現状では`run_typescript`等で集計する。
- 候補: `search`に`stats`等のmodeを追加し、fileの行数・単語数・バイト数を返す。
  mode名と集計の具体的な契約は採用時に決め、検索の出現回数を返す`count`と区別する。
- 便益: 特に行数を、読取範囲・分割方法の判断や編集前後の規模確認に使える。
  この集計のためだけにbashを使う必要を減らす。
- 案内: tool説明の先頭で「`wc`相当」と明示し、modelが普段のcommandと専用toolを対応付けやすくする。
  機能追加だけでtool選択が改善するかは未確認。
- 再検討条件: 利用者が専用toolによるfile集計の採用を指示するとき。
- 関連: `external-tools/search/index.ts`。

### A37 — `search`・`git_inspect`の説明とtool選択案内の改善（未採用、メモのみ）

- 利用者の観測・希望（2026-10-06）: `search`があまり使われず、一覧確認や`git diff`でも専用toolを
  使ってほしいと相談した。説明文の改善案について「説明文の改善もメモして」と指示した。
- 現行の案内（同日source・常用config照合）: `search`の説明はmode紹介の後に仕様詳細が長く続く。
  guidelineはfind・grep・rgより優先すると書くが、`ls`との対応を明示していない。
  `git_inspect`はstatus・diff・log・showを明示するが、選択案内は`Prefer`という推奨表現である。 user
  instructionの`path/content lookup`も、一覧・件数確認を明示していない。
- 候補: tool説明の先頭に用途と普段のcommandとの対応を短く置き、詳細仕様と分ける。
  `search`は`ls`相当の直下一覧・metadata→`entries`、`find`・`rg --files`相当の再帰file一覧→`paths`、
  一致file→`files`、一致行→`content`、出現回数→`count`を明示する。
  file数は`paths`の`total`、一致file数は`files`の`total`で確認できることも案内する。
- `git_inspect`の候補: 対応するworkspaceのstatus・diff・log・showでは同toolを使う指示にし、
  通常diff、`staged: true`によるcached diff、`stat: true`によるdiffstatの対応を短い例で示す。
  同toolで対応できる操作をbashで実行しないことを明示する。
- 未確認: 説明文が実際のtool選択を左右した原因かは未確定。改善後は通常利用で選択を観測する。
  A36の`wc`相当機能は未実装であり、現時点で対応済みと案内しない。
- 再検討条件: 利用者が説明文・guideline・instructionの改善を採用するとき。
- 関連: A36、`external-tools/search/index.ts`、`external-tools/git_inspect/index.ts`、 user-owned
  `instruction.md`。
