# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から11、Web search受入、source再編・分割、JSR `0.1.0-alpha.2`公開は完了済み。increment 11はユーザー起動型production CLI基本E2Eを実装し、focused 5 tests、code review、authoritative offline `v0:gate`一回が成功。利用者承認後のlive E2E一回もretryなしでpassし、実provider 2 requests、`read`一回、final、Host commit/accepted ack、保持証拠を確認した
- 次: 利用者が次の通常利用incrementまたはremote反映を選択する
- 正本: `docs/increments/increment-11.md`、`docs/increments/increment-10.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`v0/agent/README.md`、`deno.v0.json`
- 注意: live run root `/tmp/henji-production-e2e-fb8d2583c1a48eee`を成功証拠として保持。execution `bf75b812-9e84-4f53-8224-3790609f0bf1`、provider evidence `d72d6211-7e99-49f3-a4dd-c8b4f3728f12`。credential値とAuthorizationは表示していない。increment 11のlocal commitは完了。push、publish、tag、releaseは未依頼・未実施。未追跡`_refs/*`は変更しない
