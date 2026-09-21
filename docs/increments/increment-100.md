# Increment 100 — provider request deadlineが実streamで発火しない問題の調査と修正

ステータス: **実装・検証完了**

計画日: 2026-09-21

関連: Increment 85（provider deadline 180s）、Increment 86（journaling非ブロッキング化）、
Increment 92（stall原因＝exact capture契約違反）、Increment 99（`henji history` CLI）、
[`architecture/henji-host-agent-worker.md`](../architecture/henji-host-agent-worker.md)。

## 利用者が必要とする動作

- provider requestは指定deadlineを超えたら`provider_timeout`でabortし、turnをnon-canonicalにsettleする。
  （deadlineを維持するか、遅いreasoningを許容するかは利用者判断。下記「決定待ち」。）
- 長い/停止したprovider requestでturnが無制限に続かない。
- 上記は実経路（production TUI、実provider）で確認できる。

## 事象（2026-09-21、session `e8e99332` turn 6）

- execution `81060ca6` は`10:12:45.320Z`に開始。root provider request（`openrouter-responses`、
  `POST https://openrouter.ai/api/v1/responses`、modelStep 1）が`10:12:45.350Z`にstart。
- 以降`model_result`なし。`10:24:19.730Z`にユーザーの`cancel_requested`（Esc）、workerが応答しないため
  `10:24:24.734Z`に`cancel_escalated`（terminate）、`10:24:24.738Z`に`execution_reconciled`
  （settlement `interrupted`、non_canonical）。
- provider requestは**約690秒**in flightで、**180秒のprovider deadlineが発火しなかった**。

## 実行証拠（2026-09-21、curl実測）

同じprompt/transcriptを`https://openrouter.ai/api/v1/responses`へ直接送信。

| model | 実測 |
| --- | --- |
| `deepseek/deepseek-v4.1-flash`（promptのみ） | 43.8s / 84.1s / 126.4s / 206.8s |
| `deepseek/deepseek-v4.1-flash`（transcript全体） | 154.8s / 220.1s / **>900s（timeout、stream中）** |
| `openai/gpt-5.6-luna`（transcript全体） | 48.9s / 58.3s |

- providerは遅く、ばらつきが大きく、15分超もあり得る。よってturnの長さ自体はprovider由来。
- 一方、Henjiのdeadline機構はローカルの無限SSEで`timeoutMs`通りに`provider_timeout`へabortすることを
  確認済み（`OpenRouterResponsesModel`に`timeoutMs: 2000`で`2004ms`、`providerExactRequestObserver`付きでも
  `2005ms`）。`evidenceFetch`もsignalを実fetchへ渡している。
- したがって「実provider streamで180秒deadlineが発火しない」はproviderの遅さとは別のHenji側事象。

## 原因（ローカル再現で確定）

**macrotask timerのstarvation**。`ResponsesApiModel.generate`は`setTimeout`でdeadlineを実装しているが、
providerが**途切れなくstream**すると`for await (const event of stream)`のloopがmicrotaskで回り続け、
macrotaskである`setTimeout`が発火しない。ローカルの連続SSE burst（gapなし）に対し`timeoutMs: 1000`でも
15秒abortしないことを再現した。既存のローカルSSEテストが200ms間隔だったため、loopがpending promiseを
awaitしてmacrotaskへyieldし、timerが発火していた（再現しなかった）。

## 決定（利用者判断）

product動作は **B: total deadline（既定180秒）を維持し、確実に発火させる**。

## 修正

- `v0/agent/provider/openai_responses_model.ts`（`ResponsesApiModel.generate`）: `startedAt`を記録し、
  `for await`loopの各eventで`Date.now() - startedAt >= timeoutMs`を判定して`controller.abort()`＋
  `provider_timeout`をthrowする。timer starvationに依存しない。
- `v0/agent/provider/openrouter_transport.ts`（chat経路）: 同じ脆弱性があるため、`deadlineExceeded`
  （`timedOut || Date.now() - startedAt >= timeoutMs`）を`readSseResponse`のtimeout predicateへ渡す。
- `v0/agent/provider/openrouter_sse.ts`（`readSseResponse`）: 成功chunkごとに`isTimedOut()`を判定する
  checkをloop先頭へ追加（従来はエラー/完了時にしか判定していなかった）。
- timerはno-data（streamが止まる）場合のために維持する。

## 同種箇所の監査

「JSのloopが連続streamをmicrotaskで処理し、macrotask timerをstarveする」パターンをprovider/tool/Hostで確認した。

- 修正済み: Responses（`openai_responses_model.ts`）、chat（`readSseResponse`／`openrouter_transport.ts`）。
- 影響なし:
  - `auxiliary_request.ts`: `response.arrayBuffer()`（JS stream loopなし。native readでevent loopは空く）。
  - `web_fetch`（`readBoundedBody`）: `MAX_WEB_FETCH_BYTES`で有界。drip時は`await reader.read()`でyieldする。
  - `bash`／`bash_output`: subprocess待ち。
  - Host側timer（`worker_host_session`のobservation flush／settlement deadline、`worker_capsule`の起動timeout、
    `worker_host_queue`のwaiter）: postMessageイベント（macrotask）駆動で、provider streamのmicrotask loopとは別。
- 監査範囲はprovider/tool/Hostのproduction path。`v0/agent/validation/`のlauncherは対象外。

## 検証

- focused test `tests/v0/increment_100_provider_deadline_test.ts`（3件、`v0:test`追加）:
  - Responsesの連続stream（gapなし）で`timeoutMs: 500`が約500msで`provider_timeout`になること。
  - chat（`readSseResponse`）の連続streamでも同様に`provider_timeout`になること。
  - streamが停止（dataなし）でもtimerで`provider_timeout`になること。
- `agent:provider-stream-compatibility:test` 20件、`deno check`、`deno fmt --check`、`deno lint`、
  `git diff --check`は成功。
- 実provider確認は未実施（本修正はoffline再現で確認。実providerでの確認は承認が必要）。

## 対象外

- providerのreasoning時間そのもの（model特性）。
- Increment 99の`henji history` CLI。

## 未確認事項

- Worker/Deno runtimeでtimerがstarvationするか（計装で確認）。
- 実fetchのabort伝播（計装で確認）。
- Increment 92のstallとの関連（別原因か再発か）。
