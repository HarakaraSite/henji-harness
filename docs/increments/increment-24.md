# 通常利用 Increment 24 — OpenRouter provider request retry

ステータス: **local実装・検証完了、Human Gate待ち**

## 利用者が必要とする動作

OpenRouter経由のagent model requestがSSE開始前のHTTP 5xxで失敗した場合、同じ論理model stepの中で
provider requestだけを再試行する。利用者がturn全体を手動再送して、既に完了したtool調査まで繰り返す
必要をなくす。

## 根拠

- production retained TUIのSession `79e87fa2`では、Qwen rootの21回目のprovider requestに対して
  Alibaba
  provider由来のHTTP 502 `STOP_ENGINE_ERROR`が返り、turnがuncommittedで終了した。
- Session `c41865cf`でも最初のroot requestが同じHTTP 502で失敗し、入力復元後の手動再送は完遂した。
- 現行HenjiはOpenRouter provider requestを自動retryしない。手動再送は失敗したmodel requestだけでなく
  turn全体を開始し直すため、完了済みtoolも再実行され得る。
- OpenRouter公式SDKにも5xx retryがあり、今回の観測はSSE開始前のHTTP応答として保存されている。

## product動作

- 対象は`OpenRouterAgentModel`を通るroot、planner、context compactionのmodel requestとする。
- retryの判断、回数、待機、再送はOpenRouter transport内に閉じる。agent loopへOpenRouter名、HTTP status、
  backoffなどのprovider固有知識を入れない。
- SSE開始前にHTTP 5xx responseを受けた場合だけ、最大2回retryする。最大physical request数は3回とする。
- retry待機は1回目500ms、2回目750msとする。
- 各attemptは同じserialized request body、transcript、toolsを使う。tool callやagent stepを再実行しない。
- 全attemptと待機は、既存の1つのprovider deadlineを共有する。Esc cancelは待機またはfetchを中断し、次の
  attemptを開始しない。
- 4xx（429を含む）、fetch前後のtransport error、timeout、response parse failure、SSE開始後のfailureは
  retryしない。`Retry-After`対応は429とともに将来必要性を判断する。
- retry exhausted時は既存と同じprovider request failureとしてturnを終了し、入力を復元する。
- retry中の新しいTUI表示は追加しない。footerは既存の`busy`表示を維持する。

## component境界

- OpenRouter transportはprovider固有のretry policyと各physical requestを所有する。
- agent loopは1回の`model.generate`を1つの論理model stepとして扱い続ける。provider固有のretry分岐を
  持たない。
- agent loopおよびfailure diagnosticでは、1つの論理stepに複数physical requestが属し得ることを表せる
  provider非依存のrequest count契約だけを一般化する。
- workerのphysical fetch counterは、現行どおり実際のfetch開始ごとに加算する。
- provider evidenceはattemptごとに独立したrequest recordを保存し、status、headers、raw responseを保持する。
  credential値とAuthorizationは保存しない。

## 対象外

- OpenAI direct providerとSonar `web_search`のretry
- provider/model fallbackとrouting変更
- SSE開始後のagent turn retry
- cancellation cleanup failureの修正またはcause保存
- `busy`への経過時間表示
- 構想、architecture、roadmap正本の変更

## 実装計画

1. OpenRouter failure contractのrequest countを非負整数へ一般化し、agent loopのfailure fact projectionも同じ
   provider非依存契約を受け取れるようにする。
2. OpenRouter transportで各attemptのevidence recordを開始し、HTTP 5xx bodyを記録・settleした後、共有deadline
   とcancelを尊重して500ms、750ms待機し再送する。
3. retry exhausted時のOpenRouter errorへその`generate`内の総physical request数を載せる。failure diagnosticの
   turn累計`providerRequestCount`は既存意味を維持し、`retryCount`は失敗した`generate`のattempt数から別に保存する。
4. 502後の成功、3回の502、同一request body、agent step・tool非再実行、backoff中cancel、4xxとSSE途中failureを
   retryしないことをfocused testで確認する。
5. 関連type check、format、lint、`git diff --check`を行い、安定候補でauthoritative `v0:gate`を一度実行する。

## Human Gate

production retained TUIでOpenRouter requestが一時的なSSE開始前HTTP 5xxになった場合に自動回復することを
実利用で確認する。自然発生を待つ必要があるため、再現可能なfocused testと保存evidenceを先に提示し、
productionで観測できた時点で利用者がIncrement完了を判断する。

## 実装結果

- OpenRouter transportがHTTP 5xx response bodyをevidenceへ保存した後、500ms、750msの順で最大2回retryする。
- retry後も同じserialized request bodyとmodel stepを維持し、agent loopはtoolとstepを再実行しない。
- OpenRouter transportは1つの既存deadlineとcancel signalを全attemptで共有し、backoff中のcancelは次のattemptを
  開始しない。
- OpenRouter failure factは`generate`内のphysical request数とprovider-owned retry数を明示する。agent loopは
  provider固有条件を持たず、その値をprovider非依存のfailure diagnosticへ投影するだけである。
- attemptごとに独立したprovider evidence request recordが作られ、HTTP status、response headers、raw response
  bodyを保持する。request header、credential値、Authorizationは記録しない。

## 検証結果

- focused provider stream compatibility test: 20件成功。
  - 502から2回目で成功し、同じbody、同じmodel step、tool call/result各1回を確認した。
  - 502が3回続く場合にrequest count 3、retry count 2、3 responseのraw evidenceを確認した。
  - backoff中cancelが2回目を開始しないことを確認した。
  - 429とSSE開始後のstream failureをretryしないことを確認した。
- 関連type check、format、lint、`git diff --check`は成功した。
- authoritative `v0:gate`は、最初の実行で既存Increment 13のexact failure-fact期待値に新しい
  `retryCount: 0`がなく1件失敗した。期待値を拡張済み契約へ合わせ、同focused test成功後に具体的理由をもって
  再実行し、type check、全体format、lint、全144 testが成功した。
