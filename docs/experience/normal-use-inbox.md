# 通常利用メモ

Henjiを通常利用して得た観測と未採用の改善候補を、topicごとに蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。
- 個別incrementへ採用した項目は、そのincrementの正本文書へ移して未振り分け一覧から除く。
- 見出しの順序は優先順位を表さず、この文書への記載だけでは採用または実装を意味しない。

## 未採用候補

### Surface: 履歴閲覧の後続候補（F01、F05、F10）

increment 3は、現在SessionのPageUp/PageDown、Esc、task送信による最新追尾への復帰と、history位置表示を
対象に採用した。次はincrement 3の対象外として残す。

- `/history`等の明示的なread-only履歴閲覧modeと、vi風の`j`/`k`、`Ctrl-U`/`Ctrl-D`、`g`/`G`、
  `q`/Esc。
- mouse wheelを共通scroll actionへ接続するためのterminal mouse tracking。
- shortcutまたはslash commandでcanonical history bufferを外部editorへ渡す閲覧出口。

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

- 未採用の改善候補として保存し、increment 3のscopeへは追加しない。

### Surface: conversation labelの色分け（F01、F10）

利用者要望:

- conversation履歴を識別しやすくするため、`user>`をblue、`assistant>`をamber等で色分けしたい。

実装候補:

- まず本文全体ではなくrole labelだけを着色する。長文の可読性とterminal themeへの依存を抑える。
- ANSI escapeを`LayoutRow.text`へ埋め込まず、layoutはplain text、role、label幅等の表示metadataを返し、
  Host rendererがterminal出力直前に色を適用する。既存のcell幅、wrap、cursor計算を変えない。
- 各label直後にSGR resetを入れて色漏れを防ぎ、frame byte上限ではANSI code分も数える。
- amberは標準16色に固有名がないため、ANSI yellowをthemeへ委ねるか256-colorを使うかを実装incrementで
  決める。`tool>`等の追加色、色無効化、legacy/non-retained表示への適用は同時採用を前提にしない。
- canonical transcript、Worker protocol、Presentation contractは変えず、Host TUI内の表示変更として扱う。

現在の扱い:

- 未採用の改善候補として保存し、increment 3のscopeへは追加しない。

### Surface: assistant本文のrendering（F01、F10、将来のF24候補）

観測:

- Henjiの回答をterminal向けplain textとして読みやすくする余地がある。

改善候補:

- TUIへのMarkdown renderer導入を検討する。通常利用increment 2では対応せずpendingとした。
- increment 3以降では、まず現在のplain text出力を変えず、assistant本文のrendererだけをTUI内部の
  差し替え可能なcomponentへ抽出する。その後Markdownを採用する場合も対応範囲を限定して始める。
- Mermaid等が必要になった場合はrenderer全体の交換だけでなく、Markdown内のblock rendererを拡張する。
  一般的なplugin/load機構までは現時点で決めない。
- agentが具体的なrenderer実装を選ぶのではなく、plain text、Markdown、Mermaid等の意味上のcontent kind
  またはpresentation intentを返し、Host側のSurfaceが利用可能なrenderer componentへ解決する境界を
  候補とする。現在のstring出力contractを変える必要が生じた場合は、F10と将来のF24として構想・
  architectureへ戻って検討する。

### Surface: tool activityの表示（F01）

観測:

- tool callの内容の一部を確認できる点はよい。例:
  `tool> bash GOCACHE=/tmp/gocache go run ./cmd/fja --help ✓`
- 現在の表示にはさらに改善の余地があるが、具体的な変更内容は未整理。

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
- `read`へ`offset`・`limit`と続きを示すtruncation resultを追加し、`bash`は切り詰め前の全出力を保存して
  必要時にreadbackできるようにする案を検討する。

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
  指針の合成はAgentCompositionの責務候補として検討する。
- tool利用効率は現時点ではF02・F06の通常改善として扱う。ここで整えるtool metadataやinterfaceは将来の
  F24実装基盤として再利用できるが、それだけでF24完了とはしない。

現行component境界の確認:

- 現行の`Tool`はname、description、input schema、executorを一単位にし、`Registry`がproviderへ渡す
  definition生成とtool call時のexecutor解決を担う。`AgentComposition`も`Registry`を保持するため、実行時の
  部品としてはcomponent化されている。
- `AgentDefinition`は`tool:read`や`tool:bash`等をresource identityとして表現できるが、実際のmaterializeは
  core内の固定switchである。公開`@henji/agent`にも任意のtool componentを追加・差し替えるauthoring APIは
  ないため、external Definitionが新しいtoolやmetadata variantを通常の契約で組み込める状態ではない。
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
  instructionを改訂対象にするときの候補とする。現時点では採用済みarchitectureまたはincrement 3の
  追加scopeとはしない。
