# Agent Worker real-provider human acceptance results

Status: **accepted**

Execution time: 2026-09-05 18:34–18:37 JST

## Result

The user-authorized two-turn Human Gate completed through the installed production `henji` at
repository commit `78971e116824e863f6464f85106c99be334bd04a`. Product source remained identical to
the accepted Worker baseline `3b7e3aa8f054f3da1e0827e4750ec5bdb6b47c2b`.

Both the built-in and external Definition paths read the exact seeded `acceptance.txt` once, used no
other tool, returned exactly `WORKER ACCEPTANCE OK`, committed one persistent turn, and exited from
the empty editor with Ctrl-D and status 0. No retry, fallback, resubmission, additional turn, or
rerun occurred.

| Path     | Session                                | Execution                              | Evidence                               | Requests |                                 Usage |      Provider cost |
| -------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | -------: | ------------------------------------: | -----------------: |
| built-in | `75cd0d87-356c-4807-b15d-8e81f193d53b` | `24bc272b-88d3-4ed6-9ccd-c65a432bdd15` | `9835547d-3336-46b6-9b21-9de56fe2324a` |        2 |      821 prompt + 89 completion = 910 |     USD 0.00094950 |
| external | `b7cba07c-d73f-4d41-802a-3d7ce0835abd` | `1b95eacb-38fd-4437-a1ec-0fc5648521e4` | `e7105951-ce6f-40a4-a835-2dee9767c132` |        2 |     821 prompt + 110 completion = 931 |     USD 0.00102825 |
| total    | —                                      | —                                      | —                                      |        4 | 1,642 prompt + 199 completion = 1,841 | **USD 0.00197775** |

The provider-reported total cost is authoritative for these four requests. It was below the
preflight estimate of USD 0.004–0.01.

## Definition and Worker evidence

The built-in execution used the `default` Definition with entry SHA-256
`564e95a5189b8bb1d1cffecd624d1c34d0a57b1c7edbdac0759f6c6e2c0a8cfc` and 232 source bytes. The
external execution loaded the exact retained `henji.agent.ts` with entry SHA-256
`2390c3233731be0821ed5c4ff1e2b9893d4d67c80a869afef0d75b54e4a18697` and 249 source bytes. Its durable
Manifest records `role: parent` and `maxSteps: 4`.

Each execution artifact records the Definition revision, Worker generation, Host-to-Worker turn
command, ordered protocol trace, one commit proposal, accepted commit acknowledgement, committed
Host store result, state revision 1 to 2, durable provider-evidence link, final settlement, and no
automatic replay. Each schema-v2 session contains one committed turn and four messages.

## Provider and tool evidence

All four requests used `google/gemini-3.7-flash`, the parent lane, streaming SSE, and returned HTTP
200 from the reported Google provider. Each turn preserved this exact runtime order:

```text
model tool_calls -> read acceptance.txt -> read success -> model final -> turn final
```

The read result was exactly `Worker acceptance: READY\n`. Planner, Bash, write, edit,
`submit_json_result`, and every other tool had zero calls. Each response recorded exactly one
terminal parser transition. The retained evidence includes serialized request bodies, raw response
bytes, ordered SSE events, provider metadata, parser transitions, usage, cost, runtime events,
outcome, and request counts. A recursive artifact check found neither an Authorization field nor the
credential environment name; no credential value was displayed or copied.

## Preflight and retained state

Immediately before execution, the installed launcher identity/check, clean tracked tree, unchanged
product source, absent target workspace/state namespaces, exact seed files, external source hash,
current official public OpenRouter model limits/pricing, and production request encoder with
scripted SSE were read back successfully. The scripted preflight predicted two parent requests per
path and the actual run matched that count.

The Human Gate authorization is consumed. The following workspaces and their workspace-partitioned
state remain retained for human inspection:

- `/tmp/henji-worker-real-provider-builtin`
- `/tmp/henji-worker-real-provider-external`

No cleanup, launcher update or rollback, product-code change, `_refs/*` operation, dependency
change, push, tag, publication, or release was performed. After reviewing the machine-observed
result, the user accepted the Worker production result on 2026-09-05 JST.
