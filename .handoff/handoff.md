# Handoff

## Records

### 通常利用の改善 — 次期Increment 69・70（未着手）

- 状態: Increment 65〜68、第三者review対応、JSR releaseまで完了。binary `0.2.1`配置、`origin/main=729376b5`で同期、
  作業ツリーclean。**次のIncrementは未着手**。
- 次: roadmapの予定順に進める。
  - **Increment 69**: `web_search`(Sonar)をsubagent化する。着手時は`docs/increments/increment-69.md`として計画
    （対象、slot/composition seamの再利用、attribution、検証、Human Gate）を作成し、利用者承認後に実装。
  - **Increment 70**: `tool:read|write|edit|bash`のsame-identity overrideを扱う。同様に計画・承認してから実装。
- 正本: `docs/roadmap.md`のProvider外部化節と通常利用改善節、`docs/increments/increment-65.md`〜`increment-68.md`、
  `docs/experience/normal-use-inbox.md`、`docs/operations/jsr-publish.md`、`docs/architecture/henji-host-agent-worker.md`。
- 注意: 各Incrementは個別計画とHuman Gate承認が必要。構想/architecture/roadmapの正本変更はIncrement承認とは別に
  明示承認を得る。未採用のfollow-up候補（実装時に正本へ反映するか判断）:
  - delegated plannerのmodel/effort差し替え（現状はinstruction/toolsのみ。`increment-65.md`）
  - `openai-chat`のgpt-6-astra（`none`を持たずtool turn不可。`increment-68.md`）
  - architecture `henji-host-agent-worker.md` 406行付近の「delegated plannerはplanner default」記述の整合
  - S6 busy表示のspinner化（`docs/experience/normal-use-inbox.md`）

### 環境・配置（再開時の注意）

- binary: `0.2.1`（build `1dbc0aa6a7e89a5efef4def9a899a54101a179d6b3917f87cd0b96eb6c5d9aeb`、binary SHA-256
  `3d5da412f5eb2b83e3511cb6304650eedd4098b080e741c16579e846461044b9`、embedded runtime
  `b66539101a57fedcb9ff2f4a0387e19e88bc030ad414d8ea352ae8b20ca32ac4`、source`b4a232be…`、`sourceDirty=false`）。
  installed launcher `~/.local/bin/henji`。buildは`deno task --config deno.v0.json henji:compile`（Deno 2.9.6厳密）。
- JSR: `@henji/harness@0.2.1`がlatest。`0.2.0`はpackaged READMEがstaleなままimmutableに残置。publishは
  `docs/operations/jsr-publish.md`の手順（README例のversion更新→gate→push→clean worktree→dry-run→device認証→
  registry/import検証→cleanup）。
- provider: built-in idは`openrouter-chat`/`openrouter-responses`/`openai-chat`/`openai-responses`。旧
  `openrouter`/`openai`は削除（互換aliasなし）。宣言providerは`providers/*.json`、protocolは
  `openai-chat-completions`または`openai-responses`のみ。credentialは`~/.config/henji-harness/{openrouter,openai}-api-key`
  （0600・単一トークン）。
- 検証の注意: TUI/pty検証は**隔離XDG**で行い、実configへ`default-selection.json`等を書かない。
- 未実施: Git tag、Forgejo Release、release automation（CIでのbinary build等）。releaseは安定後に別途計画する
  （利用者判断: ずっと先）。
- 履歴DB: このrepo workspaceの旧state DBはlegacy providerState非互換のため削除済み。他workspaceのstate DBは
  旧chat evidenceを含むとreadbackが失敗するため、必要時に同様に切捨てる。
- active external revision: `local/henji-base@sha256:82d67dd2…`。
