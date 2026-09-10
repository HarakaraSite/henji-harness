# 通常利用 increment 22 — production SSE継続とlimit正本化

ステータス: **完了**

対応architecture:
[`docs/architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)

## 利用者が必要とする動作

- production profileが許容する正常なOpenRouter SSE completionを、raw wire byte総量またはSSE event総数だけを
  理由に途中で拒否せず、terminal resultまでincrementalに処理する。
- assistant本文、planner result、Session、provider requestなど、既に合意されたsemanticまたは保存上の上限は
  維持する。
- 同じproduct上の上限を複数componentへ数値literalとして重複させず、共通の正本から参照する。
- raw response、SSE event、parser transition、provider metadataを、credential値とAuthorizationを含めず従来どおり
  完全に保存・readbackできる。

## 根拠と観測証拠

- 2026-09-10、`/home/masat.guest/src/forgejo-agent`のSession `2746203a`で、OpenRouter
  `deepseek/deepseek-v4-pro-0813` / `high`へForgejo API調査を依頼した。
- Turn 1は19 model steps、21 provider requestsまで進み、`web_search`を2回正常に完了した。21回目はHTTP 200
  だったが、terminal前にraw responseの固定1 MiB上限へ到達して`limit_exceeded`となった。
- 失敗requestの保存済みraw bodyは1,048,303 bytes、SSE eventは3,185件だった。assistant contentは6,695 bytes、
  reasoning textは5,208 bytesであり、semantic outputが1 MiBに達したのではない。各SSE chunkのJSON envelopeと
  metadataがraw byteの大部分を占めた。
- current production profileは`max_completion_tokens: 65_536`を送る一方、stream parserはraw responseを1 MiB、
  data eventを4,096件で停止する。実測上、raw上限を外しても同じcompletionが4,096-event上限へ達する可能性が
  高い。
- 過去の[`fixed-output-limit-expansion.md`](../plans/fixed-output-limit-expansion.md)はraw SSE 1 MiBを暫定維持し、
  それがsemantic本文より先に実効上限になり得ることを明記した。将来候補としてaggregate raw-response capを
  持たないincremental SSE処理も記録しており、今回その発生経路がproductionで確認された。
- `ProviderEvidenceRecorder.appendResponseBytes`はchunk受信ごとに、それまでの全raw bytesを再連結してtextと
  Base64を再生成する。1 MiBを超えてstreamingを継続するには、この二次的な反復copyを解消する必要がある。

## Product動作

### Streaming response

- OpenRouter SSEではaggregate raw-response byte上限とaggregate data-event件数上限を使わない。
- parserは各chunkをincrementalに処理し、既存のprovider deadline、cancellation、UTF-8、SSE framing、completion
  identity、choice、terminal、tool-call、usage validationを維持する。
- completed assistant textは既存の1 MiB semantic上限を維持する。tool argumentsとprovider reasoning stateも、
  terminal result、Session codec、provider request encoder等の既存contractを通る。
- non-streaming JSON responseはbody全体をbufferするため、streamingとは別名のbuffer上限を維持する。本incrementで
  JSON responseの上限値またはdecoder semanticsは変更しない。

### Evidence保持

- response受信中はraw chunkと累積byte数を保持し、chunkごとに全bodyを再構築しない。
- evidence snapshotまたは永続化時に、保持したchunkからexact raw bodyとBase64を一度だけ構築する。
- `rawBodyBytes`、各SSE eventの`responseBodyOffset`、raw frame、parsed event、parser transitionは従来と同じ意味と
  内容を維持する。credentialまたはrequest headerを新たに記録しない。

### Limitの正本

依存を持たない共通moduleを一つ設け、次の既存product decisionを正本化する。

| 共通limit | 現行値 | 共有する意味 |
| --- | ---: | --- |
| production OpenRouter completion | 65,536 tokens | root/plannerの通常profileとOpenRouter catalog既定値 |
| conversation text | 1 MiB UTF-8 | completed assistant text、saved/replayed message、planner answer、terminal JSON answer、Presentation/TUIの一message |
| planner result envelope | 2 MiB UTF-8 | planner delegation resultとそのreplay |
| serialized model messages | 5 MiB UTF-8 | provider encoderとcontext admission |
| complete model request | 6 MiB UTF-8 | provider transportとcontext admission |

各componentの既存export名が必要な場合は共通値へのaliasとし、数値literalを複製しない。次は意味が異なるため
共通値へ統合しない。

- context compactionのtrigger token数、summary、checkpoint、draft reserve
- Session file全体、restored display全体、Presentation event全体、TUI log全体
- steering、skill、read、bash output等の入力・tool固有上限
- failure diagnostic、provider evidence、execution artifact等の保存形式固有上限
- request timeout、agent step数、Session message件数等の非byte limit

同じ数値であっても目的が異なるlimitは別名・別所有のまま残す。

## 実装計画

1. import依存を持たない共通limit moduleを追加し、上表の5つを定義する。
2. core loop、provider profile/catalog/contract、planner delegation、terminal result、Session replay、Presentation、TUIが
   同じ意味で使っている既存constantを共通値へのaliasまたは直接参照へ変更する。数値とproduct動作は変えない。
3. OpenRouter SSE parserからaggregate raw byte判定とdata-event件数判定を外す。non-streaming body上限は用途が
   分かる名前へ変更してbuffered JSON pathだけで使う。
4. provider evidenceのraw response accumulationをincrementalなchunk保持へ変更し、snapshot時に一度だけexact
   text/Base64へmaterializeする。途中snapshotでも受信済み範囲を正確に返す。
5. 実測failureより大きい1 MiB超かつ4,096 events超の正常なSSE fixtureで、terminal result、assistant text、raw
   evidence、event数、offsetを確認する。semantic text上限、buffered JSON上限、timeout、tool loopの既存動作を
   対応するfocused regressionで確認する。
6. focused test、type check、format、lint、`git diff --check`と差分reviewを行い、stable candidateでauthoritative
   `v0:gate`を一回実行する。
7. 利用者がproduction retained TUIで同じForgejo API調査taskを再実行し、途中のraw limit failureなしに最終回答
   まで継続することをHuman Gateとして確認する。

## 成功条件

- 1 MiB raw bytesまたは4,096 eventsを超えることだけでは、正常なOpenRouter SSE completionを拒否しない。
- assistant semantic text等の既存product limitとmalformed response validationは変わらない。
- evidenceは1 byteも省略せず、受信済みraw bodyとSSE/parser情報をreadbackできる。
- 共通化対象のproduct limitに複数の数値literal正本が残らない。
- production再実行が最終回答まで完了する。

## 対象外

- assistant text、planner result、Session、provider requestの既存上限値変更
- non-streaming JSON response上限値の変更
- provider timeout、retry、fallback、model routing、agent step budgetの変更
- context compaction policyまたはtoken estimatorの変更
- evidence内容の省略、sanitization、rotation、削除、schema migration
- modelのtool選択、重複read、回答品質を制御するinstruction変更
- OpenAI Responses SDKのstream parser変更
- 構想、architecture、roadmap正本の変更

## 第三者review

- 2026-09-10、read-only reviewerが計画、current source、過去のlimit判断を照合し、計画承認へ進める`GO`、
  Blocker / P1 / P2なしと判定した。
- raw 1 MiBと4,096-event判定からproduction failureまでの経路、semantic text上限の独立性、evidenceの反復
  全body構築、共通化対象とcomponent固有limitの境界、planned testのproduct対応を確認した。
- 実装時は、buffered response上限をJSON成功応答だけでなくnon-2xxおよびunsupported-media bodyの既存readにも
  維持し、aggregate上限を外す範囲をSSE readerだけに限定する。
- 実装diff、追加test、機械検証、production再実行は実装前のため未確認である。

## 実装結果

- 依存を持たない`v0/resource_limits.ts`を追加し、計画した5つの共通limitを正本化した。既存componentの
  export名は必要な箇所でaliasとして維持した。
- OpenRouter SSE readerからaggregate raw-response byte上限とaggregate data-event件数上限を除去した。
  buffered responseには用途を示す`MAX_BUFFERED_RESPONSE_BYTES`を残し、JSON、non-2xx、unsupported-mediaの
  既存read経路を変更していない。
- provider evidenceは受信中にraw chunkと累積byte数だけを更新し、snapshotまたは永続化時に受信済みchunkを
  一度結合してraw textとBase64へmaterializeするよう変更した。
- assistant semantic text、planner result、Session replay、provider request、timeout、cancellation、SSE validation、
  tool continuationのcontractは維持した。

## 検証結果

- 1 MiB超かつ4,102 data eventsの正常なSSE fixtureがterminal resultへ到達し、4,100文字のassistant text、raw
  byte数、raw text、Base64、全event、累積offsetが一致した。
- 途中snapshotは、追加時点までのraw byte数、text、Base64を正確に返した。
- buffered responseの1 MiB上限とassistant semantic textの1 MiB上限が引き続き`limit_exceeded`になること、既存の
  provider timeoutとtool loopが成立することをfocused testで確認した。
- focused test、type check、format、lint、`git diff --check`は成功した。
- stable candidateに対するauthoritative `v0:gate`を2026-09-10に一回実行し、check、format、lint、全gate testが
  成功した。
- 構想、architecture、roadmapは本incrementの実装では変更していない。commit、pushも行っていない。

## Human Gate

利用者は2026-09-10に計画を承認し、local実装とauthoritative gateは完了した。production retained TUIで同じ
Forgejo API調査taskを再実行し、raw 1 MiBまたは4,096-eventによる途中failureなしに最終回答へ到達することを
確認する。これがIncrement 22の残るHuman Gateである。

利用者は同日、production retained TUIのSession `77e1f980`で同じForgejo API調査taskを再実行し、複数の
workspace readとweb searchを経て最終回答まで到達した。従来の`provider response limit exceeded`は再発せず、
Human Gateを通過したためIncrement 22を完了とした。
