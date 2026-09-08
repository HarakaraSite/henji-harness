# 通常利用 increment 13 — provider deadlineと固定Session footer

ステータス: 完了（実装・offline検証・review・通常利用確認済み）

## 通常利用で確認した問題

同一Session内でroot modelを`qwen/qwen3.8-max-0902`へ切り替え、
「READMEを読み10行で説明して」と依頼したところ、二回のtool-call response後の第三requestで
`failure> provider response invalid`となった。

保存済みSessionとprovider evidenceから、次を確認した。

- `/model`による切替は成功しており、Sessionのactive selectionと三回のrequestはいずれも
  `qwen/qwen3.8-max-0902` / `xhigh`だった。OpenRouterが返したprovider名はAlibabaだった。
- 第一・第二requestは`finish_reason: tool_calls`と`[DONE]`まで正常に完了した。
- 第三requestは351件のreasoning eventを受信したが、assistant本文、terminal finish reason、`[DONE]`へ
  到達する前に、現行OpenRouter adapterのrequest単位30秒deadlineでabortされた。
- timeout後のstream cleanup経路でtimeout分類が`response_error` / `response_stream_failed`へ置き換わり、
  TUIの汎用表示`provider response invalid`となった。観測済みeventにresponse shapeのparse failureはない。
- failure turnはSessionへcommitされなかったが、選択済みmodel/effortはSessionに保持された。

相関する診断IDは`91d583f1-6aab-4f2d-afcc-b51d8ad94d6d`、provider evidence IDは
`a3d3f0dd-e18b-4b24-8b59-73cd1ce110ad`である。credential値とAuthorizationはこの文書へ記録しない。

## 採用したproduct動作

### Provider deadline

- reasoning modelの正常な長時間応答を固定30秒で中断しないよう、provider request deadlineを設定可能にする。
- 設定したdeadlineは、request開始からstreamのterminal resultまでを対象にする。
- deadline到達はtimeoutとして保持し、stream cleanupの成否によって`response invalid`へ置き換えない。
- TUIは、timeoutとprovider responseの構文・shape不正を区別できる短いfailure表示を出す。
- 自動retryまたはmodel fallbackは、この要求からは追加しない。

設定はproduction TUI起動option `--provider-timeout-ms N`で受け取る。`N`は正のsafe integerとする。
未指定時は120,000 msを使う。同じTUI invocationが起動するWorker generation内で、root、delegated planner、
context compactionが行う各OpenRouter model requestへ同じrequest単位deadlineを適用する。Sessionへは保存せず、
同じinvocation内でSessionを切り替えた場合も現在の設定を引き継ぐ。新しい設定ファイルや環境変数は追加しない。

### 固定footer 2段目

production TUIの二行footerを次の責務へ分ける。

- 1段目: ready / busy / failure、history位置、pending input、操作結果など、状況に応じて変化する情報。
- 2段目: cwd、現在のSession ID、root model、effortなど、作業対象と選択状態を常時確認する情報。

Session切替、model切替、effort切替の直後に2段目を現在値へ更新する。failure messageや一時的なstatusで
Session ID、model、effortを押し出さない。通常サポート下限の80 columnsでは、Session IDの先頭8桁、完全な
model ID、effortを必ず残し、cwdを残り幅に合わせて先頭から省略する。80 columns未満のdegraded表示では、
cwd、model provider prefixの順に省略し、Session短縮IDとeffortを残す。

## `/model`選択時のeffort

Increment 12の現仕様では、`/model`でmodelを選ぶと、そのcatalog entryの`defaultEffort`も同時に選択する。
Qwen Maxのcurated defaultが`xhigh`であるため、今回の`xhigh`は利用者が`/effort`で明示選択した値ではなく、
model選択時に自動適用された値だった。model pickerにはdefault effortを表示するが、通常画面には選択直後の
一時statusとしてしか表示されない。

Increment 13では固定footer 2段目に実際のeffortを常時表示して、この自動適用の結果を見えるようにする。
利用者判断により、model選択時にcurated default effortを適用する現仕様は維持する。

## 対象外

- providerまたはmodelの自動切替
- automatic retry / fallback
- delegated planner modelの選択UI
- provider response parserの未観測variant対応
- Increment 12で保存したSession model attributionの形式変更

## 実装計画

1. `session_launcher.sh`と`parseTuiInvocation()`へ`--provider-timeout-ms N`を追加し、正のsafe integerだけを
   admissionする。`WorkerSessionOptions`、Host start command、Worker generation、production physical I/Oを
   通してresolved deadlineを`OpenRouterAgentModel.timeoutMs`へ渡す。
2. provider timeoutを`transport_error`や`response_error`と区別する`provider_timeout`として、provider error、
   failure diagnostic、presentation contractへ通す。fetch中、body読取り中、SSE cleanup中、lock release時の
   どこでdeadlineが観測されてもtimeout分類を保ち、利用者cancelが同時に確定した場合は既存どおりcancelを優先する。
3. `PresentationProjection`へ現在のroot model/effortを加える。startup、`/model`・`/effort`の成功、
   `/sessions`によるbinding replacementで更新し、TUI reducerが一つのcurrent projectionとして保持する。
4. footer layoutを、一時statusの1段目と固定identityの2段目へ分ける。2段目はcwd、Session短縮ID、model、effortを
   表示し、failureやpicker完了statusから独立させる。
5. READMEとactive architecture/roadmapの現行挙動を、実装結果に合わせて更新する。診断IDやraw evidenceを
   user-facing READMEへ複製しない。

## 機能に対応する確認

- TUI引数のdefault、明示値、flag順序、重複、不正値と、Host→Worker→OpenRouter adapterへの値の伝達を確認する。
- deadline前に完了するSSEは従来どおり成功し、deadline到達はfetch/stream cleanupの形にかかわらず
  `provider_timeout`診断と`provider deadline exceeded`表示になることを、実providerを使わない実transport経路で
  確認する。
- startup、model/effort切替、Session切替、failure status後もfooter 2段目が現在値を保持することを確認する。
- 80 columnsでSession短縮ID、完全なmodel ID、effortが残り、cwdだけが必要量省略されることを確認する。
- 変更箇所のfocused test、`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。安定候補で
  authoritative `v0:gate`が必要かは、実装後の変更範囲と既存gate方針に従ってcoordinating ownerが判断する。

## 実装結果

- production TUIへ`--provider-timeout-ms N`を追加し、未指定時のOpenRouter request deadlineを120,000 msへ
  変更した。値はHost start commandからWorker generationへ渡り、root、delegated planner、context compactionが
  作るOpenRouter modelへ共通適用される。Session切替後も同じinvocation値を使い、Session recordには保存しない。
- `provider_timeout`をprovider error、failure diagnostic、Presentationへ追加した。fetch、body読取り、SSE stream
  cleanup、reader lock releaseでdeadlineを観測した場合もtimeout分類を保持し、TUIは
  `provider deadline exceeded`と表示する。利用者cancelが確定している場合はcancelを優先する。
- startup projection、成功したmodel/effort選択、Session binding replacementから現在のroot model/effortを
  Presentation projectionへ反映する。footer 1段目を一時status、2段目をcwd、Session短縮ID、完全なroot model
  ID、effortの固定identity表示へ分けた。2段目は`[<cwd> session:<短縮ID> model:<model ID> <effort>]`とし、
  将来のprovider表示にも幅を使えるよう`cwd:`と`effort:`のlabelは付けない。80 columnsではcurated catalog
  全entryの完全なmodel IDとeffortを保持する。
- model選択時にcatalogのdefault effortを自動適用するIncrement 12の仕様は変更していない。自動retry、fallback、
  Session schema変更も追加していない。

## 検証とreview

- Increment 13 focused test 5件、conversation presentation 10件、Worker foundation 40件、provider stream
  compatibility 10件が成功した。
- authoritative `v0:gate`を一回実行し、type check、format、lintとoffline test 104件がすべて成功した。
  `git diff --check`も成功した。
- product経路、timeoutとcancelの分類順、Session切替時のinvocation設定保持、model/effort projection更新、80 columns
  layoutを差分reviewし、BlockerまたはP1 findingはなかった。
- 実装・review時の自動検証では、利用者の承認範囲に含まれない実provider request、installed launcher更新、
  commit、push、tag、publish、releaseを実施していない。実providerでの確認は、その後の通常利用で行った。

## 通常利用確認と完了

- 通常利用Session `84597d99-69f7-4f78-ac2f-091a4978ad9e`で複数modelへ切り替え、4 turn・15 provider
  requestsをtimeoutなくcommitできた。GLM-5.3 / maxのcommit成功まで約99秒だったため、既定値120秒を維持し、
  実際にtimeoutが起きた時点で追加確認する方針とした。
- footer 2段目のSession ID、model、effort常時表示を利用者が通常利用で確認した。続く省スペース化で`cwd:`と
  `effort:`のlabelを削除し、commit `b3609dc`へ記録した。
- 2026-09-08、利用者がincrement 13の終了を確定した。
