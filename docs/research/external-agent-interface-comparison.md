# 外部agent interfaceの比較（Codex app-server / OpenCode server+SDK / ACP）

作成日: 2026-09-22

## 目的

coding agentを外部program（editor、別agent、CI、独自UI）から駆動・監視するinterfaceの代表例を調査し、
Henjiが採用する場合の位置づけを整理する。記載は調査であり、採用や実装認可ではない。候補は
[`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md)へ記録する。

## 1. Codex app-server（OpenAI）

- 正体: Codexがrich client（例: Codex VS Code extension）を動かすためのinterface。実装はOSS
  （`openai/codex/codex-rs/app-server`）。深いproduct統合（authentication、conversation history、approvals、
  streamed agent events）向け。CI/automationにはCodex SDKを推奨。
- 起動: `codex app-server`（既定`stdio://`）、`--listen ws://IP:PORT`（experimental・unsupported）、
  `--listen unix://`、`--listen off`。`--remote`でCLI terminal UIを別hostのapp-serverへ接続。
- protocol: **JSON-RPC 2.0双方向**（wireでは`jsonrpc` headerを省略）。transportはstdio JSONL、WebSocket
  （1 frame 1 message）、Unix socket。WebSocketは`--ws-auth capability-token|signed-bearer-token`等で認証、
  overload時はJSON-RPC `-32001`。
- 中核primitive: **Thread**（会話）、**Turn**（1依頼とagent work）、**Item**（user/agent message、command run、
  file change、tool call等）。
- lifecycle: `initialize`→`initialized`→`thread/start|resume|fork`→`turn/start`→（`turn/steer`で追加入力）→
  `turn/completed`。notificationsで`thread/started`、`item/started|completed`、`item/agentMessage/delta`、
  tool progress等をstream。
- 主なmethod: `thread/start|resume|fork|read|list|archive|delete|unarchive|name/set|goal/*|metadata/update|
  compact/start|shellCommand|rollback`、`turn/start|steer|interrupt`、`review/start`、
  `command/exec|exec/write|exec/resize|exec/terminate`、`process/spawn|kill|...`、`model/list`、
  `skills/list|extraRoots/set`、`hooks/list`、`plugin/*`、`marketplace/*`、`environment/info`、
  `permissionProfile/list`、`experimentalFeature/*`。
- 生成物: `codex app-server generate-ts|generate-json-schema`でversion固有のschemaを出力。
- 出典: <https://developers.openai.com/codex/app-server/>

## 2. OpenCode server + SDK

- 正体: `opencode serve`がheadless HTTP serverを立て、OpenAPI 3.1 specを`/doc`で公開。OpenCodeのTUIは
  **serverのclient**であり、複数clientを許す。IDE pluginはserverの`/tui` endpoint経由でTUIを駆動する。
- 起動: `opencode serve [--port 4096] [--hostname 127.0.0.1] [--cors <origin>] [--mdns]`。HTTP basic authは
  `OPENCODE_SERVER_PASSWORD`（username既定`opencode`）。
- API（抜粋）: `GET /global/health`、`GET /global/event`（SSE）、`GET /event`（SSE）、`/project`、`/path`、`/vcs`、
  `/config`、`/provider`（`/provider/auth`、OAuth authorize/callback）、`/session`（一覧・作成・status・詳細・
  delete・children・todo・init・fork・abort・share・diff・summarize・revert・unrevert・permissions）、
  `/session/:id/message`（送信・一覧・詳細・`prompt_async`）、`/session/:id/command`、`/session/:id/shell`、
  `/command`、`/find/*`・`/file/*`、`/experimental/tool*`、`/lsp`・`/formatter`・`/mcp`、`/agent`、`/log`、
  `/tui/*`（append-prompt、submit-prompt、open-models等、control request/response）、`/auth/:id`。
- SDK: `@opencode-ai/sdk`（TypeScript）。`createOpencode()`（server+client起動）、`createOpencodeClient({baseUrl})`。
  `session.prompt`等の型付きAPI、SSE `event.subscribe()`、**structured output**（`format: {type:'json_schema',
  schema}`でJSON Schema準拠の検証済み出力、`StructuredOutputError`）。
- 出典: <https://opencode.ai/docs/server/>、<https://opencode.ai/docs/sdk/>

## 3. ACP（Agent Client Protocol）

- 正体: **editor/IDEとcoding agentの通信を標準化するopen standard**（Zedが作成、JetBrainsと協業）。LSPに
  なぞらえ、agentが任意のACP editorで動き、editorが任意のACP agentを扱えるようにする。Zed、JetBrains、
  VS Code、Emacs、Neovim、Obsidian等がACP client。agent側はClaude Code、Codex CLI等が挙げられている。
- protocol: **JSON-RPC 2.0双方向**。local agentはeditorの**subprocessとしてstdio**、remote agentはHTTP/
  WebSocket（remoteはwork in progress）。
- flow: `initialize`→`auth/login`（必要時）→`session/new`／`session/load`→`session/prompt`→agentが
  `session/update`（message chunk、tool call、plan、available commands、mode変更）やpermission要求を送る→
  `session/cancel`→turn終了時に`session/prompt` response（stop reason）。
- client側method: `session/request_permission`（tool call承認）、`fs/read_text_file`、`fs/write_text_file`、
  `terminal/create|output|release|wait_for_exit|kill`。agent側: `session/set_mode`等。
- 規約: pathはabsolute、行番号1-based、MCPのJSON表現を一部再利用、user-readable textはMarkdown。
- 出典: <https://agentclientprotocol.com/>、<https://zed.dev/acp>、<https://agentclientprotocol.com/protocol/overview>

## Henjiとの関係

- Henjiは既にHost/Worker間に**data-only双方向protocol（F12）**を持つ。HostがSurface（TUI/headless）を所有し、
  Workerはheadless。外部interfaceを足す場合は**Host-owned Surfaceの追加**として整理できる（F10）。
- 段階は3つ:
  1. **一方向structured output（P1）**: `henji run --json|--stream`。外部が起動しeventを読む。最小。
  2. **双方向server/RPC**: Codex app-server／OpenCode serverに相当。外部がprompt/steer/model変更/abort/
     state取得を行う。HenjiのHost/Worker protocolを外部へ露出する大きな増分。contract（message、handshake、
     error、versioning、auth、Surface identity）の安定化が必要。
  3. **ACP**: editor/IDE統合の標準。ACP clientを増やさずに済む代わりに、ACPのmethodをHenjiのHost操作へ写像する
     Surface adapterが必要。`session/request_permission`、`fs/*`、`terminal/*`をHenjiのtool（bash/read/write）と
     trusted-local方針へどう対応させるかが設計課題。
- 注意: ACPは「agentがclientのfs/terminal/permissionを使う」前提を持つ。Henjiの現行modelは自前toolと
  trusted-local・no hard sandboxで、permission要求UIを持たない。写像は非自明で、R3（sandbox/permission）や
  F10の判断と接続する。
- 「OpenCodeがHenjiをCLIで呼び状況確認」は**一方向（P1）で足りる**。双方向やACPは別の目的（埋め込み・
  editor統合）で、必要になった時点で採用するのが妥当。

## 未確認

- ACPのremote transport（HTTP/WebSocket）はwork in progressで、schema詳細・安定性は要確認。
- Codex app-serverのWebSocket transportはexperimental・unsupported。method一覧は取得時点のversion固有で、
  変更され得る。
- ACP採用agent（Claude Code、Codex CLI等）の対応範囲（mode、permission、terminal）は実装ごとに差がある。
