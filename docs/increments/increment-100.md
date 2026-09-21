# Increment 100 — provider request deadlineが実streamで発火しない問題の調査と修正

ステータス: **計画（利用者承認待ち）**

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

## 原因仮説（未確定）

1. **Workerのdeadline timer starvation**: provider観測の処理/送信でWorkerのイベントループが塞がり、
   `setTimeout`が発火しない。
2. **abortの伝播不全**: 実fetch/undiciのstreaming body abortが本番pathで効かない（ローカルHTTPでは再現せず）。
3. **別のstall**: Increment 92と同型の停止（契約違反等）が再発している。

原因は推測で確定せず、計装と実provider再現で特定する。

## 調査計画

1. **計装**: `ResponsesApiModel.generate`周辺に、deadline timer設定時刻、timer発火時刻、`controller.abort()`
   呼出、streamの初回/最終chunk受信時刻、chunk間隔、`for await`終了理由を記録する。`diagnostic-v1`の
   attachment（または明示diagnostic）として保存し、readback可能にする。credential値は記録しない。
2. **再現**: 遅いmodel（例: `deepseek/deepseek-v4.1-flash`、`effort:high`）で長いstreamを発生させ、
   `diagnostic-v1`で上記計装を取得する。実provider callは対象・回数・保存先を提示して利用者承認を得る。
3. **Host側の時系列**: `cancel_requested`／escalation／settlementの時刻と、`appendExecutionEvents`の
   処理時間も併せて記録し、Hostの同期SQLiteがWorkerへ与える影響を確認する。
4. **原因確定後**: 下記Fix候補から選択し、product動作を確定する。

## Fix候補（原因確定後）

- A. **stream loop内でelapsed/no-progressを判定**し、timer starvationに依存しない。
- B. **no-progress（idle）timeout**: 最終chunkからの経過でabort。長いreasoningを許容しつつ停止を検出。
- C. **total deadlineの維持**（180sで必ずabort）を確実にする。
- D. deadlineを延ばす/無効化し、Esc cancelを主手段にする。

## 決定待ち（利用者判断）

- product動作: 長いreasoningを許容するか。許容するならno-progress timeout（B）を主にし、total deadlineを
  どうするか。許容しないならtotal deadline（C）を確実に発火させる。
- 既定値: no-progressの閾値、total deadlineの値。

## 対象外

- providerのreasoning時間そのもの（model特性）。
- Increment 99の`henji history` CLI。

## 未確認事項

- Worker/Deno runtimeでtimerがstarvationするか（計装で確認）。
- 実fetchのabort伝播（計装で確認）。
- Increment 92のstallとの関連（別原因か再発か）。
