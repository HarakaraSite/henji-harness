# Increment 178 — ChatGPTの最新モデルを固定候補へ追加

## 要件・根拠

利用者の2026-10-03の「今はカタログに固定記載しよう、エフォートも公式から調べて
カタログに乗せて」により、`openai-chatgpt`の`gpt-6.1-sol`と`gpt-6-luna`を
モデル候補へ追加する。既存のAPI由来のモデル候補とアカウント別の設定を維持する。

- 同日の登録済みアカウントの`GET /v1/models`はHTTP 200、表示候補5モデルだったが、
  この2モデルを含まなかった。
- 利用者承認済みの直接指定probeでは、両モデルが`Hello, world!`を返し、HTTP 200、
  指定モデル名、`response.completed`を確認した。tool利用や全effortの実callは未確認。
- [GPT-6.1 Sol公式](https://developers.openai.com/api/docs/models/gpt-6.1-sol):
  `low / medium / high / xhigh / max`、既定`medium`。
- [GPT-6 Luna公式](https://developers.openai.com/api/docs/models/gpt-6-luna):
  `none / low / medium / high / xhigh / max`、既定`medium`。
- Probe資料: `/tmp/henji-chatgpt-model-catalog-check/models.json`、
  `/tmp/henji-chatgpt-61-probe/retry-result.json`、同`luna-result.json`。

## 現行経路・変更範囲

TUIの`/model`・login中のモデル閲覧 → Coreの`catalogRead` → `LiveModelCatalog.models` →
選択アカウントのOAuth解決 → API一覧・models.dev・アカウント別catalog → TUI候補。
`/effort`は同じcatalogの`efforts`を読み、モデル選択時の既定effortと選択済みeffortは
既存のアカウント別保存を使う。

- 固定entryに`pinned`を追加し、今回の2モデルだけを指定する。API一覧の順序を保ち、
  未収録の固定候補を末尾へ補う。既にAPI一覧にあるモデルは重複させない。
- 固定候補のeffortは宣言を正本とし、models.devより優先する。`auto`は既存UIの
  「effortを明示送信しない」選択として残す。
- 新たな保存先や旧dataのmigrationは追加しない。API一覧取得失敗時のfallbackも追加しない。
- 対象: provider defaults・entry parser・live catalog、対応する既存catalog testと
  この動作を確認するfocused test、利用説明。

## 確認計画

- 実測した旧API一覧に対して2モデルと公式effortが候補に出ること、既存保存catalogでも
  反映されること、favorite・選択・effortがCore HTTP経由で読み戻せることを確認する。
- 既存ChatGPTのAPI・アカウント別catalog、provider declarationとcatalogのfocused確認、 type
  check、format、lint、diff checkを行う。
- tmuxのproduction source TUIで隔離XDGとlocalhost模擬provider/authを使い、
  `/model`から両モデルを選択し、`/effort`の候補と変更を確認する。追加の実provider callは行わない。
- 常用配置、commit/push、公開、構想・architecture・roadmapの変更は対象外。

## 結果

local実装・確認完了（2026-10-03）。

- `openai-chatgpt`のbundled catalogに2モデルを`pinned: true`として追加した。
  API一覧へ未収録entryを補い、model一覧・effort一覧・favorite保存で宣言済みeffortを使う。
  providerの既定モデルは既存の`gpt-5.6-sol`を維持した。
- 保存済みアカウントcatalogに新モデルがない場合も、候補と既定`medium`へ反映された。
  API一覧へ6.1-solが現れた場合はその位置を保ち、重複させないことをHTTP経由で確認した。
- focused確認は178のHTTP確認、163のAPI／runtime、157のcatalog、174の未登録provider一覧、
  14のprovider宣言／runtimeの計36 caseが通過した。
- CLI入口と変更testのtype check、変更source/testのlint・format、diff checkを確認した。 full
  gateは実行していない。
- tmux、100×32、隔離XDGのproduction source TUIとproduction Core HTTPで確認した。
  OAuthと外部catalog取得だけを模擬し、API一覧には実測した旧モデル一覧を再生した。
  `/model`に既存5モデルと新2モデルの計7候補が出た。両モデルを検索・選択すると`medium`になり、
  Solのfavorite、Solの`max`、Lunaの`none`選択をTUI表示とCoreの保存値で確認した。
  資料は`/tmp/henji-increment-178-tui/evidence/`。確認用TUIとCoreは停止済み。
- この実装・確認で追加の実provider callは0回。常用配置、commit/push、公開、
  実configの変更、構想・architecture・roadmapの変更は行っていない。

## 常用配置（2026-10-03）

利用者の「その後配置して」により、177・178を含む現在のlocal sourceを
`henji:compile`でbuildし、`dist/henji`と`/home/agent/.local/bin/henji`へ配置した。 配置先はstaging
fileから置き換え、前のbinaryは`.tools/increment-178/henji.previous`へ保存した。

- version: `0.8.0`、Deno `2.9.7`。
- source: `9c4e4d5257e0669ea896988dda9096d5d10855e3+dirty`。
- Build ID: `1d61453333894ead19aee82b641df31a0ef3335bfed8c5469046afccacb7f0b5`。
- Binary SHA-256は`.tools/increment-178/deployment.json`を参照する。配置先とdistのhashは一致した。

配置先binaryのproduction Core/TUIを隔離XDG、tmuxの100×32 terminalで確認した。 外部宣言のlocalhost
Responses providerへ同じ2つの固定entryを渡し、API一覧には `gpt-5.6-sol`だけを返した。compiled
runtimeの候補補完で両モデルが表示され、
Solは既定`medium`から`max`へ、Lunaは既定`medium`から`none`へ変更できた。 Luna／noneでの1
taskはlocalhostへ1 inference requestを送り、`Completed normally.`と
readyを表示し、保存Sessionはidleへ戻った。Coreのbuild IDも配置版と一致した。

localhostのmodel一覧取得は2回、inferenceは1回、実provider callは0回。 この配置先確認は宣言／compiled
catalog／Workerの実経路を確認するもので、 ChatGPT認証での実推論確認を追加するものではない。
資料は`.tools/increment-178/deployed-tui/`、確認用Core・TUI・providerは停止済み。
起動中の常用Coreと実configを変更せず、新しく起動するCoreから配置版を使う。
利用者の「コミットプッシュはしよう」により、177・178のcommit/pushは追加承認された。公開は行っていない。

## Commit/push（2026-10-03）

利用者の「コミットプッシュはしよう」により、177・178の実装・検証・配置記録と関連メモを commit
`e76056bab3fb30ccb9661290cb7f84625d1c2f3c`へまとめ、`origin/main`へpushした。
完了状態の記録も同じ送信先へcommit/pushする。
配置済みbinaryは常用配置節に記載したbuildのままであり、今回のcommit/pushでは再buildしていない。
