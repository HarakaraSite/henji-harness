# Increment 163 — Sign in with ChatGPTによるChatGPT契約枠の利用

更新日: 2026-10-01

ステータス: **利用者確認・完了承認済み（2026-10-01）。**
利用者の「では案を次のインクリメントとする」により、A1の対応改訂案をIncrement 163へ採用した。
本書が要件、対象範囲、計画、実装・検証・配置・利用者確認結果の正本である。改訂案の本文を本書へ移し、通常利用メモのA1候補は除いた。
採用後、利用者の「では実装を始めてください 実装後コードとテストをレビューさせてください 配置後登録してみます」により、本体実装・レビュー・常用配置を承認した。追加実provider確認・commit/push・公開は未指示。
spikeの実測結果は[検証記録](../research/a1-chatgpt-sign-in-spike.md)を参照する。

## 目的と採用した方針

ChatGPT固有の認証とrequest差分を限定した箇所に置き、通常のResponses呼び出しへ合流させる。
親だけでなく子も同じprovider経路を使い、親が別providerでもChatGPTの子を起動・回収できる構成を第一案とする。
providerの選択identityを分けることと、内部adapterを共通化することは別の判断として扱う。

## 利用者が必要とする動作

1. VM上のHenjiで認証を開始し、VM外の手元browserで承認する。アドレスバーのcallback URL全体を
   TUIの非表示入力へ貼付すると、Coreがtoken交換・保存を完了する。
2. 接続済みChatGPT accountと、そのaccountで表示可能なmodel一覧を参照して選択する。
   親がChatGPTを使っていなくても、認証・一覧取得・子での利用ができる。
3. 親をChatGPTにすると、通常の会話、Henjiのlocal tool往復、同じSessionの後続turnを実行できる。
4. 親がOpenRouter等の別providerの場合も、`spawn_subagent`でChatGPTのmodelを指定し、
   子がtaskを実行して、`collect_subagent`で結果を親へ返せる。親のprovider設定は変わらない。
5. 子のmodel指定を省略した場合は、既存どおり親の現在selectionを継承する。
   ChatGPTの親から別providerの子を指定することも、同じ選択経路で扱う。
6. processを起動し直して保存認証を使える。access token期限切れ後は更新して呼び出しを続ける。
   親・複数の子・model一覧取得・複数Coreが同じ認証を使う場合も、更新結果を共有する。

成功基準は人間がproduction TUIと実provider経路で上記を完了できることとする。
offline確認やspike成功だけでは、本体対応の完了とは扱わない。

## 根拠と未確認事項

2026-10-01のspikeでは、VMで認証開始、VM外browser承認、手動callback、token保存とID検証、 account
model一覧、`gpt-5.6-sol`の短い応答・namespace echo往復、期限切れ後のrefreshが成立した。
事前レビュー後の再実測では推論3回すべての完了イベントoutputが空配列で、確定itemから本文・toolを取得できた。
累計は外部HTTP
11回、推論6回。詳細とレビュー対象hashは[実測記録](../research/a1-chatgpt-sign-in-spike.md)を参照する。

本体の親子実行、並行refresh、再login、reasoning item再送は下記のlocal/mock検証で確認した。
実providerでの本体成立とreasoning item再送の受理は、配置後の利用者操作まで未実測。
`gpt-6.1-sol`は今回取得した表示対象一覧に無く、提供されない理由や直接指定時の利用可否は未確定である。
実装でmodel名を固定したり、取得一覧に無いmodelへ自動置換したりする根拠にはしない。

外部契約はOpenAI
Docsの次の資料を使う。Piは手動callbackと責務分離の参考とし、旧backend接続を移植しない。

- [登録・認証](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): dynamic
  client登録、host ID、発行済みclient ID再利用、PKCE、ID tokenと契約枠permission検証。
- [accountとsession](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions):
  account別登録・client/tokenの対応、保存accountの選択、同じsessionのrefresh直列化とreplacement保存。
- [model一覧・推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
  account別`models`、表示名とslug、OAuth bearerによる公開Responses API呼び出し。
- [preview条件](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):
  `store:false`、`stream:true`、必要な履歴配列、namespaceによるfunction宣言。 Henjiの子起動はlocal
  function toolであり、未対応のAPI field `multi_agent`は使わない。

## 現行経路と変更の合流点

人間の認証操作はTUI `/login` → CoreのHTTP credential登録 → API key file保存である。
model一覧取得はCore側でそのfileを直接読む。model呼び出しはWorkerの `createProductionPhysicalIo` →
request時のcredential resolver → Responses adapter → Henjiのtool loop →
Hostのsemantic履歴・outcome保存へ進む。

子の起動ではHostが指定model、または親の現在selectionを確定し、provider declarationとともに
子Workerへ渡す。子も同じ`createProductionPhysicalIo`を使い、空transcriptから独立したExecutionを開始する。
resultはcollect時のtool resultとして親contextへ入る。子専用のmodel呼び出し経路は増やさない。

```text
TUI /login → CoreのChatGPT認証操作 → user scopeのaccount登録・token保存
                                         ↓
Coreのmodel一覧取得 ───────────────→ 共通の認証解決処理
親／子Workerのmodel呼び出し ──────→ 共通の認証解決処理
                                         ↓ 有効なaccess token
                               共通Responses adapter
                                         ↓
                        既存のHenji tool loop・履歴・outcome
```

## 共通部分とChatGPT固有部分

| 部分                                             | 改訂案                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| OAuth開始・callback・token交換・account登録      | Coreの認証serviceに置く。TUIはURL案内、非表示入力、状態表示を担当する。                                            |
| 保存・refresh                                    | ChatGPT用認証moduleが所有し、Coreの一覧取得と全Workerのcredential resolverから使う。                               |
| request時の認証                                  | 既存の`CredentialSource`へ有効なtokenを返し、通常のmodel呼び出しへ合流する。                                       |
| model一覧                                        | ChatGPTの`models[].slug/display_name/visibility`を読み、既存のcatalog表示・選択へ正規化する。                      |
| tool宣言                                         | ChatGPTのrequest構築部分でHenjiのfunction群をnamespaceへまとめる。local toolの名前と実行契約は共有する。           |
| Responses stream                                 | 確定itemを`output_index`順で保持し、本文・tool call・replayを共通処理へ渡す。完了イベントは成功判定・usageに使う。 |
| tool loop、子起動、status／collect／cancel、履歴 | 既存処理を共有し、ChatGPT専用の分岐を入れない。                                                                    |

共通adapterの変更では、既存providerで正常に返る確定itemと完了outputの関係を現行sourceと確認証拠で照合する。
未観測の形式を推測して拒否条件や代替処理を増やさない。既存API
key経路で空outputが発生するとは未確認である。

### providerとadapterの選択

第一案は共通Responses adapterを使い、認証方式、catalog読取、tool宣言形式の差分を入口で解決する。
これらを差し込むためだけに、全provider向けの新しいplugin frameworkを設けない。

選択上のprovider IDは、契約枠とAPI keyの認証・catalog・replay identityを明確にするため
`openai-chatgpt`を分ける案を推奨する。これは薄いroute追加であり、Responses実装の複製を意味しない。
同じprovider内で認証方式を選ぶ案も残すが、その場合は親子のmodel指定とreplay identityでも
認証方式を表現する必要がある。最終identityは本incrementの具体設計で確定する。

実装設計でChatGPT専用の分岐がstream処理・結果変換まで散らばるなら、専用の薄いadapterへ分ける。
その場合も確定item収集とResponsesのinput/output変換は共有できる範囲を使い、Henjiのtool
loopは共通のままとする。
分離の判断は具体的な差分を示して行い、専用adapterを先に大きく作る前提にはしない。

## 認証の状態所有と並行更新

host ID、account登録ID、client ID、検証済みidentity、token集合と期限はuser scopeの専用保存先へ置く。
保存accountを選ぶか、新しい登録を追加する最小の操作を認証画面に用意する。
同じemailでも登録を区別し、account/client/tokenを同じ登録単位で扱う。 通常のAPI
key登録とChatGPT登録は認証方式の情報で分け、OAuth tokenをAPI key入力欄へ登録する操作にはしない。

Coreはlogin attemptとaccount選択を所有する。Workerへは非secretの認証profile・登録の参照を渡し、
request時にWorker-local resolverが共有認証moduleを呼ぶ。token値をWorker start command、
Session、model context、通常evidenceへ渡さない。 Coreのmodel一覧取得も同じ解決処理を使い、既存のAPI
key file直読経路からChatGPT tokenを読むことはしない。

親子が別Workerで、複数Coreも同じ保存先を使えるため、process内のPromise共有だけでは更新をまとめられない。
同じ登録/sessionの更新をlocal file lockで直列化し、lock取得後に保存tokenと期限を読み直す。
更新が必要な一つの呼び出しだけがrefreshし、replacement集合を保存した後、他の呼び出しはそれを読む。
このlockはtoken更新を対象とし、通常の推論requestを直列化しない。
token取得・更新の失敗理由は認証操作とprovider結果へ伝え、すべてをAPI key未設定として扱わない。

親のturnと子の起動では使うaccount登録を非secretの参照として確定する。
実行中のtool往復は同じaccountを使い、その登録のtokenだけを更新できるようにする。
account選択を変更した場合は次の実行から適用し、model一覧とreplayの参照もその登録に対応させる。
現在のResponses replayはprovider/modelで区別するため、同providerの別accountを扱う場合の account
bindingも変更対象である。具体的な型と保存位置は本incrementの具体設計で決める。

## 別providerの親からChatGPTの子を呼ぶ経路

例として、親を`openrouter-chat`、子を`openai-chatgpt`の`gpt-5.6-sol`とする。

1. 人間は親のproviderを変更せず、`/login`からChatGPT認証を済ませる。
2. CoreはChatGPTの接続状態とaccount model一覧を、親のselectionに関係なく取得できる。
3. 親が`spawn_subagent`でprovider/modelを指定する。Hostは既存のmodel選択処理で
   子selectionを確定し、ChatGPT routeと非secretの認証参照を子へ渡す。
4. 子Workerが共通resolverでChatGPT tokenを取得し、通常のResponses adapterから実行する。
5. 子のtool・reasoning履歴は子Executionに保持する。親にはcollectの結果を返し、
   ChatGPTのprovider-private replayを親の別providerの履歴へ混ぜない。

認証moduleやChatGPT routeの初期化を「親がChatGPTを選んだとき」に限定しない。
CLI／headlessもTUIで作ったclosureの継承に依存せず、同じ保存参照とresolverで使える構成にする。
未接続の子はその子の失敗として既存のspawn／status／collect経路で理由を返し、親の認証を代用しない。
provider/modelを選べることをmodelに伝える既存のcatalog／tool
description経路も確認し、必要な変更を同じ範囲に含める。

## 影響範囲

| 現行component                                                                 | 変更責務                                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `v0/agent/provider/credential_registration.ts`と新しいChatGPT認証module       | 認証方式、account登録、login attempt、専用保存・更新。                            |
| `credential_resolver.ts`、credential availabilityの判定                       | 全Worker共通の認証解決と、保存状態からの接続表示。                                |
| `live_model_catalog.ts`                                                       | 共通認証解決、ChatGPT一覧の読取、accountに対応するcache・選択。                   |
| `provider_declaration.ts`、`model_selection.ts`、defaults                     | 認証方式とroute差分の最小表現、選択identity。tokenは宣言に含めない。              |
| `openai_responses_model.ts`                                                   | namespace request、確定item収集、tool／本文／replayへの共通変換。                 |
| `worker_physical_io.ts`、`worker_bootstrap.ts`、必要なWorker protocol         | 親子とも同じroute・resolverを生成し、非secretのaccount bindingを扱う。            |
| `worker_host_children.ts`、`tools/async_agents.ts`                            | 指定selection・継承と利用可能routeの確認。子専用OAuth flowやtool loopは作らない。 |
| `host/core_service.ts`、`http/server.ts`、`v0/api/contract.ts`・client・codec | 認証開始・callback受付・取消・状態、一覧取得を既存Core APIへ接続する。            |
| `v0/tui/remote_catalog_ui.ts`と関連state／入力描画                            | `/login`の認証方式分岐、account選択、URL案内・非表示callback入力、完了表示。      |

上表は現行経路から得た変更責務であり、全fileの変更を必須とする一覧ではない。 既存tool
loopや履歴保存に新しいChatGPT分岐を要する場合は、合流点の設計を先に見直す。
現行の`web_search`は独立したOpenRouter Sonar経路で、引き続きそのAPI keyを使う。
検索backend変更やChatGPTのhosted tool採用はこの案に含めない。

## 実装順序と到達点

TUIの`/login`で選ぶ項目は、利用者の指定により機能名の`Sign in with ChatGPT`とする。
公式UIガイドの認証開始action表記は`Continue with ChatGPT`だが、Henjiの選択肢には
利用者が認識しやすい機能名を採用する。参照:
[公式UIガイド](https://developers.openai.com/siwc/ui-ux-guidelines)。

1. **routeと認証の接続点を確定する。** 本incrementの採用範囲に基づきprovider identity、
   非secretのaccount binding、共通adapterの差分表現を決める。必要なarchitecture変更案を提示する。
2. **認証とCoreのcatalog経路を作る。** spikeの成立部分をmodule化し、登録・保存・refresh、
   複数Worker／Coreの更新共有、親providerに依存しない状態・一覧取得を実装する。 standalone
   spikeの保存形式を自動migrationする経路は設けない。
3. **全Workerから共通Responses経路へ接続する。** request差分と確定item収集を共通adapterへつなぎ、
   親・子のmodel生成、tool宣言・結果・replayを既存loopで扱う。
4. **TUIの通常操作をつなぐ。** API key入力とChatGPT認証操作を分け、VM外browserの手動callback、
   account/model選択、再起動後の接続状態を人間が使えるようにする。
5. **production経路で受け入れる。** 隔離XDGのtmuxで親の会話・tool往復・継続と、
   別providerの親からChatGPTの子を起動して回収する操作を確認する。

reasoning再送と再loginは未実測事項として、対応する段階で必要な最小probeを提示する。
今回の採用だけでは追加requestを実行しない。常用配置・commit/push・公開は別操作とする。

## 動作に対応する確認

| 確認する動作                                 | 根拠と確認方法                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| VM外browserから認証し、再起動後に使う        | 利用者の操作要件とspike成功。Core APIのfocused確認と隔離tmuxの実操作で確認する。                                                               |
| 空の完了outputでも本文・tool・履歴を得る     | 再実測3回で再現。確定itemを含むfocused確認とproduction tool往復で確認する。                                                                    |
| 別providerの親からChatGPTの子を回収する      | 利用者の明示要件。Hostでの指定selection、子Workerでのresolver使用、collect結果を確認し、最後に実providerで通す。                               |
| 親selectionを継承する／子だけ別routeを使う   | 現行の子起動契約。selectionの受渡しをfocused確認し、変更で親設定が変わらないことを確認する。                                                   |
| 期限切れの認証を親子・複数Coreが共有更新する | 現行の並行実行と公式のrefresh直列化。別Worker/processが同じ保存先を使う確認で更新の重複とreplacement読取を調べる。通常推論の並行性も確認する。 |
| reasoningと同Sessionの後続turnを再送する     | 既存Responses履歴契約。offlineでitem保持を確認し、reasoningを実際に返した応答から次requestへ進めて受理を確認する。                             |
| 既存API key providerを使い続ける             | 共通adapterと認証解決の変更による具体的regression。関係する既存focused確認を使い、追加実callは必要性を提示する。                               |

testは上記動作に対応させ、未観測provider variantやpermission matrixを推測で増やさない。
実装中はfocused test、type check、format/lint、diff checkを使う。full gateを各段階の前提にはしない。
TUI変更はproduction
tmux確認まで行い、必要な実provider確認は対象・見込み回数・保存先を提示して承認後に実行する。
通常factはprovider/model/API、step・request順、HTTP/error、解析field/shapeを保持し、semantic履歴をreadbackする。
credential値、Authorization、callback URL、raw request／responseやSSE全文を通常記録へ残さない。

## 正本文書への変更案と承認境界

構想の目的変更は今回の案では不要。architectureは固定API key fileからのcredential解決に加えて、
OAuthの保存・更新owner、account binding、共通Responses
adapterへの差分接続を記述する変更案が必要になる。
対象は`docs/architecture/henji-host-agent-worker.md`と、同書が参照するprovider/authの担当文書である。
roadmapの実装状態は本incrementの実装結果に応じて更新する案とする。

これらの意味上の変更は本書に留め、構想・architecture・roadmapは改訂していない。
product正本への反映は個別incrementの包括承認と分けて、対象・理由・変更内容への明示承認を得る。
本体実装・コードとtestのレビュー・常用配置は利用者の追加指示により承認済み。
追加実provider確認・commit/push・公開および上記product正本の改訂は未指示。

## 合意した認証UI

`/login`の最初の選択肢で認証の登録先を選ぶ。ChatGPTの項目名は、利用者の指定どおり
`Sign in with ChatGPT`とする。既存の登録先はprovider declarationから得たAPI key profileを表示する。
以下はOpenRouterとOpenAIを含む場合の表示例であり、登録先を三つに固定するものではない。

```text
  OpenRouter — API key
  OpenAI — API key
› Sign in with ChatGPT
```

初回は項目選択から認証開始へ進み、URL表示 → VM外browserで承認 → callback URLの非表示入力 →
account名を伴う接続完了表示、の順とする。保存登録がある場合は、先に登録accountの選択、
再認証が必要な状態、別accountの追加を表示する。同じemailでも登録を区別できるlabelを使う。
認証登録の操作では親のprovider/model設定を変更しない。

親がChatGPTを使う場合は既存のprovider/model選択へ進み、子だけが使う場合は起動時に指定する。
親selectionを変更せずにChatGPT
accountのmodel一覧を参照する具体的な画面操作は、TUIの詳細設計で確定する。

## 計画レビューの結果

利用者の指示により、通常レビューと批判的レビューを独立した二名のreviewerが実施した。
両reviewとも必須の計画修正・採用findingはなく、個別incrementへの採用判断と具体設計へ進めるとの判定だった。
共通Responsesへの合流、薄いprovider route、別provider親からChatGPT子への経路、 account
bindingとrefresh ownerを確認した。本体のproduction成立を確認した判定ではない。

レビュー対象は移管前の改訂案で、SHA-256は
`fce37426f8209412b69767fb18d1873a7a2bc0e235a043c403bd88f612225c30`。
レビュー後のUI項目名は利用者との合意で`Sign in with ChatGPT`へ具体化した。

具体設計で確認する点として、親selection非依存のmodel一覧参照操作、ChatGPT routeへの
`store:false`明示、resolverとadapterが認証失敗を`missing_credential`へ一括変換する現行処理の変更を引き継ぐ。
一般hardeningや未観測variantの追加は採用していない。

## 参照実装と以前の案

Pi snapshot `b35af04f465d60c2f15d124ed074476b8986deb4`では、通常のOpenAI provider内のOAuth経路から
公開Responses APIを使う。手動callbackと責務分離の参照先は
[OAuth実装](../../_refs/pi/packages/ai/src/auth/oauth/openai-chatgpt.ts)、
[provider](../../_refs/pi/packages/ai/src/providers/openai.ts)、
[Responses実装](../../_refs/pi/packages/ai/src/api/openai-responses.ts)である。

[Increment 17](increment-17.md)と[2026-09-29の旧A1調査](../research/a1-chatgpt-subscription-provider.md)は
以前の判断・調査として保持する。ChatGPT Codex
backendへのdirect接続案を本incrementの実装方針にしない。

## 現在の実装と受入状態

### 実装時に確定した接続点

- provider IDとauth profileは`openai-chatgpt`、protocolは`openai-responses`とする。
  公開APIの共通Responses adapterへ、OAuth token、namespace形式、account replay identityを接続する。
- 非secretのCore APIは`POST /api/v1/credentials/chatgpt`とし、`status`、`begin`、`complete`、
  `cancel`、`select`を扱う。callback入力はこの専用操作だけに渡し、応答・通常factへ含めない。
- user configの`chatgpt/`以下にhost、registration、account、選択参照を保存する。
  CoreとWorkerは同じ認証moduleを使い、account IDだけを実行境界で確定する。
  rootの公開selectionにはaccountを追加せず、内部のturn/子起動のbindingとして渡す。
- `/login` → `Sign in with ChatGPT` → 初回は認証URL案内 → Enterで非表示callback入力 → 登録完了。
  保存accountがある場合はaccount pickerへ入り、選択・再認証・追加を行う。
  accountをEnterで選択するとpickerを閉じ、通常入力へ戻って選択結果を表示する。
  pickerの`M`はhighlightしたaccountのmodel一覧を読み取り専用で開く。
  catalog requestへaccount参照を渡し、参照だけで保存accountや親selectionを変更しない。

### 通常コード・testレビューと修正

完了した認証、Core API、TUIのコードとtestを通常reviewerがread-onlyで確認した。
以下のP2二件を採用し、修正後の一回の限定re-reviewで双方の解消、新findingなしを確認した。

1. callback送信後の待機中に`Esc cancel`を表示しても、token交換・保存は進行していた。
   送信後は登録完了を待つ表示とし、取消を表示・送信しない。Auth APIも進行中の取消には
   `chatgpt_completion_in_progress`を返す。送信前のcallback入力・認証案内からはEscで取消できる。
2. 再認証のaccount保存がrefresh lockの外にあり、古いrefresh失敗が新loginのtokenを上書きした。
   再認証時のaccount読直し、identity照合、atomic保存にも同じaccount lockを使う。

両問題はsigned mockで再現した。authのdeferred二件とTUIの送信後操作一件をreviewerも独立実行し、
network権限なしで3 passed／0 failed。通常reviewの対象外であるruntime統合は、別の批判的レビューで確認する。

### 途中の実経路確認

sourceのproduction TUIを隔離HOME/XDG/workspaceのtmux（80×24）で実行した。
実Core APIとsigned mock issuerをつなぎ、`/login`の表記、認証URL全文表示、callbackの非表示paste、
登録完了のaccount名、`M`の読み取り専用model一覧を確認。親のOpenRouter selectionは変更されず、
Ctrl-Qで確認用TUI/Coreを終了した。実provider/OAuth requestは0。
compiled binaryの最終確認も下記のとおり完了した。
証拠は`/home/agent/.local/state/henji-build-artifacts/increment-163-20261001/source-tui-probe/`。

### runtime実装とlocal検証

共通Responses adapterへ薄いChatGPT routeを追加した。`store:false`、`stream:true`、namespace
`henji`のfunction宣言、空の完了outputに対する確定item取得とreasoning再送を扱う。
account別のmodel一覧は表示対象とserver順を保ち、cacheとfavoritesもaccountに対応させた。
API key経路、Henjiのlocal tool loop、子のstatus/collect/cancelは共有する。

親のChatGPT accountはturn開始時に確定する。明示的にChatGPT modelを指定した子は起動時の
保存選択accountを使い、model指定を省略した子は親selectionとChatGPT親turnのaccountを継承する。
子の起動経路がselected accountを取得しない場合に、保存認証があっても未設定扱いになる問題を
実Worker検証で再現し、起動時の保存参照取得を修正した。

実Workerの追加検証では、親をOpenRouter、子をChatGPTとし、保存account Aを子が読み、
local `read` → 二回目のResponses → collectまで実際のbootstrap/resolver/SDK/tool loopで通した。
transportだけをloopbackへ差し替えた。途中で保存選択をBへ変えても子の両requestはAを使用し、
暗号化reasoningは子の続行requestに再送、collectには最終本文だけが返った。実provider呼出しは0。

認証requestの短いfactはCoreのworkspace `chatgpt-auth-requests.jsonl`、Workerのrefreshでは
user config `chatgpt/requests.jsonl`へ保存する。後者はaccount/session/model/stepとAPI・request順・
HTTP/error・解析項目/value shapeを持ち、既存のsemantic履歴やinference factを置換しない。
credential/Authorization、callback値、raw body/SSE、暗号化reasoningは通常factへ保存しない。

focused確認はauth 7、Core API 1、TUI 5、runtime 5、実Worker子 1が通過した。
既存API key登録、remote catalog、multi-provider、非同期子、子model指定の関連確認も通過した。
CLIと担当sourceのtype check、project-config format/lint、`git diff --check`も通過。
full gateは計画に要求されておらず実行していない。

### compiled production TUI確認

official build scriptでcandidateを作り、隔離HOME/XDG/workspaceのtmux（80×24）で確認した。
compiled TUIから実Core APIへ接続し、signed mock issuerで登録を完了した。
`/login`の三方式表示、URL全文、hidden callback paste、完了account名、`M`の読み取り専用一覧、
serverのmodel順、親selection不変を確認した。
別途、compiled binaryだけでlauncher/Core/TUIを起動し、認証案内とcallback送信前のEsc取消を確認。
確認用TUI/Core/tmuxは終了済み。実provider/OAuth requestは0。

証拠は`/home/agent/.local/state/henji-build-artifacts/increment-163-20261001/`の
`compiled-tui-probe/`と`compiled-startup-probe/`へ保存した。
実account登録と本体の実provider受入は、配置後の利用者操作として残る。

### 批判的コード・testレビュー

独立reviewerが安定候補のruntime統合、共通Responses、親子account binding、refresh、catalogと
関連testをread-onlyで確認し、必須findingなし、利用者登録のための配置へ進めると判定した。
既存providerの非空completed output処理が維持され、追加account読取awaitの前後は上位task ownerの
同期的なbusy予約で保護されることも確認した。

review対象39 fileのsnapshotはartifact `review-source-snapshot.json`に保存した。
manifest SHA-256は`554901e12d398e7f60eb287ba525aaad1b78547cece4c94acdf4b3f76ed1fe6f`。
reviewからbuild・配置までこのsourceの同一性を確認した。
実Worker子testは別provider親のHostから子を起動するものであり、親の実OpenRouter推論が
spawnを判断する動作を実測したものではない。live受入とは区別する。

### 常用配置

2026-10-01、official `scripts/build_henji.ts`で作成したcandidateを
`/home/agent/.local/bin/henji`へatomic配置した。配置前binaryをartifactへ退避し、
candidateと配置先のbinary SHA-256一致、および配置先の`--version`を確認した。

- version: `henji 0.8.0`
- build ID: `ada1b43172b2f291ac72b89a3d7464e8d1173834a1b6b0b179f0f30e0ee62536`
- source: `85256f4e57629c3703ff83c10f865cf42d22531e+dirty`
- binary SHA-256: `3d235586b21c294e3a42f7ef8302695f1fa314b5339e61010b2755716b31c15d`
- 配置・退避先とverification記録: artifactの`deployment.json`、`verification.json`

配置先binaryも隔離HOME/XDG/workspaceのtmuxで新しく起動し、compiled Core/TUI、
`/login`の表記、認証案内、callback前のEsc取消を確認して終了した。
証拠はartifactの`deployed-tui-probe/`。実provider/OAuth requestは0。

新しく通常起動したHenjiへ適用する。配置前から稼働するCoreはそのまま保持した。
利用者は`/login` → `Sign in with ChatGPT`で登録し、VM外browserの承認後に
アドレスバーのcallback URL全体を非表示入力へ貼り付ける。
本体の実OAuth登録・実model一覧・実Responses推論・実refreshは、配置後の利用者確認待ちである。

### 利用者登録後のEnter導線修正・再配置（2026-10-01）

利用者の実登録accountが一覧に表示され、選択成功が表示された一方、Enterを押しても通常入力へ
戻らないことを観測した。成功処理が同じaccount pickerを再表示していたことが原因である。
初回のcompiled確認は登録と一覧参照までで、Enterによる終了操作が未確認だった。

選択成功時はmodalを閉じ、選択accountのnoticeを通常画面へ保持するよう修正した。
Enterの案内は選択して閉じること、Escは画面を閉じることを明示した。
選択失敗時は一覧と理由を維持する。親のprovider/modelは変更せず、model一覧参照と再認証/追加の
操作は継続して使える。

既存のproduct testを更新し、変更先accountと既選択accountの両Enterでmodalが閉じ、noticeが残り、
親selectionが変わらないことを確認した。再び`/login`を開いて再認証/追加/一覧参照も続ける。
TUI 5件・既存catalog 2件のtyped focused test、project format/lint、diff checkが通過した。
別reviewerの15分以内の局所reviewは必須findingなし。変更したproduct testをnetwork permissionなしで
独立実行し1 passed。

修正版をofficial buildし、隔離HOME/XDG/workspace、tmux80×24のcompiled TUIでsigned mock登録後と
account一覧再open後のEnterを確認。通常入力へ戻り、account選択noticeが表示され、親selectionも不変。
再配置後は配置先binaryとcompiled Core/TUIでも、保存mock accountのEnter終了を確認した。
実provider/OAuth呼出しは0。確認用Core/TUI/tmuxは終了し、利用者の実account/config/Coreは保持した。

現在の常用binaryはbuild ID `9c7c2492eb3d80d636a8fff9f78500c2939da9140903606d39fb5f239075825b`、
binary SHA-256 `9cf62dea503585a4956ff71efdec0e8d7856a6a0a0a8c291f4005a28fcc67e0e`。
sourceは`85256f4e57629c3703ff83c10f865cf42d22531e+dirty`。
配置・退避・compiled証拠は初回artifact以下の`account-enter-fix/`へ保存した。
新しいTUIから修正が適用される。既存TUIのaccount画面はEscで閉じられる。
登録済みaccountは再登録不要。親で使用する場合は`/provider`で`openai-chatgpt`を選び、`/model`へ進む。
この修正の確認では、本体の実model一覧・推論・更新と子実行を追加実測していない。

### 登録後操作の利用者確認（2026-10-01）

Enter導線の修正・再配置と、既存画面のEsc終了およびprovider/model選択案内の後、
利用者から「うまくいきました」との報告を得た。登録後の操作が進められることを利用者確認済みとする。
この報告だけでは、本体での推論、local tool往復、子実行、後続turn、期限切れ更新の確認範囲までは
特定できないため、それらのlive受入状態は個別の実行結果に基づいて更新する。

### 完了承認とセッション引継ぎ（2026-10-01）

利用者の「インクリメントを完了とする セッションを作り直すので記録して」により、
Increment 163を完了とした。実装・通常/批判的レビュー・常用配置、登録後のEnter導線修正と
再配置、利用者の成功報告を含めて完了承認を得た。

新しいセッションの入口は`.handoff/handoff.md`とする。現在の常用binary・証拠の所在は本書に保持し、
実登録accountと既存Coreを引き継ぐ。追加の実provider検証・commit/push・公開は別指示に従う。
未実測として記載した事項は実行証拠の範囲を表すもので、完了済みincrementの継続作業にはしない。
