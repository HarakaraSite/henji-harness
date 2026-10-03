# Increment 181 P0 contract

更新日: 2026-10-04

[`increment-181.md`](increment-181.md)の§6.1を具体化する実装contract。
合意したproduct方針を変更せず、Slice
1〜5で同じ境界を使う。新DB/Surfaceはこのcontractに沿って後続sliceで実装する。

## Agent設定と現在fileの選択

Agent
JSONは`name`、任意の版名`revision`、role寄与`instruction`、tool名配列`tools`、子Agent名配列`agents`。
`name`は表示・相関に必要な非空string。revision省略は`unversioned`という表示ラベルで、内容identityに使わない。
instruction省略は同梱role、空stringはrole寄与なし。未知の追加metadataだけでは拒否しない。

- tools省略は同梱defaultの選択。`[]`はtoolを宣言しない。skill/submit_json_resultの自動追加で空配列を上書きしない。
- agents省略はgenericと現在のnamed catalog。`[]`は子Agent操作を構成しない。
- 同梱default JSONのtoolsは基本五種＋web_search/web_fetch/skill/submit_json_result。 native
  skillは実際のcatalogがあるときに提示する。追加web toolの供給を廃止しない。
- genericは同梱default JSONを基底にtask/model/tool
  filterを適用する。同梱generic専用Definitionを新設しない。 named親のroleを継承しない。spawn
  filterは既存のdeclared toolを絞るcontractとnative helperの扱いを維持する。
- root、named、genericのinstructionは、共通base→role寄与と構成不足の案内→実際のtool guideline→
  workspace AGENTS→skill manifest→runtime facts。共通baseの既存選択は維持する。
  JSONのroleを共通baseの代替と扱わない。

config rootの`agents.json`:

```json
{
  "schemaVersion": 1,
  "default": "agents/my-root.json",
  "agents": { "reviewer": "agents/reviewer.json" }
}
```

default項目は省略可能。catalogがない/有効なcatalogでdefault指定がない場合は同梱default。
明示file指定が優先し、named指定はcatalogの現在file、genericは同梱基底を使う。 choiceのname省略がroot
default選択であり、明示name `default`も他のnamedと同じcatalog entryを選ぶ。 `agents.default`はroot
defaultの代替にはしない。 root defaultの差替えJSONは固有nameを持てる。named catalogのkeyとJSON
nameは一致させる。 相対pathはcatalogを置くconfig
rootから、明示fileは起動cwdから解決する。絶対pathも使える。
catalog名genericへの差替えは行わず、用途ごとの設定はnamed Agentに置く。

選択するJSONの失敗を同梱defaultへ代替しない。named JSONの失敗は当該entryの理由として保持し、
root/他namedは構成できる。利用不可namedをmodelのspawn
enumに含めず、不足理由をinstructionとSurfaceへ渡す。
childは親の起動snapshotではなく、child起動時にcatalogと現在fileを再解決する。

## Tool metadata、Worker APIと寿命

config rootの`tools.json`:

```json
{ "schemaVersion": 1, "tools": { "read": "tools/read", "marker": "tools/marker" } }
```

folderの`tool.json`:

```json
{ "name": "marker", "revision": "local-1", "apiContract": "henji-tool/v1", "entry": "index.ts" }
```

folderはconfig root相対または絶対path。entryはfolder相対または絶対path。 Agent
JSONが宣言したtoolを解決し、未指定toolは同梱実装、指定した同名folderは置換として扱う。
metadata/import/factory/返却Toolの検証失敗は当該toolだけrejectし、同梱へ代替しない。
tools.json全体が解析不能で置換指定を判別できない場合は、そのAgentの構成をrejectする。
Core/TUIの起動はこの失敗と分離する。形式の未知metadataだけではrejectしない。

新しい外部toolは`@henji/tool`をimportする。typeとToolInputError等のruntime値はbinaryへ同梱する。
default exportは`(input: ToolFactoryInput) => Tool | PromiseLike<Tool>`。 inputはworkspace、skill
catalog、process executor、work-tool seams、同じWorkerのBashOutputStore、 web backend、既存provider
request/credential presence seam。modelやCore/DBの所有をtool factoryへ移さない。
Toolは現行のname/description/inputSchema/executeと任意guideline/terminalを使う。
nameと選択名の一致、宣言のJSON dataと実行functionを確認し、検証のためexecuteを呼ばない。
moduleのlocal importはその場でDenoが読み込む。source closureの列挙・hash照合・永続copyはしない。

Host結果は設定・file・metadata・対象別理由だけ。Workerでmoduleをimportし、factoryを一度呼び、
実体化した同じToolを提示schemaとdispatchへ使う。外部toolのfunction/内部stateをpostMessageしない。
bash/bash_outputは同じWorkerのoutput storeを使い、Registry.closeでそのstoreを閉じる。 physical
process/childの清算は既存Host ownerを維持する。

起動済みWorkerはimport済みfunctionと起動時の設定・宣言を使う。file変更は新Workerから反映する。
configuration IDは独立UUID。同じrevisionの内容変更も別snapshotとして保存する。
snapshotは実効Agent設定、選択元、最終system
instruction/components、実提示toolの名・版名・選択元・contract、
reject差分。実model/effort、build、max-stepsとrequest attributionはexecution側へ記録する。

P0のstandalone probeは、build用sourceを削除後、別cwdからcompiled binaryのWorkerで外部TS、 local
importと同梱APIの実行を確認した。証拠は`.tools/increment-181/p0/`。 Slice
1で新APIと共通factoryを使う同等の確認、Worker間の編集反映を行う。

## 新DBの具体保存責務

pathはworkspace data rootの`history.sqlite3`、新schema versionは1。
旧history-v7.sqlite3は読込・移行・上書き・削除しない。DBのschema不一致を旧converterで処理しない。
Data Workerの既存serviceを入口にし、production store/coreを新storeへまとめる。

主要columnの`*_json`はdata-onlyの現行型または新contract型をserializeする。
contentsはSHA-256の実内容保存だけに使い、Agent/tool revisionの成立条件にしない。

| Table                 | Column/参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Writeのowner/時点                                          | Readと用途                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| store_metadata        | singleton、schema_version、created_at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | store初期化                                                | open時の新schema確認                                                               |
| sessions              | session_id PK、workspace_root、agent_choice_json、created_at、updated_at、title、state_revision、next_turn、active_model_json、message_count、model_change_count、turn_count、checkpoint_json                                                                                                                                                                                                                                                                                                                              | Data open/create、成功turn採用、model変更、checkpoint      | Session一覧/再開、現在selection、conversation cut。persistent revisionの唯一の正本 |
| configurations        | configuration_id PK、created_at、snapshot_content_digest FK contents                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Worker readyの構成をexecution admission時に一度保存        | context/履歴/diagnosticの当時設定。Agent revisionをunique keyにしない              |
| executions            | execution_id PK、canonical_session_id nullable FK sessions、session_correlation、task_id、task_content_digest、parent_execution_id nullable、spawn_call_id、turn_number、base_revision、base_message_count、created_at、settled_at、agent_name、configuration_id nullable FK configurations、build_json、model_json、max_steps、instance_correlation、worker_generation、lifecycle、outcome、adoption、latest_ordinal、occurrence_count、terminal_record_id、unresolved_mandatory_count、event_count、runtime_outcome_json | Data admission、semantic append、settlement/reconciliation | 実行一覧・親子・診断相関・history read。旧executionsとadmissionsを統合             |
| contents              | content_digest PK、byte_length、content_bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | config、message、semantic/context/diagnosticの内容保存     | 実内容の正本とreadback。複数のprojectionへ全文copyしない                           |
| messages              | execution_id FK、message_ordinal、content_digest FK contents、PK(execution_id,message_ordinal)                                                                                                                                                                                                                                                                                                                                                                                                                             | Data settlementで当該executionの新messageを保存            | canonical/non-canonicalに共通のmessage正本                                         |
| session_turns         | session_id FK、turn_ordinal、turn_number、execution_id unique FK、PK(session_id,turn_ordinal)、unique(session_id,turn_number)                                                                                                                                                                                                                                                                                                                                                                                              | canonical採用transaction                                   | 会話に採用したexecutionの順番。build/model/configはexecution参照                   |
| conversation_messages | session_id FK、message_ordinal、turn_number、execution_id、execution_message_ordinal、PK(session_id,message_ordinal)、FK messages                                                                                                                                                                                                                                                                                                                                                                                          | canonical採用transaction                                   | Session表示/再開のindexed projection。message本文はmessagesを参照                  |
| session_model_changes | session_id FK、change_ordinal、effective_from_turn、changed_at、selection_json、PK(session_id,change_ordinal)                                                                                                                                                                                                                                                                                                                                                                                                              | Data model変更                                             | model変更の経緯、再開/public read                                                  |
| semantic_records      | record_id PK、execution_id FK、ordinal、kind、observed_at、payload_json、content_digest nullable FK、unique(execution_id,ordinal)                                                                                                                                                                                                                                                                                                                                                                                          | execution journalとAgent Data観測                          | tool順序・引数・結果、control、短いprovider fact、runtime outcome                  |
| semantic_relations    | record_id FK、relation_ordinal、relation、target_record_id、mandatory、resolved、PK(record_id,relation_ordinal)                                                                                                                                                                                                                                                                                                                                                                                                            | semantic append/対象到着                                   | 現行の関係解決・settlementに必要なprojection                                       |
| assistant_text_states | execution_id FK、lane、model_step、request_ordinal、first_event_ordinal、event_json、PK(execution_id,lane,model_step,request_ordinal)                                                                                                                                                                                                                                                                                                                                                                                      | Data assistant progress                                    | 進行中/中断本文のreadback。常設raw SSE保存ではない                                 |
| execution_contexts    | execution_id PK FK、manifest_json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent Data context/checkpoint/settlement                   | 現行request contextとrecall相関。起動構成はconfiguration_id参照に置換              |
| diagnostics           | diagnostic_id PK、execution_id FK、content_digest FK contents                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Data failure/capture                                       | diagnosis CLI/API、error理由。artifact全文の複製にしない                           |
| recall_relations      | source_execution_id FK、target_execution_id FK、record_id unique FK、PK(source_execution_id,target_execution_id)                                                                                                                                                                                                                                                                                                                                                                                                           | recallを実行へ適用したData admission                       | recall source/target、context/履歴                                                 |

indexはexecutions(session_correlation,turn_number,created_at,execution_id)、
executions(parent_execution_id,created_at)、semantic_records(execution_id,ordinal)、
semantic_relations(resolved,target_record_id)。既存PK/unique indexを通常readへ使う。
全会話走査を通常表示へ導入しない。

canonical settlementは一つのBEGIN IMMEDIATEでsessions.state_revisionのbase一致を確認し、
当該messages、session_turns、conversation_messages、checkpoint/next_turn/count/revision、 terminal
semantic recordとexecutionのcompleted/canonicalを一緒にcommitする。
non-canonicalは当該messages、terminal semantic record、outcome/settled_atだけをcommitし、
Session会話/revisionを変更しない。成功したdetached executionもnon-canonicalである。
detachedの基底revisionはexecution自身へ保持し、合成session_headsを作らない。

DataのreadWorker/allocateWorker/openExistingWorker/list/deleteはsessionsとconversation
projectionへ、
beginExecution/commitCanonicalTurn/settleNonCanonicalExecution/reconcileはexecution正本へ接続する。
listExecutionEvents/effects/request facts/context/recallはsemantic/context正本へ接続する。 artifact
exportはexecution/config/message/semantic/context/diagnosticから新しい単一形式を生成する。
旧artifact codecのschema 2〜7とplanner分岐は新DBのreadへ持ち込まない。 公開Session/execution
ID、command操作、task/controlの意味は維持し、payloadのDefinition refを agent choice/configuration
IDとsnapshotへ置換する。transportにfunctionやsource closureを載せない。

sessions/message counts、assistant_text_states、semantic relation解決状態、context
manifestは用途があるprojection。
他のexecution/config/model/build本文copyやderived_documentsのartifact cacheを残す理由にしない。
共有DBの現行write待機・初期化同期・Session/execution lock・interrupted
reconciliationを新pathへ適用する。
cascadeを含むSession削除は人間が指定した対象だけを既存操作で行い、起動時の旧data
cleanupは追加しない。

## 起動拒否、公開snapshotと回復

CoreのData/discovery/list/status/TUI接続はAgent構成前から利用可能。
SessionはDataが先に所有し、Agent起動結果を`configuration`欄へ反映する。

- snapshotの構成状態はpending/ready/rejected。選択名/元、configuration ID（readyのみ）、
  採用tool一覧と対象別rejection（target/name/file/field/reason）をdata-onlyで持つ。
- root rejectedでもruntimeはtask実行なしのidleとし、構成が使えない原因をruntime
  failureと区別して表示する。
- task受付時に構成を確定し、rejectedなら`configurationRejected`を理由として返す。 Data execution
  admission、provider request、canonical会話採用へ進めない。
- TUIのdraftはSurfaceの入力ownerに保持し、task acceptedを受けてからclearする。
  reject結果はfile/理由を表示し、入力を保持する。Session履歴の代替にdraftを保存しない。
- tool rejectはreadyの構成差分として表示し、有効toolでtask実行できる。
  instructionにも不足理由を含め、model declarationとRegistryから同じtoolを除く。
- runは同じ選択/factoryの結果を通常本文/stream/JSON出力方式で報告する。 root
  rejectは既存の非成功終了statusと理由、tool rejectは構成情報と通常task結果を返す。

修正後の新規Sessionは既存/new、保存Sessionの継続はCore再起動後openで新Workerを作る。
同一Coreで同一Sessionを再選択するだけのreload/retryは追加しない。
入力draftを保持して表示するため、拒否表示の案内から人間が修正して新Sessionを選ぶ。 既存worker
watchやS4/reloadを実装したことにしない。

## 切替・撤去の対応

| 新しい入口/正本                            | 切替/撤去対象                                                                                                | Slice                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Agent JSON resolverとWorker common factory | executable Agent Definition選択/evaluation、default/generic専用module、Definition manifest/resource selector | 1で部品実装、3でcaller切替、5で旧公開契約/unused source撤去 |
| 現在tool folder選択とWorker import         | managed tool store/import/transport、hash revision selector/binding、closure照合                             | 1で部品実装、3でcaller切替、5で管理操作と旧source撤去       |
| 新HistoryStoreとconfiguration/message正本  | v7 prototype/core re-export、execution_admissions、persistent session_heads、旧snapshot/artifact重複/codec   | 2でstore実装、3でData/Host切替、5で旧export/test撤去        |
| 構成状態snapshotと理由付きtask拒否         | serveの先行Definition解決、initial openSlotのCore終了、起動構成失敗をapp failure扱いする経路                 | 4                                                           |

途中の旧sourceを旧data対応の仕様にせず、切替時にproduction callerをまとめて新経路へ接続する。
構想・architecture・roadmapの変更案は181 §8のままで、このcontract文書をその変更承認と扱わない。
