# AI Definition Proposal Spike 1 結果

## 判定

独立review後の最終判定は`deterministic core GO / AI end-to-end unobserved`とする。H-010/H-012の
Spike 1範囲として、全origin共通のbounded Intake、host-owned Ticket
authority、exact-base/stale/scope/ budget enforcement、hidden-preserving resolution、candidate
DefinitionRevision value、append-only in-memory ledgerを観測した。

実AI、provider/model、credential/network call、candidate/plugin
execution、artifact、Admission、registry、
current、DeploymentStateは実装・実行・変更していない。Spike 2へ進む許可を含まない。

## 要件と証拠

| 要件                                  | 実装                                            | 直接test/観測                                        |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| bounded raw JSONとduplicate rejection | intake/framing/limits modules                   | refusal、UTF-8、duplicate precedence、depth/count    |
| 全origin共通Intake                    | `definition_proposal.ts`、`revision_service.ts` | AI/human/third-party/legacy同一fixture               |
| Ticket authorityをpayloadから分離     | Submission/Envelope/Proposal三分割              | unknown schema、trusted path、scope rejection        |
| exact baseとhidden保持                | base/live/ticket三者比較、Spike 0 resolver      | stale rejection、config変更、identity保持            |
| budget/evidence/scope                 | `mutation_scope.ts`、service budget checks      | scope、replacement、schema rejection                 |
| success時だけrevision発行             | injected ID/clock、revision digest              | rejection時0、success時各1                           |
| same-content別revision                | proposal/sealed/revision domain                 | 別submissionでcontent hash同一、Proposal ID相違      |
| rejection history/retry               | immutable outcome ledger                        | replay、conflict、満杯replay/refusal                 |
| source identity                       | normalizer manifest checker                     | pinned digest再計算成功                              |
| zero side effects                     | all-deny Deno testとcounters                    | process/broker/artifact/Admission/registry/current 0 |

## 実装範囲

- 新規`deno.spike1.json`と`spike1/`へ隔離し、新規dependencyとlockfileを追加しなかった。
- Spike 0のDefinitionContent、Revision View、JCS/hashを変更せずimportした。
- `ProposalSubmissionV1`はauthorityを持たず、trusted envelopeだけがticket/path/origin/host
  identityを付与する。
- Ticket、base snapshot、live contextを値として受け、Revision Serviceによるfilesystem/registry
  readを 行わない。
- accepted/rejected outcomeはbounded in-memory ledger valueだけに残し、persistしない。
- deterministic digest domain、Proposal/sealed/revision identity、retry bindingを分離した。

## 検証結果

runtimeはDeno 2.9.4、V8 15.0.245.2、TypeScript 6.0.3。

1. scoped `deno check`: 23 files成功。
2. `deno info --json` module graph preflight: Spike 1と承認済み`spike0/src/`だけで成功。
3. normalizer source manifest digest preflight: 成功。
4. 全permission、remote/npm/lockfile拒否の`deno test`: 29 passed / 0 failedを独立に2回。
5. scoped `deno lint`: 23 files成功。
6. scoped `deno fmt --check`: 26 files成功。
7. `git diff --check`: 成功。

## Deviationとremaining risk

- 承認済みplan-deltaどおり、AI raw outputはticket ID/pathを返さず、host-built Proposalだけが持つ。
- 実AIを選択していないため、AI Proposal contract、structured output、tool無効化、provider
  limitは未観測。
- ledgerはtrusted
  hostが完全なsnapshotを渡すTCB前提で、永続性、改ざん防止、paging/compactionを保証しない。
- ledger runtime validatorは全nested shape/literal/hash形式を検査するが、trusted snapshot内のstored
  digestを再計算して暗号学的整合性までは検証しない。
- dependency-free scannerはSpike 1の限定JSON boundary実装であり、汎用parserとして扱わない。
- source identity checkerのfile readはpreflightだけで、all-deny coreにはfilesystem authorityがない。
- resource limitはSpike 1推奨profileのconcept値で、production capacityを意味しない。
- trusted Ticket/base/live/identity port自体の発行元認証はSpike 1 TCB前提である。
- candidate revisionはin-memory valueであり、registry identity、Admission proof、artifact
  identityではない。

初回独立reviewは、untrusted keyのledger流出、検査stage順、runtime schema/bounded
traversal、normalizer identity、test evidence、failure precedence、oversize APIをblocking
findingとした。stable rejection code、 metadata/scope先行、runtime validators、early-cutoff
traversal、module-closure normalizer digest、直接回帰test、 service
refusalを追加後に全検証を再実行した。

再reviewではTicket Store key/内部ID不一致、nested ledger schema不足、base target/contentの例外、JSON
syntax precedence、identity/capacity/budget直接証拠不足がblocking findingとなった。Ticket
identity照合、 全nested runtime schema、bounded base normalizationのstructured
rejection、syntax-first pass、digest golden vector、binding全field、processing境界、deep
immutability、identity mismatch、ledger byte一致/1超過、 narrative/evidence/risk
limitの回帰testを追加した。 最終再reviewで検出されたretry bindingのproperty insertion
order依存は、canonical bytes比較とreordered ledger回帰testで除去した。 同reviewで検出されたstandard
JSON.parseの先行materializationとpublic frame bypassは、非構築の反復型 syntax pass、opaque branded
frame、Revision Service入口のclone/hash前guardと直接bypass testで除去した。

## 次のGate

独立reviewはblocking findingなしの`GO`と判定し、2026-08-19のHuman GateでユーザーがH-010/H-012の
deterministic core結果と記載された残余リスクを受け入れ、retainを承認した。実AI観測を追加する場合は
provider/model/endpoint/credential/structured output/tool 無効化/limit/費用を別途承認する。Spike
2は別計画・別承認とする。
