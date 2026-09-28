# S22 — AI agentのclient／server分離実装調査

調査日: 2026-09-27

## 調査対象と結論

[S22設計検討](../plans/s22-http-core-and-tui.md)のため、HTTPで接続するTUI、独立したagent実行owner、
操作と購読、履歴／live接続、CLI／slashの関係を確認した。
WebUI・serverの実装を持つAI agent harnessを対象とする。
公式文書とcommitを固定したsourceの静的調査であり、参照productの起動・切断・実provider実行は行っていない。
参照実装の存在はHenjiの実経路が成立することの検証や、実装採用の承認を代替しない。

主参照はOpenCodeの`serve`＋`attach`。Piは実行制御とUI serviceの境界、DeepSeek
Harnessは
snapshotからliveへ接続する順序と再接続時のprojection復元の補助参照が適している。

| 対象             | 確認した構成                                                  | Henjiへの主な参考                                                | 差分・限界                                                                            |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| OpenCode         | 独立HTTP server、HTTP接続TUI、SSE、Web client                 | serve／attach入口、SDK client、非同期promptと明示abort           | 通常TUI起動には内部RPC経路もある。SSE再開だけで履歴復元の完全性は保証できない         |
| Pi experimental  | serverとTUI client、service contract、Unix socket・CBOR frame | AgentControllerとUI-local slashの分離、catalog・transcript共有   | 実験機能。HTTP統一の直接例ではない。切断時のoperation cancellationは別確認が必要      |
| DeepSeek Harness | Host／Client分離、HTTP unary RPC、WebSocket stream            | baseline／cursor／live接続、control stateとdurable historyの区別 | HTTP＋SSE統一の例ではない。plugin・codegen・汎用stream基盤はHenjiへの採用対象にしない |

## Sourceの固定と取得方法

| 対象             | upstream                                                                        | 確認commit                                                                    | license                           |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| OpenCode         | [anomalyco/opencode](https://github.com/anomalyco/opencode)                     | `b471c2b4495747353af768fbf2e0790c9d820ce2`、commit日時 `2026-09-26T19:56:38Z` | MIT、当該commitのLICENSEを確認    |
| Pi               | [earendil-works/pi](https://github.com/earendil-works/pi)                       | `08dc60bc52d89d6823a9738cc90b1916e5e446e5`                                    | MIT、local snapshot LICENSEを確認 |
| DeepSeek Harness | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `c291e7961a515f6d7af9304e7fd1d257929aef26`                                    | MIT、local snapshot LICENSEを確認 |

OpenCodeはGitHub APIの`commits/dev`でSHAを取得し、そのSHAのtreeと選択source
fileをraw endpointから確認した。
確認用fileは`/tmp/henji-s22-reference/opencode/`、取得metadataは同directoryの`opencode-metadata.json`に置いた。
一時fileは正本や将来の参照前提にせず、以下のcommit固定リンクを証拠とする。
PiとDeepSeek Harnessは[_refsの固定snapshot情報](../../_refs/README.md)とlocal
sourceを使った。 既存snapshotのrefresh、依存追加、source
codeのコピーはしていない。

## OpenCode: 独立HTTP serverにTUIを接続する直接例

### 公式文書で確認した入口

[Server文書](https://opencode.ai/docs/server/)はheadless HTTP
serverの`opencode serve`、OpenAPI schema、
Session・message操作、非同期prompt、abort、SSE endpointを説明している。
[CLI文書](https://opencode.ai/docs/cli/)には既存serverへ接続する`opencode attach <url>`がある。
[SDK文書](https://opencode.ai/docs/sdk/)は既存serverへのclient接続とイベント購読を示す。
これらは可変の公式文書であり、細かな挙動は次の固定sourceで確認した。

### 起動とHTTP接続

- [`serve.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/cli/cmd/serve.ts):
  `Server.listen()`でheadless serverを起動し、コマンドはserverを稼働させ続ける。
- [`attach.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/cli/cmd/attach.ts):
  接続URL、directory、continue／session等を読み、既存serverのSessionを確認してTUIへURLを渡す。
  この入口ではserverを起動したり、TUI用Workerを生成したりしない。
- [`TUI sdk.tsx`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/tui/src/context/sdk.tsx):
  共通SDK clientをbase
  URLから作り、取得・操作と`global.event()`によるSSEを使う。 UI
  cleanupはclient側のrequest／SSE controllerと購読を終了する。

独立起動したserverへ接続するTUIの実装が実際に存在する。 UI cleanup、headless
server入口、後述のasync
promptのownerを合わせると、UIと実行lifetimeを分ける構成が読める。
今回、実行中のTUI切断後にturnが完了することをproduct実行で確認したわけではない。

### 通常TUIには別のphysical transportもある

[`tui.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/cli/cmd/tui.ts)
は通常起動でWorkerを生成し、SDKの`fetch`とeventsを差し替える経路を持つ。
local経路はRPCでrequestとeventを中継し、network option指定時はHTTP server
URLを渡す。 この通常起動の終了処理はWorkerのshutdown／terminateへ到達する。

したがって「OpenCodeの全TUIが常にsocket上のHTTPで通信する」「通常起動のTUIを閉じてもcoreが必ず残る」
とは言わない。Henjiで参考にするのは主に`serve`＋`attach`であり、local
RPC最適化は今回の必要条件ではない。 同じSDK
contractへ異なる通信adapterを接続できる点も、APIと通信方式の分離の実例になる。

### 受付・実行・cancel

[`Session HTTP handler`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
では、通常promptとasync promptを分ける。 async
promptは取得したservice側scopeへ実行をforkし、HTTP応答はNo Contentで返す。
明示abort handlerはprompt serviceのcancelを呼ぶ。
HTTP接続の寿命に長いagent実行をそのまま結び付けないための具体的な参照になる。
Henjiで必要な受付結果とexecution
IDの契約は、OpenCodeの応答形式をそのまま採用せず定める。

### Client projectionとイベント

- [`TUI sync.tsx`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/tui/src/context/sync.tsx):
  eventをclient
  storeへ適用し、bootstrapとSession同期で状態・message等をSDKから取得する。
- [`Web server-sdk.tsx`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/app/src/context/server-sdk.tsx):
  Web側にもSDK clientとglobal event streamを使う経路がある。
- TUI SDKはSSE終了後に再接続するloopと、local eventsを差し込む入口を持つ。

ただし、確認したTUI
SDKの再接続loopだけから、断線中の全event再送やsnapshotとのatomicな切替を証明できない。
Henjiの再接続設計には、次のDeepSeek Harnessのbaseline／cursor方式も参考にする。

### Henjiで参照する範囲

独立serverと接続clientのCLI分離、共通SDK、HTTP操作＋SSE、async実行owner、明示cancelを参照する。
OpenCode固有のEffect framework、UI
toolkit、permission機能、TUI遠隔操作endpoint、 local
RPC最適化、公開API全体をそのまま導入することは意味しない。

## Pi experimental: 共通操作とUI-local commandの境界

確認sourceはlocal `_refs/pi`の固定snapshotである。

- [`service境界`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/experimental/services/README.md):
  server scopeのSession管理と、session
  scopeのModels／AgentController／Transcript、presentation-localの
  SlashCommands／PresentationUIを分ける。
- [`client-runtime.ts`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/experimental/client-runtime.ts):
  server接続、Session service source、model等のclient serviceを構成する。
  server自動起動時のselectionと既存serverへの明示接続のoptionを区別する。
- [`AgentController provider`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/experimental/services/agent-controller-provider.ts):
  prompt、steer、followUp、abort等をlaneへ渡し、受付結果・operation／queue entry
  identityを返す。
- [`slash provider`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/experimental/services/slash-commands-provider.ts):
  model picker等のUI処理とModels／AgentControllerの操作を組み合わせる。
- [`client`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/client/src/client.ts)
  はtransport factoryを受け取り、service call／state購読を扱う。
  [`codec`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/protocol/src/codec.ts)
  はCBORをlength-prefixed frameへ符号化する。local clientはUnix socketを使う。

Henjiへの参考は「実行操作はHost
service」「slash／pickerはpresentation-local」の責務分担である。 Pi全体のservice
catalogue、facet reload、Chord、別のqueue機能は今回の採用範囲ではない。

切断の意味には注意が必要である。
[`session-router.ts`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/server/src/session-router.ts)
はclient disconnectとSession removal／closeを別に扱う。
一方、[`session-worker-manager.ts`](https://github.com/earendil-works/pi/blob/08dc60bc52d89d6823a9738cc90b1916e5e446e5/packages/coding-agent/src/experimental/session-worker-manager.ts)
ではoperationのcontext abort時にworkerへoperation cancellationを送る。
detach時に進行中のlane全体へどう影響するかは今回の範囲で確認していない。 「UI
disconnectでも実行継続」を、この分離の存在だけでHenjiへ移して成立扱いにしない。

## DeepSeek Harness: 履歴とliveの接続・再接続

確認sourceはlocal `_refs/deepseek-harness`の固定snapshotである。

- [`API gateway説明`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/api-gateway.md):
  business operationとcarrier／Remote dispatchを分ける。unary callとlogical
  streamも別contractである。
- [`HTTP bridge`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/client/connection/src/http-bridge.ts):
  node HTTPをFetch-shaped
  handlerへ対応付ける。client切断でrequest側signalをabortする。
- [`Session commands`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/commands.ts):
  promptをAgent側のsteer／follow-upへadmitし、受付応答を返す。
- [`history follow`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/history.ts):
  listenerを登録して更新をbufferし、その後に履歴sourceとcursorを読む。
  最初にheader・page・cursor・projection・optionalな最新assistant
  streamをsnapshotとして返し、 その切替点より後の更新を順序付きで送る。
- [`control`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/session-controller/src/control.ts):
  queue／job／projectionのtransient stateを最初のbaselineとlive更新で配信する。
- [`RemoteJournalStream`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/gateway/src/client/journal-stream.ts):
  reconnectごとのsnapshot、cursor、liveの順序とhistory pageによるrepairを扱う。
- [`physical stream client`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/api/gateway/src/client/stream-client.ts):
  複数logical streamをWebSocket connection上で扱う。

Henjiで参考になるのは、購読準備→snapshot→以後のliveという切替順、durable
eventとtransient stateの区別、 再接続で現在projectionを復元する方式である。
同じ意味をHTTP＋SSEで実現する案はHenji側の設計提案であり、この参照productの通信方式そのものではない。

DeepSeek固有のplugin framework、code generation、WebSocket multiplex、chunk
history codec、 その入力制限や認可仕様をHenjiへ持ち込まない。
HTTP切断signalがあることと、受付済みAgent実行をcancelすべきことは別に判断する。

## 調査結果からの提案と未確認事項

1. OpenCodeの`serve`＋`attach`を主参照に、独立HTTPコアとTUI接続を設計する。
2. TUI／WebUIの操作契約とclientを共有し、まずHTTP＋JSON／SSEに絞る。
3. Piのようにslash／pickerをUI-localにし、実行意味をHost serviceへ集める。
4. DeepSeek
   Harnessの購読前準備とsnapshot基準の復元を参考に、Henjiの既存履歴／本文stateへ接続する。
5. 切断、明示cancel、Session表示切替、generation
   closeを異なるoperationとして定義する。

未確認事項:

- 三productとも今回実行していない。切断中のturn完了や再接続表示の実測はない。
- OpenCodeのSSE再接続と全client
  storeの再同期が、欠落・二重適用をどう解消するかは未精査。
- Pi experimentalのdetach／operation cancellationがagent
  laneへ及ぼす最終挙動は未確認。
- Henjiのworkspace／Session同時稼働scope、設定scope、通常起動UXは利用者との設計で決める。
- 最新upstream全体の品質、一般的安全性、performanceは評価対象ではない。

参照sourceから仕組みを理解して独立実装する方針とし、コードを転用する場合は該当licenseとnoticeを保持する。
