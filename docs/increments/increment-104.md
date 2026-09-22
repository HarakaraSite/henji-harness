# Increment 104 — `henji run`の構造化出力（P1）

ステータス: **実装・検証完了（offline v0:gate exit 0、binary配置済み）**

計画日: 2026-09-22

関連: [`experience/normal-use-inbox.md`](../experience/normal-use-inbox.md) P1、
[`research/pi-zot-command-surface-comparison.md`](../research/pi-zot-command-surface-comparison.md)、
[`research/external-agent-interface-comparison.md`](../research/external-agent-interface-comparison.md)、
`v0/agent/core/events.ts`（`AgentEvent`）、`v0/presentation/contract_types.ts`（`PresentationEvent`）、
`v0/agent/worker/worker_headless_runner.ts`、`v0/agent/cli/runtime_cli.ts`、roadmap F01／F10。

## 利用者が必要とする動作

- 外部program（CI、script、editor plugin、別agent）が`henji run`を起動し、turn中の進行を**機械可読な
  event**として受け取れる。final textのparseに依存しない。
- 人間が`henji run`を起動し、assistant本文とtool activityを**逐次**見られる。
- 既定の`henji run`（flagなし）は従来どおりfinal textのみをstdoutへ出し、stdout/stderrとexit codeが不変。

## 決定

- flagは`--json`（machine向けNDJSON）と`--stream`（human向けlive text）。排他、同時指定はinvalid。
  既定は現行のfinal-only。
- **外部wireは内部`AgentEvent`をそのまま出さない**。CLI専用のcurated projection（下記schema）を定義する。
  `providerState`（provider固有replay state）とHost内部durability/evidence ID（`executionArtifactId`、
  `providerEvidenceId`、各durability code等）は**含めない**。
- credential/Authorizationは全eventで含めない（Host invariant）。
- 終了コードは現行と同じ（成功0、failure 1）。

## CLI event schema（curated、`v:1`）

各行は`{"v":1,"kind":"<kind>", ...}`。未知kindはconsumerが無視する前提をREADMEに明記する。未知fieldは
追加のみで、既存fieldの意味変更をしない。

| kind | fields |
|---|---|
| `turn_start` | `turn` |
| `user_message` | `turn`, `text` |
| `assistant_delta` | `turn`, `text`, `reset?`（下記） |
| `assistant_message` | `turn`, `text`（completed assistantの可視text。空なら省略） |
| `tool_call` | `turn`, `callId`, `name`, `arguments` |
| `tool_result` | `turn`, `callId`, `name`, `outcome`, `text` |
| `steering_message` | `turn`, `text` |
| `result` | `ok`, `stopReason`, `committed`, `steps`, `toolCallCount`, `toolResultCount`, `finalText?`, `terminalKind?`, `error?`, `diagnostic?`（sanitized） |

- **`assistant_delta`**: `assistant_progress`（request単位の可視prefix snapshot）からCLIが差分を計算する。
  前snapshotの延長なら`text`は差分のみ。延長でなければ（model stepのreset）`reset:true`とそのsnapshot全体を
  `text`に載せ、以降の差分基準をリセットする。これによりO(n²)を避け、consumerは単純な連結で本文を再構成できる。
  `--json`と`--stream`は同じdelta計算を共有する。
- **terminal**: turn結果は`result` recordを1行出す（成功・失敗の両方）。`finalText`は`final`と`tool_terminal`の
  両方で`outcome.finalText`から取得し、consumerはkind依存の抽出規則を必要としない。
- **pre-turn failure**（flag不正、definition、instruction、input）: 選択した出力modeで`{"v":1,"kind":"error",
  "error":{...}}`を1行出してexit 1。`--json`ではstdout、`--stream`/既定では現行どおりstderrへfailure JSON。
- `turn_end`という内部kindは外部へ出さず、`result`へ写像する。

## I/Oとsink

- `AgentEventSink`は同期・非throw（`core/events.ts:99`）。Hostはsink例外でgenerationを停止する
  （`worker_host_session.ts`のprivate `deliver`）。したがってCLIのsinkは**enqueueのみ**を行い、例外を投げない。
- CLIは**順序付き非同期write queue**を持ち、drain taskが`await Deno.stdout.write`/`writeStderr`で逐次書き、
  `main`はrunner完了後にdrainをawaitしてからreturnする。これによりlive性と行の完全性を両立し、
  `writeSync`によるmain thread blocking（B1と同種）を避ける。
- stdout（`--json`/`--stream`のassistant text）とstderr（`--stream`のtool activity要約、既定のfailure JSON）を
  分離する。`--stream`の失敗時はtool要約を止め、failure JSONをstderrへ出す。
- 書き込み失敗（EPIPE等）時はdrainを停止し、turn自体は完走させる。exit codeはrun outcomeに従う。

## flag parse

- 引数の検証より前に`--json`/`--stream`の**出力modeを先読み**し、排他を検査する。未知flagや`--task`/stdin
  規則違反はinvalid invocationとし、選択済みmodeで`error`行を出す。

## 正本変更（承認依頼）

- `architecture/henji-host-agent-worker.md`のheadless Surface contract（現在「final-only stdout、failure JSON、
  exit code」と記述）を、`--json`/`--stream`の追加へ更新する。
- `roadmap.md` F01／F10の実装状況へ追記する。
- F12はHost/Worker protocolでありCLI出力とは別authority。CLI schemaのversioningはCLI側で持つ。

## 実装範囲

1. `v0/agent/cli/run_events.ts`（新規）: curated CLI event型、`AgentEvent`→CLI eventのprojection、
   `assistant_delta`計算、NDJSON/stream writer、順序付きwrite queue。
2. `v0/agent/worker/worker_headless_runner.ts`: `HeadlessWorkerRunOptions`に`eventSink?: AgentEventSink`を追加し、
   `createWorkerSession`へ渡す。
3. `v0/agent/cli/runtime_cli.ts`:
   - 出力modeの先読みと`--json`/`--stream` parse。
   - `RuntimeCliDependencies.run`の署名をsink受け渡し可能に拡張（または専用seam）。
   - `--json`: curated eventをNDJSONでstdoutへ。`result`でterminal。
   - `--stream`: `assistant_delta`をstdoutへ、tool activity要約をstderrへ。streamed textが1つも無ければ完了時に
     `finalText`をstdoutへ出す（フォールバック）。
   - 既定は現行経路を維持。
4. README／`v0/agent/README.md`へ`--json`/`--stream`とschema（未知kind無視、`tool --json`との意味差）を追記。
5. focused test。

## 検証

- focused test:
  - `--json`が期待kind列（`turn_start`→`assistant_delta`/`tool_call`/`tool_result`→`result`）をNDJSONで出し、
    `providerState`と内部durability/evidence IDを含まないこと。
  - `assistant_delta`がstep resetを`reset:true`で表現し、連結で最終本文が再構成できること。
  - 失敗系: flag不正／definition／instruction／pre-turn／runtime `contract_failure`／`max_steps`で、`error`行か
    `result(ok:false)`のどちらが出るか、exit 1、両方出ないことを固定。
  - `--stream`がdeltaを出し、progress未観測時に`finalText`へfallbackすること。
  - 既定`run`のstdout/stderrとexit codeが不変（既存`production_cli_e2e`／`agent_worker_foundation`）。
  - `--json`×`--stream`、`--json`＋`--task`/stdin、重複`--json`。
- `deno check --config deno.v0.json`、`v0:fmt`、`v0:lint`、`git diff --check`。
- authoritative `v0:gate`はcoordinating ownerが安定候補に対し1回。
- provider-freeで`henji run --json`のNDJSONを実経路確認。実provider確認は承認後。rebuild・配置。

## 未確認事項

- `assistant_delta`のreset検出はprefix一致に基づく。provider/modelが同一step内でprefixを書き換える場合は
  resetとして扱う（TUIのentry replaceと同じ前提）。
- CLI schemaのversioning運用（`v`、未知kind/未知fieldの無視）。将来`--output text|json|stream`への統合は
  別判断。
- tool result本文のサイズは既存tool経路の上限に従う（このincrementで新設しない）。

## 対象外

- 双方向server/RPC、ACP（inbox P10）。
- `--stream`の色・整形の作り込み。
- Session永続化を伴う`run`（現行`run`は`persistence: 'none'`）。
