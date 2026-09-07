# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から9とWeb searchのproduction受入は完了。directory再編とJSR `0.1.0-alpha.2`公開も完了済み。続く巨大file分割では、`v0/tui/controller.ts`の公開APIとTUI挙動を維持したまま、公開契約、slash command、editor、overlayを専用moduleへ分離し、2,311行から1,608行へ縮小した。help、session picker/resume、history、context overlayのcharacterization testを追加し、focused test、check、fmt、lint、`git diff --check`、authoritative `v0:gate`は成功。実装をcommit `5dbee69`として記録済み
- 次: 次の巨大file分割対象を決める
- 正本: `v0/tui/controller.ts`、`v0/tui/controller_contract.ts`、`v0/tui/controller_editor.ts`、`v0/tui/controller_overlay.ts`、`v0/tui/slash_command.ts`、`tests/v0/tui_controller_overlay_test.ts`、`deno.v0.json`、`v0/agent/README.md`、`jsr.json`、`docs/roadmap.md`、`docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/increments/increment-8.md`、`docs/increments/increment-8-results.md`、`docs/increments/increment-9.md`、`docs/increments/increment-9-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: controller分割のpush、publishは未依頼・未実施。Web searchをmodel内包機能または専用AgentDefinitionのどちらとして位置付けるかは将来の設計メモとして保持する。JSR `0.1.0-alpha.2`はimmutable。tagとForgejo releaseは未依頼・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
