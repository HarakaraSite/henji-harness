# Gate 1 general-agent production acceptance results

Status: **accepted**

User acceptance: 2026-09-02 18:51 JST

## Result

The user-approved rerun completed the three-turn production task through the installed bare
`henji` at repository HEAD `da430eef48e8856e873c9867b8c0052485a9a3d3`. Product paths remained
identical to D0 baseline `591fe6f53dbdaa543653fc8b326a7bec7a7b3812`, and the installed launcher
still matched the repository wrapper at SHA-256
`2e45157491bdac8c0de52ab56116111d00077152665021135324e1602a69dcf6`.

- rerun workspace: `/tmp/henji-gate1-general-agent-production-acceptance-retry-1`
- session: `61297b14-c023-4c25-8cc6-f4db61b42e4f`
- committed state: turn count 3, message count 30
- provider requests: Turn 1 = 8, Turn 2 = 4, Turn 3 = 4, total = 16; all HTTP 200
- lanes: Turn 1 parent 7 / planner 1; Turns 2 and 3 parent only
- planner delegation: exactly one successful call, followed by continuing parent execution
- provider-reported usage: 28,524 tokens
- provider-reported cost: USD 0.028308, below the USD 2.00 ceiling
- exits: both normal Ctrl-D exits returned status 0 and restored the terminal
- continuation: `henji --continue` restored the same session at committed Turn 2
- history: Ctrl-T displayed Turn 2 user, assistant, and causal tool/result history; Esc returned to
  ready state without a provider request
- success-path diagnostics: zero

The final `brief.txt` and `release-note.md` passed exact byte comparison. The workspace contains
only those two files. The final note is:

```text
# Neighborhood release note
Audience: maintainers
Owner: Masato
Decision: Publish only after the checklist is verified.
Checklist:
- Confirm the brief was read.
- Verify title, audience, owner, decision, and status.
- Share the note with maintainers.
Status: READY
```

## Durable execution evidence

- Turn 1: `b6f8fddb-a048-47dc-a284-f0ff098a6370`
- Turn 2: `93bbe22a-33a8-4043-bd47-2f178cd0dafe`
- Turn 3: `64cb44ff-8bcd-4c70-b91b-41ed14450e8b`

Each of the 16 requests retains the serialized request, HTTP response metadata, raw SSE bytes,
ordered SSE events, parser transitions, usage, and runtime events. Every request has exactly one
terminal transition, one result transition, and one usage frame. The runtime order proves
`read -> delegate_to_planner -> planner result -> write -> read -> edit -> bash -> final` for Turn
1 and `read -> edit -> bash -> final` for Turns 2 and 3. Capture request objects contain no
credential or Authorization field/value.

## Initial stopped and explicitly authorized rerun

The initial execution did not complete. A PTY driver sent the planned multiline prompt using a
literal newline, which the TUI correctly treated as Submit. Only the first 413 bytes became Turn 1;
the remaining 566 bytes stayed in the editor. The partial task reached one planner delegation, and
the planner's second request ended at the provider completion limit with `finish_reason: length` /
native `MAX_TOKENS`. Henji reported `response_parse` / `unsupported_finish_reason`; the turn was not
committed and `release-note.md` was not created.

- initial evidence: `8a1e4c45-3054-44bc-99d5-8775b4c9ee4d`
- initial diagnostic: `b4fd9bba-1987-444f-ac7f-4bec32fe2e53`
- initial requests: 5, all HTTP 200; parent 3 / planner 2
- initial reported usage: 2,213 tokens across four usage frames
- initial reported cost: USD 0.00325875 across those four frames

The user then explicitly authorized one rerun. It used a fresh workspace and an equivalent
single-line Turn 1 prompt so the terminal driver could not submit at an embedded newline. There was
no provider retry or fallback inside either application run. Across the stopped initial run and the
successful rerun there were 21 application requests. The directly reported cost subtotal is USD
0.03156675; the initial fifth response has no usage frame, so its cost is not invented. Applying the
source-bound per-request maximum only to that missing request gives an overall ceiling of USD
0.09377475.

Both workspaces, state namespaces, sessions/evidence, and the failure diagnostic remain retained.
No cleanup, launcher change, code/test/gate change, dependency/lockfile operation, `_refs/*`
operation, commit, push, tag, publish, or release occurred. The user directly accepted Gate 1;
FR2–FR4 and Gate 1 are complete. The next planned product stage is FR5 integrated human UI
candidate assessment.
