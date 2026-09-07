# 通常利用メモ

Henjiを通常利用して得た観測と未採用の改善候補を、topicごとに蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。
- 個別incrementへ採用した項目は、そのincrementの正本文書へ移して未振り分け一覧から除く。
- 見出しの順序は優先順位を表さず、この文書への記載だけでは採用または実装を意味しない。

## 未採用候補

increment 4から6へ採用した項目は各`docs/increments/increment-N.md`へ移した。以下は各incrementへ
採用していない観測と候補だけを残す。

### Surface: 履歴閲覧の後続候補（F01、F05、F10）

increment 3では、現在SessionのPageUp/PageDown、Esc、task送信による最新追尾への復帰と、history位置表示を
実装し、通常利用で受け入れた。`/history export`はincrement 4へ移し、それ以外の操作候補を残す。

- `/history`等の明示的なread-only履歴閲覧modeと、vi風の`j`/`k`、`Ctrl-U`/`Ctrl-D`、`g`/`G`、
  `q`/Esc。
- mouse wheelを共通scroll actionへ接続するためのterminal mouse tracking。
- exportした履歴を`$VISUAL`または`$EDITOR`で自動的に開く閲覧出口。

### Surface: `/reload`によるresource再読込（F01、F03、F10）

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

現在の扱い:

- 未採用の改善候補として保存する。

### Surface: assistant本文のrendering（F01、F10、将来のF24候補）

観測:

- Henjiの回答をterminal向けplain textとして読みやすくする余地がある。

改善候補:

- TUIへのMarkdown renderer導入を検討する。通常利用increment 2では対応せずpendingとした。
- plain textのassistant renderer component抽出はincrement 4へ移した。その実装後、Markdownを採用する
  場合も対応範囲を限定して始める。
- Mermaid等が必要になった場合はrenderer全体の交換だけでなく、Markdown内のblock rendererを拡張する。
  一般的なplugin/load機構までは現時点で決めない。
- agentが具体的なrenderer実装を選ぶのではなく、plain text、Markdown、Mermaid等の意味上のcontent kind
  またはpresentation intentを返し、Host側のSurfaceが利用可能なrenderer componentへ解決する境界を
  候補とする。現在のstring出力contractを変える必要が生じた場合は、F10と将来のF24として構想・
  architectureへ戻って検討する。

現在の扱い:

- ユーザーが2026-09-07に、increment 6の作業量を限定するためincrement 7より後へ送ると決定した。

### Agent実行: 調査時のtool選択と結果readback（F02、F06、将来のF24候補）

観測:

- repository調査で、8.7 KiBのREADMEに`read`を使わず、4 KiBで出力が切れる`bash cat`と`tail`を
  繰り返してstepを消費した。
- 対象repositoryにtool選択を導くinstructionはなく、productionのtool descriptionにも`read`を優先する
  方針はない。Henjiのbash環境では`rg`がPATH外なので`grep`の選択は妥当だった。

改善候補:

- 固定instruction、tool description、tool設計のどこで効率的な選択を支えるか検討する。
- 独立したread-only調査は、可読性を保った別tool callとして同じmodel stepにまとめる。結果依存の調査や
  fallbackは順次行う。

参照実装から得た未採用の示唆:

- Piはtoolごとのdefinition metadataにdescription、schema、実行処理、TUI表示に加えて
  `promptGuidelines`を持たせ、有効なtoolのguidelineだけをsystem promptへ合成する。`read`には
  「`cat`や`sed`ではなく`read`でfileを調べる」という選択指針がある。
- Zotはtool利用指針をsystem promptへ追加せず、tool schema・descriptionとmodelの判断に任せる。
  CLIのstep上限は既定で無制限であり、必要な場合だけ`--max-steps`で指定する。
- PiとZotの`read`は50 KiBまたは2,000行で区切り、`offset`・`limit`で続きを読める。`bash`も同じ上限で
  区切るが、全出力を一時fileへ保存し、必要なら読み返せる。

現在の扱い:

- byte・line上限はtool実装またはtool設定、tool固有の選択指針はtool definition metadata、有効toolと
  指針の合成はAgentCompositionの責務候補として検討する。既存`read`、`write`、`edit`、`bash`、
  `bash_output`のcomponent化はincrement 6で実装済み。
- tool利用効率は現時点ではF02・F06の通常改善として扱う。ここで整えるtool metadataやinterfaceは将来の
  F24実装基盤として再利用できるが、それだけでF24完了とはしない。
- `read`のline windowとactive guidelineはincrement 4、`bash`全出力readbackはincrement 5へ移した。他toolの
  guidelineは未採用のまま残す。

### Agent実行: Web search tool（F02、F06、将来のF24候補）

利用者判断:

- 通常利用を続けるうえで、modelがtool callとして使えるWeb searchの必要性が高まりつつある。
- `web_search`をincrement 5とincrement 6には含めず、既存work toolのcomponent化後にincrement 7として扱う。
- URL本文を取得して人間向けtextへ変換する`web_open`は、人間にはbrowserがあるため現時点では必要性を
  感じず、候補に含めない。
- provider-neutralなHenji-owned tool componentと交換可能な検索backendに分ける方針をユーザーが
  2026-09-07に選んだ。
- 初期backendは、既存OpenRouter credentialで`perplexity/sonar`を一回呼ぶ。実測した
  `message.content`と順序付き`message.annotations[].url_citation`から、回答とtitle/URLのsource一覧を
  modelへ返す。
- OpenRouterの`openrouter:web_search` server toolを使うbackendは将来案として保持し、現在の実装には
  含めない。Exa MCPは却下し、MCP component自体も将来構想へ送る。

現在の扱い:

- increment 7へ採用し、local実装、focused verification、コード／テストreview、authoritative offline gateを
  完了した。結果は`docs/increments/increment-7-results.md`へ移した。production retained TUI human gateと
  ユーザー受入は未実施である。

現行component境界の確認:

- 現行の`Tool`はname、description、input schema、guideline、executorを一単位にし、`Registry`がproviderへ
  渡すdefinition生成とtool call時のexecutor解決を担う。
- increment 6で既存work toolのcomponent境界を作り、increment 7で`web_search`をbuilt-in componentとして
  追加した。選択済みの`read`、`write`、`edit`、`bash`、`bash_output`、`web_search`をWorker-local
  `ToolComponentCatalog`からmaterializeする境界を追加した。公開`@henji/agent`のroot composition optionで
  同一identity・nameのcomponentを明示置換できる。catalog外の新tool identityをexternal Definitionから追加する
  一般seamはまだない。
- 現在の`DefinitionRevisionRef`はentry moduleを固定するが、別moduleとしてimportするtool componentまで
  含むdependency lineageは未実装である。したがって、toolは「実行component」ではあるが「独立したrevisionを
  持ち、自己改訂候補としてDefinitionへ組み込めるcomponent」にはまだなっていない。

将来の境界候補:

- tool componentを、revision identity、model向けcontract（name、description、schema、
  `promptGuidelines`）、Worker内で物理I/Oへbindするexecutorに分ける。
- `AgentDefinition`がrevision付きtool componentを選択・合成し、`Registry`は有効なtoolのdefinitionと
  guidelineだけを組み立てる。選択結果はmanifestへ出し、Definition revisionはimportしたcomponentの
  dependency revisionも固定する。
- 直近のtool選択改善では、まず`Tool`へ`promptGuidelines`を追加し、`Registry`で集約して
  AgentCompositionのsystem instructionへ合成する。この継ぎ目は将来のF24に再利用できるが、toolの
  candidate生成・revision保存・人間による採用がない段階ではF24完了とはしない。

### F24候補: tool実行権限とsandboxed Deno program

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

### F24: sourceから派生物を作るAgent instruction

観測:

- 既存READMEの実験的な中国語版を依頼したところ、modelは原文を忠実に翻訳せず、章構成、Go要件、
  command、設定名、JSON contract、exit codeを変更し、架空のcommandと章を追加した。
- git管理外という依頼に対してtrackedな`.gitignore`も変更した。
- 完了後にsourceとの自己監査を明示すると、modelは不整合を検出できた。

Agent-level instruction候補:

- 既存sourceから派生物を作るtaskでは、current sourceを正本として直接使い、記憶や一般templateから
  再構成しない。
- 明示された変換以外では、構造、事実、identifier、command、設定名、schema、example、link、product
  behaviorを維持する。
- 完了前にsourceと成果物を照合し、意図しない追加、欠落、構造変更、contract変更を確認する。意図した
  差異は明示する。
- temporaryまたはuntracked artifactのためだけに、明示依頼なくtracked fileへ変更を広げない。
- この規則は`write` tool固有ではなく、source-grounded transformationを扱うAgent-level instruction候補とする。

追加観測:

- fresh Sessionで日本語の「READMEを読み10行で要約」という依頼に対し、modelは`ls`後に
  `README.ja.md`だけをreadした。日本語版の自動選択自体は妥当だったが、回答では未読の`README.md`も
  読んだように「`README.ja.md`（および`README.md`）」と述べた。
- これは、関連sourceの存在や翻訳関係の推定を、toolで確認済みのsource attributionへ昇格させた事例と
  扱う。共通instruction候補として、実際にtoolで取得したsourceだけを確認済みとして述べ、推定した
  sourceは区別する規則を検討する。

### F24: agent別instruction componentとPi型の合成

利用者判断:

- HenjiもPiのようにbuilt-inの共通instructionを持ち、agentごとのinstructionをcomponentとして合成する
  方式が好ましい。

現行確認:

- 現行Henjiはworkspace rootの`AGENTS.md`または`AGENTS.MD`一つとskill manifestをsystem instructionへ
  合成する。built-in `planner`だけは末尾にplanner policyを追加するため、`default`と`planner`の
  振る舞いをinstructionとtool構成の両方で既に分けている。
- workspace-local external Definitionは異なる`systemInstruction`を返せるため、agent AへX、agent BへYを
  技術的には設定できる。一方、公開`createDefaultAgentComposition()`にはagent固有instructionを追加する
  first-class optionがなく、任意のnamed agent catalog、instruction resource identity、manifestとの一貫した
  authoring契約は未整備である。
- Piはbuilt-in coding-agent promptを基礎に、append prompt、globalからcwdまでのproject context、skill、
  tool guideline、runtime factsを合成し、extensionによる差し替えも持つ。Zotもbuilt-in identity、custom
  system prompt、globalからcwdまでのAGENTS、skill、runtime factsを分離している。どちらもAGENTSだけを
  唯一のagent-wide instruction層にはしていない。

設計候補:

- `Henji共通instruction + agent role instruction + 有効toolのguideline + global/rootからcwdまでのworkspace
  instruction + skill manifest + runtime facts`を独立componentとして合成する。
- source attributionのような全agent共通規則はHenji共通componentへ、原文構造を維持する翻訳規則や
  read-only planningなどはagent role componentへ置く。全文をagentごとに複製せず、共通部分のdriftを防ぐ。
- instructionは振る舞いを誘導するものであり、必須のcapability境界はtool構成でも表現する。たとえば
  read-only agentはinstructionだけでなくwrite/edit toolを持たせない。
- componentの選択結果、revision identity、合成順と競合規則をManifestへ記録できる形を、F24で
  instructionを改訂対象にするときの候補とする。現時点では採用済みarchitectureとはしない。
