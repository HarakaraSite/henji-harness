# Increment 157 — E6: providerの現行モデル一覧とお気に入り

更新日: 2026-09-29

ステータス: 利用者確認・完了承認済み（2026-09-29）。Increment 157は完了。
実装・検証・通常reviewと指摘修正・限定re-review・commit/push・常用配置・配置後確認を完了した。
利用者が実装、実装後の実provider確認、その後のコードとtestの通常reviewを指示・承認した。
取得中overlay削除とGoの暫定カタログ運用を含め、利用者の確認・完了承認とセッション終了を記録する。

## 目的と合意した動作

現在のproviderで使うモデルを、providerが返す現行一覧から探して選べるようにする。
よく使うモデルはピッカー上でお気に入りとしてカタログへ登録でき、変更のたびにbuildし直す必要をなくす。

- `/model`を開くたびに、現在選択しているproviderのモデル一覧を取得する。
- 一つのリストにお気に入りを先頭、その後にお気に入りでないモデルを並べる。
- お気に入り内・未登録モデル内をそれぞれ新しい順に並べる。検索中も順序を維持する。
- モデル選択とは別操作で、お気に入りを登録・解除する。
- 現在の固定カタログを初期お気に入りとして残す。
- お気に入りカタログを外部ファイルへ保存し、登録・解除を即時反映する。
- 新規モデルは最初`auto`で選び、あとからモデルに合わせて`/effort`で変更できるようにする。
  変更値をモデルごとの既定として保存する方式は、今回の追加希望を実現する計画案として以下に記す。
- 対応effortの取得元はmodels.devへ統一する。モデル一覧は上記の現在providerのAPIから取得する。
- metadataの特殊なeffort値（`default`・JSON `null`）は`auto`へまとめる。
  元の意味の保持より、共通の`auto`でprovider既定を使えることを優先する。
- models.devの取得に失敗した場合は、カタログに保存したmodel別のeffort候補を優先して使う。
  カタログにも対応情報のない新規モデルは初期`auto`を使い、現在の選択・記憶したeffortは保持する。
- provider選択 → `/model`でモデル一覧取得・models.dev参照 →
  model別のeffort候補を読み込み → モデル選択 →
  `/effort`で取得済み候補を表示する流れに揃える。

通常利用メモから移したE6の観測（2026-09-23）:

- モデル選択の一覧は、bundledまたは外部Provider宣言の固定`modelCatalog.entries`を使う。
  `searchModelsFor`はその一覧を手元で絞り込む。
- 利用者はproviderの現行一覧でモデルを選びたい。OpenRouterの件数と検索・表示方法を検討する必要があった。
- 関連する未採用候補はE1。E1全体の採用はこのincrementに含めない。

## 根拠と調査結果

2026-09-29のOpenRouter公開API実測:

| 取得・分類                                  | 件数 |
| ------------------------------------------- | ---- |
| `GET /api/v1/models`の標準一覧              | 460  |
| テキストのみ出力                            | 445  |
| テキストと画像を出力（自動ルータ2件を含む） | 11   |
| テキストと音声を出力                        | 4    |
| テキストのみ出力かつ`tools`対応             | 387  |
| OpenRouterへの登録から1年以上               | 151  |
| 2025年より前にOpenRouterへ登録              | 49   |
| `output_modalities=all`で取得した全種類     | 631  |

標準一覧の応答は約755
KB。取得・手元検索に扱える量であり、画像生成を取り除くだけでは件数は大きく減らない。
年齢による除外、`tools`対応だけへの限定、独自のmodel名による除外は合意されていない。
今回の一覧はproviderの標準モデル一覧を使い、追加の用途フィルターは設けない。

- [OpenRouter Models](https://openrouter.ai/docs/guides/overview/models):
  `sort=newest`を提供する。
  `created`はOpenRouterへの登録時刻。モデルの発売日とは区別する。
- [OpenRouter一覧API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties):
  `data`配列にID、表示名、日時、出力種別、対応parameter等を返す。標準取得はtext出力を対象とし、
  paginationの`offset`・`limit`を指定しない場合は全一覧を返す。
- [OpenAI List models](https://developers.openai.com/api/reference/resources/models/methods/list):
  `GET /v1/models`を提供する。model
  objectはID、`created`、ownerなどの基本情報を持つ。
  `created`はmodel作成時刻。一覧だけからAPI別の利用可否や対応effort値の一覧は確定できない。
- [OpenRouterのmodel別reasoning情報](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options):
  `reasoning.supported_efforts`でmodel別の対応値を返す。配列は対応値、`null`は全gateway
  effort値を受け付けることを意味し、
  項目の省略はeffort選択を公開していないことを意味する。`mandatory=true`では`none`を選ばせない。
  non-reasoning modelとdynamic routerは`reasoning`自体を省略する。
- 追加実測（2026-09-29）:
  一覧だけでなく`GET /api/v1/model/qwen/qwen3.8-max-0902`でも
  `reasoning`を取得できた。対応値は`xhigh/high/medium/low/minimal`、既定は`xhigh`。
  一覧内のDeepSeek V4.1 Flashは`max/high/low`、GLM 5.3は`max/high/low`を返した。
  Qwen3.8 Flashはtoken budget対応を返し、`supported_efforts`を省略した。
  OpenRouter公式APIからの取得は可能だが、その後の利用者の方針選択により、effort候補の取得元は
  models.devへ統一する。OpenRouterの個別model詳細API取得は本計画の実装対象から外す。
- [OpenAI Retrieve model](https://developers.openai.com/api/reference/resources/models/methods/retrieve):
  公開schemaはID、日時、owner、shutdown
  date等であり、対応effort値を返す項目はない。
  OpenAI直接接続と一般のOpenAI互換providerに、OpenRouterのreasoning
  metadata取得を一律に適用しない。

2026-09-29のmodels.dev公開カタログ調査:

- [models.dev APIとschema](https://github.com/anomalyco/models.dev#api):
  `api.json`はprovider IDをkeyとした objectで、各providerがID、名前、任意のAPI
  endpoint、`models`を持つ。対応effortはmodel別の
  `reasoning_options`内の`type=effort`・`values`へ格納する。toggle・token
  budgetは別のoption型。
- 接続先providerごとにentryが分かれる。OpenAI直接接続では`openai.models["gpt-5.4"]`、
  OpenRouter経由では`openrouter.models["openai/gpt-5.4"]`を参照する。
  provider非依存の`models.json`とprovider別の`api.json`は別の公開データであり、今回は後者を使う。
- `https://models.dev/api.json`と`https://models.opencode.ai/api.json`は取得時に完全に同じJSONだった。
  約5.23 MB、225 provider。OpenAIの52
  model中reasoning対応32件はすべてeffort配列を持っていた。
- OpenRouter公式460件とmodels.devのOpenRouter entry385件の差分は75件。
  内訳は`:batch`派生73件と`typesafe/jev-router`・`openrouter/auto-beta`。
  batch73件すべての通常版IDはカタログにあり、OpenRouterがeffort配列を公開する52件は
  カタログ通常版の配列と値の集合が一致した。残るbatch21件はeffort配列が省略されている。
  この観測をbatchの通常版への自動置換・metadata継承の採用とは扱わない。
- models.devはcommunity-maintainedなmetadataであり、利用者の接続先・credentialで選択可能な
  モデル一覧の正本にはしない。外部providerの独自model
  IDが載っていない場合も選択を妨げない。

これらの件数は調査時点の観測であり、実装やtestの固定件数にしない。
公開一覧の調査後、Henjiのproduction経路での取得・選択・実generationを確認した。結果は末尾の実装・実測節を参照。

## 現行の利用経路と状態所有

`/model` → `RemoteCatalogUi.openModels()` → `HenjiApiClient.catalogRead()` →
HTTP `GET /catalogs` → `CoreService.catalogRead()` →
起動時に解決したProvider宣言の`modelCatalog.entries` → TUIで検索・表示。

Enter → `selection.change` → Coreのcatalog所属・effort判定 → Host
`selectModel()` → Worker `select_model` →
Sessionのselectionと`default-selection.json`へ保存 → 次のgenerationのprovider
request。

- Provider宣言:
  Coreがconfigの`providers/*.json`と同梱宣言からroute、認証profile、既定、固定catalogを解決する。
  外部Provider宣言によるcatalog/default overrideは既に存在する。
- Core: 現在はcatalog
  readが同期処理であり、providerへrequestしない。新規モデルは固定catalogの所属判定で選べない。
- TUI:
  モデルIDの部分一致検索と10件の表示windowが既にある。検索・カーソル・scroll・modalを所有する。
- Host/Worker:
  `isModelSelection`、`selectModelFor`等でも固定catalogの所属を判定する。
  Provider宣言はWorker生成時に渡される。Coreだけを直しても新規モデルの選択・実行は成立しない。
- カタログはroot選択と明示childモデル選択で共用されているため、親で選べたモデルがchildの継承・
  同じモデルの明示指定でも使えることを確認する。

変更後の利用経路:

provider選択 → `/model` → Coreが現在providerのモデル一覧とmodels.devを取得 →
provider/model
IDでeffort情報を対応付け、外部お気に入りと記憶した既定値を合わせる →
検索・お気に入り操作・モデル選択 →
`/effort`でそのモデルの読み込み済み候補を表示。

取得タイミングは`/model`へまとめ、モデル選択や`/effort`表示のたびには外部取得しない。
Coreは取得済みeffort
metadataをprovider/model別にメモリで保持し、現在Sessionのselectionから参照する。
お気に入りと記憶したdefault
effortの正本は外部設定、Sessionの選択は既存のselection経路が所有する。
models.dev取得失敗時は、同じprovider/modelの外部カタログに保存したeffort候補でピッカーを使えるようにする。
正常取得した対応値と、障害時に参照するカタログの保存値は情報源を区別して扱う。

## 実装案

以下は合意した動作を実現するための計画案。キー、保存先、外部providerの対応範囲等の細部は
利用者が指定した要件として扱わず、この計画の提案として区別する。

### 1. Coreでproviderのモデル一覧を取得する

- OpenRouterのChat/Responses route、OpenAIのChat/Responses routeを対象にする。
- 外部宣言で追加したOpenAI互換providerも共通の`GET {endpoint}/models`・`data[].id`経路に含める案とする。
  現行宣言のprotocolはいずれもOpenAI互換。異なる一覧URL・応答形式の個別adapterは今回増やさない。
- endpoint、authProfile、宣言headersは既存のProvider解決経路を使う。credentialとAuthorizationはCoreの
  request境界でのみ解決し、TUI、カタログファイル、診断へ渡さない。
  宣言headersの`{sessionId}`にはピッカーを開いたSessionのcontextを渡す。
- Coreのmodel catalog
  readを非同期取得へ変更する。取得はピッカーを開いた時点だけ行い、検索文字の
  入力、お気に入り変更、Enterのたびには再取得しない。再度開けば取得し直す。
- 同じ`/model`読み込みでmodels.devも取得し、現在providerの一覧にmodel別の対応effortを付ける。
  providerのモデル一覧取得と公開metadata取得は独立したrequestとして実行できる。
  models.dev未掲載・取得失敗が、接続先から取得できたモデルの表示・選択を妨げないようにする。
  取得済みmetadataはCoreが保持し、検索、お気に入り変更、モデル選択、`/effort`表示で参照する。
- UIに必要なID、任意の表示名・日時、お気に入り状態、選択用effort情報へ正規化する。
  OpenAI互換の標準項目だけの応答を扱え、OpenRouter固有項目がないことを拒否理由にしない。
- 既存modalのgeneration判定を利用し、取得中にEscで閉じたり別pickerへ移った場合も操作を継続できる。
  取得失敗時は状況を案内し、現在のSession
  selectionを保つ。固定一覧を現行取得結果として表示しない。
- 診断はprovider、API、HTTP/error、解析失敗の項目と値の形など、次のprobeを決められる短いfactを記録する。
  raw応答や全request headersの常設保存は行わない。

### 2. お気に入りカタログを外部保存する

- 保存先案: `$XDG_CONFIG_HOME/henji-harness/model-catalogs/<providerId>.json`。
  Core側のユーザー設定とし、同じconfigを使うworkspace間で共通にする。
- 同じファイル内でお気に入りのmodel ID集合と、モデルごとのdefault
  effortを別の項目として管理する。
  effort変更でお気に入りへ自動登録せず、お気に入り解除でも記憶したeffortは残す。
- model別の既知effort候補も同じ外部カタログへ保存し、models.dev取得失敗時の参照先にする。
  初期seedでは有効な固定カタログの`efforts`を保存する。お気に入り登録時には、その時点で取得済みの
  対応effortを保存する。対応情報がない場合は対応済みの値を推測で書かない。
  この保存値は障害時の候補であり、外部宣言で利用者が明示した個別overrideとは区別する。
- 現行のselection identityに合わせ、`providerId`と`modelId`で登録する。
  Chat/Responsesを別providerとして扱う現行境界に合わせる。両route間の自動共有は追加しない。
- 初回は、そのproviderの有効な固定catalogの全entryを初期お気に入りにする。
  外部宣言でoverrideしている場合は、その有効catalogを使う。
- 初回seed後は外部ファイルをお気に入りの正本にする。空のお気に入りも保存でき、解除したentryを
  毎回同梱データから復活させない。初期化に既存providerファイルの書換え・削除は必要ない。
- Core
  APIは対象modelの登録状態を明示的にsetする。選択変更とは別操作として、登録・解除の完了後に
  カタログをreadbackし、同じピッカーへ反映する。お気に入り操作でdefault
  selectionを変更しない。
- ファイルは既存config保存経路と同様に一つの完成したJSONとして更新する。
  ピッカーを開く時と登録変更時に読み、Core/TUI再起動後にも復元できるようにする。
- 登録・解除で変更するのはお気に入り状態。既知モデルのeffort情報とSession選択履歴は独立して扱う。
  モデルを選択・effortを変更したときは、選んだeffortをそのモデルの既定として外部保存する案とする。
  次の選択、新Session、Core/TUI再起動後も、そのprovider/modelの記憶した値を使う。

### 3. 選択候補とお気に入りを分離する

- provider取得一覧を探索・表示の入力にし、お気に入りを選択許可リストとして使わない。
  未登録の新規モデルも選択して実generationへ渡せるようにする。
- Core、Host、Workerの固定catalog所属を前提とした判定を整理し、宣言済みrouteとselectionの構造を
  解決する経路へ揃える。お気に入り解除で現在のselectionや保存Sessionが使えなくならないようにする。
- 既知モデルは、現在の固定catalog／外部宣言のdefault effortを初期値にする。
  利用者が変更したあとは外部保存したmodel別のdefault effortを優先する。
  effort選択肢はmodels.devと明示した外部overrideを使い、同梱固定catalogを対応値の正本にしない。
- 一覧に初めて現れたモデルは初期effortを`auto`にする。現行Chat/Responses
  adapterでは`auto`は reasoning指定を送らず、providerの既定を使う動作である。
- OpenRouter・OpenAI・外部宣言分とも、`/model`を開いたときCoreで`https://models.dev/api.json`を取得し、
  現在providerの各modelの`reasoning_options`を読み込む。対象modelだけの公開取得APIは確認しておらず、
  全体JSONからprovider/model別のentryを引く形にする。
  `/effort`は取得済みmetadataから現在モデルの候補を表示する。最新情報への更新は再度`/model`を開く。
  起動直後やSession再開後に`/model`を経ず`/effort`を開く実経路では、Coreに取得済みmetadataがない場合に
  同じmodels.dev取得処理で初回読み込みする。取得失敗時は以下のカタログ参照を使う。
  この公開metadata
  requestへproviderのcredential・Authorizationを渡す必要はない。
- Henjiの`openai-chat`・`openai-responses`はmodels.devの`openai`へ、
  `openrouter-chat`・`openrouter-responses`は`openrouter`へ対応付ける。
  Chat/Responsesのselection
  identity・お気に入り・記憶effortは引き続き別routeとして所有する。
  models.devのentryだけではChat/Responsesごとの利用可否は確定しない。
- 取得URLとprovider対応は外部設定へ置き、外部宣言providerには任意の`modelsDevProviderId`を
  指定できる案とする。モデルIDは接続先のIDで照合し、model名のprefixからメーカーや対応値を推測しない。
  外部providerの独自aliasの照合が必要なら個別の対応指定を計画上の未確認事項として扱う。
- 候補はHenjiの`auto`を含め、`type=effort`の`values`をそのprovider/modelの対応値として並べる。
  外部宣言で明示したmodel別の`efforts`は個別補正として優先する案とする。
  metadataの特殊値`default`・JSON
  `null`はHenjiの`auto`へ正規化し、候補内の`auto`は一件にまとめる。
  Coreでmetadataを読み込む際に正規化し、API応答・表示・Session選択・外部保存はいずれも`auto`を使う。
  requestではreasoning指定を省略する。特殊値の元の意味は引き継がず、provider既定を使う。
  明示的な`none`や`low`・`high`等のHenji対応値はそのまま候補に残す。
  `auto`はparameter省略であり、metadataの`none`やtoggleとは別の値。toggle・token
  budgetを low/high等へ推測変換せず、token数やtoggle専用UIは今回追加しない。
- models.devのネットワーク障害等で取得できない場合は、同じprovider/modelの外部カタログに保存した
  effort候補を優先して表示する。現在Coreに以前のmetadataが残っていても、取得失敗した読み込みでは
  利用者の方針どおりカタログの保存値を参照し、カタログ参照中であることを短く案内する。
  カタログに対応情報がなければ初期`auto`と既存の選択・記憶値を保持する。
  metadata未掲載や正常応答でeffort
  optionが省略された状態はネットワーク取得失敗とは区別する。
  models.dev復旧後に`/model`を開き直すと、正常取得した対応値を再び使う。
- provider/model未掲載・metadata未取得・effort
  optionの省略は、選択非対応の証拠にはしない。
  新規モデルの初期`auto`、現在選択と記憶effortを保ち、metadataの状態を案内する。
  対応情報のないmodelには外部宣言でeffort候補を追加できるようにする。
  OpenRouter個別API、全値を試すgeneration、モデル名による規則を代替の取得経路として追加しない。
- `/effort`で変更した値は現在Sessionへ即時反映し、モデルごとの次回既定としても保存する案とする。
  例: 新規model Aを`auto`で選択 → `high`へ変更 → model Bへ切替 →
  Aを再選択すると`high`。
  providerから取得した対応値と、利用者が記憶させる既定値を区別する。
- rootの選択、次回の既定、Session再開、childの親selection継承と明示モデル指定を同じ境界へ揃える。
  毎回の一覧全体をWorkerへ転送するための別状態は追加しない。

### 4. ピッカーの表示・操作

- 一つのリストを「お気に入り優先 → 各グループの`created`降順」で並べる。
  OpenRouterでは`sort=newest`を使い、Coreでもお気に入りを優先した順序を組み立てる。
- 日時があるentryを新しい順に並べ、日時がないentryは同じグループの後ろでproviderの返却順を維持する。
  日時のない外部providerは新旧を推測せず、返却順を使う。OpenRouterの日時の意味は登録順として案内する。
- 検索はモデルIDと、providerから得られる表示名の部分一致。大小文字を区別せず、絞り込み後も同じ順序を保つ。
- 行にお気に入りの印と現在モデルを表示し、検索query・一致件数・表示範囲を確認できるようにする。
- Up/Downで行移動、Enterでモデル選択、Escで閉じる。お気に入り登録・解除はTab案とする。
  printableなキーを登録操作に使わず、検索文字と競合させない。
- 登録・解除後は、そのmodel
  IDにカーソルを維持して並べ替える。解除で行が下へ移っても、別modelを
  誤って選択しない。検索queryを維持し、長い一覧も既存の表示windowで操作する。
- 操作案内は実terminal幅で読めるよう配置し、80列でも登録・解除キーを確認できることを実TUIで確かめる。

## 作業順と対象

| 順 | 実現する動作                                                   | 主な対象                                                                 |
| -- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1  | providerから取得し、表示用情報と外部お気に入りをreadbackできる | `v0/agent/provider/`の取得・保存module、`v0/agent/host/core_service.ts`  |
| 2  | HTTP/TUIから一覧取得と独立したお気に入り変更を使える           | `v0/api/contract.ts`・`codec.ts`・`client.ts`、`v0/agent/http/server.ts` |
| 3  | お気に入り外のモデルも選択・実行・再開できる                   | `model_catalog.ts`、Core選択、Host/Workerの既存選択呼出し箇所            |
| 4  | 検索、お気に入り優先、新しい順、Tabで登録・解除を操作できる    | `v0/tui/remote_catalog_ui.ts`、必要な表示部分                            |
| 5  | 実利用経路で受入し、結果と操作方法を記録する                   | focused test、隔離tmux、`docs/operations/http-api.md`、本increment       |

共通input decoderには既にTab eventがあり、キー追加のための変更は不要と見込む。
今の`searchModelsFor`や固定catalog参照は呼出し元を確認し、使わなくなる探索・所属判定を同じ変更で整理する。
一つのincrementとして進め、途中はfocused確認を使う。

## 検証と受入

各確認は合意したproduct動作または現在の選択経路が変わることに対応する。

| 確認するproduct動作                                    | 方法・根拠                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 現在providerの現行一覧とeffort情報を/modelで取得する   | loopback一覧APIとmodels.dev形式の応答を変え、Core HTTP経由で再度開いたモデルとeffort候補の更新を確認。検索入力・Tab・モデル選択・取得後の/effortでは追加取得しないことも確認                       |
| OpenRouter形式と基本的なOpenAI互換形式を扱う           | 公式schemaに対応する最小応答でID、任意表示名・日時、既存認証設定の利用を確認                                                                                                                       |
| 初期お気に入り、登録・解除、再起動後の保存を使える     | 隔離configのJSON readbackとCore再起動。空状態を保持し、selectionが変更されていないことを確認                                                                                                       |
| お気に入り優先・各グループの新しい順・検索を操作できる | TUI focused確認と実tmux。日時情報に基づく順序とID/表示名検索、Tab後のmodel ID・query保持を確認                                                                                                     |
| 新規モデルを未登録のまま選択し実行できる               | production Core/Host/Workerとloopback providerで、Session selection、provider requestのmodel ID、完了結果を確認                                                                                    |
| 選択したモデルで新Session・再開・childが動く           | 次回既定・保存Session再開を確認し、loopback providerで親モデル継承と同じ新規モデルの明示child指定を実行                                                                                            |
| 最初autoを使い、model別の対応effortを選べる            | 新規モデルのautoがreasoningを送らないことと、/modelで取得したmodel別候補を/effortで使うことを確認。公開schemaのprovider別entry、OpenAI直接・OpenRouter経由の照合、外部provider対応と個別補正を確認 |
| 特殊なeffort値をautoにまとめて使える                   | 実測したdefault・JSON nullを含むmetadataをCore HTTP経由で読み、候補のautoが一件になり、選択・外部保存がauto、次requestがreasoning指定省略になることを確認。通常の対応値は保持する                  |
| 起動・Session再開直後にも/effortを開ける               | /modelを経ず/effortを開き、取得済みmetadataがない場合の初回読み込みと現在provider/modelの照合を確認。既存の選択・記憶値を保つ                                                                      |
| models.dev取得失敗時もカタログのeffort候補を使える     | 初期seedと新規お気に入り登録で候補を保存し、Core再起動後のmetadata取得失敗時にカタログ値と情報源の案内を確認。現在の選択・記憶値を保ち、復旧後の/modelで正常取得値へ戻る                           |
| カタログ未掲載でもモデルを選べる                       | 実測のbatch・router差分に対応し、metadata未掲載が/modelからの選択を妨げないことと、初期auto・情報状態の案内・外部宣言での候補追加を確認。通常版への自動置換は行わない                              |
| 後から変更したeffortをモデルごとに使える               | 新規Aをautoで選びhighへ変更→Bへ切替→Aへ戻りhighになることを、外部JSONと次requestで確認。お気に入り未登録・解除後、Core再起動後も記憶値を確認                                                       |
| 通常の表示・操作で目的を完了できる                     | 隔離HOME/XDG/workspaceの80列tmuxでproduction TUI。検索→選択→再度開く→登録/解除→再起動→再選択を実操作                                                                                               |

- 変更箇所のfocused test、必要なtype
  check、format、lint、`git diff --check`を行う。 本計画ではfull
  `v0:gate`を要求しない。既存144の「catalog readでprovider requestしない」前提は
  model一覧取得の新要件と競合するため、正しい新動作へ更新する。
- sourceのproduction経路と、公式build scriptで生成した検証用compiled
  TUI/Coreを確認する。
  実configの`default-selection.json`や既存Coreには操作しない。
- 外部providerでのproduction確認案は、OpenRouter Chat/ResponsesとOpenAI
  Chat/Responsesを
  各一覧取得1回・新規モデルの最小generation1回とする。モデルIDと保存先は実行前に提示する。
  各routeの`/model`でmodels.dev取得と対象entryの照合を1回ずつ確認し、その後の`/effort`は
  取得済み候補を追加requestなしで表示することを確認する。
  外部宣言分は一覧APIを持つloopback
  providerでproduction経路を確認し、実接続先が提示された場合は
  その接続先の一覧取得を追加対象として提示する。
- これらの認証付き外部確認・generationは利用者が明示承認済み。対象・回数・保存先を実行前に提示する。
- 最終受入は、人間がproduction
  TUIでモデルを探し、未登録でも選び、登録・解除をbuildなしで
  反映できること。offline testやloopbackだけで外部providerの受入を代替しない。

## 未確認事項・計画上の境界

- 外部宣言分を共通のOpenAI互換一覧取得に含める範囲は計画案。全ての外部serviceの一覧API互換性は保証しない。
- models.devのprovider別effort値は公開データで確認済み。metadataと実generationの結果は別に記録する。
  未掲載model、独自alias、modelごとのChat/Responses別利用可否、取得・option省略時の表示詳細は
  実装前の設計で確定する。batch IDの通常版からのmetadata継承は未採用。
- 通常・批判的reviewのP2で指摘された特殊値は、利用者の追加指示により`default`・JSON
  `null`とも `auto`へまとめる方針を追記した。
  [Sarvamの公式説明](https://docs.sarvam.ai/api/api-guides-tutorials/chat-completion/how-to/adjust-the-models-thinking-level)
  では明示的な`reasoning_effort: null`は推論OFF、指定省略はprovider既定の使用であり、
  この変換で意味が変わることを説明したうえで利用者が共通の`auto`を選んだ。
  provider別に元の意味へ戻す送信変換は追加しない。Core読込時の正規化とfocused確認済み。実装後の通常reviewへ渡す。
- 実provider確認結果は末尾を参照。全モデルのChat/Responses利用可否を一律に保証するものではない。
  取得一覧にない保存済お気に入りを自動削除しない。
- お気に入りのChat/Responses間共有、用途フィルター、年代での除外、model
  capabilityの一般化、
  非OpenAI互換一覧APIのadapter、追加protocol、一般的hardeningは今回の対象に含めない。
- 実装、隔離tmuxと実provider確認、その後のコードとtestの通常reviewは指示・承認済み。
  実provider確認の対象・回数・保存先は実行前に提示する。commit/push・常用配置は追加指示済み。公開は未指示。

## Product正本への変更案

現在のarchitectureは固定catalog、dynamic
model取得は採用時に戻る境界を記述している。
roadmapはprovider設定の外部化の実装状態を管理している。実装時には以下の意味変更が必要になる。

| 対象                                                                      | 理由・意味上の変更案                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docs/architecture/henji-host-agent-worker.md`のProvider設定              | Coreが現行一覧取得とお気に入りの外部保存を所有し、カタログの登録を選択可否と分離することを記述 |
| `docs/architecture/multi-provider-routing-and-auth.md`のprovider contract | route宣言・一覧取得・お気に入り・effort metadataの責務と認証request境界を実装に合わせる        |
| `docs/roadmap.md`のprovider外部化の実装状態                               | E6の採用範囲と、実装後のモデル一覧取得・お気に入り保存の実装状態を記述                         |

これらは変更案に留めた。`AGENTS.md`のProduct正本の変更承認に従い、個別incrementの計画・実装とは
別に利用者へ意味変更を提示して承認を得るまで反映しない。構想のWhy・人間による採用境界の変更は不要と見込む。

## 実装と確認結果（2026-09-29）

- Coreの`LiveModelCatalog`が現在providerの一覧、models.devのeffort情報、外部お気に入りを合わせる。
  `/model`を開くたびに一覧とmetadataを取得し、検索・Tab・選択・取得後の`/effort`では再取得しない。
- `model-catalogs/<providerId>.json`にお気に入り、記憶したdefault
  effort、障害時の既知候補を保存する。
  固定catalogは初期seedとして残し、以降のお気に入り操作と選択の所属判定を分離した。
- Core/Host/Worker/明示child選択は宣言済みrouteとselection構造で解決し、未登録モデルでも使える。
- `POST /catalogs/favorite`で独立した登録・解除を行う。TUIはTab、ID/任意表示名の検索、
  お気に入り優先・日時降順、操作後のquery・model IDカーソル維持に対応した。
- `default`・JSON
  `null`はCoreで`auto`へ正規化する。API・表示・保存は`auto`、requestはreasoning指定省略。
  正常metadata/overrideの候補に固定catalogの値を混ぜず、障害・未掲載時は現在/記憶値を保持する。
- 外部provider宣言の`modelsDevProviderId`、config
  rootの`model-metadata.json`による取得URL変更に対応した。
  credential/Authorizationは公開metadataへ渡さず、短いHTTP/error/parse factsを
  workspaceのstate directory内`catalog-requests.jsonl`へ保存する。

### focused確認とTUI

E6/更新144のfocused
testは7件成功。新規候補、特殊値正規化、並び順、保存・再起動、障害時カタログ、
外部provider対応/override、TUI操作、production
Core/Host/Workerの新規モデル実行・復元、
子agentへの継承と明示指定を確認した。既存12/14/15のmodel/provider経路33件も成功。
source entryのtype check、変更14 TS
fileのformat/lint、`git diff --check`は成功。
旧12/14/15は既存taskと同じ`--no-check`で実行し、runtime sourceのtype
checkは別途成功。 full gateは計画上要求せず実施していない。

sourceと公式build scriptで生成したcompiled
TUI/Coreを、隔離HOME/XDG/workspaceの80列×32行tmuxで確認した。
検索（IDと表示名）→新規modelをautoで選択→effortをhighへ変更→登録/解除→実行→Core/TUI再起動→再選択を
完了した。Tab後もqueryと対象modelを保持し、登録/解除だけでSession
selectionは変わらない。
再起動直後の`/effort`も読み込み、models.devを503にした実経路で保存候補を参照できた。
各source/compiled確認はloopback一覧3回・metadata4回・generation1回。外部provider
requestはない。

確認中に、取得factの保存がSession
directoryを既存規約と異なるmodeで先に作る問題を発見し、
既存保存規約に合わせて修正した。受入用helperの選択保存完了待ちも調整した。

### 実provider確認

利用者の実provider確認承認とOpenCode Go追加指示に従い、compiled production
TUI/Coreで以下を完了した。
各経路は一覧取得1回、models.dev取得1回、最小generationの物理request1回。計6・6・6回。
検索→独立したお気に入り操作→選択→`/effort`→生成を実操作した。
`/effort`で追加の外部取得はなく、すべて`auto`で`E6_OK`の生成とprocess
settlementを確認した。
Goは隔離configへコピーした外部宣言に`modelsDevProviderId: opencode-go`を指定して確認した。

| provider              | model               | 結果                 |
| --------------------- | ------------------- | -------------------- |
| openai-chat           | gpt-5.4-nano        | completed・request 1 |
| openai-responses      | gpt-5.4-nano        | completed・request 1 |
| openrouter-chat       | openai/gpt-5.4-nano | completed・request 1 |
| openrouter-responses  | openai/gpt-5.4-nano | completed・request 1 |
| opencode-go-chat      | glm-5.3-flash       | completed・request 1 |
| opencode-go-responses | gpt-5.6-luna        | completed・request 1 |

OpenAI/Routerのnanoは元の固定catalog外。初期auto、未登録での選択と生成を実接続で確認できた。
Goの二モデルは外部宣言の既知モデル。外部一覧取得・対応付け・明示overrideと両protocolの生成を確認した。
既存の実config/Coreへ書き込まず、確認用Core/TUI/tmuxは終了し、実credentialの隔離コピーは除去済み。

確認用binary:
`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/henji`。
build ID: `78c9fb8d5052da8c6d88af1b3ebf3c0f0af7e2804a3677c43b202b359fbd8a59`。
runtime SHA-256:
`6ed3590b5986bff988962c33613ba48b4e355b5e45ea1f59cc4e68247cf3c911`。 source
`438c4d195e9d353460d5788e080af76533dcb418`+dirtyを含む検証候補。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/`。
`focused-tests.log`、`build.log`、`tmux-results.json`、`source-tmux/`・`compiled-tmux/`の画面とsnapshot、
`real-providers/results.json`と経路別picker/effort画面・完了snapshot・短い取得factを保存した。
実provider helperの初版はconversation request projectionを数えて0を報告したが、
完了snapshotの`runtime.execution.requestCount`は全経路1。results.jsonをその正本へ合わせて訂正した。
生成失敗・追加generationはない。

### 実装後review

実provider確認後の通常reviewは4分33秒で完了。Blocker/P1なし、P2二件を採用した。

1. 明示rootProviderの新Sessionがmodel別の記憶effortを使わず、固定defaultへ戻る。
   Coreの同初期化経路でも外部保存defaultEffortを適用した。
2. 共有catalogへの直接writeで、別Coreの読取りが更新途中のJSONを観測できる。
   既存default-selection保存と同じ、完成したstaging
   fileからrenameする更新へ揃えた。

双方を修正前に再現した（新Sessionがlowでなくhigh、並行読取りがlow/highの断片を混ぜてligh）。
修正後はfocused8件、source type check、変更4file format/lint、diff checkが成功。
source/compiledの80列tmuxで、明示providerの新Sessionが記憶autoを使うことを追加確認し、
元の検索・登録解除・新規model/effort・再起動/障害時catalog動作も再確認した。
確認用Core/TUI/tmuxは終了済み。外部generationの追加はなく、当初6経路各1回の証拠を維持する。

最終検証用binaryは同証拠directoryの`review-fixed-verification/henji`。 build ID
`1912d69680d85d4f9b5a82ee36a4e4b69f0c6e2dc6854a53346bbfe4ae79faae`、 runtime
SHA-256 `8cce1e317705f251f7770db869fec521cf57b7917a9b78ae1cb1edada6e11cc8`。
`review-fixed-tests.log`・`review-fixed-verification/tmux-results.json`と画面/snapshotに記録した。
修正4fileと既存findingだけの限定re-reviewを一回実施し、P2二件とも解消と確認された。
新しいBlocker/P1/P2はなし。終了時刻は2026-09-29 06:36:36 UTC、10分上限内。
親が固定manifestとの一致、最終format/lint/diff状態と記録を確認した。
local実装報告時点ではcommit/push・常用配置は未実施だった。追加指示による配置は次節に記録する。
公開、およびarchitecture/roadmapの正本変更は未指示。

## commit・push・常用配置（2026-09-29）

利用者の「コミット プッシュ
配置して」に従い、E6の実装・test・要件/結果・操作文書、
通常利用メモからの採用移動とhandoffをcommitし、origin/mainへpushする。
レビュー済みsource/testのmanifest一致を確認し、固定commitのclean
checkoutで公式buildする。 最終検証候補のruntime
SHA-256との一致を確認し、旧binaryを保存して常用先へ原子的に配置する。
配置したbinaryそのものを隔離HOME/XDG/workspaceのtmuxで確認し、結果を後続文書commitへ記録・pushする。
稼働中の既存Core二つは停止・移行しない。構想・architecture・roadmapとJSR公開は対象外。

実装・test・要件/結果・操作文書・採用移動・handoffの18ファイルをcommit
`058d503ab89c782b905686f36bce691b66c1bd44`へまとめ、origin/mainへpushした。
既存の未採用S26・S27は保持し、構想・architecture・roadmapは変更していない。

固定commitのclean checkoutからDeno 2.9.7の公式build scriptでbuildした。
最終検証候補とruntime SHA-256が一致し、sourceDirty=false。
旧binaryを保存し、`/home/agent/.local/bin/henji`へ原子的に配置した。henji
0.7.0。

- build ID: `4e6e3a1f9bf4ded9d90bb7ab9ee50cddd63a4c4bb27e1f2edb8bdd6416f1fd10`。
- runtime SHA-256:
  `8cce1e317705f251f7770db869fec521cf57b7917a9b78ae1cb1edada6e11cc8`。
- binary SHA-256:
  `5acedf81e2e00fbfbb617fa8d517eedc36dbef17e6a4f613e14e90cf315a2dac`。
- 旧binary:
  `/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/deployment/henji.previous`。
  SHA-256: `cff9ec278b3258f876196f41850ec87d54c926159344bcd90196a8995e934296`。

配置binaryそのものを隔離HOME/XDG/workspaceの80列×32行tmuxで実操作した。
検索（ID・表示名）、お気に入り優先/日時降順、Tab登録・解除とquery/cursor保持、
新規モデル初期auto、effort変更、生成完了、明示providerの新Sessionで記憶effort適用、
再起動/再選択とmetadata障害時の保存候補参照を再確認した。 Core HTTP
identityのsource/build/runtimeと配置identityが一致し、dirtyなし。
loopback一覧3回・metadata4回・generation1回、外部provider requestは0回。
確認用Core/TUI/tmuxは終了済み。実configへのdefault-selection書込みは無い。

配置前から稼働中のCore二つはPID/start
time・epoch・Session・idle状態・buildを保持し、
配置後もHTTP応答を確認した。停止・移行していない。新規起動には配置binaryが使われる。
既存Coreへの明示再接続URLは`http://127.0.0.1:41115`と`http://127.0.0.1:34001`。

配置証拠は`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/deployment/`のbuild.log、deployment.json、version.txt、
tmux-results.json、tmux.log、preexisting-cores.json、preexisting-cores-after.json。
実画面、完了snapshotとCore identityはdeployed-tmux/へ保存した。
本配置記録とhandoffを後続の文書commitへまとめ、origin/mainへpushする。
この配置時点では利用者による通常操作確認・increment完了承認は別途だった。最終承認は末尾に記録する。
JSR公開は未指示。

## 追加修正 — モデルピッカーの取得中表示（2026-09-29）

利用者がモデルピッカーを開く際の一瞬の表示切替を観測し、2行の取得中表示は不要と指定した。 現行経路は
`/model` → `RemoteCatalogUi.beginLoading`の2行overlay → Coreのprovider一覧/metadata取得 →
一覧overlay。会話画面から短いoverlayを経て一覧へ置き換えるため、途中の画面変化が生じる。

取得中のmodel
overlayを出さず、従来の会話画面とfooterの短い取得状態を維持し、完了時に一覧を表示する。
非表示でも読み込み状態は `RemoteCatalogUi` が所有し、入力dispatchをその状態に従わせる。
Esc取消と遅れて届く応答の無視は維持する。毎回取得する時点とprovider/effort/favoriteの動作は変えない。

具体的な確認は、遅延した取得中に2行overlayが出ないこと、取得中Escが有効で完了後に再表示しないこと、
再度開くと一覧取得・検索・選択ができること。focused test、source type
check、format/lint/diff確認と、 隔離HOME/XDG/workspaceのproduction tmuxで確認する。外部provider
requestは追加しない。


追加修正の確認結果: 更新したremote/catalog focused3件が成功。CLI source type check、変更TS4fileの
format/lint、diff checkも成功。隔離80列×32行tmuxのsource/compiled TUIで、取得中の会話領域が変わらず、
2行overlayが出ないこと、取得中Esc取消、遅れた応答で再表示しないこと、再度開いて検索・選択できることを
確認した。各modeのloopback一覧2回・metadata2回・generation0回。外部requestは0回。
確認用Core/TUI/tmuxは終了済み。取得状態はfooterに短く表示する。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/picker-loading/`の
source-tmux.log、compiled-tmux.log、tmux-results-source.json、tmux-results-compiled.jsonと各画面/snapshot。
focused結果は一段上のpicker-loading-tests.log。確認用binaryは同directoryのhenji、build
`de7b1853d88fc3d3c9a0417194568eba4cb8b16e382d25a6bd7881814bdfd5b2`、runtime
`487e658febe5fe4992db681944257e59d81fa8cf4b1257c3c7ee33dce69896ad`。追加修正はlocal確認後、下記のGo暫定方式と合わせて常用配置した。

### 通常利用での追加観測

- qwen3.8-maxのeffortがautoだけになるとの利用者観測を調査した。常用のGo両宣言には
  `modelsDevProviderId`がなく、実装はopencode-go-chat/responsesをmetadata keyとして照合していた。
  models.devの同keyは存在せず、opencode-goのqwen3.8-maxにはlow/medium/xhighが存在することを
  公開APIのDeno fetchで確認した。先の実provider確認は隔離宣言へ対応付けを追加していた。
  常用宣言の追加/既存Core再起動は今回行っていない。
- 利用者がGoのChat/Responsesで同じ一覧を表示することとAPIエラーを質問した。
  今回の実装は共通の/models一覧を表示し、API別の絞り込みや選択時のroute切替はない。
  [Go公式endpoint表](https://opencode.ai/docs/go/#endpoints)はモデル別のAPIを案内する。
  GPT/GrokはResponses、Qwen3.8はMessagesと掲載されている。ただし推奨surfaceの掲載だけから、
  ほかの互換surfaceが必ず失敗するとは確定できない。
  実確認済みのGo代表経路はGLM ChatとGPT Responsesであり、全モデルと両APIの組合せは未確認。
  共通一覧を全モデルの両API対応保証とは扱わない。API別分類や自動route切替は追加要件として未採用。


## 追加修正 — Goの暫定カタログ運用（2026-09-29）

利用者がGoの共通一覧とモデル別API対応を踏まえ、将来一providerへ統合するまで、
Goは外部カタログだけを参照し、必要に応じagentが更新する運用を採用した。
GoのChat/Responsesはそれぞれ登録済みモデル・effortを表示し、一覧もmodels.devも外部取得しない。
OpenAI/OpenRouterなど既存のAPI一覧方式は維持する。お気に入りの登録・解除と候補一覧は分離する。

現行経路は外部provider宣言のCore起動時読込み → protocol/endpoint/auth・固定entriesの保持 →
LiveModelCatalogの一覧/metadata取得 → /modelと/effort。保存お気に入り・default effortは別のconfig file。
provider宣言に任意のmodelListSource（provider/catalog）を加え、既定はprovider。
catalogでは宣言entriesを一覧とeffortの正本にし、同じ合成・お気に入り・記憶経路を使う。
プロトコル分類の推測、未登録モデルの一般的な選択拒否、Go自動API切替は加えない。

常用Go宣言は新binaryの配置後にcatalog方式へ更新する。既存entriesは保持する。
カタログ更新は宣言JSONのmodelCatalog.entriesへモデルとeffortを追加し、Coreを再起動する。
ビルドは不要。稼働中Coreを自動停止・移行しない。
モデル追加は公式情報と、そのAPI経路の最小実行を確認して行う。

確認対象は外部宣言の解析、cold /effortと/modelの外部requestゼロ、favorites/effort記憶と再起動、
更新した宣言entriesの読込み、API方式の従来動作。focused/type/format/lint/diffと隔離production tmuxで
確認し、常用反映後のidentityと実config読込みも確認する。構想/architecture/roadmapの変更は含めない。


追加カタログ方式の確認結果: focused8件成功。外部宣言parse、cold effort、登録モデルだけの一覧、
お気に入りを解除しても候補と選択を保持すること、記憶値と再起動、宣言へ追加したモデルの読込みを確認した。
CLI source type check、変更TS7fileのformat/lint、diff checkも成功。
source/compiledの隔離80列×32行tmuxで、Go ChatとResponsesの候補が分かれ、cold /effortと再起動後も
宣言の候補を表示し、Tabの独立操作・検索・選択とmodel別effort記憶が成立した。
両modeとも一覧/metadata/generation requestは0。API方式は既存focusedと取得中表示のtmux証拠を参照する。

Qwen3.8 MaxをGo Chatの宣言へ追加し、auto/low/medium/xhighを候補とした。
承認済みの実provider確認範囲で、compiled production TUIから登録一覧→選択auto→/effort低指定→
最小生成を実行した。outcome=completed、物理request1回でGO_CATALOG_OKを得た。
一覧/models.dev requestは0。確認用Core/TUI/tmuxは終了済み、実credentialの隔離コピーは除去した。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/go-catalog/`の
build.log、tmux-results-source.json、tmux-results-compiled.json、各modeの画面/snapshot、
real-qwen/result.json・completed.json。focused結果は一段上のgo-catalog-tests.log。
検証binary buildは`b95c26b7aad25b8e2d62809b922299d2257086c723f774b5907fd29148f646d0`、runtime
`26fa116ff50396a9cc8782fbeb78c33a2bbe89e031f54b5b187922f03cd872cf`。

先の利用者のcommit/push・配置指示に続け、取得中overlay削除と今回のGo暫定方式をcommit/pushし、
固定commitのclean buildから常用配置する。Goの両外部宣言へmodelListSource=catalogを反映し、
Chat側へ確認したQwen3.8 Maxを追加する。既存Core三つは保持して新規起動から適用する。
Product正本の変更・JSR公開・既存Coreの停止/移行は対象外。


### 追加修正のcommit・配置結果

取得中overlay削除とGo暫定方式の10fileをcommit `6263de95b6fcfa5bb96e226062cbfdb17deb1856`へまとめ、origin/mainへpushした。
固定commitのclean checkoutから公式buildし、検証候補とruntime SHA-256の一致を確認して常用配置した。
sourceDirty=false、henji 0.7.0。

- build ID: `48e38e5204422eb37bfb74003c03b1cdeacd4cc476d2783998d7b7cdf0e5395d`。
- runtime SHA-256: `26fa116ff50396a9cc8782fbeb78c33a2bbe89e031f54b5b187922f03cd872cf`。
- binary SHA-256: `eb4ad7cda6ca51a708f31b63342c47b51ac618487e282d312f47e8e8b003d4cf`。
- 配置先: `/home/agent/.local/bin/henji`。
- 旧binary: `/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/go-catalog/deployment/henji.previous`。

常用の`~/.config/henji-harness/providers/opencode-go-chat.json`と同responses宣言へ
`modelListSource: catalog`を反映した。既存entriesを保持し、Chat側へ実確認したQwen3.8 Maxを追加した。
Chatは6モデル、Responsesは2モデル。お気に入り・記憶effort・default-selection・credentialは変更していない。
両宣言のreadbackが一致することを確認した。既存catalog更新にmodelsDevProviderIdの追加は不要になった。

配置binaryそのものと常用宣言のコピーを隔離HOME/XDG/workspace/tmuxで確認した。
Goのcold /effort、API別の登録一覧、Qwenのeffort候補、Tabと選択の独立、再起動の記憶を再確認し、
一覧/metadata/generationは0 request。Coreのsource/build/runtime/dirtyは配置identityと一致。
別のAPI一覧方式の隔離TUIでは、読み込み中も会話行を保持し、2行overlayなし、Esc取消と遅れた応答の無視、
再度取得して検索・選択が成立した。一覧2回・metadata2回・generation0回のloopback確認で、外部requestは0。
確認用Core/TUI/tmuxは終了済み。

稼働していた既存Core三つはPID/start time・epoch・Session・phase・buildを保持し、配置後もHTTP応答した。
それらの停止・移行は行わず、新規起動から今回のbinaryとGoカタログ設定を使う。

配置証拠は`/home/agent/.local/state/henji-build-artifacts/increment-157-20260929/go-catalog/deployment/`のbuild.log、deployment.json、version.txt、config-update.json、
preexisting-cores.json、preexisting-cores-after.json、tmux-results-deployed.json、loader-verification/の
tmux-results-deployed.jsonと各画面/snapshot。旧Go宣言は同directoryのprevious.jsonへ保持した。
配置記録とhandoffを文書commit `152771480c7a08538797f6dd5c31ddc0096202bf`へまとめ、origin/mainへpushした。
Product正本とJSRは変更していない。

## 利用者確認・完了承認（2026-09-29）

利用者の「確認しました このインクリメントを完了とします 関連文書を更新して
その後セッションを終了します」により、Increment 157の利用者確認・完了承認とセッション終了を記録した。
完了範囲にはE6のモデル一覧・検索・お気に入り・effort対応、取得中overlay削除、Goの暫定カタログ運用を含む。

最後のcommit/push・配置指示では配置後の確認は今回は不要と指定されたため、追加の動作確認は行っていない。
上記の実装・検証・review・配置結果と、今回の利用者確認を完了の根拠とする。
確認用Core/TUI/tmuxは既に終了済み。常用binaryとGoの外部宣言を保持し、既存Coreの停止・移行は行わない。
関連文書の完了状態とhandoffを更新し、次は利用者の新しい指示から再開する。

構想・architecture・roadmapへの意味変更とJSR公開は今回の完了記録更新に含めない。
Product正本への変更案は上記に保持し、未採用候補は[通常利用メモ](../experience/normal-use-inbox.md)を参照する。
