# 通常利用メモ

Henjiの通常利用で得た観測と、まだ個別Incrementへ採用していない改善候補の入口である。

更新日: 2026-10-07（source `68ab5dd0`。S20・A34・B5の現行境界を追加照合）。 基盤の照合:
2026-10-05、source `a78c2076`・Increment 182まで。S26はIncrement 183、A18はIncrement
185へ採用・移設。B11はIncrement 190へ採用・移設。A23はIncrement 191の計画へ採用・移設。
2026-10-06にA30・A31を追加し、A32・A33はIncrement 200・201へ採用・移設（A32: review用Agentの
tool構成とinstruction、A33: read-onlyのgit調査toolとsearchのentry列挙）。 B12はIncrement
203へ採用・移設（binary更新後のprocess runner起動と早期終了の原因表示）。 A30へは保存Session
`0cd5c22e`・`2bc2699f`の分析結果も追記した。
2026-10-06にA19（requestごとの実行状況・日時・地域context）は利用者判断で不採用とし、
候補一覧と本項目を削除した。

2026-10-07にS32・S37は[Increment 211](../increments/increment-211.md)、S36は
[Increment 212](../increments/increment-212.md)へ採用・移設した。S35は利用者方針により取り下げた。

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

| ID  | 領域           | 候補                                                                                          | 再検討の主な契機                                                                                                       |
| --- | -------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S4  | Surface        | `/reload`によるinstruction・Agent設定・toolの再読込                                           | 改訂したinstruction・Agent設定・toolを現Sessionの後続executionへ適用したいとき                                         |
| S20 | Surface        | 巨大表示領域での画面サイズ・frame上限の見直し                                                 | 大きなディスプレイで履歴の空白・古い行欠落が観測されたとき                                                             |
| S22 | Surface        | 将来のWebUI本体                                                                               | browserから通常利用する画面が必要になるとき                                                                            |
| S28 | Surface        | `@`によるコンテキスト注入（旧P5を統合）                                                       | 人間がファイル内容等をmodel turnなしでcontextへ入れたいとき。採用は利用者判断                                          |
| S29 | Surface        | `/edit`による外部エディタ起動                                                                 | 利用者が入力編集の外部エディタ連携を採用するとき                                                                       |
| S30 | Surface        | TUIの`/help`とCLI helpの内容統合                                                              | 利用者がヘルプ内容の統合を採用するとき                                                                                 |
| A2  | Agent実行      | Host操作のmodel向けtool化                                                                     | AIがSession列挙やreloadを実際に必要とする                                                                              |
| A3  | Agent実行      | Context Strategyの外部化                                                                      | 長期Sessionのtoken usageとcontext品質を実測で比較できる                                                                |
| A5  | Agent実行      | ambient情報のinstruction化（repository context・実行環境）                                    | ambient remoteの誤認・repository探索の再発、またはAIが実行環境のambient情報を知らない／instructionだけでは足りない事例 |
| A9  | Agent実行      | Sessionと関連履歴の保存・削除（旧P7を統合）                                                   | 古いSessionの整理や、Sessionと関連履歴の保存期間を決める必要が出るとき                                                 |
| A11 | Agent実行      | instructionの与え方                                                                           | 指示の粒度や配置によってtaskの完了挙動が変わるとき                                                                     |
| A21 | Agent実行      | 1ターン内でsteeringを複数回受け付ける                                                         | 実行中に追加の指示を続けて送りたいとき                                                                                 |
| A24 | Agent実行      | subagent起動の判断とprovider・model・effort・toolの選択                                       | 利用者が起動判断の検討を再開するとき                                                                                   |
| A27 | Agent実行      | providerの一時的な応答中断に対する自動再試行                                                  | recallでの手動継続が負担になる、または利用者が自動再試行の検討を再開するとき                                           |
| A29 | Agent実行      | request単位のtoken usage・cache再利用量の保存とreadback                                       | token消費の内訳やcontext整理・cache改善の効果を把握したいとき                                                          |
| A30 | Agent実行      | tool間の結果連鎖（tool resultを別toolの入力にできない）。利用者は安易なパイプ連結を希望しない | パイプ回避の案内後も、保持済み出力を後段toolで使う必要が通常利用で残るとき                                             |
| A31 | Agent実行      | workspace外（config/state/tmp）の読取・書込境界                                               | workspace外の確認・一時file作成を通常利用で繰り返すとき。credential露出防止とセットで決める必要が出たとき              |
| A34 | Agent実行      | 再起動後の続行セッションで新規toolがmodel定義に現れない疑い                                   | 新規セッションで再確認し、同じ現象なら定義更新の経路を調査するとき                                                     |
| A35 | Agent実行      | 子agentの時間上限と期限での自動キャンセル                                                     | review等の時間上限をruntimeで実行したいとき                                                                            |
| B5  | 保存履歴       | commit却下時の検証不合格項目を特定できない                                                    | 却下の再観測、または項目別理由の記録・原因調査を個別incrementへ採用するとき                                            |
| R1  | F24            | 自己改訂対象の重心とagent loop境界                                                            | Self-revision Cycleの最初の実証対象を選ぶ                                                                              |
| R2  | F24            | tool改訂の版・使用内容の記録とMCP                                                             | tool candidateを生成・保存・採用するflowを設計する                                                                     |
| R3  | F24            | tool実行profileとsandboxed Deno program                                                       | trusted-local以外の実行環境をproduct要件にする                                                                         |
| R4  | F24            | instruction componentのrevision化                                                             | instructionを自己改訂candidateとして採用する                                                                           |
| E1  | 配布・外部化   | Agent設定・tool以外のresource外部化                                                           | 通常利用で更新・共有・rollback・分離実行が必要になる                                                                   |
| E2  | 配布・外部化   | 追加managed resource kind候補（未採用）                                                       | 各kindを通常利用で更新・pin・transport・activationする必要が出る                                                       |
| E3  | 配布・外部化   | Host runtime tunablesの設定ファイル化                                                         | provider timeout・tool限界・maxSteps既定などを通常利用で調整したくなるとき                                             |
| E5  | 配布・外部化   | 追加protocol adapter候補（Anthropic Messages／Google／Azure OpenAI）                          | 該当providerを通常利用で使う必要が出るとき。Increment 101のauth/header一般化を前提にする                               |
| P3  | 参照実装parity | 手動`/compact`（checkpoint/compactionの人間起動）                                             | context圧縮を人間が明示的に行いたくなったとき                                                                          |
| P4  | 参照実装parity | Session export/import                                                                         | Sessionを別installationへ移す・再開する必要が出るとき                                                                  |
| P6  | 参照実装parity | model cycling shortcut                                                                        | provider横断のmodel切替を頻繁に行うとき                                                                                |
| P8  | 参照実装parity | configurable keybindings                                                                      | keybindingを利用者ごとに変えたくなったとき                                                                             |
| P9  | 参照実装parity | 画像入力（`@image`／clipboard paste）                                                         | 画像を扱うtaskを通常利用で行うとき。transcriptのimage part・provider別encoding・表示・catalog capabilitiesが必要       |
| P10 | 参照実装parity | 外部agent interface（双方向server/RPC／ACP）                                                  | editor/IDE統合や別agentからの対話的駆動が必要になるとき。一段目の一方向structured outputはIncrement 104で実装済み      |

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

### S20 — 巨大表示領域での画面サイズ・frame上限の見直し（F01）

- 原観測（2026-09-26、参照実装調査の実測）: 大きな表示領域で当時のTUIが画面を埋められなかった。
  `HISTORY_WINDOW_ENTRIES` 48／`HISTORY_WINDOW_BYTES` 1 MiBのwindowはentry数・文字量で決まり、
  画面が要求する行数は保証しない。実測で512×200のとき、window30 entry・63 KBで生成行120行に対し
  必要196行（不足分は空行padding）。entryが短い対話ほど起こりやすい。加えて`MAX_ROWS` 200／
  `MAX_COLUMNS` 512でclampされた外側は空白になり、512×200＋CJK本文ではframeが `MAX_FRAME_BYTES` 128
  KiB（実測147 KB、SGR未計上）を超過して`renderFrame`が古いlog行からtruncateする。
- 現行境界（2026-10-07、source照合）: [Increment 198](../increments/increment-198.md)で 48件/byte
  window、全候補行の結合/slice、旧全文layoutを撤去し、本文位置から可視範囲を取得する方式へ
  置換した。旧windowの行量不足を理由とする変更案は残候補にしない。 `MAX_ROWS` 200・`MAX_COLUMNS`
  512・`MAX_FRAME_BYTES` 128 KiBは残っている。
  原観測の512×200条件での空白・行欠落は198後に再測定しておらず、同じ現象が残るとは断定しない。
- 残る候補: 巨大表示領域での画面サイズclampとframe上限を、現行経路での実測に基づき見直す。
- 再検討条件: 大きなディスプレイ利用が日常になり、履歴の空白・行欠落が観測されたとき。
- 関連: `v0/tui/layout.ts`（`MAX_ROWS`／`MAX_COLUMNS`／`MAX_FRAME_BYTES`）、
  `v0/tui/tui_renderer.ts`（frame予算）、[Increment 198](../increments/increment-198.md)、
  [画面表示比較](../research/pi-opencode-henji-screen-display-comparison.md)。

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
- 関連:
  A3、[A28の移設先](../increments/increment-199-a28-observations.md)、`v0/agent/provider/openai_responses_model.ts`、
  [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、
  [Chat Completions公式仕様](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

### A30 — tool間の結果連鎖（tool resultを別toolの入力にできない）（未採用、メモのみ）

- 観測（2026-10-06、[Increment 200](../increments/increment-200.md)の実装・検証作業中の通常利用）:
  専用toolへ寄せられない合成処理がbash
  pipelineに残る。実例は、test結果の要約（`deno test … |
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
  望ましくない。bashは`/bin/bash --noprofile --norc -c`で実行され`pipefail`が無いため、 失敗がexit
  statusから消える（`false | tail -1`と`deno eval … Deno.exit(7) | tail -1`がともexit 0）。
  今回のtest要約（`deno test … | grep … | tail`）も同じ形で、失敗runでもbash
  toolのexitCodeは0だった。
- 既存の代替経路（新機構なしで成立、実測）:
  コマンド出力をfileへredirectし（workspace内のscratchまたは
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
- 当該作業でのpipe使用の分類（2026-10-06）:
  観測したpipeはすべて「modelが読むための要約・整形」目的で、
  command自体がstream処理を目的とする必須pipeは0件だった。代替は、一覧/検索→`search`、file閲覧→`read`、
  test出力→redirect+`run_typescript`または`bash_output`の末尾offset、JSON整形→`run_typescript`。
  2件はpipe後も4 KiBを超えてtruncateされた（7,318と4,654 bytes）ため、pipeは可視性問題を解決しない。
- 案内の形:
  「pipeを避ける」だけでは、代替（file経由/末尾offset/専用tool）を使えない場合に失敗の見逃しや
  step増を招く。「要約はpipeではなくredirect+file+`run_typescript`、打ち切られた末尾は`bash_output`の
  offset」のように置換先を指定し、pipeが本当にcommandの目的である場合と、どうしても使う場合の
  `set -o pipefail`（実測で有効）を例外として残す。
- baseline観測（2026-10-06、保存Session `0cd5c22e`・13 turn・tool call 139件の
  read-only分析、Increment 200の案内配置前）: bash 113件（81%）に対しread 15・edit 9・write 1・
  web_search 1で、`run_typescript`・`search`・`bash_output`は0件。bashの内訳はcd 111（98%）、 pipe
  81（72%、うちhead 68）、`sed -n 'A,Bp'` 33、grep系 68、ls/find 22、echo区切り 72、 `> /dev/null`
  17、実書込redirect 1。結果は11件がtruncate/spoolされ、`bash_output`
  でのreadbackは0件。同一fileの再訪が多い（`worker_runtime.ts` 26回等）。
  つまりbashが閲覧・検索・head整形の代用になっており、pipeはdata連鎖ではなく表示の切詰めが主。
  証拠は`.tools/tool-trend-0cd5c22e/`（詳細JSONLと集計summary.json）にある。
- 再検討条件: パイプ回避の案内後も、保持済み出力を後段toolで使う必要が通常利用で残るとき。
- 利用者提案（2026-10-06）: `read xxx.md | run_typescript`、`search xxx | read`のようなtool間の
  受け渡し。実装は未指示。
- 実装ルートの整理（2026-10-06、source確認）: 新文法/新pipeline
  toolは表示・step・失敗・型のsurfaceを 増やすため最後の候補とする。明示的な参照渡し（tool
  resultのidと後続toolの参照）なら既存contractの 延長で済む。大きいdataはrequest上限（会話1
  MiB等）があるためargumentsでなくfile渡しが妥当。
  - core変更なしのprobe: 外部hookで成立する。`after_tool`で結果とidを保持し、`before_tool`で参照を
    file path等の小さい引数へ置換、`runtime_start`のcontext additionで案内を追加する。hook contextの
    transcriptはcommitted済みの過去turnのみ（当turnの結果は見えない）ためhook自身が保持する。
    引数書換時はloopがeffective arguments全文をresultへ付記するため、注入はpath等に限る。
  - core最小形: 結果artifact（file materialize・id・上限・清掃）と`run_typescript`等への参照引数。
    既存precedentは`web_fetch`の`save_to`と`bash`のredirect。
- どのルートでも決めること: 参照可能な範囲（当turn/実行/Worker世代）、上限・eviction・清掃、
  credentialをworkspaceやDataへ書かないこと、参照元のsidecar/attribution、不在・期限切れの明示error、
  TUIの参照表示。
- 可視サイズの実測（2026-10-06）: bashのmodel可視出力はstreamあたり4,096
  bytes（`MAX_CAPTURE_BYTES`）で 打ち切られ、残りはspoolへ保持される（32 MiB/command、128
  MiB/registry）。`bash_output`は`totalBytes`と 任意offset（UTF-8境界）を受け、49,152 bytes
  windowで末尾も読める。readは64 KiB/call、searchは既定100件/page。 今回の実測は`deno test`（2
  file・41 test）4,998 bytes、`git status --porcelain` 2,502 bytes、`grep -rn` 1,565 bytes、
  `cat .handoff/handoff.md` 12,239 bytes（可視4 KiB＋readback）。
- 効果の見込み（再評価）:
  打ち切られた結果を後段へ渡す需要より、「打ち切られず全部読めるfileを作り、集計だけを
  contextへ返す」需要が実態に合う。`web_fetch`は`save_to`（workspaceまたは`/tmp`、既存fileは拒否）で
  本文をfile化し、結果は`Saved: <path> … Bytes:`の小さいtextだけになる。同じ形を`bash`のredirectでも
  使えるため、新機構の優先度は下げ、既存primitiveの案内と`bash_output`の末尾offset利用を先にする。
  `read→run_typescript`はrun_typescriptが既にfileを読めるため利得小。本命だった`bash`/`search`→
  `run_typescript`も、上記のfile経路と末尾readbackで多くは足りる。
- pipe回避の既存実例（2026-10-05 Session `2bc2699f`、2026-10-06にread-only分析）:
  `… > log 2>&1; result=$?; tail -n 8 log; exit "$result"`の形が39件あり、対象実行では非0 exit
  10件が
  正しく伝播していた（pipeでtailへ絞る場合と違い失敗が見える）。file化＋尾の表示＋exit再送は、
  新しい機構なしで成立する代替の実例である。
- 関連: [Increment 200](../increments/increment-200.md)、`v0/agent/tools/run_typescript.ts`、
  `v0/agent/tools/bash_output.ts`、R2、R3。

### A31 — workspace外（config/state/tmp）の読取・書込境界（未採用、メモのみ）

- 観測（2026-10-06）: 専用toolはworkspace内に限定される（`checkedPath`、`run_typescript`実行Workerの
  permissionはworkspaceと`/tmp`）。workspace外の確認はbashが必要で、実際に今回はAgent自身の実効
  instructionを確認するためconfig rootの`instruction.md`をbashの`cat`で読んだ（`read`は 「path must
  stay within workspace」で拒否）。
- 採用済み（2026-10-06、[Increment 204](../increments/increment-204.md)）: `run_typescript`はconfig
  rootを
  read/writeでき、`henjiConfigRoot`変数を受け取る。credential値はstate配下の専用rootへ分離し、
  同toolからread/writeとも不可（`deny`監査は設定可能）。採用した要件・前提・残る範囲は204を参照する。
- 残る候補: workspace外のHost-owned root（config/state）を`read`・`search`等の専用toolでも明示pathで
  読めるようにする案と、現状どおりbash併用を案内で明示する案を比較する。広げる場合は対象root、
  credential fileの扱い、表示・履歴への波及を採用時に決める。
- 再検討条件: 通常利用でworkspace外の確認・一時file作成が繰り返し必要になり、bash併用の使い分けが
  負担・誤用の原因になるとき。
- 関連:
  A5、A30、204、`v0/agent/tools/work_tool_workspace.ts`、`v0/agent/tools/run_typescript_executor.ts`、E1。

### A34 — 再起動後の続行セッションで新規toolがmodel定義に現れない疑い（未確認）

- 観測（2026-10-06、Session `91cb1f45`）: Core/TUIを再起動（新binary build `5bfcdbaa`・source
  `6f6f9a6a`、Core `c6afea6d`、`henji tui --continue`）した。
  - config側: `tool list`に`git_inspect`、`agent inspect`はdefault・reviewerともrejections `[]`
  - 実行側: `search`の`entries`
    mode（local-3）は**このセッションで動作**した（type/bytes/modifiedAtを返した）
  - しかし新規tool名`git_inspect`は**このセッションのtool呼び出しとして発行できなかった**（複数回試行したがbashへ
    落ちた）。
- 追試（2026-10-06、利用者指示により実行を試行）:
  同じセッション・同じWorkerで`git_inspect`の呼び出しを発行できなかった
  （複数回試行、いずれも発行不能。同じWorkerの`search`は`entries`
  modeが動作した）。config側のrejections `[]`と 呼出し不能の観測だけでは、当該requestのmodel-facing
  tool定義に`git_inspect`が無かったとは確定できない。
- 当時の仮説（未確認）: model-facing
  tool定義がSession開始時のbinaryで固定され、`--continue`では新しいtool名が
  追加されない可能性を考えた。同名toolの新機能が使えたことは観測だが、定義の固定を証明するものではない。
- 現行source照合（2026-10-07）: `core/loop.ts`は各model
  requestへ現在の`registry.definitions()`を渡す。
  Worker起動時は現在fileからtoolを構成し、保存Sessionの過去snapshotを現在のtool定義として使う契約ではない。
  当該実WorkerのRegistryとmodelへ実提示した定義は未取得であり、原因と仮説の成立は未確認のままである。
- 利用者影響:
  再起動しても、新規追加toolを既存セッションの続きでは使えない可能性がある。新規セッションなら
  使える見込み（未確認）。
- 次の確認: 新規Sessionと続行Sessionのtool提示・呼出しを比較し、再観測時は当該Workerの構成とmodelへ
  実提示したtool名を確認する。実provider callを伴う追試は別途明示承認を得る。
- 再検討条件: 利用者が新規セッションで確認するとき、または同現象が再観測されるとき。
- 追加確認（2026-10-06）: Core API（`/api/v1/*`）には実行中Workerのtool一覧を読む経路がない。
  隔離XDGで起動したcompiled binaryのTUIではconfiguration rejectionのnoticeが出なかった。
  `search`の`entries`は続行Sessionでも動作したが、当該実Workerの`git_inspect`提示確認とは分ける。
  利用者判断でSessionを作り直して新規Sessionで確認する方針とした。本項目にはその確認結果の記録がない。

### A35 — 子agentの時間上限と期限での自動キャンセル（未採用、メモのみ）

- 利用者の希望（2026-10-06）: reviewの時間上限を`spawn_subagent`の`task`へ書く方法を確認した後、
  「キャンセル作りたいな、メモしておいて」と指示した。
- 現行境界: `spawn_subagent`に時間上限の引数はなく、`task`内の時間指定はmodelへの指示に留まる。
  `collect_subagent`にもtimeout引数はなく、子agentの終了を待つ。手動の`cancel_subagent`は既存。
- 候補: 子agentに時間上限を設定し、期限に達したらruntimeから既存のキャンセル経路を呼ぶ。
  親agentが`collect_subagent`で待機中でも期限で停止できるようにする。
- 未決定: 設定方法・引数名、時間の起算点、期限による停止理由と途中結果の返し方。
  個別incrementへの採用・実装はまだ行わない。
- 再検討条件: 利用者がreview等の時間上限をruntimeで実行する機能の採用を指示するとき。
- 関連: A24、`v0/agent/tools/async_agents.ts`、`v0/agent/worker/worker_host_children.ts`。

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
- 現行境界（2026-10-07、source照合）: [Increment 170](../increments/increment-170.md)で
  record組立て・保存はAgent
  Data側へ移り、[Increment 199](../increments/increment-199.md)で採用portを 新message
  suffixへ絞った。`session_authority.ts`の`proposalSuffix`はnextTurn、既存会話以上の
  transcript長、新suffixの因果構造と1 turnであることを検証し、不合格なら`undefined`を返す。
  `session_data_owner.ts`の`prepareProposal`はこれを`commit proposal invalid`としてthrowする。
  不合格項目・値の形を返す経路はなく、元の却下原因も未特定である。
- 対応済みの境界: 自動入力復元と停止理由の上書きはIncrement 85／97で解消した。
  却下proposalのtranscriptを保存・readbackする経路は181のhistory.sqlite3（schema
  1）へ接続されており、 原観測時の「却下transcriptをDBから読めない」は現行storeの制約ではない。
  [Increment 176](../increments/increment-176.md)でWorker／Data／commitの例外に取得可能な処理段階・
  例外種類・短いmessage等を残すが、項目別の検証不合格理由は提供していない。
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
