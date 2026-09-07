# Handoff

## Records

### JSR alpha publication

- 状態: `@henji/harness@0.1.0-alpha.1`のMIT公開準備を完了。Agent Definition APIだけを`mod.ts`から公開し、JSR slow-types修正、公開対象32ファイルのdry-run、authoritative offline gate 84/84を通過した。実公開、push、tagは未実施
- 次: 利用者承認後、公開準備commitを含む`main`をForgejoへpushし、同じcommitからJSRへpublishする
- 正本: `jsr.json`、`mod.ts`、`LICENSE`、`v0/agent/worker_agent_api.ts`
- 注意: CLI/TUI、tests、docs、archive、`_refs/*`は初回JSR packageの公開対象外。JSR公開versionは差し替え・削除できないため、publish前にcommitとdry-run対象の一致を再確認する

### Project structure and canonical sources

- 状態: 通常利用increment 2から5は完了。increment 6はrecoverable input、idle Ctrl-C、既存work toolのcomponent化についてlocal実装、focused verification、bounded implementation review GO、authoritative offline gate 84/84を完了。production human gateとユーザー受入は未実施
- 次: `docs/increments/increment-6.md`のproduction retained TUI human gateを実施するかユーザー判断を受ける
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: plan/resultsに記録したlocal成果は未commit。計画・実装開始前の文書は`f466c23`でcommit済み。production/provider/credential操作とpush/tag/publish/releaseは未承認・未実施。未追跡`_refs/*`は変更しない
