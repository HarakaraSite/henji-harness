# Pi / Zot のスラッシュコマンド・CLI option 調査

作成日: 2026-09-22

## 目的

参照実装Pi（TypeScript）とZot（Go）のユーザー向けスラッシュコマンドとCLI optionを、pinned snapshotから
抽出し、Henjiへ採用する価値のある差分を検討する。ここでの記載は調査であり、採用や実装認可ではない。
採用候補は[`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)へ記録する。

## 対象snapshot

- Pi: `_refs/pi`、commit `08dc60bc52d89d6823a9738cc90b1916e5e446e5`、`@earendil-works/pi-coding-agent@0.85.1`、
  binary `pi`、config `~/.pi`。
- Zot: `_refs/zot`、commit `f60e492e551892e737d24a7eaf7730f1f60b75af`、`github.com/patriceckhart/zot`（Go 1.25）、
  binary `zot`、config `$ZOT_HOME`（`$XDG_STATE_HOME/zot`）。
- Henji現行: slash `/help /new /sessions /rename /provider /model /effort /recall /exit`
  （`v0/tui/slash_command.ts`）。CLI subcommand `run / sessions / history / module / tool / diagnostics`
  （`v0/agent/cli/henji_cli.ts`）。TUI flag `--agent --definition-revision --continue --session --no-session
  --max-steps --provider-timeout-ms --root-provider`（`v0/agent/cli/tui_cli.ts`）。

## Pi

### Slash commands（`core/slash-commands.ts:19-43`、dispatch `modes/interactive/interactive-mode.ts:2964-3156`）

| command | args | 目的 |
|---|---|---|
| `/settings` | — | 設定メニュー |
| `/model` | `[provider/model]` | model選択（picker、Ctrl+Sで既定保存） |
| `/tree` | — | session tree／branch移動 |
| `/thinking` | `[level]` | reasoning level（picker、Ctrl+Sで既定保存） |
| `/scoped-models` | — | Ctrl+P cycling対象modelの有効/無効 |
| `/export` | `[path]` | session export（HTML既定、`.jsonl`でJSONL） |
| `/import` | `<file.jsonl>` | JSONLからsession import・resume |
| `/share` | — | secret GitHub gistとして共有 |
| `/copy` | — | 直近assistantメッセージをclipboardへ |
| `/name` | `[name]` | session表示名 |
| `/session` | — | session情報と統計 |
| `/changelog` | — | changelog |
| `/hotkeys` | — | keybinding一覧 |
| `/fork` | — | 過去user messageから新session |
| `/clone` | — | 現在位置でsession複製 |
| `/trust` | — | project trust判断を保存 |
| `/login` / `/logout` | `[provider]` | provider auth（OAuth/API key） |
| `/new` | — | 新session |
| `/compact` | `[prompt]` | 手動context compaction |
| `/resume` | — | session picker |
| `/reload` | — | keybindings/extensions/skills/prompts/themes/context再読込 |
| `/quit` | — | 終了 |

- 拡張: `/skill:<name>`、prompt template `/<name>`、extension `registerCommand`。
- 非slash入力: `!command`（shell実行、出力をmodelへ）、`!!command`（context外）、`@file`（file参照）。
- hidden: `/debug`等。`/help`は無く`/hotkeys`と`pi --help`が担う。

### CLI options / subcommands（`cli/args.ts:71-249`、`main.ts:571-601`）

- 出力mode: `--mode text|json|rpc`、`-p/--print`、`--export <in> [out]`、`--list-models [search]`。
- session: `-c/--continue`、`-r/--resume`、`--session <path|id>`、`--session-id <id>`、`--fork`、
  `--session-dir`、`--no-session`、`-n/--name`。
- model/provider: `--provider`、`--model`（`provider/id`、`:thinking`）、`--models`（glob/fuzzy cycling）、
  `--thinking <level>`、`--api-key`。
- prompt: `--system-prompt`、`--append-system-prompt`。
- 制御: `--tools/-t`、`--exclude-tools/-xt`、`--no-tools/-nt`、`--no-builtin-tools/-nbt`、
  `--extension/-e`、`--no-extensions`、`--skill`、`--no-skills`、`--prompt-template`、`--theme`、
  `--no-context-files/-nc`、`--approve/-a`、`--no-approve/-na`、`--offline`、`--tui-mode regular|fullscreen`、
  `--verbose`。
- subcommand: `install/remove/uninstall/update/list/config`（package/resource管理）、
  `auth check|print-api-key|print-bearer-token`。`server`/`client`は`PI_EXPERIMENTAL=1`のdev-only。

## Zot

### Slash commands（dispatch `packages/agent/modes/interactive.go:4467-4721`、catalog `slash_suggest.go:39-69`）

| command | args | 目的 |
|---|---|---|
| `/help` | — | keybindingとcommand一覧 |
| `/login` / `/logout` | `[provider]` | credential管理（API key/OAuth） |
| `/model` | `[id]` | model選択（picker） |
| `/llama` | — | llama.cpp router model管理（未設定時hidden） |
| `/reasoning` | — | reasoning level picker |
| `/settings` | — | 永続設定dialog |
| `/sessions` | — | 過去session picker（resume/rename/delete） |
| `/session` | `timeline\|export [path]\|import <path>\|fork\|tree` | 現session操作 |
| `/jump` | `[text]` | 過去turnへスクロール |
| `/btw` | `[question]` | 本transcriptに残らないside-chat |
| `/skills` | — | `SKILL.md`一覧・preview |
| `/compact` | — | transcriptを要約・置換してcontext解放 |
| `/study` | `[file\|dir]` | 全体を読むcanned prompt |
| `/jail` / `/unjail` | — | toolをcwdへ限定／解除 |
| `/reload-ext` | — | extension hot reload |
| `/telegram` / `/tg` | `connect\|disconnect\|status` | Telegram bridge |
| `/swarm` | `list\|new\|kill\|remove\|logs\|send\|resume` | 背景sub-agent監督 |
| `/clear` / `/exit` | — | 履歴clear／終了 |
| `/skill:<name>` | `[request]` | skillをprompt展開 |
| `/cd` | `<path>` | sessionのcwd変更（hidden） |
| extension commands | 例 `/mcp ...` | `register_command` |

- 非slash: `!command`（shell実行）、`@` file picker。

### CLI options / subcommands（`packages/agent/args.go:138-326`、router `cli.go:208-241`）

- 出力mode: `-p/--print`、`--stream`、`--json`（NDJSON）、`--rpc`（NDJSON JSON-RPC）、`--swarm-agent <path>`。
- session: `-c/--continue`、`-r/--resume`、`--session <path>`、`--no-session`、`sessions prune`。
- model/provider: `--provider`、`--model`、`--api-key`、`--base-url`、`--reasoning <level>`、`--temperature`。
- prompt: `--system-prompt`、`--append-system-prompt`。
- 制御: `--no-tools`、`--tools <csv>`、`--max-steps`、`-e/--ext`、`--no-ext`、`--no-skill`、
  `--no-context-files`、`--insecure`、`--no-yolo`、`--cwd`。
- subcommand: `ext list|doctor|logs|enable|disable|remove|install`、`update`、`sessions prune`、
  `telegram-bot`、`run|pack|inspect|verify`（zotfile）、`rpc`。

## Henjiとの差分と採用候補

Henjiのproduct境界（Host-owned Surface、local、credentialはowner-only file、managed resourceは
Definition/instruction/tool、自己改訂は人間承認）を踏まえた候補。

### 有力候補

| 候補 | 参照 | 価値 | 規模・関係 |
|---|---|---|---|
| `run`の構造化出力（`--json` event stream / `--stream`） | Pi `--mode json`、Zot `--json`/`--stream` | 非対話実行の自動化・埋め込み。現在はfinal-only stdout／failure JSONのみ | 中。F12（data-only event）と親和 |
| 会話ログの`/jump`（過去turnへ移動） | Zot `/jump` | 長いSessionの閲覧性。PageUpに加えturn単位移動 | 小。F01/F05 |
| 手動`/compact`（checkpoint/compactionの人間起動） | Pi `/compact`、Zot `/compact` | 自動compaction停止（Increment 29）後、contextを人間が明示的に圧縮 | 中。F05/F06 |
| Session export/import（`henji history`はexportあり、import/branchなし） | Pi `/export`/`/import`、Zot `/session export|import` | Sessionの移送・再開。durable history v7のexportを入力に戻す | 中〜大。F04/F05/F25 |
| `!command` shell escape / `@file` reference | Pi/Zot | 素早いshell実行とfile参照。Henjiはbash toolとpath補完のみ | 小〜中。F01/F10 |
| model cycling shortcut | Pi Ctrl+P、Zot Ctrl+1..9 | provider横断の素早いmodel切替。現在は`/model` picker | 小。F01/F02 |
| `henji sessions prune` | Zot `sessions prune` | 古いSessionの整理。現在は削除手段が限定的 | 小。F04/F05 |
| configurable keybindings | Pi `keybindings.json`、Zot設定 | keybindingの利用者設定 | 中。F01/F10 |

### P1（`run`の構造化出力）の利点

現在の`henji run`はfinal text（成功時）またはfailure JSON（失敗時）のみをstdoutへ出し、途中eventやlive textを
出さない。構造化出力（Pi `--mode json`、Zot `--json`/`--stream`）の利点:

- **自動化・他ツール連携**: CI、script、editor plugin、別agentがper-eventで消費でき、final textのparseに依存しない。
- **live progress**: `--stream`でassistant textやtool activityを逐次表示でき、wrapper UIが進捗を描画できる。
  TUIは内部のpresentation contractでこれを行うが、headless CLIには無い。
- **観測・診断**: turn start/end、tool call/result、failure diagnosticをmachine-readableに得られ、SQLiteを
  読まずにデバッグできる。
- **埋め込み**: editor plugin、Web UI、bot等がsubprocessとしてHenjiを駆動し、eventを描画できる。Host/Worker
  protocolは既にdata-only（F12）なので、そのHost-ownedな一部をCLIへ露出するのは自然な拡張。
- **テスト**: event列に対して決定的にassertできる。

設計上の注意: どのeventをstable subsetとして出すか（Worker内部eventをそのまま漏らさずHost-ownedなCLI event
schemaを定義する）、NDJSON形式、credential/Authorizationをeventへ含めない、`--stream`（human向けlive text）と
`--json`（machine向け）の範囲、既存final-only出力との切替、F10/F12との整合。

### 大きい／慎重に扱う候補

- **Session tree/branch/fork**（Pi `/tree`/`/fork`/`/clone`、Zot `/session fork|tree`）: Henjiのcanonical turnと
  durable historyに分岐の意味論を追加する大きな変更。F18/F05と関係。採用時はarchitecture判断が必要。
- **`/btw` side-chat**（Zot）: 本transcript外の会話。Host/Workerのstate境界を増やす。
- **`/swarm`／async subagent**（Zot）: 既存のA7候補（非同期・並行subagent）と同じ領域。
- **extension／package管理**（Pi install/update、Zot ext）: managed resourceの一般化（E2/F24）と同じ領域。
- **`/login`／`/logout`等のcredential UI**: Henjiはowner-only credential fileを採用（S2で別途検討）。
- **画像入力（`@image`／clipboard paste）**（Pi `ctrl+v`、Zot `ctrl+v`＋`inline_images_enabled`）: transcriptの
  content part、provider別encoding（OpenAI `image_url`、Anthropic image block、Gemini `inlineData`）、tool result、
  TUI表示、catalog capability（vision）が必要。E5とIncrement 103で先送りしたcapabilityに依存する。

### 採用しない／対象外

- self-update、Telegram/messaging bridge、llama.cpp router管理、project trust/`--approve`（trusted-local前提）、
  Piのdev-only `server`/`client`。
- `/jail`/`--insecure`/`--no-yolo`等のsandbox・permission系は、Henjiのtrusted-local方針とR3の別increment領域。

## 補足詳細

### Pi

- 出力mode解決（`main.ts:111-122`）: `--mode rpc`→rpc、`--mode json`→json、`--print`または非TTY→print、それ以外は
  interactive。`--mode json`はsession eventをJSON linesで出し、`--mode rpc`は双方向JSONL（prompt/steer/
  followUp/state/model/thinking/queue/compaction/retry/bash/session/get_commands等）。
- 非slash入力（`docs/usage.md:22-35`）: `!command`（shell実行、出力をmodelへ）、`!!command`（context外）、
  `@file`（file参照）、`/`補完、`Tab`でpath補完。
- keybindings（`docs/keybindings.md`、`~/.pi/agent/keybindings.json`、`/reload`でhot reload）: `enter` submit、
  `shift+enter`/`ctrl+j` newline、`escape` interrupt、`ctrl+c` clear→exit、`ctrl+d` exit、`ctrl+l` model
  selector、`ctrl+p` cycle forward、`ctrl+s` save default、`shift+tab` thinking cycle、`ctrl+o` expand tools、
  `ctrl+g` external editor、`ctrl+v` paste image、session pickerのrename/delete等。
- config（`config.ts:537-572`）: `~/.pi/agent/settings.json`（global）、`.pi/settings.json`（project）、
  `keybindings.json`、`auth.json`、`models.json`、`trust.json`、`sessions/`、`prompts/`、`themes/`、`tools/`、
  `bin/`。override env `PI_CODING_AGENT_DIR`／`PI_CODING_AGENT_SESSION_DIR`、`--offline`／`PI_OFFLINE=1`。
- extension/prompt/skill: `/skill:<name>`、prompt template `/<name>`、extension `registerCommand`。RPCの
  `get_commands`はextension/prompt/skillのみを返しbuilt-in TUI commandは含めない（`docs/rpc.md:816-853`）。
- caveat: `/debug`等のhidden commandはautocompleteに出ない。`server`/`client`は`PI_EXPERIMENTAL=1`のdev専用で
  published binには含まれない。

### Zot

- mode（`args.go:14-30`、dispatch `cli.go:279-295`）: interactive（既定）、print（`-p`/piped stdin）、stream
  （`--stream`、assistant textをstdout・toolをstderr）、json（`--json`、NDJSON event）、rpc（`--rpc`、NDJSON
  JSON-RPC）、swarm-agent（`--swarm-agent <path>`、unix-socket inbox daemon）。RPC command: `hello`、`prompt`、
  `abort`、`compact`、`get_state`、`get_messages`、`clear`、`set_model`、`set_reasoning`、`get_models`、`ping`
  （`rpc.go:26-42`、`docs/rpc.md`）。任意authは`ZOTCORE_RPC_TOKEN`の`hello` handshake。
- 非slash入力: `!command`（shell実行）、`@` file picker（`[file:name]`/`[dir:name/]`chip）。
- keybindings（`help.go:12-27`、README）: `enter` submit（busy時queue）、`shift/alt+enter` newline、`tab`補完、
  `esc` cancel、`ctrl+c` exit/double-press、`ctrl+o` tool result expand、`ctrl+v` paste（image含む）、
  `ctrl+1..9` quick model slot、`@` file picker。
- skills discovery（`docs/skills.md:51-77`）: `.zot/skills`→`$ZOT_HOME/skills`→`.claude/skills`→
  `~/.claude/skills`→`.agents/skills`→`~/.agents/skills`。manifestをsystem promptへ、本文は`skill` toolで
  on-demand、`/skill:<name>`で明示展開、`disable-model-invocation`でmodelから隠す。
- config（`config.go:145-173`）: `$ZOT_HOME`（`$XDG_STATE_HOME/zot`等）。`config.json`、`auth.json`（0600）、
  `sessions/`、`models-cache.json`、`AGENTS.md`、`SYSTEM.md`、`skills/`、`themes/`、`extensions/`、`logs/`、
  `models.json`。persisted key（`config.go:26-143`）に`auto_compact_threshold`、`jail_by_default`、
  `tui_*`、`compact_mode`等。
- extension: subprocess JSON-RPC、`register_command`/`register_tool`、tool intercept、turn gating、
  assistant-text rewrite、`/reload-ext`でhot reload（`docs/extensions.md`）。
- caveat: `--max-steps`既定がREADME（50）とcode（unlimited）で不一致。`zot bot`はcommentのみで未実装。
  `/cd`はhelp/autocompleteからhidden。`slashCatalog`と`runSlash`は手動同期（`slash_suggest.go:37-38`）。

## 未確認

- Pi/Zotのpicker内のexact key semanticsや一部subcommandの細部はsnapshotの大きなcomponent fileに分散し、
  本調査ではhandlerの位置までに留めた。
- Henji側の現行surfaceは`v0/tui/slash_command.ts`とCLIのentryのみ確認し、keybindingの全数は監査していない。
- 抽出はpinned snapshotの静的な読み取りであり、実動作確認（実行）は行っていない。
