# Increment 49 — durable history storage amplification investigation

ステータス: **調査完了、runtime変更なし**

基準commit: `cf6180ee`

調査日: 2026-09-13

対象候補: A4

## 目的と範囲

通常利用を続けた場合にworkspace-local `history.sqlite3`が耐え難い容量へ成長する可能性を、現行schemaと
開発VM上の実dataから小さく確認する。保存本文やcredential値は出力せず、file/page、table、record kind、
serialized byte量だけをread-onlyで集計する。

このIncrementは原因経路と次の狭い実装候補を明らかにする調査であり、schema、retention、history readback、
code、test、binaryは変更しない。保存すべき診断証拠の種類も変更しない。

## 確認した実data

現行v0.1.2を通常利用している当該workspaceのSQLite schema v3を、`node:sqlite`のread-only connectionで集計した。

| 指標 | 観測値 |
| --- | ---: |
| database file | 15,613,952 bytes |
| Session | 3 |
| canonical turn / message | 3 / 14 |
| execution / model request | 3 / 7 |
| execution event | 3,800 |
| context relation / request item / unique blob | 264 / 95 / 38 |

tableのSQLite page使用量上位は次のとおりだった。

| table | SQLite page bytes | 主なpayload bytes |
| --- | ---: | ---: |
| `execution_events` | 9,756,672 | 8,240,193 |
| `provider_evidence` | 2,650,112 | 2,641,124 |
| `execution_artifacts` | 1,437,696 | 1,431,305 |
| `model_requests` | 172,032 | 159,916 |
| `context_blobs` | 163,840 | 138,506 |

databaseの約89%を`execution_events`、`provider_evidence`、`execution_artifacts`の三tableが占めた。
content-addressed `context_blobs`は38 unique blob、約0.14 MBであり、このdataでは主要因ではない。

## `execution_events`の内訳

byte量の大きいevent kindと、`runtime_event`内のsubtypeを集計した。

| event kind / subtype | records | serialized bytes | 観測した保持内容 |
| --- | ---: | ---: | --- |
| `runtime_event`全体 | 1,197 | 4,583,613 | 下記subtypeを含む |
| └ `commit_proposal` | 3 | 2,947,064 | execution完了時点の累積transcript |
| └ `assistant_progress` | 1,152 | 1,531,696 | streaming中に配送されたprogress snapshot |
| `provider_sse_event` | 837 | 1,461,952 | parse済みSSE event |
| `provider_response_bytes` | 862 | 813,758 | raw response byte chunk |
| `provider_parser_transition` | 849 | 715,084 | parser transition |
| `context_observation` | 7 | 430,272 | exact model request attribution |
| `provider_request_start` | 7 | 166,062 | provider request開始時のrequest情報 |

`worker_host_session.ts`はactive execution中のWorker messageをappend-only journalへ保存し、settlement後も同じrowを
残す。`commit_proposal`はcanonical messageとは別に累積transcriptを保持する。`assistant_progress`はmodel request
ごとのprogress配送を毎回journalへappendする一方、完成したprovider evidence側では同じstepのprogressを最新値へ
集約する。provider streamはraw response bytes、SSE event、parser transitionをlive journalへ保存し、settlement後の
provider evidenceにも完成したrecordを保持する。execution artifactも完成した実行記録を別payloadとして保持する。

したがって、現行の容量増加には次の具体的な経路がある。

1. live recovery用の細粒度journalと、settlement後のevidence/artifactが同じexecutionについて併存する。
2. `assistant_progress`の連続snapshotをすべてappendするため、長いstreamほどsnapshot本文の重複が増える。
3. `commit_proposal`が累積transcriptをexecutionごとに保持し、canonical messageの正本とも併存するため、
   Sessionが長くなるほど過去conversationの再保持量が増える。
4. raw response、SSE、parser transitionは原因特定に必要な別表現だが、live journalと完成evidenceの二層に残る。

## 判断

Increment 43の5.9 MiB / 1,826 recordsは多数turnの長期Sessionではなく、3 executionを使ったrecord/content量と
並行writeの受入だった。一方、今回の通常利用dataは3 executionだけでdatabaseが約15.6 MBになり、3,800 eventと
settlement後の重複表現が容量の中心であることを示した。単純平均の約5.2 MB / executionを通常利用の予測値とは
扱えないが、同じ比率なら1,000 executionで約5.2 GBになる。したがって、A4は未観測の将来懸念ではなく、
実装候補を比較する根拠があるstorage amplificationとして扱う。

## 次の小さな実装候補

保存する証拠の種類を減らさず、同じbytesまたは同じ完成状態をsettlement後も複数payloadへ保持する経路だけを
対象にする。

- active execution中はrestart reconciliationに必要なlive journalを維持する。
- settlement transactionでevidence、artifact、canonical/non-canonical outcomeが確定した後、exact raw response、
  SSE、parser transition、model request、tool effect、context attributionを一つのauthorityからreadbackできるようにし、
  完成recordと重複するjournal payloadを参照または小さいsettlement recordへ置き換える案を比較する。
- `assistant_progress`は観測順を失わないdelta表現、または完成evidenceへ集約可能なsnapshotのどちらが既存の
  readbackとrestart reconciliationを保てるか確認する。
- `commit_proposal`の累積transcriptをsettlement後も保持する必要があるか、canonical messageとexecution outcomeへの
  relationで同じ事実を復元できるか確認する。
- 実装前後で同じproduction turnを実行し、history/detail/exportの内容、restart reconciliation、database増加量を
  比較する。未観測のretention期間、quota、自動削除、VACUUM、圧縮はこの候補へ加えない。

この実装候補は未採用であり、別途利用者の承認を得て計画する。
