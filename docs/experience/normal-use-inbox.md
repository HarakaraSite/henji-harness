# 通常利用メモ

Henjiの通常利用で得た観測と、まだ個別Incrementへ採用していない改善候補の入口である。

- ここへの記載は採用、優先順位、実装認可を意味しない。
- 個別Incrementへ採用した項目はその正本へ移し、この一覧から除く。
- 長い実行証拠、参照実装比較、完了経緯は、increment、research、architecture等の担当正本へ置き、
  ここには候補を選ぶための現在の観測、候補、再検討条件だけを残す。
- 一覧IDは文書内の参照用であり、順序や大小は優先度を表さない。

## 候補一覧

| ID | 領域 | 候補 | 再検討の主な契機 |
| --- | --- | --- | --- |
| S2 | Surface | Henji内credential登録 | Provider外部化の計画を採用する |
| S4 | Surface | `/rebuild`によるAgent context再構築 | 改訂したinstructionやskillを現Sessionの後続executionへ適用する必要が出る |
| S8 | Surface | startup headerのMCP欄（複数行対応の予約） | MCP接続managed resourceが採用され、header表示が必要になるとき |
| S10 | Surface | 入力履歴のセッション横断保存とsnippet | 再起動後・別Sessionでも同じpromptを再利用したいとき |
| S14 | Surface | ツール呼び出しに添えたassistant本文の履歴表示 | 作業途中の発話を後から時系列で読みたいとき |
| S16 | Surface | 通常実行中の出力を一行ずつ追える表示 | 生成中の表示がまとまって現れ、進行を追いにくいとき |
| A1 | Agent実行 | ChatGPT subscription root provider | subscription利用がproduct要件になる |
| A2 | Agent実行 | Host操作のmodel向けtool化 | AIがSession列挙やcontext rebuildを実際に必要とする |
| A3 | Agent実行 | Context Strategyの外部化 | 長期Sessionのtoken usageとcontext品質を実測で比較できる |
| A5 | Agent実行 | ambient repository contextの配送 | workspace探索やtask targetの誤認が再発する |
| A6 | Agent実行 | Web searchのsearch/fetch/backend境界 | 対象発見と本文取得の混在が調査品質・コストを損なう |
| A8 | Agent実行 | OpenRouter Responses API経路 | 利用者希望（2026-09-17）。E1のProvider外部化と合わせて検討 |
| A9 | Agent実行 | 診断記録の保存期間 | 保存期間を独立に決める必要が出たとき。粒度変更の計画はIncrement 121 |
| A10 | Agent実行 | モデル別instruction | 同じ目的のtaskでモデル間の探索・報告の差を改善したいとき |
| A11 | Agent実行 | instructionの与え方 | 指示の粒度や配置によってtaskの完了挙動が変わるとき |
| A12 | Agent実行 | semantic履歴の保存粒度と容量 | 長期Sessionの履歴DB容量やreadback負荷が利用上の問題になったとき |
| A13 | Agent実行 | 無名サブエージェント（仮称）と起動時モデル指定 | 名前付きDefinitionを準備せず、taskごとにモデルを選んで子Agentへ任せたいとき |
| A14 | Agent実行 | 名前付き子Agent Definitionの専用model指定 | reviewerなどを親Sessionとは別のmodelで動かしたいとき |
| R1 | F24 | 自己改訂対象の重心とagent loop境界 | Self-revision Cycleの最初の実証対象を選ぶ |
| R2 | F24 | revision付きtool componentとMCP | tool candidateを生成・保存・採用するflowを設計する |
| R3 | F24 | tool実行profileとsandboxed Deno program | trusted-local以外の実行環境をproduct要件にする |
| R4 | F24 | instruction componentのrevision化 | instructionを自己改訂candidateとして採用する |
| E1 | 配布・外部化 | Agent Definition後のresource外部化 | 利用者希望（2026-09-17）のProvider外部化。A8と合わせて検討 |
| E2 | 配布・外部化 | 追加managed resource kind候補（未採用） | 各kindを通常利用で更新・pin・transport・activationする必要が出る |
| E3 | 配布・外部化 | Host runtime tunablesの設定ファイル化 | provider timeout・tool限界・maxSteps既定などを通常利用で調整したくなるとき |
| E5 | 配布・外部化 | 追加protocol adapter候補（Anthropic Messages／Google／Azure OpenAI） | 該当providerを通常利用で使う必要が出るとき。Increment 101のauth/header一般化を前提にする |
| E6 | 配布・外部化 | providerからのmodel一覧取得 | model選択でproviderの現行一覧を使いたいとき |
| P1 | 参照実装parity | `henji run`の構造化出力（`--json` event stream／`--stream`） | 非対話実行の自動化・埋め込みが必要になるとき |
| P3 | 参照実装parity | 手動`/compact`（checkpoint/compactionの人間起動） | context圧縮を人間が明示的に行いたくなったとき |
| P4 | 参照実装parity | Session export/import | Sessionを別installationへ移す・再開する必要が出るとき |
| P5 | 参照実装parity | `@file` reference（内容注入） | 人間がfile内容をmodel turnなしでcontextへ入れたいとき |
| P6 | 参照実装parity | model cycling shortcut | provider横断のmodel切替を頻繁に行うとき |
| P7 | 参照実装parity | `henji sessions prune` | 古いSessionの整理が必要になるとき |
| P8 | 参照実装parity | configurable keybindings | keybindingを利用者ごとに変えたくなったとき |
| P9 | 参照実装parity | 画像入力（`@image`／clipboard paste） | 画像を扱うtaskを通常利用で行うとき。transcriptのimage part・provider別encoding・表示・catalog capabilitiesが必要 |
| P10 | 参照実装parity | 外部agent interface（双方向server/RPC／ACP） | editor/IDE統合や別agentからの対話的駆動が必要になるとき。P1はその一段目 |

## Surface

### S2 — Henji内credential登録（F01、F02、F10）

- 観測: API keyをHenji内のslash commandから登録したい。
- 利用者判断（2026-09-12）: built-in二providerに固定した登録UIは先行実装しない。Provider外部化と
  同時または直後に、external Providerが宣言する非secretなauth profile identity、Host-owned credential
  registry、TUIの登録対象catalog、request時解決を接続する。credential値はDefinition、transport package、
  Session、evidenceへ含めない。
- 候補: secretを通常のinput buffer、会話履歴、process argumentへ残さない入力、auth profile選択、fixed
  credential fileの更新と結果表示を設計する。
- 利用者判断（2026-09-22）: 欲しくなってきた。優先度を上げる（Provider外部化はIncrement 58〜68／101で
  成立済みなので、E1の前提は満たしている）。
- 再検討条件: E1でProvider外部化を採用すること（充足済み）。

### S4 — `/rebuild`によるAgent context再構築（F01、F03、F08、F10、F11、F27）

- 観測: Henjiはworkspace instructionとskill catalogをWorker generation開始時にsnapshot化するため、改善した
  instructionや新しいskillを現在Sessionの後続executionへ適用するには新しいgenerationが必要である。目的は
  fileを再読込することだけでなく、改訂後のresourceからAgent側の基底設定を再構築することであるため、
  command候補名を従来の`/reload`から`/rebuild`へ変更した。
- 利用者判断（2026-09-13）: 少なくとも`AGENTS.md`と個々のnative Skillは、Session内の人間操作から後続execution
  に対して有効化・無効化できるようにしたい。他resourceを同じ操作対象に含めるかは個別に検討する。過去executionの
  attributionは変更しない。選択状態をSessionへ永続化するか、操作と`/rebuild`の順序、既定の有効状態は未決である。
- 候補: 人間の`/rebuild`で、対象として定めたresourceから新しい`AgentContextGeneration`を構築し、現Session、
  canonical conversation、未送信draft、過去executionのattributionを維持したまま後続executionへ適用する。
  最初の対象では`AGENTS.md`とnative Skillの有効・無効selectionを扱い、Agent Definition、tool、将来componentは
  対象kindとして採用するまで含めない。context generationとWorker generationを同じidentityにすることも決めていない。
- 再検討条件: instruction等を改善した通常利用で、Henji自体を終了せず同じSessionの次taskへ適用したい事例が
  得られること。個別incrementでは対象resource、selection/activation authority、transitionのcommit/failure
  semanticsを決める。
- 関連: A2、R4、E1、
  [`terminal-markdown-rendering-comparison.md`](../research/terminal-markdown-rendering-comparison.md)、
  [`durable-history-and-context-rebuild.md`](../roadmap-inputs/durable-history-and-context-rebuild.md)、
  [`externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)。

### S8 — startup headerのMCP欄（F01、F10）

- 観測（2026-09-19、通常利用メモ）: MCP接続は将来のmanaged resource候補だが、startup orientation
  （`startupHeaderLines`）に表示欄がない。
- 採用済み（Increment 82）: `base:`→`base instruction:`表記と`skills:`複数行折り返しを実装し、ラベル付き値の
  複数行描画を`headerContentLines`へ分離した。
- 候補: 将来のMCP接続managed resource用に、複数行対応の`mcp:`欄を`headerContentLines`で追加する。
  表示対象のresourceが採用されるまでは欄自体を実装しない。
- 再検討条件: MCP接続managed resourceが採用され、headerで接続状態や数を示す必要が出るとき。
- 関連: `v0/tui/startup_render.ts`、`v0/presentation/contract_types.ts`。

### S10 — 入力履歴のセッション横断保存とsnippet（F01、F10）

- 観測（2026-09-19）: 入力履歴（`v0/tui/input_history.ts`）はTUIプロセス内のみで、再起動や別Sessionで消える。
  繰り返し使う常用prompt（調査手順・レビュー依頼等）を毎回入力している。
- 候補: 入力履歴をworkspaceまたはuser scopeへdurable保存する、または名前付きprompt（snippet）を明示保存して
  `/snippet <name>`等で呼び出す。保存先・scope、Session横断の範囲、credential等secretを履歴へ入れない境界、
  呼び出しUIを採用時に決める。
- 再検討条件: 再起動後・別Sessionでも同じpromptを再利用したい実例が通常利用で得られるとき。
- 関連: `v0/tui/input_history.ts`、roadmap F01。

### S14 — ツール呼び出しに添えたassistant本文の履歴表示

- 観測（2026-09-24、session `a2098f7c`）: モデルがツール呼び出しと一緒に返した
  `Now the production TUI verification ...`のようなassistant本文は、TUIに一時表示されるが、同じturnの
  後続発話や最終回答で表示行が置き換わる。元の本文は実行記録に残る一方、通常のTUIログと
  `henji history --view session`では後から読めない。
- 候補: この確定した途中発話を、対応するツール呼び出しの前に、人間が時系列で読み返せるようにする。
  最終回答や`thinking>`とは区別し、表示先とラベルは採用時に決める。stream中のprogress断片を
  一件ずつ保存・表示する話ではない。
- 再検討条件: ツール使用の意図と実際の結果を、通常の履歴から後で追いたいとき。
- 関連: `v0/tui/state.ts`、`v0/agent/history/history_view.ts`、F05。

### S16 — 通常実行中の出力を一行ずつ追える表示

- 観測（2026-09-24）: 利用者はPi等のように、通常実行中の出力が一行ずつ進む見え方を希望した。Henjiは
  assistant本文を進行中に更新する一方、thinkingはproviderから断片を受け取ってもmodel step終了時に
  まとめて表示する。現行TUIは更新のたびに画面を再描画する。
- 候補: 通常実行中の出力を生成に合わせて追える表示を検討する。thinkingの途中表示と画面全体の描画方式は
  変更範囲が異なるため、採用時に必要な見え方を決める。保存Session復元時の逐次再生は含めない。
- 再検討条件: 通常実行中に出力がまとまって現れ、進行を追いにくいと感じたとき。
- 関連: `v0/agent/core/loop.ts`、`v0/tui/tui_renderer.ts`、`v0/tui/state.ts`。

## Agent実行

### A1 — ChatGPT subscription root provider（F02、F06）

- 観測: Increment 17で公式Codex境界、非公開ChatGPT Codex backendのdirect route、参照実装、OSS支援方針を
  調査した。技術候補はあるが、現在のHenjiに必須でないため利用者判断で延期した。
- 候補: subscription対応を再採用する場合は、OpenAIの最新公式contractと現行参照実装を再確認し、
  新しい個別Incrementを作る。
- 再検討条件: existing provider routeではなくsubscription利用がproduct要件になること。
- 正本: [`increment-17.md`](../increments/increment-17.md)。

### A2 — Host操作のmodel向けtool化（F02、F06、F10、F27）

- 観測: `/rebuild`や`/sessions`の意味操作は、人間だけでなくAIが作業中に使う価値もある。
- 候補: slash command文字列をmodelに擬似入力させず、Host-owned application serviceへ型付きcommand
  handlerとtool handlerを接続する。read-onlyな一覧/詳細取得と、Session切替・context rebuildのように
  呼出元のcontextを置き換える操作を分ける。後者はtool result前に呼出元を破棄せず、次turn予約、Host
  control event、turn完了後の切替等の順序を定める。
- 再検討条件: AIがSession列挙・詳細取得・選択、またはcontext rebuildを実taskで必要とすること。
  UIだけに意味があるcommandや人間の明示選択が目的のcommandまで一律にtool化しない。
- 関連: S4。

### A3 — Context Strategyの外部化（F02、F06、将来のF24候補）

- 観測: 64 KiBでのtool-result機械的省略とpre-turn automatic semantic compactionの停止はIncrement 29で
  採用済みである。将来のcompactionは容量対策だけでなく、何を覚え、捨て、抽象化するかを決める
  Context Strategyとして扱う必要がある。
- 候補: 発動判断、対象選択、保持予算、semantic summary、model、failure方針、結果説明を交換可能な
  component境界にする。Agent Definitionに選択させても、canonical transcript、checkpointの永続化と相関、
  tool call/resultの因果構造、credential、provider evidence、strategy結果の採否はHenji-owned境界に残す。
- 再検討条件: 長期Sessionの実token usage、provider/model context契約、turn中/間checkpointを比較できる
  利用証拠が得られること。
- 正本: [`increment-29.md`](../increments/increment-29.md)は既に停止した挙動と維持するcheckpoint境界を定める。

### A5 — ambient repository contextの配送（F02、F06）

- 観測: Increment 37 Human Gateで、local target未指定の外部調査taskに対し、modelがworkspaceのGit remoteと
  handoffを探索し、ambient repositoryから得たForgejo hostをtask targetとして扱った。repository情報を
  知らないための探索と、repository contextを過剰にユーザー指定targetへ結び付ける問題を分ける必要がある。
- 候補: Hostがworking directoryのrepository root、VCS種別、非secretなcanonical identityをambient contextとして
  配送する。それはtask targetではなく、ユーザーが「このrepository」等と結び付けた場合だけsourceとして
  扱う。credentialやremote URL内の認証情報は含めない。
- 再検討条件: 外部product名だけのtaskでambient remoteをtargetにする誤認、またはrepository identityを得る
  ための不要なtool探索が再発すること。
- 再観察（2026-09-22、`henji run --json`、`opencode-go-chat`/`deepseek-v4.1-flash`、workspace=henji repo、
  task「Giteaの直近10件のPRを教えて」、1 turn）: tool sequenceは`web_fetch`（GitHub API）→`web_search`で、
  ambient workspace探索（`bash git remote -v`、handoff読み）は0回、ambient Forgejo remoteをtargetにする
  誤認もなし。credential探索もなし。**この条件では再現せず**。留意: 1 model/provider・知名度の高いproductで
  の観測。Increment 37のmodel/provider（openrouter経由）や知名度の低いproductでは未確認。
- 状態（2026-09-22）: 利用者判断で継続して要観察。trigger未発火のため実装しない。
- 正本: [`increment-37.md`](../increments/increment-37.md)が観測した実行証拠と完了判断を保持する。

### A6 — Web searchのsearch/fetch/backend境界（F02、F06、将来のF24候補）

- 観測: Increment 7〜9でHenji-owned `web_search`、OpenRouter Sonar backend、groundingと直接URL citationを実装・
  production受入済みである。現行は一つのmodel-facing tool内でSonar backendがmodelを使う。
- 候補: 対象identity/canonical URLを発見する`search`と、指定URLの本文・公開API responseを正確に取得する
  `fetch`を分ける。取得内容とcitation/provider evidenceの相関、追加stepと経路の明示性を実taskで比較する。
  canonical API確定後の一回の`curl`は対象外で、filesystem探索、複数endpoint試行、shell quoting、temporary file、
  別commandでの再読込が連なる発見・取得経路が主対象である。
- backend候補: OpenAI Responses API built-in Web searchとOpenRouter `openrouter:web_search`を一つの
  `WebSearchBackend`境界へ追加できるか、現行Sonarと比較する。modelに実装名の異なるtoolを無条件に並べない。
  同時公開するなら品質、費用、検索範囲等で選択理由を説明できる別contractにする。
- 再検討条件: searchとfetchの混在、または現backendの品質/費用/取得範囲が具体的に問題になること。
  Web search自体をAgent Definitionにするかは、conversation、prompt、model、tool利用を独立所有する必要が
  出たときだけ比較する。

### A8 — OpenRouter Responses API経路（F02、F06、将来候補）

- 観測（2026-09-13）: 現行HenjiはOpenAI directだけをResponses API adapterへ接続し、OpenRouterは
  Chat Completions互換APIの独立adapterを使う。
- 利用者希望（2026-09-17）: 現状のOpenRouter経路をResponses APIへ変えたい。あわせてProvider設定を外部化したい
  （E1）。
- 候補: OpenRouterでもResponses API経路を選べるようにする。現行OpenRouter経路の置換か併設か、Responses固有の
  input/output item、tool continuation、reasoning state、stream event、evidence、model対応範囲をどう扱うかは、
  採用時に最新のOpenRouter公式contractと実provider応答を確認して決める。
- 再検討条件: OpenRouter経由でResponses固有機能を使う必要が出る、またはOpenAI directとOpenRouterで
  Responses transportを共通化する具体的なproduct上の利点が得られること。利用者希望によりE1のProvider外部化と
  合わせて採用を検討する。

### A9 — 診断記録の保存期間（実施未定）

- 診断記録の粒度と通常時の収集・保存処理の縮小はIncrement 121の計画へ採用した。約3万件／4.5万件の
  観測とその判断も同文書を参照する。
- 元の記録をいつまで保存するかは別の判断として残す。現時点で自動削除期間を決めない。
- 再検討条件: 保存期間を利用上の必要性から独立に決める実例が得られたとき。

### A10 — モデル別instruction

- 観測（2026-09-23）: 別Sessionで同じsystem instructionを受けたREADME二言語版の比較依頼に対し、
  `deepseek-v4.1-flash`は`effort=high`を送ってもツール使用を続け、15回目のprovider request中にキャンセル
  された。`glm-5.3-flash`は3回目で回答した。task文面には軽微な差があり、この一例だけでモデル差を
  唯一の原因とは断定しない。
- 追加観測（2026-09-23）: 別Sessionの同種の短い依頼に、`gpt-5.6-luna`は4回、`grok-4.7`は6回の
  provider requestで回答した。両者は`opencode-go-responses`経路、DeepSeekとGLMは`opencode-go-chat`
  経路であり、モデルとAPI経路の差は切り分けていない。
- 追加観測（2026-09-23、session `c15dee05`）: `openrouter-responses`経路の同じDeepSeekモデルでも
  `effort=high`で2ファイルを読んだ後に10件のbash比較を続け、13回目のprovider request中にキャンセルされた。
  TUIでは10件とも先頭行の`cd /home/agent/projects/henji-harness`だけが見えるが、実際のbash本文はそれぞれ異なる。
- 再観察（2026-09-24、session `677dbc65`）: `deepseek-v4.1-flash`によるREADME二言語版比較は最終回答まで
  完了した。通常履歴では13件のtool行と9件のthinkingを確認した。9件のassistant messageすべてに
  `reasoning_content`が保存されており、Increment 119で追加した同一provider・modelへの再送経路が適用される。
  以前の途中キャンセルから完了に変わった一因として、この再送が有力である。今回の実行だけでは寄与度や
  ツール使用回数への効果は切り分けられない。
- 利用者希望: モデル別のinstructionを検討する。候補は、指定された対象の調査を終えて結論を報告する条件を
  モデルごとに補うこと。共通instructionとの役割分担は採用時に決める。
- 再検討条件: 同じ目的のtaskで、モデルごとの探索範囲や報告までの挙動に差が出ること。

### A11 — instructionの与え方

- 観測（2026-09-23）: DeepSeekは短いREADME比較依頼ではツール使用を続けたが、対象ファイル、比較項目、
  追加調査の条件、報告する時点を明示した指示では、2回のprovider request（2件の`read`）で回答した。
- 利用者希望: instructionの内容・粒度・与える場所（共通instruction、モデル別instruction、個々のtask）を
  検討する。短い依頼から目的に合う作業範囲と終了条件を組み立てられるかを実利用で比較する。
- 再検討条件: 指示の与え方を変えると、同じ目的のtaskの完了挙動が変わること。

### A12 — semantic履歴の保存粒度と容量

- 観測（2026-09-24、session `a2098f7c`）: 6実行（確定4、停止2）でsemantic履歴は4,693件、
  `semantic_occurrences.payload_json`の合計は約10.5 MB。確定会話は240メッセージ、約513 KB。
  workspaceの履歴DB全体（4 Session）は本体24.1 MiBとWAL 4.5 MiBだった。DBの保存量は次のmodel
  requestへ送るcontext量とは別である。
- 現行用途: `history`と`/recall`のため、toolの順序・引数・結果、runtime outcome、request単位のfact、
  停止実行の証拠を保持する価値がある。一方、現在の4,693件すべての保存粒度が必要かは未判断。
- 候補: 容量の大きいsemantic種別と重複を測り、通常履歴のreadbackと`/recall`が使う情報を保ったまま
  記録量を減らせるか調べる。保存期間を決めるA9とは分け、現時点では削除・縮小を採用しない。
- 再検討条件: 長期SessionでDB容量や履歴readbackの負担が実利用上の問題になったとき。

### A13 — 無名サブエージェント（仮称）と起動時モデル指定

- 利用者希望（2026-09-24）: Codexのように「gpt-6-lunaでこのtaskの子Agentを起動」と依頼し、用途やモデル
  ごとに名前付きAgent Definitionを用意せず委譲したい。「無名」は事前登録する`agent:<name>`が不要という意味の
  仮称で、実行を参照する`runId`まで無くす意味ではない。
- 現行境界: `spawn_subagent(agent, task)`は親Definitionが宣言したcatalog名だけを受け付け、起動ごとのmodel
  引数はない。組み込み`planner`の実行用DefinitionはIncrement 127で除去した。Hostから子Workerへ
  `ModelSelection`を渡す経路自体は既にある。
- 候補: 既存の名前付き子Agentへの起動時モデル指定と、任意task向けの汎用子Agentを事前の名前付き登録なしで
  起動する動作を分けて検討する。後者では一つの組み込み汎用Definitionを基底にでき、モデルごとのDefinitionは
  要らない。provider／model／effortの選択方法、子のinstruction・tool構成、既存の名前付きcatalogとの関係は
  採用時に決める。
- 再検討条件: 通常利用で、モデルや用途を変えるたびにDefinitionをinstall・bindする負担、またはplanner以外へ
  その場で委譲できない不便が現れたとき。
- 関連: `docs/architecture/henji-host-agent-worker.md`のasync agent catalogとchild execution。採用時には
  `spawn_subagent(agent, task)`および子model選択のarchitecture変更を別途判断する。

### A14 — 名前付き子Agent Definitionの専用model指定

- 利用者希望（2026-09-25）: 外部`reviewer` Definitionにreviewer専用のmodelを定義し、親Sessionのmodelと
  独立に動かしたい。起動ごとにmodelを任意指定するA13とは別の要望。
- 現行境界: `agents/reviewer.ts`は役割instructionとtoolを定義するが、`createAgentComposition`にmodel指定
  optionはない。session `b3aa7c49`では親とreviewerがともに`opencode-go-chat / mimo-v2.6-pro`で実行された。
  子Workerへ渡すmodelは現在、Hostが親を開いたときの`initialModelSelection`から決まる。
- 候補: 外部Agent Definitionが子実行の既定model選択を宣言し、Hostが子Worker起動時にその選択を適用する。
  親Sessionの選択や将来の起動時指定との優先順位は、採用時に決める。
- 再検討条件: reviewerなど名前付き子Agentを親と異なるmodelで通常利用するとき。

## F24・自己改訂

### R1 — 自己改訂対象の重心とagent loop境界

- 利用者の仮説: Agent Definition、とくにrole定義はmodel能力への依存が大きく、有用なvariationも多くない
  可能性がある。Definition variantの増加自体を自己改訂の中心にしない。tool定義と実装、作業方針、
  instruction、policy、workflowの方が改善余地を観測しやすい。
- 現行境界: `AgentDefinition`はmodel、instruction、tool/skill/subagent resource identity、`maxSteps`を選ぶ
  composition envelopeである。「外部対象ならweb search」のような判断規則はinstruction/workflow、人間gateは
  Host/Surface側のadmissionに置ける。tool executionの並列化、自動dispatch、turn確定条件を変える場合は
  runtime/loop semanticsの改訂になる。
- 候補: 最初の自己改訂実証はDefinition sourceの変更だけでなく、tool componentまたは作業方針componentの
  candidate生成、差分確認、人間による採用、通常利用への反映を対象とする案を比較する。Definition、tool、
  instruction/policy/workflow、core loop、Host enforcementのrevision boundaryを、どの経験から改訂するか
  判断できる単位にする。
- 不変条件: candidateの採用は人間の明示操作・承認に限定する。candidate自身にこの境界を外させない。
- 再検討条件: Self-revision Cycleで最初のcandidate kindと採用flowを選ぶとき。
- 調査: [`agent-loop-and-durable-state-comparison.md`](../research/agent-loop-and-durable-state-comparison.md)。

### R2 — revision付きtool componentとMCP component

- 観測: catalog外の新tool identityをexternal Definitionから追加する一般seamと、tool dependency revisionを
  Definition lineageへ固定する境界は未実装である。Exa MCPの採用は却下済みだが、一般的なMCP
  componentは将来候補として残る。
- 候補: tool componentをrevision identity、model向けcontract（name、description、schema、
  `promptGuidelines`）、Worker内でphysical I/Oへbindするexecutorに分ける。Definitionがcomponentを選択・合成し、
  Manifestへresolved revisionを記録する。
- 完了境界候補: component schemaだけではF24の完了とせず、tool candidate生成、revision保存、人間の採用、
  通常利用への反映までをproduct flowとして確認する。
- 再検討条件: Self-revisionのtool candidate、または具体的なMCP integrationを採用するとき。
- 関連: E1。

### R3 — tool実行profileとsandboxed Deno program

- 観測: 現行`bash`はmodelのcommandを`/bin/bash` subprocessへ渡す。Deno公式permissionのとおり、subprocessは
  親runtimeのfilesystem/network permission内に自動で閉じず、OS userの権限で動く。2026-09-07の開発VMには
  `python3`、`apt`、`sudo`とpasswordless sudoがあった。あるturnでpackage導入を選ばなかったことは強制境界の
  証拠にならない。
- 候補: startupの`trusted-local · no hard sandbox`をtrust、tool capability、permission、human gate、
  isolationの独立軸で扱う。read-only、approval-gated、workspace-sandbox、isolated-runner等を構造化profileで
  表し、Agent Definition/tool componentはHost-owned permission ceilingの範囲内だけを選ぶ。
- hard sandboxの条件: `deno run --allow-run`やcommand名の禁止ではなく、subprocess自体をbubblewrap、Landlock、
  container、専用VM等へ置き、workspace mount、他path/credentialの可視性、network、process範囲をHostが強制する。
- 外書き込みの拒否/承認（Codexの`workspace-write`＋outside承認、OpenCodeのpermission model相当）は
  command解析ではなく**sandbox policy**として実装する。command解析型の承認や、bashの破壊pattern
  （`rm -rf /`等）のdeny-netは**sandboxまでの安全帯**であり境界ではない（変数展開・script・interpreter・
  redirect・`curl|sh`等で回避可能）。frictionの大きいapproval gateを常用の前提にしない。安価な大事故低減が
  必要になった場合の選択肢としてのみ残す。
- Deno program tool候補: modelはTypeScript programとdataを渡し、Host/executorが固定permissionで実行する。modelに
  Deno CLI option、permission flag、executor、任意の`deno run`や`--allow-all`、shell起動を制御させない。
- 分類: sandboxed program toolの通常導入はF06の改善として先行できる。経験からexecutor/contractの
  revision candidateを生成・採用するflowまで成立した段階をF24とする。
- 再検討条件: trusted-local以外の実行環境、またはmodel-generated programの制限実行がproduct要件になること。
- 参照: [Deno permissions](https://docs.deno.com/runtime/reference/permissions/#subprocesses)。

### R4 — instruction componentのrevision化と自己改訂

- 現行境界: Henji共通、agent role、active tool guideline、workspace instruction、skill manifest、runtime factsを順に
  合成する。`AGENTS.md`はworkspace固有instructionで、Henji共通/built-in roleは`v0/agent/instructions/`が所有する。
  standalone binaryの静的importはinstructionを埋め込むため、built-in source変更のrelease反映はrebuild/installを必要とする。
- 候補: instruction/policy/workflowをrevision付きresourceとして保存・比較し、candidate生成、人間の採用、
  rollbackの対象にする。named agentがcomponentを選ぶauthoring contract、dependency lineage、複数componentの
  合成順/競合規則/Manifest attribution、standaloneでの書換可能storeとactivation境界を決める。各executionを
  当時使用したinstruction/context attributionへ結び付け、完全再現ではなく振り返りに必要な内容を残す。
  `/rebuild`によるnative resourceの再解決と、managed candidateの承認/promotion/binding transitionを同じoperationへ
  まとめるかは、対象kindを採用するincrementで決める。
- 再検討条件: instructionまたはworkflowをSelf-revisionの対象として選ぶとき。
- 正本: 現行runtime instruction合成は
  [`multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)。
- 関連: S4、E1。

## 配布・外部化

### E1 — Agent Definition後のresource外部化

- 現行境界: standalone executable、Agent Definition専用のmanaged revision store/resolver、portable transportは
  Increment 32〜34で採用・実装済みである。`instruction:henji-base`はIncrement 51でmanaged revisionとして
  導入され、Increment 103でbuilt-in最小core＋user `instruction.md`直接読み込みへ置換された。Agent Definitionで
  得たloader、dependency、promotion、activationのsemanticsをinstruction、tool、Provider、MCP、Surfaceへ
  自動的に一般化しない。
- 未実装境界: catalog外のtool identity、複数slotのinstruction revision化、external Provider registry、互換providerの
  data-only Definition、独自protocolのexecutable Definition、resourceごとのmutable instance state、context rebuild、共通package/plugin
  discoveryは未採用である。Providerは`openrouter-chat`／`openrouter-responses`／`openai-chat`／`openai-responses`と
  external宣言で、auth profileはpattern一般化済み（Increment 101）だが、external Provider registryと宣言の
  exact revision化は未採用である。
- 利用者希望（2026-09-17）: Provider設定を外部化したい。A8のOpenRouter Responses API経路への変更と合わせて
  採用を検討する。
- 候補: resource kindごとにscope/activation owner、execution placement、lifecycle、durability、dependency identity、
  Manifest attribution、mutable stateを決める。Agent、instruction、tool、Providerを同じloaderへ載せる必要が実利用から
  出るまで、共通化を目的にしない。
- Provider候補: 互換providerをdata-only、独自protocol/OAuth/dynamic model取得をexecutable Definitionとして
  分けるか、credential非継承、adapter state、raw SSE evidence、request count、timeout、network permissionのどこまでを
  Henji-owned contractに固定するかを決める。S2のcredential registryと接続する。
- activation候補: LLM-callableなmodule installはcandidate receiptを返して現turnを終え、人間の採用後に次Worker
  generationでactivateする。`define/install -> inspect -> activate/update -> stop/rollback`を分け、新revisionの起動成功後だけ
  current bindingを更新する。
- 分離候補: canonical transcript、provider context projection、外部moduleの作業用stateを同じ保存機構へ混ぜず、
  個別のlifecycleと復元保証で扱う。prompt note、memory、skill reference、subagent specのような軽量補助stateと
  executable code revisionも分けて検討する。
- 再検討条件: instruction、tool、Provider、MCP、Surfaceのいずれかに対し、通常利用で更新・共有・rollback・
  分離実行が必要になること。
- 正本: 採用済みの境界は[`roadmap.md`](../roadmap.md)、
  [`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)、Increment 32〜34。
- 調査: [`externalization-reference-comparison.md`](../research/externalization-reference-comparison.md)。

### E2 — 追加managed resource kind候補（未採用）

- 観測（2026-09-18）: Agent Definition、Henji Instruction、tool Definitionの3 kindがmanaged revisionとして
  存在し、kindごとにref/framing/store/CLI/binding/loadが別実装になっている。「任意kindの一般化」を検討したが、
  Skillは他harness互換のnative `SKILL.md`形式に価値があり、Henji固有revisionとして管理する実利が薄いため
  最初の適用例から外した。その後Increment 103でHenji Instructionはmanaged revisionをやめ、user
  `instruction.md`の直接読み込みへ移行した（現行managed revision kindはAgent Definitionとtool Definition）。
  base instructionのcontent revisionはR4の対象として残る。
- 候補（Henjiが単独でownerになれるcontractに限る）。優先順は未定で、通常利用で必要になった時点で個別incrementへ
  採用する。
  - named subagentの一般化: `agent-definition`（role=subagent）×`subagent:<name>` slotをplanner以外へ広げる。
    独立kindではない。→ 2026-09-18に次のincrementとして採用（increment-72）。
  - provider declaration revision: data-only宣言をexact revision化（pin/transport/activation）。Provider外部化の
    続き。ファイルベースで足りる可能性あり。
  - model profile revision: model/effort/catalog preset。selection presetという別contract。
  - context/compaction strategy revision: generationごとのcontext投影/compaction policy（A3）。設計大きめ。
  - instruction component／policy／workflow revision: base 1つではない複数componentの順序付き合成（R4）。
  - integration declaration（MCP connection）revision: connection/transport/capability（E1）。
  - Surface data/code revision: Host側Surface差し替え（F10/F24）。規模大。
  - Agent loop／runtime policy revision: loop semantics置換。core変更で高リスク。
- framework自体の扱い: 共通kind基盤（ref/framing/store/CLI/binding/loadをkind descriptor化）は、実利用から
  必要になった具体的なkindが決まってから、そのために必要なseamだけ切り出す。仮想的な汎用plugin discovery/loaderは
  現時点で採用しない（architectureの「必要になるまで共通化しない」方針）。
- 再検討条件: 上記候補のいずれかを通常利用で更新・pin・transport・activationする具体的必要が出ること。
- 正本: [`roadmap.md`](../roadmap.md) F24、[`henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

### E3 — Host runtime tunablesの設定ファイル化（未採用）

- 観測（2026-09-19）: 固定値が分散している。provider request deadlineは`DEFAULT_PROVIDER_TIMEOUT_MS`
  （`openrouter_contract.ts`、利用者指示で120,000→180,000へ変更）、assistant maxStepsは
  `DEFAULT_AGENT_MAX_STEPS=64`（`agent_definition.ts`、Definition入力）、toolは`WEB_FETCH_TIMEOUT_MS=30_000`・
  `MAX_WEB_FETCH_BYTES=1MiB`・`BASH_OUTPUT_*_WINDOW_BYTES=49,152`、resource limitsは`resource_limits.ts`。
- 既存のHost configは`$XDG_CONFIG_HOME/henji-harness/`の`default-selection.json`・`providers/*.json`・
  `tools.json`・`agents.json`。
- 2026-09-24のIncrement 126では、provider deadlineを300,000 ms、組み込みAgentの`maxSteps`を128へ拡張し、
  TUIと`henji run`の両方でCLI引数から上書きできるようにした。`runtime.json`は採用していない。
- 候補: `runtime.json`を追加し、厳格schema＋検証でHost runtime tunablesを読む。precedenceはCLI flag > config >
  built-in default。CLI引数を毎回指定する負担が実利用で残る場合は`providerTimeoutMs`を第一候補として再検討する。
- authority境界: `maxSteps`は現在**Agent Definition所有者**であり、Host configに置くと二重authorityになる。
  既定値のHost config化はroadmap F06（loop/context externalization）の判断が必要。provider timeoutは
  Host/provider側なので衝突しない。
- 再検討条件: provider timeout・tool限界・maxSteps既定を通常利用で調整したくなったとき、または別incrementで
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
  - Azure OpenAI: v1 API `https://{resource}.openai.azure.com/openai/v1/`はOpenAI形式で`api-key`header
    またはEntra Bearer。classicはdeployment path＋`api-version` queryが必要でURL/query templatingが要る。
  - AWS Bedrock native: SigV4署名はrequestごとの計算が必要で静的header mapでは表現できない。
- 利用者判断（2026-09-21）: 参考調査のみで当面対応しない。Increment 101でauth profileと宣言headerを
  一般化しておく。
- 候補: 必要になったproviderから、binary-owned protocol adapterを追加する。GoogleはOpenAI互換endpointの
  宣言だけで足りる可能性がある。AzureはURL/query templatingの要否を採用時に判断する。
- 再検討条件: 該当providerを通常利用で使う必要が出るとき。
- 正本候補: `docs/architecture/multi-provider-routing-and-auth.md`、`docs/roadmap.md` F02／F24。
- 関連: E1、Increment 101。

### E6 — providerからのmodel一覧取得

- 現行境界: model選択の一覧は、bundledまたは外部Provider宣言の固定`modelCatalog.entries`を使う。
  `searchModelsFor`はその一覧を手元で絞り込む。
- 利用者希望（2026-09-23）: model一覧をproviderから取得したい。OpenRouterは一覧が非常に大きいため、
  その扱いを検討する必要がある。
- 候補: providerから取得した現行一覧をmodel選択へつなぐ。取得の時点・更新方法と、大きな一覧からの
  検索・絞り込み・表示・選択方法は採用時に決める。
- 再検討条件: model選択でproviderの現行一覧を使う機能を採用するとき。
- 関連: E1、`v0/agent/provider/model_catalog.ts`、`v0/agent/provider/provider_declaration.ts`。

## 参照実装parity（Pi／Zot調査、未採用）

- 観測（2026-09-22、snapshot調査）: Pi（`_refs/pi` commit `08dc60bc…`、0.85.1）とZot（`_refs/zot`
  commit `f60e492e…`）のslash commandとCLI optionを抽出し、Henji現行surface（`v0/tui/slash_command.ts`、
  `v0/agent/cli/henji_cli.ts`、`v0/agent/cli/tui_cli.ts`）と比較した。詳細と全表は
  [`research/pi-zot-command-surface-comparison.md`](../research/pi-zot-command-surface-comparison.md)。
- 有力候補（P1、P3〜P9）: `run`の構造化出力（Pi `--mode json`／Zot `--json`/`--stream`）、手動`/compact`、
  Session export/import、`@file`、model cycling、`sessions prune`、configurable keybindings、画像入力。
- 利用者判断（2026-09-22）:
  - P7 `sessions prune`: 将来採用見込み。削除authority（`--dry-run`・明示confirm）を設計する。
  - P2 `/jump`: 3アクション程度必要でPageUpの方が手軽なため、候補から除外（調査記録には残す）。
  - P5: `@file`（内容注入）のみ候補として残す。`!command`はHost実行経路を増やす割にtool loopと重複するため
    候補から除外（調査記録には残す）。
  - Session tree/fork: 有用性が未確認。採用判断は保留。
  - `/btw` side-chat: Henjiにそぐわないため対象外。
  - `/swarm`: 時期尚早。非同期subagentは同期subagent廃止後の別incrementで採用する（採用済み）。
  - extension/package管理: 将来課題（E2／F24）。
  - credential UI: 利用者が欲しくなってきた。S2の優先度を上げる。
  - messaging bridge: 将来Surfaceの拡張で検討する可能性がある（未採用）。
  - sandbox/permission系: 対象外（R3領域）。
- 対象外: self-update、llama.cpp router、project trust。
- 再検討条件: 各候補の再検討契機は候補一覧の列に従う。通常利用で具体的な不便が観測されたとき個別incrementへ
  採用する。

### P9 — 画像入力（`@image`／clipboard paste、未採用）

- 観測（2026-09-22、参照実装調査）: Piは`ctrl+v`でimage paste、Zotは`ctrl+v` paste（image含む）と
  `inline_images_enabled`を持つ。Henjiのtranscriptはtext-only（`UserMessage.content`は`TextContent`）で、
  画像をtaskへ入れる経路がない。
- 候補: 人間が`@image`／pasteで画像をtaskへ入れる経路。実現にはtranscriptのcontent part、provider別encoding
  （OpenAI `image_url`、Anthropic image block、Gemini `inlineData`）、tool result、TUI表示、model catalogの
  capability（vision）が必要。
- 依存: E5（Anthropic Messages／Google adapter）と、Increment 103で先送りしたcatalog capabilities。
- 再検討条件: 画像を扱うtaskを通常利用で行うとき。
- 関連: E5、A3、S2。

### P10 — 外部agent interface（双方向server/RPC／ACP、未採用）

- 観測（2026-09-22、公式docs調査）: Codex app-serverはJSON-RPC 2.0双方向（stdio/WebSocket/unix、
  thread/turn/item）でrich clientを駆動し、OpenCodeは`opencode serve`のHTTP OpenAPI 3.1 server＋`/event` SSE＋
  `@opencode-ai/sdk`で外部からprogrammaticに制御できる。ACPはeditor/IDE↔agentの標準（JSON-RPC 2.0、
  `session/new|prompt|update|cancel`、`fs/*`・`terminal/*`・permission要求）でZed/JetBrains等が対応。
  詳細は[`research/external-agent-interface-comparison.md`](../research/external-agent-interface-comparison.md)。
- 段階: (1) 一方向structured output（P1）、(2) 双方向server/RPC、(3) ACP（editor統合）。HenjiはHost/Worker間に
  既にdata-only双方向protocol（F12）を持つため、外部interfaceはHost-owned Surface追加（F10）として整理できる。
- 注意: ACPはagentがclientのfs/terminal/permissionを使う前提で、Henjiの自前tool・trusted-local方針との写像が
  非自明。R3（sandbox/permission）とF10の判断に接続する。
- 再検討条件: editor/IDE統合、または別agentからの対話的駆動を通常利用で必要とするとき。
- 関連: P1、F10、F12、R3。

## 観測した不具合（未修正）

- 個別incrementへ採用するまでは修正しない。再現条件、実行証拠、利用者影響をここへ残す。

### B1 — busy表示が更新されない（原因=同期terminal write、increment-74で修正）

- 観測（2026-09-18）: 利用者報告ではtool call結果待ちの間、busy表示（`working`＋spinner、経過時間）が
  更新されない。
- 検証（2026-09-18、installed binary、pty）: 12秒の`bash sleep`待ちで`working 00:00`〜`00:11`（102 frame）、
  `web_search`（ネストSonar request）待ちで`00:00`〜`00:19`と、いずれも継続更新。spinnerも更新、`BLINK_SGR`なし。
  **これらの条件では再現しない**。
  初期の「停止」観測はpty採取側の早期打ち切りによる誤りで、timer callback自体はturn中も実行されていた
  （`__TICK=40`／`__HB=29`、9秒単発timerも発火）。
- 利用者再現（2026-09-18）: Session `375ca4e7`（workspace `/home/masat.guest/src/henji-harness`、state root
  `~/.local/state/henji-harness/v1/967fa641…`）のprompt「denoとnodeを比較したい webで情報を収集して」で
  `web_fetch`中に発生。
- DB観測: execution `8182968c`（turn 2）は217秒。`context_observation`→次`provider_request_start`間に
  **12.2s／18.8s／25.7s**の無観測gapがある。
- ただしDBからweb_fetchの実引数URLと所要時間を算出すると、web_fetchは
  `docs.deno.com/runtime/fundamentals/node/`、`nodejs.org/en/about/previous-releases`、
  `docs.deno.com/runtime/fundamentals/stability_and_releases/`、`docs.deno.com/runtime/migrate/`、
  `deno.com/blog/v2.0`、`betterstack.com/...`等で、いずれも**0〜1.2秒**。gapはweb_fetchではない。
- gap区間は`context_observation`直後から次request開始までで、web_search等のaux requestやprovider待ちの
  可能性。利用者の「web_fetchで起きた」は別の待ち区間を指している可能性がある。
- pty長時間再現（2026-09-18、同じ日本語prompt）: 133秒のturnを通して`working 00:00`〜`02:13`が継続更新し、
  連続frame間の最大gapは0.4秒。**実シナリオでも再現しなかった**。
- tmux再現（2026-09-18、increment-74）: tmux 3.5a内のinstalled binaryで同じ日本語promptの150秒turnを
  `capture-pane`採取すると`working`更新に**10.0s／5.1s／3.6s**のgapを観測。原因は
  `v0/tui/terminal.ts`の`Deno.stdout.writeSync`によるfull-frame同期writeが、遅いterminal consumerで
  main threadを塞ぐこと。**修正済み**（非同期write＋full-frame coalescing、restore時flush）。
- 検証（increment-74）: masterをdrainしないptyでsync実装はevent loopがblock（hung）、非同期実装はtimer継続。
  tmux内source TUIの長時間turn（busy 95秒、および大出力turn 150秒）でbusy表示が継続更新し、最大wall gap
  1.6秒。focused testは`tests/v0/increment_74_terminal_write_test.ts`。
- 正本: [`increment-74.md`](../increments/increment-74.md)。

### B2 — `/sessions`が`session list unavailable`（increment-75で修正）

- 観測（2026-09-18）: `/sessions`でセッション一覧が参照できず`[session list unavailable]`が表示される。実際には
  Session `a75bd052`が存在する。
- 原因（2026-09-18、increment-74で特定）: `sqlite_history_store.ts`の`listWorker()`が、`sessions`表の1件の
  不正record `6e8de261-31a7-4dae-81bf-a7024723aac0`（workspace `967fa641…`、productVersion `0.1.3`の過去
  build、embedded build manifestが現行でvalidation不合格）で`readRecord`が投げる`SessionStoreError
  session_invalid`を全体へ伝播させ、listing全体が失敗する。`skippedInvalid`は`0`固定で不正recordをskipして
  いなかった。実Session `a75bd052`（24 message、2 turn）は同DBに存在し正常に読める。
- 影響: 1件の不正recordで、そのworkspaceの有効なSessionが全件`/sessions`に出ない。
- 修正（2026-09-18、increment-75）: `listWorker()`をrecord単位try/catchし、`session_invalid`のみskipして
  `skippedInvalid`へ加算。他エラーは再throw。原因recordは利用者許可のうえ削除。実DBで`ok 5 skipped 1`→
  削除後`ok 5 skipped 0`。production TUIの`/sessions`で実Session 5件が一覧され`session list unavailable`が
  出ないことを確認。focused testは`tests/v0/increment_75_session_list_skip_test.ts`。
- 残観測（別問題）: 一覧される5件はいずれも保存Definition digestが現行`builtin/default`（`e28fe12a…`）と
  異なり、pickerで`unavailable`表示。exact revision契約による既知の挙動で、resume可否は別途扱う。
- 正本: [`increment-75.md`](../increments/increment-75.md)。

### B4 — 保存SessionのDefinition revision不一致でresumeできない

- 観測（2026-09-18）: increment-75後、`/sessions`は開くが既存Sessionを選ぶと
  `[session resume failed; current session unchanged]`。workspace `967fa641…`の5件はいずれも
  保存Definitionが`builtin/default`の過去digest（`cc214791…`／`e0f2114d…`／`48b09811…`／`c3a72500…`）で、
  現行digest（`e28fe12a…`）と一致しない。
- 原因: `worker_tui_session.ts`の`switchTo`が`recordRefMatches`（保存refと現行Definition refのexact一致）を
  要求し、不一致で`session Definition revision mismatch`を投げる。pickerは`row.mismatch`で`unavailable`表示。
  これはroadmap F18「同じInstanceのDefinition revision bindingを人間の判断でdurableに切り替える」が
  **未実装**（「現行はstartup selectorと保存済みrefが一致する場合だけreopenし、revision transitionを拒否する」）
  ため。exact revision契約による意図的な現状で、B1/B2とは別。
- 影響: bundled defaultのdigestはbuildごとに変わり得るため、Definition変更後のbuildでは過去Sessionを
  resumeできず、canonical履歴を通常利用で引き継げない。構想の「保存されたSessionを選んで利用を続けられる」
  「canonical/non-canonical双方を履歴として参照できる」と緊張する。
- 対応候補（要利用者判断・roadmap/architecture変更を含む）:
  - A. F18（revision transition）を実装し、保存Sessionを現行Definition revisionへ切り替えて履歴ごとresumeする。
  - B. 不一致Sessionはread-onlyで履歴閲覧だけ可能にする（resumeはしない）。
  - C. 現状維持。過去build Sessionは削除する（履歴は失われる）。
- 検討（2026-09-18）: 「閲覧（Workerを起動せず、Definition ref照合なし）」と「継続（現行DefinitionでWorkerを
  起動し、切替を記録。保存refとの一致は要求しない）」を分離する。admission invariantはlive generationの条件で
  あり閲覧には無関係。正本変更は[`increment-76.md`](../increments/increment-76.md)として承認・適用済み。
- 実装（2026-09-18、increment-76完了）: 継続経路を実装。過去build Sessionを`resume failed`なく開き、turn生成で
  `session.definition`が現行digestへ更新され、過去turnのattributionが不変であることを実経路で確認。閲覧は
  pickerの`v`で選択Sessionのhuman historyをread-only overlay表示（active binding不変、Worker非起動）。
- 正本候補: `docs/roadmap.md` F18、`docs/architecture/henji-host-agent-worker.md`のDefinition binding節。

### B5 — `commit proposal invalid`で入力が理由不明のまま自動復元される

- 観測（2026-09-19、利用者報告）: 特に操作していないのに`[recovered input; edit or resubmit]`が表示される。
- 確認（2026-09-19、DB read-only）: Session `54d65ea7`（workspace `967fa641…`、turn 1、task「denoとnodeを比較したい
  情報をwebで集めて比較表と総評をして」）はexecution `e0e9cf4f`で`outcome=contract_failure`／
  `stop_reason=contract_failure`／`error=commit proposal invalid`。provider request 9回（web_search aux 2回を含む
  7 model steps）、14 messages、約5分41秒。
- 原因: `worker_host_session.ts:1826`の`proposalRecord(message)`が`undefined`（`validateSessionRecordV6`不合格）と
  なり`commit proposal invalid`としてfailed settlement。`controller.ts:1772`のrecoverable判定（`contract_failure`）で
  自動`popRecovery()`が走り、入力がeditorへ戻って当該メッセージが出る。元の理由status
  （`agent failure; recoverable input available`）は直後の復元メッセージで上書きされる。
- 制約: `sqlite_history_store.ts:3745`の`durableEventPayload`が`commit_proposal`を`{kind,correlation,nextTurn}`へ
  縮約保存するため**却下されたtranscriptをDBから直接読めない**。`execution_messages.content_digest`は全行nullで
  transcript本文もjoinできない。exactなvalidator不合格理由は未取得。
- 影響: recoverable stopの理由が見えず、原因不明の自動復元に見える。数分走ったturnの成果がcanonical採用されず、
  入力を再投入する必要がある。
- 対応候補（要判断・未修正）: (a) 同じtaskをisolated XDG＋実providerで再現し却下理由を捕捉する、(b) reject時に
  validator不合格理由をdurable diagnosticへ残す、(c) recoverable statusに元のstop理由を残し上書きしない。
- 再現（2026-09-19、isolated XDG・実provider・`openrouter-responses`／`deepseek/deepseek-v4.1-flash`／`high`、
  `agent:run`）: 同じtaskを実行すると`contract_failure`になったが**別原因**で、`model contract failure: provider
  deadline exceeded`（transport/provider_timeout、modelStep 5、steps=5、tools=8、requests=7、diag
  `2f5b0ee4…`）。`proposalRecord`の不合格dumpは発火せず、**`commit proposal invalid`は再現せず**（model出力依存・
  非決定）。同じrecoverable contract_failureのため入力自動復元は同様に起きる。120秒のrequest deadlineが高effort
  のweb調査turnで到達する点は別の観測。
- 正本候補: `v0/agent/worker/worker_host_session.ts`（commit validation）、`v0/tui/controller.ts`（auto-recovery status）。
- 関連: increment-85（自動復元を停止理由表示へ変更）、increment-97（recovery lane削除で`/recover`を廃止）。
- 由来（2026-09-19、git履歴）: 自動復元は後付け。`d00b5129`（2026-08-31）はeditorを空のまま`ready`にし
  Ctrl-Rの明示操作で復元、`b19b5dd2`（2026-09-07）が`controller.ts`の自動`popRecovery()`を追加、`58d908d1`で
  Ctrl系機能キーを削除し以降は`/recover`が明示操作。理由statusを復元メッセージが上書きするのはこの追加による。
