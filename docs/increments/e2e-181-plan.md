# Increment 181 最終実provider E2E計画

更新日: 2026-10-04

ステータス:
**完了。E1〜E11の実操作・停止DB照合、採用したbuild保存P2の修正確認と指摘限定re-reviewを完了。**

[`increment-181.md`](increment-181.md)のSlice 6に対する最終受入の正本。
利用者の「インクリメントの最後に基本的な流れを網羅した実プロバイダによるe2eテスト」により、
以下のproduction経路と必要な実provider実行は承認済みである。
スライスsmokeの結果だけで最終受入を代替しない。

## 対象と実行環境

- 最終候補からbuildしたstandalone binaryを、repository
  checkoutと別途Denoに依存しない起動方法で使う。 build/source
  identityを記録する。常用配置版を上書きしない。
- provider/model/effortは既存accountの`openai-chatgpt / gpt-6.1-sol / medium`を基本とする。
  E3で同じmodelの選択可能な別effortを一つ使い、実行前に選択値を記録する。 model
  requestは通常のResponses production adapterから送り、parser/結果をfixtureへ置換しない。
- 隔離HOME/XDG/workspace、新DB、検証用Core/tmuxを使用する。現在fileの変更・不正化は検証用fileだけに行う。
  credential登録を必要な範囲で非公開複製し、credential値・Authorizationを表示・保存しない。
- 保存先は`.tools/e2e-181/<run-id>/`。操作helper、画面、公開snapshot/command/execution結果、
  semantic履歴、短いrequest fact、構成snapshot、停止後readback、集計を保持する。 raw
  request/responseとSSE断片を常設収集しない。

## 実施の前提と順序

Slice 1〜5の実装、focused確認、各独立reviewと採用findingの修正を終え、最終候補を作る。
defaultがauthoritative `v0:gate`を一回実行し、同じsourceからbinaryをbuildする。
tmux上のTUI、正式API、headless run CLIと新DBの停止後readbackを組み合わせて以下を実施する。
追加修正が必要な場合は、focused確認と変更箇所reviewを行い、影響するシナリオを再実行する。
gate再実行は候補変更や失敗原因の解消という具体的な理由を記録する。

## シナリオと成功条件

| ID  | 基本フロー                      | 操作から結果までと確認する動作                                                                                                                                                                                                                                                           | Execution見込み                           |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| E1  | defaultと基本五種               | 設定fileなしでTUIを起動。隔離fileをwrite/read/editし、bashで結果を確認。現行の短縮閾値を超えるstdoutを作りbash_outputで残りを読む。promptに埋めないfile/output markerを実tool結果と回答で照合。五種の提示contract・順序・結果を保存readback                                              | root 1                                    |
| E2  | genericとnamed子Agent           | 外部reviewer JSONを登録し、親taskからgenericとreviewerをspawn。起動時tools指定、status、collectを使って結果を親回答へ反映。親子で独立したWorker・構成snapshot・実際のmodel選択・親execution/spawn call相関を確認。child cancelはE9とfocused確認を補完して確認する                        | 親1＋子2                                  |
| E3  | model選択と実行中入力           | idle時に別effortへ選択し、task受付後のselectionを確認。実行中のF3 steeringとF2 Session follow-up予約を、操作案内とtool開始を観測して行う。steeringのsemantic採用、親完了後follow-up、idle、executionごとのselectionを確認。同じmodelの別effortを使う後続taskで起動snapshotとの区別を確認 | 親1＋follow-up1＋後続1                    |
| E4  | detach・再接続・保存Session再開 | 同じCoreへのTUI detach/reconnect、Core停止、同Sessionを新Coreでopen。保存会話とtitle/model選択を確認し、以前のtool結果を前提にした短い続きtaskを完了する。停止後history CLI/API/SQLite readbackでcanonical順序と構成参照を照合                                                           | 続き1                                     |
| E5  | JSON/tool編集と起動時適用       | 外部Agent JSONと小さい外部tool（local importを含む）を使う。実行後に版名を変えずinstruction/tool contractとmarkerを編集。起動済みWorkerの構成を維持した実行と、/newによる新Workerの実行を比較。旧executionの当時の内容を現在fileで上書きせず読める                                       | 変更前1＋旧Worker1＋新Worker1             |
| E6  | tool個別rejectと回復            | 選択中tool一つを検証用folderでimport/export不成立にする。初期SessionありでCore/TUIを起動し、file・理由と不足toolを表示。model宣言/registryの両方から対象が外れ、有効なread/bash等でtaskが完了。file修正後/newで新Workerを起動し、修正toolを使えることを確認                              | reject状態1＋回復後1                      |
| E7  | root JSON rejectと回復          | root外部JSONを不正にして初期Sessionありで起動。Core discovery/status、TUI接続、既存の新形式履歴を利用でき、原因が画面に表示される。入力taskを理由付きで拒否し、拒否時draftを保持、provider requestは0。file修正後/newで構成し直し、短いtaskを完了                                        | 拒否時0＋回復後1                          |
| E8  | 本文cancel                      | 長い回答を依頼し、実assistant本文の開始を観測してEscape。cancelled/non-canonicalと部分本文保存、清算後idleを確認。cancelしたtask/途中出力をcanonical会話へ採用しない                                                                                                                     | root 1                                    |
| E9  | processとchildのcancel          | parentのbashで開始markerを作り待機させ、実tool開始を観測してcancel。検証fileの完了marker未生成、process清算、非canonical保存を確認。childについては既存cancel操作を実行し、child Worker/process清算と親のstatus/collect結果を確認                                                        | parent tool task1＋child制御taskの親1/子1 |
| E10 | run CLIと構造化結果             | stdinの通常本文、--stream、--jsonをそれぞれproduction CLI Worker/headless Hostで実行。新Agent指定とtool構成、最終本文/curated output/終了status、execution保存を照合。既存のsubmit_json_resultによる構造化最終結果も対応するtaskで確認                                                   | CLI 3                                     |
| E11 | failed executionとエラー履歴    | 既存max-steps指定を使い、1 stepのtool taskが継続requestを必要とする実経路でbudget終了を確認。failed/non-canonical、tool call/result、理由と診断、後続正常taskに失敗会話が混入しないことを確認。provider障害を誘発する確認ではない                                                        | failed task1                              |

実executionはE1〜E11で概ね22件、model requestはtool loop・親子実行を含め40回前後を見込む。
これは費用/操作規模を説明する見込みで、request上限・test件数の目標・成功判定ではない。 実際のtool
callのまとめ方、steering、cancel、compactionにより増減するため、短いrequest
factから実回数を報告する。
E2/E9のchild操作は必要な状態を観測して行い、完了済みchildへのcancelを成功確認にしない。 E11で実tool
callが起きなかった場合はfailed経路の実証にならない。結果を保持し、prompt/操作を見直して必要な再確認を行う。

context/recall・診断・Session一覧/削除・exportは、上記で作った新形式データを使うreadbackと操作確認にも含める。
recallの適用はcancel/failed記録を選んで準備し、後続の予定済み正常taskに相関する方法を具体手順に記す。
native
instruction/skillの発見・合成は隔離workspaceで有効なresourceを配置し、/contextと保存内容で確認する。
skill本文の実取得を要する場合は、予定済みtaskに組み込み、提示toolと取得結果をsemantic履歴から確認する。
削除操作は受入で作った検証用Sessionだけを対象とし、必要なreadbackの記録を完了してから行う。

## 証拠の読み方と結果記録

公開APIの受付/command結果、tmux画面の表示/操作、modelへ渡したcontract、実tool引数/結果、
assistant本文、runtime outcomeとcanonical採用、停止DBの内容をexecution IDで照合する。
promptの文字列一致だけでtool実行や回答成功と判定しない。
構成snapshot、版名、実effort/buildと親子関係を読み戻し、現在fileへの参照だけを当時の構成記録にしない。

各シナリオに、操作、観測、結果、実request数、HTTP/error、証拠path、未確認事項を記録する。
実行前にhelperのAPI呼出・capture/readbackをproviderなしで確認し、helper不具合の修正だけで成功済み推論を繰り返さない。
新しいproduct bugは原因・source・影響・修正案を報告し、181の採用範囲に入る修正かdefaultが判断する。
範囲外のbugを黙って修正しない。

最終reviewはシナリオと実行証拠、各sliceの指摘対応、最終候補との差分を確認する。
未確認のproduct動作をfixture追加だけで閉じず、実経路で目的が成立した結果を完了判断へ渡す。

## 実行結果

2026-10-04にcompiled binaryの隔離production経路で実施した。受入シナリオの23 execution・53 physical
requestに加え、helper修正と既存制約の観測で4 execution・8 requestを記録し、合計27 execution・61
request。全executionがsettled。HTTP
response_startは200が60件、残り一requestはcancelでheader受信前に終了。provider_request_failureとparser
failureは観測しなかった。request数は保存した短いrequest factから集計した。

| ID  | 受入execution / request      | 実観測と結果                                                                                                                                                          |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 1 / 8                        | 五種とskillを実順序で使用。write/read/editの結果AFTER、bash stdout 70,076 byteの短縮、bash_outputで非prompt tailを取得。native AGENTS/skillとhidden値を回答で確認     |
| E2  | 親1＋子2 / 11                | generic/reviewerそれぞれ実readを行い、親が子の値とnamed roleを回答。親子UUID・spawn相関・modelを停止DB照合。genericのnative helper二種は既存filter contractどおり保持 |
| E3  | 3 / 5                        | 同じWorkerの後続executionでmediumからlowへ選択変更。F3 steeringとF2次taskを採用。予定した後続taskのbash開始を観測してactive中detach/reconnectし完了                   |
| E4  | 1 / 1                        | title/modelを保存してCore再起動・同SIDを再開。promptに含めないE2の既読値をtoolなしで回答                                                                              |
| E5  | 3 / 6                        | 外部JSON/tool/local importを同じrevision名のまま編集。旧Worker二実行は旧role/tool、新Workerは新role/tool。構成UUIDと当時contractを停止後確認                          |
| E6  | 2 / 4                        | import不能のmarkerを宣言/dispatchから除外、理由/fileを表示。readは完了。修正して/new後は実marker toolと回答が一致                                                     |
| E7  | 拒否0＋回復1 / 1             | exact rejection noticeとAPI rejected状態を観測。draft保持、DB execution delta[]。修正後/newで新role指示を使うtaskが完了                                               |
| E8  | 1 / 1                        | streamed本文を観測してEscape。部分本文保存、cancelled/noncanonical、committed turn不変、idleを確認                                                                    |
| E9  | 親process1＋制御親1＋子1 / 8 | 親bashの開始file後cancel、完了fileなし。明示modelのgeneric子も開始file後status/cancel/collect、cancelled/noncanonicalと清算durability yesを確認                       |
| E10 | CLI 3 / 6                    | stdin text、--stream、--jsonは全てexit0、外部cli-runner/markerの実結果を返す。JSONは実submit_json_resultとterminal result。各detached executionを新DBからreadback     |
| E11 | failed1＋回復1 / 2           | maxSteps1で実bash結果後step_limit failed/noncanonical。Core再開後にfailed記録をrecall準備、正常taskへliteral projectionを適用。canonicalへの失敗会話混入なし          |

Session/history/context/diagnosticsのAPIとcompiled CLIをreadbackし、71 CLI
readbackがexit0。削除は検証用空Sessionをtitle保存で永続化し、別saved Sessionへ移動後に実施。accepted
receipt、Session一覧とSQLiteから対象SIDが消え、27 executionは不変と確認した。追加provider
requestは0。

binaryとworkspace/HOME/XDGはcheckout外の`/tmp/henji-181-*`に置き、PATHは`/usr/bin:/bin`。
version/SHA一致のコピーを使用し、常用配置版を上書きしなかった。元credential
fileのhash一致はtrue。Core/tmuxを停止し、非公開credential複製を終了時に除去した。元の27
executionは当時の内容を保つ。

証拠は`.tools/e2e-181/2026-10-04/`の`results.json`、`readback.json`、`verification.json`、
execution別semantic/events/artifact、Session export NDJSON、history/API/CLI/tmux画面。
`verification.json`はpassed=true・errors=[]。raw request/responseやSSE断片は取得していない。

helperと範囲外の観測は次のとおり。

- queued
  follow-upはpending.followUpにあり、started後のfollowUpsだけを見た初回helperがtimeout。保存受付IDを再利用し完了済み推論は繰り返さず、予定した後続taskでactive
  detachを補完した。
- E7初回helperはdraft中のconfigurationという単語をrejectionと誤認し、ACK前にfileを修正。task一実行/一requestが正常に通過した。当該履歴を保持し、exact
  noticeとAPI rejectedを待つ手順で拒否0 requestを実証した。
- E9初回のmodel省略childは既存の登録ID継承不具合でmissing_credential・0 request・process未開始。親1
  execution/6
  requestと子failed記録を保持し、明示modelで実cancelを再確認した。この既存経路は[通常利用メモB10](../experience/normal-use-inbox.md#b10--model省略のchatgpt子agentへ認証登録idが渡らない)へ未採用候補として記録した。
- E9再開で完了済み親cancelのEscapeを再送し、次の親1 execution/1
  requestがcancelされた。再開時は完了済みcontrol blockを省略し、その記録も保持した。
- CLI子起動のspecPath参照と、保存前の空Session history/active Session削除はhelperを修正しprovider
  request追加なしで実証した。

最終reviewは、当時のbinary/Core実buildIdに対して全execution.buildがdevelopment値となる既知B9を、181の実build保存要件に対するP2として採用した。Host→Data
Worker
initializeで実manifestを渡して生成前にinstallする修正を実施し、最後の候補でcompiled/providerなしのadmission/readbackを行う。成功済み27
executionは変更しない。

実build保存修正後の候補は`c7dff2e7d091742374c66696c2de6f64b04dbda77a808505eec0d59e8b1bb588`。compiled
stdin CLIとAPI Coreでcredentialなしのproduction taskをadmitし、model
request前の失敗二件を新しい隔離DBへ保存した。versionと両execution/derived
artifactのbuildが一致し、sourceRevisionはdevelopmentではない。追加physical requestは0。証拠は同run
folderの`build-fix/results.json`・`readback.json`とexecution別artifact、`build-fix-check.py`/`build-fix-readback.py`。初回argv誤りはCLI
admissionなし＋API一件で、二回目stdin経路の実行後は診断名の期待だけを直し既存DBのreadbackを再利用した。source差分はData
initializeのmanifest伝達だけであり、既に成功したprovider推論を再実行しなかった。

最終reviewの指摘限定再確認で、実build保存P2は解消済み、実Session削除も成立、新しいBlocker/P1なし、local完了可と判定された。全シナリオの受入と変更箇所の最終候補確認を完了した。
