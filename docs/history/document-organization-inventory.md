# 初期increment・計画文書の整理棚卸し

## この一覧の位置付け

利用者の「初期のインクリメント、計画文書は整理しようかな」「では進めて」に対する第一段階。
現行文書を探しやすくするため、残す／履歴へ移す候補／要確認を整理する。
第一段階の分類に加え、利用者の「アーカイブしようか」に基づく対象20ファイルの移動結果を記録する。
product仕様とincrementの完了状態は新たに定義しない。

初期Increment 2〜9の16ファイルと計画・結果4ファイルを履歴へ移動した。
削除・統合・要約置換はしていない。構想・architecture・roadmap、通常利用メモ、handoff、実装・設定も
この整理では変更していない。

## 根拠と確認範囲

- [roadmapの「目的と正本」](../roadmap.md#目的と正本)を含む冒頭180行を直接確認。
  `docs/plans/`は過去の実装・検証の証拠であり、現在の実装状態・機能順序の正本ではない、と明記されている。
- [handoff](../../.handoff/handoff.md)を全文確認。現在の入口はIncrement 172〜179等であり、初期文書ではない。
- 初期incrementは、今回の小さな整理単位として2〜9を対象にした。
  第一段階では計画側のタイトル・ステータスを抽出し、各結果文書を全文確認した。
  アーカイブ前に2〜9の計画本文とminimal tool-use計画も全文確認した。
  10以降の本文評価、および2以前の記録を他の保存先から探す作業は未実施。
- `docs/plans/`の110ファイルはタイトル・行数・ステータス行を機械抽出した。
  全文を意味上精査したものは下記に明記し、それ以外を完了済みと推測しない。
- Git管理下のMarkdown、TypeScript、JavaScript、JSON、shell、Pythonファイルを対象に、
  対象ファイル名の文字列参照を走査した。表の参照数は一致した行の数で、文書自身の記載も含む。
  番号だけの参照、動的に組み立てたpath、外部repository、未追跡ファイルは網羅しない。
  「参照なし」はこの走査で一致しなかった意味であり、不要の証明ではない。
- 「現行入口から参照」はREADME、AGENTS、handoff、roadmap、構想、architecture、operations、experienceからの
  文字列参照を指す。参照元の本文全体を精査したという意味ではない。

## 判断規則

- **残す**：未採用・未完了の案、または現行入口から参照され、先に参照の役割を確認する必要がある文書。
- **履歴へ移す候補**：結果に完了・実行結果が記録されている初期文書。要件・実行証拠をそのまま保持する。
- **要確認**：メタデータだけでは状態を確定できない文書。計画と結果のステータス差も勝手に補正しない。
- **pointer維持**：すでにincrementへ採用された移管案内。重複本文として削除しない。

履歴移動時も、初期の値・command・schema・制約を現在仕様に書き換えない。
移動先は`docs/history/increments/`と`docs/history/plans/`。
ファイル名と本文を保持し、移動に必要なMarkdownリンクの相対pathだけを更新した。
当時の実装対象や結果保存先を示す本文内の旧path・commandは歴史的記録として保持した。
既存の`archive/`は旧spike・旧実装等も含むため、今回の開発記録と一括にはしない。
正本の参照path更新が必要な場合も、AGENTSの承認境界に従って対象・理由・意味上の差を別途提示する。

## 初期Increment 2〜9：アーカイブ済み

各行は計画と結果の2ファイルを一組として扱う。結果全文と計画のステータス記載を根拠にする。

| Increment | 対象 | 根拠・注意点 |
| --- | --- | --- |
| 2 | [step budgetとworkspace表示](increments/increment-2.md) / [結果](increments/increment-2-results.md) | 通常利用の人間による確認・受入完了。64 steps等は当時の記録として保持する。 |
| 3 | [履歴からの復帰と画面の視覚的境界](increments/increment-3.md) / [結果](increments/increment-3-results.md) | 2026-09-07に通常利用確認・受入完了。 |
| 4 | [conversation識別、history export、read継続読込み](increments/increment-4.md) / [結果](increments/increment-4-results.md) | 2026-09-07にproduction human gate・受入完了。当時のexport仕様は現在仕様へ格上げしない。 |
| 5 | [conversation label識別とbash全出力readback](increments/increment-5.md) / [結果](increments/increment-5-results.md) | 初回失敗後の再試行でhuman gate・受入完了。初回未完了の経緯も残す。 |
| 6 | [recoverable inputとwork tool component化](increments/increment-6.md) / [結果](increments/increment-6-results.md) | idle Ctrl-Cのproduction不具合修正を含め、2026-09-07に受入完了。当時のcomponent置換経路も履歴として保持する。 |
| 7 | [Henji-owned Web search](increments/increment-7.md) / [結果](increments/increment-7-results.md) | 当初のgrounding未受入と、8・9による後継経路、2026-09-27の完了整理を区別して保持する。 |
| 8 | [Web search grounding](increments/increment-8.md) / [結果](increments/increment-8-results.md) | 当初の親final未受入と、9への引継ぎ、2026-09-27の完了整理を区別して保持する。 |
| 9 | [Web search citation links](increments/increment-9.md) / [結果](increments/increment-9-results.md) | 2026-09-08のproduction human gate・利用者受入を記録。 |

上記16ファイルについて、走査対象の現行入口・コードからファイル名の参照は検出されなかった。
移動文書からE2E記録へのリンクと、Increment 146からIncrement 3へのリンクを更新した。
この一覧から移動文書へのリンクも更新した。

## 計画文書：本文確認済みの判断

- **残す**：[Forgejo配布・自己update案](../plans/forgejo-binary-distribution-and-self-update.md)。
  全文で未採用・未承認の検討案と確認できる。過去の完了計画として移動しない。
  通常利用メモへの扱い変更は今回行わず、固有の要望・提案を保持する。
- **pointer維持**：[A1移管案内](../plans/a1-chatgpt-sign-in.md)。
  全文でIncrement 163への移管先案内と確認できる。独立した重複計画本文ではない。
- **アーカイブ済み**：[minimal tool-use plan](plans/minimal-tool-use-agent-loop.md)と
  [結果](plans/minimal-tool-use-agent-loop-results.md)。結果全文に承認済みmilestone 5実装の記録がある。
  fixture-onlyの達成範囲と、当時の後続課題を保持した。計画本文もアーカイブ前に全文確認した。
- **アーカイブ済み**：[step 9結果](plans/json-object-keys-task-results.md)、
  [step 10結果](plans/multi-tool-task-results.md)。全文で初期taskの実行結果と確認できる。
  失敗した先行attemptやtask変更もそのまま残す。

## 計画文書の全件一覧

以下はメタデータと文字列参照による一次分類に、今回のアーカイブ結果を反映したもの。
参照行数・参照元行番号は第一段階の走査時点の記録。アーカイブ対象以外の完了判定は未実施。
現行入口から参照される文書は、その参照役割を確認するまで現在位置に残す。
ステータス欄は抽出した最初の行のみで、複数行に続く記載は省略している。
空欄を完了／未完了のいずれとも解釈しない。

| 文書 | 行数 | 一次分類 | 参照行数 | 現行入口の参照元 | ステータス抽出 |
| --- | ---: | --- | ---: | --- | --- |
| [a1-chatgpt-sign-in.md](../plans/a1-chatgpt-sign-in.md) | 6 | pointer維持 | 0 | — | — |
| [a25-implementation-slices.md](../plans/a25-implementation-slices.md) | 343 | 残す | 8 | [docs/operations/http-api.md:11](../operations/http-api.md) | — |
| [a25-multiple-cores.md](../plans/a25-multiple-cores.md) | 242 | 要確認 | 8 | — | — |
| [agent-definition-composition-boundary-results.md](../plans/agent-definition-composition-boundary-results.md) | 96 | 要確認 | 1 | — | — |
| [agent-definition-composition-boundary.md](../plans/agent-definition-composition-boundary.md) | 338 | 要確認 | 5 | — | — |
| [agent-definition-fresh-runtime-comparison-results.md](../plans/agent-definition-fresh-runtime-comparison-results.md) | 80 | 要確認 | 1 | — | — |
| [agent-definition-fresh-runtime-comparison.md](../plans/agent-definition-fresh-runtime-comparison.md) | 785 | 要確認 | 3 | — | — |
| [agent-definition-local-comparison-variant-results.md](../plans/agent-definition-local-comparison-variant-results.md) | 89 | 要確認 | 1 | — | — |
| [agent-definition-local-comparison-variant.md](../plans/agent-definition-local-comparison-variant.md) | 433 | 要確認 | 3 | — | — |
| [agent-definition-replay-envelope-execution-record-results.md](../plans/agent-definition-replay-envelope-execution-record-results.md) | 99 | 要確認 | 1 | — | — |
| [agent-definition-replay-envelope-execution-record.md](../plans/agent-definition-replay-envelope-execution-record.md) | 495 | 要確認 | 2 | — | — |
| [agent-definition-resolved-manifest-results.md](../plans/agent-definition-resolved-manifest-results.md) | 95 | 要確認 | 1 | — | — |
| [agent-definition-resolved-manifest.md](../plans/agent-definition-resolved-manifest.md) | 416 | 要確認 | 3 | — | — |
| [agent-definition-resource-identity-results.md](../plans/agent-definition-resource-identity-results.md) | 87 | 要確認 | 1 | — | — |
| [agent-definition-resource-identity.md](../plans/agent-definition-resource-identity.md) | 445 | 要確認 | 3 | — | — |
| [agent-worker-foundation-proof-stages-1-3-results.md](../plans/agent-worker-foundation-proof-stages-1-3-results.md) | 142 | 要確認 | 0 | — | — |
| [agent-worker-foundation-proof-stages-1-3.md](../plans/agent-worker-foundation-proof-stages-1-3.md) | 697 | 要確認 | 3 | — | — |
| [agent-worker-real-provider-gate-corrections-results.md](../plans/agent-worker-real-provider-gate-corrections-results.md) | 119 | 要確認 | 1 | — | — |
| [agent-worker-real-provider-gate-corrections.md](../plans/agent-worker-real-provider-gate-corrections.md) | 321 | 要確認 | 3 | — | — |
| [agent-worker-real-provider-human-acceptance-results.md](../plans/agent-worker-real-provider-human-acceptance-results.md) | 72 | 要確認 | 3 | — | Status: **accepted** |
| [agent-worker-real-provider-human-acceptance.md](../plans/agent-worker-real-provider-human-acceptance.md) | 317 | 要確認 | 0 | — | Status: **execution package prepared — Human Gate pending** |
| [bounded-next-turn-queue-results.md](../plans/bounded-next-turn-queue-results.md) | 82 | 要確認 | 1 | — | — |
| [bounded-next-turn-queue.md](../plans/bounded-next-turn-queue.md) | 442 | 要確認 | 1 | — | — |
| [bounded-planner-delegation-tool-results.md](../plans/bounded-planner-delegation-tool-results.md) | 123 | 要確認 | 2 | — | — |
| [bounded-planner-delegation-tool.md](../plans/bounded-planner-delegation-tool.md) | 483 | 要確認 | 4 | — | — |
| [builtin-agent-definition-selection-results.md](../plans/builtin-agent-definition-selection-results.md) | 101 | 要確認 | 1 | — | — |
| [builtin-agent-definition-selection.md](../plans/builtin-agent-definition-selection.md) | 378 | 要確認 | 2 | — | — |
| [d0-internal-agent-definition-seam-results.md](../plans/d0-internal-agent-definition-seam-results.md) | 70 | 要確認 | 0 | — | — |
| [d0-internal-agent-definition-seam.md](../plans/d0-internal-agent-definition-seam.md) | 207 | 要確認 | 1 | — | — |
| [daily-editor-no-lost-input-results.md](../plans/daily-editor-no-lost-input-results.md) | 110 | 要確認 | 2 | — | — |
| [daily-editor-no-lost-input.md](../plans/daily-editor-no-lost-input.md) | 663 | 要確認 | 4 | — | — |
| [detached-three-band-human-ui-results.md](../plans/detached-three-band-human-ui-results.md) | 208 | 要確認 | 1 | — | — |
| [detached-three-band-human-ui.md](../plans/detached-three-band-human-ui.md) | 531 | 要確認 | 3 | — | — |
| [fixed-output-limit-expansion.md](../plans/fixed-output-limit-expansion.md) | 81 | 要確認 | 1 | — | Status: implemented and functionally reviewed |
| [forgejo-binary-distribution-and-self-update.md](../plans/forgejo-binary-distribution-and-self-update.md) | 184 | 残す | 0 | — | — |
| [fr0-fr1-product-baseline-provider-stream-compatibility-results.md](../plans/fr0-fr1-product-baseline-provider-stream-compatibility-results.md) | 116 | 要確認 | 1 | — | Status: **post-commit P2 closure locally verified; real-provider and human acceptance pending** |
| [fr0-fr1-product-baseline-provider-stream-compatibility.md](../plans/fr0-fr1-product-baseline-provider-stream-compatibility.md) | 303 | 要確認 | 1 | — | Status: **implementation approval pending** |
| [fr1-real-provider-human-acceptance-results.md](../plans/fr1-real-provider-human-acceptance-results.md) | 52 | 残す | 2 | [docs/operations/openrouter-credential.md:47](../operations/openrouter-credential.md) | Status: **accepted** |
| [fr1-real-provider-human-acceptance.md](../plans/fr1-real-provider-human-acceptance.md) | 211 | 要確認 | 0 | — | Status: **executed once and accepted — Human Gate consumed** |
| [gate-1-general-agent-production-acceptance-results.md](../plans/gate-1-general-agent-production-acceptance-results.md) | 84 | 残す | 2 | [docs/operations/openrouter-credential.md:48](../operations/openrouter-credential.md) | Status: **accepted** |
| [gate-1-general-agent-production-acceptance.md](../plans/gate-1-general-agent-production-acceptance.md) | 409 | 要確認 | 0 | — | Status: **planning complete — Human Gate pending** |
| [json-object-keys-task-results.md](plans/json-object-keys-task-results.md) | 9 | アーカイブ済み | 0 | — | — |
| [live-corpus-evaluation-results.md](../plans/live-corpus-evaluation-results.md) | 113 | 要確認 | 3 | — | — |
| [live-corpus-evaluation.md](../plans/live-corpus-evaluation.md) | 387 | 要確認 | 2 | — | — |
| [local-work-tools-real-model-sentinel-results.md](../plans/local-work-tools-real-model-sentinel-results.md) | 139 | 要確認 | 2 | — | — |
| [local-work-tools-real-model-sentinel.md](../plans/local-work-tools-real-model-sentinel.md) | 441 | 要確認 | 2 | — | — |
| [milestone-100-offline-gate-integrity-results.md](../plans/milestone-100-offline-gate-integrity-results.md) | 73 | 要確認 | 1 | — | — |
| [milestone-100-offline-gate-integrity.md](../plans/milestone-100-offline-gate-integrity.md) | 395 | 要確認 | 1 | — | — |
| [minimal-tool-use-agent-loop-results.md](plans/minimal-tool-use-agent-loop-results.md) | 45 | アーカイブ済み | 1 | — | — |
| [minimal-tool-use-agent-loop.md](plans/minimal-tool-use-agent-loop.md) | 169 | アーカイブ済み | 0 | — | — |
| [multi-tool-task-results.md](plans/multi-tool-task-results.md) | 7 | アーカイブ済み | 0 | — | — |
| [normal-cli-offline-process-e2e-results.md](../plans/normal-cli-offline-process-e2e-results.md) | 124 | 要確認 | 2 | — | — |
| [normal-cli-offline-process-e2e.md](../plans/normal-cli-offline-process-e2e.md) | 219 | 要確認 | 1 | — | — |
| [offline-corpus-eval-runner-results.md](../plans/offline-corpus-eval-runner-results.md) | 89 | 要確認 | 1 | — | — |
| [offline-corpus-eval-runner.md](../plans/offline-corpus-eval-runner.md) | 377 | 要確認 | 0 | — | — |
| [offline-provider-transport-tool-use-results.md](../plans/offline-provider-transport-tool-use-results.md) | 117 | 要確認 | 2 | — | — |
| [offline-provider-transport-tool-use.md](../plans/offline-provider-transport-tool-use.md) | 271 | 要確認 | 1 | — | — |
| [pi-json-result-live-sentinel.md](../plans/pi-json-result-live-sentinel.md) | 269 | 要確認 | 2 | — | — |
| [pi-style-json-result-submission-results.md](../plans/pi-style-json-result-submission-results.md) | 178 | 残す | 4 | [docs/operations/openrouter-credential.md:46](../operations/openrouter-credential.md) | — |
| [pi-style-json-result-submission.md](../plans/pi-style-json-result-submission.md) | 504 | 要確認 | 2 | — | — |
| [planner-delegation-real-model-sentinel-results.md](../plans/planner-delegation-real-model-sentinel-results.md) | 193 | 要確認 | 4 | — | — |
| [planner-delegation-real-model-sentinel.md](../plans/planner-delegation-real-model-sentinel.md) | 358 | 要確認 | 2 | — | — |
| [planner-delegation-sentinel-response-guard-fix.md](../plans/planner-delegation-sentinel-response-guard-fix.md) | 143 | 要確認 | 1 | — | — |
| [portable-launch-startup-orientation-results.md](../plans/portable-launch-startup-orientation-results.md) | 85 | 要確認 | 0 | — | — |
| [portable-launch-startup-orientation.md](../plans/portable-launch-startup-orientation.md) | 497 | 要確認 | 3 | — | — |
| [provider-neutral-cancellation-results.md](../plans/provider-neutral-cancellation-results.md) | 140 | 要確認 | 1 | — | — |
| [provider-neutral-cancellation.md](../plans/provider-neutral-cancellation.md) | 715 | 要確認 | 4 | — | — |
| [provider-neutral-context-management-results.md](../plans/provider-neutral-context-management-results.md) | 94 | 要確認 | 2 | — | — |
| [provider-neutral-context-management.md](../plans/provider-neutral-context-management.md) | 506 | 要確認 | 3 | — | — |
| [provider-neutral-mid-turn-steering-results.md](../plans/provider-neutral-mid-turn-steering-results.md) | 105 | 要確認 | 2 | — | — |
| [provider-neutral-mid-turn-steering.md](../plans/provider-neutral-mid-turn-steering.md) | 592 | 要確認 | 1 | — | — |
| [provider-neutral-persistent-session-history-results.md](../plans/provider-neutral-persistent-session-history-results.md) | 62 | 要確認 | 0 | — | — |
| [provider-neutral-persistent-session-history.md](../plans/provider-neutral-persistent-session-history.md) | 346 | 要確認 | 2 | — | — |
| [provider-neutral-streaming-results.md](../plans/provider-neutral-streaming-results.md) | 75 | 要確認 | 1 | — | — |
| [provider-neutral-streaming.md](../plans/provider-neutral-streaming.md) | 575 | 要確認 | 1 | — | — |
| [provider-neutral-tool-progress-events-results.md](../plans/provider-neutral-tool-progress-events-results.md) | 110 | 要確認 | 2 | — | — |
| [provider-neutral-tool-progress-events.md](../plans/provider-neutral-tool-progress-events.md) | 529 | 要確認 | 2 | — | — |
| [real-provider-fixed-tool-acceptance-results.md](../plans/real-provider-fixed-tool-acceptance-results.md) | 156 | 要確認 | 2 | — | — |
| [real-provider-fixed-tool-acceptance.md](../plans/real-provider-fixed-tool-acceptance.md) | 367 | 要確認 | 2 | — | — |
| [repo-external-credential-launcher-results.md](../plans/repo-external-credential-launcher-results.md) | 138 | 残す | 2 | [docs/operations/openrouter-credential.md:29](../operations/openrouter-credential.md) | — |
| [repo-external-credential-launcher.md](../plans/repo-external-credential-launcher.md) | 223 | 要確認 | 1 | — | — |
| [s22-cli-and-external-api.md](../plans/s22-cli-and-external-api.md) | 200 | 残す | 10 | [docs/experience/normal-use-inbox.md:840](../experience/normal-use-inbox.md) | ステータス: [詳細設計・slice計画](../plans/s22-detailed-design-and-slices.md)のCLI具体案。 |
| [s22-detailed-design-and-slices.md](../plans/s22-detailed-design-and-slices.md) | 879 | 残す | 15 | [docs/experience/normal-use-inbox.md:114](../experience/normal-use-inbox.md) | ステータス: 利用者が全8sliceの段階実装と各sliceのコード・test第三者reviewを指示した。 |
| [s22-http-core-and-tui.md](../plans/s22-http-core-and-tui.md) | 376 | 要確認 | 3 | — | ステータス: |
| [session-navigation-context-recovery-readme-results.md](../plans/session-navigation-context-recovery-readme-results.md) | 203 | 要確認 | 0 | — | — |
| [session-navigation-context-recovery-readme.md](../plans/session-navigation-context-recovery-readme.md) | 588 | 要確認 | 4 | — | — |
| [small-task-corpus-results.md](../plans/small-task-corpus-results.md) | 67 | 要確認 | 1 | — | — |
| [small-task-corpus.md](../plans/small-task-corpus.md) | 290 | 要確認 | 1 | — | — |
| [step-83-full-capability-human-acceptance-gate.md](../plans/step-83-full-capability-human-acceptance-gate.md) | 220 | 要確認 | 2 | — | Status: **separate final Human Gate consumed; Turn 1 failure is non-evaluable; no retry** |
| [step-83-full-capability-human-acceptance-results.md](../plans/step-83-full-capability-human-acceptance-results.md) | 179 | 要確認 | 1 | — | Status: **local integration GO; final real-screen Human Gate consumed but non-evaluable** |
| [step-83-full-capability-human-acceptance-retry-gate.md](../plans/step-83-full-capability-human-acceptance-retry-gate.md) | 390 | 要確認 | 1 | — | Status: **CONSUMED — Turn 1 diagnosed failure; no retry** |
| [step-83-full-capability-human-acceptance-retry-results.md](../plans/step-83-full-capability-human-acceptance-retry-results.md) | 160 | 要確認 | 1 | — | Status: **repository implementation and owner evidence closure complete; the |
| [step-83-full-capability-human-acceptance-retry.md](../plans/step-83-full-capability-human-acceptance-retry.md) | 548 | 要確認 | 3 | — | Status: **Human Gate 2 pending; implementation and execution are not |
| [step-83-full-capability-human-acceptance.md](../plans/step-83-full-capability-human-acceptance.md) | 493 | 要確認 | 1 | — | Status: **Human Gate 2 pending; implementation not authorized** |
| [step-83-sanitized-failure-diagnostics-results.md](../plans/step-83-sanitized-failure-diagnostics-results.md) | 146 | 要確認 | 0 | — | Status: **implemented; Product and Evidence findings closed; offline verification complete** |
| [step-83-sanitized-failure-diagnostics.md](../plans/step-83-sanitized-failure-diagnostics.md) | 464 | 要確認 | 2 | — | Status: **Human Gate 2 pending; implementation not authorized** |
| [two-tool-task-selection-results.md](../plans/two-tool-task-selection-results.md) | 47 | 要確認 | 2 | — | — |
| [two-tool-task-selection.md](../plans/two-tool-task-selection.md) | 236 | 要確認 | 1 | — | — |
| [zot-agents-context-discovery-results.md](../plans/zot-agents-context-discovery-results.md) | 76 | 要確認 | 1 | — | — |
| [zot-agents-context-discovery.md](../plans/zot-agents-context-discovery.md) | 346 | 要確認 | 1 | — | — |
| [zot-first-cli-agent-runtime-results.md](../plans/zot-first-cli-agent-runtime-results.md) | 112 | 要確認 | 2 | — | — |
| [zot-first-cli-agent-runtime.md](../plans/zot-first-cli-agent-runtime.md) | 371 | 要確認 | 1 | — | — |
| [zot-first-tui-results.md](../plans/zot-first-tui-results.md) | 103 | 要確認 | 1 | — | — |
| [zot-first-tui.md](../plans/zot-first-tui.md) | 675 | 要確認 | 5 | — | — |
| [zot-local-work-tools-results.md](../plans/zot-local-work-tools-results.md) | 62 | 要確認 | 2 | — | — |
| [zot-local-work-tools.md](../plans/zot-local-work-tools.md) | 787 | 要確認 | 2 | — | — |
| [zot-provider-neutral-multi-turn-events-results.md](../plans/zot-provider-neutral-multi-turn-events-results.md) | 82 | 要確認 | 0 | — | — |
| [zot-provider-neutral-multi-turn-events.md](../plans/zot-provider-neutral-multi-turn-events.md) | 283 | 要確認 | 5 | — | — |
| [zot-skills-discovery-results.md](../plans/zot-skills-discovery-results.md) | 70 | 要確認 | 1 | — | — |
| [zot-skills-discovery.md](../plans/zot-skills-discovery.md) | 436 | 要確認 | 1 | — | — |

## 集計と次の段階

- 初期Increment 2〜9：16ファイル、2,170行。全てアーカイブ済み。
- 第一段階で棚卸しした計画文書：110ファイル、29,379行。
  pointer維持1件、残す8件、要確認97件、アーカイブ済み4件（230行）。
- 今回のアーカイブ合計：20ファイル、2,400行。行数は移動前後で不変。
- 今回の対象に対するコード内のファイル名参照は検出されなかった。

承認された20ファイルのアーカイブと参照更新は完了した。
要確認の計画は、結果との対応・状態差・後継incrementを本文で調べてから分類を確定する。
Increment 10以降は別の整理単位として扱い、全初期文書の整理完了とはしない。

## 原文との差と検証

- 対象20ファイルを移動し、移動文書の相対リンクと、Increment 146・この一覧の参照リンクを更新した。
- 移動前の保存snapshotと照合し、本文の差がMarkdownリンクの宛先更新だけであることを確認する。
  構造・状態・事実・command・設定・schema・例・外部URL・本文中の歴史的pathは変更していない。
- ステータス抜粋内の相対リンクは、この一覧から同じ原文へ到達するようpathを調整した。
- 概要表では過去の細かな実装・command・検証件数を省略し、リンク先の原文を保持した。
- 完了は既存結果文書の記載の確認であり、今回production動作を再検証した意味ではない。
- 対象20ファイルの移動先・行数・本文差分、移動に関係する相対リンク、旧pathへのMarkdownリンク残存を確認する。
- `git diff --check`を行う。実装変更がないためproduct test・gate・provider callは行わない。

## 後続の利用者判断と調査

利用者の「じゃあの残そうか　インクリメント50まで調査して」により、一次分類で「残す」とした
計画文書8ファイルは現在位置に残す。移動・本文改訂は行わない。
Increment 10〜50の調査・分類は[別の棚卸し](increments-10-50-inventory.md)へ記録した。
調査後、利用者の追加指示により17を含むアーカイブ候補38ファイルを`docs/history/increments/`へ移動した。
29・37と計画文書8ファイルは現在位置に残す。移動結果と検証範囲は上記の別棚卸しを参照する。
