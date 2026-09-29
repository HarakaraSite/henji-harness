# Increment 159 — 計画の通常・批判的レビュー結果

日付: 2026-09-29

利用者の指示で、独立したreviewer二人が[四sliceの計画](increment-159.md)をreviewした。
Blocking／P1限定、全体10分上限。2026-09-29 10:57:26 UTCに対象を固定し、11:02:13
UTCまでに両報告を確認した。 対象snapshotのSHA256:
`78e32f8ca653b58ac03a0b77e97361df78d5511ddc13f5aca5e25af5ffdfb9d2`。

| review | Blocking | P1 | 必須修正 |
| ------ | -------: | -: | -------- |
| 通常   |        0 |  0 | なし     |
| 批判的 |        0 |  0 | なし     |

rootは両報告の要件根拠・確認範囲・current sourceへの参照を確認し、採用findingなしと判断した。
この結果は計画reviewであり、実装後の各sliceのコード・test
reviewやproduction／実provider確認を代替しない。
計画にはその手順と、利用者が承認したsliceごとの最小実provider確認を保持した。

以下は各reviewerの報告。通常と批判的は相手の報告を参照せず独立に判断している。

## 通常レビュー

方式: 独立した静的レビュー。固定 `plan-snapshot.md`
全文と、計画の具体的経路に関係する指定source・既存testの該当部分を参照した。批判的レビューの結果は参照していない。

状態: 完了。2026-09-29 11:00 UTC時点で確認終了、絶対deadline 11:07:26 UTC以内。

対象: 四sliceの要件、Core/TUIの既存責務、実装順序、focused確認・隔離production
TUI・最小実provider確認、sliceごとのコード/test reviewと次へ進む条件。評価はcontext
packetの暫定基準によるBlocking/P1限定。

**Blocking 0件 / P1
0件。指定基準で実装へ進む妨げになる計画上の問題は認めなかった。必須修正はない。実装開始の最終判断は依頼元に委ねる。**

確認した根拠:

- Slice 1（snapshot
  209行以降）のEnter/F2/F3/Alt-Enter振分けは、入力先と実行先を分ける合意に対応している。`remote_session.ts`
  の `activeExecution`・`canSubmit`・`submitDraft`、`core_service.ts:461`
  のoperations、`task_service.ts:57` の受付可否と `:133`
  のsteer／queue経路を確認した。計画は既存受付可否、execution固定、receipt照会、draft保持を維持し、一turnの追加指示枠・予約枠を拡張しない。廃止するパス補完のproduction参照はRemoteCatalogUi→client→HTTP→Core→file_referenceの経路で、計画の除去対象に含まれている。
- Slice
  2（230行以降）は、既存14コマンドを使うpickerの選択Enterと実行Enterを分け、Escでdraftを保持し、補完・終了後の自動再表示を抑止する。`slash_command.ts`
  の定義と `remote_session.ts:1851` のコマンド実行、`:1970`
  以降のoverlay優先経路と整合する。引数入力中にpickerを割り込ませない要件も明記されている。
- Slice
  3（244行以降）の保存済み停止理由を表示へ渡す経路は成立する。`sqlite_history_v7_production_store.ts:94`
  のcompactOutcomeはtranscriptだけを省き、`:1551`・`:1623` で保存、`:1714`
  以降でoutcomeJsonを取得する。snapshotの `api_projection.ts:951` と `core_service.ts:806`
  のexecution.readは同じprojectExecutionViewを使う。contract/codec/projectionを同じsliceで変える計画で、DB形式変更は不要。既存の予約成功条件・取消時破棄・未開始理由は
  `task_service.ts:276`
  のsettle経路と整合する。通知のSession対応、identityによる重複抑止、semanticな追加指示と受付通知の区別も計画に含まれる。
- Slice
  4（268行以降）は、終了outcomeを受け取る時点と新規入力が可能になる時点を区別し、operationsと既存送信・取消待ちから状態を表示する。elapsedは既存のexecution.createdAt→renderer時計の経路を用い、履歴中Escの意味と幅省略を維持する。Coreに表示用phaseや新しい保存状態を加えない。
- 各sliceは実装→focused確認→隔離production TUIと承認済み最小live→固定差分のコード/test
  review→採用findingの修正・限定re-review→次sliceの順で閉じる（283行以降）。liveの物理request数は見込みとして扱い、不要なcallを増やさず、対象・保存先・semantic結果を記録する。既存testで旧Enter
  steering、Alt-Enter
  queue、パス補完、旧footer結果を前提にする箇所は、計画どおり変更・削除する対象として識別できる。full
  gateをreview完了の代替にしていない。

確認限界: 今回は計画レビューであり、コード変更・test実行・tmux・provider
callは行っていない。GhosttyからのF1〜F3物理入力、停止理由の短い表示への変換、実装後の通知保持・画面操作は未実測で、計画に示された実装時の確認を残す。本結果はその確認や各sliceのコード/test
reviewを済ませたものではない。

## 批判的レビュー

- 結果: **Blocking 0件 / P1
  0件**。本レビュー範囲では実装へ進む妨げとなる計画上の欠陥は見つからなかった。
- 状態: 完了。確認開始 2026-09-29 10:58:03 UTC、完了 2026-09-29 11:02:01 UTC。全体の絶対deadline
  2026-09-29 11:07:26 UTC以内。
- 対象: `/tmp/codex-agent-context/increment-159-plan-review/plan-snapshot.md`（四sliceの固定計画）。
- 方式:
  通常レビューの結果を参照しない独立した静的レビュー。入力から受付・実行結果への経路を逆にたどり、slice間の依存、暫定画面、pickerのEnter/Esc、状態と操作可否、通知保持、停止理由API、最小実provider確認に重大な矛盾がないかを確認した。
- 評価基準: packet記載のBlocking/P1限定。要件根拠、current
  sourceから利用者影響への経路、test追加だけではないcorrectness問題の三点を満たす指摘のみ採用対象とした。

### 確認結果

1. **四sliceの順序と暫定画面**: Slice
   1で入力の送り先と廃止経路を切り替え、暫定案内も新キーに合わせることが明記されている（計画211–228行）。Slice
   2のpickerは既存slash実行とoverlay優先処理へ接続し、Slice 3で本文通知を保持した後にSlice
   4でfooterを分離する。sliceごとの実操作・focused確認・コード/test
   reviewを終えて次へ進む条件とも整合する。
2. **送り先、受付、picker操作**:
   `remote_session.ts`のactiveExecution/canSubmit/submitDraftと、`core_service.ts`のoperations/steeringSubmit/followUpQueue、`task_service.ts`のcanSteer/canQueueFollowUpを確認した。計画71–86行はready
   Enter、busy Enter送信なし、F2予約、F3追加指示、対象Session/execution固定を明示し、picker
   Enterを補完だけに消費し、Escのキャンセル流入と同draftの即時再表示を避ける。既存の1turn制約を拡張する計画にはなっていない。
3. **状態と操作可否**:
   既存Coreのoperationsはpreparing/実行/後処理を含むslotBusyで新規受付を制御する。計画137–156行および270–277行はworkingを新規受付再開まで維持し、結果completedだけでreadyへ戻さず、取消待ちと受付確認不能も区別する。状態名の整理を内部完了条件の削除として扱う矛盾はない。
4. **結果と通知保持**: `StoredExecutionRow.outcomeJson`をproduction
   storeがcompactOutcomeで保存・readbackし、stopReasonとdiagnosticを維持することを確認した。snapshotとexecution.readはいずれも`projectExecutionView`を使うため、計画246–260行の共通API拡張は既存DB形式で実現できる。現行snapshotの会話置換、Session切替、notice消去に対して、計画109–120行および253–256行はSession別のTUI保持とcommand/execution/予約identityによる統合を要求している。予約の成功後開始、失敗/取消時未開始は`task_service.ts`のsettle/discardと一致する。
5. **最小live確認**:
   計画307–319行はsliceごとの生成に関係する操作に実provider確認を絞り、picker/認証編集/幅だけのためにcallを増やさない。各sliceのproduction
   TUI確認と結果記録、localhost
   providerによる拒否/失敗再現を組み合わせる手順に、合意した確認目的を成立させない重大な矛盾はない。

### 確認限界

これは未実装の計画に対する静的レビューであり、test、build、full gate、tmux操作、provider
callは実行していない。将来の実装correctnessや実端末操作の成立を承認する結果ではない。Ghostty+tmuxからF1〜F3を物理入力した結果は未確認であり、計画342行もtmuxへのキー列送信と区別して記録することを明示している。短い停止理由の具体的表示変換、通知のSession別保持、sliceごとのproduction/live結果は実装時の確認対象として残る。

repository、context packet、固定snapshotは変更していない。本ファイル以外へ書込みしていない。
