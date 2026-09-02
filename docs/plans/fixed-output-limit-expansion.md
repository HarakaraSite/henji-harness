# Fixed output-limit expansion

Status: implemented and functionally reviewed

## Product decision

Gate 1 established that the production agent can complete the general-agent task, but its first
run also showed that the current 1,024-token planner completion ceiling can stop an otherwise valid
turn with provider `MAX_TOKENS`. The user approved the following interim fixed limits:

- production parent and planner model completion request: 65,536 tokens;
- completed parent or planner answer text: 1 MiB UTF-8;
- complete serialized planner-result JSON returned to the parent: 2 MiB UTF-8;
- one saved/restored user or assistant message text: 1 MiB UTF-8;
- one TUI message: 1 MiB UTF-8;
- raw SSE response: unchanged at 1 MiB;
- serialized conversation sent to the next model request: 5 MiB;
- complete provider request body: 6 MiB.

The 2 MiB planner envelope is a separate tool-result allowance. It does not enlarge ordinary tool
outputs. Because raw SSE includes JSON and framing, its unchanged 1 MiB ceiling may become the
effective provider-path limit before an assistant body itself reaches exactly 1 MiB.

The legacy one-request CLI and its existing USD 0.064 budget contract are outside this change. The
production agent profile is separated from that legacy module and becomes the `v0/agent/`-owned
source used by the parent and its built-in planner. The old CLI remains directly runnable but is no
longer treated as part of the current public runtime by the minimal API-exposure test.

## Implementation

1. Add an agent-owned production provider profile with the 65,536-token limit. Use it from the
   normal OpenRouter adapter and Agent Definition so neither imports the legacy `v0/model.ts`
   profile. Keep the legacy profile and its budget unchanged. Remove the stale minimal-test import
   that fixed the old CLI as an intended current public API; do not delete the old CLI itself.
2. Raise the completed-answer, streaming-progress and terminal JSON paths to 1 MiB in the
   provider-neutral loop, OpenRouter adapter, and JSON-result tool. Keep raw SSE at 1 MiB. Raise
   serialized messages to 5 MiB and the enclosing provider request to 6 MiB so an accepted 2 MiB
   planner envelope survives JSON re-encoding and reaches the parent's next model request.
3. In planner delegation, validate the child answer at 1 MiB and its final serialized envelope at
   2 MiB. Keep planner task input unchanged.
4. Raise saved/replayed user and assistant text to 1 MiB and allow only the planner delegation tool
   result to use the 2 MiB envelope limit. Keep the overall session-file limit at 8 MiB.
5. Remove the 64/256 KiB presentation and retained-TUI choke points required to retain and lay out
   a 1 MiB message. Keep the terminal viewport frame bound because it limits one rendered screen,
   not the stored message.
6. Add only focused known-answer checks for the production profile, a representative answer above
   64 KiB, planner result reinsertion, replay/session retention, and TUI retention/layout.

## Verification

During implementation run the two current focused suites, type check, format, lint, and
`git diff --check`. After functional review, the coordinating owner runs `v0:gate` once on the
stable candidate. No provider request or credential access is part of this verification.

Implementation completed with current tests 9/9 and provider compatibility tests 9/9. Initial
functional review found that the old 76 KiB next-request limit prevented a 300 KiB planner result
from reaching the parent. The user chose full planner-result delivery, so the approved limits became
5 MiB for serialized messages and 6 MiB for the enclosing provider request. The exact
delegation-to-parent continuation now passes; narrow re-review is GO with no remaining
Blocker/P1/P2. The coordinating owner ran `v0:gate` once and all 18 current tests, type check,
format, and lint passed.

## Reference note and future work

Pi and Zot are reference information only. They are not the specification for this increment and
no `_refs/*` file is changed. Their current approaches suggest future investigation of:

- per-model output-token limits rather than one shared value;
- incremental SSE processing without an aggregate raw-response cap;
- full-message session and TUI flow without duplicated byte ceilings at every layer;
- context-window/token-based compaction instead of the interim fixed 5 MiB serialized-message
  limit.

Those changes require a later product decision. This increment intentionally retains the fixed
1 MiB / 2 MiB design above.

## Excluded operations

No provider or production run, credential read, launcher or retained-state change, general
hardening, dependency or lockfile change, `_refs/*` edit, cleanup, push, tag, publish, or release is
authorized by this plan.
