# A1 — Sign in with ChatGPTのVM手動callback spike

## 目的と承認範囲

2026-10-01、利用者はA1の本体実装へ直行せず、独立した検証プログラムで試す方針を指定した。
合意した操作は、VMで認証開始 → VM外のbrowserで承認 → アドレスバーのcallback URL全体を
VMの専用入力へ貼付 → VMでtoken交換・保存・更新、である。

今回のlocal変更はspikeプログラム、focused確認、この記録とhandoffのpointerに限る。
Henji本体のprovider、TUI、API key登録、実config、配置binaryは変更しない。
A1のproduct実装への採用、構想・architecture・roadmap変更、commit/push・公開はこの指示に含めない。
2026-10-01、対象・回数・保存先を提示後、利用者の「実施してください」により 初回7
HTTP／推論3回の実provider確認を承認された。追加requestはこの承認に含めない。
実model一覧に第一候補がなかったため停止し、利用者の指定により対象を`gpt-5.6-sol`へ変更した。
同日、利用者は空の完了イベントoutputの再実測とspikeの事前レビューを指定した。
前回事前承認とは別の再実測として、同modelの短い応答1回・echo往復2回と、期限切れtokenの refresh
1回、同じ保存先を実行前に提示した。レビュー後に計4 HTTP／推論3回を実施した。

## 今回確かめる動作

1. VMのhost IDを保存し、Henji名でdynamic client登録を開始できる。
2. 手元のbrowserで承認後、最終callback URLの貼付でtoken交換まで進める。
3. ID
   tokenの署名・issuer・audience・期限・nonceを確認し、account/clientとtoken集合を隔離保存できる。
4. process終了後に保存状態を読める。再loginは発行済みclient IDとhost IDを再利用する。
5. 同じtokenでaccount固有のmodel一覧を取得し、表示名とslugを読める。
6. 選択したmodelで短い応答を受け取り、`response.completed`まで確認できる。
7. namespace内のlocal echo toolを一回実行し、output item/reasoningとtool resultを次のrequestへ渡し、
   応答を受け取れる。

`refresh`コマンドと、期限切れ時に更新してからrequestする経路も用意する。ただし最初の実測に
強制refreshは含めない。期限と`earliest_refresh_at`を確認してから更新の実測を別途決める。
複数accountのUI、sign out/revoke、並行processのrefresh、Henjiのproduction経路への統合は対象外。
このspikeは一つの保存先を一つのaccount・一つのprocessで使う。

## 根拠

- [登録・認証](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): dynamic
  client、発行済みID再利用、loopback callback、PKCE、ID token検証、direct scope。
- [ID token検証](https://developers.openai.com/siwc/website): discoveryとJWKSによる署名検証。
  2026-10-01の公開discoveryはissuer `https://auth.openai.com`、RS256、公開JWKS URIを返した。
- [accountとsession](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions):
  account/client対応、refresh token更新。正式実装では複数accountと並行更新の設計が別途必要。
- [model一覧・推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
  OAuth bearer、`models[].slug/display_name/visibility`、HTTP/SSEと完了判定。
- [preview条件](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):
  `store:false`、`stream:true`、履歴配列、function toolのnamespace宣言。
- [errorと復旧](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery):
  HTTPとstream内の契約枠errorを区別する。自動retryは今回行わない。
- Pi snapshot `b35af04f465d60c2f15d124ed074476b8986deb4`の
  [`openai-chatgpt.ts`](../../_refs/pi/packages/ai/src/auth/oauth/openai-chatgpt.ts)は手動callback
  URLを受け付ける。 Piの手動経路を参考にするが、現行公式契約との差分はそのまま移植しない。

公式の[VM案内](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)は
local認証後のcredential転送を説明する。今回の「VMで開始してcallbackを貼付する」経路は Pi
sourceを参考にした検証対象であり、公式VM案内で実成立が証明された経路とは扱わない。

## プログラムと保存先

- [検証プログラム](../../scripts/spike_chatgpt_sign_in.ts): dependencyのないDeno CLI。
  `login`、`status`、`models`、`infer`、`tool`、`refresh`を持つ。
- [focused確認](../../tests/spike_chatgpt_sign_in_test.ts): real
  RSA署名によるID検証、公式形式のmodel一覧、 namespace tool往復とreasoning
  replay、完了/error区別、credential非記録を確認する。
- 実測予定先: `.tools/a1-chatgpt-spike/`（既存`.gitignore`対象）。
  `host.json`、`registration.json`、`credential.json`は専用state。
  tokenを含む`credential.json`は0600でatomic置換する。本体のAPI key fileは読まない。
- `facts.jsonl`はrun ID、操作、request順、API、HTTP status、request ID、error
  code、解析失敗field/shape、 model一覧、semantic
  tool引数/結果、短い応答、usage、期待markerとの一致を保持する。
  token、Authorization、code、callback URL、raw response、SSE全文、encrypted reasoningは記録しない。
- 認証URLはterminal表示のみ。保存済みID tokenを含む`id_token_hint`は今回の表示URLへ入れず、
  再認証時はaccount selectorを使う。callback入力はterminalでechoしない。

## 操作手順

repository rootで実行する。実requestを伴うコマンドは承認後に使う。

```bash
deno run --no-config --allow-read --allow-write --allow-net scripts/spike_chatgpt_sign_in.ts login --dir .tools/a1-chatgpt-spike
```

表示URLを手元のbrowserで開いて承認する。browserのアドレスバーが
`http://127.0.0.1:1455/auth/callback?...`へ変わったら、URL全体をterminalの専用入力へ貼り付けてEnter。
手元PCにlistenerがなければbrowserの接続エラー表示は想定内。
URLはchat、shellのcommand、issue、文書へ貼らない。入力取消はCtrl-C。
1455が使用中なら`--port 0`で空きportを選べる。listenerはURL生成前にVMで開始する。
browserがVMのlistenerへ到達する場合も、spikeでは同じ手動貼付操作を案内する。

```bash
deno run --no-config --allow-read --allow-write scripts/spike_chatgpt_sign_in.ts status --dir .tools/a1-chatgpt-spike
deno run --no-config --allow-read --allow-write --allow-net scripts/spike_chatgpt_sign_in.ts models --dir .tools/a1-chatgpt-spike
```

account一覧にあるmodelのslugを選ぶ。推論第一候補は`gpt-6.1-sol`。
一覧に無ければ推論を開始せず、その時点で対象modelを決める。

```bash
deno run --no-config --allow-read --allow-write --allow-net scripts/spike_chatgpt_sign_in.ts infer --dir .tools/a1-chatgpt-spike --model gpt-6.1-sol
deno run --no-config --allow-read --allow-write --allow-net scripts/spike_chatgpt_sign_in.ts tool --dir .tools/a1-chatgpt-spike --model gpt-6.1-sol
```

`infer`は`HENJI_A1_OK`、`tool`はecho往復後の`HENJI_A1_TOOL_OK`を期待する。
異なる正常応答はその内容とmarker不一致を記録し、service response自体を不正として拒否しない。
後者は、返されたnamespaceをfactへ記録し、output itemをそのまま次のinputへ再送する。
本体SDKのadapterを使わないため、成功してもHenji本体や公式SDKとの統合確認済みとは扱わない。

## 初回の実request予定と停止点

| 対象                       | 回数 |
| -------------------------- | ---: |
| authorization code交換     |    1 |
| ID検証用公開discovery/JWKS |  各1 |
| account model一覧          |    1 |
| `gpt-6.1-sol`の短い応答    |    1 |
| 同modelのlocal echo往復    |    2 |

programからの外部HTTPは計7回、うち推論3回。browserのログイン・承認に必要なrequestはこの数に含まない。
token期限切れで追加refreshが必要になった場合はこの初回予定を超えるため、実行前に報告する。
自動retryなし。認証失敗、account利用不可、model非掲載、tool/stream差分があればその観測を残し、
追加のprovider variantやrequestを推測して進めない。

## local確認と実測結果

- `deno test --no-config tests/spike_chatgpt_sign_in_test.ts`: 3 passed。 署名済みID
  tokenの検証と改変署名の検出、初回/再認証のclient ID、account model一覧、 namespace
  tool往復、reasoning replay、HTTP/stream内の実code保持、未完了streamの区別を確認した。
- `deno check --no-config scripts/spike_chatgpt_sign_in.ts`、対象fileのformat/lint、`git diff --check`:
  pass。
- standalone CLIの`--help`と、tmux上の手動入力を確認した。 隔離先
  `/tmp/henji-a1-spike-offline-ebyk3h6b`、`--port 0`で起動し、dummy callbackを貼付した。
  入力は画面・factsに出ず、callback URI不一致として終了。外部request 0、credential file生成なし、
  host fileのmodeは0600。確認用tmuxは終了済み。

2026-10-01、専用tmux `henji-a1-spike`でloginを起動した。callbackはport 1455。
利用者がVM外browserで承認し、アドレスバーのcallback URLをVMの非表示入力へ貼付した。
既存tmux内からはattachでnested警告が出たため、`tmux switch-client -t henji-a1-spike`で切り替えた。
認証URLやcallback URLはこの文書へ保存しない。

- code交換、OIDC discovery、JWKSはすべてHTTP 200。ID tokenの署名・identity検証成功。
- tokenを`.tools/a1-chatgpt-spike/credential.json`へ保存し、別processの`status`で
  `registered:true`、`connected:true`、`planUsageEnabled:true`を確認した。
  host・registration・credential・facts各fileのmodeは0600。
- account model一覧はHTTP 200。表示対象5件をserver順のまま取得した。

| slug            | display name  |
| --------------- | ------------- |
| `gpt-6-astra`   | GPT-6-Astra   |
| `gpt-5.6-sol`   | GPT-5.6-Sol   |
| `gpt-5.6-terra` | GPT-5.6-Terra |
| `gpt-5.6-luna`  | GPT-5.6-Luna  |
| `gpt-5.5`       | GPT-5.5       |

予定の`gpt-6.1-sol`は`visibility:list`の表示対象一覧にないため、停止点どおり推論前に停止した。
全modelの掲載有無や直接指定時の利用可否は、この表示対象の観測だけでは確定しない。
利用者が`gpt-5.6-sol`を指定したため、回数を変えず残る推論3回を実施した。

| 実測request | 観測と結果                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 短い応答    | HTTP 200、本文delta 6回、`response.completed`受信。ただしspikeが完了イベントのoutputだけから本文を読むため`assistant_text_missing`で終了。本文の内容は未保存・未確認。                                     |
| echo前      | HTTP 200、`response.output_item.done`から`function_call`を取得、namespaceは`henji_spike`。引数とlocal結果は`HENJI_A1_TOOL_OK`。`response.completed.response.output`は空配列。                              |
| echo後      | HTTP 200、確定itemは`reasoning`と`message`。最終応答は`HENJI_A1_TOOL_OK`、期待marker一致、`response.completed`確認。完了イベントのoutputは空配列。usageはinput 136、output 38（reasoning 25）、total 174。 |

最初の推論で収集不備を観測し、spikeを`response.output_item.done`のitemを`output_index`順に集める方式へ
修正した。完了イベントは完了判定とusageに使う。公式の[stream例](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)も本文をstreamから読み、完了イベントで成功を判定する。
確定itemの形式は[Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)を参照した。
offlineのtool確認も確定itemイベントを含む形へ修正し、空のterminal outputで本文・tool
call・reasoningを 保持して次のrequestへ渡せることを確認した。focused test 3 passed、type
check・format・lint・diff check pass。 元の短い応答は再実行していない。tool往復は当初承認された残り2
requestで確認した。

program外部HTTPは計7回、推論3回、自動retry・refreshなし。credential値がfactsに含まれないことも
保存fileをreadbackして確認した。専用tmuxは認証process終了後のshellを保持している。
VMで開始した認証をVM外browserで承認し、手動callbackでVMへtokenを保存する経路は実成立した。
契約枠の公開Responses APIで、Henji側のlocal toolを往復させて最終応答を得る経路も実成立した。

## 事前レビューと再実測（2026-10-01）

再実測の前に、独立したread-only reviewerがrequest・SSE収集・測定fact・namespace tool往復と
credential非記録を確認した。再実測を妨げるcorrectness findingと必要なプログラム修正はなかった。
`response.completed`の元のresponseを保持し、収集itemを含む返却objectとは分けて、
元の`completed.output`のshape/countを記録していることを確認した。 reviewerの独立したoffline
probeでも、terminal outputが空／非空の場合に記録が0／1となり、
収集した確定itemと混同しないことを確認した。既存focused testは3 passed。

レビュー対象のプログラムはSHA-256
`3499cc230a326cb4f6856dc8b5a4285ea92c01babf8072b146e09ff7b7355f9d`。
レビュー後のコード変更、追加retryは行っていない。

実測は2026-10-01 11:05–11:06 JST、`.tools/a1-chatgpt-spike/`を使い、次の順に実行した。

| request  | HTTP | 観測と結果                                                                                                                        |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| refresh  | 200  | 前回のaccess tokenは期限切れ。refresh成功、新token集合を保存。                                                                    |
| 短い応答 | 200  | 完了outputは`array(length=0)`、count 0。確定itemは`message`。本文`HENJI_A1_OK`を取得し期待marker一致。                            |
| echo前   | 200  | 完了outputは`array(length=0)`、count 0。確定itemは`function_call`。namespace `henji_spike`、引数とlocal結果は`HENJI_A1_TOOL_OK`。 |
| echo後   | 200  | 完了outputは`array(length=0)`、count 0。確定itemは`message`。本文`HENJI_A1_TOOL_OK`を取得し期待marker一致。                       |

推論3回すべてで`response.output_item.done`と`response.completed`を受信した。 短い応答のusageはinput
23、output 10、total 33。 echo後はinput 136、output 11、total 147。今回はreasoning
item/tokenを観測していない。 Responsesのrequest IDは3回ともnullで、refreshではrequest IDを取得した。
run ID、request順、model step、HTTP、item type、元のterminal outputのshape/countは
`facts.jsonl`へ保存し、実行後にreadbackした。

再実測は外部HTTP 4回、うち推論3回。初回を含む累計は外部HTTP 11回、推論6回。
更新後のcredentialは0600で、保存token値がfactsへ含まれないことをreadbackで確認した。
別processの`status`でもregistered・connected・planUsageEnabledはtrueだった。
今回のmodel・account・API経路で、空の完了outputは再現した。一般のResponses API全体や
全modelに同じ挙動があるとは断定しない。

## 残る確認とHenji本体への入力

- 独立した短い応答、namespace echo往復、期限切れ後のrefreshは実測で成功した。
- 発行済みclient IDでの再loginはofflineのみ。今回の再実測を超える追加実requestは未承認。
- tool前の実応答はfunction callのみでreasoningを含まなかった。tool後にはreasoningがあったが、
  その後のrequestを送っていないため、reasoning再送のprovider側受理はofflineのみ。
- account model一覧は固定model名の推測で代替せず、認証accountで取得したslugを使う必要がある。
- 本体への入力は、API key登録とは別のOAuth操作、account/client/tokenの保存・更新、account
  model一覧、 namespace tool宣言、確定stream itemの履歴保存と再送、完了判定である。本体のAPI
  key入力画面へ OAuth
  bearerを手動登録する方式では、登録・更新・model一覧までの利用経路を満たせない。
- 現行の[Responses adapter](../../v0/agent/provider/openai_responses_model.ts)は本文deltaをprogressに
  使うが、tool call抽出とreplay履歴は`completed.output`から作る。今回実測した空のterminal outputでは
  tool callと履歴を失うため、A1採用時はこの経路も変更対象になる。
  確定itemを`output_index`順で保持し、完了判定・usageと本文／tool／replayの収集を分ける方針は
  再実測でも成立した。現行API
  key経路で同じ挙動が出るかは今回検証しておらず、その経路のbug修正は行っていない。
- 利用者の後続指示により、対応案を[Increment 163](../increments/increment-163.md)へ採用した。
  本体統合・配置は未着手。このspikeの成功はHenji production経路の完了を意味しない。
