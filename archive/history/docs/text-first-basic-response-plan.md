# Text-first basic response implementation and verification plan

## 推奨計画と前提

Human Gate 2後の最小変更は、`basic run`の成功terminal contractからPlan/JSON parseの実行と
`parse` fieldだけを取り除き、providerから得た`text`を`responseText`としてそのまま返すことである。
provider transport、failure、finite limits、credential、request countの実装は変更しない。
legacy `run` / `acceptance run`は現在の`parseModelPlan`経路を保持する。

今回の内部contractは次の二つに固定する。

- basic success: `{ responseText: string, requestCount: 1, durationMs: number,
  outcome: { ok: true } }`
- basic failure: 現行どおり`{ error: { code, message }, requestCount: 0 | 1,
  durationMs: number, outcome: { ok: false, code } }`

`responseText`の内容・見た目・Plan適合性はsuccess判定へ影響しない。provider response envelopeの
JSON decodeはtransportからassistant textを取り出す処理であり、今回禁止されるPlan/JSON parseでは
ないため維持する。

可逆的な実装上の仮定として、basicのsystem instruction文言は今回は変更しない。H-017は受信textの
consumer contractとparse表示の除去を検証するsliceであり、modelの出力形式を新たに指定・改善する
sliceではない。format-neutralなprompt自体を成果に含めたい場合は、実装者判断で追加せずDiscoveryへ
確認を戻す。

## Concept review request

なし。現行seamではbasicだけからparseを外せるため、one-request、application retryなし、finite
limits、passive response、host-only secret、legacy互換性を弱める必要はない。

ただし、repositoryの`AGENTS.md`とhandoffはRevision 8 / H-016をcurrent phaseとしており、配送済み
planner inputのfrontmatterも`Human Gate 1: pending`のままである。今回のcontext packetに記録された
新しい明示承認（Revision 10 Slice 1のplanningのみ）をこの計画作成の権限とする。この表記差はHowや
H-017の観測可能性を変えないため計画停止条件ではない。実装承認時にはIncrement 0でrepository側を
承認されたphaseへ同期し、実装権限を推測させない。

## 確認した現在状態

- `v0/cli/main.ts`の`basicRun`はmodel success後に`parseModelPlan(result.text)`を呼び、
  `responseText`と`parse`を同時に表示している。parse結果にかかわらずbasic successのexit codeと
  `outcome.ok`はtrueである。
- 同じfileのlegacy `run`はextension payloadの`planText`を別箇所で`parseModelPlan`へ渡し、結果を
  trace、attempt、terminal outcomeへ使う。basic側の一呼出しを除去してもlegacy経路は変更不要である。
- `v0/model.ts`の`ModelGenerate`は既に`{ text, profile } | Failure`を返す。共有
  `requestCurrentProvider`はrequest validation、single fetch、redirect rejection、30秒timeout、
  256 KiB request、1 MiB response、sanitized failure、host credential取扱いを担い、Plan parseは
  行わない。
- `tests/v0/v0_test.ts`のbasic direct testsはstate-free repeatability、one call、passive
  tool-shaped text、入力limit、confirmation、option parse、failure後の再実行を検証しているが、success
  では現在`parse` fieldも期待している。
- `docs/repeatable-personal-basic-harness-results.md`はRevision 8 / H-016のoffline結果であり、現行
  boundaryと31 tests成功を記録する一方、real provider acceptanceは未実施としている。planner inputが
  正本として述べるRevision 9本人task三件の結果は、このrepository内の結果文書には同期されていない。
- `README.md`はbasic responseに「parse observation」が含まれると説明しており、新contractとの
  user-facingな不一致になる。

## 順序付きincrement

### Increment 0 — 実装権限と変更面を同期する

成果:

- Human Gate 2で承認された場合だけ、`AGENTS.md`のcurrent phaseをRevision 10 / H-017 Slice 1へ更新し、
  許可file、禁止事項、次のhuman gateを明示する。
- 実装対象を`v0/cli/main.ts`、`tests/v0/v0_test.ts`、`README.md`、
  `docs/text-first-basic-response-results.md`、状態が変わった時点の`.handoff/handoff.md`に限定する。
  `v0/model.ts`、dependency、lockfile、legacy sourceは変更対象にしない。

依存関係: Human Gate 2の明示承認。

検証: 更新後のinstructionsがH-017、対象外、provider call禁止、acceptance別gateを正確に示すことを
readbackする。ここではsource/testをまだ変更しない。

### Increment 1 — basic successをtext-only terminal contractへ切り替える

成果:

- `v0/cli/main.ts`の`basicRun`成功分岐から`parseModelPlan(result.text)`と`parse` fieldを除去する。
- `responseText: result.text`、`requestCount: 1`、`durationMs`、`outcome: { ok: true }`だけを返す。
- `ModelGenerate` seam、basic request構築、confirmation、input validation、failure pathを保持する。
- legacy `run` / `acceptance run`のPlan parse、trace、attempt、exit behaviorには触れない。

依存関係: Increment 0。

検証: source readbackでbasic successから`parseModelPlan`へのdata flowが0、legacyからのdata flowが
残ることを確認する。basic responseからtool、write、次request、state保存へ向かう分岐が増えていない
ことも確認する。

### Increment 2 — H-017の直接offline testを更新する

成果:

- `tests/v0/v0_test.ts`の既存basic success testを更新し、JSON風textをexactに保持しつつterminalに
  `parse`、`plan`、validation結果が存在しないことをassertする。
- table-drivenなsuccess testで少なくともJSON風、Markdown、plain text、invalid
  structured-looking textを返し、各caseでexit 0、exact `responseText`、`outcome.ok: true`、一回の
  model invocation、parse由来fieldなしを確認する。
- tool-shaped textの既存testを維持し、passive dataのままでdispatch、filesystem change、追加requestが
  ないことを確認する。test自身が作る一時path以外の状態を使わない。
- provider/transport failure、task/context/constraints上限、request/response上限、timeout、confirmation、
  fixed endpoint、redirect rejection、dummy credential非serialization、failure後の独立commandという
  異なるfailure modeの既存testを保持する。
- legacy direct testは従来どおりPlan parseとlegacy outcomeを期待し、basic変更がlegacy contractへ
  波及していないことを確認する。新parser、repair、schema fixtureは追加しない。

依存関係: Increment 1。

検証: まず対象basic testsだけをofflineで実行し、その後`deno task --config deno.v0.json v0:gate`を
実行する。既存suiteはloopback HTTPを使う場合があるが、real provider endpoint、credential値、
外部networkへ接続しない。実行前にtest filterとfixtureがこの境界を満たすことをreadbackする。

### Increment 3 — user-facing contractとacceptance packageを確定する

成果:

- `README.md`のbasic説明からparse observationを除き、raw `responseText`と最小metadataのみ、内容を
  自動実行・再投入・永続化しないこと、legacy互換性、real provider acceptance別gateを記す。
- `docs/text-first-basic-response-results.md`を作り、H-017の各条件をsource/test名と観測結果へmapping
  する。実行command、test count、未実施事項、変更file、deviation、残存riskを記録する。
- 実装とoffline verificationで状態が変わった後だけ`.handoff/handoff.md`のHenji Harness Recordを
  H-017 local gateへ更新し、次を「別承認の本人acceptance gate」一つにする。

依存関係: Increment 2のlocal gate成功。

検証: README、results、handoffのcontractが実装terminal shapeと一致し、Revision 9の未収録
acceptance結果を新たなrepository evidenceとして創作していないことをreadbackする。scoped diffの
whitespace checkを行い、予定外file、provider/model/dependency/legacy変更がないことを確認する。

## Migration・互換性・rollback

- data migrationはない。basic pathはpersistent attempt、budget、extension、response stateを使わない。
- intentionalなCLI compatibility changeは、basic success JSONから`parse` fieldが消えることだけである。
  `responseText`と最小metadata、failure shape、command flagsは維持する。basic output consumerは`parse`を
  読まないよう同時に移行する必要があるが、repository内にそのconsumerは確認されていない。
- legacy `run` / `acceptance`のterminal、Plan parse、state、attempt、traceは移行対象外であり、回帰testで
  保持する。
- local gateまたはreviewで失敗した場合は、Increment 1のbasic success変更とIncrement 2の対応test、
  README/results/handoffの未成立記述だけを元へ戻す。provider transportやlegacyを変更しないため、data
  rollback、credential操作、attempt復旧は不要である。

## H-017 acceptance packageと別gate

offline packageは次を直接示せば完了とする。

| H-017条件 | 必要な直接証拠 |
| --- | --- |
| raw textが唯一の正式response | 4種のrepresentative textがexact `responseText`でexit 0 |
| parse実行・表示0 | basic source data-flow readbackとterminal key absence assertions |
| failureをsuccessと混同しない | transport、input、generation/request、response、timeoutのbounded failure tests |
| exactly one request、retry等0 | model/fetch spy countとpassive tool-shaped response test |
| host-only secret | fixed destination、redirect error、dummy Authorizationの非serialization test |
| passive・state-free・再実行可能 | no-dispatch/no-state assertionsとfailure後の次command success |
| legacy非変更 | legacy parse/outcome regressionとscoped diff |

offline package確定後に停止し、real provider、credential lookup、本人task、attempt/state操作は行わない。
別の明示Human Gateで承認された場合だけ、一件以上のside-effect-free本人taskを一command・一requestで
実行し、本人が(1) raw responseをそのまま利用可能か、(2) parse由来の修正操作が0かを判断する。
provider successそのもの、文章品質、JSON率はH-017の代替判定にしない。

## 完了条件と残るrisk

Human Gate 2へ渡せる条件は満たしている。計画は現行seamで実施可能で、concept review条件に該当する
衝突はない。実装完了はIncrement 0–3、offline gate、H-017 mapping、scoped readbackが成功し、deviation
が記録され、別gate前に停止した時点とする。

残るriskは、repositoryにRevision 9本人acceptanceの直接result文書がなく、planner inputの要約を
repository内で再検証できないこと、およびbasic successの`parse` fieldを利用するrepository外consumerが
存在する可能性である。前者は今回のHowを変えず、後者はHuman Gate 2でintentional contract changeとして
承認する。どちらもlegacy変更やscope拡大で解消しない。
