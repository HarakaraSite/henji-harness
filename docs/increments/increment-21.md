# 通常利用 increment 21 — OpenRouter mixed text/tool-call互換性

ステータス: **完了**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- OpenRouterのassistant responseが非空textと有効なtool callsを同じmessageで返した場合、Henjiは正常な
  tool requestとして受理し、toolを実行してagent turnを継続する。
- tool callに先行したassistant textを捨てず、TUI、transcript、Session履歴へ保持する。
- 次のprovider requestでは、受信したassistant textとtool callsを同じassistant messageの情報として再送する。
- textだけ、またはtool callsだけの既存responseは従来どおり動作する。

## 根拠と観測証拠

- 2026-09-10、`/home/masat.guest/src/forgejo-agent`でSession
  `75c2d70f-f014-42e1-8f1e-6190a72f18fa`のTurn 1をOpenRouter
  `deepseek/deepseek-v4-pro-0813` / `high`で実行した。
- 3回のprovider requestはすべてHTTP 200だった。最初の2回でread-onlyな`bash`と`read`を計4回実行した。
- 3回目は127文字のassistant textに続けて`web_search` tool callをstreamした。Henjiはtool call fragmentを
  受信した時点で`mixed_text_and_tool_calls`と判定し、turnを`contract_failure`、uncommittedとして終了した。
  `web_search`は実行されなかった。
- 保存済みprovider evidenceにはraw response、SSE events、request identity、runtime outcomeがあり、
  credential値とAuthorizationは含まれない。
- [OpenRouterのClient Tools文書](https://openrouter.ai/docs/guides/features/tool-calling)は、受信したassistant
  responseをconversationへ追加してtool resultを続けるagent loopを示している。repositoryにvendorされた
  OpenAI SDK 7.2.0のChat Completions型でも、assistantの`content`と`tool_calls`は独立した任意fieldである。
- current parserはstreamingでtextとtool callsの同居を明示的に拒否し、non-streaming decoderもどちらか一方
  だけを受理する。provider-neutralな`ModelResult`と`AssistantMessage`も現在は二者択一である。

## Product動作

### mixed assistant responseの受理

- streaming responseは、非空content fragmentとtool-call fragmentを同じcompletionへ蓄積できる。
- terminal `finish_reason`が`tool_calls`で、有効なtool callが1件以上あればtool-call resultとする。蓄積した
  textがあれば、そのtool-call resultへ付随するassistant textとして保持する。
- non-streaming responseも、非空`message.content`と有効な`message.tool_calls`の同居を同じ意味で受理する。
- tool callのname、ID、arguments、terminal、usage等に対する既存validationは維持する。mixedであることだけを
  理由に拒否しない。

### 表示、保存、再送

- tool callsに付随するtextは、stream中の一時表示だけで終わらせず、completed assistant textとしてTUIへ残す。
  tool call/resultの表示順はassistant textの後とする。
- provider-neutralなtool-call resultとassistant tool messageへ任意textを追加する。純粋なtool-call messageでは
  fieldを省略し、既存shapeを維持する。
- Session codec、履歴表示、history export、restored presentationは任意textを保持する。既存Sessionにはfieldが
  ないため、従来どおり読み込めるadditiveな変更とし、migrationは追加しない。
- OpenRouterへの次requestでは`content`と`tool_calls`を同じassistant wire messageへ戻す。Session途中で
  OpenAIへ切り替えた場合も、assistant textとfunction-call itemsの両方を入力へ投影する。

## 実装計画

1. `ModelResult`のtool-call variantとprovider-neutralなassistant tool messageへ、任意の先行textを表すdata-only
   fieldを追加する。validator、snapshot、provider evidenceの完全性を同じshapeへ合わせる。
2. OpenRouterのstreaming assemblyとnon-streaming decoderで、textと有効なtool callsを同じresultへ保持する。
   malformed responseに対する既存の具体的な拒否は残す。
3. agent loopでcompleted assistant textをtool activityより先に通知し、text付きtool messageをtranscriptへ保存して
   tool loopを継続する。
4. OpenRouter request encoderとOpenAI Responses input projectionで、text付きtool messageを欠落なく再送する。
5. Session codec、causal transcript、履歴、history export、Presentation adapter、retained TUIをadditive fieldへ
   対応させる。
6. focused product test、type check、format、lint、`git diff --check`と差分reviewを行い、stable candidateで
   authoritative `v0:gate`を一回実行する。
7. 利用者がproduction retained TUIで同じ調査taskを再実行し、`web_search`から最終回答まで継続することを
   Human Gateとして確認する。

## Product確認

| 動作 | 確認方法 |
| --- | --- |
| 観測済みSSE variantを受理する | `content` fragmentsの後に`web_search` call、`tool_calls` terminalが来るfixtureで確認 |
| toolを実行してturnを継続する | tool call/resultの後に次model resultまで進むloop testで確認 |
| 先行textを失わない | retained TUI、transcript、Session復元、history exportで確認 |
| providerへ忠実に再送する | 次のOpenRouter requestに同じassistant `content`と`tool_calls`があることを確認 |
| non-streamingも同じ意味を持つ | JSON responseのtext付きtool callsをdecoder testで確認 |
| 既存経路を変えない | text-only、tool-only、malformed tool callの既存動作をfocused regression確認 |

## 対象外

- provider requestの自動retry、model fallback、provider routing変更
- mixed response以外の一般的なparser緩和
- tool-call arguments等、既存validationの弱化
- TUIの全failure文言またはdiagnostic表示の再設計
- OpenAI Responses provider自体のresponse decoding変更
- Session schema migration機構またはprotocol version negotiation
- 構想、architecture、roadmap正本の変更

## 実装結果

- provider-neutralなtool-call resultとassistant tool messageへ任意の`text`を追加し、既存のtextなしmessageは
  fieldを持たないまま維持した。
- OpenRouterのSSE assemblyとJSON decoderは、非空textと有効なtool callsの同居を正常なtool requestとして
  受理する。既存のtool call validation、terminal validation、assistant text上限は維持した。
- agent loopはtext付きassistant messageをtool activityより先に通知し、transcriptとprovider evidenceへ保持して
  tool実行後のmodel requestまで継続する。
- OpenRouterの継続requestはassistant `content`と`tool_calls`を同じwire messageへ戻す。OpenAIへ切り替えた
  場合はassistant textとfunction-call itemsの両方をResponses inputへ投影する。
- Session codec、復元表示、Session履歴、history export、Presentation adapter、retained TUIを任意textへ対応
  させた。Session schema versionは変更せず、migrationも追加していない。

## 検証結果

- 観測済みと同じSSE順序で、assistant textの保持、tool dispatch、次model resultへの継続、OpenRouter request
  への再送、provider evidenceへの保持をfocused testで確認した。
- JSON response、Session保存・復元・履歴、history export、retained TUI、OpenRouterからOpenAIへの切替投影を
  focused testで確認した。
- 2026-09-10、authoritative `v0:gate`を一回実行し、type check、format、lint、全137 testが成功した。
- production retained TUIで同じ調査taskを再実行し、`web_search`が2回正常に完了するところまで確認した。
  この実行ではmixed variant自体は再現せず、後続の別responseがraw SSE上限に達した。利用者は、mixed
  variantのfocused確認と全体gate、productionでのtool継続を根拠としてIncrement 21の完了を承認した。

## Human Gate

利用者は2026-09-10、通常利用で発見したmixed text/tool-call拒否を修正対象とし、Increment 20のproduction確認を
完了した後、本書の計画を承認した。local実装とgateの完了後、production再実行で`web_search`の継続を確認した。
同じ実行の後段で見つかったraw SSE上限はmixed response拒否とは別の問題としてIncrement 22へ分離し、利用者は
Increment 21を完了とした。

## 2026-09-12 post-completion TUI ordering fix

- 別workspaceでの通常利用により、tool result完了後のfinal assistant textがstreaming中だけtool行より上へ表示され、
  settle時にtool行の下へ移動する不自然な順序変更を観測した。
- TUIは一turnのassistant表示に同じentry IDを再利用する。tool callに先行したassistant entryがある状態で後続の
  `assistant_progress`を同じ位置へ上書きし、settled `assistant_message`だけがtool行の後ろへentryを移していたことが
  原因だった。
- active toolがすべて完了し、同じturnのtool entryがassistant entryより後ろにある場合、最初の
  `assistant_progress`でassistant entryをtool行の後ろへ移すようにした。以後のstreaming updateとsettled responseは
  同じ位置を維持する。
- 観測したevent列を再現するfocused testを追加し、conversation presentation 13件、対象type check、format、lint、
  `git diff --check`が成功した。provider requestは行っていない。
- code commit `91e091b6`からbuildしたbuild ID `f8fb18486d0d54e45e936329c1a58de509a07d794324d23e46d19c894bc9ddc8`、
  SHA-256 `5b32dce0c17f53ae321587de1aabcc0e3e7303cf87239e7d170948b74051bd11`のartifactへ`dist/henji`と
  `~/.local/bin/henji`をatomicに置換した。
