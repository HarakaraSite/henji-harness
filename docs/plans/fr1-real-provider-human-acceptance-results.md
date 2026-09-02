# FR1 real-provider human acceptance results

Status: **accepted**

Execution time: 2026-09-02 15:55–15:57 JST

## Result

The approved single production turn passed through the installed bare `henji` at repository HEAD
`a7d68ead0ec6bbd644e26614f282323e9ce54f9c`, with product source unchanged from baseline
`d6e737a90f95defd7d345c9b0f4b692a227bb2aa`.

- workspace: `/tmp/henji-fr1-real-provider-acceptance`
- session: `aa31420b-5399-4c37-88cf-c3ba64005e4a`
- committed state: turn count 1, message count 12
- provider requests: 6 turn / 6 runtime; all HTTP 200
- tools: `read`, `write`, `read`, `edit`, `bash`; all succeeded
- outcome: settled assistant `final`, ready state, clean Ctrl-D exit 0
- usage: 3,443 prompt + 799 completion = 4,242 tokens
- provider-reported cost: USD 0.0055785, below the USD 1.00 ceiling
- evidence: `9ebb80b6-065f-46c3-a661-2b7f75084aa8`, durable and readable
- retry, fallback, resubmission, additional turn, rerun: zero

`request.txt` remained exactly the seeded three lines. `acceptance-note.md` was exactly the required
four lines with `Status: READY`; the product's Bash verification and the owner's post-exit `cmp`
checks both passed.

## Provider compatibility evidence

All six actual responses ended with OpenRouter's accounting frame containing an empty
`delta.content`, `role: assistant`, the established finish reason, and usage immediately before
`[DONE]`. Each request recorded exactly one terminal transition and one result transition. The
first five results were tool calls and the sixth was the assistant final, matching the runtime tool
and outcome sequence.

The retained artifact contains the serialized request, HTTP status/response headers, exact raw SSE,
parsed provider metadata, parser transitions, tool events, outcome, and request counts. A recursive
key inspection found no credential or Authorization capture field. No credential value was displayed
or copied. Other response metadata remains intact in the local artifact.

## Preflight and retained state

Official OpenRouter model/API/streaming pages still showed `google/gemini-3.7-flash`, the planned API,
and USD 0.75/M input plus USD 3.75/M output. The installed launcher `check`, product-source comparison,
fresh workspace/state namespace, and empty initial evidence list passed. Before those checks, one
owner command stopped immediately because it incorrectly guessed the full hash behind short commit
`a7d68ea`; the actual full HEAD was then read and used as the plan requires. That observation made no
provider request and changed no machine or repository state.

The Human Gate is consumed. The workspace, committed session, and provider evidence are retained for
inspection. No launcher update/rollback, code/test/review/gate, cleanup, `_refs/*`, dependency,
commit, push, tag, publication, or release operation was performed during execution.
