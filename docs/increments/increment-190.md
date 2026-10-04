# Increment 190 — openai-chatのモデル一覧からgpt-6.1-solを除外

状態: 実装・検証・常用配置・source commit済み（2026-10-04）。利用者による通常利用確認は未実施。

## 必要な動作と採用範囲

利用者の「openai-chatの選択候補から当該モデルを外し、Responses側で使う修正
一覧にフィルタかけて」により、
通常利用メモB11から一覧フィルタを採用した。`openai-chat`のmodel一覧では、取得元に含まれていても
`gpt-6.1-sol`を表示しない。`openai-responses`と`openai-chatgpt`では従来の候補を維持する。
お気に入り変更後の返却一覧にも同じフィルタを適用する。

対象はprovider ID `openai-chat`とmodel ID `gpt-6.1-sol`の一致だけである。
request側のeffort変更、APIの自動切替、直接指定の拒否、保存済みSession/default selectionの変更や
既存catalog dataの削除は含めない。commit・常用配置・公開/release・実provider
callは本指示に含めない。

## 現行のproduct経路

TUI `/model` → Core API `catalog.read(kind=models)` → Core-owned `LiveModelCatalog.models` →
provider `/models`から一覧取得、models.devからeffort
metadata取得、configのfavorites/defaultEffort読込み → `#compose`で共通一覧を返却 → TUI検索・選択 →
`selection.change` → Sessionとdefault selection保存、
という現行経路を使う。お気に入り変更は`modelFavorite` → `LiveModelCatalog.favorite` →
catalog保存/readback → 同じ`#compose` → TUI一覧の再表示である。

external `modelListSource: catalog`の一覧とChatGPTのaccount別一覧も同じ`#compose`を使う。
この返却箇所でフィルタすれば、通常一覧とお気に入り操作後の一覧に同じ選択候補を返せる。
新しい状態や保存先、provider responseの解析制約は増やさない。

原記録の「model一覧はmodels.dev由来」はsource照合で補正する。通常一覧のIDはproviderの`/models`由来で、
models.devはeffort metadataの供給元である。B11のHTTP 400と利用者の採用判断はこの補正で変わらない。

## 実装・確認計画

1. `LiveModelCatalog.#compose`で`openai-chat`の`gpt-6.1-sol`だけを一覧から除外する。
2. 原観測の選択経路に対応するfocused
   testで、live一覧にある対象modelと保存お気に入りが表示されないこと、
   他modelのお気に入り変更後にも除外が維持されること、Responses側の対象modelとeffortが維持されることを確認する。
   既存のChatGPT catalog確認で対象modelの候補・選択を確認する。
3. 変更経路のtype check、format、lint、`git diff --check`を行う。full gateは実施しない。
4. 隔離HOME/XDG/workspaceのproduction TUIをtmuxで開き、Chat側の候補・検索・お気に入り更新と、
   Responses側の候補・選択を確認する。確認用catalogは隔離configへ置き、実provider callは行わない。
   公式build candidateは確認用保存先だけへ出力する。

## 正本変更の扱い

構想、architecture、roadmapは変更しない。provider/auth
architectureの「catalog未登録のmodelも一覧から選択できる」
という現行経路説明に、本incrementの明示除外を例外として追記する案は別承認対象に留める。

## 採用元B11の原記録

以下は通常利用メモから移設した観測と採用前の候補である。今回の採用範囲は上記の一覧フィルタであり、
effort送信抑制は採用していない。

### B11 — `gpt-6.1-sol`で`reasoning_effort`とfunction toolsの併用requestがHTTP 400になる

- 原観測（2026-10-04）: Session `44aab8ea`のexecution `a2d8894a`（turn 1、modelStep 1、物理request
  1回目、retry 0）は、 provider `openai-chat`／api `openai-chat-completions`／model
  `gpt-6.1-sol`／effort `high`の最初のrequestで HTTP 400（stage `http`／code
  `http_error`、`ProviderAPIError`／`invalid_request_error`、param `reasoning_effort`、 requestId
  `req_1fa60a57ccb2470e960dc9d7a8cd7f60`）となり、`contract_failure`
  （`model contract failure: provider request failed (400)`）で停止した。provider
  messageは次のとおり。
  `Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions.`
  `To use function tools, use /v1/responses or set reasoning_effort to 'none'.`
  失敗turnはnon_canonicalに保存され、同旨の再実行`81aaa578`は`mimo-v2.6-pro`でcompletedしcanonical採用された。
- 事象の切り分け: 同Sessionのmodel変更史では08:25:27に`gpt-5.6-sol`／effort
  `none`、08:27:19に`gpt-6.1-sol`／effort `high` へ変更されており、失敗（08:27:39）はeffort
  `none`→`high`の切替直後の最初のrequestで発生している。 model一覧はlive
  catalog（models.dev由来、`openai-chat`／`openai-responses`／`openai-chatgpt`は同一`openai`のmodel群）
  から出るため、`gpt-6.1-sol`はprotocol `openai-chat-completions`の`openai-chat` routeでも選択でき、
  model名の選択だけで`/v1/chat/completions`へ到達した。henjiのChat Completions系request組み立ては
  effort選択時に`reasoning_effort`をtoolsと併送するため（`v0/agent/provider/openrouter_request.ts`の組立と同型）、
  当該provider/modelの受入条件と衝突した。henjiの実装bugというより未観測のprovider
  variantとの組合せである。
- 残る利用者影響: `openai-chat` routeでeffort `auto`／`high`を選んでいる間、function
  tools付きturnは同様に400で停止する。 tools不要な純粋な生成でも同制約に当たるかは未確認。
- 対応候補（未採用）:
  1. 運用回避: 該当modelではeffort `none`を選ぶ、またはtoolsが要るturnを別modelへ回す。
  2. chat-completionsでtools併用時の`reasoning_effort`送信を抑制する（modelの実効effortが変わる点は要確認）。
  3. 同一`openai-api-key`でprotocol `openai-responses`の`openai-responses`
     route、またはChatGPT認証の `openai-chatgpt` route（いずれもResponses
     API）で該当modelを使う（provider messageが勧める方針。route実装は既存）。
- 利用者の運用判断（2026-10-04）: `gpt-6.1-sol`は`openai-chat`（chat-completions）routeでは使わず、
  Responses APIの`openai-chatgpt`または`openai-responses`
  routeで使う方向。chat-completionsで使う場合はeffort `none`前提。
  対応候補1・3の運用部分をこれで代替する。henji側でrouteに6.1を出さない整理や対応候補2（effort送信抑制）は未採用のまま残す。
- 再検討条件:
  同種の400が通常利用で再観測される、またはeffort送信・route選択の対応を個別incrementへ採用するとき。
- 関連: history.sqlite3（schema 1）のexecution `a2d8894a`のoutcomeJsonとdiagnostic
  `12d1188b-0528-4a3d-a372-24ad7da58820`、 `v0/agent/provider/openrouter_request.ts`、
  [provider/auth architecture](../architecture/multi-provider-routing-and-auth.md)。

## 実装・確認結果（2026-10-04）

- `LiveModelCatalog.#compose`の一覧投影で、provider ID `openai-chat`とmodel ID `gpt-6.1-sol`の
  一致だけを除外した。通常一覧とお気に入り更新後の一覧は同じ処理を使う。
- focused testは6件が通過した。新しい190の確認では、live inventoryに対象modelが存在し、保存済み
  favoritesにも含まれる状況からChat側の非表示、別modelのお気に入り登録・解除後の非表示継続、
  保存済みの対象modelのeffort data維持、Responses側の表示・effort・お気に入り登録を確認した。
  既存157の一覧順序・effort metadata・declared
  catalog確認と、178のHTTP経由のChatGPT候補・選択も通過した。
- production CLI入口と新testのtype
  check、変更source/testのformat・lint、`git diff --check`が通過した。 full gateは実行していない。
- 公式build scriptで確認用binaryを`.tools/increment-190/henji`へ作成した。build IDは
  `1128ddce033536e22463a1fb303991aaac81cc36565dc00d1906e012e2abb7f1`。 sourceDirty=trueのlocal
  candidateであり、`dist/henji`と常用binaryには配置していない。
- 隔離HOME/XDG/workspaceで同binaryのproduction `serve`とtmux上のTUIを使用した。
  隔離configのChat/Responses declarationには同じ二つのmodel（`gpt-5.6-sol`と`gpt-6.1-sol`）を置き、
  `modelListSource: catalog`を使用した。Chat側の保存favoritesに対象modelを残した状態でも、
  `/model`には5.6だけが表示された。Tabで5.6のお気に入りを変更した後も対象modelは非表示で、
  `gpt-6.1-sol`の検索結果は`no matching models`だった。
- TUIの`/provider`で`openai-responses`へ切り替え、`/model`で対象modelの表示と検索を確認した。
  Enterで選択し、Session API readbackが`openai-responses`／`gpt-6.1-sol`／effort `high`に一致した。
  隔離default selectionにもResponses側の選択が保存された。
- tmux確認は実providerを呼んでいない。live provider一覧の経路はfocused testの代替fetcherで確認し、
  production TUIの表示・操作経路は隔離declared catalogで確認した。 新executionは0件、実provider
  requestは0回。確認用Coreはshutdown accepted、exit 0で終了した。
  実config・実DB・既存Core/TUIは変更していない。
- 証拠はgit管理外の`.tools/increment-190/build.log`、`tmux-check.py`、`tmux-result.json`、
  `tui-chat-models.txt`、`tui-chat-favorite.txt`、`tui-chat-search.txt`、`tui-responses-models.txt`、
  `tui-responses-search.txt`、`tui-responses-selected.txt`、`core.log`へ保存した。

本指示のlocal実装と非破壊的な検証は終了した。常用binaryは189の配置版のままなので、通常利用へ反映するには
別途配置が必要である。保存済みのChat側selectionやCLI/APIの直接指定は一覧フィルタの対象外である。
構想・architecture・roadmapの変更、commit・常用配置・公開/releaseは行っていない。

## Commit・常用配置の承認（2026-10-04）

利用者の「常用配置・commitして」により、local commitと常用binaryへの配置、配置後の確認と結果記録を
追加承認された。上記の採用時点の境界をこの承認で更新する。

実装と検証記録をsource commitへ保存し、公式build scriptでsourceDirty=falseのbinaryを作成する。
検証済みcandidateとembedded runtime digestが一致することを確認し、旧binaryを保存したうえで
`dist/henji`と常用`henji`へatomic配置する。配置版を隔離HOME/XDG/workspaceのtmuxで開き、
Chat側の一覧・検索・お気に入り更新とResponses側の表示・選択を確認する。

既存Core/TUIは再起動しない。実configとprovider
requestは本修正の配置に不要であり、変更・呼出を行わない。
構想・architecture・roadmap正本への反映、公開/release・push、旧実データ削除はこの承認に含めない。

## 常用配置結果（2026-10-04）

- 実装と関連文書をsource commit `def02bb2659cc70d84ae7779245fa5af35b7c915`
  （`fix: filter gpt-6.1-sol from OpenAI Chat model choices`）へ保存した。
- 公式build scriptでsourceDirty=falseのbinaryを作成した。build IDは
  `33bf9e59e3937a228d734d64c4f96d8f916bfe4e38d9d1ebcf7cb2cd9dc3a00d`、embedded runtime SHA-256は
  `a06c60eac7ea6646663fc495b34d55424b7b26aa1b1c4b8862385402d3300507`。実装検証済みcandidateとruntime
  digestが一致した。
- 旧binaryを`.tools/increment-190/deployment/henji.dist.previous`と`henji.local.previous`へ保存し、
  staging fileから`dist/henji`と`/home/agent/.local/bin/henji`へatomic配置した。
  両配置先のversion・build manifest・binary SHA-256が一致した。 binary
  SHA-256は`beab8a61ef5911bf13b3eb1833fe6f2ac6ffe642b611fe49305e9d885dcbe5dd`。
- 常用配置したbinaryのproduction CoreとTUIを隔離HOME/XDG/workspaceのtmuxで起動し、
  Chat側の対象model非表示・お気に入り変更後の非表示継続・検索の`no matching models`を確認した。
  Responses側では対象modelの表示・検索・選択と、Session API readback・隔離default
  selection保存を確認した。 新executionは0件、実provider requestは0回。確認用Coreはshutdown
  accepted、exit 0で終了した。
- 実configの非credential 26fileは配置前後でhash一致した。既存Core 1件のID・PID・URLも一致し、
  既存Core/TUIを再起動していない。フィルタはCoreが一覧を生成する処理にあるため、
  既存CoreへTUIを再接続するだけでは切り替わらず、新しく起動するCoreから有効になる。
- 証拠は`.tools/increment-190/deployment/`の`build.log`、`deployment.json`、`local-runtime.json`、
  `dist-runtime.json`、`tmux-result.json`、`tui-*.txt`、`existing-core-check.json`とconfig/Core
  snapshot。 既存source検証済みruntimeとの一致を確認したため、focused testとfull
  gateは繰り返していない。

190の常用配置・source commitは終了した。配置結果と現在地を記録commitへ保存する。
公開/release・push、構想・architecture・roadmap変更は行っていない。
