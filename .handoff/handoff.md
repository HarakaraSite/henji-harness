# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から9は完了。increment 9はSonarのlocal citationを直接source linkへ正規化し、親へ裸の`[n]`を渡さない処理とgrounding guidelineを実装した。offline `v0:gate`は89 tests成功。production Session `dd984286-a8bb-41ae-b177-b0e49f30d150`の三turnで直接URL、不足と推測の表示、根拠URLを求める追質問への応答、実測usage/costを確認し、2026-09-08にユーザーがWeb searchを受入済み。Web searchをmodel内包機能または専用AgentDefinitionのどちらとして位置付けるかは将来の設計メモとして保持する
- 次: `v0/agent`のentrypoint、dynamic load、Deno task、public export、testと文書参照をread-onlyで調査し、directory構成案と未参照file候補を分けた初期計画を作る
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/increments/increment-8.md`、`docs/increments/increment-8-results.md`、`docs/increments/increment-9.md`、`docs/increments/increment-9-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: production human gateは既存OpenRouter credentialを使ったが、値とAuthorizationはevidenceへ記録していない。directory調査はread-onlyで開始できるが、再編・削除は初期計画のユーザー承認後に行う。commit、push、tag、publish、releaseは未承認・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
