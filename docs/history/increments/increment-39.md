# Increment 39 — cancellation stream settlement

ステータス: **完了**

基準commit: `e789b75c`（Increment 38の未commit差分上で実装）

対象機能: F02、F05、F10

## 利用者が必要とする動作

- production TUIでOpenRouter responseのstreaming中にEscを押すと、既に受信したtool resultやprogressを保持したまま
  turnが`cancelled`、`uncommitted`として確定し、`cancellation cleanup failed`へ誤分類されない。
- 通常のcancel settlement後は同じWorker Sessionを次turnへ再利用できる。
- active resourceを本当にcleanupできなかった場合は`cancellation_cleanup / cleanup_error`を維持し、そのWorkerを
  readyな再利用可能状態へ戻さない。

## 根拠と確認済みの原因

- Increment 38のreal-TTY受入では、3回目のOpenRouter requestが21件のSSE eventを受信した後、terminal/parser failureなしで
  Esc cancelされた。turnは`contract_failure: cancellation cleanup failed`になり、diagnostic
  `e08a9e5b-a4ef-4177-9bc6-5dd3d68d968d`を保存した。
- Deno 2.9.4の実行確認では、erroredな`ReadableStream`に対して`reader.read()`と、その後の`reader.cancel()`が同じ
  `AbortError`をrejectし、`reader.releaseLock()`は成功した。現行`readSseResponse`はread rejection後にもcancelを要求し、
  そのrejectを新しいcleanup failureと扱うため、既にterminal errorへ到達したstreamを誤分類する。
- parser/framer failureなどreaderがまだactiveな段階で早期終了する場合は、明示的なreader cancelと、そのcleanup成否の確認が
  引き続き必要である。
- 現行Worker Hostは`turn_failed`のcleanup diagnosticを通常のrecoverable contract failureと同様に扱い、generationを
  利用不能にしない。真のcleanup failureに対する従来のfatal contractと一致していない。

## 実装計画

1. OpenRouter SSEとbounded response readerで、`reader.read()` rejectionをstreamのterminal errorとして分類し、二重cancelを
   行わない。turn cancel、timeout、provider stream failureの既存優先順位を保持する。
2. parser/framer/size-limit等でactive readerを途中終了するときのexplicit cancelは維持し、そのcancelまたはlock releaseが
   失敗した場合だけcleanup failureとして扱う。
3. Worker Hostが`cancellation_cleanup / cleanup_error`を受けた場合、evidence・diagnostic・execution artifactを保存してから
   generationを利用不能にする。TUIはrecoverable readyへ戻さずfatal settlementとして終了する。
4. Denoのabort-error stream、通常cancel後のWorker再利用、真のcleanup failureの保持とWorker再利用拒否をfocused testで確認する。
5. 対象type check、format、lint、`git diff --check`後、stable candidateへauthoritative `v0:gate`を一回だけ実行する。
6. isolated XDG rootのstandalone binaryとreal TTY/OpenRouterで、Esc cancelが`cancelled`になり、同じSessionの次turnが成功することを
   確認する。差分review、通常利用メモ、increment結果、handoffを更新する。

## 完了条件

- 実測と同じabort後read rejectionが`cancelled`になり、cleanup diagnosticを生成しない。
- cancelled sourceはuncommittedで、同じWorker Sessionが次turnを処理できる。
- active readerの真のcleanup failureはcontract failureのまま保存され、Worker Sessionは再利用できない。
- focused確認、一回のauthoritative `v0:gate`、production retained-TUI Human Gate、差分reviewが完了する。

## 対象外

- cancellation UX、`/recall` contract、canonical transcript、provider timeout、retry policyの変更。
- architecture、roadmap、構想、installed binary、commit、push、tag、publish、releaseの変更。

## 承認

- 利用者は2026-09-12にこの計画を承認した。

## 実装結果

- SSEとbounded responseの`reader.read()` rejectionは、streamが既にerrored terminal stateへ到達したことを
  示すものとして分類する。この経路で二度目の`reader.cancel()`を行わず、Escは通常の
  `TurnCancelledError`へsettleする。
- parser/framer failureやresponse size limitなど、active readerを途中終了する経路のexplicit cancelは維持した。
  active resourceのcancelまたはlock releaseが実際に失敗した場合は従来どおりcleanup failureになる。
- Worker Hostは`cancellation_cleanup / cleanup_error`のdiagnostic、provider evidence、uncommitted execution artifactを
  保存した後にgenerationを終了し、Sessionをunavailableにする。TUIもそのSessionをrecoverable readyとして
  再利用しない。

## Verification

- Deno 2.9.4で実際のabort-error `ReadableStream`を使うfocused test、active-reader cleanup failure、bounded body
  read rejection、Worker Hostのartifact保存後のunavailable化を確認し、Increment 39の4件が成功した。
- retained TUI 30件、provider stream compatibility 20件、timeout 5件、Worker foundation 39件、Increment 38
  recall 6件の関連regressionが成功した。`v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`も成功した。
- stable candidateに対するauthoritative `v0:gate`は計画どおり一回だけ実行し、192 testすべてが成功した。

## Production Human Gate

- 未commit差分からbuild ID
  `27a97e17b75d29ba8dba75c298b279758e0534fdde6d2b9e60d7bab19368318f`のstand-alone binaryを作り、isolated
  XDG state/data rootのreal TTYでOpenRouter `deepseek/deepseek-v4.1-flash`を使用した。installed binaryは変更していない。
- session `39decf73-bb82-425a-9d93-807497eb306f`のprovider streaming中にEscを押し、TUIが`failure> cancelled`と
  `recovered input; edit or resubmit`へ遷移することを確認した。`cancellation cleanup failed`は表示されなかった。
- cancelled execution `ba5ea084-9090-4c3f-b5d2-2560044ec77f`はturn 1の`uncommitted`、outcome
  `cancelled`であり、diagnosticは通常cancelを示す`turn_control / turn_cancelled`のみだった。
- 同じWorker Sessionの次taskは「再開成功」と応答し、execution
  `92949fea-35a5-4eaf-bc3f-2a330a5d3230`がturn 1の`committed`になった。canonical transcriptは成功した
  user/assistantの2 messageだけである。
- 一時binaryと状態は`/tmp/henji-increment-39-acceptance-xA5Jxs`に保持した。

## Review結果

- 明示要件、Deno/OpenRouterのproduction経路、変更差分、保存artifactを照合し、Blockerまたは
  correctness findingは見つからなかった。
- terminal read rejectionとactive-resource cleanup failureの境界、cancelled sourceのno-commit、次turnのatomic commit、
  cleanup failure時のHost/TUI unavailable contractをそれぞれ独立に確認した。
