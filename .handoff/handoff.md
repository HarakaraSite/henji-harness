# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2、increment 3、increment 4は完了。increment 5はlocal実装、review GO、offline gate 78/78を完了。初回production attemptで`bash`一回と`bash_output`二回により60,050 bytes、1,201行、末尾markerまでのreadbackは成立したが、次のprovider responseがreasoningだけでvisible contentを空にし`empty_terminal_result`となったturnは未commit。human gate全体とユーザー受入は未完了。同じTUI processでrecoverable taskをeditorへ戻すUIが未接続で再送不能だったことと、idle Ctrl-Cをshell同様の入力buffer clearにする要望を通常利用inboxへ保存
- 次: increment 5 human gateを再試行するかユーザー判断を受ける。再試行はTUI processを再起動し、同じSession turn 0から同じpromptを送る
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: increment 5のscopeは計画、local実装・検証・review・初回production attempt結果はresultsを正本とする。初回attemptの診断IDは`ad50975f-e366-4c02-878d-a1d762f6b541`。再試行は未認可・未実施。グローバル`~/.codex/AGENTS.md`から旧checkpoint追記規則は削除済み。今回の上限はstdout/stderr captureだけであり、既存`bash`がworkspace内へ直接巨大fileを作れる権限の制限はF24候補のまま。追加実装、push/tag/publish/releaseは未実施。未追跡`_refs/*`は変更しない

### Legacy Spike2 and operations transfer reconciliation

- 状態: archived Spike2はProposal不在とcross-binding P1により最終結果NO-GO。後続のDefinition/Revision/Admission cycle（Step 78–80）は完了結果を保持する。source/target/transfer ledgerの現所有と範囲は未確認のまま、移管・採用・authority継承を判断できないdormant topic
- 次: accessibleなoperations source、transfer ledger、対応するsource/target Recordsを取得してownerとdispositionを確定する
- 正本: `archive/README.md`、`archive/safety-spikes/docs/plans/admission-builder-spike-2.md`、`archive/safety-spikes/docs/spikes/admission-builder-spike-2-results.md`、`archive/history/docs/roadmap-inputs/henji-agent-definition-composition-boundary.md`
- 注意: local scopeの確認と関連henji/henjibot/abyssaeon handoffの照合ではoperations正本・transfer ledgerを確認できなかった。planner inputが示す旧operations正本（未アクセス）は`discovery/concepts/deno-self-revising-agent-harness/README.md`（`/tmp/planner-inputs/henji-agent-definition-resource-identity.md`）。archived safety workは明示判断なしに再開せず、移管先のRecordだけで完了・承認継承と判断しない
