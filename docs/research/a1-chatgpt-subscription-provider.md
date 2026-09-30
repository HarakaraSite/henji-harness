# A1 — ChatGPT subscription provider調査（OpenCode／Pi）

調査日: 2026-09-29

ステータス: **調査と実装候補。個別incrementへの採用・実装認可ではない。**

利用者は次の候補としてA1を検討し、OpenCodeとPiの実装調査、その結果の記録を指示した。
本書は2026-09-29時点の旧A1の調査記録である。2026-10-01の利用者判断により、現在の候補は
[通常利用メモのA1](../experience/normal-use-inbox.md)「Sign in with ChatGPTによるChatGPT契約枠の利用」へ
置き換えた。本書のbackend接続案は現在の実装方針ではない。
以前の見送り判断と調査は[Increment 17](../increments/increment-17.md)を参照する。

## 結論と確認範囲

- OpenCodeとPiには、自身のagent／tool loopを維持し、ChatGPTのCodex用backendへ直接model requestを
  送る実装がある。Henjiのroot providerを追加する目的に合う技術候補である。
- 両者がOAuth login、token保存・更新、account identity、backend接続を所有する。 Codex
  CLI／SDK／app-serverへagent taskを委譲する方式ではない。
- 公開OpenAI Responses APIと会話・function
  toolの形式は共通するが、接続先・認証・header・stream処理には 差分がある。API keyをOAuth
  tokenへ替えるだけの変更ではない。
- HenjiにはResponses変換、tool loop、reasoning／output item再送、provider選択とSessionの基盤がある。
  Piの専用provider方式を参考に、これらへsubscription用adapterとOAuth経路を接続する案が適している。
  これはsourceからの実現見込みであり、Henjiでのproduction動作を確認した結論ではない。
- 確認したのはsourceと公式資料。ログイン、実credential読取、認証先・model
  backendへのrequestは行っていない。

## 調査対象

| 対象     | 確認したrevision                                              | 主なsource                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode | `7945de208964a49300d7f770d1a71d078db9a4c4`（upstream `dev`）  | `packages/opencode/src/plugin/openai/codex.ts`、`src/auth/index.ts`、`src/provider/provider.ts`・`transform.ts`、`src/plugin/index.ts`                                                      |
| Pi       | `cb7969d212836b8939001dce159fbd2ed6ad395f`（upstream `main`） | `packages/ai/src/auth/oauth/openai-codex.ts`、`src/auth/resolve.ts`、`src/api/openai-codex-responses.ts`、`src/providers/openai-codex.ts`、`packages/coding-agent/src/core/auth-storage.ts` |
| Henji    | `0a918c86819e1a39e3d342b1c206743911f637fa`                    | `v0/agent/provider/`、`v0/agent/worker/worker_physical_io.ts`、`v0/agent/http/server.ts`、`v0/agent/host/core_service.ts`、`v0/tui/slash_command.ts`                                        |

OpenCodeとPiはGitHub上の当日のbranch先端を確認し、上記commitのsourceを取得した。
repository内の既存`_refs`やIncrement 17の古いsnapshotと同一であるとは扱わない。
以降のupstream変更は未確認である。

## OpenCodeとPiの実装比較

| 項目              | OpenCode                                                             | Pi                                                                                            |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ログイン          | browser OAuth（PKCE、localhost callback）とheadless向けdevice code   | 同じ二方式。browser方式ではauthorization code／redirect URLの手動貼り付けも受け付ける         |
| provider identity | `openai`内でAPI keyとOAuthを切り替える                               | `openai-codex`を専用providerとして持つ                                                        |
| 保存する情報      | access／refresh token、有効期限、account ID                          | 同じ情報をOAuth credentialとして保存する                                                      |
| token更新         | request時に期限を確認し、同じloader内の更新を一つのPromiseへまとめる | 期限前にstoreをlockし、期限を再確認して更新・保存する。複数request／processでの更新をまとめる |
| 接続              | 既存OpenAI SDK経路のfetchでcredential・header・URLを書き換える       | 専用Responses adapterがrequest・stream変換を持つ                                              |
| transport         | HTTPに加えてexperimental WebSocket経路を持つ                         | SSE／WebSocketに対応し、`auto`で選択する                                                      |
| client表示        | `originator: opencode`とOpenCodeのUser-Agent                         | `originator: pi`とPiのUser-Agent                                                              |

両者の確認sourceは同じOAuth client IDを使う。Henji独自のclient登録方法や、`originator: henji`での
login成立は今回確認していない。

根拠:
[OpenCode CodexAuthPlugin](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/opencode/src/plugin/openai/codex.ts)、
[Pi OAuth](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/auth/oauth/openai-codex.ts)、
[Pi認証解決・更新](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/auth/resolve.ts)、
[Pi専用provider](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/providers/openai-codex.ts)。

## URL・認証コードを表示する方式と保存先

利用者が想定した「TUIにURLと認証コードを表示し、ブラウザで承認する」はdevice code方式に対応する。
確認sourceでは次の流れになる。

1. agent側がOpenAIのdevice認証開始先へrequestし、device ID・user codeを取得する。
2. TUIへ認証URLとuser codeを表示する。
3. 人間がブラウザでログイン・承認する。
4. agent側が認証完了をpollし、得たauthorization codeとverifierをtokenへ交換する。
5. agent側の認証storeへ保存し、以後のmodel requestでaccess tokenを使う。
6. 次回起動でも保存済みcredentialを読み、有効期限に応じて更新する。

ブラウザを手元PC、agentをVMで動かしている場合、credentialの保存先はagentが動いているVM側である。

| 実装     | 標準の保存先                        | 内容                                  |
| -------- | ----------------------------------- | ------------------------------------- |
| OpenCode | `~/.local/share/opencode/auth.json` | provider別のAPI key／OAuth credential |
| Pi       | `~/.pi/agent/auth.json`             | provider別のAPI key／OAuth credential |

これらは標準pathで、設定による変更がある。access tokenはmodel呼出用、refresh tokenはtoken更新用、
`expires`は有効期限、`accountId`はChatGPT account identityである。実値は調査記録へ含めない。

根拠: [OpenCodeの保存仕様](https://opencode.ai/docs/troubleshooting/#storage)、
[OpenCode auth store](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/opencode/src/auth/index.ts)、
[Piの設定仕様](https://pi.dev/docs/latest/configuration)、
[Pi auth store](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/coding-agent/src/core/auth-storage.ts)。

## API key方式との共通部分と差分

比較対象のAPI key方式は公開OpenAI Responses APIである。Chat Completions等の別APIを同一視しない。

| 項目                  | 公開Responses APIのAPI key方式              | 比較実装のChatGPT subscription方式                |
| --------------------- | ------------------------------------------- | ------------------------------------------------- |
| 接続先                | `https://api.openai.com/v1/responses`       | `https://chatgpt.com/backend-api/codex/responses` |
| 認証                  | OpenAI Platform API key                     | OAuth access tokenとChatGPT account ID            |
| 利用枠                | OpenAI API側の課金・制限                    | ChatGPT側の利用枠                                 |
| 会話・tool            | Responses形式のinput、function call／output | 同じ基本形式を使い、各実装のadapterで扱う         |
| request／streamの契約 | 公開Responses API                           | 専用header・request項目・stream eventの差分がある |

例えばPiは`store: false`、`stream: true`、`instructions`、`reasoning.encrypted_content`、
Sessionに対応するcache keyを送る。Bearer token、`chatgpt-account-id`、client表示等をheaderへ付ける。
streamでは`response.done`等を共通処理向けの`response.completed`へ正規化する。
これらは参照sourceの動作であり、全項目が全account／modelで必須であるという実測結果ではない。

根拠:
[Pi Codex Responses adapter](https://github.com/earendil-works/pi/blob/cb7969d212836b8939001dce159fbd2ed6ad395f/packages/ai/src/api/openai-codex-responses.ts)、
[OpenCode request変換](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/opencode/src/provider/transform.ts)、
[OpenAI公式認証案内](https://learn.chatgpt.com/docs/auth)。

## Henjiへの接続案（未採用）

現行の人間操作から実行までの経路は、TUIの`/login`→CoreのHTTP credential登録→固定credential
file保存、 provider選択→Workerの`createProductionPhysicalIo`→request時のcredential解決→model
adapter→Henji-owned tool loop→Hostの履歴・outcome保存である。現在の`/login`はAPI
keyの入力・保存用で、OAuth flowは持たない。

- **provider／adapter**: `openai-codex`をsubscription専用routeとする案。公開APIとのidentityを分け、
  既存Responsesの会話・tool変換とreasoning／output
  item再送を再利用しつつ、専用の接続・認証・stream差分を
  扱う。現行provider宣言は二protocolと固定header／catalogを扱うdata-only形式なので、JSON追加だけでは
  OAuth login・refresh・dynamic account header・stream差分まで成立しない。
- **認証**: Henji自身のOAuth
  login・保存・更新を追加する案。Core側がloginと保存を所有し、TUIはURL・code・
  完了状態を表示する。request時にWorker
  adapterがcredentialを使う現行境界へ接続する方法、更新のowner、 保存fileは未決定。tokenをmodel
  context、Session会話、通常evidenceへ入れない。
- **並行実行**: 親・子Agentや複数Coreが同じuser scopeの認証を使うため、refresh
  token更新をまとめる方法を 決める。Piのstore
  lock＋再確認が参考になるが、そのlibraryや五分前更新という値の採用は未決定。
- **Surfaceと通常利用**: OAuth開始・完了待ちを既存Core／TUI操作へつなぎ、`/provider`・`/model`、
  same-Session継続、tool往復、cancel、provider attributionを確認する。
- **最初のtransport案**: Henjiの既存HTTP/SSE経路へ接続する。WebSocketは両参照実装にあるが、
  Henjiでの採用は今回決めていない。
- **Evidence**:
  現行AGENTS.mdに従い、provider・model・API・step／物理request順・HTTP／error・解析失敗の
  短いfactとsemantic tool履歴を保存する。Increment 17の旧計画にある通常raw収集をそのまま採用しない。

上記は実装候補である。構想・architecture・roadmapは変更していない。採用する場合は新しい個別incrementで
要件と範囲を定め、必要な正本変更はrepositoryの承認規則に従う。

## 公式資料で確認した境界と未確認事項

- OpenAI公式案内はChatGPT subscription sign-inとAPI key sign-inを別経路として扱う。
  [Authentication](https://learn.chatgpt.com/docs/auth)
- 公式app-serverは認証・conversation・approval・agent eventの統合境界である。
  `chatgptAuthTokens`はhostがtokenをapp-serverへ供給するexperimental入口であり、Henjiのdirect model
  adapterへ認証だけを貸すAPIとは扱わない。
  [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- OpenAIのOSS支援programはOpenCode・Pi等のtoolを使う開発者を明示している。第三者toolの利用を認識・
  支援する証拠だが、direct backendを公開Responses APIと同じ契約へ変える記載ではない。
  [Codex for Open Source](https://developers.openai.com/community/codex-for-oss)
- 今回確認した公式資料には、第三者harness向けの低水準subscription model APIとOAuth client登録の
  公開contractを見つけていない。接続詳細は参照実装と実行証拠で確認する部分が残る。
- 未確認: Henji client名でのlogin、利用accountでのmodel／effort、request項目とstream終端の実際の形、
  Henjiのtool往復・reasoning再送・token更新のproduction成立。必要な実provider確認は、対象・回数・保存先を
  提示して利用者の明示承認を得てから行う。

利用者は認証情報の保存先とAPI key方式との差分を確認し、調査結果を残すと指示した。
認証方式・保存先・adapterの最終採用、実装、実provider確認は今回の記録指示には含めない。
