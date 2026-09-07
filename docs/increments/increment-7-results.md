# 通常利用 increment 7 — 実装結果

ステータス: local実装、focused verification、コード／テストreview、authoritative offline gate完了。
production retained TUIでmechanismの成立を確認したが、grounding品質は未受入。increment 8で修正する。

## 成立した動作

- default parent Definitionへ`tool:web_search`を追加した。modelは
  `web_search({"query":"..."})`を呼び、同じturnの次のmodel stepで検索結果を使える。plannerのtool集合は
  従来どおり`read`、任意`skill`、`submit_json_result`だけである。
- Henji-ownedな`WebSearchBackend`境界と`web_search` toolを分離した。toolは一つのqueryを渡し、回答本文と
  backendが返した順序のtitle/URLを番号付き`Answer`・`Sources` textとしてmodelへ返す。
- 初期production backendは、既存OpenRouter credential sourceで`perplexity/sonar`を一回呼ぶ。
  non-streaming Chat Completions requestへ一つのuser messageと
  `web_search_options.search_context_size: "low"`を渡し、実測した
  `choices[0].message.content`と`annotations[].url_citation`をparseする。sourceを並べ替え・重複除去しない。
- Sonar callは親のmodel request admissionを一件消費し、main modelと同じcounted fetchを使う。tool call元の
  `modelStep`を`ToolExecutionContext`からprovider evidenceへ渡すため、main → Sonar → mainのrequest順と
  runtime eventを同じturn artifactから確認できる。
- request body、response headers、raw response bytes、JSON parse、terminal/resultまたはfailure transitionを
  既存provider evidenceへ保存する。evidence APIにはrequest header、Authorization、credentialのcapture shapeを
  加えていない。
- user cancellationはSonar fetchへ同じ`AbortSignal`で伝播し、model-visible tool errorへ変換せず既存の
  `cancelled` settlementへ進む。HTTP error、invalid UTF-8/JSON、回答またはURL citation欠落はraw responseを
  保持したtool errorになり、自動retryやfallbackを行わない。
- Worker production compositionはmain modelとSonar backendへ同じcredential sourceとcounted fetchを渡す。
  provider-free Workerはnetwork-free backendを使う。non-Worker runtimeにもbackend injection seamと固定Sonar
  production backendを接続した。
- built-in component catalog、resource topology、manifest、public composition API、JSR publish allowlistへ
  `web_search`を追加した。OpenRouter `openrouter:web_search` server toolを使うbackendは未実装で、同じ
  `WebSearchBackend`へ将来追加できる案として残る。

## Focused verification

- increment 7 web search suite: 5 passed、0 failed。
  - provider-free non-Worker compositionが注入backendをmaterializeする。
  - productionと同じWorker physical I/Oでmain SSE → Sonar JSON → main SSEを実行し、最終回答まで継続する。
  - annotation順のsource、Sonar request shape、shared request count 3、request budget消費3、evidence model step
    `[1, 1, 2]`、runtime event順、raw response、credential/Authorization非記録を確認する。
  - HTTP 429、invalid JSON、citation欠落は各一回のrequestでtool errorとなり、raw responseとfailure transitionを
    保持する。
  - request budget exhaustionはcredential解決とfetchの前に停止する。
  - nested fetch中のcancelはtool resultを生成せずturnを`cancelled`にする。
- Definition/current-code suite: 14 passed、0 failed。defaultのtool topology、planner分離、active guideline、
  manifest/resource validation、component replacementを確認した。
- Worker foundation suite: 34 passed、0 failed。built-in/external Definitionがprovider-free backendを含む同じ
  Worker compositionで起動し、既存protocol、request accounting、cancel、commitを維持することを確認した。
- provider stream compatibility suite: 10 passed、0 failed。production physical I/O refactor後もmain modelのSSE、
  provider evidence、planner continuationを維持することを確認した。
- `v0:check`、format 112 files、lint 109 files、`git diff --check`: 成功。

## コード／テストreview

- tool contract、Sonar request/response parser、credential、request admission/count、evidence、cancellation、
  Worker/non-Worker composition、Definition/manifest topology、planner分離、public exportをsourceから利用者影響まで
  照合した。実装上のBlocker/P1/P2はなかった。
- 初回test reviewで、承認済み計画にあるnon-2xx、invalid JSON、budget exhaustionの具体的確認が不足していた。
  production contractを変えずfocused casesを追加し、各一回のrequest、raw evidence、retryなし、fetch前停止を
  確認した。追加後のreviewで未解決findingは0。
- 新tool追加でfresh-runtime comparisonの固定manifest/replay-envelope identityが旧resource集合を示したため、
  新しいDefinition resource集合から4 identityを再計算した。comparisonの64対4という評価軸は変更していない。

## Authoritative offline gate

stable candidateへ`deno task --config deno.v0.json v0:gate`を一回実行し、成功した。

- 通常suite: 57 passed
- provider stream compatibility: 10 passed
- increment 4 filesystem: 6 passed
- increment 5 bash output: 11 passed
- increment 7 web search: 5 passed
- 合計89 passed、0 failed

このgateとfocused verificationはprovider-free responseだけを使用し、新しいprovider requestやcredential読取りを
行っていない。

## Production利用での確認

2026-09-07にユーザーが`/home/masat.guest/src/forgejo-agent`からproduction retained TUIを通常利用し、Session
`59a37c41-5f6d-4607-a700-39be01f857cd`でDeno 3.0候補の調査を二turn行った。保存済みtranscriptとprovider
evidenceから、初回4回、追質問3回の`web_search`、main → Sonar → mainの交互実行、全HTTP 200、合計140件の
ordered annotation、二つのfinal settlementを確認した。Sonar 7回の合計は2,282 tokens、$0.03727、mainを含む
provider costは$0.072676825、各turnの所要時間は約33秒だった。evidence recordにはAuthorization、credential値、
credential pathを持つshapeも文字列もなかった。

mechanismはproduction経路で成立した。一方、追質問へのfinalはsource URLを表示せず、Sonarが公式なDeno 3
roadmapを確認できないと返した後も、親modelが将来topicを確認済みのように断定した。したがってincrement 7を
grounding品質まで受入済みとはせず、具体的query、Sonarの検索結果限定回答、親のsource URL・不足・推論表示を
increment 8で修正する。確認後のreadbackでは追加provider requestを実行していない。
