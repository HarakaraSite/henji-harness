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
| S1 | Surface | slash command候補の選択・補完 | 候補からの入力が繰り返し必要になる |
| S2 | Surface | Henji内credential登録 | Provider外部化の計画を採用する |
| S3 | Surface | canonical/non-canonicalを辿る履歴viewer | 長い履歴の検索・copy・execution詳細確認が実利用で問題になる |
| S4 | Surface | `/rebuild`によるAgent context再構築 | 改訂したinstructionやskillを現Sessionの後続executionへ適用する必要が出る |
| S5 | Surface | assistant本文のMarkdown等のrendering | plain textで意味・可読性を保てない表現を扱う |
| A1 | Agent実行 | ChatGPT subscription root provider | subscription利用がproduct要件になる |
| A2 | Agent実行 | Host操作のmodel向けtool化 | AIがSession列挙やcontext rebuildを実際に必要とする |
| A3 | Agent実行 | Context Strategyの外部化 | 長期Sessionのtoken usageとcontext品質を実測で比較できる |
| A4 | Agent実行 | durable historyの物理保持方式 | 長期SessionのRAM・CPU・disk I/Oまたは履歴参照への影響を実測する |
| A5 | Agent実行 | ambient repository contextの配送 | workspace探索やtask targetの誤認が再発する |
| A6 | Agent実行 | Web searchのsearch/fetch/backend境界 | 対象発見と本文取得の混在が調査品質・コストを損なう |
| A7 | Agent実行 | 非同期・並行subagentと結果の合流 | 親が委譲待ちの間にも独立作業を進めたい実taskが得られる |
| R1 | F24 | 自己改訂対象の重心とagent loop境界 | Self-revision Cycleの最初の実証対象を選ぶ |
| R2 | F24 | revision付きtool componentとMCP | tool candidateを生成・保存・採用するflowを設計する |
| R3 | F24 | tool実行profileとsandboxed Deno program | trusted-local以外の実行環境をproduct要件にする |
| R4 | F24 | instruction componentのrevision化 | instructionを自己改訂candidateとして採用する |
| E1 | 配布・外部化 | Agent Definition後のresource外部化 | instruction、tool、Providerのいずれかを実利用が要求する |

## Surface

### S1 — slash command候補の選択・補完（低優先度、F01、F10）

- 観測: slash command候補は表示できるが、候補を選んで現在のinput bufferへ補完する操作はない。
- 候補: 選択key、補完確定key、引数付きcommandの扱いを一つのSurface incrementで決める。
- 再検討条件: 候補一覧を見てcommand名を手入力する負担が繰り返し観測されること。

### S2 — Henji内credential登録（F01、F02、F10）

- 観測: API keyをHenji内のslash commandから登録したい。
- 利用者判断（2026-09-12）: built-in二providerに固定した登録UIは先行実装しない。Provider外部化と
  同時または直後に、external Providerが宣言する非secretなauth profile identity、Host-owned credential
  registry、TUIの登録対象catalog、request時解決を接続する。credential値はDefinition、transport package、
  Session、evidenceへ含めない。
- 候補: secretを通常のinput buffer、会話履歴、process argumentへ残さない入力、auth profile選択、fixed
  credential fileの更新と結果表示を設計する。
- 再検討条件: E1でProvider外部化を採用すること。

### S3 — canonical/non-canonicalを辿る履歴viewer（F01、F05、F10）

- 観測: Increment 30でPageUp/PageDown中のkeyword検索を試したが、terminalのdrawing rowとHostのbounded
  history entryという二つのpage単位が混在したため取り下げた。現在はPageUp/PageDown、Escによる最新復帰、
  `/history export`を使える。
- 候補: canonical turnとsettled non-canonical executionを同じSession historyから識別して辿り、outcome、
  tool call/result、context attribution、`/recall` source/target、将来の`/rebuild` transitionを必要に応じて
  展開できるread-only viewにする。閲覧、literal keyword検索、wrap、viewport、page移動を同じ連続document上で
  扱い、Markdown assistant rendererとtool summary/detail inspectorは保存・採用状態を変えないSurface部品にする。
  `j`/`k`、`Ctrl-U`/`Ctrl-D`、`g`/`G`、`q`、mouse wheel、`$VISUAL`/`$EDITOR`へのexportは個別に選べる。
- 再検討条件: 人間が過去turn、cancel/failed execution、toolの詳細を探してcopy・確認する作業で、現行の
  scroll、`/recall` selector、canonical transcript exportでは十分でない事例が出ること。

### S4 — `/rebuild`によるAgent context再構築（F01、F03、F08、F10、F11、F27）

- 観測: Henjiはworkspace instructionとskill catalogをWorker generation開始時にsnapshot化するため、改善した
  instructionや新しいskillを現在Sessionの後続executionへ適用するには新しいgenerationが必要である。目的は
  fileを再読込することだけでなく、改訂後のresourceからAgent側の基底設定を再構築することであるため、
  command候補名を従来の`/reload`から`/rebuild`へ変更した。
- 候補: 人間の`/rebuild`で、対象として定めたresourceから新しい`AgentContextGeneration`を構築し、現Session、
  canonical conversation、未送信draft、過去executionのattributionを維持したまま後続executionへ適用する。
  最初の対象を`AGENTS.md`とskillsに限るか、Agent Definition、tool、将来componentまで含めるかは未決である。
  context generationとWorker generationを同じidentityにすることも決めていない。
- 再検討条件: instruction等を改善した通常利用で、Henji自体を終了せず同じSessionの次taskへ適用したい事例が
  得られること。個別incrementでは対象resource、selection/activation authority、transitionのcommit/failure
  semanticsを決める。
- 関連: A2、R4、E1、
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

### A4 — durable historyの物理保持方式（F02、F04、F05、F06、F08、F15）

- 観測: 人間が見る履歴全体はcanonical conversationだけでなく、settled non-canonical execution、tool
  activity、context attribution、`/recall` projection、将来の`/rebuild` transitionを含む。storageへの物理commitと
  conversationへのcanonical採用は別operationである。現実装はcanonical transcriptをRAMへ展開してturnごとに
  `session.json`をatomic rewriteし、execution artifact/provider evidenceを別に保存する。長期Sessionの性能と、
  全履歴を一つのviewから辿る物理構成は未確認である。
- 候補: canonical transcriptのatomic adoptionを維持しながら、execution identity、outcome、観測済みevent、
  context attribution、projection/transitionを相関できるstoreを比較する。append-only store、SQLite、現Session
  JSONとartifact storeの拡張、RAM上のindex/checkpoint suffix、paged history readは候補であり未決定である。
  providerの一時的な`callId`だけを永続identityと仮定しない。完全再現性、過去Worker、OS/filesystem、外部状態の
  snapshotは目的にしない。
- 再検討条件: RAM、CPU、GC、disk I/O、history表示、execution/context相関の具体的な問題を長期Sessionまたは
  通常利用で観測すること。
- 調査: [`agent-loop-and-durable-state-comparison.md`](../research/agent-loop-and-durable-state-comparison.md)。

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
  Increment 32〜34で採用・実装済みである。Agent Definitionで得たloader、dependency、promotion、activationのsemanticsを
  instruction、tool、Provider、MCP、Surfaceへ自動的に一般化しない。
- 未実装境界: catalog外のtool identity、revision付きinstruction、external Provider registry、互換providerの
  data-only Definition、独自protocolのexecutable Definition、resourceごとのmutable instance state、context rebuild、共通package/plugin
  discoveryは未採用である。Providerは現在`openrouter`/`openai`、API種別、auth profileのclosed unionである。
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
