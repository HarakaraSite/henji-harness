# 通常利用 increment 11 — ユーザー起動型production CLI基本E2E

ステータス: Gate 1およびGate 2完了。production CLI基本E2E受入成功

## 目的と利用者が必要とする動作

1. 利用者が明示的に指示した場合だけ、実credentialと実providerを使い、現在のproduction
   `agent:run`を入口から終了まで一回確認できる。
2. E2Eのtest subjectは実providerを使うHenjiのAIとし、AIが実workspaceの`read` toolを呼び、その結果から
   final responseを作る基本turnを実行する。
3. 起動を担当するAIまたは人間は、単にfinal textを見るだけでなく、Hostが保存したprovider evidenceと
   Worker execution artifactをreadbackし、同じ実行のprovider request、tool call/result、proposal、commit、
   acknowledgement、closeを機械判定できる。
4. 成功・失敗とも、一つのJSON reportから結果、request count、証拠ID、保持場所を確認できる。credential値と
   Authorizationはreport、child command、保存証拠へ入れない。
5. このlive E2Eをoffline `v0:gate`、通常CI、publish、releaseへ自動接続せず、live実行ごとに利用者の指示を
   必要とする。

## 現在の根拠

- increment 10でproduction非対話経路は
  `runtime_cli_launcher.sh` → `runtime_cli.ts` → `runHeadlessWorker` → `createWorkerSession` →
  `WorkerHostSession` → Deno Workerへ統一された。基本E2Eはこの経路をそのまま子processとして起動できる。
- production headless turnはSession transcriptを永続化しない一方、workspace別state rootへprovider evidenceと
  Worker execution artifactを保存する。E2Eは新しい観測経路をproductionへ追加せず、既存の正本を読む。
- provider evidenceはraw request/response、SSE、parser transition、model result、tool call/result、turn outcomeを
  持つ。execution artifactはDefinition revision、manifest、command、protocol trace、commit/ack/settlement、
  outcome、evidence IDを持つ。
- 現`agent:acceptance`はfixture toolと`runAgent`をCLI process内で直接使い、旧environment credential経路を
  通る。provider/loopの固定contract確認としては残せるが、increment 10後のproduction Host / Worker E2Eでは
  ない。
- production provider adapterは一request 30秒のtimeoutを持つ。normal root Definitionの上限は64 stepsであり、
  E2Eの期待request数2をproduct側のtest専用上限へ置換しない。orchestratorには子process全体のdeadlineを置き、
  実測request数は保存証拠から報告する。

## 採用する一件の基本シナリオ

orchestratorは一実行ごとにisolated run rootを`/tmp`へ作り、その配下にphysical workspaceとXDG state baseを
作る。workspaceの`e2e-input.txt`には、task本文へ含めないrun固有nonceを一行で保存する。

Henjiへ渡す固定taskの意味は次のとおりとする。実装時に完全な文字列をconstantとして固定する。

> `read` toolをちょうど一回使って`e2e-input.txt`を読み、tool resultを受け取った後、file本文だけを変更せず
> final responseとして返す。他のtoolを呼ばない。

期待する一turnは次の順序である。

```text
user / operator
  → agent:e2e:live --confirm-external-call
  → E2E orchestratorがisolated workspace/stateとnonce fileを作る
  → fixed taskをredirected stdinでproduction runtime_cli_launcher.shへ渡す
  → Hostがbuilt-in default Definitionをpre-readしてDeno Workerを起動
  → provider request 1 → AIがread toolを選ぶ
  → read(e2e-input.txt) → nonceを含むtool result
  → provider request 2 → AIがnonceだけをfinal responseにする
  → Worker proposal → Host memory commit → accepted acknowledgement → close
  → orchestratorがCLI channel、execution artifact、provider evidenceを照合
  → JSON report一件
```

この一件は、plain responseだけのsmokeよりも、system instruction/tool guideline、tool schema、providerの
tool-call response、workspace I/O、tool resultの次model stepへの入力、final responseを一度に確認できる。
`web_search`、planner delegation、TUI、persistent Sessionは基本シナリオへ含めない。

## commandと実行権限

新しいtaskを次の形で追加する。

```sh
deno task --config deno.v0.json agent:e2e:live --confirm-external-call
```

- 引数はexact `--confirm-external-call`一つだけを受理する。task、workspace、model、credential path、request数を
  caller optionにはしない。
- 人間自身がcommandを実行することは明示指示とみなす。Codex等のAIが実行する場合は、利用者からそのlive
  invocationへの明示指示を受けた後だけ実行する。初期実装承認はlive invocationを含まない。
- orchestrator processには`/tmp`のread/write、固定launcherを起動するためのsubprocess権限、保存証拠の
  ownerを検証する`uid`参照だけを与える。provider network、credential file read、credential environmentは
  orchestratorへ与えない。
- 子processは既存`runtime_cli_launcher.sh`をphysical workspaceから起動し、固定taskをredirected stdinで渡す。
  production CLIは非TTY入力をstdinから受理し、argv `--task`はTTY時だけ受理するため、この経路が既存contractに
  合致する。launcherが固定credential file、
  OpenRouter network、workspace/state、Deno 2.9.4のproduction権限を所有する。
- 子processへはisolated `XDG_STATE_HOME`と必要な固定`PATH`だけを渡す。credential値を親が読み、環境変数や
  command argumentで子へ渡す旧launcher方式は使わない。
- orchestratorのchild deadlineは120秒とし、deadline時はchildを停止して失敗reportを返す。自動retryは
  行わない。

## 実装構成

### 1. production E2E orchestrator

`v0/agent/validation/production_cli_e2e.ts`を追加し、次を所有させる。

- exact argument parsingと一件のrun ID / nonce生成。
- `/tmp/henji-production-e2e-*`配下のworkspace、XDG state base、nonce fileの作成。
- production launcher子processの起動、stdout/stderr、exit、deadlineの取得。
- `DenoWorkerExecutionArtifactStore`と`DenoProviderEvidenceStore`による保存証拠のreadback。
- 下記contractの評価とJSON report一件のstdout出力。orchestrator自身のexitはpassで0、failureで1。

child stdout/stderr、provider evidence、execution artifact、nonce fileはrun rootに保持する。E2E終了時にrun rootを
自動削除せず、reportにabsolute pathを返して、失敗原因と成功証拠を後から確認可能にする。

### 2. 成功判定

成功は次をすべて実測できた場合だけとする。

- child exit 0、stderr空、stdoutは末尾newline一つを持つnonce一件だけ。
- isolated stateにexecution artifactが一件あり、command task、built-in default Definition、production profileが
  今回の入力と一致する。
- artifactは`storeResult: committed`、`acknowledgement: accepted_sent`、`settlement: committed`、
  `outcome: final`で、steps 2、tool call/result各1、turn/runtime provider request count各2、final textがnonce。
- protocol traceにstart、module pre-read/import、ready、turn、effect observation、commit proposal、accepted
  acknowledgement、turn endが順序付きで存在する。
- artifactが指すprovider evidenceが一件あり、HTTP/SSE/parserの保存recordが二request分存在する。
- evidenceのruntime eventsが、一回目model result、`read` tool call、成功した同call IDの`read` tool result、
  二回目final model result、final turn outcomeを因果順に持つ。
- workspace/stateが今回のisolated run rootに対応し、Session transcript directoryは作成されていない。
- credentialまたはAuthorizationを表すheader/valueは、既存evidence schemaどおり保存対象になっていない。

modelが正常なprovider responseを返していても上記taskを完了しなければ、その時点のproduction E2Eはfailureと
する。ただし、これだけで実装bugと断定せず、保存されたraw response、parser transition、tool event、artifactを
利用者または実行担当AIが読んで原因を分類する。

### 3. report contract

成功reportは少なくとも次を持つ。

- `schemaVersion`、`taskId`、production profile ID、`ok: true`、`outcome: passed`
- `runRoot`、`workspaceRoot`、`stateRoot`
- `executionId`、`providerEvidenceId`
- `externalRequests: 2`、`steps: 2`、`toolOrder: ["read"]`、`stopReason: final`
- `retryCount: 0`

失敗reportは同じrun identityと保持pathに加え、確認できた範囲のchild exit、request count、execution/evidence ID、
失敗stage/codeを持つ。自由文だけへ潰さず、`preflight`、`process`、`cli_contract`、`execution_artifact`、
`provider_evidence`、`model_behavior`のどこで不一致になったかを区別する。child stdout/stderrの全文とprovider raw
responseはrun rootの証拠に保持し、report本文へ重複させない。

### 4. taskと文書

- `deno.v0.json`へlive taskとprovider-free focused test taskを追加する。
- provider-free testだけを`v0:test`へ一回組み込み、`v0:gate`からlive taskへ到達しないことを確認する。
- `v0/agent/README.md`の`validation/`へproduction CLI E2E orchestratorを記録する。
- `docs/operations/openrouter-credential.md`へ、E2Eもproduction Workerのrequest-time credential sourceを使うこと、
  live実行は別の利用者指示を必要とすることを記録する。
- 実装・offline検証・review後に本書へ結果を追記し、handoffをlive Human Gate待ちへ更新する。

## 既存`agent:acceptance`の扱い

- このincrementでは削除、rename、production Host / Worker移行をしない。
- `real_provider_acceptance.ts`はdirect provider/loop fixture acceptanceという既存の役割で残し、新しい
  `agent:e2e:live`をproduction CLI E2Eの正本とする。
- 実E2Eが一度成功し、両者の用途を利用経験から比較した後に、旧taskを残すか整理するかを別途判断する。

## provider-free検証

live実行前の実装検証では、orchestratorへprocess/store seamを注入して次のproduct contractを確認する。

- exact confirmation argumentだけが一childを起動し、workspace/state/task/env/cwdをproduction launcher向けに
  構成する。
- success child channelと対応するartifact/evidenceからpass reportを作る。
- child failure、channel mismatch、artifact/evidence mismatchをfailure reportへ分類し、run rootを保持する。
- live taskが`v0:test` / `v0:gate`から到達不能で、offline focused testはprovider network、credential file、
  `runtime_cli_launcher.sh`実行を行わない。
- focused test、`v0:check`、format、lint、`git diff --check`を実行する。implementation review後のstable
  candidateに対し、authoritative offline `v0:gate`をcoordinating ownerが一回だけ実行する。

offline fixtureの件数、fake provider成功、review、gateは実provider E2Eの代替にしない。

## Human Gates

### Gate 1 — 初期実装承認

この計画への利用者承認後、orchestrator、task、provider-free test、文書、review、authoritative offline gateまでを
実施できる。provider network接続、credential内容のread、production E2E invocation、commit、push、publish、
tag、releaseは含まない。

### Gate 2 — live E2E一回の実行

実装・offline検証・reviewがGOになった後、exact command、固定task、current production profile、期待request数2、
child deadline 120秒、証拠保持pathの方針をreadbackし、利用者が実行を明示した場合だけ一回実行する。その指示は
一回分であり、failure時の再実行、別task、別model、追加scenarioを含まない。

実行後はJSON reportと保存証拠を照合し、観測事実、pass/failure、実request数、実行pathを本書とhandoffへ記録する。
provider/modelの応答が計画の期待と異なった場合、raw evidenceを確認してから、実装修正、prompt修正、再実行、
受入のどれを行うか利用者へ返す。

## 対象外

- TUI/real TTY E2E、persistent Session、cancel、steering、follow-up、history、context compaction。
- `web_search`、planner delegation、write/edit/bash/bash_outputを含む複数scenarioまたはmatrix。
- provider/model/profile、tool、Definition、retry/fallback、normal `agent:run` grammarの変更。
- provider品質の統計評価、反復実行、flake率測定、benchmark、load test。
- CI secret登録、scheduled E2E、release gateへの自動接続。
- credentialの作成、変更、copy、表示、rotation。
- E2E run rootの自動cleanup command。
- 旧`agent:acceptance`、live corpus、sentinelの整理。

## Gate 1実装結果

2026-09-08に利用者がGate 1を承認し、次を実装した。

- `production_cli_e2e.ts`がisolated run root、nonce file、production launcher子process、120秒
  deadline、child channel保存、artifact/evidence readback、JSON reportを所有する。
- `production_cli_e2e_contract.ts`へ固定task、report contract、production profile・execution
  artifact・provider evidence・runtime eventの機械判定を分離した。
- `agent:e2e:live`は親orchestratorに`/tmp` read/write、固定launcherのrun、`uid`だけを許可する。
  `agent:e2e:test`はrun/network/environment credential権限を持たず、live taskを実行しない。
- `v0:test`にはprovider-free focused testだけを追加した。既存`agent:acceptance`は変更していない。

実装reviewでは、初期計画の`runtime_cli_launcher.sh --task <fixed task>`がproduction CLIの実contractと
一致しないことを検出した。現`runtime_cli.ts`はargv `--task`をTTY時だけ受理し、非TTY子processではredirected
stdinを正規入口とする。そこで、外部command、固定task、provider request数、成功条件を変えず、子processの
stdinへ固定task一件を渡すよう修正した。再reviewではBlocker/P1/P2 findingなしとした。

検証結果:

- focused check、lint、format、`git diff --check`: 成功。
- `agent:e2e:test`: 5件成功。exact confirmation、固定子process構成、pass report、child/channel/artifact/
  evidence/model failure分類、retained evidence path、live taskのoffline gate非到達を確認した。
- authoritative offline `v0:gate`: 2026-09-08に一回実行して成功。check、176 filesのformat、174 filesの
  lint、合計95 testsが成功した。
- `agent:e2e:live`、provider network、credential file readは実行していない。

Gate 1の結論はGO。次のhuman gateは、本書Gate 2に定義したproduction profile、固定task、期待2 request、
120秒deadline、run root保持をreadbackした後の、一回のlive invocation承認である。

## Gate 2実行結果

2026-09-08に利用者がreadback済み条件で一回のlive invocationを承認し、次のexact commandを一回実行した。

```sh
deno task --config deno.v0.json agent:e2e:live --confirm-external-call
```

JSON reportは`ok: true`、`outcome: passed`を返した。自動または手動retryは行っていない。

- profile: `openrouter-google-gemini-3.7-flash-vertex-v0`
- execution ID: `bf75b812-9e84-4f53-8224-3790609f0bf1`
- provider evidence ID: `d72d6211-7e99-49f3-a4dd-c8b4f3728f12`
- 実provider request: 2。両方がOpenRouter chat completions endpointへのparent/user-turn SSE requestで、
  HTTP 200。request 1は6 SSE events / 8 parser transitions、request 2は7 SSE events / 9 parser
  transitionsを保持した。
- runtime causality: step 1 model tool-calls → `read` call一件 → 同call IDのsuccessful `read` result →
  step 2 final model result → final turn outcome。
- Worker artifact: built-in default Definition、parent role、maxSteps 64、steps 2、tool call/result各1、
  request count 2、`committed` / `accepted_sent` / `committed` / `final`。
- protocol trace: start、module pre-read/import、ready、turn、tool call/result effects、commit proposal、accepted
  acknowledgement、turn endを順序付きで保持した。
- child exit 0、stderr空、stdoutはnonce一件、Session transcript directoryなし。
- retained run root: `/tmp/henji-production-e2e-fb8d2583c1a48eee`

orchestratorはcredentialを受け取らず、production Workerが固定credential fileをrequest時に使用した。credential値、
Authorizationは表示しておらず、request evidence schemaにも保存されていない。Gate 2の結論はGOとし、increment 11を
完了する。
