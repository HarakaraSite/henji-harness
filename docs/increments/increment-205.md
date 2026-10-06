# Increment 205 — S34: `search`の検索条件・`run_typescript`の生成コードの抜粋表示

状態: 完了（2026-10-06、利用者による完了承認済み）。利用者承認済み計画で実装し、focused確認・独立
review・隔離tmuxのproduction TUI確認・source commit・公式build・常用配置・pushまで完了した。
利用者の「インクリメント205を完了とします」（2026-10-06）により完了とした。

## 利用者が必要とする動作と根拠

通常利用メモS34の記録（2026-10-05）:

- `tool> search`に検索パラメータの一部を表示したい。TypeScript toolもAgentが組み立てたscriptの一部を
  表示できるか検討したい。ただし先頭だけではimportしか見えない可能性がある。
- 実利用観察（Session `2bc2699f`）: 4回の`run_typescript`はいずれもfile編集で、先頭数行を出すだけでは
  書込処理や編集対象を把握しにくかった。構文解析で主要処理を選ぶ案も検討した。
- 利用者提案: `run_typescript`のtool案内で、生成する`code`の先頭に処理目的の一行コメントを入れるよう
  促し、表示側はそのコメント本文を出す。利用者の「うんいいね」によりこの方針に合意した。
- 検索表示案: `mode`・`pattern`・`path`を短く表示し、`paths` modeでは`glob`を手掛かりにする。
  補助条件の範囲と、長い検索語・pathの表示配分は未決。

利用者は本会話で2026-10-06に「S34の対応をしようと思う」と述べ、205として進める意向を示した。
この発言はrepository文書には未記録であり、会話の利用者指示として扱う。通常利用メモの記載だけでは
採用・実装を意味しないため、本計画の表示契約と実装範囲について利用者の確認を待つ。

## 現行product経路（2026-10-06、source照合）

- 引数previewは`v0/agent/tools/tool_activity.ts`の`toolActivityPreview(name, args)`が唯一の実装である。
  `bash`・`read`・`write`/`edit`・`bash_output`・`web_search`・`web_fetch`・`skill`・`spawn_subagent`を
  分岐し、未知のtoolは引数なし（名前だけ）になる。`search`と`run_typescript`の分岐はない。
- 同じhelperを使う実稼働経路は3つ:
  - `v0/tui/state.ts`: liveイベントのtool_call/tool_progress/tool_result。
  - `v0/tui/keyed_conversation_store.ts`: Core snapshotのtool entity投影（保存Session再表示を含む）。
  - `v0/agent/history/history_view.ts`: `henji history` CLIとHTTP `view=session`の`tool> `行。
  加えて`v0/tui/terminal_text.ts`の`toolCallText`も同じhelperを使うが、現行sourceではproduction呼出しが
  なく、testが使うdirect renderer seamである（`tests/v0/tui_tool_preview_test.ts`）。
- 引数を表示する別経路があり、本計画の対象外とする:
  - `v0/agent/cli/run_events.ts`の`argumentPreview`: `henji run --stream`のstderr行。引数JSON全体を
    160 unitsで切って出す（例 `tool> search {"mode":…}`）。
  - `v0/agent/session/history_export.ts`: export markdownの`### tool> name`と引数JSON全体のブロック。
- tool引数はConversationのtool entity（`v0/conversation/model.ts`の`arguments`）とsemantic履歴に既に
  保存されている。表示のための新しい保存先・model request・Core/Data変更は不要である。
- previewは`boundedHead`で96 UTF-8 bytesに制限し（文字単位で切るためUTF-8境界は壊れない）、
  `pendingToolActivityText`／`settledToolActivityText`が末尾へ状態記号（…／✓／✗）を付ける。
- `state.ts`はtool_progress／tool_resultで既存行から`previewFromToolActivityText`によりpreviewを復元する。
  実行中→完了後→保存Session再表示で同じ抜粋が残る経路である。
- `search`はconfig rootの外部tool（現行`local-4`）が実装するが、previewはcore側のtool名一致で決まる。
  外部toolのrevisionには依存しない。
- `run_typescript`のmodel可視テキストは`v0/agent/tools/run_typescript.ts`の`description`と
  `promptGuidelines`にあり、`code`の先頭コメント規約は現在記載していない。

## 表示契約（提案）

利用者はtool行が2〜3行へ折返す表示を許容している。既存の96 bytes上限と状態記号の位置は維持する。
tool activity textは既存previewと同じく1行の論理行として扱う。

### `search`

`mode`を先頭に、存在する引数だけを`pattern` → `glob` → `path`の順で表示する。
各要素は次のbudget（`…`の3 bytesを含む）で切り、切れた箇所は`…`で示す。

| 要素    | 形式                 | 表示budget（`…`を含む） |
| ------- | -------------------- | ----------------------- |
| mode    | そのまま             | 8 bytes                 |
| pattern | `"…"`で囲む          | 38 bytes                |
| glob    | `glob="…"`           | 23 bytes                |
| path    | そのまま             | 22 bytes                |

budget最悪値は mode 8 + 空白3 + pattern 38 + glob 23 + path 22 = 94 bytesで、既存の全体96 bytes上限内に
収まる。各要素のbudgetが`…`を含むため、長い要素だけが省略され他の要素は残る（全体上限は保険として
維持する）。各要素は最初の行のみを使い（`firstLine`相当）、前後の空白を除く。空文字・非文字列・欠落の
要素は省略する。

例:

- `search content "toolActivityPreview" v0/`
- `search count "TODO" scripts/`
- `search paths glob="*.ts" tests/v0`
- 長い値: `search content "認証処理を調べて原因を…" tests/v0/tui_tool…`

`patternKind`・`caseSensitive`・`offset`・`limit`・`depth`は表示しない。検索対象の把握には不要で、
行が長くなるためである。`path`省略時は補完しない（workspace rootが既定であることはtool contractの
既知事項とする）。`mode`は検証前の生引数であり得るが、上限8 bytesに収める。

### `run_typescript`

- `v0/agent/tools/run_typescript.ts`のmodel可視テキストへ、`code`の先頭に処理目的の一行`//`コメントを
  書く規約を追加する（例: `// TUI関連7ファイルの配色とtool名の表示を変更する`）。置き場所の第一候補は
  `promptGuidelines`（Increment 200で導入したactive tool guidelineの既存拡張点）。`description`へ置いても
  成立する。
- previewの抽出規則（focused testで固定する）:
  1. `code`の先頭2048 bytesだけを対象にする（それ以降は見ない）。
  2. 先頭から連続する空行・空白のみの行を飛ばす。
  3. 最初の非空行が`//`で始まる場合だけ、その行から`//`と前後空白を除いた本文を出す（本文が空なら
     名前のみ）。
  4. 最初の非空行が`//`でなければ名前のみ。後方にある`//`は拾わない。
  5. コメント本文は既存の96 bytes上限を使う。
- 例: `run_typescript TUI関連7ファイルの配色を変更する ✓`
- コメントはAgentが記す処理意図であり、実行された処理や結果との一致を保証しない。S34の便益は
  コメントがあるcallでのみ成立する。コメントがないcallも実行できるままとし、代替抜粋は追加しない。

## 未確認・実装時に確認する事項

- 上記のbudgetと長さが実表示で読みやすいか。tmux確認で提示し、必要なら調整する。
- 実modelが先頭コメント規約に従うかはmodel可視テキストだけでは保証されない。遵守確認を必須受入に
  しない。
- `search`の補助条件表示は、実利用の観察後に再検討する。

## 確認するproduct動作

| 動作                                                     | 確認方法                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| 実行中のsearch行にmode・pattern・glob・pathが出る         | focused test（state reducer）                                 |
| 完了後も同じ抜粋が状態記号付きで残る                      | focused test（tool_result）                                   |
| 保存Session再表示でも同じ抜粋になる                       | focused test（conversation fixtureのtool entity投影）＋tmux   |
| 長いpattern・glob・pathが要素ごとに省略される             | focused test（要素budgetと全体byte数）                        |
| 改行入りpattern・pathでもtool行が1行のまま                | focused test                                                  |
| modeが長い・未知でも行が壊れない                          | focused test                                                  |
| run_typescript行に先頭コメントが出る                      | focused test（pending→settled）                               |
| 空行のみ・非コメント先頭・空コメントは名前のみ            | focused test                                                  |
| 表示していないcode本文がtool行に出ない                    | focused test（行textにcode本文が含まれないこと）              |
| history CLI/APIの`tool> `行も同じ抜粋になる               | 同一helper実装のsource確認と既存history testの回帰            |
| production TUIの実行中・完了後・再表示の表示              | 隔離XDG/workspaceのcompiled binary TUIをtmuxで確認            |

変更箇所のtype check、format、lint、`git diff --check`を行う。Surface局所変更のため、途中の
`v0:test`／`v0:gate`は使わず、この計画ではfull gateを要求しない。

tmux確認の具体化（Increment 193の手順を踏襲）:

- 確認用binaryを`.tools/increment-205/henji`へbuildし、常用binaryと`dist/henji`は変更しない。
- 隔離HOME/XDG/workspaceのconfigへ既存の`tool activate --name search --folder external-tools/search`で
  searchを登録する（未登録だと検索の行が✗になり表示確認にならない）。
- local provider（OpenAI互換のlocalhost HTTP）が、長いpattern/pathを含む`search` callと、先頭コメント
  付き`code`の`run_typescript` callを返す1 turnを実行し、pending→settledと保存Session再表示のSGR画面を
  記録する。実provider callは0回。

## 実装範囲

- `v0/agent/tools/tool_activity.ts`: `search`と`run_typescript`の分岐を追加。
- `v0/agent/tools/run_typescript.ts`: `promptGuidelines`（第一候補）へ先頭コメント規約を1行追加。
- `tests/v0/tui_tool_preview_test.ts`: 上記動作のfocused testを追加。
- `README.md`・`README.ja.md`の`run_typescript`利用例へ先頭コメントを足すのは任意（runtime動作を
  変えない文書変更）。

## 実装・focused確認結果（2026-10-06）

利用者の「1 推奨通り　2 承認する　実装テスト後レビューを実施」により、`--stream`を対象外として
本計画の実装を開始した。

### 実装

- `v0/agent/tools/tool_activity.ts`: `search`分岐（`mode` → `"pattern"` → `glob="…"` → `path`、
  要素ごとのbyte budget、最初の行のみ、空要素は省略）と `run_typescript`分岐（先頭2048 bytesの走査、
  最初の非空行が`//`の場合のみコメント本文）を追加。
- `v0/agent/tools/run_typescript.ts`: `promptGuidelines`へ先頭コメント規約を1行追加。
- `tests/v0/tui_tool_preview_test.ts`: focused testを追加（search 5件、run_typescript 3件、
  保存entity行1件、seam testの更新）。
- `README.md`・`README.ja.md`: 利用例の`code`へ先頭コメントを追加し、tool行に表示されることを1文で記載。

### focused確認

- `tests/v0/tui_tool_preview_test.ts`は27件pass・0 fail（`.tools/increment-205/focused-test.log`）。
- 関連する既存test（`tui_conversation_presentation_test`・`tui_retained_terminal_test`・
  `agent_worker_foundation_test`・`current_code_test`・`increment_191_configuration_test`）は
  94件pass・0 fail（`related-tests.log`）。guideline追加後もinstruction合成の期待は成立している。
- 変更fileと対象testのtype check、fmt、lint、`git diff --check`は成功（`type-check.log`）。
- 未実施: 独立review（実施中）。
- 作業treeには別sessionが記録した`docs/experience/normal-use-inbox.md`のA35メモ（2026-10-06）が
  あり、本incrementの変更には含めない。

### 独立review結果（実装、2026-10-06）

独立reviewer（reviewer agent、`opencode-go-chat`／`deepseek-v4.1-flash`／max）が差分
（`.tools/increment-205/source.diff`、5ファイル、current worktreeの`git diff`との一致確認済み）を
current sourceと照合した。製品correctnessのfindingは成立せず（Blocker/P1/P2なし）、次を確認した。

- `search`/`run_typescript` previewが承認済み表示契約と一致（順序・要素budget 8/38/23/22・`…`込み・
  全体96 bytes以内、先頭2048 bytes走査、最初の非空行が`//`の場合のみ、非文字列・空コメント・
  巨大`code`の挙動）。
- guideline追加がmodel可視経路（`Registry.promptGuidelines()`→instruction compose）に載り、
  既存の一意性assertと完全一致assert（run_typescript非materialize）を壊さない。
- 追加testが変更product動作に対応し、期待値のbyte計算が実装と一致。既存previewと
  `previewFromToolActivityText`の契約は不変。`tool> search`/`tool> run_typescript`を期待する既存testは
  なく回帰経路なし。focused 27件・関連94件はtest定義数と一致。

参考観測への対応:

- fmt/lint/`git diff --check`の証跡が`type-check.log`のみだったため、`fmt-lint-diffcheck.log`へ
  再取得して保存した。
- 2048 bytes境界を固定するtestは計画の確認表にないため追加していない（source上の挙動は一意）。
- 表示例`tests/v0/tui_…`は22 bytes予算の厳密なbyte例ではなかったため`tests/v0/tui_tool…`へ直した。
- 通常利用メモのS34は採用済みのため、本書末尾「採用前S34の原記録」へ移設し、候補一覧から除いた。

### 隔離tmuxのproduction TUI確認（実provider 0）

- 確認用binary（build ID `b65ca98af6fbbf64a33b47686bb7cd426ddef1d0dec0bdb90da8aa566abacb74`、
  source `2344ff82+dirty`、runtime digest `43d10091dbd802daf765b64482b8ba8662a8a1055bc33f10788a67495c4355bc`）を
  公式build scriptで`.tools/increment-205/henji`へ作成し、常用binaryと`dist/henji`は変更していない。
- 隔離HOME/XDG/workspaceと専用tmux socketでcompiled Core＋TUIを起動し、local provider
  （127.0.0.1、物理request 2件）がsearch 2件とrun_typescript 1件を呼ぶ1 turnを実行した。
  executionはcompleted／canonical（`.tools/increment-205/local-tmux-result.json`）。
- pending画面: `tool> search content "needle" . …`、
  `tool> search content "needle-xxxxxxxxxxxxxxxxxxxxxxxxxx…" aaaaaaaaaaaaaaaaaaa… …`、
  `tool> run_typescript 検索結果を集計する …`。
- 完了後は同じ行が`✓`。長いpatternは26 xで`…`、長いpathは19 aで`…`に省略され、code本文
  （`readTextFile`）とtool結果（`{"ok"`）は行に出ていない。
- 保存Session再表示: TUIをdetachし、通常起動で同じSessionへ再接続すると同じ3行が同じ抜粋で表示された。
- tool prefixは緑dimのままで、preview開始位置でresetしていることをSGR記録で確認した。
- 初回probeはcredential配置が旧config rootのままで`credential unavailable`により失敗した。204で
  credential rootが`${stateRoot}/credentials`へ移ったため、probeの隔離config側を新rootへ直して再実行した。
  製品sourceの追加修正はない。
- 証拠は`.tools/increment-205/`（`local-completed*.txt`、`local-tool-pending*.txt`、
  `local-normal-entry-reconnected*.txt`、result JSON、semantic events、`build.log`、`tmux.log`）。

### Commit・公式build・常用配置・push結果（2026-10-06）

利用者の「コミット　常用配置　プッシュして」により実施した。

- source commitは`841c9b6ca2229737e7450d400aeb92b924ff7dce`
  （`feat: show search and run_typescript tool row excerpts`）。変更source/test、README、
  205文書、handoff、通常利用メモのS34移設だけを含め、別sessionのA35メモと既存の未追跡file
  （`191-result.json`、`scripts/diagnostics/__pycache__/`）は含めていない。
- このcommitから公式`henji:compile`で0.9.0をbuildした（sourceDirty=false）。build IDは
  `0bd658345ae446d6ccfd650a39161412dd7c5e8809af34ea02e68a000c7edb47`、runtime digestは
  `43d10091dbd802daf765b64482b8ba8662a8a1055bc33f10788a67495c4355bc`で、隔離tmux probeで確認した
  candidate（build ID `b65ca98a…`）のruntime digestと一致した。
- `dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。両配置先のversion・SHA-256
  （`704336a5a72c6800d04b32894644df2bf6ed150017722e19ed55afef9c280336`）が一致した。直前の
  binaryは`~/.local/bin/henji.previous`と`.tools/increment-205/deployment/henji.local.previous`
  （旧SHA-256 `3e1e6c00…`）へ、元の`henji.previous`は`.tools/increment-205/deployment/henji.local.previous.pre205`
  へ保存した。
- 配置後、配置済みbinaryで隔離HOME/XDG/workspaceのCore＋TUIを起動し、`● ready`表示、Ctrl-Qでの
  TUI終了とCoreのexit 0、Core APIのbuild情報（0.9.0／source `841c9b6c`／sourceDirty=false／
  runtime digest一致）を確認した（`deployment/smoke.json`、実provider request 0）。
- `origin/main`へ`d2c8bf67..841c9b6c`を送信し、本記録のdocs commitも続けて送信した。
  公開/releaseは実施していない。

## 対象外

- `henji run --stream`のtool行（`v0/agent/cli/run_events.ts`の`argumentPreview`）と、export markdownの
  引数全量（`v0/agent/session/history_export.ts`）。利用者は2026-10-06に「1 推奨通り」として、
  対象外のままとすることを確認した。
- 検索補助条件（patternKind・caseSensitive・offset・limit・depth）の表示、pattern不在時の補完。
- 構文解析による主要処理抽出、コメント不在時の代替抜粋、modelによる要約引数の追加。
- 新しい保存先・設定・上限の追加、tool実行の制御変更、history schema/API変更。
- 構想・architecture・roadmapの変更。roadmapは個別incrementを追記しない方針であり、TUI表示改善は
  既存F01の範囲である。

## 計画レビュー結果（2026-10-06）

独立reviewer（reviewer agent、`opencode-go-chat`／`deepseek-v4.1-flash`／max）が本計画をcurrent sourceと
照合した。採用可能なBlocker/P1はなく、次のfindingを計画へ反映した。

- F1（Medium、採用）: current routeの記述誤り。`v0/tui/terminal_text.ts`の`toolCallText`は現行sourceで
  production未参照のseamであり、`--stream`のtool行は`v0/agent/cli/run_events.ts`の`argumentPreview`
  （生JSONを160 unitsで切る）である。計画の「4経路」記述を訂正し、`--stream`とexportを対象外として
  明記した。`--stream`を今回の対象に含めるかは利用者判断として残す。
- F2（Low、採用）: 改行入りの`pattern`/`glob`/`path`でtool行が複数行化し得るため、各要素を最初の行の
  みに正規化する契約とtestを追加した。
- F3（Low、採用）: 要素別上限が`…`の3 bytesを考慮しておらず、`mode`に上限がなかった。要素budgetへ
  `…`を含め、`mode`にも8 bytes上限を置いた（worst case 94 bytes）。
- F4（Low、採用）: `run_typescript`のコメント抽出境界が未定義だったため、先頭2048 bytes・最初の非空行が
  `//`の場合のみ、という規則を固定し、通常利用メモの「コメントは実行結果やcodeとの一致を保証しない」
  注意書きを引き継いだ。
- 参考: 実config root側の`search` revisionと`run_typescript`の外部override有無、実表示とbyte数は
  reviewerの実行範囲外（workspace外・実行不可）であり、実装時の確認事項とする。

## 利用者による完了承認（2026-10-06）

利用者の「インクリメント205を完了とします」により本incrementを完了とした。この承認は、実装・
focused確認・独立review・隔離tmuxのproduction TUI確認・source commit `841c9b6c`・公式build・
常用配置・pushまでの結果を完了として受理するものである。これによりhandoffに残っていた「利用者の
通常利用での見た目・使い勝手の確認待ち」を閉じた。個別の観察内容の記録はない。

## 承認境界

- 本計画の表示契約（`henji run --stream`を対象外とすることの確認を含む）と、local実装・focused確認・
  type check/fmt/lint/`git diff --check`・隔離XDG tmuxのproduction TUI確認（local provider、実provider
  call 0回）は利用者の承認を待つ。
- commit・公式build・常用配置・push・公開/releaseは別承認とする。
- 実provider callを行う場合は、対象・回数・保存先を提示して都度承認を得る。

## 採用前S34の原記録

以下は通常利用メモS34の原記録の移設である。「未採用」「採用時に決める」等は当時の状態を表す。
現行の採用範囲・実装状態は本書上段を正本とする。

### S34 — `search`の検索条件・`run_typescript`の生成コードの抜粋表示（未採用、検討メモ）

- 利用者メモ（2026-10-05）: `tool> search`に検索パラメータの一部を表示したい。TypeScript
  toolもAgentが組み立てたscriptの
  一部を表示できるか検討したい。ただし先頭だけではimportしか見えない可能性がある。
- 現行経路・実現性（同日source照合）: Agentのtool
  call引数はDataがsemantic履歴へ保存し、Conversationのtool entityにも保持する。
  TUIは`keyed_conversation_store.ts`から共通の`toolActivityPreview()`へ引数を渡し、実行中と完了後の
  tool行を生成する。イベント表示の`state.ts`と直接表示の`terminal_text.ts`も同じ関数を使う。
  現在その関数に`search`と`run_typescript`の分岐がないため名前だけになる。
  引数は既に届いているので、抜粋表示は既存の表示経路で実現可能。新しい保存先やmodel
  callは不要と見込む。
- `search`の表示案:
  外部toolの現行引数は`mode`、`path`、`glob`、`pattern`、`patternKind`、`caseSensitive`、`offset`、
  `limit`。まず`mode`・検索語`pattern`・対象`path`を短く表示し、`paths`
  modeでは`glob`を手掛かりにする。 例: `tool> search content "toolActivityPreview" v0/ …`、
  `tool> search paths glob="*.ts" v0/ ✓`。どの補助条件まで含めるかと、長い検索語・pathの表示配分は未決。
- `run_typescript`の表示案と限界: 引数`code`はasync
  functionの本文で、std取得は`await import()`を使う。 Increment
  191の配置確認artifactには、空行に続き
  `const csv = await import('jsr:@std/csv@^1.0.6');`から始まる実例がある。
  単純な先頭一行では空欄またはimportだけになり、利用者の懸念に該当する。
  最初の案は、先頭の空行・コメント・import取得部分を飛ばし、その後の短い本文を表示すること。 例:
  `tool> run_typescript const text: string = await Deno.readTextFile(workspace + …`。
  ただし次も変数宣言やhelper定義なら処理目的までは分からない。
  file読込・書込・fetch・return等を選ぶ案も可能だが、任意scriptの主要処理を一意に決められるとは限らない。
  import部分の判定は複数行・分割代入にも関わるため、単純な行判定と構文解析のどちらを使うかは未決。
  import自体が処理目的のcallもあるので、抜粋候補がなくなる場合の表示も採用時に決める。
  modelによる要約や追加の説明引数は、この表示案の前提にしない。
- 実利用を見た再検討（2026-10-05、Session `2bc2699f`）:
  利用者は2〜3行の表示も許容すると述べ、このSessionを参照対象に指定した。 read-only history
  detailで4回の`run_typescript` callを確認した。いずれもfile編集で、先頭に長い
  置換dataを置く30行のscript、追加testをtemplate literalに置く51行のscript、一行に全処理を詰めた
  script、各行が長い3行の文書編集scriptだった。importを飛ばして先頭数行を出すだけでは、書込処理や
  編集対象を把握しにくい。
  現時点の推奨案は、tool名・状態の一行と、コードの入口・操作箇所の二つの抜粋を合わせた計3行。
  入口は空行・コメント・importを除いた最初の短い文、操作箇所はfile書込・通信等の呼出しを候補にし、
  それがない場合は読込・return等を比較する。抜粋の順序は元codeの順に保ち、省略は`…`等で示す。
  最初のcallなら入口の`const patches: Record<string, [string,string][]> = {`と、後半の
  `await Deno.writeTextFile(workspace+'/'+path,text); changed.push(path);`が手掛かりになる。
  一行に複数の文があるので物理行だけでなく文・呼出し単位の抜粋を検討する。 template
  literal内の追加testにも呼出しに見える文字列があるため、文字列中のcodeを実行本文の操作と
  誤認しない抽出方法が必要。これはコードの抜粋であり、実際に通った分岐や主要処理の保証ではない。
  選択規則・構文解析方式・端末幅に応じた省略は未決で、表示案の採用・実装は未承認。
- 利用者提案を受けた表示候補（2026-10-05）:
  `run_typescript`のtool案内で、生成する`code`の先頭に処理目的を示す一行コメントを入れるよう案内する。
  例: `// TUI関連7ファイルの配色とtool名の表示を変更する`。
  表示側はそのコメント本文を短く出し、`tool> run_typescript TUI関連7ファイルの配色とtool名の表示を変更する ✓`
  とする。端末幅による折返しで2〜3行になる表示も候補とする。
  利用者の「うんいいね」により、先頭の一行コメントを表示する方針に合意した。
  長いdata定義・import・一行に詰めたscriptに左右されず、
  コードから主要処理を選ぶための構文解析を追加する必要がない。
  コメントはAgentが記す処理意図であり、実行結果やcodeとの一致を保証するものではない。
  コメントがないcallも実行できるままとし、不在時の表示は採用時に決める。
  個別incrementへの採用・実装はまだ行っていない。
- 未確認・採用時の確認: 抜粋方法と長さは未採用。現在の共通previewは96 UTF-8
  bytesまでで、コード表示に適するかは実表示で判断する。
  credential値・Authorizationの露出防止という既存要件を守る。実装を採用した場合は実行中・完了後・
  保存Session再表示の同じ抜粋と、隔離XDGのproduction TUIで読みやすさを確認する。
- 関連: `v0/agent/tools/tool_activity.ts`、`v0/tui/keyed_conversation_store.ts`、`v0/tui/state.ts`、
  `v0/tui/terminal_text.ts`、`external-tools/search/index.ts`、`v0/agent/tools/run_typescript.ts`、
  [Increment 191](../increments/increment-191.md)。
