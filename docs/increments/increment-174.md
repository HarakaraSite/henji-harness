# Increment 174 — ChatGPT未登録時もprovider一覧と選択を使えるようにする

更新日: 2026-10-03

ステータス:
**完了（2026-10-03、利用者承認）。local実装・focused確認・隔離production
TUI確認・通常review・常用配置済み。commit/pushは未実施。**

利用者の「B6の対応を行う」「これインクリメント174ね」により採用した。

## 採用要件と実行証拠

- ChatGPT
  account未登録でも、TUIの`/provider`はChatGPTを含むprovider一覧を表示する。
  API-key providerの選択・切替をChatGPTの未登録状態で妨げない。
- 未登録のChatGPTも選択でき、Session selectionと次回default
  selectionを保存できる。 accountがない段階でaccount
  catalogへの設定保存を要求しない。認証は既存`/login`から行う。
- provider一覧用のChatGPT default
  effortは、選択accountがない場合に宣言済みの値を使う。
  選択accountがある場合は、そのaccountに保存されたeffortを使う。
- ChatGPTの実model一覧取得・認証・accountごとの設定保存は既存の経路を使う。
  provider一覧を開くための外部provider requestは不要。
- エラーメッセージは英語。credential・Authorizationを記録しない。

B6の原観測は2026-10-03、Increment 170の隔離HTTP確認で、ChatGPT未登録の
`catalog.read(kind=providers)`がHTTP 500、Core直接呼出しが
`LiveModelCatalogError: credential_unavailable`となったもの。
173の隔離production TUIでも、`/login`のExa／Brave登録は成功したが、`/provider`は
`provider catalog unavailable`、一覧APIはHTTP 500となった。
該当処理は170以前から存在し、170／173では修正していなかった。

## 現行経路と修正計画

人間の`/provider` → remote catalog UI → Core HTTP catalog API →
`CoreService.catalogRead` → 全providerの`LiveModelCatalog.defaultEffort` →
provider一覧とdefault selection → Coreのselection変更 →
WorkerとSessionのselection保存、 という経路である。

`defaultEffort`がChatGPTの選択account解決を必須にしているため、認証が不要な一覧取得も失敗する。
選択accountがない場合は非secret宣言からeffortを取得し、account
catalogを作らない。
選択accountまたは明示accountがある場合のcatalog読取りと保存は保持する。
一覧復旧後の隔離production
Core確認で、未登録ChatGPTへのselection変更はSessionを更新した後、
`remember`のaccount必須処理でcommandが`rejected`／`failed`となることも観測した。
`remember`はaccount未登録時にaccount catalogへ書かず、Sessionとdefault
selection保存を完了させる。
未知の障害をcatchしてdefaultへ置き換える処理は加えない。

変更は`live_model_catalog.ts`のdefault
effort取得・effort記憶と、該当regressionの確認に限定する。 既存144
HTTP確認のChatGPT除外を撤去して、実際のbuiltin
provider集合でAPI-key選択経路を確認する。 B7／B8、model
backend、認証フローの変更は対象外。

## 確認計画

- 新174 HTTP確認: ChatGPT未登録でも全providerが返り、宣言済みdefault
  effortを表示できる。 ChatGPT
  model取得は既存の認証エラーとなり、外部requestや未登録accountのcatalog生成はない。
  未登録ChatGPTの選択がacceptedとなり、API-key providerへの切替も成立する。
- 既存144 HTTP確認: 全builtin providerがある環境でAPI-key
  providerの選択・変更が成立する。
- 既存163 account catalog確認: accountごとのdefault
  effortとfavoriteが分離される。
- 関係するsource/testのtype check、format、lint、`git diff --check`を実施する。
- 隔離XDG・tmuxのproduction TUIで`/provider`の一覧、API-key
  providerへの切替と再表示、 未登録ChatGPTの選択とAPI-key
  providerへの切替、`/login`のChatGPT登録入口を確認する。
  確認資料はtmpへ保存する。 実provider callは行わず、実configへdefault
  selection等を書かない。full gateは計画しない。

## 結果

- `LiveModelCatalog.defaultEffort`はChatGPT
  account未選択時に宣言済みeffortを返す。 provider一覧に全5 builtin
  providerを含め、認証を一覧取得の条件にしない。
- `remember`は未登録時にaccount catalogへ書かず、CoreのSession
  selectionとdefault selection保存を
  完了させる。登録済みのselected／明示accountは既存のaccount別catalogを使う。
- accountなしのmodel一覧取得は既存の`chatgpt_selection_missing`となる。実model
  request、 認証、favoriteの経路とaccount別の保存先は変更していない。
- B6の観測と採用要件を通常利用メモから本書へ移し、173の参照pointerを更新した。
  B7／B8の実装と構想・architecture・roadmapは変更していない。

### Focused確認

最終candidateの174 HTTP 1件、144 HTTP 1件、163 runtime 5件がすべて成功した。
174では全provider一覧、未登録ChatGPTの選択成功とcredential missing、API-key
providerへの切替、 認証が必要なmodel取得、外部request 0、未登録account
catalogを作らないことを確認した。 144のChatGPT除外を撤去し、全builtin
providerがある構成で既存のcatalog／selection／credential操作が
成立することを確認した。163ではaccount Aの記憶effortを明示accountとselected
accountの両方から 読み戻し、account
Bのeffort・favoriteへ混入しないことを確認した。

関係するsource/testのtype check、format、lint、`git diff --check`は成功。 full
gateと実provider/model callは行っていない。

### 隔離production TUI

資料: `/tmp/henji-increment-174-tui-q1kub2m5/evidence/`。 source版の通常CLI
`serve`と接続TUIをtmuxの100×32 terminalで起動し、config/data/stateを
同tmp配下のXDGへ分離した。network
permissionは127.0.0.1だけとし、実credentialを使わず、 実provider/model
callは行っていない。

1. ChatGPT account 0件の状態で`/provider`を開き、全5 providerとdefault
   model／effortを確認した。 同じCoreのprovider一覧APIはHTTP 200だった。
2. OpenAI Responsesへ切り替え、Session
   selectionと隔離`default-selection.json`の更新を確認した。
   pickerを再表示すると現在のOpenAI行が選択されていた。
3. 初回の一覧修正後、未登録ChatGPTのselection変更がSessionを更新した後に`rejected`／`failed`となる
   既存の`remember`問題を実Coreで確認し、同じ174のprovider選択経路として修正した。
   原観測は`06-chatgpt-selection-before-remember-fix.json`。
4. 最終sourceでCoreとTUIを起動し直し、未登録ChatGPTの選択が失敗noticeなく完了した。
   Session、footer、次回defaultがChatGPTとなり、credentialはmissing、account
   catalogは作られなかった。
   `/login`には既存の`Sign in with ChatGPT`登録入口が表示された。
5. `/provider`を再表示し、ChatGPTの選択行を確認した後、OpenAI
   Responsesへ戻せた。
   最終資料は`07-final-providers.txt`〜`12-selected-back-openai.txt`と`checks.json`。

TUIをdetachし、今回の検証用Coreだけを通常`core stop --connect`で停止した。
常用Coreと実configは変更していない。このlocal確認時点では常用配置・commit/pushは未実施。

2026-10-03の利用者の「では完了とする　次のb7に進む」で本incrementの完了承認を受けた。
後続はB7を[Increment 175](increment-175.md)として進める。

### 通常reviewと常用配置

2026-10-03の「b6からb8まで通常レビューさせて」による174〜176の通常reviewでfindingはなかった。
続く「では配置して」により176までを含む常用binaryを配置した。配置先のproduction
TUIを隔離XDGで 起動し、未登録ChatGPTを含むprovider一覧、ChatGPTの選択、API-key
providerへの切替を確認した。
配置・review資料とbuild情報は[Increment 176](increment-176.md#常用配置)を参照する。
