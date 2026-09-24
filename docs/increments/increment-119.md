# Increment 119 — reasoningの継続リクエストへの再送

状態: 実装、provider-free検証、実provider確認を完了。Increment 120、121に先行する。

## 必要なproduct動作と根拠

- toolを使ってモデルが次のrequestへ進むとき、同じprovider・モデルが実際に返したreasoningを、Chat／Responsesそれぞれのwire形式と元の順序で引き継ぐ。表示できるかどうかとは独立したmodel向け状態である。
- OpenCode Go ChatのDeepSeek、GLM、MiMoで`reasoning_content`が観測されたが、現行Chat経路は`reasoning_details`しか保持・再送しない。OpenRouter Responsesではreasoning itemが返った実例があり、そのitemを次のrequestへ入れるprobeはHTTP 200で完了した。現行adapterの`stateProvider: null`は再送を止めている。
- [OpenRouter公式のreasoning説明](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning)はChatの`reasoning`、別名`reasoning_content`、順序を保つ`reasoning_details`を区別する。モデル名の許可リストではなく実際の応答形で扱う。
- DeepSeekのtool反復がこの変更で改善するかは未確認であり、再送成立の受入条件とは分ける。

## 現行経路と対象

- Chat: `openrouter_sse.ts`／`openrouter_response.ts`で応答を読み、`core/contracts.ts`のprovider stateを経て、`openrouter_request.ts`で後続requestへ投影する。core、Session、context、evidenceのvalidatorも同じstate形を検証する。
- Responses: `openai_responses_model.ts`で`response.output`のitemを保持し、同じprovider・モデルへのrequestに再送する。OpenRouter Responsesもclient側でこの経路を使い、server側の保存や`previous_response_id`に依存しない。
- Hostの`privateStateFromTurn`は現在provider変更時だけ境界を進める。同一provider内のモデル変更とA→B→Aの復帰でも古いprivate stateを戻さず、通常の会話本文から入力を組み立てる。turn内のtool継続では同じ選択を保つ。

## 実装計画

1. Chatで返された平文`reasoning`／`reasoning_content`と構造付き`reasoning_details`を取り込み、対応するwire形式で再送する。両方返る場合は構造付きitemの順序を保ち、同じ内容を二重に送らない。Chat stateに生成元モデルを含め、request組立てとwire size計測を同じ判定へ揃える。
2. OpenRouter Responsesのreasoning itemを、既存Responses adapterのprovider／モデル限定replayへ接続する。暗号化itemはそのまま扱い、表示用の本文へ変換しない。
3. Hostのprivate state境界をproviderまたはモデルの変更で更新する。永続Sessionと`/recall`を含む実経路で、旧stateが復活せずsemanticな本文は残ることを確認する。

## 受入確認

- 保存済み応答を使い、Chatの平文・構造付きreasoningとResponses reasoning itemが次requestに正しい順序・形で入ることを、実際のrequest builderで確認する。
- 同一provider・モデルのtool継続、別provider／別モデルへの切替、A→B→A復帰を確認する。foreign／古いprivate stateは再送されず、通常の会話内容は継続する。
- type check、変更箇所のfocused test、format、lint、`git diff --check`を行う。実provider確認は対象・回数・保存先を提示して別承認を得る。

## 第三者計画reviewと承認境界

- 全体reviewで`reasoning` aliasの見落としと、モデルtagだけではA→B→Aの旧state復活を防げない点を指摘された。本計画へ反映した。
- `docs/architecture/multi-provider-routing-and-auth.md`は従来、同一providerの互換モデル切替でChat stateを維持すると定めていた。利用者の別承認を得て、モデル切替でも遮断する規則へ変更した。構想・roadmapは変更していない。

### 承認済みのarchitecture変更

対象は`docs/architecture/multi-provider-routing-and-auth.md`の「provider stateとprovider切替」節である。

- Chatのprivate stateに生成元providerとモデルを記録する。返された平文reasoningまたは順序付き`reasoning_details`を、同じprovider・モデルの継続requestへ対応するwire形式で戻す。Responsesのreasoning/output itemも、同じprovider・モデルの継続requestへ戻す。OpenRouter Responsesのstateless endpointではHenjiがitemを再送する。
- Session内でprovider**またはモデル**を切り替えたら、その境界以前のprivate stateを後続requestから外す。元の選択へ戻っても旧stateを復活させない。人間の入力、assistantの通常本文、tool call／resultなどのsemantic transcriptは残す。
- この変更は現行の「OpenRouter内の互換model切替では`reasoning_details`を維持する」という規則を置き換える。元のモデルとの互換性を推測してprivate stateを流用しない。

## 実装と確認結果

- ChatのJSON／SSE応答で平文`reasoning`・`reasoning_content`と`reasoning_details`を取り込み、生成元provider／モデルを記録した。同じprovider／モデルへの継続requestでは元の平文field、または順序付きdetailsを再送する。両方ある場合はdetailsを選び、重複を避ける。request wire size計測にも同じ組立てを使用する。
- OpenRouter Responsesの返却`output` itemをclient側のprovider stateへ保存し、同じprovider／モデルの次requestへ元の順序で再送する。`store`／`previous_response_id`は使わない。
- Hostはproviderまたはモデル変更時にprivate stateの有効開始turnを進める。A→B→Aでも古いstateを復活させず、通常の会話本文は残す。既存SessionにモデルtagがないChat stateは読めるが、再送しない。
- provider-freeのproduction adapterを模したHTTP応答でChatの分割された`reasoning_content`＋tool call、JSONの`reasoning` alias、両形式併存時の重複防止、Responses reasoning item＋function call＋tool resultの再送を確認した。モデル切替境界とSQLite Sessionでの新Chat state読み戻しも確認した。
- focused test: provider stream compatibility 20件、Increment 101 17件、14 25件、15 8件、38 8件、104 7件、111 7件、16 4件が成功。`v0:check`、変更箇所の`deno fmt --check`／`deno lint`、`git diff --check`も成功。full gateは実施していない。
- 利用者承認の実provider確認は計4 request。OpenCode Go Chat `deepseek-v4.1-flash`（effort `high`）は2回ともHTTP 200で、最初のtool call応答から`reasoning_content`を取得し、次requestに再送、応答はfinal。OpenRouter Responses `deepseek/deepseek-v4.1-flash`（effort `high`）も2回ともHTTP 200で、最初のtool call応答から`reasoning` itemと`function_call` itemを取得し、次requestにreasoning itemを再送、応答はfinal。実際の送信bodyで再送の有無を確認した。
- probeは既存Henji DBを使わず、結果の短い要約だけを`/tmp/henji-increment119-live/summary.json`に保存した。credential・Authorization・生応答は保存していない。
- binary build／配置、push、releaseは未実施。DeepSeekの反復動作が改善するかは今回の短い2-request probeでは未確認で、このIncrementの再送成立と混同しない。
