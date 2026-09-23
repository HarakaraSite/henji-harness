# Increment 116 — Chat provider応答と切替後のprivate state

## 状態

local実装と実provider検証を完了。2026-09-23の通常利用で観測した2件を対象とする。

## 必要なproduct動作と根拠

1. OpenCode Go Chatの`deepseek-v4.1-flash`が正常な回答を返したとき、そのturnを完了できる。保存済みの
   `high`／`auto`の2応答はHTTP 200で、本文を持つ`finish_reason: stop`とusageを含むframeの後に、同じ
   completionの`choices: []` usage frame、`[DONE]`が続いた。現行parserは後者を
   `data_after_terminal`として拒否した。空の`choices`を持つ最終usage frameはOpenAI Chatのstreaming説明にもある。
   終端frame自身と後続frameの両方にusageがある組合せは、この実応答を根拠とする。
2. 同じSessionでproviderを切り替えた後も、会話本文を保って次のproviderでturnを進められる。
   OpenRouter Chatが生成した`reasoning_details`を、後続のOpenCode Go Chat `glm-5.3`へ
   `messages[4].reasoning_details`として送ったところ、HTTP 400の`Extra inputs are not permitted`となった。
   `docs/architecture/multi-provider-routing-and-auth.md`はforeign provider stateを送らず、元providerへ
   戻ったときも根拠なく古いprivate stateを再利用しないと定める。
3. 実provider再確認で、OpenCode Go Chat `glm-5.3`は継続SSE deltaに`role: null`を送った。HTTP 200の
   正常な応答を現行parserが`unsupported_delta_shape`として拒否したため、継続deltaのnull roleを
   role省略と同様に扱う必要がある。この追加原因は、要件2の実経路確認中に判明した。

## 実装計画（第三者review指摘を反映）

1. SSE parserの終端frame内usageと後続のusage専用frameの記録を分離する。終端にusageがあっても、後続の
   content-freeな`choices: []` usage frameを処理し、`[DONE]`を待つ。回答本文やtool callを含む終端後frameの
   拒否とraw response／parser transitionの保存を維持する。実観測により、継続deltaの`role: null`も受理する。
2. Chatの`reasoningDetails` stateに、実際の生成元provider IDを付ける。Chat requestは一致するproviderの
   stateのみをwireへ再送し、foreign stateはsemanticな会話本文として投影する。response parser、request
   encoder、wire size計測と、core／Session／context／evidenceのstate validatorを同じ形へ揃える。
3. HostがSessionの`modelChanges`から最後の跨provider切替turnを導出し、Worker start／select_modelへ渡す。
   Workerはcanonical transcriptを変更せず、model request投影でそのturnより前のprivate stateを除外する。
   同一provider内のmodel切替と、現在turnのtool continuationは除外しない。
4. 保存済みの失敗SSEと同じframe構造（終端本文＋usage、後続の空choices＋usage、`[DONE]`）を
   オフラインで再生し、final ModelResultを確認する。OpenRouter→OpenCode Goと
   OpenRouter→OpenCode Go→OpenRouterのrequestで本文は保持し、foreign／古いprivate stateを送らないこと、
   同一providerのreasoning継続と送信body／wire size計測の一致をfocusedに確認する。
5. focused test、type check、format、lint、`git diff --check`の後、安定候補へauthoritative `v0:gate`を一回
   実行する。実provider callは別承認の対象とする。

構想、architecture、roadmap、SQLite schemaは変更しない。既存のSession・historyを削除・自動書換えしない。
当初計画にbinary配置、commit、push、releaseは含まなかった。その後、利用者がcommitとbinary配置、
`v0:gate`のパス修正を指示した。pushとreleaseは対象外。

## 第三者計画review

初案はprovider IDの一致だけでstateを再送するため、OpenRouter→他provider→OpenRouterの復帰時に古い
`reasoning_details`を再送する、と指摘された。Sessionの切替履歴から直近の跨provider境界を導出し、request
投影だけで除外する手順3を追加した。ほかに対象内の阻害要因は報告されなかった。

## 結果

- Chat SSE parserは終端frame内usageを後続usage専用frameの消費として数えず、観測された
  `stop`＋本文＋usage→`choices: []`＋usage→`[DONE]`でfinalを返す。終端後の本文は引き続き拒否する。
- Chatの`reasoningDetails`へ生成元provider IDを保存し、同じproviderのrequestだけに再送する。
  request bodyとwire size計測も同じ判定を使用する。Session、context、evidenceのvalidatorを揃えた。
- Hostは最後の跨provider切替turnをWorker start／model選択へ渡す。Workerはその境界より前の
  private stateをrequest投影から除外し、canonical transcriptの本文とstateは保つ。現在のprovider区間の
  stateは継続する。
- focused確認: Increment 101（15件）、15（7件）、12（3件）、provider stream compatibility（19件）は成功。
  `v0:check`、format、lint、`git diff --check`も成功。最初の`v0:gate`は既存のproduction CLI E2Eの
  設定検査で停止した。`deno.v0.json`の`agent:e2e:live`が旧workspaceの絶対パスを固定していたため、
  実行許可を`./dist/henji`へ変更し、E2E設定検査もrepository rootから解決するよう修正した。
  修正後のfocused E2Eは5件成功。`deno run`で現在の`dist/henji`を許可し、`/bin/echo`を拒否することを
  確認した。修正理由を明示して再実行した`v0:gate`はexit 0で通過した。
- 利用者の実provider許可のもと、隔離XDGとtmuxのproduction TUIで合計4 turn／4 requestを実行した。
  `/tmp/henji-increment116`／`/tmp/henji-increment116b`は未commit sourceからの検証用binaryであり、
  installed binaryには配置していない。新規Session `4948f0be`のOpenCode Go Chat
  `deepseek-v4.1-flash high`は「こんにちは」にHTTP 200・1 requestで正常応答した。この回のSSEは終端内usage
  のみで、後続usage専用frameは来なかった。元の失敗応答の保存済みraw prefix（終端内usage＋後続usage frame）
  に、parser abortで保存されなかった`[DONE]`を補って現sourceへ再生し、206 byteのfinal textを得た。
- 新規SessionのOpenRouter Chat `deepseek/deepseek-v4.1-flash high`もHTTP 200・1 requestで正常応答したが、
  この応答に`reasoning_details`はなかった。そのため、元Session `b400f2be`のDBを隔離XDGへコピーしてresume
  した。元の`glm-5.3`失敗requestにはOpenRouter由来のprivate stateがあり、HTTP 400だった。最初の再試行
  ではprivate stateがrequest投影から消え、HTTP 200となったが、SSEの`role: null`でparserが失敗した。
  これを局所修正し再buildした2回目の再試行は、HTTP 200・1 request・finalで完了した。保存済みSSEには
  `role: null`を含む継続eventが29件あり、terminal `stop`と`[DONE]`を記録した。
- 実providerの保存先は`/tmp/henji-116-state`、tmux画面と元応答の捕捉prefixは
  `/tmp/henji-116-artifacts`。検証用credential fileは`/tmp/henji-116-config`に0600でコピーし、
  診断・画面へ値とAuthorizationを記録していない。元DBは変更していない。
  4 requestの上限内では、OpenRouterへの復帰はliveで行わず、Worker投影のfocused regressionで確認した。
- 修正一式をcommitし、そのclean commitからbuildしたbinaryを`~/.local/bin/henji`へ配置した。pushとreleaseは
  実施していない。
