# Daily editor and no-lost-input implementation and verification plan

## Decision summary

**GO、初期implementation Human Gate待ち。**

Roadmap Step 82では、現行real-TTY TUIへ次の一つのbounded sliceを追加する。

- 65,536 UTF-8-byte上限を維持するmultiline・cursor-aware editor
- process-local bounded ordinary-prompt history
- workspace-relative path completion一つ
- active task、admitted-unconsumed steering、queued-unsubmitted follow-up、recoverable inputを区別するTUI-owned fixed-lane core
- secret-free metadata表示と一件ずつの明示的pop-back
- safe non-poisoning turn failureだけをreadyへ戻す分類
- nonempty/pending/recoverable textを伴うnormal exitの明示discard confirmation

一般queue、draft/history persistence、session schema変更、provider retry、Pi framework導入は行わない。実装、test、review、results/lifecycle更新は、この計画への別のHuman Gateまで開始しない。

## Authority and verified baseline

正本:

- canonical input: `/tmp/planner-inputs/henji-daily-editor-no-lost-input.md`
- concept revision 34 / roadmap Step 82
- input SHA-256: `410adbcb5d827476a44b2cc8d24cb4fb9c4dd499d9b5b1951eaae7a59afe3ef8`
- verified base: `018048f3c1add6ad7e1b2db698832a71c2708f45`
- repository `AGENTS.md`
- `.handoff/handoff.md`
- implemented cancellation、persistence、progress、streaming、steering、follow-up、Step 81 plans/results

確認済みbaseline:

- Step 81 portable startup/orientationはcommit済みで、startupからinput受付までcredential read、provider fetch、tool executionは0。
- `TuiEditor`は一つのstring、末尾append、scalar Backspace、clear、nonblank submitだけを持つ (`v0/tui/input.ts`)。
- decoderはUTF-8、CR/LF/CRLF Enter、Backspace、Ctrl-C、Ctrl-D、Escape、legacy/xterm Alt+Enter、bracketed pasteを扱い、Escape deadlineは50 ms (`v0/tui/input.ts`)。
- controllerはsubmit、steering admission、follow-up textを直ちにeditorからclearする (`v0/tui/controller.ts`)。
- follow-upはcontroller-local一件で、成功settlement後だけordinary turnへ移る (`v0/tui/controller.ts`)。
- steering textは`SteeringOwner.consume()`でsafe continuation boundaryに一回だけ消費され、その直後に同期`steering_message` eventが配送される (`v0/agent/steering.ts`、`v0/agent/loop.ts`)。
- cancellation時、sessionはsteering laneをcloseし、cancelled draftをcommitしない (`v0/agent/session.ts`)。
- 現行rendererは一つのlive lineの末尾viewportを表示し、follow-upについてbooleanだけを保持する (`v0/tui/render.ts`)。
- production TUI launcherはcanonical repository rootへのread権限を既に持つ (`v0/agent/session_launcher.sh`)。workspaceは`Deno.realPath()`済みのdirectoryである (`v0/agent/work_tools.ts`)。
- raw EOF、decoder framing failure、terminal read failureは`input_failure`、renderer/event failureは`output_failure`、その他のfatal controller failureは`agent_failure`へsanitizeされる (`v0/tui/controller.ts`、`v0/agent/tui_cli.ts`)。
- turn-owned cancellation cleanup failureはsessionをpoisonする。terminal restoreとfinal session closeの一部は現在best-effortにswallowされる (`v0/agent/session.ts`、`v0/tui/terminal.ts`、`v0/agent/tui_cli.ts`)。Step 82では後述のobservable fatal contractへ揃える。

## Scope

In scope:

1. multiline editor、cursor movement、line movement、word delete、cursor insert/paste
2. bounded process-local ordinary-prompt history
3. exact一つのworkspace-relative path completion
4. controller/TUI-owned fixed pending-input lanesとimmutable metadata projection
5. unconsumed inputのrecovery、one-at-a-time pop-back、double-submit防止
6. non-poisoning failureのready recoveryとfatal matrix
7. no-silent-loss normal exit、renderer viewport、80x24 PTY
8. focused unit/controller/session/process/PTY/topology/full-offline evidence
9. provider-free representative human acceptance
10. minimal README、results、AGENTS、handoff更新

Out of scope:

- multi-item queue、priority/replacement/general scheduler
- pending、draft、prompt historyのdisk persistenceまたはrestart recovery
- session schema/version/message/replay/manifest/Definition/resource identity変更
- Step 83 session navigation/history inspection/manual compaction/root README再構成
- Step 84 daily-use/alpha/JSR
- external editor、custom keymap、mouse、image/attachment/preview/upload
- fuzzy/LSP/semantic/global/home/outside-workspace search
- Pi framework/API/event bus/hooks/extensions/package ecosystem
- provider/model/login/credential/usage UI、automatic resend/retry
- dependency/lockfile、real provider/network/credential/production task、actual persistent product state
- `_refs/` inspection/change、commit/push/tag/publish/release

## Before/after ownership inventory

| Text/state | Before | After |
|---|---|---|
| current editor | `TuiController.editor` / suffix-only renderer copy | `TuiEditor` remains sole editable owner; renderer receives bounded layout projection only |
| submitted active task | only `AgentSession`/outcome draft after editor clear | `PendingInputCore.activeTask` owns exact text from admission until commit/recovery |
| steering draft | editor until Enter | unchanged |
| admitted steering | private `AgentSession` `SteeringOwner`; controller has boolean only | core holds exact admitted text until synchronous consumed event marks it irrecoverable |
| queued follow-up | controller `followUpText` | core fixed `followUp` lane |
| recoverable text | none | fixed recovery slot per source kind: active task、steering、follow-up |
| prompt history | none | `TuiEditorHistory`; ordinary submissions only、process-local |
| renderer pending state | follow-up boolean and status strings | immutable secret-free lane metadata; no pending text |
| path candidates | none | startup-bounded workspace path index; names only、no file content |

Renderer、event、status、error、stderr、logはpending/recovery textを所有または複製しない。

## Exact editor model

`TuiEditor`を次のbounded modelへ発展させる。

```ts
interface EditorSnapshot {
  readonly text: string;
  readonly cursorScalar: number;
  readonly byteLength: number;
}
```

- `text`はwell-formed Unicode scalar sequence。
- cursorはUTF-16 offsetではなくscalar境界のindex。
- insert、Backspace、word delete、pasteは新しいcomplete valueを先に検証し、成功時だけtext/cursorを交換する。
- NUL、malformed Unicode、65,536 UTF-8 bytes超過はatomic reject。
- Backspaceはcursor直前の一scalarを削除。
- word deleteはcursor直前のUnicode whitespaceを先に削除し、その後直前の連続non-whitespace scalarsを削除する。
- left/rightは一scalar。
- Home/Endはcurrent logical lineの先頭/末尾。
- Up/Downはlogical line間を移動し、scalar columnをsticky preferred columnとして短い行では末尾へclampする。visual-wrap movementは行わない。
- combining markは独立scalarとして安全に扱い、wide/combining display cell計算はrendererだけが担当する。
- newlineはcursor位置へ`\n`を挿入。
- pasteはembedded newline/tabを保持し、cursor位置へ一回で挿入する。
- submitはexact textを返すがblank-after-`trim()`は拒否する。
- submit成功後だけclearする。

## Exact key and decoder contract

### Keybindings

| Action | Exact event/encoding |
|---|---|
| submit | Enter: CR、LF、CRLF |
| insert newline | Ctrl-O: `0f` |
| cursor left/right | `ESC [ D` / `ESC [ C` |
| logical line up/down | `ESC [ A` / `ESC [ B` |
| line start/end | `ESC [ H` or `ESC [ 1 ~`; `ESC [ F` or `ESC [ 4 ~` |
| Backspace | `08` or `7f` |
| word delete | Ctrl-W: `17` |
| history previous/next | Ctrl-P `10` / Ctrl-N `0e` |
| path completion | Tab `09` |
| pop one recovery item | Ctrl-R `12` |
| busy steering | Enter、unchanged |
| busy follow-up | legacy/xterm Alt+Enter、unchanged |
| busy cancel | Escape、unchanged |
| normal exit/discard confirmation | Ctrl-C / Ctrl-D、後述 |

Ctrl-OはEnter、busy Enter、Alt+Enterに衝突せず、raw terminalで一つのexact byteとしてdecodeでき、terminal protocol negotiationを必要としない。Shift+Enter、Ctrl-J、Kitty CSI-uはsupportしない。

### CSI/split/timeout behavior

- new CSI keysはcomplete sequenceが50 ms deadlineより前に揃った場合だけatomic eventとなる。
- 全byte split境界をacceptする。
- exact deadlineでは既存どおりtimeout-first。
- timeoutしたrecognized-key prefixは`escape`を一回emitし、後着のexact recognized suffixは`unknown`としてconsumeする。cursor actionやprintable suffix insertionへfallbackしない。
- divergent/unknown CSIはbuffered CSI payloadをeditorへ挿入せず、sequence finalで`unknown`。
- Alt+Enterの既存legacy/xterm deadline semanticsは維持し、既存regressionを変更しない。
- SS3 cursor keys、Kitty CSI-u、modifyOtherKeysの未列挙variantはunsupportedであり、別操作へsilent reinterpretしない。
- incomplete UTF-8、CSI、paste framing at EOFは引き続きfatal input failure。
- printable input、paste、new decoder eventの同一chunk順序はrun-to-completionで保持する。

## Prompt history contract

`TuiEditorHistory`は次の固定boundsを持つ。

- maximum entries: 32
- maximum aggregate UTF-8 bytes: 262,144
- one entry maximum: existing editor maximum 65,536
- ordinary `AgentSession.submit()`へ移す直前のmanual taskとautomatic follow-upを記録
- steering、tool/provider text、transcript、restored session history、blank submissionは記録しない
- consecutive exact duplicateは新規entryにせず、既存newest entryを維持
- capacity超過時はoldest-first eviction
- process restartで消失

最初のCtrl-P時にcurrent draft textとcursorを一つだけsnapshotする。Ctrl-P/Nはhistory copyをeditorへ置き、cursorを末尾へ置く。newestより先のCtrl-Nで閲覧前draftとexact cursorへ戻る。境界を越える操作はno-op status。history copyを編集するとnavigationをdetachし、そのcopyをordinary current draftとして保持する。submit/clear後はnavigation snapshotを破棄する。

Historyはsession transcript/persistence/provider contextの別正本ではない。

## Selected file-reference helper

### Choice

**workspace-relative path completion**を選ぶ。

minimal pickerは別mode、candidate navigation、focus/resize/cancel stateを追加し、editor/pending/streamingとの競合面を増やす。Tab completionはcurrent editor/cursor modelへ一つのatomic replaceとして収まり、file内容を読む必要がない。

### Index construction

新しい`v0/tui/file_reference.ts`が、startupで確定済みcanonical workspace rootから一つのimmutable indexを作る。

- manifest validation後、terminal acquireとinput受付前に構築
- directory entriesだけを読む。file contents、preview、hash、provider/tool callなし
- root外を探索しない
- root directory entry namesはUTF-8 byte lexical orderで処理し、各directoryも同順のbounded depth-first traversalとする
- root直下のexact component `.git`と`_refs`はdirectory listingのname比較でpre-count除外し、`lstat`、descendant traversal、candidate/countへの追加を一切行わない
- symlink file/dirはcandidateにも traversal targetにも含めない
- regular filesだけをcompletion candidateにし、directoryはtraversalだけに使う
- lexical UTF-8 byte orderで固定
- maximum visited entries: 4,096
- maximum indexed regular files: 1,024
- maximum aggregate retained path bytes: 262,144
- one workspace-relative path maximum: 4,096 UTF-8 bytes
- maximum traversal depth: 32
- malformed Unicode、NUL、absolute/`..` componentはcandidateから除外
- scan前にcanonical rootの`realPath`とnon-symlink directory identityをsnapshotし、各candidate componentを`lstat`してsymlinkをfollowしない。scan後にroot identity/`realPath`を再検証する
- bound到達、read/stat failure、component/root identity変化、root replacementはpartial candidateをwhole-index discardして`incomplete`にし、Tabは挿入せずbounded error statusを返す

production launcherの既存`--allow-read=<repo-root>`で足りる。permission、work-tool registry、OS-user tool rightsは変更しない。

ephemeral TUI factoryは`prepareRuntimeComposition()`と`createRuntimeSessionFromPrepared()`を使う形へ局所的に揃え、prepared canonical workspaceからindexを作る。persistent factoryも同じprepared workspaceを使う。display projection、manifest、session recordへroot/indexを追加しない。test factoryはpermission-free fake indexを注入できる。

### Tab interaction

- cursor直前のlogical tokenを、前方のASCII whitespaceまたはline startまでのfragmentとして扱う。
- empty fragment、absolute path、`..` componentはrefuse。
- optional leading `./`を除いたfragmentでcandidate prefix match。
- exact一件だけなら、fragmentをJSON文字列と同じquote/backslash/control escapeを使う`"./relative/path"`へatomic replacementする。
- escapingはquote、backslash、C0/C1、bidi controlをASCII escapeへ変換し、terminal controlをraw挿入しない。
- zero match、multiple match、incomplete index、scan error、replacement overflowはeditor text/cursor/history stateを完全に不変とし、text-free bounded statusだけを表示する。
- candidate pathやfragment本文をstatus/error/logへ表示しない。表示は`path inserted`、`no path match`、`path match ambiguous (N)`、`path index unavailable`等に限定する。
- Tabはcompletion以外へfallbackせず、literal tab insertionはbracketed pasteだけが担う。

## Fixed-lane pending-input core

新しい`v0/tui/pending_input.ts`がexact text ownerとなる。array、priority queue、replacement APIは作らない。

Fixed live lanes:

```text
editor/current draft        max 1
activeTask                  max 1
steering                    max 1
followUp                    max 1
recovery.activeTask         max 1
recovery.steering           max 1
recovery.followUp           max 1
```

`TuiEditor`はeditor/current draftの唯一のownerであり、coreはそのtextを複製せずmetadataだけをprojectする。busy中に入力された未admit draftは、final、cancel、recoverable failure、automatic follow-up開始のどの場合もeditorにそのまま残す。editorをclearできるのはordinary/steering/follow-up admissionの成功、explicit clear、confirmed discardだけである。

steeringだけは実行用copyを`AgentSession`の`SteeringOwner`が保持し、TUI coreはadmissionからconsume境界までrecovery用copyを保持する。この二copyは役割を分離し、以下のatomic handshakeと同期consume bridgeで相関する。coreを「sole text owner」とは扱わない。

Secret-free immutable projection:

```ts
type PendingLaneMetadata = {
  readonly kind: 'editor' | 'active_task' | 'steering' | 'follow_up';
  readonly lifecycle:
    | 'draft'
    | 'active_uncommitted'
    | 'admitted_unconsumed'
    | 'queued_unsubmitted'
    | 'recoverable';
  readonly present: boolean;
  readonly byteCount: number; // 0..65536
};
```

projectionはfixed order、deep-frozen defensive valueであり、text、hash、prefix、path、timestamp、provider/session identityを含まない。

### Core transitions

| Trigger | Editor/current draft | Active task | Steering | Follow-up | Result |
|---|---|---|---|---|---|
| idle ordinary submit accepted | exact textをactiveへmoveしclear | empty → active | unchanged | closed → open | exact taskを一回だけsessionへsubmit |
| busy Enter accepted | exact textをsteeringへcopy後clear | active | empty → admitted | unchanged | handshake成功後だけclear |
| busy Alt+Enter accepted | exact textをfollow-upへmoveしclear | active | unchanged | open → queued | admission成功後だけclear |
| busy partial draft; no admission | unchanged | active | unchanged | unchanged | settlementでclearしない |
| loop consumes steering | unchanged | active | admitted → consumed/cleared | unchanged | synchronous bridgeでmark、回収不可 |
| final/tool-terminal commit | unchanged | active → cleared | admittedならrecovery、consumedならclear | queuedならtake | queued textをactiveへmoveしてautomatic submit、draftは保持 |
| cancelled, session reusable | unchanged | active → recovery | admitted → recovery | queued → recovery | ready、auto resend 0 |
| max_steps, session reusable | unchanged | active → recovery | admitted → recovery | queued → recovery | ready、auto resend 0 |
| safe contract_failure | unchanged | active → recovery | admitted → recovery | queued → recovery | ready、auto resend 0 |
| fatal/poison | recovery guaranteeなし | process-local lanes remain only until fatal cleanup | no ready reuse | no ready reuse | no recovery guarantee across exit |
| Ctrl-R, empty editor | next fixed recoveryをeditorへmove | kind cleared only after move | one item only | one item only | user edits/resubmits explicitly |
| Ctrl-R, nonempty editor | unchanged | unchanged | unchanged | unchanged | refuse |
| confirmed discard exit | clear exactly once | clear | clear | clear | restore/exit |

Recovery pop orderはfixed `active_task → steering → follow_up`。これはscheduling priorityではなく、rendererに表示された三つのfixed slotsから一回に一件だけ戻すdeterministic arbitrationである。

同kind recovery slotがoccupied中は、そのkindを再びadmitしない。

- `recovery.activeTask`がある間、新しいordinary submitをrefuse。
- `recovery.steering`がある間、新しいsteering admissionをrefuse。
- `recovery.followUp`がある間、新しいfollow-up admissionをrefuse。

これによりmulti-item queueなしで上書きlossを防ぐ。editorがnonemptyならCtrl-Rはmerge/overwriteせずrefuseする。

### Steering admission handshake

busy Enterは次の同期handshakeを一つのcontroller call stack内で実行する。

1. editor textをvalidateし、coreに`reserved` stateとexact recovery copyを置く。editorはまだclearしない
2. `session.steerActiveTurn(text)`を一回callする
3. `accepted`なら、coreの`reserved → admitted`をthrow不能transitionとしてcommitし、その後だけeditorをclearする
4. `idle`、`already_accepted`、throw、または他のrefusalならreservationをrollbackし、editor text/cursorを完全に保持する

`steerActiveTurn()`はsynchronous contractのままとし、acceptedを返す前に`steering_message`をemitしない。consume/cancel reentrancy seamでは、reservationのないconsume、二重consume、accepted後clear前cancelをfail closedに検出し、stale recoveryやexecution-only admissionを残さない。refusal/error/reentrancyのdirect testsでeditor、core、session execution copyの相関を固定する。

### Steering consume race

TUI mainはsession factoryへ渡すevent sinkを小さなsynchronous bridgeで包む。

1. `steering_message`を受けたらcoreのadmitted steeringを`consumed`へmark
2. その後existing renderer event sinkへ同じeventを一回delivery

`runAgentTurn`は`consume()`、transcript append、event deliveryをawaitなしで連続実行するため、このbridgeがexact consume boundaryとなる。renderer deliveryがその後失敗してもsteeringは既にconsumedであり回収しない。event前のcancel/failureではlaneはadmittedのままで回収する。event schema、provider wire、session APIは変更しない。

### Follow-up success race

successful parent settlement時は次の順を固定する。

1. parent commit/persistence
2. `turn_end(committed=true)`
3. `AgentSession.submit()` settlement
4. unconsumed steeringをrecoveryへ移す
5. queued follow-up textをfollow-up laneからdetach
6. active task laneへ同じtextをmove
7. metadata redraw
8. `session.submit(text)`をexactly once
9. historyへordinary automatic submissionを一件記録

detach後のrenderer/controller failureはactive textをrecoveryへ戻せる場合だけreadyへ戻す。fatal output/cleanup failureではprocess recoveryを約束しない。follow-up laneとactive laneへ同時に同じtextを保持しない。

## Recoverable versus fatal failure matrix

### Recoverable to same ready session

| Boundary | Classification | Reason/action |
|---|---|---|
| user Escape cancellation with settled cleanup | recoverable | `cancelled`、no commit、session reusable |
| `max_steps` | recoverable | explicit noncommitted `LoopOutcome` |
| context preparation failure returned as `contract_failure` | recoverable | loop returns bounded outcome、session remains available |
| model generate/shape/credential/request-budget contract failure returned as `contract_failure` | recoverable | no commit、no automatic retry |
| tool execution error converted to tool-result and later noncommitted max/contract outcome | recoverable at terminal outcome | completed results/effects remain visible; task recovery warning |
| ordinary `contract_failure` with session still available and no commit attempt | recoverable | active/unconsumed lanes move to recovery |

Controller must not infer from free-form error text alone。Add an internal read-only `AgentSession.isAvailable()`/structural `sessionAvailable?()` seam returning only a boolean after settlement。A failed outcome is recoverable only when:

- `stopReason` is `cancelled`、`max_steps`、or `contract_failure`;
- session reports available;
- controller/input/output/terminal state is healthy;
- no exit/discard intent has won。

Fake sessions used for tests provide the same seam。

### Fatal

| Boundary | Classification | Required result |
|---|---|---|
| cancellation cleanup failure | fatal `agent_failure` | session poisoned、settle、restore、exit 1 |
| persistence/session commit failure | fatal `agent_failure` | session unavailable、no ready recovery |
| rollback failure/ghost artifact | fatal `agent_failure` | existing poison contract、no second submit |
| event sink/renderer/live progress write failure | fatal `output_failure` | cancel/settle active、restore、exit 1 |
| terminal read/raw EOF/incomplete UTF-8/CSI/paste | fatal `input_failure` | settle active、restore、exit 1 |
| terminal acquire/restore/input-drain failure | fatal `terminal_failure` | attempt every restore step、record aggregate failure、exit 1 |
| session lock/close cleanup failure | fatal sanitized cleanup/terminal failure | no success exit |
| unexpected rejected `submit()` without stable reusable outcome | fatal `agent_failure` | do not invent recovery |
| crash/unhandled rejection | fatal | guarded settlement/restore、exit 1 |
| SIGKILL、machine/process restart | unrecoverable limitation | no persistence claim |

`TerminalLifecycle.restore()`は全restore operationsを引き続きbest-effortで一回ずつ試すが、失敗有無をlatched sanitized resultとして返す。`tui_cli.main()`はcontroller resultをcleanup完了まで確定せず、restoreまたはsession close失敗をexit 1へ昇格する。raw diagnostics、path、input textはstderrへ出さない。

### Local side-effect warning

recovered active outcomeで`toolCallCount > 0`なら、text-free fixed warning `tools may have changed the workspace; inspect before resubmitting`をready statusへ表示する。

- tool call countはside effectの証明ではないため、rollback済みとも変更済みとも断定しない。
- automatic retry/resendは0。
- warningはrecovery itemをpopしても次のexplicit submitまで維持する。
- completed Bash/write/editその他のOS effectsをrollbackしない。

## Exit and shutdown contract

normal interactive exitは**explicit discard confirmation**を採用する。

### Idle Ctrl-D

- editor、recovery、pending laneがすべてempty: existing immediate exit 0
- 何かpresent: first Ctrl-Dは何もclearせず、2秒の`pending input; Ctrl-D again to discard and exit` confirmationをarm
- deadline内のsecond Ctrl-Dだけがall process-local editor/pending/recovery/history-navigation draftをclearしexit 0
- timeout後はarmed stateだけをclearし、textは保持

### Idle Ctrl-C

- empty: existing twice-within-500-ms exitを維持
- nonempty/recoverable: first Ctrl-Cはclearせず2秒discard confirmationをarm
- second Ctrl-Cでだけdiscard+exit
- Ctrl-C一回でeditorをclearする現行挙動は廃止する

### Busy Escape / Ctrl-C / Ctrl-D

- Escape: cancel、safe settlement、eligible textをrecoveryへ移しready。exitしない。
- first Ctrl-C: cancelをrequestし、exitせずdiscard confirmationをarm。settlement後recoveryを表示。
- second Ctrl-C within 2 seconds: settlement後all lanesをdiscardしexit 0。
- busy Ctrl-D: inputをclearせず`busy; Escape cancels, Ctrl-C twice discards and exits`としてrefuse。

### Signals, EOF, fatal shutdown

- SIGINTはbusy Ctrl-Cと同じ二段階contract。idleではCtrl-C contract。
- SIGTERM/SIGHUPはexternal graceful-shutdown intentとしてexisting 143/129を維持する。active turnをcancelしてsettlementを待ち、secret-free metadata countと`discarding pending input for signal shutdown`を表示できた場合に一回表示し、process-local textをclearしてrestoreする。interactive confirmationは要求しない。
- raw terminal EOFはconfirm不能な`input_failure`であり、restart recoveryを保証しない。
- output failure、crash、restore failureではwarning描画自体を保証せずfatal limitationとして記録する。
- internal normal `shutdown()`は、no-pendingまたはconfirmed-discard以外から呼べないようにする。

No pending/recovery text is copied to status、event、stderr、log during confirmation or signal shutdown。

## Renderer and 80x24 contract

`TuiRenderer`はtext ownerにならず、次を受け取る。

- immutable editor snapshot/layout input
- immutable pending metadata
- existing live assistant/tool progress
- existing completed events

single suffix lineをbounded live editor blockへ拡張する。

- alternate screenは使わない。
- maximum live editor rowsは`min(8, max(2, terminalRows - 4))`。
- logical newlineとcolumn wrapをpure layout functionでcell rowsへ変換。
- original scalar→escaped display cellsのmappingを保持し、C0/C1/tab/bidi escaping後のcursor cellへ置く。
- viewportはcursorを必ず含み、上/下omission markerをtext-freeに表示。
- editor nonemptyはlive assistant/tool progressより優先。
- editor empty時はexisting live progress behavior。
- pending metadataはkind/lifecycle/byte countだけをcompact statusへ表示。
- metadataは最大二行、各80 cells以下のexact ASCII projectionとする。present laneだけをfixed orderで表示し、第一行は`p E:d:65536 A:a:65536 S:u:65536 F:q:65536`、第二行は`r A:65536 S:65536 F:65536`を最大形とする。`p/r`、kind、lifecycle codeのlegendはstartup help/READMEに固定し、text/path/hashは含めない
- metadata rowは0–2。editor row budgetは`min(8, max(1, terminalRows - 6 - metadataRows))`とし、80x24のall-seven-lanes caseでも二metadata rows、八editor rows、status/completed-record/cursor安全余白を超えない。80 cells未満ではkindを落とさずrightmost byte countからfixed truncationし、cursor rowを侵食しない
- completed event前にold live blockをstatic erase/move sequencesでclearし、その後scrollback recordを一回write。
- terminal resize、invalid size fallback、80x24、wide/combining、multiline cursor、streaming/progress replacementをpure known answerで固定。
- terminal controlsはstatic constantsだけ。dynamic textは既存central escape boundaryを通す。
- renderer close後のlate event/redrawは引き続き禁止。

Step 81の12-line orientationは12 linesのまま維持し、key linesだけを次の実装済みsummaryへ更新する。

```text
keys> Enter submit · Ctrl-O newline · arrows/Home/End move · Ctrl-W delete
keys> Ctrl-P/N history · Tab path · Ctrl-R recover
keys> busy Enter steer · Alt+Enter follow-up · Esc cancel · Ctrl-C/D exit
```

credential timing、workspace、Agent、model、session、instruction、skills、trust linesは不変。

## Pi-derived boundary

Canonical inputで供給された比較だけを採用する。

Adopt:

- ordinary editingに必要なcursor-aware editor state
- history閲覧前draftのround trip
- completionをeditorへのatomic text insertionとして扱うUX
- steeringとfollow-upを別laneとして表示・保持する考え方
- rendererをstate ownerにしないcompact core
- busy interactionでもunsent/unconsumed textを明示回収するUX

Do not adopt:

- Pi TUI/editor framework
- generic Agent class/state machine
- event bus、hooks、extensions、package ecosystem
- arbitrary custom messages、multi-item queues、branches
- images/attachments、provider selector/login/usage
- Pi-compatible public APIまたはdependency

Zotはcompactnessの比較材料に留め、互換目標や機能上限にしない。upstream codeはcopyせず、`_refs/`をこのincrementでinspect/changeしない。

## Planned files and responsibilities

一つのimplementerが全writeを所有する。

| File/component | Responsibility |
|---|---|
| `v0/tui/input.ts` | cursor-aware editor、history、new input events、exact decoder grammar |
| `v0/tui/pending_input.ts` | new fixed-lane recovery owner、transitions、steering reservation、immutable metadata |
| `v0/tui/file_reference.ts` | new bounded workspace index、prefix match、escaping、atomic edit |
| `v0/tui/controller.ts` | gestures、lane transitions、history/completion/pop-back、failure/exit arbitration |
| `v0/tui/render.ts` | multiline viewport/cursor、metadata status、live-state priority、help |
| `v0/tui/terminal.ts` | static cursor/block controls、observable aggregate restore result |
| `v0/agent/session.ts` | read-only post-settlement availability seam only |
| `v0/agent/tui_cli.ts` | pending event bridge、prepared-workspace index wiring、cleanup result precedence |
| `tests/v0/tui_input_test.ts` | editor/history/decoder known answers |
| `tests/v0/tui_pending_input_test.ts` | new permission-free lane state/projection/race tests |
| `tests/v0/tui_file_reference_test.ts` | new permission-free fake-filesystem completion tests |
| `tests/v0/tui_render_test.ts` | layout/cursor/metadata/progress/no-disclosure |
| `tests/v0/tui_controller_test.ts` | complete state/failure/exit matrix |
| `tests/v0/agent_steering_test.ts` | consume event boundary and no schema/provider regression |
| `tests/v0/agent_session_tui_test.ts` | availability、commit/rollback、automatic follow-up persistence |
| `tests/v0/fixtures/tui_process_fixture.ts` | deterministic editor/recovery/failure modes and fake path index |
| `tests/v0/tui_process_test.ts` | real PTY keys、split/timeout、recovery、signals、restore |
| `tests/v0/portable_tui_launch_process_test.ts` | Step 81 portable/orientation/credential-zero regression |
| `tests/v0/tui_topology_test.ts` | exact task/check/source/permission topology |
| `tests/v0/offline_gate_topology_test.ts` | new files、leaf ownership、production read boundary |
| `deno.v0.json` | add new permission-free pending/file test targets to check/gate; no production permission expansion |
| `README.md` | minimal Step 82 key/bounds/recovery/limitation summary |
| `docs/plans/daily-editor-no-lost-input-results.md` | completion evidence after implementation |
| `AGENTS.md`, `.handoff/handoff.md` | final reviewed lifecycle only |

`deno.v0.json`には次の二つのpermission-free leafをexactに追加する。

```text
agent:tui:pending:test = /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/tui_pending_input_test.ts
agent:tui:file-reference:test = /home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno test --no-prompt tests/v0/tui_file_reference_test.ts
```

両leafを`v0:test`へ`agent:tui:test`の直後、pending→file-referenceの順でexact一回ずつ追加する。`v0:check`へnew source二件/test二件をexact一回追加し、`tests/v0/tui_topology_test.ts`は二taskのexact command、permission-free、`v0:test` exact-once、check targetをsnapshotする。`tests/v0/offline_gate_topology_test.ts`は二leafのone-owner mapping、新production source inventory、check/format/lint compositionを更新する。new test fileを既存`agent:tui:test`へ重複登録しない。fake filesystemによりdirect leafへ`--allow-read`は付与しない。real production adapter evidenceは既存portable PTY taskの`--allow-read=.,/tmp --allow-write=/tmp`内のdisposable checkoutで行う。

## Ordered implementation increments

1. `TuiEditor`をscalar cursor modelへ置換し、insert/delete/movement/newline/paste known answersを先に固定する。
2. new key eventsとCSI grammarを追加し、全split/deadline/unknown/unsupported regressionsを固定する。
3. bounded history ownerとdraft round tripを追加する。
4. permission-free file-reference index/completion moduleを実装し、workspace/symlink/bounds/error/nonmutationを固定する。
5. pending-input coreを単独実装し、fixed transition/projection/pop/refusal/capacityを固定する。
6. TUI event bridgeでsteering consume境界をcoreへ同期し、consume前後raceを固定する。
7. controllerのmanual task、steering、follow-up、automatic turnをcore transitionsへ移す。
8. cancellation、max-step、safe contract failureをready recoveryへ接続し、session availability gateを追加する。
9. fatal input/output/commit/cleanup/crash matrixとobservable restore/close precedenceを実装する。
10. Ctrl-R pop-back、same-kind admission refusal、local-tool warning、double-submit防止を追加する。
11. Ctrl-C/Ctrl-D confirmation、signal/EOF/shutdown behaviorを追加する。
12. multiline renderer viewport、cursor placement、metadata composition、progress/event priorityを実装する。
13. persistent session、Definition/manifest/replay/session-schema、Step 81 startup credential-zero regressionsを追加する。
14. deterministic real PTY representative flowsとcentral permission topologyを更新する。
15. README、results、AGENTS、handoffを更新する。
16. focused verification、authoritative full offline gate、bounded independent reviewを実施する。

最大の技術的不確実性であるdecoder timeout、multiline cursor layout、steering consume race、failure recoverabilityを前半で独立検証し、controller統合前に閉じる。

## Verification matrix

### Editor/decoder unit

- ASCII、multibyte、combining、wide scalar、malformed surrogate
- multiline cursor insert、left/right、logical up/down sticky column、Home/End
- Backspace、Ctrl-W、line boundary、empty no-op
- exact 65,536 bytes、one-byte/scalar overflow atomicity
- cursor-position paste、newline/tab、NUL、invalid UTF-8、oversize unchanged
- every new CSI complete/split、49/50/51 ms、unknown/divergent/incomplete EOF
- unsupported SS3/Kitty/modifyOtherKeys no mutation
- existing Alt+Enter late replay regressions unchanged
- history entry/aggregate bounds、eviction、duplicate/blank、draft/cursor round trip、detach

### File reference

- canonical workspace-relative regular files
- unique、zero、ambiguous、empty/absolute/`..`
- depth/visited/file/aggregate/path bounds
- control/bidi/quote/backslash/space escaping
- symlink file/dir exclusion and no traversal
- read/stat/root-race/incomplete index
- exact top-level `.git`/`_refs` pre-count exclusion; excluded descendants are not statted/read and cannot exhaust bounds
- disposable checkout with oversized excluded `_refs`、outside symlink、one valid project file keeps completion usable without outside traversal
- insertion overflow and exact editor/cursor/history nonmutation
- file content reads 0、workspace-outside reads 0

### Pending/controller/session

- every transition table edge and invalid transition
- immutable metadata、exact byte count、no text/hash/prefix
- steering only、follow-up only、both、active+both
- partial busy editor draft survives final、cancel、recoverable failure、automatic follow-up start unchanged
- steering reserve/accepted/commit、idle/refusal/throw rollback、accepted-clear/cancel and consume reentrancy correlation
- consume-before/after cancel/failure race
- follow-up take-before automatic submit and no duplicate owner
- Ctrl-R fixed order、nonempty refusal、double-pop no-op
- same-kind recovery capacity blocks replacement
- success commit、automatic follow-up、fresh turn ownership
- cancelled/max-step/safe contract failure ready recovery
- cleanup poison、commit/rollback failure fatal
- tool error continuing behavior and side-effect warning
- automatic retry/resend/fallback 0
- submitted/consumed/committed items never recover
- no double submit、commit、turn/event、late provider request

### Renderer/process/PTY

- multiline viewport and exact cursor cell under 80x24
- wide/combining/control/bidi/tab/newline mapping
- streaming/tool progress/editor/pending priority
- metadata only; pending/recovery text absent from status/error/log
- all seven live/recovery lanes use the exact two-row 80x24 projection without cursor-row loss
- legacy/xterm Alt+Enter and new CSI split sequences through PTY
- history、Tab completion、cancel/pop/edit/resubmit representative sequence
- Ctrl-C/Ctrl-D confirm/refuse/timeout
- SIGINT、SIGTERM、SIGHUP、raw EOF
- input/output/restore/session-close failure precedence
- settle before restore、one restore、no late writes/input drain leakage
- session noncommit and credential/provider activity 0

### Compatibility/full gate

Run repository-defined commands only after implementation approval:

- focused new permission-free core/file leaves
- `agent:tui:test`
- `agent:tui:process:test`
- `agent:portable-tui:process:test`
- `agent:tui:topology:test`
- `agent:session:tui:test`
- `agent:steering:test`
- `agent:cancellation:test`
- `agent:streaming:test`
- `agent:tool-progress:test`
- relevant runtime/Definition/manifest/replay/session-store suites
- `v0:offline-gate:topology:test`
- `v0:check`
- `v0:fmt`
- `v0:lint`
- `git diff --check`
- authoritative `v0:gate`

No real provider、network、credential value、production task、actual persistent product stateを使わない。

## Provider-free representative human acceptance gate

Local implementation、full offline verification、review GO後に、別の明示Human Gateで一回だけ行う。

Disposable workspace、fake local session/model、credential env unset、network unavailableのreal PTYで:

1. multiline taskをCtrl-O、cursor、Home/End、Ctrl-W、insert/pasteで編集
2. exact taskを一回submit
3. Ctrl-P/Nでhistoryと元draftをround trip
4. Tabでworkspace file pathを一件挿入
5. delayed turn中にsteeringとfollow-upを一件ずつadmitしmetadataを確認
6. Escape cancel後、active task、unconsumed steering、follow-upをCtrl-Rで一件ずつ回収
7. one recovered itemを編集して明示resubmit
8. nonempty editorでCtrl-D一回がrefuseし、二回目だけdiscard+exit
9. terminal restoration、request/tool/credential/network activity 0、disposable cleanupを確認

Acceptanceはprovider sentinelではなく、retry/rerunを自動実施しない。

## Rollback

Step 82はsession migration/data migrationを持たない。

RollbackはStep 82 commitを一括revertし、次をbaselineへ戻す。

- old suffix editor/decoder/controller/renderer
- controller-local follow-up ownership
- existing fatal-on-noncancel failure behavior
- old key help
- new source/test/task leavesの除去

persistent schema-v1、existing session files、Definition、manifest、replay envelope、provider wireは変更しないため、data rollbackやrecord conversionは不要。実装途中でfixed-lane capacity、terminal restore observability、workspace traversalが計画どおり成立しない場合は、scopeを広げず停止して再計画へ戻す。

## Completion evidence

完了には次をすべて要求する。

- success criteria 1–9をtest名/command/resultへ対応付けたresults document
- exact changed-file inventory
- focused suite counts
- authoritative full offline gate count
- check/fmt/lint/diff results
- credential read、provider/network request、production command、actual persistent stateが0である証拠
- permission topology before/after
- no Definition/manifest/replay/session-schema byte change regression
- independent bounded reviewのBlocker/P1/P2 disposition
- approved closureがあれば一回のplan-scoped closureとnarrow re-review
- representative human acceptance結果または未実施Human Gate状態
- remaining limitation: fatal crash/kill/restartを越えるpending recoveryなし、local tool effects rollbackなし

## Initial implementation Human Gate

この文書はplanning-onlyである。次を開始するにはユーザーの明示承認が必要:

- product/test/task/document/lifecycle変更
- disposable offline fake/PTY/temp-workspace verification
- full offline gate
- bounded independent review
- plan-scoped finding closure

real provider/network/credential access、production task、actual persistent product state、`_refs/`、dependency/lockfile、commit/push/tag/publish/releaseはこのHuman Gateに含めない。
