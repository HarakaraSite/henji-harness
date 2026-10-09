# Increment 221: モデル容量に応じた入力予算とターン内の切り詰め

## 1. 状態・目的（2026-10-09）

local実装・検証完了。利用者の「1、2を合わせて次のインクリメントとして計画してください」に基づく計画に対し、
2026-10-09に各スライスの実装・test・reviewと、increment末尾のe2e・最小限の実provider利用を承認した。
この実装承認にはcommit/push・常用配置を含めなかった。続く利用者の「コミット配置して」により、
221のcommitと常用binary配置を承認した。push・公開・正本文書の変更は含めない。

モデル容量に対して小さすぎる固定予算で通常利用が止まる問題を解消し、長い一つのターンでも、
入力予算を超えた際に古いtool交換を送信対象から外して作業を続けられるようにする。
送信対象から外した情報の全文は保存履歴に残す。自動要約によるコンパクションは後続incrementとする。
切り詰めて完了した直近ターンも必要な文脈を再投影し、次ターン・Session再開へ渡せるようにする。

### 合意済みの要件

- 入力全体の既定予算を、選択モデルのcontext windowの80%とする。
  instruction、tool定義、checkpoint/recall、過去会話、現在ターン、provider固有のreasoning/replayを含む。
- 現在ターンにも予算に合わせた切り詰めを適用する。
  assistantのtool呼出しと対応する結果を一組として扱い、古い組から送信対象外にする。
- 予算の拡張とターン内の切り詰めを先に実装し、コンパクションは今回実装しない。
- searchの出力量・gitignore・mode命名の改善は別件であり、今回の対象に含めない。

以下の容量取得、未知容量、保持単位、停止条件、検証手順は、この計画で具体化する実装案である。
実装前に確認が必要な外部metadataの項目・対応関係を、確認済みのprovider仕様として扱わない。

## 2. 根拠と現行の利用経路

### 2.1 通常利用で観測した停止

source基準は`9eae73c1`。対象はOpenCode Go Chat / `deepseek-v4.1-flash` / effort maxの Session
`7814247a-916e-4211-a2fd-e351b1bfb4cd`、 execution `287fd3fc-8777-410a-bf4e-d34927a500bb`。
過去ターンを持たない最初のターンで、model request 5回とtool結果10件の後、次の送信準備が停止した。

- 入力全体の推定46,933 tokensは既定入力上限65,536以内だった。
- 現在ターンの会話推定33,099 tokensが、別枠の既定`historyTokens=32,768`を超えた。
- 最終会話のadapter変換後messagesは99,033 bytes。tool結果本文は合計70,658 bytesだった。
  モデルに送るmessagesの5 MiB上限に達した事例ではない。
- `context-budget.json`はなく、固定既定値による停止だった。
- execution全文は保存されたが、TUIは`FAILED · invalid input`と表示し、原因が分かりにくかった。

これは現在の固定予算と「現在ターンだけで超過したら停止」という経路の問題である。
以前の長い実行が巨大なcontextを送って成功していたことを踏まえ、コンパクションの完成を待たずに
利用可能な容量を回復する。今回の切り詰めには情報の省略が伴い、要約による保持は後続の課題として残る。

### 2.2 操作から送信・保存まで

1. TUI/CLI/APIがSessionを開き、CoreからAgent Workerを起動する。
   Coreの`live_model_catalog.ts`がprovider catalogとmodels.dev metadataを所有する。
   現状では主にmodel IDとeffortを取り込み、容量情報は利用していない。
2. `worker_bootstrap.ts`が選択モデルのadapterと`context-budget.json`のsnapshotをWorkerへ渡す。
   `context_budget.ts`が固定既定値とprovider/model設定を合成する。
3. `core/loop.ts`が現在のtask、steering、assistant、tool結果の全文を保持して進行する。
   `worker_runtime.ts`のrequest projectorがcheckpoint/recallと過去の完了ターンを選び、
   `contextCost()`で実adapterのwire変換後サイズを測る。
4. 現行projectorは現在ターンが単独で超過すると停止する。収まる場合だけ、過去ターンを新しい順に
   一ターンずつ追加する。投影後のrequestをloopがsnapshotしてadapterへ送信する。
5. requestの出典・budget factは既存context attributionへ記録される。 loopの全文、draft、execution
   proposal、canonical履歴は送信projectionとは別に保存される。

変更はこの経路へ組み込み、別の履歴所有者やWorker独自のcatalog取得経路を新設しない。 hook
viewが使う予算解決も揃えるが、hook用の完了履歴に現在ターンの交換単位を適用しない。

## 3. 入力予算

### 3.1 定義と計算

| 記号 | 意味                           | 取得元                                                 |
| ---- | ------------------------------ | ------------------------------------------------------ |
| C    | 入出力を合わせたcontext window | 明示設定、選択routeに対応した容量metadata              |
| q    | 入力に利用する割合。既定0.8    | `inputRatio`設定案                                     |
| I    | 入力だけの上限                 | 明示`inputTokens`、確認できたprovider入力上限          |
| R    | 出力予約                       | adapterが実requestで指定する値、または明示した運用予約 |
| L    | 今回の入力全体の上限           | 以下の計算結果                                         |

```text
L = min(floor(C × q), I, C − R)
```

値が不明な項は比較から外す。Cが不明なら`C × q`と`C − R`を使わない。
80%を適用した後にRをもう一度引くことはしない。 input-only上限をcontext
windowとして80%計算へ流用しない。

DeepSeek直接APIの公表C=1,048,576と、現行Chat adapterのR=65,536を用いる例では、
`floor(C × 0.8)=838,860`、`C − R=983,040`なので、Iがこれより小さくなければL=838,860となる。
これは計算例であり、OpenCode Go routeの保証容量を意味しない。
[DeepSeek公式model一覧](https://api-docs.deepseek.com/api/list-models/)と
[OpenCode Go公式route説明](https://docs.opencode.ai/docs/go/)を参照する。

既定`historyTokens=32,768`と、容量不明時の既定入力65,536を廃止する。
会話には、prefixを含めた入力全体がLに収まる範囲を使う。
利用者が明示した`historyTokens`は追加の会話予算として適用するが、未設定時に固定上限を補わない。
現行adapterのmessages 5 MiB / request body 6 MiB等のbyte制約は独立して適用し、拡大しない。

### 3.2 容量・設定の解決

- 設定値は項目ごとにprovider/model指定、provider指定、defaultsの順で優先する。
  `contextTokens`、`inputTokens`、`outputReserve`、明示`historyTokens`を扱い、`inputRatio`を追加する案とする。
- 容量metadataは既存Core
  catalogの所有下で取得・正規化し、選択provider/model/APIに結び付けてWorkerへ渡す。
  明示設定を優先し、未指定項目にroute対応のprovider metadata、次にmodels.dev metadataを利用する。
  出典と値の意味を保持し、models.devによる推定とprovider契約による値を区別する。
- provider/modelの対応は既存宣言と実際のmodel IDで確認する。
  同じモデル名でも、直接APIとGo等の中継routeの容量が同一とは推測しない。
  確認できない対応は未知とする。既知モデルだけを並べた新しい固定容量辞書は作らない。
- metadata取得・cache・起動/モデル変更の受渡しは既存catalog経路を使う。
  Agentから別途全catalogを取得せず、毎model requestで外部metadataへ問い合わせない。
  S1で現行の取得タイミングと項目を確認し、容量snapshotが使える最短の経路を確定する。
- 設定は現行と同じWorker起動時snapshotとし、新Workerから適用する。
  idle時のモデル変更では、新しい選択に対応する容量を解決する。設定reloadや設定編集UIは追加しない。

RはChat adapterの実送信値を優先する。Responses adapterは現状`max_output_tokens`を送らないため、
公表最大出力を実際の予約として扱わない。明示運用予約がなければRは未知として記録する案とする。
このincrementでadapterの出力設定、effort、モデル、APIを変更しない。

### 3.3 未知容量と推定精度

未知容量では、小さな仮のtoken上限を新設して通常利用を止めない。 既知のI、明示会話予算、既存wire
byte制約を適用し、それ以外はproviderの容量判断に委ねる案とする。
この場合は「80%に収まる」とは表示せず、Cとratio由来のLが未解決であることを診断へ記録する。
Goの容量対応が取得できなければ、routeを調査した結果と必要な明示設定を報告する。
metadataが不明という理由で固定32,768/65,536へ戻さない。

初回は既存の`wire UTF-8 bytes / 3 + framing`推定を継続する。 実測request
#5では推定45,108に対しprovider usage34,743だったが、この一例を全モデルの補正率にしない。
80%は推定入力の運用予算であり、厳密なtokenizer計数ではない。
既存usageと推定を比較できるfactを残し、専用tokenizer・動的な比率補正・provider超過時の自動retryは追加しない。

## 4. 現在ターンと直近完了ターンの送信projection

### 4.1 保持単位

送信選択用に、全文の元message位置を参照する交換単位を構成する。

- tool交換はassistant responseと、その全tool callに対応する全結果を一単位とする。
  並列toolのbatchを分割しない。callだけ、resultだけを残さない。
- assistantの本文・reasoning・providerStateは、そのresponseと一緒に扱う。
  ChatのreasoningとResponsesのreplayItemsをadapter変換後にも対応させる。
- toolを呼ばないassistant responseは単独のresponse単位とする。
- 現在の最初のuser taskと、受理済みsteeringをすべて保持し、元の時系列を維持する。
- 直近の交換単位または継続に必要な最新assistant responseを保持する。 途中のtool
  batchが未完了なら、完了するまで切り分けて送信しない。

単なるmessage数の`slice`ではなく、元のresponse範囲とcall/result対応を使って選択する。
保持するresponseのprovider stateから必要な部分を独断で取り除かない。

### 4.2 選択順序

1. instruction、tool定義、checkpoint/recallと現在ターン全文だけで実wireを測定する。
2. 収まる場合は、直近完了ターンの全文を追加して測定する。
   全文が収まらなくてもそのターンを丸ごと諦めず、第4.3節の規則で再投影する。
   直近ターンが全文で収まった場合だけ、さらに古い完了ターンを全体単位で新しい順に追加する。
   直近ターンを部分選択した後は、さらに古いターンを追加しない。
3. 現在ターンだけでも収まらなければ、過去ターンを追加せず、現在ターンの古い交換単位から外す。
   各候補を実adapterのwire変換後に測り、token予算と既存byte制約の両方に収める。
4. 一度外した現在ターンの単位は、同じexecution中には再投入しない。
   ターン内切り詰め開始後、そのexecutionでは過去ターンも再投入しない。
   この境界はexecution内の送信選択状態であり、新しいユーザーターンではリセットする。
   次ターンの直近履歴は保存全文から第4.3節で選び直す。保存履歴を削除しない。
5. 保護対象だけでも収まらなければ停止する。どの制約に対してどれだけ超過したかを記録・表示し、
   task、steering、結果全文と実行状態を保存する。

instruction、tool定義、checkpoint/recall、task、steering、最新の交換単位は今回切り詰めない。
単一の巨大なtool結果、またはこれらの合計が上限を超える場合は停止し得る。
この限界は、古い交換を外せる通常ケースと分けて扱う。tool本文の文字数切断や自動要約は今回導入しない。

### 4.3 直近完了ターンの再投影とSession再開

現在ターンの切り詰めで実行を完了しても、保存全文は予算を超えたままになる。
現行の「完了ターン全文が入らなければ追加を止める」規則だけを残すと、次の
「さっきの結果を続けて」に最終応答さえ渡らなくなるため、この経路もS2で置き換える。

直近完了ターンの全文が、prefixと現在ターンを合わせた予算に収まらなければ、
第4.1節と同じ交換単位で古い側から外し、残る入力全体を実wireで測定する。
直近ターンの最初のtask、受理済みsteering、最後の完全なtool交換（存在する場合）、
最終assistant応答を保持する。最終応答のproviderStateもresponseと一緒に扱う。
この必要範囲が現在ターンと合わせて収まる限り、全文の超過を理由に直近ターンを全落ちさせない。
選択したmessageは元の時系列・元位置を維持し、新しい現在ターンの前へ配置する。

同じSession/Workerでの次ターンと、新WorkerでのSession再開に同じselectorを使う。
再開時も保存されたsemantic全文から同じ単位を構成できるようにし、
前WorkerのRAM内の選択結果や新しい要約・別の履歴保存先に依存しない。
予算は再開時の実際の選択モデル・設定で解決するため、元の送信内容の無条件な再送はしない。
checkpointで既に対象外となった履歴を、この規則で復活させない。

現在ターンが成長した場合も、合成した入力全体を再測定し、過去側の古い交換から再選択する。
現在ターン自体の切り詰めが必要になった後は、第4.2節に従って過去ターンを再投入しない。
直近ターンの必要範囲さえ現在ターンと合わせて収まらない場合は、現在ターンを優先し、
その履歴が送信対象外になった理由と範囲を記録・表示する。
現在ターンの保護対象の超過による停止と、過去文脈を選べない限界を区別する。
この限界を自動要約で補う処理は、後続コンパクションの範囲とする。

### 4.4 全文保存・出典・実行状態

選択結果はmodel request専用のprojectionとする。loop transcript、draft、proposal、canonical履歴、
checkpointの保存内容を選択結果で上書きしない。 元のmessage/responseの位置・logical
identityを保持し、選択後の連番を元履歴の番号として記録しない。 source sidecar、context
occurrence、差分/spliceと実際の送信内容を一致させる。

root、child、headlessの現在ターン送信に同じ選択規則を使う。
予算は各Workerの実際の選択provider/modelとadapterに対して解決する。
別モデルを指定したchildへ親の容量・出力予約を流用しない。
共通loopの変更だけで届かない経路はS2で確認して同じselectorへ接続する。 補助toolの独立HTTP
requestに、会話の交換単位を持ち込まない。
既存の過去履歴の段階読出しを維持し、候補評価のたびに全保存履歴を読込・cloneしない。

現在ターン全文の保持は続くため、この変更は長い一ターンのRAM使用量を一定にするものではない。
送信予算の改善と、全文のメモリ保持・保存方式の最適化を混同しない。

## 5. 人間への表示とreadback

初めてターン内切り詰めが起きた時に、古いtool交換等を送信対象から外し、全文は履歴に保存している旨を
短く表示する。毎requestの通知で画面を埋めない。要約済みであるかのような表示はしない。

保護対象の超過は`context_budget_exceeded`として扱い、現在の汎用`invalid input`だけで終わらせない。
既存のfailure/terminal経路で、入力推定値・有効上限・byte制約・保存されたことを確認できるようにする。
他のrequest構築失敗をこの原因へ一括変換しない。

既存context attributionのbudget factへ、選択route、C/I/R/q/L、容量の出典・未知項目、
推定profile、wire bytes、保持/省略した元範囲・単位数、過去ターン選択を記録する。
直近完了ターンの部分選択も、元execution/turn/message位置に結び付けて記録する。
部分選択したことと、必要範囲も収まらず全落ちしたことを区別してreadbackできるようにする。
readbackで「何を送ったか」「何を送らなかったか」と保存全文を対応付けられるようにする。 raw
request/responseを常設収集せず、credential/Authorizationは記録しない。

## 6. 実装スライス

| スライス              | 成立させる動作                                                                   | 主な変更範囲                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1 容量と予算         | 選択モデルの80%入力予算。固定既定会話予算の廃止                                  | `context_budget.ts`、既存provider catalog/metadata、CoreとWorkerの起動・モデル選択受渡し、必要なAPI/Worker契約 |
| S2 ターン内projection | 古い交換単位を外して継続。直近完了ターンも再投影し、全文保存と出典を維持         | `worker_runtime.ts`、共通loop/contracts/execution context、Chat/Responsesのwire測定・state対応                 |
| S3 診断と表示         | 切り詰めと残る超過理由を人間とreadbackへ提示                                     | 既存context attribution、failure details、terminalイベント、TUI状態・表示                                      |
| S4 実経路確認         | 観測済み停止の解消、前結果を使う継続・再開、モデル変更/child予算、短いメモリ観測 | focused test、隔離localhost provider、standalone Core/CLI/TUI、結果記録                                        |

S1で容量metadataの実項目、CとIの意味、Goの対応、既存cacheの更新時点を確認する。 不明なmetadata
schemaを推測して実装しない。確認結果を本書へ追記し、未知は第3.3節の経路で扱う。
既存の固定既定値と現在ターン即停止分岐を置き換える。
直近完了ターンについては、全文超過で候補選択を打ち切る分岐を共通selectorによる再投影へ置き換える。
さらに古い完了ターンの全体単位選択は維持する。
旧計算を別経路に残したり、互換用の二重selector・二重budget保存先を追加したりしない。

## 7. 確認と受入

### 7.1 product動作に対応するfocused確認

- 観測Sessionの保存messageを隔離環境へ読み出し、同じadapterで最終候補を構築する。
  対応容量が解決された予算で、元の32,768制約だけを理由に停止しないことを確認する。
  元Sessionを更新せず、元のbash/read等を再実行しない。
- 実送信のC/I/R/qと出典を使ってLが決まり、prefix/tool定義/reasoning/replayを含むwire全体が
  評価されることを確認する。明示会話予算、未知容量、実出力予約のないResponsesは各々の合意案を確認する。
- 容量が異なるモデルを持つlocalhost providerで、rootのidleモデル変更前後にrequestを行い、
  route・C/I/R/q/L・出典とadapterの実出力予約が選択モデルに対応することを照合する。
  親と異なるモデルを指定したchildでも同じfactを照合し、親の容量・予約が流用されないことを確認する。
- 隔離した明示小予算で複数tool交換、並列batch、途中steeringを含む長いターンを実行する。
  古い交換の省略後にも次のmodel request、最後の応答、短い次ターンが成立することを確認する。
  task/steering/最新交換とcall/result対応、切り詰め境界の単調性を確認する。
- 上記の長いターン完了後、前の結果を指すfollow-upを同じWorkerで実行する。
  保存前ターン全文は予算超過、保持する必要範囲と新taskの合計は予算内となる負荷を使い、
  次requestへ前task/steering・最後のtool交換・最終応答が元位置付きで渡ることを照合する。
  長いターン完了直後の保存状態を隔離コピーで分岐し、新Worker再開でも同じfollow-upを行う。
  同じ予算・同じ直近完了ターンから必要範囲が選択されることを確認し、
  同じWorkerで実施したfollow-upの履歴を、再開確認の直近ターンとして使わない。 localhost
  providerは前結果の識別子がrequestにあることを確認して応答し、
  request送信が成功しただけで文脈継続の成功とは判定しない。
- ChatとResponsesの実wire builderで、保持したreasoning/replay、call ID、source位置を照合する。
  request readbackと保存全文を比較し、省略した交換もproposal/canonical履歴から読めることを確認する。
- 保護対象だけで超過する場合は全文保存と具体的な停止理由を確認する。
  新しい規則と競合する既存「現在ターン超過なら常に停止」testは修正し、旧動作を維持するための制約を残さない。

### 7.2 実経路とメモリ観測

隔離XDG/workspaceとlocalhost providerを使い、standalone Coreから同じSession/Workerで長い一ターンと
前結果を参照する短い確認会話を行う。
rootの送信・tool実行・最終応答・保存readbackと、新Worker再開後の文脈継続まで照合する。
headlessのselector到達と、rootのidle変更/異モデルchildでの容量再解決も、
第7.1節に対応するfocusedな統合確認で確かめる。 TUI通知と停止表示はtmux上のproduction
TUIで確認する。実config/default selectionを更新しない。

上記の長いターンに合わせ、起動後・Session開始前・切り詰め前後・実行中最大・終了30秒待機後の
RSS/PSS、取得可能な各context heapを記録する。
保存全文量、選択wire量、request数を添え、送信量が抑制されたこととRAMの挙動を分けて報告する。
この確認のために別の200ターン測定や長時間耐久runを追加しない。

実装中はfocused test、必要なtype check、format、lint、`git diff --check`を使う。 full
gateの反復は行わず、この計画ではfull gateを受入条件にしない。 各スライスは実装・focused
test・reviewを行ってから次へ進み、increment末尾でe2eを実施する。
最小限の実provider利用は2026-10-09の利用者指示で承認済み。offline/localhost確認後に、
対象route・回数・隔離保存先を具体化して提示し、最後に実施する。過去incrementの許可は流用しない。

受入では、通常利用の固定予算による停止が解消されること、切り詰め後にも実行が継続すること、
長い完了ターンの必要範囲が収まる場合に次ターン・再開へ引き継がれること、
idle変更と異モデルchildで選択モデル自身の予算が使われること、
保存全文と送信projectionが一致する出典で確認できること、人間が省略/停止理由を読めることを確認する。
test件数を目標にせず、結果、容量の未確認事項、巨大な保護対象の限界を本書へ記録する。

## 8. 対象外と正本文書への反映案

自動コンパクション、要約生成、個別tool本文の切断、search改善、履歴を再取得する新tool、
モデル自動切替、context超過retry、設定reload、履歴schema移行、過去データ削除は対象外。
commit/push・常用配置・公開は実装計画の受入とは別の利用者指示に従う。

Increment 218の「現在ターンは切らず超過なら停止」という設計は、今回の明示要件で置き換える。
218の結果を遡って書き換えず、変更後の要件と結果を221へ保持する。
通常利用メモのsearch候補は未採用のまま、その正本に残す。

architectureには、全文状態の所有を維持したままmodel
projectionだけを切り詰め、直近完了ターンの必要範囲も再投影する責務と、 Core
catalogから選択容量を渡す境界を追記する案がある。
roadmapには、モデル容量連動予算とターン内切り詰めの実装状態、コンパクション未実装を反映する案がある。
構想の目的・人間による採用境界は変更しない。
これらは案に留め、構想・architecture・roadmapの正本は、対象・理由・意味上の変更を提示して
利用者の別途明示承認を得るまで編集しない。

## 9. 結果

S1〜S4の実装・focused test・独立reviewと、最終compiled localhost／実provider e2eを終えた。
結果・途中失敗・制約は第11節。続く全体reviewを終え、利用者指示でcommit・常用配置も完了した。
pushと正本文書への反映は対象外。

## 10. 計画レビューと指摘反映（2026-10-09）

利用者の明示依頼で通常レビューと批判的レビューを独立して実施した。
通常レビューはP2の受入確認不足1件、批判的レビューはP1の次ターン文脈脱落1件。 80%予算、provider
stateを交換単位で扱う方針、保存全文と送信projectionの分離は妥当と評価された。 Go
routeの容量metadataとWorker受渡しの具体化は、S1で確認する未確認事項として残る。

- **P1採用・計画へ反映:** 現行の完了ターン選択経路をread-only Deno evalで確認したところ、
  前ターン全文4,274 estimated tokens、必要範囲196 tokens、L=2,000の条件で、
  次requestは継続指示一件だけになり、`selectedTurns=[]`だった。
  未実装の221全体の再現ではなく、当初計画が維持していた全文単位選択の問題である。
  第4.2〜4.4節へ直近完了ターンの再投影・新Worker再開・出典保持を追加し、
  S2/S4と第7節へ前結果を指すfollow-upの送信内容照合を追加した。
- **P2採用・計画へ反映:** idleモデル変更と独立child起動は容量snapshotの受渡しが異なる経路であり、
  selectorの到達確認だけでは選択モデルへの再解決を確認できない。
  実在する誤動作の指摘とは区別し、第7節へroot変更前後/異モデルchildのbudget fact照合を追加した。

利用者の「修正してください」に基づく計画修正。文書のformat確認と`git diff --check`は成功。
実装・実provider利用は未着手であり、修正後の計画の再レビューは未実施。

### 10.1 再開時の限定再確認（2026-10-09）

利用者の「作業を続ける」により再開し、defaultが修正後の計画と関連する現行sourceを照合した。
前回の独立reviewの再実行ではなく、採用済みP1/P2の反映と実装開始前の経路確認に限定した。

- P1: `worker_runtime.ts`の現行projectorは直近完了ターン全文が予算に収まらないと
  履歴追加を打ち切る。第4.3節・S2はこの分岐を交換単位の再投影へ置き換え、最終応答と
  必要な直近交換を保持する。第7.1節は同Workerでのfollow-upと、長いターン完了直後の
  保存状態から分岐した新Worker再開を別々に照合するため、前回指摘の経路と確認方法が対応している。
- P2: rootは`generationBasis.modelSelection`から選択を更新する一方、異モデルchildは
  `worker_host_children.ts`で独立した選択・Worker起動へ進む。S1の受渡し変更と第7.1節の
  root変更前後・異モデルchildの容量/出力予約fact照合が、両方の経路に対応している。
- 共通loopはprojectorの返したrequestを送信用にsnapshotし、proposalはloopの全文transcriptから
  作る。第4.4節のprojectionと全文保存の分離は、この既存の状態所有に沿っている。
- 現行catalogのmetadata正規化はeffortが中心であり、容量snapshotは未実装。
  容量metadataの実項目・C/Iの意味・Go routeとの対応・CoreからWorkerへの具体的受渡しは、
  S1の調査事項として残る。今回、外部metadataやprovider容量契約を新たに検証したとは扱わない。

この限定確認で追加の計画修正は見つからなかった。実装correctnessとproduct受入は未確認であり、
実装・test・localhost統合確認・実provider利用は行っていない。実装開始の明示指示待ちを維持する。

## 11. 実装・確認記録

### 11.1 開始承認とS1外部metadata確認（2026-10-09）

利用者は「各スライスごとに実装テストレビューを行い インクリメントの最後にe2eテストを行なって
最小限の実プロ利用を認める」と指示した。S1〜S4を順に進め、各スライスの確認結果を本節へ記録する。
commit/push・常用配置・正本文書の別途承認境界は維持する。

[models.dev公式repository](https://github.com/anomalyco/models.dev)のREADMEで、
`limit.context`、`limit.input`、`limit.output`が別項目であり、provider向け上書きが生成APIへ
反映されることを確認した。公表最大出力を実requestの予約へ変換しない。
[公開API](https://models.dev/api.json)の取得snapshotを
`.tools/increment-221-metadata/models-dev.json`へ保存した。

同snapshotのprovider `opencode-go`は`api=https://opencode.ai/zen/go/v1`で、
`deepseek-v4.1-flash`は`limit.context=1,000,000`、`limit.output=384,000`。
本環境の`opencode-go-chat`宣言のendpointとmodel IDが一致する。直接APIの容量からの類推ではない。
これはmodels.dev metadataによる容量推定であり、Goの保証契約としては扱わない。 現行Chat
adapterの実予約65,536とq=0.8では、別の明示制約がなければ入力予算L=800,000となる。

通常利用で停止したexecutionの保存message 11件と直近requestのinstruction/tool定義を、
本workspaceのDBからread-onlyで読み出し、`.tools/increment-221-metadata/observed-*`へ保存した。
元Sessionの変更と元tool操作の再実行は行っていない。実装後の送信候補確認へ利用する。

### 11.2 S1実装・focused確認・初回review

固定H/L/Rを未設定時に補う処理を廃止し、C/I/q/実adapter予約から入力全体の予算を解決する。
metadataは既存catalogで正規化し、明示provider対応またはendpointとmodel IDの一致から選択する。
Coreのsingle-route resolverを起動・idleモデル変更・childのHostへ渡し、Workerへ容量snapshotを送る。
hook用の予算も同じresolverへ揃えた。provider-freeの確認経路はmetadata通信を行わない。

S1のfocused test（容量計算・catalog対応・Core→Worker起動とprovider-free・実wire予約）9件、
既存checkpoint/recall・保存/window確認4件と、現行hook contractへfixtureを更新したhook確認3件が成功。
変更source/testのtype check・format・lintと`git diff --check`も成功した。
通常利用で停止した保存履歴の実adapter再構築は、input=46,933、history=33,099を再現し、 新budget
C=1,000,000、q=0.8、R=65,536、L=800,000、history既定なしでwire制約内だった。
結果は`.tools/increment-221-metadata/observed-replay-result.json`。実providerと元toolの再実行は0。

独立S1 reviewではP2を一件採用した。実CLIの`hjh run`は既存のstandalone headless Hostを通り、
Coreから注入するresolverを持たないため、既知容量でもC/I/Lが未知になる。
この実利用経路もS1で修正する。headless Hostから既存`LiveModelCatalog`を再利用してresolverを渡す。
Agent Workerに取得処理は追加せず、Coreからresolverを受け取る通常経路に二重catalogを作らない。
この違いはS1開始時の経路確認で具体化できていなかった実装詳細であり、headlessの予算要件は変更しない。
初回reviewでその他の採用対象P1/P2はなかった。

S1の修正後focused testは10件成功。headlessの実入口から起動commandへの容量snapshot受渡し、
隔離localhost metadata取得一回、short factの保存readbackを確認した。 これは実Agentのmodel
request確認とは区別する。変更source/testのtype・format・lint・diff確認も成功。
限定再reviewでP2解消と新たなBlocker/P1なしを確認し、S2へ進んだ。 通常productionと同じDeno
fetchでも公開metadata endpointがHTTP 200を返すことを確認した。
rootのidle変更前後・異モデルchildの実request fact照合はS4に残る。

### 11.3 S2実装・focused確認

現在ターンのrequest projectionを交換単位のselectorへ置き換え、古い完全な単位から外す。
assistantのtext/stateと全call/resultを一緒に扱い、task・受理済みsteering・最新単位を保持する。
省略はexecution内で単調に保持し、現在ターンの切り詰め開始後は過去ターンを再投入しない。
直近完了ターンは全文から必要範囲を再投影し、それが部分選択になった場合は古いターンを追加しない。
複数の過去ターンを全文で選ぶ場合は元の時系列を維持する。

proposalはloop全文のまま保存し、Data読出しportがない局所経路も全文proposalを履歴へ追加する。
選択messageとsource sidecarは元位置で対応させる。budget
factに現在/直近履歴の保持・省略範囲を記録し、
容量Iを`inputCapacityTokens`へ残す。`inputTokens`は実requestの推定入力として維持する。

新しいS2確認2件と既存context-window・wire-budget確認7件、計9件が成功した。
並列batch、steering、省略の単調性、全文proposal、同Worker/新Workerで同じ全文履歴からの再投影、 Chat
reasoningとResponses replay、元のmessage locatorを確認した。 type
check・format・lint・`git diff --check`も成功。独立reviewを終え、採用すべきP1/P2はなかった。

### 11.4 S3実装・focused確認

現在ターンの切り詰め、履歴の部分選択・選択省略、保護対象超過を`context_notice`として保存する。
同じexecutionでは種類ごとに一度通知し、全文の保存とmodel入力からの省略を区別する。
予算factには既知のmessage/body byte上限も記録する。 保護対象超過はtyped
errorの`failureFact`から`context_budget_exceeded`へ分類し、
入力推定・有効上限・byte情報を短い説明と保存factへ残す。他のrequest構築失敗の分類は維持する。

通知は既存semantic journalの`context_update`からconversation execution metadataへ投影し、
実行中・settlement後・履歴replayのTUIで保持する。CLIのJSONとstream出力にも接続した。
現行productionにはAgentEventからlocal PresentationEventへ渡すadapterがなく、通常TUIは
conversation/RemoteSystemNoticesを使うため、その実経路を変更した。 既存presentation側は新failure
codeと人間向け表示名を揃えた。

focused確認36件が成功した。Workerの通知・全文保持・履歴再投影・予算超過分類に加え、
実SqliteHistoryStoreへのsemantic保存とreplay、settlement後の保持、TUIのactive/completed/reconnect通知、
CLI
JSON/streamを確認した。旧error文言を見ていた218の確認は診断codeと追加requestなしの確認へ更新した。
変更15ファイルのtype check・format・lintと`git diff --check`も成功。 独立reviewを実施中。production
TUIの表示・操作確認は最後のcompiled e2eで行う。

初回S3 reviewではP2一件を採用した。CLI既定text modeはsinkを無効にしており、
成功した切り詰めの通知が通常の`hjh run`へ届かない。JSON/streamだけの接続では第5節を満たさない。
既定text modeもcontext noticeだけstderrへ送り、最終応答のstdoutを維持するよう修正した。 実CLI
`main`の入口でsink、notice-only stderr、最終stdoutを確認し、deltaのfocused確認17件が成功。
変更のtype・format・lint・diff確認も成功。限定再reviewでP2解消と新しいBlocker/P1なしを確認した。
S4へ進む。production TUIの受入確認は最後のe2eに残る。

### 11.5 S4開始・観測済み停止のWorker経路確認

通常利用で停止したexecutionのassistant応答5件と保存tool結果10件をオフラインで再生した。
元tool操作と実providerは実行せず、同じChat adapterのwire測定を使うWorkerGenerationで 6回のrequest
selectorへ到達し、元の停止地点の11 messageと最終requestが完全一致した。
全文proposalの元messageも一致した。

input=46,933、history=33,099、C=1,000,000、q=0.8、R=65,536、L=800,000、 history既定なしで、全11
messageを保持したまま最後のオフライン応答まで進んだ。 message/body
bytesは121,148/140,487、既存byte上限は5,242,880/6,291,456だった。
証跡は`.tools/increment-221-metadata/observed-worker-replay-result.json`。 実provider request
0、元tool操作0。これは保存データによるselector確認であり、実provider受入の代替にはしない。

### 11.6 S4モデル選択・childの実Core確認

実Coreとproduction Workerをlocalhost Chat providerへ接続し、保存されたmodel request factを読んだ。
rootはidleモデル変更の前後、childは親と異なるmodelを選んだ`spawn_subagent`経路で確認した。
選択provider/model/API/auth profile/effort、C/I/q/R/Lと出典、実bodyのmodelと
`max_completion_tokens`を照合し、rootの変更後とchildへ自身の容量が渡ることを確認した。

focused test 2件、type・format・lint・`git diff --check`が成功。
変更は`tests/v0/increment_221_routes_test.ts`のみで、productionの不具合は観測しなかった。
rootのidleモデル変更前後で保存Worker generationが同じであることも追加確認した。

初回独立reviewでproductionのP1/P2はなかった。e2e driverのP2二件を採用した。 semantic request
readbackは論理model step数と照合し、HTTP再試行を含む物理request数とは別に記録する。 exact
Session再開でもmaxStepsとtimeoutをactivationへ渡すよう修正した。
real確認は3ターン・各4論理step以下、通常6物理requestを想定する。既存Chatの最大3回送信を
含む絶対上限は12論理step／36物理requestであり、再試行のproduction動作は変更しない。
修正箇所に限定した一回の15分以内の再reviewで二件の解消と新しいBlocker/P1なしを確認した。
S1〜S4の各実装・focused test・reviewを終え、最終compiled e2eへ進む。

### 11.7 最終compiled e2eの準備・隔離手順

常用binaryへ配置せず、221候補を`.tools/increment-221-e2e/hjh`へcompileした。 build
`19063d50…`、runtime `c61f9b6c…`、binary SHA-256
`1f43c3191b6f7ee345306a2afc633ff197566344dc61846285413b1dc52b6d04`。
S4の変更はtestだけであり、このbinaryのproduction sourceからの追加変更はない。

最初のlocalhost手順はfixture credentialを0600にしていなかったため送信前に停止した。 次の手順はlong6
requestとfollow1 requestが成功した後、branch DBディレクトリが
既存storeの0700契約に合わず新Core起動前に停止した。両方とも手順の設定を修正し、
失敗した隔離先を保持した。production sourceの不具合ではなく、実provider requestは0。
証跡は`localhost-20261009T181239`と`localhost-20261009T181353`。
次の`localhost-20261009T181533`ではCore/TUIのlong・follow・resume・保護対象超過と
readback照合が成功した。CLI subprocessへ`--task`と非terminal stdinを併用していたため
既存入力契約で送信前に止まり、taskをstdinで渡す手順へ直した。このrunも実provider 0。

credentialは既存のregular-file契約に合わせる。localは0600 fixture、realは既存0600 credentialのhard
linkを同一filesystemの隔離XDGへ置く。値を出力・記録せず、元fileへ書かない。 branch
DBはlong完了直後の同じbaselineからコピーし、0700 directory／0600 fileで開く。
実config・履歴・default selectionは変更しない。

### 11.8 localhost compiled e2e結果

`localhost-20261009T181755`は全確認成功、物理request18件。Core/TUIはlong6、同Worker follow1、 新Core
resume1、保護対象超過1。compiled headless JSON6、既定text3。
保護対象超過だけは意図した失敗で、`context_budget_exceeded`・超過数値・全文保持を確認した。

- TUIへ入力したlongは並列read batchと実行中steeringを含む。6requestで完了し、 全文13
  messageと全6ファイルの結果を保存した。最終送信は6 messageで、古い6 messageの
  省略がexecution内で単調に保持され、taskとsteeringは全送信に残った。
- 切り詰め通知は一度だけ表示され、内容に全文保存とmodel入力からの省略が明記された。
  tool呼出し/resultは全送信で対応し、parallel batchを分割しなかった。
- 同Worker followと、新Core/Worker resumeはlong直後の同じSQLite baselineから開始した。
  選択transcriptは一致し、最新交換と最終identifierを保持して成功した。 部分履歴の理由はlive
  TUIと保存noticeから確認した。元messageのlocatorも一致した。
- 巨大read結果は全文60,000文字を保存し、次のprovider送信前に保護対象超過で止まった。
  requestは1件のみ。TUIの数値説明と`FAILED · context budget exceeded`を確認した。
- JSON headlessは容量C=200,000とadapter R=65,536を読めるnoticeを出して完了した。
  既定textは通知をstderrへ、最終identifierをstdoutへ出した。

request spliceをsemantic journalから復元し、messageの内容・元位置・sourceを保存全文と照合した。
結果は`readback-verification.json`。C=200,000、q=0.8、R=65,536、
隔離I=15,000からL=15,000。初回trimの入力推定12,861、messages/body bytes
37,694/38,390で、tokensと既存wire byte上限内だった。

0.1秒周期のCore process（Worker threads込み）RSS/PSS計測を保存した。longのsampled peakは RSS 136.25
MiB／PSS 109.21 MiB、最初のtrim request前後は129.02/101.99 MiBから 131.27/104.23
MiBだった。候補binaryに各context heapの計測interfaceはなく、個別heapは未取得。
全Core操作終了後のprocess消滅とsamplerの競合でthreadが終了したが、long・30秒idle・
follow・resume・保護対象超過までの必要なsampleは残った。実provider前にprocess参照を固定し、
消滅時の`ProcessLookupError`を扱うprobe修正を行った。production sourceの変更はない。
切り詰めは送信文脈を減らすもので、全保存履歴または常駐RAMを有限にする保証ではない。

### 11.9 実providerの準備失敗と対象route修正

`real-20261009-final`では相対パスをmodelが`/workspace/f3.txt`へ解釈して失敗し、
実workspaceへの修正readに一stepを使った。3ファイルのread完了後、最終応答前の4step上限で停止した。
物理request4、現在ターンの切り詰めはまだ起きていなかった。

`real-20261009-corrected`は絶対パスの二交換（各24,000文字）へ縮め、3step上限で実施した。
3回目の送信で古い交換を省略できたが、modelが省略済みの最初のファイルを再readして上限で停止した。
物理request3。送信・予算・対応するcall/result・全文保存は成立したが、作業完了は未確認とした。

両runを保存factから調べ、実modelは`glm-5.3-flash`だったことを確認した。 Core
activationの`rootProvider`指定はprovider宣言のdefaultsを使い、隔離した
`default-selection.json`のDeepSeek指定より優先された。driverのreport.modelは計画値で、
実選択の証拠ではなかった。両runに`route-verification.json`を追記し、この不一致を明示した。
これまでの実request7件はGLMであり、DeepSeek受入の証跡には使わない。

隔離provider宣言のdefaultsもDeepSeekへ合わせ、新しいSessionの公開selectionを送信前に照合する
assertを加えた。全request deltaのmodelSelectionも事後照合した。元の実configは変更していない。
二交換のtaskには「最後のf5結果があれば両readは完了し、以前の省略結果を再readしない」を
明記した。これはprobe用の操作指示であり、productionへ自動進捗summaryや強制規則を追加していない。
切り詰めによる情報の省略は残り、最新assistant状態が過去の進捗を表さない場合、modelが
作業を再実行することはあり得る。この観測を一般的なcontinuation成功保証として扱わない。

### 11.10 DeepSeekのcompiled e2e結果と受入範囲

`real-20261009-deepseek-verified`はOpenCode Go Chat / `deepseek-v4.1-flash` / autoで
全確認成功。Core起動時・全semantic request delta・保存されたprovider response state・TUI footerで
実選択を照合した。long3、同Worker follow1、新Core resume1、計5物理request／5論理step。
先のGLM準備7件を含め、今回の実provider利用は計12件。HTTP再試行は起きなかった。
実providerを使う追加runは行わない。

longは二交換と最終応答の全文6 message（readback JSON換算50,241 bytes）を保存した。
3回目のrequestはtaskと最新交換の3 messageを送り、元位置1〜2の古い一交換を省略した。
推定入力8,930／L=15,000、messages/body bytes=25,961/26,670、既存wire上限内。
通知は一度だけTUIに表示され、全文保存との区別を読めた。

long完了直後の同じSQLite baselineから、同Worker followと隔離コピーの新Core/Worker resumeを
行った。両方の送信transcriptは一致し、元task・最後のtool交換・最終応答と、その元locatorを
保持した。最新結果のidentifierを各一requestで返し、live TUIへ部分履歴の通知も出た。
入力推定はfollow9,121／resume9,123で、保存履歴の選択は同一、prefixの差も含め各requestが予算内。
request spliceのreadbackと保存全文を照合し、省略の単調性、元source、全二ファイル結果の保存を
確認した。証跡は`readback-verification.json`と各`*-request-readback.json`。

容量factはC=1,000,000（models.dev）、q=0.8、R=65,536（実Chat adapter予約）、
隔離I=15,000（明示設定）、L=15,000だった。metadataはOpenCode側の保証ではなく、
入力costは推定値のままである。明示Iを置かない通常既定のL=800,000とhistory上限なしは
S1のresolver確認および第11.5節の観測済みWorker再生で照合している。

Core processのlong sampled peakはRSS174.71 MiB／PSS147.27 MiB（129 samples）。 初回trim
request直前は169.73/142.30 MiB、直後170.00/142.56 MiB、 終了30秒後は119.63/92.12
MiBだった。各context heapはproduction binaryに計測interfaceがなく未取得。
メモリsample486件を保存した。入力projectionの削減と常駐RAM・全文保存は別であり、
切り詰め後のメモリが増えない保証、長時間耐久性の検証は今回の結果に含めない。

今回の受入対象は、容量連動予算・requestだけの交換単位省略・全文保存・通知/停止診断・
直近完了ターンの再投影・root/child自身の容量である。S1〜S4のfocused testとreview、 localhost
production TUI/CLI、実DeepSeekの人間による操作経路で成立することを確認した。
一般的な安全性強化、未知provider variantのmatrix、full gate、200turn測定は追加していない。
コンパクション、search改善、巨大な保護対象を収める新処理は対象外のまま。
構想・architecture・roadmapは変更せず、反映案は第8節に残す。

### 11.11 修正全体の通常・批判的review

利用者の明示依頼で、新しいreviewer二名へ会話履歴を渡さず、対象source/差分/要件とe2e証跡を
固定したcontextを渡し、通常reviewと批判的reviewを独立に依頼した。対象file/diffのhashは
開始時と終了時に一致した。通常reviewは容量と実利用経路・全文保存・通知・regression、
批判的reviewは責務/状態所有・slice間の接続・実wire・受入結論の妥当性を確認した。

両reviewとも採用対象のBlocker/P1/P2はなく、defaultも採用するfindingはないと判断した。
保存全文と省略範囲、source locator、省略の単調性、task/steering、call/result、
同baselineのfollow/reopenが独立に照合された。realのGLM失敗とDeepSeek成功の区別と、
一般的な情報保持・RAM上限を保証しない記述も受入結論と矛盾しなかった。
通常L=800,000付近の実provider負荷と、Responsesの実provider切り詰め送信は未確認。
reviewerは変更・full gate・追加実provider利用を行っていない。

### 11.12 commit・常用配置

利用者の「コミット配置して」を受け、221のsource/test/結果をcommitし、
そのbuild入力がcleanなsourceから公式buildを作る。配置先は`dist/hjh`と
`/home/agent/.local/bin/hjh`。旧binaryを保存し、atomicに切り替える。 配置binaryのruntime
hashが第11.7節の検証候補と一致すること、buildのsource/clean、
隔離XDGのCore/TUI起動・操作・終了を確認する。配置確認に追加実providerは使わない。
構想・architecture・roadmap、実config・DB・外部tool/hookは変更しない。

221のsource/test/記録を`90696061ecfa79e9dbf38551e91aa75a7e7a92e4`へcommitした。
先行する通常利用メモの別件修正と既存pycacheは、このcommitに含めず保持した。
公式`build_henji.ts`でbuild入力cleanのcommitからcompileし、e2e候補と embedded runtime
hashが一致することを配置前に確認した。

- version: `hjh 0.11.0`、sourceDirty: `false`
- source: `90696061ecfa79e9dbf38551e91aa75a7e7a92e4`
- build ID: `595db794c0fca85d1a9ed2ea6d8e1adc96d0761ee6e214f5457afe3fc4f2bcf0`
- runtime SHA-256: `c61f9b6c68deeabd0c797c91f6972f581eb48b24bb6b7d3f0036777957556f6d`
- binary SHA-256: `5d6632c46e04db4efeab7d1cf969d065c38dcc1678e226d8217088d781a14c06`

`dist/hjh`と`/home/agent/.local/bin/hjh`をatomic配置し、両方のversion/hashを候補と照合した。
旧binaryは`.tools/increment-221-deployment/hjh.dist.previous`と`hjh.local.previous`へ保存した。
常用配置先そのものを隔離HOME/XDG/workspace、外部DenoのないPATH、tmuxから起動し、
Core自己起動、buildのsource/clean、一覧/status、TUI ready、`/help`、Esc復帰、detach後の
Core存続、`core stop`と解放を確認した。通常PATHも常用`hjh`へ解決された。 実provider追加0、full
gate再実行0。配置証跡は`.tools/increment-221-deployment/`。

既存の稼働Core/TUIは停止・再起動しておらず、新規Core起動から反映される。
実config・DB・credential・外部tool/hookと旧`henji`は変更していない。
push・JSR公開・release・構想/architecture/roadmap反映は行っていない。
