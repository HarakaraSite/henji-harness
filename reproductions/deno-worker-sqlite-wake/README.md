# Withdrawn Deno module Worker wake reproducer

Status: **withdrawn as a cause reproducer**. This directory is retained only as historical
investigation material. The later credential-free replay in Increment 92 established that the
production stop was caused by an auxiliary exact-capture contract mismatch in Henji, not by Deno,
SQLite, or module Worker wake behavior. Do not use this program as evidence for a Deno issue.

The program exercises Henji's real module Worker bootstrap while replacing provider traffic with
local deterministic responses. Its earlier interpretation attributed a correlated stop to the
synchronous SQLite append. That interpretation was superseded once the missing auxiliary exact
capture and the resulting Host journal failure were reproduced directly.

Historical local commands, from the repository root with Deno 2.9.7:

```sh
deno run --config deno.v0.json --unstable-worker-options --allow-all \
  reproductions/deno-worker-sqlite-wake/run.ts sqlite-local
```

An investigation run produced:

```json
{"event":"sqlite_append_returned","inputCount":3,"kinds":["runtime_event","runtime_event","context_observation"]}
{ "result": "reproduced", "detail": "Worker made no observable progress for 5 seconds after synchronous SQLite append" }
```

Run the direct control:

```sh
deno run --config deno.v0.json --unstable-worker-options --allow-all \
  reproductions/deno-worker-sqlite-wake/run.ts memory-local
```

Observed control result:

```json
{ "result": "completed", "ok": true, "stopReason": "final", "requestCount": 3 }
```

The expected synthetic flow makes three requests. The observed correlation did not isolate Deno
from Henji's then-current history contract and therefore did not establish the claimed runtime
cause. The authoritative cause, offline replay, fix, and verification are recorded in
`docs/increments/increment-92.md`.
