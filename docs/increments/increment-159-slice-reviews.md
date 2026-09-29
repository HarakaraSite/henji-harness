# Increment 159 — Sliceごとのコード・testレビュー

# Increment 159 Slice 1 コード・test通常レビュー

完了: 2026-09-29 11:42 UTC。開始11:39
UTC、30分上限内。read-onlyで固定diffと必要な周辺source、test、実測証拠を照合した。build・test・provider
call・tmux・full gateは実行していない。

**Blocking 0件 / P1 0件 / P2 0件。対応が必要な問題は認めなかった。Slice
2へ進む妨げはない。採否と最終検証はrootへ委ねる。**

対象は `slice.diff` と `source-files.json` のSlice 1変更。26項目のsource
hashを照合し、削除済みのfile_reference.tsを含め全件一致した。採用要件は
`docs/increments/increment-159.md` のキー・コマンド振分けと廃止経路。後続sliceの本格slash
picker、最終footer、本文通知保持・色は今回の完了判定に含めていない。

確認結果:

- `v0/tui/input_decoder.ts:96`・`:322` のSS3/CSIによるF1〜F3 decode、廃止Ctrl/Alt
  aliasの消費、Backspace 0x08/0x7fとCtrl-Uの受信を確認。既存の改行eventを維持している。
- `v0/tui/remote_session.ts:1955` 以降で全体detach/quit、catalog・Session・help
  overlayが通常入力に先行する。picker内Ctrl-C closeは除去され、Esc
  closeは通常の取消へ流れない。masked Ctrl-Uは `remote_catalog_ui.ts:680` の全消去を維持している。
- `remote_session.ts:2036` 以降はslashを先に扱い、active
  execution中の通常Enterは送信せず、F2/F3を明示的なfollow-up/steeringへ渡す。Alt-Enterは`:640`
  の改行へ進む。readyのF2/F3をtask送信へ転用していない。
- `remote_session.ts:1194` の既存submitDraftは、active
  Session・operations・対象execution・receipt照会・draft保持を維持している。TaskServiceの実行・追加指示枠・予約開始条件に変更はない。
- `/quit`の定義・補完・実行・TUI/CLI案内が揃い、HTTP Core shutdown
  APIは維持される。path補完はclient/contract/codec/HTTP/Core/indexを含め撤去され、v0
  productionに廃止API・index・専用editor methodの参照は残っていない。
- test差分はF1一覧・F2予約receiptと新draft保持・F3追加指示・masked認証・通常Tabでpath
  APIを呼ばないこと・path endpoint廃止・/quitとCore
  drainを扱う。廃止機能専用testの削除と新bindingsへの変更は要件に沿っている。

実測との照合: `real-147212/results.json`、ready F2／busy
Enter／Alt-Enterの画面、`completed.json`、`first-execution.json`を確認した。改行入りS159_STEERが最初のexecutionへ反映され、S159_QUEUEは予約された別executionで完了し、物理requestは2＋1回。/quitのowned
Core/TUI終了はresults.jsonのexit 0記録による。rootのHTTP focused logは1件pass。その他のfocused
66件・check/fmt/lint・diff
checkはchecks.mdの実装者/root報告を参照し、reviewerによる再実行結果とは扱っていない。

確認限界:
GhosttyクライアントからのF1〜F3物理キー入力は未確認。今回の実経路証拠はtmux送信キーによるもの。最終footer・help一覧・本文通知の実測は後続sliceの範囲として残る。

# Increment 159 Slice 2 コード・test通常レビュー

完了: 2026-09-29 11:59 UTC。開始11:56 UTC、30分上限内。固定slice.diff、source
identity、必要な周辺source・testとrootの実測証拠を独立に照合した。build・provider・tmux・full
gateは実行していない。

**Blocking 0件 / P1 1件 / P2 1件。以下の要件差を修正してからSlice
3へ進むことを推奨する。採否と最終検証はrootに委ねる。**

## P1 — 前のdraftの抑止が残り、最初のEnterでコマンドを実行する

位置:
`v0/tui/remote_session.ts:998`（text一致による抑止）、`:1770`（補完時の抑止代入）、`:2075`（draft
clear）。

根拠: Increment
159は、補完・Esc終了「直後に、同じ入力のままで」再表示しないことと、コマンド名を編集した時の候補再表示、選択Enterではコマンド実行を重ねないことを定める。

現実の経路:
`/quit`をpickerで補完して閉じると、slashPickerSuppressedTextは`/quit`になる。その後Ctrl-Cでdraftを空にしても抑止値は解除されない。新しいdraftで`/quit`を入力すると、途中はpickerが開くが、全文が旧抑止値に一致した時点でrenderEditorのelse枝がpickerを閉じる。続く最初のEnterは通常入力のrunSlashCommandへ進み、Core
shutdownを実行する。補完した名前を一文字消して戻す場合も同じ挙動になる。

影響:
利用者が新しい入力・再編集で候補を選ぼうとしたEnterが実行へ変わる。`/quit`では、予定より一段階早く稼働Coreを止める。これは確認testの不足だけではなく、入力と実行を分けるproduct動作の破綻である。

最小修正方向: 抑止を現在のdraft状態に限定し、実際の名前編集やdraft
clearで旧抑止を解除する。補完・Esc終了後の未編集draftへの再renderでは抑止を維持する。新しいdraftで同じコマンドを入力した場合と、名前を編集して元に戻した場合に、最初のEnterが補完だけになることを確認する。

## P2 — 引数を残したコマンド名編集では候補が再表示されない

位置: `v0/tui/slash_command.ts:121`、caller `v0/tui/remote_session.ts:995`。

根拠:
採用要件は「slashのコマンド名を編集した時は再び候補を扱う。引数入力中はコマンド名選択を割り込ませない」。Slice
2も入力先頭のslash tokenを絞込みに使うと定める。

現実の経路:
`/rename Title`を準備してHome/←でコマンド名へ戻り、名前を編集する。候補関数はdraft全体に空白があるとundefinedを返し、cursor位置を受け取らないため、名前部分を編集してもpickerが開かない。補完直後の`/rename`でも同様。

影響:
引数を保持してコマンド名を選び直す操作で、候補・説明・usageを利用できない。引数を一旦消さないと名前再編集の要件が成立しない。

最小修正方向: 先頭slash
tokenとcursor位置から名前編集と引数入力を区別し、名前編集時だけ候補を再表示する。候補補完は名前tokenを置換し、既存引数を保つ。引数付きdraftでの名前編集→選択補完→次Enter実行を確認する。

## 確認済み範囲と証拠

- 固定10項目のsource hashは全一致。diff SHA256はpacket指定の
  `7250241240c993995dc90cb22650e50a4f36a0d1e53d43fb5d6020d05909db11` と一致。
- 14コマンドの説明・usage・直接キーはSLASH_COMMANDSをpicker/helpで共有し、shortcut-only全項目と「対応なし」をhelpへ渡す。
- 通常の先頭slash→filter→↑/↓→Enter/Tab補完→引数→次Enter実行、Escのdraft保持、overlay内Escが取消へ流れないことはコードと新しいremote
  testに対応する。既存catalog・masked・Session
  pickerより通常入力を優先しない。Ctrl-D/Qはoverlay処理より前に維持される。
- helpの12/32行切捨てを外し、固定headerとページoffsetで全項目に到達する。retained testは全command
  usageとshortcut-only項目を巡回表示し、実測help-page-2.txtは最後のmasked
  Ctrl-Uまでを含む。40×23の実測は選択`/quit`とusage/キーが可視。
- 実測results/completedはpicker後の通常taskがS159_PICKERを回答し、1物理request、completedを示す。focused-final.logはshutdown2＋retained26
  pass。その他のfocused/type check/fmt/lint/diff
  checkはpacketのroot報告であり、reviewerによる再実行ではない。

確認限界:
引数付きコマンド名編集と、旧抑止値に戻る操作は今回の実測証拠に含まれていない。上記findingは固定sourceの決定的な分岐に基づく静的確認。Ghostty物理入力、最終footer・system通知は今回の再評価対象ではない。

root採用判断:
P1/P2双方とも明示要件と利用者影響が成立するため採用。修正・focused/production確認済み、限定re-review中。

# Increment 159 Slice 2 限定re-review

完了: 2026-09-29 12:07 UTC。開始12:06
UTC、15分以内・一回の限定再確認。対象は採用P1/P2に対応するfix.diffの3
filesと、解消確認のtest・root実測のみ。sourceは変更せず、build/provider/tmux/full
gateは実行していない。

**P1・P2とも解消。残るBlocking/P1/P2は0件。今回の修正範囲にSlice
3へ進む妨げはない。採否と最終検証はrootへ委ねる。**

- P1「draftを跨いだ補完抑止」: `remote_session.ts:995`
  は、現在textが抑止textから変わった時点で抑止を解除する。Ctrl-C clear→同じ名前のfresh
  draftと、名前を削除→元の値に戻す編集では旧抑止が復活しない。補完・Esc終了後に同じdraftを再renderする場合は抑止を維持するため、元の再表示抑止要件も保つ。追加testは両/quit経路について最初のEnter後のshutdown
  countが0であることを確認する。
- P2「引数保持の名前編集」: `slash_command.ts:122` は先頭slash
  tokenを取り、cursorがtoken内の場合だけ候補を返す。callerはeditor.cursorScalarを渡す。`remote_session.ts:1769`
  以降の補完は名前tokenだけを置き換え、残りのargumentsTextを保持する。追加testは`/renam Kept title`で候補を再表示し、補完時にはrename未実行、次Enterのtitleが`Kept title`であることを確認する。引数位置では候補を割り込ませない。

固定source/とworkspaceの3項目hashはsource-files.jsonに全一致。fix.diff SHA256はpacket指定の
`fcea765c7c1f040d04006792e62ec06e815803613f8ca4bc07909c0f7948f950` と一致。

証拠: `slice-2-focused-fix.log`はremote Session 5 tests
pass。`slice-2/real-153617/results.json`はfresh /quitと削除→復元名の補完のみ、引数保持、provider
request 0、exit
0を記録する。fix-fresh-quit.txt、fix-arguments-picker.txt、fix-arguments-complete.txtも修正後の候補表示・保持されたdraftと一致する。これらはrootの実行結果を照合したもので、reviewerによる再実行ではない。

確認限界: 先行Slice
1やhelp/幅表示など、今回変更していない範囲は再走査していない。Ghostty物理入力の未確認と後続sliceの対象範囲は前回のまま。この限定確認で新しいBlocking/P1は認めなかった。

root確認: 両finding解消を採用。Slice 3へ進む。

## Slice 3 通常review

# Increment 159 Slice 3 通常コード・test review

結論: **Blocker 0 / P1 0 / P2 1**。Slice
3の実行結果・操作通知の主要経路は要件と実測が対応している。別executionで同じ追加指示を再送した際の受付表示欠落を修正してから、Slice
4へ進む判断を依頼元へ返す。

## P2 — 別executionの同文steerを現在の受付表示と取り違える

位置: `v0/tui/system_notices.ts:98–106`（固定source）。

根拠:
`docs/increments/increment-159.md`「本文の運用メッセージと保持」は追加指示の受付を本文で示し、同じcommand／execution／予約の更新を一箇所に保つと定める。Slice
3もcommand・execution・予約のidentityを使う。既存TaskServiceは1 executionにつき1
steerを受け付け、semanticへ反映されるまで、そのexecutionId・commandId・textをpending.steeringへ残す。

事実: この二つの条件は、Sessionの全semantic
entriesから`label === 'steer>'`かつ同じtextだけを探している。notice側に保存済みのexecutionIdも、pending.steering.executionIdも照合しない。

発生経路・影響: 同じSessionのexecution Aで「Keep reply
short」を追加指示として反映し、その後execution
BのBash等の実行中に同じ文をF3で受け付ける。Bの追加指示がまだsemanticへ反映されていない時点でも、Aのsteer本文が条件に一致するため、Bの`Additional instruction received`通知を作らない。既に作られた通知も同じ条件で削除できる。正常受付の独立footer通知は今回省かれ、acceptedでdraftは処理されるため、Bの入力が受け付けられたことを現在の本文で確認できない。入力自体のCore受付は失われないのでP2と判断する。

改善方向: 対象executionに属するsemantic
steerとの一致だけで受付通知を除く。APIのmessage.executionId等の対応情報をprojectionへ渡すか、snapshot側のsemantic
message identityで対応を判定する。既存1
execution内の受付→semantic反映の二重表示抑止を維持する。現在の新focused testは1
execution・1文の対応だけを確認しているため、修正確認では別executionに同文steerが存在する状態から、現在のpending受付が残り、現在executionのsemantic反映後にのみ除かれることを照合するとよい。これはtest件数の不足ではなく、上記表示欠落のcorrectness問題である。

## 確認した範囲

- 固定20項目のdiff/sourceを確認。source-files.jsonの全hash一致、slice.diff SHA256
  `7f580499ddcce4bbc79a9105a9562481822754b48c9e40e9fb05fb954a37a235`一致。
- 保存済みoutcomeJsonから共通ExecutionViewへstopReasonとdiagnostic code/stageを渡すAPI
  projection・contract・codec、snapshot/execution.read一致のfocused
  assertions。DB、Loop、raw保存を増やしていない。
- SessionごとのTUI通知memory、command/execution/queue
  identityによるupsert、元anchor保持、反復snapshot・typing・Session切替での保持。queueのRESERVED→STARTED／NOT
  STARTED更新、非completed結果の短い理由表示。
- normal system>のneutral表示、失敗label＋failureWord prefixだけの赤色。既存本文presentation
  testを今回の明示要件へ変更していること。
- task／steering／follow-upの拒否・確認不能時の対象入力、draft保持、理由・次の確認。cancel要求結果とexecution取消結果の区別。Session・catalog・selection・credential・recall・context・shutdownの操作結果が開始時Sessionへ帰属する経路。credential値を通知へ出さず、保存を認証成功と呼ばないこと。
- picker
  loading/savingの一時表示、接続断の一度の通知。正常task受付、正常completed、改名・model成功の独立本文通知を省いていること。
- 指定focusedログとproduction証拠をread-onlyで照合。APIの初回stage推測による失敗は実測httpに合わせた最終focusedで解消。本文色の旧assertion失敗は明示要件に合わせた対象1
  testの再確認で解消。77
  focused確認の内訳はpacket・依頼元報告に基づく（他remote17の個別実行ログはpacketに位置未記載）。reviewerによるtest実行はしていない。

production `slice-3/real-160815`のresultsと画面証拠では、localhost503のFAILED／provider request
failed、idle
F3拒否時の入力・draft保持、typing後の保持、別Sessionへの非混入、元Sessionへ戻った際の通知保持を確認した。`slice-3/real-160816`では実execution取消のCANCELLED、予約のNOT
STARTED／内容／cancelled理由、typing・title
snapshot後の保持、execution.readとsnapshotのcancelled／turn_cancelled／turn_control、exit0を確認した。既存証拠のphysical
requestは1、reviewerによる追加requestは0。

## 制約と次へ進む条件

Slice 1/2の再レビュー、Slice
4/footerの旧状態表示、一般hardening、未観測variantやmatrixは対象外。Ghostty physical
Fキーはpacketどおり未確認。別executionの同文steer経路はsourceから上記の結果を導いたもので、production再操作は行っていない。

review中に関連workspaceのsnapshot_presentation.tsへexecutionId追加が見えたが、今回の結論には固定system_notices.tsを用い、後続fixを混ぜていない。P2修正後の確認は変更箇所とこのfinding解消に限定した一回のre-reviewが適切。修正の採否・Slice
4への最終判断は依頼元が所有する。

開始 2026-09-29 12:50:02
UTC。30分上限内で完了。コード・test・configの変更、build、tmux、provider呼出し、full
gateは行っていない。

## Slice 3 限定re-review

# Increment 159 Slice 3 限定re-review

結論: **既存P2 1件解消。未解消finding 0（Blocker 0 / P1 0 / P2 0）**。指定修正範囲に、Slice
4へ進む妨げになる問題は確認されなかった。実装の採否・最終判断は依頼元へ返す。

対象は通常reviewで指摘した「別executionの同文steerにより現在の受付通知が抑止される」問題と、固定fix.diffの変更4
filesのみ。source-files.jsonの4 hashすべて一致、fix.diff SHA256
`5288b6afa8e922579d5c56ef8127d7eb5772d4fc2c48540eb48e7caaea63a093`一致。

`v0/tui/snapshot_presentation.ts`のuser projectionが、既存API
message.executionIdをUiLogEntryへ渡すようになった。metadata比較は既にexecutionIdを扱うため、resync・更新後もこの情報を保持する。`v0/tui/system_notices.ts`では、保存済み受付通知の除去とpending受付通知の生成抑止の両方を、steer
label・対象executionId・textの一致で判定する。これにより、前のexecutionの同文steerでは現在の通知を抑止せず、対象executionのsemantic反映時にだけ受付通知を除く。Core/DBの状態・API
contractは増やしていない。

新focused testはexecution Aの同文steerとexecution
Bのpending受付を同時に与え、Bの通知が1件残り、Bのsemantic
steer追加後に0件になることを確認している。projection testの追加assertionは、実値`execution-1`がuser
entryへ渡ることを確認する。指定focusedログは8 pass、追加projection確認は4
passを示す。type/fmt/lint/diff passは依頼元報告を参照し、reviewerは再実行していない。

compiled production tmuxの既存証拠 `slice-3/real-162267`もread-onlyで照合した。2 taskのexecution
IDは異なり、両方のreceipt画面で`Additional instruction received`が1件、その後のapplied画面で0件だった。第2taskのreceipt画面には第1taskの`steer> Keep reply short`が既に存在する。第2taskの反映後は同文steerが2件残り、受付通知だけが除かれている。results.jsonはlocalhost
2 tasks／4 physical requests／external 0／exit0を示す。

開始 2026-09-29 12:58:01 UTC。15分上限内で完了。初回reviewの他領域やSlice
4は再走査していない。コード・test変更、build、tmux、provider呼出し、full
gate、追加agentは行っていない。reviewerによる追加provider requestは0。

## Slice 4 通常review

# Increment 159 Slice 4 通常コード・test review

結論: **Blocker 0 / P1 0 / P2
0**。指定された三行footer・時計・受付確認不能の表示と操作経路について、修正が必要なcorrectness問題は確認されなかった。Slice
4のreviewを終え、依頼元によるlocal完了の記録・最終判断へ進める状態。

固定11 filesのdiff/sourceを確認した。source-files.jsonの全hash一致、slice.diff SHA256
`fcc1452a61b8d34dd4fc1b76b19d327bdbda74659043f3f7caefa016e1a37bce`一致。要件は`docs/increments/increment-159.md`の「フッター各行」「Slice
4」「検証と受入」を用いた。

## 確認した動作

- remote
  controllerからUiFooterのactivity・controls・短いhintを直接渡し、remote用status文字列のconcat/parser経路と常設credential
  cache/callbackを撤去している。local rendererの既存status支援は対象外として維持。
- row1はCore
  operationsと受付／取消待ちから、その場で使えるEnter、F2、F3、Escとslash案内を作る。pickerでは各pickerのcontrolsを使う。履歴中はhistory/new/Esc
  latestを示し、Esc
  cancelを除く。layoutはoverlay中のhistory表示を抑制しており、pickerと履歴のEsc案内を混ぜない。
- row2はready／working／cancelling／READ-ONLY／DISCONNECTEDとworkspace・Session・title。pending/accepted/unknown
  receiptとCore
  preparing/running/settling中をworkingへまとめ、正常completedやcanonical/settlementを表示しない。shutdownも既存終了待ちを保ってworkingへまとめる。row3は共通selectionのprovider/model/effortを同時に投影する。
- 時計の起点はexecution.createdAt。receipt/preparationではspinnerだけで経過時間を作らない。同executionの反復projection・footer更新ではtimer起点を維持し、ready／READ-ONLY／DISCONNECTEDでtimerを解除する。狭い幅では状態・elapsedを優先し、既存path/modelの末尾省略を維持する。
- 受付確認不能はSession別TUI markerを残し、元のsnapshotだけではreadyやEnter
  submitへ戻さず、再送も止める。既存command照会後のfresh
  sessionReadのcursorと観測済みsnapshotを突き合わせる経路、対象commandのexecution相関、fresh
  subscription snapshotによる解除を確認した。Core/DBの状態は増やしていない。変更testではfresh
  readを待たせ、working・draft保持・Enter再押下でPOST増加なしを確認してから、fresh
  read後にreadyへ戻す。
- /loginはその都度presenceを読み、profile一覧とmasked入力を表示する。保存後のpresence
  refreshは維持する。footer専用の共有cacheを除く変更が、login表示やcredential値の非表示を壊していない。

## 検証証拠の照合

指定ログのretained27＋remote141の7＝34 pass、remote140の4
pass、remote142/143/144/155/157の13のうち最初11 passと、要件変更後のshutdown slash1・shortcut1
passを確認した。計51 distinctの根拠はこれらの最終結果であり、途中の停止・旧shutting
down表示待ち失敗を成功として数えていない。narrow-clockの対象1 testもpass。type/fmt/lint/diff
passは依頼元報告を参照した。testを新要件の表示へ合わせた変更後も、shutdown
drain完了待ち・他TUIの切り離し・draft/receipt・historyの実操作assertionは残っている。

production `slice-4/real-163580`の実provider証拠では、Mimo autoの1 task／2 physical
requests、working＋execution時計、completed／processSettlement
complete／task.submit可能後のreadyを確認した。100x14で会話がviewportに収まったhistory
probe待機失敗は、task完了やfooterの失敗を示していない。

最終candidateのlocalhost証拠 `slice-4/real-165459`では、ready→working→ready、history Esc
latest、busy slash
picker、detach/reconnect後の同execution起点、ready後1.3秒で時計停止、40x23の表示、provider/model/effortの同時変更、exit0を確認した。`real-165809`ではmasked
Ctrl-U、/loginのprofile presence、旧Session
READ-ONLY、DISCONNECTEDと通知1件・typing後の保持、exit0を確認した。localhostは2
requests、追加の実providerは0。reviewerは保存済みresults・画面・snapshotだけを読んだ。

## 範囲と制約

Slice 1/2/3の再レビュー、一般hardening、未観測variant
matrix、CLI/help統合、commit/push/常用配置、protected正本変更は対象外。Ghostty physical
Fキーはpacketどおり未確認。実providerのhistory表示は最初のprobeでは成立せず、最終candidateのlocalhost長文taskで実経路を確認している。

開始 2026-09-29 13:15:27
UTC。30分上限内で完了。reviewerはコード・test・configを変更せず、build、tmux、provider呼出し、full
gate、追加agentを行っていない。報告以外の書込みなし。finding採否・local完了・最終検証の判断は依頼元が所有する。
