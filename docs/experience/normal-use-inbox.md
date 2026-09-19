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
| S5 | Surface | assistant本文のMarkdown等のrendering | plain textで意味・可読性を保てない表現を扱う |
| S8 | Surface | startup headerのMCP欄（複数行対応の予約） | MCP接続managed resourceが採用され、header表示が必要になるとき |
| S9 | Surface | recovery laneの削除 | laneのブロッキング（submit・navigation不可）が通常利用で問題になるとき |
| S10 | Surface | 入力履歴のセッション横断保存とsnippet | 再起動後・別Sessionでも同じpromptを再利用したいとき |
| A1 | Agent実行 | ChatGPT subscription root provider | subscription利用がproduct要件になる |
| A2 | Agent実行 | Host操作のmodel向けtool化 | AIがSession列挙やcontext rebuildを実際に必要とする |
| A3 | Agent実行 | Context Strategyの外部化 | 長期Sessionのtoken usageとcontext品質を実測で比較できる |
| A5 | Agent実行 | ambient repository contextの配送 | workspace探索やtask targetの誤認が再発する |
| A6 | Agent実行 | Web searchのsearch/fetch/backend境界 | 対象発見と本文取得の混在が調査品質・コストを損なう |
| A7 | Agent実行 | 非同期・並行subagentと結果の合流 | 親が委譲待ちの間にも独立作業を進めたい実taskが得られる |
| A8 | Agent実行 | OpenRouter Responses API経路 | 利用者希望（2026-09-17）。E1のProvider外部化と合わせて検討 |
| R1 | F24 | 自己改訂対象の重心とagent loop境界 | Self-revision Cycleの最初の実証対象を選ぶ |
| R2 | F24 | revision付きtool componentとMCP | tool candidateを生成・保存・採用するflowを設計する |
| R3 | F24 | tool実行profileとsandboxed Deno program | trusted-local以外の実行環境をproduct要件にする |
| R4 | F24 | instruction componentのrevision化 | instructionを自己改訂candidateとして採用する |
| E1 | 配布・外部化 | Agent Definition後のresource外部化 | 利用者希望（2026-09-17）のProvider外部化。A8と合わせて検討 |
| E2 | 配布・外部化 | 追加managed resource kind候補（未採用） | 各kindを通常利用で更新・pin・transport・activationする必要が出る |
| E3 | 配布・外部化 | Host runtime tunablesの設定ファイル化 | provider timeout・tool限界・maxSteps既定などを通常利用で調整したくなるとき |

## Surface

### S2 — Henji内credential登録（F01、F02、F10）

- 観測: API keyをHenji内のslash commandから登録したい。
- 利用者判断（2026-09-12）: built-in二providerに固定した登録UIは先行実装しない。Provider外部化と
  同時または直後に、external Providerが宣言する非secretなauth profile identity、Host-owned credential
  registry、TUIの登録対象catalog、request時解決を接続する。credential値はDefinition、transport package、
  Session、evidenceへ含めない。
- 候補: secretを通常のinput buffer、会話履歴、process argumentへ残さない入力、auth profile選択、fixed
  credential fileの更新と結果表示を設計する。
- 再検討条件: E1でProvider外部化を採用すること。

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

### S5 — assistant本文のrendering（F01、F10、将来のF24候補）

- 観測: plain text renderer componentはIncrement 4で実装済みだが、terminal上の回答にはさらに読みやすく
  できる余地がある。
- 候補: 限定したMarkdown対応から始め、必要が出た場合だけMermaid等のblock rendererを拡張する。
  agentは具体rendererではなくmeaningful content kindまたはpresentation intentを返し、Host Surfaceが解決する境界も
  比較候補にする。
- 再検討条件: plain textでは意味・可読性を安定して保てない回答が観測されること。string出力contractを
  変える場合はF10/F24として構想・architectureへ戻る。

### S8 — startup headerのMCP欄（F01、F10）

- 観測（2026-09-19、通常利用メモ）: MCP接続は将来のmanaged resource候補だが、startup orientation
  （`startupHeaderLines`）に表示欄がない。
- 採用済み（Increment 82）: `base:`→`base instruction:`表記と`skills:`複数行折り返しを実装し、ラベル付き値の
  複数行描画を`headerContentLines`へ分離した。
- 候補: 将来のMCP接続managed resource用に、複数行対応の`mcp:`欄を`headerContentLines`で追加する。
  表示対象のresourceが採用されるまでは欄自体を実装しない。
- 再検討条件: MCP接続managed resourceが採用され、headerで接続状態や数を示す必要が出るとき。
- 関連: `v0/tui/startup_render.ts`、`v0/presentation/contract_types.ts`。

### S9 — recovery laneの削除（F01、F10）

- 観測（2026-09-19、B5調査）: production TUIはsubmit時にtaskを入力履歴へ記録する（`controller.ts`の
  `editorController.record`）ため、recoverable stop後のtask復元はlaneと履歴で重複する。lane固有の価値は
  未消費steering・follow-upと`sideEffectWarning`のみ。一方でlaneが`hasRecovery`により新taskのsubmit
  （`active task recovery pending`）とnavigationをブロックする摩擦が実害。
- 候補: recovery laneを作らず、recoverable stopでは停止理由をstatusへ示し、再送は入力履歴（Up）に任せる。
  未消費steering/follow-upの救済が通常利用で必要になった場合だけ、その分を別途設計する。
- 再検討条件: laneのブロッキング（submit・navigation不可）が通常利用で問題になるとき、またはsteering/follow-upの
  取り戻しが実際に必要になるとき。
- 関連: `increment-85`、inbox B5、`v0/tui/controller.ts`、`v0/tui/pending_input.ts`。

### S10 — 入力履歴のセッション横断保存とsnippet（F01、F10）

- 観測（2026-09-19）: 入力履歴（`v0/tui/input_history.ts`）はTUIプロセス内のみで、再起動や別Sessionで消える。
  繰り返し使う常用prompt（調査手順・レビュー依頼等）を毎回入力している。
- 候補: 入力履歴をworkspaceまたはuser scopeへdurable保存する、または名前付きprompt（snippet）を明示保存して
  `/snippet <name>`等で呼び出す。保存先・scope、Session横断の範囲、credential等secretを履歴へ入れない境界、
  呼び出しUIを採用時に決める。
- 再検討条件: 再起動後・別Sessionでも同じpromptを再利用したい実例が通常利用で得られるとき。
- 関連: `v0/tui/input_history.ts`、roadmap F01、S9。

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

### A7 — 非同期・並行subagentと結果の合流（F02、F06、将来候補）

- 観測: 現行のdelegated plannerは親Execution内の同期的なtool callであり、親agentはplannerの完了まで次の
  model requestやtool実行を進めない。複数subagentの同時起動、独立したchild Execution、後からの結果合流は
  architecture・roadmapで採用されていない。
- 候補: 実taskで必要性が確認された場合、親が委譲後も作業を継続し、複数subagentを並行実行して観測済み結果を
  明示的に合流できるagent loopを検討する。task identity、親子関係、実行・cancel・budgetの単位、結果配送、
  failure時の親継続、canonical/non-canonical採用、history viewとmodel projectionを分けて定義する。既存の
  AgentInstance mailboxや複数Surface routingを、そのままsubagentのfork/join仕様とは扱わない。
- 再検討条件: planner待機中に親が進められる独立作業があり、逐次委譲による時間または作業品質への具体的な
  影響を通常利用で観測すること。単に並列化可能であることだけでは採用しない。
- 参照実装調査: 親の継続、複数child、join、cancel、durable attributionを比較した。OpenAI Agents APIが
  agent固有の操作・履歴・帰属を最も近い一つの契約として持ち、Codex Subagentsの操作体験、Temporalの
  durable child lifecycle、LangGraphのfuture/checkpointを補助参照にできる。調査結果だけではarchitecture・
  roadmapへの採用を意味しない。詳細は
  [`async-parallel-subagent-reference-comparison.md`](../research/async-parallel-subagent-reference-comparison.md)。

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
  Increment 32〜34で採用・実装済みである。managed `instruction:henji-base` revisionはIncrement 51で採用・
  実装済みである。Agent Definitionで得たloader、dependency、promotion、activationのsemanticsをinstruction、
  tool、Provider、MCP、Surfaceへ自動的に一般化しない。
- 未実装境界: catalog外のtool identity、複数slotのinstruction revision化、external Provider registry、互換providerの
  data-only Definition、独自protocolのexecutable Definition、resourceごとのmutable instance state、context rebuild、共通package/plugin
  discoveryは未採用である。Providerは現在`openrouter`/`openai`、API種別、auth profileのclosed unionである。
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
  最初の適用例から外した。
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
- 候補: `runtime.json`を追加し、厳格schema＋検証でHost runtime tunablesを読む。precedenceはCLI flag > config >
  built-in default。第一候補は`providerTimeoutMs`（`run`にも効く）。tool timeout/limitも同様に扱える。
- authority境界: `maxSteps`は現在**Agent Definition所有者**であり、Host configに置くと二重authorityになる。
  既定値のHost config化はroadmap F06（loop/context externalization）の判断が必要。provider timeoutは
  Host/provider側なので衝突しない。
- 再検討条件: provider timeout・tool限界・maxSteps既定を通常利用で調整したくなったとき、または別incrementで
  採用するとき。
- 正本候補: `docs/roadmap.md` F06、`docs/architecture/henji-host-agent-worker.md`。

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

### B3 — PageUpで履歴先頭まで到達できない

- 観測（2026-09-18）: PageUpによる履歴遡りが先頭まで届かず、Session `a75bd05`では2ページ目程度で止まる。
- 利用者情報（2026-09-18）: 「再現したりしなかったりする」＝間欠的。常に止まるわけではない。
- 確認（2026-09-18、increment-74）: Session `a75bd052`は2 turn・24 messageのみで、restored表示上限
  （100 message／2 MiB）に未到達。表示上数画面で先頭に着くのは履歴量と整合し、欠落の決定的な証拠は
  得られなかった。
- 原因候補: history paginationの読み込み欠落、boundaryでの`history empty`／`history boundary`処理。
- 対応: 再現には利用者側の具体的条件（どの画面・key・Session/履歴量・止まったときの見え方・間欠の条件）
  が必要。B1/B2とは別として個別に扱う。

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
- 関連候補: S9（recovery laneの削除）。increment-85で自動復元は停止理由表示＋明示`/recover`へ変更済み。
- 由来（2026-09-19、git履歴）: 自動復元は後付け。`d00b5129`（2026-08-31）はeditorを空のまま`ready`にし
  Ctrl-Rの明示操作で復元、`b19b5dd2`（2026-09-07）が`controller.ts`の自動`popRecovery()`を追加、`58d908d1`で
  Ctrl系機能キーを削除し以降は`/recover`が明示操作。理由statusを復元メッセージが上書きするのはこの追加による。

### B6 — 長いturn中にTUI表示が凍結する（busy経過時間が止まる、CPU高止まり）

- 観測（2026-09-19、利用者報告）: 13 model steps・24 tool callsのweb調査turnで、`working 00:xx`の経過時間が
  増えず画面が凍結。`Esc`等の表示更新も止まる。一方で実行は進行し、turnは`ok=1 stop=final`で正常完了。
- DB確認（read-only）: execution `1eb2a662`（workspace `967fa641…`、turn 1）は02:33:47〜02:41:20に
  `execution_observations` **9848件**。1秒あたり最大**2968件**（02:41:1x）、他に1250／743／663／604件/秒の
  バースト。henji processは実行中`Rl+`でCPU **68〜76%**、settle後は低下。
- 原因候補（仮説、CPU profile未取得）: Host main threadが`appendJournal`→`node:sqlite`（`DatabaseSync`、同期）で
  観測を1件ずつ書くため、数千件/秒のバースト中はmain threadが塞がり、120ms周期のbusy timer
  （経過時間・spinner・redraw）が回らない。実行は別threadのWorkerが進むためDBは伸び続ける。
  increment 84のrendererは本文が小さく主因ではなさそう。
- 原因（2026-09-19、phase計測で確定）: stall時のmain threadは`appendExecutionEvents`の**トランザクションbody**
  でblockしていた（`BEGIN IMMEDIATE`=0.0ms、`COMMIT`=0.1ms、body=最大5秒）。bodyの実体は
  `appendExecutionEventTx`が**1イベントごとに**実行する
  `SELECT max(worker_sequence) ... WHERE execution_id=?`で、`execution_observations`に`worker_sequence`の
  indexが無いためPKの`execution_id`前方一致で当該executionの全行を走査する。実測で10,257行時に
  `max(ordinal)`=0.01msに対し`max(worker_sequence)`=**0.8〜1.5ms/回**。バッチ256件で16ms(256行)→
  **223ms(10,240行)** とO(n)で増大し、turn中にmain threadを秒単位で塞いでbusy timerを止める。
  `busy.tick-gap`最大52.5秒、`terminal.write`最大33.6秒も観測。
- 対応候補（要判断・未修正）: (a) `execution_observations(execution_id, worker_sequence)`へindexを追加して
  `max(worker_sequence)`をO(log n)化、(b) `appendExecutionEvents`でordinalとlast worker_sequenceを
  **バッチ先頭で1回だけ**求めて以降は局所インクリメント（per-insertのmax走査を除去）、(c) 観測journalingを
  render経路から外す（別thread/lane）、(d) 高頻度`provider_response_bytes`/`sse_event`行のcoalesce。
  最短で効くのは(a)＋(b)。
- 部分対応（Increment 87、2026-09-19）: (a)のindexを実装。offlineのO(n)は解消（バッチ256件が行数に依らず
  約11ms、5件flush 0.4ms）したが、**実turnのstallは残存**。
- 残因（2026-09-19、per-event段階計測で特定）: stall中の遅い処理は`writeContextObservationsTx`で、単一の
  `context_observation`あたり**最大17秒**（`ctx:17343`等）。これは`appendevent`ごとにrequestの全itemを
  `Uint8Array.fromBase64`でdecodeし`contextDigestSync`(sha256)と既存blobのbyte比較を行い、
  `model_requests`/`context_blobs`/`context_relations`へ書く。turn進行でrequestのitem/byteが増えるため
  O(n²)で増大し、16 request分がHost main threadを塞ぐ。`BEGIN`/`COMMIT`や`max(ordinal)`は0ms台で無関係。
- 対応候補（残、要判断・未修正）: (e) 各`context_observation`で**新規itemだけを処理**し、既にmaterialize済みの
  itemの再decode/re-digestを避ける、(f) context materializationをturn commit/settle時へまとめる、
  (g) `writeContextObservationsTx`内の段階計測でどのsub-step（decode/digest/blob比較/insert）が支配的か確定。
- (e)実装（Increment 87に同梱、2026-09-19）: 既存blobがあるitemは`fromBase64`/`contextDigestSync`/insertを
  省略し、`insertContextBlobTx`の既存blobのbyte-by-byte比較をcontent-addressedなbyteLength照合へ置換した。
  既存test（increment_40/41/42/50/86/87）と`v0:gate`はpass。**しかしtmux実機では依然stall**（経過時間が
  `01:23`で約96秒停止）。残る主因は`validateContextModelRequestRecord`が**requestの全itemを毎回base64 decode**
  してbyteLength照合する点（turn進行でO(n²)）と、sourceRelations付きitemの再処理。validationはpure関数で、
  storeが「既知digest（materialize済み）はdecodeせず信頼する」入力を受け取れるよう拡張する必要がある。
- 設計候補（要判断）: context_observationが毎model stepで全itemのbase64を再送する契約自体がO(n²)の根源。
  materialize済みitemはdigest参照だけを送る、またはcontext materializationをturn末へまとめる。
- 影響: 実行中は入力・表示が応答しないように見える。成果は失われないが、進行とcancelの可否が分からない。
- 対応候補（要判断・未修正）: (a) 観測journalingをバッチ化しrender経路から外す、(b)
  `provider_response_bytes`/`sse_event`の行をcoalesceしつつ診断は保持する、(c) busy timerを別経路（worker側）
  にしてmain threadの停止と切り離す。
- 正本候補: `v0/agent/worker/worker_host_session.ts`（appendJournal）、
  `v0/agent/history/sqlite_history_store.ts`、`v0/tui/tui_renderer.ts`（busy timer）。
