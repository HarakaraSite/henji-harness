# 通常利用メモ

Henjiを通常利用して得た観測と未採用の改善候補を、topicごとに蓄積する。

- 一行の自由なメモでよい。
- 日時、F番号、原因、解決策は、書けるときだけ書く。
- まとまった時点で検討し、roadmap、architecture、構想、個別の実装計画などへ振り分ける。
- 個別incrementへ採用した項目は、そのincrementの正本文書へ移して未振り分け一覧から除く。
- 見出しの順序は優先順位を表さず、この文書への記載だけでは採用または実装を意味しない。

## 未採用候補

### Surface: Session一覧の識別情報（低優先度、F01、F05、F10）

- 保存済みSessionに、人間が一覧で内容を識別できるtitleを持たせたい。
- default titleは、最初のturnの内容をもとにAIが自動で付ける。
- 自動生成後も、人間がtitleを変更できるようにする。
- Session一覧には最終turn等の日時も表示したい。ただし、現行の1行表示には十分な幅がない。
- 自動生成の実行時点、利用model、再生成の扱い、変更用UIと、日時を含む識別情報の表示方法は、
  個別incrementへ採用するときに決める。

### Surface: slash command候補の逐次絞り込みと補完（低優先度、F01、F10）

- 入力が先頭の`/`から始まる場合、その後のkey入力ごとに一致するslash command候補を絞り込んで表示する。
- 可能なら、選択した候補を現在の入力bufferへ補完できるようにする。
- 候補の選択key、補完を確定するkey、引数を持つcommandの扱いは、個別incrementへ採用するときに決める。

### Surface: provider認証statusとHenji内credential登録（F01、F02、F10）

通常利用での観測と要望:

- `henji --root-provider openai`はcredential未登録でも起動でき、最初のprovider request時にcredential不足が分かる。
- 選択中providerが未認証の状態なら、requestを送る前からフッター1行目の一時status欄へその旨を表示したい。
- API keyの登録をHenji内のslash commandから行えるようにしたい。

個別incrementで決めること:

- credential fileが存在しない状態と、登録値がproviderに拒否された状態をどう区別し、何を「未認証」と表示するか。
- slash command名、secretを通常の入力buffer・会話履歴・process argumentへ残さない入力方法、登録先auth profileの選択、
  fixed credential fileへの保存と更新結果の表示。
- OpenRouter、OpenAI direct、将来providerで共通化する範囲と、Sessionのroot routeを切り替えた時のstatus更新時点。

### Surface: 履歴閲覧の後続候補（F01、F05、F10）

increment 3では、現在SessionのPageUp/PageDown、Esc、task送信による最新追尾への復帰と、history位置表示を
実装し、通常利用で受け入れた。`/history export`はincrement 4へ採用済み。次の操作は未採用である。

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

### Surface: assistant本文のrendering（F01、F10、将来のF24候補）

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

### Agent実行: 調査時のtool選択（F02、F06、将来のF24候補）

観測:

- repository調査で、8.7 KiBのREADMEに`read`を使わず、4 KiBで出力が切れる`bash cat`と`tail`を
  繰り返してstepを消費した。
- 対象repositoryにtool選択を導くinstructionはなく、productionのtool descriptionにも当時は`read`を
  優先する方針がなかった。Henjiのbash環境では`rg`がPATH外なので`grep`の選択は妥当だった。
- `read`のline windowとactive guidelineはincrement 4、`bash`全出力readbackはincrement 5、既存work toolの
  component化はincrement 6で実装済みである。

未採用候補:

- `read`以外のtoolについて、実際の誤選択が観測された場合にtool固有guidelineまたはdescriptionを改善する。
- 独立したread-only調査は、可読性を保った別tool callとして同じmodel stepにまとめる。結果依存の調査や
  fallbackは順次行う。

### Agent実行: Web searchの後続境界（F02、F06、将来のF24候補）

現行確認:

- Increment 7から9で、Henji-owned `web_search`、OpenRouter Sonar backend、groundingと直接URL citationを
  実装し、production通常利用で受け入れ済みである。
- 現行の`web_search`は一つのtool componentであり、Sonarを交換可能backendが内部利用するmodelとして扱う。

未採用候補:

- OpenAI Responses APIのbuilt-in Web searchを、現行OpenRouter Sonarと同居可能な将来backend候補として保持する。
  初期候補は、modelに`websearch1`、`websearch2`という実装名を直接選ばせるより、一つの意味上の`web_search`
  toolに対してAgent Definitionまたはtool componentがbackendを選ぶ構成とする。二つを同時にmodelへ公開する必要が
  生じた場合は、品質、費用、検索範囲など、人間とmodelが選択理由を理解できる別contractとして検討する。
- OpenRouterの`openrouter:web_search` server toolを、同じ`WebSearchBackend`境界へ追加する将来backend候補
  として保持する。
- 将来も「modelを内包する機能」として扱うか、検索・解釈を担当する`WebSearch AgentDefinition`として
  conversation、prompt、model、tool利用を明示的に所有させるかは未決である。agent化が必要になる具体的な
  task、状態、委譲、revision上の利点が観測された時点で比較する。

### F24候補: revision付きtool componentとMCP component

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

### F24候補: sourceから派生物を作るAgent instruction

観測:

- 既存READMEの実験的な中国語版を依頼したところ、modelは原文を忠実に翻訳せず、章構成、Go要件、
  command、設定名、JSON contract、exit codeを変更し、架空のcommandと章を追加した。
- git管理外という依頼に対してtrackedな`.gitignore`も変更した。
- 完了後にsourceとの自己監査を明示すると、modelは不整合を検出できた。
- fresh Sessionで日本語の「READMEを読み10行で要約」という依頼に対し、modelは`README.ja.md`だけを
  readしたが、回答では未読の`README.md`も読んだように述べた。

Agent-level instruction候補:

- 既存sourceから派生物を作るtaskでは、current sourceを正本として直接使い、記憶や一般templateから
  再構成しない。
- 明示された変換以外では、構造、事実、identifier、command、設定名、schema、example、link、product
  behaviorを維持する。
- 完了前にsourceと成果物を照合し、意図しない追加、欠落、構造変更、contract変更を確認する。意図した
  差異は明示する。
- temporaryまたはuntracked artifactのためだけに、明示依頼なくtracked fileへ変更を広げない。
- 実際にtoolで取得したsourceだけを確認済みとして述べ、推定したsourceは区別する。
- これらは`write` tool固有ではなく、source-grounded transformationを扱うAgent-level instruction候補とする。

### F24候補: instruction componentのrevision化と自己改定

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
