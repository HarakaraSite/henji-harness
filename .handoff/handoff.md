# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から9とWeb searchのproduction受入は完了。承認済みのdirectory再編では、active Agent sourceを`core`、`definitions`、`provider`、`tools`、`session`、`runtime`、`worker`、`cli`、`validation`へ整理し、公開API facadeとinstalled/operator shell pathを維持した。到達不能な四module、壊れたretained UI acceptance入口、production非到達だった旧extension一式を削除し、現行source graphに未到達TypeScript fileは残っていない。focused Worker testとauthoritative `v0:gate`は成功し、review findingはない。sourceとJSR `0.1.0-alpha.2`準備をcommit `7a1ae74`として`main`へpushし、clean worktreeからJSRへpublishした。registry metadataとexact-version importで公開を確認済み
- 次: ユーザーと次の通常利用incrementの目的を決める
- 正本: `v0/agent/README.md`、`deno.v0.json`、`jsr.json`、`docs/roadmap.md`、`docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/increments/increment-8.md`、`docs/increments/increment-8-results.md`、`docs/increments/increment-9.md`、`docs/increments/increment-9-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: Web searchをmodel内包機能または専用AgentDefinitionのどちらとして位置付けるかは将来の設計メモとして保持する。JSR `0.1.0-alpha.2`はimmutable。tagとForgejo releaseは未依頼・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
