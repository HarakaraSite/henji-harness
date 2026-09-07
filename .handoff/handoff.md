# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から6は完了。increment 7はHenji-owned `web_search`とOpenRouter Sonar backendを実装し、production Session `59a37c41-5f6d-4607-a700-39be01f857cd`でmechanism成立とgrounding不足を確認した。increment 8はspecific question、Sonarのsearch-result限定回答、親finalのsource URL・不足・推論表示、`medium` contextをlocal実装済み。focused verification、コード／テストreview、authoritative offline `v0:gate`は成功し、未解決Blocker/P1/P2は0。increment 8のproduction human gateとユーザー受入は未実施
- 次: ユーザーの別の明示承認後、新しいWorker generationで`docs/increments/increment-8.md`のproduction human gateを一回実施し、groundingと実測usage/costを受入判断する
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/increments/increment-8.md`、`docs/increments/increment-8-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: increment 8実装とoffline gateではprovider requestやcredential読取りを行っていない。既存OpenRouter credentialはproduction backendがrequest時に再利用し、値とAuthorizationをevidenceへ記録しない。既に起動中のWorker generationにはdisk上のincrement 8変更が反映されない。directory構成と未参照fileの調査はincrement 8のproduction受入後の別計画であり、現時点では移動・削除していない。commit、push、tag、publish、releaseは未承認・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
