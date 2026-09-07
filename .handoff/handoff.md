# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から6は完了。increment 7はHenji-owned `web_search`とOpenRouter Sonar backendを実装した。increment 8はSonar groundingを改善したが、production Session `0aa262b8-724e-462c-9340-249703627b36`で親finalがsearchごとの`[n]`をURLなしで転載し、裏付けのない具体的予測を加えたため未受入。increment 9は有効な`[n]`を直接source linkへ正規化し、親へ裸のlocal番号を渡さない処理とguidelineをlocal実装済み。focused verification、コード／テストreview、authoritative offline `v0:gate`は89 tests成功し、未解決Blocker/P1/P2は0。Web searchをmodel内包機能または専用AgentDefinitionのどちらとして位置付けるかは設計メモへ記録済み
- 次: ユーザーの別の明示承認後、新しいWorker generationで`docs/increments/increment-9.md`のproduction human gateを一回実施し、直接URL、未裏付け事実、実測usage/costを受入判断する
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/increments/increment-7.md`、`docs/increments/increment-7-results.md`、`docs/increments/increment-8.md`、`docs/increments/increment-8-results.md`、`docs/increments/increment-9.md`、`docs/increments/increment-9-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: increment 9実装とoffline gateではprovider requestやcredential読取りを行っていない。前回production human gateは既存OpenRouter credentialを使ったが、値とAuthorizationはevidenceへ記録していない。citation正規化後のproduction再確認には新しいWorker generationと別の明示承認が必要。directory構成と未参照fileの調査はWeb search受入後の別計画であり、現時点では移動・削除していない。commit、push、tag、publish、releaseは未承認・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
