# 通常利用 Increment 26 — Compaction provider failure diagnostic

ステータス: **完了**

## 利用者が必要とする動作

- automatic compaction中のprovider requestがtimeout等で失敗した場合も、そのprovider failure分類を
  failure diagnosticへ保持する。
- TUIはcompactionのprovider timeoutを、response不正やgeneric agent failureと区別し、既存の
  `provider deadline exceeded`として表示する。
- compactionはheld user turnのadmission前に行うため、失敗outcomeのturn-local request countは0のままとし、
  diagnosticとruntime/evidenceには実際に発生したcompaction requestを残す。

## 根拠

- 第三者によるcode・test全体reviewで、`WorkerGeneration.prepareCompaction()`のprovider exception catchが
  provider errorの`failureFact`を捨て、`unknown_stage` / `unknown_code`を記録する経路が確認された。
- focused in-memory再現では、`transport` / `provider_timeout`、request count 1のerrorが、diagnosticでは
  `unknown_stage` / `unknown_code`、request count 0へ劣化した。error text自体は
  `provider deadline exceeded`を保持していた。
- Increment 13は、deadline到達をtimeoutとして保持し、TUIでprovider response不正と区別することを要求する。
  同じrequest deadlineはroot、planner、context compactionへ適用される。

## 原因

- 通常agent loopはmodel errorのprovider-neutral `failureFact`を検証・投影し、stage、code、request count、
  retry count、HTTP status、parse reasonをdiagnostic ownerへ渡す。
- Workerのautomatic compaction経路は同じprojectionを使わず、exceptionを一律のunknown failureとして
  diagnostic ownerへ渡していた。
- compaction前はheld user turnがまだadmitされていないためturn-local counterは0であり、その値だけでは
  fetch後のtransport/HTTP/parse failureに必要な正のrequest countを表せない。

## Product動作

- model errorからprovider-neutral failure factを投影する処理を、通常turnとcompactionが共有する。
- compaction exceptionに有効なfailure factがある場合は、stage、code、retry count、任意のHTTP status・
  parse reasonをdiagnosticへ保持する。有効なfactがなければ既存のunknown fallbackを使う。
- compaction diagnosticの`providerRequestCount`は、当該compaction開始後のphysical request deltaとerror factの
  request countの大きい方を使い、実際のattemptを失わない。
- failure outcomeの`turnProviderRequestCount`は0を維持し、`runtimeProviderRequestCount`とprovider evidenceは
  compaction requestを含む既存境界を維持する。
- cancellationが同時に成立した場合は、既存どおりcancellationを優先し、新しいfailure diagnosticを作らない。

## 実装計画

1. 通常loop内のfailure fact projectionをprovider-neutral failure diagnostic moduleへ移し、通常turnと
   compactionから再利用する。
2. compaction failure recorderへmodel errorを渡し、有効なfactとcompaction physical request deltaから
   diagnosticを作る。generic fallback、cancellation、turn/runtime count境界は維持する。
3. Worker production経路を使うfocused testでcompaction timeoutを発生させ、diagnostic、outcome count、
   evidence phase、TUI failure reasonを一続きで確認する。
4. 関連type check、format、lint、`git diff --check`を行う。
5. 第三者reviewerがfindingの解消と変更箇所だけを15分以内でread-only re-reviewする。
6. stable candidateでauthoritative `v0:gate`を一度実行する。

## 成功条件

- compactionのprovider timeoutが`transport` / `provider_timeout`としてvalidなdiagnosticに残る。
- TUI failure reasonが`provider deadline exceeded`になる。
- diagnosticはcompactionのphysical attempt数を保持する。
- held user turnは開始されず、outcomeのturn-local request countは0、runtime countはcompaction requestを含む。
- 通常turnのfailure projection、automatic compaction成功、generic failure、cancellation挙動を変えない。

## 対象外

- compaction trigger、summary/checkpoint contract、provider timeout値、retry policy、Session schemaの変更
- user turn outcomeのrequest-count意味変更
- live provider、real-TTY、E2E
- 構想、architecture、roadmap正本の変更

## 承認

- 利用者は2026-09-10にIncrement 26として修正し、実装、test、第三者re-reviewまで進める計画を承認した。

## 実装結果

- `session/failure_diagnostic.ts`へprovider-neutralな`projectFailureDiagnosticFact()`を移し、通常turnと
  compactionが同じprojectionを使うようにした。
- compaction failure recorderはmodel errorを受け取り、投影済みstage、code、retry count、HTTP status、
  parse reasonをdiagnostic ownerへ渡すようにした。
- compaction diagnosticのrequest countはWorkerのphysical request deltaとerror factのrequest countを照合して
  保持する。outcomeのturn/runtime count境界とcancellation precedenceは変更していない。

## 検証結果

- Worker production経路のfocused suite 41件が成功した。追加testはcompaction timeoutが
  `transport` / `provider_timeout`、request count 1、model step 0のvalid diagnosticになることを
  確認した。
- 同testでfailure outcomeのturn-local count 0、runtime count 1、evidence phase `compaction`、
  diagnostic IDの相関、TUI failure reason `provider deadline exceeded`まで確認した。
- timeout表示5件、provider stream互換20件、通常loop 15件の関連focused testが成功した。
- 対象fileのtype check、format、lint、`git diff --check`が成功した。
- stable candidateでauthoritative `v0:gate`を1回実行し、type check、全体format、lint、
  既存144 testがすべて成功した。追加したWorker regression testは上記focused suiteで実行した。

## Review結果

- 元のP2を報告した同じ第三者reviewerが、変更箇所とfindingの解消だけを15分上限で
  read-only re-reviewした。
- reviewerはprovider failure factのdiagnosticへの保持、turn/runtime/diagnostic countの整合、
  cancellation precedence、追加testが実際の`WorkerGeneration.runTurn()` failure経路を通ることを
  確認した。
- 元のP2は解消済みと判定され、未解消のBlocker、P1、P2、P3はなかった。
- live provider、real TTY、第三者reviewerによるfull gate再実行は計画どおり対象外とした。
