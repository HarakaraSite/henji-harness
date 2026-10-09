# henji-harness：長時間実行のメモリ対策 — Linux側の計画入力

作成日：2026-10-08。通常レビュー・批判的レビューの補足と、実装スパイクを反映した引継ぎ版。
Linux側Codexへ、このファイル単独で渡す。以前のレビュー用context.mdと個別の診断指示書は、今回の作業指示ではない。

## 目的と進め方

長時間実行で、履歴総量に応じてCoreの常駐量と毎turnの処理対象が増える構造を改善する。
モデルへの入力を適切な最新範囲に収めることと、Data／Agent等のRAM常駐範囲を絞ることを両方扱う。

計画以降はLinux側で進める。順序は、計画 → 隔離した実装スパイク → 成立判定 → 本実装 → 長時間の受入確認。
このファイルは目的・要求・検証する仮説を渡すもので、具体的なAPI、ファイル構成、実装順を確定しない。
実行、commit／push、配置の権限はLinux側での利用者指示とrepository規約に従う。既に承認済みの範囲について確認を繰り返さない。

## 対象と着手時の確認

- repository：<https://forge.harakara.site/littleisland/henji-harness>
- 調査・実験の基準：`6315beed73cb4c68ec46189c30e08487a83d0028`（Increment 217）。
- Linuxの既知の配置：`/home/agent/projects/henji-harness`。実際の配置を確認する。
- 最新の実験報告は、Linux常用checkoutのHEADを`93e9c344…`と記載している。このHEADの内容はDiscovery側で確認していない。

Linux側で現在HEAD、変更状態、AGENTS.md、architecture、現在のincrement／handoffを確認する。
基準commitとの関係を明記し、既存変更と診断patchを保全する。以下のsource位置は基準時点の入口であり、現在HEADへ照合して使う。
過去のcontext-management計画や診断用8ターン制限を、今回の採用済み要求として扱わない。

## 利用者が求める入力構成

履歴が `A → B → … → X → Y → Z` と続く場合、予算内の最新側 `X → Y → Z` を時系列順に渡す。
古いA/Bだけを渡し、最新入力が欠落する動作を避ける。

論理的な構成は、次のとおり。

```text
前置context：instruction、tool定義、追加の注入context、将来の要約
    ＋
予算内の最新履歴と現在turn
```

- 前置contextをinstructionとtool説明に限定しない。追加情報の役割と順序を扱える構成にする。
- tool定義がAPIの独立したfieldになる場合等、実際の配置・roleはprovider契約へ合わせる。
- 将来の要約も入力容量を消費する。前置contextや要約を際限なく累積させる構成にしない。
- 今回は最新履歴の選択を扱う。自動compaction、要約生成、常時background要約、履歴検索toolの実装は含めない。
- 診断の固定8ターンは製品要件ではない。

## 予算の意味とrequestごとの選択

モデルのcontext総容量、providerの入力単体上限、出力予約、会話履歴の保持予算、将来のcompaction発動閾値を区別する。
会話履歴の予算には、過去の完了turnと現在turnを含める。現在turnを予算外の追加枠として扱わない。

以下は意味を明確にするための概念式であり、設定名や計数APIを指定するものではない。

```text
C = 入出力合計のcontext容量
I = providerが持つ入力単体上限
R = 出力予約
P = 全前置contextの量（tool定義を含み、重複計上しない）
O = Pや会話本文に含めていないprovider上のframing等
H = モデル別に設定する会話履歴予算（完了履歴＋現在turn）
K = 現在turnの量

有効入力上限 V = min(I, C − R)    # 両方が定義される場合
会話へ使える量 B = min(H, V − P − O)
過去の完了履歴へ使える量 = B − K
```

一方の容量だけが提供される場合や不明な場合は、情報源・推定・保証範囲を計画で定義する。
`B − K`が負なら、過去履歴をゼロにしても現在turnは収まらない。その場合の動作を未定義のまま実装しない。

- 既定値とprovider／model別の上書きを用意し、予算を柔軟に設定できるようにする。
- 容量値の情報源と上書き優先順、不明modelの扱いを決める。モデル不明を理由とする新しい選択拒否を当然の帰結にしない。
- 出力予約はproviderへ実際に送る出力設定、または確認できた上限と対応付ける。
- モデル、前置context、tool定義、現在turnが変わったら、各requestの実際の入力に基づき再評価する。
- 現在turnの入力・tool call／resultを優先し、残量で最新側の連続した完了履歴を選ぶ。送信は時系列順とし、因果関係を分断しない。
- 現在turn単体や必須前置contextが収まらない場合の利用者に見える動作を計画で決める。最新入力の黙った欠落、元履歴のDB削除、未承認の自動要約を解決策へ混入させない。
- tokenの計数／推定方式と限界を明示する。provider変換、reasoning等のprovider固有項目も必要な計数・状態管理の対象へ含める。
- 全履歴をclone／JSON化してから予算を求める処理を避ける。計数用cacheも、全件をRAMへ累積させない。
- 現行のserialized messages 5 MiB／request body 6 MiBというbyte制限とtoken予算の関係を整理する。byte上限へ達しなかったことはtoken適合の証明ではなく、byte上限の引き上げだけも今回の対策ではない。

## 保存・状態所有・差分commit

- SQLiteを全文の正本とする。会話、元tool引数・結果、canonical／non-canonical、cancel／failure／途中の観測、childの保存を維持する。
- RAMやモデル入力から外すことと、DB記録の削除を区別する。
- Dataは必要範囲の取得と永続化を担い、Agentは選択contextと現在turnを保持する。
- 新規Sessionだけでなく、保存Sessionの再開も全件本文のRAM展開を前提にしない。
- 本文だけでなくID／size／turn情報も、全件を配列へ読み込んでから選ぶ方式にしない。範囲取得と必要な軽量metadataで成立させる。
- Agent→Dataのcommitは新turnの差分と、保存側のcanonical位置・revision等で成立させる。選択windowの長さを保存履歴の総件数として使わない。
- Coreの採用判断、Dataのdurable保存、revision／correlation照合、原子的なcanonical採用、cancel／failureの保存境界を維持する。
- Dataの会話projection、API／TUI閲覧も必要範囲を保持し、古い履歴はDBから閲覧できるようにする。
- 完了executionは、after_turn等の必要なconsumerと後処理が完了した後、本文に加えて常駐registry／索引も保持範囲から外す。各executionにつき小さなDB参照をRAMに永久蓄積する方式にしない。
- Core側のregistry、購読queue、API／TUI側の蓄積も実経路を追って範囲を決める。これらの詳細経路は今回の独立reviewでは未確認である。
- 限定cacheの範囲、解放時点、過去記録の再取得方法はLinux側の設計で決める。

DB構造の変更は選択肢に含む。既存DBはnormalizedなので、DB engine置換を前提にしない。
range読取、位置情報、必要なsize／token情報等を支える変更を検討する。
schema変更と既存データの扱いを計画に書き、移行／互換方式を黙って追加しない。実データの削除は含めない。

## 入力証跡と保存位置の契約

- 保存履歴の安定ID／turn／execution位置と、選択window内の配列位置を分ける。
- source attributionは、各requestで実際に選んだ入力と前置contextへ結び付ける。
- 選択windowがrequest間で縮小・置換された場合も表現する。同じ件数のwindow置換を、追記だけの変化と扱わない。
- 現在のappend-onlyなrequest evidenceを、そのまま流用できるという前提を置かない。必要な置換／revision契約を設計する。
- checkpointやprovider-private stateの境界も、保存側の全体位置と選択範囲に整合させる。
- 証跡の無効化や誤ったsource番号による見かけのメモリ削減を、成功と扱わない。

## 実装スパイク

### 検証する仮説

全文常駐を外しても、実際のDB → Data → Agent → 差分保存の経路で、最新入力、全履歴保存、原子的採用、正しい入力証跡を同時に成立させられる。
その対象経路の常駐本文量・記録件数・毎turnの処理範囲を、履歴総量に依存させず保持範囲に収められる。

### 範囲

隔離環境の1 Session・1 Agentと、既存のlocalhost負荷を用いる。
実DB／Data／Agentの経路を通す。擬似コードやselector単体の確認だけでスパイク成立としない。
必要なprototype変更、DB変更、計数、commit／証跡契約を一つの経路として検証する。
会話表示全体、全provider／child経路、自動compaction、設定UIの完成はスパイクの範囲にしない。

確認する動作：

1. 必要範囲だけを取得し、全文をData／Agentへ展開せず継続・再開できる。
2. 通常のtool結果追加で第2request等の予算が変わり、履歴境界が動いても最新入力とtool因果を維持できる。
3. 追加前置contextと異なるモデル別予算を反映して選択範囲を変えられる。実モデル切替と設定の反映時点は既存の実利用経路へ合わせる。
4. 新turnの差分で元の会話・tool結果を全保存し、実際の各request入力を証跡から照合できる。保存位置をwindow内位置へ振り直さない。
5. 必要な後処理が終わったexecutionの常駐state／索引を解放しても、保存済み記録を参照できる。

### 観測と判定

- 合格条件は、全履歴保存、最新入力、予算内入力、正しい証跡が成立し、対象経路の常駐本文・記録件数が定めた保持範囲に収まること。
- 常駐量、処理対象量、件数は全文を追加cloneせず観測する。重いDB全文照合は会話中のmemory観測区間と分ける。
- RSS／PSSも併せて観測する。Core内Workerは同一PIDなのでWorkerごとのRSSを合算しない。TUIは別processとして区別する。
- ターン数、入力負荷、保持範囲、観測間隔、測定時点、使用source／binaryを計画で明記する。保持範囲を超えて履歴が十分増える長さを選ぶ。
- 正常な連続処理中の需要を主に確認する。待機後の解放量だけを成功根拠にしない。
- 保存／入力／証跡／状態解放のいずれかが破綻する、または全件取得が残るなら、結果と原因を示して方針を再検討する。
- 対象経路のスパイク成功は、未変更の会話表示等を含むCore全体の増加停止を証明するものではない。成立範囲と残りを明記して本実装へ進む。

## 本実装と受入確認

スパイク結果を使って本実装計画を具体化し、Data／Agent、会話表示、他の実行経路、完了記録・索引・購読の保持範囲へ適用する。
headless／Core、保存Session再開、child等の実際に共通処理を使う経路を確認し、rootだけの特殊処理を本実装の完了としない。

受入では、以下を直接確認する。

- 全文保存、canonical／non-canonical、採用・cancel／failureの既存動作が成立する。
- 最新入力、前置context、tool因果が予算に沿ってモデルへ渡され、証跡が一致する。
- 連続実行・再開・過去履歴閲覧で、常駐本文量と記録件数が保持範囲を越えて総履歴に比例増加しない。
- 履歴総量に応じた毎turnの全文clone／転送／JSON化／全文走査が主要経路から外れている。
- 同じ負荷のRSS／PSS推移を確認し、ピーク減少に加えて継続実行中の増加傾向を判定する。

具体的なmemory閾値、試行数、実行長、操作確認はLinux側の計画で決める。
RSSが数学的な定数になることは要求しない。JS heap、native／allocator、共有pageを区別し、残る増加を無条件にリーク／解決済みと扱わない。
一般的なtest／gate成功だけを受入根拠にせず、利用者の目的へ対応する観測を記録する。

## 既存実験の要点と再利用

既存のLinux成果物・driver・localhost provider・sampler・binary provenanceを確認して再利用する。
配置が違えばLinux側でreport内容から解決する。追加のコピー単体A/B測定を繰り返すことを、計画開始の前提にしない。

| 比較 | 条件・結果 |
| --- | --- |
| A50／B50（mem4） | 各3回、計300成功turn／600request。A全文input、B直近8完了turn＋現在turn。CoreピークRSS中央値505.68→379.79 MiB、PSS477.58→351.71 MiB。Bは入力が固定になってもRSS増加が残った。 |
| B50／C50（mem5） | 各3回、計300成功turn／600request。B/Cとも上記input制限。Cは採用済みAgent全文を再利用し、毎turnのgeneration全文snapshot／転送／basis cloneを省いた。CoreピークRSS中央値400.51→371.36 MiB、PSS373.26→343.57 MiB。 |
| mem5の増加傾向 | 21–50turnのRSS傾き中央値B4.857／C3.774 MiB/turn。41–50はB0.754／C3.035。Cの頭打ちや後半の一貫した改善は確認できない。CでもData／Agentは200messagesの全文を保持し、loop開始clone／index本文copy／全文commit等が残る。 |
| 以前の200turn試行 | 87turn完了、88turnで5MiB serialized messages制限に停止。RSS約773MiB。OOMではない。200turn完遂やその時点の解放量は未確認。 |

mem4のBとmem5のBは別compile／別runである。mem4の379.79とmem5の371.36を対応したB/C削減量として扱わない。
mem5の対応した3組のピークRSS差C−Bは−42.59／−0.82／−49.42 MiB。各要因の個別MiBや現在のRSS増加の全原因は分離できていない。
待機中に解放される大きな部分も観測済みだが、連続実行中の需要を解決した根拠にはならない。

mem4は`.tools/memory-context-causality-217-20261008/`相当のA50/B50成果物。
mem5は「Data→Agent generation context再取得とメモリ増加の切り分け」という題名のB50/C50 reportとaggregate、B-only／C-only patch、共通counter、各run記録を探す。
これらのreport末尾にある次の単体コピー診断の提案は、今回の作業指示ではない。

## source確認の入口

| 経路 | 基準sourceの入口 |
| --- | --- |
| 全文Session read／保存 | `v0/agent/history/sqlite_history_store.ts` のreadSessionOwnerState（743付近）、prepareWorkerObservationForHistory（1344付近）、commitCanonicalTurn（1921付近）。SQLite commitは既にsuffix保存。 |
| DB構造 | `v0/agent/history/history_schema.ts`。contents／messages／session_turns／conversation_messages等。 |
| Data全文保持／proposal | `v0/agent/data/session_authority.ts` のtranscriptSnapshot、applyCommitted、proposalSuffix（254付近）。現在は全文件数をprefix長としてsliceする。 |
| generation／完了state | `v0/agent/data/session_data_owner.ts` のgenerationContext（513付近）、#executions、#recordTerminal（1520付近）。 |
| Data会話projection／索引 | `v0/agent/data/conversation_writer.ts` のbeginExecution（185付近）、snapshot／watch（367付近）、全文facts読取（435付近）、releaseSession。 |
| loop／commit | `v0/agent/core/loop.ts` のturn開始snapshot、request投影／観測、tool結果追記、commit proposal。 |
| 入力証跡／位置 | `v0/agent/worker/worker_runtime.ts` のcanonical attribution（949付近）、append-only検査（1175付近）、新規messages抽出（1269付近）、privateState／checkpoint境界。 |
| 型・相関 | `v0/agent/worker/worker_protocol.ts`、`v0/agent/session/session_store_contract.ts`、Data／Agent直接channelのcontract。 |
| 前置context／checkpoint | composition／instruction構成、`v0/agent/session/semantic_context.ts`、`v0/agent/history/context_attribution.ts`。 |
| モデル容量／設定／wire | `v0/agent/provider/provider_declaration.ts`、model_catalog.ts、model_selection.ts、openrouter_request.ts、openai_responses_model.ts。 |

正本はrepositoryのAGENTS.mdと、そこから参照されるarchitecture／roadmap／各incrementを確認する。
旧pre-turn automatic compactionと64KiB tool-result機械的省略は停止済み。A3の将来Context Strategyは未採用候補であり、今回の承認範囲へ暗黙に入れない。

## Pi／OpenCode／Codexから参考にする機構

2026-10-08に公開sourceを確認した。公開branchのsnapshotであり、利用者のインストール済みbinaryと同一とは主張しない。

- Pi main `ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`：prompt／tool情報と会話変換の分離、provider/model別reserveTokens／keepRecentTokensの上書き。
  [context拡張](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/docs/extensions.md#L103)、[モデル別設定](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/docs/compaction.md#L439)。後者はcompactionの設定であり、Henjiの通常input予算と同一ではない。
- OpenCode dev `5d9cd9b259f0456522f318a7435501d03cfbee79`：前置systemの構成と拡張、モデル容量と予約量、compaction時の最新tail選択。
  [前置context](https://github.com/anomalyco/opencode/blob/5d9cd9b259f0456522f318a7435501d03cfbee79/packages/opencode/src/session/llm/request.ts#L56)、[tail選択](https://github.com/anomalyco/opencode/blob/5d9cd9b259f0456522f318a7435501d03cfbee79/packages/opencode/src/session/compaction.ts#L223)。常時latest suffix制限の実装という意味ではない。
- Codex main `be2e129ecd67d900c016eda12d5d193e33d9c3da`：context容量とcompaction閾値の分離、prefix／追加context／圧縮履歴の再構成。
  [再構成](https://github.com/openai/codex/blob/be2e129ecd67d900c016eda12d5d193e33d9c3da/codex-rs/core/src/compact.rs#L79)、[公式設定](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)。`body_after_prefix`は引き継いだcompaction windowのprefill baselineを差し引く設定で、instruction／tool量だけを差し引く意味ではない。

各実装のdefault値、自動要約、全履歴のRAM保持方式をそのまま採用する要求はない。
これらのcontext機構がHenjiのメモリ増加停止を保証するという根拠にも使わない。

## レビュー結果とLinux側で決めること

通常レビュー・批判的レビューはともに「要補足で進める」。上記へ次の指摘を反映済み。

- 現在turnを含むrequest全体の予算と、turn内の境界変更。
- 容量値の情報源、不明model、出力予約の対応。
- 本文に加えて完了execution registry／索引の件数も抑えること。
- window変更時の証跡、保存位置とwindow位置、軽量metadataの全件読込回避。

計画では、計数方式、設定の配置と優先順、予算不足時の動作、範囲取得・位置・commit・証跡の契約、後処理解放時点、DB変更と既存データの扱い、スパイクの具体的観測条件を決める。
利用者の入力方針や全文保存を変更しないと成立しない場合は、その理由と具体的な選択肢を利用者へ戻す。

Linux側の出力は、対象repositoryの規約に沿った計画、スパイクの成立範囲／失敗理由、残る実装範囲、受入結果。
ここで未確定の実装詳細はLinux側で決めてよい。目的・採用済み要求・対象外を黙って変えない。
