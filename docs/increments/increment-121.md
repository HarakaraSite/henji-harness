# Increment 121 — 通常実行の診断記録を短い手掛かりへ縮小

状態: 実装・検証完了。利用者は製品内の常設raw記録を廃止し、必要時はprobeで取得する方針を選んだ。既存v9 DBの削除とv10での再作成、およびAGENTS.md・構想・architecture・roadmap正本の意味上の変更を個別に承認した。保存期間は別課題であり、本incrementでは決めない。

## 必要なproduct動作と根拠

- 通常実行では、MiMoのような失敗から再現probeの対象を決められる短い手掛かりを残す。一方でDeepSeekのようなtool反復は、通常履歴だけで人間が順番と操作内容を判断できるようにする。
- session `b489d0e9`のキャンセル実行では約3万件、別実行では約4.5万件の診断記録が生じた。経過時間表示の停止との因果と改善量は未計測である。行数だけでなく、保存bytes、Worker内の複製・転送、起動／読出しの仕事を対象にする。
- 現行production既定は`diagnostic-v1`であり、request、raw response、SSE、parser transition等を保存する。`normal-v1`へ既定を変えるだけでは、Worker側の収集・snapshot・送信が残る。

## 残す情報と経路

- requestの短い手掛かり: provider、モデル、API経路、論理model stepと物理requestの対応、物理request順番、HTTP statusまたはエラー、失敗stage・理由。parserで値を検査して失敗した場合は、項目path、期待形、実際の値の型／形を残す。構文不正やtransport failureに存在しないpathを作らない。
- toolの順番、名前、引数、結果は通常のsemantic履歴を正本とし、同じ列を診断attachmentへ重複保存しない。短い人間向け概要は保存済み引数から作り、先頭行が同じ複数のbash callを識別できるようにする。
- キャンセル・失敗で観測済みの途中経過も、確定した範囲として保存する。request完了時だけ一行書く方式で、途中の情報を全て失わないようにする。

## 実装計画

1. admissionからWorker／provider adapterまでcapture modeを渡し、通常実行ではraw bytes、SSE frame、parser transitionの全文収集・複製・IPC転送・attachment保存を行わない。現行の`normal-v1`指定だけで済ませない。
2. provider observation／evidence recorderに依存するsemanticなmodel result、assistant event、tool call／result、request metadataを一つのdurable経路で維持する。通常履歴と`/recall`がraw attachmentを前提としていないことを確認する。
3. 失敗の検査箇所から短い診断factを生成し、request単位で読めるようにする。exact request、response byte event、SSE event、provider evidence documentの重複writer／readerを整理する。使われなくなる保存先と処理も対象に含める。
4. 製品内の常設raw capture、`diagnostic-v1`選択、exact request／response byte／SSE frame／parser transitionの収集・IPC・attachment／document writerと専用readerを廃止する。必要時のraw取得は別probeで行い、通常実行で未取得の過去rawは後から復元できないことを明示する。保存期間の一律ルールはこのincrementで推測して追加しない。

## 実装前に確認した具体的な経路

- production TUIは`historyCaptureProfileFor`で`diagnostic-v1`を既定にする。一方、Workerはprofileを受け取らず、`ProviderEvidenceRecorder`を常に生成する。`normal-v1`へ変更するだけでは、Workerのraw／SSE／parser記録、response byteの複製、`provider_observation`のIPC、完了時の全文snapshotが残る。
- Workerのevidence recorderはraw診断とsemanticなassistant／tool／model結果の配送を兼ねる。単純にrecorderを消すと、Hostが保存する意味上の出来事も欠けるため、短いrequest factとsemantic eventの配送を残したままraw経路を外す。
- `provider_request_start`は現在もsemantic occurrenceになるが、`response_start`とparser失敗の詳細はそのままでは通常履歴の正本にならない。物理requestごとの開始、HTTPまたはtransport結果、失敗stage・理由・検査項目と値の形を短く記録する。cancel／Worker異常終了では、最後に確定保存されたrequest factまでを保持する。
- `providerExactRequest`はrequest bodyを、OpenAI Responsesの`EvidenceSseTap`とChatのSSE framerはraw frameを扱う。これらを外してもprovider本来のstream解析とmodelへのreasoning再送を維持する必要がある。`/recall`が現在evidence documentから作るrequest概要は、semanticなrequest factから組み立て直す。

## 製品正本へ提案する意味上の変更

- repository `AGENTS.md`のraw request／response／SSE等を常時保存する規則を、通常実行ではprovider・model・API・論理step／物理request番号・HTTP／error・検査失敗のpathと値の形など短いfactを保存し、rawは必要時の別probeで取得する規則へ置き換える。credentialとAuthorizationを記録しない規則は維持する。
- 構想 `docs/concepts/experience-driven-self-revision.md`の「選択した診断captureでraw等を保存・readback可能」を、通常履歴のsemantic記録と短いrequest factを使って人間が次の調査を判断し、必要時は別probeでrawを取得する記述へ変える。
- architecture `docs/architecture/henji-host-agent-worker.md`の診断attachment層、capture profile／coverage、production既定`diagnostic-v1`、exact request／response／SSE／parser transitionの保存・readback契約を廃止する。request factをsemantic authorityに置き、root／async child、失敗／cancelの観測済みprefix、`/recall`をその記録から支える。人間向け`history --view detail`は残るsemantic記録を出す。
- roadmap `docs/roadmap.md`のF02・F04・F05の現状と受入記述を、raw evidenceとdiagnostic drill-downを前提にしない短いrequest fact・semantic historyへ更新する。保存期間や自動削除の規則は追加しない。

上記の構想・architecture・roadmapの編集は個別の明示承認を得て反映した。既存v9 DBは対象workspaceのpathとschema versionを確認し、隔離環境でv10を検証した後に削除・再作成した。

## 受入確認

- 通常実行でraw event／attachment／全文snapshot／全文IPCが生成されず、semanticなtool履歴と短い失敗factを読めることを確認する。長いstreamでも診断保存件数・bytes・処理時間がSSE断片数に比例して増えないことを測る。
- MiMo型のparser失敗を使い、provider／モデル／requestの特定とfield path・値の形から、次のprobeを設計できることを確認する。DeepSeekの異なるbash引数は通常履歴上で区別できることを確認する。
- cancel／Worker異常終了時の観測済みfactと、root／async childの通常記録を確認する。実provider callは対象・回数・保存先を提示して別承認を得る。

## 第三者計画reviewと承認境界

- 診断専門reviewは、保存profileだけの変更ではWorker内のraw処理が続き、recorderの単純削除ではtool等のsemantic eventも失う、と指摘した。上の実装計画へ反映した。
- 利用者は第三者reviewの「明示選択する一時raw記録」ではなく、製品内の常設raw記録を廃止し、必要時は別probeで取得する案を選んだ。正本変更も個別に明示承認し、反映した。
- 利用者は既存v9 DBを削除し、新schemaの空DBに作り直す方針を明示承認した。対象workspaceの`history-v7.sqlite3`とそのWAL／SHMのみを削除し、v10・Session 0件・`diagnostic_attachments`表なしを確認した。

## 実装結果と確認

- Chat、Responses、補助requestから、raw request／response、SSE断片、通常時のparser全文収集を外した。Worker内のrecorderは通常実行で現在のrequestだけを保持し、短いrequest factと意味上のassistant／tool eventをHostへ送る。全文snapshot、evidence document、診断attachmentのIPC・writer・reader、capture profile選択を廃止した。
- SQLite schemaをv10へ切り替えた。対象workspaceの旧v9 DBとWAL／SHMを承認どおり削除し、空のv10 DBを作成した。`PRAGMA user_version=10`、Session 0件、`diagnostic_attachments`表なしを確認した。旧Sessionと旧診断記録は復元しない。
- 失敗時はprovider／model／API／request順番／HTTPまたはerrorを短いfactとして残す。解析失敗の検査箇所が分かる場合はfield path、期待形、実際の値の形を記録する。toolの完全な引数と結果は通常semantic履歴に残し、診断へ重複保存しない。bashの短い表示は改行を一行に畳み、長いまたは複数行のcommandをfingerprintで区別する。
- 4,100 SSE event、1 MiB超の模擬streamで、provider観測はrequest startとHTTP statusの2件、直列化後2 KiB未満だった。MiMo型の不正なtool引数では`response.choices[0].message.tool_calls[0].function.arguments`、期待`JSON string`、実際`number`と短い失敗factを確認した。Worker→Host→SQLiteの保存・request単位readback、キャンセル時の観測済みprefix、async childの結果、`/recall`の短いfactもfocused testで確認した。保存時間の改善量は測定していない。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`成功。provider stream、Worker基盤、history v7、recall、web search、multi-provider、child、cancel/liveness、stage probe、thinking/history、CLI E2E等の対象testが成功。full `v0:gate`は実行していない。
- 隔離XDGとtmuxで変更後のproduction TUIを起動し、localhost模擬Chat providerのtool call→bash実行→回答を確認した。画面と`henji history --view session`の両方に`bash printf TUI121_A printf TUI121_B #9a3eb93c`と回答`TUI121_DONE`が表示された。実provider callは行っていない。
- 利用者の追加許可後、隔離XDG・tmuxのproduction TUIからOpenCode Go Chatへ実provider callを行った。`glm-5.3-flash`のREADME冒頭read→回答は2物理request、`mimo-v2.6-pro`の一語回答は1 request、同モデルの別SessionでのREADME冒頭read→回答は2 request、合計5 request。TUIと`henji history --view session`でthinking、readの順番・範囲、回答を確認した。各requestの短いfactをSQLiteから読み戻し、provider／model／APIとHTTP 200を確認した。旧`diagnostic_attachments`表は生成されなかった。MiMoの以前の`provider response invalid`は、この限定した入力では再現しなかったため、その失敗経路の実provider確認は未達。隔離DBとcredentialの一時copyは確認後に削除した。
- 第三者コード・test reviewは、SSE解析失敗で`delta.content: 42`を`delta=object`と誤記録し、`tool_calls[0].function.arguments: 9`のfield／値の形を失うP2を報告した。拒否した検査箇所で短いfield・期待形・実際の形をerror factに付け、parser observationへ渡すよう修正した。対象のSSE入力を使うfocused testを追加し、provider stream 17件、Chat provider headers 17件、`v0:check`、`v0:lint`、format、`git diff --check`の成功を確認した。実providerではこの異常応答を観測していない。
- P2修正後、隔離XDG・tmuxのproduction TUIへlocalhost模擬Chat providerから`delta.content: 42`を送った。TUIは`provider response invalid`で失敗し、SQLiteの同一requestにはstart／HTTP 200／parser failure／request failureの4件を記録した。parser factの読戻しは`field=choices[0].delta.content`、`expectedShape=string or null`、`actualShape=number`、`reason=unsupported_delta_shape`だった。実provider callは行っていない。
- 同じ第三者reviewerによる変更箇所限定の再reviewで、上記P2は解消と判定された。追加focused testが二つの再現入力のerrorとparser factを確認していることも確認された。
- 後続の実利用確認では、OpenCode Go Chat `glm-5.3-flash`のREADME冒頭read指示が2回ともHTTP 200後に`incomplete_tool_call`で失敗し、`mimo-v2.6-pro`は同じ指示を完了した。利用者許可の別probeでGLMの生SSEを取得すると、最初のtool断片には`type: "function"`があり、後続断片には`type: null`があった。SSE parserは`id`／`name`のnullを無視する一方、`type`のnullを拒否していた。`type`／`function`／`arguments`のnullも後続断片では値の更新なしとして扱い、最終tool callの必須項目とJSON引数の検査は維持した。取得した生SSEの再生、provider stream focused test 18件、type check、format、lint、`git diff --check`が成功。再buildしたproduction TUIを隔離XDG・tmuxで実provider確認し、同じGLM指示がread→回答まで2物理requestで完了した。隔離DBは完了execution 1件、request failure 0件、tool call／result各1件、checkpoint後348,160 bytesだった。probeと実利用確認のcredential copyは削除した。
- 利用者の方針に合わせ、診断用の別probeを`scripts/probe_provider_response.py`としてrepositoryへ置いた。固定model catalogを持つ宣言providerのChat Completions／Responsesを対象に、隔離XDGのproduction TUIから送信した本文とproviderの応答本文をlocal proxy経由で物理requestごとにファイルへ保存する。認証headerは保存せず、credential copyは終了時に削除する。proxyは応答を一度bufferするため、stream配信のtiming自体は再現しない。localhost模擬ChatとResponsesの両経路で、TUI回答、送受信本文、metadata、credential copy削除を確認した。実provider callは追加していない。
- 多様なproviderの応答を受け入れるため、Chat tool callで`type`が欠けても`function`の名前・JSON引数とcall IDが揃えば実行し、tool-call indexが0から連番であることも要求しない。明示された未対応typeや、実行・tool resultとの対応に必要なID／名前／JSON引数の欠落は引き続き失敗とする。JSON応答も`type`省略を受け入れる。focused provider stream test 20件、type check、format、lint、`git diff --check`が成功した。未観測の他のSSE shapeまで許容する変更は行っていない。
