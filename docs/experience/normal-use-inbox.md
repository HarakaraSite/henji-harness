# 通常利用メモ

Henjiの通常利用で得た観測と、まだ個別Incrementへ採用していない改善候補の入口である。

更新日: 2026-10-05（source `a78c2076`・Increment 182までと照合。S26はIncrement 183、A18はIncrement
185へ採用・移設。B11はIncrement 190へ採用・移設。A23はIncrement 191の計画へ採用・移設）。
2026-10-06にA30・A31を追加し、A32・A33はIncrement 200・201へ採用・移設（A32: review用Agentの
tool構成とinstruction、A33: read-onlyのgit調査toolとsearchのentry列挙）。
A30へは保存Session `0cd5c22e`・`2bc2699f`の分析結果も追記した。

- ここへの記載は採用、優先順位、実装認可を意味しない。
- 個別Incrementへ採用した項目はその正本へ移し、この一覧から除く。
- 長い実行証拠、参照実装比較、完了経緯は、increment、research、architecture等の担当正本へ置き、
  ここには候補を選ぶための現在の観測、候補、再検討条件だけを残す。
- 一覧IDは文書内の参照用であり、順序や大小は優先度を表さない。

現在の目的・境界・実装状態は[構想](../concepts/experience-driven-self-revision.md)、
[Host/Worker architecture](../architecture/henji-host-agent-worker.md)、
[provider/auth architecture](../architecture/multi-provider-routing-and-auth.md)、[roadmap](../roadmap.md)を参照する。
採用した要件・原観測・受入結果は[個別increment](../increments/)へ置く。

現行はJSON Agent設定・現在tool folder・configuration snapshotとhistory.sqlite3（schema 1）を使う。
以下の過去観測は観測日当時の事実として残し、「現行境界」は現在sourceへ照合する。 廃止済みのmanaged
Definition/transportを候補の必須前提として復活させず、候補自体の採否は利用者へ戻す。
未解決のB8原失敗原因と再発時調査は[176](../increments/increment-176.md)の担当範囲であり、診断拡充だけで原因特定済みとはしない。

## 候補一覧

| ID  | 領域           | 候補                                                                 | 再検討の主な契機                                                                                                       |
| --- | -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S4  | Surface        | `/reload`によるinstruction・Agent設定・toolの再読込                  | 改訂したinstruction・Agent設定・toolを現Sessionの後続executionへ適用したいとき                                         |
| S20 | Surface        | 巨大表示領域でのwindow行量確保とframe上限                            | 大きなディスプレイで履歴の空白・古い行欠落が観測されたとき                                                             |
| S22 | Surface        | 将来のWebUI本体                                                      | browserから通常利用する画面が必要になるとき                                                                            |
| S28 | Surface        | `@`によるコンテキスト注入（旧P5を統合）                              | 人間がファイル内容等をmodel turnなしでcontextへ入れたいとき。採用は利用者判断                                          |
| S29 | Surface        | `/edit`による外部エディタ起動                                        | 利用者が入力編集の外部エディタ連携を採用するとき                                                                       |
| S30 | Surface        | TUIの`/help`とCLI helpの内容統合                                     | 利用者がヘルプ内容の統合を採用するとき                                                                                 |
| S32 | Surface        | 入力履歴機能の削除                                                   | 利用者が入力履歴の削除を個別incrementへ採用するとき                                                                    |
| S34 | Surface        | `search`の検索条件・`run_typescript`の生成コードの抜粋表示           | tool行から検索対象や実行内容を把握したいとき。抜粋方法を選び、個別incrementへ採用するとき                              |
| A2  | Agent実行      | Host操作のmodel向けtool化                                            | AIがSession列挙やreloadを実際に必要とする                                                                              |
| A3  | Agent実行      | Context Strategyの外部化                                             | 長期Sessionのtoken usageとcontext品質を実測で比較できる                                                                |
| A5  | Agent実行      | ambient情報のinstruction化（repository context・実行環境）           | ambient remoteの誤認・repository探索の再発、またはAIが実行環境のambient情報を知らない／instructionだけでは足りない事例 |
| A6  | Agent実行      | Web searchの取得品質・backend比較                                    | 対象発見と本文取得の混在が調査品質・コストを損なう                                                                     |
| A9  | Agent実行      | Sessionと関連履歴の保存・削除（旧P7を統合）                          | 古いSessionの整理や、Sessionと関連履歴の保存期間を決める必要が出るとき                                                 |
| A11 | Agent実行      | instructionの与え方                                                  | 指示の粒度や配置によってtaskの完了挙動が変わるとき                                                                     |
| A19 | Agent実行      | requestごとの実行状況・日時・地域context                             | モデルが残りstep・経過時間を知らず長いturnを継続した観測、日時・地域を判断材料にしたいとき                             |
| A21 | Agent実行      | 1ターン内でsteeringを複数回受け付ける                                | 実行中に追加の指示を続けて送りたいとき                                                                                 |
| A24 | Agent実行      | subagent起動の判断とprovider・model・effort・toolの選択              | 利用者が起動判断の検討を再開するとき                                                                                   |
| A27 | Agent実行      | providerの一時的な応答中断に対する自動再試行                         | recallでの手動継続が負担になる、または利用者が自動再試行の検討を再開するとき                                           |
| A28 | Agent実行      | 通常利用時のメモリ使用量の調査・チューニング                         | 利用者がメモリ内訳の調査・削減を個別incrementへ採用するとき                                                            |
| A29 | Agent実行      | request単位のtoken usage・cache再利用量の保存とreadback              | token消費の内訳やcontext整理・cache改善の効果を把握したいとき                                                          |
| A30 | Agent実行      | tool間の結果連鎖（tool resultを別toolの入力にできない）。利用者は安易なパイプ連結を希望しない | パイプ回避の案内後も、保持済み出力を後段toolで使う必要が通常利用で残るとき                                  |
| A31 | Agent実行      | workspace外（config/state/tmp）の読取・書込境界                      | workspace外の確認・一時file作成を通常利用で繰り返すとき。credential露出防止とセットで決める必要が出たとき               |
| A34 | Agent実行      | 再起動後の続行セッションで新規toolがmodel定義に現れない疑い          | 新規セッションで再確認し、同じ現象なら定義更新の経路を調査するとき                                                       |
| B5  | 保存履歴       | commit却下時の検証不合格項目を特定できない                           | 却下の再観測、または項目別理由の記録・原因調査を個別incrementへ採用するとき                                            |
| B12 | Agent実行      | process runner早期終了でbashが全件失敗し、原因も復旧も残らない       | 同エラーが通常利用で再観測されたとき、またはrunner診断・復旧を個別incrementへ採用するとき                              |
| R1  | F24            | 自己改訂対象の重心とagent loop境界                                   | Self-revision Cycleの最初の実証対象を選ぶ                                                                              |
| R2  | F24            | tool改訂の版・使用内容の記録とMCP                                    | tool candidateを生成・保存・採用するflowを設計する                                                                     |
| R3  | F24            | tool実行profileとsandboxed Deno program                              | trusted-local以外の実行環境をproduct要件にする                                                                         |
| R4  | F24            | instruction componentのrevision化                                    | instructionを自己改訂candidateとして採用する                                                                           |
| E1  | 配布・外部化   | Agent設定・tool以外のresource外部化                                  | 通常利用で更新・共有・rollback・分離実行が必要になる                                                                   |
| E2  | 配布・外部化   | 追加managed resource kind候補（未採用）                              | 各kindを通常利用で更新・pin・transport・activationする必要が出る                                                       |
| E3  | 配布・外部化   | Host runtime tunablesの設定ファイル化                                | provider timeout・tool限界・maxSteps既定などを通常利用で調整したくなるとき                                             |
| E5  | 配布・外部化   | 追加protocol adapter候補（Anthropic Messages／Google／Azure OpenAI） | 該当providerを通常利用で使う必要が出るとき。Increment 101のauth/header一般化を前提にする                               |
| P3  | 参照実装parity | 手動`/compact`（checkpoint/compactionの人間起動）                    | context圧縮を人間が明示的に行いたくなったとき                                                                          |
| P4  | 参照実装parity | Session export/import                                                | Sessionを別installationへ移す・再開する必要が出るとき                                                                  |
| P6  | 参照実装parity | model cycling shortcut                                               | provider横断のmodel切替を頻繁に行うとき                                                                                |
| P8  | 参照実装parity | configurable keybindings                                             | keybindingを利用者ごとに変えたくなったとき                                                                             |
| P9  | 参照実装parity | 画像入力（`@image`／clipboard paste）                                | 画像を扱うtaskを通常利用で行うとき。transcriptのimage part・provider別encoding・表示・catalog capabilitiesが必要       |
| P10 | 参照実装parity | 外部agent interface（双方向server/RPC／ACP）                         | editor/IDE統合や別agentからの対話的駆動が必要になるとき。一段目の一方向structured outputはIncrement 104で実装済み      |

## Surface

### S4 — `/reload`によるinstruction・Agent設定・toolの再読込（F01、F03、F08、F10、F11、F27）

- 現行の観測（2026-10-04、source照合）: workspace instructionとskill本文はWorker起動時に
  snapshot化され、toolも起動時に読み込まれる。稼働中Workerへの明示的な再読込操作はない。
- 利用者方針（2026-10-03、個別incrementへの採用・実装は未実施）:
  操作名を`/rebuild`から`/reload`へ変更する。
  Agent設定・tool管理の簡素化、revisionの扱い、新DBへの整理は
  [Increment 181](../increments/increment-181.md)の現在file読込み・snapshot方式を前提にし、S4の再読込操作とは区別する。
- 候補:
  起動時の読込・検証・構成と共通の経路を人間の`/reload`から使い、instruction・Agent設定・toolの
  現在内容を同じSessionの後続executionへ適用する。canonical
  conversation、未送信draft、過去executionと そのattributionを維持する。
- 未決事項:
  最初の再読込対象、実行間の適用手順、読込失敗時の扱い、現在のWorkerとの接続を個別incrementで
  定める。2026-09-13の`AGENTS.md`と個々のnative Skillの有効・無効選択の希望についても、保存scope、
  既定状態、操作との関係は未確定である。
- 再検討条件: `/reload`を個別incrementへ採用するとき、または通常利用で同じSessionへ
  編集内容を反映する必要が出ること。
- 関連: A2、R4、E1、[Increment 181](../increments/increment-181.md)、
  [`terminal-markdown-rendering-comparison.md`](../research/terminal-markdown-rendering-comparison.md)、
  [`durable-history-and-context-rebuild.md`](../roadmap-inputs/durable-history-and-context-rebuild.md)、
  [`externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)。

### S20 — 巨大表示領域でのwindow行量確保とframe上限（F01）

- 観測（2026-09-26、参照実装調査の実測）: 大きな表示領域で現行TUIが画面を埋められない。
  `HISTORY_WINDOW_ENTRIES` 48／`HISTORY_WINDOW_BYTES` 1 MiBのwindowはentry数・文字量で決まり、
  画面が要求する行数は保証しない。実測で512×200のとき、window30 entry・63 KBで生成行120行に対し
  必要196行（不足分は空行padding）。entryが短い対話ほど起こりやすい。加えて`MAX_ROWS` 200／
  `MAX_COLUMNS` 512でclampされた外側は空白になり、512×200＋CJK本文ではframeが `MAX_FRAME_BYTES` 128
  KiB（実測147 KB、SGR未計上）を超過して`renderFrame`が古いlog行からtruncateする。
- 候補: 描画windowを行量ベース（必要なlogHeightぶんを遡って確保、entry数上限は維持）に変え、
  巨大表示領域でのclampとframe上限を実測に基づき見直す。
- 再検討条件: 大きなディスプレイ利用が日常になり、履歴の空白・行欠落が観測されたとき。
- 関連: `v0/tui/state.ts`（`HISTORY_WINDOW_*`）、`v0/tui/layout.ts`（`MAX_ROWS`／`MAX_COLUMNS`／
  `MAX_LAYOUT_SOURCE_BYTES`）、`v0/tui/tui_renderer.ts`（`MAX_FRAME_BYTES`）、比較文書。

### S22 — 将来のWebUI本体（F01、F10、未採用）

- 候補: 独立HTTPコアと共通のschema・client・操作契約を利用するWebUI本体。
  terminalに固有のeditor・key操作はbrowserのUIへ置き換える。
- 再検討条件: TUI分離後、browserから通常利用する画面を採用するとき。
- 関連: 採用済みの独立HTTPコア・TUI分離・第三者APIは
  [Increment 139](../increments/increment-139.md)と
  [8slice計画](../plans/s22-detailed-design-and-slices.md)を参照する。
  現行は[複数Core](../increments/increment-153.md)で別Sessionを並行実行できる。
  WebUI本体とACPは未実装であり、HTTP/API Workerの存在だけで成立済みとしない。

### S28 — `@`によるコンテキスト注入（未採用、メモのみ）

- 参照実装調査（2026-09-22、旧P5）: `@file`によるファイル内容の注入を候補として記録した。
- 利用者意向（2026-09-29）: 将来`@`によるコンテキスト注入を行うかもしれないが、
  行わない可能性もある。今回はメモのみ。
- 候補: TUI入力で`@`を起点とするコンテキスト注入。具体的な用途として、人間が`@file`で
  ファイル内容をmodel turnなしでcontextへ渡すことを含む。注入対象、操作、contextへの渡し方は未決。
  workspaceパス補完の廃止判断をこの候補で取り消さず、既存処理を将来用に残す要件とも扱わない。
- 再検討条件: 人間がファイル内容等をmodel turnなしでcontextへ入れたい実例があり、
  利用者が必要性を判断してこの候補を個別Incrementへ採用するとき。
- 関連: [Increment 159](../increments/increment-159.md)、
  [Pi／Zot参照実装比較](../research/pi-zot-command-surface-comparison.md)、
  P9（画像入力は別候補）。今回のフッター・ショートカット整理では実装しない。

### S29 — `/edit`による外部エディタ起動（未採用、将来候補）

- 利用者意向（2026-09-29）: 単語・行頭／行末までの削除キーを省く方向に関連して、
  `/edit`でエディタを起動する機能をいつか実装したい。
- 候補: 入力編集に外部エディタを使う。エディタの指定方法、draftの受け渡し、
  編集後のTUI復帰操作等は採用時に決める。今回は記録のみ。
- 再検討条件: 利用者が入力編集の外部エディタ連携を個別Incrementへ採用するとき。
- 関連:
  [Increment 159](../increments/increment-159.md)。今回のフッター・ショートカット整理では実装しない。

### S30 — TUIの`/help`とCLI helpの内容統合（未採用、メモのみ）

- 利用者意向（2026-09-29）: F1 helpの内容をCLIのヘルプと統合するか、別件としてメモする。
- 現行境界: [Increment 159](../increments/increment-159.md)でF1はSession一覧へ変更し、 TUI
  helpは`/help`へ集約した。CLI helpとの内容統合は未採用である。
- 候補: TUI helpとCLI helpの内容を整理・統合する。対象となる内容と統合方法は未決。
- 再検討条件: 利用者がヘルプ内容の統合を個別Incrementへ採用するとき。
- 関連: [Increment 159](../increments/increment-159.md)、TUIの`/help`、CLI help。

### 画面表示の参照実装調査で見送ったもの（Pi／OpenCode、2026-09-26）

Pi／OpenCode／Henjiの画面表示比較
（[`pi-opencode-henji-screen-display-comparison.md`](../research/pi-opencode-henji-screen-display-comparison.md)）
から、現時点では取り入れないもの。記録のみで採用・実装を意味しない。

- Piのmain screen履歴（会話をterminal scrollbackへ残す方式）: Henjiはalt screen＋内部window方針で、
  Increment 128／130の履歴閲覧・履歴位置表示と整合しない。描画コストも本質的には変わらない
  （Piもdocument全体を毎frame計算）。 再検討条件:
  履歴閲覧の要求が現行window方式で満たせなくなったとき。
- message jump（Pi／OpenCodeのmessage単位移動）: 利用者判断でP2として除外済み（PageUpの方が手軽）。
  調査記録に残す。
- テーマ／256 color／truecolor:
  調査当時は色に関する観測された不満がなく、Surface変更が大きいため見送った。
  配色変更前のsourceは一部に256色指定を使っており、この記録は256色未対応を意味しない。
  2026-10-05の配色変更は[Increment 193](../increments/increment-193.md)へ採用した。
  テーマ切替・truecolor対応の採用は未決。
- Piの`CURSOR_MARKER`（hardware cursor指定によるIME候補位置合わせ）:
  Henjiはframe末尾のcursor位置指定で 入力位置を示しており、目的は現状で満たしている。 再検討条件:
  IME候補位置がずれる観測が得られたとき。
- xterm.js仮想terminal（`@xterm/headless`）のtest基盤:
  単独では採らない。Surface変更を採用するincrementで、
  frameの実挙動検証が要件に直結するときに限って検討する。 再検討条件:
  terminalの実表示・操作確認を補う具体的な必要が出たとき。

### S32 — 入力履歴機能の削除（未採用、メモのみ）

- 観測・利用者意向（2026-10-03）: 実行中の↑/↓で入力履歴を呼べないことを確認したが、利用者は
  あまり不便を感じておらず、入力履歴自体の使用頻度も少ないと述べ、削除候補の記録を指示した。
- 候補: editorの送信済みpromptを↑/↓で再呼出しする入力履歴機能を削除する。
  関連する記録・navigation処理、help記載、専用testの整理範囲は採用時に決める。
- 再検討条件: 利用者が入力履歴の削除を個別incrementへ採用するとき。
- 現行経路: `v0/tui/input_history.ts`、`v0/tui/remote_session.ts`、`v0/tui/slash_command.ts`。

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

## Agent実行

### A2 — Host操作のmodel向けtool化（F02、F06、F10、F27）

- 観測: `/reload`や`/sessions`の意味操作は、人間だけでなくAIが作業中に使う価値もある。
- 候補: slash command文字列をmodelに擬似入力させず、Host-owned application serviceへ型付きcommand
  handlerとtool handlerを接続する。read-onlyな一覧/詳細取得と、Session切替・reloadのように
  呼出元のcontextを置き換える操作を分ける。後者はtool result前に呼出元を破棄せず、次turn予約、Host
  control event、turn完了後の切替等の順序を定める。
- 利用者メモ（2026-09-25）:
  Agent自身が`/model`相当のHost操作をtoolで要求する案。model変更は現在のturn中には
  適用せず、次のturnから有効にする。現行の`selectModel`は実行中に`busy`を返すため、単にslash
  commandを toolで呼ぶだけでは成立しない。実際に必要な利用場面はまだ不明で、採用・実装は決めない。
- 再検討条件: AIがSession列挙・詳細取得・選択、またはreloadを実taskで必要とすること。
  またはAgentが後続turnのmodelを自分で変える必要が実taskで現れること。UIだけに意味があるcommandや
  人間の明示選択が目的のcommandまで一律にtool化しない。
- 関連: S4。

### A3 — Context Strategyの外部化（F02、F06、将来のF24候補）

- 観測: 64 KiBでのtool-result機械的省略とpre-turn automatic semantic compactionの停止はIncrement
  29で 採用済みである。将来のcompactionは容量対策だけでなく、何を覚え、捨て、抽象化するかを決める
  Context Strategyとして扱う必要がある。
- 候補: 発動判断、対象選択、保持予算、semantic summary、model、failure方針、結果説明を交換可能な
  component境界にする。Agent設定から選ぶ場合も、canonical transcript、checkpointの永続化と相関、
  tool call/resultの因果構造、credential、provider
  evidence、strategy結果の採否はHenji-owned境界に残す。
- 利用者との検討（2026-10-05、アイデアのみ）:
  Agentが過去のtool結果を探す`history_search`・`history_read`はcompaction設計と合わせて考える。
  provider error後に、後続実行のAgentが保存済みrequest fact・失敗診断を調べる用途も含む。
  `/recall`による失敗作業の引継ぎは人間が判断し、履歴を読む操作と分ける。
  compaction時には、後から元のtool引数・結果へ戻れるIDをcontextに残す方針を検討する。
  保存記録の`occurrenceId`やexecutionとcallの組を候補とし、検索ではtool名・対象path・本文の語句も使う。
  IDだけで参照対象が分かるか、tool名・対象・短い要点を添えるかは未決。
  利用者は、turn完了後はtool結果本文を順次model contextから外してよいのではないかと提案した。
  元の保存履歴を保持し、必要な結果は履歴toolで再取得する構成を候補とする。対象・タイミング・
  保持内容・再取得経路を一体で設計する。現在の通常処理が自動省略しているという意味ではない。
  履歴tool・compaction方針とも、個別incrementへの採用・実装は未承認。
- 再検討条件: 長期Sessionの実token usage、provider/model
  context契約、turn中/間checkpointを比較できる 利用証拠が得られること。
- 正本:
  [`increment-29.md`](../increments/increment-29.md)は既に停止した挙動と維持するcheckpoint境界を定める。

### A5 — ambient情報のinstruction化（repository context・実行環境）（F02、F06）

- 観測: Increment 37 Human Gateで、local target未指定の外部調査taskに対し、modelがworkspaceのGit
  remoteと handoffを探索し、ambient repositoryから得たForgejo hostをtask
  targetとして扱った。repository情報を 知らないための探索と、repository
  contextを過剰にユーザー指定targetへ結び付ける問題を分ける必要がある。
- 観測（実行環境、2026-09-26、実行証拠と利用者観測）: bash toolは`clearEnv: true`で`PATH`／`LANG`／
  `LC_ALL`のみを設定し、親processの環境を引き継がない（`v0/agent/tools/bash_tool.ts`）。この設計のままでは、
  (1)
  `git push`が`HOME`未提供で認証情報（`credential.helper=store`＋`~/.git-credentials`）に到達できず
  hangした、(2) `git`は`fatal: $HOME not set`でglobal config（user
  identity・credential）を解決できず failする（実測）、(3) buildもよく失敗する（利用者観測）。
- 利用者判断（2026-09-26）: 機構としてambient情報を組み込む（env継承・自動付与・env manifest）のでは
  なく、**instructionとしてambient情報を持つ**方向とする。重要なのはAIがambient情報の**存在を
  知る**こと。環境情報を**機械的に集める**案は範囲が広く難しい（実行環境がdeno／node／bunで違い、
  VCSがgit／jujutsuで違う等）ため採らない。旧候補の「Hostが…配送する」も、Hostが環境情報を集めて
  dataとして渡す意味ではなく、**instructionの配送手段**の話である可能性がある（利用者指摘、
  2026-09-26）。
- 候補（利用者示唆、2026-09-26）: **人間の指示によりリポジトリの環境情報を集め、`ambient.md`等に
  まとめて、それをinstructionとして読み込む**。文書には(1) どんなambient情報が存在するか
  （repository root・VCS種別・非secretなcanonical identity、`HOME`配下のcredential store、git
  identity、 buildに必要なenv等）、(2) その所在、(3) 扱い方（repository contextはtask
  targetではなく、利用者が
  「このrepository」等と結び付けた場合だけsource。実行環境は必要時に明示する）、を記載する。
  credentialやremote URL内の認証情報は含めない。機械的収集・自動更新は行わない。
  `ambient.md`等の文書は**git管理外に置く**（`.gitignore`等）。commit・push・履歴に残さない
  （利用者指示、2026-09-26）。環境情報はworkspace／machine固有のため。
  AGENTS.md「実行環境」はこの方向の先行例。
- 再検討条件: ①外部product名だけのtaskでambient remoteをtargetにする誤認、またはrepository
  identityを
  得るための不要なtool探索が再発する、②AIが実行環境のambient情報の存在を知らない、またはinstruction
  だけでは足りない事例が観測される、のいずれか。採用時にR3（tool実行profile）・E3（Host runtime
  tunables）との分担を決める。
- 再観察（2026-09-22、`henji run --json`、`opencode-go-chat`/`deepseek-v4.1-flash`、workspace=henji
  repo、 task「Giteaの直近10件のPRを教えて」、1 turn）: tool sequenceは`web_fetch`（GitHub
  API）→`web_search`で、 ambient workspace探索（`bash git remote -v`、handoff読み）は0回、ambient
  Forgejo remoteをtargetにする 誤認もなし。credential探索もなし。**この条件では再現せず**。留意: 1
  model/provider・知名度の高いproductで の観測。Increment
  37のmodel/provider（openrouter経由）や知名度の低いproductでは未確認。
- 状態（2026-09-22）: 利用者判断で継続して要観察。trigger未発火のため実装しない。
- 統合記録: 旧A16「bash
  tool実行のambient情報をinstructionで持つ」（2026-09-26記録）はこの項目へ統合。
- 正本: [`increment-37.md`](../increments/increment-37.md)が観測した実行証拠と完了判断を保持する。
- 関連: A11（instructionの与え方）、R3、E3、`v0/agent/tools/bash_tool.ts`、AGENTS.md「実行環境」。

### A6 — Web searchの取得品質・backend比較（F02、F06、将来のF24候補、残候補）

- 現行境界: [Increment 172](../increments/increment-172.md)で`web_search`をExa API直結へ置き換えた。
  検索結果を親modelが回答へ使い、既知URLは`web_fetch`で取得する。Sonar backendは除去済みで、
  search/fetch分離と`web_fetch`のdownloadは172の採用範囲である。
  credential登録は[Increment 173](../increments/increment-173.md)の共通`/login`経路を使う。
- 候補: 取得内容とcitation/provider evidenceの相関、追加stepと経路の明示性を実taskで比較する。
  filesystem探索、複数endpoint試行、shell quoting、temporary file、別commandでの再読込が
  連なる発見・取得経路の品質・コストを観測する。
- backend候補: OpenAI Responses API built-in Web searchとOpenRouter `openrouter:web_search`を一つの
  `WebSearchBackend`境界へ追加できるか、現行Exa
  backendと比較する。modelに実装名の異なるtoolを無条件に並べない。
  同時公開するなら品質、費用、検索範囲等で選択理由を説明できる別contractにする。
- 再検討条件: searchとfetchの混在、または現backendの品質/費用/取得範囲が具体的に問題になること。 Web
  search自体を別Agent実行にするかは、conversation、prompt、model、tool利用を独立所有する必要が
  出たときだけ比較する。
- 残候補は実taskでの取得品質・費用・取得範囲の比較と、必要になった場合の別backend採用である。
- 保存履歴での実測（2026-10-05 Session `2bc2699f`、2026-10-06にread-only分析）: `web_search` 5件の
  result bytesは1,349・2,152・18,218・19,758・**148,977**。最大のものは
  `contents: {text: true}` + `numResults: 2`でghostty.orgのoption reference本文144,402 bytesを
  1回のresultへ展開していた（指定どおりの取得でtoolの不具合ではない）。同じexecution内の以降の2回は
  `contents: {highlights: {maxCharacters: 5000, query: …}}`へ切り替えて1,349・2,152 bytesに収まっており、
  schemaは`contents.text.maxCharacters`も持つ。採用するなら既定や案内の形（highlights既定、上限指定の
  推奨、大きなdocs本文は`save_to`＋`run_typescript`で必要部分だけ抜く）を決める。
- 同5件のExa費用（responseの`costDollars`）: いずれも`total 0.007`（USD、neural
  search）で、`text:true`の149 KBの1件も小さい4件と同額だった。この5件では`contents`指定による
  Exa課金差は見えない。149 KBの代償はExa費用ではなくmodel context（約3.5–4万token）側にある。

### A9 — Sessionと関連履歴の保存・削除（旧P7を統合、未採用）

- 現行境界: Increment 121で常設raw診断記録を廃止し、短いrequest
  factをsemantic履歴の一部として保存する。
  `henji sessions delete --session ID --yes`による個別削除は実装済みで、Sessionに紐づくexecution、
  semantic履歴・request fact、recall参照関係も同じtransactionで削除する。
- 利用者判断（2026-09-27）: 診断記録の保存期間と旧P7 `sessions prune`を一つの検討事項へ統合する。
  Sessionと関連履歴を一体の保存・削除単位として扱う。診断factだけを消すと履歴の詳細表示や`/recall`の
  失敗原因の手掛かりが欠け、Sessionだけを消して関連履歴を残すと、一覧からの削除と実際の保存状態が
  食い違うため、両者を別々の保存期間で整理する方針は採らない。
- 候補: 残すSessionと削除対象の選び方、一括整理（`sessions prune`）、保存期間を
  まとめて検討する。期限による自動削除を提供するかは別途判断し、現時点で期間や自動削除は決めない。
- 手動個別削除のTUI操作は[Increment 161](../increments/increment-161.md)へ採用した。
  本項目の残候補は保存方針と一括整理である。
- 旧P7の利用者判断（2026-09-22）: 一括整理は将来採用見込み。採用時に削除対象の確認（`--dry-run`）と
  明示confirmを設計する。今回の統合は候補の整理であり、採用・実装や既存dataの削除を意味しない。
- 再検討条件:
  古いSessionの整理や、Sessionと関連履歴をいつまで残すかを決める必要が通常利用で出たとき。
- 関連: [`increment-121.md`](../increments/increment-121.md)、
  [`pi-zot-command-surface-comparison.md`](../research/pi-zot-command-surface-comparison.md)（旧P7の調査）、
  `v0/agent/cli/session_cli.ts`、`v0/agent/history/sqlite_history_store.ts`の`delete`。

### A11 — instructionの与え方

- 観測（2026-09-23）: DeepSeekは短いREADME比較依頼ではツール使用を続けたが、対象ファイル、比較項目、
  追加調査の条件、報告する時点を明示した指示では、2回のprovider request（2件の`read`）で回答した。
- 利用者希望:
  instructionの内容・粒度・与える場所（共通instruction、モデル別instruction、個々のtask）を
  検討する。短い依頼から目的に合う作業範囲と終了条件を組み立てられるかを実利用で比較する。
- 再検討条件: 指示の与え方を変えると、同じ目的のtaskの完了挙動が変わること。

### A19 — requestごとの実行状況・日時・地域context

- 観測（2026-09-27）: [A18の元観測](../increments/increment-185.md)のsession
  `51b47299`では、maxSteps・現在step・turn経過時間を
  modelへ自動通知していなかった。現行`Runtime facts`は作業directoryだけで、内部の`modelStep`は
  診断・履歴用である。利用者は、turnを返す判断材料に加え、現在日時と地域の情報も有用と考えた。
- 候補: Worker内のAgent loopが既存のmaxSteps・stepとturn開始時刻から実行状況を生成し、
  request直前に最新の短いruntime contextを投影する。stepはtool呼出し数と区別し、残り回数が
  今回のrequestを含むかを明示する。共有request budgetによる残り回数とmodel stepの関係は採用時に
  定める。経過時間の基準は「今回のturn開始から」とし、現在日時にはrequest準備時点の日時・ UTC
  offset・timezoneを含める。通知文面と、それを使った報告方針のinstructionは分ける。
- 渡し方の案: request用コピーの末尾へ、runtime由来と明示したuser-role messageを一つ追加し、
  毎requestで最新値に置き換える。canonical会話へ通知を積み重ねず、当時渡した内容と出所は既存の
  context attributionで追跡できる形を検討する。通知だけでfinal回答が保証されるとは扱わない。
  最終requestの回答強制、通知頻度、報告を促す時点は未決であり、今回の案から自動停止を導入しない。
- 日時・地域の案: 現在日時とsystem timezoneを自動取得する。localeは言語・書式の設定として
  所在地と区別する。このVMでの取得値は`Asia/Tokyo`／`en-US`／locale region `US`で、利用者は
  localeを設定していないと述べた。利用者の居住地は大阪であり、timezoneだけでは大阪まで表せない。
  任意の地域設定として`Osaka, Japan`や「大阪市、大阪府、日本」を指定し、情報の出所を示す案とする。
  system timezone、locale、利用者指定の地域を一つの所在地へ混同しない。
- 参照実装: DeepSeek Harnessの`time-context`（snapshot
  `c291e7961a515f6d7af9304e7fd1d257929aef26`）は`agent/pre-step`でturn・step・時刻・
  前回の観測からの経過時間をuser-role messageへ追加し、履歴にも保存する。Henji案のturn開始からの
  経過時間・requestごとの最新値投影とは異なる。
  [実装](../../_refs/deepseek-harness/packages/context/time-context/src/index.ts)。
  OpenCodeの2026-09-27に取得した`dev` branchのV1経路は、最終stepで報告を促すassistant-role
  messageをrequest末尾へ追加する。
  [追加処理](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts)、
  [通知文面](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/max-steps.ts)。
  mechanismを比較する資料であり、そのまま採用するcontractではない。
- 利用者指示（2026-09-27）: 今回はアイデアのメモのみ。runtime通知・地域設定の実装は未指示。
- 再検討条件: 個別Incrementへ採用するとき。実際に通知が報告・作業継続の判断に使われるかを
  通常利用で確認する。
- 関連:
  [A18（Increment 185）](../increments/increment-185.md)、A11、S4、E3、`v0/agent/core/loop.ts`、
  `v0/agent/worker/worker_runtime.ts`のrequest projection・context attribution。

### A21 — 1ターン内でsteeringを複数回受け付ける

- 利用者希望（2026-09-27）: 実行中の同じturnへsteeringを複数回送れるようにしたい。
  今回は未採用候補としてメモし、実装は行わない。
- 現行境界（2026-10-03）: busy中の追加指示はF3で送り、受付は1 executionにつき1回。
  `SteeringOwner.admit()`の受付済み状態は指示を消費した後も解除されない。
  [Increment 175](../increments/increment-175.md)でWorkerの受付確認と、tool後に加えてmodelがfinalを
  返した際の取込み・同じexecutionの次requestへの継続を成立させた。複数回の受付は175の対象外であり、
  本候補として残る。これはHenjiの実装上の制約であり、provider APIの制約ではない。
- 利用者方針（2026-10-04、実装は未採用）: 前の指示が適用されたら、同じexecutionで次の指示を
  受け付ける。未適用の指示がある間は次を受け付けない。実装はまだ行わない。
- 候補: 上記の受付方針で、同じturnの実行中にsteeringを複数回受け付け、既存のtool実行後・ 次のmodel
  request前の経路（final後の継続を含む）でモデルへ渡す。
- 対象範囲: 実行中turnへの追加指示。別枠のchatや子Agentへの直接steeringは、この候補には含めない。
- 関連: [Increment 175](../increments/increment-175.md)、`v0/agent/core/steering.ts`、
  `v0/agent/core/loop.ts`、`v0/tui/remote_session.ts`。

### A24 — subagent起動の判断とprovider・model・effort・toolの選択（未採用）

- 観測（2026-09-28、workspace `/home/agent`、session `6e5dbddd`の保存履歴照合）:
  README日英比較で`generic`を3件起動した（run `8739f50c`、`7796828a`、`6a6acd8b`）。
  起動引数は`agent`と`task`だけで、3件とも親の
  `openrouter-responses / xiaomi/mimo-v2.6-flash / auto`を引き継いだ。`tools`未指定により
  `read`、`write`、`edit`、`bash`、`bash_output`、`web_fetch`、`web_search`、`submit_json_result`が
  有効だった。「ファイルを変更しない」はtask内の指示で、toolを制限する指定ではなかった。
- 利用者判断（2026-09-28）: この辺りのsubagent起動の判断をどうするかは今後検討する。今回はメモだけ。
- 検討候補: どのtaskを親自身で扱い、どのtaskを子へ任せるか、任せる際のAgent選択と
  provider・model・effort・toolの選び方を検討する。親設定の継承と明示指定を使い分ける基準も未決である。
- 再検討条件: 利用者が起動判断の検討を再開するとき。現時点で起動方針の変更や実装は採用しない。
- 関連: [Increment 131](../increments/increment-131.md)（起動時のmodel・tool指定）。

### A27 — providerの一時的な応答中断に対する自動再試行（未採用）

- 利用者判断（2026-10-01）: 常に停止するわけではないため、当面は`/recall`で対処する。
  自動再試行は将来の候補としてメモに留める。採用・実装は未指示。
- 観測: Session `e71f582a`の4ターン目で、`opencode-go-chat / mimo-v2.6-pro`の回答が途中で
  終了し、HTTP 200のまま`stream_ended_before_done`／`provider response invalid`となった。
  保存入力をproduction adapterで再送する1 requestのprobeでは、約40秒で`finish_reason: stop`と
  `[DONE]`を受信し正常完了した。中断の発生箇所がprovider・gateway・通信経路のどれかは未確定。
  局所probeの証拠は`.tools/provider-stream-eof-probe/report.json`。
- 現行経路と比較: HenjiのChat経路はHTTP 5xxを最大2回再試行するが、今回のHTTP 200後の中断は
  そのままターン失敗となる。Piは途中終了等を分類して既定3回、OpenCodeは再試行可能なエラーを
  最大5回再試行する。参照は10月1日更新のsnapshotにある
  `_refs/pi/packages/ai/src/utils/retry.ts`と`_refs/opencode/packages/opencode/src/session/retry.ts`。
- 現行の対処: [Increment 169](../increments/increment-169.md)で対象のprovider failureに
  `try /recall`を案内し、[Increment 176](../increments/increment-176.md)で失敗の分類と短い診断を拡充した。
  いずれもHTTP 200後の中断への自動再試行を追加しておらず、本候補は未採用のままである。
- トークン量: 今回の再送は入力30,878、出力1,533（推論661を含む）、cached 0だった。
  同規模で3回再試行すれば、キャッシュなしの追加入力だけで約9.3万tokenとなる。
  recallの準備自体はproviderを呼ばないが、次のtaskには通常履歴と参照JSONを送るため、
  recallによる継続1回が再試行1回より少ないtokenで済むとは限らない。
- 候補: 確認された一時的な中断に対し、完了済みtool結果を保持して失敗したmodel requestだけを
  再試行する。途中回答を次のmodel入力へ混ぜない処理、再試行の対象・回数・待ち時間・表示は採用時に
  決める。raw応答の常設保存は候補に含めず、必要な調査時だけ別probeで取得する。
- 再検討条件: recallでの手動継続が通常利用の負担になる、または利用者が検討の再開を指示するとき。

### A28 — 通常利用時のメモリ使用量の調査・チューニング（未採用、メモのみ）

- 利用者判断（2026-10-05）:
  DBは十分小さいが、メモリにはチューニングの余地がありそうなので候補として記録する。
- 実測（同日13:25 JST、Session `2bc2699f`、idle）:
  対象Sessionを開いているCoreとTUIの`/proc/<pid>/smaps_rollup`を読み、共有pageを按分するPSSで Core
  179.3 MiB、TUI 89.8 MiB、合計269.1 MiBだった。RSS合計は325.6 MiB。
  CoreはAgent・Data等のWorkerを含むprocessで、Session単独のメモリ使用量ではない。
  この一時点の値からleakや削減可能量は断定していない。
- DBとの比較（同時点、SQLite read-only集計）: workspace共有DBは15 Sessionを含み、本体57.4 MiB、WAL
  4.3 MiB、SHM込み合計61.7 MiB。 `2bc2699f`は4 turn・182 message・1,258
  semantic記録で、関連データ量は約5.3 MiB。
  Session分は関連rowの文字列/BLOBと参照先contentsの重複を除いた本文bytesの合計。共有設定・本文を含み、
  index・row/page
  overheadは含まないため、Session専用の物理占有量ではない。checkpointは未保存だった。
- 候補・未確認:
  起動時の固定費、CoreとTUIそれぞれが保持する会話・表示data、履歴量に伴う増分を実測し、
  機能と通常操作を維持したまま削減できる箇所を選ぶ。全体の内訳・削減可能量は未確定。
  A3のcontext管理とは関連し得るが、providerへ送るcontext量とprocessの常駐メモリ量を同一視しない。
- 追加実測（同日、同じCore/TUI・Session）: 15:31の実行中はPSSでCore 284.9 MiB、TUI 325.3
  MiB、合計610.2 MiB。 15:42のidleではCore 309.3 MiB、TUI 284.1 MiB、合計593.4 MiBだった。
  turnの停止後も大部分が残るが、PSS/RSSだけで生存heapとallocatorの保持pageは区別できない。
- 現行sourceと会話dataの確認:
  CoreのConversationWriterとTUIのSessionClientStateは、現在の会話entityを全件保持する。
  TUIは表示用Mapも持ち、画面外のtool引数・結果もsnapshotに含む。
  一方、EntryLayoutCacheの折返し結果は現在のhistory windowだけを保持し、範囲外を削除する。
  `2bc2699f`の会話snapshotは611 entity、JSON換算で約1.9 MiBであり、 このサイズだけではTUIの約284
  MiBを説明しきれない。
- TUI待機loopの再現済み保持問題は[Increment 194](../increments/increment-194.md)へ採用し、
  観測と修正要件を移設した。
- Coreの保存会話復元で累積本文を一括保持する問題は
  [Increment 195](../increments/increment-195.md)へ採用し、調査証拠と修正要件を移設した。
  本候補にはCore全体等の残る調査・チューニングを残す。
- 保存Sessionの最新request・request件数取得で不要な履歴本文を展開する問題は
  [Increment 196](../increments/increment-196.md)へ採用し、追加調査の根拠・比較と修正要件を移設した。
- 残る観測・候補: 196の同条件の隔離compiled確認で、100回参照後も約384 MiBのCore process
  PSSが残った。 native memory全体の所有・未使用領域の分解や、長時間のAgent実行の内訳は未確認。
- 類似問題reviewのcontext読取・終了後artifact更新・recall/診断読取の候補は
  [Increment 199](../increments/increment-199.md)の計画対象へ移設した。 Data
  Worker全体の処理調査と合わせて採用・実装・検証し、利用者による完了承認を得た。結果は199を参照する。
- 保持内訳の確認と限界（196採用前、195のsourceを使った調査）:
  実DBコピーを100回参照後に各isolateでGCすると、生存heapUsedはCore 5.6、Data 9.4、API 4.5 MiBで、
  GC後もprocess PSSは約704 MiBで、glibcの未使用malloc領域を約201 MiB確認した。
  probe内だけでmalloc_trimするとPSSは約520 MiBへ下がり、解放済みallocator領域の残存を実証した。
  ただしnative memory全体の所有・未使用領域を完全には分解していない。
  Worker終了後にもprocess側へ残る領域があり、ここから永続保持のleakとは断定しない。
  このnative内訳のprobeはDeno source環境でのみ行った。compiled binaryのnative内訳解析は未実施。
  常用環境への削減量保証として扱わない。GCとmalloc_trimは内訳を調べるprobe操作だけである。
- native内訳の調査証拠はgit管理外の`.tools/a28-core-followup/`に置いた。
  `findings.json`、各isolateの記録、`baseline-natural-http-result.json`、
  `baseline-natural-closure-result.json`を参照する。追加候補は個別採用前に実装しない。
- TUI更新時の割当調査（2026-10-05、Session `e4e0c7ce`、未採用）: 利用者がTUIの約155
  MiBの消費に疑問を示したため、稼働中と同じsource `da251e56`のbinaryを
  隔離HOME／XDGとコピーDBで確認した。実provider callは0回で、稼働processのGC・再起動は行っていない。
  production TUIのPSSは空Sessionで48.2 MiB、同じ保存会話を開いた直後で78.7 MiBだった。
  会話snapshotは260 entity／627,699 bytes、表示用本文は169,055 bytesである。
  保存semanticをproduction normalizerでAPI deltaへ変換した2,552更新／12,743,789 bytesを 10
  ms間隔で再生すると、別のproduction TUIのPSSは68.5から184.6 MiBへ増えた。
  再生ではCore役がPythonで、上記起動比較とは共有file page等の条件が異なるため、各run内で比較する。
  同じ再生の診断binaryでは、累積JS割当が約4.5 GiBに対し、GC後の生存JS heapは約10.5 MiB、
  確保済みphysical heapは約77.8 MiBだった。累積割当は常駐量ではない。
  割当追跡とsourceから、更新のたびに累積thinking全文を文字分解し、折返し・source index配列を
  作り直す経路が有力な改善候補である。`layoutLogEntry` → `thinkingBodyRenderer` →
  `wrapCellsWithSource`で、変わらない本文部分の再処理と重複した文字分解を減らす方向を候補とする。
  診断binaryは計測処理・GC公開・FFIを含み、関数別counterは重複と計測負荷がある。
  元の更新間隔・batchingも再現しておらず、実processのheap内訳や修正後の削減量は未確認である。
  実TUIは同じPIDのまま23:52 JSTにはPSS94.7 MiBへ下がった。
  証拠はgit管理外の`.tools/a28-tui-investigation/findings.json`と参照先へ保存した。 product
  sourceは変更しておらず、更新時割当の削減は個別採用後に実装する。
- TUI割当の因果比較（2026-10-06、同じ保存会話、未採用）:
  利用者が診断プログラムの追加と調査を承認したため、`scripts/diagnostics/a28_tui_memory.py`、
  `a28_tui_observer.ts`、`a28_thinking_allocation.ts`を追加した。 `da251e56`のarchived
  sourceだけに計測処理を加え、通常版とthinking折返しを空の表示行へ置き換えた
  診断版を、同じ2,552更新・10 ms間隔・110列×36行・隔離HOME／XDGで比較した。
  起動順を入れ替えて各2回測定し、両版とも会話260 entity・cursor
  2,552と最終snapshotのSHA-256が一致した。 通常版はPSSピーク167.1–167.7 MiB、終了10秒後167.1–167.7
  MiB、30秒後100.3–101.1 MiB。 折返しを省いた版はピーク102.9–103.1 MiB、10秒後103.0–103.2
  MiB、30秒後84.0–85.8 MiBだった。 強制GCはこの通常待機の測定後にだけ行った。GC後の生存JS
  heapは通常10.43、診断10.11 MiBで、 30秒後に残るPSS差約15–16 MiBは主にanonymous
  pageの差だが、その所有・長期残存は未特定である。 計測なしの元production
  binary一回でも、ピーク170.0、10秒後169.7、30秒後103.4 MiBとなった。
  計測版の再生中の累積JS割当は通常約4.4 GiBから診断約0.9 GiBへ減り、thinking layout回数は
  約1,300回でほぼ同じだった。割当の削減とprocess PSSピークの削減が同条件で対応した。
  実本文の単体測定は幅90 cell・200回batchの平均をfresh process二回で比較し、約3.9 KBのthinkingで
  一回あたり約2.1 MiB、約27 KBのthinkingで約15.8 MiBを割り当てた。 出力として保持されるJS
  heap増分はそれぞれ約43 KB、361 KBで、本文の数百倍になる割当の大部分は短命だった。 約3.9
  KBの本文では、行ごとの文字分解だけで約0.70 MiB、行幅の計算だけで約0.67 MiBを割り当てる。
  これらは別batchで測った部分処理であり、全体への寄与率や単純な合算値として扱わない。
  単発counterには計測自体等の割当が混ざるため、単発のraw値で倍率を判断しない。
  今回は大きな増加の多くが30秒以内に下がることと、折返し経路がピークを増やすことを確認した。
  診断版はthinking表示を省くためproduct修正ではなく、表示を維持した最適化の削減量はまだ未確認。
  候補は同じ本文の重複した文字分解・幅計算・位置配列生成を減らすこと。
  生存heapだけで常駐量全体を説明せず、30秒を超える残存量も保証しない。
  証拠はgit管理外の`.tools/a28-tui-causal/summary.json`と参照先に保存した。
  稼働中のTUI・Coreと実DBは操作せず、provider call、task投入、product runtime変更、配置は0回である。
- TUIの局所構造の無駄確認（2026-10-06、利用者指定、未採用）:
  独立reviewerがproductionの入口・Core起動境界・HTTP/SSE・reducer・projection・表示cache・terminal・入力を
  read-onlyで確認した。現在HEAD `4683adb`と測定source `da251e56`の対象runtime差分は配色変更のみ。
  correctnessの必須修正findingはなく、既知thinking以外に数十MiB以上の不要な生存dataがある証拠は得ていない。
  - 共通CLIのstatic importが非選択の履歴CLI・node:sqlite・Core・provider・Worker側moduleを評価する。
    `henji_cli.ts`と`tui_cli.main`の入口を同じ診断binary内で切り替え、空会話・同じCore接続を各2回測定した。
    専用入口で起動直後約8.0–8.8 MiB、30秒後約3.2–4.1 MiB、GC後の生存JS heap約2.52 MiBが減った。
    全runのsnapshotは一致した。最小方向は選択commandの遅延importで、通常local Core起動は維持する。
    証拠は`.tools/a28-tui-entrypoint/summary.json`。この結果を既存48.2
    MiBのコピーCore比較から差し引かない。
  - 全SSE frameでposition・projection・startupを再生成し、startupとpositionを複数回deep cloneする。
    今回の2,552更新は全件conversation更新でcontrol changeは0件だった。
    orientation設定を初回だけにする同一binaryの診断比較を各2回行うと、累積JS割当は約3%減り、
    PSSピーク168.6–169.1から164.9–166.3 MiB、30秒後101.2–101.4から99.3–99.7 MiBとなった。
    会話snapshotと最終tmux画面のSHA-256は一致したが、thinking layout回数も少し変わるため全差分を
    cloneに厳密帰属させない。変更なしの場合の比較であり、metadata・lifecycle変更を扱うproduct修正ではない。
    元情報が変わった場合だけ再設定する候補。証拠は`.tools/a28-tui-orientation/summary.json`。
  - 未使用tool result本文122,518 bytes・progress89,945 bytesもTUIが受信・保持する。
    `/recall`はexecution IDでCoreへ別要求するため、この保持本文のconsumerではない。
    TUI内部projectionだけで未使用payloadを省く候補だが、今回の量だけで150 MiBを説明しない。
  - 起動と`/view`でGET snapshotをID照合に使い、直後SSE snapshotで正式stateを作る二重取得がある。
    activation付きattachのGETは設定照合に使うため同列に削除しない。寄与量は未測定。
  - opaque overlay表示でも先に会話をlayoutし、その後表示を置き換えるため、見えない会話更新も折返す。
    受信・会話stateは維持し、閉じた時の最新表示・resize／scroll
    anchorを維持して折返しを遅延する候補。 実利用時の寄与量は未測定。 表示Mapを全文の二重copy、API
    reducerを毎回の全会話copyとして数えない。history window外のlayout cacheは
    削除され、terminalの直近frameには差分描画のconsumerがある。更新履歴の無制限な蓄積は確認されなかった。
    review全文はgit管理外の`.tools/review-a28-tui-structure/report.md`に保存した。
    比較用`a28_tui_entrypoint.py`・`a28_tui_orientation.py`を診断programとして追加した。
    product修正・配置は行っていない。未使用payload・二重取得・hidden
    layout等は効果を測って採用判断する。
- 操作・結果表示の責務からのTUI設計reviewとPi比較（2026-10-06、未採用）:
  利用者は局所費用の一覧ではなく、現在の操作受付・結果表示の責務に対する構造の適切さを問うと明示した。
  同じ独立reviewerが操作・必要状態・owner・更新単位から再評価し、Pi実装も比較した。
  推奨候補はCore/DataとTUIの境界を維持し、既存HTTP/SSEをTUI内の単一read modelへ直接適用すること。
  現在の共通会話read model
  replicaから別の表示row/orderを同期する段階と、汎用presentation更新を整理する。 canonical
  domainの再構成や本文の物理二重copyを問題とする案ではなく、必要な表示状態のownerと同期経路を
  明確にする設計判断である。cursor/cut・scope・最小ID/position索引・order・execution
  notice・steering照合・ control metadataを維持し、draft/receipt/menu/viewport等のlocal interaction
  stateと合成する。 全wire
  deltaは順番に適用し、表示処理だけを合流する。全保存履歴の既存表示source、entry/source anchor、
  操作世代、window cache、terminal差分出力も維持する。巨大controllerへ統合する提案ではない。
  server側のTUI専用read model/別APIはcontractと投影同期を増やし、現機能に対する利益が未測定のため
  現時点では推奨しない。現full replicaを維持する局所整理案は移行途中として比較対象に残す。
  Piは`_refs/README.md`のsnapshot
  `c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06`、1.0.0のsourceを確認した。
  通常interactiveはAgentSession eventから対象componentを更新するが、streaming Assistant
  contentは全文を clear/rebuildする。experimental remoteはConversationView
  replicaからcomponentへ投影し、publicationごとに
  transcriptを全invalidateする。Piを差分本文だけの処理や可視範囲だけのlayoutの例として扱わない。
  現Piは既定alt screenだが、通常のchat表示はcompaction-aware active context、remoteの旧entry
  pagingはTODO。
  Henjiの全保存履歴scrollと同条件ではなく、Piのtool結果本文には展開表示のconsumerがある。
  参考候補はoperation facade/表示read modelの分離、stable
  identityごとの更新、本文cache、editor/footer合成。
  履歴範囲縮小、in-process化、全invalidate、新replication frameworkの一括導入は採用しない。
  組替えのメモリ・入力応答改善量は未測定で、thinking全文処理の費用も別に残る。
  review全文はgit管理外の`.tools/review-a28-tui-structure/responsibility-report.md`へ保存した。
  これは設計候補の記録であり、product実装・architecture正本変更の承認ではない。

- TUI表示要件の利用者補足（2026-10-06）:
  当初要求したのはassistant出力のMarkdownを見やすくすることで、thinkingの折返しは要求していないと明示した。
  Increment 84はassistant Markdown、後のIncrement 123はthinkingの段落・読みやすさを扱う記録であり、
  現thinking rendererはassistant用のword-aware wrap/source index生成を共有している。
  既存実装・test・incrementの具体的な折返し方式を、利用者が要求した必須処理として維持しない。
  Markdown整形、thinkingの本文・改行表示、アプリ内のword-aware wrap/文字単位の位置配列生成を区別し、
  今回の検討でthinkingにassistant相当の整形費用を課すことを所与にしない。
  続く補足では、thinking・tool・assistant noteについて何も要求していないと明示した。
  これらの既存表示・整形を利用者の明示要件として扱わず、assistant回答のMarkdown
  readabilityと区別する。 この補足は既存表示の削除やproduct修正の指示とは扱わない。
- Pi測定後の利用者判断（2026-10-06）:
  CoreはPiより複雑と考えており、Coreの消費には大きな違和感はない。一方、操作受付・結果表示を担う
  TUI単独の100 MiB超には納得できないと明示した。PiのAgent+TUIの消費量をHenji TUI単独の
  妥当性の根拠にしない。今後のTUI評価は現在の操作・表示機能を維持した必要状態と更新処理の費用に基づける。
- Pi実CLI・実providerのメモリ測定（2026-10-06、利用者が実行を明示承認）:
  この環境にinstalled済みの`pi` 1.0.2をsource改変なしで起動した。実体はNode CLIで、Node v24.21.0。
  source reviewで参照したPi 1.0.0 snapshotとはversionが異なる。
  `openai-codex / gpt-6.1-sol`、thinking medium、110×36のtmux fullscreen、新規Sessionで説明依頼を1
  turn送信。 HOME/XDG/agent/session/workspaceを隔離し、tools・extensions・skills・context
  discoveryを無効化した。 `--offline`はstartup
  networkのみ止める設定で、応答は実providerから取得した。
  `/proc/<pid>/smaps_rollup`を約200ms間隔で568回測定し、child
  processも対象にしたが観測はPi単一process。 AgentとTUIを同じprocessに含む。強制GC・heap
  instrumentationは行っていない。 空画面の起動10秒後はPSS 86.4 MiB / RSS 117.7
  MiB。実応答中peakと完了直後はPSS 124.7 MiB / RSS 156.5 MiB。 完了後10・30・60秒もPSS 124.7 MiB /
  RSS 156.5 MiBで変化しなかった。 PSS内訳は空画面でanonymous 66.6 / file 19.7 MiB、完了後anonymous
  102.1 / file 22.7 MiB。 応答は43.9秒、stopReason `stop`、表示本文1,301文字・3,357 UTF-8
  bytes、表示thinking本文0文字。 usageはinput 563 / output 943（reasoning 68）/ total 1,506
  tokens。tool実行はなく、追加turnは送っていない。 物理HTTP
  request数・provider内部retryはinstrumentしていない。 小さな本文の応答後に100
  MiB超が残る現象はNode版Piでも観測したが、PSSのみではlive object、
  GC後の再利用領域、native割当を区別できず、Henjiの構造が最適であることの根拠にはならない。
  PiのAgent+TUI・新規短履歴とHenjiのTUI単独・長い既存履歴は同条件ではなく、性能順位は判断しない。
  診断programは`scripts/diagnostics/a28_pi_memory.py`、数値・時系列・画面・通常Sessionはgit管理外の
  `.tools/a28-pi-live/`へ保存。隔離credential copyは測定後に除去し、測定用Piも終了した。

- TUI評価の目的についての利用者補足（2026-10-06）: メモリ削減が目的ではなく、最適な処理の結果100
  MiB超が必要なら許容する、と明示した。
  現状は不要な処理が多く、それにメモリを使っているように見える、という疑問を検証する。
  各処理の操作/表示上の役割、必要な再実行、状態所有、処理量・応答・整合性から評価する。
  PSS・割当・保持量は結果指標の一つであり、100 MiB未満、thin client、単一store、paging、native化を
  それ自体の達成目標にしない。用途のあるcache・index・履歴保持は、操作を効率よく成立させるなら肯定する。
- TUI改定の検討案（2026-10-06、未採用、実装指示とは別）:
  利用者は改定案の検討を求め、表示処理の軽量化と状態・同期構造の整理は両方行うべきと指摘した。
  さらに、現構造を可能な限り維持する判断を捨て、常に最適な処理から考えるよう明示した。
  旧component、既存HTTP/SSE、Deno、現screen方式、履歴全文のTUI常駐は選定の前提にしない。
  ただし、採用済みの利用者操作と保存dataの意味を、実装都合やメモリ目標だけで省かない。

  出発点は「入力を編集する→Coreへ操作を送る→受付・進捗・結果を表示する」である。
  TUIに必要な正本はlocal draft/cursor、接続・表示対象、未確認の受付、viewport/menuであり、
  実行・予約・設定・保存履歴はCore/Dataが所有する。TUIがCore状態の別の正本を再構成しない。
  明示された表示要件はassistant回答のMarkdown readability。thinking/tool/assistant
  noteの高度整形は要件にしない。

  推奨候補は「更新元が変更の意味を通知→表示read
  model/index/cache→変更部分のlayout→可視frame→terminal」。
  store数の削減を目標とせず、各表現にconsumerがあり再処理を省けるなら複数の表現を肯定する。
  表示用recordはID、位置、種類、本文/活動preview、確定状態、必要なnotice関連情報のみとし、
  receipt照合・予約・cancel・設定menu等のconsumerが必要なcontrol情報を添える。 generic
  ConversationEntityから別の表示Map/orderへ同期する仕事は、発生元で必要な意味を公開する案と比較する。
  clientの再照合・再同期を省ける配置を選び、serverに別replicaや投影同期を増やして総処理が増すなら採らない。
  本文の物理二重copyがあるという理由ではなく、状態ownerと同期・処理段階が不要に重なるためである。
  transport、input、operation/receipt、view
  state、layoutを各moduleへ分け、巨大controllerにまとめない。

  display分類は回答Markdownとplain textを分ける。thinking/tool/assistant noteはplain表示を提案し、
  段落・元の改行・順序・活動状態を表示する。これは提案する既定であり、利用者が要求した追加機能ではない。
  回答本文とtool併存をDataのtoolIds等のsemantic関連から判定し、toolIdsが後から確定する更新も扱う。
  plain表示のscreen方式にアプリ内の物理行計算が必要なら、幅を一回走査し、各行の先頭元位置だけを作る。
  単語境界の再配置、Markdown
  span処理、全文字sourceIndices、文字/segment/tokenの重複配列をplain経路へ持ち込まない。
  append更新と判定できた場合は既存行を再利用し末尾の未確定行以降を更新する。任意replaceをappendと決めつけない。
  幅変更・本文途中の変更は必要箇所を再計算する。metadata/editor/timer更新で本文を再処理しない。
  回答Markdownのtable/list/code等は必要なlayoutとして扱い、変更のないentry/blockの結果を再利用する。
  画面を覆うmenu中は裏の会話stateだけ更新し、閉じる時に最新内容をlayoutする。

  表示用projectionの配置は比較対象とする。TUI内でwire入力から直接作る案ならAPI側の処理追加はないが、
  generic
  payloadの通信・decodeは残る。Core/API側で純粋な表示用projectionを提供する案なら不要payloadを
  通信・TUI保持から外せるが、notice/cursor/receipt等もconsumerを追ってcontractを設計する必要がある。
  new
  APIを避けること自体を理由に後者を棄却しない。Dataの履歴正本を追加複製しないprojectionとして設計する。
  今回のunused payloadは約212 KBで、この整理だけで数十MiB減るとは見積もらない。

  runtimeは必要処理を成立させる手段として評価する。不要なimport/evaluationは外すが、
  native比較はruntimeの具体的な処理/操作上の問題が残る場合に検討し、固定PSSだけを理由に必須にしない。
  単一Henji executable/別processの起動方式を変更しないことや言語を揃えることを目的にしない。 native
  TUIは低い固定費を期待する候補であり、今回のPi Node測定からその数値を推定しない。
  Deno案ではcommandの遅延importを行い、非選択Core/provider/history CLIの評価をTUIへ持ち込まない。
  既存probeで専用入口の減少は30秒後約3–4 MiBで、これだけを100 MiB超の対策にはしない。

  terminal委譲も候補とする。native auto-wrapとscrolling
  regionを使い、入力欄固定と更新中の本文表示を試す。
  全画面であることを不採用理由にしない。現在の行単位frame差分・PageUp/resizeのsource anchorを
  そのまま適用できると仮定せず、必要な画面位置管理と再描画量を比較する。
  行単位layout案でもplain経路を上記の最小処理へ変える。両screen案は同じ消費者機能で比較し、
  現行screen方式を残すためにwrap計算を必要要件へ格上げしない。
  全履歴のTUI常駐とCoreからのwindow取得も比較対象になり得るが、今回の本文169 KBだけを理由に
  新しいpaging contractを増やさない。履歴の表示可能範囲を短縮する案にはしない。

  検証は各部品の都合ではなく、入力編集・送信・予約/steering・cancel・履歴移動・resize・menu・
  Session切替・再接続・detach/quitが成立することから選ぶ。tool併存本文、thinkingの途中更新と確定、
  実際のMarkdown table/list/codeの表示も確認する。旧word-aware thinking
  testを新要件として固定しない。
  同じ保存会話と2,552更新の再生で空画面/会話表示直後/更新peak/自然待機10・30・60秒のPSS、
  累積割当、入力応答、最終の本文・順序・表示を比較する。強制GCで減った値を通常利用の成果にしない。
  100
  MiB未満を改善目標にしない。最適な処理の結果必要なメモリ量は許容し、不要な処理の有無を評価する。
  full replicaの削除・native化・terminal委譲の削減量は未測定であり、組み合わせの最終値を保証しない。
  採用後はTUI Surfaceの変更を隔離tmux上のproduction経路で確認する。
  構想・architecture・roadmapの正本反映やproduction修正は今回行っていない。

- 最適な処理を基準にした独立設計reviewの結果（2026-10-06、未採用）:
  利用者が既存構造維持のbiasを再指摘したため、同じreviewerへ目的・必要操作・状態・処理からの
  新しい独立設計reviewを依頼した。初回約10分、続く目的補足に対するbounded re-reviewを実施した。
  前回の「既存APIを維持できる最小変更」をB案推奨の理由にした判断は撤回した。
  メモリ削減を目的にしたwindow取得の既定推奨と固定RAMによるnative優先も撤回した。
  必要なcache・索引・全履歴source保持は、再取得・再解析・操作待ちを減らすなら適切と評価する。

  採用判断に向けた推奨候補は、Dataの更新境界が幅非依存の表示情報と変更の意味を公開し、
  TUIがlocal操作stateと再利用に有効なread model/cacheから必要部分を描く構造である。 単一storeやthin
  client自体を正解とせず、同じ仕事の再実行を外すことを目的とする。
  server側に別の会話replicaや追加投影同期を作って総処理が増えるならこの配置を採らない。
  client側の直接投影も、consumerの仕事を効率よく成立させる対案として評価する。

  具体的な見直し根拠は、thinkingで先頭しか使わない全文字sourceIndicesを生成すること、
  plain情報のword-aware/Markdown処理、変化のないorientation再設定、opaque
  overlay下の本文layoutである。 累積本文のfull entity
  upsert再送も、更新元が旧値と新値を持つため、append/replace/metadata通知へ変える候補。
  `normalizer.ts`の更新境界→`conversation_writer.ts`のJSON encode→Coreのencoded public frame→
  TUIのJSON.parseという実経路を確認した。appendを確認できる時にだけ通知し、置換はreplaceとして通知する。
  TUIが累積全文をdecodeしてから追記判定する仕事を発生元で省く。原観測も累積全文ならserverの比較は残り得る。
  新contractの総処理・操作応答・割当は未測定で、12.7 MBのwire量が169 KBになるとは見積もらない。

  推奨はplain表示経路と変更通知/状態同期を同じ改定で見直すこと。Markdownはassistant回答に適用し、
  note分類の後確定も意味情報として扱う。terminal委譲/アプリ行layoutは必要な操作の総処理で選ぶ。
  native比較や範囲取得を、100 MiB超だけを理由に新しい必須作業へ加えない。 これは設計判断とsource
  reviewであり、新方式の最適性・PSS削減量を実測した結果ではない。
  reportはgit管理外の`.tools/review-a28-tui-structure/first-principles-report.md`。 product
  source、正本architecture、稼働Sessionの変更や実provider callは行っていない。

- 可視領域に応じた加工についての利用者質問と現経路確認（2026-10-06）:
  利用者は、端末の表示行・幅に収まる領域へ表示される時だけ加工すればよいのではないか、と問うた。
  現`layoutUi`はeditor/footer等を除いたlogHeightを決める一方、`logRows`が履歴候補windowのentryを
  cache利用またはentry全文layoutで行へ展開してから、`slice(logStart, logStart + logHeight)`で可視行を選ぶ。
  履歴候補windowは既定48 entry/1 MiBであり、実画面の可視行とは異なる。全保存履歴を毎回layoutしている
  わけではなく、変更しないentryにはcacheがある。しかし候補内の長い変更entryは可視部分以外も全文layoutする。
  改定候補は本文/状態の更新と可視layoutを分離し、画面外ではlayoutをdirtyにするだけで加工を遅延すること。
  表示anchorから画面に必要な行/blockを加工し、既存cacheを再利用する。先読みは操作を速くする利益で選ぶ。
  行位置の索引やMarkdownの文脈解析が必要な場合は独立した必要処理として扱う。部分表示するtableの列幅等も
  依存情報を読むことはあるが、全履歴や画面外本文の折返し・span・画面行を毎更新生成する理由にはしない。
  sourceは`v0/tui/layout.ts`のlogRows/layoutUi、`entry_layout_cache.ts`、`state.ts`のhistoryWindow。

- 可視領域を起点にした改定案（2026-10-06、利用者が案の再検討を指示、未採用）:
  以下を描画候補の一つとする。後述のterminal履歴案と比較して選ぶ。
  先のstore/公開view中心の案は、この描画経路を満たす手段として再評価する。
  目的は現在の操作受付・結果表示に必要な処理を最適に行うこと。100
  MiB未満や保持量削減を目標にしない。
  方針は「更新を本文sourceへ反映→閲覧位置と実表示領域を決定→必要な行/blockだけ加工→frameを描く」。
  全候補entryを折り返してから可視行をsliceする現順序は置き換える。

  1. 本文と表示加工を分離する。
     TUIは表示に必要な本文・ID・順序・種類・版・確定状態と操作に必要なcontrolを保持する。
     受信時は関連recordと索引の更新、加工済み結果の必要な無効化だけを行う。受信のたびにrendererを呼ばない。
     draft/cursor/menu/receiptと会話sourceは別の状態として扱う。全履歴sourceを保持することは許容する。
     各索引・派生表現はconsumerと再処理を省く役割で選び、単一storeの数合わせを目的にしない。

  2. 閲覧位置を先に決める。 latestまたはentry
     ID＋元本文位置を持ち、editor/footer/menuを差し引いた実際の行数と幅を求める。
     位置解決には本文中の改行/block境界、必要時に作った折返し開始位置/checkpointを使う。
     viewportのために全履歴の高さや全文字位置配列を先に作らない。必要な初回走査/文脈解析は索引として再利用する。
     latestは末尾から画面を埋める範囲を求め、anchor閲覧はその位置から必要行を求める。

  3. 行生成を要求駆動にする。
     rendererの`render(entry全体, width) -> 全行配列`というinterfaceを置き換え、
     source位置から行を生成するcursor/iteratorが必要な行数で停止する形にする。
     thinking/tool/assistant noteは元本文・改行のplain経路とし、必要なセル幅/行先頭位置だけを扱う。
     word-aware整形、Markdown spans、per-character sourceIndicesをこの経路へ持ち込まない。
     assistant回答だけにMarkdown解析/layoutを適用し、表示に関係するblockと文脈だけを処理する。
     表の列幅、fence等の状態に必要な範囲外参照は認めるが、未表示部分の画面行/着色spanを全て生成しない。
     単一entryが長くても、画面を埋めるためにentry全文の表示行配列を作る形に戻さない。

  4. 表示と変更の交差で仕事を選ぶ。
     表示外entryの更新はsourceと索引/dirty情報だけ更新し、見る時に加工する。
     表示中entryのappendは、確認できた未確定tail/block以降を更新し、確定済み部分を再利用する。
     途中replaceや後確定のnote分類は影響する文脈/blockを無効化する。任意Markdownを末尾一行更新と仮定しない。
     同じentryでも画面外部分まで毎回再加工しない。位置計算の必要性と表示行生成を分ける。
     editor/timer/control変更は該当regionを更新する。順序変更時も本文位置anchorを維持して必要なviewを解決する。
     opaque menu中は会話sourceを更新するだけで、会話layoutはmenuを閉じるまで遅延する。

  5. cacheと履歴操作を新しい処理単位へ合わせる。 entry単位の全文layout
     cacheから、解析文脈、block、折返しcheckpoint、加工済み行を分けた再利用へ変える。
     有効性は本文の実変更範囲、幅、表示種類/文脈で判断する。変更のないrecord/blockを再加工しない。
     PageUp/Downは全`allLog`配列ではなく、表示済みの元本文位置と必要な前後の行cursorから移動する。
     resizeは元本文anchorから新しい幅の画面を作り直し、未閲覧履歴を全再layoutしない。
     位置案内はentry/本文位置から作る案を含め、総表示行数を出すための全履歴事前layoutを前提にしない。
     次pageの先読みやcache保持は操作応答を改善する利益で採否を決め、低い保持量だけで削らない。

  6. Core/Dataとtransportはこの経路に必要な意味を供給する。
     現Dataは既に幅非依存の本文・意味関係・順序・状態を作り、幅計算はTUIが行っている。
     本案でも幅・閲覧位置・画面行はTUI側で扱う。幅非依存化が今回初めて必要になるという説明は訂正する。
     更新元でappend/replace/metadataを確定して通知する案は、累積全文再送/decodeとTUI側の再判定を省く候補。
     clientへ必要な情報を直接渡す公開view案は総処理で比較し、別replicaや二重publicationを増やすためには採らない。
     新API、paging、native化は可視領域起点の描画を成立させる必須前提にはしない。 terminal
     auto-wrapもdrawingの候補に残し、必要な位置管理・再出力との総処理で選ぶ。

  変更対象は本文source/更新の境界、閲覧位置・行cursor、Markdown/plain
  renderer、cache、frame合成である。
  `AssistantContentRenderer`、`EntryLayoutCache`、`layoutUi/logRows`、`scrollPage/allLog`の現在interfaceは
  前提にしない。役立つID/order、本文source、terminal差分出力、操作/receipt経路は役割を確認して使う。
  実装採用後の検証は、画面外で長い本文が更新されても閲覧中の表示と入力を維持すること、
  その本文を開いた時に最新内容を表示すること、長い単一entryのPage/resize、可視Markdown
  table/list/code、 menu開閉、途中更新/確定とnote分類、Session切替/reconnectを実経路で確認する。
  sourceの最終本文・順序の一致に加え、加工範囲・走査量・cache再利用・入力応答・出力・PSSを観測する。
  『加工済み行が可視範囲に対応する』ことと、『必要文脈の読取も常に可視行数に比例する』ことを混同しない。
  product source変更、正本architecture反映、provider call、配置はこの検討では行っていない。

- terminalへ表示履歴を任せる案との比較（2026-10-06、未採用）:
  利用者は、PageUp/Downもtmux等の履歴bufferへ任せる案を提示した。ただし根拠のある決定ではなく、
  鵜呑みにせず、必要な操作と総処理のメリット・デメリットから選定するよう明示した。
  現行機能や表示方式の維持も、利用者案への追随も選定目的にしない。

  - 成立性の実測: 隔離HOME/XDG、独立socket、configなしのtmux
    3.5aで80x12画面を使い、1–10行を出力領域、
    11–12行を固定入力/status領域とした。26件の出力で17行のhistoryができ、最初のrecordを
    historyから読め、固定入力/statusも残った。固定入力欄があることだけでは本案を否定できない。
    通常時の`a`はprobeへ届き、copy mode中の`b`は届かず、終了後の`c`は届いた（受信`ac`）。 copy
    modeが履歴閲覧とキー受付を担うことは[公式manual](https://man.openbsd.org/tmux.1)とも一致する。
    証拠は`.tools/a28-terminal-history/summary.json`、`history.txt`、`visible.txt`。
    probe専用serverは終了済み。Henji常用process、利用者のtmux設定、providerは触っていない。
    確認範囲はtmuxの基本動作であり、他terminalやHenji全操作の互換性・性能を実証したものではない。

  - terminal履歴へ任せる利点:
    確定した表示を一度出力し、その保存・閲覧・検索・copyをterminal側に集約できる。
    Henji側の過去画面行、履歴移動のための行索引、再閲覧時のlayoutを省ける。 plain本文のsoft
    wrapもterminalへ任せられる。terminal自身の履歴保持は必要だが、
    重複する表示処理を省けるなら有効であり、単なる別processへのメモリ移動という理由で退けない。

  - 操作・結果表示上の代価: 同一paneのcopy
    mode中は通常キーがアプリへ届かないため、履歴を見ながらdraftを編集・送信する
    現行操作はそのまま成立しない。別pane等で共存させる案はあるが、pane/focus/キー経路を増やす。
    この同時操作を必須とするかは、現実装に存在することだけでは決めない。
    また、生成中から確定までの実経路は同じrecordを更新する。`keyed_conversation_store.ts`ではassistantの
    toolIdsによりnote分類が変わり、tool開始表示をresult表示へ置換する。これは未確定表示の更新であり、
    完了した過去turnの確定本文が後から書き換わる根拠ではない。通常のcursor制御は画面座標を対象とし、
    未確定のままscrollbackへ送った旧表示をIDで置換する機能にはならない。
    本案では結果を別行へ追記するか、未確定表示を画面内に留めて確定後に履歴へ送る必要がある。
    これは単なる描画内部変更ではなく、途中表示と確定表示の関係を選び直す判断である。
    assistant回答のMarkdown table列幅・list/codeの明示改行は出力時のlayoutとなる。 terminalのsoft
    wrapだけでMarkdownの意味から新幅へ再layoutできるとは扱わない。
    古い表示をそのまま読むか、必要時に再表示するかを選ぶ。毎resizeで全履歴を再出力すれば利益が減る。
    Session切替・再接続ではterminalの出力履歴とCoreの保存会話を区別する必要があり、
    切替先を読み出して表示する処理は残る。bufferの上限もある
    （[tmux 3.5a公式仕様](https://raw.githubusercontent.com/tmux/tmux/3.5a/tmux.1)の`history-limit`）。
    scrollback自体を保存会話の正本にする案ではない。

  - 組合せ案の評価:
    「確定履歴はterminal、未確定内容と入力/menuは小さい可視領域」という案も成立候補とする。
    確定時の加工・出力は一回追加されるが、過去全体を毎更新加工する必要はない。
    一方、長い未確定本文の画面外部分を生成中にも読むなら、別の閲覧経路または早期履歴出力が必要になる。
    履歴へ送った部分の後変更も解決が必要であり、二方式を足すだけでは最適にならない。

  - 参照実装確認前の暫定選定（後述の確認で第一候補の優先を撤回）:
    最新本文を読めること、入力・制御を受け付けること、assistant回答のMarkdownを読みやすく示すことを
    同じ経路で成立させる候補として、可視領域起点の描画を暫定第一候補とする。
    画面外を毎更新加工することや全文layout配列は前提にせず、変更する範囲と閲覧範囲の交差だけを処理する。
    terminal履歴案は確定済みの追記型出力では処理をさらに省けるが、上記の操作・表示選択まで含む別案である。
    履歴閲覧中の入力を切り分け、過去表示の再layout/置換を不要とする使い方なら、terminal履歴案が優位になる。
    その操作変更を未承認のまま「最適」と確定せず、かつ現行操作を全て維持すべきという推測も採用しない。
    総性能の優劣は未測定。比較する場合は同じ操作と結果で、加工範囲・走査量・出力・入力応答を測り、
    メモリだけで選ばない。Piのmain-screen実装も全文`render(width)`と`previousLines`保持を行い、
    width変更でscrollback消去＋全再出力するため、terminalへ完全委譲した実例としては扱わない
    （`_refs/pi/packages/tui/src/tui-main-screen.ts`、参照版1.0.0）。

  - 「過去の記録が書き換わるか」の追加確認:
    完了した過去turnの確定本文を書き換える通常経路は、確認したsourceには見つからない。
    前の比較では、生成中に画面から流れた未確定表示と、確定済みの過去記録を区別できていなかった。
    `normalizer.ts`のassistant_progress→model_result、thinkingのcomplete更新、tool_call→tool_resultは
    途中から確定までの更新である。model_resultはdeclaredCallsも同時に処理し、writerは同一publication内の
    entity更新をcoalesceするため、note分類を確定後の過去本文変更の一般例として扱わない。
    終了後のhook/context/provider観測保存経路も確認したが、`history_adapter.ts`では確定済み本文の
    改稿に投影していない。これは全APIの不変保証を証明したものではなく、通常経路のsource確認である。
    確定済み表示を追記するterminal履歴案は、この点で自然な候補である。
    比較上の争点を、未確定表示をいつ履歴へ送るか、履歴閲覧と入力の共存、過去Markdownのresize、
    Session切替・再表示へ絞る。「確定履歴が後から変わる」という理由では本案を不利に扱わない。

  - Pi・Codexのterminal履歴方式の確認と判断更新:
    利用者は、PiとCodexにもterminalへ履歴を任せる方式があり、別方式も存在すると指摘した。
    Pi参照版1.0.0には`TuiMainScreen`と`TuiAltScreen`がある。main
    screenは履歴閲覧をterminalに任せつつ、
    componentの全文render、表示行保持・差分比較をアプリが行う。width変更や表示外の旧行変更は
    scrollback消去＋全再出力で扱う。履歴委譲の成立例であるが、毎更新の加工を最適化した例とは区別する。
    Codexのinstalled CLI 0.160.0のhelpは`--no-alt-screen`をinline mode＋scrollback保持と説明する。
    [公式CLI文書](https://developers.openai.com/codex/cli/reference/)にも同flagがある。
    実装参照はOpenAI公式repositoryの固定commit
    `3f1ccb7ceb814e54314826f68d61c892e2f5a48e`を取得した。 installed
    binaryと同一sourceであることは確認していない。保存先は`.tools/a28-codex-reference/`。
    `insert_history.rs`は確定表示を入力viewportの上のscroll
    regionへ書き、通常のdrawはviewportを描く。 `app/native_history.rs`は未完了dynamic
    toolに関係する出力を待たせ、streamの未出力部分を確定sourceへ
    統合する。`app/resize_reflow.rs`は幅変更時に保持したHistoryCell
    sourceからscrollbackを再構成する。
    `transcript_mode.rs`はTerminal/Ownedを区別し、Ownedでは保持sourceをdraw経路で表示する。
    このsourceにはpre-wrapとterminal wrapの選択もあり、「terminalに履歴を任せる」と
    「Markdown/折返し等の表示加工も全てterminalに任せる」は別の判断である。

    生成中の更新・入力欄・幅変更があることだけでterminal履歴方式を不利とし、可視領域方式を
    第一候補とした判断は撤回する。実装を確認する前に現行操作との距離を強く評価しすぎた。
    「確定履歴はterminal、更新中の表示と入力/menuはTUI」は実装のある構成として有力候補にする。
    このTUI側の更新中表示にも、不要な全文加工を避ける可視領域起点の処理を適用できる。
    ただし二つの完全な履歴描画経路を併設することは既定にしない。Pi/Codexの採用だけで性能優位とも断定しない。
    比較する仕事は、通常更新で新しく確定した内容と動く領域だけを加工する方式と、
    閲覧位置に応じてsourceから必要な行を生成する方式である。resize/replayの仕事はその操作時に比較する。
    tmux copy mode中の入力制約は確認済みだが、terminal委譲方式全体の共通制約へ一般化しない。
    provider call・Codex対話起動・product実装は行っていない。文書diff check済み。

  - 過去Session再表示とtmux既定2000行の確認:
    利用者が、過去Sessionを呼び出した時にtmuxの既定2000行制限がどう影響するか質問した。 隔離tmux
    3.5a（configなし、80x12、出力1–10行、固定入力/status 11–12行）へ、
    保存会話の再表示を模した2500件の番号付き1行出力を行った。history-limitは2000、実historyは1891行、
    captureで読める本文は601–2500の1900件で、1–600は残らなかった。historyが常にぴったり2000行
    残るわけではない。probe専用serverは終了済み。証拠は
    `.tools/a28-terminal-history/session-replay-limit/summary.json`、`retained.txt`。
    この制限はterminalへ出力した表示行にかかり、Coreの保存会話を削除するものではない。
    terminalのPageUpだけでは、脱落した行をCoreから自動取得できない。
    全文を加工・出力しても先頭が読めなくなるため、全Session再出力を無条件の最短経路にしない。
    全履歴を辿る動作が必要なら、terminal側の上限との役割分担と、保存会話を指定位置から読む経路を
    選ぶ必要がある。alternate
    screenの可視領域起点閲覧はterminalの履歴上限に依存しない点で利点がある。

  - alternate
    screenの更新依存・可視範囲加工を[Increment 198](../increments/increment-198.md)へ採用した。
    利用者は2026-10-06にalternate screen継続と上記改善の実装を指示した。
    採用要件・計画・実装・検証結果の正本は198。前段の比較・処理監査の根拠は
    [調査文書](../research/a28-alternate-screen-viewport-plan.md)を参照する。
    Core全体のnative内訳等、198の対象外の候補は本A28に残る。

### A29 — request単位のtoken usage・cache再利用量の保存とreadback（未採用、メモのみ）

- 利用者観測・依頼（2026-10-05）:
  Henjiの`openai-chatgpt / gpt-6.1-sol`でtoken消費が激しく感じられる。
  Codexのcache活用と、完了turnのtool結果をcontextから外すA3案との関係を検討した。
  usage記録の候補をメモするよう指示された。変更・実装の承認は含まない。
- 現行確認:
  `openai_responses_model.ts`は`response.completed`のresponseを受けるが、usageを抽出・保存していない。
  `2bc2699f`の確認した直近実行のsemantic記録にもinput/cache/reasoning token項目がない。
  cache未使用と観測欠落は区別できず、token消費の主因・削減効果は未測定。
- 候補:
  provider・model・API・execution・物理request順に相関して、providerが返したinput/output/total、
  cached input、reasoning、cache write等の取得できるusage数値を短いfactとして保存・readbackする。
  raw responseやcredential/Authorizationを常設記録する必要はない。
  usageまたは詳細項目が返らない場合は未取得として区別し、0へ置き換えたり通常応答を拒否したりしない。
- OpenAI公式仕様との照合（2026-10-05）: Responsesのcached
  inputは`usage.input_tokens_details.cached_tokens`、 Chat
  Completionsは`usage.prompt_tokens_details.cached_tokens`。
  input/outputとreasoningの名前もそれぞれinput/outputとprompt/completionで異なる。 Chat
  Completionsのstreamingは`stream_options.include_usage: true`で最後のusage chunkを要求できる。
  stream中断時はそのchunkを受け取れないことがある。
  これらはOpenAIの仕様であり、同形式の互換providerすべてが同じ詳細項目を返すとは未確認。
  provider別の実対応と保存・公開contractは採用時に確認する。
- 関連: A3、A28、`v0/agent/provider/openai_responses_model.ts`、
  [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、
  [Chat Completions公式仕様](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

### A30 — tool間の結果連鎖（tool resultを別toolの入力にできない）（未採用、メモのみ）

- 観測（2026-10-06、[Increment 200](../increments/increment-200.md)の実装・検証作業中の通常利用）:
  専用toolへ寄せられない合成処理がbash pipelineに残る。実例は、test結果の要約（`deno test … |
  grep -E … | tail`）、`search`結果の`cut`・`head`整形、`git diff | grep`、`cat … | head`。
- 現行境界: `run_typescript`の`input`はmodelが用意するJSONで、直前のtool
  result（bashのstdout、`search`結果）を機械的に受け取る経路がない。大きい出力はmodel
  contextへcopyすることになり、`run_typescript`の「fileを直接読む」案内は実行結果には使えない。
  `bash_output`は出力を`outputId`で保持するが、consumerは`bash_output`
  tool自身のwindow表示で、他のtoolから参照できない。
- 候補: 直前または指定したtool resultを`run_typescript`実行へ参照渡しする。例として、保持出力やtool
  resultを実行側（workspace配下または`/tmp`）へmaterializeしてcodeから読めるpathと識別子を渡す、
  `input`へ参照idを渡す。保持件数・大きい出力・取消・保存境界は採用時に決め、常設のraw保存は増やさない。
- 利用者意向（2026-10-06、実装は未指示）: 「安易にパイプでの連結はしてほしくない」。
  トークン効率が下がる可能性は許容する。合成のためのbash pipelineより、明示的なstepと専用toolの
  利用を優先する。
- 実測（2026-10-06、現行環境）: 1回のbash内で完結するpipelineはtool間の連鎖ではないが、別の理由でも
  望ましくない。bashは`/bin/bash --noprofile --norc -c`で実行され`pipefail`が無いため、
  失敗がexit statusから消える（`false | tail -1`と`deno eval … Deno.exit(7) | tail -1`がともexit 0）。
  今回のtest要約（`deno test … | grep … | tail`）も同じ形で、失敗runでもbash toolのexitCodeは0だった。
- 既存の代替経路（新機構なしで成立、実測）: コマンド出力をfileへredirectし（workspace内のscratchまたは
  `/tmp`）、`run_typescript`がそのfileを読んで集計する。bashの`/tmp`書込と`run_typescript`の`/tmp`
  読取は今回の環境で確認した。中間出力をmodel contextへ出さないため、pipelineでtailへ絞る場合より
  context消費が増えるとは限らず、増えるのはstep数である。
- 候補の見直し: 上記の代替経路があるため、参照渡しの新機構は「保持済みの出力を後段で使う」場合の
  小さい形（例: `bash_output`の保持streamを`web_fetch`の`save_to`と同様にfileへ書き出し、
  `run_typescript`/`read`の入力にする）から検討する。tool result全般の参照storeは役割・寿命・上限・
  清掃を新たに定義するため優先度を下げる。
- 案内候補（実装は未指示）: 上記意向を`promptGuidelines`へ入れる案。例: bashへ「要約のための安易な
  pipe（grep/head/tail）を避け、集計が必要なら出力をfileへ書いて`run_typescript`に渡す」、
  `run_typescript`へ「他commandの出力を集計するときはfile経由で読む」。[Increment 200](../increments/increment-200.md)の
  文面へ追加するかは未定。
- 当該作業でのpipe使用の分類（2026-10-06）: 観測したpipeはすべて「modelが読むための要約・整形」目的で、
  command自体がstream処理を目的とする必須pipeは0件だった。代替は、一覧/検索→`search`、file閲覧→`read`、
  test出力→redirect+`run_typescript`または`bash_output`の末尾offset、JSON整形→`run_typescript`。
  2件はpipe後も4 KiBを超えてtruncateされた（7,318と4,654 bytes）ため、pipeは可視性問題を解決しない。
- 案内の形: 「pipeを避ける」だけでは、代替（file経由/末尾offset/専用tool）を使えない場合に失敗の見逃しや
  step増を招く。「要約はpipeではなくredirect+file+`run_typescript`、打ち切られた末尾は`bash_output`の
  offset」のように置換先を指定し、pipeが本当にcommandの目的である場合と、どうしても使う場合の
  `set -o pipefail`（実測で有効）を例外として残す。
- baseline観測（2026-10-06、保存Session `0cd5c22e`・13 turn・tool call 139件の
  read-only分析、Increment 200の案内配置前）: bash 113件（81%）に対しread 15・edit 9・write 1・
  web_search 1で、`run_typescript`・`search`・`bash_output`は0件。bashの内訳はcd 111（98%）、
  pipe 81（72%、うちhead 68）、`sed -n 'A,Bp'` 33、grep系 68、ls/find 22、echo区切り 72、
  `> /dev/null` 17、実書込redirect 1。結果は11件がtruncate/spoolされ、`bash_output`
  でのreadbackは0件。同一fileの再訪が多い（`worker_runtime.ts` 26回等）。
  つまりbashが閲覧・検索・head整形の代用になっており、pipeはdata連鎖ではなく表示の切詰めが主。
  証拠は`.tools/tool-trend-0cd5c22e/`（詳細JSONLと集計summary.json）にある。
- 再検討条件: パイプ回避の案内後も、保持済み出力を後段toolで使う必要が通常利用で残るとき。
- 利用者提案（2026-10-06）: `read xxx.md | run_typescript`、`search xxx | read`のようなtool間の
  受け渡し。実装は未指示。
- 実装ルートの整理（2026-10-06、source確認）: 新文法/新pipeline toolは表示・step・失敗・型のsurfaceを
  増やすため最後の候補とする。明示的な参照渡し（tool resultのidと後続toolの参照）なら既存contractの
  延長で済む。大きいdataはrequest上限（会話1 MiB等）があるためargumentsでなくfile渡しが妥当。
  - core変更なしのprobe: 外部hookで成立する。`after_tool`で結果とidを保持し、`before_tool`で参照を
    file path等の小さい引数へ置換、`runtime_start`のcontext additionで案内を追加する。hook contextの
    transcriptはcommitted済みの過去turnのみ（当turnの結果は見えない）ためhook自身が保持する。
    引数書換時はloopがeffective arguments全文をresultへ付記するため、注入はpath等に限る。
  - core最小形: 結果artifact（file materialize・id・上限・清掃）と`run_typescript`等への参照引数。
    既存precedentは`web_fetch`の`save_to`と`bash`のredirect。
- どのルートでも決めること: 参照可能な範囲（当turn/実行/Worker世代）、上限・eviction・清掃、
  credentialをworkspaceやDataへ書かないこと、参照元のsidecar/attribution、不在・期限切れの明示error、
  TUIの参照表示。
- 可視サイズの実測（2026-10-06）: bashのmodel可視出力はstreamあたり4,096 bytes（`MAX_CAPTURE_BYTES`）で
  打ち切られ、残りはspoolへ保持される（32 MiB/command、128 MiB/registry）。`bash_output`は`totalBytes`と
  任意offset（UTF-8境界）を受け、49,152 bytes windowで末尾も読める。readは64 KiB/call、searchは既定100件/page。
  今回の実測は`deno test`（2 file・41
  test）4,998 bytes、`git status --porcelain` 2,502 bytes、`grep -rn` 1,565 bytes、
  `cat .handoff/handoff.md` 12,239 bytes（可視4 KiB＋readback）。
- 効果の見込み（再評価）: 打ち切られた結果を後段へ渡す需要より、「打ち切られず全部読めるfileを作り、集計だけを
  contextへ返す」需要が実態に合う。`web_fetch`は`save_to`（workspaceまたは`/tmp`、既存fileは拒否）で
  本文をfile化し、結果は`Saved: <path> … Bytes:`の小さいtextだけになる。同じ形を`bash`のredirectでも
  使えるため、新機構の優先度は下げ、既存primitiveの案内と`bash_output`の末尾offset利用を先にする。
  `read→run_typescript`はrun_typescriptが既にfileを読めるため利得小。本命だった`bash`/`search`→
  `run_typescript`も、上記のfile経路と末尾readbackで多くは足りる。
- pipe回避の既存実例（2026-10-05 Session `2bc2699f`、2026-10-06にread-only分析）:
  `… > log 2>&1; result=$?; tail -n 8 log; exit "$result"`の形が39件あり、対象実行では非0 exit 10件が
  正しく伝播していた（pipeでtailへ絞る場合と違い失敗が見える）。file化＋尾の表示＋exit再送は、
  新しい機構なしで成立する代替の実例である。
- 関連: [Increment 200](../increments/increment-200.md)、`v0/agent/tools/run_typescript.ts`、
  `v0/agent/tools/bash_output.ts`、R2、R3。

### A31 — workspace外（config/state/tmp）の読取・書込境界（未採用、メモのみ）

- 観測（2026-10-06）: 専用toolはworkspace内に限定される（`checkedPath`、`run_typescript`実行Workerの
  permissionはworkspaceと`/tmp`）。workspace外の確認はbashが必要で、実際に今回はAgent自身の実効
  instructionを確認するためconfig rootの`instruction.md`をbashの`cat`で読んだ（`read`は
  「path must stay within workspace」で拒否）。
- 現行境界: config rootにはcredential file（API key等）が同居し、読取範囲の拡大は既存のcredential
  露出防止要件とセットで決める必要がある。A5の「mechanismで自動収集せずinstructionで持つ」方針とも
  区別する。
- 候補: workspace外のHost-owned root（config/state）を明示pathで読めるようにする案と、現状どおり
  bash併用を案内で明示する案を比較する。広げる場合は対象root、credential
  fileの扱い、表示・履歴への波及を採用時に決める。
- 再検討条件: 通常利用でworkspace外の確認・一時file作成が繰り返し必要になり、bash併用の使い分けが
  負担・誤用の原因になるとき。
- 関連: A5、A30、`v0/agent/tools/work_tool_workspace.ts`、`v0/agent/tools/run_typescript_executor.ts`、E1。

### A34 — 再起動後の続行セッションで新規toolがmodel定義に現れない疑い（未確認）

- 観測（2026-10-06、Session `91cb1f45`）: Core/TUIを再起動（新binary build `5bfcdbaa`・source
  `6f6f9a6a`、Core `c6afea6d`、`henji tui --continue`）した。
  - config側: `tool list`に`git_inspect`、`agent inspect`はdefault・reviewerともrejections `[]`
  - 実行側: `search`の`entries` mode（local-3）は**このセッションで動作**した（type/bytes/modifiedAtを返した）
  - しかし新規tool名`git_inspect`は**このセッションのtool呼び出しとして発行できなかった**（複数回試行したがbashへ
    落ちた）。
- 仮説（未確認）: 会話のmodel-facing tool定義がセッション開始時のbinaryで固定され、`--continue`では新しいtool名が
  追加されない。実行はliveなWorker Registryへ届くため、同名toolの新機能（search entries）は使える。
- 利用者影響: 再起動しても、新規追加toolを既存セッションの続きでは使えない可能性がある。新規セッションなら
  使える見込み（未確認）。
- 次の確認: ①`henji tui --new`の新規セッションで`git_inspect`を呼べるか、②呼べない場合はmodel requestの`tools`を
  組み立てる経路（`loadWorkerTools`・Worker composition）とHost/TUIが保持する会話stateの関係を確認する。
- 再検討条件: 利用者が新規セッションで確認するとき、または同現象が再観測されるとき。

## F24・自己改訂

### R1 — 自己改訂対象の重心とagent loop境界

- 利用者の仮説: Agent
  Definition、とくにrole定義はmodel能力への依存が大きく、有用なvariationも多くない
  可能性がある。Definition variantの増加自体を自己改訂の中心にしない。tool定義と実装、作業方針、
  instruction、policy、workflowの方が改善余地を観測しやすい。
- 現行境界（2026-10-04）: Agent
  JSONはinstruction/tools/agentsを選び、共通runtimeがmodel/loop/contextと
  compositionを構築する。maxStepsはruntime既定と起動optionで決まり、JSONの任意項目からは選ばない。
  task中の判断規則はinstruction/workflow、tool実行順やdispatch・turn確定条件はruntime/loopの改訂対象である。
- 候補: 最初の実証対象をAgent JSONに限定せず、tool実装、作業方針、instruction/policy/workflow、core
  loop、
  Hostのいずれかから経験に必要な対象を選ぶ。経験の解釈、候補生成、差分確認、人間の採用、通常利用への
  反映をつなぐ。現在fileと使用snapshotを使い、全対象共通のrevision storeを必須にしない。

- 不変条件: candidateの採用は人間の明示操作・承認に限定する。candidate自身にこの境界を外させない。
- 再検討条件: Self-revision Cycleで最初のcandidate kindと採用flowを選ぶとき。
- 調査:
  [`agent-loop-and-durable-state-comparison.md`](../research/agent-loop-and-durable-state-comparison.md)。

### R2 — tool改訂の版・使用内容の記録とMCP component

- 現行境界（2026-10-04）: Agent JSONのtoolsが名前を宣言し、tools.jsonが現在folderを選ぶ。
  Workerが@henji/toolのfactoryを一度呼び、同じToolのcontract/executorを提示・dispatchする。
  revisionは版名であり、実提示contract・選択元・rejectは独立configuration snapshotへ保存する。
  source closureの保存・exact revision pin・transportは現行方式ではない。
- 候補: tool候補の生成・内容確認・人間の採用・新Workerへの適用を経験へ結び付ける。
  履歴snapshotに加えてtool
  sourceの版やdependencyを固定する必要があるかは、具体的な改訂で振り返る材料から判断する。
  旧案のDefinition lineageへの固定を現行方式の必須追加機能にしない。 一般MCP
  componentは別の将来候補で、Exa MCPの採用は却下済みである。
- 確認する動作:
  schemaや版名の導入だけでF24の完了とせず、必要な候補内容と由来を人間が確認・採用でき、
  後続通常利用へ反映して使用内容を振り返れること。
- 再検討条件: tool改訂のcandidate flow、または具体的なMCP integrationを採用するとき。
- 関連: E1/E2、[181 contract](../increments/increment-181-contract.md)、
  [Host/Worker architecture](../architecture/henji-host-agent-worker.md)。

### R3 — tool実行profileとsandboxed Deno program

- 観測: 現行`bash`はmodelのcommandを`/bin/bash`
  subprocessへ渡す。Deno公式permissionのとおり、subprocessは 親runtimeのfilesystem/network
  permission内に自動で閉じず、OS userの権限で動く。2026-09-07の開発VMには
  `python3`、`apt`、`sudo`とpasswordless
  sudoがあった。あるturnでpackage導入を選ばなかったことは強制境界の 証拠にならない。
- 候補: startupの`trusted-local · no hard sandbox`をtrust、tool capability、permission、human gate、
  isolationの独立軸で扱う。read-only、approval-gated、workspace-sandbox、isolated-runner等を構造化profileで
  表し、Agent設定/tool componentはHost-owned permission ceilingの範囲内だけを選ぶ。
- hard sandboxの条件:
  `deno run --allow-run`やcommand名の禁止ではなく、subprocess自体をbubblewrap、Landlock、
  container、専用VM等へ置き、workspace
  mount、他path/credentialの可視性、network、process範囲をHostが強制する。
- 外書き込みの拒否/承認（Codexの`workspace-write`＋outside承認、OpenCodeのpermission model相当）は
  command解析ではなく**sandbox policy**として実装する。command解析型の承認や、bashの破壊pattern
  （`rm -rf /`等）のdeny-netは**sandboxまでの安全帯**であり境界ではない（変数展開・script・interpreter・
  redirect・`curl|sh`等で回避可能）。frictionの大きいapproval
  gateを常用の前提にしない。安価な大事故低減が 必要になった場合の選択肢としてのみ残す。
- Deno program tool候補: modelはTypeScript
  programとdataを渡し、Host/executorが固定permissionで実行する。modelに Deno CLI option、permission
  flag、executor、任意の`deno run`や`--allow-all`、shell起動を制御させない。
- 分類: sandboxed program toolの通常導入はF06の改善として先行できる。経験からexecutor/contractの
  revision candidateを生成・採用するflowまで成立した段階をF24とする。
- 関連: [Increment 191](../increments/increment-191.md)へA23の標準tool計画を採用した。同一process
  Workerの限界を 区別して記録している。強いsandboxの採用と同一の判断にはしない。
- 再検討条件: trusted-local以外の実行環境、またはmodel-generated
  programの制限実行がproduct要件になること。
- 参照: [Deno permissions](https://docs.deno.com/runtime/reference/permissions/#subprocesses)。

### R4 — instruction componentのrevision化と自己改訂

- 現行境界（2026-10-04）: 共通baseはuser instruction.mdまたはbinary内の最小coreを選び、 Agent
  JSONのrole寄与と構成不足の案内、実tool guideline、workspace AGENTS、skill manifest、runtime
  factsを合成する。 起動snapshotは当時の最終instruction/componentsを保持し、request
  contextとexecutionから参照する。 user
  file/JSONの編集は新Workerから反映し、現在fileの変更で過去snapshotを上書きしない。
- 候補:
  instruction/policy/workflowの候補内容・由来を現在採用状態と区別し、人間の採用・rollback対象にする。
  現在fileとsnapshotで足りるか、独立revision保存や複数component選択が必要かは対象動作から決める。
  合成順・競合・使用内容のattributionを維持し、旧managed
  loader/promotion/bindingを必須方式にしない。
  /reloadで現在内容を取り込むことと候補を人間が採用することを同じoperationにするかも未決である。
- 再検討条件: instructionまたはworkflowを自己改訂対象として選ぶとき。
- 正本: [構想](../concepts/experience-driven-self-revision.md)、
  [Host/Worker architecture](../architecture/henji-host-agent-worker.md)、[181 contract](../increments/increment-181-contract.md)。
- 関連: S4、E1。

## 配布・外部化

### E1 — Agent設定・tool以外のresource外部化

- 現行境界（2026-10-04）: standalone executable、JSON Agent設定、folder-based tool、native
  AGENTS/Skill、 user instruction.md、data-only
  provider/credential宣言を利用できる。model一覧・お気に入り・effort、
  APIキーとChatGPT認証も既存ownerが持つ。旧managed Agent/tool store、closure install、exact
  selectorとtransportは廃止済み。
- 残る対象: instruction複数component、任意context/loop strategy、MCP、Surfaceのload/置換、
  resource固有のmutable stateや移送等は、具体的な動作を採用するときに境界を定める。
  provider宣言の追加や現在tool folderの読込み自体を未実装候補として重複計上しない。
- 候補: 更新・共有・rollback・分離実行が必要な対象ごとにselection owner、scope、placement、
  lifetime、使用内容の記録を定める。file方式で足りるか、pin/transportが必要かもその利用目的から判断する。
  Agent/instruction/tool/providerを同じloaderへ載せること自体を目標にしない。
- Provider候補: 既存protocolで表せないadapterや認証・一覧取得を外部実装にする必要が出た場合に、
  binary-owned adapter、credential resolver、短いrequest fact、deadlineとの責務を比較する。 raw
  SSEの常設記録は前提にせず、追加確認は別probeを使う。
- 適用候補: candidate生成と人間の採用、現在設定の選択、新Workerへの反映、rollbackを区別する。
  廃止済みmodule install/managed activationを現行の利用入口として扱わない。
- 状態の分離: canonical会話、request
  context、tool/外部moduleの作業stateは、それぞれのownerとlifetimeを保つ。
- 再検討条件:
  instruction/tool/provider/MCP/Surface等の更新・共有・rollback・分離実行が通常利用で必要になること。
- 正本:
  [roadmap](../roadmap.md)、[Host/Worker architecture](../architecture/henji-host-agent-worker.md)、
  [provider/auth architecture](../architecture/multi-provider-routing-and-auth.md)。
- 調査: [外部化の比較記録](../research/externalization-reference-comparison.md)。

### E2 — 追加managed resource kind候補（未採用）

- 原観測（2026-09-18）: 当時のmanaged kind間の重複から一般化を検討した。native Skillの互換形式には
  独立した価値があり、最初のmanaged化対象から外した。
- 現行境界（2026-10-04）: instructionはuser file、AgentはJSON、toolは現在folderを使い、 旧managed
  Agent/tool revision基盤は181で廃止した。追加kindの必要性は、現在fileとsnapshot方式で足りない
  利用目的から改めて判断する。既存managed kindへの単純な追加・共通化を前提にしない。

- 候補（Henjiが単独でownerになれるcontractに限る）。優先順は未定で、通常利用で必要になった時点で個別incrementへ
  採用する。
  - provider declaration revision: data-only宣言をexact
    revision化（pin/transport/activation）。Provider外部化の
    続き。ファイルベースで足りる可能性あり。
  - model profile revision: model/effort/catalog preset。selection presetという別contract。
  - context/compaction strategy revision: generationごとのcontext投影/compaction
    policy（A3）。設計大きめ。
  - instruction component／policy／workflow revision: base
    1つではない複数componentの順序付き合成（R4）。
  - integration declaration（MCP connection）revision: connection/transport/capability（E1）。
  - Surface data/code revision: Host側Surface差し替え（F10/F24）。規模大。
  - Agent loop／runtime policy revision: loop semantics置換。core変更で高リスク。
- framework自体の扱い:
  共通kind基盤は、具体的なkindと必要な動作が決まってから、そのために必要なseamだけ切り出す。仮想的な汎用plugin
  discovery/loaderは現時点で採用しない（architectureの「必要になるまで共通化しない」方針）。
- 再検討条件:
  上記候補のいずれかを通常利用で更新・pin・transport・activationする具体的必要が出ること。
- 正本: [`roadmap.md`](../roadmap.md)
  F24、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

### E3 — Host runtime tunablesの設定ファイル化（未採用）

- 現行境界（2026-10-04、source照合）: provider deadlineはDEFAULT_PROVIDER_TIMEOUT_MS=300000、
  maxStepsはworker_agent_api.tsのDEFAULT_AGENT_MAX_STEPS=128が既定である。
  TUI/runは--provider-timeout-ms/--max-stepsでHost起動optionを渡し、共通Workerへ適用する。 Agent
  JSONはmaxStepsを宣言しない。runtime.jsonはない。
- 既存configはdefault-selection.json、providers/_.json、model-catalogs、agents.json、tools.json、
  credentials/_.json、user instruction.md等で、それぞれselection/contentのownerを持つ。
- tool定数はweb_fetchのtimeout=30000/本文readback上限1 MiB、bash_outputのwindow既定・上限49152
  bytes等にある。
  web_fetchのdownloadと本文readbackの上限を混同せず、調整したい具体的な動作から対象を選ぶ。
- 候補: CLI引数を毎回指定する負担が残る場合にruntime configで既定を選ぶ。 CLI > config >
  runtime既定の優先関係は案であり、対象設定とscopeを採用時に決める。
  providerTimeoutMsを最初の候補として比較し、他tool限界やmaxStepsを一括外部化しない。
- authority境界: Host起動optionと共通runtime既定の選択経路を使い、廃止済みAgent
  Definitionとの二重authorityを 仮定しない。JSON Agent設定、Session
  selection、executionの実効maxStepsとは役割を分ける。
- 再検討条件: timeout/tool限界/maxSteps既定の継続設定を通常利用で必要とするとき。
- 正本:
  [roadmap](../roadmap.md)、[Host/Worker architecture](../architecture/henji-host-agent-worker.md)。

### E5 — 追加protocol adapter候補（未採用）

- 観測（2026-09-21、official docs調査のみ）: 現行protocolは`openai-chat-completions`と
  `openai-responses`の2つで、adapterはbinary所有である。追加候補を調査した。
  - Anthropic Messages: `POST https://api.anthropic.com/v1/messages`、`GET /v1/models`あり。authは
    `x-api-key`または`Authorization: Bearer`、`anthropic-version: 2023-06-01`必須。wireが別で、
    thinking block＋`signature`のecho必須、`max_tokens`必須。新adapterが必要。
  - Google Gemini (AI Studio): nativeは`/v1beta/models/{model}:generateContent`、
    `:streamGenerateContent?alt=sse`、authは`x-goog-api-key`。OpenAI互換endpoint
    `https://generativelanguage.googleapis.com/v1beta/openai/`があり、Chat Completionsとtoolsを
    既存adapterで再利用できる。nativeは`thoughtSignature`のechoが必要で新adapter。
  - Azure OpenAI: v1 API
    `https://{resource}.openai.azure.com/openai/v1/`はOpenAI形式で`api-key`header またはEntra
    Bearer。classicはdeployment path＋`api-version` queryが必要でURL/query templatingが要る。
  - AWS Bedrock native: SigV4署名はrequestごとの計算が必要で静的header mapでは表現できない。
- 利用者判断（2026-09-21）: 参考調査のみで当面対応しない。Increment 101でauth profileと宣言headerを
  一般化しておく。
- 候補: 必要になったproviderから、binary-owned protocol
  adapterを追加する。GoogleはOpenAI互換endpointの 宣言だけで足りる可能性がある。AzureはURL/query
  templatingの要否を採用時に判断する。
- 再検討条件: 該当providerを通常利用で使う必要が出るとき。
- 正本候補: `docs/architecture/multi-provider-routing-and-auth.md`、`docs/roadmap.md` F02／F24。
- 関連: E1、Increment 101。

## 参照実装parity（Pi／Zot調査、未採用）

- 観測（2026-09-22、snapshot調査）: Pi（`_refs/pi` commit `08dc60bc…`、0.85.1）とZot（`_refs/zot`
  commit `f60e492e…`）のslash commandとCLI
  optionを抽出し、Henji現行surface（`v0/tui/slash_command.ts`、
  `v0/agent/cli/henji_cli.ts`、`v0/agent/cli/tui_cli.ts`）と比較した。詳細と全表は
  [`research/pi-zot-command-surface-comparison.md`](../research/pi-zot-command-surface-comparison.md)。
- 有力候補: 手動`/compact`、Session export/import、model cycling、configurable
  keybindings、画像入力。 P1（`run`の構造化出力）はIncrement 104へ採用済みでこの一覧から除く。
  旧P5（`@file`内容注入）はS28「`@`によるコンテキスト注入」へ統合した。検討事項と再検討条件はS28を参照する。
  旧P7（`sessions prune`）はA9「Sessionと関連履歴の保存・削除」へ統合した。検討事項と再検討条件はA9を参照する。
- 利用者判断（2026-09-22）:
  - P2 `/jump`: 3アクション程度必要でPageUpの方が手軽なため、候補から除外（調査記録には残す）。
  - `!command`はHost実行経路を増やす割にtool loopと重複するため候補から除外（調査記録には残す）。
  - Session tree/fork: 有用性が未確認。採用判断は保留。
  - `/btw` side-chat: Henjiにそぐわないため対象外。
  - `/swarm`: 時期尚早。既存async childのone-shot fork/joinとは別の候補として扱う。
  - extension/package管理: 将来課題（E2／F24）。
  - messaging bridge: 将来Surfaceの拡張で検討する可能性がある（未採用）。
  - sandbox/permission系: 対象外（R3領域）。
- 対象外: self-update、llama.cpp router、project trust。
- 再検討条件:
  各候補の再検討契機は候補一覧の列に従う。通常利用で具体的な不便が観測されたとき個別incrementへ
  採用する。

### P9 — 画像入力（`@image`／clipboard paste、未採用）

- 観測（2026-09-22、参照実装調査）: Piは`ctrl+v`でimage paste、Zotは`ctrl+v` paste（image含む）と
  `inline_images_enabled`を持つ。Henjiのtranscriptはtext-only（`UserMessage.content`は`TextContent`）で、
  画像をtaskへ入れる経路がない。
- 候補: 人間が`@image`／pasteで画像をtaskへ入れる経路。実現にはtranscriptのcontent
  part、provider別encoding （OpenAI `image_url`、Anthropic image block、Gemini `inlineData`）、tool
  result、TUI表示、model catalogの capability（vision）が必要。
- 依存: E5（Anthropic Messages／Google adapter）と、Increment 103で先送りしたcatalog capabilities。
- 再検討条件: 画像を扱うtaskを通常利用で行うとき。
- 関連: E5、A3、[Increment 135（credential登録）](../increments/increment-135.md)。

### P10 — 外部agent interface（双方向server/RPC／ACP、未採用）

- S22で採用した第三者HTTP操作契約は [Increment 139と後続slice](../increments/increment-139.md)、
  [CLI・外部API利用設計](../plans/s22-cli-and-external-api.md)を参照する。
  ACP・editor統合は引き続き本候補の未採用範囲である。
- 観測（2026-09-22、公式docs調査）: Codex app-serverはJSON-RPC 2.0双方向（stdio/WebSocket/unix、
  thread/turn/item）でrich clientを駆動し、OpenCodeは`opencode serve`のHTTP OpenAPI 3.1
  server＋`/event` SSE＋
  `@opencode-ai/sdk`で外部からprogrammaticに制御できる。ACPはeditor/IDE↔agentの標準（JSON-RPC 2.0、
  `session/new|prompt|update|cancel`、`fs/*`・`terminal/*`・permission要求）でZed/JetBrains等が対応。
  詳細は[`research/external-agent-interface-comparison.md`](../research/external-agent-interface-comparison.md)。
- 段階: (1) 一方向structured output（Increment 104で実装済み）、(2) 双方向server/RPC、(3)
  ACP（editor統合）。HenjiはHost/Worker間に
  既にdata-only双方向protocol（F12）を持つため、外部interfaceはHost-owned
  Surface追加（F10）として整理できる。
- 注意:
  ACPはagentがclientのfs/terminal/permissionを使う前提で、Henjiの自前tool・trusted-local方針との写像が
  非自明。R3（sandbox/permission）とF10の判断に接続する。
- 再検討条件: editor/IDE統合、または別agentからの対話的駆動を通常利用で必要とするとき。
- 関連: Increment 104、F10、F12、R3。

## 観測した不具合（未解決の残件）

- 個別incrementへ採用するまでは修正しない。再現条件、実行証拠、利用者影響をここへ残す。

### B5 — `commit proposal invalid`の具体的な検証不合格理由を特定できない

- 原観測（2026-09-19）: Session `54d65ea7`のexecution `e0e9cf4f`は約5分41秒のweb調査後、
  `contract_failure`／`commit proposal invalid`で停止し、成果がcanonical採用されなかった。
  同日の隔離XDG・実provider確認では別原因のprovider timeoutとなり、commit却下は再現しなかった。
  詳細なDB観測、自動復元の由来、再現試行は
  [`increment-85.md`](../increments/increment-85.md#b5の原観測と切り分け2026-09-19)へ移した。
- 現行境界（2026-10-04、source照合）: [Increment 170](../increments/increment-170.md)で
  record組立て・保存はAgent Data側へ移った。`session_authority.ts`の`proposalRecord`はcanonical
  Session schema
  1の`validateStoredSessionRecord`がfalseなら`undefined`を返し、`session_data_owner.ts`の
  `prepareProposal`が`commit proposal invalid`をthrowする。validatorはbooleanのままで、
  不合格になった項目・値の形は返さない。元の却下原因も未特定である。
- 対応済みの境界: 自動入力復元と停止理由の上書きはIncrement 85／97で解消した。
  却下proposalのtranscriptを保存・readbackする経路は181のhistory.sqlite3（schema
  1）へ接続されており、 原観測時の「却下transcriptをDBから読めない」は現行storeの制約ではない。
  [Increment 176](../increments/increment-176.md)でWorker／Data／commitの例外に取得可能な処理段階・
  例外種類・短いmessage等を残すが、boolean validatorを項目別理由付きへ置き換える作業は対象外である。
- 残る利用者影響:
  commit却下が起きた場合、保存されたproposalと取得可能な例外情報だけでは具体的な検証不合格箇所を
  直接特定できず、成果がcanonical採用されなかった理由の調査が難しい。
- 対応候補（未採用）:
  commit却下時に検証不合格の項目と値の形を短いfactとして保存・readbackできるようにし、
  実際の却下原因を調べる。再現probeが必要なら隔離XDGで行い、実provider callは別途明示承認を得る。
- 再検討条件:
  commit却下が通常利用で再観測される、または却下理由の記録・原因調査を個別incrementへ採用するとき。
- 関連:
  [`increment-85.md`](../increments/increment-85.md)、[`increment-94.md`](../increments/increment-94.md)、
  [`increment-97.md`](../increments/increment-97.md)、[Increment 170](../increments/increment-170.md)、
  [Increment 176](../increments/increment-176.md)、`v0/agent/data/session_authority.ts`、
  `v0/agent/data/session_data_owner.ts`、`v0/agent/worker/worker_host_coordinator.ts`、
  `v0/agent/history/sqlite_history_store.ts`。

### B12 — `process runner ended before command status`でbashが全件失敗し、原因も復旧も残らない

- 原観測（2026-10-05、Session `2bc2699f`の保存履歴分析、2026-10-06にread-onlyで集計）:
  2026-10-05T04:58:31Z–06:16:31Zの間に6 executionで`process runner ended before command
  status`のtool resultが生じた。失敗したcommandはgit status/diff・find・rg・grep・ls・echoで、
  対象executionでは**bash callが全件失敗**した（例: execution `99fae222`は130件すべて失敗）。
- 利用者影響: review子Agentが差分・gitを取得できないまま終了し、親はreviewを計6 execution
  spawnし直した。`99fae222`は同一`ls .tools/increment-193/apply-palette/`を125回再試行し、
  128 model step limitで停止した（診断`model_step_limit`、requestCount 128）。review未完の判定と
  再実行のstep・時間を浪費した。
- 現行source: `v0/agent/runtime/process_executor.ts`はrunner childのcontrol fd（stdio[3]）が
  `status`messageを返す前に`end`した場合にこのエラーを返す。runner自身の終了理由（exit code・
  signal・crash出力）はtool結果に含まれず、`diagnostic`recordにも残らない（同時期の診断はprovider系と
  model_step_limitのみ）。runner死亡後の再生成・復旧経路も確認していない。
- 未確認: runner childが早期終了した原因（生成失敗・crash・外部要因等）。1.5時間と新しいWorker世代を
  またいで継続したため環境要因の疑いがあるが、再現probeは未実施。
- 対応候補（未採用）: runner早期終了時にexit code・signal・短いcrash出力等を短いfactとして残す。
  runner死亡後の復旧（再生成）の是非は、原因確認後に採用判断する。修正・実装は未指示。
- 利用者判断（2026-10-06）: 別途調査とする。本項は通常利用メモに残し、原因究明・再現・対応の実施は
  別途の調査・指示で行う（この分析では追加probe・修正をしていない）。
- 再検討条件: 同エラーが通常利用で再観測されたとき、またはrunner診断・復旧を個別incrementへ採用するとき。
- 証拠: `.tools/tool-trend-2bc2699f/`（detail.jsonと集計）、分析scriptは`.tools/tool-trend/analyze.ts`。
- 関連: [Increment 133](../increments/increment-133.md)（managed process runner）、
  [Increment 176](../increments/increment-176.md)（失敗分類・短い診断）、
  `v0/agent/runtime/process_executor.ts`、`v0/agent/runtime/process_runner.ts`。
