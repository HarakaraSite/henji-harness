# Henji Harness: minimal tool-use agent loop implementation plan

## Concept review request

なし。確認したrepository状態では、roadmap step 1〜5はlocal fixture、provider-neutralな型、追加dependencyなしで成立できる。現行のprovider transport、credential、state、extension、停止済みSpike 0〜2を変更または再開する必要はない。

## 推奨計画と前提

milestone 5は現行`v0/model.ts`や`v0/cli/main.ts`のone-request経路を拡張せず、`v0/agent/`配下の独立したfixture-only vertical sliceとして追加する。これにより、完成済みmilestone 1の`basic run`、legacy `run` / `acceptance`、provider profile、budget、attempt、state、extensionの契約を維持したまま、roadmap step 1〜5だけを直接検証できる。

採用する最小契約は次のとおり。

- model requestは、provider-neutralなtranscriptとregistryが提示するtool definition一覧を受け取る。model resultは`final text`または1件以上の`tool calls`の判別可能なunionとする。
- transcript messageは`user`、`assistant`、`tool`の三roleとする。contentはtext、tool call、tool resultだけを表し、tool call/resultは同じcall IDとtool名で対応付ける。
- tool callのargumentsとschemaはJSON valueとして表し、tool resultはtextと`success | error` outcomeを持つ。
- Toolは一意なname、description、input schema、executeを持つ。Registryは重複名を拒否し、名前解決と安定順のdefinition提示を行う。
- 製品に含めるtoolは、入力textを決定的に変換するpure fixture tool一件だけとする。invalid argumentsはこのtoolがerror resultを返す。tool execution errorのtestにはtest内で注入する失敗Toolを使い、二つ目の製品toolは追加しない。
- unknown tool、invalid arguments、tool execution errorはすべて対応するerror tool-resultとしてtranscriptへ追加し、fixture modelへ再投入する。panicや未処理rejectionでloopを落とさない。fixtureがその結果を受けてfinal textを返せば、loop自体は正常な`final`停止となる。
- max stepsはmodel generate一回を1 stepとして数え、defaultを8とする。8回目がtool callsならそのassistant messageとtool resultsまではtranscriptへ追加し、次のmodel callを始めず`max_steps`で終了する。これにより上限時にも未回答tool callを作らない。testでは小さい上限を注入する。
- 成功outcomeはfinal text、`final` stop reason、model step数、tool call/result数、完全なtranscriptを返す。非成功outcomeは`max_steps`またはfixture/model contract failureと、同じ観測情報を返す。
- local commandは既存mainへ混ぜず、fixture専用`v0/agent/cli.ts --task TEXT`とする。外部call確認、credential、state-dir、provider profileは受け取らず、JSONでfinal responseと最小loop outcomeをstdoutへ出す。

可逆的な実装上の仮定は、型や識別子の具体名、fixture toolの変換内容、CLI JSON field名である。上記の意味とdirect testを維持する限り、実装者が局所的に調整してよい。未解決の製品判断はない。

## 現在状態の直接証拠

- `v0/model.ts`の`ModelMessage`は`system | user` textだけ、`ModelGenerate`の成功結果はtextだけであり、`fixtureModel`とprovider transportはone-requestのPlan生成用である。これをtool-use contractへ拡張すると現行provider経路まで意味が変わるため再利用しない。
- `v0/cli/main.ts`の`basicRun`は注入可能な`ModelGenerate`を一度だけ呼び、external-call confirmationとrequest count 1を前提にする。legacy `run` / `acceptance`はstate、extension、attemptへ接続されているため、milestone 5のcomposition rootには使わない。
- `tests/v0/v0_test.ts`は`basic run`がtool-looking textをdispatchせずpassive successにすること、state-freeに独立反復すること、provider requestにtool fieldがないことを直接固定している。新sliceはこれらを変更せず、別test fileで検証する。
- `deno.v0.json`のformat/lint/testは`v0`と`tests/v0`を対象にする一方、checkとgateのcheck対象は明示列挙である。新entrypointと新testをtype-check対象へ加える更新が必要だが、dependencyやlockfile変更は不要である。
- Deno固定snapshot二例（commit `eb8f78e90dbc72f3b3ab7dcd85609622379b5bca`）は、assistant tool callをtranscriptへ記録し、対応するtool resultを追加して、final answerまで同じmessagesでmodel callを反復する最小因果順を示す。
- Zot `packages/core/agent.go`と`packages/core/tool.go`（commit `9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`）は、provider-neutral requestへtranscriptとregistry specsを渡すloop、名前解決、tool errorをresultへ変換するmechanism、有限step上限を分離している。採用するのはこの最小mechanismだけで、session、event、retry、queue、extension hook、cost、provider catalogは採用しない。

## 影響するfileとcomponent

Human Gate 2承認後の実装対象を次に限定する。

- `v0/agent/contracts.ts`: JSON value、content、message、tool definition/call/result、model request/result、model interface、loop outcomeのprovider-neutral型。
- `v0/agent/tools.ts`: Tool interface、Registry、pure fixture tool、argument validation、execution errorの正規化。
- `v0/agent/fixture_model.ts`: scripted stepを順に返し、各requestのtranscript/tool definitionsを観測できる決定的fixture model。
- `v0/agent/loop.ts`: transcript append、model call、registry dispatch、tool-result再投入、final/max-step停止を担う有限loop。
- `v0/agent/cli.ts`: `--task`からfixture model、fixture tool、registry、loopを組み立てるstate-free composition rootとterminal JSON出力。
- `tests/v0/agent_loop_test.ts`: milestone 5のdirect tests。既存`test_helpers.ts`のassertionだけを再利用する。
- `deno.v0.json`: fixture commandとdeny-by-default agent test taskを追加し、新fileを既存check/gateのtype-check対象へ含める。既存task名とpermissionは削除・緩和しない。
- `docs/plans/minimal-tool-use-agent-loop-results.md`: 実装後のacceptance package。roadmap step 1〜5、各完了条件、test名と結果、差分、残存riskを対応付ける。

`v0/model.ts`、`v0/cli/main.ts`、既存`tests/v0/v0_test.ts`、provider/state/extension/Spike file、dependency、lockfileは変更しない。

## 順序付きincrement

### 1. Roadmap step 1: provider-neutral message/tool contract

成果:

- `contracts.ts`へtext-only content、三role message、call ID/name/JSON argumentsを持つtool call、call ID/name/text/outcomeを持つtool resultを定義する。
- assistant resultを`final`と`tool_calls`のunionにし、空tool-call batchを型または境界validationで拒否する。
- model requestにtranscriptとtool definitionsを含め、providerやprofile固有fieldを含めない。

依存関係: なし。以降のincrementはこの型だけへ依存する。

検証:

- Deno checkで全unionの分岐が網羅されることを確認する。
- direct testでuser、assistant tool call、tool result、assistant finalの構築とcall ID/name/outcomeの対応を確認する。

### 2. Roadmap step 2: Tool interface、Registry、fixed tool

成果:

- `tools.ts`にTool interfaceとRegistryを実装し、constructorで空名/重複名を拒否する。
- `definitions()`はtool nameの安定順でname、description、input schemaを返し、`resolve(name)`は対応する同一実装を返す。
- pure fixture tool一件はobject形、必須text、余分な不正型を決定的にvalidationし、成功時はtextだけを返す。
- dispatch境界はunknown name、invalid arguments、throw/rejectをcall ID/name付きerror tool-resultへ正規化する。

依存関係: increment 1。

検証:

- definition提示内容と安定順、正しいname解決、重複拒否を直接確認する。
- fixed tool成功、invalid arguments、unknown tool、test注入のthrow/rejectが、例外を外へ漏らさず期待するerror resultになることを個別に確認する。

### 3. Roadmap step 3: scripted fixture model

成果:

- `fixture_model.ts`にscripted stepsを順番に消費するmodelを実装する。各stepは受け取ったrequestを検査でき、tool callまたはfinal textを返す。
- modelは受け取ったrequest snapshotとcall countをtestからread backでき、script枯渇や期待不一致を明示的なcontract failureにする。
- CLI用scriptは、初回にfixed toolを一件要求し、次回に対応する成功tool resultを観測してfinal textを返す。

依存関係: increment 1、2のdefinition shape。

検証:

- tool definitionsが初回を含む全model requestへ渡ること、前stepのtool resultを次stepが観測すること、script順とcall countが決定的であることを直接確認する。
- real provider protocol JSON、SDK mock、OpenRouter responseをfixtureへ混ぜていないことを差分で確認する。

### 4. Roadmap step 4: finite agent loop

成果:

- `loop.ts`はuser message一件で開始し、各model callの前に現在のtranscriptとregistry definitionsをrequestへ渡す。
- tool-call resultならassistant messageを一度appendし、callsを宣言順にdispatchし、対応resultsを一つのtool messageとしてappendして次stepへ進む。
- final resultならassistant final messageをappendし、`final` outcomeを返す。
- model call前にstep上限を判定する。許可された最終stepがtool callsを返した場合はそのbatchをdispatchしてresultsまでappendし、次のmodel callを行わず`max_steps` outcomeを返す。default 8、注入値は正整数だけを受け入れる。
- model/fixture contract failureもterminal failure outcomeへ変換し、panic、unhandled rejection、無限loopを作らない。

依存関係: increment 1〜3。

検証:

- text-only finalはtool dispatch 0、1 step、`user → assistant final`で終了する。
- 一回tool flowは`user → assistant tool call → tool result → assistant final`となり、call ID/name/resultとmodel request snapshotが一致する。
- 二回tool roundは少なくとも5 messageの因果順を保ち、model call 3回でfinalへ到達する。単発専用分岐でないことをrequest snapshotsで確認する。
- unknown tool、invalid arguments、tool execution errorの各caseはerror resultがmodelへ戻り、その後のscripted finalまでpanic/hangせず終了する。
- 常にtool callを返すfixtureは注入した上限で`max_steps`となり、上限を超えるmodel callとtool executionがない。

### 5. Roadmap step 5: local command、gate、acceptance package

成果:

- `cli.ts`へfixture-only commandを追加する。task、最終text、stop reason、step数、tool call/result数、outcomeをJSON出力し、`final`はexit 0、terminal failureはexit 1とする。
- CLIはprovider、credential、filesystem、shell、network、clock、random、environment、stateを参照せず、同一taskで同一の意味的結果を返す。durationやrandom IDは出力しない。
- `deno.v0.json`へ、CLIを実行する`agent:fixture`、権限を付与しない`agent:test`を追加する。既存`v0:check`と`v0:gate`のcheck列挙へ新entrypoint/testを加える。
- `agent_loop_test.ts`へ上記direct testsとcomposition-root testを置き、`results.md`へroadmap/完了条件ごとの結果を記録する。

依存関係: increment 1〜4。

検証:

- composition-root testでtask一件からtool call/resultを一回経てfinal JSONとexit 0になるflow全体を確認する。
- `agent:test`をDenoのdefault deny permissionsで実行し、local testsがnetwork、credential、provider call、filesystem外部fixtureを必要としないことを実行環境で確認する。
- 続けて既存`v0:check`、`v0:fmt`、`v0:lint`、`v0:test`、`v0:gate`を実行し、milestone 1とlegacy経路の回帰がないことを確認する。provider acceptanceやcredentialを必要とするcommandは実行しない。
- 最後に`git diff --check`と対象diffを確認し、dependency/lockfile、provider/state/extension/Spike fileが変わっていないことを確認する。

## Direct test対応表

| 完了条件 | direct evidence |
| --- | --- |
| toolなしのfinal response | final-only loop test: dispatch 0、1 step、2-message transcript |
| tool call → result → final | one-round E2E testとcomposition-root test |
| 二回以上のtool round | two-round scripted fixture test、model call 3回 |
| transcript因果順 | one/two-roundでmessage role、content kind、call ID/nameを完全比較 |
| definitions提示とname解決 | Registry testとfixture request snapshots |
| unknown/invalid/execution error | 三つのfailure testでerror result再投入後にfinal停止 |
| step上限 | never-final fixture testでexact call/dispatch countと`max_steps` |
| local command全flow | CLI mainのstdout JSON、exit code、loop counts |
| network/credential/provider/dependency不要 | no-permission `agent:test`成功、diff inventory |
| roadmap step 1〜5の受入 | results documentのrequirement-to-test mapping |

同じfailure modeを重複して検証しない。Registry単体testはdispatch正規化、loop testは再投入と停止、CLI testはcompositionだけを担当する。

## Migration、互換性、rollback

migrationは不要である。新sliceはadditiveかつstate-freeで、既存state schema、attempt、extension package、provider request、credential、terminal outputを読み書きしない。既存commandとtask名は維持し、`agent:fixture`だけを追加する。

Human Gate 2後の実装を取り消す場合は、新規`v0/agent/`、`tests/v0/agent_loop_test.ts`、results documentを削除し、`deno.v0.json`の追加task/check列挙だけを戻す。data rollback、state cleanup、credential操作、provider操作は発生しない。既存未commit worktree全体をresetせず、このsliceのexact diffだけを戻す。

## 完了条件とHuman Gate 2停止点

計画段階の完了条件は、この文書がroadmap step 1〜5、対象file、依存順、failure契約、direct tests、migration/rollback、acceptance packageを一意に示し、concept review requestが不要と判断できることである。

この文書のreadback後はHuman Gate 2で停止する。Human Gate 2の明示承認前に、source/test/config/resultsの作成・変更、test実行、provider call、credential参照、dependency導入、state操作、implementation review、commit、push、releaseへ進まない。

## 残るriskとdeferred事項

- scripted fixtureはH-020のloop構造を検証するが、real providerのtool-call protocol互換性は検証しない。これはroadmap step 6以降の別判断である。
- default max steps 8はlocal fixtureの終了仕様であり、将来の実用agentの適切な上限を決めない。real provider導入時に別途見直す。
- Tool executeのasync許容とerror正規化は将来のI/O toolを承認するものではない。filesystem、shell、network、clock、random、environment toolは対象外のまま維持する。
- permission hardening、session durability、abort、retry、streaming、multi-user/public distribution、self-revisionはmilestone 5の受入へ混ぜずdeferredとする。
