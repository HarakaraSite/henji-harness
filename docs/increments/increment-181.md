# Increment 181 — E6: JSON Agent設定・tool読込・履歴DBの簡素化

更新日: 2026-10-04

ステータス:
**完了（実装・検証・commit/push・常用配置）。P0と全六スライスの実装・test・独立review、最終gate615件、実provider
E1〜E11・停止DB照合、採用した実build保存P2の修正と指摘限定re-review、配置版の隔離起動確認を完了した。構想/architecture/roadmapの意味変更は別途承認前のため未反映。**

利用者のE6検討、四項目の推奨案への採用判断、検証失敗時の個別rejectへの合意、 「お願いします
反映したらレビュアに批判的レビューをさせてください」により、
本incrementへの採用、合意内容の文書化、独立reviewを行う。
本書を要件・対象範囲・設計案・review結果の正本とする。
利用者の追加指示「複数スライスにして、それぞれで実装テスト、レビューできるようにしてください」
「スライスで必要に応じて実プロバイダを利用することを許可」「インクリメントの最後に基本的な流れを網羅した
実プロバイダによるe2eテスト」により、スライス別の実装・test・review、必要な実provider確認、
最後の実provider E2Eを実施する方針と権限を追加した。詳細は§6・§7と最終E2E計画を参照する。
具体的なcontract/schemaが未確定の部分は、実装前にP0でsourceに沿って確定する。

## 1. 目的と成功条件

人間がAgent設定やtoolを編集し、新しく起動するWorkerから現在内容を利用できるようにする。
AgentはJSON設定から共通runtimeで構成し、用途ごとの実行可能TS Definitionの管理を外す。
revisionを版名として扱い、履歴から当時の実際の設定・提示contract・使用版を確認できるようにする。
DBも新しい保存責務に合わせて整理する。過去Sessionの移行・旧形式との互換性は要求しない。

設定・toolの検証失敗でCore/TUI全体を起動不能にしない。失敗した対象を個別にrejectし、原因を人間へ示す。
Agentを構成できる場合は、利用可能なtoolで通常利用を継続できる。 canonical会話、cancel/failed
executionの記録、親子実行、model選択、履歴参照・再開を新形式で成立させる。

## 2. 利用者の決定と権限

### 合意済みのproduct方針

- 標準default設定はJSONデータとしてbinaryへ同梱する。指定した外部JSONで差し替えられる。
  defaultの専用TS Definitionは不要とする。
- genericは独立Definitionを廃止し、標準設定と起動時のtask/model/tools指定から作る無名子Agentとする。
- 同梱toolを利用でき、変更・追加するtoolだけ外部folderへ置く。
  利用者の追加指示「bash_outputは失念していた 4種に加えて」に従い、基本tool名は
  `read`・`write`・`edit`・`bash`・`bash_output`の五種とする。
- 履歴には実際のAgent設定、instruction、modelへ提示したtool
  contract、版名、build、model選択を保存する。
  tool実装source全文・依存module一式の保存は要求しない。
- Agent設定とtoolはWorker起動時に読み込む。稼働中Workerは起動時に構成したものを使う。
  同じ稼働中Workerへの明示再読込はS4の`/reload`として別incrementで扱う。
- 読込時には実行に必要な形式・contractを検証する。内容hashとの一致や過去版との一致を要求しない。
- Core/TUIは起動し、不正toolは登録をrejectする。利用可能なtoolだけをmodelへ提示する。 Agent
  JSONが不正な場合は当該Agentの構成をrejectし、アプリから原因を確認できるようにする。
- revisionは任意の版名である。同じ内容への別版名、同じ版名での内容更新を許容する。
  内容hashによるexact revision管理、過去版選択・loadを外す。
- provider/model/effortは既存のSession選択・起動時指定を使う。taskに応じた判断はAIが行う。
  command/path単位のpermission制御と確認機構は追加しない。
- 「この際だからdbも綺麗に整理」「破壊的変更として、過去のセッションの意向は考えないでいいよ」に従い、
  DBへの影響最小化を優先せず、新schemaに整理する。過去Sessionの移行、旧形式read、converter、dual-read/writeは不要。

### 承認境界

localのスライス別実装・非破壊的test・独立review、必要な実provider確認、最後の実provider E2Eは
2026-10-04の追加指示により承認された。実providerの対象・回数見込み・保存先は§7.1と
[最終E2E計画](e2e-181-plan.md)に定める。この範囲の実行で都度の再承認を求めない。
実装・検証・実provider実行の結果は§10と最終E2E文書へ記録した。
commit/push、常用配置、既存data/fileの削除は追加指示に含まない。
構想・architecture・roadmapの変更にはAGENTS.mdの別途承認が必要で、変更案だけを本書に保持する。

## 3. 現行の利用経路と観測

### 起動・構成・子Agent

| 利用者の操作から結果まで                                                | 現行sourceと所有者                                                                                                                                | 181で扱う影響                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TUI/serve起動 → root選択 → Core起動 → 初期Session                       | `v0/agent/cli/serve_cli.ts`、`v0/agent/host/core_service.ts`。Core初期化前の`resolveRequestedDefinition()`と、Core初期化中の`openSlot()`がある    | 読込拒否をCore全体の起動失敗へ伝播させない。起動前・初期Session経路の両方を変える           |
| 新規/保存Sessionをopen → Agent/tool binding解決 → Worker起動            | `v0/agent/worker/worker_tui_session.ts`、`definitions/definition_selection.ts`、`agent_slot_binding.ts`、`tool_binding.ts`。Hostが管理storeを解決 | 現在JSON/fileの選択・読込と対象別の採用結果へ置換する                                       |
| Worker起動 → instruction/skill discovery → Definition評価 → composition | `worker_bootstrap.ts`、`worker_agent_api.ts`。評価と実体化はWorker内                                                                              | TS Definition評価を共通JSON構成処理へ置換する。関数・registryはWorker localに保つ           |
| task → context構成 → model/tool loop → proposal → Data commit/ack       | `worker_runtime.ts`、`core/loop.ts`、`data/session_data_owner.ts`、`data/conversation_writer.ts`                                                  | 共通loopと会話採用の意味を維持し、新しい構成・保存contractへ接続する                        |
| generic/named spawn → child Worker → status/collect/cancel              | `tools/async_agents.ts`、`worker_host_children.ts`。Hostがchild所有、Dataがchild execution保存                                                    | 共通設定でgenericを構成し、named AgentはJSONから構成。各childの使用設定と親子関係を保存する |
| `/model`等 → Session selection保存 → 後続turnでmodel適用                | `worker_runtime.ts`の`generationBasis.modelSelection`、`data/session_authority.ts`                                                                | 起動時snapshotとexecutionごとのmodel/effort選択を混同しない                                 |
| Sessionのfollow-up要求 → 次task/executionの受付                         | `host/core_service.ts`、`host/task_service.ts`。Session対象のHost operation                                                                       | 既存のSession follow-upを維持する。child向けfollow-upの新設は含めない                       |
| `henji run` → CLI Worker → headless Host → Data/Agent Worker            | `cli/run_worker_client.ts`、`host/application_service.ts`、`worker_tui_session.ts`                                                                | HTTP Coreの有無にかかわらず同じ設定/構成/保存経路を使う                                     |

default/genericの現行moduleは、ともに`createDefaultAgentComposition(input)`を呼ぶだけである。
`agents/reviewer.json`も共通factoryへrole instruction、tool宣言、空の子Agent宣言を渡している。
2026-10-03の通常利用メモでは、常用の外部Agent Definitionはreviewer一つと観測されている。

現行toolは`Tool`のname/description/inputSchema/executeと`Registry`を持つ。
`ToolComponent.materialize()`がworkspace、process executor、bash output
store等の実行依存を注入する。 外部toolの簡素化でも、model-visible
contractと実行関数を同じ採用済みtoolから作る。

### DB・履歴

現行はworkspaceごとの`history-v7.sqlite3`（schema 11）を唯一のproduction履歴DBとしている。
schemaは`history/sqlite_history_v7_prototype.ts`、productionの書込/読取は
`sqlite_history_v7_production_store.ts`にある。`sqlite_history_v7_store.ts`はprototype名のre-exportである。

- `sessions`・`session_turns`・`execution_admissions`に`definition_json`がある。
  build/model情報とmanifest/context情報にも別の保存先がある。
- `session_heads`と`sessions`はSession revisionを持つ。detached executionでは
  `detached:<executionId>`をauthority keyとして使うため、単純に一方を消すだけでは置換できない。
- canonical messageは`session_messages`、non-canonical結果は`execution_messages`、semantic recordは
  `semantic_occurrences`で扱う。表示、再開、recall、途中本文に対する読取上の役割があり、全部を重複と見なさない。
- `derived_documents`はartifact/diagnostic等の保存に使う。artifactには過去schemaと旧planner/subagentの読取分岐が残る。
- context snapshot/manifest、recall relation、immutable
  content、assistantの進行中本文も保存・参照される。
  保存contractの変更はCLI/API/TUIのhistory/context表示まで影響する。

### 参照実装の確認（2026-10-04）

新しい調査は2026-10-02取得のsnapshotに基づく。過去researchの旧commitと混同しない。
参照実装を丸ごと採用せず、次の境界の根拠として使う。

| 参照・commit                                        | 確認したsource                                                                                                                                             | 181への示唆                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pi `c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06`       | `_refs/pi/packages/agent/src/agent.ts`、`types.ts`、`coding-agent/src/core/sdk.ts`、`agent-session.ts`の`_buildRuntime()`/`reload()`、`session-manager.ts` | 共通Agent loop、設定/resource構成、永続Session管理を分ける。標準toolはcodeでも供給している。reloadではextension失効と再構成を行う   |
| Zot `6a6e31f371936d350bf23f3dce65d3fddc896d23`      | `_refs/zot/packages/agent/build.go`の`Resolved`/`NewAgent()`、`sdk/sdk.go`、`core/agent.go`、`core/tool.go`、`agent/extensions/tool.go`、`manager.go`      | 設定解決後にclient/model/prompt/registryを共通Agentへ渡す。外部toolのadapterと共通tool contractを分け、hostが保存callbackを接続する |
| OpenCode `1ddb0873aee50d209d1a8d7f91b89c5daf692d49` | `_refs/opencode/packages/opencode/src/agent/agent.ts`、`config/agent.ts`、`tool/registry.ts`、`session/prompt.ts`                                          | Agentはdata、実行は共通Session loop。folderのtoolを同梱toolと共通registryへ接続できる                                               |

参照実装のpermission・retry・compatibility・plugin frameworkは181への採用根拠にしない。
Henji固有のcanonical採用・Data Worker・process所有をこれらのSession保存方式へ置換しない。
sourceとcommitの管理は[`../../_refs/README.md`](../../_refs/README.md)を参照する。

## 4. 設定・tool・runtimeの設計案

### 4.1 設定データと選択

Agent JSONの基本項目は`name`、`revision`、`instruction`、`tools`、`agents`とする案。
`tools`/`agents`の空配列は明示的な未使用であり、省略との意味を実装前に確定する。
instructionはroleの寄与で、Henji共通base、workspace instruction、skillとtool
guidelineは既存の構成責務で合成する。
provider/model/effortをJSONで固定する機構は増やさない。既存max-steps指定と既定動作を維持する。

```json
{
  "name": "reviewer",
  "revision": "1",
  "instruction": "Review the requested work against its stated purpose.",
  "tools": ["read", "bash"],
  "agents": []
}
```

配置案はconfig rootの`agents/<name>.json`と、名前を現在fileへ対応付ける簡易な`agents.json`。 root
defaultは同梱JSON、明示Agent名または有効化設定は外部JSONを選ぶ。
明示選択した外部JSONの失敗はそのAgentをrejectし、同梱defaultへの自動代替にしない。
genericは同梱標準設定を基底にspawn時指定を適用し、親のreviewer等のrole
instructionを自動継承しない案。 named
Agentの利用可能名と実際の採用結果を区別し、rejectしたAgentへspawnした場合は理由を返す。

### 4.2 tool供給と五種の基本tool

同梱の基本toolは`read`・`write`・`edit`・`bash`・`bash_output`。
web_search/web_fetch等の追加toolは既存機能として同梱供給を維持し、明示した構成から利用できるようにする案。
skill利用、構造化結果の提出、非同期子Agent操作は共通runtimeの既存機能として維持し、 基本file/shell
toolの五種とは区別する。最終default JSONの追加tool選択は実装前に明記する。

現行bashは短縮されたstdout/stderrの残りを`bash_output`へ誘導する。
追加指示により`bash_output`を基本toolへ含め、そのcontract、`BashOutputStore`、process所有と続き取得を維持する。
bashへ出力取得operationを統合する案は採用しない。

外部toolはconfig rootの`tools/<name>/`にmetadataとentry moduleを置く案。
metadataはtool名、revision、API contract、entryを持ち、有効化設定は現在folderを指定する。
同名toolの外部指定は同梱版を置換する。置換対象がrejectされた場合、そのtoolを未登録とし、
同梱版を自動採用しない。未指定の基本toolは同梱実装を使う。

toolの名前/schemaとexecutorは同じ採用結果に結び付ける。 検証はmodule
import、必要export、構成したtoolの必須項目と実行contractを対象にする。
loaderがtoolの動作を試すために`execute()`を呼ぶことはしない。 source closureのimmutable保管、content
hashへのrevision binding、全依存fileの一致検査は撤去対象。 local依存importとHenji
APIへの接続はcompiled binaryからの既存外部tool利用経路を確認して確定する。 別途Denoやrepository
checkoutがないstandalone環境で外部toolを利用できることを受入に含める。

### 4.3 読込・構成・実行の所有と寿命

| 責務                                           | 所有者                        | 寿命と境界                                                                  |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| Agent/toolの選択と現在fileの読込               | Coreまたはheadless Host       | Worker起動ごとに解決する。Core全体の起動成功とは分離                        |
| dataの形式検証・選択結果                       | Hostの共通resolver            | functionを含まない選択dataと対象別の理由をWorker/Surfaceへ渡す              |
| tool moduleのimport・export検証・実体化        | Agent Worker                  | 各Worker local。import/構成失敗も対象別rejectとしてready結果へ返す          |
| instruction/registry/modelの構成               | Agent Workerの共通構成factory | default/generic/namedで同じ経路。registryとfunctionはprocessを越えない      |
| turn loop・context・cancel・steering・proposal | 既存Worker runtime/loop       | 進行中executionとgenerationを区別。設定変更は起動済みregistryを差し替えない |
| Session・semantic履歴・canonical採用           | Data Worker                   | Workerを閉じても保持。正本をCoreのcacheへ移さない                           |
| tool process/child Workerの生存・終了          | Hostの既存owner               | 設定resolverへprocess lifetimeを持たせない                                  |

親子でregistryやtool内stateを共用しない。子AgentもWorker起動時に現在内容から構成し、 そのchild
executionに実際の構成を記録する。親の起動時構成をchildの使用版として記録しない。 新しい汎用plugin
frameworkや万能Runtime classは増やさず、既存`WorkerGeneration`/loopへの構成入口を整理する。

### 4.4 起動継続と対象別reject

読込結果は、選択元、採用した設定/tool、rejectした対象とfile/項目/理由を保持する。
実行が成立する形式・contractの検証であり、追加のpermission/hardening判定にしない。

| 対象                                  | 利用者に見える結果                     | 実行への反映                                                                |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| 一つのtoolが不正                      | Core/TUIは起動し、そのtoolと原因を表示 | 当該toolをregistryとmodel-visible宣言の両方から外し、利用可能toolで実行する |
| 一つのnamed Agent JSONが不正          | そのAgentのreject理由を表示            | 他のAgentの構成を継続する。拒否対象へのspawnは理由付きで成立しない          |
| 選択したroot Agent JSONが不正         | Core/TUIを起動し、構成拒否と原因を表示 | そのAgentのtaskは受付拒否。会話やdraftを失わず、provider requestを送らない  |
| `henji run`でtoolのrejectがある       | 通常の出力方式で理由を確認できる       | 有効toolでtaskを実行。最終結果と構成情報を保存する                          |
| `henji run`でroot Agentが構成できない | 理由付きの結果と終了statusを返す       | providerへ進めず終了する。Coreを起動する経路には変えない                    |

Core discovery/list/status、Session一覧・履歴参照、TUI接続をAgentの構成成功の前提にしない。
`serve_cli.ts`の先行解決と`core_service.ts`の初期`openSlot()`の失敗伝播を双方変更する。
構成できないときのSurface表示を、単なるprocessのstderrだけで済ませない。
reject理由は短いfactとして人間に示し、tool不足をAgentにもinstruction内で知らせる。
Agent構成成功後のexecutionには採用済み設定とrejectによる構成差分を相関する。
credential値とAuthorizationを設定・reject理由・履歴に含めない。

修正したfileの反映は新しいWorkerの起動で行う。新規Sessionの起動、またはCore再起動後の保存Session
openで 再解決する案。同じCoreで同じSessionを選び直すだけでは新Workerの起動を保証しない。
現行Coreは同一Sessionの再openを省略し、LazyWorkerSessionは失敗したstarting Promiseを保持するため、
この二つを自動的な再読込経路と見なさない。拒否表示から使う具体的な人間の操作とdraftの保持は§6で確定する。
Core restartだけに解決を固定しない。既存Workerへの自動watchやS4のreload commandは追加しない。

## 5. 新DB・保存contractの設計案

### 5.1 保存する正本

新DBは同じworkspaceの新しいpath（案: `history.sqlite3`）へ作り、旧DBを上書き・移行・削除しない。
production
read/writeは新DBだけを使う。新schemaはこの保存責務から定め、旧column名を維持することを目的にしない。

| 情報                                                           | 新しい正本と参照                                                 | 旧保存先の整理対象                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Session metadata・現在model・会話revision・checkpoint          | `sessions`。会話message/turnへの参照を持つ                       | `sessions`とpersistent `session_heads`のrevision重複。detachedの基底revisionはexecution側へ分ける   |
| executionのtask/親子/基底状態/build/model/結果                 | `executions`。起動構成snapshotへの参照を持つ                     | `executions`と`execution_admissions`の統合、旧Definition ref、artifactへの同じ情報の重複保存        |
| 起動時の実効Agent設定・instruction・tool版/contract            | `configurations` snapshot。独立IDと内容参照を持つ                | Definition/manifest/context snapshotに跨る共通の構成情報を一つの正本へ整理                          |
| 会話に採用されたturn/messageの順序                             | Sessionからexecution/messageへの採用・順序記録                   | `session_turns`のbuild/Definition/model重複。必要な会話projectionは参照または用途の明確な保存を使う |
| executionごとのmessageとsemanticな出来事                       | semantic recordとmessage内容の正本                               | `session_messages`/`execution_messages`/`semantic_occurrences`の内容・順序の役割を対応付けて整理    |
| 参照する実内容                                                 | contentsとその参照                                               | 既存immutable contentを再利用できる。hashは内容保存用で、revisionの成立条件にしない                 |
| 進行中assistant本文、context/model request attribution、recall | 実行正本に結び付く専用record/projection                          | 既存進行中本文・context manifest・recall relationの機能を維持し、snapshotとの責務を分ける           |
| 人間向けartifact/diagnostic/export                             | 上記正本から生成するread model。固有診断factが必要な場合だけ保存 | `derived_documents`とartifact schema 2〜7/旧plannerの読取分岐、全文重複、prototype名/re-export      |

table名は案。実装前にwrite/readの対応表と具体column・index・transactionを確定する。
projectionを残す場合は利用者の表示・再開・参照に必要な用途と更新元を明記する。
通常の会話参照で全履歴を再走査する方式へ置換しない。

### 5.2 identityとattribution

- Session ID、execution ID、Worker generation ID、構成snapshot ID、Agent/tool名、版名を区別する。
- configuration snapshotは起動時に読み込んだAgent設定・instruction・採用tool contractと版名を表す。
  共通起動構成を使う複数executionは同じsnapshotを参照できる。
- `/model`や起動指定、spawn時指定による実際のmodel/effort、max-stepsの実効値、基底会話revision、
  recall、requestごとのcontext attributionはexecution側へ相関する。起動snapshotだけでmodel
  input全体を表さない。
- revisionはstringの版名で、DBのcontent identityやunique keyにしない。
  同じ版名で異なる内容を使ったexecutionでも、独立snapshot/内容参照で当時の構成を保持する。
- tool source全文の復元は受入条件ではない。実装の識別にはtool名・版名・選択元とHenji buildを記録し、
  当時のinstruction/tool contractなど実際に提示した内容は保存する。

### 5.3 必要な利用動作の維持

新規Sessionの実行と停止後再開、canonical採用、failed/cancelled executionの参照、親子関係、
model変更、進行中本文、context/recall、診断、Session削除、履歴export/readbackを新DBへ接続する。
storage commitとcanonical採用を区別し、成功した会話の採用とSession
revisionの更新は同じtransactionで行う。 複数Coreとheadless Hostの共有DB利用、既存のSession/execution
lock、write待機、初期化同期、 interrupted execution reconciliationは現行利用に必要な動作として扱う。
既存の制約やlockを機械的に増やす一般的なhardeningは対象外。

## 6. スライス別の実装・test・review計画

### 6.1 P0: 実装前のcontract確定

P0は実装スライスの着手条件を具体化する設計作業で、product機能の追加スライスではない。
方針を再承認のために蒸し返さず、次の局所的な実装詳細を現行sourceと隔離probeで確定して本書へ追記する。

2026-10-04に[具体contract](increment-181-contract.md)へ、JSON省略/空配列、catalogとmetadata、 Worker
tool API、保存column/write/read/transaction/projection、構成snapshotとtask拒否/draft/回復、
切替・撤去の対応を確定した。standaloneの外部TS/local import/API接続も実証した。
新schema/Surfaceの実装はSlice 2〜4でこのcontractへ接続する。

1. Agent JSONの省略/空配列、role instructionの合成、defaultの追加tool、config/catalogの具体形式。
2. 外部tool moduleのcompiled binary内API接続、local import、読込・実体化・終了の最小contract。
   standaloneのimportが未確認のままstore撤去を始めない。providerは不要な確認である。
3. 保存項目ごとのwrite/read対応、具体table/column/index、canonical transaction、projectionの更新元、
   各API/CLIの新payload。detachedとpersistentの保存上の差を明記する。
4. root構成拒否でもCore/TUIが利用できるsnapshotとtask受付結果、reject理由の表示、draftの所在。
5. 人間の回復操作。新規Sessionは既存`/new`から現在fileを解決する新Workerを起動する。
   保存Sessionを同じ内容で継続する場合はCore再起動後にopenする。同一Coreでの同一Session再選択を
   Worker再起動と扱わず、新しいreload/retry commandをこのincrementで追加しない。

新しい状態/処理ごとに既存ownerと利用者を対応付け、不要になる経路・保存先を撤去表に記す。
What/Whetherを変える判断が生じた場合だけ利用者へ戻す。実装詳細の確定のために権限確認を繰り返さない。

### 6.2 スライスと依存関係

実装五スライスと最終統合受入一スライスを順に進める。 各スライスは実装、対応するfocused
test、独立review、指摘の採否・必要な修正までを一単位とする。
前スライスの結果と残りの制約を記録してから次へ進む。途中成果は常用配置・releaseしない。
P0で確定した境界に従う独立した実装準備は並行できる。接続と完了判定は依存順を守り、
各sliceの実利用経路の確認・独立review・指摘対応を省かない。

| スライス                                  | 利用者に必要な動作/成立させる境界                                                                           | 実装の中心                                                                                                                       | 完了を確認する経路                                                                                                                                    | 独立reviewの対象                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Slice 1: 設定・toolから実行構成を作る     | 同梱default、外部JSON、genericの基底、五種のtoolと外部moduleを共通factoryで構成。tool検証を個別rejectへ変換 | 設定/版名/採用結果contract、Host resolver、Worker構成factory、tool loader、standalone用API接続                                   | 実Workerと隔離file/processで構成・提示schema・executorを確認。compiled binaryから外部module/local importを実行                                        | 宣言とexecutorの一致、role/base合成、起動時の現在file利用、function/stateのWorker local所有、rejectの局所化              |
| Slice 2: 新DBの保存・読取を成立させる     | 実効構成とexecutionごとの選択を保存し、新規Session・canonical/non-canonical履歴を読める                     | 新schema/store、Dataの保存contract、Session codec、configuration/semantic/context/recall、history/diagnostic read model          | production Data serviceから書込→close→read-only readback。成功/cancel/failed、detached、Session再開とcanonical transactionを確認                      | 情報の正本、会話採用とstorage commitの区別、親子/selection相関、既存の必要projectionと共有DB利用、旧互換機構がないこと   |
| Slice 3: root・子Agent・runの実経路を接続 | TUI/APIのtask、generic/named spawn/status/collect/cancel、Session follow-up、CLI runがJSONと新DBを使う      | Worker session/host/protocol、child supervisor、Application/Data接続、CLI Worker/run、execution attribution                      | production Host–Worker–Dataのfocused確認。必要な実provider smokeでroot→tool→final、親子実行、CLI最終出力を確認し保存readback                          | root/child所有、selection適用時点、cancel/settlement、childに実際の設定を記録、Session follow-upとの区別                 |
| Slice 4: 起動継続・reject表示・回復操作   | 不正tool/AgentがあってもCore/TUIが起動し、人間が原因を確認して新Workerで使い直せる                          | serve/Core初期化、公開snapshot/受付結果、TUIの起動・表示・draft、runのreject結果                                                 | 隔離XDGのtmuxでinitial Sessionありの起動、tool一つの拒否、root JSONの拒否、file修正→/new、保存Sessionの再openを確認。必要時に有効toolで実provider完了 | アプリ起動とAgent構成の分離、task受付結果、draft/会話の保持、原因がSurfaceへ届くこと、回復で新Workerが実際に起動すること |
| Slice 5: 管理操作・旧機構を整理           | 現在fileの配置/一覧/確認/有効化を使い、旧TS Agent Definitionや過去revision管理を要求しない                  | module/tool CLI/help、binding/store/selector/transport、旧artifact/codec分岐、export/build manifest/packaging、関連test/操作文書 | compiled binaryの新設定/tool管理と既存history/diagnostic/Session操作を確認。旧契約を要求するtest/task/exportを対応・撤去                              | 撤去漏れと未使用保存先、新旧dual経路がないこと、standalone配布と追加toolの通常利用を狭めていないこと                     |
| Slice 6: 統合受入・実provider E2E         | 最終候補で基本フローを人間のproduction操作から完了し、停止後に履歴を確認                                    | E2E helper/シナリオ、結果記録、必要な統合修正                                                                                    | §7と最終E2E計画に従い、authoritative gateを一回、compiled binary/tmux/API/run/停止DB readbackを実施                                                   | 最終候補の差分・各スライスfindingの解消・実行証拠と成功条件の対応、未確認範囲と完了判定                                  |

Slice 1・2の入口は後続スライスでproductionへ接続するため、単体でHenji全機能の完了とは扱わない。
隔離Worker/Data実経路で確認する部品の境界と、まだ接続されていないSurfaceを結果へ明記する。
途中に旧sourceが残ることを旧形式互換の仕様にしない。新しいcodeへlegacy
converterや二重読書きを追加せず、 切替時には関連するproduction
callerと保存contractをまとめて新経路へ接続する。 全スライスが同じP0のcontractを使用する。Slice
3は1・2に、4・5は3に、6は1〜5に依存する。

### 6.3 各スライスの実施順と判定

1. そのスライスの操作→結果、owner、変更対象、接続済み/未接続の経路を本書で確認して実装する。
2. §7の動作へ対応するfocused testと必要なtype check/format/lint、`git diff --check`を実行する。
   実Worker、実process、Data、compiled binaryを必要な境界で使う。test
   helperの形をproduction仕様にしない。
3. 未確認事項がprovider/modelの実応答に依存するときは、§7.1の承認済み対象で必要な最小確認を行う。
   offlineで確認できる設定形式・DB・起動拒否には推論を使わない。
4. reviewerへ変更差分、要件、実経路、実行証拠、未確認範囲を指定してread-onlyの独立reviewを依頼する。
   初回は30分、10分間新しい証拠/結論がなければ中断。reviewerはfull gateや実providerを実行しない。
5. defaultがfindingを採否し、採用分を修正してfocused確認する。re-reviewは変更と既存findingの解消だけを
   15分以内で一回行う。新しいBlocker/P1の具体的なsource-to-impactがある場合だけ追加範囲を判断する。
6. 実装、確認、review/修正、実providerの実回数、残りの接続/未確認を§10へ記録して次へ進む。

reviewは一般的なsecurity/hardeningや網羅matrixを追加するために使わない。 計画外のproduct
bugはsource・利用者影響・修正案を報告し、独断でscopeへ追加しない。
途中で`v0:test`/`v0:gate`を繰り返さない。authoritativeな`v0:gate`はSlice
6の安定候補へdefaultが一回実行する。
失敗時はfocused確認で原因を特定し、候補を変更した理由を記録してから必要な再実行を行う。

## 7. 動作に対応する確認と受入案

testは以下の具体的な動作を確認する最小限とし、未観測provider
variant、permission/入力matrixを追加しない。

| 確認するproduct動作                                                                      | 根拠                                                  | 確認方法                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| 設定fileなしで同梱defaultを構成し、外部JSONでreviewerを選択できる                        | default同梱/JSON差替えの利用者決定                    | focusedな共通構成・Host経路確認とcompiled binary                               |
| genericのtask/model/tools指定とnamed子Agentのspawn/status/collect/cancelが動く           | generic方針と既存通常利用経路                         | 現行childのfocused確認を新contractへ対応                                       |
| read/write/edit/bash/bash_outputを使い、bashの短縮出力の続きが取得できる                 | 基本五種の決定、現行bashがbash_outputへ誘導するsource | 隔離workspaceでfile操作・実processを使うfocused確認                            |
| 外部tool編集が新Workerで反映され、起動済みWorkerの構成は維持される                       | 起動時読込の決定                                      | standalone binaryでroot/childを新起動し、使用版と提示contractをreadback        |
| tool一つのrejectでCore/TUIが起動し、他toolを使え、model宣言にも不正toolがない            | 個別rejectの利用者合意                                | 実際のimport/export失敗を対象とするfocused確認とtmux production TUI            |
| 不正root JSONでもCore/TUI・履歴表示を利用でき、taskを理由付きで拒否できる                | Agent構成rejectの利用者合意と現行Core初期化失敗経路   | initial Sessionありのserve/TUIと、runのfocused確認。tmuxでdraft/原因表示を観測 |
| Sessionのfollow-upが次executionを開始できる                                              | 既存Session対象のfollowUp.queue経路                   | 現行Task/Coreのfocused確認を新contractへ対応                                   |
| 新DBに成功・cancel・failed executionを保存し、停止後再開とhistory/context/recallが使える | 保存整理方針と既存通常利用                            | production Data経路のfocused確認、停止DBのAPI/CLI読取                          |
| model変更後・child指定後の実際のmodel/effortと構成snapshotを区別して保存する             | 現行turn開始時のselection適用source                   | 同じWorkerで後続executionのreadbackを比較                                      |
| 同じ版名で内容を変えても当時の設定/contractが読める                                      | revisionを内容identityにしない合意                    | 二つのWorkerから保存し、内容参照をreadback                                     |

実装中はfocused test、必要なtype check/format/lint、`git diff --check`を使う。
Surfaceの表示・操作変更は隔離XDGのtmux上でproduction TUI確認し、本書へ操作と観測を記録する。
実configと既存DBは検証に使わない。 人間がproduction経路でtaskを完了することを最終受入とする。
スライス内の必要な実provider確認と最終E2Eは追加指示で承認済み。§7.1の対象・保存先と最終E2E計画に従う。
レビュー用agentは実providerを呼ばず、defaultが操作と証拠を所有する。

### 7.1 スライス内の実provider確認（承認済み）

対象は既存の通常利用accountの`openai-chatgpt / gpt-6.1-sol / medium`を基本とする。
これは179/180の実受入で使用したrouteであり、provider variantの網羅を目的にしない。
selectionの変更確認では、現行catalogで選択可能な同じmodelの別effortを一つ使う。
追加provider/modelの網羅確認は計画に入れない。

| スライス | 実providerを使う必要がある場合の確認                                                                  | 実行見込み                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Slice 1  | 設定・import・tool実体化は推論不要。factoryとproduction model接続に未解決の疑問がある場合だけ短いtask | 原則0。必要ならroot 1 execution                                              |
| Slice 2  | DB read/write・canonical採用はproduction Data経路で確認できる                                         | 原則0。provider固有の保存内容が未確認なら短いtask 1 execution                |
| Slice 3  | root→tool→final、generic/named子Agent、CLI runと新DB相関                                              | root task・親子task・runを必要分各1回。親子taskは必要なchild executionを含む |
| Slice 4  | 不正toolを除いた構成で実taskが完了し、修正後の新Workerが現在内容を使う                                | reject状態/修正後を必要分各1 execution。不正root JSONの拒否確認は0 request   |
| Slice 5  | 新CLI/packagingからの構成とtool利用に、既存証拠では解消できない不確実性が残る場合                     | 原則0。必要ならcompiled binaryで1 execution                                  |
| Slice 6  | 最終候補を通した基本フロー                                                                            | 最終E2E計画の各シナリオを実施                                                |

保存先はスライス確認が`.tools/increment-181/slice-N/<run-id>/`、最終E2Eが
`.tools/e2e-181/<run-id>/`。各確認前に操作目的、provider/model/effort、execution見込み、保存先を提示する。
承認済み範囲内では提示後に実行を続け、都度の許可確認は増やさない。 execution見込みと実model
request数は区別し、tool loop・compaction・cancel・childを含む実回数を 短いrequest
factから集計する。見込み件数をruntimeの上限や成功条件にしない。

offlineで疑問を解消できた場合や同じ候補で十分な実証拠がある場合はスライスsmokeを省略し、理由を記録する。
同じ候補の成功済み推論を機械的に繰り返さない。失敗の調査・修正後再確認はこのincrementの必要な範囲で行い、
変更した条件・実回数・結果を記録する。最終E2Eはスライスsmokeを代替にせず、安定候補で別途行う。

実行には隔離HOME/XDG/workspace、新DB、検証用Core/binary/tmuxを使用する。
credentialは既存登録を必要な範囲で隔離環境へ非公開で複製し、credential値とAuthorizationは出力・保存しない。
常用Core、実config、旧DB、配置binaryを変更しない。通常raw通信やSSE断片を常設収集しない。
request/provider/model/API/HTTP/error等の短いfact、semanticなtool引数/結果、outcome、構成内容と画面/操作を保持する。
詳細rawが必要になった場合は個別probeとして扱う。

### 7.2 最終E2E

[Increment 181 最終実provider E2E計画](e2e-181-plan.md)をシナリオ・操作・保存readbackの正本とする。
基本五種、JSON/外部tool変更、個別rejectと回復、root/child、selection、steering/follow-up、cancel、
保存Sessionの再開、CLI runを最終compiled binaryのproduction経路で確認する。 機械的gate成功やoffline
testだけで完了にしない。実装・test・各review・最終E2Eの結果をまとめて完了判定へ進む。

## 8. 構想・architecture・roadmapの変更案（未反映・別途承認）

| 正本                                               | 変更理由と意味上の変更案                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/concepts/experience-driven-self-revision.md` | Definitionの改訂をexact revisionで追う記述を、JSON設定/使用版と実際の観測内容で振り返る方針へ変更する。経験から人間が改訂を採用する目的は維持                                                 |
| `docs/architecture/henji-host-agent-worker.md`     | executable Agent Definition/module closureの取込・評価・managed immutable storeから、Hostの現在設定選択とWorkerの共通構成へ変更。revisionは履歴ラベル。起動継続と個別reject、新DBの正本を反映 |
| `docs/roadmap.md`                                  | F06と関連するtool/Definition管理の現行方式、F04の保存schema/責務、旧exact selector/transport機能の廃止範囲を更新する。S4のreload実装済みとは記載しない                                        |

これらは本incrementの包括承認と別に提示・承認する。現在の正本は変更していない。

## 9. Reviewと結果

初回reviewは本書と指定sourceをread-onlyで確認する。上限30分、10分間新しい証拠/結論がなければ中断。
通常correctness、利用者の明示要件、実利用経路、保存・参照の整合性、変更によるregressionを評価する。
一般的security/hardening review、full gate、実provider call、無関係な候補調査は行わない。
指摘の採否と計画外のproduct判断はcoordinating ownerが行う。

### 9.1 初回の独立review（2026-10-04）

read-only reviewerが文書全文と指定sourceを批判的に確認した。test/full gate、provider
call、file変更は行っていない。

**P2: 子Agentのfollow-upを既存機能として扱っていた。採用・修正済み。**

- 初回案の§3のchild経路と§7の受入に、child follow-upを含めていた。
- `v0/agent/tools/async_agents.ts`のrequest union（67行以降）と
  `v0/agent/worker/worker_host_children.ts`のdispatch（165行以降）はspawn/status/collect/cancelだけである。
  `v0/agent/host/core_service.ts`のfollowUp.queue（1593行以降）はSessionを対象にする。
- child follow-upを既存機能として実装・受入すると、未承認の機能新設またはSession APIの誤用になる。
- defaultが指摘を採用し、childをspawn/status/collect/cancelへ訂正した。 Session
  follow-upは別の現行経路・受入として明記した。child follow-upの新設は対象外。

追加のP1/P2は確認されなかった。reviewerは、この訂正後の設計方向について詳細設計へ進めると評価した。
実装準備状態は完成計画ではなく、§6の具体化を必要とする。

reviewerが確認した範囲:
文書全文、root/child起動・構成、tool実体化とbash_output接続、executionごとのmodel選択、
Dataのcanonical/non-canonical保存、現行schema/canonical transaction、参照snapshotのcommit対応。

reviewerが未確認とした範囲: standalone binaryの外部module/API/local
import、具体的な新schemaと全API/CLI読取対応、
TUIのreject表示と回復操作。Pi/Zot/OpenCodeの個別sourceは独立reviewでは再検証していない。
参照実装の比較は§3のdefaultによる調査として扱う。

設計の具体化に関する補足として、現行Coreの同一Session再open short-circuit （`core_service.ts`
730行以降）と、失敗したstarting Promiseの保持 （`worker_tui_session.ts`
199行以降）が報告された。既に未確定としていた回復操作の確認であり、
独立findingにはしていない。defaultが§4.4へsource上の注意と新Workerを使う回復経路案を追記した。

初回指摘修正と追記はdefaultが文書確認した。この時点では独立re-reviewを実施していなかった。
初回案をそのまま実装開始可能な完成計画とは扱わず、追加指示を§6・§7へ具体化して次のreviewを行った。

### 9.2 追加スライス計画のfocused review（2026-10-04）

同じread-only reviewerへ、追加した§6・§7.1・§7.2・§10と最終E2E計画を指定し、15分以内の focused
reviewを依頼した。**対応が必要なfindingはなかった。**

Slice 1・2の部品境界、Slice 3でのproduction接続、Slice 4・5から最終受入への依存関係、
スライスごとのtest/reviewとprovider実行・保存先が整合していると確認した。 初回のchild
follow-up指摘も解消済みで、childの四操作とSession follow-upを分けている。

最終E2Eの基本五種、root/child、selection、steering/follow-up、detach/reconnectと保存Session再開、
起動時の編集適用、rejectと回復、cancel、CLI、failed保存の対応を確認した。
F2/F3、Escape、CLI三出力方式、child cancel後のstatus/collect、max-steps終了の診断と
failed/non-canonical保存は現行sourceに対応している。22 execution/約40 requestは規模見込みであり、
上限や件数目標ではない。承認済みprovider確認の再承認も要求していない。

未確認なのは、P0の具体contract/schema、standalone外部importの実証、新実装のAPI/helper、
状態待機とtaskの具体的な組み合わせである。E11後の正常task・recall・skill取得を予定taskへ
組み込む方針に矛盾はないが、最終候補で成立を確認する。

reviewの結論はP0で具体化してからスライス実装へ進める計画という評価である。
product実装・gate・provider E2Eの成功を意味しない。reviewerはfile変更や実行検証を行っていない。
defaultの文書format、local link、`git diff --check`は通過した。

## 10. スライスの実施結果

実装・test・独立review・実provider確認の結果を以下に記録する。

| 段階    | 実装/確認                                                        | Review/指摘対応                    | 実provider      | 状態 |
| ------- | ---------------------------------------------------------------- | ---------------------------------- | --------------- | ---- |
| P0      | contract確定・standalone import実証                              | Slice 1 reviewで関連contractも確認 | 不要            | 完了 |
| Slice 1 | 設定/tool構成入口、focused/standalone確認済み                    | P2二件修正確認済み                 | 不要・0 request | 完了 |
| Slice 2 | 新schema/core/store/Data実装・focused確認済み                    | P2二件修正確認済み                 | 不要・0 request | 完了 |
| Slice 3 | root/child/Worker接続・focused確認済み                           | P2一件修正・独立review通過         | 不要・0 request | 完了 |
| Slice 4 | Core/API focused、tmux拒否・修復確認済み                         | P2一件修正・独立review通過         | 不要・0 request | 完了 |
| Slice 5 | 旧Definition/旧DB codec整理、CLI/packageと既存実経路test移行済み | 独立review通過・P2一件修正済み     | 不要・0 request | 完了 |
| Slice 6 | gate615件通過、実E2E/DB照合、実build保存修正済み                 | 最終review・P2解消re-review通過    | 27 exec/61 req  | 完了 |

### Slice 1の実装と確認（2026-10-04）

- `configuration/default-agent.json`を同梱し、`agent_configuration.ts`/`configuration_resolver.ts`で
  現在JSON/catalog/tool metadataと対象別rejectをdataとして解決する。
- `tool_api.ts`の`@henji/tool`/`henji-tool/v1`と`worker_tool_loader.ts`で、Worker内の直接import/factory/
  Tool検証を実装。個別rejectから同梱への自動代替はせず、executeを検証のために呼ばない。
- `worker_configuration.ts`は実体化済みToolを既存共通compositionへ渡し、提示とdispatch、 共有bash
  output store、最終instructionとUUID snapshotを作る。起動後の編集でregistryを差し替えない。
- spawn filterは既存contractを名前に対する共通関数へ整理し、新factoryと旧callerが同じ処理を使う。
  buildのruntime rootへ新factoryを加え、alias/API/default JSONを同梱対象へ含める。

実Workerと実file/processを使うfocused testは7件通過。基本五種とbash_output続き、JSON省略/空配列、
genericのroleとtool filter/native
skill、同じ版名での編集とWorkerごとのstate、import/export拒否後のread利用、
不正Agentの拒否、大文字を含むnamed名を確認した。既存generic filterのfocused
regressionは2件通過した。 最終修正後のfocused check/fmt/lintとcompiled standalone再確認も通過した。

standalone確認ではbuild用sourceを削除後、別cwdからcompiled executable内Workerの新factoryを使い、
外部TS/local import/同梱APIを実行した。同じ版名でrole/local dependencyを変更し、
既存Workerは旧内容、新Workerは新内容を利用した。証拠と再実行helperは
`.tools/increment-181/slice-1/standalone/`。helper初回のtype指定・package config
copy漏れは修正してから確認した。

このsliceではCore/root/child/runのproduction caller、Data/new
DB、TUIのreject表示をまだ切り替えていない。 共通compositionの旧型・旧default
projectionや既存tool/Definition sourceは切替・撤去対象として残る。 新resolverへ旧data compatibility
read/dual-writeは加えていない。実provider smokeは不要で0 request。

独立実装reviewではP2を二件採用した。非空nameとして有効な`Reviewer`が旧小文字resource制約で
default構成全体をthrowする問題は、dataのagent/tool名をresource identityへ保持する修正で解消した。
空instructionが空component作成でthrowする問題は、role寄与だけを省き共通base等を残す修正で解消した。
reviewerは両方の修正を再現入力で確認し、次へ進む妨げになるfindingなしと報告した。
skill未採用時に利用不能なskill manifestをinstructionへ含めない修正も確認済み。
production接続・snapshotのDB保存・child実起動・TUI回復は後続sliceの範囲として未確認。

### Slice 2の実装・focused確認（2026-10-04、独立review中）

新schema1を`history.sqlite3`へ作成し、configurations/contents/messages/conversation_messages/session_turnsとsemantic記録を正本とするcore/storeへDataを切り替えた。Sessionと実行artifactは現行schema1のみを読み、旧DBを読まず、旧形式のmigrationを作らない。Worker
readyで確定した構成をadmission時にUUID参照で保存し、executionの実際のmodel/build/maxStepsと分けて保持する。command
correlationもsemantic admissionに実値を残す。

core focused2件、store focused1件、production Data保存/reopen1件、既存Data
service1件を通過。canonical
commit、非canonical部分assistant、同版名の別snapshot内容、context/recall/export、read-only
reopen、旧DB
sentinel不変を確認した。Coreの不正JSON→task拒否（execution0件）→file修復→新Workerで完了のfocused1件も通過した（Slice4の準備確認）。provider-free
headless経路も通過した。

実装中の確認で新storeのmessage content参照join漏れと、Session
codecのfield順序制約による正しいproduction record拒否を修正した。現行Session/turn
attributionではJSONのfield集合を検証する。実providerは未実施、full
gateは未実施。独立review結果の採否と修正後にSlice2を受け入れる。

Slice2の独立reviewではP2二件を採用・解消した。保存Sessionのdeleteはconversation/turn
projectionを先に、子executionから親へ同一transactionで削除するよう修正。canonicalとchildのある検証用Session削除のfocused
testが通過した。固有nameのrootは割当時nameと実効nameが違うためmodel/title変更を拒否していた。Session
ID/choiceのbindingを保って実効name比較を除き、reviewerがData実経路でcanonical保存→title→model変更を再確認した。残存findingなしでSlice2を受入。既存実データは削除していない。

Slice3の新Worker focused1件、既存headless1件、typed run
CLI2件、新factory7件を通過した。root/childを現在のJSONで起動し、genericとnamedの独立構成、file修正後の新Worker、startup拒否でadmissionなしを確認。新testの未保存parent
IDを実際にadmitするfixtureへ直し、production親子FKは維持した。独立reviewへ進む。

Slice3の独立reviewでchildへasync
toolを提示する一方Hostに対応処理がないP2を採用。既存architectureのrecursive
spawn対象外に合わせ、child起動contextからasync RPCを外し、同一registryの宣言/dispatchからasync
toolを除いた。reviewerは修正とprovider-free実Worker
probeを確認し、同版名のroot編集後のmodel切替でも既存root構成を維持、named
childは独立構成と親の現在model/effort、親子IDを保存し、ともにcompletedとなることを確認した。残存必須findingなしでSlice3受入。

### Slice4の実装・tmux・独立review（2026-10-04）

Lazy Worker起動へ接続し、Core起動時にselected
JSONを早期検証してアプリ全体を止めない。不正Agentはtask受付前にconfigurationRejectedを返し、executionをadmitしない。public
effectiveConfigへfile/reasonを返し、通常TUI会話へCONFIGURATION REJECTED
noticeを保持する。draftは拒否時に残す。bad
toolは構成全体を止めず、対象だけをfactory/registryから除く。

隔離XDGのproduction source CLI/tmuxで、不正root
JSONの初期Session起動、task拒否、file/reason表示、draft保持、execution0件、file修正→/new→renameによる実Worker起動を確認した。bad
bash外部folderのexport不成立でもCore/TUIと構成はreadyとなり、対象file/reasonが表示され、file修正→/newでrejectがなくなることも確認した。provider
request0。証拠は`.tools/increment-181/slice-4/2026-10-04/`。

実画面で、ready
configurationの固有Agent名が初回admitまでdefaultの表示となるずれを修正した。positionはWorkerのready構成名を表示し、起動前はallocation名を使う。独立reviewはさらに、固有名defaultで完了した保存Sessionへの初期--continueが旧Agent名filterで見つからないP2を再現した。makeSlotで既存sessionOpen同様latest→exactへ解決し、保存choiceを引き継ぐ修正を採用。reviewerはprovider-free実Core再起動で同じSID/canonical1turn保持、同版名file編集後のcurrent-rootを新Workerが読むことを確認し、残存必須findingなし。Core
focused2件とnotice4件が通過した。

Slice5移行中に、derived artifactがDataで取得したchildCleanup/storeResult/短いIPC envelope
traceを落とすregressionを確認した。artifact全文cacheを再導入せず、必要な実清算・保存結果とpayloadなしtraceをsemantic
host observationへ一回保存し、derived
readへ接続した。terminal/child実経路のfocused確認は通過。最終reviewでこの変更も確認する。

### Slice5の整理・確認・独立review（2026-10-04）

実行可能Agent/Tool Definition API、旧builtin wrapper、revision/archive/transportと旧DB
prototype/store/複数artifact codecを撤去。共有runtimeはJSON構成と実体化Toolだけを受け取り、Tool
APIを@henji/tool/henji-tool/v1へ一本化した。旧v7
semantic名は現行history_semantic_model/History型へ整理し、旧schema version11を撤去。未使用Session
rollbackは削除し、現在のcheckpoint処理を残した。管理CLIはcurrentfile/folderのcatalog更新とinspectのみを扱い、例はreviewer.jsonへ切り替えた。

混在testは実filesystem/bash/web/streaming/Data/親子/Session保存等の機能を保って現行設定へ移行した。廃止されたDefinition専用test/fixtureだけを撤去。複数process待機、liveness/cancel、thinking/streaming、診断、Data
terminal/child清算等のfocused testが通過した。実際のparent
admissionをfixtureで用意してFKを弱めず、pre-admission cancelはexecution未作成を確認する。JSR
dry-runの実54module closure、全体type check、format404files/lint398files、diff
checkが通過。fullgateはまだ未実施でSlice6へ進む。

独立reviewで、root defaultとnamed
defaultを混同するresolverのP2を採用。名前省略だけroot、明示defaultもnamed
catalogへ解決し、root項目がなければ同梱defaultとなるよう修正。実Workerのcoexistence確認と独立CLI
probeが通過した。reviewerはmetadataの失敗保存結果/compact IPC trace/recall literal/human
exportを停止後DBで確認し、残存必須findingなし。HTTP
activationの旧definitionRevision項目もagentFileへ切り替えた。compiled最終binaryと実provider
E2EはSlice6で確認する。

Slice6のauthoritative gate初回はcheck/fmt/lint通過後、named defaultとの区別を修正した後も旧明示agent
defaultを同梱rootとして使うtest
fixtureが残っているため失敗した。productionの選択contractは変更せず、同梱rootのsetupを名前省略またはagentChoice={}へ移行。ローカルprovider待機testが拒否後に待ち続けるためgateを中断し、該当実経路へfocused確認を行った。root/Worker/modelの67件、HTTP/TUI/shutdown14件、recall/cancel/none/delete/stream/session-close/sharedDBのfocusedが通過した。初回候補からtest
fixtureが変わり、失敗原因が解消したことを理由にgateを再実行する。

Slice6のgate二回目はcheck/fmt/lintを通過し、597件pass・17件failで終了した。残存する旧root選択fixture（14/15/32/91/94/159/167）が原因で、production変更は行わず名前省略またはagentChoice={}へ修正した。14/15/91/94のfocusedは52件pass後に91の残存一箇所を修正し同suite10件pass、32/159/167は9件pass。source型check・scoped
fmt/lint・diff
checkを確認した新候補でgate三回目を行う。SDKの未キャッシュambient型解決はcached-onlyでは成立しないため、focused型checkは通常の依存解決を使った。

Slice6のgate三回目はcheck/fmt/lintおよび614件のtestがすべて通過した（`.tools/increment-181/final/gate-3.log`）。同じsourceのstandalone
binaryを`.tools/increment-181/final/henji`へbuildし、buildIdは`aeda17d71a90c989d93ee6769c914edf80ec720e26850513ef6601683139fbe7`。最終E2Eの操作結果と停止DB照合は`.tools/e2e-181/2026-10-04/`へ保存した。

### Slice6最終reviewのbuild保存P2（採用）

実provider E2Eの停止DBは27 execution/61 physical
request、18構成UUIDを保存し、操作とsemantic履歴の照合は通過した。しかしbinary/CoreのbuildId
`aeda17d…`に対して全execution.buildが既存development値
`c738494f…`だった。既知B9のsourceは181前から同じだが、本incrementの「当時のbuildで同梱tool実装を識別する」新DB保存要件へ直接交差するためP2として採用した。B9の観測を通常利用メモから本incrementへ移し、HostからData
Worker initializeへBuildManifestV1を渡し、authority生成前にinstallする最小修正を実施。実Data
Workerへdevelopmentとは異なる正規manifestをinstall/admission/readbackするfocused確認を含む5件が通過、type/fmt/lint/diff
checkも通過した。production候補のこの変更を理由に最終gateを再実行し、compiled
providerなしの実admissionと停止DBreadbackで実build一致を確認する。元の27
executionの保存内容は書き換えず、当時の不具合の証拠として保持する。

#### B9の採用時の原観測

- 観測（2026-10-03、Increment 179のprovider-free受入）: 公式compiled候補と変更前baseline
  (`1d8d58e`)のmanaged headless実行を、終了後にread-only SQLiteで確認した。
  両版の保存executionのbuildIdはdevelopment値
  `c738494fbbf99c577b5c91b957df9f3f0efcfc755442293665f71c8e3bd30179`で、
  binaryの`--version`にある実buildIdと一致しなかった。
- 原因のsource経路: `data/client.ts`のData Worker初期化はstateRoot/workspaceRootだけを渡し、
  `data_bootstrap.ts`はbuild manifestをinstallしていない。`session_authority.ts`が
  `buildManifest()`の既定development値を取得し、`session_data_owner.ts`がexecution保存へ渡す。
- 利用者影響: 保存executionのbuildIdから、実際に使用したcompiled buildを区別できない。
  今回の候補identityはbinary SHA・version・Core readで確認した。
- 採用した修正範囲: Data Workerの初期化へ実build manifestを渡してinstallし、
  新しいexecution保存とreadbackで実buildIdを確認する。既存履歴の書換えは採用していない。
- 採用根拠: 181の実build attribution要件と最終実行証拠。
- 証拠: `.tools/increment-179/acceptance/definition-{baseline,candidate}/`、
  同受入の`definition_readback.ts`、[Increment 179](../increments/increment-179.md)。

修正後のgate四回目はcheck/fmt/lintおよび615件が全て通過（`gate-4.log`）。production3fileのmanifest伝達修正という候補変更を理由に再実行した。同sourceの再buildは`c7dff2e7d091742374c66696c2de6f64b04dbda77a808505eec0d59e8b1bb588`（`build-4.log`）。checkout外へコピーしたこのbinaryのstdin
run CLIとAPI Coreを、credentialなしの隔離環境で実行し、model
request前の失敗を新DBへ保存した。双方のexecution/derived
artifactのbuildIdがbinary実IDと一致し、sourceRevisionもdevelopmentではない。二実行ともphysical
request0。`build-fix/results.json`、同`readback.json`とexecution別記録で確認できる。helper初回のCLI
argvはinvalid_inputでadmissionなし、API一件のみ保存。修正したstdin経路で二件保存後、診断code期待を実`chatgpt_selection_missing`へ合わせて既存DBだけ読み直し、確認のために操作を繰り返さなかった。

最終E2Eは23件/53requestの受入フローにhelper修正・既存制約観測の4件/8requestを加え、計27件/61request。native
instruction/skill、五種tool、generic/named
child、同revision編集、reject/修復、model/steering/follow-up、detach/再開、cancel、stdin
text/stream/JSON、failed/recall、一覧/history/context/diagnostics/export、検証用Session削除を確認した。各scenarioとhelper修正の内訳は[最終E2E結果](e2e-181-plan.md#実行結果)を参照。model省略childの登録ID継承不具合は181前からの経路でありB10へ未採用として残した。

### 最終完了判定（2026-10-04）

read-only
reviewerによる最終reviewと一回の指摘限定re-reviewが完了した。採用P2のmanifest伝達修正、修正後compiled
binary/SHA、stdin CLIとAPI Coreのexecution/derived artifactの完全なbuild一致、実inactive
Session削除とSQLite row0、元27 executionの保持、615件のgate、E2E verification
passed=true/errors=[]を独立に確認し、新しいBlocker/P1なし・local完了可との結論を受けた。Ownerもこの結論を採用し、181をlocal実装・検証完了とする。

local完了判定時点では、稼働中の常用Core、実config、旧DB、常用binaryは変更していない。検証用Core/tmuxは全て停止。設定/tool/新DBの破壊的contract切替は実装したが、旧実データの移行・削除はしていない。構想・architecture・roadmapの意味変更案は§8に保持し、別途承認前に反映していない。その後の追加指示によるcommit/push・常用配置の結果は次節に記録する。B10のmodel省略child認証登録ID継承は未採用の既存不具合として通常利用メモに残り、181の受入では明示modelによる開始/cancelを実証した。

## Commit/push・常用配置（追加承認）

2026-10-04の利用者の「commit/push・常用配置をして」により、181の実装・関連結果記録と先行E6計画commitのorigin/mainへのpush、常用binaryの配置を承認された。
実装commitは`a9fd01ef184494b483b55ef7db77ded4776f6cf1`
（`refactor: configure agents from JSON and normalize execution history`）。先行計画commit
`27625405`とともにorigin/mainへpushした。配置完了記録も同じ承認範囲でcommit/pushする。

このcommitのclean sourceから公式buildを実施した。配置版はhenji 0.8.0、Deno 2.9.7、 buildId
`055edaadf7b3fd7964eafc5a56014c2f068175d2ead520f358525152a6257474`、 runtime digest
`db86bae20802782215d3e271028f4c83bc01ce38e5d72b04679b8abf0b1bb5f9`。 受入済み候補とruntime
digestが一致し、source revisionは上記実装commitでdirtyではない。
配置完了記録のcommitは文書だけの変更であり、binaryのsource revisionは実装commitのままとする。

`dist/henji`と`/home/agent/.local/bin/henji`へstaging fileから置換して配置した。
両方のversion出力とbinary SHA-256
`e42ae5cb84abc72dfd32d9ed135735834adf875337b7b46fddfa3f3331dfc7ae`が一致した。
旧binaryは`.tools/increment-181/deployment/henji.{dist,local}.previous`へ保存した。 build
log・配置先別の旧/new SHA・時刻は同folderの`build.log`と`deployment.json`に記録した。

配置した常用binaryを隔離HOME/XDGで実行し、Core/API起動、tmux上のproduction TUI接続、 設定ready・task
admission、実build manifestの新DB保存を確認した。 credentialなしの環境でmodel
request前に失敗させた確認であり、追加provider requestは0件。 保存した完全なbuild
manifestはCoreの実manifestと一致し、TUI detach・Core shutdown accepted・exit 0を確認した。
`probe-results.json`の`passed=true`、`probe.log`、TUI captureを同folderに保存した。
受入済みruntimeと同一で変更は配置と文書記録だけのため、full gate・実provider E2Eは繰り返していない。

実config・旧DB・稼働中常用Coreは変更していない。次回Core起動から配置版を使用する。
検証用Core/tmuxは停止済み。構想・architecture・roadmapの意味変更案はこの配置承認にも含めず、§8に保持する。

### 常用設定の切替漏れと修正（2026-10-04）

配置後の通常利用で、Core `e9f6b2bd`／Session `7b865ed1`が
`agents.json must contain schemaVersion 1 and agents`によりtaskをrejectし、draftを保持した。
常用catalogには旧`bindings.agent:reviewer`だけが残っていた。
隔離配置確認ではこの既存catalogを扱っておらず、常用設定の切替確認が漏れていた。

旧`/home/agent/.config/henji-harness/agents.json`をgit管理外の
`.tools/increment-181/deployment/config-fix/agents.json.previous`へbackupし、常用catalogを
`{"schemaVersion":1,"agents":{"reviewer":"agents/reviewer.json"}}`へ更新した。
rootは同梱defaultを使用する。旧reviewer.tsの指示・tool構成を確認し、同じroleを持つ
`agents/reviewer.json`をconfig rootへ配置してnamed reviewerを維持した。 旧managed
source・DB・instruction・provider設定・credentialは変更していない。 converterやcompatibility
readをproductionへ追加した変更ではなく、今回の常用設定の切替である。

配置済みbinaryの`agent list`・`agent inspect`・`agent inspect --name reviewer`は全てexit 0、
default/reviewerの`rejections: []`を確認した。
変更前後のSHAと配置先は同folderの`configuration-change.json`、CLI確認は`readback.json`へ保存した。
追加provider callは0件で、利用者のtask再送は行っていない。
現在の失敗済みSessionは`LazyWorkerHostSession.starting`のrejected Promiseを保持するため、
利用者には`/new`で新Workerを起動してから再送する手順を案内した。Core自体の再起動は不要。
通常利用の再送結果はまだ未確認であり、CLIの構成確認をtask完了として扱わない。

### 常用再送時のChatGPT認証更新失敗（2026-10-04）

設定修正後、利用者の新Core `eebdf857`／新Session `0a9b7b99`で構成は通過したが、 execution
`f26c2808-79fa-4af5-b995-2be4663b8fc8`はmodel request前に失敗した。 read-only
DBの診断は`ChatGPTAuthError`／`invalid_grant`、provider request 0、tool call 0。
既存の短い認証request記録は`oauth.token` HTTP 400／`invalid_grant`で、
accountの`needsReauthentication=true`を確認した。credential値・Authorizationは出力していない。
証拠は`.tools/increment-181/deployment/auth-failure/readback.json`。

`chatgpt_auth.ts`の期限切れaccountのrefresh経路では、この応答を受けて再認証必要状態を保存する。
利用者へTUIの`/login`→ChatGPT→account一覧の`r`で再認証後に同じtaskを再送する手順を案内した。
こちらから追加認証requestやmodel request、task再送は行っていない。再認証と通常利用成功は未確認。

E2Eの「元credential fileのhash一致」はlocal
fileの非変更だけを示し、認証service側の状態不変は保証しない。 元accountのaccess期限は2026-10-03
14:08:58 UTC、同じ認証の非公開複製を用いたE2E開始は19:30:49 UTCで、
期限切れaccountをrefreshする実装経路に該当する。複製側の認証更新が今回の失効に影響した可能性がある。
provider側の失効理由と複製側のrefresh記録は未確認のため、原因を断定していない。
