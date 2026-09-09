# 通常利用 increment 15 — 同一Session内のroot provider切替

ステータス: **実装・検証・第三者review・production TUI user確認完了**

対応architecture:
[`docs/architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)

## 利用者が必要とする動作

- 同一Henji Sessionのidle時に`/provider`を開き、OpenRouterとOpenAI directを選べる。
- providerを選ぶと、そのproviderのdefault model/effortからなる完全なroot selectionへ一度に切り替わる。
- `/model`はactive providerのcatalogだけを検索・表示し、model選択時にそのmodelのdefault effortを適用する。
  `/effort`はactive provider/modelで利用可能なeffortだけを表示する。
- providerを切り替えた次のturnから新routeを使い、admit済みturnの途中ではrouteを変えない。
- OpenRouterからOpenAI、OpenAIからOpenRouterへ切り替えても、同じsemantic transcriptとcontextを継続する。
- active provider/model/effortをSessionへ保存し、`/sessions`、resume、footer、turn attribution、execution
  artifact、provider evidenceから実際のrouteを確認できる。

## 確認済みの根拠と現在地

- Increment 14でgeneric `ModelSelection`、provider別catalog、Session v4、generic Worker protocol、Worker-local
  provider materialization、provider別auth resolver、evidence attributionを実装済みである。
- Workerはgeneric selectionを受けてroot modelを差し替え、Hostはidle-onlyなselection変更をSession commitとWorker
  acknowledgementで確定する既存経路を持つ。現在はHostのprovider一致checkがcross-provider変更だけを止めている。
- TUI/presentationは`/model`と`/effort`をOpenRouter catalogへ直接結合しており、`/provider` intent/pickerを持たない。
- Session `7656d48a`のproduction通常利用でOpenAI `gpt-5.6-sol` / `medium`がtext finalと`read` tool
  continuationを完了した。保存済みevidenceには2回のOpenAI requestのraw response、SSE event、parser
  transitionがあり、Authorizationとcredential pathは含まれていない。
- 実装前preflightで、OpenAI rootがOpenRouter Sonar `web_search`を一回使いOpenAIへ戻ってfinalを返す
  production Worker/Host経路を確認した。request列は`openai -> openrouter -> openai`の3回で、各routeのauth
  profile、HTTP 200、raw response、OpenAI SSE event、parser transitionを保存した。credential値、Authorization、
  credential pathはartifactとevidenceに含まれていない。
- 実際のprovider往復後のsemantic transcript継続は、実装後のproduction TUI Session `a338621b`で確認した。
- OpenAI公式model documentationで、`gpt-5.6-terra`はResponses APIとfunction callingをサポートし、
  `reasoning.effort`のdefaultが`medium`であることを確認した。
  [GPT-5.6 Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- 同documentationで、`gpt-6-astra`はResponses APIとfunction callingをサポートし、effortは`low`、`medium`、
  `high`、`xhigh`、`max`であることを確認した。初期defaultには利用者指定の`low`を採用する。
  [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
- 登録済みPlatform API keyを使い、`gpt-5.6-luna` / `medium`、`gpt-5.6-terra` / `medium`、
  `gpt-6-astra` / `low`へ「`OK`だけ返す」requestを各1回実行した。3件ともResponses APIのstreamをHTTP
  200で完了し、Henji adapterは`OK`を返した。raw response、SSE event、parser transition、route metadataも各requestで
  取得できた。`gpt-5.6-sol` / `medium`はSession `7656d48a`の通常利用で確認済みである。

## 採用するSurface動作

### `/provider`

- exact slash command `/provider`を追加する。既存pickerと同じく、turn実行中ではなく入力bufferが空のときだけ開ける。
- pickerは`openrouter`と`openai`を表示し、現在のproviderを初期選択する。Up/Down、Enter、Escを既存pickerと
  同じ意味で使う。
- Enterで別providerを選ぶと、次の完全なselectionを一回の変更として直ちに適用する。
  - `openrouter`: 現行`ROOT_DEFAULT_MODEL_SELECTION`
  - `openai`: 現行`OPENAI_DEFAULT_MODEL_SELECTION`
- provider選択後に追加の確定画面は置かない。modelを変えたい場合は続けて`/model`、effortだけを変えたい場合は
  `/effort`を使う。それぞれの変更も常に完全なselectionを渡す。
- credential未登録でもprovider選択自体は可能とし、credentialは従来どおりrequest時に解決する。未認証footer
  statusとHenji内key登録は`normal-use-inbox.md`の別候補であり、このincrementへ含めない。

### provider-scoped `/model`と`/effort`

- provider別catalogへ共通の検索、model選択、effort候補取得interfaceを追加する。
- OpenRouterでは現行11件のcurated listと検索挙動を維持する。OpenAI curated listは次の4件とする。
  - `gpt-5.6-sol`: root default、default effort `medium`
  - `gpt-5.6-luna`: default effort `medium`
  - `gpt-5.6-terra`: default effort `medium`、候補`none` / `low` / `medium` / `high` / `xhigh` / `max`
  - `gpt-6-astra`: default effort `low`、候補`low` / `medium` / `high` / `xhigh` / `max`
- model選択時のdefault effort自動適用と、`/effort`での明示変更を維持する。
- status行には選択後のprovider/model/effortを表示する。

### footerとSession表示

- footer 1行目は従来どおり一時status専用とする。
- footer 2行目はcwd、Session短縮ID、provider、model、effortを常時表示する。十分な幅では
  `[cwd session:xxxxxxxx provider:openai model:gpt-5.6-sol medium]`の形とする。
- 狭い幅ではSession、provider、effortを保持し、cwdを前方省略してから除外し、それでも収まらなければmodelを前方
  省略する。providerをmodel IDから推測させない。
- `/sessions`はIncrement 14で追加したprovider/model/effort表示を維持し、選択したSessionのactive selectionをそのまま
  resumeする。

## 実装slice

1. **real-provider preflight**: product source変更前に、OpenAI rootがOpenRouter Sonar `web_search`を一回使い、
   OpenAIへ戻ってfinalを返す短いWorker/Host実経路を実行する。request列が
   `openai -> openrouter -> openai`、auth profile、raw response/SSE、request countと一致することをmetadataで
   readbackする。credential値とAuthorizationは表示・記録しない。
2. **provider-scoped catalog**: provider一覧、active providerに対するmodel検索、selection生成、effort候補取得を
   provider-neutral interfaceへ集約する。既存catalogの内容とdefaultは変えない。
3. **typed Surface command**: slash parser、presentation intent/result、controller overlayへ`/provider`を追加し、
   `/model`と`/effort`をactive providerのcatalogへ接続する。UIからAPI/auth identityを組み立てず、adapterがprovider
   catalogの完全なselectionへ解決する。
4. **atomic Host/Worker transition**: HostのIncrement 14限定provider拒否を外し、既存idle check、Session v4 commit、
   Worker `select_model` acknowledgement、rollback/unavailable境界をgeneric routeで成立させる。変更履歴は同じnext
   turnに有効な一件として記録し、planner defaultはOpenRouterのまま変えない。
5. **persistent attribution**: provider往復後のturn requestがactive adapterのwire計測とprovider-private stateを使い、
   foreign provider stateはsemantic messageとして再構築されることを確認する。Session active selection、model changes、
   turn models、execution manifest/resource、evidence metadataを実routeへ一致させる。
6. **footer/help/docs**: footer 2行目、startup/help command一覧、README、roadmap、increment記録を新Surface動作へ合わせる。
7. **検証とreview**: 下記focused product確認後にtype check、format、lint、`git diff --check`、差分reviewを行い、
   安定候補でauthoritative `v0:gate`を一回実行する。最後にproduction TUIでprovider往復を人間が確認する。

## Product確認

| 動作 | 確認方法 |
| --- | --- |
| `/provider`がactive providerを示し、別providerのdefault selectionへ一度に切り替える | controller/presentationのfocused testとHost selection結果 |
| `/model`検索と`/effort`候補がactive providerだけを使う | OpenRouter 11件とOpenAI 4件のpicker操作 |
| admit済みturn中は切り替えず、idle後の次turnから有効になる | busy拒否と次turn requestのprovider metadata |
| OpenRouter → OpenAI → OpenRouterでconversationが継続する | provider別fake transportを通す同一Sessionの3 turnとtranscript確認 |
| selection変更が一つのdurable stateとしてresumeされる | Session v4のactive selection、change history、turn attribution、reopen |
| manifest、artifact、evidenceが実際のrouteを示す | 各turnのroot selection/resource/request metadata readback |
| footer 2行目がproviderを常時表示する | 160 columnsの完全形と80 columns以下の省略順 |
| 既存OpenRouter通常利用を維持する | Increment 12〜14 focused regressionと最終gate |
| 実providerでも往復できる | 短いproduction TUI taskを各providerで一turnずつ実行し、Session resumeとevidenceを確認 |

Testは上記の具体的なproduct動作に対応するものだけを追加する。未観測provider variant、credential/permission
matrix、一般的なhardeningはこの計画へ加えない。

## 対象外

- planner/subagent routeの対話的変更
- 複数auth account picker、自動retry、provider/model fallback
- 未認証footer statusとslash commandによるAPI key登録
- built-in instruction component再設計（Increment 16）
- Codex/ChatGPT subscription認証（Increment 17）
- OpenAI built-in Web search、vision、OpenRouter SDK移行

## Human Gate

2026-09-09承認済み。最大3回のreal-provider preflight、provider picker選択時のprovider defaultへの即時切替、
この文書に記載した実装、focused test、review、authoritative gate、production TUI user確認準備までを承認範囲とする。

## 実装結果

- provider一覧とprovider-scoped catalog interfaceを追加し、OpenAI directのcurated listを承認済み4 modelへ
  拡張した。`/provider`、`/model`、`/effort`は常に完全な`ModelSelection`へ解決される。
- HostのIncrement 14限定provider一致checkを外し、既存のidle判定、Session commit、Worker acknowledgement、失敗時
  rollbackをprovider横断でも使う。planner defaultはOpenRouterのまま変更していない。
- `/provider` pickerは現在providerを初期選択し、別providerを選ぶとそのdefault model/effortへ即時に切り替える。
  `/model`の検索と`/effort`候補はactive providerへ限定した。busy中の`/provider`はactive turnへsteeringせず、
  他のselection commandと同じくready待ちとして入力bufferに残す。
- footer 2段目にproviderを追加した。通常幅はcwd、Session短縮ID、provider、model、effortを表示し、狭幅では
  cwdを除外してmodelを前方省略する。40列のdegraded表示でもSession/provider/model/effortを保持する。
- README、Agent source guide、roadmap、help、slash command一覧を新しいSurface動作へ更新した。

## 検証とreview

- 実装前real-provider preflightは、OpenAI `gpt-5.6-sol` root、OpenRouter Sonar `web_search`、同じOpenAI
  rootの順に3 requestでfinalまで完了した。route別auth profile、HTTP 200、raw response、SSE/parser evidenceを
  readbackし、credential値、Authorization、credential pathが保存されていないことを確認した。
- Increment 15 focused testは6 passed。provider-scoped catalog、typed selection、picker/search/effort、footer、
  provider固有stateをsemantic messageへ戻す両方向wire、同一SessionのOpenRouter → OpenAI → OpenRouter、
  change history、turn attribution、artifact、planner固定、resumeを確認した。
- production相当のretained controller testを追加し、busy中の`/provider`がsteeringされないことを確認した。
- 第三者reviewはbusy command分岐、40列footer、古い継続文書の3 findingを報告した。修正後の限定再reviewで
  3件解消、新しいBlocker/P1なしを確認した。
- authoritative `v0:gate`は、初回に旧footer表示を前提とする既存conversation testで停止した。新しい省略契約へ
  testを更新してfocused確認後に再実行し、type check、format、lintと全121 offline testsを通過した。
- 2026-09-09、利用者がproduction TUIの同一Session `a338621b`でOpenRouterからOpenAI
  `gpt-5.6-sol` / `medium`へ切り替えてREADME要約を実行し、OpenRouter
  `deepseek/deepseek-v4-pro-0813` / `high`へ戻して直前の要約を英訳した。Session v4のchange historyとturn
  attributionはturn 1をOpenAI、turn 2をOpenRouterとして保存し、現在selectionもOpenRouterである。
- 両turnのexecution artifactはcommit済みである。provider evidenceはOpenAI 3 requestとOpenRouter 1 requestを
  すべてHTTP 200として保持し、raw response、SSE event、parser transitionをreadbackできた。Authorization keyと
  credential pathは保存されていない。
