# S22 — CLI入口とサードパーティAPI利用の設計

更新日: 2026-09-28

ステータス: [詳細設計・slice計画](s22-detailed-design-and-slices.md)のCLI具体案。
利用者が8sliceの段階実装を指示した。各入口は該当sliceで実装し、結果は個別incrementへ記録する。
S22の8sliceと追加修正147のlocal実装・検証・独立reviewを完了した。現在の配置結果は
[合同配置記録](../increments/s22-deployment-2026-09-28.md)、利用方法は[HTTP API](../operations/http-api.md)を参照する。

## 利用者指定と設計判断

利用者が指定した意味は、coreのみ起動する入口はサードパーティ接続を想定し、
通常henjiは明示したTUI起動の省略形、WebUI起動は別入口とすることである。
option形式／subcommand形式の選択、および他optionのsubcommand化検討は設計側に委任された。

動作の選択をsubcommand、対象・設定・出力形式をoptionにする。
既にrun／history／sessions／module／tool／diagnosticsがsubcommandであるため、この構造へ揃える。

| 入口                                         | 動作                             | coreの扱い                                                    |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `henji`                                      | `henji tui`と同じ                | workspaceのcoreを発見。未起動なら独立processで起動してTUI接続 |
| `henji tui [options]`                        | TUIを起動                        | 同上。`--connect`指定時はそのcoreへ接続                       |
| `henji serve [options]`                      | coreのみforegroundで起動         | TUI・browserを起動せず、第三者も同じAPIへ接続可能             |
| `henji webui [options]`                      | WebUIを配信・起動しbrowserへ接続 | 将来実装。同じcore発見／起動を利用。明示`--connect`も考慮     |
| `henji core status [--connect URL] [--json]` | 稼働coreと実効接続先の確認       | queryのみ。core未起動時に自動起動しない                       |
| `henji core stop [--connect URL]`            | coreを明示停止                   | 新規受付を閉じ、Worker・processを清算して終了                 |
| `henji run [options]`                        | 一つのtaskを非対話実行           | 現行local headless Hostを所有。今回のHTTP化対象ではない       |
| `henji history [options]`                    | 保存履歴をread-onlyで参照        | 既定は現行local store。`--connect`指定時はcore APIを読む      |
| `henji sessions/module/tool/diagnostics ...` | 既存の参照・管理操作             | 現行local経路を維持。全部をHTTP化しない                       |

議論中の`--serve`、`--tui`、`--webui`、`--stop-core`は、この案では上記subcommandの名称へ置き換える。
これらのmode optionはまだ実装されていないため、互換aliasとして追加しない。
`--version`はexecutableの情報取得、`--help`は使用法の表示としてoption形式にする。 内部process
runner／core bootstrapは通常CLIと分け、helpへ公開operationとして載せない。

## grammarと代表的な操作

```text
henji
henji tui --continue
henji --continue                         # tui を省略した同じ操作
henji tui --session <id>
henji tui --new --agent generic
henji serve --host 127.0.0.1 --port 5270
henji serve --port 0 --json
henji tui --connect http://127.0.0.1:5270
henji core status --json
henji core stop

henji history --session <id-or-prefix> --view session
henji history --latest --view canonical
henji history --connect http://127.0.0.1:5270 --session <id> --view detail

henji run --task "依頼"
henji run --task "依頼" --stream
henji run --task "依頼" --json
```

引数なし、またはTUIのoptionだけを渡す形は、同じoptionを持つ`tui`へ解決する。
これは「TUIを既定にする」grammarであり、複数のmode optionを合成する規則ではない。
`serve`と`tui`と`webui`はそれぞれ一つの実行入口である。
`tui --new`は既存coreへ接続した後、新しいSessionを明示openする。
通常の再接続で既存Sessionへattachする動作と、新しいactivation設定でSessionを作る動作を区別できる。
commandと引数全体を解釈してから、core起動、storage操作、terminal acquireへ進む。

`serve`は既定で新規taskやUIを作らない。
Definition／runtimeの既定を設定するoptionは受け取れるが、Sessionのopen・submitはAPIの別操作とする。
初期Sessionを指定する場合も明示されたopenだけを行い、依頼を自動送信しない。
既存coreがあればそのendpointを提示し、二つ目のstate ownerを作らない。

通常`henji`で自動起動したcoreも、`serve`で明示起動したcoreも同じAPIとserviceを持つ。
UIの`/exit`はdetach、`core stop`はshutdownであり、相互に置き換えない。
`webui`はWebUIの起動を意味し、coreのみ起動して成功とする入口ではない。
今回はTUI分離を先に実装し、WebUI本体の実装採用は別に行う。

## 他optionのsubcommand化を検討した結果

| 現行／議論中のoption                                  | 設計判断                      | 理由                                                                       |
| ----------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| mode選択の`--serve/--tui/--webui`                     | `serve/tui/webui`             | 独立した動作とlifecycleを選ぶため                                          |
| `--stop-core`                                         | `core stop`                   | 明示的な管理操作であるため                                                 |
| coreの稼働・接続先表示                                | `core status`                 | 停止やUI起動とは異なるread-only操作。既存core.readを再利用                 |
| `--connect`、`--host`、`--port`                       | 各commandのoption             | 接続先・listen条件であり、それだけで新しい動作を選ばない                   |
| `--continue`、`--session`、`--no-session`             | tuiのoptionとして維持         | UIを起動する際の対象・保存条件。省略形henjiの使いやすさも維持              |
| `--agent`、`--definition-revision`、`--root-provider` | 対応commandのoptionとして維持 | Sessionのactivation・初期selection。別commandにしても設定scopeは解決しない |
| `--max-steps`、`--provider-timeout-ms`                | 対応commandのoptionとして維持 | Definition／provider invocationの実行条件                                  |
| `run --task`／stdin                                   | 維持                          | taskの入力方法であり、実行操作は既にrunで表す                              |
| `run --stream`、`run --json`                          | 出力optionとして維持          | 同じtask実行の出力形式。新しい実行操作へ分ける必要がない                   |
| `history --view`、`--latest`、`--session`             | historyのoptionとして維持     | projection・参照対象。履歴操作は既にsubcommandで表す                       |
| tool/moduleのinstall／activate等                      | 既存subcommandを維持          | 既に動作とparameterを分離している                                          |
| diagnosticsのshow／executions等、`--id`               | 現行grammarを維持             | 今回はcore分離が主目的。targetを位置引数へ変えるだけの改名を同時実装しない |
| sessions deleteの`--yes`等                            | 現行意味を維持                | 今回のCLI整理は実データ削除の意味や権限を変更しない                        |

commandへの所属を明確にすることと、設定・対象をすべてcommandへ変えることは区別する。
`--new`もUI起動時のSession選択条件としてoptionに置く。
`run --root-provider`やruntime.jsonは今回自動的に追加しない。
CLIのselection／timeout／Definitionの適用条件は詳細設計の設定scope節を正本とする。

## historyとstreamの関係

利用者確認（2026-09-27）: `henji run`はUIを伴わず、実行結果を受け取る入口とする。
TUI／WebUIを起動せず、taskを`--task`またはstdinから受け取り、stdoutへ結果を返して終了する。
既定は最終結果、`--stream`はlive本文、`--json`は機械向けeventとする。
この案ではrunが一回の実行用local Hostを所有し、常駐coreへattachする動作とは分ける。

historyは既に起きたexecutionのauthorityから作るread-only projectionである。
streamは実行中の観測を継続して受け取る配送方法、またはそれをCLIに出力する形式である。
どちらもstorageの正本ではなく、同じ履歴・最新本文stateへ相関する。

| 操作                       | 新しいtaskを送るか | データ／出力の意味                                               |
| -------------------------- | ------------------ | ---------------------------------------------------------------- |
| `history --view session`   | 送らない           | canonical／non-canonicalを含む人間向け保存履歴                   |
| `history --view canonical` | 送らない           | canonicalに採用されたconversation                                |
| `history --view detail`    | 送らない           | 既存の原記録readback用JSONL。raw provider responseの収集ではない |
| `run --stream`             | 送る               | 新しい一taskのlive assistant textという既存stdout契約            |
| `run --json`               | 送る               | 新しい一taskのcurated NDJSON event streamという既存stdout契約    |
| HTTP `session.subscribe`   | 送らない           | 対象Sessionのsnapshotと以後の状態更新。第三者も利用可能          |

`run --stream`や`--json`をそのままSSE frameのstdout出力へ置換しない。
runのJSONには既存の利用者があり、HTTP frameにはsnapshot・pending・selection等の別の意味がある。
run終了・signalのcleanupはそのcommandのlocal Hostを対象とし、独立coreのshutdownには写さない。

`history --connect URL`はcore側workspaceの履歴を同じviewで読む。
`--session`のID／prefixと`--latest`は接続先で解決し、TUI側／CLI側のlocal storeへfallbackしない。
参照だけではSessionをactivateせず、Workerやprovider requestを開始しない。 接続先の省略時は現行local
storeの意味を保つ。 API `history.read`のtargetはSession
ID／prefix／latest、viewはsession／canonical／detailとして共有する。 HTTP
mappingは`GET /api/v1/history?session=<ref>&view=<view>`、latestは`latest=true`で表す。
単発取得のため、最初のsnapshotからSSEを延々購読する経路にしない。

追加候補として、既存実行のCLI購読だけを行う`henji watch --connect URL --session <id>`を考えられる。
runと異なりtaskを送らない、終了してもexecutionをcancelしない、という動作をcommand名で区別できる。
これは利用者のhistory／streamへの質問に対する検討候補であり、今回の8sliceの必須機能へ追加しない。
採用する場合はhuman表示とNDJSON出力を定め、HTTP clientの購読を再利用する。
名前をstreamへ変えるだけで、run／history／購読の異なる意味を一つにまとめない。

## サードパーティが利用する公開境界

外部clientは言語を問わずHTTP＋JSON／SSEを利用できる。 共有TypeScript
clientは便宜であり、これを使わなくても操作が完結する契約にする。

1. `serve`を起動するか、既に起動したcoreのURLを受け取る。
2. core.readでAPI version、epoch、workspace、稼働Session、利用可能な操作を読む。
3. session.openでnew／none／保存Sessionの継続を明示し、Session IDを得る。
4. session.subscribeの先頭snapshotから状態を読み、以後のordered updateを購読する。
5. task.submitの受付からexecutionIdを得る。受付と完了を混同しない。
6. 同じSession／executionを指定してsteer、follow-up、cancelや結果参照を行う。
7. 接続を閉じても受付済み実行は継続する。後で同じSessionへ接続しsnapshotから復元する。

task、pending、selection、outcome、commit／清算の意味をTUI・WebUIと共通にする。
keypress、slash文字列、overlay、editor、OS exit codeを外部APIの必須入力にしない。
外部clientは一覧と明示IDを使い、server内の「現在表示UI」や現在terminalへ依存しない。
callerごとのwriter leaseや専用agent loopは作らず、coreの実際の受付条件で結果を返す。

`serve --json`の提案出力は、ready時に一つのNDJSON recordとする。

```json
{
  "kind": "core.ready",
  "apiVersion": 1,
  "coreEpoch": "<epoch>",
  "workspace": "<canonical-path>",
  "url": "http://127.0.0.1:<port>",
  "pid": 1234,
  "reused": false
}
```

HTTP listenとservice初期化が完了してから出力する。
起動できない場合はstderrへ短い起動結果を返し、readyを出さない。 providerのrawやSSE
frame、credential、Authorizationをこのstdoutへ流さない。
`serve --json`はcoreの起動管理出力であり、executionのevent streamではない。
既存coreがある場合は、その実際のendpointとepochを`reused: true`で返す。
第三者はこの値から自分が新規起動したcoreかを判別でき、起動用processの終了を既存coreの終了と混同しない。

core.readには`apiVersion: 1`と、そのsliceで実装した`implementedOperations`を含める。
これはserverの実装済み機能の案内であり、Session
snapshotの現在phaseで使える`runtime.operations`とは区別する。
未実装のoperationを利用可能と広告しない。異なるAPI versionをUI内部型の偶然の一致で互換扱いしない。
将来のversion migration／旧API併設は今回の設計から推測で追加しない。

API referenceは実装sliceに合わせ、URL・input・result・SSE
frame・JSON例を共有contractと揃えて記録する。 新しいOpenAPI
generatorを導入することと、外部向けに契約を文書化することは別である。
Pythonやcurl等で公開APIを利用する例を置き、Henji内部object・descriptorへのアクセスを要求しない。
この公開APIは第三者からの操作を対象に含むが、ACP、editor統合、Agent model向けHost
toolを同時採用しない。

## sliceへの対応と確認

- slice 2: serve／接続tui、serveのready出力、API version／operation案内、historyのlocal／remote
  read。 外部のHTTP clientでもTUIを起動せず状態・履歴を読めることを確認する。
- slice 3: task受付、SSEのlive更新、cancel、応答照合を外部clientでも確認する。 TUI-specific
  commandや内部state fileなしで操作が成立することを確認する。
- slice 4〜6: steering・follow-up、Session／設定／catalog／credentialの同じ公開contractを拡張する。
- slice 7: core status／stopと自動起動・発見を実装する。
- slice 8: henjiとtuiの省略関係、root help、CLI optionの所属、compiled binaryを最終入口へ揃える。

historyの既存renderer、runのstdout／exit codeは実装で再利用し、別契約のコピーを増やさない。
実provider確認は利用者が包括承認した。対象・量・保存先を具体化して記録し、多数step・turnの場合は事前報告する。
