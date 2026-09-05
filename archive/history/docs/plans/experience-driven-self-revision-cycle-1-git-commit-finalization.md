# Experience-driven self-revision Cycle 1 — Git commit finalization

Status: **archived; production comparison never executed**

Decision date: 2026-09-06 JST

Baseline repository commit: `b1342eb76ad76f2f6f7f9b3f066165456e224334`

Archive disposition: This plan was withdrawn after the user clarified that experience-driven
self-revision is a future product concept, not the active next stage. The candidate was authored by
external Codex and would only have tested Henji following developer-written instructions. It was not
Henji self-revision, and the proposed production Human Gate is no longer active.

## User outcome

When the user explicitly asks Henji to commit selected repository changes, Henji should make the
commit once and return a clear final response containing its result. A recoverable Git environment
condition must not consume the final available model step after the commit has succeeded.

## Observed experience

The user asked the installed production `henji`:

```text
acceptance results・handoff・AGENTS.mdをコミット
```

The turn performed eight model requests and eight Bash calls. The first commit attempt ran without
an available repo-local Git author identity and returned exit code 128. Henji then read the recent
commit author and used a one-shot `git -c user.name=... -c user.email=... commit`; that eighth tool
call successfully created commit `b1342eb`.

The default Definition had `maxSteps: 8`. After the successful eighth tool result, the loop reached
the model-step limit before another model response could report success. The TUI displayed
`failure> step limit reached`; the Worker execution settled `uncommitted`, and no persistent session
record was created. The Git commit remained because Bash effects are non-transactional and are not
rolled back.

The Bash tool transport also reported both the exit-128 process and the successful process as a
successful tool dispatch, so the compact TUI rendered `✓` for both. The model-visible JSON retained
the distinct `exitCode` and `stderr`, and the model did react to the failure correctly.

## Baseline evidence

- Worker execution: `78bcf350-6ce9-47a8-a3f6-02bd1d4f63b5`
- provider evidence: `429b4569-5332-4615-82df-a40c55493554`
- uncommitted session identity: `5a6994dc-5409-4942-b72d-3944c4b51281`
- Definition: built-in `default`, entry SHA-256
  `564e95a5189b8bb1d1cffecd624d1c34d0a57b1c7edbdac0759f6c6e2c0a8cfc`
- requests: 8 parent requests, all HTTP 200 with one terminal parser transition each
- tools: 8 Bash calls and 8 settled tool results
- usage: 26,628 prompt + 263 completion = 26,891 tokens
- provider-reported cost: USD 0.02095725
- runtime outcome: `max_steps`; Host store `not_attempted`; acknowledgement `not_sent`; settlement
  `uncommitted`; automatic replay false
- external effect: Git commit `b1342eb` succeeded and remains in history

The retained request bodies contain no remaining-step or step-limit signal. The runtime checks the
limit immediately after appending the tool result in [`loop.ts`](../../../../v0/agent/loop.ts), so an
eighth-step tool call cannot be followed by an assistant final under the current contract.

## Cause hypothesis

The immediate and repeatable trigger for this repository was the absent repo-local Git author
identity. The agent discovered that fact only after spending a model step on a failed commit.
Reading the established author before the first commit attempt would have removed the failed attempt
and left one model response available for the final result.

The runtime has a broader boundary: any necessary tool call on step eight ends as `max_steps`, even
when that tool completes the requested work. The TUI's Bash completion mark also does not express
the subprocess exit code. These are observed facts, but Cycle 1 does not change loop semantics,
request limits, session failure persistence, or TUI rendering. The instruction candidate tests the
smallest artifact that can change this concrete repository outcome. A recurrence without the Git
identity trigger is evidence for a later runtime or presentation cycle.

## Revision candidate

Cycle 1 adds `Git commit execution` instructions to the repository `AGENTS.md`:

1. Inspect the selected diff, `git diff --check`, and repo-local author identity before staging.
2. Batch independent read-only checks in one assistant tool-call response when possible.
3. If repo-local identity is absent, read the recent committed author and pass it to the first
   commit with one-shot `git -c` options; do not change Git configuration.
4. Judge Bash subprocess success from its JSON `exitCode`, `stderr`, and `timedOut`, rather than the
   tool completion mark.
5. After an exit-0 commit identifies the new commit, do not repeat the mutation; return the hash and
   result unless the user requested another readback.

This candidate records no fixed personal identity. It preserves the user's explicit commit boundary,
the existing untracked files, and the current Host/Worker/runtime contracts.

## Roles and revision identity

- author: user and coordinating Codex, using the user's observed outcome and retained evidence
- generator: coordinating Codex; **developer-assisted**, not evidence that Henji generated its own
  revision
- evaluator: user and coordinating Codex against the retained baseline and next production result
- applier: pending; the candidate is present in the working tree but is not committed or installed
  by this cycle step
- execution entry for the baseline: the built-in Definition hash recorded above
- candidate artifact: this record plus the exact `AGENTS.md` instruction diff

## Production comparison

The comparison should be the next natural, explicitly authorized commit task for these Cycle 1
artifacts in a new production `henji` session. Do not replay the already completed baseline commit.

The 2026-09-06 JST public OpenRouter readback confirmed `google/gemini-3.7-flash`, tool support,
1,048,576 context tokens, and 65,536 maximum completion tokens. The listed Google endpoints ranged
from USD 0.375/M input plus USD 1.875/M output through USD 1.35/M input plus USD 6.75/M output. The
production request supplies no provider-route selector, so the selected tier is not fixed by the
Henji profile. The expected cost for one comparison turn is USD 0.01–0.04 based on the baseline
shape and current endpoint range. The conservative eight-request full-limit calculation at the
highest listed price is USD 14.8635648; Henji has no monetary client cap.

The separate Human Gate authorizes one new production session from the repository root and this
exact task once:

```text
AGENTS.md、docs/plans/experience-driven-self-revision-cycle-1-git-commit-finalization.md、.handoff/handoff.mdをコミット
```

It authorizes the installed `henji` to use the configured credential, make at most eight parent
model requests, and commit only those three candidate files. It does not authorize planner use,
retry, fallback, task resubmission, another turn, Git configuration changes, push, cleanup, or any
other repository mutation. Stop on the first failed success condition and retain the session,
execution, provider evidence, and workspace state for readback.

For the first comparison, observe whether Henji:

- reads or otherwise establishes the repo-local identity state before the first commit attempt;
- uses the established recent author only through one-shot `git -c` options when needed;
- makes exactly one successful commit attempt and does not mutate Git configuration;
- preserves unrelated untracked files;
- returns a clear assistant final within the eight-step Definition limit;
- commits the Worker turn and persistent session with correlated provider evidence and execution
  artifact.

Record actual request count, tool sequence, tokens, cost, final text, commit identity, and session
settlement. Success is limited to that observed comparison; it does not prove that all step-limit or
Bash-status cases are solved.

## Current boundary

This implementation step changes instructions and documentation only. It makes no provider request,
does not launch production `henji`, does not change Git configuration or runtime code, and does not
commit, push, clean, or modify `_refs/*` or the untracked `docs/plans/surface-roadmap.md`.
