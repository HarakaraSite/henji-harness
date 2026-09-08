# Agent source layout

`v0/agent` groups the active Agent implementation by responsibility:

- `core/`: provider-neutral messages, events, turn control, context, cancellation, and steering.
- `definitions/`: Agent definitions, selection, instructions, skills, identities, and resolved
  manifests.
- `provider/`: OpenRouter transport and profile, credential access, and provider evidence.
- `tools/`: tool declarations, registries, components, and tool implementations including web
  search.
- `session/`: durable sessions, history, replay values, context checkpoints, and diagnostics.
- `runtime/`: direct evaluation composition and shared startup projection.
- `worker/`: production Host/Worker sessions, headless runner, protocol, bootstrap, physical
  bindings, and Worker fixtures.
- `cli/`: TypeScript command entrypoints.
- `validation/`: provider acceptance, the user-confirmed production CLI E2E, sentinels, fixtures,
  and runtime comparison utilities.

`worker_agent_api.ts` remains the public composition facade. The shell launchers stay at this
directory root because the installed `henji` command and operator workflows use those stable paths.
Terminal-specific implementation remains under `v0/tui`; the UI-neutral presentation contract and
adapter remain under `v0/presentation`.

Both production entrypoints use the same headless Worker capsule and Host commit path:

- `session_launcher.sh` starts the interactive terminal Surface and optionally persists a Session.
- `runtime_cli_launcher.sh` starts one noninteractive turn without persisting a Session transcript;
  diagnostics, provider evidence, and execution artifacts still use the workspace state root.

`validation/production_cli_e2e.ts` starts that production launcher only when invoked with the exact
`--confirm-external-call` argument. It retains an isolated workspace, child channels, provider
evidence, and the Worker execution artifact under `/tmp/henji-production-e2e-*`, then emits one JSON
report. The live task is intentionally absent from `v0:test`, `v0:gate`, and CI; its provider call
requires a separate user instruction for each invocation.
