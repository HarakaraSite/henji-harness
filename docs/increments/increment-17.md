# 通常利用 increment 17 — ChatGPT subscription root provider feasibility

ステータス: **feasibility gate完了、runtime実装は将来incrementへ延期**

対応architecture:
[`docs/architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)

## このincrementの結論

Increment 17では、ChatGPT subscriptionで利用するOpenAI Codex経路を、Henjiの三つ目のroot provider
`openai-codex`として追加できるかを調査した。ここでいう`codex`はprovider・認証経路のidentityであり、Codex CLIを
agentとして起動したり、Henjiからtaskを委譲したりする意味ではない。

調査の結果、PiとOpenCodeにHenjiの目的と一致するdirect backend実装があり、OpenAIもOSS支援programで両toolを
明示していることを確認した。一方、低水準のsubscription model API、endpoint、header、OAuth client contractは
公式public contractとして公開されておらず、現段階のHenjiにこの経路は必須ではない。

2026-09-09、利用者はHenjiの既存機能の完成度を先に高め、OpenAI subscription対応を将来の実装へ延期すると決めた。
したがって、このincrementは調査結果と将来候補を保存して完了とし、provider registry、認証、transport、Surface、
Sessionのruntime変更は行わない。将来、利用者が必要性を判断して新しいincrementへ採用した時点で、OpenAIの最新方針、
公式contract、Pi・OpenCode等の現行実装を再確認する。

## Increment 14〜16から利用する基盤

- Increment 14で、provider route、auth profile、adapter、provider state、Session、evidenceをgeneric contractへ移し、
  公開OpenAI Responses APIの`openai`経路を追加した。
- Increment 15で、同じSessionの`/provider`からOpenRouterとOpenAI directを切り替えるSurfaceを追加した。
- Increment 16で、built-in instructionをproviderに依存しないcomponentへ分けた。

将来この機能を再採用する場合は、この基盤へ`openai-codex` branchを追加する。別のagent orchestration機能へ
置き換えない。

## Feasibility gateの確認結果

確認日: 2026-09-09

### 1. ChatGPT subscription認証

- [OpenAI公式のCodex authentication](https://learn.chatgpt.com/docs/auth)は、ChatGPT subscription sign-inと
  API key sign-inを別方式として定義する。ChatGPT sign-inのcredentialはCodex clientがcacheし、利用中にtokenを
  refreshする。
- [OpenAI公式のCodex app-server](https://learn.chatgpt.com/docs/app-server)は`account/read`、browser login、
  device-code login、login完了・account更新notificationを公開JSON-RPC contractとして持つ。app-server自身が
  実行主体である場合は、OAuth flow、token永続化、refreshもapp-serverが所有する。
- VMの`codex-cli 0.153.4`は`codex login status`で`Logged in using ChatGPT`を返した。app-serverへ
  `account/read`を送り、credential値やemailを出力せず、`authType: chatgpt`、認証済みaccount、plan type、
  `requiresOpenaiAuth`を取得できた。

結論: Codex client自身が実行する場合のmanaged ChatGPT authは成立する。ただし、app-serverの公開contractに
Henjiのdirect adapterへaccess tokenとaccount identityだけを貸す低水準APIは確認できなかった。したがって、
「app-server managed authが成立する」ことを、そのままdirect root providerのauth resolver成立とは扱わない。

### 2. 公式の実行境界

- 公式app-server contractは、Codex agentのconversationを`thread`、一つの依頼とagent workを`turn`、
  message・command・file change・tool call等を`item`として扱う。app-serverがconversation history、approval、
  tool loop、streamed agent eventを所有する。
- [OpenAI公式のCodex SDK](https://learn.chatgpt.com/docs/codex-sdk)もlocal Codex agentのthread開始・継続・再開を
  提供する高水準interfaceである。TypeScript SDKはNode.js 18以上を必要とする。
- 導入済みbinaryから生成したversion固有schemaでも、公開入口は`thread/start`と`turn/start`である。
  Henjiの一回の`Model.generate()`へ対応する、認証だけを借りた低水準model request APIは確認できなかった。
- `dynamicTools`は現versionではexperimental contractであり、Codex agent loopがclient toolを呼ぶ仕組みである。
  Henji-owned model/tool loopそのものをsubscriptionへ接続する低水準境界ではない。

結論: SDKまたはapp-serverを使うと「Henjiがmodel providerを切り替える」のではなく「Codex agentへtaskを委譲する」
別のproduct動作になる。これはIncrement 17の代替routeとして採用しない。

### 3. Direct backendの比較証拠

- pinned Zotの比較実装は、`openai-codex`を通常のmodel providerとして扱い、ChatGPT側のCodex Responses endpointへ
  OAuth access tokenとChatGPT account identityを付けて直接requestする。
- requestはResponses形式、responseはSSEで、text、reasoning item、function call、tool result continuationを
  Zot自身のmodel/tool loopへ写像している。Codex CLI processやapp-serverへagent taskを委譲していない。
- この方式なら、Henjiでも既存`Model.generate()`、tool loop、Session transcript、raw SSE evidenceを維持できる。
- pinned PiもCodex CLIやapp-serverを起動せず、Pi自身がOAuth、token refresh、Codex backendへのResponses request、
  SSE変換を所有する。requestでは`originator: pi`とPi自身のUser-Agentを送り、Codex CLIを偽装しない。
- 2026-09-09に確認したOpenCode v1.18.30のbuilt-in `CodexAuthPlugin`も、browser PKCEとheadless device-code OAuth、
  token保存・refresh、ChatGPT account identityの解決、Codex backendへのrequest書換えをOpenCode自身で行う。
  requestでは`originator: opencode`とOpenCode自身のUser-Agentを送り、agent/tool loopはOpenCode本体が所有する。
- [OpenAI公式のCodex for Open Source](https://developers.openai.com/community/codex-for-oss)は、開発者が好みのtoolで
  開発する例としてOpenCodeとPiを明示する。この記載は第三者OSS toolでの利用をOpenAIが認識・支援している証拠だが、
  programへの応募をclient登録にしたり、非公開backendをpublic API contractにしたりするものではない。
- したがって、第三者agentによる利用が一律に禁止されているとは扱わない。一方、endpoint、必須header、client
  identity、OAuth client contractはOpenAIの公式public APIとして確認できず、Pi・OpenCode・Zotの実装は外部contractの
  安定性を保証しない。

結論: 当初のproduct動作を実現できる候補は、この非公開direct backend方式である。技術的な候補は存在するが、
現段階では実装せず、将来再採用時に公開APIと同じ安定性を前提にせず最新の実行証拠でcontractを確定する。

### 4. Evidence差分

- app-server routeではthread/turn/itemとruntime outcomeは取得できるが、公開stable contractとしてupstream raw SSE
  bytesを取得する方法は確認できなかった。
- direct backend routeではHenji自身がHTTP/SSE transportを所有するため、credentialとAuthorizationを除くserialized
  request、raw response bytes、SSE event、parser transition、runtime outcomeを既存providerと同じ粒度で保存できる。
- 実装時にはpublic OpenAI Responses routeと`openai-codex` routeのendpoint・header・auth resolverを分け、
  evidenceにも別API identityを記録する。

## Gate判定

| Gate | 判定 | 将来実装への意味 |
| --- | --- | --- |
| Codex client内のmanaged ChatGPT auth | 成立 | SDK/app-server自身のagent実行には使える |
| managed authだけをHenji direct adapterへ貸す公式API | 不成立 | root provider用のcredential取得方法は別途決定が必要 |
| 公式の低水準subscription model API | 確認できず | 公開contractだけでは当初のroot providerを実装できない |
| 非公開direct backend | 実装候補あり | Pi・OpenCode・Zotに独立agentとしてのdirect実装があるが、再採用時に再確認する |
| Henji-owned tool loop・Session・raw SSE | direct routeなら成立見込み | live preflightとproduction経路で確定する |

live model turnと非公開backendへのrequestは実行していない。feasibility成立見込みと、現段階で実装する必要性は
別に判断し、利用者判断により後者を将来へ延期した。

## 将来の採用候補route

将来のincrementで利用者が非公開direct backendを再採用した場合だけ、次のrouteをprovider registryへ追加する。
`api`と`authProfile`の最終名は、credential取得方法を確定してからarchitectureとruntimeで同時に固定する。

```text
provider: openai-codex
api: chatgpt-codex-responses（暫定名）
authProfile: openai-codex-oauth（暫定名）
```

このrouteはCodex CLIを起動しない。Henjiのprovider adapterがChatGPT subscription用credentialをrequest時に解決し、
ChatGPT側のCodex Responses endpointへ直接requestする。public `openai` adapterへOAuth tokenを渡さず、
`openai-codex` adapterへPlatform API keyを渡さない。

## 将来再採用時に決める認証境界

direct adapterにはaccess token、refresh、ChatGPT account identityが必要である。一方、公式app-serverはそれらを
direct adapterへ公開しない。将来の実装前preflightではcredential値を表示せず、次の二案の実在性と影響を確認し、
採用案を利用者へ戻す。

1. Henjiが専用のOAuth login・保存・refreshを所有する。Codex CLIのcredential cacheへ依存しないが、第三者向けに
   公開されていないOAuth client contractへ依存する。
2. 既に認証済みのCodex local credential storeをHenjiのauth resolverが利用する。loginを重複させないが、privateな
   store schemaとrefresh contractへ依存し、Henji processがcredential materialを扱う。

どちらも公式公開contractだけでは確定できない。Codex CLI/app-serverをagentとして実行する案へ黙って切り替えず、
確認結果と推奨案をHuman Gateへ戻す。

## 将来再採用時の暫定実装計画

この計画は現時点の実装認可ではない。再採用時には外部仕様と参照実装を再確認し、その時点の個別increment計画として
利用者の承認を得る。

1. **External contract refresh**: OpenAIの最新方針、公式contract、Pi・OpenCode・Zotの現行実装を再確認し、direct
   backend方式が引き続き利用可能かを確定する。
2. **Auth preflight**: 導入済みCodex versionとpinned比較実装から、credential値を読まずにlogin、store schema、refresh、
   account identityの必要contractを確認する。上記二案のうち実行可能な方式、依存する非公開contract、変更範囲、
   live認証確認方法をまとめ、runtime変更前のHuman Gateへ戻す。
3. **Route contract**: 承認されたauth方式に合わせ、`openai-codex`用の`ProviderRoute`、auth profile identity、
   provider state、model catalogを確定する。Sessionとmanifestには非秘密のidentityだけを保存する。
4. **Direct adapter**: public OpenAI adapterと別のtransport・auth resolverとして、Responses形式request、SSE parser、
   text、reasoning replay、function call、tool result continuation、usage、provider failureを既存`ModelResult`へ写像する。
5. **Evidence**: counted fetchの内側で、credentialを除くrequest body、raw response bytes、SSE event、parser transition、
   provider metadata、runtime outcome、actual request countを保存する。
6. **SurfaceとSession**: `/provider`へ`openai-codex`を追加し、idle時の選択、次turnからの反映、footer、`/sessions`、
   same-Session switch、resumeを既存二providerと同じproduct contractへ接続する。
7. **Focused verification**: fake transportでrequest/SSE/tool continuation/route分離を確認し、該当type check、format、lint、
   `git diff --check`を行う。test helperの都合でproduction responseを狭めない。
8. **Live acceptance**: 認証済みproduction経路で最小turn、tool call/result continuation、provider切替を確認する。
   credential値とAuthorizationは出力・evidence・repositoryへ保存しない。requestとraw SSEは保存してreadbackする。
9. **Documentationとreview**: source guide、roadmap、architecture、個別increment文書、handoffを実装結果へ合わせ、差分review後、
   安定候補でauthoritative `v0:gate`を一回行う。

## このincrementで実装しないこと

- `openai-codex` route、ChatGPT OAuth、Codex backend transport、provider picker項目の追加
- credential読取、OAuth login、非公開backendへのrequest、live model turn
- Codex CLI、SDK、app-serverをnamed delegated agentとして起動すること
- Codex-owned thread/turnをHenji Session transcriptの正本にすること
- public OpenAI API keyとChatGPT subscription OAuth credentialを相互利用すること
- OpenAI built-in Web search、provider自動fallback、複数ChatGPT account picker
- 未確認variant、一般的hardening、permission matrixを機能成立前に追加すること

## 利用者判断

2026-09-09、利用者はOpenAI subscription対応を現段階の必須機能とせず、Henjiの完成度を先に高めてから将来の
incrementとして採否を判断すると決めた。Increment 17についてruntime実装の承認待ちはなく、feasibility調査の記録を
保存して完了とする。将来の実装は自動的に開始せず、新しい個別increment計画と利用者承認を必要とする。
