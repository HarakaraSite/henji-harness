# Handoff

## Records

### Project structure and canonical sources

- 状態: 通常利用increment 2から5は完了。increment 6の初期実装は`b19b5dd`でcommit済み。その後の通常利用で、端末の`cbreak: true`によりidleの物理Ctrl-CがSIGINT経路へ入り二回押下を要求する不備が判明した。`cbreak: false`へ修正し、focused verification、provider-free実PTY、changed-lines review GO、修正版authoritative offline gate 84/84を完了。通常利用での再確認とユーザー受入は未実施
- 次: 通常のproduction retained TUIで、draftがCtrl-C一回でclearされ同じSessionのreadyへ戻ることをユーザーが再確認する
- 正本: `docs/concepts/experience-driven-self-revision.md`、`docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`、`docs/increments/increment-2.md`、`docs/increments/increment-2-results.md`、`docs/increments/increment-3.md`、`docs/increments/increment-3-results.md`、`docs/increments/increment-4.md`、`docs/increments/increment-4-results.md`、`docs/increments/increment-5.md`、`docs/increments/increment-5-results.md`、`docs/increments/increment-6.md`、`docs/increments/increment-6-results.md`、`docs/experience/normal-use-inbox.md`
- 注意: Ctrl-C修正と対応するtest・plan/results・handoffは未commit。provider/credentialを使う残りのproduction human gateとcommit、push、tag、publish、releaseは未承認・未実施。今後のJSR publishは`docs/operations/jsr-publish.md`に従う。未追跡`_refs/*`は変更しない
