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

#### Surface: Session一覧の識別情報（低優先度、F01、F05、F10）

- 保存済みSessionに、人間が一覧で内容を識別できるtitleを持たせたい。
- default titleは、最初のturnの内容をもとにAIが自動で付ける。
- 自動生成後も、人間がtitleを変更できるようにする。
- Session一覧には最終turn等の日時も表示したい。ただし、現行の1行表示には十分な幅がない。
- 自動生成の実行時点、利用model、再生成の扱い、変更用UIと、日時を含む識別情報の表示方法は、
  個別incrementへ採用するときに決める。

#### Surface: slash command候補の選択・補完（低優先度、F01、F10）

- 表示中のslash command候補を選択し、現在の入力bufferへ補完できるようにする。
- 候補の選択key、補完を確定するkey、引数を持つcommandの扱いは、個別incrementへ採用するときに決める。

#### Surface: busy中の経過時間表示（F01、F10）

- 長いprovider生成やtool loopを人間が判断できるよう、フッター1行目の`busy`表示の直後へtask開始後の経過時間を
  表示したい。
- 表示形式、更新間隔、task受付・provider request・tool実行のどこを起点とするかは、個別incrementへ採用するときに
  決める。

#### Surface: Henji内credential登録（F01、F02、F10）

通常利用での観測と要望:

- API keyの登録をHenji内のslash commandから行えるようにしたい。

個別incrementで決めること:

- slash command名、secretを通常の入力buffer・会話履歴・process argumentへ残さない入力方法、登録先auth profileの選択、
  fixed credential fileへの保存と更新結果の表示。
- OpenRouter、OpenAI direct、将来providerで共通化する範囲。

#### Surface: 履歴閲覧の後続候補（F01、F05、F10）

increment 3では、現在SessionのPageUp/PageDown、Esc、task送信による最新追尾への復帰と、history位置表示を
実装し、通常利用で受け入れた。`/history export`はincrement 4へ採用済み。次の操作は未採用である。

- `/history`等の明示的なread-only履歴閲覧modeと、vi風の`j`/`k`、`Ctrl-U`/`Ctrl-D`、`g`/`G`、
  `q`/Esc。
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

#### Agent実行: 調査時のtool選択（F02、F06、将来のF24候補）

観測:

- repository調査で、8.7 KiBのREADMEに`read`を使わず、4 KiBで出力が切れる`bash cat`と`tail`を
  繰り返してstepを消費した。
- 対象repositoryにtool選択を導くinstructionはなく、productionのtool descriptionにも当時は`read`を
  優先する方針がなかった。Henjiのbash環境では`rg`がPATH外なので`grep`の選択は妥当だった。
- `read`のline windowとactive guidelineはincrement 4、`bash`全出力readbackはincrement 5、既存work toolの
  component化はincrement 6で実装済みである。
- Increment 23のHuman Gateでは、Qwenが複数の`bash` callへ毎回
  `cd /home/masat.guest/src/forgejo-agent && ...`を付けた。現行system instructionはRuntime factsとして同じcwdを
  注入し、bash executorも各callの`cwd`をworkspace rootへ設定済みなので、この`cd`は不要だった。
- fresh-shell guidelineは`cd`の状態が後続callへ残らないことと、必要なsetupを同じcallに置くことを伝えるが、
  各callが最初からworkspace rootで始まることを明記していない。このためmodelがworkspace rootへの`cd`も
  毎回必要なsetupと解釈した可能性がある。

未採用候補:

- `read`以外のtoolについて、実際の誤選択が観測された場合にtool固有guidelineまたはdescriptionを改善する。
- 独立したread-only調査は、可読性を保った別tool callとして同じmodel stepにまとめる。結果依存の調査や
  fallbackは順次行う。
- bash descriptionまたはactive guidelineへ、各callがRuntime factsに示したcurrent workspace directoryから
  始まること、同じdirectoryへ`cd`せずrelative pathを使うこと、別subdirectoryから実行する必要がある場合だけ
  そのcall内で`cd`することを明記する。新しいcwd注入機構は追加しない。

#### Agent実行: Qwen xhighの長時間調査（利用者所感、対応候補ではない）

- Session `c41865cf`のForgejo API概要調査は完遂したが、約9分6秒、24 root model requests、5 web searches、
  33 tool callsを要した。成功runのprovider responseは全29件がHTTP 200で、root modelのraw responseは約1.84 MB、
  4,813 SSE eventsだったため、provider failureよりQwen `xhigh`の長い推論と調査反復が時間の中心だった。
- 利用者所感として、これはQwenのmodel特性である可能性があり、利用時に気をつける。modelごとに個別対応すると
  際限がないため、この観測をmodel固有のinstruction、step・tool上限、effort既定値等のproduct対応候補にはしない。

#### Agent実行: Web searchの後続境界（F02、F06、将来のF24候補）

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

### F24・自己改定

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

#### 配布・F24候補: 各種Definitionの外部化とPiのProvider構成

対象はAgent Definition、instruction component、tool component、Provider Definitionである。現時点では将来課題として
保存し、共通plugin方式や外部化の採用は決定しない。

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

pinned `_refs/pi` v0.84.2の調査結果:

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
- 完全なextension Providerは同じIDのbuilt-inをcomposition baseとして置き換えられ、`models.json`のmodel overrideは
  さらに上位のuser configとして適用される。登録・解除は初期load後なら即時反映できる。
- Pi extensionは独立processのExecutable Definitionではなく、Pi本体とsystem permissionを共有するin-process pluginである。
  外部化、hot reload、強い実装自由度には有効だが、実行分離やpermission ceilingは提供しない。

Henjiで個別incrementへ採用するときの検討候補:

- Piと同様に、互換providerをdata-only Definition、独自protocolをexecutable Provider Definitionとして分けるか。
- Agent、instruction、tool、providerを同じloaderへ載せるか、resourceの性質ごとにloaderと更新単位を分けるか。
- executable DefinitionをWorker内TypeScript pluginとするか、process・permissionを分離したExecutable Definitionとするか。
- Provider registryへ移行する場合も、credential値の非継承、adapter固有state、raw SSE evidence、request count、timeout、
  network permissionをprovider definitionへ無条件に委譲せず、Henji-owned contractとしてどこまで固定するか。
- 外部resourceのidentity、revision、dependency lineage、Manifest attribution、reload時のSession binding、rollbackを、
  F24の候補生成・人間による採用flowとどう接続するか。

Pi調査箇所: `_refs/pi/packages/ai/src/providers/all.ts`、`_refs/pi/packages/ai/src/models.ts`、
`_refs/pi/packages/coding-agent/src/core/model-runtime.ts`、`_refs/pi/packages/coding-agent/src/core/provider-composer.ts`、
`_refs/pi/packages/coding-agent/src/core/extensions/loader.ts`、`_refs/pi/packages/coding-agent/docs/models.md`、
`_refs/pi/packages/coding-agent/docs/custom-provider.md`、`_refs/pi/packages/coding-agent/docs/extensions.md`。
