# Pre-alpha raw response validation 実装・検証計画

> Status: proposed at Human Gate 2
> Canonical input: `/tmp/planner-inputs/trusted-local-deno-vertical-slice.md`
> Concept revision: 7
> Scope: H-014の一回のexternal responseをparse前に保持し、本人へ表示する最小変更

## 推奨計画と前提

`v0/cli/main.ts`の既存`acceptance run`結果組み立てだけを変更し、extensionから返った
`payload.planText`をparse前に`responseText`として保持する。その同じ文字列と、既存
`parseModelPlan`のresultまたはerror、既存の`hostCalls`、`durationMs`、`outcome`を一つのterminal
JSONへ出す。strict parseが失敗してもterminal JSONを出してから非zero終了し、response内容を本人の
評価前に失わない。

`v0/model.ts`、`v0/runner.ts`、bundled extension、state/attempt、trace schemaは変更しない。既存の
一command、一host model call、application retry 0、30秒HTTP timeout、1 MiB response上限、
trusted-local/no-tool境界をそのまま利用する。raw provider HTTP envelopeではなく、host codecが抽出して
extensionへ渡したassistant textを「内容を損なわないrepresentation」として表示する。Authorization
header、credential、provider response headersはこの経路へ入らない。

局所的で可逆的な実装上の仮定は、field名を`responseText`、`parse`、`requestCount`、`durationMs`、
`outcome`相当とすることだけである。命名と小さなobject配置は、全観測項目が一つのJSONにあり、
response textが改変されなければ実装者が調整できる。新しいerror codeや汎用result abstractionは作らない。

## 確認済みの現在状態

- `v0/model.ts`の`openRouterModel`はboundedなprovider bodyからassistant contentをstringとして返し、
  credentialやheaderを返さない。HTTP timeout、1 MiB response上限、retry 0のprofileは既存実装にある。
- `v0/runner.ts`は一runの`host.model.generate`をexactly oneに制限し、`hostCalls`と`durationMs`を返す。
- bundled task-plannerはmodel textを`payload.planText`としてhostへ返す。
- `v0/cli/main.ts`は`planText`を受け取った後にstrict parseし、parse error時は`fail(plan)`でerrorだけを
  出す。この境界が、到達済みresponseを本人へ示せない現在差分である。
- traceにはduration、hostCalls、result digest、parse outcomeが既にある。response本文をtraceへ追加する
  必要はない。

## Implementation slice 1: parse前responseのterminal readback

### 成果

一回の`run`または`acceptance run`でmodel response textまで到達した場合、CLIは次を同じJSONで本人へ示す。

- `requestCount`（既存`result.hostCalls`）と`durationMs`
- response textを一字も作り替えないrepresentation
- strict parseの成功result、または既存code/messageのparse error
- 既存traceと同じfinal outcome

既存の組み立て上で自然に含まれる場合は`runId`を維持できるが、新しい必須観測にはしない。task、context、
constraints、active extension identity、host profileをこの変更のためにterminal JSONへ追加しない。

parse成功時は従来どおりexit 0、parse失敗時はJSONを表示した後にexit 1とする。attemptの
`succeeded`/`failed`判定とtrace保存は従来のparse outcomeを使い、raw textをstateやtraceへ新たに永続化しない。

### 変更対象

- `v0/cli/main.ts`: `planText`をparseより前に局所変数へ保持し、成功・parse失敗の両方を同じbounded
  readback shapeで出力する。model/transport failureでresponse textが存在しない既存経路は、既存のsanitized
  errorを維持する。
- `tests/v0/v0_test.ts`: 下記の直接testだけを追加または既存testへ統合する。

### このstepが必要な理由

H-014で未観測なのは外部経路やstrict parserの存在ではなく、既に返ったassistant textの本人価値である。
parse直前の既存CLI境界でtextを保持して表示すれば、この未観測点だけを解消でき、provider、runner、extension、
state、traceを広げずに済む。

### 直接test（3件）

1. 既存のCLI offline run testでterminal JSONを捕捉し、fixtureのexact response text、parse成功result、
   request count `1`、duration、outcomeが同居することを確認する。
   - 必要理由: 新しいreadbackが通常の成功経路を壊さず、H-014の最小観測を一commandで満たす直接証拠になる。
2. temporary trusted-local test extensionで一回だけhost model callを行い、返答とは別のnon-Plan textを
   `planText`として返す。CLIがそのexact textと既存parse errorを同時に表示し、exit 1、request count `1`、
   duration、outcomeを確認する。providerは呼ばない。
   - 必要理由: acceptance 3と同じfailure modeでresponseがparse failureにより消えないことを直接証明する。
3. 既存のlocal HTTP redaction testとrunner exactly-one-call testを維持し、変更後のterminal objectを
   serializationしてもdummy credential、Authorization header、追加requestが現れないことを、変更箇所に
   最も近いassertionとして一件だけ追加する。
   - 必要理由: raw text表示の追加が、H-014の明示的な停止条件であるcredential露出や複数requestを伴わない
     ことを確認する。timeout/response上限testは既存の異なるfailure modeを既に覆うため重複追加しない。

### Local verification

実装承認後、provider credentialを設定せず、providerへ接続しない状態で次を実行する。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --config deno.v0.json v0:gate
```

23 tests全体の再設計やtest数の増加自体を合格条件にしない。上記direct assertionsと既存gateが通り、
外部通信が0であることをlocal完了条件とする。

## Manual acceptance（別承認後のみ）

前提は、実装とlocal gateが完了し、本人が新しいattempt ID、最大1 request、最大USD 0.064を別途authorize済みで
あること。この計画とHuman Gate 2はattempt作成、credential変更、external call、再試行を承認しない。

本人は既存のactive trusted-local revisionとstate directoryを使い、既存のscoped production invocationを
変更せず、次の`acceptance run`引数を付けた一commandを一度だけ実行する。production invocationのpermissionは、
exact Deno executable、既存state/source path、`HENJI_OPENROUTER_API_KEY`、`openrouter.ai`へ限定された現行値を
再利用し、このsliceで`--allow-read`や`--allow-write`を無制限化しない。

```sh
<existing scoped production invocation> v0/cli/main.ts acceptance run --attempt-id <separately-authorized-new-id> --task '<one side-effect-free task>' --constraints '["no tools","no filesystem changes","no external writes"]' --confirm-external-call --state-dir <existing-state-dir>
```

本人がterminal JSONで、`requestCount: 1`、duration、final outcome、exact response text、parse resultまたは
parse error、credential/header不在を読む。parse成否にかかわらずresponse内容を実際の作業の
出発点として使えるかを本人だけがGO/NO-GO判断する。同じattempt IDで再実行しない。

このacceptanceが必要な理由は、local fixture/testではresponse保持は検証できても、H-014の「本人にとって使う
価値があるか」は本人が一つのreal responseを読むまで観測できないためである。

## 停止条件

- response textがparse前に保持できない、またはparse failure時にterminalへ出せない場合は実装を止める。
- 変更に`v0/model.ts`、`v0/runner.ts`、extension protocol、state/attempt、trace schemaの拡張が必要になった
  場合はscopeを広げずplan-deltaとしてHuman Gateへ戻す。
- 一runでrequest countが1でない、application retryが入る、credential/headerがoutputへ現れる、task外の
  副作用が生じる、timeout/response上限が失われる疑いがあればexternal acceptanceを止める。
- 接続設定または一時的provider errorでresponseへ到達しない場合、H-014の価値NO-GOにせずraw sanitized errorを
  残して停止する。再試行は別のhuman decisionと新attemptを要する。

差分がcredential露出、複数request/無限retry、副作用、timeout/response上限喪失のいずれかを新たに可能にする
疑いがある場合だけ、該当差分とriskに限定した5分reviewを行う。それ以外の独立review stepは追加しない。

## 対象外とdeferred risk

- provider/model/token/price/budgetの一般化またはprofile変更
- strict JSON成功必須、schema repair policy、new error taxonomy、汎用result/trace abstraction
- process/permissionの再証明、atomic state、lock、crash recovery、install/activate/switch/rollback
- raw provider HTTP envelope、header、credentialの表示または永続化、broad trace/digest追加
- Spike 0/1再利用、Spike 2修復、旧`src/`・`plugins/`・`tests/`の変更、`_refs/`利用
- tool実行、filesystem/shell/external service writeを行うtask、streaming、retry、subagent

## 完了条件とHuman Gate 2

計画段階の成果は本書一件だけである。Human Gate 2で利用者が本計画を承認、修正、保留、または終了するまで、
実装、test、review、attempt、provider call、acceptanceを開始しない。承認後のimplementation slice完了は、
上記direct testsとlocal gateが通り、本人が別承認したmanual acceptanceでraw responseとparse結果/errorを同時に
読める状態までとする。H-014のGO/NO-GOは本人のresponse価値判断であり、実装者やplannerが代行しない。
