# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から12、Web search受入、source再編・分割は完了済み。increment 13はcommit `2f346bd`で設定可能なprovider deadline、専用timeout診断・表示、固定footer 2段目を実装した。通常利用Session `84597d99`では4 model・15 provider requestsがtimeoutなくcommitされ、footerのSession表示も受入済み。follow-upとしてfooterの`cwd:`と`effort:` labelを削除し、focused test、type check、format、lint、diff checkに成功した
- 次: 利用者が省スペースfooterを通常利用確認する
- 正本: `docs/increments/increment-13.md`、`docs/experience/normal-use-inbox.md`、`README.md`、`v0/agent/README.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`
- 注意: provider deadline既定値は120,000 msを維持する。将来provider切替を実装する場合はfooterへprovider identityも常時表示する候補を通常利用メモへ保存した。実provider timeout表示は未観測。installed launcher更新、push、tag、publish、releaseは未依頼・未実施。credential値とAuthorizationは表示・保存していない。未追跡`_refs/*`は変更しない

### Next JSR package description

- 状態: 利用者は次回JSR publishで、Henjiが何であるかを現在より詳しく説明する方針を選択した。JSR Overviewはdefault entrypointの`@module`をREADMEより優先する現設定のため、`mod.ts`のmodule documentationを主対象とし、`README.md`も同じ説明へ整合させる
- 次: 次回publish準備時に、目的、人間の承認を境界とする自己改訂、Host / Worker構成、現在のJSR公開範囲、最小利用例を説明へ反映する
- 正本: `mod.ts`、`README.md`、`docs/operations/jsr-publish.md`
- 注意: 公開済み`0.1.0-alpha.3`は変更せず、次のversion（現時点の候補は`0.1.0-alpha.4`）で反映する。READMEから参照するrelative documentはJSR publish対象に含まれるか確認する
