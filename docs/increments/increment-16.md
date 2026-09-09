# 通常利用 increment 16 — built-in instruction component

ステータス: **完了**

対応architecture:
[`docs/architecture/multi-provider-routing-and-auth.md`](../architecture/multi-provider-routing-and-auth.md)

## 利用者が必要とする動作

- Henji共通、agent role、active tool guideline、workspace instruction、skill manifest、runtime factsを
  独立componentとして一定順序で合成する。
- default rootとplannerは共通componentを共有しつつ、互いのrole instructionと利用不能なtool guidelineを
  受け取らない。
- OpenRouterとOpenAI directは同じresolved Henji instructionを受け、provider固有のwire fieldやmetadataを
  Henjiのinstruction本文へ混ぜない。
- 実行に使ったinstruction component identityをdefault/plannerのmanifestへ記録する。
- built-in instruction本文を人間がsource treeから見つけ、共通部分とagent固有部分の影響範囲を区別して
  編集できる。

## 採用する構造

```text
v0/agent/instructions/
├── README.md
├── component.ts
├── compose.ts
├── henji_common.ts
├── runtime_facts.ts
└── roles/
    ├── default.ts
    └── planner.ts
```

- `henji_common.ts`は全built-in agent共通の短いidentityと作業姿勢を所有する。
- `roles/default.ts`と`roles/planner.ts`はagent固有instructionを別々に所有する。既存planner policyの
  read-only semanticsを維持する。
- `compose.ts`は次の固定順序だけを所有する。
  1. Henji common
  2. agent role
  3. active tool guidelines
  4. workspace instruction
  5. skill manifest
  6. runtime facts
- runtime factsの初期内容はcanonical current working directoryだけとする。provider、model、effort、Session
  IDは同一Session内の切替で古くなるため入れない。日付はprompt cacheを日ごとに変化させるため入れない。

## Workspace instruction

- project instructionは現行どおり`<workspace root>/AGENTS.md`、なければ`AGENTS.MD`の一つだけを使う。
- Henji-globalな`~/.config/henji-harness/AGENTS.md`は設けない。
- ancestor/nested discovery、`AGENTS.override.md`、SYSTEM.md、prompt override UIはこのincrementへ含めない。

## Component identityとmanifest

default/plannerの実際の構成に応じ、既存の`manifest.resources`へ次のidentityを記録する。

- `instruction:builtin-henji-common`
- `instruction:builtin-default-role`または`instruction:builtin-planner-policy`
- `instruction:active-tool-guidelines`
- `instruction:workspace-agents`（workspace instructionがある場合）
- `instruction:project-skill-manifest`（skillがある場合）
- `instruction:runtime-facts`

manifestには本文を複製しない。合成順はsource contract、実際にproviderへ送ったresolved本文はprovider request
evidenceで確認する。component revision、候補、採用、rollback、自己改定はF24候補のままとする。

## 実装slice

1. instruction component型、共通／role別本文、runtime facts、順序付きcomposerを上記directoryへ追加する。
2. built-in default/planner Definitionのinstruction resource宣言をcomponent identityへ合わせる。
3. Worker compositionで、実際にmaterializeした各registryのtool guidelineからdefault/plannerを独立に合成する。
4. direct runtime互換経路もmaterialize済みregistryから同じcomposerを使い、Workerと意味を揃える。
5. OpenRouter system messageとOpenAI Responses `instructions`の既存adapter mappingは変更せず、同一resolved
   instructionがprovider固有fieldへ入ることを確認する。
6. source guide、roadmap、architecture、handoffを実装結果へ合わせる。
7. focused product test、type check、format、lint、差分review後、安定候補でauthoritative `v0:gate`を一回行う。

## Product確認

| 動作 | 確認方法 |
| --- | --- |
| componentが固定順で一度ずつ合成される | component composerのfocused test |
| defaultとplannerが自分のroleだけを受け取る | 両compositionのresolved instruction比較 |
| tool guidelineがactive registryへ限定される | defaultのread/bash_output/web_searchとplannerのreadを比較 |
| workspace/skillの有無がcomponentとmanifestに一致する | Definition、manifest、resolved instructionの比較 |
| runtime factsがcwdだけを含みroute変更で古くならない | component本文とmodel selection非依存の比較 |
| OpenRouter/OpenAIが同じsemantic instructionを受ける | fake transportで各provider wireをcapture |
| OpenAI rootとOpenRouter plannerがrole/providerを混同しない | root/planner compositionとroute attributionのfocused regression |
| direct runtimeとWorkerが同じ合成規則を使う | 両実経路のrequest capture |

実provider callは外部contractの確認を必要としないため行わない。Testは上記product動作へ対応するものだけを
追加する。

## 対象外

- tool/provider plugin機構とHenji core更新機構
- instruction revision、自己改定、候補保存、採用、rollback
- global/ancestor/nested instruction discovery
- provider/model/planner選択UI、認証、Web search、visionの変更
- system prompt override fileまたはslash command

## Human Gate

利用者は2026-09-09、上記directory構造、workspace rootの`AGENTS.md`だけをproject instructionとして使う
方針、runtime facts、component実装、test、review、authoritative gateまでを承認した。

## Review

2026-09-09のread-only第三者reviewは、対象source/testにBlocker/P1なしと判定した。合成順、role/tool分離、
Worker/direct共通composer、provider wire mapping、manifest identity、workspace-root限定のAGENTS discoveryを確認した。
P2はhandoffが古い計画段階を示していた文書状態の不整合一件で、本実装の現在段階へ更新して解消した。

## Verification

- Increment 16 focused product test: 4 passed
- 既存`current_code_test.ts`: 14 passed
- authoritative `v0:gate`: type check、format、lint、全125 test passed

最初のgate実行は`v0/agent/README.md`のMarkdown折返し一箇所でformat checkが停止した。formatterどおりに
整形して該当checkを確認し、testへ到達しなかった具体的理由からgateを再実行して全項目が成功した。

## Production確認

2026-09-09、利用者がOpenAI root（`gpt-5.6-sol`、effort `medium`）から`delegate_to_planner`を一回呼び、
続いてrootの`read README.md`で10行要約を完成できることを確認した。instruction不正、provider response invalid、
権限errorは発生しなかった。
