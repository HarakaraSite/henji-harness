# 通常利用 Increment 27 — Retained TUI描画への一本化

ステータス: **完了**

## 利用者が必要とする動作

- 通常の`henji` TUIで現在利用しているretained描画を唯一の描画経路とする。
- test用のSession/runtime注入を使う場合もproductionと同じretained描画を使い、表示方式を暗黙に
  切り替えない。
- startup、conversation、editor/footer、overlay、Session再開の現在のproduct動作を維持する。

## 根拠と現行source

- production CLIは`createSession`と`runtimeSeam`が未注入の場合だけretained描画を選び、通常利用では
  常にこの条件が成立する。legacy描画を選択するCLI optionやslash commandはない。
- dependency injection時だけlegacy描画へ切り替わるが、これらはprovider-freeなdirect test/host seamであり、
  別の人間向けSurfaceとして定義されていない。
- `TuiRenderer`はretained modeでも`UiState`を更新する一方、legacy modeではconversation event、editor、
  status、picker、history/context、restored transcriptを別の文字列・cursor操作で再実装している。
- 二重実装はすでにSession pickerで表示差を生み、後続のbusy経過時間とSession識別情報を両経路へ実装する
  必要も生じさせる。

## Product動作

- `TuiRenderer`は常に`UiState`を更新し、pure layoutからretained frameを生成する。
- `TerminalLifecycle`は実Sessionとtest seamの双方でalternate screenを取得・復元する。
- `createSession`、`runtimeSeam`、terminal、state root等のdependency injection自体は維持する。
- productionで使われないlegacy startup、逐次conversation出力、editor block/cursor管理、static overlay、
  restored transcript出力を削除する。
- retainedのconversation、viewport、overlay、input、footer、terminal cleanupの意味と表示は変更しない。

## 実装計画

1. `TuiRenderer`から`retained` option、legacy-only state/helper、各条件分岐を削除し、既存のretained処理を
   無条件の描画経路にする。
2. TUI CLIからdependency注入による描画方式の切替とlegacy startup出力を削除し、常にcompact retained
   startupを使う。
3. direct renderer testと注入seamをretained経路へ合わせ、productionのconversation、footer、overlay、
   resize、alternate-screen restoreが維持されることをfocused testで確認する。
4. 関連type check、format、lint、`git diff --check`を実行し、変更箇所をcorrectnessとregressionの観点で
   reviewする。
5. stable candidateでauthoritative `v0:gate`を一回実行する。

## 成功条件

- repository内にlegacy/non-retained TUIを選ぶ状態、条件分岐、直接描画実装が残らない。
- dependency injection時もretained rendererとalternate screen lifecycleを使う。
- productionで現在使うstartup、conversation、editor/footer、overlay、Session復元、terminal restoreが
  focused testで維持される。
- 後続Incrementはbusy経過時間とSession pickerを一つのproduction描画経路だけへ追加できる。

## 対象外

- busy経過時間、Session title、Session picker表示、`/rename`
- Session schema、Worker protocol、provider/model処理、Session navigation semantics
- 新しいSurfaceまたはrendererの追加
- live provider、real-TTY、E2E
- 構想、architecture、roadmap正本の変更

## 承認

- 利用者は2026-09-10、legacy描画を先に削除し、その後のIncrementでbusy経過時間とSession pickerを
  改善する計画をIncrement 27として承認した。

## 実装結果

- `TuiRenderer`から描画方式を選ぶ`retained` optionと全条件分岐を削除し、`UiState`、pure layout、
  retained frameを唯一の描画経路にした。
- legacy専用だった逐次conversation出力、editor block/cursor管理、static overlay、startup orientation、
  history/context文字列化、restored transcript出力と関連state/helperを削除した。
- TUI CLIは`createSession`または`runtimeSeam`の注入有無にかかわらず同じrendererを作り、常にcompact
  startupとalternate screen lifecycleを使う。
- test/runtime、terminal、state root等のdependency injection、Session navigation、Worker protocol、
  provider/model処理は変更していない。
- controllerは削除した互換aliasではなく、現行の`clearLiveActivity()`を直接呼ぶようにした。

## 検証結果

- retained renderer、conversation、controller overlay、tool previewのfocused test 42件が成功した。
- focused testはalternate-screenの取得・復元、startup、conversation、busy/footer、editor、resize、viewport、
  Session picker、provider/model/effort picker、cancel、history exportを既存product経路で確認した。
- 変更対象のtype check、format、lint、`git diff --check`が成功した。
- legacy描画の選択state、条件分岐、direct startup/history/overlay/conversation出力helperがrepository内に
  残っていないことをsource検索で確認した。schema-v3のlegacy model migration等、描画方式と無関係な
  `legacy`処理は対象外として維持した。
- stable candidateでauthoritative `v0:gate`を一回実行し、type check、全体format、lint、既存144 testが
  すべて成功した。

## Review結果

- 利用者の依頼により、実装者とは別の第三者reviewerがworking tree差分をread-onlyで確認した。
- production CLIの通常起動とdependency注入のどちらも同じ`TuiRenderer` constructorへ到達し、rendererは
  `usesAlternateScreen`を常に有効にする。
- conversation event、editor/footer、overlay、restored transcriptは`UiState`へ入り、`layoutUi()`から
  frame化される一経路だけになった。
- retained固有のfollow-up pending表示、close後のwrite防止、terminal restore時のline clearは保持した。
- 第三者reviewのBlocker、P1、P2、P3 findingはなく、今回の変更による未解消のcorrectness findingはない。

## 承認後に追加したlive E2E

- 利用者は差分review後の実provider E2Eを追加で許可したため、2026-09-10にrunbookの
  `agent:e2e:live --confirm-external-call`を一回実行した。
- production childはprovider request前に終了した。`runtime_cli_launcher.sh`の`--no-remote`でWeb Workerを
  起動すると、Worker graphが静的importする`@openai/openai`のJSR package manifestを解決できない。
  保存結果は`executionCount: 0`、`evidenceCount: 0`、`externalRequests: 0`、`retryCount: 0`であり、
  credential値は読んでいない。
- `vendor/`、lockfile、configは存在し、通常processの`deno info --no-remote`は成功する。一方、同じ
  `worker_bootstrap.ts`を実際のWeb Workerとして起動すると`--no-remote`で同じ失敗を再現し、
  `--cached-only`ではremote取得なしで`ready`へ到達した。
- Increment 27の差分はprovider、Worker、launcher、Deno configを変更しておらず、このproduction起動不具合は
  計画外だった。利用者の追加承認後、`runtime_cli_launcher.sh`を`--cached-only`へ変更し、launcher契約testへ
  回帰確認を追加した。shell構文、type check、format、lint、Worker foundation 41件、offline production E2E
  5件が成功し、第三者の限定再reviewでもfindingはなかった。
- 許可済みのlive E2Eを再実行すると、production childは正常終了し、`read`を一回実行してnonceだけを最終出力した。
  保存evidenceはparentのmodel step 1、2に対応するOpenRouter HTTP 200を二件保持し、retryは0だった。
- E2E validatorはその後`execution_contract_mismatch`を返した。唯一の不一致は、Increment 14でWorker manifestが
  `modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION)`へ移行した後も、validatorとoffline fixtureが旧
  `PRODUCTION_PROFILE.id`を期待していることである。product実行、tool順序、commit、artifact/evidence link、
  provider responseは正常だった。
- 利用者の追加承認後、artifactのroute identity照合とoffline fixtureを現行manifest契約へ揃え、focused確認と
  第三者限定再reviewを通した。許可済みlive E2Eを再実行すると同じproduct動作とOpenRouter HTTP 200二件は
  成功し、validatorは次の`provider_evidence`段階で`evidence_request_mismatch`を返した。
- この不一致は、Increment 14でproduction evidenceの`requestMetadata`がprovider、API、model、auth、origin、
  protocolを含む9項目へ拡張された後も、validatorとfixtureが旧3項目以外を拒否していたためである。実recordの
  9項目は現行recorder contractと一致したため、validatorとfixtureをcurrent production値のexact key/value照合へ
  修正した。focused type check、format、lint、offline production E2E 5件と第三者限定再reviewは成功している。
- 利用者の明示許可後に最終live E2Eを一回実行し、`ok: true`、`outcome: passed`を得た。production childは
  `read`を一回実行し、2 model steps、OpenRouter request二件、retry 0でexact nonceをfinal出力した。stop reasonは
  `final`で、execution artifactとprovider evidenceを`/tmp/henji-production-e2e-f3d95406548675c6`へ保持した。
