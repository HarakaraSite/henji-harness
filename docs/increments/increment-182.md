# Increment 182 — B10: ChatGPT子Agentへの認証登録ID継承

現在の状態: **完了（2026-10-07、利用者判断による一律整理）**。

以下の状態・未実施・承認待ちの記載は当時の記録であり、本incrementの現在の残作業として扱わない。
この完了判断は過去の作業を閉じるもので、当時未実施だった実装・検証・配置等を実施済みに変更するものではない。

更新日: 2026-10-04

ステータス:
完了（利用者受入済み。実装・ローカル検証・独立review・実provider受入・commit/push・常用配置）。

## 採用・目的

利用者の「次のインクリメントとして修正して」により、通常利用メモB10を採用する。
正常に動くChatGPT親Agentからmodelを省略して子Agentを起動し、子の作業とcollectを完了できるようにする。
model/effortを省略した子は、親executionが実際に使う認証登録IDを継承する。
明示の登録IDおよびnullを未指定と区別し、execution中のアカウント選択変更では親子の参照先を変えない。
利用者の追加指示「異なるproviderを明示した子は、そのprovider用の認証
＞このケースも確認して」に従い、 ChatGPT親→OpenRouter子とOpenRouter親→ChatGPT子も確認する。

## 現行の操作・状態経路と根拠

利用者のtask→Core→ExecutionCoordinator.runReservation→Data admission→Worker turn→
spawn_subagent→ChildRunRegistry.spawn→子Worker→status/collect→Dataの非canonical保存。
親のmodel選択はData descriptorが所有する。アカウント選択はconfig rootのChatGPTAuthServiceが読む。
親Workerはturn commandに登録IDがない場合、credential resolverで選択中アカウントを解決できる。
しかしCoordinator.childChatGPTRegistrationIdは未指定をnullに変え、ChildRunRegistry.activeParentsへ保存するため、
model省略childがregistrationId:nullとなりmissing_credentialで失敗する。

下記は181の実providerで観測済みの不具合である。外部API/parser契約の変更は必要ない。 既存の163
registry確認はopenParentへ有効なIDをfixtureで渡しており、Coordinatorでの解決漏れを確認できていなかった。

## 実装と確認

1. Coordinatorでexecution開始時のChatGPT登録IDを一度解決する。
   child-spawn固定ID、model選択の明示ID/null、hostの選択中IDの順で現在の参照契約を適用する。
   同じ結果をChildRunRegistry.openParentと親Worker turn commandへ渡す。 非ChatGPT route、明示model
   childのspawn時選択、認証更新処理、保存schemaは変更しない。
2. 実Core側Coordinator・Data経路で、登録ID未指定の親→model省略child→collectを確認する。
   execution中の選択変更と次executionの再解決を、実際の失敗原因に対応する確認へ含める。
   明示ID/nullの意味と既存の明示model child経路はfocused確認する。
3. 実Worker・ローカルHTTP
   providerによる親子実行で、credential解決・request・結果の保存まで確認する。
   異なるproviderを明示した子についても、両方向で指定先のcredentialを使ってread/collectできることを確認する。
   実credentialを複製して認証refreshを競合させない。実provider確認は対象・回数・保存先を提示し、
   本incrementとして許可された場合にのみ行う。
4. focused test、必要なtype check、scoped fmt/lint、diff checkを行う。 変更が局所的なためfull
   gateの反復を計画しない。

## 範囲・未確認事項・承認境界

B10の親子credential参照の修正に限る。認証失効の原因調査、login UI、S4、再帰child、
旧DB移行や実data削除は対象外。認証値・Authorizationは出力・記録しない。
構想・architecture・roadmap正本の意味変更は含まない。 181に対するcommit/push・常用配置・実provider
E2Eの承認を182の追加操作へ拡張しない。

## B10の原観測（通常利用メモから移動）

- 観測（2026-10-04、181最終E2E）: 親は選択中のChatGPT登録で正常に実行できるが、
  `spawn_subagent`でmodelを省略したgeneric子は`registrationId:null`を受け取り、
  `missing_credential`・0 provider request・0 tool callで失敗した。
- source経路:
  `worker_host_coordinator.ts`の`childChatGPTRegistrationId()`はmodel選択に明示IDがないとnullを返す。
  `worker_host_children.ts`はmodel省略時にその親scopeのIDを子のselectionへ設定する。
  親自身は明示IDがなければhostの選択中登録を使えるため、親子で実効credentialが異なる。
  この処理は181変更前にも同じである。
- 利用者影響: 正常な親からmodel指定なしで子を起動しても作業を開始できない。
  同じprovider/model/effortを明示したspawnでは、開始後cancel/status/collectまで実行できた。
- 修正候補（未採用）: 親execution開始時に、親の実効選択登録IDを一度解決して子scopeへ渡す。
  明示nullと未指定は区別する。認証値を履歴へ保存する必要はない。
- 再検討条件: model省略の親子実行の修正を個別incrementへ採用するとき。
- 証拠: [181最終E2E](../increments/e2e-181-plan.md)、親`75e94975-d288-41c2-ba20-e1e5f25f99fd`、
  子`911fea2e-ac7d-4f5d-8fc7-3b5bc1a0c932`。初回のfailed子をcancel成功とは扱っていない。

## 実装とfocused確認結果

production変更は`worker_host_coordinator.ts`に限定した。 execution
admission後に`executionChatGPTRegistrationId()`を一度awaitし、同じ結果を親Workerのturnと
ChildRunRegistryのparent
scopeへ渡す。選択がない場合はundefinedを保ち、既存の親の認証失敗経路を維持する。
明示nullは選択中登録へ代替しない。非ChatGPT executionはこのlookupを行わない。

`increment_182_chatgpt_inheritance_test.ts`では、実Coordinator・実Data Worker・実親子Agent
Workerを使い、 fixture bootstrapでmodel HTTPの宛先だけlocalhostへ向けた。productionのcredential
resolver・ChatGPT/Responses adapter、 tool実行・spawn/collect・履歴保存はそのまま通す。synthetic
account/API keyのみを使い、実configは変更しない。

- ID未指定の親がaccount-aで開始。最初の親request後に選択をaccount-bへ変更しても、同じexecutionの
  model省略childと親の継続requestはaccount-aを使用する。
- 同Sessionの次executionでは親子ともaccount-bを使用する。
- 明示account-aはhost選択account-bより優先し、model省略childへ同じIDが渡る。
- 明示nullは選択中accountへ代替せず、model request/tool callなしで失敗する。
- ChatGPT親→明示OpenRouter子は子のOpenRouter API keyを使用する。
- OpenRouter親→明示ChatGPT子はspawn時の選択中ChatGPT account-bを使用する。
- 成功した全childは実workspaceのmarkerをreadし、親がcollectで実結果を取得した。
  終了後のread-only新DBから五childのcompleted・tool call 1を確認した。

182確認と既存163の明示model/認証固定、131のgeneric/model/filter、170の親子preparing cancelをまとめた
focused確認は16 pass/0 fail（`.tools/increment-182/focused.log`）。182確認の成功フローは local model
request計25件で、実provider callは0件。production変更と新test/fixtureのtype check・scoped fmt/lint・
diff checkが通過した。途中のtest
helperはreadのtext出力・flattenされたspawn/collect結果・履歴内で一意なcall ID・ 既存API key file
modeへ合わせて修正した。production contractをfixtureへ合わせる変更はしていない。

独立reviewの初回で、新しいlookup awaitがData admission後・receipt解決前に例外となると、
executionがsettledでもsubmit/admitの応答が未解決となるcorrectness問題を採用した。
reviewerがmalformed selectionと実Workerで0 provider requestのhangを再現した。 Data
admission直後にreceiptを確定し、そのcompletionへlookup失敗の清算結果を返す順序へ修正した。
lookup前のreceipt確定後も、ID解決とcancel確認はWorkerへのturn dispatchより先に行う。
実Workerのmalformed selectionでadmit
receiptとcompletionが返り、追加requestが0であるregression確認を追加した。
既存のinterrupted後のgeneration replacementとmodel変更のcontractは変更していない。

指摘限定の一回のre-reviewでこの失敗経路の解消を独立に再確認し、親子同一binding・明示ID/null・
次executionの再解決・異なるproviderのcredential経路に残るfindingなしとの結論を得た。
Ownerも採用し、局所実装・ローカル検証を完了する。 最終sourceでfocused 16 pass/0 fail、type/scoped
fmt/lint/diffを通過。 full gateは局所修正の計画に含めず、実行していない。

公式compiled候補は`.tools/increment-182/henji`、build ID
`98ff720db033ad6ce03929fa8ed05d1fcf4dcac70d26b6b475dca7026d3dc77e`、 runtime digest
`7581b7585ba8cf4b3d1a5f9ca1273a4b439a9eb0f627588a166f8f2bb38e8fe9`。
候補のsourceは`95c1117c+dirty`で、本incrementのlocal変更を含む。
SHA/versionは`.tools/increment-182/candidate.json`、build logは同folderの`build.log`。
この時点で実providerのproduction受入は未実施であり、localhost確認をその代替の証拠として扱わなかった。後続の承認・実行結果は次節に記録する。

## 実provider受入操作（2026-10-04承認済み）

compiled候補で、選択中ChatGPT親のmodel省略generic child、ChatGPT親→明示OpenRouter child、
OpenRouter親→明示ChatGPT childを各一フロー、計三フロー確認する。
それぞれ実workspaceのmarker読込→collect→親の最終回答と保存履歴を照合する。
対象は登録済みChatGPT/OpenRouterで、physical model request合計24件をprobe予算の上限とする。
保存先は`.tools/increment-182/real-provider/`、raw request/responseやcredential値は保存しない。
利用者の「はい確認して」により、計三フロー・最大24request・上記保存先での確認を承認された。
認証refresh tokenの複製を使わず、共通の元account
storeとlockを使用し、その他の設定・stateは隔離する。
commit/push・常用配置は未実施であり、別途指示に従う。

## 実provider受入結果（2026-10-04）

公式compiled候補（上記build `98ff720d…`）を隔離HOME/XDG・workspaceでCore/APIとして実行した。
ChatGPTは`gpt-6.1-sol`／low、OpenRouterは登録済み`openai/gpt-5.6-luna`／lowを使用。
ChatGPTは元account storeへのsymlinkにより同じaccount・lockを使用し、rotating OAuth
credentialを複製しなかった。 OpenRouter API
keyはprobeだけの非公開fileにコピーし、設定・履歴・Sessionは隔離した。
元のagents/default-selection/instruction、稼働中常用Core、旧DB、常用binaryは変更していない。

| フロー               | 親／子のprovider     | 親request | 子request | 結果      |
| -------------------- | -------------------- | --------- | --------- | --------- |
| model省略child       | ChatGPT → ChatGPT    | 3         | 2         | completed |
| 明示OpenRouter child | ChatGPT → OpenRouter | 3         | 2         | completed |
| 明示ChatGPT child    | OpenRouter → ChatGPT | 3         | 2         | completed |

計三parent＋三child、六execution・15 physical model requestで完了した（承認上限24以内）。 HTTP
response startは15件とも200、provider request failureは0。
各親はspawn一回とcollect一回、各子は実workspaceの個別markerをreadし、
その内容を子の回答→collect結果→親のcanonical最終回答へ返した。親自身のreadは0。 終了後のread-only
DBとderived artifactを照合し、以下を確認した。

- 同providerフローのparent modelに登録IDはなく、実spawn引数のmodelも省略されている。
  子の実modelには選択中の登録IDが保存され、missing_credentialなしで完了した。
- 異なるproviderの両方向は実spawn引数に指定先provider/model/effortがあり、 child
  modelのprovider/authProfileと実requestが指定先へ対応している。 ChatGPT
  childには選択中登録ID、OpenRouter childにはOpenRouter authProfileが保存された。
- 全parentがcanonical、全childがnon_canonicalのcompleted。六executionがsettledで、
  個別marker・実tool引数／結果・親子correlationを保存履歴から照合できた。
- parent/childの保存した完全なbuild manifestは、そのCoreの実manifestと一致した。
- 三Coreのshutdownはaccepted、exit 0。probeのAPI key copyと共有authへのlinkを除去し、 元account
  storeは保持した。元accountのneedsReauthenticationはfalseのままである。

証拠は`.tools/increment-182/real-provider/`の`results.json`、`readback.json`、
execution別semantic/event/artifact、Session別human export、`verification.json`。
`verification.json`はpassed=true/errors=[]。helperの最初の照合はrootの省略parentExecutionIdを
必須keyとして読んで止まったため、optional keyへ合わせ、既存の停止DB記録だけ再照合した。
この修正によるprovider再実行はない。

Ownerは独立review・focused/type/fmt/lint・compiled buildと上記production経路の結果を採用し、
182の実装・検証を完了とする。commit/push・常用配置は指示待ちで、本確認では行っていない。

## 利用者の完了判断（2026-10-04）

追加のコード確認では、model省略childが親のprovider/model/effort/authProfileを継承し、
OpenRouterは同じconfigRootのAPI keyを解決することを確認した。
ChatGPTでは複数accountの選択を表すregistrationIdが必要であり、今回の修正はその実効値を親子へ渡す。
OpenRouter親→model省略OpenRouter childの追加実provider callは行っていない。

利用者の「了解　完了とする」により、182（B10）を利用者受入済みの完了とする。
commit/push・常用配置は未実施で、この完了判断に伴う追加実行は行わない。

## Commit/push・常用配置（追加承認）

2026-10-04の利用者の「commit/push・常用配置して」により、182の実装・関連結果記録のcommit/pushと
常用binaryの配置を承認された。配置結果の文書commit/pushも同じ範囲で行う。
受入済みsourceをcommitし、clean sourceから公式buildを作成してruntime digestの一致を確認する。
旧binaryを保存して`dist/henji`と`/home/agent/.local/bin/henji`へ配置し、
隔離HOME/XDGで起動・admission・実build保存を確認する。追加の実provider callは行わない。
稼働中のCoreは維持し、新規Core起動から配置版を使用する。

### 配置結果（2026-10-04）

実装commit `417e2af44e99406426d1d85e59dd0123fa52ae15`
（`fix: inherit effective ChatGPT account in child executions`）をorigin/mainへpushした。 このclean
sourceから公式buildを作成し、配置版のruntime digest
`7581b7585ba8cf4b3d1a5f9ca1273a4b439a9eb0f627588a166f8f2bb38e8fe9`が実provider受入済み候補と一致した。
配置版はhenji 0.8.0／Deno 2.9.7、build ID
`88e696177a224efffc718b101491f4575da913f47baefbf3bf20e3f1cc0cb949`、sourceDirty=false。

旧binaryを`.tools/increment-182/deployment/henji.{dist,local}.previous`へ保存し、staging fileから
`dist/henji`と`/home/agent/.local/bin/henji`を置換した。両配置先のversionとSHA-256
`833f6d77e45166a26ceb2fce687b6555dc5e4fd3bab58af1a9a598bbbf916300`が一致した。

配置版を隔離HOME/XDGで起動し、Core/API起動、tmux上のproduction TUI接続、設定ready、 task
admission、実build manifestの新DB保存とreadbackを確認した。 credentialのない隔離環境でmodel
request前に失敗させ、追加provider requestは0件。 完全な保存build
manifestはCoreの実manifestと一致し、source revisionは上記実装commitだった。 TUI detach、Core
shutdown accepted、exit 0を確認し、検証用Core/tmuxは停止済み。

証拠は`.tools/increment-182/deployment/`の`build.log`、`deployment.json`、`probe.log`、
`probe-results.json`（passed=true）、TUI captureに保存した。
実config・認証・旧DB・稼働中常用Coreは変更していない。次回Core起動から配置版を使用する。
受入済みruntimeと同一のためfull gate・実provider E2Eは繰り返していない。
配置結果の文書変更も同じ承認範囲でcommit/pushする。binaryのsource revisionは実装commitのままとする。
