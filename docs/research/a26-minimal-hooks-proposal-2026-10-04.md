# A26 最小hook機構と開始日時の外部定義案

2026-10-04。A26の検討で整理した案を保存する。
本体に最小限のhook機構を組み込み、具体的な処理は外部TypeScriptで定義する。 初回はAgent
Workerの6種のhookと、runtime開始日時をcontextへ挿入する外部定義を対象とする。
本書は初期提案と調査根拠を保持する。採用された具体contract、実装計画と結果は以下のIncrement
189を参照する。

その後の会話と初期提案の批判的reviewを踏まえ、
[Increment 189](../increments/increment-189.md)に具体contractと実装計画の案をまとめた。
以後の採用要件・計画・結果は同文書を参照する。本書は提案の背景と調査根拠を保持する。

通常利用メモのA26はIncrement 189へ採用・移設した。採用要件の入口は
[Increment 189](../increments/increment-189.md)とする。

## 本体と外部定義の分担

hookの契約と呼出点はビルトインとする。本体は呼出タイミング、引数・戻り値の型、登録順の実行、
非同期処理の待機、結果の適用・保存を担当する。外部TSは環境情報の挿入、tool引数・結果の加工、
完了通知など、そこで何を行うかを定義する。

現行AgentはJSON設定であり、外部toolはWorker内でTS factoryを読み込む。 hookもAgent
JSONの`hooks`配列から外部TSを順序付きで選択し、Worker内で読み込む案とする。 moduleのdefault
factoryはhook objectを返し、登録・組立てを担当する。
factory実行と`runtime_start`の呼出しは区別する。
module指定形式と公開APIの具体名は詳細contractで決める。

登録範囲はその後の会話で具体化した。親Agent・named子Agent・generic子Agentが共通デフォルトを使い、
Agent名と親／子の区別を受け取った外部TSが処理対象を判断する。
子のhookは子の実行・contextを対象とし、親のhookとは独立して呼ぶ。 catalogとAgent
JSONの指定規則はIncrement 189の計画案を参照する。

複数の外部定義を登録した場合は、登録順に直列でawaitする。
contextや引数・結果を変更するhookは、前のhookの結果を次へ渡し、明示的な戻り値で変更を表す。
credential値・Authorizationをhook入力、context、記録へ含めない。

## 初回に備える6種のhook

| hook            | 呼出タイミング                      | 外部定義で行えること            |
| --------------- | ----------------------------------- | ------------------------------- |
| `runtime_start` | Workerの構成完了後、task受付前に1回 | 初期処理、共通contextの追加     |
| `runtime_stop`  | Worker停止時に1回                   | 後処理、保持resourceの終了      |
| `before_turn`   | 各turnの処理開始前                  | turnごとの処理、context追加     |
| `after_turn`    | 実行・保存・採用結果の確定後        | 完了処理、次turn用contextの更新 |
| `before_tool`   | 各toolの実行直前                    | 引数の参照・変更                |
| `after_tool`    | toolの通常結果・エラー結果の確定後  | 結果の参照・本文加工            |

ここでruntimeはAgent Workerの寿命を指す。Core起動、Session新規作成、TUI接続を意味しない。
同じWorkerで複数turnを処理する間は、start／stopを繰り返さない。
同じSessionでもWorkerを再生成すれば`runtime_start`を再実行する。
複数Coreは別processであり、それぞれのWorkerで独立して実行する。
`runtime_stop`は通常の停止経路で呼び、強制終了・process crash時の実行は保証しない。

## hookの実行先

初回の外部TSの読込・実行先はAgent Workerとする。
HenjiCoreはWorkerの起動・停止とtaskの受付・配送を管理し、Agent Workerの実行基盤がhookを呼ぶ。
turnの呼出点はAgent loop、tool前後は共通tool実行経路、runtime前後はWorker lifecycleへ置く。
`after_turn`はDataによる保存・採用結果の確定を受けて呼ぶ。

共通機構はAgent専用に固定しない。将来Data Worker等で具体的な用途が必要になった場合は、
そのcomponentが呼出点と引数・戻り値の型を提供し、外部TSもそのWorker内で読み込んで実行する。
例えば保存完了のhookなら、Data Workerがcommitした後に呼ぶ。
Worker間で渡すのは設定や結果のdataであり、functionやclosure自体は渡さない。 Data
Worker向けhookの実装は初回の対象に含めない。

## 最初の外部定義

`runtime_start`で開始日時を取得し、共通contextへ追加する。 timezoneは実行環境の設定を使い、UTC
offsetとtimezone名の両方を含める。

出力例は次のとおり。日時とtimezoneは例であり、実行時に取得する。

```text
Agent runtime started at: 2026-10-04T15:30:00+09:00
Timezone: Asia/Tokyo
```

同じWorkerでは開始時点の値を保持する。「現在時刻」とは区別する。
この外部定義で、外部TSの読込、hookの呼出し、contextへの反映、Worker内での保持を確認できる。

## contextとcompactionへの対応

同じWorker内なら、外部TSへcontextなどのobjectや操作APIを渡せる。
snapshotを渡して置換結果を受け取る方式と、contextの取得・変更APIを渡す方式の具体的な選択は、
詳細contractで決める。本体がcontextの適用・保存を所有し、外部TSが構築・圧縮の方針を担当する。

`after_turn`は通知専用にせず、次turn用contextの更新を返せる契約にする。
compactionを利用する場合の流れは次のとおり。

1. turnの実行・保存・採用結果が確定する。
2. 外部TSへ結果と現在のcontextを渡す。
3. 外部TSが古い部分を要約し、最近のcontextはそのまま残したcontextを返す。
4. 本体が次turn用checkpointとして保存・適用する。
5. 次turnの入力を圧縮済みcontextへ追加する。

次回の圧縮では、前回の要約と新たに古くなった部分をまとめ直し、直近のcontextを残す。
確定済みturnの結果と元の会話履歴は保持する。 長い1
turnの途中でcontextが増える問題への対応は、このturn間の圧縮とは別に扱う。
compactionの外部定義そのものは今回の初期実装には含めない。

## 実装前に具体化する項目と確認方法

実装前に、module指定形式、各hookの引数・戻り値、例外時の挙動、context更新の保存・再開経路を
具体化する。選択したmodule・登録順と、変更したcontext・引数・結果の出所を
configurationおよびsemantic履歴から確認できる記録方法も決める。
通常実行の記録はsemanticな変更と短い実行factを使い、raw request／responseの常設収集を追加しない。

検証は6つの呼出点と変更結果に対応するfocused確認に加え、compiled production Workerで
外部TSの日時取得・context反映を確認する。実provider callを伴う確認は、対象・回数・保存先を
提示して利用者の明示承認を得てから実施する。

## 調査根拠

[外部化の参照実装比較](externalization-reference-comparison.md)は2026-09-11のcommitを主な根拠とする。
今回の検討では、2026-10-02に更新された手元`_refs`のdocs・型・dispatch・呼出位置を再読した。
参照実装の動作実測は行っていない。snapshotのcommitと選択範囲は
[`_refs/README.md`](../../_refs/README.md)を参照する。

- Pi: `c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06`。
  [`docs/extensions.md`](../../_refs/pi/packages/coding-agent/docs/extensions.md)、
  `src/core/extensions/types.ts`、`runner.ts`、`loader.ts`、`src/core/agent-session.ts`を確認した。
  TSによる登録、非同期factoryの待機、順序付き合成、`agent_end`と`agent_settled`の区別を参考にする。
- Zot: `6a6e31f371936d350bf23f3dce65d3fddc896d23`。
  [`docs/extensions.md`](../../_refs/zot/docs/extensions.md)、
  `packages/agent/extensions/events.go`、`before_start.go`、`lifecycle.go`を確認した。
  通知と介入を分ける。`turn_end`はtool実行前のmodel応答終了であり、Henjiのturn終了とは対応しない。
- OpenCode: `1ddb0873aee50d209d1a8d7f91b89c5daf692d49`。
  [`packages/plugin/src/index.ts`](../../_refs/opencode/packages/plugin/src/index.ts)、
  `packages/opencode/src/plugin/index.ts`、`src/session/tools.ts`、`prompt.ts`を確認した。
  非同期factoryがhook objectを返す構成と、順序付きawaitを参考にする。
- DeepSeek Harness: `639ed015397290b3745d163aafe02ffee4aa3f84`。
  [`docs/cordis-primer.md`](../../_refs/deepseek-harness/docs/cordis-primer.md)、
  `docs/agent-lifecycle.md`、`packages/core/agent-loop/src/agent.ts`、
  `packages/core/tools/src/index.ts`を確認した。
  変更可能な途中結果と確定結果の通知を区別する点を参考にする。

上記は比較根拠であり、各参照実装のhook数、block、timeout、reload、plugin framework全体を
Henjiへ採用する判断ではない。手元snapshotはgit管理外であり、別checkoutでは
`_refs/README.md`に記載したcommitと取得規約を使う。
現行Henjiの外部TS契約は[Increment 181 contract](../increments/increment-181-contract.md)を参照し、
古い比較資料のmanaged revision・exact binding方式を今回のhook選択へ持ち込まない。
