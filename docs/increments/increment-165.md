# Increment 165 — Responsesで表示用reasoning summaryを要求する

更新日: 2026-10-01

ステータス: **完了（2026-10-01、利用者がIncrement 168まで完了と明示）。**

## 利用者の要件と根拠

利用者の「結果を踏まえて修正、reasoning.summary:"auto"で」により、共通Responses adapterで
表示用summaryを要求するlocal修正を採用した。思考量の選択は維持する。対象Session
`fb5a6bb1-8199-4d53-b06c-969d3ae70046`のeffortはhighであり、APIへ送る値は
`reasoning: { effort: "high", summary: "auto" }`となる。

Henjiのeffort選択値autoはproviderの既定の思考量を使う意味であり、APIへeffortを送らない。
summaryのautoは表示用要約の形式をproviderに選ばせる意味であり、effortとは独立している。
既定の思考量を選択したrequestでも、effortを省いたまま`reasoning: { summary: "auto" }`を送る。

実API probeは同じChatGPT OAuth credential、gpt-5.6-sol/high、source診断課題、tool結果で
summary指定だけを変えた。指定なしでは要約0、指定ありでは169文字・143文字の要約が返り、 production
adapterのthinking callbackと保存stateへ届いた。両条件で暗号化reasoningの次turn再送は
元itemと一致した。結果はgit管理外の`.tools/henji-summary-comparison/report.json`に保存した。
公式契約は[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)を参照する。

## 利用経路と変更範囲

利用者が選択したprovider/model/effortからWorkerが共通Responses adapterを作成する。
adapterはsummaryを要求し、SSEのsummary deltaまたはdone itemをthinking callbackへ渡す。 core
loopはthinking eventを発行し、既存の表示経路とprovider stateの保存・再表示経路へ渡す。

- 共通adapterのrequestに`reasoning.summary: "auto"`を追加する。
- 明示effortは従来どおり送る。provider既定を選んだ場合はeffortを送らない。
- OpenAI API key、ChatGPT OAuth、OpenRouter、宣言されたResponses providerが同じ処理を使う。
- 既存probeはsummary指定なしの対照条件を明示的に作り、修正後のadapterと比較できるようにする。

assistant noteの生成指示、TUI描画、summaryの途中deltaの段落区切りは本変更の対象外。
probeで観測した途中callbackの段落区切りと保存版との差は、probe結果に保持する。
構想・architecture・roadmapは変更しない。常用配置・commit/push・公開は本採用に含めない。

## 検証

- 既存のAPI key request testでsummary追加とmedium維持を確認する。
- 既存のChatGPT request testでhigh維持、summary callback、空のterminal outputからの保存を確認する。
- 共通adapterの既存testでprovider既定のeffort省略とhigh送信を確認する。
- 既存のthinking probe testで、指定なし／ありの対照条件とreasoning再送を確認する。
- 既存のResponses note・thinking履歴testで、受信後のcore・保存・履歴表示経路を確認する。
- focused type check、format、lint、git diff --checkを行う。

追加の実API確認は会話で許可されたcredentialとproviderを用い、対象・回数・保存先を実行前に提示する。

## 結果

共通Responses adapterへsummary要求を追加した。既存のeffort、認証、tool形式、暗号化reasoningの
保存・再送を維持した。probeも、修正後の標準requestからsummaryだけを省く対照条件を明示する形に更新した。

focused testは14件pass。API key・ChatGPTのrequest、provider既定と明示highの扱い、summary callbackと
provider state保存、coreのthinking event、Session保存・再開、note順序とthinking履歴表示を確認した。
type check、format、lint、git diff --checkもpass。full gateは実行していない。

修正後adapterの実API確認は、ChatGPT OAuth/gpt-5.6-sol/highで3 request実行した。payload書き換えなしで
3回とも`reasoning: { summary: "auto", effort: "high" }`を送信し、すべてHTTP
200／response.completed。 可読summaryがthinking callbackと保存stateに届き、次user
turnへの暗号化reasoning再送も元itemと一致した。
結果はgit管理外の`.tools/summary-fix-verification/report.json`に保存し、credential値が含まれないことを確認した。

本修正後のproduction TUI実画面は未確認。常用binaryと既存Coreは更新していない。

後続のcommit/build指示により、本修正を含むsource commitとbinary作成を完了した。
成果物と確認結果は[local build記録](../operations/local-build-2026-10-01.md)。常用配置、push、公開は行っていない。

さらに「了解配置して」により常用配置と配置先の起動確認を完了した。詳細は上記記録を参照する。
push、公開は行っていない。

## 完了承認（2026-10-01）

利用者の「同期して168まで完了してるし」により、Increment 168までの完了承認を記録した。
構想・architecture・roadmapの現行説明への同期も指示され、正本へ反映した。既存の検証・配置結果は上記を正本とし、
今回追加の実provider確認や公開は行わない。
