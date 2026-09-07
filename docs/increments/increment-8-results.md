# 通常利用 increment 8 — 実装結果

ステータス: local実装、focused verification、コード／テストreview、authoritative offline gate完了。
production retained TUI human gateとユーザー受入は未実施。

## 成立した動作

- Sonar requestへ、search resultで裏付けられた内容だけを答え、不足時は推測せず、near missと推論を明示する
  system messageを追加した。公式contractどおり、このmessageは検索後の回答規律を担う。
- `web_search`のactive guidelineは、親modelへcompleteでspecificなresearch questionを渡すよう求め、bare
  keywordまたはBoolean queryより優先させる。backendはmodelが選んだqueryを暗黙に書き換えない。
- 親modelには、返されたsource URLを対応する主張の近くへ示し、sourceが答えを含まない場合と推論をfinalで
  明示するよう求める。guidelineは`web_search`を持つdefault parentだけへ合成し、plannerには追加しない。
- 通常検索の`web_search_options.search_context_size`を、公式がgeneral query向けとする`medium`へ変更した。
- increment 7のHenji-owned tool contract、交換可能backend、ordered citation、main → Sonar → main、request
  admission/count、raw evidence、error、cancellation、credential非記録を変更していない。

## 検証

- increment 7 web search focused suite: 5 passed、0 failed。実際に生成するSonar request bodyがgrounding system
  message、exact user query、`medium`を持つことを確認し、main → Sonar → main、citation順、request count、
  evidence、error、budget exhaustion、cancellationも維持した。
- Definition/current-code focused suite: 14 passed、0 failed。新guidelineがdefault parentに一回だけ入り、
  plannerと空Registryへ混入しないことを確認した。
- `v0:check`、format 112 files、lint 109 files、`git diff --check`: 成功。
- stable candidateへauthoritative offline `v0:gate`を一回実行し、通常57、provider compatibility 10、filesystem
  6、bash output 11、web search 5の合計89 testsが成功した。
- focused verificationとoffline gateはprovider-free responseだけを使用し、credentialを読まず、新しいprovider
  requestを行っていない。

## コード／テストreview

- 承認済みproduct動作、Perplexity公式Prompt GuideとSearch Filters、production request builder、active tool
  guideline composition、focused testを照合した。
- 変更はSonar messageとcontext size、`web_search` guidelineに限定され、model、tool schema、parser、backend
  seam、retry/fallback、request budget、cancel、evidence、planner tool集合、public APIは変わっていない。
- 実利用で観測した具体的な問題へ対応しないpermission、入力制限、search filter、回数制限、hardening testは
  追加していない。未解決Blocker/P1/P2は0。

## Pending production human gate

code変更後の新しいWorker generationで、曖昧さを含むcurrent-information taskをproduction retained TUIから
一回実行する。modelがcompleteでspecificなquestionを選ぶこと、Sonarと親finalが不足・near miss・推論を
確認済み事実から分けること、使用したsource URLをfinalで示すこと、実測usage・costを確認する。

この操作はcredentialとprovider requestを使うため、ユーザーの別の明示承認まで実行しない。既に起動していた
Session `59a37c41-5f6d-4607-a700-39be01f857cd`のWorker generationには、disk上の変更は反映されない。
