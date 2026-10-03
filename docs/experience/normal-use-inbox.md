# 通常利用メモ

Henjiの通常利用で得た観測と、まだ個別Incrementへ採用していない改善候補の入口である。

更新日: 2026-10-03（S31の採用範囲をIncrement 179へ移動）。

- ここへの記載は採用、優先順位、実装認可を意味しない。
- 個別Incrementへ採用した項目はその正本へ移し、この一覧から除く。
- 長い実行証拠、参照実装比較、完了経緯は、increment、research、architecture等の担当正本へ置き、
  ここには候補を選ぶための現在の観測、候補、再検討条件だけを残す。
- 一覧IDは文書内の参照用であり、順序や大小は優先度を表さない。

採用済みのExa検索・download（A17とA6の一部）は[Increment 172](../increments/increment-172.md)、
共通APIキー登録は[173](../increments/increment-173.md)、B6は[174](../increments/increment-174.md)、
B7は[175](../increments/increment-175.md)、B8と共通の短い失敗診断は[176](../increments/increment-176.md)を参照する。
API/CLI adapter分離（S31とrun追加案）は[179](../increments/increment-179.md)を参照する。
B8の元の実失敗原因は未確定で、再発時の調査方針も176を参照する。

## 候補一覧

| ID  | 領域           | 候補                                                                         | 再検討の主な契機                                                                                                       |
| --- | -------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S4  | Surface        | `/rebuild`によるAgent context再構築                                          | 改訂したinstructionやskillを現Sessionの後続executionへ適用する必要が出る                                               |
| S20 | Surface        | 巨大表示領域でのwindow行量確保とframe上限                                    | 大きなディスプレイで履歴の空白・古い行欠落が観測されたとき                                                             |
| S22 | Surface        | 将来のWebUI本体                                                              | 独立HTTPコア・TUI分離の採用範囲はIncrement 139と後続sliceへ移した                                                      |
| S24 | Surface        | subagent tool行のrunId・task断片表示とstatus／collect／cancel行のagent名対応 | 並行子Agent運用で操作行とagent・runの対応付けが必要になったとき、A14採用時                                             |
| S26 | Surface        | CLIエラーを人間向けの理由・使い方案内へ統一                                  | 利用者がCLIエラー表示の改善を個別Incrementへ採用するとき                                                               |
| S28 | Surface        | `@`によるコンテキスト注入（旧P5を統合）                                      | 人間がファイル内容等をmodel turnなしでcontextへ入れたいとき。採用は利用者判断                                          |
| S29 | Surface        | `/edit`による外部エディタ起動                                                | 利用者が入力編集の外部エディタ連携を採用するとき                                                                       |
| S30 | Surface        | TUIの`/help`とCLI helpの内容統合                                             | 利用者がヘルプ内容の統合を採用するとき                                                                                 |
| S32 | Surface        | 入力履歴機能の削除                                                           | 利用者が入力履歴の削除を個別incrementへ採用するとき                                                                    |
| A2  | Agent実行      | Host操作のmodel向けtool化                                                    | AIがSession列挙やcontext rebuildを実際に必要とする                                                                     |
| A3  | Agent実行      | Context Strategyの外部化                                                     | 長期Sessionのtoken usageとcontext品質を実測で比較できる                                                                |
| A5  | Agent実行      | ambient情報のinstruction化（repository context・実行環境）                   | ambient remoteの誤認・repository探索の再発、またはAIが実行環境のambient情報を知らない／instructionだけでは足りない事例 |
| A6  | Agent実行      | Web searchの取得品質・backend比較                                            | 対象発見と本文取得の混在が調査品質・コストを損なう                                                                     |
| A9  | Agent実行      | Sessionと関連履歴の保存・削除（旧P7を統合）                                  | 古いSessionの整理や、Sessionと関連履歴の保存期間を決める必要が出るとき                                                 |
| A11 | Agent実行      | instructionの与え方                                                          | 指示の粒度や配置によってtaskの完了挙動が変わるとき                                                                     |
| A14 | Agent実行      | 名前付き子Agent Definitionの専用model指定                                    | reviewerなどを親Sessionとは別のmodelで動かしたいとき                                                                   |
| A15 | Agent実行      | searchツールコールの実装                                                     | 利用者指示（2026-09-25）。findとgrepを兼ね備えるかは実装時に検討                                                       |
| A18 | Agent実行      | bash toolのtimeout説明と引数エラーの具体化                                   | timeout上限超過をcommandの問題と誤解し、再試行でmaxStepsへ達した観測                                                   |
| A19 | Agent実行      | requestごとの実行状況・日時・地域context                                     | モデルが残りstep・経過時間を知らず長いturnを継続した観測、日時・地域を判断材料にしたいとき                             |
| A21 | Agent実行      | 1ターン内でsteeringを複数回受け付ける                                        | 実行中に追加の指示を続けて送りたいとき                                                                                 |
| A23 | Agent実行      | `run_typescript`でファイル操作を含む小処理をHenji内で実行                    | 利用者が対象用途・実行条件の具体化や利用価値検証を指示するとき                                                         |
| A24 | Agent実行      | subagent起動の判断とprovider・model・effort・toolの選択                      | 利用者が起動判断の検討を再開するとき                                                                                   |
| A26 | Agent実行      | hookによる起動時・実行前後の自動処理                                         | 起動時の環境確認など、決まったタイミングで実行したい具体的な処理が必要になったとき                                     |
| A27 | Agent実行      | providerの一時的な応答中断に対する自動再試行                                 | recallでの手動継続が負担になる、または利用者が自動再試行の検討を再開するとき                                           |
| A28 | Agent実行      | Coreの実行状態全件転記・task受付後の重複再投影の削除                         | provider-free測定結果を踏まえ、利用者が最小削除範囲を個別incrementへ採用するとき                                       |
| B9  | 保存履歴       | compiled実行のbuildIdがdevelopment値になる                                   | 履歴の実build attribution修正を個別incrementへ採用するとき                                                             |
| R1  | F24            | 自己改訂対象の重心とagent loop境界                                           | Self-revision Cycleの最初の実証対象を選ぶ                                                                              |
| R2  | F24            | revision付きtool componentとMCP                                              | tool candidateを生成・保存・採用するflowを設計する                                                                     |
| R3  | F24            | tool実行profileとsandboxed Deno program                                      | trusted-local以外の実行環境をproduct要件にする                                                                         |
| R4  | F24            | instruction componentのrevision化                                            | instructionを自己改訂candidateとして採用する                                                                           |
| E1  | 配布・外部化   | Agent Definition後のresource外部化                                           | 通常利用で更新・共有・rollback・分離実行が必要になる                                                                   |
| E2  | 配布・外部化   | 追加managed resource kind候補（未採用）                                      | 各kindを通常利用で更新・pin・transport・activationする必要が出る                                                       |
| E3  | 配布・外部化   | Host runtime tunablesの設定ファイル化                                        | provider timeout・tool限界・maxSteps既定などを通常利用で調整したくなるとき                                             |
| E5  | 配布・外部化   | 追加protocol adapter候補（Anthropic Messages／Google／Azure OpenAI）         | 該当providerを通常利用で使う必要が出るとき。Increment 101のauth/header一般化を前提にする                               |
| P3  | 参照実装parity | 手動`/compact`（checkpoint/compactionの人間起動）                            | context圧縮を人間が明示的に行いたくなったとき                                                                          |
| P4  | 参照実装parity | Session export/import                                                        | Sessionを別installationへ移す・再開する必要が出るとき                                                                  |
| P6  | 参照実装parity | model cycling shortcut                                                       | provider横断のmodel切替を頻繁に行うとき                                                                                |
| P8  | 参照実装parity | configurable keybindings                                                     | keybindingを利用者ごとに変えたくなったとき                                                                             |
| P9  | 参照実装parity | 画像入力（`@image`／clipboard paste）                                        | 画像を扱うtaskを通常利用で行うとき。transcriptのimage part・provider別encoding・表示・catalog capabilitiesが必要       |
| P10 | 参照実装parity | 外部agent interface（双方向server/RPC／ACP）                                 | editor/IDE統合や別agentからの対話的駆動が必要になるとき。一段目の一方向structured outputはIncrement 104で実装済み      |

## Surface

### S4 — `/rebuild`によるAgent context再構築（F01、F03、F08、F10、F11、F27）

- 観測: Henjiはworkspace instructionとskill catalogをWorker
  generation開始時にsnapshot化するため、改善した
  instructionや新しいskillを現在Sessionの後続executionへ適用するには新しいgenerationが必要である。目的は
  fileを再読込することだけでなく、改訂後のresourceからAgent側の基底設定を再構築することであるため、
  command候補名を従来の`/reload`から`/rebuild`へ変更した。
- 利用者判断（2026-09-13）: 少なくとも`AGENTS.md`と個々のnative
  Skillは、Session内の人間操作から後続execution
  に対して有効化・無効化できるようにしたい。他resourceを同じ操作対象に含めるかは個別に検討する。過去executionの
  attributionは変更しない。選択状態をSessionへ永続化するか、操作と`/rebuild`の順序、既定の有効状態は未決である。
- 候補:
  人間の`/rebuild`で、対象として定めたresourceから新しい`AgentContextGeneration`を構築し、現Session、
  canonical
  conversation、未送信draft、過去executionのattributionを維持したまま後続executionへ適用する。
  最初の対象では`AGENTS.md`とnative Skillの有効・無効selectionを扱い、Agent
  Definition、tool、将来componentは 対象kindとして採用するまで含めない。context generationとWorker
  generationを同じidentityにすることも決めていない。
- 再検討条件:
  instruction等を改善した通常利用で、Henji自体を終了せず同じSessionの次taskへ適用したい事例が
  得られること。個別incrementでは対象resource、selection/activation
  authority、transitionのcommit/failure semanticsを決める。
- 関連: A2、R4、E1、
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
  初回scope外の複数Session同時root実行、WebUI本体、ACPの実装を完了扱いにしない。

### S24 — subagent tool行のrunId・task断片表示とstatus／collect／cancel行のagent名対応（F01）

- 観測（2026-09-27、Increment 136計画時のsource照合）:
  runIdはHostの`ChildRunRegistry.spawn`が発行し、 `spawn_subagent`のcall引数には無い（tool result
  JSONと`subagent_status`／`collect_subagent`／
  `cancel_subagent`の引数にのみ現れる）。起動行へのrunId表示はresult textの解析を要し、操作行の
  agent名対応はrunId→agent名の対応付け（transcriptからの導出、TUI stateの保持、またはspawn result
  契約の拡張のいずれか）を要する。task断片はcall引数`task`から表示できる。
- 候補: [Increment 136](../increments/increment-136.md)で採用したagent名表示に加え、runId短縮表示で
  起動行とstatus／collect／cancel行を対応付けられるようにする。
- 再検討条件: 複数の子Agentを並行運用し、操作行がどのagent・runのものか履歴から追えなくなったとき、
  またはA14を採用するincrementに含めるとき。
- 関連: A14、[Increment 138（A20・A22）](../increments/increment-138.md)、
  [`increment-136.md`](../increments/increment-136.md)、
  [`increment-131.md`](../increments/increment-131.md)、`v0/agent/tools/async_agents.ts`。

### S26 — CLIエラーを人間向けの理由・使い方案内へ統一（未採用）

- 観測（2026-09-29、利用者の通常操作）: `henji list`で
  `{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}`
  がそのまま表示された。Core一覧の正しい操作は`henji core list`だが、何を間違え、どう直せばよいか
  メッセージから分からない。
- 現行常用binaryでの確認（同日、隔離HOME／XDG、実provider requestなし）:
  不明なcommand／optionに対し、root、通常起動／`tui`、`run`の通常表示／`--stream`、`history`、
  `sessions`、`module`、`tool`、`diagnostics`はJSONエラーを出す。TUI optionの指定漏れ等は
  具体的な理由がJSON内にあるが、ほかは`invalid invocation`だけの場合が多い。
  `core`／`serve`はテキストで、command間で表示が統一されていない。
  `sessions`のエラーはstderrではなくstdoutへ出る。
  `henji core list --help`もhelpとして処理されずエラーになる。
- 利用者判断（同日）: CLIらしいメッセージへ改善したい。今回はメモだけを残し、まだ修正しない。
- 候補: 通常表示ではstderrへ、不明なcommand／option名、値の指定漏れや不正な値の理由、
  該当commandの使い方またはhelpへの案内を短いテキストで出す。例えば`henji list`には
  未知のcommandであることと、Core一覧は`henji core list`であることを案内する。
  明示的な`run --json`等の機械向け出力は維持し、成功時の出力形式は別の変更として扱う。
  エラーの出力先とsubcommandのhelpも、今回観測した不整合の改善候補に含める。
- 再検討条件: 利用者がこの改善を個別Incrementへ採用するとき。対象command、表示文言、
  機械向け出力との境界を採用時に決める。
- 関連: `v0/agent/cli/henji_cli.ts`、`v0/agent/cli/cli_help.ts`、`v0/agent/cli/`の各command入口。

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
- テーマ／256 color／truecolor: 色に関する観測された不満がなく、Surface変更が大きい。 再検討条件:
  表示の識別性で色が問題になったとき。
- Piの`CURSOR_MARKER`（hardware cursor指定によるIME候補位置合わせ）:
  Henjiはframe末尾のcursor位置指定で 入力位置を示しており、目的は現状で満たしている。 再検討条件:
  IME候補位置がずれる観測が得られたとき。
- xterm.js仮想terminal（`@xterm/headless`）のtest基盤:
  単独では採らない。S17を採用するincrementなど、
  frameの実挙動検証が要件に直結するときに限って検討する。 再検討条件:
  S17の採用incrementを計画するとき。

### S32 — 入力履歴機能の削除（未採用、メモのみ）

- 観測・利用者意向（2026-10-03）: 実行中の↑/↓で入力履歴を呼べないことを確認したが、利用者は
  あまり不便を感じておらず、入力履歴自体の使用頻度も少ないと述べ、削除候補の記録を指示した。
- 候補: editorの送信済みpromptを↑/↓で再呼出しする入力履歴機能を削除する。
  関連する記録・navigation処理、help記載、専用testの整理範囲は採用時に決める。
- 再検討条件: 利用者が入力履歴の削除を個別incrementへ採用するとき。
- 現行経路: `v0/tui/input_history.ts`、`v0/tui/remote_session.ts`、`v0/tui/slash_command.ts`。

## Agent実行

### A2 — Host操作のmodel向けtool化（F02、F06、F10、F27）

- 観測: `/rebuild`や`/sessions`の意味操作は、人間だけでなくAIが作業中に使う価値もある。
- 候補: slash command文字列をmodelに擬似入力させず、Host-owned application serviceへ型付きcommand
  handlerとtool handlerを接続する。read-onlyな一覧/詳細取得と、Session切替・context rebuildのように
  呼出元のcontextを置き換える操作を分ける。後者はtool result前に呼出元を破棄せず、次turn予約、Host
  control event、turn完了後の切替等の順序を定める。
- 利用者メモ（2026-09-25）:
  Agent自身が`/model`相当のHost操作をtoolで要求する案。model変更は現在のturn中には
  適用せず、次のturnから有効にする。現行の`selectModel`は実行中に`busy`を返すため、単にslash
  commandを toolで呼ぶだけでは成立しない。実際に必要な利用場面はまだ不明で、採用・実装は決めない。
- 再検討条件: AIがSession列挙・詳細取得・選択、またはcontext rebuildを実taskで必要とすること。
  またはAgentが後続turnのmodelを自分で変える必要が実taskで現れること。UIだけに意味があるcommandや
  人間の明示選択が目的のcommandまで一律にtool化しない。
- 関連: S4。

### A3 — Context Strategyの外部化（F02、F06、将来のF24候補）

- 観測: 64 KiBでのtool-result機械的省略とpre-turn automatic semantic compactionの停止はIncrement
  29で 採用済みである。将来のcompactionは容量対策だけでなく、何を覚え、捨て、抽象化するかを決める
  Context Strategyとして扱う必要がある。
- 候補: 発動判断、対象選択、保持予算、semantic summary、model、failure方針、結果説明を交換可能な
  component境界にする。Agent Definitionに選択させても、canonical
  transcript、checkpointの永続化と相関、 tool call/resultの因果構造、credential、provider
  evidence、strategy結果の採否はHenji-owned境界に残す。
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
  search自体をAgent Definitionにするかは、conversation、prompt、model、tool利用を独立所有する必要が
  出たときだけ比較する。
- 残候補は実taskでの取得品質・費用・取得範囲の比較と、必要になった場合の別backend採用である。

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
  `v0/agent/cli/session_cli.ts`、`v0/agent/history/sqlite_history_v7_production_store.ts`の`delete`。

### A11 — instructionの与え方

- 観測（2026-09-23）: DeepSeekは短いREADME比較依頼ではツール使用を続けたが、対象ファイル、比較項目、
  追加調査の条件、報告する時点を明示した指示では、2回のprovider request（2件の`read`）で回答した。
- 利用者希望:
  instructionの内容・粒度・与える場所（共通instruction、モデル別instruction、個々のtask）を
  検討する。短い依頼から目的に合う作業範囲と終了条件を組み立てられるかを実利用で比較する。
- 再検討条件: 指示の与え方を変えると、同じ目的のtaskの完了挙動が変わること。

### A14 — 名前付き子Agent Definitionの専用model指定

- 利用者希望（2026-09-25）: 外部`reviewer`
  Definitionにreviewer専用のmodelを定義し、親Sessionのmodelと
  独立に動かしたい。起動ごとにmodelを任意指定するIncrement 131とは別の要望。
- 現行境界:
  `agents/reviewer.ts`は役割instructionとtoolを定義するが、`createAgentComposition`にmodel指定
  optionはない。session
  `b3aa7c49`では親とreviewerがともに`opencode-go-chat / mimo-v2.6-pro`で実行された。
  現在は[`increment-131.md`](../increments/increment-131.md)の`spawn_subagent(agent, task, model?, tools?)`で
  起動時にmodelを指定でき、省略時は親Sessionの現在selectionを使う。Definitionの専用model既定は未実装である。
- 候補: 外部Agent
  Definitionが子実行の既定model選択を宣言し、Hostが子Worker起動時にその選択を適用する。
  親Sessionの選択や既存の起動時指定との優先順位は、採用時に決める。
- 再検討条件: reviewerなど名前付き子Agentを親と異なるmodelで通常利用するとき。

### A15 — searchツールコールの実装

- 利用者指示（2026-09-25）:
  searchツールコールを実装する。findとgrepを兼ね備えるかは実装時に検討する。
- 現行境界: Henjiのtool setは`read`／`write`／`edit`／`bash`等で、検索専用のtool callはない。
- 候補: modelが使えるsearch tool
  callを実装する。findとgrep（対象探索と本文検索）を兼ね備える一つのtoolに
  するか、分けるかは実装時に検討する。
- 再検討条件: 個別Incrementへ採用するとき。findとgrepを兼ね備えるかはその実装時に決める。

### A18 — bash toolのtimeout説明と引数エラーの具体化

- 観測（2026-09-27、session `51b47299`、execution `6598b5eb-f405-4dbc-b213-eaa0b93bc145`）:
  `opencode-go-chat / mimo-v2.6-pro / effort=auto`によるIncrement 135のslice 1〜3実装・検証が、
  約43分、128 model step、172 tool呼出しで`max_steps`停止した。128回のmodel responseはすべて
  tool呼出しで、最終回答はなかった。bash引数エラー29回の内訳は`timeoutMs=180000`が28回、
  `300000`が1回で、いずれも上限超過だった。modelはcommandやファイル名、wrapperの不調と
  誤解して再試行し、stepを浪費した。これが長時間turnの唯一の原因とは断定しない。
- 現行境界: bash toolの説明とinput schemaは既に上限`120000`を明示しているが、timeoutの
  検証失敗も`invalid arguments: invalid bash arguments`だけを返す。command実行前の拒否なのか、
  どの引数が不適合なのかが結果から分からない。
- 候補: 説明に`timeoutMs`の整数範囲`1〜120000`と、引数検証失敗時はcommandが未実行であること、
  再試行前にschemaと引数を照合することを明示する。timeoutエラーは、例えば
  `invalid arguments: timeoutMs must be an integer from 1 to 120000; received 180000. Command was not executed.`
  として原因と修正方法を示す。今回の観測に対応するtimeoutの説明・エラー改善から検討する。
- 利用者指示（2026-09-27）: 今回は通常利用メモへの追加のみ。採用・実装は指示していない。
- 再検討条件: 個別Incrementへ採用するとき。改善後の通常利用で、引数エラーから適切に修正して
  作業を継続できるかを確認する。
- 関連: A11（報告する時点の指示）、E3（runtime tunables）、
  `v0/agent/tools/bash_tool.ts`のdescription・input schema・timeout検証。

### A19 — requestごとの実行状況・日時・地域context

- 観測（2026-09-27）: A18のsession `51b47299`では、maxSteps・現在step・turn経過時間を
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
- 関連: A18、A11、S4、E3、`v0/agent/core/loop.ts`、 `v0/agent/worker/worker_runtime.ts`のrequest
  projection・context attribution。

### A21 — 1ターン内でsteeringを複数回受け付ける

- 利用者希望（2026-09-27）: 実行中の同じturnへsteeringを複数回送れるようにしたい。
  今回は未採用候補としてメモし、実装は行わない。
- 現行境界（2026-10-03）: busy中の追加指示はF3で送り、受付は1 executionにつき1回。
  `SteeringOwner.admit()`の受付済み状態は指示を消費した後も解除されない。
  [Increment 175](../increments/increment-175.md)でWorkerの受付確認と、tool後に加えてmodelがfinalを
  返した際の取込み・同じexecutionの次requestへの継続を成立させた。複数回の受付は175の対象外であり、
  本候補として残る。これはHenjiの実装上の制約であり、provider APIの制約ではない。
- 候補: 同じturnの実行中に追加のsteeringを受け付け、既存のtool実行後・次のmodel request前の
  経路（final後の継続を含む）でモデルへ渡す。未消費の指示がある間に届いた追加分の保持方法と適用順序は、個別Incrementへ
  採用するときに定める。
- 対象範囲: 実行中turnへの追加指示。別枠のchatや子Agentへの直接steeringは、この候補には含めない。
- 関連: [Increment 175](../increments/increment-175.md)、`v0/agent/core/steering.ts`、
  `v0/agent/core/loop.ts`、`v0/tui/remote_session.ts`。

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
  統合障害は見つかっていないが、具体的な統合方式と実経路は未確認である。
- 次に具体化するとき: 利用者が対象用途・実行条件の具体化や利用価値検証を指示した時点で、
  現行sourceと今回の調査記録を使う。計画・実装・provider A/Bは未指示であり、利用価値が小さければ
  標準Toolへ採用しない。
- 関連: R3（tool実行profile・isolation）。本候補は小処理の利用価値、R3は実行境界を扱う。
- 原資料:
  [`2026-09-27-run-typescript-assessment.md`](../research/2026-09-27-run-typescript-assessment.md)。
  同資料のspike・planner
  input参照先はこのrepositoryにはなく、詳細証拠・保留中の検証案は未照合である。

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
- 関連: A14（名前付き子Agent Definitionの専用model指定）、
  [Increment 131](../increments/increment-131.md)（起動時のmodel・tool指定）。

### A26 — hookによる起動時・実行前後の自動処理（未採用）

- 利用者判断（2026-09-29）: hookの組み込みを検討したが、現時点では「必ず何かを実行させたい」という
  具体的なニーズはない。Zot／Piの調査結果と利用例をメモに残す。採用・実装は未指示。
- 参照実装調査（2026-09-29、手元sourceと公式docsを確認、動作実測なし）:
  - **Zot**: hook相当の仕組みをextensionとして持つ。拡張を別processで起動し、stdin/stdoutの JSON
    frameでイベント購読と介入を登録する。実装言語は自由。Session開始・turn開始／終了等の
    通知、tool実行前の引数変更・中止、ユーザー向けassistant本文の変更ができる。
    拡張は標準ではインストールされず、利用者が追加する。
    [公式extension仕様](https://github.com/patriceckhart/zot/blob/main/docs/extensions.md)、
    手元`_refs/zot/docs/extensions.md`、`_refs/zot/packages/agent/extensions/`を参照。
  - **Pi**: TypeScript extensionをPi process内で読み込み、`pi.on("tool_call", handler)`等で
    handlerを登録する。入力加工、実行前のcontext追加、tool実行前の引数変更・中止、
    tool結果変更、完了通知等ができる。通知だけのeventと、dataや動作を変更できるeventを分ける。
    [公式extension仕様](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、
    手元`_refs/pi/packages/coding-agent/docs/extensions.md`、
    `src/core/extensions/`（同package配下）を参照。
- Henji現行: `v0/agent/core/events.ts`に開始・終了やtool call/resultの通知、
  `v0/agent/tools/tools.ts`の`Registry.dispatch`に共通のtool実行経路がある。
  ユーザーがhookを登録する汎用機構は未実装。既存event sinkは同期通知で、非同期処理の完了待ちや
  引数・結果の変更を行うhook contractではない。
- 利用者が挙げた例: 「環境情報を起動時に必ず確認させたい」。起動時hookで既存の環境メモを読む、
  または必要な情報を取得し、初期contextへ渡す形が考えられる。instructionでAIへ確認を依頼する方式と
  異なり、runtimeが処理を呼び情報を渡すところまでを確定できる。AIの理解・活用を保証するものではない。
- 設計上の選択肢: 全利用者に共通する標準動作なら起動処理への直接実装も可能。利用者・projectごとに
  処理を差し替えたい場合はhook登録方式が候補になる。「起動」がCore／Session／Workerのどの境界か、
  確認項目、情報を渡す先は採用時に決める。
- 境界: 起動時の環境確認は利用例であり、環境情報の機械的収集を採用した判断ではない。
  A5の既存方針（人間の指示で`ambient.md`等を用意しinstructionとして読む）を変更しない。
  credential値とAuthorizationは取得結果・context・記録へ含めない。
- 再検討条件: 決まったタイミングで実行したい具体的な処理が通常利用で必要になったとき、
  または利用者がhookの検討を再開するとき。
- 関連: A5（ambient情報）、A11（instructionの与え方）、E2（追加resource kind）。

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

### A28 — Coreの冗長な状態更新・実行状態走査の削除（未採用）

- 根拠: 利用者の冗長処理調査とproviderなし測定の指示。1 Core・1 Sessionのtoolなし正常完了100
  turnで、 状態再投影1,900回、実行状態Mapの走査95,950件を観測した。過去のsettled
  executionも毎回転記される。 task受付後の明示的な再投影は100回すべて公開状態に変更なしだった。
- 候補: snapshot更新から実行状態Mapの全件転記を外し、実際に追加・変更された実行だけを反映する。
  admit成功後の重複再投影を除く。runtime通知の変更なし更新は一括削除せず、過去の履歴・実dataも削除しない。
- 未確認: CPU時間・入力遅延、実providerのstream、tool loop、cancel・失敗、HTTP/TUIの測定は未実施。
  測定件数を他経路へ一般化せず、性能向上や通常利用の遅延解消を保証しない。
- 実施順序: 利用者と合意し、179へ混ぜず、179の受入・baseline比較完了後に別incrementとして検討する。
  再測定と利用動作の確認は179後のCore・正式API Worker経路を基準にする。
- 再検討条件: 179完了後、利用者が削除案を別incrementへ採用すること。受付cursor、状態遷移、実行照会、
  cancel・steering・follow-upと履歴保存の意味を維持する具体的な反映経路を採用時に確認する。
- 詳細: [Coreの冗長な処理削除案](../research/core-redundant-processing-removal.md)。

## F24・自己改訂

### R1 — 自己改訂対象の重心とagent loop境界

- 利用者の仮説: Agent
  Definition、とくにrole定義はmodel能力への依存が大きく、有用なvariationも多くない
  可能性がある。Definition variantの増加自体を自己改訂の中心にしない。tool定義と実装、作業方針、
  instruction、policy、workflowの方が改善余地を観測しやすい。
- 現行境界: `AgentDefinition`はmodel、instruction、tool/skill/subagent resource
  identity、`maxSteps`を選ぶ composition envelopeである。「外部対象ならweb
  search」のような判断規則はinstruction/workflow、人間gateは Host/Surface側のadmissionに置ける。tool
  executionの並列化、自動dispatch、turn確定条件を変える場合は runtime/loop semanticsの改訂になる。
- 候補: 最初の自己改訂実証はDefinition sourceの変更だけでなく、tool
  componentまたは作業方針componentの
  candidate生成、差分確認、人間による採用、通常利用への反映を対象とする案を比較する。Definition、tool、
  instruction/policy/workflow、core loop、Host enforcementのrevision
  boundaryを、どの経験から改訂するか 判断できる単位にする。
- 不変条件: candidateの採用は人間の明示操作・承認に限定する。candidate自身にこの境界を外させない。
- 再検討条件: Self-revision Cycleで最初のcandidate kindと採用flowを選ぶとき。
- 調査:
  [`agent-loop-and-durable-state-comparison.md`](../research/agent-loop-and-durable-state-comparison.md)。

### R2 — revision付きtool componentとMCP component

- 現行境界: Increment 69〜71でmanaged tool
  Definition、model向けcontract（name、description、schema、
  `promptGuidelines`）、Worker内のmaterialize、Manifestへのresolved exact
  revision記録を実装済みである。 catalog外の新tool identityもexternal
  Definitionの`additionalTools`宣言と`tools.json` bindingで追加できる。
- 候補: tool dependency revisionをDefinition lineageへ固定し、tool
  candidate生成から人間の採用、通常利用への 反映までを自己改訂flowとして接続する。一般的なMCP
  componentは将来候補として残る（Exa MCPの採用は却下済み）。
- 完了境界候補: component schemaだけではF24の完了とせず、tool
  candidate生成、revision保存、人間の採用、 通常利用への反映までをproduct flowとして確認する。
- 再検討条件: Self-revisionのtool candidate、または具体的なMCP integrationを採用するとき。
- 関連: E1、[`increment-69.md`](../increments/increment-69.md)、
  [`increment-70.md`](../increments/increment-70.md)、[`increment-71.md`](../increments/increment-71.md)。

### R3 — tool実行profileとsandboxed Deno program

- 観測: 現行`bash`はmodelのcommandを`/bin/bash`
  subprocessへ渡す。Deno公式permissionのとおり、subprocessは 親runtimeのfilesystem/network
  permission内に自動で閉じず、OS userの権限で動く。2026-09-07の開発VMには
  `python3`、`apt`、`sudo`とpasswordless
  sudoがあった。あるturnでpackage導入を選ばなかったことは強制境界の 証拠にならない。
- 候補: startupの`trusted-local · no hard sandbox`をtrust、tool capability、permission、human gate、
  isolationの独立軸で扱う。read-only、approval-gated、workspace-sandbox、isolated-runner等を構造化profileで
  表し、Agent Definition/tool componentはHost-owned permission ceilingの範囲内だけを選ぶ。
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
- 関連: A23は`run_typescript`の小処理Toolとしての利用価値検証候補であり、同一process Workerの限界を
  区別して記録している。強いsandboxの採用と同一の判断にはしない。
- 再検討条件: trusted-local以外の実行環境、またはmodel-generated
  programの制限実行がproduct要件になること。
- 参照: [Deno permissions](https://docs.deno.com/runtime/reference/permissions/#subprocesses)。

### R4 — instruction componentのrevision化と自己改訂

- 現行境界: Henji共通、agent role、active tool guideline、workspace instruction、skill
  manifest、runtime factsを順に
  合成する。`AGENTS.md`はworkspace固有instructionで、Henji共通/built-in
  roleは`v0/agent/instructions/`が所有する。 standalone
  binaryの静的importはinstructionを埋め込むため、built-in
  source変更のrelease反映はrebuild/installを必要とする。
- 候補:
  instruction/policy/workflowをrevision付きresourceとして保存・比較し、candidate生成、人間の採用、
  rollbackの対象にする。named agentがcomponentを選ぶauthoring contract、dependency
  lineage、複数componentの 合成順/競合規則/Manifest
  attribution、standaloneでの書換可能storeとactivation境界を決める。各executionを
  当時使用したinstruction/context
  attributionへ結び付け、完全再現ではなく振り返りに必要な内容を残す。 `/rebuild`によるnative
  resourceの再解決と、managed candidateの承認/promotion/binding transitionを同じoperationへ
  まとめるかは、対象kindを採用するincrementで決める。
- 再検討条件: instructionまたはworkflowをSelf-revisionの対象として選ぶとき。
- 正本: 現行runtime instruction合成は
  [`multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)。
- 関連: S4、E1。

## 配布・外部化

### E1 — Agent Definition後のresource外部化

- 現行境界: standalone executable、Agent Definition専用のmanaged revision store/resolver、portable
  transportは Increment 32〜34で採用・実装済みである。`instruction:henji-base`はIncrement
  51でmanaged revisionとして 導入され、Increment 103でbuilt-in最小core＋user
  `instruction.md`直接読み込みへ置換された。Agent Definitionで
  得たloader、dependency、promotion、activationのsemanticsをinstruction、tool、Provider、MCP、Surfaceへ
  自動的に一般化しない。
- toolの現行境界: Increment 69〜71でmanaged tool Definitionのinstall/bindと、external Agent
  Definitionによる catalog外のtool identityの追加宣言・合成、Manifestへのresolved exact
  revision記録を実装済みである。 tool dependency revisionのDefinition
  lineageへの固定と自己改訂flowはR2の候補として残る。
- 未実装境界: 複数slotのinstruction revision化、external Provider registry、互換providerの data-only
  Definition、独自protocolのexecutable Definition、resourceごとのmutable instance state、context
  rebuild、共通package/plugin
  discoveryは未採用である。Providerは`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`と
  external宣言で、auth profileはpattern一般化済み（Increment 101）だが、external Provider
  registryと宣言の exact revision化は未採用である。
- 利用者希望（2026-09-17）: Provider設定を外部化したい。OpenRouter Responses API経路はIncrement
  58で、 Provider外部化はIncrement 58〜68／101で成立済みであり、残る対象は上記の未実装境界に限る。
- 候補: resource kindごとにscope/activation owner、execution
  placement、lifecycle、durability、dependency identity、 Manifest attribution、mutable
  stateを決める。Agent、instruction、tool、Providerを同じloaderへ載せる必要が実利用から
  出るまで、共通化を目的にしない。
- Provider候補: 互換providerをdata-only、独自protocol/OAuth/dynamic model取得をexecutable
  Definitionとして 分けるか、credential非継承、adapter state、raw SSE evidence、request
  count、timeout、network permissionのどこまでを Henji-owned contractに固定するかを決める。
  [Increment 135のcredential登録](../increments/increment-135.md)と接続する。
- activation候補: LLM-callableなmodule installはcandidate
  receiptを返して現turnを終え、人間の採用後に次Worker
  generationでactivateする。`define/install -> inspect -> activate/update -> stop/rollback`を分け、新revisionの起動成功後だけ
  current bindingを更新する。
- 分離候補: canonical transcript、provider context
  projection、外部moduleの作業用stateを同じ保存機構へ混ぜず、
  個別のlifecycleと復元保証で扱う。prompt note、memory、skill reference、subagent
  specのような軽量補助stateと executable code revisionも分けて検討する。
- 再検討条件:
  instruction、tool、Provider、MCP、Surfaceのいずれかに対し、通常利用で更新・共有・rollback・
  分離実行が必要になること。
- 正本: 採用済みの境界は[`roadmap.md`](../roadmap.md)、
  [`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、Increment 32〜34。
- 調査:
  [`externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)。

### E2 — 追加managed resource kind候補（未採用）

- 観測（2026-09-18）: Agent Definition、Henji Instruction、tool Definitionの3 kindがmanaged
  revisionとして
  存在し、kindごとにref/framing/store/CLI/binding/loadが別実装になっている。「任意kindの一般化」を検討したが、
  Skillは他harness互換のnative
  `SKILL.md`形式に価値があり、Henji固有revisionとして管理する実利が薄いため
  最初の適用例から外した。その後Increment 103でHenji Instructionはmanaged revisionをやめ、user
  `instruction.md`の直接読み込みへ移行した（現行managed revision kindはAgent Definitionとtool
  Definition）。 base instructionのcontent revisionはR4の対象として残る。
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
- framework自体の扱い: 共通kind基盤（ref/framing/store/CLI/binding/loadをkind
  descriptor化）は、実利用から
  必要になった具体的なkindが決まってから、そのために必要なseamだけ切り出す。仮想的な汎用plugin
  discovery/loaderは 現時点で採用しない（architectureの「必要になるまで共通化しない」方針）。
- 再検討条件:
  上記候補のいずれかを通常利用で更新・pin・transport・activationする具体的必要が出ること。
- 正本: [`roadmap.md`](../roadmap.md)
  F24、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

### E3 — Host runtime tunablesの設定ファイル化（未採用）

- 観測（2026-09-19）: 固定値が分散している。provider request deadlineは`DEFAULT_PROVIDER_TIMEOUT_MS`
  （`openrouter_contract.ts`、利用者指示で120,000→180,000へ変更）、assistant maxStepsは
  `DEFAULT_AGENT_MAX_STEPS=64`（`agent_definition.ts`、Definition入力）、toolは`WEB_FETCH_TIMEOUT_MS=30_000`・
  `MAX_WEB_FETCH_BYTES=1MiB`・`BASH_OUTPUT_*_WINDOW_BYTES=49,152`、resource
  limitsは`resource_limits.ts`。
- 既存のHost
  configは`$XDG_CONFIG_HOME/henji-harness/`の`default-selection.json`・`providers/*.json`・
  `tools.json`・`agents.json`。
- 2026-09-24のIncrement 126では、provider deadlineを300,000
  ms、組み込みAgentの`maxSteps`を128へ拡張し、
  TUIと`henji run`の両方でCLI引数から上書きできるようにした。`runtime.json`は採用していない。
- 候補: `runtime.json`を追加し、厳格schema＋検証でHost runtime tunablesを読む。precedenceはCLI flag
  > config > built-in
  > default。CLI引数を毎回指定する負担が実利用で残る場合は`providerTimeoutMs`を第一候補として再検討する。
- authority境界: `maxSteps`は現在**Agent Definition所有者**であり、Host
  configに置くと二重authorityになる。 既定値のHost config化はroadmap F06（loop/context
  externalization）の判断が必要。provider timeoutは Host/provider側なので衝突しない。
- 再検討条件: provider
  timeout・tool限界・maxSteps既定を通常利用で調整したくなったとき、または別incrementで
  採用するとき。
- 正本候補: `docs/roadmap.md` F06、`docs/architecture/henji-host-agent-worker.md`。

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
  - `/swarm`: 時期尚早。非同期subagentは同期subagent廃止後の別incrementで採用する（採用済み）。
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

### B9 — compiled実行の保存buildIdがdevelopment値になる

- 観測（2026-10-03、Increment 179のprovider-free受入）: 公式compiled候補と変更前baseline
  (`1d8d58e`)のmanaged headless実行を、終了後にread-only SQLiteで確認した。
  両版の保存executionのbuildIdはdevelopment値
  `c738494fbbf99c577b5c91b957df9f3f0efcfc755442293665f71c8e3bd30179`で、
  binaryの`--version`にある実buildIdと一致しなかった。
- 原因のsource経路: `data/client.ts`のData Worker初期化はstateRoot/workspaceRootだけを渡し、
  `data_bootstrap.ts`はbuild manifestをinstallしていない。`session_authority.ts`が
  `buildManifest()`の既定development値を取得し、`session_data_owner.ts`がexecution保存へ渡す。
- 利用者影響: 保存executionのbuildIdから、実際に使用したcompiled buildを区別できない。
  今回の候補identityはbinary SHA・version・Core readで確認した。
- 対応候補（未採用）: Data Workerの初期化へ実build manifestを渡してinstallし、
  新しいexecution保存とreadbackで実buildIdを確認する。既存履歴の書換えは採用していない。
- 再検討条件: 履歴の実build attribution修正を個別incrementへ採用するとき。
- 証拠: `.tools/increment-179/acceptance/definition-{baseline,candidate}/`、
  同受入の`definition_readback.ts`、[Increment 179](../increments/increment-179.md)。

### B5 — `commit proposal invalid`の具体的な検証不合格理由を特定できない

- 原観測（2026-09-19）: Session `54d65ea7`のexecution `e0e9cf4f`は約5分41秒のweb調査後、
  `contract_failure`／`commit proposal invalid`で停止し、成果がcanonical採用されなかった。
  同日の隔離XDG・実provider確認では別原因のprovider timeoutとなり、commit却下は再現しなかった。
  詳細なDB観測、自動復元の由来、再現試行は
  [`increment-85.md`](../increments/increment-85.md#b5の原観測と切り分け2026-09-19)へ移した。
- 現行境界（2026-10-03、source照合）: [Increment 170](../increments/increment-170.md)で
  record組立て・保存はAgent Data側へ移った。`session_authority.ts`の`proposalRecord`はcanonical
  Sessionの`validateSessionRecordV6`がfalseなら`undefined`を返し、`session_data_owner.ts`の
  `prepareProposal`が`commit proposal invalid`をthrowする。validatorはbooleanのままで、
  不合格になった項目・値の形は返さない。元の却下原因も未特定である。
- 対応済みの境界: 自動入力復元と停止理由の上書きはIncrement 85／97で解消した。
  却下proposalのtranscriptを保存・readbackする経路はIncrement 94のhistory v7へ移行済みであり、
  原観測時の「却下transcriptをDBから読めない」は現行storeの制約ではない。
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
  `v0/agent/history/sqlite_history_v7_production_store.ts`。
