# Increment 114 — 現行コードベースの重大セキュリティ経路review

## 目的と判断基準

現行のproduction経路で、現実的に到達でき、重大な権限獲得、API credential／Authorizationの露出、
利用者のファイルや履歴の侵害につながる問題がないか確認する。攻撃者の初期権限、入力入口、境界、
影響までを現行sourceで追い、可能性の低い仮想caseはfindingにしない。

baselineはcommit `ab34c330d07dde65ad995645723f5696ff5e04e9`。ユーザーの依頼はreviewであり、
修正、実provider call、credential読取り、releaseを含まない。確認済みの問題が見つかった場合は、
原因、到達経路、影響、修正案を提示し、修正は別の明示指示に従う。

対象は現行Henjiのproduction source（`v0/**`、`mod.ts`、該当するbuild script）。test、fixture、
文書、`_refs`、`vendor`、`archive`は実経路や外部実装の確認に必要なときに参照する。
それらを無条件にproduction attack surfaceとは扱わない。

## 進め方

1. 各sliceでproduction入口と実際のtrust boundaryを定め、現行sourceから攻撃者の入力が重要操作へ
   届くかを確認する。critical／highに重点を置き、条件付きの問題は前提と確度を明示する。
2. 結果を別のread-only reviewerに渡し、findingの成立、severity、見落とし、結論の言い過ぎを
   独立して確認する。coordinating ownerが最終採否を決める。
3. sliceごとに確認済み範囲、採用finding、未確認範囲、第三者reviewの修正点を記録する。
   横断経路は最終sliceで突き合わせる。reviewのためにproduction挙動やtestを変更しない。

## Slice

1. Provider／credential／Authorization／diagnostic evidence — `v0/agent/provider/**`。
2. Tool／filesystem／shell／network effect — `v0/agent/tools/**` と Workerの組み込みtool binding。
3. Managed Definition／instruction／Skill／executable load — `v0/agent/definitions/**`、
   `v0/agent/instructions/**` と関連Worker loader。
4. Host／Worker authority、protocol、Session／history storage — `v0/agent/worker/**`、
   `v0/agent/session/**`、`v0/agent/history/**` の残り。
5. CLI／TUI／Surface入口 — `v0/agent/cli/**`、`v0/tui/**`、`v0/presentation/**`。
6. Execution core、runtime、build／validationと横断収束 — `v0/agent/core/**`、
   `v0/agent/runtime/**`、`v0/agent/validation/**`、`v0/corpus/**`、`v0/eval/**`、
   `mod.ts`、`scripts/**`。先行sliceの境界を跨ぐ到達経路もここで照合する。

## Slice 1 — Provider／credential／Authorization／diagnostic evidence

**状態: 完了。報告対象のcritical／high findingなし。**

- Codex Security Standard scan `e5770009-4e49-45e2-bd1f-d743fb674af5`で、
  `v0/agent/provider/**`の追跡対象24ファイルを静的に確認した。独立baseline監査、
  credential送信先と証拠保存のfocused調査、architecture mappingを実施した。
- 組み込みprovider宣言の上書きはprotocol、endpoint、authProfileの一致を要求する
  （`v0/agent/provider/provider_declaration.ts:306-329`）。新規providerの送信先変更には
  利用者管理のXDG設定が必要で、モデル入力やprovider応答からその設定を変える経路は確認できなかった。
- productionの組み込み`web_search`はOpenRouter送信先と認証profileを固定している
  （`v0/agent/tools/web_search.ts:155-179`）。汎用`requestProvider`は信頼された実行可能
  Tool Definitionに渡る別の権限であり、モデルの検索queryから任意endpointを選ぶ経路ではない。
- 送信requestのcredentialとAuthorizationはrequest evidence形に含まれない
  （`v0/agent/provider/provider_evidence.ts:25-51`）。providerのresponse headerとbodyは
  診断のため保存される。providerがcredentialを反射した証拠は確認されていない。
- 第三者reviewは「全fetchでredirectを拒否」という監査側の表現を訂正した。
  Chatとauxiliary fetchは`redirect: 'error'`を実指定するが、Responses adapterと導入済みSDKは
  その指定をしない（`v0/agent/provider/openrouter_transport.ts:242-247`、
  `v0/agent/provider/auxiliary_request.ts:130-137`、
  `v0/agent/provider/openai_responses_model.ts:218-254`、
  `vendor/jsr.io/@openai/openai/7.2.0/client.ts:1133-1142`）。この差だけで現実的な
  critical／highの漏えい経路は立証されていない。外部fetchのcross-origin認証header挙動は
  このreviewでは断定しない。
- 第三者reviewは、上記の限定付きで「報告対象なし」を支持した。これは対象sliceの結論であり、
  未着手sliceについて安全性を主張しない。

実provider call、credential値の読取り、production file変更は行っていない。

## Slice 2 — Tool／filesystem／shell／network effect

**状態: 完了。報告対象のcritical／high findingなし。**

- Codex Security Standard scan `9964a129-b721-4b9d-821f-82e577fc6825`で
  `v0/agent/tools/**`の追跡対象15ファイルを確認した。独立baseline監査とtool authorityの
  architecture mappingを行い、別の第三者reviewerが結果とproduction bindingを照合した。
- `read`／`write`／`edit`はworkspace内のpathを検証する。一方`bash`はworkspaceを
  開始ディレクトリにするOS-user commandであり、file toolのpath制限は適用されない
  （`v0/agent/tools/work_tool_workspace.ts:50-99`、`v0/agent/tools/bash_tool.ts:277-291`）。
  これは承認済みの`trusted-local · no hard sandbox`構成と一致する。
- `web_fetch`は任意のHTTP(S) URLを取得しredirectを追うが、providerのAuthorizationは付けない
  （`v0/agent/tools/web_fetch.ts:94-105,127-141`）。現行の利用環境で具体的な高影響の
  local HTTP serviceと攻撃者からの到達経路は確認されていない。`web_search`は組み込みの
  OpenRouter送信先を使い、認証情報はrequest dispatch境界で追加する。
- 外部ページ等の本文はtool resultとして次のmodel入力に入る。既定parentには`bash`等もあるため、
  モデルが外部本文の指示に従えばOS-user権限を使える。これは現実的に検討すべき条件付きの設計リスクである。
  現行sourceからモデルが指示に従うことは立証できず、実provider確認は実施していないため、
  このsliceのvalidated critical／high findingには採用しない
  （`v0/agent/tools/web_fetch.ts:154-165`、`v0/agent/core/loop.ts:883-890`、
  `v0/agent/definitions/agent_definition.ts:89-101`）。組み込みcredential読取り禁止文は
  モデルへの指示であり、強制的な権限境界ではない。
- 非同期childのstatus／collect／cancelはHostで親execution identityに照合される。
  `bash`のtimeout／cancelは直接の子processをkillし、process group全体の停止保証ではない。
  これらについて独立した重大な攻撃経路は確認されていない。
- 第三者reviewは上記の限定付きで「確認済みcritical／high findingなし」を支持した。

実provider call、credential値の読取り、production file変更は行っていない。

## Slice 3 — Managed Definition／instruction／Skill／executable load

**状態: 完了。報告対象のcritical／high findingなし。**

- Codex Security Standard scan `4e470b43-0a6f-4f04-bfd8-4c2b130497fd`で
  `v0/agent/definitions/**`の追跡対象22ファイルを静的に確認した。関連するinstructionと
  Worker loaderのproduction経路を照合し、別の第三者reviewerが結果を独立確認した。
- managed Agent／Toolの実行可能なmoduleは、利用者の明示的なinstall／importと、revisionの
  選択またはbindingを経る。store readbackはfile hash、dependency lineage、manifestの
  revisionを照合し、Workerは実行前にclosure hashを再確認する
  （`v0/agent/definitions/managed_definition_revision_validator.ts:45-90`、
  `v0/agent/definitions/managed_definition_store.ts:157-225`、
  `v0/agent/worker/worker_bootstrap.ts:136-216`）。これらは内容の同一性検査であり、
  有効化したmoduleのOS権限を制限するものではない。
- workspaceの`AGENTS.md`と`SKILL.md`はmodel instruction／tool resultとして読み込まれ、
  直接moduleとしてimportされない（`v0/agent/definitions/agent_instructions.ts:153-198`、
  `v0/agent/definitions/skills.ts:340-409`）。その内容がmodelのtool選択に影響し得る点は
  Slice 2の条件付きリスクと同じ。静的sourceだけで重大な指示追従を確定しない。
- 別件のproduct動作差として、通常のheadless `henji run`では`configRoot`が未指定のまま
  root Definitionを解決し、`agents.json`の`agent:default` bindingをroot選択に適用せず
  bundled defaultを選ぶ。TUIはXDGのconfigRootを渡す（`v0/agent/cli/runtime_cli.ts:300-307`、
  `v0/agent/definitions/definition_selection.ts:180-200`、`v0/agent/cli/tui_cli.ts:281-307`）。
  攻撃者起点のcritical／high security経路は確認できず、修正は今回のreview範囲外とする。
- 第三者reviewは、trusted-localの実行境界と上記限定を確認し、「報告対象なし」を支持した。

実provider call、credential値の読取り、production file変更は行っていない。

## Slice 4 — Host／Worker authority、protocol、Session／history storage

**状態: 完了。報告対象のcritical／high findingなし。**

- Codex Security Standard scanをWorker 38ファイル（`81af1377-2834-425d-88ef-8b2f5a421f4a`）、
  Session 13ファイル（`3e5bf373-0407-4473-965b-04746ad7619c`）、history 9ファイル
  （`82f7e532-f7d1-4d4b-b86a-3f48f7c8c644`）に分けて実施した。各領域のproduction callerを
  追い、Worker結果と保存領域の結果をそれぞれ別の第三者reviewerが確認した。
- Hostがcanonical Sessionとcommitを所有し、Workerのproposalのcorrelation、Session ID、
  revision、turnを照合する。child runのstatus／collect／cancelは親execution IDに結び付く
  （`v0/agent/worker/worker_host_coordinator.ts:1534-1615`、
  `v0/agent/worker/worker_host_children.ts:160-267`、
  `v0/agent/history/sqlite_history_v7_production_store.ts:1750-1801`）。
- `async_agent_request`は通常のcorrelation／journal処理より先にdispatchされる
  （`v0/agent/worker/worker_host_coordinator.ts:369-372`）。ただし組み込み経路はawait前に
  要求を送信し、Hostもawait前に親execution IDを捕捉する。信頼されない入力から別turnの
  親権限へ付け替わる現実的な経路は確認できず、findingには採用しない。
- workspace別の状態はcanonical pathのdigestで分離される。productionのCLI入力はSession IDを
  UUIDとして検証し、TUIは検証済みlistの行を選ぶ。`openExistingWorker`はID検証前にlock pathを
  作るが、実利用入口から未検証IDが届く経路は確認できない
  （`v0/agent/session/session_store_paths.ts:23-37`、`v0/agent/cli/tui_cli.ts:167-175`、
  `v0/agent/history/sqlite_history_v7_production_store.ts:742-798`）。
- request evidenceの形にAuthorization headerとcredentialは含まれない。raw provider responseは
  診断目的で保存される。外部providerが認証値を反射する挙動は観測していない。
- Workerは設計上trusted-localの実行主体であり、hard sandboxはない。第三者reviewはいずれも
  この前提と限定を踏まえ、報告対象なしを支持した。

実provider call、credential値の読取り、production file変更は行っていない。

## Slice 5 — CLI／TUI／Surface入口

**状態: 完了。報告対象のcritical／high findingなし。**

- Codex Security Standard scanをCLI 10ファイル（`d4703b23-871c-459d-9841-b89f6465fbea`）、
  TUI 22ファイル（`4d82717d-3021-4418-a8eb-e2ecd7e4d4d5`）、presentation 10ファイル
  （`b3459ef6-b05c-42cf-98d6-fdd84c39cc90`）に分けて実施した。別の第三者reviewerが
  結果とproductionの表示・操作経路を照合した。
- CLIは固定subcommandへdispatchし、taskをshellとして解釈しない。module／toolの
  install・export・activation・removeはoperatorが明示して起動する経路である
  （`v0/agent/cli/henji_cli.ts:74-92`、`v0/agent/cli/runtime_cli.ts:298-358`）。
- TUIはmodel、tool、history、workspace path等の動的文字列の制御文字とbidiを端末出力前に
  可視化する。表示eventから人間のsubmit／session切替／model選択intentへ直接進む経路はない
  （`v0/tui/layout.ts:62-76,368-385`、`v0/tui/tui_renderer.ts:170-198`、
  `v0/presentation/tui_presentation_adapter.ts:99-224,381-470`）。
- `henji run`のtext／streamと`henji history`のsession／canonical表示はassistant本文を
  stdoutへraw出力する。streamはprovider由来のtool名もstderrへ出し得る。対応端末では
  OSC 52等によるclipboard書換えや表示偽装が条件付きで成立する。ただし確認したsourceから
  自動的なcommand実行やcredential読取り・外部送信には至らず、要求されたcritical／high
  findingには採用しない（`v0/agent/cli/runtime_cli.ts:363-372`、
  `v0/agent/cli/history_cli.ts:143-155`、`v0/agent/cli/run_events.ts:145-155`）。
  JSON出力とhistory detailは制御文字をJSON escapeする。
- 第三者reviewはこの限定を含めて「報告対象なし」を支持した。端末実機での挙動は未確認。

実provider call、credential値の読取り、production file変更は行っていない。

## Slice 6 — Execution core、runtime、build／validationと横断収束

**状態: 完了。報告対象のcritical／high findingなし。**

- 最終Codex Security Standard scan `7642963a-38bf-4872-88ad-d296a47de4ea`で`v0/**`の追跡対象
  217ファイル（TypeScript 213、JSON 2、README 2）をinventoryとした。先行sliceで163ファイル、
  残り54ファイルを今回の一次監査で確認した。READMEは補助文書として参照した。範囲外のroot `mod.ts`と`scripts/**`
  2ファイルも別途source監査した。別の第三者reviewerが横断経路と結論を独立確認した。
- `core/loop.ts`はmodelのtool callを形状検証し、宣言済みregistryを通じてdispatchする。
  model本文から任意のHost codeを直接選ぶ経路は確認できない
  （`v0/agent/core/loop.ts:107-145,764-837`）。
- 検証用のlive corpus credential launcherは実行file・entrypoint・引数と子processの許可を固定し、
  error時は固定codeのみを出力する。corpus prompt／fixtureは実行前に正本値と照合する
  （`v0/eval/live_corpus_credential_launcher.ts:12-19,290-307,377-404`、
  `v0/corpus/task_corpus_validation.ts:270-314`）。固定Deno実行fileのrepo外の内容は今回未確認。
- buildは入力digestとdirty状態をmanifestへ記録し、commandを引数配列で起動する
  （`scripts/build_henji.ts:94-163,345-408`）。
- 外部Web／workspace文書がmodelにtool使用を指示し、既定のOS-user Bash権限へ影響する経路は
  Slice 2／3の条件付き設計リスクとして残る。sourceだけではmodelの追従や具体的な
  credential流出を確定できず、実provider callは承認されていないため実施していない。
  第三者reviewもこの限界を明示して、追加のvalidated critical／high findingなしとした。

## 横断結論と別件

- 現行HEAD `ab34c330d07dde65ad995645723f5696ff5e04e9`の静的reviewでは、現実的な
  source-to-impact経路として成立するcritical／highのsecurity findingは0件。
  これは実provider応答、実端末操作、modelの間接指示への追従を保証する結論ではない。
- **条件付きリスク**: 外部内容→model→宣言済みtoolという経路にOS-user Bashがあり、
  credential禁止はmodel instructionであってOS権限境界ではない。重大な影響の可能性があるため、
  利用者がこの脅威を対象に含める場合は、対象・回数・保存先を決めた実provider確認を別承認で行う。
  raw CLI出力の端末制御文字は表示／clipboard影響までsourceで追えたが、critical／highには達しない。
- **security reviewで発見した別件のproduct bug**: 通常のheadless `henji run`は
  `agent:default` bindingをroot選択に適用しない。原因はCLIで`configRoot`を解決せずに
  `resolveRequestedDefinition`へ渡す点。利用者がheadlessでもcustom rootを期待した場合、
  bundled defaultで実行される。修正するならproductionのXDG configRootをroot選択へ渡し、
  bindingあり／なしのheadless起動をfocused testで確認する。review時点では修正せず、利用者の後続指示を受けて
  [`increment-115.md`](increment-115.md)で修正した。
- reviewはsourceと正本文書の読取りのみ。production file・test・global環境・provider・
  credential値を変更または読取りしていない。コード変更がないためbuild／testは実行していない。
