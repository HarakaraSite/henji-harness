# Increment 131 — 誰でもないサブエージェント（agent:generic）と起動時モデル指定

状態: 実装完了（2026-09-26）。focused test・type check・format・lint・`git diff --check`確認済み。
architecture正本変更1〜5を反映済み。通常利用メモのA13をこのincrementへ移設済み（A14はinboxに残す）。
authoritative `v0:gate`は計画が要求していないため未実施。実装commit `6d7a5d39`からbuildしたbinary
（build `55d99dc5…`）を利用者の指示に基づき`~/.local/bin/henji`へ配置済み。

## 必要なproduct動作と根拠

- 利用者希望（2026-09-24、通常利用メモA13より移設）: Codexのように「gpt-6-lunaでこのtaskの子Agentを
  起動」と依頼し、用途やモデルごとに名前付きAgent Definitionを用意せず委譲したい。「無名」は事前登録する
  `agent:<name>`が不要という意味の仮称で、実行を参照する`runId`まで無くす意味ではない。

- 利用者希望（2026-09-24、通常利用メモA13）: 「gpt-6-lunaでこのtaskの子Agentを起動」のように、
  用途やモデルごとに名前付きAgent Definitionを用意・install・bindせずに委譲したい。
- 形態（2026-09-26、利用者決定）: 「登録ゼロのspawn」ではなく、**「誰でもない」汎用サブエージェント
  `agent:generic`をHostが常時1件登録する**形を採る。install・bind・`agents.json`手当ては不要。
  実行参照の`runId`は残る。
- 起動時指定（利用者決定）: spawnごとに**model**と**tool構成**を指定できる。
  - model指定: `{provider, modelId, effort?}`。省略時は親Sessionのselection。
  - tool指定: `tools: string[]`でtool名（通常名）を列挙し、宣言済みtoolから絞り込む。
    省略時は宣言どおり全部（default構成7つ）。bash/bash_output/web_search/web_fetchは
    指定に含めれば任意に選べる。
- 再帰spawn（利用者決定）: `agent:generic`は子をspawnしない（`spawn_subagent`を持たない）。
- 名前付きchild（`agent:reviewer`等）にも起動時model指定・tool絞り込み指定を適用する（同一contract）。

## 現行経路（調査済み事実）

- `v0/agent/tools/async_agents.ts`: `spawn_subagent(agent, task)`の`agent`はHost解決済みcatalog名の
  enumのみ。`task`は64 KiB上限。`AsyncAgentRequest`のspawn variantは`{kind:'spawn', agent, task}`。
  失敗は`{ok:false, error:string}`契約。
- `v0/agent/tools/registries.ts:118-123`: `asyncAgentNames.length === 0`なら`spawn_subagent`を
  materializeしない。`asyncAgentNames`は`agents.json`のbinding解決
  （`worker_tui_session.ts` `resolveAsyncAgents`）→`worker_bootstrap.ts`→
  `agent_definition.ts`の`input.asyncAgentNames`へ流れる。
- `v0/agent/worker/worker_host_children.ts` `ChildRunRegistry.spawn`: catalog名→
  `WorkerAsyncAgentCatalogEntry {name, ref}`を解決し、`run.model = options.initialModelSelection ??
  ROOT_DEFAULT_MODEL_SELECTION`。`childOptions`が`resolveManagedModule(entry.ref)`と
  `initialModelSelection: run.model`を子Workerへ渡す。`ExecutableAgentDefinitionInput`には
  `asyncAgentNames?: readonly string[]`のようにHostから子へ構造化入力が渡る既存seamがある。
- `v0/agent/definitions/agent_definition.ts` `declarationsFor`: default capabilitiesのtool宣言は
  `tool:bash`／`tool:bash_output`／`tool:edit`／`tool:read`／`tool:web_fetch`／`tool:web_search`／
  `tool:write`＋`tool:submit_json_result`（常に宣言）＋skillsがあれば`tool:skill`。
  `asyncAgents`は`input.asyncAgentNames`から生成（子がspawn toolを持つ条件）。
- `v0/agent/worker_agent_api.ts` `createAgentComposition`: `tools`／`additionalTools`／`asyncAgents`／
  `roleInstruction`／maxSteps option。model optionはなく、子modelはHostの
  `initialModelSelection`経路（`worker_bootstrap.ts`の`createModel('parent', initialModelSelection)`）
  だけで決まる。
- selection identityは`provider`／`api`／`authProfile`／`modelId`／`effort`。検証は
  `selectModelFor(provider, modelId, effort?)`（unknown provider／unknown model／unsupported effortで
  `RangeError`）。
- 組み込みDefinitionは`builtin/default`のみ。`managed_resource_ref.ts`は`builtin/default`／
  `builtin/planner`をreserved idとして除外し、`builtinDefinitionRef`は`agent: 'default'`固定。
  非development buildではbuild manifestの`BUILTIN_DEFINITIONS`（`scripts/build_henji.ts`）の
  closure digestが必須。
- architecture（`docs/architecture/henji-host-agent-worker.md`）: async agent catalog `agent:<name>`は
  `agents.json`のmanaged selector。「modelは…catalog名だけを渡せる」「child Definitionのmodule、
  role/model、execution evidenceはcatalogで選択したexact refのprovenanceから一貫して決め」る。
  「組み込みdefaultは解決済みcatalogの名前を宣言し、未設定時はasync child toolを持たない」。
  「外部Agentのchild executionは通常のroot selection経路を使う。Agent名別の同梱model既定は持たない」。
  childのdurable admission/settlement、parent-execution-scoped addressability、one-shot fork/joinは
  維持（変更しない）。

## 提供するproduct動作

1. **`agent:generic`の常時利用**（install/bind不要）:
   Hostは組み込みgeneric定義（bundled ref `builtin/generic`）をcatalogへ常時解決して提供する。
   `agents.json`が空でも`spawn_subagent`から`agent:generic`を起動できる。status／collect／cancelの
   runId操作とdurable admission/settlementは名前付きchildと同一。
   `generic`は予約名で、`agents.json`に同名bindingがある場合はtyped failure
   （malformed/missing規定と同格。2026-09-26追加決定）。
2. **起動時モデル指定**（generic・名前付きchildの両方）:
   spawn入力の`model: {provider, modelId, effort?}`をcatalog検証経路（`selectModelFor`相当）で解決し、
   `run.model`として子Workerの`initialModelSelection`へ渡す。child execution evidence（projectionの
   `modelSelection`）にも記録される。
   省略時は親Sessionの**現在のselection**（`/model`変更後を引き継ぐ。2026-09-26追加決定）。現行の
   `initialModelSelection`固定の挙動を変更し、名前付きchildも現在selectionを引き継ぐ。
   modelの不正指定はspawnを失敗させrunIdを返さない（現行`{ok:false, error}`契約を維持し
   新error契約は作らない）。
3. **起動時tool指定**（generic・名前付きchildの両方）:
   spawn入力の`tools: string[]`（通常名。例`["read","bash","web_search"]`）で、そのchildの
   **宣言済みtoolから絞り込む**。定義の宣言以上のtoolは足せない。省略時は宣言どおり。
   **tool名の検証はそのchildの宣言済みtool集合に対して行い、固定のtool名vocabularyは持たない。**
   そのため将来の新規tool（例: A15のsearch）がdefault宣言に加われば、`agent:generic`にも自動的に
   現れ、起動時指定でもそのまま使える。
   失敗面（2026-09-26追加決定）: 入力の形状不正（配列でない・非string要素・空配列）はtool入力の
   形状error（`ToolInputError`）でrunIdなし。値不正（未知のtool名・絞り込み結果がゼロ）は子側で
   検証し、起動直後に失敗するrunとしてcollectに失敗が返る（runIdは発行される）。
   有効tool集合はchild execution evidenceに記録する。
   絞り込み可能対象は宣言済みtool全体。`tool:skill`と`tool:submit_json_result`は絞り込み対象外の
   例外で、指定に含めても含めなくてもdeclaredであれば残る。declaredでなければ現れない
   （エラーにしない）。
4. **`agent:generic`のinstruction/tool構成**（利用者決定）:
   tool宣言はdefault構成と同じ（7つ＋`submit_json_result`）。instructionはdefaultと同じbase
   instruction/guidelines＋起動時task本文で、role文なし。再帰spawnは持たない
   （`asyncAgentNames`を空にして`spawn_subagent`をmaterializeさせない）。

## 対象範囲

- `v0/agent/tools/async_agents.ts`の`spawn_subagent` input schemaと`AsyncAgentRequest` spawn variant
  （`model`・`tools`追加）。
- `ChildRunRegistry.spawn`のselection解決（per-spawn model・省略時はsession現在のselection）・
  tool指定の子への伝達、`childOptions`→`ExecutableAgentDefinitionInput`への新入力
  （`asyncAgentNames`と同じseam）。
- `declarationsFor`／`createAgentComposition`での「宣言済みtool ∩ 指定tool」絞り込み。
- `agent:generic`用bundled定義`builtin/generic`（`createDefaultAgentComposition`基底、
  `asyncAgentNames`空）と、bundled ref処理の拡張: `BUILTIN_AGENT_IDS`、reserved id
  （`managed_resource_ref.ts`）、`builtinDefinitionRef`、`definition_selection.ts`、
  build manifestの`BUILTIN_DEFINITIONS`（`scripts/build_henji.ts`）。
- 子module load path: `builtin/generic`を子Workerへ読み込む経路（`worker_definition_revision.ts`の
  builtin module pathは現状`default`専用、`childOptions`の`resolveManagedModule`はmanaged store専用）。
- Host側catalog組み立て: 親executionのasync catalogに`agent:generic`を常時含める
  （`worker_tui_session.ts`の`resolveAsyncAgents`経路。bindingゼロでも`undefined`にしない）。
  `registries.ts`のtool公開条件自体は変更しない。spawn済みchildは現状どおりcatalogを受け取らず
  spawn toolを持たない（再帰spawnなし）。
- child execution evidenceへのmodel selection・有効tool集合・`definitionRef`記録。
- 通常利用メモの整理: 採用完了時にA13をinboxからこのincrementへ移す（A14はinboxに残す）。
- focused test（下記）と関連fixture。

## 非対象

- A14（名前付き子Agent Definitionの専用model既定）。Definition APIへのmodel option追加も行わず、
  子modelはHostの`initialModelSelection`経路だけで成立させる（A14採用時に判断）。
- `agent:generic`の差し替え・カスタマイズ機能、generic定義の手動install/bind。
- spawnごとのtool**追加**（宣言以上のtoolの付与）。絞り込みのみ。
- recursive spawn、mailbox、restart reattach、follow-up、swarm UI（architectureのV1境界のまま）。
- `agents.json`のworkspace-scope binding、`subagent:<name>`復活。
- 名前別の同梱model既定（「Agent名別の同梱model既定は持たない」を維持）。
- bash本体の再設計（分離／sguidance／A5のvenv問題）、searchツール（A15）、A6のsearch/fetch分離。

## architecture正本の変更対象（2026-09-26、利用者承認済み。反映は実装と同時）

1. activation-level root slot節 → **意味変更**: 組み込み`agent:generic`を常時catalogに含め、
   bindingゼロでもgenericのみspawn可能にする（「未設定時はasync child toolを持たない」を改める）。
   slot値のdomain文「値はmanaged selector `moduleId@sha256:<digest>`」は`agent:generic`の
   bundled exact refを含む形へ、「`agent:<name>`は親Definitionが宣言する…catalog」の文は
   Host常設`agent:generic`を含む形へ修正する。`agents.json`の`generic`同名bindingは
   予約名typed failure（malformed/missing規定と同格）。
2. 「modelは任意pathや未解決selectorではなくcatalog名だけを渡せる」→ **緩和**: spawn入力に
   catalog検証済みのprovider/modelId/effortを渡せる。任意pathは引き続き渡さない。
   （agent名catalogとmodel catalogを区別する文言に改める。）
3. 「外部Agentのchild executionは通常のroot selection経路を使う」→ **明確化**: selection機構は
   rootと同じ経路を維持するが、selectionの**値**はspawn指定（新source）またはsessionの現在
   selectionを取り得る（省略時は現在selectionを引き継ぐ。`initialModelSelection`固定を変更）。
   「Agent名別の同梱model既定は持たない」は維持。child execution節の
   「role/model…exact refのprovenanceから一貫して決め」の文もmodel値のsourceを広げる形へ修正。
4. child execution節 → **追加**: spawn入力によるtool絞り込み（宣言済みtoolの部分集合。追加不可）と、
   有効tool集合・model selection・`definitionRef`のevidence記録を明記。値不正（未知tool名・
   絞り込みゼロ）は子側検証で起動直後の失敗runとなる失敗面も明記。
5. `spawn_subagent(agent, task)` contract → **拡張**: `model`・`tools`引数追加、常設`agent:generic`。
   durable admission/settlement、parent-scoped addressability、one-shot fork/joinは変更しない。

## 利用者決定（2026-09-26、レビュー後の設計協議）

1. tool一覧: 起動時指定を採用（指定＝宣言済みtoolからの絞り込み。追加不可）。
2. bash/bash_output: 可変方式により指定で任意。
3. web_search/web_fetch: 可変方式により指定で任意。
4. 再帰spawn: `agent:generic`は許可しない。
5. tool名: 子でも通常名のまま（prefix等なし）。
6. 名前: `agent:generic`（bundled `builtin/generic`）。
7. instruction: role文なし＋default base instruction/guidelines＋task本文。
8. model指定shape: `{provider, modelId, effort?}` object。`selectModelFor`検証。
9. 名前付きchildにも起動時model指定を適用（同一contract）。
10. model指定省略時: 親Sessionのselection。A14の優先順位はA14採用時に決める。
11. install/bind不要を維持。genericの差し替え機能は作らない。
12. model省略時の意味（2026-09-26追加決定）: sessionの現在のselection（`/model`変更後を引き継ぐ）。
    現行の`initialModelSelection`固定を変更する。
13. tools値不正の失敗面（同）: 未知tool名・絞り込み結果ゼロは子側検証で起動直後の失敗run。
    形状不正は`ToolInputError`でrunIdなし。model不正は現行`{ok:false, error}`でrunIdなし。
14. `agents.json`の`generic` binding（同）: 予約名としてtyped failure。
15. 名前付きchildのspawn tool: 現状維持（spawn済みchildは全員spawn toolなし・孫spawn不可のまま）。

## 未確認事項

- 将来互換（2026-09-26、利用者確認）: `/model`でproviderからmodel一覧を取得してカタログに登録する
  動的カタログ方式は、現行の`declaration.modelCatalog.entries`構造にそのまま乗り、A13側の変更を
  要しない。取得先・保存先・失敗時挙動・effort情報の補完は別incrementで決める（A13の非対象）。

- model指定の入力表記について、利用者語彙「gpt-6-lunaで」のようなmodelId単独表記を将来
  受け付けるか（providerが一意に決まる保証が必要）。初回はobject表記のみとし、利用実態を見て判断。
- 名前付きchildが`agent:generic`をspawnできるか（現状構造ではchildはcatalogを受け取らず発生しない）。
  将来childへcatalogを渡す場合は別途判断する。
- 名前付きchild（reviewer等）の宣言済みtoolと絞り込み指定の実運用差（reviewer宣言に含まれない
  tool名の指定がエラーになる挙動）が利用者期待と一致するか、実利用で確認する。

## 実装計画

1. `spawn_subagent` input schemaへ`model?: {provider, modelId, effort?}`と`tools?: string[]`を加え、
   `AsyncAgentRequest` spawn variantと`AsyncAgentRpc` data contractを拡張する。
2. `ChildRunRegistry.spawn`でper-spawn model指定を`selectModelFor`相当で解決して`run.model`へ。
   省略時はsessionの現在のselectionを引き継ぐ（現行の`initialModelSelection`固定を変更）。
   model不正は`{ok:false, error}`でrunIdを発行しない。tool入力の形状不正は`ToolInputError`で同様。
3. `childOptions`→`ExecutableAgentDefinitionInput`へtool指定を`asyncAgentNames`と同じseamで渡し、
   `declarationsFor`／`createAgentComposition`で「宣言済みtool ∩ 指定tool」を適用する。
   子側で未知tool名・絞り込み結果ゼロを検証し、該当時は起動直後に失敗するrunとする。
   `agent:generic`は`asyncAgentNames`を空にして再帰spawnを持たない。
4. `builtin/generic`を追加: `BUILTIN_AGENT_IDS`、reserved id、`builtinDefinitionRef`、
   `definition_selection.ts`、build manifest`BUILTIN_DEFINITIONS`を拡張し、production buildで
   exact refを発行できるようにする。子module load path（builtin module pathの`generic`対応）を追加。
5. Host側catalog組み立てで親executionのcatalogに`agent:generic`を常時含める（bindingゼロでも
   `undefined`にしない）。`agents.json`の`generic`同名bindingは予約名typed failure。
6. child execution evidenceにmodel selection・有効tool集合・`definitionRef`が記録されることを確認。
7. focused test、type check、format、対象lint、`git diff --check`。authoritative `v0:gate`は
   承認済み計画が要求する場合のみcoordinating ownerが一回実行する。
8. 完了後、通常利用メモのA13をこのincrementへ移し、A14はinboxに残す。

## test計画（対応するproduct動作）

- `agent:generic`の常時利用: `agents.json`未設定の状態でinstall/bindなしにspawn→runIdで
  status／collect／cancelが機能し、terminal結果がcollect結果として親contextへ入ること。
- 起動時model指定: 指定selectionでspawn（`agent:generic`・`agent:reviewer`の両方）→child runの
  selection/evidenceが指定modelになること。省略時はsessionの現在のselection（`/model`変更後）が
  引き継がれること。
- instruction構成: `agent:generic`のsystem instructionがrole文なし・default base instruction/
  guidelines＋起動時task本文で構成されること。
- evidence: 有効tool集合・model selectionがchild execution evidenceに記録されること。
- 起動時tool指定: `tools`指定で含めたtoolだけがchildで動作し、含めないtoolが無いこと。
  省略時は宣言どおり全部。未知tool名・絞り込み結果ゼロは起動直後に失敗するrun（collectで失敗）。
  入力形状不正は`ToolInputError`でrunIdなし。`agent:generic`＋model指定＋tool指定の合成caseを明示する。
- 再帰spawnなし: `agent:generic`のchildに`spawn_subagent`が存在しないこと。
- provenance: generic childのcollect結果／evidenceに`builtin/generic`の`definitionRef`が記録される。
- 不正model指定: spawnが失敗しrunIdを返さないこと。
- 名前付きchild regression: `agent:reviewer`の従来spawn/collectがregressionなく動作すること。

## レビュー結果（2026-09-26、計画に対するレビュー第1回）

- 通常レビュー（reviewer subagent）: 現行経路の事実記載はsourceと一致。Finding 2件。
  - [高] 無名childの「install・bind不要」は、`registries.ts`が`asyncAgentNames.length === 0`なら
    `spawn_subagent`をmaterializeせず（architecture「未設定時はasync child toolを持たない」と同じ境界）、
    `agents.json`未設定の主シナリオで無名spawnが呼び出せない。tool露出経路（`registries.ts`、
    `agent_definition.ts`、`worker_bootstrap.ts`のname宣言）が計画の対象範囲から漏れている。
  - [中] architecture変更案が不完全。「未設定時はasync child toolを持たない」と正面衝突する変更と、
    「外部Agentのchild executionは通常のroot selection経路を使う」の解釈・明確化が承認リストに無い。
- 批判的レビュー（reviewer subagent）: Finding 8件（High 1／Medium-High 1／Medium 3／Low 3）。
  - High 1: 上記[高]と同一のtool公開条件衝突に加え、無名spawnがcatalogの「spawn可能なagent名の
    境界」というinvariantを無条件化する点も変更案に現れていない。
  - Medium-High 2: per-spawn model指定と「child executionは通常のroot selection経路を使う」の
    関係（selection値の由来か機構か）が未明示で、selection authorityの変更が承認に出ていない。
  - Medium 3: 「提供するproduct動作」が未確認事項で保留中の設計（model入力shape、無名childの
    tool構成・instruction形態）を確定事項として書いて自己矛盾している。
  - Medium 4: bundled generic identityはreserved id（`managed_resource_ref.ts`）、
    `builtinDefinitionRef`、build manifestの`BUILTIN_DEFINITIONS`（`scripts/build_henji.ts`）へ
    波及するがスコープに無い。provenance一貫の主張がproductionで崩れる。
  - Medium 5: 未確認事項3（Definition API model option）は現行sourceで解消済み
    （`worker_bootstrap.ts:375`の`createModel('parent', initialModelSelection)`経路のみで成立）。
    131でHost経路のみと閉じ、Definition model optionはA14へ戻すべき。
  - Low 6: 「型付きerror」の契約未定義（`ToolInputError`かerror code拡張か）。
  - Low 7: 無名childの`definitionRef`／evidenceへのprovenance記録を確認するtestが無い。
  - Low 8: A13採用に伴う通常利用メモの整理（A13をinboxからincrementへ移す）が計画に無い。
- 共通観測: durable admission/settlement、parent-scoped addressability、one-shot fork/joinの維持、
  不正model指定のadmission前失敗、「Agent名別の同梱model既定を持たない」の維持は両レビューで
  問題なし。2機能を1 incrementに同梱する点は過多と断定せず。
- 採用判断（coordinating owner）: 8 findingsすべて採用。本改訂での対応:
  - [高]／High 1 → `agent:generic`常設方式への変更とtool露出経路の対象範囲追加（architecture案1）。
  - [中]／MH2 → architecture案3にselection値のsource明確化を追加。
  - Medium 3 → 利用者決定を反映し、残る未決は「未確認事項」へ整理。
  - Medium 4 → 対象範囲にreserved id・`builtinDefinitionRef`・build manifest・store境界を追加。
  - Medium 5 → Definition API model optionを非対象（A14へ）として明記。
  - Low 6 → 新error契約を作らず現行`{ok:false, error}`契約に統一。
  - Low 7 → test計画にprovenance確認を追加。
  - Low 8 → 実装計画7に通常利用メモ整理を追加。
- 未確認のproduct動作の記録: 当時点で改訂版はレビュー未実施。→ 第2回レビュー（下節）で実施済み。

## レビュー結果（2026-09-26、改訂版計画に対するレビュー）
- 通常レビュー: Finding 3件（[高]1／[中]1／[低]1）。前回8件のうち7件の閉じを確認。
  - [高] F1: `agent:generic`常設のHost側catalog組み立て（`worker_tui_session.ts`の`resolveAsyncAgents`が
    ゼロ件で`undefined`を返し、`ChildRunRegistry.spawn`はcatalog不在を`agent is not available`で失敗）と、
    子module load path（`childOptions`は`resolveManagedModule`＝managed storeのみ。`builtin/generic`の
    load経路が無い。`workerBuiltinModulePath`は`agent !== 'default'`をthrow）が対象範囲・実装計画に無い。
  - [中] F2: tool名検証の情報源が無い。宣言済みtool集合は子Workerでしか確定せず（catalog entryは
    `{name, ref}`のみ）、Hostがspawn前に未知tool名を検証できない。「固定vocabularyなし」「runIdなし」
    「追加不可」の三立にsource上の実装経路が無い。
  - [低] F3: test計画にgenericのinstruction構成・有効tool集合のevidence記録の確認が無い。
- 批判的レビュー: Finding 7件（High 1／MH 1／Medium 3／Low 2）。
  - High 1: 「generic常設でspawn公開」と「asyncAgentNames空でspawn抑制」が同じ入力で逆の動作を要求。
    加えて`childOptions`は子へcatalogを渡さず（spawn済みchildは全員spawn toolなし）、整合には
    「Hostがgeneric以外のWorkerへcatalog注入」という未記載seamが必要。
  - MH 2: 通常レビューF2と同一（tool検証の情報源欠落）。
  - Medium 3: 「省略時は親Sessionのselection」が現行と不一致。現行は`initialModelSelection`固定で、
    `/model`変更後の現在selectionは子へ伝わらない。
  - Medium 4: 承認済みarchitecture変更1〜5が実装が実際に壊す不変条件文を網羅していない（slot値の
    domain「managed selector」文、「親Definitionが宣言するcatalog」文、child execution節の
    「role/model…exact ref provenance」文、`agents.json`に`agent:generic` bindingがある場合の挙動）。
  - Medium 5: `tool:skill`／`tool:submit_json_result`例外ルールが「常時有効」と「常にdeclaredどおり」
    で矛盾。reviewer宣言に`submit_json_result`は無い。「名指し時の挙動」も未定義。
  - Low 6: 形状不正（ToolInputError）と値不正（`{ok:false, error}`）の使い分け未定義。
  - Low 7: 3機能同梱で未確定mechanismが確定調のまま採用判断の誤認要因になる。
- 両レビュー共通: 前回8件のうちMedium 4/5・Low 6/7/8・MH 2概念は解消確認。source一致も確認。
  中核設計（`agent:generic`常設方式、model shape、絞り込みのみ）への異論なし。
- 未確認として残す事項（批判的レビュー）: 名前付きchildが`agent:generic`をspawnできるべきかは利用者
  決定に存在しない。`agents.json`の`agent:generic` binding実在時の挙動も未観測。model省略時の意味は
  利用者確認が必要。これらは推測で埋めず、利用者決定後に反映する。
  → 追加決定12〜15で反映済み（名前付きchildはspawn toolを持たない、`agent:generic` bindingは
  予約名typed failure、省略時はsession現在のselection）。

## 実装結果（2026-09-26）

- spawn contract: `spawn_subagent(agent, task, model?, tools?)`。`model`は`{provider, modelId, effort?}`
  （Hostが`selectModelFor`で解決。不正は`{ok:false, error}`でrunIdなし）、`tools`は通常名の列挙
  （形状不正は`ToolInputError`、値不正は子側検証で`tool_filter_invalid`付きの起動直後失敗run）。
- `agent:generic`: bundled定義`builtin/generic`（`worker_builtin_generic_definition.ts`）をHostが
  catalogへ常時解決（`resolveAsyncAgents`）。`BUILTIN_AGENT_IDS`、reserved id、`builtinDefinitionRef`、
  `definition_selection`、build manifest `BUILTIN_DEFINITIONS`、子module load path
  （`workerBuiltinModulePath('generic')`）を拡張。`agents.json`の`agent:generic` bindingは
  `binding_slot_abolished`のtyped failure。
- tool絞り込み: `definitions/tool_filter.ts`の`applyDeclaredToolFilter`を`createAgentComposition`で
  適用（宣言済みtoolの部分集合・追加不可。`tool:skill`／`tool:submit_json_result`は絞り込み対象外）。
  `toolFilter`はstart command→`AgentDefinitionInput`経路で子へ伝達。
- model: 省略時は親Sessionの現在selection（`currentModelSelection` dep）。指定時は`run.model`として
  子Workerへ伝達しevidenceの`model`へ記録。
- evidence: childのready manifestをsettle時に`execution_admissions.manifest_json`へ記録
  （`row.manifest.resources`が有効tool集合の記録）。`definitionRef`（`builtin/generic`）も記録。
- 再帰spawnなし: childはcatalogを受け取らずspawn toolを持たない（既存構造のまま維持）。
- architecture正本の変更1〜5を反映済み。
- focused test: `tests/v0/increment_131_generic_subagent_test.ts` 7件（model/tools入力、model値不正、
  絞り込み＋evidence、省略時model、tool値不正の失敗run、generic常時spawn（install/bind不要・
  provenance・再帰なし・instruction構成）、`agent:generic` binding拒否）すべて通過。
  regression: increment 33／65／77／109／110／111／127 testすべて通過。type check・format・lint・
  `git diff --check`確認済み。
- build・配置（2026-09-26）: 実装commit `6d7a5d39`のclean treeから
  `deno task --config deno.v0.json henji:compile`でbuildした。`dist/henji --version`は
  source `6d7a5d39f39f94b421d98065b6ec2433e7f45991`、build `55d99dc5c543d7b91e6e8b706500e75b42fc2476cc0d769205b76849a392f1d6`、
  embedded runtime `7ec2ce0b…`、Deno 2.9.7を表示した。利用者の指示に基づきこのbinaryを
  `~/.local/bin/henji`へ原子的に配置した。配置後の`--version`はsource/buildとも同一で、
  `dist/henji`と`~/.local/bin/henji`のSHA-256は
  `be084eef41bcd84923582f4884d62027b11188483b20fa0fe49bb68875da41ef`で一致した。
  起動中のHenjiには再起動後に反映される。

## 実装レビュー（2026-09-26、通常レビュー）

- reviewer subagentによる通常レビュー: Finding 2件（いずれも[低]）。regression・契約不整合・
  実利用経路のcorrectness問題はなしと確認。要件成立（generic spawn、model/tools指定、絞り込み、
  失敗面、evidence、再帰なし、binding拒否）は実行証拠付きで確認済みと評価。
- [低] F1: architecture変更2の反映不完全。slot節の「modelは…catalog名だけを渡せる」が未改めで、
  新文言と併読すると矛盾読解が残る。→ 採用。agent名catalogとmodel catalogを区別する文言へ改め、
  spawn `model`指定（検証済みprovider/modelId/effort）の緩和を明記して修正済み。
- [低] F2: `agents.json`未設定時のHost側`agent:generic`常時解決（`resolveAsyncAgents`のseed）が
  実経路で未確認（既存testはcatalog直接注入のためseed回帰を検出できない）。→ 採用。
  `createWorkerSession`実経路でparent start commandのcatalogに`generic`/`builtin/generic`が
  常に載ることを確認するtest（`the Host resolves agent:generic into the parent catalog without
  bindings`）を追加済み。focused testは8件すべて通過、type check・format・lint再確認済み。
