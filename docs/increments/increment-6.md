# 通常利用 increment 6 — recoverable inputとwork tool component化

ステータス: local実装、focused verification、bounded implementation review、authoritative offline gateは
2026-09-07に完了。production retained TUI human gate待ち。

## この文書の位置付け

この文書は、通常利用で実際に再現したcancel後の入力再送不能とidle Ctrl-Cの操作感を直し、次の
incrementでprovider-neutralな`web_search`を追加できるよう既存work toolのmaterialize境界をcomponent化する
初期実装計画である。利用者は2026-09-07にこの二つをincrement 6へ採用し、`web_search`をincrement 7、
Markdown rendererをそれ以降へ送る順序を決定した。

計画review GO後、ユーザーが2026-09-07にこの初期計画を明示的に承認した。以下のscopeで
local実装と検証を開始できる。

## 利用者が必要とする動作

### 1. recoverable inputとidle Ctrl-C

1. 人間がproduction retained TUIでtaskを送信し、実行中にEscでcancelした場合、未commitの元taskを失わず、
   cancel settlement後に同じSessionのeditorへ戻す。人間はそのまま、または編集して明示的に再送できる。
2. `contract_failure`またはmodel step上限でも、同じrecoverable active-task経路を使って元taskをeditorへ戻す。
3. cancelまたは失敗前にtool callが一回以上あった場合は、workspaceへeffectが残り得るという既存warningを
   保ったままtaskを戻す。復元だけでは自動再送しない。
4. settlement時に人間が別のdraftを編集中なら、そのdraftを上書きしない。recoverable laneを保持し、idleの
   exact `/recover` commandでactive task、未消費steering、未送信follow-upの順に一件ずつeditorへ取り出せる。
5. idleのCtrl-Cは現在のeditor inputとinput-history navigationをclearして同じprocessとSessionのreadyへ戻る。
   editorが空でもexit confirmationへ進めずreadyを維持する。通常終了は空editorのCtrl-Dまたは`/exit`を使う。
6. busyのEsc cancellation、busy Ctrl-Cのcancel／二回押下exit、Ctrl-D、signal、Session navigation、viewport、
   steering／follow-up admissionの既存semanticsは変更しない。

再現済みの受入経路は次である。

```text
user> READMEを韓国語に翻訳して表示して
<Esc>
failure> cancelled
editor> READMEを韓国語に翻訳して表示して
<Enter>
user> READMEを韓国語に翻訳して表示して
```

二回目のEnterは`active task recovery pending`で拒否されず、同じSessionの新しい未commit turnを開始する。

### 2. 既存work toolのcomponent化

1. `read`、`write`、`edit`、`bash`、`bash_output`を、Agent Definitionが選択したtool resource identityから
   Worker内でmaterializeできる`ToolComponent`として扱う。
2. componentは少なくとも、選択に使う`tool:*` identityと、既存のmodel向けcontractおよびexecutorを持つ
   `Tool`をWorker-local runtime bindingsから生成するfactoryを一単位にする。
3. `Registry`のprovider向けdefinition生成、guideline集約、tool call dispatch、tool result contractは変えない。
   built-in default componentでは各work toolのname、description、input schema、`promptGuidelines`、実行結果、
   cancellation、上限も変えない。Executable Definitionが明示した置換componentは、同じtool nameを保った上で
   description、schema、guideline、executorをそのDefinitionの選択として置換できる。
4. built-in component catalogを既定とし、Executable Agent Definitionがcomposition構築時に同じidentityの
   componentを明示的に差し替えられるWorker-local seamを設ける。関数をHost/Worker protocolで転送しない。
5. Definitionが宣言したidentity、materializeされたcomponent identity、生成された`Tool.name`の対応を検証し、
   provider definition、Registry dispatch、manifest/resource selectionが異なるtoolを指さないようにする。
6. `bash`と`bash_output`は、現在どおり一つのRegistry lifetimeで同じ`BashOutputStore`を共有する。
7. plannerが持つ`read`も同じbuilt-in `read` componentからmaterializeする。root composition向けのcomponent
   置換はplannerへ暗黙に継承せず、plannerへwrite、edit、bash、bash_outputを追加しない。
8. corpus/eval専用fixture toolは通常のAgent Definitionで選択されるwork toolではないため、現在の直接構築を
   維持する。

## 根拠となる明示要件と実行証拠

- 2026-09-07のproduction retained TUIで、翻訳taskをEsc cancelした後に同じpromptを再入力すると
  `active task recovery pending`となり、同じprocess内で再送できなかった。
- `PendingInputCore`は未commit active taskをrecoverable laneへ移し、`popRecovery()`でactive task、steering、
  follow-upの順に返す。controllerにもeditorへ戻す`popRecovery()`処理があるが、現行key eventまたはslash
  commandから到達する入口がない。
- modern idle Ctrl-Cはeditor textまたはrecoverable inputがあると二回押下のdiscard-and-exitへ入り、通常の
  shellと同じ「現在の入力を消して同じprocessで続ける」動作にならない。
- 現行`Tool`はname、description、input schema、任意guideline、executorを既に一単位として表す。
  `Registry`もdefinition生成とdispatchを既に一元化している。
- 一方、Definitionが宣言したtool identityのmaterializeは`registries.ts`の固定switchであり、Definitionが
  tool componentを追加・差し替える公開composition seamはない。
- pinned Piのextension contractではcustom toolのcontract、executor、任意rendererを登録でき、同名built-in
  toolの置換もできる。Henjiはこの観測をcomponent化の参考にするが、Piのruntime mutation、renderer、plugin
  discoveryをこのincrementへ移植しない。

## 現行product経路と変更境界

### TUI input recovery

現行のproduction経路は次である。

```text
InputDecoder
  → TuiController.editor
  → PendingInputCore.admitTask
  → ordinary_submit intent
  → Worker turn
  → cancelled / max_steps / contract_failure settlement
  → PendingInputCore.recoverAfterSettlement
  → idle TUI
```

変更はHost-owned TUI input stateへ閉じる。Worker protocol、canonical Session transcript、committed turn、
provider adapterは変更しない。復元されたtextはeditor draftであり、再送して成功するまでcanonical Sessionへ
commitしない。

settlement後、controllerは既存`recoverAfterSettlement()`を完了してから次を行う。

- editorが空でrecoverable active taskがある場合は、その一件をeditorへ戻しcursorを末尾へ置く。
- editorが空でなく自動復元できない場合、recoverable laneを保持して`/recover`を案内する。
- `/recover`はidleでのみHost-localに処理し、modelへ送らない。command textをeditorから除いた後、既存の
  deterministic順序で一件をeditorへ戻す。recoverable itemがなければ状態を変えず通知する。
- tool call後のwarningは復元後もclearせず、次のordinary task admissionが成功した時点で既存どおりclearする。

### Tool component

現行経路は次である。

```text
Agent Definition capabilities.tools
  → createDeclaredRegistry
  → createDeclaredToolの固定switch
  → Tool
  → Registry
  → provider definition / dispatch
```

increment 6では次へ変える。

```text
Agent Definition capabilities.tools
  → Worker-local ToolComponentCatalog
  → selected ToolComponent.materialize(runtime bindings)
  → Tool
  → 既存Registry
  → 既存provider definition / dispatch
```

`ToolComponent`とcatalogはWorker内の実行componentであり、data-only manifestやHost/Worker messageへfunctionを
入れない。default componentは現在の`createReadTool`、`createWriteTool`、`createEditTool`、`createBashTool`、
`createBashOutputTool`を呼ぶ薄いfactoryとし、executor本体を複製しない。

Executable Definition向けroot composition optionは、既定catalogに対して同じ`tool:*` identityとtool nameの
componentを明示的に置換できるようにする。この置換はbuilt-in planner compositionへ暗黙に伝播させない。
選択されていない新しいtool identityの追加、active Session中の動的変更、filesystemからのplugin探索はこの
incrementでは成立させない。increment 7の`web_search`では、このcomponent境界を使った新identityの選択を
別計画で追加する。

component identityはこのincrementでは既存`AgentResourceIdentity`を使う。built-in component sourceはHenji
runtime sourceの一部、external Definitionがinlineで選んだ置換はそのDefinition entry revisionの一部として
扱う。別module importまで含むdependency lineageと独立したtool revision identityは未実装のまま明示する。

## 対象外

- provider-neutralな`web_search`のcontract、検索backend、credential、cost、network permission、実装、test。
  increment 7で別計画にする。
- OpenRouterの`openrouter:web_search` server toolと旧web plugin。
- assistant Markdown renderer、Mermaid、content kind変更。
- tool plugin directory探索、package installation、runtime hot reload、`/reload`、同じWorker generation中の
  tool追加・削除・置換。
- tool componentの独立revision repository、import dependency lineage、候補生成、人間による採用、F24完了。
- tool固有TUI renderer、parallel tool execution、provider tool-call protocol、canonical transcript schema変更。
- `skill`、`delegate_to_planner`、`submit_json_result`のreplaceable work component化。
- built-in default work toolの機能、permission、入力制限、上限、result schemaの変更。

## 主な実装対象

1. recoveryとCtrl-C:
   `v0/tui/controller.ts`、`v0/tui/pending_input.ts`（既存primitiveで不足する最小操作だけ）、
   `v0/tui/render.ts`のhelp/status、関連するTUI focused test。
2. tool component:
   new `v0/agent/tool_components.ts`または同等の単一component境界、`v0/agent/registries.ts`、
   `v0/agent/tools.ts`、`v0/agent/worker_agent_api.ts`、必要なDefinition/component topology test。
3. 既存work tool factory:
   `v0/agent/work_tools.ts`と`v0/agent/bash_output.ts`は原則としてexecutorを変更せず、factory exportまたは
   binding型に機械的な調整が必要な場合だけ変更する。
4. 現在形の文書:
   `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、
   `docs/experience/normal-use-inbox.md`、new `docs/increments/increment-6-results.md`、`.handoff/handoff.md`。

source inspectionで上記以外の既存consumerに固定tool materializerまたはslash command一覧の期待値が見つかった
場合は、確定scopeとの整合だけを同じ変更に含める。新しいproduct動作、外部contract、Host/Worker protocol
変更が必要なら計画変更としてユーザーへ戻す。

## 実装順序

1. cancel／失敗settlementからrecoverable active taskを空のeditorへ戻し、`/recover`で残るlaneへ到達できる
   controller経路を接続する。
2. idle Ctrl-Cをeditor clear＋readyへ変更し、busy cancellationと明示exit経路を維持する。
3. `ToolComponent`とWorker-local catalogを追加し、既存work tool factoryをbuilt-in componentとして登録する。
4. `createDeclaredRegistry`をcomponent catalogからmaterializeするよう変更し、bash pairのshared storeとplanner
   read selectionを維持する。
5. Executable Definitionが選択済みidentityのcomponentをcomposition構築時に明示置換できるseamを接続し、
   effective manifest/resource selectionとの一貫性を確認する。
6. 変更したproduct動作に対応するfocused test、type check、format、lint、`git diff --check`を実行する。
7. stable candidateをbounded implementation reviewし、accepted findingがあれば局所修正と一回のchanged-lines
   re-reviewを行う。その後、coordinating ownerがauthoritative `v0:gate`を一回だけ実行する。
8. results、architecture、roadmap、normal-use inbox、handoffを実測した現在形へ更新し、production retained TUI
   human gateへ渡す。

## 検証と受入れ

各確認は次の具体的なproduct動作へ対応させる。test件数やcomponent数自体を完了条件にしない。

### Focused verification

- cancel recovery: controllable sessionで翻訳promptを送信し、Esc cancellation settlement後に元prompt全文と
  末尾cursorがeditorへ戻る。committed turnは増えず、Enterで同じSessionの次のordinary submitが開始し、
  `active task recovery pending`にならない。
- failure recovery: `contract_failure`またはmodel step上限の既存recoverable settlementでも元taskをeditorへ
  戻し、自動再送しない。tool call countが正の場合は既存effect warningを表示する。
- occupied editor: settlement時に別draftがある場合は上書きせず、`/recover`が既存順でrecoverable textを
  editorへ戻す。unknown commandや通常promptとしてmodelへ送られない。
- idle Ctrl-C: 一行・複数行draftとinput-history navigationを一回のCtrl-Cでclearし、process、Session、turn、
  viewportを維持してreadyになる。空editorでもCtrl-Cでexitせず、空editorのCtrl-Dと`/exit`は終了する。
- busy control regression: busy Esc、busy Ctrl-C、follow-up／steering、cancel cleanup settlementは既存結果を
  保つ。
- component selection: default parentはread、write、edit、bash、bash_outputを各一回だけmaterializeし、plannerは
  readだけを同じcomponent経路から得る。provider tool definitionとmanifestの既存tool集合・name・schemaを
  保つ。
- component replacement: test用Executable Definitionが選択済みwork tool identityへ代替componentを一つ
  明示し、identityとtool nameを保った代替contractとexecutorだけがrootのprovider definitionとRegistry
  dispatchへ現れる。他のwork tool、built-in default、plannerのreadを変更せず、functionはWorker protocol
  messageへ現れない。
- work tool regression: temporary workspaceでread window、write、editを実行し、bashの通常出力とtruncated出力を
  bash_outputで末尾まで読む既存product動作がcomponent経路後も同じになる。

focused確認には既存のTUI controller/retained-terminal suite、filesystem suite、bash-output suite、
current-code/Worker foundationのcomponent topology testを使う。必要ならincrement 6の直接test fileを一つ追加
する。実装中は該当focused testと`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`だけを使い、`v0:test`や
`v0:gate`を繰り返さない。

stable candidateに対するreview後、authoritative `deno task --config deno.v0.json v0:gate`をcoordinating ownerが
一回だけ実行する。

### Production retained TUI human gate

local実装、focused verification、implementation review、authoritative offline gateがGOになった後も、
production/provider/credentialを使う確認は自動で開始しない。ユーザーの別の明示承認後、現在のproduction
launcherで次を一回確認する。

1. `READMEを韓国語に翻訳して表示して`を送信し、visible responseの完了前にEscでcancelする。
2. `failure> cancelled`後、元promptがeditorへ戻り、同じSessionのcommitted turnが増えていないことを確認する。
3. 復元promptをそのままEnterで再送し、`active task recovery pending`にならず新しいturnが開始することを確認
   する。再送後のprovider完了をこのcancel/recovery確認の必須条件にはしない。
4. idleで別の複数行draftを作り、Ctrl-C一回でclearされ、TUIが終了せず同じSessionのreadyへ戻ることを確認
   する。
5. 通常利用中のreadと、4,096 bytesを超える既知の一つのbash出力を既存bash_outputで読み、component化後も
   tool call/resultと末尾readbackが成立することを確認する。write/editによるworkspace変更はhuman gateでは
   行わずtemporary workspaceのfocused testを正本にする。

## Review contractとImplementation Human Gate

初期計画reviewはこの文書、採用済みscope、現行TUI pending-input/controller、Agent Definition、Registry、
work tool factory、pinned Piのcustom-tool registration contractだけを対象にする。目的は、二つの採用事項を
production経路で成立させる計画として、実装境界、既存contractとの整合、回帰経路、検証可能性に具体的な
欠落がないか確認することである。

- initial review: read-only、30分以内。10分間新しい証拠・tool結果・中間結論がなければ確認済み範囲を返す。
- severity: Blocker / P1 / P2。findingは明示scopeまたは確認済みsourceから利用者影響までの経路を示す。
- findingを反映した場合のre-review: changed linesと既存finding closureだけ、15分以内、最大一回。
- plan GO: 未解決Blocker/P1/P2がなく、scope、実装対象、依存順、product test、human gate、対象外が一意である。

一般的なsecurity hardening、未観測provider variant、Web search、Markdown、plugin loader、F24全体はreview対象外
とする。reviewerはproduct source/configを変更せず、testやfull gateを実行しない。

計画review GO後は初期implementation Human Gateで停止する。ユーザーがreview済み計画を明示的に承認する前に、
product source/test/config変更、test実行、production/provider/credential操作を行わない。承認後はlocal実装、
focused verification、bounded implementation review、authoritative offline gate、results/architecture/roadmap/
inbox/handoff更新までを継続できる。production human gate、commit、push、tag、publish、releaseは別の明示指示を
必要とする。

## Plan review結果

- 初回read-only reviewは、cancel後のstate遷移、component identity・Registry・manifestの一貫性、既存work
  tool contractの維持、focused verificationとhuman gateの到達可能性を現行sourceに照合した。Blocker 0、
  P1 0、P2 2でNO-GOだった。
- 一つ目のP2は、built-in default contractを維持する要件と、明示的な置換componentがcontractを差し替える
  seamの記述が区別されていなかったことである。defaultだけを完全維持し、置換componentはidentityに対応する
  tool nameを保ちながらmodel contractとexecutorを置換できると明記した。
- 二つ目のP2は、root Definitionが選んだcomponent置換をbuilt-in plannerの`read`へ継承するか未確定だった
  ことである。increment 6ではrootだけへ適用し、plannerはbuilt-in `read` componentを維持すると確定した。
- changed-lines re-reviewはGOで、二つのP2はClosed、未解決Blocker/P1/P2は0。scope、実装境界、依存順、
  product verification、human gate、対象外は実装へ進める状態である。review中にproduct source/config変更、
  test、full gate、provider requestは行っていない。
