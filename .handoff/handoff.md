# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から12、Web search受入、source再編・分割は完了済み。increment 12は同一Session内のcurated OpenRouter root model/effort切替、検索picker、Session v3永続化、planner default分離を実装し、authoritative `v0:gate`（99 tests）と2-requestのlive production経路に成功した。変更はworking treeにあり未commit。既存release candidate `2a57d73`はForgejo `main`へpush済みで、JSR `@henji/harness@0.1.0-alpha.3`を同commitから公開済み
- 次: 利用者がproduction TUIでincrement 12を通常利用するか、次の通常利用incrementを選択する
- 正本: `docs/increments/increment-12.md`、`README.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`v0/agent/README.md`、`deno.v0.json`
- 注意: increment 12 live run root `/tmp/henji-increment12-live-a0c10d05d8d9990d`とSession `94d53a9a-b878-4950-b4d7-f7407db98b05`を成功証拠として保持。credential値とAuthorizationは表示・保存していない。commit、push、tag、publish、releaseは未依頼・未実施。未追跡`_refs/*`は変更しない

### Next JSR package description

- 状態: 利用者は次回JSR publishで、Henjiが何であるかを現在より詳しく説明する方針を選択した。JSR Overviewはdefault entrypointの`@module`をREADMEより優先する現設定のため、`mod.ts`のmodule documentationを主対象とし、`README.md`も同じ説明へ整合させる
- 次: 次回publish準備時に、目的、人間の承認を境界とする自己改訂、Host / Worker構成、現在のJSR公開範囲、最小利用例を説明へ反映する
- 正本: `mod.ts`、`README.md`、`docs/operations/jsr-publish.md`
- 注意: 公開済み`0.1.0-alpha.3`は変更せず、次のversion（現時点の候補は`0.1.0-alpha.4`）で反映する。READMEから参照するrelative documentはJSR publish対象に含まれるか確認する
