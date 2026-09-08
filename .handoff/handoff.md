# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から11、Web search受入、source再編・分割は完了済み。increment 11のproduction CLI基本E2Eはoffline gateと一回のlive E2Eに成功。release candidate `2a57d73`をForgejo `main`へpushし、JSR `@henji/harness@0.1.0-alpha.3`を同commitから公開、registry metadataとexact-version importを確認した
- 次: 利用者が次の通常利用incrementを選択する
- 正本: `docs/increments/increment-11.md`、`jsr.json`、`README.md`、`docs/operations/jsr-publish.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`v0/agent/README.md`、`deno.v0.json`
- 注意: live run root `/tmp/henji-production-e2e-fb8d2583c1a48eee`を成功証拠として保持。execution `bf75b812-9e84-4f53-8224-3790609f0bf1`、provider evidence `d72d6211-7e99-49f3-a4dd-c8b4f3728f12`。credential値とAuthorizationは表示していない。JSR release worktreeは検証後に削除済み。tagとForgejo releaseは未依頼・未実施。未追跡`_refs/*`は変更しない
