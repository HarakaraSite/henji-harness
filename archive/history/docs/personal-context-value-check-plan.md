# H-018 personal context value check execution and evidence plan

## 推奨計画と前提

このsliceではsource、test、configuration、dependencyを変更せず、現行の`basic run`を二回だけ使う。
Run Aはcontextなし、Run Bは承認済みのexact contextありとし、同じtask、provider、model、system
instruction、constraints、generation/output/time limitsのままA→採点→Bの順で実行する。各runは別process、
一request、application retry 0であり、responseはterminal上のpassive raw textとしてだけ扱う。

H-018の判断は一組の本人A/Bに限定する。model varianceと順序効果を除去したcausal proofやbenchmarkとは
扱わない。rubric、anchor、分類規則は本書でprovider call前に固定し、実行時に変更しない。

可逆的な実行上の仮定は次のとおりである。

- 両runで`--constraints`を省略し、現行interfaceが生成する同一の空配列`[]`を使う。
- taskとcontextは非secretなのでsingle-quoted shell argumentで渡す。shell substitution、file input、profile、
  history、memory、workspace readは使わない。
- provider-call gateだけは、確認済みのhost-only credential fileをsubshell内でCR/LF除去してexact env名へ
  注入する。`set +x`をassignment前に適用し、値をstdout/stderr、shell history、argumentへ出さない。二runは
  同一のfile path、注入手順、Deno permissionを使う。
- responseと採点は本人がterminalから読み、acceptance conversationのworksheetへ手動転記する。shell
  redirection、`tee`、product state、profile/history/memoryへの自動保存は行わない。
- `retry: 0`とmodel/provider/limit identityはrun terminalだけでは表示されないため、provider call前の
  repository readbackとsource hashを共通metadataとして記録し、二run後に同じhashであることを確認する。

## Concept review request

なし。現行`basic run --context`はexact contextを一requestのpassive runへ渡せる。source変更、別interface、
promptへの手動混入、boundary緩和は不要である。

ただし配送inputのfront matterとHuman Gate 1節は`pending`／未承認のままで、repository `AGENTS.md`も
完了済みH-017 Slice 1をcurrent phaseとしている。一方、今回のcontext packetは、より新しい明示承認として
Human Gate 1 approved、Slice 2の計画文書一件だけ作成可、としている。この差はplanning authorityの表記差で
あり、H-018、Fixed A/B、rubric、対象外は変更しない。本書以外を同期せずHuman Gate 2で停止する。

## 確認した現在状態

- `v0/cli/main.ts`のhelpは
  `basic run --task TEXT [--context TEXT] [--constraints JSON] --confirm-external-call`を公開している。
- 同fileの`basicRun`はtaskをUTF-8 8 KiB、contextを32 KiB、constraintsを最大32件・各1 KiBで検証し、
  system instructionと`JSON.stringify({ task, context, constraints })`から一つのrequestを作る。context省略時は
  empty string、constraints省略時は`[]`である。
- `basicRun`はconfirmation後にmodel seamを一度だけ呼ぶ。successはexact `responseText`、
  `requestCount: 1`、`durationMs`、`outcome.ok`を表示してexit 0、failureはsanitized error、実request count、
  duration、failure outcomeを表示してexit 1にする。responseのparse、tool dispatch、再投入、state writeはない。
- `main`はbasic pathへ固定`basicModel`を渡す。`v0/model.ts`の現行profileはOpenRouter
  `google/gemini-3.7-flash`、`stream: false`、`max_completion_tokens: 1024`、request limit 1、retry 0、
  30秒deadline、76 KiB messages、256 KiB request、1 MiB responseである。CLIからprovider、model、
  endpoint、credential、limitsを上書きするoptionはない。
- credentialはhost processがallowlistされた`HENJI_OPENROUTER_API_KEY`だけから読み、fixed endpointの
  Authorization headerへ入れる。body、success、sanitized failureへ表示しない。確認済みlive `ai-dev`では
  login/non-login shellの同envは未設定で、専用file
  `/home/masat.guest/.config/henji-harness/openrouter-api-key`から値を表示せず注入する必要がある。
- `tests/v0/v0_test.ts`はcontextを含むexact user message、state directory非作成、一回のmodel/fetch、
  passive tool-shaped response、retryなし、fixed request body、credential非serializationを直接検証する。
- `docs/text-first-basic-response-results.md`はH-017 local gate 32 testsと、別承認の一件real-provider
  acceptance（requestCount 1、retry 0、success/exit 0）を記録している。raw responseとcredentialは保存していない。

## Human Gateと順序付きincrement

### Increment 0 — Human Gate 2: 本計画だけを判断する

成果: 本書のexact task/context、invocation、rubric、記録項目、分類、停止条件を承認、修正、保留、終了の
いずれかで判断する。

依存関係: Human Gate 1の新しい明示承認。

検証: 本書一件以外に変更がなく、source/test/configuration/dependency/AGENTS/handoff/Git stateを変更して
いないことをreadbackする。

停止点: Human Gate 2ではtest、credential参照、provider call、A/B、本人判定を行わない。

### Increment 1 — 別Human Gate: read-only local preflight

成果: Human Gate 2承認後、provider callをまだ許可しない別gateで、同じVM、repository、runtime、current
sourceがexact invocationを支えることだけを確認し、次の共通metadataを固定する。

1. 実行場所: `/home/masat.guest/src/henji-harness`。
2. Deno executable: `/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno`。version readbackで
   Deno 2.9.4であることを確認する。
3. `v0/cli/main.ts`からbasic command、context assembly、success/failure metadata、single model callをreadbackする。
4. `v0/model.ts`からprovider origin/path、model identity、stream false、completion 1024、request limit 1、
   retry 0、30秒deadline、request/response bounds、exact credential env名をreadbackする。credential値や存在は
   このgateで調べない。
5. `sha256sum v0/cli/main.ts v0/model.ts`の二digestを記録する。Git commandは使わない。
6. 下記rubricとblank score sheetがprovider call前に固定済みであることを本人が確認する。

検証: source変更、test実行、network接続、credential access、state/writeが0で、Fixed A/Bを妨げる差異が
ないこと。差異があればprovider gateへ進まず、source変更で補わずconcept reviewへ戻す。

停止点: preflight結果を提示して、二回のbounded provider callを許可する次の明示Human Gateを待つ。

### Increment 2 — 別Human Gate: Run Aをexactly once実行して採点する

次の一commandだけをrepository rootで実行する。`--context`と`--constraints`は付けない。

```sh
(
  set +x
  export HENJI_OPENROUTER_API_KEY
  HENJI_OPENROUTER_API_KEY="$(
    tr -d '\r\n' < /home/masat.guest/.config/henji-harness/openrouter-api-key
  )"
  exec /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt \
    --allow-read=/home/masat.guest/src/henji-harness \
    --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai:443 \
    v0/cli/main.ts basic run \
    --task '個人用AI coding harnessを今後3日間試すための優先タスクを3つ提案し、順序と判断基準を示してください。' \
    --confirm-external-call
)
```

実行直後にshell exit codeを読み、Run A欄へ手動記録する。terminal JSONからresponseText、requestCount、
durationMs、outcome、またはsanitized errorを記録する。provider body、Authorization、credential値は記録しない。
preflightの共通metadataをRun Aへ対応付け、retryはsource contractの0として記録する。

Run Aがexit 0、requestCount 1、outcome okでなければpairは直ちにinconclusiveとし、Run Bを実行しない。
成功した場合は、固定rubricでRun Aの三項目、total、correction count、各根拠を採点し、採点を確定してから
Run Bへ進む。Run Bを先に見てAの点を変更しない。

### Increment 3 — 同じprovider-call gate: Run Bをexactly once実行して採点する

Run Aの成功と採点確定後にだけ、次の一commandをrepository rootで実行する。contextは下記exact textだけで、
追加、要約、file混入を行わない。

```sh
(
  set +x
  export HENJI_OPENROUTER_API_KEY
  HENJI_OPENROUTER_API_KEY="$(
    tr -d '\r\n' < /home/masat.guest/.config/henji-harness/openrouter-api-key
  )"
  exec /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno run --no-prompt \
    --allow-read=/home/masat.guest/src/henji-harness \
    --allow-env=HENJI_OPENROUTER_API_KEY --allow-net=openrouter.ai:443 \
    v0/cli/main.ts basic run \
    --task '個人用AI coding harnessを今後3日間試すための優先タスクを3つ提案し、順序と判断基準を示してください。' \
    --context '私は一人で個人software projectを運用している。保守の単純さ、重複回避、実環境の証拠を重視する。team、CI、public deploymentは今回の対象外である。' \
    --confirm-external-call
)
```

Run Aと同じmetadataとexitを手動記録する。Run B failureはinconclusiveであり、同command、修正版command、
別model/providerでretryしない。成功時は同じrubricでBを独立採点し、correction countと各根拠を記録した後、
本人が一回の追加`--context`操作を今後も行えるか`acceptable / unacceptable`で判断する。

最後に`sha256sum v0/cli/main.ts v0/model.ts`を再度読み、preflight digestと一致することを確認する。不一致なら
task/context以外の条件一致を証明できないためinconclusiveとする。Git command、test、file変更は行わない。

### Increment 4 — 別Human Gate: 本人判定とacceptance package

二run後は自動的に次sliceへ進まず、本人判断のgateでworksheetをreadbackする。packageはacceptance
conversationへ直接返し、repository、profile、history、memory、stateへ自動保存しない。packageにはtask/context
全文、共通metadata、各runのresponseTextまたは比較に十分なexact readback、metadata、score根拠、validity、
分類、model variance/順序効果を含める。credential/header/provider error bodyは含めない。

## Provider call前に固定するrubric

| 項目 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| personal fit | solo、単純保守、重複回避、実環境証拠、対象外のうち二つ以上に反する | 一部に適合するがgenericで、本人条件の手動補完が必要 | 本人条件と対象外へ明示的に適合し、手動で前提を置換する必要がない |
| actionable specificity | 3 task、順序、判断基準の二つ以上が欠ける | すべてあるが、一つ以上が曖昧で直接試せない | 3 taskが順序付きで、各taskに3日以内に観測できる判断基準がある |
| irrelevant team assumptions | team、CI、public deployment前提が二つ以上、または回答の中心にある | 除去が必要な前提が一つある | 該当前提がない |

- total usefulnessは三項目の合計0〜6。高い方をbetterとする。
- correction countは採用可能にするため必要な前提・task・順序・判断基準の実質的な追加、削除、置換件数。
  表記だけの修正は数えず、低い方をbetterとする。
- 各項目はanchorへ対応する短い根拠を一つ付ける。合計だけでは判定しない。
- operation burdenはRun B後に本人が`acceptable / unacceptable`の二値で判断する。

## Execution and score worksheet

### Common preflight

- timestamp/timezone: `[ ]` / Asia/Tokyo
- VM/cwd: `ai-dev` / `/home/masat.guest/src/henji-harness`
- Deno identity: `[ ]`
- provider/model: `OpenRouter` / `google/gemini-3.7-flash`
- generation/input/output/time: stream false; completion 1024; task 8 KiB; context 32 KiB;
  constraints `[]`; messages 76 KiB; request 256 KiB; response 1 MiB; deadline 30秒
- request/application retry: 1 / 0
- `v0/cli/main.ts` SHA256: `[ ]`
- `v0/model.ts` SHA256: `[ ]`
- rubric fixed before Run A: `[yes/no]`

### Run A — no context

- timestamp: `[ ]`
- exact invocation confirmed; `--context` absent; constraints `[]`: `[yes/no]`
- exit / requestCount / durationMs / outcome or sanitized failure: `[ ]`
- responseText exact readback: `[ ]`
- personal fit 0–2 / rationale: `[ ]`
- actionable specificity 0–2 / rationale: `[ ]`
- irrelevant team assumptions 0–2 / rationale: `[ ]`
- total usefulness 0–6: `[ ]`
- correction count / concrete corrections: `[ ]`
- A score fixed before B: `[yes/no]`

### Run B — exact context

- timestamp: `[ ]`
- exact invocation/context confirmed; constraints `[]`: `[yes/no]`
- exit / requestCount / durationMs / outcome or sanitized failure: `[ ]`
- responseText exact readback: `[ ]`
- personal fit 0–2 / rationale: `[ ]`
- actionable specificity 0–2 / rationale: `[ ]`
- irrelevant team assumptions 0–2 / rationale: `[ ]`
- total usefulness 0–6: `[ ]`
- correction count / concrete corrections: `[ ]`
- one additional `--context` operation: `[acceptable/unacceptable]`
- post-run source digests equal preflight: `[yes/no]`

## Validityと一意な分類

valid pairは次をすべて満たす場合だけ成立する。

- A→A採点確定→Bの順で、各runをexactly once実行した。
- 両runがexit 0、requestCount 1、success outcomeで、responseを比較できる。
- task、provider、model、system instruction、constraints、generation/input/output/time limits、runtime、basic
  pathが同じで、差はBのexact contextだけである。
- persistent session/history/memory/state、前response再投入、tool/write、retry/fallback/continuationがない。
- preflight/post-run source digestが一致し、rubricが最初のprovider call前、A scoreがB前に固定された。

分類は次の優先順で一意に行う。

1. 上記valid pair条件を一つでも満たさない、どちらかがfailure、条件不一致、または比較不能なら
   `inconclusive`。自動retryせず、新しいpairには別Human Gateが必要。
2. valid pairでoperation burdenが`unacceptable`なら`unsupported`。
3. valid pairでoperation burdenが`acceptable`かつ、B total usefulnessがAより高い、またはB correction
   countがAより一件以上少ないなら`supported`。
4. valid pairでoperation burdenが`acceptable`だが、B total usefulnessが改善せず、B correction countも
   一件以上減らないなら`unsupported`。

## Compatibility、rollback、停止条件

source、CLI、prompt contract、data、stateを変更しないためmigrationとproduct rollbackはない。A/Bは外部call
という不可逆な観測なので「巻き戻し」や同じpairの再実行で補わず、失敗時はsanitized evidenceを残して
inconclusiveで停止する。

次の場合はその場で停止する。

- Human Gate 2、local preflight gate、二run provider-call gate、本人判定gateのいずれかが未承認。
- 現行`basic run --context`でexact passive one-request A/Bを維持できない。
- source/test/configuration/dependency/prompt変更、別interface、credential表示、別provider/model、追加権限、
  repeat、retry、statistical benchmarkが必要になる。
- A failure、B failure、metadata/condition mismatch、response比較不能、source digest mismatchが起きる。

## 完了条件と残るrisk

planning完了は、本書一件だけが存在し、exact A/B、preflight、固定rubric、metadata、score sheet、validity、
supported/unsupported/inconclusive、gateと停止点が実行可能な形で定義され、Human Gate 2前に停止した時点である。

H-018完了は、別々のgateを経てvalid pairと本人のoperation burden判断を含むacceptance packageが提示され、
本人がsupported、unsupported、inconclusiveを確認した時点である。結果からSlice 3、profile、memory、自動context
探索へ進む権限は生じない。

残るriskは、一組のA→Bではmodel varianceと順序効果を分離できないこと、manual scoringに本人判断が入ること、
外部providerの同一model identity内のserving差を観測できないことである。これらは今回の本人value checkの明示的な
限界であり、repeatやbenchmarkを追加して解消しない。
