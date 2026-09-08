# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から9、Web search受入、source再編・分割、JSR `0.1.0-alpha.2`公開は完了済み。commit `49380f1`後の全体整合reviewで確認したP1は`jsr.json`へpublic dependency closureを追加してJSR dry-run成功。P2は承認済みincrement 10によりproduction `agent:run`をTUIと同じheadless Host / Worker経路へ統合した。focused 40 tests、check、fmt、lint、production invalid-input smoke、第三者re-review GO、authoritative offline `v0:gate`一回がすべて成功し、local実装・検証・commitは完了
- 次: 利用者がproduction `agent:run`のlive確認を実施するか判断する
- 正本: `docs/increments/increment-10.md`、`jsr.json`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`v0/agent/README.md`、`deno.v0.json`
- 注意: 外部providerを呼ぶlive評価は実行しておらず、固定credential fileの内容も確認していない。push、publish、tag、releaseは未依頼・未実施。未追跡`_refs/*`は変更しない
