# Zot-first first TUI implementation plan

## Decision summary

Concept **GO、初期Human Gate待ち**。planning baseはcommit `a5560a6`、full offline
baselineは227 tests、直近reviewはBlocker/P1/P2 zeroである。

このsliceは、explicitなreal-TTY commandで複数turnのin-memory conversationを扱い、completed
assistant/tool activity、idle/busy、最低限のUTF-8 editorを表示し、全ての扱えるexit pathでterminalを
復元する。provider streaming、persistent session、confirmation、cancellationは含めない。

次のproduct decisionをHuman Gateの承認対象とする。

- explicit `agent:tui`を追加し、既存`agent:run`のTTY挙動は変えない。
- invocation-level tool authorizationを維持し、per-tool confirmationを追加しない。
- idle中のCtrl-Cは1回目で入力clearと終了予告、500 ms以内の2回目で終了する。busy中のEscは
  cancelせず、Ctrl-Cはturn終了後exitを予約する。
- busy中の追加入力はqueue/bufferせず、consumeして捨てる。
- main screen/scrollback方式を採用し、alternate screen/rich rendererを延期する。
- model/loop terminal failureではsessionを続けず、terminal restore後にexit 1とする。

## Pinned Zot decisions

第一リファレンスはMIT-licensed Zot commit
`9b7bb6a4f36bc8c8deb2cc5796a8f557f4fb7479`である。

- `_refs/zot/packages/agent/args.go`: `--no-yolo`はconfirmationのopt-inで、default interactive
  toolsはconfirmationなし。Henjiも現行trusted-local authorizationを維持する。
- `_refs/zot/packages/agent/cli.go`: interactive compositionとUI wiringをagent executionから分離。
  Henjiもruntime composition、terminal/controller、CLIを分離する。
- `_refs/zot/packages/agent/modes/interactive.go`: raw lifecycle、main-screen scrollback、busy key
  handling、completed eventsを参照する。
- `_refs/zot/packages/tui/terminal.go`: terminal abstractionとcleanup sequenceを採用する。
- `_refs/zot/packages/tui/input.go`: UTF-8 key parsingとbracketed paste framingを限定採用する。
- `_refs/zot/packages/tui/render.go`: rich full-frame diff、viewport、Markdown、theme、image/mouse
  supportはfirst sliceでは採用しない。

Zot sourceはimport/copyせず、TypeScriptで独立実装する。`_refs/`は実行、変更、refreshしない。

## Pinned Pi comparison

第二リファレンスはMIT-licensed Pi commit
`a69bef789bc95abf0acee16f7b4660b70b650bb9`である。Piの広いTUI機能全体ではなく、first
TUIのterminal lifecycleとinput framingだけを比較対象にする。

- `_refs/pi/packages/tui/src/terminal.ts`: raw mode開始前後のterminal lifecycle、chunkを跨ぐinput
  buffering、bracketed paste、終了前のbounded stdin drain、input handler解除、stdin pause、raw mode
  restoreを参照する。
- `_refs/pi/packages/tui/src/stdin-buffer.ts`: partial escape sequence、lone Esc timeout、chunkを跨ぐ
  bracketed pasteを一つのstateful decoderで処理する構造を参照する。
- `_refs/pi/packages/tui/src/tui-main-screen.ts`: alternate screenを必須にせずmain screen/scrollbackへ
  描画する選択を支持する。Piのfull differential redraw、scrollback clear、image handlingは採用しない。
- `_refs/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`: first Ctrl-Cでeditor clear、
  500 ms以内のsecond Ctrl-Cでshutdown、TUI stop後にcleanupが再描画しないordering、signal/crash時の
  terminal restore、終了前input drainを参照する。
- `_refs/pi/packages/tui/test/stdin-buffer.test.ts`と
  `_refs/pi/packages/coding-agent/test/interactive-tui.test.ts`: split input/pasteとvirtual terminal
  lifecycleのdirect test patternを参照する。

Piから次を採用する。

- shutdown開始時にrendererをclosingへ遷移させ、以後のdynamic writeを禁止してからrestoreする。
- bracketed pasteをdisableした後、single-reader ownershipを維持したままstdinを最大1,000 ms、50 ms
  idleまでdrainし、最後にreaderをcancel/releaseする。これにより遅延inputがcooked modeまたは親shellへ
  漏れるriskを減らす。
- awaited controller path外のuncaught error/unhandled rejectionにもidempotent last-resort restoreを
  適用する。
- idle Ctrl-Cはdouble-press shutdownとし、Ctrl-D emptyはsingle-press shutdownのままとする。

Piから次は採用しない。

- streaming中Esc cancellation、steer/follow-up queue。現行Henji coreにcancellation/queue contractがない。
- Kitty keyboard protocol、modifyOtherKeys、SSH/env依存のEsc timeout。first sliceではfixed 50 msとし、
  追加env permissionを導入しない。
- session persistence、compaction、extensions、selectors、history、full differential/alternate renderer。

Pi sourceもimport/copyせず、Deno/TypeScriptで独立実装する。`_refs/pi`は実行、変更、refreshしない。

## Scope

In scope:

- explicit production task `agent:tui`
- real TTY preflight
- fixed normal-runtime model、workspace、AGENTS、skills、production registryを1回だけcomposeした
  `AgentSession`
- multi-turn memory-only conversation
- completed event rendering
- idle/busy/exit-after-turn state machine
- bounded UTF-8 editor、Backspace、Enter、bracketed paste
- central terminal-control escaping
- main-screen scrollbackとsmall live editor/status frame
- raw mode、paste mode、cursor、SGR、live frame cleanup
- fake-terminal unit tests、fake-session PTY tests、topology/regression tests
- local results、documentation、bounded review

Out of scope:

- provider streaming/token delta
- transcript/session persistence、resume/export/import
- cancellation/AbortSignal
- per-tool confirmation、`--no-yolo`
- queued/follow-up input
- slash commands、history、completion、cursor movement
- alternate screen、full-history viewport、Markdown、color/theme、mouse、images
- dynamic model/provider、provider selector、step override
- context compaction
- dependency/lockfile
- real provider/TUI execution、credential inspection
- commit、push、tag、publish、release

## Invocation and authorization contract

Production invocationはexactly次とする。

```sh
/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno task --quiet \
  --config deno.v0.json agent:tui
```

Rules:

- argvは0件だけ。flag、positional、initial promptは全てrejectする。
- stdinとstdoutの両方がTTYでなければrejectする。
- piped stdinはemptyでもrejectし、読まない。
- `agent:run`をTTYでimplicit TUIへ切り替えない。
- fixed workspace、profile、model、max steps 8、tools、instructions、skillsを現行normal runtimeと同じ
  規則で解決する。
- session作成時にはcredentialを読まない。既存adapterのlazy credential lookupを最初のsubmitted
  turnまで維持する。
- `agent:tui`の明示起動と各Enter submitが、trusted-local tool executionおよび各turn最大8 provider
  requestsをauthorizeする。
- per-tool promptは設けない。Bashは引き続きOS user権限であり、sandboxではない。
- application retry、fallback、自動resubmitは0とする。

Local implementation gateではproduction `agent:tui`を実行せず、credential、network、providerを使わない。

## Runtime composition

`v0/agent/runtime.ts`で既存compositionを一箇所へ抽出する。

```ts
interface RuntimeComposition {
  readonly model: Model;
  readonly registry: Registry;
  readonly systemInstruction?: string;
  readonly requestCount: () => number;
}

createRuntimeComposition(seam?: RuntimeTestSeam): Promise<RuntimeComposition>

createRuntimeSession(
  eventSink: AgentEventSink,
  seam?: RuntimeTestSeam,
): Promise<{
  readonly session: AgentSession;
  readonly requestCount: () => number;
}>
```

`createRuntimeComposition`はinvocation中1回だけ次を行う。

1. workspace canonicalization
2. workspace AGENTS discovery
3. project-local skill snapshot/manifest
4. fixed production registry
5. counted fetch wrapper
6. lazy-credential `OpenRouterAgentModel`

`runRuntime`はこのcompositionと既存`runAgent`を使い続ける。`agent:run`のargv/stdin、TTY
rejection、stdout/stderr、request counters、outcomesをbyte-compatibleに維持する。

`createRuntimeSession`は同じcompositionから、fixed `maxSteps: 8`、system instruction、event sinkを
持つ`AgentSession`を1個だけ作る。TUIがdiscovery、registry、provider wiringを複製しない。

## CLI contract

`v0/agent/tui_cli.ts`はpreflight、runtime session作成、terminal lifecycle、controller起動、exit
mappingだけを所有する。

Ordering:

1. exact argv and stdin/stdout TTY preflight
2. terminal objectとevent bridge作成
3. runtime/session composition
4. terminal acquisition
5. controller run
6. `finally`でidempotent restore
7. exit/error mapping

Preflight/runtime compositionをraw acquisition前に完了する。partial acquisition後のfailureではacquired
stateだけをbest-effortで全復元する。

Output contract:

- preflight failure: stdout empty、stderrにstatic compact JSON 1行、exit 1
- normal TUI exit: interactionはstdout、stderr empty、exit 0
- acquisition/input/output/model/event failure after startup: restore後、stdoutにはそれまでのsanitized
  scrollbackを残し、stderrにstatic compact JSON 1行、exit 1
- handled SIGHUP: restore後exit 129
- handled SIGTERM: restore後exit 143
- SIGKILLはhandling不能

Allowlisted fatal codes:

```text
invalid_invocation
startup_failure
terminal_failure
input_failure
output_failure
agent_failure
```

stderrへtask、model text、tool arguments/results、credential、provider body、raw exception、stackを出さない。

## Terminal abstraction and restore

`v0/tui/terminal.ts`を追加する。minimum portは次とする。

```ts
interface TerminalPort {
  stdinIsTerminal(): boolean;
  stdoutIsTerminal(): boolean;
  consoleSize(): { columns: number; rows: number };
  setRaw(mode: boolean, options?: { cbreak: boolean }): void;
  read(): Promise<Uint8Array | null>;
  drainAndCloseInput(maxMs: number, idleMs: number): Promise<void>;
  write(bytes: Uint8Array): void;
  addSignal(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP",
    handler: () => void,
  ): void;
  removeSignal(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP",
    handler: () => void,
  ): void;
}
```

Production adapterは確認済みDeno 2.9.4 APIを使う。raw acquisitionは
`Deno.stdin.setRaw(true, { cbreak: true })`とする。Linux/macOSではsignal-generating charactersを
有効に保ち、Ctrl-CをSIGINT handlerからstate machineへ渡す。

Terminal sessionはmain screenに留まり、alternate screenへ入らない。acquire後、host-owned static
sequenceだけでbracketed pasteをenableし、cursor styleをeditor用へ設定する。

Inputはproduction adapterが`Deno.stdin.readable`から取得したreaderを一つだけ所有する。controller、
decoder、shutdown pathが別々のreaderまたはconcurrent readを作らない。shutdown時は現在のpending readを
drain ownershipへ移し、最大1,000 ms、50 ms idleまで入力をconsumeした後にreaderをcancel/releaseする。
Deno reader cancelがpending readをsettleさせることはfakeだけでclaimせずPTY testで確認する。確認できない
場合はterminal restoreを推測で実装せずstop conditionへ戻す。

Restoreはidempotentで、各operation failure後も残りを試す。

1. terminal sessionをclosingにし、renderer/event sinkからの新しいdynamic writeを禁止
2. bracketed paste off
3. stdin bounded drain + reader cancel/release
4. live frameをerase
5. SGR reset
6. scroll region reset
7. default cursor style
8. cursor show
9. raw mode off
10. signal/crash handlers解除

normal exit、startup failure after acquisition、read/write error、model failure、event sink failure、
Ctrl-C/Ctrl-D、handled SIGINT/SIGTERM/SIGHUPで必ず呼ぶ。最初のprimary failureを保持し、cleanup
exceptionでraw diagnosticを上書きしない。

`tui_cli.ts`はraw acquisition直前にscoped `error` / `unhandledrejection` last-resort handlerを登録し、
通常のawaited pathを迂回したfailureでもclosing gateとidempotent restoreを一度だけ試す。handler自身の
failure、dead terminalのEIO、restore中の再entrant failureはrecursive diagnostic/restoreを行わずexit 1に
収束させる。normal restore後はhandlerを解除する。implementationはdetached promiseを新規作らず、この
guardは通常control flowの代替にしない。

## Input decoder and editor

`v0/tui/input.ts`を追加する。

### Decoder

Stateful decoderはarbitrary byte chunk boundariesを扱う。

```text
printable(codePoint)
enter
backspace
escape
ctrl_d
paste(text)
unknown
invalid_utf8
paste_rejected
```

- direct printable inputはstrict well-formed UTF-8だけを受理する。
- malformed sequenceをU+FFFDへsilent replacementせず、bufferを変えずbounded statusを出す。
- CRまたはLFはpaste外でEnter。CRLFは1 Enterとする。
- Backspaceは0x08/0x7fを認識する。
- bracketed pasteはexact `ESC[200~`から`ESC[201~`までとする。
- bare Escはinjected 50 ms expiryでescape eventにする。
- unknown CSI/navigation keysはbufferを変えない。
- incomplete escape/paste at EOFはinput failureとする。
- pasteはterminatorまでboundedにdrainする。64 KiB超過またはmalformed UTF-8ならpaste全体をrejectし、
  partial insertionしない。

### Editor

- maximumは65,536 UTF-8 bytesとする。
- direct printable code pointを末尾へappendする。
- pasteをone atomic insertionとして扱う。
- pasted LF、CR、tab、controlsをtask buffer内に保持する。
- Backspaceは最後のUnicode code pointを1個削除する。
- Enterは`text.trim()`がblankならsubmitせずstatusだけを更新する。
- nonblank taskはbufferをtrim/rewriteせずexact submitする。
- overflowとなるrune/pasteは挿入せずstatusを更新する。
- cursor movement、selection、history、completionは実装しない。

## Rendering and terminal injection safety

`v0/tui/render.ts`を追加する。dynamic contentがterminalへ到達する唯一の入口を
`escapeTerminalText`に固定し、controller/sessionからterminalへの直接dynamic writeを禁止する。

Policy:

- ordinary printable Unicodeは保持する。
- ESC、C0、DEL、C1はASCII `\\u{XXXX}`表記にする。
- CRはvisible `\\u{000D}`にする。
- tabはvisible `⇥`にする。
- LFはscrollback recordではhost-managed logical line break、one-line editorではvisible `↵`にする。
- bidi formatting/isolate controls `U+061C`、`U+200E–U+200F`、`U+202A–U+202E`、
  `U+2066–U+2069`はASCII `\\u{XXXX}`表記にする。
- dynamic string内のANSI/OSC/DCS sequenceはESC escapingにより実行不能にする。
- malformed UTF-8はdecoderでrejectし、rendererへ到達させない。

user/model/tool/error fieldはそれぞれ64 KiB UTF-8まで表示し、それ以上はsafe code-point boundaryで
切ってhost-owned static `… [display truncated]`を付ける。session transcript自体は変更しない。

Rendererはmain-screen scrollbackへcompleted recordsを通常のterminal flowとしてappendし、current
editor/statusの1 live lineだけをCR + erase-lineでredrawする。alternate screen、scrollback clear、full
frame replayは行わない。

`consoleSize()`はredraw時に読み、invalid/error時は最後のvalid size、なければ80x24を使う。live
editorはcolumns内へconservative cell-widthでsuffix表示し、stored bufferは切らない。

## Event-to-visible-output mapping

| Event/outcome | Visible record |
| --- | --- |
| `turn_start` | turn headerは追加せずbusy statusだけ |
| `user_message` | `user>` + escaped exact taskを1回 |
| assistant text `assistant_message` | `assistant>` + escaped textを1回 |
| tool-call assistant message | 表示しない |
| `tool_call` | `tool>` + escaped tool name。argumentsは表示しない |
| `tool_result` | `tool<` + escaped name + outcome + bounded escaped result text |
| `turn_end` success | status updateのみ |
| `tool_terminal` outcome | submit解決後にcanonical `finalText`を`assistant>`として1回 |
| contract/max-step | raw errorを表示せずstatic failure status、fatal exit |

tool-call assistant messageをskipし、individual `tool_call`で描画するため重複しない。terminal
submissionにはassistant text eventがないため、outcome `finalText`をcontrollerが1回だけ補う。

event sinkはsynchronousで、rendererのsync writeを呼ぶ。write failure flagを保持して
`EventDeliveryError`を`output_failure`へ分類する。session rollbackとstop-before-next-effectは既存core
contractを利用する。

## Controller state machine

`v0/tui/controller.ts`を追加する。

```text
starting
idle(buffer empty/nonempty)
busy(exitAfterTurn false/true)
exiting
failed
```

### Idle

- printable/paste: append
- Backspace: last code point削除
- Enter: blankならstatusだけを更新し、nonblankならbufferをclearして1つの`session.submit`を開始
- Ctrl-C/SIGINT: 1回目はbufferをclearし、`press Ctrl-C again to exit`を表示して500 ms armする。
  500 ms以内の2回目はnormal exit 0。期限後のpressは再びfirst pressとして扱う。
- Ctrl-D: emptyならnormal exit 0、nonemptyならignoreして`Ctrl-D exits only on empty input`
- Esc/unknown/navigation: ignore with bounded status

### Busy

controllerはsubmit promiseを待つ間もterminal readを継続する。

- Esc: `cancellation unavailable; turn continues`
- Ctrl-C/SIGINT: `exitAfterTurn = true`、`exiting after current turn`
- printable、Backspace、Enter、paste、Ctrl-D: consume and discard。editorへ入れずnext turnをqueueしない。
- repeated inputはfixed-length statusだけを更新し、memory growthさせない。
- successful final/tool-terminal: normalならidle emptyへ戻り、`exitAfterTurn`ならrender完了後exit 0
- `contract_failure`、`max_steps`、submit throw、event/output failure: fatal exit 1
- sessionに同時2件目をsubmitしない。

`Promise.race`等でread promiseを1個だけ保持し、submit completionごとに新しいstdin readを重複開始しない。

SIGTERM/SIGHUPはbusy/idleを問わずnew submitやcancelを試みず、restoreして129/143で終了する。
in-flight tool/model cancellationは主張しない。

全shutdown pathは最初にstateを`exiting`または`failed`へ固定してrender closing gateを閉じる。in-flight
session/event callbackがその後に完了してもterminalへ再描画できない。normal busy Ctrl-Cだけはcurrent turnの
completed renderingを待ってからgateを閉じる。

## Files and ownership

Add:

- `v0/tui/terminal.ts`
- `v0/tui/input.ts`
- `v0/tui/render.ts`
- `v0/tui/controller.ts`
- `v0/agent/tui_cli.ts`
- `tests/v0/tui_input_test.ts`
- `tests/v0/tui_render_test.ts`
- `tests/v0/tui_controller_test.ts`
- `tests/v0/tui_process_test.ts`
- `tests/v0/tui_topology_test.ts`
- `tests/v0/fixtures/tui_process_fixture.ts`
- `docs/plans/zot-first-tui-results.md`

Modify:

- `v0/agent/runtime.ts`: shared composition + `createRuntimeSession`
- `deno.v0.json`: production/focused/process/topology tasks、check/gate
- `README.md`: exact TUI command、authorization、keys、deferred boundary
- repository owner only: `AGENTS.md`、`.handoff/handoff.md`

Do not functionally change:

- `v0/agent/session.ts`
- `v0/agent/events.ts`
- `v0/agent/loop.ts`
- `v0/agent/runtime_cli.ts`
- `v0/agent/openrouter_model.ts`
- tools/registries/instructions/skills
- corpus/eval/sentinel paths
- dependencies/lockfiles
- `_refs/`

既存core変更が必要ならstop conditionへ戻す。

## Deno tasks

Production taskはexisting `agent:run`と同じtrusted-local permissionsを持つ。

```text
agent:tui =
deno run --no-prompt
  --allow-env=HENJI_OPENROUTER_API_KEY
  --allow-net=openrouter.ai
  --allow-read=.
  --allow-write=.
  --allow-run=/bin/bash
  v0/agent/tui_cli.ts
```

Local tasks:

```text
agent:tui:test =
deno test --no-prompt
  tests/v0/tui_input_test.ts
  tests/v0/tui_render_test.ts
  tests/v0/tui_controller_test.ts

agent:tui:process:test =
deno test --no-prompt
  --allow-run=/usr/bin/script
  tests/v0/tui_process_test.ts

agent:tui:topology:test =
deno test --no-prompt --allow-read=deno.v0.json
  tests/v0/tui_topology_test.ts
```

new filesを`v0:check`へ、3 local tasksを`v0:gate`へ追加する。gateはproduction `agent:tui`、
`agent:run`、provider/sentinel tasksを実行しない。TUI framework dependencyは追加しない。

## Test matrix

### Fake terminal/unit

- argv/stdin/stdout TTY preflight before session/raw/credential/fetch
- acquire/restore normal path
- failure at each acquire/write/read stage still attempts all applicable restore steps
- restore idempotence
- Ctrl-C double-press arm/expiry、Ctrl-D、Escのexact idle/busy behavior
- shutdown closing gate後のlate event/model completionがterminalへwriteしない
- bounded stdin drain、pending read cancel/release、遅延inputがrestore後へ漏れない
- awaited path外のuncaught error/unhandled rejectionがlast-resort restoreを一度だけ行う
- busy input is consumed, discarded, and never submitted later
- only one submit active
- final、tool continuation、tool terminalのevent mapping with no duplicates
- model failure、max steps、session throw、event sink/write failure restore and exit
- completed output only; no token delta assumption
- UTF-8 split at every byte boundary
- malformed/overlong UTF-8
- CR/LF/CRLF、Backspace by Unicode code point
- bracket begin/end split across every boundary
- multiline/control-containing paste preserved in submitted task but visibly escaped
- exact 65,536/65,537-byte editor/paste boundaries
- incomplete/oversized paste bounded drain
- ESC/C0/C1/CR/LF/tab/bidi injection cannot emit dynamic terminal control
- per-field render truncation
- console-size invalid/fallback
- SIGINT idle/busy semantics、SIGTERM/SIGHUP cleanup/exit
- stderr fatal records contain only allowlisted static fields

### PTY process via installed `/usr/bin/script`

`/usr/bin/script` 2.41.5を固定argvで起動し、PTY stdinへtest bytesを送る。childは
`tests/v0/fixtures/tui_process_fixture.ts`を実行し、production terminal adapter/controllerとfake
`AgentSession`/modelを使う。credential、env lookup、fetch、provider、production taskを使わない。

Required cases:

1. ASCII/Unicode/Backspace/Enter、completed response、Ctrl-D exit
2. multiline bracketed pasteがone exact submitになり、visible newline escapingがある
3. delayed fake turn中のprintable/paste/Enterがdiscardされ、Escはunavailable、Ctrl-Cはexit-after-turn
4. idle Ctrl-Cの1回目が入力をclearしてarmし、500 ms内の2回目がexitする。arm expiryも確認する
5. model failure after raw acquisition emits cleanup sequence and exits 1
6. non-TTY direct fixture invocation fails before raw/session
7. exit直前の遅延inputをbounded drainし、restore後のfixture/shell outputへ再解釈されない
8. injected uncaught failureがclosing後に一回だけrestoreし、late callbackが再描画しない

PTY assertions:

- natural exit before fixed deadline
- bounded stdout/stderr
- bracketed-paste on precedes off
- bracketed-paste off precedes input drain completion and raw-mode restore
- cleanup contains erase-line、SGR reset、scroll-region reset、default cursor、show cursor
- terminal-injection markers appear escaped, not executed
- exactly expected submit count
- no provider/credential marker
- no alternate-screen sequence
- process is killed/reaped on deadline/output overflow using existing harness pattern

Fake terminal testsはexact `setRaw(false)` callsを証明する。PTY testsはactual TTY detection、raw-mode
keyboard flow、control sequence ordering、natural process completionを証明する。SIGTERM/HUP kernel delivery beyond
this fixed harnessはclaimせず、injected signal-registration testsがそれらのpathを担う。

### Regression/topology

- `runRuntime` requests/outcomes unchanged after composition extraction
- `agent:run` byte-compatible direct/process cases
- session 14 and loop 22 regressions
- instructions、skills、work-tools、transport regressions
- production `agent:run` literal unchanged
- `agent:tui` exact permission topology
- local gate excludes all production/provider/credential commands
- dependency/lockfile and `_refs/` unchanged

## Ordered implementation

1. shared runtime compositionを抽出し、`runRuntime` compatibilityをdirect testする。
2. terminal port、resource acquisition、idempotent restore、signal registrationを実装する。
3. strict byte decoder、bounded paste、editorを実装する。
4. central escapingとmain-screen scrollback/live-line rendererを実装する。
5. controller state machineとcompleted-event mappingを実装する。
6. exact TUI CLI/preflight/error mappingを実装する。
7. fake-terminal testsを追加する。
8. `/usr/bin/script` PTY fixture/harness testsとtopology testを追加する。
9. Deno check/fmt/lint/gate tasksとREADMEを統合する。
10. verificationを実行し、resultsとlifecycle recordsを更新する。
11. bounded independent reviewを行う。

## Verification

全commandはrepository embedded Deno 2.9.4で実行する。

```sh
deno task --config deno.v0.json agent:tui:test
deno task --config deno.v0.json agent:tui:process:test
deno task --config deno.v0.json agent:tui:topology:test
deno task --config deno.v0.json agent:session:test
deno task --config deno.v0.json agent:test
deno task --config deno.v0.json agent:runtime:test
deno task --config deno.v0.json agent:runtime:process:test
deno task --config deno.v0.json agent:transport:test
deno task --config deno.v0.json agent:instructions:test
deno task --config deno.v0.json agent:skills:test
deno task --config deno.v0.json agent:skills:topology:test
deno task --config deno.v0.json agent:work-tools:test
deno task --config deno.v0.json v0:check
deno task --config deno.v0.json v0:fmt
deno task --config deno.v0.json v0:lint
deno task --config deno.v0.json v0:test
deno task --config deno.v0.json v0:gate
git diff --check
```

Production `agent:tui`、`agent:run`、provider/sentinel/credential launcherは実行しない。

## Review and completion

30分以内のread-only reviewで次を確認する。

- explicit invocationと`agent:run` compatibility
- one fixed session/runtime composition
- no confirmation/cancellation/queueingのexact UX
- busy input consumption
- event duplicate suppression
- terminal injection boundary
- bounded decoder/paste/output
- all exit/failure/signal restore paths
- PTY harness safety
- production task exclusion
- scope外変更なし

10分間新しい証拠がなければ停止する。修正後はchanged-lines/finding closureだけを15分以内で1回
re-reviewする。Blocker/P1/P2 zeroがGO条件である。

Completion requires:

- direct TUI suitesとPTY tests green
- full offline gate green
- `agent:run` byte-compatible
- provider/network/credential/production command 0
- dependency/lockfile/`_refs/` unchanged
- resultsがrequirement-to-evidence、commands/counts、review、deviation、riskを記録
- final review Blocker/P1/P2 zero

## Stop conditions

次の場合は原因、証拠、影響、plan delta、検証方法を返して停止する。

- `agent:run` compatibilityを維持できない。
- one session compositionにdiscovery/provider/tool duplicationが必要になる。
- event renderingにasync/core event-contract変更が必要になる。
- exact busy input consumptionにsecond submit/queueingが必要になる。
- safe terminal restoreにglobal dependencyまたは新permissionが必要になる。
- Deno stdin readerのpending readをboundedにdrain/cancelできず、PTYでnatural exitを証明できない。
- cancellation、confirmation、persistence、streamingがfirst slice完成に不可欠になる。
- dynamic outputがcentral escapingを迂回する。
- PTY harnessがchildをboundedに終了、reapできない。
- existing tool/workspace safety boundaryを変える必要がある。
- dependency、lockfile、provider profile、credential contract変更が必要になる。

## Rollback and residual risks

Rollbackではnew TUI source/tests/fixture/resultsを削除し、`runtime.ts` composition extraction、
`deno.v0.json` task/check/gate、README/lifecycle additionsだけを戻す。`agent:run`、session/core、work
tools、`_refs/`、worktree全体をresetしない。migration/persistent dataはない。

Residual risks:

- SIGKILL、power loss、terminal emulator crashではrestore不能。
- terminal emulatorごとにraw/paste/cursor behaviorは異なる。first sliceはfake terminalとutil-linux PTYで
  証明した範囲だけをclaimする。
- bounded drain後にもterminal/kernel側に未観測inputが残る可能性はある。PTYで確認した範囲を超えて
  shell leakage zeroとはclaimしない。
- cancellationがないためin-flight provider/toolはcompletion/timeoutまで続く。
- busy中のCtrl-Cはimmediate exitではない。
- Bash side effectsはsession rollback/terminal exitでundoされない。
- long sessionはprovider context/request boundに達し、agent failureでexitする。
- per-turn maximumは8だが、interactive session全体のturn/cost aggregate上限はない。
- scrollbackはterminal-ownedで、resize/wide/combining character表示はconservative best effortである。
- displayed truncationはsession/model contentをtruncateしない。

## Human Gate

この計画の承認は、上記explicit `agent:tui` product contract、trusted-local no-confirmation UX、busy
interruption semantics、local implementation、fake-terminal/PTY tests、full offline verification、results、
bounded reviewを許可する。

承認はproduction `agent:tui` execution、credential read/probe、provider/network request、dependency/
lockfile、`_refs/`変更、commit、push、tag、publish、releaseを許可しない。
