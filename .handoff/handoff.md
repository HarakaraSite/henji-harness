# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から6は完了し、increment 6はproduction retained TUIで2026-09-07に受入済み。increment 7はHenji-ownedな`web_search`と交換可能backend、初期OpenRouter `perplexity/sonar` backend、回答と順序付きcitationを実装した。focused verification、コード／テストreview、authoritative offline `v0:gate`は成功し、未解決Blocker/P1/P2は0。production retained TUI human gateとユーザー受入は未実施
- 次: ユーザーの別の明示承認後、`docs/increments/increment-7.md`のproduction human gateを一回実施する。`tool> web_search`、visible answer/source、main → Sonar → main evidence、実測usage/cost/所要時間を確認して受入判断へ進む
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: OpenRouter Sonarの一回のlive probeは計画前にユーザー承認済みで完了し、temporary artifactは`/tmp/henji-openrouter-sonar-probe-20260907/`にある。実装とoffline gateではprovider requestやcredential読取りを行っていない。既存OpenRouter credentialをproduction backendからrequest時に再利用し、値とAuthorizationをevidenceへ記録しない。production human gate、push、tag、publish、releaseは未承認・未実施。commitはユーザー指示によりlocal実装・review・文書を対象として行う。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
