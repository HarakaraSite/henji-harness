# A28 再検討：逐次更新を基本にした会話状態

2026-10-02。利用者は本書の案を承認し、計画作成と通常・批判的レビューを指示した。
採用要件・計画の正本は[Increment 170](../increments/increment-170.md)。
本書は承認に至った再検討と設計レビューの記録であり、対策実装・常用配置・構想／architecture／roadmapの変更ではない。

## 設計原則と必要な動作

利用者の明示原則は「現状の責務を念頭に置かない」。必要な動作、共通の更新規則、必要な状態と順序、
配置の順で判断する。既存componentの担当、同期API、変更量を配置の採否理由にしない。
現行sourceは観測原因、利用できるID／番号、現在成立している利用者の動作を確認する資料として使う。

保存済みの会話を開く、新規会話を始める、保存済み会話から新しい指示を送る、実行中に再接続する、を
同じ会話状態と更新規則で扱う。thinking、本文、tool、steering、終了結果の順序と確定状態を保持する。
通常更新に過去履歴の読取、最新値の再探索、全会話組み立て、全snapshot比較を挟まない。

根拠は[実provider観測](a28-real-provider-observation-2026-10-02.md)。run-2では物理request一回に対し
全projectionが414回、362.781秒。journal
writeは合計142.786ms。thinkingは途中112件と完了一件、
本文progressは82件だった。保存後通知内のprojectionは205回で、198件batchの通知は178.295秒。
当時の2.5GiB保持は未再現であり、本案からその解消を保証しない。

## 共通の会話状態更新器

`applyFact(state, fact)` を会話状態を作る唯一の更新規則にする。
保存済み履歴か新規の出来事かを判別して、関連づけや表示順の規則を切り替えない。
DB取得、画面描画、全履歴scanはこの更新器に含めない。

状態はexecution、request、thinking、tool occurrenceと関連・順序をIDで保持する。
同じ対象の更新はその値を置き換え、新しい対象だけを追加する。
出力は変更entityと必要な構造変更であり、全状態を再構築して比較しない。

| 操作                        | 共通更新器への入力と状態                                 |
| --------------------------- | -------------------------------------------------------- |
| 新規会話                    | 空状態から、新指示と以後の出来事を順に入力する           |
| 保存会話を初めて開く        | 空状態へ保存された事実を順に一度入力する                 |
| 読み込み後に指示を追加      | 読み込みで得た状態へ、新executionと出来事を入力する      |
| 実行中の更新                | 同じ状態へ新しい保存済み事実だけを入力する               |
| 開いているSessionへの再接続 | 保持している現在状態を取得し、その後の変更を受ける       |
| Core再起動後                | 保存された事実を空状態へ再生し、その後も同じ更新器を使う |

初回の再生では途中thinkingの過去snapshotを一度読むことはあるが、同じキーへの更新として最新値へ
到達する。通常更新で再生を繰り返さず、現在状態には同thinkingの全snapshotを保持しない。
初回の画面描画は再生終了後にまとめる。

### 入力の正規化とidentity

保存履歴と新規append結果を同じpublic semantic factへ正規化する。 raw
provider／Worker protocolやprivate replay stateをそのままUIへ渡さない。
`executionId`、`requestKey`、`workerSequence`、保存ordinal、`occurrenceId`を再利用する。
通知の番号と、更新される同一entityのキーを区別する。

- request開始でrequest
  keyと順序の対応indexを作る。thinkingのkey補完で過去eventsをfilter／sortしない。
- 本文はrequestごとに一つ。model
  resultで同じrequestを確定し、別の確定本文を重複追加しない。
  terminal保存でsemantic
  occurrenceIdが新たに付いても、executionとrequestKeyによる本文identityは維持する。
- entityの版は共通factへ正規化した入力のsequence／保存ordinalから定め、apply回数から作らない。
  配置はrequest開始や本文のfirstEventOrdinalから定める。初回読取で途中本文の最新値だけを入力しても、
  liveで複数回更新しても、同じ版・位置・確定状態へ到達する。
- thinkingはrequest keyとkindで最新値を保持する。
- toolはcallの保存occurrenceをidentityとし、progress／resultを同じtoolへ結び付けるindexを維持する。
- steering、request、toolなどの構造情報は、公開batchの本文更新を合流する際にも落とさない。
  steer_requestedは要求中の操作状態、steering_messageは実適用済みの会話factとし、二つのuser行にしない。
- 順序はexecution／request／occurrenceの関連として保持する。文字更新で全sortせず、絶対値の
  `beforeMessageIndex`を毎回計算しない。
- canonical採用とprocess cleanup完了は別の状態として入力する。

現行の`readSessionHistory`、`restoreRecordMessages`、`thinkingForVisibleExecutions`などで完成した
表示を初回専用に作り、その後だけ新engineを使う方式は採らない。 初回はsemantic
occurrencesと最新途中本文stateを、版・元の順序を保った共通factへ変換して入力する。
履歴DBの保存authorityと人間向けのderived stateを混同せず、model
contextをTUI表示から作らない。

## 共通処理から選ぶ配置

| 実行単位               | 必要な処理と状態                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| データWorker一つを追加 | DB読取・書込、共通更新器の会話state、保存済みの版・順序、初回再生、terminal／canonicalのatomic保存、Sessionのmodel用dataとrecord組立て・検証 |
| Core                   | 操作受付、Agent／process／childの実行管理、小さいactive state、採用許可、直接cancel、public配信revisionの一元化と変更中継                    |
| Agent Worker           | provider／toolの実行。Coreとは制御、データWorkerとはcontext／proposal／semantic dataをやり取りする                                           |
| TUI                    | entityから表示entryへの共通mapper、keyed表示state、Markdown／layout／viewport／画面更新                                                      |

データWorkerは共通更新器によるsemantic stateの唯一のwriterとする。
保存履歴の再生にも新しい保存batchにも同じ更新器を使う。
ここでは人間向け行・Markdown・viewportを作らない。

TUIでは、初回の全entityとその後の変更entityを同じmapperとentry差分APIに入力する。
保存履歴専用とlive専用のprojectorを分けない。
通常の文字更新では該当entryだけを変更し、構造変更時だけ順序indexを更新する。
既存の全messages走査、全entries置換、配列全体の検索・コピーを通常更新経路に残さない。
既存scheduler、EntryLayoutCache、限られたhistory windowの描画は利用できる。
deltaは毎revisionでstateへ適用し、dirty entryの描画だけを合流する。
最新callbackへの置換によって未適用deltaを捨てない。

データWorkerのsemantic stateとTUIの表示stateは、別々の履歴組み立てではない。
前者が同じ更新規則から現在の事実を作り、後者がそれを同じ表示規則で画面へ変換する。
両段とも初回と継続で規則を変えない。

## 通常更新、保存、キャンセル

通常経路は、Agent更新→順序付きjournal
buffer→atomic保存batch→同じnormalizer／更新器→ 変更entityの一回配信→Coreでpublic
revision付与→TUIで同じentry mapper、とする。
batch内のfactは順に適用し、配信・描画だけ同entityの最新値へまとめる。
受信時のfull refresh、保存batch各resultでのfull refresh、全snapshot
diffを廃止する。 表示更新のための過去queryは行わず、新規入力と保存結果を使う。

terminal transactionが行う残存本文のsemantic化、terminal
identity、outcome／adoptionを結果として返し、
COMMIT後のfactとして同じ更新器へ入力する。保存成功前に採用済みや正常終了と報告しない。
SessionAuthorityの全文clone、record組立て・検証もデータWorkerへ置く。
同期HistoryPersistencePortをCoreで待つ構成を、data-onlyの非同期command／resultへ変更する。
`artifactForCapture`等の関数callbackをWorkerへ渡さず、必要dataと確定結果へ分解する。

Coreは小さいactive stateから対象を確認してAgentへ直接cancelを送る。
送信前に表示更新やデータWorkerのflush／読取／保存を待たない。
取消要求・送信をcontrol
sequenceとcorrelation付きでデータWorkerへ非同期に記録する。
要求受付、Agent受信、terminal保存、process
cleanup完了を別々の確認済み状態として扱う。

採用許可とcancel判断は同じCore controllerで順序化する。
Agent→DataとCore→Dataの別portの到着順を前提にしない。 Dataがproposal
ID、correlation、最終worker sequence付きprepare tokenを返し、Coreがそのtokenへ
採用許可を返す。Dataは対象sequenceまで保存してからterminal transactionへ進む。
取消が先なら許可せず、durable採用済みの結果を取消で巻き戻さない。

## 接続と配信の境界

データWorker内でsnapshot
cutとwatch登録を一つの境界として扱い、snapshotと後続deltaを順に出す。
Data側の保存revisionをpublic cursorとして独立発行しない。 Coreがsnapshot
cutと最新の小さいcontrol状態を接続時に合成し、以後のdata／control両方へ
単一のpublic配信revisionを付ける。Coreは会話全文を解釈・再構築・比較しない。
複数TUIは同じentity／updateを各自同じmapperで表示する。

## 対案と推奨理由

同じ共通更新器をCoreで動かす案も、414回の反復原因は除去できる。
ただし、履歴読取・復元・record組立て・検証などの同期処理が操作受付と同じ実行単位に残る。
Session全体をWorkerへ移す案では、それらからCoreを外せるが、Agentへのcancel送信もbusy
Workerを 通過する構成になり得る。

本案は、データ処理を一つのWorkerへ置き、Agentへの制御経路はそのWorkerを通過させない。
同時に、共通更新器と項目単位の表示で総処理量を減らす。 追加API／CLI
Worker、保存履歴表示専用Worker、live表示専用Workerは設けない。
コード変更量ではなく、同じ更新規則での継続と操作経路の成立を理由としてこの配置を推す。

## 確認方針と承認境界

同じ保存factからの初回stateと、新規append経路から逐次作ったstateが一致し、さらに新指示を足して
継続できることを確認する。比較するのは異なる実際の入力経路であり、同じ関数を二度呼ぶだけのtestにしない。
productionでは途中表示・順序・確定、保存会話からの再開、実行中再接続、実際のcancel到達・terminal・
cleanup、通常更新で過去queryと全projectionがないこと、CPU／RSSを確認する。
配置を変えて性能を探す試行錯誤は行わない。

案は後続指示で承認され、Increment 170へ採用した。今回の計画作成・reviewは実装開始の指示ではない。
本書保存に伴うsource変更、実provider request、既存DB／Coreへの変更はない。
構想・architecture・roadmapの意味変更は別途の提示・承認が必要であり、本書には反映案として留める。

## レビュー

現行責務の保持を条件としない批判的reviewを実施した。今回の対象は共通更新器、保存／liveの入力、
履歴からの継続、TUIとの二段構成。時間上限8分、4分時点で中間結論を受領し、read-onlyで完了した。
既確認のcancel・commit・配信revisionの議論を再探索する依頼にはしていない。

reviewerは共通normalizer／applyFactへの置換を支持し、配置変更を必要とする具体的な矛盾は認めなかった。
本文identityの維持、apply回数に依存しない版と順序、steering要求と実適用の区別を契約へ明記するよう提案した。
親は本文保存時にfirstEventOrdinalを保持し、terminalで同じrequest本文へsemantic
IDを付けるsourceと、
steer_requested／steering_messageの経路を確認し、三点を採用して本書へ反映した。

初回専用に旧readSessionHistory／restoreRecordMessagesを残す対案は、完成済み表示の解釈規則を二重に持つため
採らない。共通engineの状態を引き継ぐ案を推奨する。物理配置の対案と採否理由は前節に記載した。
Data側がidentity・関連・確定状態・順序を決め、TUIが出来上がったentityを同じmapperで表示する二段は、
保存履歴とliveの別組み立てにはならない、という結論を親も採用する。

これはsourceに基づく設計レビューであり、未実装の性能・操作成立を確認済みとするものではない。
