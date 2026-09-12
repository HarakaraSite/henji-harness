# 通常利用メモ

Henjiを通常利用して得た観測と未採用の改善候補を、topicごとに蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。
- 個別incrementへ採用した項目は、そのincrementの正本文書へ移して未振り分け一覧から除く。
- 見出しの順序は優先順位を表さず、この文書への記載だけでは採用または実装を意味しない。

## 未採用候補

### 一覧

- [Surface](#surface)
- [Agent実行](#agent実行)
- [F24・自己改定](#f24自己改定)
- [配布・外部化](#配布外部化)

### Surface

#### Surface: slash command候補の選択・補完（低優先度、F01、F10）

- 表示中のslash command候補を選択し、現在の入力bufferへ補完できるようにする。
- 候補の選択key、補完を確定するkey、引数を持つcommandの扱いは、個別incrementへ採用するときに決める。

#### Surface: Henji内credential登録（F01、F02、F10）

通常利用での観測と要望:

- API keyの登録をHenji内のslash commandから行えるようにしたい。

個別incrementで決めること:

- slash command名、secretを通常の入力buffer・会話履歴・process argumentへ残さない入力方法、登録先auth profileの選択、
  fixed credential fileへの保存と更新結果の表示。
- OpenRouter、OpenAI direct、将来providerで共通化する範囲。

利用者判断（2026-09-12）:

- built-in二providerだけに固定したcredential登録を先行実装しない。Provider外部化を採用するときに、external Providerが
  宣言する非secretなauth profile identity、Host-owned credential registry、TUIの登録対象catalog、request時解決を
  一つの接続として設計し、Provider外部化と同時または直後の個別incrementで扱う。
- credential値はexternal Provider Definition、managed transport package、Session、evidenceへ含めない。

#### Surface: 履歴閲覧の追加候補（F01、F05、F10）

Increment 30ではPageUp / PageDown中のkeyword検索を試行したが、通常viewportのterminal描画rowと
Host側bounded history entryという二つのpage単位が混在したため取り下げた。現在はPageUp / PageDown、
Escによる最新復帰、および`/history export`を利用できる。

履歴閲覧で人間が行いたいことは、過去のturn、指示、結果を確認し、terminalの機能で必要な箇所をcopyする
ことである。次に採用する場合は、簡易なread-only text editorのように、閲覧と検索で同じ連続document、
wrap、viewport、page移動を共有する履歴viewerとして設計する。keyword検索は人間が記憶している場所へ
素早く移動する入口とする。

追加候補:

- 上記viewer内のliteral keyword検索、現在位置からのjump、一致箇所のhighlight。
- vi風の`j`/`k`、`Ctrl-U`/`Ctrl-D`、`g`/`G`、`q`による追加navigation。
- mouse wheelを共通scroll actionへ接続するためのterminal mouse tracking。
- exportした履歴を`$VISUAL`または`$EDITOR`で自動的に開く閲覧出口。

#### Surface: `/reload`によるresource再読込（F01、F03、F10）

観測と利用者要望:

- Piの`/reload` slash commandは有用だったため、Henjiにも同様の再読込入口が欲しい。
- pinned Piでは、active responseまたはcompaction中のreloadを待たせ、idle時にkeybindings、extensions、
  skills、prompts、themes、context filesを再読込する。
- 現行Henjiはworkspace instructionとskill catalogをWorker generation開始時にsnapshot化し、同じgeneration
  中のfile変更を再読込するslash commandを持たない。このため、新しく配置したskillを使うには現状では
  Henjiの新しいWorker generationが必要になる。

未決事項:

- Henjiで最初にreload対象とするresourceを、`AGENTS.md`とskillsだけにするか、Agent Definition、tool、
  その他の将来componentまで含めるか。
- 現Sessionと未送信draftを保ったままWorker generationを置換するのか、現在のgeneration内でresourceだけを
  再構成するのか。Definition revision bindingとSessionの整合性を含め、実装increment採用時に決める。

#### Surface: assistant本文のrendering（F01、F10、将来のF24候補）

観測:

- Henjiの回答をterminal向けにさらに読みやすくする余地がある。
- plain textのassistant renderer component抽出はincrement 4で実装済みである。

未採用候補:

- TUIへのMarkdown renderer導入を検討する。採用する場合も対応範囲を限定して始める。
- Mermaid等が必要になった場合はrenderer全体の交換だけでなく、Markdown内のblock rendererを拡張する。
  一般的なplugin/load機構までは現時点で決めない。
- agentが具体的なrenderer実装を選ぶのではなく、plain text、Markdown、Mermaid等の意味上のcontent kind
  またはpresentation intentを返し、Host側のSurfaceが利用可能なrenderer componentへ解決する境界を
  候補とする。現在のstring出力contractを変える必要が生じた場合は、F10と将来のF24として構想・
  architectureへ戻って検討する。

### Agent実行

#### Agent実行: ChatGPT subscription root provider（F02、F06）

- Increment 17で、公式Codex境界、非公開ChatGPT Codex backendへのdirect route、Pi・OpenCode・Zotの比較実装、
  OpenAIのOSS支援方針を調査した。詳細な確認結果は
  [`docs/increments/increment-17.md`](../increments/increment-17.md)を正本とする。
- 技術的な実装候補は存在するが、OpenAI subscription対応は現段階のHenjiに必須ではないため、利用者判断で
  runtime実装を将来incrementへ延期した。
- Henjiの既存機能の完成度を高めた後、利用者が必要性を判断して再採用する場合に、OpenAIの最新方針、公式contract、
  現行の参照実装を再確認し、新しい個別increment計画を作る。

#### Agent実行: 有用なslash command操作のtool化（F02、F06、F10）

- slash commandのうち、AI自身が作業中に利用できると有用な操作は、人間向けcommandだけでなくmodel向けtoolとしても
  提供することを検討する。初期候補はresourceを再読込する`/reload`と、保存済みSessionを扱う`/sessions`である。
- slash command文字列をmodelに擬似入力させるのではなく、Hostが所有する同じapplication serviceへ、型付きslash command
  handlerと型付きtool handlerの双方を接続する構成を候補とする。
- 一覧取得などのread-only操作と、Session切替・runtime再読込のように現在のtool callやconversation contextを置換する操作を
  区別する。後者はtool resultを返す前に呼出元を破棄せず、次turnへの予約、Host control event、完了後の切替など、実行順序を
  個別incrementで定める。
- `/sessions`のtool化では、Session一覧取得、詳細取得、選択・切替を一つのtoolにするか分けるかを決める。AIによる自動切替と、
  候補提示後に人間が選択する操作も区別する。
- `/reload`のtool化では、再読込対象、active response中の扱い、Worker generation・Definition revision・Session bindingとの
  整合を、既存の「`/reload`によるresource再読込」候補と一緒に設計する。
- 今後slash commandを追加するときは、同じ意味操作をAIが利用する価値があるかを確認し、必要ならtool surfaceも併せて検討する。
  UIだけに意味があるcommandや、人間の明示選択そのものが目的のcommandまで一律にtool化はしない。

#### Agent実行: Context Strategyの外部化（F02、F06、将来のF24候補）

- 64 KiBでのtool-result機械的省略とpre-turnの自動semantic compactionを止める修正はIncrement 29へ採用した。
  観測証拠、停止する現動作、維持するcheckpoint境界は
  [`docs/increments/increment-29.md`](../increments/increment-29.md)を正本とする。
- 将来のコンパクションは単なる容量対策ではなく、何を覚え、捨て、抽象化するかを決めるContext Strategyとして
  扱う。発動判断、対象選択、保持予算、semantic summary、使用model、failure方針、結果の説明を交換可能な
  component境界にすることを検討する。
- Agent Definitionがrevision付きContext Strategyを選び、Workerが実行する構成を候補とする。一方、完全な
  canonical transcript、checkpointの永続化と相関、tool call/resultの因果構造、credential、provider evidence、
  strategy結果の採否はHenji-owned境界に残す。
- 実token usage、provider/modelのcontext契約、turn途中とturn間のsemantic checkpoint、機械的・意味的・階層的な
  strategyの比較は、長期Sessionの実利用証拠が得られた後の個別incrementで行う。この記録だけでは外部化や
  F24への採用を意味しない。

#### Agent実行: canonical transcriptの物理的な保持方式（F02、F05、F06）

現行確認:

- commit済みの完全なcanonical transcriptをSessionの正本として保持し、semantic checkpointをprovider向けの
  派生投影として分離する性質は、履歴閲覧、再投影、診断、rollbackのために維持したい。
- 現行実装は完全な`committedTranscript`を常時RAMへ展開し、turn開始やmodel requestの構築時に全体の
  `structuredClone`、走査、serializationを行う。またturn commitでは完全な`session.json`をatomic rewriteする。
  Sessionが長くなるほど、providerへ送る投影後contextとは別に、local CPU、memory、GC、disk I/Oの負担が増える。
- この負担は完全履歴を正本として残すことの必然ではなく、正本の論理的な所有と物理的なmaterializationを
  現在は同じ構造で実装していることによる。現時点では体感性能への影響を実測していない。

未採用候補:

- canonical transcriptの完全性を変えず、SQLite等のappend-onlyな永続層を完全履歴の正本とし、RAM上のactive
  stateを履歴index、semantic checkpoint以降のsuffix、current draftへ分けることを検討する。SQLite採用は
  現時点では候補であり、storage技術の決定ではない。
- history表示のpaged read、turn単位のincremental commit、provider requestを投影済みcontextから直接構築する方式を
  比較し、完全履歴をmodel requestごとにclone・走査しない構成を将来incrementで検討する。
- tool callと完全なtool resultをSession内の安定した参照identityで保存し、semantic checkpointには必要に応じて
  その参照を残す。modelが圧縮後に原文を必要と判断した場合、専用のread-only toolから参照identityを指定して
  canonical resultを取得できる構成を候補とする。
- providerの一時的な`callId`だけを永続参照として十分と仮定せず、Session、turn、message、tool resultとの相関、
  access contract、複数result batchを含むidentityを設計時に決める。再取得は過去のprovider tool pairをそのまま
  replayするのではなく、現在turnの新しいtool resultとして返す方法を候補とする。

SQLite backendを持つagent harnessの比較調査（2026-09-11）:

- TypeScriptという条件を外し、SQLiteがcode indexやcacheではなく、Session、message、event等のagent状態を保持する
  harnessを公式sourceで確認した。現時点でHenjiの履歴正本構想に最も近い参照候補はRust製の
  [NorviaLabs/forge](https://github.com/NorviaLabs/forge/tree/d0bb0788e7c1fdfbe16291818c39293c1de755f7)
  commit `d0bb0788e7c1fdfbe16291818c39293c1de755f7`である。MIT license、beta段階であり、成熟productというより
  SQLite設計の比較対象として扱う。
- Forgeの
  [`forge-durable`](https://github.com/NorviaLabs/forge/blob/d0bb0788e7c1fdfbe16291818c39293c1de755f7/crates/forge-durable/src/lib.rs)
  は、SessionごとのSQLite databaseにappend-onlyな`events`と`replay_checkpoints`を持つ。tool/modelの副作用前に
  intentを永続化するrecord-before-side-effect、会話・tool intent/result・model response・HITL・task・subagent・
  compacted contextのreplay、不完了intentの検出、checkpoint以降のevent適用を実装している。
  [`forge-core`のadapter](https://github.com/NorviaLabs/forge/blob/d0bb0788e7c1fdfbe16291818c39293c1de755f7/crates/forge-core/src/persistence.rs)
  はjournalをSession単位のpersistence境界へ閉じ込めており、HenjiのHost-owned canonical transcript、派生projection、
  tool result identity、checkpointを分離する検討に直接対応する。
- Go製の[Charmbracelet Crush](https://github.com/charmbracelet/crush/tree/bb33cee2d32780cb5afa31fc3aa815302b9f7443)
  commit `bb33cee2d32780cb5afa31fc3aa815302b9f7443`は、SQLiteにSession、message、file snapshot、token・cost等を
  保存し、WAL、process lock、同時接続上の運用対策も持つ。一方、messageの更新・削除を行うmutableなrelational storeで、
  append-onlyな完全履歴正本ではない。Session picker、summary、親子Session、database運用の比較には有用である。
  licenseは現時点でFSL-1.1-MITであり、直ちにMITとして扱わない。
- Rust製の[Goose](https://github.com/aaif-goose/goose/tree/618d41ee2e01032e6c2874b1da467259ac3229af)
  commit `618d41ee2e01032e6c2874b1da467259ac3229af`は、Apache-2.0で、SQLiteにSession、message、usage ledger、thread、
  provider/model構成等を保存し、schema migrationと他agentからのSession importも持つ。ただしconversation全置換や
  message削除を行う通常のmutable storeであり、repository規模も大きい。成熟したSession databaseの比較対象にはなるが、
  `_refs`へ丸ごと置く第一候補にはしない。
- awesome list上の候補もsourceで照合し、DvalinCodeのSession正本はJSONと`.journal.jsonl`で、SQLite backendでは
  なかった。紹介文だけからSQLite利用を推定しない。
- `_refs`へ次に追加するならForgeを第一候補とする。ただし、この調査記録だけではsnapshot追加、SQLite採用、storage
  architectureの決定を意味しない。採用時はcurrent commitとlicenseを再確認し、現行Henjiのevent・checkpoint・
  canonical transcript contractとの差分を個別incrementで整理する。

#### Agent実行: ambient repository contextの配送（F02、F06）

通常利用での観測:

- Increment 37のproduction Human Gateでは、local targetを指定しない外部調査taskにsource-selection instructionを
  配送し、`web_search`も利用可能だったが、modelは最初に`bash`でworkspaceのGit remoteとhandoffを探索した。
- modelはambient workspaceから得たForgejo hostをtask targetとして扱った。repository情報を知らないために探索した
  可能性と、存在するrepository contextをユーザー指定targetとして過剰に結び付けた問題を分ける必要がある。
- 実行証拠とIncrement内の完了判断は
  [`docs/increments/increment-37.md`](../increments/increment-37.md)を正本とする。

未採用候補:

- Hostがmodelへ、working directoryのrepository identityをtool探索不要なambient contextとして明示的に配送する
  構成を検討する。同時に、それはtask targetではなく、ユーザーが「このrepository」「current repository」等と
  結び付けた場合だけsourceとして扱う意味境界を示す。
- 外部product・project名だけが指定されたtaskではambient remoteからidentityを推定せず、外部source discoveryを
  行う規則との組合せを確認する。単にremote URLを追加して今回の誤認を強めない。
- 配送する情報、snapshot時点、HostとAgent Definitionの責務を個別increment採用時に決める。候補はrepository root、
  VCS種別、非secretなcanonical repository identityであり、credentialやremote URL内の認証情報は含めない。
- この記録はcontext配送方式、architecture、instruction componentの採用を意味しない。

#### Agent実行: Web searchの後続境界（F02、F06、将来のF24候補）

現行確認:

- Increment 7から9で、Henji-owned `web_search`、OpenRouter Sonar backend、groundingと直接URL citationを
  実装し、production通常利用で受け入れ済みである。
- 現行の`web_search`は一つのtool componentであり、Sonarを交換可能backendが内部利用するmodelとして扱う。

未採用候補:

- model向けtool callを、対象identityとcanonical sourceを発見する`search`と、指定URLの本文・公開API responseを
  正確に取得する`fetch`へ分けて実装すべきか検討する。`search`で公式URLを特定し、`fetch`でそのURLを取得し、
  特殊なrequestだけ`curl`を使う流れを候補とする。現行`web_search`との置換・併存、search結果からfetchへ渡す
  identity、取得内容とcitation・provider evidenceの対応、追加stepを使う代わりに調査経路を明示できる利点を、
  実際の調査taskで比較する。
- canonical API確定後の一回の`curl`は意味上誤りではない。`fetch`で置き換えたい主対象は、対象発見のための
  filesystem探索と複数endpointの試行、shell quoting、temporary file、別commandによる再読込・解析が連なる
  経路である。first-class toolにすることでGET取得、response metadata、cancel、evidence、表示を同じcontractへ
  揃えられるかを確認する。
- OpenAI Responses APIのbuilt-in Web searchを、現行OpenRouter Sonarと同居可能な将来backend候補として保持する。
  初期候補は、modelに`websearch1`、`websearch2`という実装名を直接選ばせるより、一つの意味上の`web_search`
  toolに対してAgent Definitionまたはtool componentがbackendを選ぶ構成とする。二つを同時にmodelへ公開する必要が
  生じた場合は、品質、費用、検索範囲など、人間とmodelが選択理由を理解できる別contractとして検討する。
- OpenRouterの`openrouter:web_search` server toolを、同じ`WebSearchBackend`境界へ追加する将来backend候補
  として保持する。
- 将来も「modelを内包する機能」として扱うか、検索・解釈を担当する`WebSearch AgentDefinition`として
  conversation、prompt、model、tool利用を明示的に所有させるかは未決である。agent化が必要になる具体的な
  task、状態、委譲、revision上の利点が観測された時点で比較する。

### F24・自己改定

#### F24候補: 自己改訂対象の重心とagent loop

利用者の仮説:

- Agent Definition、とくにrole定義はmodel能力への依存が大きく、有用なvariationもそれほど多くないため、
  実際には改訂余地が小さい可能性がある。Definition variantを増やすこと自体を自己改訂の中心にしない。
- tool定義はagentの手足に当たる部分であり、自己改善・自己拡張の余地が大きい。例えばfile検索で`find`を
  使っていた経験から、より適した`fd`を使うtoolまたはtool実装を候補化するような改訂が考えられる。
- 仕事の進め方、どこに人間のgateを置くか、何をしてはいけないかというinstruction、policy、workflowも、
  経験に応じて改訂する価値が大きい。これらとcore agent loopの違いを整理する必要がある。

現行Henjiとの対応:

- 現行`AgentDefinition`はmodel、instruction、tool・skill・subagentのresource identity、`maxSteps`を選ぶ
  composition envelopeである。Definitionそのものを頻繁に書き換える代わりに、revision付きtoolやinstruction、
  workflow componentを選択する安定した入れ物として使う構成も考えられる。
- 現行のcore agent loopは、一つのuser turnについてcommit済みtranscriptとtool definitionsからmodel requestを
  作り、modelがfinalを返せば終了し、tool callsを返せばRegistryで実行してassistant tool-call messageとtool
  resultをtranscriptへ追加し、次のmodel requestへ進む反復である。step budget、cancel、steering、progress、
  failure、turn末尾のcommit proposalもこの実行semanticsに含まれる。
- 「外部対象ならweb searchを先に使う」「実装後にreviewし、ここで人間を待つ」「pushは人間の指示後だけ」
  のような判断規則は、通常はloopそのものではなく、loopへ渡すinstruction、workflow、Host / Surface側の
  admission・gateである。一方、tool callsを並列に実行するか、reviewを別Workerへ自動dispatchするか、turnを
  どの条件で終了・commitするかまで変える場合はagent loopまたはruntime semanticsの改訂になる。
- 自己改訂candidateの採用を人間の明示操作・承認だけに限定する境界は、現在の採用済み構想が定める
  user-owned invariantである。日常taskのcommit、push、外部変更、review等に置く運用上のhuman gateとは分ける。
  後者の配置や表現を改訂候補にできても、前者をcandidate自身が外す構成にはしない。

agent loop比較調査（2026-09-11）:

- `user input -> model request -> final、またはtool calls -> tool resultsを履歴へ追加 -> 次のmodel request`
  という最小骨格は各harnessに共通するが、これは鉄板の全architectureではない。履歴をいつ確定するか、toolを
  逐次・並列のどちらで実行するか、steeringとfollow-upをどの境界で取り込むか、approvalでどう停止・再開するか、
  compactionとretryを誰が所有するかに各harnessの設計差が現れる。
- Henjiはcommit済みtranscriptの防御copy上で一つのuser turnを実行し、`final`またはterminal tool成功時にturn全体を
  commitする。cancel、provider failure、途中のtool failureで未成立turnをcanonical transcriptへ混ぜない単純さ、
  transcriptと実行順の一致、復元時に成立済み履歴を判別しやすい点を利用者は好ましく評価している。一方、process
  crash時の未commit turn、すでに発生したtool副作用、長時間turnの途中観測は別の実行journalがなければ復元しにくい。
- Codexの公開App Server contractは、永続conversationを`thread`、user処理を`turn`、assistant message、command、
  file change、tool call、compaction等を`item`として表す。`item/started`と`item/completed`の間にapproval requestを
  挟んで停止・再開でき、`turn/steer`は新しいturnを作らず実行中turnへ入力を追加する。これは外部から観測できる
  protocol上の状態機械であり、今回の調査ではCodex内部Rust loopの具体的な制御関数までは確認していない。
- OpenCode V1は`SessionPrompt.runLoop`の`while (true)`でcompact済みmessage履歴をstepごとに再読込し、assistant
  messageとtext・reasoning・toolのpartを実行途中からDBへ逐次保存する。session単位の`ensureRunning`、provider retry、
  subtask、max steps、compactionをloopとprocessorで扱うため、Henjiのturn末尾atomic commitとは異なる。
- OpenCode `dev` commit `193de13a88d62a6409c6d385831180f1def527dc`の移行中V2は、SQLite上のdurable eventと
  user-input inboxを基礎に、外側でqueued input、内側でtool continuationとsteerを処理する二重loopを持つ。完成した
  local tool callを先に永続eventへ投影してからfiberで実行し、provider stream終了後に全tool settlementを待ち、結果を
  保存して履歴を再投影する。同一Sessionはcoordinatorが直列化し、別Sessionは並行実行できる。crash後に残った
  `pending` / `running` toolを黙って再実行せず、interruptedとして確定する境界も明示されている。
- human gateの「どの操作を承認対象にするか」という方針はinstruction、policy、workflow側に置けるが、approval待ちの
  toolを安全に停止し、回答後に同じcallを再開・拒否する実行地点はruntime / loop境界に必要である。したがってhuman
  gateはcore loopと完全に無関係な外層ではなく、方針とenforcementを分けて接続する機能と捉える。
- Henjiのatomic turn commitと逐次実行を捨てず、未commit中のprovider request、tool requested / started / completed、
  cancel等だけをappend-only execution journalへ逐次記録する折衷案が考えられる。canonical transcriptは成功時に一括
  commitし、journalはcrash recoveryと診断証拠、context projectionはcommit済み正本から再生成する。この分離は既存の
  provider evidenceをcanonical transcriptとは別に保存する考え方とも整合するが、まだ採用判断ではない。
- tool call並列化の主な利点は、独立したread/search等の待ち時間短縮である。AIが混乱するかは物理的な完了順より、
  `callId`とresultの対応、modelへ返す順序、依存関係を保持できるかに左右される。同じfileへのwrite、生成物を読む後続
  call、test、git操作、複数approvalなどは順序で意味が変わる。現行Henjiの逐次実行は決定性、cancel・failure semantics、
  atomic commitとの相性がよく、実測上の必要が出るまでは妥当な既定値である。
- 将来部分並列化する場合は、同一responseに複数callがあるだけで並列可能とみなさず、tool componentに
  `parallel-safe`または`exclusive`相当の実行特性を持たせ、独立したread-only callだけを並列化して全件settlement後に
  安定した対応関係でmodelへ返すschedulerを候補とする。これは未採用であり、現行loopを変更する要件ではない。
- Codex UIの`Explored`はRead/Search等をまとめる表示分類、`Ran`はcommand executionの表示分類であり、label自体は
  並列・逐次を示さない。探索agent起動の証拠にもならない。実際の並列性は、個別itemのstarted/completed区間または
  subagent threadの重なりで確認する必要がある。OpenAI公式文書には`Explored` / `Ran`をscheduler semanticsとして
  定義した記述は見つからなかった。

比較参照:

- Henji: `v0/agent/core/loop.ts`
- Pi: `_refs/pi/packages/agent/src/agent-loop.ts`
- Zot: `_refs/zot/packages/core/agent.go`
- DeepSeek Harness: `_refs/deepseek-harness/packages/core/agent-loop/README.md`
- Codex: [App Server](https://learn.chatgpt.com/docs/app-server)、
  [Open Source](https://learn.chatgpt.com/docs/open-source)、
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- OpenCode V1: [prompt.ts](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/prompt.ts)、
  [processor.ts](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/opencode/src/session/processor.ts)
- OpenCode V2: [Session API specification](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/specs/v2/session.md)、
  [runner](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/runner/llm.ts)、
  [run coordinator](https://github.com/anomalyco/opencode/blob/193de13a88d62a6409c6d385831180f1def527dc/packages/core/src/session/run-coordinator.ts)

未採用の検討候補:

- 最初の自己改訂実証で、Agent Definition sourceの変更そのものより、tool componentまたは作業方針componentの
  candidate生成、差分確認、人間による採用、通常利用への反映を対象にする方が経験上の価値を示しやすいか
  比較する。
- Definition、tool、instruction・policy・workflow、core loop、Host enforcementの各revision boundaryを、
  どの経験からどれを改訂するか判断できる単位として整理する。

#### F24候補: revision付きtool componentとMCP component

未採用候補:

- tool componentを、revision identity、model向けcontract（name、description、schema、
  `promptGuidelines`）、Worker内で物理I/Oへbindするexecutorに分ける。
- `AgentDefinition`がrevision付きtool componentを選択・合成し、`Registry`は有効なtoolのdefinitionと
  guidelineだけを組み立てる。選択結果はManifestへ出し、Definition revisionはimportしたcomponentの
  dependency revisionも固定する。
- catalog外の新tool identityをexternal Definitionから追加する一般seamと、importしたtool componentを
  Definition revisionのdependency lineageへ含める境界は未実装である。F24でtoolを改訂対象にするときに
  検討する。
- Exa MCPの採用は却下済みだが、一般的なMCP componentは将来構想候補として保持する。具体的なserviceを
  導入する判断とは分ける。
- 上記のcomponent境界だけではF24完了とせず、tool candidate生成、revision保存、人間による採用まで
  product flowとして成立した段階をtool改訂として扱う。

#### F24候補: tool実行権限とsandboxed Deno program

通常利用での観測:

- 現行`bash` toolはmodelが生成したcommandを`/bin/bash` subprocessへ渡す。
  [Deno公式のpermission文書](https://docs.deno.com/runtime/reference/permissions/#subprocesses)どおり、
  subprocessは親runtimeのfilesystem・network permission内には閉じず、OS userの権限で動く。
- 2026-09-07の実利用環境では`python3`、`apt`、`sudo`がPATH上にあり、`pip` executableとPythonの`pip`
  moduleはなかった。実行userにはpasswordless sudo権限があるため、modelがpackage導入commandを選ばなかった
  ことは、実行可能性を制限する境界ではない。
- Forgejo API文書の調査では、modelは未導入のBeautifulSoupを試した後、packageを導入せずPython標準
  libraryと正規表現へ切り替えた。この一回の選択から、別のtaskやmodelでも`pip`、`apt`等を自発的に
  使わないとは判断できない。

検討候補:

- startup headerの`trusted-local · no hard sandbox`は、単一のmode名ではなく、少なくともtrust、tool
  capability、permission、human gate、isolationという独立した軸の現在値として扱う。`trusted-local`は
  信頼されたlocal利用を前提に確認なしでtoolを使う運用model、`no hard sandbox`はsubprocessをOS userから
  強制分離するcontainer、VM、mount namespace等がないことを示す。plannerのようにtool capabilityが少ない
  ことや、Deno launcherのpermissionが限定されることをhard sandboxと同一視しない。
- 将来のexecution profileとして、read-only、write・shell・networkをhuman approval後に使う
  approval-gated、workspaceだけをread-write mountするworkspace-sandbox、一時containerまたはVMで実行する
  isolated-runner等を検討できる。たとえば`approval-gated · no hard sandbox`と
  `trusted-local · workspace sandbox`は別々に成立する。
- 内部表現は一つの列挙modeへ早期に固定せず、`trust`、`isolation`、filesystem範囲、network範囲、approval
  policyの構造化profileとして持つ候補を残す。Agent Definitionやtool componentはHostが所有するpermission
  ceilingの部分集合だけを選び、human gateの配置とOS-level isolationを別々に変更できるようにする。
- hard sandboxを名乗る場合は、`bash`を単にDenoの`--allow-run`で起動する構成では足りない。subprocess自体を
  bubblewrap、Landlock、container、専用VM等へ配置し、workspace mount、他pathとcredentialの可視性、network、
  process実行範囲をHost側で強制する必要がある。これはcore agent loopではなく、主にHostとtool executorの
  execution profile境界として検討する。
- 「packageを導入しない」というAgent instructionと、「共有VM状態へ導入できない」というtool実行権限を
  区別する。`pip`や`apt`というcommand名の禁止だけでは、downloadしたbinaryや別package managerによる
  同じeffectを制限できないため、必要な境界はprocess起動、write先、network、credential等のcapabilityで
  表現する。
- modelが必要なprogramをTypeScriptとして組み立て、Hostまたはtool executorが固定したDeno permission内で
  実行するtoolを検討する。modelはprogramとdataだけを渡し、Deno CLI option、permission flag、executorを
  制御しない。特に任意の`deno run`、`--allow-all`、shellまたはsubprocess起動を許す構成はsandboxとして
  扱わない。
- Hostが改訂対象外のpermission ceilingを所有し、Agent Definitionとrevision付きtool componentはその部分集合を
  選択する。Manifestは選択結果を説明するがpermission authorityにはしない。権限拡張はtool candidateの
  自動採用から導かず、人間が明示的に判断する。
- sandboxed program toolの通常導入はF06を含む通常改善として先に実施できる。経験からtool contractや
  executorの改訂候補を生成し、revisionとして保存し、人間が採用するproduct flowまで成立した段階をF24の
  tool改訂として扱う。

現在の扱い:

- 議論から得た未採用のarchitecture・tool候補として保存する。permission profile、実行配置、dependency
  取得、永続化範囲、unrestricted `bash`との併存方法は、具体的なproduct incrementを選ぶ時点で決める。

#### F24候補: instruction componentのrevision化と自己改定

Increment 16で採用するruntime instruction合成は
[`docs/architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)
を正本とし、ここにはF24で検討するrevision管理と自己改定だけを残す。

現行確認:

- 現行HenjiはHenji共通、agent role、active tool guideline、workspace instruction、skill manifest、
  runtime factsをこの順でsystem instructionへ合成する。workspace instructionはworkspace rootの
  `AGENTS.md`または`AGENTS.MD`一つであり、defaultとplannerは自分のroleと利用可能toolのguidelineだけを受け取る。
- Henji全体へ適用する`~/.config/henji-harness/AGENTS.md`は採用せず、`AGENTS.md`はworkspace rootの
  project固有instructionだけに使う。Henji共通とbuilt-in agent固有のinstructionは
  `v0/agent/instructions/`の独立したTypeScript componentが所有する。
- 現在のinstalled `henji`はrepository内のTypeScriptを`deno run`するlauncherなので、built-in
  instructionのsource変更はHenji再起動後に反映できる。一方、将来`deno compile`等のstandalone
  executableへ移行すると、静的importされたinstructionもbinaryへ埋め込まれ、sourceを変更するだけでは
  installed binaryへ反映されず、再build・再installが必要になる。
- workspace-local external Definitionは異なる`systemInstruction`を返せるため、agent AへX、agent BへYを
  技術的には設定できる。一方、公開`createDefaultAgentComposition()`にはagent固有instructionを追加する
  first-class optionがなく、任意のnamed agent catalog、instruction resource identity、manifestとの一貫した
  authoring契約は未整備である。

未採用候補:

- runtime componentをrevision付きresourceとして保存・比較し、F24の候補生成、人間による採用、rollbackの対象にする。
- 任意のnamed agentがcomponentを選択できるauthoring契約と、component revisionのdependency lineageを定める。
- 自己改定で複数componentを変更する場合の合成順、競合規則、Manifest attributionを定める。
- standalone binaryでもinstruction置換と自己改定を成立させるため、immutableなbinary内built-inを直接書き換えるのか、
  writableな外部revision storeを正本にするのか、build・install・rollbackを伴う更新機構にするのかを決める。開発時の
  source編集可能性を、配布後のruntime変更可能性と同一視しない。

### 配布・外部化

#### 配布・外部化の調査背景と未決事項

standalone executableとAgent Definition専用のmanaged revision store / resolverは、Self-revision Cycle 1前段として
採用した。決定の正本は[`docs/roadmap.md`](../roadmap.md)と
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)である。この節には判断の
背景となった実機確認と外部比較、および未採用の後続候補だけを残し、採用済み方針は再掲しない。

instruction component、tool component、Provider Definitionの外部化、共通plugin方式、hot reloadは採用していない。
Agent Definitionで採用したloader、dependency、promotion、activationのsemanticsを、それらへ自動的に一般化しない。

現行Henjiの境界:

- workspace-local external Agent DefinitionはTypeScriptとしてWorker内で評価できる。一方、配置先はworkspace内に限定され、
  任意のnamed agent catalog、共通の外部resource store、配布後の更新・rollback契約は未整備である。
- built-in instruction componentは独立したTypeScript sourceになったが、standalone executableでは静的importされた内容が
  binaryへ埋め込まれる。配布後も置換可能にするには、外部revision storeまたは更新機構が別途必要になる。
- external Agent Definitionはroot compositionの既存toolを同一identity・nameで置換できるが、catalog外の新tool identityを
  一般登録するseamはない。
- Providerは`openrouter` / `openai`、API種別、auth profileのclosed unionであり、adapter factory、credential resolver、
  provider state、raw evidence、model catalog、Denoのnetwork permissionも現在の二providerを前提にしている。新providerを
  外部定義だけで追加できるregistry contractはまだない。

Deno 2.9.4の公式仕様と実機確認:

- `deno compile`の出力はDeno runtimeを内包するtarget OS・architecture別のstandalone executableであり、実行権限と
  platform互換性があれば任意のpathへ配置できる。binaryの配置先、Henjiのstate、config、書換可能な外部resourceの
  配置先は分離し、binary隣接pathへの書込みを前提にしない。
- compiled executableから、build時に埋め込んでいない外部`.ts`をcomputed dynamic `import()`し、その外部moduleが
  relative importする別の`.ts`も読み込めることをDeno 2.9.4で確認した。また、compile時のimport mapと埋込み済みAPI
  moduleを使い、外部`.ts`のbare specifierをbinary内APIへ解決できることも確認した。
- `deno compile --include`はbuild時にmoduleやWorkerをbinaryへ埋め込む機能であり、稼働後の`module install`ではない。
  runtimeで外部moduleを読むにはcompile時のread permissionが必要であり、permissionはbinaryへ固定される。現在のlauncherが
  起動時のworkspace・state rootから組み立てるDeno permissionは、そのままstandalone binaryへ移せない。
- `--app-name`はDeno KV、`localStorage`、cache等のorigin-bound storage identityをbinaryのrename後も安定させるが、
  Henjiが明示pathで所有するSessionやmodule storeの配置を自動的に決めるものではない。

AgentによるDefinition候補生成、登録、人間による採用、Instance binding transitionはF24ではなく、Self-revision Cycle 1の
F20〜F22で扱う。LLM-callableなmodule install tool、receipt、Host follow-upをどのexactなSurface / protocolで表すかは、
Cycle 1の個別phaseで決める。

pinned `_refs/pi` commit `08dc60bc52d89d6823a9738cc90b1916e5e446e5`（package version 0.85.1）の調査結果:

- PiのProvider構成は三層である。組み込みproviderは`packages/ai/src/providers/*.ts`と生成model catalogを本体へ組み込み、
  `builtinProviders()`で登録する。
- OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AIのいずれかと互換なproviderは、
  `~/.pi/agent/models.json`でbase URL、API種別、認証値の解決方法、header、model、model overrideを外部定義できる。
- 独自protocol、独自streaming、OAuth、modelの動的取得が必要なproviderは、globalまたはproject-localのTypeScript extensionから
  `pi.registerProvider()`で登録できる。簡易configだけでなく、auth、model取得・filter・refresh、`stream`、
  `streamSimple`を持つ完全な`Provider` objectも登録できる。
- extensionは`jiti`で外部TypeScriptを同一processへloadする。compiled binaryではextensionがimportするPi APIを
  `virtualModules`としてbinaryへ組み込み、外部extension自体は再buildなしで読めるようにしている。auto-discovery対象は
  `~/.pi/agent/extensions/`と`.pi/extensions/`で、`/reload`による再読込にも対応する。
- Piの配布binaryはBun compileで作られる。`jiti`は`moduleCache: false`で外部TSをloadし、reload時にはPi側のextension
  cacheも明示的にclearする。npm/git packageは管理directoryへ導入する一方、local pathの`pi install`はcopyせずpathを
  settingsへ登録する。
- Piの`/reload`はstreamingまたはcompaction中には開始せず、旧ExtensionRunnerへ`session_shutdown(reason: reload)`を送り、
  旧contextを失効させた後、settings、provider登録、extensions、skills、prompts、themes、context filesを再読込して
  runtimeとtool registryを再構築する。同じAgentSessionとtranscriptは保持し、新runnerへ
  `session_start(reason: reload)`を送る。
- PiにはLLM-callable `reload_runtime` toolのexampleがあり、tool自身はreloadせず、follow-up user commandをqueueし、現在の
  tool execution後にcommand contextから`ctx.reload()`する。Henjiでturn完了後に新Worker generationへ切り替える案に近い。
- `ctx.reload()`後も呼出元の古いcommand frame自体はreturnまで続くが、旧contextは明示的にinvalidとなり、後続のcommand、event、
  tool callは新runtimeを使う。Pi自身もreloadをhandlerの終端として扱うよう案内しており、Henjiのtool call途中でactive
  Definitionを置き換えない方針を補強する。
- 完全なextension Providerは同じIDのbuilt-inをcomposition baseとして置き換えられ、`models.json`のmodel overrideは
  さらに上位のuser configとして適用される。登録・解除は初期load後なら即時反映できる。
- Pi extensionは独立processのExecutable Definitionではなく、Pi本体とsystem permissionを共有するin-process pluginである。
  外部化、hot reload、強い実装自由度には有効だが、実行分離やpermission ceilingは提供しない。
- local extension pathはmutableであり、各reloadをimmutable revisionとして保存したり、Sessionをextension digestへbind
  したりはしない。Piのreload sequencingは参考になるが、Henjiのrevision storeと採用境界は別に設計する必要がある。

pinned `_refs/zot` commit `f60e492e551892e737d24a7eaf7730f1f60b75af`（tag v0.3.72）の調査結果:

- Zot本体はstatic Go binaryであり、extensionは任意言語の外部programをsubprocessとして起動し、stdin/stdoutのJSON-RPCで
  command、tool、lifecycle event、panelを接続する。Piのin-process TypeScript extensionとは異なる。
- `zot ext install <path|git-url>`はlocal directoryをcopy、またはGitをshallow cloneして
  `$ZOT_HOME/extensions/<name>`へ配置する。`./.zot/extensions/<name>`をproject-local、`zot --ext <path>`を開発時の
  直接loadに使える。
- `/reload-ext`は現在のextension subprocess群を停止し、manifestを再読込して全extensionをrespawnし、ready後に稼働中
  Agentのtool registryとsystem promptを更新する。Zotfileの`entry.pre`完了後にもextensionとskillをreloadするため、
  startup actionが導入したresourceを次turnから使える。
- extension lifecycleはsession start/end、tool call/result、compaction、permission decision、subagent、user prompt等の通知を持ち、
  `before_agent_start`ではsession開始時のsystem promptを置換できる。subprocessへはcwd、provider、model、Zot version、extension・
  data directory等のHost metadataを渡す。Henjiで外部DefinitionへどのHost情報を公開するかを明示contractにする際の比較材料になる。
- `zot ext doctor`とstartup・`/reload-ext` diagnosticsは、manifest、実行file、handshake、登録競合、stderr log pathまでextension単位で
  報告する。Henjiのmodule inspectとactivation failureをAgentと人間の双方からreadback可能にする設計の参考になる。
- Zotにも専用LLM向けinstall toolはなく、Agentから行うならbash等でCLIを呼ぶ。installed directoryはmutableで、Sessionを
  immutable extension revisionへbindする方式ではない。process分離とregistration protocolは参考になるが、Agent
  Definitionそのものの世代交換とは異なる。

pinned `_refs/deepseek-harness` commit `c291e7961a515f6d7af9304e7fd1d257929aef26`の調査結果:

- Cordisを基盤としてmodel adapter、tool registry、session log、agent loopを含む各要素をpluginとして構成する。ただし
  developer previewであり、互換性を壊す変更があり得るため、現行APIではなくlifecycle上の考え方を参考にする。
- 永続pluginと、Agentがsession中に生成するdynamic packageは別経路である。永続pluginはprofile directoryへpackage managerで
  導入し、bundle・patch layerとしてcompositionへ加える。dynamic packageは`cordis_define`、`cordis_run`、
  `cordis_stop`、`cordis_undefine`というmodel-facing toolで管理する。
- `cordis_define`は提出されたJavaScriptの構文を検査し、同じpluginにimmutable package versionを追加するだけで実行しない。
  `cordis_run`の`run`は初回起動・再起動、`update`は別versionへの切替を表す。pluginは稼働versionの
  `currentPackageId`と切替対象の`nextPackageId`を別々に持ち、完全に起動できた後だけcurrentを更新する。失敗したtargetを
  currentにせず、旧packageをrollback先として残せる。
- dynamic definitionはsession単位で所有されるが、active pluginの効果は同一process内の他sessionにも及び得る。definition registryは
  process memoryだけにあり、再起動すると消える。tool-call履歴には提出sourceとreceiptが残るが、repository file、dependency、
  `cordis.yml`を変更する永続installではない。
- dynamic codeは外部TypeScript moduleではなく、tool call引数として渡すplain JavaScript function bodyである。package IDはHostが
  発行する識別子で、source・dependencyをcontent digestで固定するrevision storeではない。このため、Henjiが検討している
  任意pathのTypeScriptをsnapshot化し、再起動後もSessionから参照できるmanaged revisionとは目的と永続性が異なる。
- Cordisのeffect ownershipにより、plugin unload時にはhandler等のeffectを巻き戻す。loaderはstable entry IDを使って変更entryだけを
  create、update、removeできる。Henjiの初期実装ではAgent Definition全体のWorker generation交換を優先できるが、将来の局所的な
  component reloadとcleanup契約の参考になる。
- Henjiへ直接取り込める設計原則は、`define/install`と`activate`の分離、immutable version、`current`と`next`の分離、
  新Workerの起動成功後だけactive revisionを更新すること、旧revisionをrollback可能に保つこと、source・diagnostics・runtime stateを
  Agent自身がinspectできることである。DeepSeek Harnessの「everything is a plugin」をそのまま採用する判断ではなく、Henji Hostが
  履歴正本、credential、provider evidence、module store、Worker lifecycleを所有する既存境界の内側へ適用する候補とする。
- DeepSeek Harnessでは永続profile pluginとsession-local dynamic packageが分離している。Henjiではさらに、session中のcandidateを
  一時revisionとして定義し、人間の採用後に永続managed revisionへpromoteする二段階を設けるかを検討できる。

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/1eee2938b4eeb7a4d72e17035adda669a89b63de)
commit `1eee2938b4eeb7a4d72e17035adda669a89b63de`（coding-agent package version 0.9.4）の調査結果:

- Prime AgentはPiを基盤にしたTypeScript Hostと、modelに唯一のbuilt-in toolとして公開する永続IPython kernelを組み合わせる。
  file操作、shell、skill、subagent、context操作をPythonからprogrammaticに行う一方、provider call、Session永続化、child lifecycle、
  schedule等のauthoritative operationはHost側に残し、kernelからtyped host requestで呼ぶ。この分離は、Henjiの外部moduleへ
  実装自由度を与えながら、履歴正本とlifecycleをHost-ownedに残す案の比較材料になる。
- 通常経路はTUI client、daemon supervisor、Session worker、AgentSession、kernelを別processとして構成する。TUI切断後もworker、
  kernel、schedule、subagentが稼働し、再接続できる。ただしprocess分離はlifecycleとfailure containmentのためで、OS user権限を
  分けるsecurity sandboxではない。
- Session正本はSQLiteではなく、`~/.prime/agent/sessions/`のJSONLである。entryは`id` / `parentId`によるtreeを形成し、message、
  tool result、model変更、compaction、branch summary、extension state、child usage、Session lifecycle等を追記する。
  compactionは旧entryを削除せず、summaryと`firstKeptEntryId`を持つentryを追加し、provider context構築時にactive branchを歩いて
  summaryと保持suffixへ投影する。Henjiのcanonical transcriptとprovider向け派生projectionの分離に近い一方、永続媒体はJSONLである。
- IPython namespaceはSession artifact内の`kernel-state.dill`とmanifestへvariable単位でbest-effort snapshot化する。Python stateは
  tool call間とcompactionを越えて保持され、Session resume時にも復元されるが、serialize不能または上限超過のvariableはskipされる。
  transcriptと作業用計算状態を別の永続層として扱う例である。
- `rlm.spawn()`は独立contextとSession directoryを持つ通常のchild `AgentSession`を起動し、完了を待たずstable handleを返す。
  結果はreturn valueではなくagent messageまたはfileで親へ明示的に渡す。親のchild registryはcompaction、kernel restart、Session
  restoreを越えて復元され、child transcriptとartifactは削除操作後もdiskへ残る。
- Continual Harnessはprompt note、memory、Python skillの参照契約、subagent spec、refinement eventをSession-localまたはglobalな
  `harness_state.json`へ保存する。`/refine`またはmodel-callable `refine.run()`は、現trajectoryから小さい変更案を作り、current turn
  終了後に適用してsystem promptを再構築する。base system promptはimmutableで、各editのbefore/afterとrefinement historyから
  rollbackできる。planning中に対象entryが変わった場合はそのeditを適用しない。
- Continual Harnessのskill entryは既存Python callableへの説明・参照であり、新しい実行codeをpackage化する機構ではない。実行可能な
  Python-backed skillは別途`SKILL.md`、`pyproject.toml`、Python packageとしてuserまたはproject directoryへ配置し、kernel venvへ
  editable installする。metadataは`/reload`で再探索できるが、新しいPython-backed skillは新Sessionでkernel setupが必要になる。
- Prime Agentのrefinementはagent自身がturn境界でlocal/global補助状態を更新でき、人間によるcandidate採用を必須にはしない。
  immutable base、small edit、scope、conflict検出、rollbackは参考になるが、HenjiのF24で想定するcandidate生成と人間の採用境界、
  immutable module revision、Session bindingを置き換えるものではない。

Henjiで個別incrementへ採用するときの検討候補:

- Piと同様に、互換providerをdata-only Definition、独自protocolをexecutable Provider Definitionとして分けるか。
- Agent、instruction、tool、providerを同じloaderへ載せるか、resourceの性質ごとにloaderと更新単位を分けるか。
- executable DefinitionをWorker内TypeScript pluginとするか、process・permissionを分離したExecutable Definitionとするか。
- Provider registryへ移行する場合も、credential値の非継承、adapter固有state、raw SSE evidence、request count、timeout、
  network permissionをprovider definitionへ無条件に委譲せず、Henji-owned contractとしてどこまで固定するか。
- instruction、tool、providerその他の外部resourceについて、identity、revision、dependency lineage、Manifest attribution、
  reload時のbinding、rollbackを、F24で選んだ対象の候補生成・人間による採用flowへどう接続するか。
- 採用済みのAgent Definition専用storeとは別に、instruction、tool、providerを同じloaderへ載せる必要が実利用から
  生じるか。共通化する場合も、評価後の`AgentManifest`をrevision authorityにせず、対象resourceごとのdependency、
  promotion、activation semanticsをF24で決める。
- Cycle 1でLLM-callableな`module-install` toolを採用するか。採用する場合、登録receiptを返して現turnを終え、既に分離した
  人間の採用操作とHost-owned activationを、どのfollow-upと次Worker generationで表すか。
- DeepSeek Harnessの`define -> inspect -> run/update -> stop/rollback`を参考に、HenjiのCLI/toolも
  `module install`、`module inspect`、`module activate/update`、`module stop/rollback`へ責務を分けるか。candidate登録時には実行せず、
  activation成功時だけSessionのactive revisionを更新する契約を置くか。
- Prime AgentのContinual Harnessを参考に、code module revisionとは別に、prompt note、memory、skill reference、subagent specのような
  軽量な補助状態を改訂対象として持つか。持つ場合も、agentによる即時適用ではなくHenjiの人間による採用境界へどう接続するか。
- canonical transcript、provider context projection、kernelまたは外部moduleの作業用stateを、同じ保存機構へ混在させず別のlifecycleと
  復元保証で扱うか。Prime AgentのJSONL、harness JSON、kernel dillという分離と、ForgeのSQLite journalを比較する。

Pi調査箇所: `_refs/pi/packages/ai/src/providers/all.ts`、`_refs/pi/packages/ai/src/models.ts`、
`_refs/pi/packages/coding-agent/src/core/model-runtime.ts`、`_refs/pi/packages/coding-agent/src/core/provider-composer.ts`、
`_refs/pi/packages/coding-agent/src/core/extensions/loader.ts`、`_refs/pi/packages/coding-agent/docs/models.md`、
`_refs/pi/packages/coding-agent/docs/custom-provider.md`、`_refs/pi/packages/coding-agent/docs/extensions.md`、
`_refs/pi/packages/coding-agent/src/core/resource-loader.ts`、`_refs/pi/packages/coding-agent/src/core/agent-session.ts`、
`_refs/pi/packages/coding-agent/src/core/package-manager.ts`、
`_refs/pi/packages/coding-agent/examples/extensions/reload-runtime.ts`。

Zot調査箇所: `_refs/zot/docs/extensions.md`、`_refs/zot/docs/zotfiles.md`、
`_refs/zot/packages/agent/extensions/manager.go`、`_refs/zot/packages/agent/extcmd.go`、
`_refs/zot/packages/agent/modes/interactive.go`、`_refs/zot/packages/agent/cli.go`。

DeepSeek Harness調査箇所: `_refs/deepseek-harness/README.md`、
`_refs/deepseek-harness/docs/architecture.md`、
`_refs/deepseek-harness/docs/cordis-tutorial/06-composition-and-hmr.md`、
`_refs/deepseek-harness/apps/cli/src/plugin.ts`、
`_refs/deepseek-harness/packages/extensions/cordis-host-runner/README.md`、
`_refs/deepseek-harness/packages/extensions/cordis-host-runner/src/index.ts`、
`_refs/deepseek-harness/packages/extensions/tool-cordis/README.md`、
`_refs/deepseek-harness/packages/extensions/tool-cordis/src/index.ts`。

Prime Agent調査箇所（snapshot未追加）:
[README](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/README.md)、
[architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/docs/architecture.md)、
[RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/docs/rlm.md)、
[RLM runtime](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/docs/rlm-runtime.md)、
[Session format](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/docs/session-format.md)、
[compaction](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/docs/compaction.md)、
[refinement](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/src/core/refinement/refinement.ts)、
[kernel snapshot](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/packages/coding-agent/src/core/kernel/state-snapshot.ts)、
[Python harness state](https://github.com/PrimeIntellect-ai/prime-agent/blob/1eee2938b4eeb7a4d72e17035adda669a89b63de/prime-agent-runtime/src/rlm/harness.py)。
